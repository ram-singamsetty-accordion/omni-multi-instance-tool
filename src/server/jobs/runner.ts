import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { FolderRef, Job, JobItem, JobItemKind, JobStatus, OmniLabel } from '../../shared/types.js';
import { getInstance, isUnlocked } from '../storage/vault.js';
import { OmniClient, OmniError } from '../omni/client.js';
import type { OmniDocState, OmniExportPayload } from '../omni/types.js';
import { getItems, updateItem, updateJob } from '../storage/repo.js';
import { publish } from './events.js';
import { runPostMigrationActions } from './postMigration.js';
import { copyQueryModels, hasAuthoredContent, pairQueryModels, rewriteSourceIds, verifyTiles } from './queryModels.js';
import type { TargetBinding } from './queryModels.js';
import { resolveDestFolder, resolveFolder } from './folders.js';
import { buildUpdatePatch, describeChanges, hasContentChanges } from './updatePatch.js';

interface SourceMeta {
  description: string | null;
  labels: string[];
}

// Why the source metadata / label-definition preloads failed, so the steps that need them can say so.
interface PreloadErrors {
  metaError?: string;
  labelsError?: string;
}

// A failed export, import or update leaves nothing for the steps after it to work on. Not 'models':
// verify and meta still run after a models failure.
const PREREQUISITE_KINDS = new Set<JobItemKind>(['export', 'import', 'update']);
const DEPENDENT_KINDS = new Set<JobItemKind>(['import', 'models', 'verify', 'meta']);

// Omni error bodies can be whole HTML gateway pages; the item row stores and streams every error.
const MAX_ITEM_ERROR = 4000; // about 13 verify-tile failures at 300 chars each

const clip = (s: string, max = MAX_ITEM_ERROR): string => (s.length > max ? `${s.slice(0, max)}... (truncated)` : s);

function safeOrigin(u: string): string {
  try { return `${new URL(u).origin}/…`; } catch { return '<invalid url>'; }
}

const running = new Set<string>();
// Destination folders (`${destId}:${folderId}`) with a job in flight. Two jobs planning from the same
// destination snapshot would import the same dashboard twice or interleave update drafts.
const activeDest = new Map<string, string>();

export function isRunning(jobId: string): boolean {
  return running.has(jobId);
}

// Same folder fallback as resolveFolder, but it never throws (a locked vault just means no default).
export function destKeys(destIds: string[], destFolders: Record<string, FolderRef> | null | undefined): string[] {
  return destIds.map(d => `${d}:${destFolders?.[d]?.id || (isUnlocked() ? getInstance(d)?.folderId : '') || ''}`);
}

// The id of a running job that already owns one of these destination folders, if any.
export function busyJob(keys: string[]): string | null {
  for (const k of keys) {
    const j = activeDest.get(k);
    if (j) return j;
  }
  return null;
}

export async function runJob(job: Job): Promise<void> {
  if (running.has(job.id)) return;
  const keys = destKeys(job.destIds, job.destFolders);
  const other = busyJob(keys);
  if (other) {
    // Defensive: the routes check first, but a job must never start on a folder another job owns.
    const msg = `destination busy: job ${other} is still running against it`;
    failUnfinished(job.id, msg);
    markJobFailed(job.id, msg);
    return;
  }
  // Both are set before the first await, so a second request cannot slip in between.
  running.add(job.id);
  for (const k of keys) activeDest.set(k, job.id);
  try {
    await executeJob(job);
  } catch (err) {
    // e.g. the vault was locked before the job started: leave nothing pending or running.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[migrator] job ${job.id} aborted: ${msg}`);
    failUnfinished(job.id, `aborted: ${msg}`);
    markJobFailed(job.id, msg);
  } finally {
    running.delete(job.id);
    for (const k of keys) if (activeDest.get(k) === job.id) activeDest.delete(k);
    // After the flag is cleared, so a client that refetches on this event sees running: false.
    publish({ jobId: job.id, type: 'done', status: 'done', at: Date.now() });
  }
}

