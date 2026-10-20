import 'dotenv/config';
import { createVault, vaultExists, VAULT_PATH, upsertInstance, listInstances, getInstance } from '../storage/vault.js';
import { normalizeBaseUrl } from '../storage/baseUrl.js';
import type { InstancePublic, InstanceRole } from '../../shared/types.js';
import { readPassphrase, readNewPassphrase, unlockOrExit } from './cli.js';

interface Entry {
  label: string; // explicit LABEL, '' when unset
  defaultLabel: string; // used when there is no LABEL ('Source', 'Dest 2', ...)
  role: InstanceRole;
  baseUrl: string;
  apiKey: string;
  userId: string;
  modelId: string;
  folderId: string;
  folderPath: string;
}

const SUFFIXES = ['LABEL', 'BASE_URL', 'API_KEY', 'USER_ID', 'MODEL_ID', 'FOLDER_ID', 'FOLDER_PATH'];
// SOURCE_LABEL (unindexed) and SOURCE_1_LABEL, SOURCE_10_LABEL, ... are all accepted.
const KEY_RE = /^(SOURCE|DEST)(?:_(\d+))?_([A-Z_]+)$/;

function discoverPrefixes(): string[] {
  const prefixes = new Set<string>();
  for (const k of Object.keys(process.env)) {
    const m = KEY_RE.exec(k);
    if (!m) continue;
    if (!SUFFIXES.includes(m[3]!)) {
      console.warn(`${k}: unrecognised suffix, ignored`);
      continue;
    }
    prefixes.add(m[2] ? `${m[1]}_${m[2]}` : m[1]!);
  }
  const rank = (p: string): number => (p.startsWith('SOURCE') ? 0 : 1); // sources first
  const idx = (p: string): number => Number(/_(\d+)$/.exec(p)?.[1] ?? 0);
  return [...prefixes].sort((a, b) => rank(a) - rank(b) || idx(a) - idx(b));
}

function read(prefix: string): Entry | null {
  const v = (k: string): string => (process.env[`${prefix}_${k}`] ?? '').trim();
  const source = prefix.startsWith('SOURCE');
  const n = /_(\d+)$/.exec(prefix)?.[1];
  const apiKey = v('API_KEY');
  if (!apiKey) {
    // Stay quiet for an empty template block, but never drop a filled-in one without saying so.
    if (SUFFIXES.some(s => v(s))) console.warn(`${prefix}: other values are set but ${prefix}_API_KEY is empty, skipped`);
    return null;
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(v('BASE_URL'));
  } catch (err) {
    const msg = v('BASE_URL') ? (err instanceof Error ? err.message : String(err)) : 'is required';
    console.error(`${prefix}_BASE_URL: ${msg}`);
    process.exit(1);
  }
  return {
    label: v('LABEL'),
    defaultLabel: `${source ? 'Source' : 'Dest'}${n ? ` ${n}` : ''}`,
    role: source ? 'source' : 'destination',
    baseUrl,
    apiKey,
    userId: v('USER_ID'),
    modelId: v('MODEL_ID'),
    folderId: v('FOLDER_ID'),
    folderPath: v('FOLDER_PATH'),
  };
}

async function main(): Promise<void> {
  // Everything .env can get wrong is checked here, before the passphrase prompt and any vault write.
  const entries = discoverPrefixes().map(p => read(p)).filter((e): e is Entry => e !== null);
  if (entries.length === 0) {
    console.error('No *_API_KEY values found in .env (expected SOURCE_1_API_KEY, DEST_1_API_KEY, ...). Nothing to seed.');
    process.exit(1);
  }
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.role}:${e.label || e.defaultLabel}`;
    if (seen.has(key)) {
      console.error(`duplicate LABEL in .env: ${e.role} "${e.label || e.defaultLabel}" is used twice. Give each instance a unique label per role.`);
      process.exit(1);
    }
    seen.add(key);
  }
  console.log(`Found ${entries.length} instances to seed:`);
  for (const e of entries) console.log(`  - [${e.role}] ${e.label || e.defaultLabel} @ ${e.baseUrl}`);

  if (vaultExists()) {
    const passphrase = await readPassphrase();
    if (!passphrase) {
      console.error('passphrase required');
      process.exit(1);
    }
    unlockOrExit(passphrase);
  } else {
    console.log(`No vault at ${VAULT_PATH}: a new one will be created. Press Ctrl+C if that is not what you expected (check VAULT_PATH).`);
    createVault(await readNewPassphrase());
  }

  // Each instance is claimed by at most one entry. Labels are matched for every entry before the
  // fallback (an instance renamed in the UI: same key and folder), so a fallback cannot take an
  // instance that another entry names.
  const existing = listInstances();
  const claimed = new Set<string>();
  const matches = new Map<Entry, InstancePublic>();
  const finders: Array<(e: Entry, x: InstancePublic) => boolean> = [
    (e, x) => x.label === (e.label || e.defaultLabel),
    (e, x) => x.folderId === e.folderId && getInstance(x.id)?.apiKey === e.apiKey,
  ];
  for (const finder of finders) {
    for (const e of entries) {
      if (matches.has(e)) continue;
      const m = existing.find(x => !claimed.has(x.id) && x.role === e.role && finder(e, x));
      if (m) {
        matches.set(e, m);
        claimed.add(m.id);
      }
    }
  }
  for (const entry of entries) {
    const { defaultLabel, ...fields } = entry; // keep defaultLabel out of the vault
    const wanted = entry.label || defaultLabel;
    const match = matches.get(entry);
    if (match) {
      const cur = getInstance(match.id)!;
      const keep = (v: string, c: string): string => v || c; // a blank .env value never clears a stored one
      upsertInstance({
        ...cur,
        baseUrl: fields.baseUrl,
        apiKey: fields.apiKey,
        userId: keep(fields.userId, cur.userId),
        modelId: keep(fields.modelId, cur.modelId),
        folderId: keep(fields.folderId, cur.folderId),
        folderPath: keep(fields.folderPath, cur.folderPath),
        label: entry.label || match.label,
      });
      console.log(`updated ${match.label}`);
    } else {
      upsertInstance({ ...fields, label: wanted });
      console.log(`created ${wanted}`);
    }
  }
  console.log('done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
