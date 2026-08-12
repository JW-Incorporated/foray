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
  triggers.
- Chunker: split at heading boundaries, pack paragraphs to ~500–1000 est.
  tokens (chars/4 heuristic, documented), oversize paragraphs split at sentence
  boundaries; heading_path = "H1 > H2 > H3".
- Manifest loader: parse the dossier markdown itself (READ FIRST list + the 9
  detail sections), dedupe by URL, OR the read_first flag. The parse IS the
  ingestion manifest — no hand-copied URLs.
- CLI `tools/corpus/corpus.mjs`: `init`, `load-manifest`, `ingest [--area N |
  --source ID | --all]`, `search "query"`, `stats`, `refetch <source_id>`,
  `report` (writes coverage.md + dead-links.md content).

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
