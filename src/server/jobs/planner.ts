import { createHash } from 'node:crypto';
import type { FolderRef, JobPlan, JobPlanStep } from '../../shared/types.js';
import { getInstance } from '../storage/vault.js';
import { httpError } from '../httpError.js';
import { OmniClient } from '../omni/client.js';
import { resolveDestFolder, resolveFolder } from './folders.js';

export interface PlanInput {
  sourceId: string;
  destIds: string[];
  docIds: string[];
  emptyFirst: boolean;
  sourceFolder?: FolderRef;
  destFolders?: Record<string, FolderRef>;
}

export async function buildPlan(input: PlanInput): Promise<JobPlan> {
  const source = getInstance(input.sourceId);
  if (!source) throw httpError('source instance not found', 404);

  const sourceClient = new OmniClient(source);
  const sourceFolder = resolveFolder(source, input.sourceFolder);
  const sourceDocs = await sourceClient.listFolder(sourceFolder.id);
  const picked = sourceDocs.filter(d => input.docIds.includes(d.identifier));
  const missing = input.docIds.filter(id => !picked.some(p => p.identifier === id));
  if (missing.length) throw httpError(`docs not found in source folder: ${missing.join(', ')}`, 404);

  // Documents are matched by name, so two picked documents with one name would overwrite each other.
  const pickedNames = new Set(picked.map(p => p.name));
  const idsByName = new Map<string, string[]>();
  for (const p of picked) idsByName.set(p.name, [...(idsByName.get(p.name) ?? []), p.identifier]);
  const pickedDupes = [...idsByName].filter(([, ids]) => ids.length > 1);
  if (pickedDupes.length) {
    throw httpError(
      'Migration matches documents by name, so each selected document needs a unique name. Deselect or rename: ' +
        pickedDupes.map(([n, ids]) => `"${n}" (${ids.join(', ')})`).join('; '),
      400,
    );
  }

  const steps: JobPlanStep[] = [];
  const destFolders: Record<string, FolderRef> = {};

  for (const destId of input.destIds) {
    const dest = getInstance(destId);
    if (!dest) throw httpError(`destination not found: ${destId}`, 404);

    const destClient = new OmniClient(dest);
    const destFolder = await resolveDestFolder(dest, input.destFolders?.[destId]);
    destFolders[destId] = destFolder;
    const existing = await destClient.listFolder(destFolder.id);

    // A picked doc whose name already exists at the destination is updated in place (keeps the
    // destination identifier, so schedules and usage analytics survive). Which of several same-name
    // docs holds the schedules cannot be told from here (newest is often a stray copy), so refuse.
    const destByName = new Map<string, string[]>();
    for (const d of existing) {
      if (pickedNames.has(d.name)) destByName.set(d.name, [...(destByName.get(d.name) ?? []), d.identifier]);
    }
    const destDupes = [...destByName].filter(([, ids]) => ids.length > 1);
    if (destDupes.length) {
      throw httpError(
        `${dest.label}: several documents already share a name being migrated: ` +
          destDupes.map(([n, ids]) => `"${n}" (${ids.join(', ')})`).join('; ') +
          '. Delete or rename the extra copies in Omni (keep the one that has the schedules), then run again.',
        409,
      );
    }
    const keeperByName = new Map<string, string>();
    for (const [name, ids] of destByName) keeperByName.set(name, ids[0]!);

    // Exports go first: a failed export must stop the destructive deletes (see runner.ts).
    for (const doc of picked) {
      if (keeperByName.has(doc.name)) continue;
      steps.push({
        destId,
        destLabel: dest.label,
        kind: 'export',
        docId: doc.identifier,
        docName: doc.name,
      });
    }

    for (const d of existing) {
      const isKeeper = keeperByName.get(d.name) === d.identifier;
      if (isKeeper) continue;
      if (input.emptyFirst) {
        steps.push({
          destId,
          destLabel: dest.label,
          kind: 'delete',
          docId: d.identifier,
          docName: d.name,
        });
      }
    }

    for (const doc of picked) {
      if (keeperByName.has(doc.name)) {
        steps.push({
          destId,
          destLabel: dest.label,
          kind: 'update',
          docId: doc.identifier,
          docName: doc.name,
        });
        steps.push({
          destId,
          destLabel: dest.label,
          kind: 'verify',
          docId: doc.identifier,
          docName: doc.name,
        });
        steps.push({
          destId,
          destLabel: dest.label,
          kind: 'meta',
          docId: doc.identifier,
          docName: doc.name,
        });
        continue;
      }
      steps.push({
        destId,
        destLabel: dest.label,
        kind: 'import',
        docId: doc.identifier,
        docName: doc.name,
      });
      steps.push({
        destId,
        destLabel: dest.label,
        kind: 'models',
        docId: doc.identifier,
        docName: doc.name,
      });
      steps.push({
        destId,
        destLabel: dest.label,
        kind: 'verify',
        docId: doc.identifier,
        docName: doc.name,
      });
      steps.push({
        destId,
        destLabel: dest.label,
        kind: 'meta',
        docId: doc.identifier,
        docName: doc.name,
      });
    }
  }

  return {
    sourceId: input.sourceId,
    sourceLabel: source.label,
    sourceFolder,
    destFolders,
    destIds: input.destIds,
    docIds: input.docIds,
    emptyFirst: input.emptyFirst,
    steps,
    digest: planDigest(steps),
  };
}

// Covers which dashboards are deleted, updated or imported where. Sorted so the order the folder
// listing returned them in does not matter.
function planDigest(steps: JobPlanStep[]): string {
  const lines = steps.map(s => `${s.destId}|${s.kind}|${s.docId ?? ''}`).sort();
  return createHash('sha256').update(JSON.stringify(lines)).digest('hex');
}
