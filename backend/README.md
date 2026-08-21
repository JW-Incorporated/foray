# 4a backend

Node.js + TypeScript backend core for 4a: feed ingest primitives,
episode identity/dedup, a Tier-1 enrichment pipeline (real + stub), cost
metering with a budget guard, and a curation engine that assembles a
4-archetype session document. Local-first: `npm install && npm test`
requires no cloud services, no database, and no API keys.

See `../docs/brief/` for the product spec this implements against, and
`../docs/adr/` for the design decisions behind the pieces below.

## Requirements

- Node.js >= 20 (developed against Node 24)
- npm

No Postgres, no Docker, no API keys required for `npm install && npm test`
or `npm run build-session`.

## Setup

```bash
cd backend
npm install
```

Environment is read from the **repo-root** `.env` (one level up from
`backend/`), which already exists in this repo (see `.env.example` for the
documented keys: `ANTHROPIC_API_KEY`, `PODCASTINDEX_API_KEY`,
`PODCASTINDEX_API_SECRET`, `DAILY_BUDGET_USD`). Every key is optional —
absence is handled explicitly everywhere (`src/config/env.ts`), not treated
as a startup error. An optional `backend/.env.local` can override the
repo-root file for local-only experimentation (gitignored).

**Never** does this codebase log a raw env value — only booleans
("is this key present") via `envPresenceSummary()`.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies. |
| `npm test` | Run the full vitest suite (unit + integration, no network, no live DB, no LLM calls — see "Test isolation" below). |
| `npm run test:watch` | Same, in watch mode. |
| `npm run typecheck` | `tsc --noEmit` across `src/` and `test/` (strict mode). |
| `npm run build` | Compiles `src/` to `dist/` (`tsconfig.build.json`; test files are excluded from the build output). |
| `npm run build-session` | **The end-to-end pipeline proof.** Extracts candidates from `docs/research/*.md`, scores them against `data/taxonomy.json`, fills the 4 archetype slots, and writes a `session.json` (v1 schema) to `backend/output/`. Zero API keys required — runs entirely in dry-run mode by default. See below for flags. |
| `npm run ingest-fixtures` | Runs the RSS parser against every feed in `backend/fixtures/feeds/` and prints a human-readable summary (episode counts, warnings, duration-resolution stats) — the manual counterpart to `test/parser.test.ts`. |
| `npm run migrate` | Applies `backend/migrations/*.sql` in order against `DATABASE_URL` (works against a local Postgres or a Supabase project — the SQL is plain, Supabase-compatible). **With no `DATABASE_URL` set, prints what it would do and exits cleanly** — never required for `npm test`. |

### `build-session` flags

```bash
npm run build-session -- --commute-minutes 25 --speed 1.25 --session-key 2026-08-01-morning --out my-session.json
npm run build-session -- --candidates path/to/candidates.json --archetype comfort
npm run build-session -- --taxonomy path/to/other-taxonomy.json
```

- `--taxonomy <path>`: defaults to `../data/taxonomy.json` (repo root).
- `--candidates <path>`: a JSON file, either a flat array (episode objects
  with `show`, `episode_title`, `release_date`, `duration_min`, `summary`,
  `depth`, ...) or a keyed object (`{"stretch": [...], "narrative": [...],
  "comfort": [...]}`) — the same two shapes `docs/research/*.md` use. When
  omitted, candidates are extracted live from
  `docs/research/fusion-candidates.md` (deep-learn pool) and
  `docs/research/other-slot-candidates.md` (stretch/narrative/comfort
  pools) — see `src/curation/candidateExtractor.ts`.
- `--archetype <name>`: only used with `--candidates` pointing at a flat
  array file, to tag every candidate in it with one archetype.
- `--commute-minutes`, `--speed`, `--session-key`, `--out`: self-explanatory
  session-build parameters; see defaults in `src/cli/buildSession.ts`.

## Test isolation (why `npm test` never touches a network or an LLM)

- **Feed parser tests** run against real, checked-in fixture files
  (`fixtures/feeds/*.xml`) — no live HTTP.
- **Redirect resolver / conditional-GET / iTunes / Podcast Index client**
  tests all inject a stub `fetchImpl` — the real `fetch` is never called.
