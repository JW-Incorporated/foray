# Breadth re-harvest with `artist_name` — 2026-10-07 (PKG-14, P-03a)

Card: `docs/roadmap/shows-search.md` § PKG-14. One full run of
`node tools/harvest-catalog.mjs` (US, 110 genres) on the founder's box, alone on
the machine, then `tools/refresh/fold-breadth-topics.mjs`,
`tools/build-show-index.mjs` and `tools/build-catalog-client.mjs`. No ranking
rule changed; no code changed except two data-pinned tests (below).

## The run

| | |
|---|---|
| started / finished (UTC) | 2026-10-07 00:19:50 → 00:34:06 |
| wall time | **14 m 16 s** (856 s) |
| requests to Apple | **243** = 1 genre tree + 110 chart feeds + 132 `lookup` batches (150 ids each) |
| smallest gap between request starts | 3.28 s (policy ≥ 3 s; the harvester sleeps 3 s before every request) |
| responses | 243 × HTTP 200; no backoff, 0 failed genres, 0 failed lookup batches |

Counted by a `--import` preload that wrapped `fetch` for the run only — the
harvester itself was not modified. `docs/CATALOG-PIPELINE.md`'s "~170
requests / 10–12 minutes / 200 ids per lookup" was an estimate; it is corrected
there to these measured numbers (the code's `LOOKUP_BATCH` is 150).

## Before → after

| measure | before (2026-07-09 harvest) | after (2026-10-07) |
|---|---|---|
| breadth rows | 19,787 | **19,708** (escalation floor 18,000) |
| rows with non-empty `artist_name` | 0 | **19,708 (100.00 %)**; 0 null, 0 empty |
| `in_curated` | 103 | 164 |
| rows with a `feed_url` | 19,726 | 19,639 |
| rows with `chart_rank ≤ 100` | 9,981 | 9,981 |
| `data/show-index.tsv` rows | 10,122 | 10,069 |
| `data/show-index.tsv` bytes raw / gzip -9 | 447,100 / 206,357 | 439,845 / **205,019** (budget 409,600) |
| `data/catalog-client.json` bytes | 133,980 | 133,990 |
| curated shows carrying a `chart_rank` | 173 of 229 | 164 of 229 |
| mobile bundle (`tools/mobile/prepare-webdir.mjs`, bytes on disk) | 2,741,754 | **2,738,785** (−2,969) |

`in_curated` rose because the July file predates most of today's 229 curated
shows; the flag is now computed against today's `data/catalog.json`.

Curated ranks: 11 curated shows lost their breadth twin (they left every US
chart's top 200: *omega tau*, *Making Chips*, *The Violin Chronicles*,
*GardenFork Radio*, *Go Creative Show*, *Designer Notes*, *Our Fake History*,
*Astonishing Legends*, *Cider Chat*, *Wine Talks with Paul K.*, *Brew Strong*),
2 gained one (*Lingthusiasm* 134, *The Roundhouse* 174), and 147 kept one with a
different number. Under the Q30 loser policy (PROPOSED default, see
`docs/roadmap/README.md`) an unranked curated show still sorts above every
breadth row.

`artist_name` stays server-side. `data/show-index.tsv` still has its four
columns and `data/catalog-client.json` its pinned key set (`test/show-page.test.js`
green); `search-engine.js` still does not read the field (P-03b).

## The four pinned queries (curated + index, `app.js:localShowMatches`'s input)

| query → intended show | before | after | moved? |
|---|---|---|---|
| `history` → *Dan Carlin's Hardcore History* | #2 of 107 (chart 14) | #2 of 114 (chart 11) | no |
| `daily` → *The Daily* | #17 of 218 (chart 1) | **#20 of 204** (chart 1) | **yes, 3 places** |
| `money` → *Planet Money* | #2 of 43 (chart 20) | #2 of 38 (chart 19) | no |
| `american` → *This American Life* | #1 of 34 | #1 of 38 | no |

One pinned query moved (the escalation threshold is more than one). Why `daily`
moved: every row above *The Daily* except the curated *Software Engineering
Daily* is a breadth row in the same match tier and the same popularity band
(band 1, chart ≤ 10), and inside one band the title tie-break decides. Six
band-1 "Daily" shows that sort ahead of "The Daily" entered the charts
(*Daily Sermons With Bishop Robert Barron*, *Claude AI Daily*, *Locked On
Braves*, *Locked On Brewers*, *Overlap Daily*, *The Bulwark Daily*) and three
left (*Locked On Cubs*, *Netflix Is A Daily Joke*, *The Athletic NBA Daily*):
net +3, #17 → #20. That is inventory, not the rule:
`test/show-search-ranking.test.js`'s real-index test states the claim as a
relation (nothing in a worse band sits above the intended show) and stays
green. It is the P-10 gap — `chart_rank` is per-genre, so band 1 cannot say
that *The Daily* is bigger than *Claude AI Daily*.

Also unchanged: `history` keeps *Hardcore History* above *Ancient History
Fangirl* (#2 vs #6), `science` keeps *Science Vs* above *Science for Sport*
(#3 vs #7), `fridman` → *Lex Fridman Podcast* #1.

## The ripple

**Row churn is a third of the file.** Same size, different shows: 13,155 ids
kept, **6,553 added, 6,632 dropped** since 2026-07-09. The harvester is
chart-driven, so a show that left every US top-200 leaves the breadth tier.
Consequences, measured:

- `taxonomy_node_ids` (folded from `data/breadth-classification.json`):
  11,145 rows get topics, 8,563 get `[]`; 6,553 of the `[]` are the new shows,
  which no classification pass has seen (`unknown_id`). Before: 16,736 rows had
  topics. The classification file was NOT extended here —
  `tools/classify/reconcile-shards.test.mjs` pins it at exactly 19,787 entries
  and a classify pass is its own card.
- The dropped ids still appear in other committed data that was built from the
  old file, e.g. `data/breadth-transcript-yield.json` (840 ids),
  `data/transcription-queue.json` (5), `data/transcript-availability.json` (9).
  Those are build-time inputs to their own pipelines; nothing in the suites
  joins them to the breadth file and nothing went red, but a dropped show no
  longer has a breadth row for the server search or a breadth show page.
- `test/show-search-ranking.test.js`, `show-index`, `show-page`,
  `show-search-live`, `show-search-fallthrough`, `show-search-shard`,
  `tools/build-show-index.test.mjs`, `tools/build-catalog-client.test.mjs`,
  `tools/refresh/fold-breadth-topics.test.mjs`,
  `tools/mobile/prepare-webdir.test.mjs`: green, unchanged.
- **A test moved:** `backend/test/breadthCatalog.test.ts` pinned
  `curated("hardcore-history").chart_rank === 14`, the July number. The
  re-harvest put it at 11, so the FIXTURE assumption broke, not the rule (the
  curated entry still carries its breadth twin's rank). The pin now reads the
  twin's rank from the committed breadth file and asserts equality, after
  asserting the twin rank is a number; the "revert to `chart_rank: null`"
  mutation still fails it (checked).
- **A second test moved:** `tools/classify/shard.test.mjs`'s "the defect" test
  had a live half asserting the unclassified remainder is still skewed by
  `Number(id) % 6` (> 1.5x) — a property of the ~509 shows the shard fleet
  worked over in id order and left. After the re-harvest the remainder is
  6,608 shows, 6,553 of them chart newcomers no pass has seen, spread evenly
  (1.046x), so it went red on the harvest, not on the shard key. The live half
  now measures only worked-over leftovers (rows WITH a classification entry
  but no agent one): 55 remain, under its existing 100-row measurability
  guard, so it reports a diagnostic. The synthetic drained-lane half — the
  test's teeth for the defect — is unchanged and green.
- The rest of the committed suites (`tools/ci/run-suites.mjs`'s package
  groups, the 284 root suites in chunks — Windows' command line is too long
  for one invocation —, `api/` and the full `backend/` vitest run) are green
  locally except three Windows-only failures that do not read the breadth
  data and pass on Linux CI: `tools/refresh/publish-digest.test.mjs` (ANSI
  colour in a captured line), `tools/release/watch-release.test.mjs` (executes
  a workflow's bash step) and a timing flake in
  `tools/transcribe/fetch-audio.test.mjs` (green on rerun);
  `tools/mobile/shell-invariants.test.mjs` flaked once under load, green alone.
- `node tools/search-probe.mjs --check`: structurally valid; the 12-query
  battery and the parity cases (`tim ferriss`, `lex fridman`, `sam harris`)
  unchanged (the parity cases measure the deployed endpoint, not this checkout).
- `tools/mobile/prepare-webdir.mjs` has no `--check` flag (`--list`/`--out`
  only); the bundle was built and measured instead (table above), and the
  bundle-alarm suite is green.

Follow-ups this run makes visible (not done here): `api/_lib/appleShowSearch.ts`'s
header still says the breadth catalogue has no author field — true of the
client files, no longer of `data/catalog-breadth.json`; a classify pass over
the 6,553 new shows; and whether a re-harvest should keep shows that left the
charts rather than drop them.

## Amended 2026-10-07: the dropped shows are back (re-harvests now union)

The follow-up question above ("whether a re-harvest should keep shows that left
the charts") is answered yes, and fixed forward in the same day's next PR:
`tools/harvest-catalog.mjs` now ends in `writeMergedHarvest`
(`tools/harvest-merge.mjs`), which UNIONS the harvest with the file it would
have replaced. Still-charting shows get the fresh row; shows that left every
chart keep their row with `chart_rank: null` and a new `last_charted_at`
(when last seen charting) and keep their topics; new shows are added; nothing
is dropped. `--replace` is the explicit opt-out. Rule and tables:
`docs/CATALOG-PIPELINE.md` § "Re-harvests keep shows that left the charts".

The committed file was rebuilt as the union of the pre-#1148 file and #1148's,
with the new merge: `node tools/harvest-merge.mjs --prev <#1148^ file> --fresh
<#1148 file> --out data/catalog-breadth.json --backfill-artist`, then
`fold-breadth-topics.mjs` → `build-show-index.mjs` → `build-catalog-client.mjs`
(the order above).

| measure | after #1148 | after the union |
|---|---|---|
| breadth rows | 19,708 | **26,340** (13,155 refreshed + 6,553 added + 6,632 kept off-chart) |
| rows with a `chart_rank` | 19,708 | 19,708 (the kept rows are `null`) |
| rows with `last_charted_at` | — | 26,340 (kept rows: 2026-07-09, their July `harvested_at`) |
| rows with topics (`taxonomy_node_ids` non-empty) | 11,145 | **16,736** (the July coverage; the 6,553 newcomers still fold `[]` until a classify pass) |
| `artist_name` non-empty | 19,708 | 26,234; 106 `null` |
| `in_curated` | 164 | 175 (the 11 curated shows whose twin left the charts have it back, unranked) |
| `data/catalog-breadth.json` bytes | 13,903,015 | 19,813,601 (server-side only; not in the web or mobile bundle) |
| `data/show-index.tsv` rows / gzip -9 | 10,069 / 205,019 | unchanged, byte-identical (kept rows are past the `chart_rank <= 100` cut) |
| `data/catalog-client.json` | 133,990 B | unchanged, byte-identical (a curated row still takes only a RANKED twin's rank) |
| mobile bundle (`prepare-webdir.mjs --out`, bytes on disk) | 2,738,785 | **2,738,785** (alarm 2.8 MB not fired) |

Apple: the kept July rows predate P-03a and had no `artist_name` key, so the
merge looked those 6,632 ids up — **45 `lookup` requests**, 150 ids each,
2026-10-07 01:27:16 → 01:29:48 UTC, smallest gap between request starts
3.20 s, 0 retries, 0 failed batches. 6,526 came back with a name; 106 ids are
no longer returned by Apple at all (`artist_name: null`, row kept — whether to
prune shows Apple has withdrawn is a separate decision). No genre or chart
feed was re-fetched; the chart data is #1148's.

Because the client index, the client catalogue and the bundle are
byte-identical, the four pinned queries cannot move and did not
(`test/show-search-ranking.test.js`). What changed for a listener is
server-side: the 6,632 shows are back in `api/shows/search` (banded UNRANKED, the
worst popularity band) and their breadth show pages resolve
again. Tests: `tools/harvest-merge.test.mjs` (13; each names its mutation,
including a REAL DATA floor of 26,340 rows — the union is monotone).
