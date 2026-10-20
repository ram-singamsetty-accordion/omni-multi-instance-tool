import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, fsyncSync, closeSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deriveKey, encrypt, decrypt, randomSalt, SIZES } from './crypto.js';
import { httpError } from '../httpError.js';
import { baseUrlOrigin } from './baseUrl.js';
import type { DashboardFilter, Instance, InstancePublic, PostMigrationAction } from '../../shared/types.js';

interface VaultData {
  version: 1;
  instances: Instance[];
  appDisabledEntities?: string[];
}

export const VAULT_PATH = process.env.VAULT_PATH ?? './data/vault.enc';

let derivedKey: Buffer | null = null;
let salt: Buffer | null = null;
let cache: VaultData | null = null;
// Hash of the vault.enc this process last read or wrote; '' = not tracking (locked). Guards against
// overwriting a file another process (for example pnpm seed-env) changed in the meantime.
let diskHash = '';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export const isUnlocked = (): boolean => derivedKey !== null;
export const vaultExists = (): boolean => existsSync(VAULT_PATH);

export function lock(): void {
  if (derivedKey) derivedKey.fill(0);
  derivedKey = null;
  cache = null;
  salt = null;
  diskHash = '';
}

// Creating is a separate, explicit step: unlock() never writes a vault, so a mistyped VAULT_PATH or a
// deleted file cannot silently turn the next passphrase into a new vault's key.
export function createVault(passphrase: string): void {
  if (existsSync(VAULT_PATH)) throw httpError('vault already exists', 409);
  mkdirSync(dirname(VAULT_PATH), { recursive: true });
  const s = randomSalt();
  const k = deriveKey(passphrase, s);
  const fresh: VaultData = { version: 1, instances: [] };
  persist(fresh, k, s, false);
  salt = s;
  derivedKey = k;
  cache = fresh;
}

// State is committed only after every step that can throw, so a failed unlock leaves the vault locked.
export function unlock(passphrase: string): void {
  if (!existsSync(VAULT_PATH)) throw httpError(`vault file not found at ${VAULT_PATH}`, 409);
  const blob = readFileSync(VAULT_PATH);
  if (blob.length < SIZES.SALT_LEN + SIZES.IV_LEN + SIZES.TAG_LEN) throw httpError('vault file is corrupt', 500);
  const fileSalt = blob.subarray(0, SIZES.SALT_LEN);
  const payload = blob.subarray(SIZES.SALT_LEN);
  let key: Buffer;
  let json: string;
  try {
    key = deriveKey(passphrase, fileSalt);
    json = decrypt(payload, key);
  } catch {
    // AES-GCM cannot tell a wrong passphrase from a damaged file.
    throw httpError('Incorrect passphrase (or vault.enc is damaged; see vault.enc.bak)', 401);
  }
  const parsed = JSON.parse(json) as VaultData;
  if (parsed.version !== 1) throw new Error(`unsupported vault version: ${parsed.version}`);
  // Migrate dashboardEnabled (boolean) → dashboardTabs (array)
  let migrated = false;
  for (const inst of parsed.instances) {
    if ('dashboardEnabled' in inst) {
      const legacy = (inst as Record<string, unknown>).dashboardEnabled;
      inst.dashboardTabs = legacy === false ? [] : ['connections', 'users'];
      delete (inst as Record<string, unknown>).dashboardEnabled;
      migrated = true;
    }
  }
  const s = Buffer.from(fileSalt);
  // Only after a successful decrypt, so a wrong passphrase cannot disarm the stale-file guard.
  diskHash = sha(blob);
  if (migrated) {
    try {
      persist(parsed, key, s);
    } catch (e) {
      console.warn('[vault] migration could not be saved; it will be retried on the next unlock:', e);
    }
  }
  salt = s;
  derivedKey = key;
  cache = parsed;
}

// Write to a temp file, fsync, then rename over the live file: a failure or crash at any point
// leaves the previous vault.enc intact. vault.enc.bak holds the generation before the last write.
function writeVaultFile(data: Buffer, backup: boolean): void {
  const tmp = `${VAULT_PATH}.tmp`;
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (backup) {
      try {
        if (existsSync(VAULT_PATH)) copyFileSync(VAULT_PATH, `${VAULT_PATH}.bak`);
      } catch { /* best effort */ }
    }
    renameSync(tmp, VAULT_PATH);
  } catch (e) {
    // Any failure (for example ENOSPC mid-write) must not leave a partial tmp holding disk space.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function persist(data: VaultData, key: Buffer | null = derivedKey, s: Buffer | null = salt, backup = true): void {
  if (!key || !s) throw httpError('vault locked', 423);
  if (diskHash && existsSync(VAULT_PATH) && sha(readFileSync(VAULT_PATH)) !== diskHash) {
    throw httpError('vault.enc was changed by another process (for example pnpm seed-env). Lock and unlock to reload, then retry.', 409);
  }
  const out = Buffer.concat([s, encrypt(JSON.stringify(data), key)]);
  writeVaultFile(out, backup);
  diskHash = sha(out);
}

