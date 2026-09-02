# Plan: show search, browse, and per-show pages

*2026-08-31. Requested by Joey during live iPhone web testing: Foray is
episode-first everywhere (topic queues, playlists) and has no "channel"/show
concept in the UI, even though `show` is a field on every episode and there is
already a real show-level dataset (`data/catalog.json`, 220 shows) sitting
unused by the client. Planning only — no implementation in this change. See
kanban card for full ask.*

## 1. Data model

**Verdict: derive from what the repo already has for Stage 1–2; the harder
question is Stage 3, and it is a founder call (§4).**

Three relevant sources already exist and were inspected before writing this:

| Source | Shape | Coverage | Client fetches it today? |
|---|---|---|---|
| `data/discover.json` | 1,855 curated episodes, `show` field on each | 221 distinct show names | Yes — this is the live discover pool |
| `data/catalog.json` | 220 show-level records (`show_id`, `title`, `apple_collection_id`, `feed_url`, `artwork_url`, `editorial_note`, `taxonomy_node_ids`, `episode_count`, `cadence_hint`) | 220/221 discover-pool shows (`Lingthusiasm` is the one gap); every entry Apple-verified, no invented ids | **No** — built for the backend curation engine (`docs/CATALOG-PIPELINE.md`), never fetched by `app.js` |
| `data/catalog-breadth.json` (+ `catalog-breadth-intl.json.gz`) | ~10k show-level records, genre/chart-rank only, **no editorial note, no artwork guaranteed** | Breadth tier, explicitly reserved for "backend seed data, future show-level search" per `CATALOG-PIPELINE.md` | No, and `CATALOG-PIPELINE.md` §5 says it deliberately never should (~3MB, would blow the client bundle) |

So a show-level dataset already exists and is already good enough for a real
page: artwork (167/220), an editorial note (220/220), a feed URL (220/220,
useful later), and taxonomy tags. The only gap is `episode_count` (167/220) and
that it was never wired to the client. **Nothing new needs to be harvested to
ship Stages 1–2.**

The `show` string on an episode record and `catalog.json`'s `title` are not
guaranteed identical keys forever (they match today for 220/221 pool shows,
verified above) — Stage 1 should join on `show_id` derived from
`catalog.json`, with a `title`-string fallback match against the discover
pool for the one show catalog.json doesn't carry yet, rather than assuming
string equality is a permanent invariant. This is a few lines of client-side
lookup logic, not a data change.

