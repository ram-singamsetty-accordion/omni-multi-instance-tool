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
- Optional "empty destination folder before import" step. Deletes run after the exports and are not run if an export fails or the destination model can't be read (they show as failed, so Retry runs them later), so a broken run leaves the destination as it was.
- Documents are matched by name. Selecting two documents with one name, or a destination folder that already holds several same-name copies of a selected one, is refused with the ids listed, so nothing is overwritten or deleted by a guess.
- One job at a time per destination folder: a second Execute or Retry aimed at a folder a running job owns is refused (409) instead of racing it.
- A destination folder is always used by ID and by the path Omni reports for that ID. The path typed on the Instances form is only a fallback if Omni's folder list can't be read, so a blank or outdated path can no longer send imports somewhere other than the folder being listed and emptied. A folder that no longer exists is refused at Preview.
- Execute runs the plan you previewed. If a destination changed in between (for example a colleague saved a dashboard there), nothing runs: the page shows the refreshed plan and asks you to review it and execute again.
- Retry re-plans only the failed (destination, document) pairs against what the destination holds now. A dashboard that already landed is updated in place rather than imported again, and the description and labels step is included. Failed deletes are retried too. If only query-model or verify steps failed, there is no Retry button: start a new migration to re-check them. A failed retry shows its reason next to the button.
- An in-place update makes the destination dashboard's labels mirror the source: labels the source no longer has are removed, including ones that exist only on the destination. (A first import just adds the source's labels.)
- Job history with per-document status and logs.

### Vault
- API keys live in an encrypted vault (`./data/vault.enc`), unlocked by a passphrase at startup. Writes are atomic, and one previous generation is kept as `vault.enc.bak` (it holds data from before the last change, including keys of instances you since deleted, until the next write).
- If `vault.enc` is changed by another process (for example `pnpm seed-env` while the server is unlocked), the server refuses to overwrite it: lock and unlock to reload, then retry.
- Server binds to `127.0.0.1` only. Nothing leaves your machine. It also rejects (403) any request whose `Host` or `Origin` is not `127.0.0.1`, `localhost` or `[::1]`, and any cross-site write, so a web page you visit cannot drive the unlocked vault. Open the UI via one of those hostnames.

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

`.env` is also read by the server, the dev proxy and the scripts for the optional `PORT`, `VAULT_PATH`, `DB_PATH` and `LOG_LEVEL` (see `.env.example`). Under `pnpm dev` the UI is only served by Vite (5173); port 5174 is the API.

Open the URL printed by Vite, set a vault passphrase (typed twice, since it cannot be recovered), and configure instances in the UI. A vault is only ever created from that "Create vault" form or by `pnpm seed-env`; if `vault.enc` goes missing later, unlocking reports it instead of silently starting a new vault.

`pnpm seed-env` reads `SOURCE_<n>_*` / `DEST_<n>_*` blocks from `.env` (see `.env.example`). Re-running it updates the instance with the same label (or the same API key and folder, if you renamed it in the UI); blank values never clear stored ones.

On Windows, `.\dev.ps1` runs `pnpm dev` from the repo root (any working directory) and returns pnpm's exit code. If a gitignored `.node22/` folder (portable Node) exists next to it, it is put first on `PATH` for that run only; otherwise the Node already on `PATH` is used.

Command-line helpers (they unlock the vault with a passphrase prompt, or `VAULT_PASSPHRASE` if set; in `.env` single-quote it, because dotenv cuts an unquoted value at the first `#`):

```bash
pnpm find-doc <source|destination> <instanceLabel> [nameContains] [--all]   # list docs + identifiers in the instance's folder (--all: whole instance, needed if no folder ID is set)
pnpm delete-doc <source|destination> <instanceLabel> <docId>        # delete one document
```

For a production-style local run:

```bash
pnpm build
pnpm start                # serves API + built web UI on http://127.0.0.1:5174
```

## Security notes

- The vault is AES-encrypted with a key derived from your passphrase. If you lose the passphrase, delete `./data/vault.enc` (and `vault.enc.bak`) and reconfigure. If `vault.enc` is ever damaged, copy `vault.enc.bak` over it. The `.bak` keeps previous data until the next write, so delete it too if you need a removed key gone from disk.
- Don't run this tool on a shared machine without a strong passphrase.

## License

MIT — see [LICENSE](./LICENSE).
