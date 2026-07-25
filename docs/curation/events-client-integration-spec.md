# Client integration spec — first-party event capture (Step C)

This is a **specification for the client wave**, not an implementation. It tells
whoever instruments `app.js` exactly what to emit and how it maps onto the
existing `cp_events` localStorage buffer (`DECISIONS.md` 2026-07-08: "syncs to
the backend `events` table once it exists" — it now does). This document does
not touch `app.js`; the backend/contract slice that produced it is scoped to
`backend/` + `docs/` only.

The contract this spec targets: `backend/src/types/events.ts`. The `events`
table shape: `backend/migrations/0009_events.sql`. The learning job that
consumes what the client sends: `backend/src/curation/interestLearning.ts`.

## 0. Prerequisite: real identity

Before any of this can sync, the client needs a real `auth.uid()` — anonymous
sign-in per ADR-0005 (`supabase.auth.signInAnonymously()`), replacing the
current `profileId()` placeholder (`app.js` line ~49). Every inserted row's
`user_id` must equal the signed-in `auth.uid()`; RLS (`backend/migrations/
supabase/0001_auth_and_rls.sql`) enforces `auth.uid() = user_id` on insert, so
this isn't optional — a mismatched `user_id` is simply rejected.

## 1. Two decisions baked into the contract (read before instrumenting)

1. **`episode_id`/`session_id` (the events table's uuid columns) are always
   sent as `null`.** The client's real identifiers are catalogue slugs
   (`data/session.json` episode ids like `"lex-353-whyte"`, session ids like
   `"2026-07-08-morning"`) — not uuids matching the backend's `episodes`/
   `sessions` tables (no live catalogue-ingest-to-Postgres pipeline exists
   yet). Durable identity travels in the jsonb `payload` instead, as
   `episode_slug` / `session_key`. See `docs/DECISIONS.md` (2026-07-24 entry)
   for the accepted-gap rationale — do not try to "fix" this from the client
   side by inventing uuids.
2. **`finished`/`skipped_at` payloads carry a `source` field**: `"observed"`
   or `"manual_stopgap"`. Per `DECISIONS.md` (2026-07-08), Foray's web client
   hands playback off to external apps (Apple Podcasts/Overcast/pod.link) —
   it cannot observe real playback position. The existing "Done ✓" button
   (`app.js`, the finished-episode flow around line 575) is a **declared**
   click, not **observed** behavior. Every `finished` event the web client
   sends today must be tagged `source: "manual_stopgap"`. Never send
   `source: "observed"` from the web client — that's reserved for a future
   in-app player (iOS) that has real position telemetry. This matters
   because the learning job and any future analysis need to be able to
   discount/weight stopgap-sourced signal differently from real observation.

## 2. Canonical event types (mirror of `backend/src/types/events.ts`)

| `type` | payload fields | required |
|---|---|---|
| `card_shown` | `episode_slug, show?, topics[], archetype` | one per dealt card, on render |
| `picked` | `episode_slug, show?, topics[], archetype, app?` | on tap-through to a player app |
| `skipped_at` | `episode_slug, show?, topics[], elapsed_seconds, duration_seconds?` | **not currently observable on web — see §4** |
| `finished` | `episode_slug, show?, topics[], percent_complete, source` | `source` mandatory, see §1.2 |
| `voice_command` | `command, node_id?, show?, episode_slug?` | `command` in `more_like_this\|something_different\|less_x\|never_this_show` |
| `thumbs` | `direction (up\|down), node_id, episode_slug?` | `node_id` mandatory — thumbs always target a named node |
| `saved` | `episode_slug, show?, topics[]` | |
| `session_built` | `session_key, builder` | |
| `session_rated` | `session_key, rating (good\|meh\|bad)` | |

`topics` should be the episode's taxonomy node ids (the client already has
these — see `snap.topics` used in the current `saved`/`finished` calls).
`archetype` is one of `deep-learn|stretch|narrative|comfort|continue`.

There is no build step for `app.js` (plain `<script src="app.js">`, no
bundler) — the TS module above cannot be imported directly. Mirror these
shapes as plain object literals; there's nothing to `import`.

## 3. Mapping from `app.js`'s existing `logEvent()` call sites

The client already has a `logEvent(type, payload)` buffering into
`cp_events` (`app.js` lines 58-63) and a `trySyncEvents()` that flushes
unsynced rows to a stopgap localhost endpoint (lines 65-84). Every existing
call site, and what to do with it:

| existing call (`app.js` line) | existing `type` | maps to canonical `type` | notes |
|---|---|---|---|
| 482 | `"picked"` | `picked` | add `archetype` from the card's slot at pick time (not currently in the payload) |
| 575 | `"finished"` | `finished` | **add `source: "manual_stopgap"`** — mandatory, see §1.2 |
| 212 | `"saved"` | `saved` | direct |
| 206 | `"unsaved"` | *(none)* | not a DB event type — stays local-only, do not sync |
| 726 | `"session_shown"` | `session_built` | rename on sync; payload becomes `{session_key, builder}` (client already has both — `state.session.session_id`, `state.session?.builder`) |
| 588 | `"playlist_built"` | *(none)* | product analytics, not a learning signal per 03_CURATION_SPEC.md — stays local unless the founders later want it server-side |
| 640 | `"playlist_removed"` | *(none)* | same as above |
| 736 | `"family_mode"` | *(none)* | same as above |
| 743 | `"player_pref"` | *(none)* | same as above |
| 749 | `"refreshed_all"` | *(none)* | same as above |

## 4. Net-new instrumentation — doesn't exist in `app.js` today

These are real product gaps, not just naming mismatches. None of the
following are currently emitted at all:

- **`card_shown`** — the client never logs an event when a card is dealt,
  only when it's picked. Needed for the "card shown, never picked x5"
  learning signal. Emit one per rendered card (all 4 slots), not just on
  pick.
- **`thumbs`** — no thumbs-up/down UI exists yet. Needs new UI (out of
  scope for this doc — flagging so product/design knows it's assumed by
  the learning job).
- **`voice_command`** — no voice UI exists yet (03_CURATION_SPEC.md's
  "more like this" / "less politics" / "never this show" mutations). Same
  status as thumbs: assumed by the learning job, not yet built.
- **`session_rated`** — the "how was that pick?" cold-start card
  (03_CURATION_SPEC.md "Cold start" section) isn't built yet.
- **`skipped_at` — do NOT fake this on web.** Real skip-at-elapsed-seconds
  requires knowing playback position, which the web client fundamentally
  cannot observe (external handoff to Apple Podcasts/Overcast/pod.link).
  Approximating it (e.g. "no finished event within N days after a pick ==
  skipped") would be a declared inference dressed up as observation —
  exactly what principle #2 warns against. Real `skipped_at` should wait
  for the iOS in-app player, which already has 15-second position
  persistence per `DECISIONS.md` (2026-07-08). Leave this event type
  unimplemented on web rather than approximate it.

## 5. Sync mechanics

- Reuse the existing buffer/cursor: `cp_events` (localStorage, capped at
  5000 events today) and `cp_synced_ts`. Only advance `cp_synced_ts` after a
  successful write.
- Batch inserts via `supabase.from('events').insert(rows)` in chunks (e.g.
  ~500 rows) rather than one request per event.
- **Retire** the current `EVENTS_ENDPOINT = "http://127.0.0.1:8787/events"`
  localhost stopgap (`app.js` lines 65-84) once Supabase sync lands — don't
  maintain two parallel sync paths.
- Every row's `payload` should validate against the shape in §2 before
  sending (hand-checked, since there's no shared runtime validator — see
  §2's build-step note). The learning job validates independently on read
  (defense in depth; a malformed row is simply skipped there, not trusted).
- CSP / dependency questions (how `@supabase/supabase-js` gets loaded given
  the strict CSP and no bundler) are the client wave's call, not decided
  here.

## 6. Open items carried from planning (for whoever picks up voice/thumbs UI)

- `never_this_show` (voice command) has no backend home yet — it's a show
  blocklist, not a taxonomy-node concept. A small new table near
  `saved_items` is the likely shape; not built in this slice.
- `thumbs` direction `up` reuses the `more_like_this` reason code
  server-side (no separate "thumbs-up" audit reason) — this is invisible to
  the client, just noted so the UI doesn't need special-case logic.
