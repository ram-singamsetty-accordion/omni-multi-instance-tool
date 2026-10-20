# In-place dashboard update: test plan

## Background

The migrator used to delete a destination dashboard and re-import it whenever it already existed. That gave the dashboard a new identifier, which wiped its schedules and usage analytics.

Now, when a picked dashboard already exists in the destination folder with the same name, the migrator updates it in place through Omni's v2 draft API (read state, patch a draft, publish). The identifier stays the same, so schedules, usage analytics, links and bookmarks survive.

| Situation | Plan steps |
| --- | --- |
| Dashboard already exists at the destination (same name) | `update` → `verify` → `meta` |
| Dashboard doesn't exist at the destination | `export` → `import` → `models` → `verify` → `meta` (unchanged) |

How `update` works (`src/server/jobs/updatePatch.ts`):

- It sends only what differs from the destination: changed or new tabs, filters, and the order, settings, layout and description when they differ. Anything it doesn't send stays as it is.
- Tabs and filters that exist only at the destination are deleted.
- Unchanged tiles keep their internal IDs. Changed tiles get new ones from Omni.
- If nothing differs, nothing is published.
- After an update, `verify` runs only the tabs that changed, and is skipped if none did.
- If Omni rejects the update with a 400, the full request and both dashboard states are saved to `data/diff/update-<identifier>-<timestamp>.json`, and the error message shows that path.

Omni rules that aren't in its docs, found while testing:

- A changed tile is rejected ("queryPresentations: expected string, received undefined") unless `query.modelId` is set to the destination's workbook model ID. Omni's v2 read leaves that field out.
- The tab `order` must only name tabs that will still exist after the update.
- Omni's 400 errors only name the top-level field, not the exact path. That's why the full request is saved on failure.

## How to use this plan

- Tick each box as you go. Note the job ID and anything unexpected next to it.
- Start with the ⭐ cases. They cover the main goal (keeping schedules) and the riskiest delete logic.
- Use a destination you can afford to change. A failed update leaves the destination as it was, but a successful one publishes a new version.

## Results so far (2026-10-20)

Ticked boxes below mean the case passed.

| Case | Result | Evidence |
| --- | --- | --- |
| A2 New dashboard | ✅ Passed | First migration of the dashboard, before it existed at the destination, imported successfully. |
| A1 Update an existing dashboard | ✅ Passed | Second migration updated `ada930b3` in place. It needed four fixes first; see "Omni rules" above. |
| C1 Visualization setting | ✅ Passed | The `ada930b3` update changed tab 5's data labels, and the destination matches the source. |
| C11 Older table format | ✅ Passed | The same update changed tab 11's per-column text wrapping, and it displays correctly. |
| A4 Re-run with no changes | ✅ Passed | A re-run published nothing. |
| F1 Saved error file | ✅ Passed | Each rejected update wrote a `data/diff/update-ada930b3-*.json` file; these files were used to find the fixes. |
| F3 Slow verify | ✅ Passed | `verify` ran for minutes before the fix and finishes quickly after it. |

Everything else, including all of section B (schedules), is still untested.

## A. Core paths

- [x] **A1 ⭐ Update an existing dashboard.** Pick a dashboard that exists in the destination folder with the same name, and Preview.
  - Expect: the plan shows `update` → `verify` → `meta`, with no `delete`, `export` or `import`.
  - After the run: same identifier and URL, content matches the source.
  - ✅ 2026-10-20: passed on `ada930b3`.
- [x] **A2 New dashboard.** Pick one that doesn't exist at the destination.
  - Expect: `export` → `import` → `models` → `verify` → `meta`, working as before.
  - ✅ 2026-10-20: passed on the first migration of the same dashboard.
- [ ] **A3 Mixed selection.** Pick existing and new dashboards in one run.
  - Expect: each takes its own path.
- [x] **A4 ⭐ Re-run with no changes.** Migrate the same dashboard again.
  - Expect in Job Detail: `update` and `verify` show a grey dot (skipped). `update` has the note "no changes: … already matches the source, nothing published", and `verify` has "no tabs changed". `meta` succeeds, and the header shows "2 skipped".
  - Cross-check in Omni: the dashboard's version history has no new entry from this run.
  - Hover over a note to read all of it.
  - If the older-format table on `ada930b3` (tab 11) shows as changed on every run, Omni rewrites that table's wrap settings when it saves. The comparison would then need to ignore that difference.
  - ✅ 2026-10-20: passed on `ada930b3`.
- [ ] **A5 Two destinations in one run.** Pick one destination that has the dashboard and one that doesn't.
  - Expect: update on the first, import on the second, and both correct.

## B. Schedules and history (the goal)

