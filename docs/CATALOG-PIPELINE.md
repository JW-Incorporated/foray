# Catalog pipeline — review and the road to 10,000 shows

*2026-07-09. Commissioned before scaling: "make sure the cataloguing is being done
effectively and is forward compatible... then aim for cataloging 10k podcasts."*

## Review of the current process (agent waves)

Three agent waves built today's catalog: 154 shows / 389 episodes. Honest assessment:

**What it does well (keep for its tier):**
- Every ID verified against the iTunes API — zero invented data across ~390 episodes.
- Editorial judgment per show (which shows are *good*, not just popular) and per episode
  (skip trailers, pick substantive), plus copy-gated hooks and 5–10 tags per episode.
- Output feeds the semantic index directly; quality is high enough to serve as the
  golden calibration set for the future Tier-1 LLM classifier.

**Why it cannot reach 10k:**
- Throughput ≈ 30 shows per agent-run; 10k would take ~330 runs and most of the
  editorial work (hooks, per-episode picks) is wasted at that scale — nobody reads
  10k hooks, and episode-level data goes stale in a week without the feed-polling
  backend anyway.
- Web-search discovery biases toward famous shows in list-articles; a breadth catalog
  needs systematic coverage, not vibes.

**Verdict:** the agent-wave process is a *curation* pipeline, not a *catalog* pipeline.
Keep it for the curated tier; build a programmatic harvester for breadth.

## Two-tier catalog architecture

| | Curated tier | Breadth tier |
|---|---|---|
| File | `data/catalog.json` + `data/discover.json` | `data/catalog-breadth.json` |
| Size | ~150 shows, grows by editorial waves | ~10k shows, grows by re-harvest |
| Contents | shows + hand-picked episodes + hooks + tags | show-level records only |
| Consumers | web client (discover pool), semantic index | backend seed data, future show-level search |
| Episode data | hand-picked, copy-gated | none — episodes come from feed polling (ADR-0001) once the backend ingests; harvesting 10k×episodes via iTunes would be rate-abusive and instantly stale |

Both tiers share `apple_collection_id` as the primary key, so a breadth entry upgrades
to curated by simply appearing in catalog.json — no migration.

## Forward-compatibility requirements (all implemented in the harvester)

1. **Identity**: `apple_collection_id` primary; `feed_url` captured on every entry —
   the RSS-native architecture keys on feeds, and Podcast Index cross-referencing
   (when the key lands) matches on feed URL. `podcastindex_id: null` reserved.
2. **Popularity prior**: `chart_genre_id` + `chart_rank` (per-genre Apple top-charts
   position) stored — this becomes the curation engine's global-quality prior for
   cold nodes (03_CURATION_SPEC: stretch slot draws on "cold taxonomy node with high
   global quality").
3. **Genre mapping**: Apple's genre ids + names stored raw (`apple_genre_ids`,
   `apple_genre`). Mapping to our taxonomy happens downstream and can be re-run;
   never bake a lossy mapping into the harvest.
4. **Provenance + refresh**: `harvest_source`, `harvested_at`, `region` on every
   entry; the script is idempotent and re-runnable (re-harvest = new file, diffable).
5. **Client isolation**: the web client never fetches the breadth file (it is ~3MB
   and show-level only). No client change ships with the harvest.
6. **Dedupe discipline**: collectionId-unique within the file; curated-tier overlap
   is allowed and expected (marked `in_curated: true` for joins).

## The harvester (`tools/harvest-catalog.mjs`)

Pipeline: Apple podcast genre tree (`itunes.apple.com/.../ws/genres?id=26`, ~110
subgenres) → per-genre top-200 charts (legacy RSS JSON) → dedupe collectionIds →
batched `lookup` calls (200 ids/request) for authoritative metadata (feedUrl, title,
artwork, trackCount, explicitness, genres) → `data/catalog-breadth.json`.

Politeness: ≥3s between requests, honest User-Agent, ~170 total requests ≈ 10–12
minutes per full harvest. Expected yield: 110 genres × 200 ≈ 22k chart rows →
~9–13k unique shows (charts overlap heavily at the top).

## What stays out of scope at breadth scale (deliberately)

- **Per-episode harvesting** — the backend's feed poller owns episodes (fresh, polite,
  conditional-GET) once deployed; a one-shot iTunes episode grab of 10k shows would be
  stale on arrival.
- **Deep tagging/classification of 10k shows** — that's the Tier-1 LLM enrichment
  pipeline's job when the key lands, budget-metered, cheapest-first. Genre + chart
  rank are enough signal for the breadth tier until then.
- **Editorial notes/hooks at scale** — reserved for what actually surfaces to users.

## Classification layers and precedence

`data/breadth-classification.json` is one file written by several passes. It has
always behaved as a layered overlay; until 2026-08 that was only ever stated in a
comment, and the bottom layer did not honour it.

| Layer | `source` | Written by | Signal |
|---|---|---|---|
| base | `genre-map` | `tools/classify-breadth.mjs` | Apple genre only — deterministic, keyless, $0 |
| distrusted overlay | `llm-title-genre` | the 2026-07 pass (retired) | title + genre, no description |
| refinement | `classify-agent-tier1` | `tools/classify/` + a Claude Code agent | feed description + recent episodes |
| escalation | `classify-agent-tier2` | ditto, `--mode escalate` | the above + a transcript excerpt |

**Higher layers win.** The rules the base layer follows, in order:

1. A `classify-agent-*` entry is never touched — not overwritten, not enriched.
   It is a real per-show judgement and may legitimately disagree with the genre
   (*The Dice Tower* is `gaming/design`, not the `gaming/tabletop` its genre
   implies).
2. Any other overlay may be **upgraded only additively**: the genre map's topic
   set must be a strict superset of what the overlay asserted, *and* must turn a
   branch the overlay left bare into one with a child. Both conditions, because
   the first alone lets the map bolt its coarse secondary branches
   (`Social Sciences` carries psychology + society + economics) onto shows that
   never asked for them — measured at 2,021 shows and root dumping getting
   *worse*, 9,741 → 10,502 pairs.
3. Entries for shows outside the input catalog are carried through untouched.
4. If any show that had topics would end up with none, the script writes nothing
   and exits non-zero. Same for a genre-map topic that is not a taxonomy node.

Rule 4 exists because the failure mode here is silent: the file stays valid JSON,
CI stays green, and shows simply lose their tags. The pass that made this concrete
would have deleted 1,851 agent-authored classifications on its next run.

**Measuring it**: `node tools/classify/root-dumping-report.mjs` prints how much of
each source sits on a bare branch that has children — the defect
`docs/research/taxonomy-review-2026-08.md` §3.2 named. `--json` snapshots it;
`--baseline <snapshot>` prints before/after. Take a snapshot before any
re-classification, because "did it work?" is otherwise unanswerable after the fact.

## Breadth tier, batch 2 (international)

`data/catalog-breadth-intl.json.gz` — 121,786 shows from 18 regional Apple top-chart
sets (fr/de/jp/br/mx/es/it/in/nl/dk/se/za/no/gb/ie/au/nz/ca), zero overlap with the
US batch, 99.4% with feed URLs. Stored gzipped (76MB raw exceeds repo limits);
consumers: `zcat` / `zlib.gunzipSync`. Same schema as catalog-breadth.json with
per-show `region`.
