import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { FolderRef, Job, JobItem, JobStatus, OmniLabel } from '../../shared/types.js';
import { getInstance } from '../storage/vault.js';
import { OmniClient, OmniError } from '../omni/client.js';
import type { OmniDocState, OmniExportPayload } from '../omni/types.js';
import { getItems, updateItem, updateJob } from '../storage/repo.js';
import { publish } from './events.js';
import { runPostMigrationActions } from './postMigration.js';
import { copyQueryModels, pairQueryModels, rewriteSourceIds, verifyTiles } from './queryModels.js';
import type { TargetBinding } from './queryModels.js';
import { resolveFolder } from './folders.js';
import { buildUpdatePatch, describeChanges, hasContentChanges } from './updatePatch.js';

interface SourceMeta {
  description: string | null;
  labels: string[];
}

const running = new Set<string>();

export function isRunning(jobId: string): boolean {
  return running.has(jobId);
}

export async function runJob(job: Job): Promise<void> {
  if (running.has(job.id)) return;
  running.add(job.id);
  try {
    await executeJob(job);
  } finally {
    running.delete(job.id);
  }
}

async function executeJob(job: Job): Promise<void> {
  const source = getInstance(job.sourceId);
  if (!source) {
    markJobFailed(job.id, 'source instance missing');
    return;
  }
  const sourceClient = new OmniClient(source);
  const items = getItems(job.id);

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
    console.warn(`[migrator] failed to list source folder with labels: ${msg}`);
  }
  try {
    const allLabels = await sourceClient.listLabels();
    for (const l of allLabels) sourceLabelDefs.set(l.name, l);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[migrator] failed to list source labels: ${msg}`);
  }

  await Promise.all(
    Array.from(byDest.entries()).map(([destId, destItems]) =>
      runDestination(job, destId, destItems, sourceClient, exportCache, sourceYamlCache, sourceStateCache, sourceMeta, sourceLabelDefs),
    ),
  );

  const refreshed = getItems(job.id);
  const finalStatus = computeStatus(refreshed);
  const endedAt = Date.now();
  updateJob(job.id, { status: finalStatus, endedAt });
  publish({ jobId: job.id, type: 'job', status: finalStatus, at: endedAt });

  if (job.postMigrationActions?.length) {
    publish({ jobId: job.id, type: 'post-migration', status: 'running', at: Date.now() });
    try {
      const actionResults = await runPostMigrationActions(job.postMigrationActions);
      for (const r of actionResults) {
        const tag = r.ok ? '[ok]' : '[fail]';
        console.log(`[post-migration] ${tag} ${r.method} ${r.url} → ${r.status ?? 'network error'}`);
        if (r.responseBody) console.log(`[post-migration] response:\n${r.responseBody}`);
        if (r.error) console.log(`[post-migration] error: ${r.error}`);
      }
      updateJob(job.id, { postMigrationResults: actionResults });
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
): Promise<void> {
  const jobId = job.id;
  const dest = getInstance(destId);
  if (!dest) {
    for (const item of items) fail(jobId, item.id, 'destination instance missing');
    return;
  }
  const destClient = new OmniClient(dest);
  let destFolder: FolderRef;
  try {
    destFolder = resolveFolder(dest, job.destFolders[destId]);
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
    target = { sharedModelId: dest.modelId, connectionId: model.connectionId };
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
  const changedTabsBySourceDoc = new Map<string, Set<string>>();

  for (const item of items) {
    const startedAt = Date.now();
    updateItem(item.id, { status: 'running', startedAt });
    publish({ jobId, itemId: item.id, type: 'item', status: 'running', at: startedAt });
    let note: string | undefined;
    try {
      if (item.kind === 'delete') {
        if (!item.docId) throw new Error('delete item missing docId');
        await destClient.deleteDoc(item.docId);
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
        const { payload: rewritten } = rewriteSourceIds(cached.payload, await ensureTarget());
        const imported = await destClient.importDoc({
          exportPayload: rewritten,
          baseModelId: dest.modelId,
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
        // After an in-place update only the tabs it changed need checking; the rest are untouched.
        const onlyTileNames = changedTabsBySourceDoc.get(item.docId);
        if (onlyTileNames && onlyTileNames.size === 0) {
          skip(jobId, item.id, 'no tabs changed, nothing to verify');
          continue;
        }
        const result = await verifyTiles(destClient, await importedExport(imported.identifier), { onlyTileNames });
        for (const t of result.timeouts) console.warn(`[migrator] ${dest.label} ${imported.identifier}: tile "${t}" timed out; not verified`);
        if (result.failures.length > 0) {
          throw new Error(`${result.failures.length} of ${result.checked} tile(s) fail on the destination: ` +
            result.failures.map(f => `"${f.tile}": ${f.error}`).join(' | '));
        }
        note = `checked ${result.checked} tile(s)` +
          (result.timeouts.length ? `, ${result.timeouts.length} timed out: ${result.timeouts.join(', ')}` : '');
      } else if (item.kind === 'update') {
        if (!item.docId) throw new Error('update item missing docId');
        const docName = item.docName;
        if (!docName) throw new Error('update item missing docName');
        const destDocs = await destClient.listFolder(destFolder.id);
        const destDoc = destDocs
          .filter(d => d.name === docName)
          .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
        if (!destDoc) throw new Error(`destination document "${docName}" not found for in-place update`);
        const sourceState = sourceStateCache.get(item.docId) ?? await sourceClient.getDocState(item.docId);
        sourceStateCache.set(item.docId, sourceState);
        const destState = await destClient.getDocState(destDoc.identifier);
        const { patch, changedTabs } = buildUpdatePatch(sourceState, destState);
        // Recorded only once the destination is known to match (unchanged, or published below), so
        // verify and meta don't run against a dashboard whose update failed.
        const recordUpdated = (): void => {
          importedBySourceDoc.set(item.docId!, { identifier: destDoc.identifier, miniUuidMap: {} });
          updatedSourceDocs.add(item.docId!);
          changedTabsBySourceDoc.set(item.docId!, new Set(changedTabs));
        };
        if (!hasContentChanges(patch)) {
          recordUpdated();
          skip(jobId, item.id, `no changes: ${destDoc.identifier} already matches the source, nothing published`);
          continue;
        }
        try {
          await destClient.updateDocContent(destDoc.identifier, patch);
        } catch (err) {
          if (err instanceof OmniError && err.status === 400) {
            // Full request + both states, so the rejected field can be found without truncation.
            mkdirSync('./data/diff', { recursive: true });
            const dumpPath = `./data/diff/update-${destDoc.identifier}-${Date.now()}.json`;
            writeFileSync(dumpPath, JSON.stringify({ error: err.message, patch, sourceState, destState }, null, 2));
            throw new Error(`${err.message} | full request and states saved to ${dumpPath}`);
          }
          throw err;
        }
        recordUpdated();
        note = `published to ${destDoc.identifier}: ${describeChanges(patch, changedTabs)}`;
      } else if (item.kind === 'meta') {
        if (!item.docId) throw new Error('meta item missing docId');
        const newId = importedBySourceDoc.get(item.docId)?.identifier;
        if (!newId) throw new Error('no imported identifier available for metadata step');
        const meta = sourceMeta.get(item.docId);
        if (!meta) throw new Error(`source metadata missing for ${item.docId}`);
        // In-place updates already carry the description in the draft patch.
        if (!updatedSourceDocs.has(item.docId) && meta.description !== null && meta.description !== undefined && meta.description !== '') {
          await destClient.patchDoc(newId, { description: meta.description, summary: 'migration: copy description from source', clearExistingDraft: true });
        }
        if (meta.labels.length > 0) {
          await ensureDestLabels();
          for (const name of meta.labels) {
            if (destLabels.has(name)) continue;
            const def = sourceLabelDefs.get(name);
            try {
              await destClient.createLabel({
                name,
                color: def?.color ?? null,
                description: def?.description ?? null,
              });
            } catch (err) {
              if (!(err instanceof OmniError && err.status === 409)) throw err;
            }
            destLabels.add(name);
          }
          await destClient.setDocumentLabels(newId, meta.labels);
        }
      }
      succeed(jobId, item.id, note);
    } catch (err) {
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
  updateItem(itemId, { status: 'failed', endedAt, error });
  publish({ jobId, itemId, type: 'item', status: 'failed', error, at: endedAt });
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
