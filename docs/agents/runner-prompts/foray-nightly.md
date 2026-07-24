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

2. **If `resolved.resolved` is empty**, there is nothing to do. Stop. Do not
   open a PR, do not commit.

3. **Author `data-local/edits.json`** — a JSON object `{ "<id>": { "hook",
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
   - **To drop an item** (a cross-promo/trailer/ad that slipped past resolve),
     simply omit it from `edits.json` — `merge.mjs` skips resolved items with
     no edit and reports them. Prefer dropping over forcing a weak hook.

4. **Merge** (this is committed machinery — do not edit it, just run it):
   ```sh
   node tools/refresh/merge.mjs
   ```
   It enforces the copy rules before writing; if it exits non-zero, fix the
   offending hook/tags in `edits.json` (or drop the item) and re-run. It writes
   `data/discover.json` + `data/item-tags.json`.

5. **Validate.** Never open a red PR:
   ```sh
   cd backend && npx vitest run test/copyRules.test.ts test/poolIntegrity.test.ts
   ```
   Fix or drop offenders and re-run merge until green.

6. **Open a PR — never push to `main`.**
   ```sh
   git switch -c "nightly/$(date -u +%F)"
   git add data/discover.json data/item-tags.json
   git commit   # message: "Nightly refresh: +N episodes (YYYY-MM-DD)" + co-author trailer
   git push -u origin HEAD
   gh pr create --base main --title "Nightly refresh: +N episodes (YYYY-MM-DD)" \
     --body "Automated nightly content refresh. N new episodes from the refresh-digest of <date>. Copy rules + pool integrity green."
   ```
   A human (or the future integrity check) reviews and merges. GitHub Pages
   deploys from `main` on merge.

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
