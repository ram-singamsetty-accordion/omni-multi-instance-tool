import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isUnlocked } from '../storage/vault.js';
import { buildPlan } from '../jobs/planner.js';
import { isRunning, runJob } from '../jobs/runner.js';
import { subscribe } from '../jobs/events.js';
import {
  createItems,
  createJob,
  getFailedItems,
  getItems,
  getJob,
  listJobs,
} from '../storage/repo.js';
import type { NewItem } from '../storage/repo.js';
import { runPostMigrationActions } from '../jobs/postMigration.js';

const actionSchema = z.object({
  method: z.string().min(1),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
  body: z.string().default(''),
});

const folderRef = z.object({
  id: z.string().min(1),
  path: z.string().default(''),
  name: z.string().optional(),
});

const createInput = z.object({
  sourceId: z.string().uuid(),
  destIds: z.array(z.string().uuid()).min(1),
  docIds: z.array(z.string()).min(1),
  emptyFirst: z.boolean().default(false),
  postMigrationActions: z.array(actionSchema).default([]),
  sourceFolder: folderRef.optional(),
  destFolders: z.record(folderRef).default({}),
});

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/jobs/preview', async (req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const input = createInput.parse(req.body);
    const plan = await buildPlan(input);
    return plan;
  });

  app.post('/api/actions/run', async (req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const actions = z.array(actionSchema).parse(req.body);
    const results = await runPostMigrationActions(actions);
    return { results };
  });

  app.post('/api/jobs', async (req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const input = createInput.parse(req.body);
    const plan = await buildPlan(input);
    // Store the folders the plan resolved, so the run and any retry use exactly what was previewed.
    const job = createJob({ ...input, sourceFolder: plan.sourceFolder, destFolders: plan.destFolders });
    const items: NewItem[] = plan.steps.map(s => ({
      jobId: job.id,
      destId: s.destId,
      kind: s.kind,
      docId: s.docId,
      docName: s.docName,
    }));
    createItems(items);
    void runJob(job).catch(err => app.log.error({ err, jobId: job.id }, 'runJob failed'));
    return { job, plan };
  });

  app.post('/api/jobs/:id/retry', async (req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parent = getJob(id);
    if (!parent) return reply.code(404).send({ error: 'job not found' });

    const failed = getFailedItems(id).filter(i => i.kind === 'import' || i.kind === 'delete' || i.kind === 'export' || i.kind === 'update');
    if (failed.length === 0) return reply.code(400).send({ error: 'no failed items to retry' });

    const destIds = Array.from(new Set(failed.map(f => f.destId)));
    const docIds = Array.from(new Set(failed.filter(f => f.kind === 'import').map(f => f.docId!).filter(Boolean)));

    const child = createJob({
      sourceId: parent.sourceId,
      destIds,
      docIds,
      emptyFirst: false,
      parentJobId: parent.id,
      sourceFolder: parent.sourceFolder,
      destFolders: parent.destFolders,
    });

    const items: NewItem[] = [];
    for (const f of failed) {
      if (f.kind === 'delete') {
        items.push({ jobId: child.id, destId: f.destId, kind: 'delete', docId: f.docId, docName: f.docName });
      }
    }
    for (const destId of destIds) {
      for (const docId of docIds) {
        const docName = failed.find(f => f.docId === docId)?.docName ?? null;
        items.push({ jobId: child.id, destId, kind: 'export', docId, docName });
        items.push({ jobId: child.id, destId, kind: 'import', docId, docName });
        items.push({ jobId: child.id, destId, kind: 'models', docId, docName });
        items.push({ jobId: child.id, destId, kind: 'verify', docId, docName });
      }
    }
    for (const f of failed) {
      if (f.kind !== 'update' || !f.docId) continue;
      items.push({ jobId: child.id, destId: f.destId, kind: 'update', docId: f.docId, docName: f.docName });
      items.push({ jobId: child.id, destId: f.destId, kind: 'verify', docId: f.docId, docName: f.docName });
      items.push({ jobId: child.id, destId: f.destId, kind: 'meta', docId: f.docId, docName: f.docName });
    }
    createItems(items);
    void runJob(child).catch(err => app.log.error({ err, jobId: child.id }, 'runJob failed'));
    return { job: child };
  });

  app.get('/api/jobs', async (_req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    return listJobs(50);
  });

  app.get('/api/jobs/:id', async (req, reply) => {
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    const items = getItems(id);
    return { ...job, items, running: isRunning(id) };
  });

  app.get('/api/jobs/:id/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ jobId: id })}\n\n`);

    const unsub = subscribe(id, evt => {
      reply.raw.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
    });

    const keepalive = setInterval(() => {
      reply.raw.write(`: keepalive\n\n`);
    }, 15_000);

    req.raw.on('close', () => {
      clearInterval(keepalive);
      unsub();
    });

    return reply;
  });
}
