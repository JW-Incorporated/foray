# Foray UX prototypes

## `foray-m3-prototype.html` — M3 interactive prototype

A single self-contained HTML file — no build step, no dependencies to install.
Open it directly in a browser (double-click, or `file://` it) to click through
the app.

The panel on the right of the page is **not part of the app** — it's a harness
that forces app states (onboarding, player states, download/offline/building/
expired/404, etc.) so every screen is reachable without live data or a backend.

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
