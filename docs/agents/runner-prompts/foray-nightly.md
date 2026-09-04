# Runner prompt — Foray nightly refresh (Claude Cloud scheduled agent)

This is the versioned prompt for the nightly content-refresh agent. It runs
**unattended in Claude Cloud**, once per night, a couple of hours after the
`nightly-refresh` GitHub Action publishes the digest. Its only job is the
**judgment half**: turn a resolved digest into published episodes via a PR.
Be conservative — a broken deploy is far worse than a skipped night.

Read `CLAUDE.md` first; the copy rules and product principles there are binding.

## The pipeline you sit in

The Action already did the deterministic half (scan feeds, resolve Apple
trackIds, dedup) and published two files to the **`refresh-digest`** branch:
`resolved.json` (the episodes to publish) and `refresh-state.json` (ignore it).
You produce `edits.json` (hooks, tags, and `topics` where an episode differs
from its show's label) and run the committed merge. See
`tools/refresh/README.md` for the full contract.

## Steps (follow exactly)

1. **Sync.** Ensure you are on an up-to-date `main`. Then pull the digest:
   ```sh
   git fetch origin refresh-digest
   mkdir -p data-local
   git show origin/refresh-digest:resolved.json > data-local/resolved.json
   ```

2. **Check the digest is fresh — do this before anything else.**
   ```sh
   node -e "
     const r = require('./data-local/resolved.json');
     const hours = (Date.now() - new Date(r.generated_at)) / 3600000;
     console.log('digest generated_at ' + r.generated_at + ' (' + hours.toFixed(1) + 'h old)');
     if (hours > 12) { console.error('STALE DIGEST — the Action has not published today. Stopping.'); process.exit(1); }
   "
   ```
   If this fails, **stop and open no PR.** It means the `nightly-refresh` Action
   has not run yet, so the digest is yesterday's. Every item in it is already in
   `discover.json`, so `merge.mjs` would skip them all and report "0 items
   added" — a silently skipped night that looks like a successful one. Say so in
   your run output so a human notices.

   (GitHub does not honour cron punctually under load: the Action's 09:40 slot
   was measured starting at 10:54 and 11:05 on consecutive days. The cron moved
   to 06:40 UTC to restore the ≥2h margin, but this guard is the backstop.)

   **The same guard now exists pointing the other way** (issue #290). If YOU do
   not run, `tools/refresh/watch-nightly.mjs --mode absence` goes red on the same
   12-hour clock, and the Action refuses to overwrite your unread digest. So the
   12 here is not an arbitrary number in one file any more: a digest must be
   consumed within 12h of being made, and whichever half drops it goes red.

   **If you were sent here to clear a red watchdog**, the digest on the branch is
   by definition older than 12h and step 2 will refuse it — correctly, because
   the items in it may already be in `discover.json`. Do not override the guard.
   Re-cut the digest instead, which is what recovered #290's lost day:
   ```sh
   rm -f data-local/refresh-state.json          # no seen-guid state: re-emit the window
   node tools/refresh/scan.mjs --window-hours 72
   node tools/refresh/resolve.mjs
   ```
   `resolve.mjs` dedups against `discover.json` on `id` and `apple_track_id` and
   `merge.mjs` skips ids already in the pool, so nothing already published comes
   back and only the missing tail lands. Then continue from step 4 as normal.

   **Name the branch `nightly/<the digest's date>-recovery`, not today's date.**
   That string is load bearing, not cosmetic: the overwrite guard in
   `nightly-refresh.yml` clears itself when a PR matching the stranded digest's
   date appears, and a branch named after the day you did the work matches
   nothing and leaves the guard red every morning after. #293 got this right —
   it merged on the 21st as `nightly/2026-08-19-recovery`. The red run's own
   report prints the exact name and the `--window-hours` to use; prefer those
   numbers over the ones above, because they are computed from the digest that
   is actually stuck.

3. **If `resolved.resolved` is empty**, there is nothing to do. Stop. Do not
   open a PR, do not commit.

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
   fix is safe. (The one failure that DOES leave files written is the manifest
   step, below.) It writes `data/discover.json` +
   `data/item-tags.json`, **and then regenerates `deploy-manifest.json` and
   restamps `sw.js`'s `BUILD_ID`** (HUMAN-ACTIONS #37, 2026-09-03). Both data
   files are hashed by the manifest, so it is stale the instant they are
   written; doing it here means your own commit is already correct and no
   `github-actions[bot]` fixup commit is ever pushed to your PR. That matters:
   a bot commit on the PR demands an approving review that GitHub forbids the
   PR's author from giving, and PRs #443 and #456 sat green and unmergeable
   for exactly that reason. Expect the line
   `MANIFEST: deploy-manifest.json regenerated and sw.js BUILD_ID restamped in this commit.`
   in the output. If the merge instead exits non-zero with a
   `MERGE: deploy-manifest.json could NOT be regenerated ... DO NOT COMMIT`
   message, the data files WERE written but the manifest step failed: do not
   commit, do not open a PR, and leave a note for a daytime human session —
   that tree is exactly the stale-manifest state that summons the bot commit.

6. **Validate.** Never open a red PR:
   ```sh
   cd backend && npx vitest run test/copyRules.test.ts test/poolIntegrity.test.ts
   ```
   Fix or drop offenders and re-run merge until green.

7. **Open a PR — never push to `main`.**
   ```sh
   git switch -c "nightly/$(date -u +%F)"
   git add data/discover.json data/item-tags.json deploy-manifest.json sw.js
   git commit   # message: "Nightly refresh: +N episodes (YYYY-MM-DD)" + co-author trailer
   git push -u origin HEAD
   gh pr create --base main --title "Nightly refresh: +N episodes (YYYY-MM-DD)" \
     --body "Automated nightly content refresh. N new episodes from the refresh-digest of <date>. Copy rules + pool integrity green."
   ```
   **All four files go in the one commit.** `deploy-manifest.json` and `sw.js`
   were rewritten by step 5; leaving them out reproduces the #37 deadlock
   (stale manifest → bot fixup commit → an approval nobody can give). Your PR
   should change exactly those four paths and nothing else. Do NOT merge it
   yourself. `automerge-nightly.yml` enables auto-merge on `nightly/*` PRs
   whose changed files are all on `ALLOWED_PREFIXES` — all four of yours are,
   as of 2026-09-03 — so it merges automatically once the required checks
   (`backend`, `data-and-site`) pass; GitHub Pages then deploys from `main`.
   If the PR shows a `github-actions[bot]` commit anyway, step 7's `git add`
   was incomplete: say so in one PR comment and exit.

## Hard constraints

- Touch ONLY `data/discover.json`, `data/item-tags.json`, `deploy-manifest.json`
  and `sw.js` (all four via `merge.mjs` — never by hand, and never by running
  `tools/ci/generate-manifest.mjs` yourself), plus `data-local/edits.json`. No
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
  `docs/agents/runners.md`.
