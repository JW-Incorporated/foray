# ADR 0001: Feed Polling Strategy

## Status
Accepted (initial version — polling scheduler itself not yet built; this ADR
governs the primitives already implemented: `src/feeds/conditionalGet.ts`,
`src/feeds/politeness.ts`, `shows.polling_tier` / `shows.next_poll_due_at`).

**Updated 2026-09-21 (S-10, `4a-shows-pipeline-plan.md`).** The scheduler
this ADR called "not yet built" now exists: `tools/poll/poll-episodes.mjs`
+ `tools/poll/tiers.mjs`, built and unit-tested (68 tests), against a
`watchlist` table (migration `0020_watchlist.sql`) keyed on `pi_id`. It
consumes exactly the primitives this ADR specifies — `conditionalGet.ts`
for the always-conditional-GET rule, `politeness.ts`'s per-host budget for
the "don't hammer one host" rule — with no change to either. Cadence
tiering, the piece this ADR explicitly deferred ("a small statistics job
... deliberately deferred until there's a populated `episodes` table"),
is now implemented as `tools/poll/tiers.mjs`'s cadence-based correction:
seed a tier from `watch_reason` (curated/starred/changed/top-popularity/
curation-candidate/opened — see the plan's §4 table), then correct it
from the median gap between a show's observed published episodes once
there are enough of them, with a separate failure-based backoff
correction layered on top. **Still not live**: the scheduler runs in
dry-run only (no `DATABASE_URL`/`SHOWS_DATABASE_URL` in production, same
D14 no-DB-first rule as the rest of the shows deck — see
`docs/DECISIONS.md`'s 2026-09-21 S-12 entry) and has not yet opened a PR.
Once it does and the DB gates clear (HUMAN-ACTIONS #108–#110), this ADR's
status line should move from "scheduler itself not yet built" to
"scheduler live" — not done here, since the scheduler isn't live yet.

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
- `src/feeds/conditionalGet.ts`: `fetchFeedConditional()` always attaches
  prior ETag/Last-Modified, returns `notModified: true` on 304 with no body
  fetched.
- `src/feeds/politeness.ts`: `PolitenessBudget` is keyed by **hostname**,
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
yet, so it's not implemented in this pass.

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
