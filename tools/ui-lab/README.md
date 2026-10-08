# tools/ui-lab - the eyes for Redesign 2026

A Playwright screenshot + accessibility harness. It looks at today's app, or at
any static prototype with hash routes, the same deterministic way every time, so
two renders can be compared by a judge (or a diff).

**Two suites live here: `baseline.test.mjs` and `gates.test.mjs`** (pure diff/report and gate-rule logic, synthetic
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

## Visual baselines (`baseline.mjs`)

Lock a render set, then catch unintended visual change later. Direction-independent:
it works on the current app or any prototype `shoot.mjs` can drive.

```
# record: renders with shoot.mjs (args after the options are passed through) and copies the shots
node tools/ui-lab/baseline.mjs record --name gallery-v1 --target url --url path/to/gallery.html      --routes "#/gallery" --no-remote-images
# or lock an existing render dir
node tools/ui-lab/baseline.mjs record --name today --from data-local/redesign/shots/today [--force]

# compare: re-renders with the stored shoot args (baseline.json) MERGED with any you pass (yours win), or --from <renderDir>
node tools/ui-lab/baseline.mjs compare --name gallery-v1 [--max-pct 0] [--pixel-threshold 0] [--out dir]
node tools/ui-lab/baseline.mjs list
```

Baselines: `data-local/redesign/baselines/<name>/` (gitignored; renders are never
committed). Compare writes `data-local/redesign/compare/<name>/report.md`,
`report.json` and `diffs/<shot>.png` (pixelmatch overlay) for every changed shot.
Exit 0 = pass, 1 = a shot over threshold or any added/missing shot, 2 = usage.

Safety: `--name` must be `[A-Za-z0-9._-]+` and not `.`/`..` (the resolved dir must sit
directly in `baselines/`); `record --force --from` refuses the baseline's own dir;
`compare --out` only clears an empty dir or one holding the `.ui-lab-compare` marker a
previous compare wrote. `--root <dir>` relocates `baselines/` and `compare/`.

**Threshold.** Two knobs, both 0 by default. `--pixel-threshold 0` is pixelmatch's
per-pixel colour tolerance: any channel change counts. (pixelmatch's own default of
0.1 was measured to pass real token changes: #666666 -> #808080, #1a1a1a -> #2a2a2a
and #fff -> #f3f4f6 all read as "same".) Anti-aliased pixels are still ignored.
`--max-pct 0` fails a shot when more than that % of its pixels differ. Both are 0
because the harness is deterministic (below), so any differing pixel is a real
change. A size change, added shot or missing shot always fails. Raise either knob
only for a known, accepted drift.

**Determinism result (2026-10-05).** Full app set (138 shots: 6 states x 3
viewports, `--no-remote-images`) rendered twice: 138 same, 0 differ. A 20-shot
set with remote artwork also matched. Re-run at the final 0 default: 138 same, 0 differ. No new nondeterminism source was found, so
nothing was changed in `walk.mjs`; the existing controls (pinned clock, seeded
`Math.random`, animations disabled, caret hidden, pinned audio position, fixed
locale/timezone/scheme) are sufficient. Sanity check that compare can fail: a
`--css` hue-rotate flagged 20/20 shots. **Record baselines with `--no-remote-images`**:
remote artwork passes through to the live network, so a changed or slow CDN image is
a diff your code did not cause. Baselines are also tied to the machine's Chromium
and fonts; re-record after upgrading Playwright or on a different OS.

## Fidelity: prototype vs implementation (`fidelity.mjs`)

How close is the build to the direction's prototype? Each direction carries a screen
map, `docs/redesign-2026/directions/<slug>/screens.json`: screen id -> the prototype route
-> the app's state and step in `lib/states.mjs` (`"app": null` = no equivalent in today's
app yet), plus per-region CSS selectors for each side (`"mode": "all"` = union of the
matches plus their count; default is the first visible match).

```
node tools/ui-lab/fidelity.mjs --direction tactile [--screens home,now-playing] [--viewports 393x852]
     [--run name] [--max-region-delta 4] [--against self] [--remote-images] [--scheme dark|light]
```

It shoots the prototype and the mapped app states through `lib/walk.mjs` (same viewport,
frozen clock, seeded `Math.random`, no remote images unless `--remote-images`), then writes
`data-local/redesign/fidelity/<run>/` (gitignored: renders are never committed):
`side/<screen>__<vp>.png` (prototype left, app right), `diff/` (pixelmatch overlay),
`shots/{prototype,app}/`, `report.json` and `report.md`. Per screen: a pixel-diff % (reuses
`lib/diff.mjs`; dominated by content, so read it only as "close at all") and, per region, the
position and size delta in CSS px (app minus prototype: dx, dy, dw, dh, plus count and
first-item size for `all` regions). A region found on one side only is reported, not dropped.
Regions are measured only if visible and inside the viewport. Screens with `app: null` are
listed as skipped.

Fidelity is judged, not thresholded: the exit code is 0 unless a walk failed. `--max-region-delta N`
makes it a gate (a region over N px, or present on one side only, fails; exit 1).
`--against self` re-renders the prototype as the "app" side: the sanity check that identical
input reads 0.

Sanity (2026-10-06, tactile, 393x852, no remote images): `--against self`, 19 screens, mean pixel
diff 0% and every region delta 0; against today's app, 15 mapped screens, mean pixel diff about
90%, with region deltas in the hundreds of px (Home hero 76.9px lower and 121px narrower, the
primary key 329px higher). Pure logic is tested in `fidelity.test.mjs` (no browser; floored).

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
| `returning` | saved episodes, Up Next, 3 playlists, followed shows, history | all of the above populated, plus playlist detail, show, episode, category, browse pill, a foray; then Settings, Tuning (the `interests` step) and About (Redesign 2026, ambient screen 9): `gear-sheet` (Today's gear opened), `what-4a-does` (its second Sheet), `settings`, `about`, `settings-dawn-chosen` (Dawn picked live; last, so it cannot colour the steps after it) |
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

## Hard-limit gates (`gates.mjs`)

Mechanical checks of PLAN.md "Hard limits", so every Phase 4 screen build is
measured before a judge looks at it. Same walker, states and stubs as `shoot.mjs`.

```
node tools/ui-lab/gates.mjs --target app --allow tools/ui-lab/gates-known-debt.json
node tools/ui-lab/gates.mjs --target url --url path/to/prototype.html --routes "#/,#/x"
# record today's violations as the known-debt list (re-run only when burning debt down)
node tools/ui-lab/gates.mjs --target app --no-remote-images --write-allow tools/ui-lab/gates-known-debt.json
```

Writes `data-local/redesign/gates/<run>/gates.json` + `report.md` (grouped by gate,
then screen). Exit 1 on any violation not in the `--allow` list (stale allow entries
are reported, not fatal: remove them as the debt is fixed). `--no-reduce` runs the
motion pass without reduced motion; it is calibration only and must find motion.
A full app run is about 5 minutes (46 screens, three viewports).

| Gate | Checks | Runs at |
|---|---|---|
| `errors` | console errors, uncaught `pageerror` | first viewport |
| `requests` | failed or >=400 same-origin requests (ignore list in `lib/gates/config.mjs`) | first |
| `csp` | `securitypolicyviolation` events (inline `style=`/script, `javascript:`) | first |
| `tap-targets` | every visible a/button/[role=button]/input/select/[tabindex>=0]/summary is hit-tested: a 5x5 grid over the 44x44 square centred on it, via `elementFromPoint`, must land on it (an `::after` extension counts, an overlapping neighbour does not); a box already 44x44 passes unless covered at its centre | first |
| `reduced-motion` | under `reducedMotion: reduce`, no animation/transition/`animate()` over 1 ms starts during a step, none running at the shot | first |
| `overflow` | geometry, not `scrollWidth` (styles.css clips html/body with `overflow-x: clip`, so scrollWidth always equals clientWidth): the outermost visible element whose box leaves the viewport, ignoring horizontal scrollers and anything clipped inside the viewport | every viewport |
| `sheet-focus` | an open `[role=dialog]`: focus moves in, 10 Tab presses stay inside, Escape (else its close control) closes it, focus returns to the opener | first |
| `contrast` | axe `color-contrast` | first |

First viewport = `393x852`. **Exemptions are explicit** in `lib/gates/config.mjs`: an
`<a>` that is inline *and* has sibling text (WCAG 2.5.8 inline exception), a
selector list (empty), the 1 ms "instant" motion floor, ignored same-origin 404s
(`deploy-manifest.json`, `data/forays-directory.json`: both built at deploy time),
and `SHEET_OPENERS`, which maps a dialog to its opener and close control. A dialog
with no opener (the first-run sheet opens on load) reports return-focus as
*unchecked*, never as a pass. The sheets covered today are Now Playing and the
first-run intro; add an opener row when a build adds a sheet.

**Proof the gates fire.** `fixtures/gates-fixture.html` (with the app's exact CSP
`<meta>`) carries one violation per gate; `--target url --url
tools/ui-lab/fixtures/gates-fixture.html --routes "#/,#/sheet"` reports all eight
gates and nothing for its exempt inline link. Its rule logic is covered by `gates.test.mjs`
(pure rule logic, no browser, floored).

### Today's debt (trunk, 46 screens, 2026-10-05): `gates-known-debt.json`, 119 entries

| Gate | Entries | What |
|---|---|---|
| tap-targets | 110 | `a.fy-chip` pills (63, about 35px tall), the `4a` wordmark link (41 screens, 24x25), 2 each of `button.fy-chip`, `input.interest-slider` (16px) and `button.fp-close` |
| overflow | 1 | `stress/episode-token` at 375x667: the page-head title block spans 72..389 (the unbreakable 100-character token) |
| contrast | 8 | Home's `.hv2-play-title` (2.48:1) and `.hv2-play-text` (2.72:1), on 4 states |
| errors, requests, csp, reduced-motion, sheet-focus | 0 | the app is clean today |

**First real-browser smoke of the 0d `app.js` split: clean.** Zero console errors,
zero page errors, zero CSP violations and zero failed same-origin requests across
all 46 screens, so the `ui/*.js` load order holds in Chromium, not only under `node:vm`.
The reduced-motion recorder saw 0 motion under `reduce` and 3 records with it off
(Now Playing slide, the intro panel), so the zero is a measurement, not a blind spot.
