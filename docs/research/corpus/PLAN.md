# Foray research corpus — build plan

Owner: Joey's Claude session, started 2026-08-12. Announcement: root `STATE.md`.
Input manifest: `docs/research/foray-research-dossier.md` (~57 unique sources
across 9 areas). Goal: every source scraped, archived raw + as clean markdown,
chunked into a searchable SQLite corpus that later feeds agent context,
retrieval experiments, and the embedding backfill pass.

Adaptation note: the kickoff prompt referenced root `STATE.md`/`MAP.md`/`PLAN.md`;
none existed. `STATE.md` was created as the announcement board; this doc is the
PLAN; the repo map stays where it already lives (CLAUDE.md § Layout).

## Ground rules (from recon, 2026-08-12)

- Wyatt's active surface (last 7 days): `data/*.json`, `tools/segments/`,
  `tools/transcribe/`, `tools/refresh/`, `backend/src/feeds/`,
  `test/suite-integrity.test.js`, `.github/`, `docs/DECISIONS.md`,
  `docs/curation/`, `docs/product/`. This workstream touches only the two
  mandatory shared files (suite-integrity floors, DECISIONS entry), each as an
  isolated commit.
- `main` is protected: PR + green `backend`/`data-and-site`, zero bypass.
  "Merge" everywhere below means "PR merged after green checks", Joey-directed.
- Never babysit a PR (CLAUDE.md): checks are awaited synchronously in-session,
  no self-armed wake-ups.
- Fetched bytes are never committed. `data-local/corpus/` (gitignored) holds
  the DB and archives.

## Workstream A — scraper infrastructure (`corpus/scraper-infra`)

`tools/corpus/` (own `package.json`, ES modules, deps local to this dir — same
pattern as `backend/` and `player/`; root stays dependency-free):

- `fetcher.mjs` — per-host serialized queue, ≥2s between hits to the same host
  (or robots crawl-delay if larger), robots.txt fetch+cache+respect, honest
  User-Agent identifying the project and contact, retry with backoff on
  429/5xx/network (3 attempts), 30s timeout, https-only redirects, hard
  response-size cap.
- `extract.mjs` — HTML → clean markdown via linkedom + @mozilla/readability +
  turndown(+gfm); PDF → text via pdfjs-dist; site-specific handlers:
  arXiv `abs/` → fetch the PDF (primary artifact), GitHub repo root → raw
  README via raw.githubusercontent, GitHub issue → REST API (title+body+
  comments, which is already markdown).
- Raw bytes AND markdown stored for every successful fetch:
  `data-local/corpus/raw/<source_id>-<slug>.<ext>` and
  `.../markdown/<source_id>-<slug>.md`.
- Tests: fixture-based (no network), covering rate-limiter timing, robots
  parsing, retry classification, extraction, and path-safety (slug
  sanitization; archive paths must stay inside data-local/corpus).

## Workstream B — corpus database (`corpus/db-schema`)

- SQLite via built-in `node:sqlite` (zero native deps; FTS5 verified working
  on local Node 24). Single file `data-local/corpus/corpus.db` — gitignored,
  not LFS: it is fully regenerable from the dossier + the network, and raw
  archives make refetch cheap. Documented in DECISIONS.md.
- Migrations: `tools/corpus/migrations/NNNN_*.sql` applied in order, tracked
  via `PRAGMA user_version` — mechanically liftable to Postgres+pgvector later
  (schema avoids SQLite-only column types; FTS5 is isolated in one migration).
- Tables: `sources` (id, area 1–9, area_name, title, url UNIQUE, source_type
  paper/blog/docs/standard/repo/issue/court-opinion/forum/reference,
  why_it_matters, read_first, added_at), `documents` (source_id FK, fetched_at,
  http_status, content_hash sha256, raw_path, markdown_path, token_count,
  fetch_notes), `chunks` (document_id FK, ordinal, heading_path, text,
  token_count, embedding BLOB NULL — backfilled in a later pass, no embedding
  API calls in this run). `chunks_fts` = FTS5 external-content table + sync
  triggers. **Superseded 2026-08-13 by migration 0003**: the single
  `chunks.embedding` column was dropped in favour of an `embedding_models`
  registry plus a `chunk_embeddings` join table — one column cannot hold two
  models. See `docs/DECISIONS.md` (2026-08-13) and the retro below.
