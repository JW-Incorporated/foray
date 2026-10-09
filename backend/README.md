# 4a backend

Node.js + TypeScript backend core for 4a. It is a library plus founder-run
CLIs, not a server: there is no long-running process of its own. What it
holds:

- the Foray **generation pipeline** (`src/generation/`) and the CLIs that run
  it and publish its output;
- **feed and catalogue primitives** — the lenient RSS parser, conditional GET,
  the shared episode identity, the breadth catalogue and the per-show episode
  store — which the Vercel functions in `../api/` import (see "Who calls this
  code in production" below);
- the **curation engine** that assembles a 4-archetype session document, with
  a Tier-1 enrichment step (real + stub);
- **cost metering** with a per-process budget guard;
- plain SQL **migrations**.

Local-first: `npm install && npm test` requires no cloud services, no
database, and no API keys.

See `../docs/brief/` for the product spec this implements against,
`../docs/curation/generation-architecture.md` for the generation pipeline, and
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
`PODCASTINDEX_API_SECRET`, `RUN_BUDGET_USD`, `EPISODE_BUDGET_USD`; the old
`DAILY_BUDGET_USD` is a deprecated alias of `RUN_BUDGET_USD`, read with a
startup warning). Every key is optional —
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
| `npm run lint` | ESLint (with `eslint-plugin-security`) over `src/` and `test/`. |
| `npm run build` | Compiles `src/` to `dist/` (`tsconfig.build.json`; test files are excluded from the build output). |
| `npm run mutation` | Stryker mutation run (`stryker run`). Slow; not part of CI. |

## CLI scripts

Every `tsx` script in `package.json`, and nothing else
(`test/readme.test.ts` holds this table to `package.json`). All of them are
run by hand — no server calls them — and all of them run without an API key
or `DATABASE_URL` (dry-run, stub or print-and-exit) unless you supply one.

