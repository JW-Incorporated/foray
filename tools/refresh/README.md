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
| `enclosure.mjs` | — | Shared audio-provenance helpers (not a stage) |
| `backfill-audio.mjs` | ✅ | **One-shot, not nightly.** Backfills audio onto pre-#21 items |

## Audio provenance (issue #21)

Every episode carries a playable URL through all three stages:

| field | source | notes |
|---|---|---|
| `audio_url` | RSS `<enclosure url>`, iTunes `episodeUrl` as fallback | **original, pre-redirect** |
| `audio_type` | enclosure `@_type` | video-only items are skipped (corner case #6) |
| `audio_bytes` | enclosure `@_length` | `0` means unknown → stored as `null` |
| `duration_sec` | `itunes:duration`, normalised | exact; `duration_min` stays for copy |

Three rules that are easy to get wrong and expensive to discover late:

1. **RSS is authoritative, iTunes is a fallback.** Not the other way round. The
   iTunes lookup only returns recent episodes — at `limit=25` it reaches back
   about a year, at `limit=200` roughly three. Most of the catalogue is recent
   so an iTunes-first strategy *looks* fine in aggregate while failing on the
   back catalogue, which is where the hand-curated session content lives.

2. **Never substitute the resolved CDN URL.** Corner case #1: publishers count
   downloads at the prefix host. We store and play the URL they published. The
   RSS enclosure and iTunes `episodeUrl` genuinely differ for the same episode
   (`content.blubrry` vs `ins.blubrry`), which is another reason RSS wins.

3. **A null `audio_url` is fine; a malformed one is not.** Items with no
   playable URL stay in discovery and link out to Apple Podcasts (see issue
   #25). CI warns on nulls and *fails* on a non-https or tokened URL — corner
   case #9, a tokened URL is a secret and must never reach a public data file.

### Backfilling

```bash
node tools/refresh/backfill-audio.mjs --dry-run     # report only
node tools/refresh/backfill-audio.mjs              # write data files
node tools/refresh/backfill-audio.mjs --force      # re-resolve everything
```

Idempotent and re-runnable; skips items that already have `audio_url` unless
`--force`. Fetches each **show** feed once, then matches all of that show's
items. Coverage is reported separately for 2026+ and pre-2026 — a single
blended number hides exactly the failure mode described in rule 1 above.

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
