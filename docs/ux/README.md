# Foray UX prototypes

## `foray-mockup.jsx` — the front-end design, going forward (REFERENCE ONLY)

**Status: adopted as the design direction. Explicitly NOT to be implemented
yet.** Joey's call, 2026-08-13. Nobody should port this into `app.js`, start an
iOS build from it, or add React to this repo on the strength of it. It is here
to be *read* — it exists so that backend work is built toward a known front end
instead of guessing at one, and so the eventual implementation isn't designed
twice.

A single self-contained React component file (1,562 lines): design tokens,
sample data, and thirteen screens — login, welcome, preferences, home, search,
create, library, show, full player, mini player, share sheet, feedback sheet,
thumbs. It does not build here and is not wired to anything; `docs/` is not on
any build path, and CI does not compile it.

### What it commits us to, and why the backend should care

The mockup is not just a look. Its data shapes are a de facto contract, and
they are more demanding than what the backend emits today.

- **A Foray is a flat timeline of segments**, not an episode. `FORAYS[].segments[]`
  alternates `kind: "narrator"` and `kind: "source"`; each carries `dur`, each
  source carries its show, episode title and date. Playback maps a position to
  `(segment index, offset into segment)` — see `segAt()`. Anything the curation
  engine emits has to reduce to that shape.
- **`BUILD_STEPS` is a claim about the pipeline** (lines 152–158), shown to the
  user while they wait: *search 2.4M episodes → choose the strongest segments →
  clip just the relevant parts → record narrator bridges → stitch it together.*
  That is five backend capabilities, and the third one — clipping exactly the
  right audio — is the one the research corpus says is hardest, because dynamic
  ad insertion moves offsets per download (`docs/adr/0007-segment-anchoring.md`).
  The UI promising it does not make it true; treat that screen as a requirement
  with a known risk attached, not a solved problem.
- **On-demand creation is a first-class screen.** `CreateScreen` lets a user
  type any subject and get a custom Foray built for them, with a length choice
  (~20 / ~40 / ~75 min). Today's backend builds a daily menu of whole episodes;
  this is a substantially larger ask, and it is the screen most likely to drive
  scope.
- **Narrator bridges are everywhere in the design** — intro, between every pair
  of sources, and an outro. Same structural gap the M3 prototype already
  flagged below: the real session doc has no TTS items at all.

### What has been built FROM it so far (keep this list current)

The ruling above still stands — nobody ports this file. What follows is the
design *intent* rebuilt in the shipped vanilla stack, so that the next session
can tell "not built yet" from "built, differently".

| Mockup concept | Shipped as | Where |
|---|---|---|
| `resume` / "Jump back in" / `ForayCard` progress | resume across sessions: one row per Foray in `localStorage`, the Foray's own clock | `player/foray-progress.js`, `?foray=…` page + home rail |
| `MiniPlayer` identity + tap-to-open | the bar already survived navigation; it now leads with the FORAY title, says `Now: <show> · part N of M`, and carries a "Back to the foray" route | `player/client.js` |
| `Thumbs` + `FeedbackSheet` (9 `FB_CHIPS`) | per-segment thumbs on the running order; up is one tap, down opens the reason sheet and only commits on submit | `app.js` (`cp_foray_feedback`, `thumbs` events) |
| `Scrubber` over the whole Foray (`seek()`, jsx ~1329) | the segment strip IS the scrubber: a click is a position in the hour, cold or playing. It already looked like one and behaved like 32 jump targets | `app.js` (`stripElapsedAt`), `ForayPlayer.foraySeek` |
| `SegmentStrip`'s partial fill on the current bar (`cur.into / seg.dur`, jsx ~229) | the live bar fills left to right; bars behind are full, ahead are empty | `app.js` (`paintSegFill`), `.fy-seg-fill` |
| `ShowScreen` | NOT built. Its honest subset is: a "Where this came from" credit block per Foray — shows, episodes, clip counts, and a link out | `player/foray-sources.js` |
| `CreateScreen`, narrator bridges, generated cover art | NOT built, deliberately. See the scope notes above and in `STATE.md`. | — |
| `PlayerBridge` (m3 prototype) — the handoff screen between two sources | NOT built. What exists instead is the seam itself: 2.0 s of silence at every unbridged transition, which is the beat the bridge screen was drawn around | `player/seam-gap.js` |

