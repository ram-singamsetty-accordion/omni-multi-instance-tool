import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getInstance, isUnlocked } from '../storage/vault.js';
import { OmniClient } from '../omni/client.js';
import type { Instance, OmniFolder } from '../../shared/types.js';

// Omni has no folder name search (only an exact `path` filter), and listing every folder takes one
// rate-limited request per 100 folders. So the full list is cached per instance and searched here.
const FOLDER_CACHE_TTL_MS = 10 * 60_000;
const MAX_FOLDER_RESULTS = 50;
const folderCache = new Map<string, { at: number; folders: Promise<OmniFolder[]> }>();

function cachedFolders(inst: Instance, refresh: boolean): { at: number; folders: Promise<OmniFolder[]> } {
  const hit = folderCache.get(inst.id);
  if (hit && !refresh && Date.now() - hit.at < FOLDER_CACHE_TTL_MS) return hit;
  const entry = { at: Date.now(), folders: new OmniClient(inst).listFolders() };
  folderCache.set(inst.id, entry);
  entry.folders.catch(() => { if (folderCache.get(inst.id) === entry) folderCache.delete(inst.id); });
  return entry;
}

// Every word must match the name or path. Exact matches rank first, then prefix matches.
export function searchFolders(folders: OmniFolder[], q: string): OmniFolder[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...folders].sort((a, b) => a.path.localeCompare(b.path));
  const words = needle.split(/\s+/);
  const scored: { f: OmniFolder; score: number }[] = [];
  for (const f of folders) {
    const name = f.name.toLowerCase();
    const path = f.path.toLowerCase();
    if (!words.every(w => name.includes(w) || path.includes(w))) continue;
    const score = name === needle || path === needle ? 0 : name.startsWith(needle) || path.startsWith(needle) ? 1 : 2;
    scored.push({ f, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.f.name.localeCompare(b.f.name)).map(s => s.f);
}

export async function folderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/instances/:id/folders', async (req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { q, refresh } = z.object({ q: z.string().max(200).default(''), refresh: z.string().optional() }).parse(req.query);
    const inst = getInstance(id);
    if (!inst) return reply.code(404).send({ error: 'instance not found' });
    const entry = cachedFolders(inst, refresh === '1');
    const matches = searchFolders(await entry.folders, q);
    return { folders: matches.slice(0, MAX_FOLDER_RESULTS), total: matches.length, cachedAt: entry.at };
  });

  app.get('/api/instances/:id/folder', async (req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { folderId } = z.object({ folderId: z.string().optional() }).parse(req.query);
    const inst = getInstance(id);
    if (!inst) return reply.code(404).send({ error: 'instance not found' });
    const target = folderId || inst.folderId;
    if (!target) return reply.code(400).send({ error: 'no folder chosen and the instance has no default folder' });
    const client = new OmniClient(inst);
    const docs = await client.listFolder(target, { includeLabels: true });
    return docs;
  });

  app.get('/api/instances/:id/labels', async (req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = getInstance(id);
    if (!inst) return reply.code(404).send({ error: 'instance not found' });
    const client = new OmniClient(inst);
    return await client.listLabels();
  });

  app.patch('/api/instances/:id/documents/:docId/labels', async (req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const { id, docId } = z.object({ id: z.string().uuid(), docId: z.string().min(1) }).parse(req.params);
    const body = z.object({
      add: z.array(z.string().min(1)).optional(),
      remove: z.array(z.string().min(1)).optional(),
    }).parse(req.body);
    const inst = getInstance(id);
    if (!inst) return reply.code(404).send({ error: 'instance not found' });
    const client = new OmniClient(inst);
    await client.setDocumentLabels(docId, body.add ?? [], body.remove ?? []);
    return { ok: true };
  });

  app.patch('/api/instances/:id/documents/:docId', async (req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const { id, docId } = z.object({ id: z.string().uuid(), docId: z.string().min(1) }).parse(req.params);
    const body = z.object({
      name: z.string().min(1).max(254).optional(),
      description: z.string().nullable().optional(),
      clearExistingDraft: z.boolean().optional(),
    }).parse(req.body);
    const inst = getInstance(id);
    if (!inst) return reply.code(404).send({ error: 'instance not found' });
    const client = new OmniClient(inst);
    await client.patchDoc(docId, body);
    return { ok: true };
  });
}
