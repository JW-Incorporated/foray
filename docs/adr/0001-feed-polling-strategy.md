# ADR 0001: Feed Polling Strategy

## Status
Accepted (scheduler not yet built; this ADR governs the primitives already
implemented: `backend/src/feeds/conditionalGet.ts`,
`backend/src/feeds/politeness.ts`, `shows.polling_tier` /
`shows.next_poll_due_at`).

**Updated 2026-10-05 (S-10, `docs/roadmap/shows-search.md` PKG-05..PKG-10).**
The scheduler is still not built, and nothing polls a feed on a schedule. Its
pure parts have merged under `tools/poll/`, built as a no-DB dry-run first:
- `tiers.mjs` (PKG-05, #998): the cadence tiering this ADR deferred below.
  A tier is seeded from the dump's pubdates and watch reasons, corrected from
  the median gap between observed publish times once there are at least four,
  and moved by success and failure (five failures → `backoff`; 410, or a 404
  for 30 days → dead).
- `politeness.mjs` and `select-due.mjs` (PKG-06, #1017): a pinned JS port of
  `PolitenessBudget`'s per-host rules from `backend/src/feeds/politeness.ts`
  (unchanged), and the due-set selection and weekly request projection that
  gate G9 is judged against.
- `watchlist.mjs` (PKG-07, #1054): the watchlist (every curated show, plus
  the top-N non-curated shows the weekly change index says just published).
  No seed file is committed yet.
- `poll-episodes.mjs` (PKG-08, #1062): the `--dry-run` CLI, which puts the
  watchlist, the due set and the G9 projection together; it fetches nothing.

Still to come: a daily dry-run workflow (PKG-09), then the live path
(PKG-10). The live path adds migration `0020_watchlist.sql`, sends real
conditional GETs through `fetchFeedConditional`, and waits on gates G1 and G3
(see `docs/DECISIONS.md`'s 2026-10-05 S-12 entry). Move this status to
"scheduler live" only when PKG-10 runs in production.

## Context
01_PROMPT.md item 1 asks for a polite conditional-GET polling cadence that's
release-pattern aware (daily shows vs weekly), with ETag/Last-Modified
handling, backoff on 429/5xx, and a WebSub option. Corner case 8 requires
per-host (not per-feed) request budgets, since one host (Libsyn, Megaphone,
Buzzsprout) commonly serves dozens of independently-subscribed shows.
New-episode latency (how fast we notice a drop) trades directly against
politeness (how often we hit a publisher's server for nothing).

## Options considered
1. **Fixed interval per feed** (e.g. poll every 30 min, always). Simple, but
   wastes requests on weekly shows and is still too slow for daily-drop
   shows that publish at a predictable time of day.
2. **WebSub (PubSubHubbub) where offered, poll fallback elsewhere.** Best
   theoretical latency/politeness tradeoff, but WebSub support among
   podcast hosts is inconsistent and adds a callback-receiver component
   (public HTTPS endpoint, hub subscription renewal) this phase doesn't
   need yet.
3. **Cadence-derived polling tier + always-conditional-GET + per-host
   budget.** Observe each show's actual release cadence, bucket it into a
   tier (`hourly` / `several_daily` / `daily` / `weekly` / `backoff`), poll
   at that tier's frequency, and always send `If-None-Match` /
   `If-Modified-Since` so a same-content poll costs the publisher a 304 and
   costs us nothing to parse.

## Decision
Option 3, with WebSub flagged as a future upgrade (not this phase — the
`shows` table's `polling_tier` column reserves room for a `websub` tier
later without a schema change). Implemented pieces:
- `backend/src/feeds/conditionalGet.ts`: `fetchFeedConditional()` always attaches
  prior ETag/Last-Modified, returns `notModified: true` on 304 with no body
  fetched.
- `backend/src/feeds/politeness.ts`: `PolitenessBudget` is keyed by **hostname**,
  not feed URL — `msUntilAllowed(host)` enforces a minimum interval between
  *any* two requests to the same host regardless of which show triggered
  them. `recordFailure` applies exponential backoff (base × 2^failures,
  capped) per host; `recordSuccess` resets it.
- `shows.consecutive_failures`, `shows.next_poll_due_at`,
  `shows.last_polled_at` (migration 0002) give the not-yet-built scheduler
  the state it needs to decide "is this show due."
- `hostSuggestsDai()` seeds `shows.dai_suspected` from a known-host list
  (Megaphone, Acast, Art19) as a day-one heuristic, refined later by actual
  duration-variance-across-fetches once ingest is live (see corner case 2).

Cadence tiering itself (turning "this show published weekly for the last 8
episodes" into a `polling_tier` value) is a small statistics job on top of
`episodes.published_at`, deliberately deferred until there's a populated
`episodes` table to compute it from — no fixture-testable logic to write
yet, so it's not implemented in this pass. (It has since been written,
without waiting for that table, as `tools/poll/tiers.mjs`: see the
2026-10-05 update under Status.)

## Consequences
- Every poll, hit or miss, goes through one code path
  (`fetchFeedConditional`) that's honest about cost — a scheduler built on
  top of it can't accidentally skip conditional headers.
- The per-host budget means a burst of "10 shows on Libsyn all became due
  simultaneously" naturally serializes against Libsyn specifically, not
  against unrelated hosts, and back-pressures correctly under corner
  case 8's rate-limit scenario.
- Real WebSub support is out of scope until a host we actually use offers
  it and the callback-receiver work is worth the latency win.
