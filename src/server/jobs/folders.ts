import type { FolderRef, Instance, OmniFolder } from '../../shared/types.js';
import { httpError } from '../httpError.js';
import { cachedFolders } from '../omni/folderCache.js';

// A folder picked for the run wins over the folder saved on the instance.
export function resolveFolder(inst: Instance, override: FolderRef | undefined | null): FolderRef {
  const folder = override?.id ? override : { id: inst.folderId, path: inst.folderPath };
  // Without a folder ID, "list folder" returns every document on the instance, and "empty first" would delete them.
  if (!folder.id) throw httpError(`no folder chosen for ${inst.label}, and the instance has no default folder`, 400);
  return folder;
}

// A destination lists, updates and deletes by folder ID but imports by folder PATH, so the pair must
// describe one folder. The path comes from Omni's own folder list, never from the typed or saved text
// (a blank or renamed path would make imports land elsewhere than the folder being listed and emptied).
export async function resolveDestFolder(inst: Instance, override: FolderRef | undefined | null): Promise<FolderRef> {
  const wanted = resolveFolder(inst, override);
  const isWanted = (f: OmniFolder): boolean => f.id === wanted.id;
  let known: OmniFolder | undefined;
  try {
    const startedAt = Date.now();
    const first = cachedFolders(inst, false);
    known = (await first.folders).find(isWanted);
    // A miss in a list fetched before this call may only mean the folder is newer than the list.
    if (!known && first.at < startedAt) known = (await cachedFolders(inst, true).folders).find(isWanted);
  } catch (err) {
    // The folder list itself could not be read: keep the pair we were given, but never an empty path.
    if (wanted.path) return wanted;
    const reason = err instanceof Error ? err.message : String(err);
    throw httpError(`${inst.label}: folder ${wanted.id} has no saved path and the folder list could not be read: ${reason}`, 502);
  }
  if (!known) {
    throw httpError(`folder ${wanted.id} was not found on ${inst.label} (deleted, or the API key cannot see it); pick the destination folder again`, 400);
  }
  if (!known.path) throw httpError(`folder ${known.id} on ${inst.label} has no path, so documents cannot be imported into it`, 400);
  return { id: known.id, path: known.path, name: known.name };
}
