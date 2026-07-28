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