| Command | Source | What it does |
|---|---|---|
| `npm run build-session` | `src/cli/buildSession.ts` | **The curation pipeline proof.** Extracts candidates from `docs/research/*.md`, scores them against `data/taxonomy.json`, fills the 4 archetype slots, and writes a `session.json` (v1 schema) to `backend/output/`. Zero API keys required. See the flags below. |
| `npm run build-ladder` | `src/cli/buildLadder.ts` | Regenerates one ladder in `data/ladders.json` from already-tagged episodes plus a hand-written curator hints file. Zero LLM calls. `npm run build-ladder -- --node engineering/energy-fusion --hints ../docs/research/fusion-ladder-curation.json --ladder-id fusion-101 --status draft`. |
| `npm run generate-foray` | `src/cli/generateForay.ts` | **Generation §4.0–4.1** (`../docs/curation/generation-architecture.md`): captures a prompt + duration and runs it through the safety check, clarify step and intent extraction. Founder-run CLI — see `docs/DECISIONS.md` 2026-09-01 for why. `npm run generate-foray -- --prompt "the history of grilling" --duration medium`. |
| `npm run generate-forays` | `src/cli/generateForays.ts` | **The batch driver:** N prompts in, N candidate Forays out (one JSON file each, in `publish-foray`'s input shape, plus a `report.json`). Resumable per prompt and per stage (`src/cli/checkpointStore.ts`); stops at `RUN_BUDGET_USD`. Writes candidates, never publishes. |
| `npm run publish-foray` | `src/cli/publishForay.ts` | **Generation §4.9:** validates one candidate (`finalizeForay()` and the existing Foray/narration checks, then the app's own suites via `src/cli/publishSuites.ts`), writes `data/forays.json` plus the minted pool rows on a `generate/<id>` branch cut from `origin/main`, and opens a held PR. A failing candidate writes nothing. |
| `npm run ingest-fixtures` | `src/cli/ingestFixtures.ts` | Runs the RSS parser against every feed in `backend/fixtures/feeds/` and prints a human-readable summary (episode counts, warnings, duration-resolution stats) — the manual counterpart to `test/parser.test.ts`. |
| `npm run migrate` | `src/cli/migrate.ts` | Applies `backend/migrations/*.sql` in order against `DATABASE_URL` (a local Postgres or a Supabase project — the SQL is plain, Supabase-compatible). **With no `DATABASE_URL` set, prints what it would do and exits cleanly** — never required for `npm test`. |
| `npm run learn-interests` | `src/cli/learnInterests.ts` | The interest-learning job: reads unprocessed `events` rows page by page and writes `taxonomy_nodes` weights and the `user_interests` audit log (`src/curation/learningJob.ts`). Without `DATABASE_URL`, prints what it would do and exits 0. |

Two more files in `src/cli/` are entry points without a `package.json`
script; each is run through a launcher in `../tools/`:

- `src/cli/warmTranscriptIndex.ts` — `node tools/generation/warm-transcript-index.mjs`
  builds the transcript text index for every show before a generation run
  and prints what it cost.
- `src/cli/buildCorpusTerms.ts` — `node tools/foraycorpus-export/build-terms.mjs`
  writes the corpus-wide document-frequency table and each episode's top
  terms (`docs/roadmap/corpus.md` §3).

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

## Who calls this code in production

There is an HTTP surface, but it is not in this directory and it is not a
Fastify/Hono server: it is the Vercel functions under `../api/`, which import
modules from `backend/src` directly (`api/_test/import-closure.test.mjs`
guards what those imports may pull in). On `origin/main` when this was
written:

| `api/` file | imports from `backend/src` |
|---|---|
| `api/shows/[show_id]/episodes.ts` | `catalog/ingestShowFeed`, `catalog/showEpisodesStore` |
| `api/shows/search.ts` | `catalog/searchBreadthShows` |
| `api/episodes/search.ts` | `feeds/parser` (type), `feeds/userAgent` |
| `api/_lib/feedCache.ts` | `feeds/conditionalGet`, `feeds/parser` |
| `api/_lib/liveEpisodeId.ts` | `feeds/parser` (type), `feeds/episodeIdentity` |
| `api/_lib/appleShowSearch.ts` | `feeds/userAgent` |
| `api/_lib/showCatalog.ts` | `catalog/breadthCatalog` |

To re-check: `git grep -n "backend/src" -- api ':!api/_test'`.

Everything else in `src/` runs only from the CLIs above or from tests.

## Test isolation (why `npm test` never touches a network or an LLM)

- **Feed parser tests** run against real, checked-in fixture files
  (`fixtures/feeds/*.xml`) — no live HTTP.
- **Redirect resolver / conditional-GET / iTunes / Podcast Index client**
  tests all inject a stub `fetchImpl` — the real `fetch` is never called.
- **Podcast Index client** additionally runs in structural dry-run mode
  whenever `PODCASTINDEX_API_KEY`/`SECRET` are absent from env, returning a
  canned stub result even if a test forgot to inject a fetch stub.
- **Every LLM call goes through a factory** — `createEnricher()` and the
  `src/generation/create*.ts` factories — that returns the `Stub*`
  implementation whenever `ANTHROPIC_API_KEY` is absent, and
  `test/createEnricher.test.ts` asserts this repo's env keeps that key absent.
  The `Anthropic*` classes are tested with an injected mock client, never the
  real API.
- **Cost metering** uses `InMemoryCostEventSink` in every test — no
  database, no filesystem writes.
- **Migrations** are never applied by the test suite; `npm run migrate`
  is a separate, opt-in command.

## What's real vs. staged vs. not built

**Real, tested, and on a production path** (an `api/` function or a CLI
above calls it):
- Lenient RSS/podcasting-2.0 parser (`src/feeds/parser.ts`) — handles
  malformed XML (bare ampersands, control characters), CDATA/HTML show
  notes, all observed `itunes:duration` formats, missing metadata as
  hints. Exercised against real podcast feeds (`fixtures/feeds/`, see that
  directory's README for the real-world weirdness found and fixed forward).
- Conditional GET (ETag/If-Modified-Since, `src/feeds/conditionalGet.ts`).
- The one episode identity rule shared by the DB ingest and the live API
  (`src/feeds/episodeIdentity.ts`).
- Breadth show catalogue + search, and the per-show episode store with its
  feed ingest (`src/catalog/`).
- The Foray generation pipeline (`src/generation/`), run by
  `generate-foray`, `generate-forays` and `publish-foray`. Model ids and
  their per-token prices live in one file, `src/config/models.ts`: a stage
  asks for a tier (`modelFor("opus")`, `modelFor("sonnet")`,
  `modelFor("haiku")`) and that file resolves it, overridable by
  `FORAY_MODEL_*`. No other file writes a model id.
- Cost metering + budget guard: two per-process caps, `RUN_BUDGET_USD` (all
  this process may spend, every operation alike) and `EPISODE_BUDGET_USD` (one
  Foray). The sink is in memory, so a new process starts at $0
  (`docs/DECISIONS.md` 2026-10-07).
- `StubEnricher`: deterministic (hash-derived, not random) fake
  classification and why-line generation — same input always produces the
  same output, so pipeline tests are reproducible without a real LLM.
- Scoring (relevance/freshness/quality/fatigue), archetype slot-filling,
  menu diversity self-audit, union-find dedup (`groupDuplicates` in
  `src/identity/dedup.ts`) and the full session builder — all exercised
  against the repo's *real* research data (`docs/research/*.md`) and
  validated against the *real* `data/session.json`'s schema.
- `AnthropicEnricher` (`src/enrich/AnthropicEnricher.ts`): the real Tier-1
  classifier, on the `haiku` tier (`modelFor("haiku")`), chosen by
  `createEnricher()` for `build-session` when a key is present. JSON-schema
  enforcement is prompt instruction + zod validation rather than server-side
  `output_config.format`, because the pinned SDK version's TypeScript types
  predate that feature — see the comment in that file.

**Staged primitives, no production caller (arch-drift-8).** Built and tested
for the ADR 0001 ingest worker, which does not exist yet; only their own tests
import them. Round-3 review arch-drift-8
(`docs/audit/round-3-code/findings-detail.md`) ruled keeping them deliberate,
so they stay — but nothing in production runs them:
- Redirect-chain resolution (`src/feeds/redirect.ts`: cap 8,
  `Range: bytes=0-0` probe, original + resolved URL both preserved). The
  live API applies its own redirect ceiling (`api/_lib/feedGuard.ts`).
- Per-host politeness budget + exponential backoff
  (`src/feeds/politeness.ts`). The budget the poll tools actually use is
  `tools/poll/politeness.mjs`.
- iTunes Search/Lookup client (`src/clients/itunes.ts`, keyless, tested with
  injected fetch stubs). The API's Apple lookup is
  `api/_lib/appleShowSearch.ts`.
- Podcast Index client (`src/clients/podcastIndex.ts`; HMAC-style auth header
  construction implemented; dry-run without credentials).
- `computeIdentityKey` in `src/identity/dedup.ts` (the composite key, as
  opposed to `groupDuplicates`, which the session builder uses).

**Not built (see the relevant ADR or code comment for the honest scope):**
- No ingest worker / scheduler (the thing that would call
  `fetchFeedConditional` on a cron and walk `shows.next_poll_due_at`) — the
  staged primitives above are what it would use. See ADR 0001.
- No embedding pipeline — `centroid_embedding` is reserved in the taxonomy
  schema but unpopulated; relevance scoring is taxonomy-weight-only. See
  ADR 0003.
- No narration audio here: the pipeline writes narration text; rendering it
  is `tools/narration/render-foray.py`, run by
  `.github/workflows/render-narration.yml`.
- No server process and no Supabase Auth wiring — the only HTTP surface is
  `../api/` (above).
- `fatigue` scoring is wired to accept real pick history, but `build-session`
  never passes one (`recentPicks` defaults to empty).

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
    config/models.ts         the one place model ids and their prices live (modelFor/costFor)
    feeds/                   parser, duration normalization, HTML sanitizer, conditional GET,
                              episode identity, user agent; staged: redirect resolver,
                              politeness budget
    catalog/                 breadth show catalogue + search, per-show episode store and ingest
    identity/dedup.ts        union-find dedup (used) + composite identity key (staged)
    clients/                 staged: iTunes Search/Lookup, Podcast Index (both dry-run-safe)
    cost/                    cost_events sink (in memory) + per-process budget guard
    enrich/                  Enricher interface, StubEnricher, AnthropicEnricher, factory
    generation/              the Foray generation pipeline: stage interfaces, Stub* and
                              Anthropic* implementations, factories, stitching, finalize
    curation/                candidate extraction, scoring, archetype slotting, session builder,
                              ladders, interest learning
    copy/                    copy rules shared with tools/ (plain CommonJS on purpose)
    types/                   zod schemas for the data/*.json documents and pipeline stages
    cli/                     the CLI scripts above, plus checkpointStore and publishSuites
  migrations/                numbered plain SQL, Supabase-compatible
  fixtures/feeds/            real RSS feeds + README documenting real-world weirdness found
  test/                      vitest suite (every file floored in ../test/suite-integrity.test.js)
```
