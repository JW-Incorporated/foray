# tools/ui-lab - the eyes for Redesign 2026

A Playwright screenshot + accessibility harness. It looks at today's app, or at
any static prototype with hash routes, the same deterministic way every time, so
two renders can be compared by a judge (or a diff).

**This directory has no `test` script and no `*.test.*` files, on purpose.**
`tools/ci/run-suites.mjs` auto-runs every `tools/<dir>` package that has a `test`
script, and `test/suite-integrity.test.js` demands a floor for every suite. This
is a tool, not a suite. Do not add either.

## Setup (once per checkout)

```
cd tools/ui-lab
npm install
npx playwright install chromium
```

`node_modules/` is ignored (root `.gitignore` plus `tools/ui-lab/.gitignore`).
Output belongs in `data-local/redesign/` (gitignored); never commit renders of
third-party apps.

## Usage

```
# today's app, every route in every state, three phone sizes
node tools/ui-lab/shoot.mjs --target app --out data-local/redesign/shots/today

# a static prototype (a file, a directory with index.html, or an http(s) URL)
node tools/ui-lab/shoot.mjs --target url --url path/to/prototype.html \
     --routes "#/,#/now-playing,#/library" --out data-local/redesign/shots/dir-a

# a deliberately degraded variant, for judge calibration
node tools/ui-lab/shoot.mjs --target app --css degrade.css --out data-local/redesign/shots/degraded

# axe-core on every route and state (default viewport 393x852)
node tools/ui-lab/a11y.mjs --target app --out data-local/redesign/a11y/today
node tools/ui-lab/a11y.mjs --target url --url path/to/prototype.html --routes "#/,#/x" --out <dir>
```

A blind pairwise judging set for the design judge (`docs/redesign-2026/judge/protocol.md`):

```
node tools/ui-lab/judge-set.mjs --pairs docs/redesign-2026/judge/hard-pairs.json \
     --out data-local/redesign/judge-hard --judges 6
```

It copies each pair to neutral `j<k>/<nn>/A.png, B.png` folders, shows every pair
in both orders to two different judges, never gives one judge two pairs of the
same screen, can wrap a render in a marketing-style frame, and writes `key.json`
(move it out of the folder before judges start).

Options: `--states a,b` (app target), `--viewports 393x852,375x667` (shoot default
`393x852,375x667,412x915`), `--css <file>`, `--full` (full-page captures instead
of the viewport), `--no-remote-images` (flat grey placeholder for every https
image, for a fully offline run), `--scheme dark|light` (default `dark`),
`--title <text>` (contact sheet heading).

Windows note: Git Bash rewrites an argument that looks like a path, so
`--routes "#/a"` can arrive as `C:/Program Files/Git/a`. Run from PowerShell, or
set `MSYS_NO_PATHCONV=1`.

## What a run writes

- `shots/<state>__<screen>__<WxH>.png` at deviceScaleFactor 2
- `contact-<w>x<h>.png`, one per viewport: every screen tiled, grouped by state,
  each labelled with its screen name and route (composed in the browser from the
  shots, so labels are real text)
- `index.json`: every shot (`route`, `state`, `label`, `viewport`, `path`), the
  clock start, the states, a tally of stubbed/refused requests, and any page or
  console errors seen (a 404 for a generated file the checkout does not have, such
  as `deploy-manifest.json`, is expected and harmless)
- a11y: `a11y.json` (violations and incomplete per screen, with selectors) and
  `summary.md` (rules failing, by screen, a sample node per rule)

## The app states (`lib/states.mjs`)

| State | Seed | Screens |
|---|---|---|
| `first-run` | empty profile | onboarding sheet over Home |
| `empty` | intro dismissed, nothing saved | Home, Search, Create, Library, Up Next, Playlists, Followed shows, Interests, Forays, not-found playlist and episode |
| `returning` | saved episodes, Up Next, 3 playlists, followed shows, history | all of the above populated, plus playlist detail, show, episode, category, browse pill, a foray |
| `player` | returning + an episode playing | mini player over Home, Library, Up Next; the Now Playing sheet open; the sheet closed again |
| `search` | returning | idle, results ("history"), a query with no show matches ("fusion" matches only playlists), a query with no results |
| `stress` | long titles | 150-character titles, a 90-character show name and unbreakable 100-character tokens through Home, Library, Up Next, Playlists, detail pages, mini player and Now Playing |

Routes covered are every one in `app.js` `renderCurrentPage` and `TAB_ROUTES`,
except `#/subject/<id>` (generated from a live search; no stable id to seed).
`#/foray/<id>` shows "That foray isn't available" because Forays are gated behind
an unlock; it is shot as that real state.

Profiles are built by `lib/seed.mjs` from committed data (`data/discover.json`,
`catalog-client.json`), picked by a fixed rule, and written to the app's own `cp_`
localStorage keys (`cp_intro_dismissed`, `cp_saved`, `cp_episode_snaps`,
`cp_queue`, `cp_history`, `cp_playlists`, `cp_starred_shows`) before the app
loads. Add a state by adding an entry to `appStates()`; add a screen by adding a
step `{ label, route, run?(page) }`. Steps run in order on one page per
(state, viewport).

## Determinism

- Clock: `Date` starts at 2026-10-05T12:00:00Z and then runs at the real rate. A
  hard freeze breaks the app's own deadline and debounce arithmetic; pinning the
  start keeps every relative label ("3 days ago", greetings) stable.
- `Math.random` is a seeded PRNG; service workers blocked; locale `en-US`,
  timezone UTC, colour scheme dark.
- Screenshots disable animations and hide the caret.
- Playback is real (the real player, a real `<audio>`), on a silent 60 s WAV, then
  pinned: seeked to 21 s and paused. The bar's time therefore reads against 60 s,
  not the episode's own length. This is a fixture artifact.
- Viewports run concurrently (one browser context each); within a viewport the
  states run in order.

## How the network stubbing works (`lib/stubs.mjs`)

One `context.route("**/*")` handler. Nothing is ever written to production.

| Request | Answer |
|---|---|
| our local static server | passes through |
| `https://qjdllvqdcgacvujhclny.supabase.co/*` (all methods) | fixture: a fake anonymous session for `/auth/v1/signup` and `/token`, `201 []` for `/rest/v1/*`, `204` for logout |
| `https://foray-web-seven.vercel.app/*` | fixture: `api/shows/search` -> empty, not degraded; `api/episodes/search` -> empty, not degraded; anything else 404 |
| any https audio/video | the silent WAV |
| any https image, font, stylesheet (GET) | passes through, so artwork loads normally (or a grey placeholder with `--no-remote-images`) |
| anything else, and every non-GET to another host | refused with 404 and listed in `index.json` -> `network.refused` |

Because the API fixtures are empty, search results come from the local show index
only; that is the app's own "answered, nothing extra" path, not a degraded one.

## `--css` and CSP

The app's CSP forbids inline styles, so the CSS is injected as a constructable
stylesheet (`adoptedStyleSheets`), which CSP does not block. The app's policy stays
fully on (one exception, see below). Use `!important` if a rule must beat an
inline-style-free author rule of higher specificity.

`lib/server.mjs` makes the same single CSP edit the Playwright site server does:
`media-src https:` becomes `media-src 'self' https:` so the silent WAV can play. A
prototype without that string is served byte-for-byte.
