import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clearFolderCache } from '../omni/folderCache.js';
import { createVault, isUnlocked, lock, unlock, vaultExists } from '../storage/vault.js';

export async function unlockRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/unlock/status',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => ({
      unlocked: isUnlocked(),
      vaultExists: vaultExists(),
    }),
  );

  // Passphrase check: keep this tight so the vault can't be brute-forced.
  app.post('/api/unlock', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async req => {
    const body = z.object({ passphrase: z.string().min(1), create: z.boolean().optional() }).parse(req.body);
    // Errors carry their own status (401 wrong passphrase, 409 missing/existing vault, 500 damaged file)
    // and are rendered by the global error handler.
    if (body.create === true) createVault(body.passphrase);
    else unlock(body.passphrase);
    return { ok: true };
  });

  app.post('/api/lock', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async () => {
    lock();
    clearFolderCache();
    return { ok: true };
  });
}
