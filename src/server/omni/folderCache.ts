import { createHash } from 'node:crypto';
import type { Instance, OmniFolder } from '../../shared/types.js';
import { OmniClient } from './client.js';

// Omni has no folder name search (only an exact `path` filter), and listing every folder takes one
// rate-limited request per 100 folders. So the full list is cached per instance and searched here.
const FOLDER_CACHE_TTL_MS = 10 * 60_000;

export interface FolderEntry {
  at: number;
  ok: boolean;
  sig: string;
  folders: Promise<OmniFolder[]>;
}

const folderCache = new Map<string, FolderEntry>();

// Called on Lock, so cached folder lists do not outlive the unlock.
export function clearFolderCache(): void {
  folderCache.clear();
}

export function cachedFolders(inst: Instance, refresh: boolean): FolderEntry {
  // An edited URL or key must not reuse another org's list. A digest, so the key itself is not kept here.
  const sig = createHash('sha256').update(inst.baseUrl).update('\0').update(inst.apiKey).digest('hex');
  const hit = folderCache.get(inst.id);
  if (hit && hit.sig === sig && !refresh && Date.now() - hit.at < FOLDER_CACHE_TTL_MS) return hit;
  const previousGood = hit && hit.ok && hit.sig === sig ? hit : undefined;
  const entry: FolderEntry = { at: Date.now(), ok: false, sig, folders: new OmniClient(inst).listFolders() };
  folderCache.set(inst.id, entry);
  entry.folders.then(
    () => { entry.ok = true; },
    () => {
      if (folderCache.get(inst.id) !== entry) return;
      // A failed reload must not throw away a list that worked.
      if (previousGood) folderCache.set(inst.id, previousGood);
      else folderCache.delete(inst.id);
    },
  );
  return entry;
}
