# Foray UX prototypes

## `foray-m3-prototype.html` — M3 interactive prototype

A single self-contained HTML file — no build step, no dependencies to install.
Open it directly in a browser (double-click, or `file://` it) to click through
the app.

The panel on the right of the page is **not part of the app** — it's a harness
that forces app states (onboarding, player states, download/offline/building/
expired/404, etc.) so every screen is reachable without live data or a backend.

The `SESSION` constant near the top of the `<script>` block is the shared
reference fixture: it mirrors our session doc v1 shape and is meant to be the
canonical example of the item types (`intro_tts` / `episode` / `transition_tts`
/ `outro_tts`) and the events payload shapes the real session builder and
learning loop consume. Treat it as documentation, not just prototype plumbing —
if it drifts from what the backend actually emits, that's a bug worth flagging
(see the PR that introduced this file for the specific ask to Wyatt).
