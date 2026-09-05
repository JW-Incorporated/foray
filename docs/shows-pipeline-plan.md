# Plan: the shows pipeline — every show, every episode, one list

*Drafted 2026-09-04 from a scoping conversation with Wyatt. Execution is by a
fleet of agents; this document is the contract they work from. Nothing in it
is built yet.*

**Status of this document:** proposed, awaiting Wyatt's read. It supersedes
the verdict in `docs/curation/catalogue-broadening.md` §2 ("the dump is a
research tool, not an ingest path") and the "lazy only" reading of
`docs/show-pages-plan.md` Stage 3b. It does not supersede product principle
#3 (legally boring: never rehost, proxy or transform audio) or the keyless
posture of the cloud automation — both hold throughout.

---

## 0. The ask, in Wyatt's words, and the decisions already taken

> We have a download from podcastindex.org of ~all podcasts and their RSS
> feeds. Joey has it and is appending metadata for recommenders and foray
> triage. I want the first couple of columns of that database to be our
> complete list of shows. When someone searches for a show, it searches that
> list. Each show's data is hosted by the podcaster; when I open a show's
> page, the header and all the episodes are loaded from the podcaster. When I
> search for an episode — in the show search, or on the show's own page, which
> doesn't exist yet — results can be episodes, not just shows. If one episode
> from a show is in 4a, all episodes from that show are in 4a.

And the follow-up that reshaped §4:

> If it only refreshes when a user opens that show, and no user ever opens a
> show, we miss tons of episodes for curation and use. We need a better
> solution there.

Decisions taken in the conversation (2026-09-04). Each work package below
cites the one it rests on.

| # | Decision | Status |
|---|---|---|
| D1 | **Which rows are "in 4a":** alive, ≥ 3 episodes, updated within 24 months. Language filter is open. | Default, **re-confirm once Joey's export is visible** |
| D2 | **Identity:** PodcastIndex id is the show identity; feed URL is the join key; Apple collection id kept as cross-reference. Today's slug `show_id`s get a mapping table, not a rename. | Decided |
| D3 | **Joey's export:** contract in §3.1; format, location and cadence pending. Agents assume the contract is met. | **Pending Joey** |
| D4 | **Show search runs server-side** over our Postgres. The privacy policy's bold promise that the Shows search box transmits nothing must change **before** the app ships the change — with a mechanical tripwire so it cannot be forgotten (§5, WP7). | Decided |
| D5 | **Episodes are fetched lazily on show open** for serving. **Plus** a scheduled poller over a watchlist so curation sees episodes nobody has opened (§4). | Decided, amended by the follow-up |
| D6 | **Episode search scope:** episodes we have ingested, plus Apple's keyless episode search as the breadth fallback. We do not crawl 4.7M feeds. | Decided (option b) |
| D7 | **A search box on the show page**, client-side over the fetched list. | Decided |
| D8 | **Curated tier becomes an overlay** on the universal shows table — a flag plus editorial columns. Home, forays and playlists keep drawing from the curated subset. Joey's appended columns stay **out of the app path** for now. | Decided |
| D9 | **Offline:** search only what is already on the device (bundled top list + shows/episodes cached from earlier use). No search over shows that could not then load. | Decided |
| D10 | **Infra:** Vercel functions + Supabase Postgres stay as the serving layer; GitHub Actions cron for scheduled work. | Decided |
| D11 | **Freshness:** revalidate a show's feed on open when the cache is older than one hour (conditional GET, so a 304 costs nothing). | Default |
| D12 | **Three decoupled loops:** show-list refresh (from the PodcastIndex export), episode refresh (from podcasters' feeds), curation (the nightly agent pass). None polls feeds on another's behalf. | Decided |
| D13 | **Dedupe:** several feeds for one show collapse to the one Apple lists, else the most recently updated. | Default |

Open for later, not blocking: whether Joey's appended metadata eventually
replaces `data/breadth-classification.json` (our taxonomy classification of
breadth shows) or sits beside it.

---

## 1. What exists today (measured 2026-09-04, `main` @ `c60dbbc`)

Three layers, built at different times for different purposes:

| Layer | Where | Size | Ships to client? | Episodes? |
|---|---|---|---|---|
| Curated tier | `data/catalog.json`, `data/discover.json`, `data/catalog-client.json` | 220 shows, 1,946 episodes | Yes (mobile: 3 episodes/show) | Hand-picked only |
| Breadth tier | `data/catalog-breadth.json` (US), `data/catalog-breadth-intl.json.gz` | 19,787 + 121,786 shows ≈ 138k feeds, all from Apple's charts (July 2026) | No | None by design |
| Show pages (Stage 3b, #429) | `api/shows/[show_id]/episodes.ts`, `backend/src/catalog/`, migration `0016` | Fetches a show's RSS on open, caches every episode in Postgres | via API | Full feed |

Show search today: an instant local pass over the 220 curated shows, then a
breadth request to `api/shows/search` (a Vercel function that reads the two
catalogue JSON files into memory). Results are shows only. **There is no
episode search anywhere.** The playlist box is episode-level but only over
the 1,946 curated episodes. The show page has no search box.

**Stage 3b has never worked in production.** Verified against the live Vercel
project on 2026-09-04, four independent gaps:

1. **Module load crash.** The function imports `backend/src/feeds/conditionalGet`
   → `backend/src/config/env`, which needs `dotenv`, `zod` and (via the parser)
   `fast-xml-parser`. Vercel's install command is `npm install --prefix api`,
   and `api/package.json` lists only `pg`. Runtime log, every request:
   `Cannot find module 'dotenv'` → `FUNCTION_INVOCATION_FAILED` (500), even for
   a bogus show id. The build log shows the same modules unresolved as TS
   errors, non-fatal.
2. **No environment variables on the Vercel project at all** (`vercel env ls
   production`: none). After (1) is fixed the function returns 503 "episode
   store not configured" because `DATABASE_URL` is absent. Whether migration
   `0016` has ever been applied to the Supabase project is unknown.
3. **No CORS headers** on either function; `vercel.json` adds none. The shell's
   origin (`capacitor://localhost` on iOS, `https://localhost` on Android) and
   the Pages origin are refused by the browser.
4. **The client asks the wrong host.** `fetchShowEpisodes` uses a relative path
   through `pinnedUrl()`, which resolves inside the app bundle; the CSP's
   `connect-src` names only `'self'` and Supabase. PR #471 fixes this half and
   is held for review because widening `connect-src` is a documented privacy
   tripwire.

Other facts the plan leans on:

- The PodcastIndex dump was downloaded and measured on 2026-08-16
  (`docs/curation/catalogue-broadening.md`): 4,710,545 feeds in one SQLite
  table `podcasts`, 40 columns, **no episode table**, 1.8 GB compressed / 5.04
  GB unpacked, refreshed roughly weekly, keyless but **requires an identifying
  User-Agent** (a default agent gets 403 with a 179-byte body that is not a
  gzip). Node's built-in `node:sqlite` reads it with no dependency.
- ADR-0001 (feed polling) is accepted for its primitives — `conditionalGet.ts`,
  `politeness.ts`, `shows.polling_tier` — but "the polling scheduler itself is
  not yet built." §4 builds it.
- `DECISIONS.md` (2026-07): "Podcast Index demoted from required to optional …
  if its data is ever wanted, ingest their free full-DB dump (no API key)
  rather than holding credentials." This plan is that ingest.
- The nightly refresh (`tools/refresh/`) polls the 220 curated feeds itself
  (`scan.mjs`), resolves via iTunes, and an agent authors hooks/tags. It has
  failed every night since 2026-09-01: the digest publish step passes a
  base64 file body as a command-line argument and it has outgrown the
  kernel's per-argument limit (`/usr/bin/gh: Argument list too long`).
  `nightly-watch` stays green because the last *published* digest (08-31) has
  a PR. Issue #290's failure mode, in a new shape.
- The privacy policy (`docs/legal/privacy-policy.md` §2) says in bold:
  *"Nothing you type into the playlist box or the Shows search box is
  transmitted."* `test/legal-citations.test.js` pins `connect-src` to exactly
  two origins.

---

## 2. Target architecture

Three loops that never call each other, and one serving layer they all
write into.

```
 Joey's PI-derived DB ──export──▶ [Loop 1: show-list import, weekly]
                                        │  upsert shows (identity, feed_url, filters, dedupe)
                                        │  diff newest_item_pubdate → "changed this week" set
                                        ▼
                           ┌──────────────────────────────┐
                           │  Postgres (Supabase)         │
                           │  shows_catalog   (≈1M rows)  │◀── curated overlay (220 flags + editorial)
                           │  show_id_map     (slug↔PI)   │
                           │  show_episodes   (ingested)  │◀── [Loop 2a: on-open fetch, ≤1h stale]
                           │  show_feed_state (etag, …)   │◀── [Loop 2b: scheduled poll, watchlist tiers]
                           │  FTS indexes (shows, episodes)│
                           └──────────────┬───────────────┘
                                          │ read
        [Loop 3: curation, nightly] ◀─────┤   picks episodes → discover.json (unchanged consumer contract)
                                          │
                     Vercel functions: /api/shows/search, /api/shows/:id, /api/shows/:id/episodes,
                                       /api/episodes/search (+ Apple episode search fallback)
                                          │ CORS: shell + Pages origins
                                          ▼
                     Client: server search when online; bundled top list + local cache when offline;
                             show page = header + full episode list + in-page search box
```

**What "in 4a" means after this plan:** a show is in 4a when it is a row in
`shows_catalog` that passes D1's filters. Its page shows the podcaster's own
header data and its complete feed. Its episodes are searchable once ingested
(by an open or by the poller), and reachable through Apple's episode search
before that. Home, forays and playlists remain curated surfaces over the
curated overlay — being in 4a does not put a show on Home.

**Why not crawl everything.** 4.7M feeds is PodcastIndex's whole operation.
D6 and D9 together mean we ingest what people open, what curation watches,
and what the weekly dump diff says has changed among those — and lean on
Apple's index for the long tail. The dump's per-feed `newestItemPubdate` /
`lastUpdate` columns are the cheap change signal that makes a watchlist
poller efficient: we do not poll to discover that nothing happened.

---

## 3. Data contracts

### 3.1 Requirements on Joey's export (D3 — assume met, verify on arrival)

The app path consumes **only** these columns. Anything else Joey appends is
ignored by Loop 1 and must not be required for the import to succeed.

| Column (dump name) | Type | Required | Used for |
|---|---|---|---|
| `id` | integer | yes | show identity (`pi_id`) |
| `url` | text | yes | feed URL, join key, what Loop 2 fetches |
| `podcastGuid` | uuid text | no | secondary identity when a feed moves |
| `itunesId` | integer | no | Apple cross-reference (D2), Apple episode search (WP5), dedupe preference (D13) |
| `title` | text | yes | search, display |
| `itunesAuthor` / `itunesOwnerName` | text | no | search |
| `description` | text | no | search (secondary), show header fallback |
| `imageUrl` | text | no | artwork fallback when the feed has none |
| `language` | text | no | D1 language filter (open) |
| `dead` | 0/1 | yes | D1 filter |
| `episodeCount` | integer | yes | D1 filter |
| `lastUpdate`, `newestItemPubdate`, `oldestItemPubdate` | epoch | yes | D1 filter, Loop 1 change diff, WP4 tier seeding |
| `explicit` | 0/1 | no | badge |
| `category1..category10` | text | no | genre chips fallback; **not** our taxonomy |
| `host` | text | no | per-host politeness budget (WP4) |
| `newestEnclosureUrl`, `newestEnclosureDuration` | text/int | no | nothing — the newest item only; ignored |

Delivery requirements:

1. **Format:** SQLite (the dump's native form), or a CSV/Parquet with the
   columns above under their dump names. One file, one table.
2. **A stable, monotonically increasing `export_version`** (date or dump
   `Last-Modified`) so Loop 1 can be idempotent and diffable.
3. **Complete rows, not deltas.** Loop 1 computes the diff.
4. **Reachable by a GitHub Actions runner without credentials we do not hold**,
   or placed by Joey somewhere a runner can fetch with a repo secret we do
   hold (an object store URL with a token is fine). ~2 GB per drop is
   acceptable; the runner has ~14 GB scratch.
5. **Cadence:** weekly, matching the dump. Loop 1 tolerates a missed week.
6. If Joey's copy has **renamed or dropped** any required column, the import
   must fail closed and name the column — never guess.

Until D3 is settled, agents build Loop 1 against the public dump directly
(`https://public.podcastindex.org/podcastindex_feeds.db.tgz` with the
`ForayBot/…` User-Agent), which has the identical schema. Swapping the source
to Joey's export is a config change, not a code change.

### 3.2 Tables (new migrations, numbered after `0016`)

```sql
-- 0017_shows_catalog.sql
create table shows_catalog (
  pi_id              bigint primary key,
  podcast_guid       uuid,
  feed_url           text not null,
  feed_url_norm      text not null,            -- scheme/case/trailing-slash normalised; unique
  itunes_id          bigint,
  title              text not null,
  author             text,
  description        text,
  image_url          text,
  language           text,
  explicit           boolean,
  categories         text[] not null default '{}',
  host               text,
  episode_count      integer,
  newest_item_at     timestamptz,
  oldest_item_at     timestamptz,
  last_update_at     timestamptz,
  dead               boolean not null default false,
  in_4a              boolean not null,          -- D1 filter result, recomputed each import
  dedupe_group       bigint,                    -- D13: canonical pi_id for this show, self if canonical
  is_canonical       boolean not null default true,
  curated            boolean not null default false,   -- D8 overlay
  editorial_note     text,                            -- D8 overlay
  taxonomy_node_ids  text[] not null default '{}',    -- D8 overlay
  export_version     text not null,
  first_seen_at      timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  search_tsv         tsvector generated always as
                     (setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
                      setweight(to_tsvector('simple', coalesce(author,'')), 'B') ||
                      setweight(to_tsvector('simple', left(coalesce(description,''), 2000)), 'C')) stored
);
create unique index on shows_catalog (feed_url_norm);
create index on shows_catalog using gin (search_tsv);
create index on shows_catalog using gin (title gin_trgm_ops);   -- prefix/typo; needs pg_trgm (0001 enables extensions)
create index on shows_catalog (itunes_id) where itunes_id is not null;
create index on shows_catalog (in_4a, is_canonical);

-- 0018_show_id_map.sql — D2: slugs keep working
create table show_id_map (
  slug   text primary key,                 -- today's catalog.json show_id
  pi_id  bigint not null references shows_catalog(pi_id)
);

-- 0019_show_episodes_rekey.sql — catalog_show_episodes / catalog_show_feed_state
-- keyed by pi_id instead of slug text; adds search_tsv over title + description_text,
-- gin index; adds polling columns to feed_state: tier, next_poll_due_at, watch_reason text[].
```

Identity rule for agents: **`pi_id` everywhere server-side; the client may
still say `#/show/lex-fridman-podcast`** and the API resolves slugs through
`show_id_map`. New shows get numeric routes `#/show/pi:123456`. Never
generate new slugs.

### 3.3 API contracts (Vercel functions, all GET, all CORS-enabled for the
shell and Pages origins, all `Cache-Control: public, max-age=300,
stale-while-revalidate=3600` unless stated)

| Route | Returns | Notes |
|---|---|---|
| `/api/shows/search?q=&limit=` | `{ shows: ShowCard[], degraded }` | FTS + trgm over `shows_catalog where in_4a and is_canonical`; rank: exact title > prefix > FTS rank > trgm similarity; curated rows get a small boost. Replaces the in-memory JSON search. |
| `/api/shows/:id` | `ShowCard` + header fields | `:id` is `pi:<n>` or a slug. Header fields come from the **feed** when cached (title, description, image), else from `shows_catalog`. |
| `/api/shows/:id/episodes?cursor=&limit=` | `{ episodes, stale, error, next_cursor, total }` | Triggers Loop 2a if cache older than 1 h (D11). **Paginated**, newest first, default 100, so a 10,000-item feed does not ship in one response. |
| `/api/episodes/search?q=&limit=&show=` | `{ episodes: EpisodeCard[], source: "ingested" \| "apple" \| "mixed", degraded }` | FTS over ingested episodes first; if fewer than `limit` results and online, append Apple `entity=podcastEpisode` results not already present, mapped to `shows_catalog` via `itunes_id`. Apple calls are rate-limited server-side (≤ 20/min, shared budget) and cached 1 h. `show=` scopes to one show. |

`ShowCard` = `{ id: "pi:<n>", slug?, title, author, image_url, episode_count,
newest_item_at, curated, explicit }`. `EpisodeCard` = `{ show: ShowCard,
guid, title, published_at, duration_seconds, audio_url, description_text
(≤ 300 chars) }`. `audio_url` is always the podcaster's enclosure URL,
never ours (principle #3).

---

## 4. Episode freshness — the part the follow-up changed

Three sources of episode ingestion, in order of cost:

**Loop 2a — on open (D5, D11).** Unchanged from Stage 3b's intent: opening a
show page fetches the feed through `/api/shows/:id/episodes` if the cache is
older than one hour, using conditional GET. Serves the page. Does not help
curation for shows nobody opens — which is the gap Wyatt named.

**Loop 2b — scheduled poller over a watchlist (new).** A GitHub Actions cron
(`episode-poll.yml`, hourly) that calls a single Vercel function
`/api/internal/poll?budget=` protected by a shared secret, or runs the poll
directly in the runner with `DATABASE_URL` — agents choose the runner (fewer
moving parts, no function timeout). Each run:

1. Selects shows whose `next_poll_due_at <= now()` from `show_feed_state`,
   ordered by tier, capped by a per-run budget (start: 300 feeds/run) and a
   **per-host budget** from `politeness.ts` (Megaphone, Libsyn, Anchor and
   Simplecast host thousands of our feeds each; ADR-0001 corner case 8).
2. Fetches each with conditional GET; a 304 costs one request and reschedules.
3. Upserts episodes; updates tier from observed cadence (ADR-0001's deferred
   `polling_tier` assignment, seeded from the dump's `newestItemPubdate` /
   `oldestItemPubdate` / `episodeCount` on first sight).
4. Records failures; 5 consecutive failures → `backoff`; a 410 or 30 days of
   404 → `dead` (the dump will usually agree the following week).

Who is on the watchlist, and why (`watch_reason` is an array so a show can be
there for several reasons and drop off when none remain):

| `watch_reason` | Added by | Tier |
|---|---|---|
| `curated` | D8 overlay — the 220 today, whatever curation promotes later | daily or observed cadence, whichever is faster |
| `opened` | any show page open; expires 90 days after the last open | observed cadence |
| `starred` | a listener stars the show (already a client feature) | observed cadence |
| `changed_in_dump` | Loop 1's weekly diff: `newest_item_at` advanced since last export **and** the show is `in_4a` **and** has any other reason or is in the top-N by dump `popularityScore` | one poll, then drops unless another reason holds |
| `curation_candidate` | Loop 3 / Joey's triage: any show curation wants to see episodes from before promoting it | daily |

The `changed_in_dump` reason is what answers the follow-up cheaply: the
weekly dump tells us, for all 4.7M feeds, which ones published since last
week, without fetching a single feed. We then fetch only those we care
about. The top-N popularity slice (start: N = 5,000) gives curation a broad
stream of fresh episodes from shows nobody has opened yet — the "tons of
episodes for curation" Wyatt does not want to miss — at roughly 5,000 ×
(publish frequency) fetches a week, well inside a free-tier runner's budget.
N is a knob, not an architecture decision; raising it is a config change and
a spend question, and it is flagged as such in §6.

**Loop 2c — Apple episode search (D6).** Not ingestion; a read-through
fallback for `/api/episodes/search` when our index is thin. Results carry
Apple's enclosure URL, so they are playable without our having ingested the
feed. Opening the parent show then triggers Loop 2a and the show is fully in
4a from that moment — which is exactly the "if one episode is present, all
are" rule made mechanical.

What is deliberately not here: polling all `in_4a` shows on a schedule. At
~1M shows that is a crawler and a hosting bill; D6 ruled it out for now, and
the watchlist plus dump-diff gets most of the value.

---

## 5. Work packages

Conventions for the fleet: one PR per package unless stated, branch names
given, tests named, `STATE.md` entry per PR as the repo requires. **Owned
files** may be edited freely; **shared files** need a rebase discipline;
anything under `api/`, `.github/`, `index.html`, `docs/legal/` is a governed
path that waits for a human (`path-policy`). Every PR body carries the
measured before/after, not a description of intent.

### WP0 — Make Stage 3b work in production (unblocks everything)

*Rests on: §1's four gaps. Branch `fix/stage-3b-production`.*

1. **Dependencies.** Move the function's backend closure off `config/env`:
   `conditionalGet.ts` takes the User-Agent as a parameter (default exported
   from a dependency-free `backend/src/feeds/userAgent.ts`); `env.ts` is no
   longer in the import graph of anything under `api/`. Add
   `fast-xml-parser` to `api/package.json`. Add a test
   (`api/test/import-closure.test.mjs`) that walks the import graph of every
   file under `api/` and fails if any bare import is not in
   `api/package.json` or Node built-ins — this is the bug that shipped, so
   it gets a test that would have caught it.
2. **CORS.** A shared `api/_lib/cors.ts` that allows exactly:
   `capacitor://localhost`, `https://localhost`, `https://jwlabs.ai`,
   `https://jw-incorporated.github.io`, and the Vercel production alias.
   Handles `OPTIONS`. Test pins the list.
3. **Client origin + CSP.** Land the content of PR #471 (retarget to `main`
   after #472 merges): `API_ORIGIN`, `apiUrl()`, `connect-src` gains the API
   origin, `test/api-origin.test.js`. This is the privacy tripwire the legal
   doc names — **founder review required**, see §6.
4. **Environment.** Wyatt sets `DATABASE_URL` on the Vercel project (the
   Supabase **transaction pooler** URL, port 6543, so a serverless function
   per request does not exhaust connections). HUMAN-ACTIONS item (§6). The
   function keeps its honest 503 until then.
5. **Migrations.** Confirm `0016` is applied (`schema_migrations` table);
   apply if not. HUMAN-ACTIONS item — needs the service-role URL.
6. **Acceptance:** from a headless browser with origin `capacitor://localhost`,
   `GET /api/shows/lex-fridman-podcast/episodes` returns 200 with > 100
   episodes and an ACAO header; a bogus id returns 404 not 500; a TestFlight
   build shows the full Lex Fridman list. Before/after in the PR body.

### WP1 — Loop 1: show-list import

*Rests on: D1, D2, D3, D13. Branch `feat/shows-import`. Owned:
`tools/shows/import-dump.mjs`, `tools/shows/*.test.mjs`,
`.github/workflows/shows-import.yml`, migrations `0017`, `0018`.*

1. Fetch the export (§3.1; the public dump until D3 lands), with the
   identifying User-Agent, checksum, and `export_version` from
   `Last-Modified`. Skip if the version is already imported.
2. Read with `node:sqlite`. Stream rows; never load 4.7M into memory.
3. Compute `in_4a` per D1: `dead = 0 and episodeCount >= 3 and
   newestItemPubdate >= now - 24 months`. Language: **no filter until D1's
   open half is decided**; store the column so the filter is a one-line
   change. Report the counts per filter in the job summary so the D1
   re-confirmation has numbers.
4. Dedupe per D13: group by `podcastGuid` when present, else by normalised
   title + author; canonical = the member whose `itunes_id` is set, else the
   most recent `last_update_at`. Non-canonical rows stay in the table with
   `is_canonical = false` so a feed URL someone has still resolves.
5. Upsert into `shows_catalog` in batches of 5,000 via `COPY` into a staging
   table, then `insert … on conflict do update`. Emit the **change set**:
   rows whose `newest_item_at` advanced → `watch_reason += changed_in_dump`
   (WP4 consumes this).
6. Build `show_id_map` from `data/catalog.json` (`show_id` → `feed_url` →
   `pi_id` by `feed_url_norm`, falling back to `apple_collection_id` →
   `itunes_id`). Every one of the 220 must map; the import fails closed
   naming any that do not. Curated overlay columns (`curated`,
   `editorial_note`, `taxonomy_node_ids`) are written from `catalog.json`
   in the same step — **`catalog.json` remains the source of truth for the
   overlay** until curation has its own editing surface.
7. Workflow: weekly cron (Sunday 06:00 UTC, after the dump's typical
   refresh), `workflow_dispatch` for manual runs, `DATABASE_URL` from a repo
   secret (`SHOWS_DATABASE_URL`, service role — see §6). Job summary states
   rows read / in_4a / canonical / changed / mapped.
8. **Acceptance:** two consecutive runs on the same export are a no-op
   (idempotent); a run on the next export produces a non-empty change set;
   `select count(*) from shows_catalog where in_4a` is reported; all 220
   curated slugs resolve; the import runs inside a standard runner's disk
   and under 40 minutes. Sizing note for §6: at ~1 KB/row the full table is
   ~5 GB; if filtering to `in_4a` first is needed to fit the Supabase tier,
   store only `in_4a` rows plus every row referenced by `show_id_map`.

### WP2 — Server-side show search + client wiring + offline rule

*Rests on: D4, D9. Branch `feat/show-search-server`. Owned:
`api/shows/search.ts` (rewrite), `api/shows/[id].ts` (new),
`backend/src/catalog/searchShows.ts`, `test/show-search*.test.js`.
Shared: `app.js` (`renderShowSearchResults`, `showById`,
`fetchApiJson`), `search-engine.js`.*

1. `/api/shows/search` moves from the in-memory JSON to Postgres FTS +
   trgm per §3.3. Keep the response shape the client already reads so #470's
   live-search work keeps working. Delete `backend/src/catalog/breadthCatalog.ts`
   and `searchBreadthShows.ts` once nothing imports them.
2. `/api/shows/:id` for shows the client has no local record of (a
   `pi:` id reached from a search result or a deep link). `showById`
   becomes async-capable: local catalog → in-memory cache → API.
3. **Online:** local pass over the bundled list stays instant; the server
   pass replaces the breadth pass, same debounce (#470). **Offline** (D9):
   the server pass is skipped and the results header says *"Showing shows
   available offline"*; no request is attempted. Detection: `navigator.onLine`
   plus a failed-fetch fallback.
4. The local list grows from "the 220" to a **bundled top list** — the
   curated 220 plus the top 2,000 `in_4a` shows by dump popularity, as
   `data/shows-bundled.json` generated by `tools/build-catalog-client.mjs`
   from the DB (or from the dump when the DB is not reachable in CI).
   Measured size budget: ≤ 250 KB minified; the mobile bundle test
   (`tools/mobile/prepare-webdir`) gets the new file.
5. **Privacy:** `docs/legal/privacy-policy.md` §2's bold sentence is
   rewritten to state that Shows search and episode search send the typed
   query to our API and are not logged as events; `data-safety.md`'s CSP
   sentence and `test/legal-citations.test.js`'s origin count are updated.
   This is the founder edit (D4). WP7 makes forgetting it impossible.
6. **Acceptance:** `q=lex` returns Lex Fridman first from a table of ≥ 500k
   rows in < 150 ms server time (measured, reported); a `pi:` result opens a
   show page; airplane mode yields local results and the offline header, zero
   requests (measured in headless Chrome with network blocked).

### WP3 — Show page: header from the feed, full paginated list, in-page search

*Rests on: D5, D7, D11. Branch `feat/show-page-full`. Owned: migration
`0019`, `test/show-page*.test.js`, `test/show-page-search.test.js`. Shared:
`app.js` (`renderShow`, `fetchShowEpisodes`), `api/shows/[id]/episodes.ts`,
`backend/src/catalog/ingestShowFeed.ts`, `showEpisodesStore.ts`.*

1. Rekey the episode store by `pi_id` (`0019`), preserving existing rows
   through `show_id_map`. Add `search_tsv` on episodes.
2. Header fields (title, description, artwork) come from the fetched feed
   when present, with `shows_catalog` as fallback — "loaded from the
   podcaster," as asked. Count label states the real total.
3. Pagination: the API returns 100 per page with a cursor; the page renders
   the first 100 and a *"Show more"* control; the in-page search box searches
   **the full list**, so when a search is typed with more pages unfetched,
   the client asks `/api/episodes/search?show=<id>&q=` instead of filtering
   the partial list. Never claim completeness over a partial list.
4. Feed size guard: `ingestShowFeed` already caps download size (M1, #396);
   confirm the cap fits the largest feeds in the curated 220 and report the
   three largest. Feeds over the cap degrade to "the newest N episodes" with
   the count label saying so.
5. Staleness: revalidate when `last_fetched_at` older than 1 h (D11); render
   cached rows immediately and patch in the delta when the fetch lands.
6. **Acceptance:** Lex Fridman (feed ~500 items) and a 5,000+ item daily show
   both render in under 2 s to first list on a throttled connection; the
   in-page box finds an episode on page 12 without the user scrolling there;
   `test/show-page-search.test.js` pins the "never filter a partial list"
   rule.

### WP4 — Loop 2b: scheduled episode poller (the follow-up)

*Rests on: §4, ADR-0001. Branch `feat/episode-poller`. Owned:
`tools/poll/poll-episodes.mjs`, `tools/poll/tiers.mjs`, tests,
`.github/workflows/episode-poll.yml`. Shared: `backend/src/feeds/politeness.ts`
(read), `show_feed_state` (via `0019`).*

1. Watchlist maintenance: `watch_reason` writes from — the import (WP1,
   `changed_in_dump`, top-N popularity), the episodes endpoint (WP3,
   `opened` with a 90-day expiry), the client's star action (via a tiny
   `/api/shows/:id/watch` POST — or derived from Supabase `saved_items` if
   stars already sync), curation (WP6). A nightly sweep expires reasons and
   removes rows with none.
2. Tier assignment per ADR-0001, seeded from the dump: `episode_count /
   months active` → hourly / several-daily / daily / weekly; corrected from
   observed publish intervals after 3 polls.
3. The run: select due shows ordered by tier, cap per run and per host,
   conditional GET, upsert, reschedule; write a run summary (feeds polled,
   304s, new episodes, failures by host). Hourly cron; 15-minute job
   timeout; `concurrency` group so runs never overlap.
4. Politeness is non-negotiable: identifying User-Agent, conditional GET
   always, ≥ 1 request/s per host, honour `Retry-After`, exponential backoff
   on 429/5xx, never fetch enclosures (metadata only — principle #3).
5. **Acceptance:** with N = 5,000 and the curated 220 on the watchlist, one
   week of runs stays under 40,000 feed requests (reported from summaries);
   a curated show's new episode appears in `show_episodes` within one tier
   interval of publish (measured against three real releases); no host
   receives more than its budget (asserted in tests with a fake clock).

### WP5 — Episode search: ingested index + Apple fallback

*Rests on: D6. Branch `feat/episode-search`. Owned:
`api/episodes/search.ts`, `backend/src/catalog/searchEpisodes.ts`,
`backend/src/catalog/appleEpisodeSearch.ts`, tests. Shared: `app.js`
(`renderShowSearchResults` gains an episodes section), `styles.css`.*

1. FTS over `show_episodes.search_tsv` joined to `shows_catalog` for the
   card; rank by FTS rank then recency.
2. Apple fallback: `itunes.apple.com/search?term=&entity=podcastEpisode&limit=`,
   keyless; server-side token bucket ≤ 20/min; results cached 1 h by query;
   mapped to `shows_catalog` by `collectionId = itunes_id`; unmapped results
   are dropped, not shown as orphans. `source` field tells the client what
   it is looking at.
3. Client: the Shows search results get an **Episodes** section under the
   shows, rendered with the existing `epRow` so episodes play in-app and
   link to their show; the section says *"from Apple's index"* when
   `source` includes `apple`. Offline (D9): episodes from the local cache
   only.
4. Opening a show from an Apple-sourced episode triggers WP3's fetch — the
   "one episode present → all present" rule.
5. **Acceptance:** a query naming an episode from a curated show returns it
   from the ingested index; a query naming an episode from an un-ingested
   show returns it via Apple within 1.5 s; the Apple bucket never exceeds 20
   calls/min under a synthetic burst (test with fake clock).

### WP6 — Decouple curation from feed polling; fix the nightly

*Rests on: D12. Branch `feat/curation-decoupled`. Owned: `tools/refresh/*`,
`.github/workflows/nightly-refresh.yml`, `nightly-watch.yml`.*

1. **Immediate fix, its own small PR first:** the digest publish step sends
   the file body via `--input` (a JSON file) instead of `-f content=$(base64
   …)` so it stops hitting the argument-length limit. `nightly-watch` gains
   a second check: a `nightly-refresh` run that failed today is red
   regardless of the digest's PR state.
2. `scan.mjs` stops polling feeds. It reads new episodes for curated shows
   from `show_episodes` (via `DATABASE_URL`, service role, in the runner)
   since the last `refresh-state` cursor. `resolve.mjs`'s iTunes lookup
   stays (it resolves `apple_track_id`, which the discover pool needs).
3. Curation candidates: the agent half may also read `show_episodes` for
   shows with `watch_reason` containing `changed_in_dump` or
   `curation_candidate`, which is where "episodes for curation" from
   never-opened shows arrive. Promotion to curated writes the overlay in
   `catalog.json` (WP1 step 6 syncs it to the DB on the next import; add a
   `tools/shows/sync-overlay.mjs` for an immediate push).
4. **Acceptance:** a night runs green with zero feed requests from the
   refresh job (asserted from the run log); the digest publishes at the
   current size and at 10× the current size (test the publish step with a
   synthetic 2 MB file); `nightly-watch` goes red on a night where the
   refresh job failed.

### WP7 — Mobile shell, CSP, and the "Wyatt will forget" tripwire

*Rests on: D4, D9, D10. Branch `feat/shell-search-online`. Owned:
`tools/mobile/*`, `test/release-gates.test.js`. Shared: `index.html`
(CSP, governed), `sw.js`, `.github/workflows/ios-build.yml`,
`android-release.yml`.*

1. The mobile bundle carries `data/shows-bundled.json` and the cached
   episode store is IndexedDB (the event log already moved there, M3 #403);
   D9's offline search reads both.
2. CSP `connect-src` carries the API origin (from WP0) and nothing wider;
   `test/legal-citations.test.js` pins three origins.
3. **The tripwire (D4):** `test/release-gates.test.js` fails when *all* of
   the following are true: `app.js` routes any search through `API_ORIGIN`,
   **and** `docs/legal/privacy-policy.md` still contains the sentence
   *"Nothing you type into the playlist box or the Shows search box is
   transmitted"*. The test runs in `ci.yml` (so a PR that wires the search
   without the policy edit is red) **and** as a dedicated step at the top of
   `ios-build.yml` and `android-release.yml`, so a release build cannot even
   start with the stale policy. Add a HUMAN-ACTIONS item that says exactly
   which sentence to change and links the test. Belt, braces, and a note on
   the door.
4. **Acceptance:** the release workflows fail fast on a branch with the old
   sentence and pass once it is edited; a TestFlight build searches shows and
   episodes online and degrades to the offline header in airplane mode.

### WP8 — Decision records and doc reconciliation

*Branch `docs/shows-pipeline-records`. One PR, after WP1 and WP4 merge.*

- `docs/DECISIONS.md`: record D1–D13 with the date and this file.
- `docs/curation/catalogue-broadening.md` §2: add a dated note that the
  "research tool, not ingest path" verdict is superseded for the **show
  list** (weekly import, not nightly), and stands for **episodes** (the dump
  has none — Loop 2 does that).
- `docs/CATALOG-PIPELINE.md`: the two-tier table becomes the overlay model;
  `catalog-breadth*.json` marked retired once WP2 lands.
- `docs/adr/0001-feed-polling-strategy.md`: Status → the scheduler exists
  (WP4), with the tier-seeding rule.
- `docs/show-pages-plan.md`, `docs/catalog-growth-plan.md`: header banners
  pointing here.
- `HUMAN-ACTIONS.md`: items in §6 added; #35 and #36 (already done) closed.

---

## 6. Founder gates and HUMAN-ACTIONS items (nothing here is an agent's call)

| # | Who | What | Blocks |
|---|---|---|---|
| G1 | Wyatt | Set `DATABASE_URL` (Supabase transaction-pooler URL) on Vercel project `foray-web`, production + preview | WP0 step 4 |
| G2 | Wyatt | Confirm/apply migration `0016` on the Supabase project; later `0017–0019` | WP0, WP1, WP3 |
| G3 | Wyatt | Add repo secret `SHOWS_DATABASE_URL` (service role) for the import and poller workflows. This is the first DB credential in Actions; the keyless posture applies to *content* automation, and this is infra — say so in `CLAUDE.md` | WP1, WP4, WP6 |
| G4 | Wyatt | Review and merge the `connect-src` widening (PR #471's content, in WP0) — the documented privacy tripwire | WP0 step 3 |
| G5 | Wyatt | Edit privacy policy §2 (WP2 step 5). WP7's test will not let a release build start until this is done | WP2, WP7 |
| G6 | Wyatt + Joey | D1 re-confirmation with WP1's first job summary in hand: filters, and **the language decision** | WP1 step 3 |
| G7 | Joey | D3: export format, location, cadence (§3.1) | WP1 source swap |
| G8 | Wyatt | Supabase tier: a ~1M-row `shows_catalog` plus episode store exceeds the free tier's 500 MB. Decide Pro (8 GB) or store `in_4a` rows only | WP1 step 8 |
| G9 | Wyatt | Watchlist top-N (start 5,000) and the weekly request budget — a spend and politeness knob | WP4 |
| G10 | Joey | Whether his appended metadata replaces or joins `breadth-classification.json` — not blocking | later |

---

## 7. Sequencing for the fleet

```
WP0 ──┬── WP2 ──┬── WP5
      │         └── WP7
      ├── WP1 ──┬── WP4 ── WP6(steps 2-4)
      │         └── WP3
      └── WP6(step 1, the nightly fix — independent, do first)
                              WP8 last
```

Parallel from day one: WP0, WP1, WP6 step 1. WP2 and WP3 start when WP0 has
a working endpoint in production. WP4 needs WP1's tables. WP5 needs WP2's
search plumbing and WP3's episode index. WP7 can start its tripwire test
immediately and finish after WP2. Gates G1–G3 are on the critical path and
should be done before the fleet starts.

Agents should read, in this order, before touching anything: `CLAUDE.md`,
this file, `docs/show-pages-plan.md`, `docs/adr/0001-feed-polling-strategy.md`,
`docs/adr/0002-episode-identity-and-dedup.md`,
`docs/curation/catalogue-broadening.md` §1–2, `backend/README.md`
§Migrations.

---

## 8. Non-goals (so nobody builds them by accident)

- Crawling all `in_4a` feeds on a schedule. D6 says no; §4 explains the
  substitute.
- Rehosting, proxying, transcoding or caching audio. Metadata only, always.
- Replacing the curation pipeline's editorial output (`discover.json`,
  hooks, tags). Loop 3 keeps its consumer contract; only its *input* changes.
- Using Joey's appended metadata columns anywhere in the app path (D8).
- A PodcastIndex API key. The dump is keyless; Apple search is keyless; that
  is the whole surface.
- Renaming today's `show_id` slugs. They map (D2).