- Chunker: split at heading boundaries, pack paragraphs to ~500–1000 est.
  tokens (chars/4 heuristic, documented), oversize paragraphs split at sentence
  boundaries; heading_path = "H1 > H2 > H3".
- Manifest loader: parse the dossier markdown itself (READ FIRST list + the 9
  detail sections), dedupe by URL, OR the read_first flag. The parse IS the
  ingestion manifest — no hand-copied URLs.
- CLI `tools/corpus/corpus.mjs`: `init`, `load-manifest`, `ingest [--area N |
  --source ID | --all]`, `search "query"`, `stats`, `refetch <source_id>`,
  `report` (writes coverage.md + dead-links.md content). Later additions:
  `rechunk` (offline re-chunk from the archives) and `eval` (score retrieval
  against the committed gold set) — see the backfill step-1 note below.

## Workstream C — ingestion runs (after A+B merge)

- Parallel subagents, one per dossier area (9), each invoking the CLI for its
  area against the shared DB (WAL + busy_timeout for concurrent writers) and
  reporting per-source outcomes. 404/paywall/bot-walled → recorded with status
  + notes, no workaround-burning; those land in dead-links.md.

## Workstream D — verification + review

- Fresh-context reviewer subagent on every branch before merge (correctness,
  schema soundness, injection/path-traversal in the fetcher, CLAUDE.md
  compliance). Findings fixed before merge.
- `corpus stats` per-area coverage; `corpus search` sanity: "reciprocal rank
  fusion", "dynamic ad insertion", "server test".
- Deliverables: `docs/research/corpus/coverage.md`, `docs/research/corpus/
  dead-links.md`, retro appended below.
- CI: corpus test suites are floored by suite-integrity (runs in CI) but a
  `node --test tools/corpus` step in ci.yml is CI/CD and therefore Wyatt's
  call — proposed as its own PR, left unmerged for him.

## Merge order

1. `corpus/announce` — STATE.md, this plan, the dossier file itself.
2. `corpus/scraper-infra` — Workstream A (+ floors commit).
3. `corpus/db-schema` — Workstream B (+ DECISIONS commit).
4. `corpus/ingestion-reports` — coverage + dead-links + retro after C/D.

Each branch: `git fetch origin && git rebase origin/main` immediately before
PR/merge; conflicts in shared files resolve in Wyatt's favor, mine layered on
top.

## Retro (2026-08-12 — workstream complete)