Two deviations worth knowing:

- **`ShowScreen` has no data behind it.** The mockup shows a description and a
  follower count per show; `data/segment-sources.json` carries a feed URL and
  nothing else, and only one of Foray #1's five shows is in `data/discover.json`
  (so only one has an `apple_collection_id`). The credit block therefore links to
  the show's real Apple page when we know its id and to an Apple search for its
  name when we do not, and `linkKind` records which — rather than inventing an id
  or sending a human to an RSS document. There is no follow button, because there
  is nothing to follow with.
- **The scrubber lost the mockup's tick marks and its knob, and kept its job.**
  The strip's own 2px gaps already draw a boundary between every segment, so
  separate ticks would be a second set of lines saying the same thing. There is
  no drag: a click is a position, which is the gesture that was missing. The
  exact-segment jump the strip used to do lives on in the running-order rows,
  which are also the keyboard-reachable half of the control — the strip is a
  pointer affordance and does not claim otherwise.
- **The mockup's resume state is read-only and hard-coded** (`const resume = { f1: 1180 }`,
  a literal `"20 min left"`, a literal `62%`). Everything above it is computed.
  The one number that is not the mockup's is the "already finished" threshold:
  the mockup has none, and resuming a listener 20 seconds before the closing
  out-point drops them into a goodbye.

### Frictions to know about before anyone implements it

- It imports `react` and `lucide-react`. The repo root is deliberately
  dependency-free with no build step (see `package.json`'s own description), so
  adopting this is a stack decision, not a file copy — it needs an ADR.
- It pulls Fraunces and DM Sans from Google Fonts via `@import` (line 1480).
  The live site runs a strict CSP with no inline styles or external fetches
  (`CLAUDE.md` § Conventions), so those fonts would have to be self-hosted.
- Sample data is fictional. The podcasts, episodes and follower counts are
  illustrative, not a catalogue.

## `foray-m3-prototype.html` — M3 interactive prototype

A single self-contained HTML file — no build step, no dependencies to install.
Open it directly in a browser (double-click, or `file://` it) to click through
the app. Live: https://jw-incorporated.github.io/foray/docs/ux/foray-m3-prototype.html

**Defaults to full-screen "real webapp" mode** — no fake-phone bezel, no
desktop chrome, just the app edge to edge (a centered readable column on wide
viewports, full-bleed on mobile widths). That's the link to share with anyone
who just wants to see the product.

For internal review — checking the harness-forced states, the fixture, the
event log — click **"Exit demo mode"** in the top-right corner. That reveals
the annotated desktop preview: the phone-bezel mockup plus the intro copy and
harness panel described below. Click **"Full-screen demo"** to go back.

The panel on the right of that annotated preview is **not part of the app** —
it's a harness that forces app states (onboarding, player states,
download/offline/building/expired/404, etc.) so every screen is reachable
without live data or a backend.

The `FIXTURE_SESSION` constant near the top of the `<script>` block is the
original hand-built reference: it mirrors our session doc v1 shape and is
meant to be the canonical example of the item types (`intro_tts` / `episode` /
`transition_tts` / `outro_tts`) and the events payload shapes the real session
builder and learning loop consume. Treat it as documentation, not just
prototype plumbing — if it drifts from what the backend actually emits, that's
a bug worth flagging (see the PR that introduced this file for the specific
ask to Wyatt).

## Real-data mode

The harness has a **"real backend data"** toggle. It swaps the fixture for
`data/session.json` (bundled verbatim into the file, the same doc `app.js`
reads on the live site and `backend/src/curation/sessionBuilder.ts` emits via
`npm run build-session`) run through `adaptRealSession()`.

**This surfaced a real gap, not just field-name drift:** the real session doc
has no `menu`/`paths`/`intro_tts`/`transition_tts`/`outro_tts` at all. It's
flat — one episode per card (`cards[]`: `episode_id`, `why_line`, `fit_line`,
`alternates[]`) plus a `categories[]`/`episodes{}` lookup. The TTS-choreographed
run the fixture demonstrates (intro → episode → transition → episode → outro)
doesn't exist in the backend yet. Real-data mode is honest about that: picking
a card plays straight into the episode with no intro/transition/outro, and the
Today screen shows a banner saying so. This is exactly the kind of mismatch
the M3 prototype PR asked Wyatt to check the `SESSION` fixture against.

