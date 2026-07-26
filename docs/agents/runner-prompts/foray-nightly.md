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
You produce `edits.json` (hooks + tags) and run the committed merge. See
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

3. **If `resolved.resolved` is empty**, there is nothing to do. Stop. Do not
   open a PR, do not commit.

4. **Author `data-local/edits.json`** — a JSON object `{ "<id>": { "hook",
   "tags" } }` with one entry per resolved item you intend to publish. For each
   item in `resolved.json` (each carries `_description`, the episode's real
   blurb, plus `show`/`title`/`topics`):
   - **hook**: ≤ 16 words, grounded in the real description. Banned:
     `fascinating`, `deep dive`, `delve`, `explores`, clickbait withholding,
     any commute-length framing. If the description is *itself* clickbait
     withholding ("we can't get into it here…"), ground the hook in the
     episode's title/subject instead — never quote the tease.
   - **tags**: 5–10, lowercase-hyphenated (`^[a-z0-9]+(-[a-z0-9]+)*$`). Reuse
     the existing vocabulary in `data/item-tags.json` wherever it applies.
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
   offending hook/tags in `edits.json` (or drop the item) and re-run. It writes
   `data/discover.json` + `data/item-tags.json`.

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
   Do NOT merge it yourself. `automerge-nightly.yml` enables auto-merge on
   `nightly/*` PRs, so it merges automatically once the required checks
   (`backend`, `data-and-site`) pass; GitHub Pages then deploys from `main`.

## Hard constraints

- Touch ONLY `data/discover.json`, `data/item-tags.json` (both via `merge.mjs`),
  and `data-local/edits.json`. No schema changes, no dependency changes, no edits
  to `tools/refresh/*`.
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
