import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stdin, stderr } from 'node:process';
import type { Instance } from '../../shared/types.js';
import { unlock, vaultExists, VAULT_PATH, listInstances, getInstance } from '../storage/vault.js';

// Shared setup for the command-line scripts that work against an existing vault.

// Asks for the vault passphrase without echoing it (or reads VAULT_PASSPHRASE), then unlocks.
// Never creates a vault: a mistyped VAULT_PATH must not leave a stray empty one behind.
export async function unlockVault(): Promise<void> {
  if (!vaultExists()) {
    console.error(`No vault found at ${VAULT_PATH}. Create one in the app (pnpm dev) or with pnpm seed-env, or fix VAULT_PATH.`);
    process.exit(1);
  }
  const passphrase = await readPassphrase();
  if (!passphrase) {
    console.error('passphrase required');
    process.exit(1);
  }
  unlockOrExit(passphrase);
}

// Unlocks, reporting the failures vault.ts raises with a status (wrong passphrase, damaged file) as one line.
export function unlockOrExit(passphrase: string): void {
  try {
    unlock(passphrase);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === undefined) throw err;
    if ((err as { statusCode?: number }).statusCode === 401 && process.env.VAULT_PASSPHRASE) {
      console.error(
        'Could not decrypt the vault with VAULT_PASSPHRASE (wrong passphrase, or vault.enc is damaged). ' +
        'If it is set in .env: dotenv ends an unquoted value at the first "#" and trims spaces, so wrap the value in single quotes.',
      );
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }
}

// For creating a vault: always typed twice, and VAULT_PASSPHRASE is ignored because dotenv may have
// cut it short at a "#" and the vault would then be locked behind a passphrase nobody typed.
export async function readNewPassphrase(): Promise<string> {
  try {
    const first = await promptHidden('New vault passphrase: ');
    if (!first) {
      console.error('passphrase required');
      process.exit(1);
    }
    if (first !== (await promptHidden('Confirm passphrase: '))) {
      console.error('passphrases do not match');
      process.exit(1);
    }
    return first;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// Role is needed because source and destination instances often share a label.
export function findInstance(role: 'source' | 'destination', label: string): Instance {
  const all = listInstances();
  // The vault allows duplicate labels, and the scripts select by label only.
  const matches = all.filter(i => i.label === label && i.role === role);
  if (matches.length > 1) {
    console.error(
      `${matches.length} ${role} instances are labeled "${label}": ` +
      matches.map(m => `${m.id} (${m.baseUrl}, folder "${m.folderPath || m.folderId}")`).join('; ') +
      '. Rename them in the UI so the label is unique.',
    );
    process.exit(1);
  }
  const match = matches[0];
  if (!match) {
    console.error(`no ${role} instance labeled "${label}". Available: ${all.map(i => `${i.label} (${i.role})`).join(', ')}`);
    process.exit(1);
  }
  return getInstance(match.id)!;
}

export function isRole(value: string | undefined): value is 'source' | 'destination' {
  return value === 'source' || value === 'destination';
}

// The passphrase is used byte for byte, like the web unlock, so it is not trimmed.
export async function readPassphrase(): Promise<string> {
  if (process.env.VAULT_PASSPHRASE) return process.env.VAULT_PASSPHRASE;
  try {
    return await promptHidden('Vault passphrase: ');
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// Prompts on stderr so piped stdout stays data-only. Readline echoes into a sink that drops
// everything, so Backspace/arrow redraws cannot print the typed text.
async function promptHidden(q: string): Promise<string> {
  if (!stdin.isTTY) {
    console.error('stdin is not a terminal, so the passphrase may be echoed as you type (Git Bash/mintty: use winpty, PowerShell or Windows Terminal). Set VAULT_PASSPHRASE for this run to avoid typing it.');
  }
  const output = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const rl = createInterface({ input: stdin, output, terminal: stdin.isTTY === true });
  stderr.write(q);
  try {
    return await new Promise<string>((resolve, reject) => {
      // question() never settles when stdin closes (EOF, Ctrl+C).
      rl.once('close', () => reject(new Error('input closed before a passphrase was entered')));
      rl.question('').then(resolve, reject);
    });
  } finally {
    rl.close();
    stderr.write('\n'); // Enter's echo is dropped, so end the prompt line
  }
}
