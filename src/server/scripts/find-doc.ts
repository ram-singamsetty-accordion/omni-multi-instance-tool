import { OmniClient } from '../omni/client.js';
import { findInstance, isRole, unlockVault } from './cli.js';

// Usage:
//   tsx src/server/scripts/find-doc.ts <source|destination> <instanceLabel> [nameContains]
//
// Lists documents (name + identifier) in an instance's configured folder, optionally
// filtered by a case-insensitive substring match on name. Useful for finding the
// docId to pass to delete-doc.ts.

async function main(): Promise<void> {
  const [role, instanceLabel, nameContains] = process.argv.slice(2);
  if (!isRole(role) || !instanceLabel) {
    console.error('Usage: tsx src/server/scripts/find-doc.ts <source|destination> <instanceLabel> [nameContains]');
    process.exit(1);
  }

  await unlockVault();
  const inst = findInstance(role, instanceLabel);
  const client = new OmniClient(inst);

  console.log(`Listing docs in folder ${inst.folderPath} (${inst.folderId}) on ${instanceLabel} [${role}]...`);
  const docs = await client.listFolder(inst.folderId);
  const filtered = nameContains
    ? docs.filter(d => d.name.toLowerCase().includes(nameContains.toLowerCase()))
    : docs;

  if (filtered.length === 0) {
    console.log('No matching documents found.');
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
