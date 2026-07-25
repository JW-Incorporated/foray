# Depth ladders — client integration spec

**Status: not yet implemented.** This document specifies how the web client
(`app.js`/`sw.js`) should surface `data/ladders.json` and infer a listener's
entry rung, for a **separate, later client-integration pass**. The backend/data
change that shipped alongside this spec (`data/ladders.json`, the ladder
builder, the pure `inferLadderProgress()` reference function) deliberately
does **not** touch `app.js` or `sw.js` — see `docs/DECISIONS.md`
"2026-07-24 (depth-laddered learning paths — Step D)" for why (avoiding a
collision with concurrent client-side work in flight). Read this alongside
`docs/curation/personalization-and-depth-plan.md` §6.

## What exists today, for the implementer to build on

- `data/ladders.json` — one or more ladders, schema in
  `backend/src/types/ladders.ts` (`LaddersFileSchema`). Each ladder has a
  `status` of `"draft"` or `"published"`. **Only `"published"` ladders may
  ever be shown to a user** — `"draft"` exists purely for founder/editorial
  review via PR diff. The shipped Fusion ladder is `"draft"`; nothing in this
  spec applies to it until a founder flips it.
- `backend/src/curation/ladderProgress.ts` — `inferLadderProgress(ladder,
  pickedEpisodeIds)`, a pure function (no I/O, no DOM) implementing the
  entry-rung algorithm below. **Port this logic to the client rather than
  re-deriving it** — it's small (~40 lines), has unit tests
  (`backend/test/ladderProgress.test.ts` if added, or exercise it inline),
  and is the one place the rules are written down. If the client ever grows a
  shared-bundle build step, importing it directly (instead of porting) is the
  even-better option.
- `sw.js` already caches everything under `data/` generically (network-first,
  cache-fallback — see `DATA_PREFIX` handling). **No service-worker change is
  needed** to add `data/ladders.json`; it's covered automatically.

## 1. Fetching

Add `data/ladders.json` to the existing `Promise.all([...])` batch in
`app.js`'s `init()` (currently fetches `validated-links.json`,
`taxonomy.json`, `discover.json`, `semantic-index.json`, `item-tags.json` —
see the `fetchJson` calls around the `init()` function). Store as
`state.ladders`. Treat a fetch failure the same as the other optional data
files (`fetchJson` already returns `null` on failure without hard-failing the
app) — ladders are a progressive enhancement, never a load-blocking
dependency.

Filter to `status === "published"` immediately after load; nothing downstream
should ever see a draft ladder.

## 2. Entry-rung inference (observed, never declared)

Per `CLAUDE.md` principle #2, a listener's position in a ladder is **computed
from observed behavior**, never asked or configured. The algorithm
(`inferLadderProgress` in `ladderProgress.ts`):

1. **A rung is "reached"** if the listener has picked (today: appears in
   `cp_history`) **any one** episode in that rung's `episode_ids` — not all of
   them. A rung is a curriculum step, not a checklist (see
   `docs/DECISIONS.md`: "rung completion = any-one-of, correct for a
   curriculum").
2. **`prerequisites` are satisfied** once **any one** prerequisite rung is
   reached (not all) — this matches the branching structure (fundamentals
   unlocks several parallel deep-dive branches; finishing any one of them is
   meaningful progress).
3. **The entry rung** is the earliest (in prerequisite/topological order)
   unreached rung whose prerequisites are satisfied. A listener who's never
   touched the ladder gets the root rung(s) (`rootRungIds` — rungs with no
   prerequisites, i.e. `overview`).
4. If every rung is reached, `entryRungId` is `null` — the ladder is done;
   don't surface it as "next up" (a "you finished this" state is fine, but
   that's a UI decision for the implementer, not specified here).

**Known input limitation:** `cp_history` today records "picked/opened," not
"finished ≥85%." Event capture with real completion percentages (Step C of
the plan) isn't built yet. Use `cp_history` as the v1 proxy — it's the best
available signal — but do not read anything stronger into it than "the
listener opened this episode." When Step C ships, swap the input source; the
inference algorithm itself does not need to change.

## 3. Where progress is cached

Recommend a new localStorage key, **`cp_ladder_progress`**, keeping the
existing `cp_` prefix convention (renaming any existing key would wipe user
state — never do that; this is a *new* key, not a rename). Treat it strictly
as a **derived cache, not a source of truth**: recompute from `cp_history` +
`data/ladders.json` on every load (cheap — a handful of ladders, each with a
handful of rungs) and overwrite the cache. This means:
- It self-heals if `data/ladders.json` changes (a rung's episodes get
  edited, a new ladder ships).
- It requires no migration if/when a backend `ladder_progress` table
  (`docs/curation/personalization-and-depth-plan.md` §4) is added later — the
  shape (`ladder_id -> rung_reached`) is designed to port mechanically.

## 4. Surfacing — additive, not a new archetype slot

The live client's `buildCards()` (`app.js`) does not currently implement the
backend's 4-archetype menu (`deep-learn`/`stretch`/`narrative`/`comfort`) —
it ranks 4 taxonomy-branch cards directly from `discover.json`+`session.json`
interest scores. **Do not block ladder surfacing on that menu rewrite.**
Instead:

- When a card's chosen episode (`whyFor()`'s `curated`/`item` lookup) belongs
  to a `"published"` ladder **and** is that listener's current
  `entryRungId` episode (or one of them, if the rung has several), render a
  small supplementary line under the existing why-line/hook — e.g. "Rung 3 of
  7 — Understanding fusion energy" — rather than replacing the why-line or
  introducing a new UI slot. Every other card renders exactly as it does
  today; only laddered episodes that happen to be picked ever show the badge.
- **Never force a ladder episode into the menu** that the normal
  scoring/branch logic wouldn't have picked anyway. Ladders label an existing
  pick; they don't override slot selection. If you want ladders to actively
  *influence* which episode gets picked for a slot (a real future
  enhancement — using ladder membership as a ranking signal), that's a
  distinct, larger change requiring its own spec and founder sign-off, not an
  implicit side effect of adding the badge.

## 5. Hard constraints (non-negotiable, repeated from CLAUDE.md)

- **No autoplay chains.** A ladder is never used to auto-queue "up next."
  Every pick remains one deliberate tap.
- **No locking / gating UI.** `prerequisites` are advisory only (see
  `types/ladders.ts` doc comment on `LadderRung.prerequisites`). Never grey
  out, badge-lock, or otherwise visually restrict a later rung because an
  earlier one hasn't been reached. If anything, the badge for a not-yet-
  "current" rung's episode (if it happens to be picked anyway) should read
  neutrally, not as a warning.
- **No new declared state.** Don't add a settings toggle, onboarding
  question, or "mark rung complete" button. Everything here is inferred from
  `cp_history`, exactly as specified above.

## 6. Suggested acceptance criteria for the client pass

- `data/ladders.json` loads without blocking `init()`; a fetch failure
  degrades to "no ladder badges shown," not a broken app.
- Draft ladders never appear anywhere in the UI (verify by temporarily
  flipping the Fusion ladder to `"published"` in a local test file and
  confirming a badge *can* appear, then confirming it disappears again with
  `status: "draft"`).
- A listener with empty `cp_history` sees no "reached" rungs and, if a badge
  is shown at all, it reads as the ladder's root rung (`overview`).
- A listener with `cp_history` containing one episode from a mid-ladder rung
  gets recommended the correct next rung per the topological rule above, not
  simply "the next array entry."
- No ladder-driven change to which 4 episodes get picked for the session —
  only to the copy shown alongside a pick that was already going to happen.
