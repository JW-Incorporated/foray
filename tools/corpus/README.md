# tools/corpus — research corpus system

Scrapes, archives, and indexes every source in
`docs/research/foray-research-dossier.md` (~57 sources, 9 areas) into a
searchable SQLite corpus for agent context, retrieval experiments, and a later
embedding backfill. Plan and ground rules: `docs/research/corpus/PLAN.md`.
Workstream announcement: root `STATE.md`.

Nothing fetched is ever committed: the DB and all archives live in
`data-local/corpus/` (gitignored).

```
data-local/corpus/
  corpus.db        SQLite (sources, documents, chunks, chunks_fts)
  raw/             raw bytes of every successful fetch (html/pdf/json/md)
  markdown/        cleaned markdown extracted from each raw artifact
```

## Modules

- `fetcher.mjs` — polite fetch policy: per-host serialization ≥2s (or robots
  Crawl-delay if larger), robots.txt respected + cached, honest User-Agent
  with contact, 3-attempt retry with backoff on 429/5xx/network, manual
  https-only redirects (≤5), 50MB cap, 30s/attempt timeout. HTTP failures are
  return values, not exceptions — dead links get recorded, not retried
  forever.
- `robots.mjs` — minimal RFC 9309-style parser (group selection, longest-match
  Allow/Disallow with `*`/`$`, Crawl-delay).
- `extract.mjs` — routing + extraction to markdown:
  - arXiv `/abs/` → the PDF (primary artifact)
  - GitHub repo root → raw README; GitHub issue → REST API (title + body +
    comments, already markdown)
  - `*.pdf` or `%PDF-` magic → pdfjs text extraction
  - everything else → Readability article extraction (whole-body fallback) →
    turndown(+gfm)
- `paths.mjs` — archive path construction; scraped titles are untrusted, so
  slugs are strict ascii and every path is proven to stay inside
  `data-local/corpus/`.

Dependencies are scoped to this directory (own `package.json`, like
`backend/` and `player/`); the repo root stays dependency-free. Requires
Node ≥22.5 (`node:sqlite`; run tests with `--experimental-sqlite` on 22.x —
unflagged on ≥23.4, which local dev and the DB layer assume).

## CLI

```
node tools/corpus/corpus.mjs init                    # create/migrate the db
node tools/corpus/corpus.mjs load-manifest           # parse dossier → sources
node tools/corpus/corpus.mjs repoint-url 12 https://new/url
                                                      # move a source's url, id-stable
node tools/corpus/corpus.mjs ingest --all            # fetch+extract+chunk
node tools/corpus/corpus.mjs ingest --area 4         # one dossier area
node tools/corpus/corpus.mjs ingest-captured --source 2 --file capture.txt
                                                      # ingest a rendered-page text capture
node tools/corpus/corpus.mjs search "server test"    # keyword search (the default)
node tools/corpus/corpus.mjs search "x" --mode hybrid # keyword + vectors, RRF-fused
node tools/corpus/corpus.mjs search "x" --explain    # show the mode + MATCH built
node tools/corpus/corpus.mjs search "x" --raw        # literal FTS5 syntax
node tools/corpus/corpus.mjs rechunk                 # re-chunk offline from archives
node tools/corpus/corpus.mjs rechunk --tokenizer     # …sized for the embedding model
node tools/corpus/corpus.mjs token-histogram         # real token lengths vs the model limit
node tools/corpus/corpus.mjs embed                   # backfill chunk vectors (opt-in runtime)
node tools/corpus/corpus.mjs eval                    # score retrieval on the gold set
node tools/corpus/corpus.mjs eval --all-modes        # all three modes + the gates
node tools/corpus/corpus.mjs stats                   # per-area coverage
node tools/corpus/corpus.mjs refetch 12              # force re-ingest one source
node tools/corpus/corpus.mjs report --write          # coverage.md + dead-links.md
node tools/corpus/corpus.mjs export-index --write    # corpus-index.json (committed)
```

## A source moved

