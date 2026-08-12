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
node tools/corpus/corpus.mjs stats                   # per-area coverage
node tools/corpus/corpus.mjs refetch 12              # force re-ingest one source
node tools/corpus/corpus.mjs report --write          # coverage.md + dead-links.md
```

Schema (migrations/): `sources` (the parsed dossier — the dossier markdown IS
the manifest), `documents` (append-only fetch history; the newest 2xx row is
the current document), `chunks` (current document only, ~500–1000 est. tokens,
heading-path tagged, `embedding` NULL until the backfill pass), `chunks_fts`
(FTS5, trigger-synced). Parallel area ingestion is safe: WAL + busy_timeout
on the DB, and a cross-process host gate (`hostgate.mjs`) keeps sibling
processes from co-hammering a shared host.

## Tests

```
cd tools/corpus && npm install && npm test
```

Fixture-only, no network, no real sleeps (injected clock). Suites are floored
in `test/suite-integrity.test.js` like every `tools/` suite. A ci.yml step is
deliberately NOT added here — CI is Wyatt's surface; proposed separately.
