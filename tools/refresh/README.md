# Nightly refresh pipeline (`tools/refresh/`)

The committed, versioned successor to the old `data-local/*.mjs` machinery. Three
static scripts + two ephemeral data files. **Machinery is code (committed here);
per-night content is data (never code).** This is the whole point of the
consolidation: the old flow regenerated a `merge-YYYY-MM-DD.mjs` every night with
the hooks/tags baked into it — unversioned and impossible to run in the cloud.

## Stages

```
scan.mjs ──▶ fresh-pending.json ──▶ resolve.mjs ──▶ resolved.json ──▶ merge.mjs ──▶ data/discover.json
  (RSS)         (raw episodes)        (iTunes)      (the digest)      (+ edits.json)   data/item-tags.json
                                                          │
                                            agent authors edits.json
```

| Script | Keyless? | Role |
|--------|----------|------|
| `scan.mjs`    | ✅ | Poll curated RSS feeds, emit episodes newer than last run |
| `resolve.mjs` | ✅ (iTunes lookup) | Resolve `apple_track_id`, dedup, drop unresolvable/dupe/invalid-topic |
| `merge.mjs`   | ✅ | Apply agent-authored hooks/tags, enforce copy rules, write data files |

The **judgment step** (writing hooks + tags) is the only non-deterministic part.
It is performed by an agent (Claude Code locally today, a Claude Cloud scheduled
agent after migration) and its entire output is `edits.json` — a data file.

## `edits.json` contract

The agent reads `resolved.json` (each item carries `_description`, the episode's
real blurb) and writes, for every item it wants to publish:

```json
{
  "<item-id>": {
    "hook": "<=16 words, grounded in the real description",
    "tags": ["5-to-12", "lowercase-hyphenated", "tags"]
  }
}
```

Rules (mirrored in `merge.mjs`'s preflight AND the CI gate — keep in sync with
`backend/test/copyRules.test.ts`):

- Hook ≤ 16 words. Banned: `fascinating`, `deep dive`, `delve`, `explores`,
  clickbait withholding, any commute-length framing.
- 5–12 tags, each `^[a-z0-9]+(-[a-z0-9]+)*$`; reuse existing vocabulary in
  `data/item-tags.json` where it applies.
- A resolved item with **no** edit is skipped (the agent may deliberately omit a
  cross-promo/trailer that slipped through). Items already in `discover.json` are
  skipped — `merge.mjs` is idempotent and safe to re-run.

## Running locally

```sh
node tools/refresh/scan.mjs --window-hours 48     # ~10 min, ~213 feeds
node tools/refresh/resolve.mjs                     # writes data-local/resolved.json
# agent authors data-local/edits.json from resolved.json
node tools/refresh/merge.mjs                        # writes data/discover.json + item-tags.json
cd backend && npx vitest run test/copyRules.test.ts test/poolIntegrity.test.ts
```

## Path overrides (used by the cloud split)

All intermediate paths are env-configurable so the same scripts run unchanged in
GitHub Actions (ephemeral workspace) and locally (`data-local/`):

| Env | Default | Set by |
|-----|---------|--------|
| `STATE_PATH`    | `data-local/refresh-state.json` | Action (persisted via cache/artifact) |
| `PENDING_PATH`  | `data-local/fresh-pending.json` | Action |
| `RESOLVED_PATH` | `data-local/resolved.json`      | Action publishes this to the digest branch |
| `EDITS_PATH`    | `data-local/edits.json`         | Cloud agent writes this |

## Cloud topology (Hybrid — see `docs/` migration plan)

1. **GitHub Actions cron** runs `scan.mjs` + `resolve.mjs`, publishes
   `resolved.json` to a dedicated digest branch (no secrets, no LLM).
2. **Claude Cloud scheduled agent** reads the digest, authors `edits.json`, runs
   `merge.mjs`, validates, and opens a PR against protected `main`.
3. A human (or an integrity check) merges the PR; GitHub Pages deploys.
