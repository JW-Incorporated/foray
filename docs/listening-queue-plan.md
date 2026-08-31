# Plan: "add to queue" — a listening queue / up-next list

*2026-08-31. Requested by Joey during live iPhone testing: "I should be able
to add some arbitrary number of shows to my queue." Joey explicitly deferred
build until a per-episode/per-show surface exists to add from. Planning
only — no implementation in this change. See kanban card `t_8fcc3a44` for
the full ask and the design questions it raised.*

## 0. Why this needs a new concept, not a reuse of an existing one

Three things in 4a already use the word "queue" or "playlist," and none of
them is what Joey is describing:

- **Playlists** (`cp_playlists`, `buildPlaylist()`) — user-triggered, but
  built *from a search query* (`buildPlaylist(query)` runs the topic
  scorer and mints a whole ranked list at once). Not an ordered manual
  pick-list a user builds one episode at a time.
- **Today's subject queues** (`state.cardSlots`, `subjectQueueById`) —
  algorithmic, rebuilt daily by the curation pipeline, not user-curated at
  all.
- **A foray's internal segment queue** (`player/queue-manager.js`,
  `player/queue-state.js`) — playback-internal ordering of stitched
  segments inside a single foray. Completely different layer; reusing
  "queue" language here risks exactly the naming collision CLAUDE.md and
  the parent card both flag.

What Joey is asking for is a **listening queue**: an ordered,
user-editable, persistent list of individual episodes, added one at a time
while browsing, that is not a named/searched playlist and not a foray.
Closest real-world analogue: a podcast app's "Up Next" list.

## 1. Design questions (from the parent card) — answered

**Q1: one global queue, or can a user have several?**

**One global queue, in v1.** Multiple named queues is playlist territory
already covered by `cp_playlists` — building a second parallel
multi-list feature would blur the exact line this doc exists to draw.
"Up Next" as a single always-there list matches every mainstream podcast
app Joey is implicitly comparing this to (Apple Podcasts, Overcast,
Pocket Casts all ship one queue). Multiple queues is a plausible v2 if usage
shows the demand — not blocking v1 on a hypothetical.

**Q2: does adding to queue interact with playlists at all?**