function requireCache(): VaultData {
  if (!cache) throw httpError('vault locked', 423);
  return cache;
}

// Apply a change to a copy and swap it in only after the write succeeded, so a failed write
// leaves the in-memory vault (and what the UI lists) identical to what is on disk.
function mutate<T>(fn: (draft: VaultData) => T): T {
  const draft = structuredClone(requireCache());
  const result = fn(draft);
  persist(draft);
  cache = draft;
  return result;
}

function maskKey(k: string): string {
  if (k.length <= 8) return '••••';
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

export function toPublic(i: Instance): InstancePublic {
  const { apiKey: _apiKey, ...rest } = i;
  void _apiKey;
  return { ...rest, apiKeyMasked: maskKey(i.apiKey) };
}

export function listInstances(): InstancePublic[] {
  return requireCache().instances.map(toPublic);
}

export function getInstance(id: string): Instance | undefined {
  return requireCache().instances.find(i => i.id === id);
}

export function upsertInstance(input: Omit<Instance, 'id'> & { id?: string }): InstancePublic {
  return mutate(d => {
    if (input.id) {
      const idx = d.instances.findIndex(i => i.id === input.id);
      if (idx === -1) throw httpError('instance not found', 404);
      const existing = d.instances[idx]!;
      // An empty key keeps the stored one, so it must not be sent to a different host.
      if (!input.apiKey && baseUrlOrigin(input.baseUrl) !== baseUrlOrigin(existing.baseUrl)) {
        throw httpError('Re-enter the API key when changing the base URL', 400);
      }
      const merged: Instance = {
        ...existing,
        ...input,
        apiKey: input.apiKey || existing.apiKey,
        id: input.id,
      };
      d.instances[idx] = merged;
      return toPublic(merged);
    }
    const created: Instance = { ...input, id: randomUUID() };
    d.instances.push(created);
    return toPublic(created);
  });
}

export function deleteInstance(id: string): void {
  mutate(d => {
    d.instances = d.instances.filter(i => i.id !== id);
  });
}

export function setInstanceActions(id: string, actions: PostMigrationAction[]): void {
  mutate(d => {
    const idx = d.instances.findIndex(i => i.id === id);
    if (idx === -1) throw httpError('instance not found', 404);
    d.instances[idx] = { ...d.instances[idx]!, postMigrationActions: actions };
  });
}

export function setInstanceDashboardTabs(id: string, tabs: ('connections' | 'users')[]): void {
  mutate(d => {
    const idx = d.instances.findIndex(i => i.id === id);
    if (idx === -1) throw httpError('instance not found', 404);
    d.instances[idx] = { ...d.instances[idx]!, dashboardTabs: tabs };
  });
}

export function changePassphrase(currentPassphrase: string, newPassphrase: string): void {
  if (!derivedKey || !salt || !cache) throw httpError('vault locked', 423);
  const verifyKey = deriveKey(currentPassphrase, salt);
  if (!verifyKey.equals(derivedKey)) {
    verifyKey.fill(0);
    throw httpError('incorrect passphrase', 400);
  }
  verifyKey.fill(0);
  const newSalt = randomSalt();
  const newKey = deriveKey(newPassphrase, newSalt);
  // Write with the new key first, then swap: a failed write leaves the old key and file in place.
  try {
    persist(cache, newKey, newSalt, false);
  } catch (e) {
    newKey.fill(0);
    throw e;
  }
  const oldKey = derivedKey;
  derivedKey = newKey;
  salt = newSalt;
  oldKey.fill(0);
  // The backup is encrypted with the old passphrase.
  try { unlinkSync(`${VAULT_PATH}.bak`); } catch { /* ignore */ }
}

export function setInstanceDashboardFilter(id: string, filter: DashboardFilter): void {
  mutate(d => {
    const idx = d.instances.findIndex(i => i.id === id);
    if (idx === -1) throw httpError('instance not found', 404);
    d.instances[idx] = { ...d.instances[idx]!, dashboardFilter: filter };
  });
}

export function getAppDisabledEntities(): string[] {
  return requireCache().appDisabledEntities ?? [];
}

export function setAppDisabledEntities(keys: string[]): void {
  mutate(d => {
    d.appDisabledEntities = keys;
  });
}