- **Podcast Index client** additionally runs in structural dry-run mode
  whenever `PODCASTINDEX_API_KEY`/`SECRET` are absent from env (which they
  are in this repo's `.env`), returning a canned stub result even if a test
  forgot to inject a fetch stub.
- **Enrichment (classification, why-lines)** always uses `StubEnricher` in
  tests — `createEnricher()` only ever returns `AnthropicEnricher` when
  `ANTHROPIC_API_KEY` is present, and `test/createEnricher.test.ts` asserts
  this repo's env keeps that key absent. `AnthropicEnricher` itself refuses
  to construct without a key (throws instead of silently no-op'ing), so
  there is no code path in the test suite that can reach the real Anthropic
  API even by accident.
- **Cost metering** uses `InMemoryCostEventSink` in every test — no
  database, no filesystem writes.
- **Migrations** are never applied by the test suite; `npm run migrate`
  is a separate, opt-in command.

## What's real vs. stubbed

**Real and tested:**
- Lenient RSS/podcasting-2.0 parser (`src/feeds/parser.ts`) — handles
  malformed XML (bare ampersands, control characters), CDATA/HTML show
  notes, all observed `itunes:duration` formats, missing metadata as
  hints. Exercised against 8 real, currently-live podcast feeds
  (`fixtures/feeds/`, see that directory's README for specific real-world
  weirdness found and fixed forward).
- Redirect-chain resolution (cap 8, `Range: bytes=0-0` probe, original +
  resolved URL both preserved).
- Conditional GET (ETag/If-Modified-Since).
- Per-host politeness budget + exponential backoff (host-keyed, not
  feed-keyed).
- Composite episode identity + dedup (`src/identity/dedup.ts`) — pure,
  fully unit-tested.
- iTunes Search/Lookup client (keyless, real API shape, tested with
  injected fetch stubs).
- Podcast Index client (HMAC-style auth header construction implemented;
  runs in dry-run mode without credentials, which this repo has).
- Cost metering + budget guard, including the tier-aware cutoff (Tier 2
  cuts off before Tier 1, per corner case 33).
- `StubEnricher`: deterministic (hash-derived, not random) fake
  classification and why-line generation — same input always produces the
  same output, so pipeline tests are reproducible without a real LLM.
- Scoring (relevance/freshness/quality/fatigue), archetype slot-filling,
  menu diversity self-audit, and the full session builder — all exercised
  against the repo's *real* research data (`docs/research/*.md`) and
  validated against the *real* `data/session.json`'s schema.

**Stubbed / not implemented in this pass (see relevant ADR or code comment
for the honest scope):**
- `AnthropicEnricher` is implemented against the real Anthropic Messages
  API (model: `claude-haiku-4-5`, per the cost-discipline constraint) but
  is **never exercised by the test suite** and has not been run against a
  live API key. JSON-schema enforcement is prompt-instruction + zod
  validation rather than server-side `output_config.format`, because the
  pinned SDK version's TypeScript types predate that feature — see the
  comment in `src/enrich/AnthropicEnricher.ts`.
- No ingest worker / scheduler (the thing that would actually call
  `fetchFeedConditional` on a cron and walk `shows.next_poll_due_at`) — the
  primitives it needs (conditional GET, politeness budget, dedup, parser)
  are built and tested; the orchestration loop is not. See ADR 0001.
- No embedding pipeline — `centroid_embedding` is reserved in the taxonomy
  schema but unpopulated; relevance scoring is taxonomy-weight-only. See
  ADR 0003.
- No transcript acquisition (Tier 2) — design-only, see ADR 0004.
- No TTS generation, no REST API server (Fastify/Hono), no Supabase Auth
  wiring — out of scope for "backend core" per the task's priority order.
- `fatigue` scoring is wired to accept real pick history but the CLI always
  calls it with an empty history (no `events` table is populated yet in
  this pass).

## Migrations

Plain numbered SQL files in `migrations/`, Supabase-compatible (uses
`pgcrypto`'s `gen_random_uuid()`, which Supabase-managed Postgres enables by
default). `user_id` is present on every table per the hard constraint, even
though there's a single seeded user today (`00000000-0000-0000-0000-000000000001`,
see `src/cli/buildSession.ts`). Run `npm run migrate` against a local
Postgres or a Supabase connection string to apply them; safe to re-run
(tracks applied migrations in a `schema_migrations` table, wraps each file
in a transaction).

## Directory guide

```
backend/
  src/
    config/env.ts            single source of env access; never logs values
    feeds/                   parser, duration normalization, HTML sanitizer,
                              redirect resolver, conditional GET, politeness budget
    identity/dedup.ts        composite episode identity + union-find dedup
    clients/                 iTunes Search/Lookup, Podcast Index (both dry-run-safe)
    cost/                    cost_events sink + tiered daily budget guard
    enrich/                  Enricher interface, StubEnricher, AnthropicEnricher, factory
    curation/                candidate extraction, scoring, archetype slotting, session builder
    types/                   zod schemas matching data/session.json and data/taxonomy.json exactly
    cli/                     build-session, ingest-fixtures, migrate
  migrations/                numbered plain SQL, Supabase-compatible
  fixtures/feeds/            8 real RSS feeds + README documenting real-world weirdness found
  test/                      vitest suite (164 tests at last count)
```
