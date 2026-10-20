import type { FolderRef, JobPlan, JobPlanStep } from '../../shared/types.js';
import { getInstance } from '../storage/vault.js';
import { OmniClient } from '../omni/client.js';
import { resolveFolder } from './folders.js';

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
  if (!source) throw new Error('source instance not found');

  const sourceClient = new OmniClient(source);
  const sourceFolder = resolveFolder(source, input.sourceFolder);
  const sourceDocs = await sourceClient.listFolder(sourceFolder.id);
  const picked = sourceDocs.filter(d => input.docIds.includes(d.identifier));
  const missing = input.docIds.filter(id => !picked.some(p => p.identifier === id));
  if (missing.length) throw new Error(`docs not found in source folder: ${missing.join(', ')}`);

  const steps: JobPlanStep[] = [];
  const destFolders: Record<string, FolderRef> = {};

  for (const destId of input.destIds) {
    const dest = getInstance(destId);
    if (!dest) throw new Error(`destination not found: ${destId}`);

    const destClient = new OmniClient(dest);
    const destFolder = resolveFolder(dest, input.destFolders?.[destId]);
    destFolders[destId] = destFolder;
    const existing = await destClient.listFolder(destFolder.id);

    // A picked doc whose name already exists at the destination is updated in place (keeps the
    // destination identifier, so schedules and usage analytics survive). Only one dest doc per
    // name is kept for the update (most recently updated); same-name extras are deleted.
    const pickedNames = new Set(picked.map(p => p.name));
    const keeperByName = new Map<string, string>();
    for (const d of [...existing].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))) {
      if (pickedNames.has(d.name) && !keeperByName.has(d.name)) keeperByName.set(d.name, d.identifier);
    }

    for (const d of existing) {
      const isKeeper = keeperByName.get(d.name) === d.identifier;
      if (isKeeper) continue;
      if (input.emptyFirst || pickedNames.has(d.name)) {
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
        kind: 'export',
        docId: doc.identifier,
        docName: doc.name,
      });
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
  };
}
