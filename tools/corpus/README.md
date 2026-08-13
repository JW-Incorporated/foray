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