**Fully separate storage, same UI affordances.** The queue does not read
from or write to `cp_playlists`. A user can have an episode both in a
playlist and in the queue simultaneously — they answer different
questions ("this belongs to a named collection I curated" vs "I want to
hear this next"). The only shared surface is presentation: the queue page
reuses `epRow`-style rows exactly like `renderPlaylistDetail` does today,
so it looks and behaves consistently, not because it shares data.

**Q3: what's the UI entry point?**

**A small "+ Queue" control on every row that already names an episode** —
`epRow`, `archivedRow`, the new episode page (`renderEpisode()`,
`t_290cba50`), and the new show page's per-episode rows
(`renderShow()`, `t_52c50bba`) once that stage lands. This is additive to
the row, alongside the existing ▶/star/external controls, not a
replacement for any of them. Tapping it adds the episode to the end of the
queue and gives a lightweight confirmation (toast-style, matching how
starring already gives feedback) without navigating away — "browse and
add without losing your place" is the explicit ask ("as you browse").

Rows already at their control-density ceiling (mobile width is the
binding constraint per the parent card's iPhone-testing context) — this is
a layout risk to watch at implementation time, not a blocker to the
concept. A collapsed "⋯" overflow affordance is an acceptable Stage 1
implementation fallback if three side-by-side icon buttons plus the title
don't fit; that's an implementation call, not a plan blocker.

**Q4: does the queue have its own page?**

**Yes — a "Queue" (labelled "Up Next" in-product, see §3) view reachable
from the drawer nav, same place `renderPlaylists()`/`#/playlists` is
reachable today** (`app.js` `openDrawer()`/`#drawer-playlists` region,
~L2640-2648). New route `#/queue`, pattern-matched alongside the existing
`#/playlists`, `#/playlist/:id`, `#/foray/:id` routes in `route()`.

The page needs, beyond a flat list of rows:
- Manual reordering (drag or up/down controls) — this is the one thing
  that makes it a *queue* rather than another playlist. Sequencing/UX
  detail deferred to implementation, but "no way to reorder" would not
  satisfy the ask.
- Per-row remove.
- A "Play from here" style affordance so the queue can actually be
  listened through as a queue, not just viewed — needs a small
  compatibility decision with the existing single-foray player (§4).
- Empty state (mirrors "no playlists yet" today).

## 2. Data model

New localStorage key, **not** reusing the `cp_` prefix's existing shapes
(playlists/history/saved are all differently shaped and mixing this in
would risk exactly the kind of migration/parsing bug CLAUDE.md's
`lsGet`/`lsSet` conventions exist to avoid). Proposed key: `cp_queue`,
storing an ordered array of episode ids (`item.id`), resolved against
`state.itemIndex` the same way playlists resolve parts — reuses the
existing `resolveParts`/archived-row pattern for episodes that later age
out of the live pool, so an item added to queue and then dropped from the
discover pool still shows (as an `archivedRow`) rather than silently
vanishing.

No backend/server involvement — like playlists today, this is
client-local state only (`user_id`-scoped backend storage is out of scope
unless/until 4a gets real accounts, which is a much bigger, unrelated
question).

## 3. Naming — the constraint the parent card flagged

**In-product copy must never say "add to queue" bare**, because
`player/queue-manager.js`/`queue-state.js` already use "queue" for a
foray's internal segment ordering, and CLAUDE.md's ownership section
reserves "foray" specifically for stitched-audio units. Recommendation:

- UI label: **"Up Next"** for the page/nav item and the per-row control
  ("+ Up Next" or a plain "+" with an "Add to Up Next" accessible label),
  never bare "Queue" in user-facing copy.
- Internal code/variable names can say `queue` (e.g. `cp_queue`,
  `renderQueue()`) since that's implementation detail, not user-facing —
  but PR review should double check no internal name leaks into rendered
  copy (a `title` attribute, an aria-label, etc.), the same class of bug
  copy-rules review already watches for per CLAUDE.md's `copyRules.test.ts`
  gate.
- This mirrors how `player/queue-manager.js` itself is never user-facing
  language — the founders don't see "queue" in the player UI today either,
  they see forays and playback controls.

## 4. Open question — playback integration

Not fully resolved here; flagging rather than guessing, per CLAUDE.md's
"don't stop to ask" *unless* it's a genuine spec gap where guessing wastes
hours — this one has real UX branches:

- Does tapping ▶ on the queue page play that one episode only (current
  single-foray player behavior, unchanged), or does finishing an episode
  auto-advance to the next queued item?
- Auto-advance would be the first cross-episode continuous-playback
  behavior in 4a and touches `player/queue-manager.js` if it's built on
  the same primitive that already sequences a foray's segments, or it's a
  new, separate advance-on-end hook if kept fully decoupled (safer, less
  surface-area, avoids conflating the two "queue" concepts even in code).

**Recommendation for Stage 1: no auto-advance.** Ship the list + reorder +
remove + individual play (today's single-episode playback, unchanged).
Auto-advance is a natural fast-follow once the base list exists and Joey
has used it — this keeps Stage 1 small and doesn't force the
queue-manager coupling question before there's real usage to learn from.

## 5. Staged breakdown

### Stage 1 — queue page + add-from-row, no auto-advance
- New route `#/queue`, `renderQueue()` (list, reorder, remove, per-row
  play using existing single-episode playback).
- `cp_queue` localStorage key + `lsGet`/`lsSet`-based helpers (mirrors
  `cp_playlists` helpers at `app.js` ~L796-824).
- "+ Up Next" control added to `epRow` and `archivedRow`.
- Drawer nav entry ("Up Next"), same region as `#drawer-playlists`.
- Explicitly NOT included: episode-page/show-page row wiring (needs
  `t_290cba50`/`t_52c50bba` to have actually landed — confirm merged, not
  just PR-opened, before starting), auto-advance playback.

**Acceptance criteria:**
- Tapping "+ Up Next" on any `epRow`/`archivedRow` adds that episode to
  the end of the queue and gives visible confirmation without navigating
  away.
- Visiting `#/queue` shows every queued episode in order, each playable,
  removable, and reorderable.
- Removing the last item shows the empty state, not a blank/broken page.
- `node --test "test/*.test.js"` and `node --check app.js` pass; new
  suite covers add/remove/reorder/persistence and the not-a-crash empty
  state, each with a named mutation per CLAUDE.md's testing section.

### Stage 2 — wire the new episode/show page rows
- Add the same "+ Up Next" control to `renderEpisode()` and the show
  page's episode rows once both are live and merged to `main`.

### Stage 3 (not scheduled) — auto-advance playback
- Only after Stage 1 ships and gets real usage. Needs its own design pass
  on the `player/queue-manager.js` coupling question in §4 before
  implementation.

## 6. Files touched (Stage 1)

- `app.js` — `route()`, new `renderQueue()`, `cp_queue` get/set helpers,
  `epRow`/`archivedRow` markup for the new control, drawer nav wiring.
- `styles.css` — queue page layout, reorder control styling.
- `test/*.test.js` — new suite for the queue route/render/persistence.
- `docs/DECISIONS.md` — entry recording "one global queue, separate from
  playlists, no auto-advance in v1" once approved, per workflow rule 4
  (expensive-to-reverse data-model/UX choices get a decision entry).

## 7. What this plan does NOT include

- No implementation. Once approved, Stage 1 becomes its own child card,
  gated on `t_290cba50` and `t_52c50bba` actually merging to `main` (not
  merely opening a PR) — those cards' final state should be re-verified at
  that time since this plan was written while both were still open PRs.
- No auto-advance playback (§4, deferred).
- No multiple/named queues (§1, deferred pending usage signal).
- No backend/account-scoped queue storage.
