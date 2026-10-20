# In-place dashboard update: test plan

## Background

The migrator used to delete a destination dashboard and re-import it whenever it already existed. That gave the dashboard a new identifier, which wiped its schedules and usage analytics.

Now, when a picked dashboard already exists in the destination folder with the same name, the migrator updates it in place through Omni's v2 draft API (read state, patch a draft, publish). The identifier stays the same, so schedules, usage analytics, links and bookmarks survive.

| Situation | Plan steps |
| --- | --- |
| Dashboard already exists at the destination (same name) | `update` → `verify` → `meta` |
| Dashboard doesn't exist at the destination | `export` → `import` → `models` → `verify` → `meta` (unchanged) |

How `update` works (`src/server/jobs/updatePatch.ts`):

- It sends only what differs from the destination: changed or new tabs, filters, and the order, settings, layout and description when they differ. Anything it doesn't send stays as it is. Exception: whenever the tab order differs (a tab is added, removed or moved), it also re-sends every unchanged tab verbatim, because the code assumes Omni rejects an `order` that names tabs the patch does not carry.
- Tabs and filters that exist only at the destination are deleted.
- Unchanged tiles that are not sent keep their internal IDs. Changed tiles get new ones from Omni. Unchanged tiles that are re-sent verbatim (see above) are assumed to keep theirs; this is untested (B3b, C3, C4, C6).
- If nothing differs, nothing is published.
- After an update, `verify` runs only the tabs that changed, plus any tab whose source query model has authored content (tab-only fields or CTEs, changed or not; a model at its empty defaults doesn't count), and is skipped if there are none. The source model is found through the tab's `model_extension_id` in the v2 state and its extension YAML is read from the source; that id is assumed (unconfirmed) to be the same one the export carries, and a model that can't be read is verified rather than skipped. The update can't rebuild a query model, so for those tabs `verify` only detects a broken one (for example after a new import stopped at the `models` step); repairing it means deleting the destination dashboard and migrating it again, which loses its schedules.
- If Omni rejects the update with a 400, the full request and both dashboard states are saved to `data/diff/update-<identifier>-<timestamp>.json`, and the error message shows that path.

Omni rules that aren't in its docs, found while testing:

- A changed tile is rejected ("queryPresentations: expected string, received undefined") unless `query.modelId` is set to the destination's workbook model ID. Omni's v2 read leaves that field out.
- The tab `order` must only name tabs that will still exist after the update. The code is more conservative: it assumes Omni also rejects an order that names tabs the patch omits (`updatePatch.ts`). That stronger rule is unconfirmed; C6 with an order-only patch would confirm it.
- Omni's 400 errors only name the top-level field, not the exact path. That's why the full request is saved on failure.

## How to use this plan

- Tick each box as you go. Note the job ID and anything unexpected next to it.
- Start with the ⭐ cases. They cover the main goal (keeping schedules) and the riskiest delete logic.
- Use a destination you can afford to change. A rejected update publishes nothing, but it first discards any unpublished draft on the destination (recoverable from the Drafts drawer for 30 days). If the patch or publish step then fails, the migrator discards the draft it created, so none should remain; a publish that times out is the exception, because it may still be applied. A successful update publishes a new version, and a failed `verify` does not roll that version back.

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
  - Expect in Job Detail: `update` and `verify` show a grey dot (skipped). `update` has the note "no changes: … already matches the source, nothing published", and `verify` has "no changed or query-model tabs, nothing to verify". `meta` succeeds, and the header shows "2 skipped". (If the dashboard has tiles with tab-only fields or CTEs, `verify` runs on those tiles instead of being skipped, and the header shows "1 skipped". If `verify` runs here on a dashboard with no such tiles, the tab's `model_extension_id` assumption above is wrong; check the `[migrator] ... could not read source query model` warnings in the server log.)
  - Cross-check in Omni: the dashboard's version history has no new entry from this run.
  - Hover over a note to read all of it.
  - If the older-format table on `ada930b3` (tab 11) shows as changed on every run, Omni rewrites that table's wrap settings when it saves. The comparison would then need to ignore that difference.
  - ✅ 2026-10-20: passed on `ada930b3`.
- [ ] **A5 Two destinations in one run.** Pick one destination that has the dashboard and one that doesn't.
  - Expect: update on the first, import on the second, and both correct.

## B. Schedules and history (the goal)

- [ ] **B1 ⭐ Dashboard-level schedule.** It's still attached after the update, and its next delivery goes out.
- [ ] **B2 ⭐ Schedule with filter overrides.** It's still correct. Filter IDs were identical on source and destination for `ada930b3`.
- [ ] **B3 ⭐ Single-tile schedule or alert on an unchanged tile**, with no add, remove or reorder in the update (see B3b). It survives.
- [ ] **B3b Schedule or alert on an unchanged tile after an add, remove or reorder.** Run C3, C4 or C6 on a dashboard that has a tile-level schedule or alert on a tile you did not touch. In these cases the update re-sends every unchanged tab verbatim; this has not been tested.
  - Expect: the update succeeds (no 400 about queryPresentations or modelId on the re-sent tabs), the untouched tile keeps its ID, and its schedule still delivers.
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
  - Then remove a label at the source (and, as a second check, add a label only on the destination dashboard) and run again. Expect: the `meta` item notes the removed label(s), and the destination dashboard's labels equal the source's. Destination-only labels are removed too (an in-place update mirrors the source); the schedules are untouched.
- [x] **C11 Older table format.** Check column text wrapping on a table that sets wrapping per column (tab 11 on `ada930b3`: one date column wraps, one is clipped in the source).
  - ✅ 2026-10-20: passed on `ada930b3`.

## D. Folder and delete rules

- [ ] **D1 ⭐ "Empty each destination folder" ticked** with a mix of matching and unrelated dashboards at the destination.
  - Expect: matching dashboards are updated in place, and only the unrelated ones are deleted.
- [ ] **D2 ⭐ Same-name duplicates at the destination.** The destination folder has two dashboards with the same name as a selected one (for example the original with schedules, plus a copy made yesterday). Preview.
  - Expect: the preview is refused with a message naming the destination and listing the ids of the same-name copies. Nothing is updated or deleted. After you delete or rename the extra copy in Omni, the same run updates the remaining dashboard in place.
- [ ] **D3 Per-run folder pickers.** Pick non-default source and destination folders.
  - Expect: the same-name match happens in the chosen destination folder.
- [ ] **D4 ⭐ Empty first with a destination that can't take the import.** Tick "Empty each destination folder" and use a destination with a wrong Base Model ID.
  - Expect: the plan lists `export` steps before `delete` steps. The `delete` steps end failed ("not deleted: destination model unusable ...", with the Omni error clipped) and the destination folder is untouched. After you fix the Base Model ID, Retry runs the deletes and the imports.
- [ ] **D5 Delete of a dashboard that is already gone.** Delete one of the listed destination dashboards in Omni after the preview, then run.
  - Expect: that `delete` step succeeds with the note "already deleted", not a 404 failure.
- [ ] **D6 Two selected dashboards with the same name.** Pick two source dashboards that share a name.
  - Expect: Preview is refused with a message listing both ids; neither is migrated. Deselect one (or rename it in the source) and it runs.
- [ ] **D7 ⭐ One job per destination folder.** Execute a migration, and while it is still running (Job Detail shows running) go back, Preview and Execute the same selection again. Also click Retry twice on a failed job.
  - Expect: the second request is refused with "another migration (job …) is still running against this destination folder" and no second job appears. After the first job finishes, the same request is accepted.
- [ ] **D8 ⭐ Destination with a blank or outdated Folder Path.** Save a destination with a valid Folder ID and a blank Folder Path (or a path from before the folder was renamed in Omni). Do not use the per-run picker. Preview, then Execute with "Empty each destination folder" ticked.
  - Expect: the plan shows the folder's real current path, imports land in that same folder, and the next run finds those dashboards and updates them in place instead of adding copies elsewhere.
- [ ] **D9 Destination folder that no longer exists.** Point a destination at a Folder ID that was deleted in Omni (or belongs to another org), then Preview.
  - Expect: Preview is refused with "folder … was not found on …"; nothing is deleted or imported.
- [ ] **D10 Folder list after editing an instance.** Edit an instance's Base URL or API key, then open its folder picker. Separately, with a loaded picker, go offline and click "reload".
  - Expect: after the edit the picker lists the new org's folders, not the previous ones. A failed reload shows its error but the earlier folder list is still searchable once you are back online.

- [ ] **D11 ⭐ Destination changes between Preview and Execute.** Tick "Empty each destination folder", Preview, then save an unrelated dashboard into that destination folder in Omni, then click Execute.
  - Expect: nothing runs. The page shows an amber "Destination changed since preview" message and the plan now lists a `delete` for the new dashboard. The new dashboard is still in Omni. Clicking Execute again on the refreshed plan runs it.

## E. Edge cases (known limits: check each one fails cleanly)

- [ ] **E1 Unpublished draft on the destination.** Expect the update to succeed and the draft to be archived. It can be recovered from the Drafts drawer for 30 days.
  - After the run: version history has one new entry from this run, and no draft remains on the dashboard. If the update itself fails, the old draft is already gone.
- [ ] **E2 Dataset or CTE tab changed in the source.** Known gap: the change doesn't carry over in place, because the model-copy step only runs after an import. Check that nothing breaks. `verify` re-runs these tiles on every update, so a tile left broken is reported (the fix is to delete the destination dashboard and migrate it again).
- [ ] **E3 CSV or spreadsheet tab.** Known gap: the destination keeps its old uploaded data.
- [ ] **E4 Topic or field missing at the destination.** Expect a clear failure in `update` or `verify`.
  - After the failure: if `update` failed, version history has no new entry from this run and no draft should remain. If `update` succeeded and only `verify` failed, the new version is live; nothing rolls it back.
- [ ] **E5 More than 48 tabs to send.** Expect a clear "Omni accepts at most 48" error that says how many tabs are changed or new and how many unchanged ones are re-sent because the tab order changed. On a dashboard with 49 or more tabs, adding, removing or reordering a single tab hits this, because every unchanged tab is re-sent to carry the order. Whether Omni really needs that re-send is untested: if it validates `order` against the merged draft, the re-send can be dropped.
- [ ] **E6 Classic-layout dashboard.** Expect a 422 asking for a layout upgrade.
- [ ] **E7 Dashboard that can only be edited through a branch.** Expect a 400 on publish.
  - After the failure: version history has no new entry from this run. The migrator discards the draft its patch created, so check that no draft remains on the dashboard (not observed yet).
- [ ] **E8 New cross-model (foreign) tab in the source.** A 400 or 403 is expected.

## F. Failures, retry and UI

- [x] **F1 Saved error file.** On an update 400, the error shows a `data/diff/update-*.json` path and the file exists.
  - ✅ 2026-10-20: a file was written for each rejected update on `ada930b3`.
- [ ] **F2 Retry a failed update.** Expect a new job with `update` → `verify` → `meta`.
- [ ] **F2a ⭐ Retry only the failed pairs.** Migrate dashboards A and B to destinations D1 and D2 while D1 has a wrong Base Model ID, so both fail on D1 and succeed on D2. Fix D1's Base Model ID, then click Retry.
  - Expect: "Retry 2 failed" and a new job with steps for D1 only (`export` → `import` → `models` → `verify` → `meta` for A and for B), nothing for D2, and no second copy of A or B on D2. Clicking Retry again on the original job adds no duplicates on D1 either: the dashboards now exist, so the steps are `update` → `verify` → `meta` with a "no changes" note.
- [ ] **F2b Retry when only `meta` failed.** Make the label step fail (for example remove the API key's right to create labels on the destination), then retry after fixing it.
  - Expect: the button counts it; the new job is `update` → `verify` → `meta` on the existing dashboard (no second import) and the labels are set.
- [ ] **F2c Retry when only `models` or `verify` failed.** Expect no Retry button; the header explains that retry does not re-run those and to start a new migration.
- [ ] **F2d Retry error shown.** Cause the retry to be refused (for example retry while another job runs on that destination folder).
  - Expect: the reason appears in red next to the button instead of nothing happening.
- [x] **F3 Slow verify.** A tile query with no answer within 60 seconds is not retried. If no tile fails, the `verify` step still succeeds, with the grey note "checked N tile(s), K timed out: <tile names>" (hover for the full text). The server console logs `tile "<name>" timed out; not verified`. If another tile fails, the step fails and only the failure is shown in the UI. Tiles that could not be checked because of an auth, rate-limit or gateway error are counted in the same note as "K not verified (<reason>)". This applies after imports too.
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
