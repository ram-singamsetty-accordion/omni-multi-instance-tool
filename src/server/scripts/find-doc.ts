import { OmniClient } from '../omni/client.js';
import { findInstance, isRole, unlockVault } from './cli.js';

// Usage:
//   tsx src/server/scripts/find-doc.ts <source|destination> <instanceLabel> [nameContains] [--all]
//
// Lists documents (name + identifier) in an instance's configured folder, optionally
// filtered by a case-insensitive substring match on name. Useful for finding the
// docId to pass to delete-doc.ts. Pass --all to list every document on the instance
// instead (required when the instance has no folder ID). Only the document rows go to
// stdout; the banner and notices go to stderr.

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const [role, instanceLabel, nameContains] = args.filter(a => a !== '--all');
  if (!isRole(role) || !instanceLabel) {
    console.error('Usage: tsx src/server/scripts/find-doc.ts <source|destination> <instanceLabel> [nameContains] [--all]');
    process.exit(1);
  }

  await unlockVault();
  const inst = findInstance(role, instanceLabel);
  // Without a folder ID, listFolder('') drops the filter and returns every document on the instance.
  if (!inst.folderId && !all) {
    console.error(`Instance "${instanceLabel}" [${role}] has no folder ID configured. Set it on the Instances page, or pass --all to list the whole instance.`);
    process.exit(1);
  }
  const client = new OmniClient(inst);

  console.error(all
    ? `Listing ALL docs on ${instanceLabel} [${role}] (no folder filter)...`
    : `Listing docs in folder ${inst.folderPath} (${inst.folderId}) on ${instanceLabel} [${role}]...`);
  const docs = await client.listFolder(all ? '' : inst.folderId);
  const filtered = nameContains
    ? docs.filter(d => d.name.toLowerCase().includes(nameContains.toLowerCase()))
    : docs;

  if (filtered.length === 0) {
    console.error('No matching documents found.');
    return;
  }
  for (const d of filtered) {
    console.log(`${d.identifier}  ${d.type ?? ''}  ${d.name}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