**Outcome:** 52/54 sources ingested (480 chunks, ~272k est. tokens) in one
day: announce (#146) → scraper infra (#147) → DB+CLI (#148) → 9 parallel
area-ingestion subagents → this reports PR. The two failures are genuine and
recorded in `dead-links.md`: the AES TD1004 PDF 301s to a 404 (AES moved its
document tree), and ScienceDirect bot-walls (403). The three definition-of-done
smoke queries ("reciprocal rank fusion", "dynamic ad insertion", "server
test") all return correctly-attributed, on-topic chunks.

**What went differently than planned:**
- PR #147 was auto-merged by `automerge-nightly.yml` the moment checks went
  green (tools/+test/ are allowlisted) — before the planned pre-merge review.
  The reviewer subagent therefore ran post-merge for infra and pre-push for
  the schema branch; all 9 findings (1 MUST-FIX: chunker heading-stack
  corruption on skipped heading levels) were fixed in #148. Lesson for the
  next workstream: on this repo, "review before merge" means review before
  PUSH for anything on an allowlisted path.
- The kickoff assumed root STATE.md/MAP.md/PLAN.md; none existed. STATE.md
  was created as a cross-session announcement board, this doc serves as
  PLAN, and the repo map stays in CLAUDE.md § Layout — no separate MAP.md.
- Per-area report branches were collapsed into this single reports PR: the
  DB is gitignored, so area runs produce no committable diff.

**Before the embedding backfill pass:**
1. Land PR #149 (Wyatt) so the 80 corpus tests actually run in CI — until
   then they're floored but never executed there.
2. Thin extractions are flagged in fetch_notes ("thin extraction") — 6
   JS-rendered pages (Apple forums ×2, Podcast Index API docs, HF TTS Arena,
   NotebookLM blog, OpenAI community) yielded 1–2 chunks. If those sources
   matter for retrieval experiments, a headless-browser fetch pass is the
   fix; a manual paste-in is cheaper for the two Apple forum threads.
3. The chars/4 token heuristic is deliberately crude; the backfill pass
   should re-chunk if its embedding model's tokenizer disagrees badly.
4. `sources.url` for the AES standard should be repointed if a new canonical
   AES URL is found (use `corpus refetch 12` after a manifest edit — the
   loader is idempotent by URL, so edit the dossier, reload, refetch).

## Embedding backfill — step 1 (2026-08-12): fix the baseline first

The backfill was planned as four branches. Step 1 landed alone, deliberately,
as a decision gate: before spending ~250MB of `onnxruntime-node` on semantic
search, find out how well keyword search does once it *works*.

It did not work. `corpus search` passed raw user text into FTS5 MATCH, so
ordinary questions either crashed (`?`, `+`, `:`, `-`, quotes, bare
AND/OR/NEAR — `diarization: who is speaking when` died with `no such column:
diarization`) or were implicitly ANDed into zero results. On a 15-question
gold set, 4 errored and only 3 found their source.

| retrieval | found | Recall@5 | MRR@8 | nDCG@8 |
|---|---|---|---|---|
| raw passthrough (what shipped in #148) | 3/15 | 0.200 | 0.200 | 0.160 |
| built query (this pass) | 15/15 | 1.000 | 0.902 | 0.788 |

Also fixed: `pdfToMarkdown` joined pages with `\n\n---\n\n`, so 29 of 480
chunks were bare rules. Repaired at the extractor and at chunk time; the
existing corpus rebuilds offline via `corpus rechunk` (480 → 451 chunks, no
source lost). Re-chunking contributed **zero** to the retrieval numbers.

**The vector question is now open, not settled.** Keyword search finds the
right source for every question in the set, so the case for embeddings has to
rest on something the set does not measure: ranking quality within the top 8,
paraphrase queries that share no vocabulary with the corpus, and questions
nobody thought to write down. That is a real case, but it is a smaller one
than it was this morning, and it is the founders' call — see the gold set's
own caveat that 15 queries cannot resolve small differences.

Two gold-set findings worth keeping regardless:
- Queries 2 and 12 are partly **orphaned** by the two ingest failures (AES
  TD1004 404, ScienceDirect 403). The numeric LUFS target may exist nowhere
  in the corpus. These are the best tests for a retriever that confabulates
  coverage. (Resolved 2026-08-13 below — both sources are now ingested, so
  this orphaning no longer applies; re-running `eval` is expected to change
  these two queries' scores.)
- 3 chunks in the IAB PDFs extract as letter-spaced text
  (`A b o u t T h i s`), a pdfjs item-joining artifact. Not fixed here.

## Retro (2026-08-13 — recovering the eight weakest sources)

Both dead links and four of the six "thin" sources were recovered; two
sources stay honestly thin because there is nothing more to recover.
`corpus stats`: 52/54 → **54/54 ingested**, 480→558 chunks (after the
2026-08-12 rechunk fix), ~272k→~345k estimated tokens. `dead-links.md` now
reads "None."

**Dead links, both fixed:**
- **Source 12, AES TD1004.1.15-10**: AES restructured its technical-document
  tree in 2024; the PDF moved to
  `aes.org/wp-content/uploads/2024/01/AESTD1004_1_15_10.pdf`, linked from a
  landing page that itself notes TD1004 was superseded by TD1008 (2021) — so
  this is deliberately the historical 2015 document the dossier asked for,
  not a silent upgrade to the newer one. Repointed via the dossier + the new
  `corpus repoint-url` command (see below), then refetched: 0 → 12 chunks.
- **Source 52, "A Survey on LLM-as-a-Judge"**: ScienceDirect 403s bot
  traffic. Same paper (Gu, Jiang, Shi et al.), same abstract, is on arXiv
  (2411.15594, v6) under a **CC0 1.0** dedication the authors chose for this
  specific article — not arXiv's site-wide metadata license, a real
  per-article public-domain grant. Repointed the dossier to the arXiv
  preprint: 0 → 95 chunks, and the source's own redistribution verdict
  flipped **deny → allow** (corpus totals: 16→17 allow, 38→37 deny). This is
  the rare case where recovering a dead link also changes what could
  legally be committed, not just what the corpus can search.

**A real bug found and fixed along the way:** the manifest loader
(`loadManifest`) upserts `sources` keyed on `url`. That's correct for
re-running the same dossier, but wrong for a URL edit: reloading a dossier
where a source's URL changed found no existing row to match, so it inserted
a *new* source with a new id instead of updating the old one — silently
forking a duplicate while the stale, dead-URL row sat untouched. Fixed with
a new `manifest.mjs` export, `repointSourceUrl(db, id, newUrl)`, and a
`corpus repoint-url <id> <new-url>` CLI command that updates `sources.url`
in place *before* `load-manifest` runs, so the url-keyed upsert then matches
correctly. Both AES and arXiv repoints above went through this path. Tested
in `manifest.test.mjs`, including a test that reproduces the fork bug
directly (reload without `repoint-url` first) so the regression stays
caught.

**Thin sources: four recovered, one stays thin, one turned out not to be
broken.** Six sources were flagged as "1–2 chunks, JS-rendered." Confirming
each one's actual fetch history (not just its current chunk count) before
touching anything showed a real split:
- **Sources 2 (Podcast Index API docs) and 37 (TTS Arena V2)** were
  genuinely broken: 16–20 estimated tokens, fetch notes reading "thin
  extraction … page may be JS-rendered." Source 2 is a RapiDoc-rendered
  OpenAPI browser (shadow DOM); recovered its narrative front matter (auth
  scheme, client libraries, Postman collection) via a real-browser capture —
  1 → 587 tokens, still 1 chunk (correctly: a documentation front page is
  legitimately short). Source 37's actual app runs inside a **cross-origin
  sandboxed iframe** on a separate `*.hf.space` origin that a parent-page
  render genuinely cannot see into, and even a successful render would need
  an interactive "Synthesize" click before any leaderboard data appears —
  this is the textbook case for "leave it thin, record why, and move on"
  (`tools/corpus/README.md#rendered-html-route`). Left thin; the digest now
  documents exactly what was checked and why it stays that way.
- **Sources 14 (NotebookLM blog), 33 and 34 (Apple Developer Forum
  threads), and 39 (OpenAI community thread) were not actually broken.**
  Their prior fetches used normal Readability extraction (fetch note
  "readability", not "thin extraction") and already held 425–820 estimated
  tokens — a complete short document, correctly landing in one chunk because
  the source itself is short (a two-post forum thread does not need three
  chunks). The "1 chunk" signal that flagged them as weak was a proxy that
  doesn't distinguish "one chunk because we captured nothing" from "one
  chunk because there was one chunk's worth of real content." Re-captured
  them anyway via the same browser-render route for consistency and, for 33
  and 34, a genuine improvement: full reply-by-reply attribution the
  original single-pass extraction had run together. Lesson for next time:
  check `fetch_notes` for the literal "thin extraction" / "may be
  JS-rendered" marker before spending a browser-capture pass on a source —
  chunk count alone overstates how many of these are actually broken.

**New pipeline route, not a one-off workaround:** `ingestCapturedText`
(`tools/corpus/ingest.mjs`) plus `corpus ingest-captured --source ID --file
<path>` ingests a browser-rendered text capture through the same chunker,
archive layout and `documents`/`chunks` schema as a normal fetch — the
capture step (render the page, read its rendered text, save verbatim to a
file) is the only thing that isn't the existing fetcher. Documented in
`tools/corpus/README.md#rendered-html-route`, covered by
`tools/corpus/ingest.test.mjs` (new suite). Reproducible by any future
session or agent with browser automation available; requires no human in
the loop beyond running the capture once per source.

## Retro (2026-08-13 — the embedding backfill: a measured NO)

**Outcome: the experiment ran end to end, and the answer is that embeddings
do not earn their place in this corpus. The default search mode stays
`keyword`, and the corpus is left on its original chunking with no vectors
stored.** The capability is committed, tested and reproducible in about a
minute; it is opt-in, and the numbers below say why it should stay that way.

Joey approved running this knowing the recommendation was against it. This is
the real answer, not a flattering one.

### Step zero: the tokenizer measurement, which changed everything downstream

`corpus token-histogram` runs the model's own tokenizer over the exact string
each chunk would be encoded as. On the corpus as it stood (558 chunks, packed
by the chars/4 heuristic to 500–1000 "tokens"):

| | real tokens |
|---|---|
| p50 / p90 / p99 / max | 652 / 1094 / 1569 / 2253 |
| over bge's 512-token limit | **348 of 558 — 62.4%** |
| chars/4 drift | real = **1.07x** estimated |

So the crude heuristic was not merely crude, it was crude in the *dangerous*
direction: it undercounts, and its 1000-token ceiling lands around 1070 real
tokens — double the model's limit. Embedding the corpus as it stood would have
silently truncated **62% of it**, with `search` still displaying the whole
chunk. That is the failure mode worth the whole measurement step: nothing
errors, nothing looks wrong, and two-thirds of the corpus is invisible to the
retriever that claims to cover it.

Re-chunked with the real tokenizer at 100–400 real tokens (`corpus rechunk
--tokenizer`), 558 → **1268 chunks**: p50 350, p90 412, max 488, **0%
truncated**, 0.2% within 32 tokens of the limit. Backfill: 1268/1268 vectors
in **61 seconds** on CPU, no API key, $0.

### The three modes, side by side

15 gold queries, depth top-8 (the CLI's own default), measured on distinct
source ids. All three modes ran against the same re-chunked corpus.

| | found | Recall@5 | MRR@8 | nDCG@8 |
|---|---|---|---|---|
| keyword | 15/15 | 1.000 | 0.828 | 0.754 |
| vector | 13/15 | 0.867 | 0.683 | 0.576 |
| hybrid (RRF, k=60) | 15/15 | 1.000 | **0.856** | 0.670 |

Per-query first-hit rank (`MISS` = the source was not in the top 8):

| q | keyword | vector | hybrid | query |
|---|---|---|---|---|
| 1 | 1 | 1 | 1 | how does DAI break timestamps |
| 2 | 1 | 2 | 1 | what loudness target for stitched segments |
| 3 | 1 | 1 | 1 | does the server test cover embedded images |
| 4 | 1 | 1 | 1 | how do I fuse BM25 and vector results |
| 5 | 3 | 2 | 2 | diarization: who is speaking when |
| 6 | 1 | 1 | 1 | aligning word-level timestamps in long audio |
| 7 | 2 | **MISS** | 2 | where do I split a podcast into topics |
| 8 | 1 | 1 | 1 | cold start recommendations for new users |
| 9 | 1 | 4 | 1 | audio fingerprinting to detect a repeated ad |
| 10 | 1 | 1 | 1 | gapless playback of queued items on iOS |
| 11 | 1 | 1 | 1 | what does TTS cost per character |
| 12 | 3 | **MISS** | 3 | how do I stop an LLM judge from favouring long answers |
| 13 | 1 | 2 | 1 | can I republish someone's podcast audio |
| 14 | 1 | 1 | 1 | how are podcast downloads counted as a listen |
| 15 | 4 | 2 | 2 | why did the clip-sharing apps die |

**Gate 1 (no query may regress from found to not-found):** hybrid passes,
vector fails outright — it loses q7 and q12 entirely.

**Gate 2 (beat fixed-keyword on BOTH Recall@5 and MRR):** hybrid **fails**.
Recall is tied at 1.000, and tied is not better — keyword already answered
every question in the set, so recall had nowhere to go and an unchanged 1.000
is not a win. MRR does improve (+0.028), but on one metric of two.

**Vector-only is reported because it is the diagnostic number**, and it says
the model is the weak link rather than the fusion: RRF recovers both of the
queries dense retrieval loses, which is exactly what fusion is for. A better
model would raise the whole table; better fusion would not.

### The finding that actually decides it: re-chunking costs the default mode

The comparison above holds chunking constant, which flatters the experiment.
Embeddings require the re-chunk, so the honest baseline is the corpus as it
was before any of this:

| corpus chunking | mode | found | Recall@5 | MRR@8 | nDCG@8 |
|---|---|---|---|---|---|
| **chars/4, 500–1000 est (558 chunks) — as shipped** | **keyword** | 15/15 | 1.000 | **0.902** | **0.789** |
| bge tokenizer, 100–400 real (1268 chunks) | keyword | 15/15 | 1.000 | 0.828 | 0.754 |
| bge tokenizer, 100–400 real | vector | 13/15 | 0.867 | 0.683 | 0.576 |
| bge tokenizer, 100–400 real | hybrid | 15/15 | 1.000 | 0.856 | 0.670 |

**The best number in the whole table is the configuration we already had.**
Re-chunking for the embedding model costs keyword search 0.074 MRR and 0.035
nDCG, and hybrid on the re-chunked corpus (0.856) does not climb back to
plain keyword on the original (0.902). Embeddings are not neutral here; on
this measured set they are a net loss, and the loss is paid by the mode that
answers every query.

The mechanism is worth keeping: scores are computed on **distinct sources**
within a **chunk-level top-8**. Halving chunk size roughly halves how many
distinct sources fit in the eight rows a user actually sees, so a retrieval
depth tuned to the product punishes small chunks. Anyone re-running this
should change the depth and the chunk size together, or not at all.

The only way to have both would be two chunkings — a coarse one for FTS5 and
a fine one for vectors — which means a second chunk table, a second FTS
index, and two things to keep in sync with `documents`. That is a real
architecture, not a flag, and nothing measured here justifies it.

### What embeddings did do, which no number above captures

On paraphrase queries that share no vocabulary with the corpus — the case the
gold set structurally cannot measure, because its 15 questions were written
by someone looking at the corpus — dense retrieval wins outright:

| query (top-5 source ids) | keyword | vector | hybrid |
|---|---|---|---|
| "why do the numbers stop lining up after the adverts change" | 5, 7, 40, 20, 31 — **all wrong** | **19**, 40, 31, 5, **9** | 31, **9**, 40, 43 |
| "picking where one subject ends and the next begins" | 40, 19, 32, 52 — **all wrong** | 6, **25**, **26**, 52 | **26**, **25**, 28, 6 |

Sources 9/19 are the DAI-timestamp answer; 25/26 are topic segmentation.
Keyword returns nothing relevant for either, because the user used none of
the corpus's words. This is a real capability and it is why the code is
committed rather than reverted — but two hand-picked queries are an anecdote,
not a measurement, and they do not overturn a gate. If paraphrase robustness
ever becomes the goal, the honest next step is a gold set written *without*
looking at the corpus, not a default flipped on the strength of two examples.

### Decisions taken

1. **Default mode stays `keyword`** (`DEFAULT_SEARCH_MODE` in `search.mjs`).
   The gates are encoded in `eval.mjs`'s `compareToBaseline`, so the next
   person gets the same verdict from the same rule rather than from prose.
2. **The corpus is left on the default chunking, with no vectors stored.**
   Shipping the re-chunked corpus would have degraded the mode everyone
   actually uses. `corpus rechunk --tokenizer && corpus embed` reproduces the
   embedded state in ~65 seconds whenever someone wants to re-run this.
3. **The runtime stays quarantined and uninstalled by default.** Measured
   installed size: **373 MB** for `tools/corpus/embed/node_modules` — larger
   than the ~250MB the plan estimated. `onnxruntime-node` is 208 MB of it and
   ships binaries for six platforms, of which this machine loads 33 MB;
   `onnxruntime-web` (90 MB) and `sharp`/`@img` (19 MB) are pure dead weight
   for text embedding in Node. Model weights are a further 33 MB in
   `data-local/models/`. CI installs only `tools/corpus/package.json`, so it
   proves the runtime-absent path on every PR without being told to.

### A real bug this pass found, unrelated to embeddings

`rechunk` reported source 1's archived markdown as missing. It was: **the
corpus test suite had been writing its fixtures into the real
`data-local/corpus/` archive**, because `ingestSource` took the archive root
from a module constant while taking the database as a parameter. A temp DB
implied nothing about where files landed. Harmless clutter until
`removeStaleArchives` shipped in #161 — after which any suite seeding source
id 1 *deleted* the real source 1's archive, on the machine that built the
corpus, every time someone ran `npm test`. Fixed by making the archive root a
parameter alongside the DB, so the two can no longer diverge; the three
affected suites now use temp archives. Source 1 was restored by refetch (its
`content_sha256` in `corpus-index.json` moved — the extraction is byte-identical
in size, the upstream page's raw HTML shifted).

### If someone picks this up again

The lever with the most headroom is the **model**, not the fusion. bge-small
is 384-dim and 33 MB; the corpus is dense technical prose, court opinions and
standards documents, which is not what a small general-purpose encoder is
best at. Before trying a bigger model, though, note that the whole
experiment's cost centre is the re-chunk, and that cost is measured above —
any future attempt should re-measure the keyword baseline on its own chunking
before claiming an improvement.
