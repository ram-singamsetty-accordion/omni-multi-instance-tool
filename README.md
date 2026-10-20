# Omni Multi-Instance Tools

A local ops toolkit for teams running multiple [Omni](https://omni.co) instances. Monitor, manage, and migrate across all your instances from a single UI — no cloud, no telemetry, credentials stay on your machine.

Built for teams with QA / AU / UK / US environments that need more than the Omni UI offers out of the box.

## Features

### Dashboard
- See all instances at a glance — source and destination alike.
- Total connection counts per instance.
- Flags connections that are missing a schema model.

### Document Migrator
- Multi-destination fan-out — migrate one dashboard to N instances in a single job.
- Folder-scoped — list a source folder, pick what moves.
- Optional "empty destination folder before import" step.
- Job history with per-document status and logs.

### Vault
- API keys live in an encrypted vault (`./data/vault.enc`), unlocked by a passphrase at startup.
- Server binds to `127.0.0.1` only. Nothing leaves your machine.

## Requirements

- Node.js 20+
- pnpm 10+
- Omni API keys for each instance

## Quick start

```bash
pnpm install
cp .env.example .env      # optional — fill in to seed the vault
pnpm seed-env             # optional — imports .env values into the encrypted vault
pnpm dev                  # runs server (5174) + vite dev server
```

Open the URL printed by Vite, set a vault passphrase, and configure instances in the UI.

Command-line helpers (they unlock the vault with a passphrase prompt, or `VAULT_PASSPHRASE` if set):

```bash
pnpm find-doc <source|destination> <instanceLabel> [nameContains]   # list docs + identifiers in the instance's folder
pnpm delete-doc <source|destination> <instanceLabel> <docId>        # delete one document
```

For a production-style local run:

```bash
pnpm build
pnpm start                # serves API + built web UI on http://127.0.0.1:5174
```

## Security notes

- The vault is AES-encrypted with a key derived from your passphrase. If you lose the passphrase, delete `./data/vault.enc` and reconfigure.
- Don't run this tool on a shared machine without a strong passphrase.

## License

MIT — see [LICENSE](./LICENSE).
