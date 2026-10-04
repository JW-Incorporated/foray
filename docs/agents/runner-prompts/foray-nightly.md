# Runner prompt — Foray nightly refresh (Claude Cloud scheduled agent)

This is the versioned prompt for the nightly content-refresh agent. It runs
**unattended in Claude Cloud**, once per night, a couple of hours after the
`nightly-refresh` GitHub Action publishes the digest. Its only job is the
**judgment half**: turn a resolved digest into published episodes via a PR.
Be conservative — a broken deploy is far worse than a skipped night.

Version 3 (2026-09-25): the mechanical halves are one command each, `tools/refresh/nightly-runner.mjs` (issue #760). Steps 2-3 and 5 call it (they were hand steps 1-3 and 5-7 before version 3); step 4, the judgement, is unchanged.
The host that runs this prompt is pending: it is moving off the Cloud routine to the Spark (#760 → `docs/plans/spark-central-narration-assessment.md` §5 Phase 5).

Read `CLAUDE.md` first; the copy rules and product principles there are binding.

## The pipeline you sit in

The Action already did the deterministic half (scan feeds, resolve Apple
trackIds, dedup) and published two files to the **`refresh-digest`** branch:
`resolved.json` (the episodes to publish) and `refresh-state.json` (ignore it).
You produce `edits.json` (hooks, tags, and `topics` where an episode differs
from its show's label) and run the committed merge. See
`tools/refresh/README.md` for the full contract.

## Steps (follow exactly)

1. **Sync.** Ensure you are on an up-to-date `main`.

2. **Fetch the digest and check it is fresh — one command, before anything else:**
   ```sh
   node tools/refresh/nightly-runner.mjs fetch-digest
   ```
   It pulls `origin/refresh-digest:resolved.json` into `data-local/resolved.json`
   and prints one verdict line. Exit 0 with `DIGEST_OK date=<YYYY-MM-DD> ...`
   means continue; the `date` it prints is the digest's date and is the date
   you use in step 5. **Any other exit code: stop and open no PR.**
   - exit 3 `DIGEST_STALE` — the `nightly-refresh` Action has not published
     today, so the digest is yesterday's and every item in it is already in
     `discover.json`. Say so in your run output so a human notices.
   - exit 4 `DIGEST_EMPTY` — nothing resolved tonight. Stop.

   **If you were sent here to clear a red watchdog**, the digest is older than
   12 h and `fetch-digest` refuses it — correctly. Do not override it. Re-cut
   the digest instead, which is what recovered #290's lost day:
   ```sh
   rm -f data-local/refresh-state.json          # no seen-guid state: re-emit the window
   node tools/refresh/scan.mjs --window-hours 72
   node tools/refresh/resolve.mjs
   ```
   then continue from step 4, and in step 5 pass `--date <the stranded digest's
   date> --suffix recovery`. That branch name, `nightly/<digest date>-recovery`,
   is load bearing: the overwrite guard in `nightly-refresh.yml` clears itself
   only when a PR matching the stranded digest's date appears (#293 got this
   right as `nightly/2026-08-19-recovery`). The red run's own report prints the
   exact date and `--window-hours` to use; prefer those numbers.

   <details><summary>Why 12 hours, and why the guard points both ways</summary>

   (GitHub does not honour cron punctually under load: the Action's 09:40 slot
   was measured starting at 10:54 and 11:05 on consecutive days. The cron moved
   to 06:40 UTC to restore the ≥2h margin, but this guard is the backstop.)

   **The same guard now exists pointing the other way** (issue #290). If YOU do
   not run, `tools/refresh/watch-nightly.mjs --mode absence` goes red on the same
   12-hour clock, and the Action refuses to overwrite your unread digest. So the
   12 here is not an arbitrary number in one file any more: a digest must be
   consumed within 12h of being made, and whichever half drops it goes red.

   </details>

3. **If `fetch-digest` printed `CANDIDATES <n>`**, read on; otherwise go to step 4.

   **Curation candidates (S-11).** `resolved.json` may also carry a
   top-level `candidates` array — shows that are NOT in the curated
   catalogue but whose PodcastIndex activity changed since the last S-04
   release (fresh episodes on shows nobody has curated in). This is
   informational only: do not author edits for it, do not add these shows
   to `data/catalog.json` yourself. Read it, and if something looks like an
   obvious curation gap worth a human's attention, say so in your PR body
   (or the run output on an empty-`resolved` night) so a daytime session can
   pick it up. Empty or absent `candidates` is normal on a `--source full`
   night or before S-04 has published a release; never treat it as an error.

4. **Author `data-local/edits.json`** — a JSON object `{ "<id>": { "hook",
   "tags", "topics"? } }` with one entry per resolved item you intend to
   publish. For each item in `resolved.json` (each carries `_description`, the
   episode's real blurb, plus `show`/`title`/`topics`):
   - **hook**: ≤ 16 words, grounded in the real description. Banned:
     `fascinating`, `deep dive`, `delve`, `explores`, clickbait withholding,
     any commute-length framing. If the description is *itself* clickbait
     withholding ("we can't get into it here…"), ground the hook in the
     episode's title/subject instead — never quote the tease.
   - **tags**: 5–10, lowercase-hyphenated (`^[a-z0-9]+(-[a-z0-9]+)*$`). Reuse
     the existing vocabulary in `data/item-tags.json` wherever it applies.
   - **topics** (OPTIONAL, #292): the resolved item's `topics` field is its
     **show's** label, not this episode's. **Omit `topics` and that label
     stands** — which is right for a single-subject show, and is the normal
     case. Supply it *only when this episode is about something else*, and it
     replaces the show label for that one episode. Rules:
     - every id must exist in `data/taxonomy.json`. A bad id **fails the whole
       merge** in preflight — it is never quietly ignored;
     - `[]` is **refused**. An episode with no topic is dropped by the
       pipeline, and the product rule is *label, never exclude*. Omit the field
       instead;
     - put the **primary** subject first: `topics[0]` is the item's branch for
       discovery diversity;
     - 1–3 ids is the normal shape. `node tools/refresh/topic-uniformity.mjs
       --show "<title>"` shows how that show is currently labelled.

     This exists because topics used to be assigned per show and could not be
     appealed: 77 of the 99 shows with ≥ 8 episodes carried one identical topic
     set on **every** episode. Authoring `topics` when an episode genuinely
     differs is how that stays fixed; skipping it is how it comes back.
   - **To drop an item**, simply omit it from `edits.json` — `merge.mjs` skips
     resolved items with no edit and reports them. Prefer dropping over forcing
     a weak hook. Drop, at minimum:
     - cross-promos, trailers, and ads that slipped past resolve
     - **filler/between-seasons chatter** — "shooting the breeze between shows",
       hiatus updates, housekeeping. The 2026-07-26 run published one of these;
       it has no subject a hook can be grounded in, which is the tell.
     - **encores and rebroadcasts.** Corner case #3 warns that rebroadcasts
       duplicate old content under a new GUID, so dedup does not catch them.
       If the title or description says encore/replay/"from the archive", drop
       it — the original is very likely already in the pool.
     A good test: if you cannot write a hook that says what the listener will
     actually learn or hear, the item does not belong in the pool.

5. **Merge, validate, and open the PR — one command** (committed machinery; do
   not edit it, just run it):
   ```sh
   node tools/refresh/nightly-runner.mjs finish --date <the DIGEST_OK date> \
     --trailer "Co-Authored-By: <the trailer your harness gives you>"
   ```
   For a recovery run add `--suffix recovery`. It runs `merge.mjs`, then
   `backend`'s `copyRules` + `poolIntegrity` tests, then creates
   `nightly/<date>`, stages exactly `data/discover.json` and
   `data/item-tags.json`, commits `Nightly refresh: +N episodes (<date>)`,
   pushes, and opens the PR. Exit 0 prints `PR_OPENED <url>`. Exits 2, 4 and 5
   have changed nothing; the others stop part-way, so read which:
   - 5 `MERGE_FAILED` — a copy-rule or `topics` failure in `edits.json`. Nothing
     was written. A `not taxonomy node ids: "…"` line is a `topics` typo —
     correct the id against `data/taxonomy.json`, or delete the `topics` key to
     fall back to the show's label. Fix the hook, tags or `topics` (or drop the
     item) and re-run.
   - 6 `TESTS_FAILED` — `merge.mjs` already WROTE the two data files before the
     tests ran. Put them back first:
     `git restore data/discover.json data/item-tags.json`, then fix or drop the
     offenders in `edits.json` and re-run `finish`. Without the restore the
     re-run finds every item already in the pool and stops at 4
     `NOTHING_ADDED` with your fixes never applied.
   - 4 `NOTHING_ADDED` — every item was already in the pool. Stop; no PR.
   - 7 `UNEXPECTED_FILES` — you are on an old checkout that still stamps
     `deploy-manifest.json` or `sw.js`. Stop and re-sync `main`.
   - 1 `GIT_FAILED <step>` or `PR_FAILED` — a git or gh call failed after the
     branch was created (it may already be pushed). Do not re-run `finish` and
     do not open a second PR by hand; stop and put the verdict line and its
     output in your run output for a daytime human.
   **Do NOT merge the PR yourself.** `automerge-nightly.yml` enables auto-merge
   on `nightly/*` PRs whose changed files are all on `ALLOWED_PREFIXES` — both
   of yours are — so it merges once the required checks (`backend`,
   `data-and-site`) pass; the deploys then build and stamp from `main`.

   <details><summary>What `finish` does, step by step (the old hand steps 5-7)</summary>

5. **Merge** (this is committed machinery — do not edit it, just run it):
   ```sh
   node tools/refresh/merge.mjs
   ```
   It enforces the copy rules before writing; if it exits non-zero, fix the
   offending **hook, tags or `topics`** in `edits.json` (or drop the item) and
   re-run. A `not taxonomy node ids: "…"` failure is a `topics` typo — correct
   the id against `data/taxonomy.json`, or delete the `topics` key to fall back
   to the show's label. **Nothing was written on a copy-rule or `topics`
   failure**: merge validates every item before it writes anything, so that
   kind of failed run leaves the data files untouched and re-running after the
   fix is safe. It writes `data/discover.json` + `data/item-tags.json` and
   **nothing else** — no `deploy-manifest.json`, no `sw.js` (issue #701,
   2026-09-24). Those are deploy build outputs now: Vercel's build and the Pages
   workflow stamp them at deploy time, so there is nothing to regenerate and
   nothing extra to commit. If you see a `MANIFEST:` line or a changed `sw.js`,
   you are on an old checkout: stop and re-sync `main`.

6. **Validate.** Never open a red PR:
   ```sh
   cd backend && npx vitest run test/copyRules.test.ts test/poolIntegrity.test.ts
   ```
   Fix or drop offenders and re-run merge until green.

7. **Open a PR — never push to `main`.**
   ```sh
   git switch -c "nightly/$(date -u +%F)"
   git add data/discover.json data/item-tags.json
   git commit   # message: "Nightly refresh: +N episodes (YYYY-MM-DD)" + co-author trailer
   git push -u origin HEAD
   gh pr create --base main --title "Nightly refresh: +N episodes (YYYY-MM-DD)" \
     --body "Automated nightly content refresh. N new episodes from the refresh-digest of <date>. Copy rules + pool integrity green."
   ```
   **Exactly those two files go in the one commit.** Do NOT `git add`
   `deploy-manifest.json`, `data/forays-directory.json` or `sw.js`: the first two
   no longer exist in the tree (they are gitignored build outputs) and the
   required `data-and-site` check fails any PR that commits them or a stamped
   `sw.js`. Do NOT merge it yourself. `automerge-nightly.yml` enables auto-merge
   on `nightly/*` PRs whose changed files are all on `ALLOWED_PREFIXES` — both of
   yours are — so it merges automatically once the required checks (`backend`,
   `data-and-site`) pass; the deploys then build and stamp from `main`.

   </details>

## Hard constraints

- Touch ONLY `data/discover.json` and `data/item-tags.json` (both via
  `merge.mjs` — never by hand), plus `data-local/edits.json`. Never run
  `tools/ci/generate-manifest.mjs`, and never commit a deploy stamp. No
  schema changes, no dependency changes, no edits to `tools/refresh/*`. **`topics` in `edits.json` is not a schema change** — it
  is an established optional field of that contract (step 4), and authoring it
  is in scope.
- Never push to `main`; never force-push; never merge your own PR without the
  governance gate.
- If anything looks structurally wrong (merge conflicts, corrupted digest,
  failing tests you can't resolve by dropping items), STOP and leave the branch
  unmerged with a note in the PR for a daytime human session. A skipped night is
  cheap; a bad merge is not.

## Notes

- No API keys live in this agent. Enrichment is your own reasoning; the repo
  Action is keyless. The only external calls `merge.mjs`/tests make are none —
  all inputs are already local.
- Version this prompt: if the steps change, bump and record it in
  `docs/agents/runners.md`. Version 3 is recorded there by OPS-15/OPS-17 (#760).