A source moved means the dossier now points at a dead link and you found the
new canonical URL. The dossier is the manifest, so a moved source is fixed
there, never in the
DB directly. But `load-manifest`'s upsert keys off `url` — it is idempotent
for *re-running the same dossier*, not for *changing a URL*. If you only edit
the dossier and reload, the old row (still pointing at the dead URL) is left
untouched and a brand-new row forks off with a new id, because nothing in the
new entry matches the old row's `url` to trigger the update. Since
`documents`/`chunks` hang off source id and `dead-links.md`/`digests.md`/
`corpus-index.json` all cite sources by id, that fork is a real bug, not a
cosmetic one.

The fix is `repoint-url`, which updates just the `url` column for a known id
— still a committed, auditable CLI path, not a hand-edit:

```
# 1. edit the dossier entry's URL (keep the exact `**Title** — URL — note` shape)
node tools/corpus/corpus.mjs repoint-url 12 https://new.example.com/doc.pdf
node tools/corpus/corpus.mjs load-manifest   # now matches by the (now-shared) url, refreshes title/notes
node tools/corpus/corpus.mjs refetch 12      # actually fetches the new URL
```

## Rendered-HTML route

For JS-rendered pages: `fetcher.mjs` fetches server-sent bytes. A handful of sources are single-page
apps or forum threads whose server-sent bytes are a near-empty shell — the
content only exists after client-side JS runs. `extract.mjs` already names
this honestly: `htmlToMarkdown` flags anything under 200 chars as
`"thin extraction … page may be JS-rendered"` rather than pretending it got
real content.

The fix is a real browser, not a workaround in the fetcher. Procedure:

