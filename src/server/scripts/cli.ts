import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Instance } from '../../shared/types.js';
import { unlock, listInstances, getInstance } from '../storage/vault.js';

// Shared setup for the command-line scripts that work against an existing vault.

// Asks for the vault passphrase without echoing it (or reads VAULT_PASSPHRASE), then unlocks.
export async function unlockVault(): Promise<void> {
  const passphrase = process.env.VAULT_PASSPHRASE || await promptHidden('Vault passphrase: ');
  if (!passphrase) {
    console.error('passphrase required');
    process.exit(1);
  }
  unlock(passphrase);
}

// Role is needed because source and destination instances often share a label.
export function findInstance(role: 'source' | 'destination', label: string): Instance {
  const all = listInstances();
  const match = all.find(i => i.label === label && i.role === role);
  if (!match) {
    console.error(`no ${role} instance labeled "${label}". Available: ${all.map(i => `${i.label} (${i.role})`).join(', ')}`);
    process.exit(1);
  }
  return getInstance(match.id)!;
}

export function isRole(value: string | undefined): value is 'source' | 'destination' {
  return value === 'source' || value === 'destination';
}

async function promptHidden(q: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
  const out = stdout as unknown as { write: (s: string) => void };
  const origWrite = out.write.bind(out);
  out.write = (s: string) => origWrite(s.includes(q) ? s : '');
  const answer = await rl.question(q);
  rl.close();
  out.write = origWrite;
  return answer.trim();
}