- [ ] **B1 ⭐ Dashboard-level schedule.** It's still attached after the update, and its next delivery goes out.
- [ ] **B2 ⭐ Schedule with filter overrides.** It's still correct. Filter IDs were identical on source and destination for `ada930b3`.
- [ ] **B3 ⭐ Single-tile schedule or alert on an unchanged tile.** It survives.
- [ ] **B4 Single-tile schedule or alert on a changed tile.** Check it. It may break, because Omni gives a changed tile a new internal ID.
- [ ] **B5 Usage analytics.** The dashboard's view history is still there.

## C. Content sync (edit the source, then migrate)

After each C test, the `update` note in Job Detail lists what was published, for example: `published to <id>: 2 tab(s) changed: "A", "B"; filters`. Check that it names what you changed.

- [x] **C1 Visualization setting** (for example, data labels on or off). It updates at the destination.
  - ✅ 2026-10-20: passed on `ada930b3` (tab 5's data labels).
- [ ] **C2 Query** (fields, filters or sorts). It updates, and `verify` runs only that tile.
- [ ] **C3 Add a tile.** It appears at the destination.
- [ ] **C4 Remove a tile.** It's deleted at the destination, and other tiles are untouched.
- [ ] **C5 Rename a tile.** The new name appears at the destination.
- [ ] **C6 Reorder tabs.** The order matches the source and nothing is deleted.
- [ ] **C7 Dashboard filters.** Add, remove or edit one, or change the filter order. The destination matches.
- [ ] **C8 Layout.** Move or resize tiles. The layout matches.
- [ ] **C9 Settings.** Change the refresh interval, crossfilter or control-bar options. The destination matches.
- [ ] **C10 Description and labels.** Change the description and add a label. Both carry over.
- [x] **C11 Older table format.** Check column text wrapping on a table that sets wrapping per column (tab 11 on `ada930b3`: one date column wraps, one is clipped in the source).
  - ✅ 2026-10-20: passed on `ada930b3`.

## D. Folder and delete rules

- [ ] **D1 ⭐ "Empty each destination folder" ticked** with a mix of matching and unrelated dashboards at the destination.
  - Expect: matching dashboards are updated in place, and only the unrelated ones are deleted.
- [ ] **D2 Same-name duplicates at the destination.**
  - Expect: the most recently updated one is updated, and the others are deleted.
- [ ] **D3 Per-run folder pickers.** Pick non-default source and destination folders.
  - Expect: the same-name match happens in the chosen destination folder.

## E. Edge cases (known limits: check each one fails cleanly)

- [ ] **E1 Unpublished draft on the destination.** Expect the update to succeed and the draft to be archived. It can be recovered from the Drafts drawer for 30 days.
- [ ] **E2 Dataset or CTE tab changed in the source.** Known gap: the change doesn't carry over in place, because the model-copy step only runs after an import. Check that nothing breaks.
- [ ] **E3 CSV or spreadsheet tab.** Known gap: the destination keeps its old uploaded data.
- [ ] **E4 Topic or field missing at the destination.** Expect a clear failure in `update` or `verify`.
- [ ] **E5 More than 48 changed tabs.** Expect a clear "Omni accepts at most 48" error.
- [ ] **E6 Classic-layout dashboard.** Expect a 422 asking for a layout upgrade.
- [ ] **E7 Dashboard that can only be edited through a branch.** Expect a 400 on publish.
- [ ] **E8 New cross-model (foreign) tab in the source.** A 400 or 403 is expected.

## F. Failures, retry and UI

- [x] **F1 Saved error file.** On an update 400, the error shows a `data/diff/update-*.json` path and the file exists.
  - ✅ 2026-10-20: a file was written for each rejected update on `ada930b3`.
- [ ] **F2 Retry a failed update.** Expect a new job with `update` → `verify` → `meta`.
- [x] **F3 Slow verify.** A tile query with no answer within 60 seconds shows "timed out; not verified" instead of being retried for minutes. This applies after imports too.
  - ✅ 2026-10-20: verify ran for minutes on `ada930b3` before the fix and finishes quickly after it.
- [ ] **F4 Import-path regression.** Migrate a dashboard with CTE or tab-only fields as a new dashboard. Expect `models` to copy them and `verify` to pass.
- [ ] **F5 UI.**
  - `update` steps show in violet on Migrate and Job Detail.
  - Notes on succeeded or skipped steps show in grey; only failures show in red.
  - History shows the job correctly.
  - The "Empty each destination folder" label mentions in-place updates.

## Notes for testers

- `pnpm dev` runs the server with `tsx watch`. Saving a server file restarts it, which stops any running job. The UI may then keep showing that job as running. Refresh and unlock the vault again.
- Files under `data/diff/` contain dashboard definitions (queries, filter values), but no credentials. `data/` is gitignored.
- Fallback if in-place updates ever stop working: delete and re-import, then recreate the schedules through Omni's Schedules API. Limits:
  - Recreated schedules are owned by the API key's user.
  - SFTP passwords aren't returned by the API, so SFTP schedules need them re-entered.
  - Run history, usage analytics and the URL don't carry over.
