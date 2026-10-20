import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RETRYABLE_ITEM_KINDS } from '../../shared/types.js';
import type { JobPlanStep } from '../../shared/types.js';
import { isUnlocked } from '../storage/vault.js';
import { buildPlan } from '../jobs/planner.js';
import { busyJob, destKeys, isRunning, runJob } from '../jobs/runner.js';
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

const busyMessage = (jobId: string): string =>
  `another migration (job ${jobId}) is still running against this destination folder; wait for it to finish, then run again`;

const createInput = z.object({
  sourceId: z.string().uuid(),
  destIds: z.array(z.string().uuid()).min(1),
  docIds: z.array(z.string()).min(1),
  emptyFirst: z.boolean().default(false),
  postMigrationActions: z.array(actionSchema).default([]),
  sourceFolder: folderRef.optional(),
  destFolders: z.record(folderRef).default({}),
});

// Execute must name the plan the user reviewed; preview has nothing to compare against.
const executeInput = createInput.extend({ expectedDigest: z.string().min(1) });

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
    const input = executeInput.parse(req.body);
    // Cheap early refusal; checked again below, because the plan can resolve different folders and
    // another job can start while it is built.
    const busy = busyJob(destKeys(input.destIds, input.destFolders));
    if (busy) return reply.code(409).send({ error: busyMessage(busy) });
    const plan = await buildPlan(input);
    // The plan is rebuilt from the live destinations; run it only if it is the one the user reviewed.
    // Otherwise (a dashboard added or changed since the preview) hand back the new plan for review.
    if (input.expectedDigest !== plan.digest) {
      return reply.code(409).send({ error: 'destination changed since preview; review the updated plan', plan });
    }
    // No await between this check and runJob(job): that is what makes the claim race-free.
    const busyAfterPlan = busyJob(destKeys(input.destIds, plan.destFolders));
    if (busyAfterPlan) return reply.code(409).send({ error: busyMessage(busyAfterPlan) });
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

    if (isRunning(id)) return reply.code(409).send({ error: 'job is still running' });

    const allFailed = getFailedItems(id);
    if (allFailed.length === 0) return reply.code(400).send({ error: 'no failed items to retry' });
    const failed = allFailed.filter(f => f.docId && RETRYABLE_ITEM_KINDS.includes(f.kind));
    // A delete item's docId is the destination document; for every other kind it is the source document.
    const deletes = failed.filter(f => f.kind === 'delete');
    const redo = failed.filter(f => f.kind !== 'delete');
    if (failed.length === 0) {
      return reply.code(400).send({
        error: 'nothing to retry: only query-model or verify steps failed, and retry does not re-run those. Start a new migration to re-check them.',
      });
    }

    const pairKey = (destId: string, docId: string | null): string => `${destId}:${docId}`;
    const redoPairs = new Set(redo.map(f => pairKey(f.destId, f.docId)));
    const failedDestIds = [...new Set(failed.map(f => f.destId))];
    // Also covers a double click and retrying a job that is still running (its own folders are claimed).
    const busy = busyJob(destKeys(failedDestIds, parent.destFolders));
    if (busy) return reply.code(409).send({ error: busyMessage(busy) });

    // Only the failed (destination, document) pairs are re-planned, against what the destination holds
    // now: a dashboard that already landed becomes update -> verify -> meta instead of a second import,
    // a missing one gets export -> import -> models -> verify -> meta. Planned before createJob, so a
    // planning error leaves no empty job behind.
    let steps: JobPlanStep[] = [];
    let destFolders = parent.destFolders;
    if (redoPairs.size > 0) {
      const plan = await buildPlan({
        sourceId: parent.sourceId,
        destIds: [...new Set(redo.map(f => f.destId))],
        docIds: [...new Set(redo.map(f => f.docId!))],
        emptyFirst: false,
        sourceFolder: parent.sourceFolder ?? undefined,
        destFolders: parent.destFolders,
      });
      steps = plan.steps.filter(s => s.kind !== 'delete' && redoPairs.has(pairKey(s.destId, s.docId)));
      destFolders = { ...parent.destFolders, ...plan.destFolders };
    }
    if (deletes.length === 0 && steps.length === 0) return reply.code(400).send({ error: 'nothing to retry' });

    const destIds = [...new Set([...deletes, ...steps].map(x => x.destId))];
    // No await between this check and runJob(child): that is what makes the claim race-free.
    const busyAfterPlan = busyJob(destKeys(destIds, destFolders));
    if (busyAfterPlan) return reply.code(409).send({ error: busyMessage(busyAfterPlan) });

    const child = createJob({
      sourceId: parent.sourceId,
      destIds,
      docIds: [...new Set(steps.map(s => s.docId!))], // delete items carry destination ids: never in docIds
      emptyFirst: false,
      parentJobId: parent.id,
      sourceFolder: parent.sourceFolder,
      destFolders,
    });

    // Exports first, then deletes, as the planner orders them: a failed export blocks the deletes (see runner.ts).
    const fromStep = (s: JobPlanStep): NewItem => ({ jobId: child.id, destId: s.destId, kind: s.kind, docId: s.docId, docName: s.docName });
    const items: NewItem[] = [
      ...steps.filter(s => s.kind === 'export').map(fromStep),
      ...deletes.map(f => ({ jobId: child.id, destId: f.destId, kind: 'delete' as const, docId: f.docId, docName: f.docName })),
      ...steps.filter(s => s.kind !== 'export').map(fromStep),
    ];
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
    if (!isUnlocked()) return reply.code(423).send({ error: 'vault locked' });
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!getJob(id)) return reply.code(404).send({ error: 'job not found' });
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // The client refetches the job on every hello, which covers events missed before this connection
    // (page load, or an automatic reconnect).
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ jobId: id })}\n\n`);

    // Nothing more will be published for a job that is not running: end the stream now instead of
    // holding a connection (and a keepalive timer) open until the browser closes it.
    if (!isRunning(id)) {
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ jobId: id, type: 'done', status: 'done', at: Date.now() })}\n\n`);
      reply.raw.end();
      return reply;
    }

    // Subscribes in the same tick as the isRunning check, so the 'done' publish cannot slip past.
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true; // the unsubscribe function is not idempotent
      clearInterval(keepalive);
      unsub();
    };
    const unsub = subscribe(id, evt => {
      reply.raw.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      if (evt.type === 'done') {
        cleanup();
        reply.raw.end();
      }
    });

    const keepalive = setInterval(() => {
      reply.raw.write(`: keepalive\n\n`);
    }, 15_000);

    req.raw.on('close', cleanup);

    return reply;
  });
}
