# tools/ui-lab - the eyes for Redesign 2026

A Playwright screenshot + accessibility harness. It looks at today's app, or at
any static prototype with hash routes, the same deterministic way every time, so
two renders can be compared by a judge (or a diff).

**One suite lives here: `baseline.test.mjs`** (pure diff/report logic, synthetic
PNGs, no browser; floored in `test/suite-integrity.test.js`). `tools/ci/run-suites.mjs`
therefore runs `npm ci` in this directory. That installs playwright, axe-core,
pixelmatch and pngjs but downloads **no browser** (`playwright install` is a
separate step CI never runs), so CI cost is a few seconds. Do not add a test that
launches a browser.

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

Options: `--states a,b` (app target), `--viewports 393x852,375x667` (shoot default
`393x852,375x667,412x915`), `--css <file>`, `--full` (full-page captures instead
of the viewport), `--no-remote-images` (flat grey placeholder for every https
image, for a fully offline run), `--scheme dark|light` (default `dark`),
`--title <text>` (contact sheet heading).

Windows note: Git Bash rewrites an argument that looks like a path, so
`--routes "#/a"` can arrive as `C:/Program Files/Git/a`. Run from PowerShell, or
set `MSYS_NO_PATHCONV=1`.

## Visual baselines (`baseline.mjs`)

Lock a render set, then catch unintended visual change later. Direction-independent:
it works on the current app or any prototype `shoot.mjs` can drive.

```
# record: renders with shoot.mjs (args after the options are passed through) and copies the shots
node tools/ui-lab/baseline.mjs record --name gallery-v1 --target url --url path/to/gallery.html      --routes "#/gallery" --no-remote-images
# or lock an existing render dir
node tools/ui-lab/baseline.mjs record --name today --from data-local/redesign/shots/today [--force]

# compare: re-renders with the SAME shoot args (stored in baseline.json), or --from <renderDir>
node tools/ui-lab/baseline.mjs compare --name gallery-v1 [--max-pct 0] [--pixel-threshold 0.1] [--out dir]
node tools/ui-lab/baseline.mjs list
```

Baselines: `data-local/redesign/baselines/<name>/` (gitignored; renders are never
committed). Compare writes `data-local/redesign/compare/<name>/report.md`,
`report.json` and `diffs/<shot>.png` (pixelmatch overlay) for every changed shot.
Exit 0 = pass, 1 = a shot over threshold or any added/missing shot, 2 = usage.

**Threshold.** Two knobs. `--pixel-threshold 0.1` is pixelmatch's per-pixel colour
tolerance (its default; ignores sub-visible noise, not a real colour change), with
anti-aliased pixels ignored. `--max-pct 0` fails a shot when more than that % of
its pixels differ; 0 because the harness is deterministic (below), so any differing
pixel is a real change. A size change, added shot or missing shot always fails.
Raise `--max-pct` (e.g. 0.05) only for a known, accepted drift.

**Determinism result (2026-10-05).** Full app set (138 shots: 6 states x 3
viewports, `--no-remote-images`) rendered twice: 138 same, 0 differ. A 20-shot
set with remote artwork also matched. No new nondeterminism source was found, so
nothing was changed in `walk.mjs`; the existing controls (pinned clock, seeded
`Math.random`, animations disabled, caret hidden, pinned audio position, fixed
locale/timezone/scheme) are sufficient. Sanity check that compare can fail: a
`--css` hue-rotate flagged 20/20 shots. **Record baselines with `--no-remote-images`**:
remote artwork passes through to the live network, so a changed or slow CDN image is
a diff your code did not cause. Baselines are also tied to the machine's Chromium
and fonts; re-record after upgrading Playwright or on a different OS.

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
