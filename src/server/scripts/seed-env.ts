import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { unlock, upsertInstance, listInstances } from '../storage/vault.js';
import type { InstanceRole } from '../../shared/types.js';

interface Entry {
  label: string;
  role: InstanceRole;
  baseUrl: string;
  apiKey: string;
  userId: string;
  modelId: string;
  folderId: string;
  folderPath: string;
}

function read(prefix: string, role: InstanceRole, defaultLabel: string): Entry | null {
  const v = (k: string): string => process.env[`${prefix}_${k}`] ?? '';
  const apiKey = v('API_KEY');
  if (!apiKey) return null;
  return {
    label: v('LABEL') || defaultLabel,
    role,
    baseUrl: v('BASE_URL'),
    apiKey,
    userId: v('USER_ID'),
    modelId: v('MODEL_ID'),
    folderId: v('FOLDER_ID'),
    folderPath: v('FOLDER_PATH'),
  };
}

async function prompt(q: string, silent = false): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const out = stdout as unknown as { write: (s: string) => void };
  const origWrite = out.write;
  if (silent) {
    const write = origWrite.bind(out);
    out.write = (s: string) => write(s.includes(q) ? s : '');
  }
  const answer = await rl.question(q);
  rl.close();
  out.write = origWrite;
  return answer.trim();
}

async function main(): Promise<void> {
  const entries: Entry[] = [];
  for (let i = 1; i <= 9; i++) {
    const e = read(`SOURCE_${i}`, 'source', `Source ${i}`);
    if (e) entries.push(e);
  }
  for (let i = 1; i <= 9; i++) {
    const e = read(`DEST_${i}`, 'destination', `Dest ${i}`);
    if (e) entries.push(e);
  }
  if (entries.length === 0) {
    console.error('No *_API_KEY values found in .env. Nothing to seed.');
    process.exit(1);
  }
  console.log(`Found ${entries.length} instances to seed:`);
  for (const e of entries) console.log(`  - [${e.role}] ${e.label} @ ${e.baseUrl}`);

  const passphrase = await prompt('Vault passphrase: ', true);
  if (!passphrase) {
    console.error('passphrase required');
    process.exit(1);
  }
  unlock(passphrase);

  const existing = listInstances();
  for (const e of entries) {
    const match = existing.find(x => x.label === e.label && x.role === e.role);
    if (match) {
      upsertInstance({ ...e, id: match.id });
      console.log(`updated ${e.label}`);
    } else {
      upsertInstance(e);
      console.log(`created ${e.label}`);
    }
  }
  console.log('done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
