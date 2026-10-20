// Must stay the first import: storage/vault.ts and storage/db.ts read process.env when they load.
import 'dotenv/config';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import staticPlugin from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { OmniError } from './omni/client.js';
import { unlockRoutes } from './routes/unlock.js';
import { instanceRoutes } from './routes/instances.js';
import { folderRoutes } from './routes/folders.js';
import { jobRoutes } from './routes/jobs.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { getDb } from './storage/db.js';
import { failInterruptedJobs } from './storage/repo.js';

const HOST = '127.0.0.1';
// Empty, non-numeric and 0 all fall back to the default (vite.config.ts reads PORT the same way).
const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 5174;
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  // Only this machine's own UI may talk to the API: a DNS-rebinding page carries a foreign Host, a cross-site
  // page a foreign Origin / Sec-Fetch-Site. Hostname only, never the port: the Vite dev proxy forwards :5173.
  app.addHook('onRequest', async (req, reply) => {
    const block = (message: string) => {
      app.log.warn({ method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin }, `blocked request: ${message}`);
      return reply.code(403).send({ error: 'Forbidden', message });
    };
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!LOCAL_HOSTNAMES.has(host)) return block('host not allowed');
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost = '';
      try { originHost = new URL(origin).hostname.toLowerCase(); } catch { /* 'null' or malformed */ }
      if (!LOCAL_HOSTNAMES.has(originHost)) return block('origin not allowed');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') return block('cross-site request blocked');
    }
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    if (req.url.startsWith('/api')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof ZodError) {
      app.log.warn({ issues: err.issues }, 'validation failed');
      return reply.code(400).send({
        error: 'ValidationError',
        message: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      });
    }
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    const upstream = err instanceof OmniError;
    // Expected 4xx and upstream (Omni) failures are warnings; only faults in this server are errors.
    if (statusCode >= 500 && !upstream) app.log.error({ err }, 'request failed');
    else app.log.warn({ err: { name: err.name, message: err.message, statusCode } }, 'request failed');
    return reply.code(statusCode).send({
      error: err.name || 'Error',
      message: err.message,
      ...(upstream ? { upstreamStatus: err.status } : {}),
    });
  });

  // Generous global default; individual routes tighten this where it matters.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  getDb();

  await app.register(unlockRoutes);
  await app.register(instanceRoutes);
  await app.register(folderRoutes);
  await app.register(jobRoutes);
  await app.register(dashboardRoutes);

  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = resolve(here, '../web');
  // Only serve the built bundle from compiled output (dist/server -> dist/web). Under tsx '../web' is the raw
  // src/web tree, which must not be served; the UI comes from the Vite dev server there.
  const isCompiled = fileURLToPath(import.meta.url).endsWith('.js');
  if (isCompiled && existsSync(resolve(webDist, 'index.html'))) {
    await app.register(staticPlugin, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  } else if (isCompiled) {
    app.log.warn('dist/web not found - run pnpm build; serving API only');
  }

  await app.listen({ host: HOST, port: PORT });
  // After listen, so a second server that fails to bind never touches the first one's live jobs.
  const interrupted = failInterruptedJobs();
  if (interrupted > 0) app.log.warn(`marked ${interrupted} interrupted job(s) as failed/partial`);
  app.log.info(`migrator server listening on http://${HOST}:${PORT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