async function executeJob(job: Job): Promise<void> {
  const source = getInstance(job.sourceId);
  const items = getItems(job.id);
  if (!source) {
    for (const item of items) fail(job.id, item.id, 'source instance missing');
    markJobFailed(job.id, 'source instance missing');
    return;
  }
  const sourceClient = new OmniClient(source);

  const startedAt = Date.now();
  updateJob(job.id, { status: 'running', startedAt });
  publish({ jobId: job.id, type: 'job', status: 'running', at: startedAt });

  const byDest = new Map<string, JobItem[]>();
  for (const item of items) {
    const list = byDest.get(item.destId) ?? [];
    list.push(item);
    byDest.set(item.destId, list);
  }

  const exportCache = new Map<string, { payload: OmniExportPayload; hash: string }>();
  // Source query-model YAML, shared across destinations so each file is read from the source once.
  const sourceYamlCache = new Map<string, Record<string, string>>();
  // Source v2 document state for in-place updates, shared across destinations.
  const sourceStateCache = new Map<string, OmniDocState>();

  const sourceMeta = new Map<string, SourceMeta>();
  const sourceLabelDefs = new Map<string, OmniLabel>();
  const preload: PreloadErrors = {};
  try {
    const docs = await sourceClient.listFolder(resolveFolder(source, job.sourceFolder).id, { includeLabels: true });
    for (const d of docs) {
      sourceMeta.set(d.identifier, {
        description: d.description ?? null,
        labels: Array.isArray(d.labels) ? d.labels : [],
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    preload.metaError = msg;
    console.warn(`[migrator] failed to list source folder with labels: ${msg}`);
  }
  try {
    const allLabels = await sourceClient.listLabels();
    for (const l of allLabels) sourceLabelDefs.set(l.name, l);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    preload.labelsError = msg;
    console.warn(`[migrator] failed to list source labels: ${msg}`);
  }

  const settled = await Promise.allSettled(
    Array.from(byDest.entries()).map(([destId, destItems]) =>
      runDestination(job, destId, destItems, sourceClient, exportCache, sourceYamlCache, sourceStateCache, sourceMeta, sourceLabelDefs, preload),
    ),
  );
  for (const r of settled) {
    if (r.status !== 'rejected') continue;
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    console.error(`[migrator] destination run aborted for job ${job.id}: ${msg}`);
    // Every destination has settled, so anything still pending/running belongs to the aborted one.
    failUnfinished(job.id, `aborted: ${msg}`);
  }

  const refreshed = getItems(job.id);
  const finalStatus = computeStatus(refreshed);
  const endedAt = Date.now();
  updateJob(job.id, { status: finalStatus, endedAt });
  publish({ jobId: job.id, type: 'job', status: finalStatus, at: endedAt });

  // A locked vault means the user wants activity to stop.
  if (job.postMigrationActions?.length && isUnlocked()) {
    publish({ jobId: job.id, type: 'post-migration', status: 'running', at: Date.now() });
    try {
      const actionResults = await runPostMigrationActions(job.postMigrationActions);
      updateJob(job.id, { postMigrationResults: actionResults });
      // Webhook URLs often carry a secret in the path or query, and responses can echo tokens: log neither.
      // The full URL and body stay in postMigrationResults for the job page.
      for (const r of actionResults) {
        const tag = r.ok ? '[ok]' : '[fail]';
        console.log(`[post-migration] ${tag} ${r.method} ${safeOrigin(r.url)} → ${r.status ?? 'network error'}`);
        if (r.error) console.log(`[post-migration] error: ${r.error}`);
      }
    } catch (err) {
      console.warn(`[migrator] post-migration actions failed for job ${job.id}:`, err);
    }
    publish({ jobId: job.id, type: 'post-migration', status: 'done', at: Date.now() });
  }
}

async function runDestination(
  job: Job,
  destId: string,
  items: JobItem[],
  sourceClient: OmniClient,
  exportCache: Map<string, { payload: OmniExportPayload; hash: string }>,
  sourceYamlCache: Map<string, Record<string, string>>,
  sourceStateCache: Map<string, OmniDocState>,
  sourceMeta: Map<string, SourceMeta>,
  sourceLabelDefs: Map<string, OmniLabel>,
  preload: PreloadErrors,
): Promise<void> {
  const jobId = job.id;
  if (!isUnlocked()) {
    for (const item of items) fail(jobId, item.id, 'vault locked: job aborted');
    return;
  }
  const dest = getInstance(destId);
  if (!dest) {
    for (const item of items) fail(jobId, item.id, 'destination instance missing');
    return;
  }
  const destClient = new OmniClient(dest);
  let destFolder: FolderRef;
  try {
    // Imports go by folder path and everything else by id. Re-checking the pair here (a warm cache costs
    // nothing) also covers retries and jobs saved before the planner verified it, and fails every item
    // before any delete runs if the folder is gone or has no path.
    destFolder = items.some(i => i.kind === 'import')
      ? await resolveDestFolder(dest, job.destFolders[destId])
      : resolveFolder(dest, job.destFolders[destId]);
  } catch (err) {
    for (const item of items) fail(jobId, item.id, err instanceof Error ? err.message : String(err));
    return;
  }
  let destLabelsLoaded = false;
  const destLabels = new Set<string>();
  const ensureDestLabels = async (): Promise<void> => {
    if (destLabelsLoaded) return;
    const list = await destClient.listLabels();
    for (const l of list) destLabels.add(l.name);
    destLabelsLoaded = true;
  };
  let target: TargetBinding | null = null;
  const ensureTarget = async (): Promise<TargetBinding> => {
    if (target) return target;
    const model = await destClient.getModel(dest.modelId);
    if (!model?.connectionId) throw new Error(`destination model ${dest.modelId} not found or has no connection`);
    // The server's canonical id, so a differently cased or padded saved id still rewrites and imports correctly.
    target = { sharedModelId: model.id, connectionId: model.connectionId };
    return target;
  };
  const importedBySourceDoc = new Map<string, { identifier: string; miniUuidMap: Record<string, string> }>();
  // Re-export of each imported dashboard, reused by the models and verify steps.
  const importedExports = new Map<string, OmniExportPayload>();
  const importedExport = async (identifier: string): Promise<OmniExportPayload> => {
    let payload = importedExports.get(identifier);
    if (!payload) {
      payload = await destClient.exportDoc(identifier);
      importedExports.set(identifier, payload);
    }
    return payload;
  };
  const updatedSourceDocs = new Set<string>();
  // Labels each updated destination doc carried before the update, so the meta step can drop the ones the source no longer has.
  const destLabelsBySourceDoc = new Map<string, string[]>();
  const changedTabsBySourceDoc = new Map<string, Set<string>>();
  // Per updated source doc: tabs whose source query model has tab-only fields or CTEs.
  const queryModelTabsBySourceDoc = new Map<string, Set<string>>();
  // Keeps the candidates whose source query model has authored content; a model left at its empty
  // defaults has nothing an update could have lost. A model that can't be read is kept, so it is
  // verified rather than assumed empty.
  const authoredModelTabs = async (candidates: { tab: string; modelId: string }[]): Promise<Set<string>> => {
    const tabs = new Set<string>();
    for (const { tab, modelId } of candidates) {
      try {
        let files = sourceYamlCache.get(modelId);
        if (!files) {
          files = (await sourceClient.getModelYaml(modelId, { mode: 'extension' })).files;
          sourceYamlCache.set(modelId, files);
        }
        if (hasAuthoredContent(files)) tabs.add(tab);
      } catch (err) {
        console.warn(`[migrator] ${dest.label}: could not read source query model ${modelId} for tab "${tab}"; it will be verified: ${err instanceof Error ? err.message : String(err)}`);
        tabs.add(tab);
      }
    }
    return tabs;
  };
  // First prerequisite step that failed, per source doc.
  const brokenDocs = new Map<string, JobItemKind>();
  // Deletes are destructive, so they only run once the exports and the destination model are known to work.
  let exportFailed = false;
  let modelBlock: string | null | undefined; // undefined = not checked yet
  const deleteBlockReason = async (): Promise<string | null> => {
    if (exportFailed) return 'not deleted: an export step failed, so the destination was left as it was; fix the cause and run again';
    if (modelBlock === undefined) {
      modelBlock = null;
      if (items.some(i => i.kind === 'import')) {
        try {
          await ensureTarget();
        } catch (e) {
          modelBlock = `not deleted: destination model unusable (${clip(e instanceof Error ? e.message : String(e), 500)}); fix it and run again`;
        }
      }
    }
    return modelBlock;
  };

  for (const item of items) {
    // Locking the vault stops the run at the next step; the step already in flight finishes.
    if (!isUnlocked()) {
      fail(jobId, item.id, 'vault locked: job aborted');
      continue;
    }
    // Reported before the 'running' update so the row does not flicker. fail, not skip: retry is
    // derived from failed import items, and skipped items count as success.
    const broken = item.docId ? brokenDocs.get(item.docId) : undefined;
    if (broken && DEPENDENT_KINDS.has(item.kind)) {
      fail(jobId, item.id, `not run: ${broken} failed for this document`);
      continue;
    }
    const startedAt = Date.now();
    updateItem(item.id, { status: 'running', startedAt });
    publish({ jobId, itemId: item.id, type: 'item', status: 'running', at: startedAt });
    let note: string | undefined;
    try {
      if (item.kind === 'delete') {
        if (!item.docId) throw new Error('delete item missing docId');
        const blocked = await deleteBlockReason();
        if (blocked) {
          // fail, not skip: skipped counts as success, so the job would end 'succeeded' with the folder
          // not emptied (the model check can fail once and the import step's retry succeed), and Retry
          // only re-runs failed items.
          fail(jobId, item.id, blocked);
          continue;
        }
        try {
          await destClient.deleteDoc(item.docId);
        } catch (err) {
          // Already gone (an earlier DELETE went through but its response was lost, or it was removed by hand): goal met.
          if (!(err instanceof OmniError && err.status === 404)) throw err;
          note = 'already deleted';
        }
      } else if (item.kind === 'export') {
        if (!item.docId) throw new Error('export item missing docId');
        let cached = exportCache.get(item.docId);
        if (!cached) {
          const payload = await sourceClient.exportDoc(item.docId);
          const hash = hashPayload(payload);
          cached = { payload, hash };
          exportCache.set(item.docId, cached);
        }
        updateItem(item.id, { exportHash: cached.hash });
      } else if (item.kind === 'import') {
        if (!item.docId) throw new Error('import item missing docId');
        const cached = exportCache.get(item.docId);
        if (!cached) throw new Error('export missing for import step (planner invariant violated)');
        const docName = item.docName ?? cached.payload.document?.name ?? 'Untitled';
        const importTarget = await ensureTarget();
        const { payload: rewritten } = rewriteSourceIds(cached.payload, importTarget);
        const imported = await destClient.importDoc({
          exportPayload: rewritten,
          baseModelId: importTarget.sharedModelId,
          folderPath: destFolder.path,
          documentName: docName,
        });
        let newId = imported.identifier;
        if (!newId) {
          const docs = await destClient.listFolder(destFolder.id);
          const matches = docs.filter(d => d.name === docName);
          matches.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
          newId = matches[0]?.identifier ?? '';
        }
        if (!newId) {
          throw new Error(`import succeeded but could not resolve destination identifier. raw response: ${JSON.stringify(imported.raw)}`);
        }
        importedBySourceDoc.set(item.docId, { identifier: newId, miniUuidMap: imported.miniUuidMap });
      } else if (item.kind === 'models') {
        if (!item.docId) throw new Error('models item missing docId');
        const imported = importedBySourceDoc.get(item.docId);
        if (!imported) throw new Error('no imported identifier available for query-model step');
        const cached = exportCache.get(item.docId);
        if (!cached) throw new Error('export missing for query-model step (planner invariant violated)');
        const hasQueryModels = Object.keys(cached.payload.queryModels ?? {}).length > 0;
        if (hasQueryModels) {
          const pairs = pairQueryModels(cached.payload, await importedExport(imported.identifier), imported.miniUuidMap);
          const copied = await copyQueryModels(sourceClient, destClient, pairs, sourceYamlCache);
          console.log(`[migrator] ${dest.label} ${imported.identifier}: copied ${copied.filesWritten} file(s) into ${copied.queryModels} query model(s), rewrote CTE refs in ${copied.refsRewritten.length} file(s)`);
          for (const w of copied.warnings) console.warn(`[migrator] ${dest.label} ${imported.identifier}: unresolved CTE ref ${w}`);
        }
      } else if (item.kind === 'verify') {
        if (!item.docId) throw new Error('verify item missing docId');
        const imported = importedBySourceDoc.get(item.docId);
        if (!imported) throw new Error('no imported identifier available for verify step');
        // After an in-place update only the tabs it changed, plus tabs with a query model, need
        // checking; the rest are untouched.
        const onlyTileNames = changedTabsBySourceDoc.get(item.docId);
        if (onlyTileNames && onlyTileNames.size === 0) {
          skip(jobId, item.id, 'no changed or query-model tabs, nothing to verify');
          continue;
        }
        const result = await verifyTiles(destClient, await importedExport(imported.identifier), { onlyTileNames });
        for (const t of result.timeouts) console.warn(`[migrator] ${dest.label} ${imported.identifier}: tile "${t}" timed out; not verified`);
        for (const u of result.unverified) console.warn(`[migrator] ${dest.label} ${imported.identifier}: tile "${u.tile}" not verified: ${u.reason}`);
        if (result.failures.length > 0) {
          // An update never rebuilds query models, so a failing tile with tab-only fields or CTEs can't be repaired in place.
          const modelTabs = queryModelTabsBySourceDoc.get(item.docId);
          const modelFailures = modelTabs ? result.failures.filter(f => modelTabs.has(f.tile)) : [];
          // The list is capped so the repair hint at the end survives clip() in fail().
          const SHOWN = 8;
          const listed = clip(
            result.failures.slice(0, SHOWN).map(f => `"${f.tile}": ${f.error}`).join(' | ') +
              (result.failures.length > SHOWN ? ` | ... and ${result.failures.length - SHOWN} more` : ''),
            2800,
          );
          const hintTiles = modelFailures.slice(0, SHOWN).map(f => `"${f.tile}"`).join(', ') +
            (modelFailures.length > SHOWN ? ` and ${modelFailures.length - SHOWN} more` : '');
          throw new Error(`${result.failures.length} of ${result.checked} tile(s) fail on the destination` +
            (result.unverified.length ? ` (${result.unverified.length} more could not be verified)` : '') + ': ' +
            listed +
            (modelFailures.length ? ` | updated in place: an update does not rebuild query models (tab-only fields, CTEs), so ${hintTiles} can't be repaired that way; to repair it, delete the destination dashboard (its schedules are lost) and migrate it again` : ''));
        }
        // Auth, rate-limit or outage errors say nothing about the tiles; don't report a healthy dashboard as broken.
        if (result.checked > 0 && result.unverified.length === result.checked) {
          throw new Error(`verification could not run: ${result.unverified[0]!.reason}`);
        }
        note = `checked ${result.checked} tile(s)` +
          (result.timeouts.length ? `, ${result.timeouts.length} timed out: ${result.timeouts.join(', ')}` : '') +
          (result.unverified.length ? `, ${result.unverified.length} not verified (${result.unverified[0]!.reason})` : '');
      } else if (item.kind === 'update') {
        if (!item.docId) throw new Error('update item missing docId');
        const docName = item.docName;
        if (!docName) throw new Error('update item missing docName');
        const destDocs = await destClient.listFolder(destFolder.id, { includeLabels: true });
        const sameName = destDocs.filter(d => d.name === docName);
        // The planner refuses same-name destination docs; one created since is still not guessed at.
        if (sameName.length > 1) {
          throw new Error(`destination has ${sameName.length} documents named "${docName}" (${sameName.map(d => d.identifier).join(', ')}); delete or rename the extra copies (keep the one with the schedules) and run again`);
        }
        const destDoc = sameName[0];
        if (!destDoc) throw new Error(`destination document "${docName}" not found for in-place update`);
        // Only when Omni returned the list: a missing field must not read as "no labels" and strip them all.
        if (Array.isArray(destDoc.labels)) destLabelsBySourceDoc.set(item.docId, destDoc.labels);
        const sourceState = sourceStateCache.get(item.docId) ?? await sourceClient.getDocState(item.docId);
        sourceStateCache.set(item.docId, sourceState);
        const destState = await destClient.getDocState(destDoc.identifier);
        const { patch, changedTabs, queryModelTabs } = buildUpdatePatch(sourceState, destState);
        // Recorded only once the destination is known to match (unchanged, or published below), so
        // verify and meta don't run against a dashboard whose update failed.
        const recordUpdated = async (): Promise<void> => {
          const modelTabs = await authoredModelTabs(queryModelTabs);
          importedBySourceDoc.set(item.docId!, { identifier: destDoc.identifier, miniUuidMap: {} });
          updatedSourceDocs.add(item.docId!);
          queryModelTabsBySourceDoc.set(item.docId!, modelTabs);
          changedTabsBySourceDoc.set(item.docId!, new Set([...changedTabs, ...modelTabs]));
        };
        if (!hasContentChanges(patch)) {
          await recordUpdated();
          skip(jobId, item.id, `no changes: ${destDoc.identifier} already matches the source, nothing published`);
          continue;
        }
        try {
          await destClient.updateDocContent(destDoc.identifier, patch);
        } catch (err) {
          if (err instanceof OmniError && err.status === 400) {
            // Full request + both states, so the rejected field can be found without truncation.
            // The dump is best effort: a filesystem failure must not replace Omni's own message.
            let where: string;
            try {
              mkdirSync('./data/diff', { recursive: true });
              const dumpPath = `./data/diff/update-${destDoc.identifier}-${Date.now()}.json`;
              writeFileSync(dumpPath, JSON.stringify({ error: err.message, patch, sourceState, destState }, null, 2));
              where = `full request and states saved to ${dumpPath}`;
            } catch (dumpErr) {
              const m = dumpErr instanceof Error ? dumpErr.message : String(dumpErr);
              console.warn(`[migrator] could not save diff dump: ${m}`);
              where = `could not save diff dump: ${m}`;
            }
            // Only the Omni part is clipped, so the dump path always survives.
            throw new Error(`${clip(err.message, 1500)} | ${where}`);
          }
          throw err;
        }
        await recordUpdated();
        note = `published to ${destDoc.identifier}: ${describeChanges(patch, changedTabs)}`;
      } else if (item.kind === 'meta') {
        if (!item.docId) throw new Error('meta item missing docId');
        const newId = importedBySourceDoc.get(item.docId)?.identifier;
        if (!newId) throw new Error('no imported identifier available for metadata step');
        const meta = sourceMeta.get(item.docId);
        if (!meta) {
          throw new Error(preload.metaError ? `could not read source metadata: ${preload.metaError}` : `source metadata missing for ${item.docId}`);
        }
        // In-place updates already carry the description in the draft patch.
        if (!updatedSourceDocs.has(item.docId) && meta.description !== null && meta.description !== undefined && meta.description !== '') {
          await destClient.patchDoc(newId, { description: meta.description, summary: 'migration: copy description from source', clearExistingDraft: true });
        }
        if (meta.labels.length > 0) {
          await ensureDestLabels();
          for (const name of meta.labels) {
            if (destLabels.has(name)) continue;
            const def = sourceLabelDefs.get(name);
            // Without the definition the label would be created bare (no colour or description).
            if (!def && preload.labelsError) {
              throw new Error(`label "${name}" is not on the destination and its colour/description could not be read from the source: ${preload.labelsError}`);
            }
            try {
              await destClient.createLabel({
                name,
                color: def?.color ?? null,
                description: def?.description ?? null,
                isVerified: def?.isVerified,
                isHomepageSection: def?.isHomepageSection,
              });
            } catch (err) {
              if (!(err instanceof OmniError && err.status === 409)) throw err;
            }
            destLabels.add(name);
          }
        }
        // An in-place update mirrors the source, so labels it no longer has come off the destination doc
        // (an import starts bare, so it has nothing to remove). Compared case-insensitively so a label
        // that differs only by case is never added and removed in one call.
        const keep = new Set(meta.labels.map(l => l.toLowerCase()));
        const removeLabels = updatedSourceDocs.has(item.docId)
          ? (destLabelsBySourceDoc.get(item.docId) ?? []).filter(l => !keep.has(l.toLowerCase()))
          : [];
        await destClient.setDocumentLabels(newId, meta.labels, removeLabels); // no-op when both lists are empty
        if (removeLabels.length > 0) note = `removed label(s) no longer on the source: ${removeLabels.join(', ')}`;
      }
      succeed(jobId, item.id, note);
    } catch (err) {
      if (item.kind === 'export') exportFailed = true;
      if (item.docId && PREREQUISITE_KINDS.has(item.kind) && !brokenDocs.has(item.docId)) brokenDocs.set(item.docId, item.kind);
      const msg = err instanceof OmniError ? err.message : err instanceof Error ? err.message : String(err);
      fail(jobId, item.id, msg);
    }
  }
}

// `note` is shown next to the item in the UI. It is stored in the item's error column, which the
// UI renders as a plain note unless the item failed.
function succeed(jobId: string, itemId: string, note?: string): void {
  const endedAt = Date.now();
  updateItem(itemId, { status: 'succeeded', endedAt, ...(note ? { error: note } : {}) });
  publish({ jobId, itemId, type: 'item', status: 'succeeded', error: note, at: endedAt });
}

function skip(jobId: string, itemId: string, note: string): void {
  const endedAt = Date.now();
  updateItem(itemId, { status: 'skipped', endedAt, error: note });
  publish({ jobId, itemId, type: 'item', status: 'skipped', error: note, at: endedAt });
}

function fail(jobId: string, itemId: string, error: string): void {
  const endedAt = Date.now();
  const e = clip(error);
  updateItem(itemId, { status: 'failed', endedAt, error: e });
  publish({ jobId, itemId, type: 'item', status: 'failed', error: e, at: endedAt });
}

// Closes out items an aborted run left behind, so none stay pending/running with no explanation.
function failUnfinished(jobId: string, msg: string): void {
  for (const it of getItems(jobId)) {
    if (it.status !== 'pending' && it.status !== 'running') continue;
    try {
      fail(jobId, it.id, msg);
    } catch (e) {
      console.error('[migrator] could not mark item failed', e);
    }
  }
}

function markJobFailed(jobId: string, error: string): void {
  const endedAt = Date.now();
  updateJob(jobId, { status: 'failed', endedAt });
  publish({ jobId, type: 'job', status: 'failed', error, at: endedAt });
}

function computeStatus(items: JobItem[]): JobStatus {
  if (items.length === 0) return 'succeeded';
  const failed = items.filter(i => i.status === 'failed').length;
  const succeeded = items.filter(i => i.status === 'succeeded' || i.status === 'skipped').length;
  if (failed === 0) return 'succeeded';
  if (succeeded === 0) return 'failed';
  return 'partial';
}

function hashPayload(p: OmniExportPayload): string {
  return createHash('sha256').update(JSON.stringify(p)).digest('hex');
}