1. Render the source URL in an actual browser (e.g. Claude in Chrome's
   `navigate` + `get_page_text`, or any headless-browser tool that returns
   the page's rendered visible text).
2. Save that text verbatim to a file — no editing, no summarizing. The text
   must be what the page actually says; a paraphrase in its place would
   misrepresent the source as fetched-and-extracted when it was hand-written.
3. `node tools/corpus/corpus.mjs ingest-captured --source <id> --file <path>
   [--tool "chrome-devtools-mcp"]`

This calls `ingestCapturedText` (`ingest.mjs`), which runs the captured text
through the same chunker (`chunk.mjs`), the same archive layout
(`raw/<id>-<slug>.txt` + `markdown/<id>-<slug>.md`), and the same
`documents`/`chunks` schema as a normal fetch — `refetch`, `rechunk`,
`export-index`, `report` all treat a captured document exactly like a fetched
one. Only the fetch+HTML-extraction stage is replaced; `fetch_notes` records
`"rendered capture via <tool>"` so the DB always shows which sources were
captured rather than fetched. Re-running `ingest-captured` with unchanged
text is a no-op (`outcome: "unchanged"`), same as a normal refetch.

**When not to use this.** A paywall, login wall, or CAPTCHA is not a
rendering problem — a browser sees the same denial a fetcher does. Genuinely
dynamic content (a live leaderboard, a chat thread that only loads on
scroll-triggered pagination beyond what a single render captures) may still
come back thin after a real render. Recording that honestly (leave it thin,
note why in `dead-links.md` / `PLAN.md`'s retro) is a correct outcome — this
route recovers content that exists but wasn't rendered, not content that
isn't accessible at all.

## Search quality

`search` takes ordinary questions. It used to take only FTS5 syntax, which
meant `search "what is DAI?"` died on the `?`, `diarization: who is speaking`
died interpreting `diarization:` as a column filter, and any question long
enough to be natural got implicitly ANDed into zero results. `ftsquery.mjs`
now turns user text into quoted, ORed phrase arms — the user's bytes become
data, never grammar — and `--raw` is the escape hatch for deliberate FTS5.

`eval` scores a committed gold set (`eval/gold-queries.json`: 15 questions,
expected source ids) on Recall@5 / MRR@8 / nDCG@8 — the MRR and nDCG cut-off
follows `--limit`, so it is 8 by default and moves with the flag — per query
and aggregate.
It exists so that no claim about retrieval quality has to be taken on faith.
The answer key was cross-checked by a second, fresh-context agent working
only from the dossier and coverage.md; where the two disagreed the file
records the disagreement instead of resolving it. Measured on this corpus:

| retrieval | found | Recall@5 | MRR@8 | nDCG@8 |
|---|---|---|---|---|
| raw passthrough (previous behaviour) | 3/15 | 0.200 | 0.200 | 0.160 |
| built query | **15/15** | **1.000** | **0.902** | **0.788** |

Measured at top-8, which is `search`'s own default — evaluating deeper than
users ever see inflates nDCG for free (the same run scores 0.864 at depth 25)
and measures a product nobody uses. `--limit` changes both.

**What these numbers do not measure.** Two blind spots, both structural:

1. *The query set is not independent.* The 15 questions were written by the
   session that wrote the fix, after it had seen which inputs broke, and four
   of them (2, 5, 6, 13) are verbatim the crash/silent-zero repros. Those were
   guaranteed to score zero before. Excluding all four, the before/after on
   the remaining 11 is **3/11 → 11/11** — smaller, still large, and not
   circular. Quote that one when the set is challenged.
2. *Operator queries are invisible to it.* Every gold question is natural
   language, so nothing here exercises FTS5 syntax — which the builder now
   treats as literal text. `term*` (prefix), `col:term` (column filter) and
   `NEAR`/`AND`/`OR` are no longer operators: `gapl*` finds "gapless" via
   `--raw` and finds nothing without it. That is a deliberate trade (questions
   are the common case, syntax was the rare one), but it is a real behaviour
   change for anyone who learned the old syntax, and no number above reflects
   it. `--raw` is the escape hatch for all of them.

The whole gain is the query builder; re-chunking contributes exactly zero to
these numbers (it is correctness hygiene, and it matters for the embedding
pass, not for bm25).

## Semantic search — measured, and NOT the default

`--mode vector` and `--mode hybrid` exist and work. **Neither is the default,
because neither earned it.** The full experiment and its numbers are in
`docs/research/corpus/PLAN.md`'s 2026-08-13 retro; the short version:

| corpus chunking | mode | found | Recall@5 | MRR@8 | nDCG@8 |
|---|---|---|---|---|---|
| **chars/4, 500–1000 est — as shipped** | **keyword** | 15/15 | 1.000 | **0.902** | **0.789** |
| bge tokenizer, 100–400 real | keyword | 15/15 | 1.000 | 0.828 | 0.754 |
| bge tokenizer, 100–400 real | vector | 13/15 | 0.867 | 0.683 | 0.576 |
| bge tokenizer, 100–400 real | hybrid | 15/15 | 1.000 | 0.856 | 0.670 |

Two gates decide the default, and they are code (`compareToBaseline` in
`eval.mjs`), not prose: **no query may regress from found to not-found**, and
the candidate must beat fixed-keyword on **both** Recall@5 and MRR. Keyword
already answers 15/15, so recall cannot improve — a tied 1.000 is not a win,
and hybrid's +0.028 MRR is one metric of two. Worse, embeddings *require* the
re-chunk (62% of the corpus was over bge's 512-token limit at the old chunk
size), and the re-chunk costs keyword 0.074 MRR — more than hybrid gives back.

What embeddings genuinely do is answer questions phrased in words the corpus
never uses ("why do the numbers stop lining up after the adverts change" finds
the DAI sources; keyword returns nothing relevant). The gold set cannot see
that, because its questions were written by someone reading the corpus. That
is a real capability and it is why this code is committed — but it is an
anecdote until someone writes a paraphrase gold set, and an anecdote does not
flip a default.

**The corpus on this machine is left on the default chunking with no vectors.**
To reproduce the experiment (~65 seconds):

```
cd tools/corpus/embed && npm install    # ~373MB, see below — once per machine
node tools/corpus/corpus.mjs token-histogram          # the gate: measure first
node tools/corpus/corpus.mjs rechunk --tokenizer --drop-embeddings
node tools/corpus/corpus.mjs embed
node tools/corpus/corpus.mjs eval --all-modes
node tools/corpus/corpus.mjs rechunk --drop-embeddings   # …and back
```

### The runtime is quarantined, and that is the point

`tools/corpus/embed/` has its **own `package.json`** holding the only heavy
dependency in this tree: `@huggingface/transformers`, which pulls
`onnxruntime-node`. Measured installed size: **373MB** — `onnxruntime-node`
alone is 208MB (binaries for six platforms; this one loads 33MB),
`onnxruntime-web` is 90MB of dead weight in Node, `sharp` another 19MB for
image handling nothing here uses.

`tools/corpus/` has advertised zero native dependencies since it was built, so
this is a stack change rather than a feature, and it is opt-in:

- `cd tools/corpus && npm ci` — **what CI runs** — never installs it.
- The whole fixture-only test suite passes without it (a deterministic stub
  embedder stands in; no model is ever downloaded in CI).
- `search --mode keyword` works with `embed/` absent, and `--mode hybrid`
  **degrades to keyword with a one-line notice** rather than failing. The CLI
  never hard-fails for someone who only wants keyword search.

Model weights (33MB) live in `data-local/models/` via an explicitly set cache
directory — never `node_modules`, never a global cache. `dtype: 'q8'` is
explicit because Node/CPU otherwise defaults to fp32. After the first run the
loader sets `allowRemoteModels` false, so it is offline and reproducible.
Nothing about the model is committed.

### How the modes work

- **vector** — `Xenova/bge-small-en-v1.5`, 384-dim, CLS pooling, L2-normalized
  at write so similarity is a plain dot product over one flat matrix. The
  encoder sees `"{source title} — {heading path}\n\n{chunk text}"`;
  `chunks.text` is stored unchanged. The **query prefix comes from the
  registry row**, never from caller code — BGE prefixes queries only, and
  getting that backwards degrades every result without erroring.
- **hybrid** — Reciprocal Rank Fusion, k=60, over both arms' ranks (Cormack,
  Clarke & Buettcher, SIGIR 2009 — source 29 in this very corpus). RRF ignores
  scores entirely, which is why a bm25 score and a cosine similarity fuse with
  no normalization and no tuning. Both arms retrieve deeper than the display
  limit before fusing; fusing two lists of exactly `--limit` throws away the
  agreement evidence that makes fusion work.
- **the length gate** — `token-histogram` runs the model's own tokenizer over
  the exact strings that would be encoded and prints the truncation rate.
  bge truncates at 512 tokens **silently**: the tail of an over-long chunk is
  simply absent from its vector while `search` keeps displaying it. At the
  chars/4 chunk size, 62% of this corpus was over the line. Never embed
  without running this first.

`rechunk` rebuilds every chunk from the archived markdown — no network, no
refetch. That is what `data-local/corpus/markdown/` is for: when a chunking
rule changes, the corpus rebuilds offline in seconds.

Schema (migrations/): `sources` (the parsed dossier — the dossier markdown IS
the manifest), `documents` (append-only fetch history; the newest 2xx row is
the current document), `chunks` (current document only, ~500–1000 est. tokens,
heading-path tagged), `chunks_fts` (FTS5, trigger-synced), and — since 0003 —
`embedding_models` + `chunk_embeddings` (see below). Parallel area ingestion is
safe: WAL + busy_timeout on the DB, and a cross-process host gate
(`hostgate.mjs`) keeps sibling processes from co-hammering a shared host.

## Vector storage

`chunks.embedding`, the single BLOB column 0001 reserved for "the" model, is
**gone** as of migration 0003. It could not survive a second model: under the
Postgres+pgvector lift this schema is written for, a vector column's dimension
lives in the column type, so one column physically cannot hold a 384-dim and a
768-dim model at once. Two tables replace it:

- **`embedding_models`** — the registry: name, revision, dim, pooling,
  normalized, quantization, and **both prefixes**. BGE-family models want an
  instruction prefix on QUERIES and none on PASSAGES; E5 prefixes both sides,
  GTE neither. Getting that backwards degrades every result and raises no
  error, so the convention is stored as DATA on the model row and read by the
  retriever, never hard-coded in whichever caller runs next.
- **`chunk_embeddings`** — `(chunk_id, model_id)` composite PK, `vector BLOB`,
  `ON DELETE CASCADE` from `chunks`. The cascade is the point: `rechunk`
  rewrites `chunks` wholesale, and vectors keyed to chunk ids that no longer
  exist are the classic stale-index bug. Cascading makes it structurally
  impossible rather than merely remembered — and `rechunk` refuses to run at
  all while vectors exist unless you pass `--drop-embeddings`.

A `BEFORE INSERT`/`BEFORE UPDATE` trigger asserts `length(vector) = 4 * dim`.
Nothing else stands between a truncated write and a corpus of silently-wrong
similarities.

The blob is **bare little-endian float32, L2-normalized at write**, with no
header — the element count is `byteLength / 4`. That is sqlite-vec's own
convention, so if a brute-force scan ever stops being instant, `vec0` becomes
a virtual table over these same bytes rather than a re-encoding migration.
Normalizing at write is what makes similarity a plain dot product.
`vectors.mjs` carries the one non-obvious hazard: `node:sqlite` returns a BLOB
as a `Uint8Array` that may be a view at an arbitrary `byteOffset`, and
`new Float32Array(u8.buffer, u8.byteOffset, n)` throws on any offset that is
not a multiple of 4 — which depends on the row, not the code, so it fails in
production on some rows and never in a small test. Every read goes through
`readVectorInto`, which checks alignment and falls back to a `DataView` copy.

## What leaves this machine

The DB and archives are gitignored, so the corpus exists only where it was
built. The repo is **public**, so the fetched text cannot simply be committed:
that would be republication of 54 third-party works, most of which carry no
license permitting it (product principle #3, "legally boring"). What is
committed instead:

- `docs/research/corpus/digests.md` — **authored** by us: per source, what it
  says in our own words, its key facts, and the redistribution verdict with the
  licence evidence behind it. Fail-closed: "in doubt" is `deny`.
- `docs/research/corpus/corpus-index.json` — **generated** from that file plus
  the DB by `export-index`: urls, `content_sha256`, chunk/token counts, fetch
  status, local archive paths, and the same digests, machine-readable for
  agents.

`export-index.mjs` has no code path that reads `chunks.text`, and its parser
rejects a digest long enough to be pasted source text (2500 chars) — the same
shape of guard as the transcript index's "no body-sized strings" rule.

## Rebuilding the corpus on another machine

Nothing is lost by not committing it — the dossier is the manifest, so a clean
machine rebuilds in one pass (~40MB on disk, most of it PDFs; a few minutes,
paced by the ≥2s/host politeness gate):

```
cd tools/corpus && npm install
node tools/corpus/corpus.mjs init
node tools/corpus/corpus.mjs load-manifest
node tools/corpus/corpus.mjs ingest --all
node tools/corpus/corpus.mjs export-index          # dry run: does it match?
```

Compare `content_sha256` in the committed index against your rebuild to see
which sources changed upstream since 2026-08-12. Two sources are known dead
(`dead-links.md`) and will fail on any machine.

## Tests

```
cd tools/corpus && npm install && npm test
```

Fixture-only, no network, no real sleeps (injected clock), **no embedding
runtime and no model download** — `backfill.test.mjs` and `search.test.mjs`
inject a deterministic stub embedder instead. Suites are floored in
`test/suite-integrity.test.js` like every `tools/` suite, and CI runs them via
`npm ci`, which installs `tools/corpus/package.json` only.

Every test that ingests passes an explicit archive root. That is not
housekeeping: `ingestSource` used to take its DB as a parameter but its
archive directory from a module constant, so a suite seeding source id 1 wrote
into the real `data-local/corpus/` — and, once `removeStaleArchives` landed,
*deleted* the real source 1's archived markdown every time someone ran
`npm test` on the machine that built the corpus. The root is a parameter now,
so a temp database implies a temp archive.
