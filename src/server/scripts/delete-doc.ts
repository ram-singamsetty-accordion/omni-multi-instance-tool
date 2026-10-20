import { OmniClient } from '../omni/client.js';
import { findInstance, isRole, unlockVault } from './cli.js';

// Usage:
//   tsx src/server/scripts/delete-doc.ts <source|destination> <instanceLabel> <docId>

async function main(): Promise<void> {
  const [role, instanceLabel, docId] = process.argv.slice(2);
  if (!isRole(role) || !instanceLabel || !docId) {
    console.error('Usage: tsx src/server/scripts/delete-doc.ts <source|destination> <instanceLabel> <docId>');
    process.exit(1);
  }

  await unlockVault();
  const client = new OmniClient(findInstance(role, instanceLabel));

  console.log(`Deleting ${docId} on ${instanceLabel} [${role}]...`);
  await client.deleteDoc(docId);
  console.log('Deleted.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