**Episode completeness is the real limit, not show metadata.** A show page
built from `discover.json` shows only the episodes 4a's curation pipeline
hand-picked for that show (median 7, max 45, min 1 — nowhere near "all known
episodes" for an active daily/weekly show). That gap is Stage 3, see below.

## 2. Staged breakdown

### Stage 1 — `#/show/:id` page over data already in the client

- New route `#/show/:show_id` (pattern matches the existing `#/foray/:id`,
  `#/playlist/:id` routes in `app.js`'s `route()`).
- Client fetches `data/catalog.json` at `init()` alongside the other
  `fetchJson` calls already there (one more parallel fetch, ~small file —
  measure actual gzip size before shipping; if it's non-trivial, ship a
  slimmed `catalog-client.json` derived at build/publish time rather than
  shipping `feed_url`/`cadence_hint`/provenance fields the client never
  reads).
- `renderShow(show_id)`: header (artwork, title, editorial note, show's
  taxonomy chips), then every episode from `discover.json` whose `show`
  matches, rendered with the existing `epRow`/`archivedRow` components (no new
  row UI — reuse what PR #357 just fixed).
- No new ingestion, no new search mode, no navigation wiring from other pages
  yet (Stage 4) — this stage is provably standalone and testable by hand-typing
  `#/show/lex-fridman-podcast`.

**Acceptance criteria:**
- Visiting `#/show/<valid show_id>` renders artwork, title, editorial note,
  and every discover-pool episode for that show, each playable exactly as it
  is today from a playlist row.
- Visiting `#/show/<unknown id>` renders a "not found" state, not a crash
  (mirrors the existing `renderPlaylistDetail`'s "Playlist not found" guard).
- `node --test "test/*.test.js"` and `node app.js` syntax check both pass;
  a new suite covers the route match and the not-found case per CLAUDE.md
  workflow rule 3.

### Stage 2 — show search (name/host matching)

- A new, separate search mode in `search-engine.js` — NOT a change to the
  existing topic-relevance scorer. Match against `catalog.json`'s `title`
  (and, once available, a `host` field if one gets added — none exists
  today, see §4) rather than episode topics/hooks.
- Surfaced as a distinct affordance (e.g. a "Shows" tab/toggle next to
  today's topic search box), not merged into the same result list — the two
  searches answer different questions ("what should I listen to" vs "does
  this show exist here") and conflating them was flagged as a scope risk in
  the original card.
- Each result links to `#/show/:id` (Stage 1's page).

**Acceptance criteria:**
- Typing a known show's name (exact or partial, case-insensitive) surfaces
  it within the shows search mode.
- `tools/test-search.mjs`-style regression battery gets a new fixture set for
  show search, per CLAUDE.md's "a green test is not evidence" section —
  name the one-line mutation that breaks each new assertion.

### Stage 3 — full episode list per show

**Decided 2026-09-02 (kanban card t_567b570f, `docs/DECISIONS.md`): 3b.**
Full per-show RSS ingestion shipped — `backend/src/catalog/`,
`backend/migrations/0016_catalog_show_episodes.sql`,
`api/shows/[show_id]/episodes.ts`. The two-path framing below is kept for
the historical record of what was weighed; 3a is no longer the live path.

This is where the founder decision in §4 gates the approach. Two paths:

- **3a (derive-only, no new infra):** accept that "all known episodes" means
  "all episodes 4a's discover/session pool has ever carried for this show,"
  union of `discover.json` + any per-user history already in
  `cp_saved`/`cp_history`. Ships with zero new ingestion, zero new legal
  surface, but under-delivers "browse a show's full catalogue" for anything
  but the ~7-episode median already curated.
- **3b (new ingestion):** fetch/cache each show's own RSS feed
  (`catalog.json.feed_url` already captured for 220/220 shows) to list every
  published episode, playable via the original enclosure URL exactly like
  today's episodes (satisfies product principle #3 — never rehost/transform,
  always the original enclosure). This is new infra: a fetch+cache step
  (client-side on-demand, or a `tools/refresh/`-style nightly job seeding a
  new `data/show-episodes/` cache), a new legally-boring question (is
  per-show, on-demand RSS fetch from a client "our" traffic pattern or does
  it want the same politeness/caching discipline as `tools/harvest-catalog.mjs`?),
  and a new failure mode (dead/moved feeds — `catalog.json`'s own `feed_url`
  was hand-verified once at harvest time, not continuously).

**Acceptance criteria (whichever path is chosen):**
- A show page shows a count of episodes that matches what was promised to the
  user in-page (no silent truncation implying completeness that isn't there).
- 3b only: a feed fetch failure degrades to the 3a view plus a stated reason,
  never a blank page or an infinite spinner.

### Stage 4 — navigation wiring from every existing card/row

- `mini-card` (topic subject queues), `epRow`, `archivedRow`, playlist rows:
  decide per-surface whether a show-name tap goes to `#/show/:id` (in-app) or
  stays an external Apple Podcasts link. Recommendation: the **show name/byline
  text** becomes an in-app link to the show page; the existing **Play/Open**
  button keeps its current behavior unchanged (in-app playback or external
  link-out, exactly as today) — this adds a destination without touching the
  playback logic PR #357 just stabilized.
- Both `epRow` and `archivedRow` need the change; `archivedRow`'s "not in
  4a's catalogue right now" episodes should still link their **show** name to
  the show page even when the specific episode is gone.

**Acceptance criteria:**
- Every row type that names a show links to that show's page.
- No change to existing play/open button behavior (regression risk called
  out explicitly because PR #357 just touched these same rows).

## 3. Files touched (all stages)

- `data/catalog.json` — read by the client for the first time (Stage 1); if
  size becomes an issue, a build step producing a trimmed client copy is a
  Stage 1 implementation detail, not a plan blocker.
- `app.js` — `init()` fetch list, `route()`, new `renderShow()`, edits to
  `epRow`/`archivedRow`/`mini-card`/playlist-row show-name markup (Stage 4).
- `search-engine.js` — new show-search mode (Stage 2), additive, existing
  topic scorer untouched.
- `styles.css` — new show-page layout.
- `test/*.test.js` — new route/render/search-mode coverage per stage.
- `tools/refresh/` — only touched if Stage 3 picks path 3b.
- `docs/DECISIONS.md` — an entry recording the Stage 3 data-source choice
  once made (§4), because it is expensive to reverse per workflow rule 4.

## 4. Needs a founder product decision — flagging per CLAUDE.md, not guessing

**Stage 3's data source: stay derive-only (3a) or add per-show RSS
ingestion (3b)?**

- 3a costs nothing new (no infra, no new legal surface, ships fast) but the
  show page under-delivers "browse ALL episodes" for anything beyond the
  curated 7-episode median — it's really "browse the episodes 4a already
  hand-picked from this show," which is not what "a one-stop shop... similar
  to Apple Podcasts" implies.
- 3b is the only path that actually delivers "all known episodes" and reuses
  infrastructure this repo already has taste for (`tools/refresh/`'s nightly
  pipeline pattern, `catalog.json`'s already-verified `feed_url`), but it is
  new fetch/cache infra and a new instance of the "legally boring" question
  (product principle #3) even though it stays within "download via original
  enclosure URLs, never rehost" — it should get the same one-line gut check
  Wyatt/Joey have given other infra additions before it's built, not assumed.

Recommend 3a for a real Stage 3 ship, with 3b explicitly named as a fast
follow if the founders want true full-catalogue browsing — this keeps stages
independently shippable and defers the only genuinely new infra decision to
its own small, reviewable PR instead of blocking Stages 1/2/4 on it.

## 5. What this plan does NOT include

- No implementation. Once approved, Stage 1 becomes its own child card
  (created separately, per the parent card's instruction) so implementation
  and review happen in tracked, reviewable steps rather than one large PR.
- No decision made on Stage 3's data source — that's the one open question
  above, and it only blocks Stage 3, not Stages 1/2/4.
