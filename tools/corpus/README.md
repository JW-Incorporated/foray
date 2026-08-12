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
node tools/corpus/corpus.mjs ingest --all            # fetch+extract+chunk
node tools/corpus/corpus.mjs ingest --area 4         # one dossier area
node tools/corpus/corpus.mjs search "server test"    # FTS5 keyword search
node tools/corpus/corpus.mjs search "x" --explain    # show the MATCH built
node tools/corpus/corpus.mjs search "x" --raw        # literal FTS5 syntax
node tools/corpus/corpus.mjs rechunk                 # re-chunk offline from archives
node tools/corpus/corpus.mjs eval                    # score retrieval on the gold set
node tools/corpus/corpus.mjs stats                   # per-area coverage
node tools/corpus/corpus.mjs refetch 12              # force re-ingest one source
node tools/corpus/corpus.mjs report --write          # coverage.md + dead-links.md
node tools/corpus/corpus.mjs export-index --write    # corpus-index.json (committed)
```

## Search quality

`search` takes ordinary questions. It used to take only FTS5 syntax, which
meant `search "what is DAI?"` died on the `?`, `diarization: who is speaking`
died interpreting `diarization:` as a column filter, and any question long
enough to be natural got implicitly ANDed into zero results. `ftsquery.mjs`
now turns user text into quoted, ORed phrase arms — the user's bytes become
data, never grammar — and `--raw` is the escape hatch for deliberate FTS5.

`eval` scores a committed gold set (`eval/gold-queries.json`: 15 questions,
expected source ids) on Recall@5 / MRR@10 / nDCG@10, per query and aggregate.
It exists so that no claim about retrieval quality has to be taken on faith.
The answer key was cross-checked by a second, fresh-context agent working
only from the dossier and coverage.md; where the two disagreed the file
records the disagreement instead of resolving it. Measured on this corpus:

| retrieval | found | Recall@5 | MRR@8 | nDCG@8 |
|---|---|---|---|---|
| raw passthrough (previous behaviour) | 3/15 | 0.200 | 0.200 | 0.160 |
| built query | **15/15** | **1.000** | **0.902** | **0.788** |

Measured at top-8, which is `search`'s own default — evaluating deeper than
users ever see inflates nDCG for free (the same run scores 0.865 at depth 25)
and measures a product nobody uses. `--limit` changes both.

The whole gain is the query builder; re-chunking contributes exactly zero to
these numbers (it is correctness hygiene, and it matters for the embedding
pass, not for bm25).

`rechunk` rebuilds every chunk from the archived markdown — no network, no
refetch. That is what `data-local/corpus/markdown/` is for: when a chunking
rule changes, the corpus rebuilds offline in seconds.

Schema (migrations/): `sources` (the parsed dossier — the dossier markdown IS
the manifest), `documents` (append-only fetch history; the newest 2xx row is
the current document), `chunks` (current document only, ~500–1000 est. tokens,
heading-path tagged, `embedding` NULL until the backfill pass), `chunks_fts`
(FTS5, trigger-synced). Parallel area ingestion is safe: WAL + busy_timeout
on the DB, and a cross-process host gate (`hostgate.mjs`) keeps sibling
processes from co-hammering a shared host.

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

Fixture-only, no network, no real sleeps (injected clock). Suites are floored
in `test/suite-integrity.test.js` like every `tools/` suite. A ci.yml step is
deliberately NOT added here — CI is Wyatt's surface; proposed separately.