## On-demand topic search ("What do you want to learn?")

Front and center on the Today screen: a user can type a topic they already
have in mind — something they just heard about, not one of the four
algorithmic picks — and get a real results list for it immediately, and the
topic gets folded into their taxonomy weights for future menus.

Results render as their own clearly-labeled **"SEARCH RESULTS · &lt;topic&gt;"**
list (badge + count + one row per match, each independently playable) —
visually distinct from the algorithmic menu, which now sits under its own
**"Today's menu"** divider below. Originally this was a single card blended in
above the four archetype cards; that read as ambiguous (was it a 5th
algorithmic pick or something else?) and collapsed multi-result topics like
"science" down to one item, so it was redesigned into a proper list with an
explicit section boundary.

**How it works:**
- `data/taxonomy.json` (149 nodes) and a slim, broad-coverage slice of
  `data/discover.json` (~6 real items per top-level branch, 217 items total,
  stripped to essential fields) are bundled into the file. The full
  `discover.json` is 1.2MB — too heavy for a demo link — so this is real
  catalogue content, not the whole catalogue.
- `resolveTopicQuery()` does simple token-overlap matching against taxonomy
  node labels/ids — no embeddings, this is a placeholder for the
  semantic-search work already roadmapped in
  `docs/curation/personalization-and-depth-plan.md` (§"Semantic search").
- `findEpisodesForNode()` returns up to 8 real episodes tagged under the
  resolved node from the bundled slice; each row that doesn't literally
  mention the typed query is flagged "closest match" individually, rather
  than one blanket note for the whole result set.
- `bumpOrCreate()` extends the existing `bump()` taxonomy-mutation pattern to
  **create** a new taxonomy row if the user has never touched that node
  before — the actual "automatically add to our algo" mechanic — then shows
  an explicit toast and tags the new row's origin ("from your search: ...")
  visibly in the Interests screen. This is a deliberate exception to "state
  observed, never declared" (`CLAUDE.md` principle #2): a typed topic request
  is a user action/event, not a config field, so it's treated the same as any
  other observed signal — just with a stronger, more visible confirmation
  since the user typed it themselves.

**Honesty over polish:** if the resolved taxonomy node has no real bundled
episodes, the card says so plainly rather than inventing a match. If it has
episodes but none of them literally match what was typed (tested against
title+hook text, not just the taxonomy node), the card still shows the
closest real result but flags it as not an exact hit — e.g. searching "Greek
mythology" surfaces a real Norse/Hawaiian mythology episode (Foray has zero
Greek-mythology content today) with a note saying so, rather than pretending
it's a direct match.

## First-time vs. returning user

The harness has a **"returning user"** toggle. It controls which sign-in
screen renders (`V.signinNew` vs `V.signinReturning`) — these are two
deliberately different first screens, not the same screen with minor copy
changes:

- **First-time (`V.signinNew`):** explains what the app does, what the
  interview is for (weighted interests, not a fixed picklist — nothing's
  locked in), and in plain language what data gets used and why (listening
  behavior only, nothing sold/shared, every weight visible and editable in
  Interests). Has an explicit **"Skip for now"** path — jumps straight to
  Today without running the interview, with a toast pointing at Interests for
  tuning later. Completing the interview (`finishOnb`) or skipping it
  (`skipOnb`) both flip `S.newUser` to `false`, so navigating back to the
  sign-in route afterward correctly shows the returning-user screen instead.
- **Returning (`V.signinReturning`):** leads with "Welcome back," a one-line
  summary of where they left off, a listening-history stat line (X finished,
  Y in progress) with a direct link into Library, and two unambiguous
  actions — resume the in-progress episode, or go straight to today's picks.
  No re-explaining what the app is or re-running the interview.

This was a specific ask (not a general "polish the onboarding" pass): make
sure a first-time user understands the product and consents to how their
answers are used before anything happens, with an easy out; make sure a
returning user is welcomed back and pointed at continuing/starting/history
without re-reading the pitch.
