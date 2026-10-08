# Tactile (Dial): build plan for phases 3 and 4

Art director's plan for building the Tactile direction as real app code on
`feature/redesign-2026-tactile`. `build-loop.md` is the procedure and wins on
procedure; `PLAN.md` holds the hard limits and wins on rules; `BUILD-NOTES.md`
holds the measurements and wins on numbers. This file holds the **decisions**
that are Tactile's alone: which token values ship, what the foundation tasks
produce, and the ordered screen list with the acceptance criteria each screen
agent builds to and each reviewer checks against.

Owner decisions (final, 2026-10-06, top of `DIRECTION.md`): Tactile is built;
the display, title and heading face is **Big Shoulders**; Cream (light) is the
primary scheme and Bakelite (dark) stays as an option; the review-only font
switcher and the dropped faces are gone. Nothing below reopens any of that.
Every further call here is the art director's; the owner is not consulted.

Shoot every Tactile render with `--scheme light` (then a secondary `--scheme
dark` pass at 393 only). Sample a background pixel before publishing: Cream is
`#F7F0E4`.

---

## 1. Foundation decisions (Phase 3)

Four tasks, in order, one branch each (`redesign/p3-tactile-tokens`,
`-sprite`, `-primitives`, `-gallery`), each merged into the direction branch
before the next starts (`build-loop.md` section 3).

### 1.1 Fonts and type (task: tokens)

Three self-hosted variable WOFF2 files under `fonts/`, Latin subset,
`font-display: swap`, `font-src 'self'`; nothing else is loaded.

| Role | Family (CSS name) | Source | File that ships | Budget |
|---|---|---|---|---|
| display, title, heading, every Find tile name, the onboarding brand | `"DialDisplay"` | Big Shoulders (2024 variable, opsz 10-72, wght 100-900), OFL 1.1 | `fonts/dial-display-latin.woff2`: the prototype's `big-shoulders-latin.woff2` **re-cut** with `fonttools` so `hhea`/`OS/2` ascent = 84% and descent = 24% of the em (`critique-r7.md` P3.1), instanced to wght 700-800 with the opsz axis kept | ≤ 60 KB |
| body, rows, labels, keycaps, chips, tags | `"DialText"` | Bricolage Grotesque variable, OFL 1.1 | `fonts/dial-text-latin.woff2`: instanced to wght 500-700, wdth 100, opsz at text sizes | ≤ 80 KB |
| readouts: clock, durations, counts, date, station codes | `"Azeret"` | Azeret Mono variable, OFL 1.1 | `fonts/azeret-mono-latin.woff2`, untouched | 26 KB |

**Why the renames.** A re-cut or instanced file is a Modified Version under
the OFL, and a Modified Version may not ship under a Reserved Font Name. Big
Shoulders' and Bricolage Grotesque's upstream licences carry their family
names as RFNs (the engineer confirms against the `OFL.txt` shipped with the
downloaded files and records the line in the PR); a renamed Modified Version
is compliant whether or not a given copy reserves the name, so the rename is
the rule either way. Azeret is not modified, so it keeps its name. The CSS `ascent-override: 84%;
descent-override: 24%` stays on the `@font-face` as well (Chromium and Firefox
honour it, WebKit ignores it; the re-cut file is what makes the iPhone build
match). The engineer checks the re-cut on a clamped title at 375/393/412: no
descender of "history" clipped, top or bottom (`critique-r7.md` "What must not
regress", the 120-strip check in `_measure-r7.cjs` is the pattern).

```css
@font-face { font-family: "DialDisplay"; src: url(fonts/dial-display-latin.woff2) format("woff2"); font-weight: 700 800; font-display: swap; ascent-override: 84%; descent-override: 24%; }
@font-face { font-family: "DialText";    src: url(fonts/dial-text-latin.woff2)    format("woff2"); font-weight: 500 700; font-display: swap; }
@font-face { font-family: "Azeret";      src: url(fonts/azeret-mono-latin.woff2)  format("woff2"); font-weight: 100 900; font-display: swap; }

:root {
  --font-display: "DialDisplay", system-ui, sans-serif;
  --font-text:    "DialText", system-ui, sans-serif;
  --font-mono:    "Azeret", ui-monospace, monospace;

  /* Big Shoulders r7 values (BUILD-NOTES 1.1, prototype tokens.css). No wdth axis: every width token is 100%. */
  --t-display-xl: 2.75rem;  --lh-display-xl: 3rem;     --w-display: 800; --wd-display: 100%; --tracking-display: 0.005em;
  --t-display:    2.25rem;  --lh-display:    2.5rem;
  --t-title:      1.625rem; --lh-title:      1.875rem; --w-title:   750; --wd-title:   100%; --tracking-title:   0.01em;
  --t-heading:    1.375rem; --lh-heading:    1.625rem; --w-heading: 750; --wd-heading: 100%; --tracking-heading: 0.01em;
  --wd-screen:    100%;     --tracking-screen: 0.005em;   /* "Today", "Find", "Yours" */

  --t-body-lg: 1.0625rem; --lh-body-lg: 1.5rem;    --w-body:  500;
  --t-body:    0.9375rem; --lh-body:    1.3125rem;
  --t-label:   0.8125rem; --lh-label:   1rem;      --w-label: 700;  --tracking-label: 0;
  --t-micro:   0.75rem;   --lh-micro:   1rem;      --w-micro: 600;
  --t-readout-lg: 1.75rem; --lh-readout-lg: 2rem;  --w-readout: 500;
  --t-readout: 0.8125rem;  --lh-readout: 1rem;
}
```

Rules that follow from the pick:

- **The weight ceiling is 800 on the display face and 700 on the text face.**
  The 700 ceiling in `BUILD-NOTES.md` 2.1 was Bricolage's curl, which Big
  Shoulders does not have; 800 is its display weight (`critique-r7.md` P3.1).
  `DialText` never exceeds 700. The mono station code under the needle keeps
  its 800.
- Hero title: `clamp(1.75rem, 7.2vw, 2rem)` at line-height **1.2**, max 3
  lines, `text-wrap: balance`; measured r7 at 375/393/412: hero 3/2/2 lines,
  card bottom 547/514/517 (the ≤ 540 rule is at 393, where it is 514). The
  three screen titles are one line at 375 ("Today" 98.5px). Now Playing title
  2 lines at 26px; Foray detail 4/3/3 at 44px. These are the numbers the
  Phase 4 agents hold.
- Role classes `.display-xl`, `.display`, `.title`, `.heading` set the family
  and their own weight/width/tracking tokens; `.tile--l .tile__name` takes the
  title role, every other `.tile__name` the heading role at 17/24; the
  onboarding brand takes the heading role. Sentence-length display lines set
  `text-wrap: balance`. `body` is `500 var(--t-body)/var(--lh-body)
  var(--font-text)`. Readouts set `font-variant-numeric: tabular-nums`. No
  `text-transform: uppercase`. Titles clamp with `-webkit-line-clamp` (2 in
  rows, 3 in Now Playing, 4 on Foray detail), never a fixed height. Body
  never below 15px; everything in `rem`.

### 1.2 Colour (task: tokens)

Both schemes ship exactly as `BUILD-NOTES.md` 2.2 lists them (Cream block on
`:root`, Bakelite under `@media (prefers-color-scheme: dark)
:root:not([data-theme="light"])` and again under `:root[data-theme="dark"]`),
`color-scheme: light dark` on `:root`, the override stored as `cp_theme`
through the storage shim with values `system | light | dark`. Accent roles:
persimmon is the listener's own (play, saved, chosen, followed), ultramarine
is what 4a authored (narration, bridges, the floor); never both on one
control. Segment enamels `--seg-c0..7`, index `hash(showId) % 8`, stable
app-wide; `--seg-narration: var(--ultramarine)`. `--scrim-np` 0.78 Cream /
0.72 Bakelite.

**Contrast test, parametrised over both schemes**, every pair in the
BUILD-NOTES 2.2 table, 4.5:1 for text and 3:1 for the UI rows, in the
rewritten `test/ui-tokens.test.js` (pattern:
`docs/redesign-2026/directions/ambient/contrast-check.mjs`). Mutation: lower
`--ink-3` to `#8A8278` and the Cream row fails.

### 1.3 Space, radius, size, material (task: tokens)

Verbatim from `BUILD-NOTES.md` 2.3 and 2.4: 4px base (`--s-1`..`--s-12`),
`--gutter` 16 at all three viewports, `--gap` 12, radii 8/14/22/pill, `--tap`
44, keys 48/56/80/96, rows 56/64/72, art 56/48/44/40, `--deck-h` and
`--mini-h` 64, safe-area tokens. Four materials: paper (0), card (1,
`--shadow-card`), keycap (2, `--lip` 3px, `--lip-pressed` 1px), well (inset,
`--well-inset`); deck (3, `--deck-tint` 84% + `--deck-blur` 20px, solid under
`prefers-reduced-transparency` and `@supports not (backdrop-filter)`).
`backdrop-filter` on exactly three things: the deck, the Now Playing header
while scrolled, modal sheets.

### 1.4 Motion (task: tokens)

The five tokens from `BUILD-NOTES.md` 2.5, verbatim: `--spring-snap` 220ms
(keycap release, chip toggle, badge tick), `--spring-settle` 320ms (tab
indicator, detents, list gaps, needle snap), `--spring-sheet` 480ms (Now
Playing open/close, modal sheets), `--ease-quick` 160ms (fades, colour),
`--d-draw` 280ms (band draw-in), with the `linear()` curves as written. Only
`transform` and `opacity` animate (the lip via `::after { transform: scaleY }`).
**One** `prefers-reduced-motion` block, the one in 2.5: durations to 1ms,
`--d-quick` 120ms, springs to `linear(0,1)`, `.keycap:active { transform:
none }`, `.band[data-draw]` no draw, `.sheet` opacity-only, view-transition
groups 1ms. Every animation or transition a later task adds (needle pulse,
skeleton shimmer, toast slide, arc draw, tint cross-fade, deck collapse) is
added to that block in the same change, and `test/ui-tokens.test.js` asserts
there is exactly one such block and that every `animation-name` and
`transition-property` in `styles.css` is named inside it.

### 1.5 Icon sprite (task: sprite)

One inline SVG sprite in `index.html`, referenced by `<svg class="i"><use
href="#..."/></svg>`; no text glyphs stand in for icons (`⋯`, `✓`, `+` and
`×` in the prototype's copy become the sprite's `dots-three`, `check`, `plus`,
`x`). Phosphor **Bold** at 24px (MIT), **Fill** only for the active tab and the
toggled bookmark/play states. Forty-one symbols, the prototype's exact set:

- Phosphor Bold (27): `ph-play`, `ph-pause`, `ph-sun-horizon`,
  `ph-magnifying-glass`, `ph-bookmarks`, `ph-caret-down`, `ph-arrow-left`,
  `ph-dots-three`, `ph-plus`, `ph-check`, `ph-check-circle`, `ph-cloud-slash`,
  `ph-bookmark-simple`, `ph-list-plus`, `ph-timer`, `ph-share-network`, `ph-x`,
  `ph-arrow-up`, `ph-arrow-down`, `ph-trash`, `ph-radio`, `ph-speaker-high`,
  `ph-moon`, `ph-sun`, `ph-list-bullets`, `ph-shuffle`, `ph-sparkle`.
- Phosphor Fill (7): `ph-play-fill`, `ph-pause-fill`, `ph-sun-horizon-fill`,
  `ph-magnifying-glass-fill`, `ph-bookmarks-fill`, `ph-bookmark-simple-fill`,
  `ph-check-circle-fill`.
- Custom marks on the same 24 grid, 2px stroke, round caps (7): `skip-15`,
  `skip-30` (arc with the numeral at 10/700 inside), `band` (three bars
  10/6/4 wide on a baseline), `needle`, `bridge` (two 4px dots joined by an
  arc), `narration` (two 3px ticks), `knob` (filled disc `cx 12 cy 11 r 8`,
  groove pointer `(12,11)`→`(7.4,6.4)` 2.5px in `var(--k-fill)`, end-stop
  dots r1.4 at `(4,20.5)` and `(20,20.5)`, **nothing above the disc**; the
  only sanctioned fallback is Phosphor `faders`, never a fourth knob).

Every icon-only button has `aria-label`; every decorative icon
`aria-hidden="true"`. Test: a sprite-integrity test asserts the 41 ids exist
once each and that no `<use>` in `ui/*.js` points at an id outside the set
(mutation: rename `knob` to `dial` in the sprite and the test fails).

### 1.6 Primitives (task: primitives)

One treatment each, every state (default, pressed, focus-visible, disabled,
loading, and offline-blocked where it applies), measured from
`BUILD-NOTES.md` section 3: keycap (`sm` 44 / `md` 48 / `lg` 56 / `xl` 80 /
`glance` 96; `persimmon`, `ultramarine`, `rubber`, `paper`; lip 3→1 and 2px
drop on press on `--spring-snap`; 2px ultramarine focus ring at 2px offset),
text button, chip (36, selected = ink fill + check icon) and tag (24;
`stretch`, `narration`, `downloaded`, `played`), card, well, **band** (`mini`
8 / `detail` 44 / `scrub` 56, codes per **run** ≥ 24px, two-layer progress
via `<clipPath>`, needle 2px + 4px head, hatch 3/3 at 45°, `role="img"` on
cards and `role="slider"` in Now Playing), gauge, bridge card, rows
(`.row-show` 56, `.row-episode` 72/92, `.row-queue` 64, `.iconbtn` 44),
mosaic tile (`s`/`m`/`l`), deck + tab row, mini player, sheet (grabber 36×5,
`aria-modal`, inert background, focus in/trap/restore), rotary chip,
skeleton (inner shapes, two tones), empty state (the 96px radio mark, the only
illustration), toast (48, `role="status"`). Each primitive renders only from
data through `esc()`/`safeUrl()`; markup lives in `ui/primitives.js`, nothing
in `index.html` beyond the sprite and the shell.

The band is the riskiest primitive: prove it first against real
`data/forays.json` items at 375/393/412, in both schemes, with the un-narrated
case (`BR BR` must not appear; the r5 `bandHTML()` per-bar gate is the bug
to avoid, `critique-r5.md` has the run-grouping code).

New suites and their mutations (each gets a `FLOORS` line in
`test/suite-integrity.test.js` in the same PR):

| Suite | Pins | Mutation that must fail it |
|---|---|---|
| `test/tactile-keycap.test.js` | sizes, variants, lip, disabled/offline-blocked state, 44px floor, no nested interactive | set `sm` to 40px |
| `test/tactile-band.test.js` | rect widths proportional to runtime, one code per run, ≥ 24px gate on the run not the bar, current run by index range, progress clip, `aria-valuetext` format, no hatch in `mini` | gate the label on the bar width instead of the run width (the `BR BR` regression) |
| `test/tactile-rows.test.js` | row heights, one trailing keycap, `+ Up Next` on the meta line, display-name rule, meta wrap after the show name at ≤ 393, `min-width: 112px` | drop the display-name strip of ` - …` |
| `test/tactile-deck.test.js` | three tabs, no drawer, badge only when Up Next non-empty, collapsed height 48, content padding formula, mini is one region with sibling keycaps | nest the Play keycap inside the mini body button |
| `test/tactile-sheet.test.js` | focus moves to the container, traps, restores to the opener; `aria-modal`; Escape closes | focus the first button on open |

`test/ui-tokens.test.js` is REWRITE-ON-PURPOSE and is rewritten in the tokens
PR, which names the rulings that fell: **U-01 dark-only** (two authored
schemes), **palette and type** (persimmon/ultramarine on cream; Big Shoulders +
Bricolage + Azeret), **card anatomy** (four materials replace seven radii and
four elevations), **no zoom** (`user-scalable=yes` restored in `index.html`,
`touch-action: manipulation` only on controls where double-tap conflicts).
**D3 (4 tabs + drawer)** falls in the primitives PR with the three-tab deck
and the knob button. The rewrite must still guarantee what
`test-classification.md` says it must (CSP, self-hosted fonts, the single
reduced-motion block, AA contrast).

### 1.7 Gallery (task: gallery)

`#/gallery` under `window.__FORAY_LAB__` or `?gallery=1`, never reachable in
production; every primitive in every state, both schemes stacked (Cream then
Bakelite via `data-theme`), plus a type specimen (the ten roles on real
strings: "Today", the r7 fixture hero title, "Podcasts, lined up around
you.") and the contrast table rendered as text on swatch. (**Hard-limit
override, 2026-10-07:** the direction's "Podcasts, stitched around you." is
refused by the stitching rule in `test/listener-copy.test.js`, the
2026-08-11 playback ruling and product principle 3, which no direction may
challenge; "lined up" is the specimen and the onboarding headline in 4.x.
`test/tactile-gallery.test.js` scans the rendered gallery for it.) Add the `gallery`
state to `tools/ui-lab/lib/states.mjs`, then shoot, gate, record
`tactile-gallery`, judge it once against the prototype's `#/home` and
`#/now-playing` (fidelity pair only), and record the rolling `tactile-app`
baseline. Phase 3 exits on green suites, green gates, both baselines recorded
and a `PROGRESS.md` line.

---

### 1.8 Tokens as built (`redesign/tactile-p3-tokens`)

What the first foundation task actually shipped, and the calls it made where
this plan met the live repo. Where this section and 1.1-1.4 differ, this
section wins.

- **Where it lives.** One section of `styles.css`, headed `DIAL (TACTILE)
  FOUNDATION TOKENS`, immediately above the reduce-motion block (which stays
  last). Three faces in `fonts/` built by `tools/fonts/build-dial-fonts.py`
  (`dial-display-latin.woff2` 34.8 KB, `dial-text-latin.woff2` 58.4 KB,
  `azeret-mono-latin.woff2` 26.2 KB; the plan's budgets were 60/80/26),
  notices in `fonts/LICENSES.md`. Wired into `tools/ci/crlf-guard.mjs`
  (`BINARY_LISTED`); the deploy manifest and the web dist derive the font list from
  the directory. **Not added to the mobile bundle's `SHELL_FILES` yet**: no live rule
  paints with them so a browser never requests them, and their 119 KB would push the
  bundle over its 2.85 MB alarm (`prepare-webdir.test.mjs` assertion A, 2.93 MB
  with them). The first adopting screen's PR lists them there and retires legacy
  faces to make room. No `<link
  rel=preload>` yet: nothing paints with them until a screen adopts the system.
  The upstream `OFL.txt` of Big Shoulders and Bricolage Grotesque reserve no
  font name (checked 2026-10-06); the renames hold either way.
- **The re-cut is verified in the bytes.** `test/ui-tokens-dial.test.js` reads
  the shipped WOFF2 (Node's zlib has brotli) and asserts hhea, OS/2 typo and
  win metrics are 84% / 24% of the em, the axes are wght 700-800 + opsz 10-72
  (display) and wght 500-700 + opsz, no wdth (text), and the family names.
- **Name rule: twelve tokens ship as `--dial-<name>`.** The live sheet owns
  `--line`, `--font-display`, `--seg-c0..7` and `--seg-narration`, and every
  page is `body.ui-v2`. Declaring the BUILD-NOTES names would either repaint
  the app (`--font-display`) or be dead under the legacy owner (`--seg-c*`,
  `--line`). So: `--dial-line`, `--dial-font-display`, `--dial-seg-c0..7`,
  `--dial-seg-narration`. **Phase 4 agents porting prototype CSS rename those
  three families as they port** (`var(--line)` -> `var(--dial-line)`,
  `var(--font-display)` -> `var(--dial-font-display)`, `var(--seg-cN)` ->
  `var(--dial-seg-cN)`); every other name is verbatim. When the last screen
  that reads a legacy name is gone, drop the prefix with one rename. The test
  fails on any new collision and on any gratuitous prefix. `--gutter` (16) is
  the plan's value and already on the legacy `:root`, so it is not declared a
  second time. The plan's `--draw-band` easing is `--ease-draw` here (the
  prototype's name).
- **Screens are untouched.** No live rule reads a Dial token and no live
  markup emits a Dial class (`.display-xl`, `.display`, `.title`, `.heading`,
  `.readout`, `.readout-lg` are new names). Verified: `baseline.mjs compare
  --name trunk-app` (138 shots, dark, the recorded baseline) 138 same, 0 differ;
  the same set shot `--scheme light` before and after: 138 same, 0 differ.
  Because of that, the legacy half of `test/ui-tokens.test.js` still describes
  what the app paints and **is not deleted**: its ownership checks now judge the
  sheet without the Dial section (a legacy rule that reads a Dial token is a
  screen adopting early and fails there). The rulings this plan lists as
  falling with the tokens PR (U-01 dark-only, palette and type, card anatomy)
  therefore fall **in the PR of each screen that adopts the system**, which
  retires the legacy pin for the token it stops reading; the Dial scheme tests
  are the new guarantee. Not done here, because they change live behaviour and
  not pixels: restoring `user-scalable=yes` and the `zoomEnabled` shell setting
  (the **no-zoom** ruling; it is a whole-shell switch, so it lands with the
  first screen that flips the shell, Now Playing), and the `cp_theme` storage
  key with its Settings control (it adds a `cp_` key that `data-deletion` and
  `engine-contract` inventory; it lands with the settings screen). The token
  layer already honours `data-theme` on `<html>`.
- **Open item for the first screen PR (Now Playing).** During Phase 4 the shell
  is `body.ui-v2` (dark, Fraunces) until the last screen adopts, so the first
  adopting screen decides the page-level switch that lets a Dial screen own its
  own `background`/`color` inside that shell (a scope class on its root that
  paints `var(--paper)` / `var(--ink)`). It is not decided here.
- **Two measured corrections to the BUILD-NOTES colour table** (the test
  computes every ratio from the declared hex; the table's rounded figures were
  not all true). Cream `--ink-3` `#6F675D` -> `#6C645A` (it was 4.49:1 on
  `--paper-2`, under AA for the secondary text that sits on wells and bands;
  now 4.70:1, 5.14:1 on paper). Cream `--dial-seg-c3` mustard `#B8860B` ->
  `#A67A08` (2.63:1 on the well, under the 3:1 the table claimed for every
  enamel; now 3.14:1, still mustard). Bakelite is untouched; every other pair
  clears its threshold as written.
- **What the motion test guarantees.** One `prefers-reduced-motion` block in
  the whole sheet, last; it carries the plan's rules verbatim; every
  `transition`/`animation` in the sheet either reads only `--d-*` durations (the
  block collapses them) or is stilled by name in the block. The Dial layer has
  no transition of its own yet, so that half cannot fail on today's data; it is
  there for the keycap, band, sheet and needle tasks.

---

## 2. Screen list (Phase 4), in build order

Order per `build-loop.md` section 4: Now Playing first, then Today, Find,
Yours, Foray detail, Onboarding, then the rest in `lib/states.mjs` order.
**Decision: a screen's sub-states are built in the parent screen's loop**, by
the same agent on the same `redesign/p4-tactile-<screen>` branch, because they
share one `ui/*.js` file and no two agents may own one file. Each sub-state
is still its own `screens.json` row, shot and judged on its own; the fidelity
command for a loop lists every id in its group. Ids below are the
`screens.json` ids (`fidelity.mjs --screens`). Rows that `screens.json` maps
to `app: null` are **not skipped** (`build-loop.md` section 8): the agent
appends the named state or step to `appStates()` first, repoints the row, and
the harness reaches it before the first shoot.

Two existing rows are mis-pointed and the Now Playing agent fixes them:
`now-playing-paused` and `now-playing-episode` both point at the `player`
state's `now-playing` step; they get their own appended steps (section 2.2
and 2.3).

Every screen also holds, without being listed again under each: `esc()` on
every interpolation, `safeUrl()` on every href/src, no inline `style=`, 44px
targets, the one reduced-motion block, AA contrast in both schemes, no
horizontal overflow at 375/393/412, copy rules (why ≤ 18 words, hooks ≤ 16,
banned words, no we/us/our, "subject"), every new test with a named and run
mutation, gates green against `gates-known-debt.json`, fidelity region deltas
≤ 4px unless the prototype explains them, and acceptance by three judges on
both pairs.

### Group A: Now Playing (branch `redesign/p4-tactile-now-playing`, file `ui/now-playing.js` + `ui/mini.js`)

#### 2.1 `now-playing`: Now Playing (foray)  (app: `player` / `now-playing`)

1. The sheet's background is `--np-tint` = the `--seg-cN` enamel of the show
   under the needle, under `--scrim-np`, edge to edge, with a radial fade to
   `--paper` over the bottom 60%; crossing into another show's bar
   cross-fades the tint over `--d-sheet` (`@property --np-tint`); the runtime
   check raises the scrim alpha to 0.9 when ink over `mix(tint, scrim)` is
   below 4.5:1. Test: a tint of `--seg-c3` (mustard) in Cream passes at 0.78;
   a forced `#FFD400` tint forces 0.9.
2. Artwork (`.np__art` → app `.fp-s-art`) is 280px square `--r-lg` with
   `--shadow-card` at 393×852, 200 at 375×667, 160 whenever the title takes 3
   lines; the title is `DialDisplay` 1.625rem/1.875rem 750 clamped at 3 lines
   with `text-wrap: balance` (2 lines for the fixture at every width), show
   15/500 `--ink-2`, chip row 8px below showing the station chip (10px
   `--seg-cN` swatch + code + name) on a bar and the "4a narration" tag on a
   tick.
3. The scrub band is 56px hit / 28px bars, full width, station codes once per
   run ≥ 24px (no doubled code at 412), the current run's code `--ink` 800,
   needle 2px with a 44px-wide hit area, `role="slider"` with
   `aria-valuetext` "12 minutes 40 of 48 minutes, {show}" updated on change
   only; drag snaps to segment boundaries within 12px and shows the
   `.band-bubble` (`show · 12:40`); arrows seek 15/30s, up/down by segment.
   Readout row: elapsed `.readout-lg` left (tracking −0.05em, colon span
   `margin: 0 -0.06em`), remaining mono 13 right.
4. Transport is `position: sticky; bottom: calc(safe-b + 16)`: skip-15
   keycap 56 rubber round · Play 80 persimmon round · skip-30 56, gaps 24; the
   Play centre sits at ≤ 72% of the viewport height and is never below the
   fold at 375×667. Secondary row 16 below: rotary chip `1.0×`, rotary chip
   `Sleep · Off`, bookmark paper keycap `sm`, Up Next paper keycap `sm` with
   `list-bullets` 20 and an 18px ultramarine badge at `top:-4px; right:-4px`,
   `aria-label="Up Next, N queued"`, opening the queue in Yours. Two chips
   then two keys, three silhouettes never.
5. `.np__top` has `min-height: calc(100% - 176px - var(--safe-b))` so the
   "Up next" heading peeks 24px above the dock at rest and its card is below
   the fold; scrolling reveals Up next (art 56, title, why-line, readout),
   "Segments" grouped by slot (heading 17, rows 56, `narration` tags), "Where
   this came from" (`.row-show` per show with its swatch and code),
   "Chapters" (48px rows, tap seeks), "Show notes" (4 lines + More,
   sanitised). The transport stays pinned throughout.
6. Opens from the mini on `--spring-sheet` with the artwork as the shared
   element (`view-transition-name: np-art`; WAAPI FLIP fallback), the mini's
   3px line stretching into the scrub band, drag-to-dismiss finger-tracked
   with the 30% / 0.5 px/ms thresholds, interruptible both ways; `aria-modal`,
   background inert, focus to the Play keycap on open and back to the mini
   body on close; a 44px "Collapse" button top-left. Haptics (Web+) per
   BUILD-NOTES 6 through a no-op shim on the web build, throttled to one
   call per 100ms; Media Session metadata per BUILD-NOTES 7.

#### 2.2 `now-playing-paused`: Now Playing, paused  (app: append step `now-playing-paused` to `player`)

1. New step: open the sheet, press Play once, ready when `#foray-player
   .fp-play[aria-label="Play"]`; `screens.json` repointed to it.
2. The Play keycap shows `ph-play-fill` and `aria-label="Play"`; the needle is
   static (no `animation`), the elapsed readout keeps its value (no "…").
3. Pixel-identical to 2.1 except the primary region: `baseline.mjs compare`
   diffs only inside `.fp-play`'s box (mutation: swap the pause glyph for the
   play glyph in the playing state and the paused test's inverse fails).
4. Buffering (prototype `#/now-playing/buffering`, no `screens.json` row;
   the agent may add one): needle pulses opacity 1→0.4 at 1s inside the
   reduced-motion block, elapsed shows "…".

#### 2.3 `now-playing-episode`: Now Playing, episode  (app: append step `now-playing-episode` to `player`)

1. New step: start playback of a plain episode (not a foray), open the sheet;
   `screens.json` repointed.
2. Tint from a 32×32 offscreen canvas average (crossOrigin anonymous) in
   linear light → OKLCH: chroma < 0.07 falls back to the show's enamel,
   lightness clamps to 0.45-0.6, chroma floors at 0.10 then walks down only
   as far as sRGB needs; cached under `cp_art_tint:{showId}` with the URL
   hash via the storage shim; a CORS failure uses the enamel. Test: a
   grey-mauve sample (`oklch(0.5 0.05 320)`) yields the enamel; a dark purple
   with chroma 0.08 yields chroma exactly 0.10 after the floor.
3. The band is a plain persimmon fill with 1px `--ink-3` chapter ticks when
   chapters exist, no station codes, no hatch; the chip row carries only
   `downloaded` / `played` tags; the detail posture shows Up next, Chapters
   and Show notes and no Segments or Where-this-came-from.
4. Media Session artwork `sizes` 96/128/192/256/384/512 from the same URL
   through `safeUrl()`, `artist` = show, `album` = the why-line.

#### 2.4 `mini`: Today with the mini player  (app: `player` / `mini-player-home`)

1. The deck is fixed, `left/right: 16px`, `bottom: calc(var(--safe-b) +
   12px)`, `--r-lg`, `--deck-tint` + `backdrop-filter: var(--deck-blur)`,
   `--shadow-deck`; opaque under `prefers-reduced-transparency` and
   `@supports not (backdrop-filter: blur(1px))`.
2. The mini (`#mini` → app `#foray-player`) is 64px: artwork 44 `--r-sm` at
   10px inset, title 15/700 one line ellipsised, show 13 `--ink-2`, Play
   keycap 48 persimmon round, 30-forward keycap 44 paper, a 3px `.band--line`
   along the top edge in the foray's enamels (persimmon for an episode); a
   1px `--line` separates it from the tab row.
3. `role="region" aria-label="Now playing: {title}, {show}"`; the body
   (artwork + text) is one ≥ 44px button that opens the sheet; the keycaps
   are siblings, never inside it; swipe-down > 60px on the body dismisses
   with a HEAVY haptic and a 5s undo toast; horizontal swipes do nothing.
4. Tab row 64 → 48 on scroll-down > 24px (labels fade on `--d-quick`,
   back on any scroll-up; scroll-driven behind `@supports
   (animation-timeline: scroll())`, else a 100ms-throttled listener); three
   tabs Today / Find / Yours with Bold icons inactive, Fill active, a 32×4
   persimmon indicator sliding on `--spring-settle`; the Yours badge
   (ultramarine, 18px, mono 11) only when Up Next is non-empty.
   **Built (group A `mini`, decisions the loop made):** (a) the collapse is the
   100ms-throttled scroll listener on every engine, not an
   `animation-timeline: scroll()` branch behind `@supports`: a scroll timeline
   maps a POSITION to a state, and the rule here is about DIRECTION (the deck
   must return on the first upward flick deep in a list), which it cannot
   express; the listener is one passive handler with a trailing call and CSS
   does the motion on `--d-quick` (`ui/tabbar.js` `deckCollapseStep`). (b) The
   deck is two fixed boxes that meet, `#tab-bar` (row, bottom `safe-b + 12`) and
   `#foray-player` (mini, flush on the row over a 1px `--dial-line`), not one
   `.deck` parent: `#foray-player` is also the full-screen Now Playing sheet,
   and a parent carrying the deck's `backdrop-filter` becomes the containing
   block of its fixed descendants and would trap the sheet in a 361x129 box;
   the deck's one shadow is the row's `::after`, sized to both halves. (c) Create
   has no tab: `#/create` and the subject queues light Find, saved playlists
   light Yours (`tabForHash`), and the legacy drawer entry reads "Find" until
   the Today/Yours knob replaces the drawer. (d) Swipe-down defers the close:
   for the 5s the mini is hidden and playback paused; Undo restores both,
   and only the timeout stops the player (through `ForayPlayer.stop()`, which
   keeps the resume point).
5. Content `padding-bottom: calc(var(--deck-h) + var(--mini-h, 0px) +
   var(--safe-b) + 24px)`: the last "Also today" row's bottom edge clears the
   mini at 393×852; the keyboard hides the deck (the Find field stays).
6. Fidelity regions header / hero / primary / rows / mini / tabBar within
   4px; `test/up-next-autoadvance.test.js` green (continuous playback kept).

### Group B: Today (branch `redesign/p4-tactile-home`, file `ui/home.js`)

#### 2.5 `home`: Today  (app: `returning` / `home`)

1. Header: "Today" `display-xl` in `DialDisplay` 800 at `--wd-screen`, one
   line at 375; the date as mono readout 13 `--ink-2` 8px below ("Mon 5
   Oct"); the knob keycap (44, paper, `knob` mark) top-right, its centre
   within 1px of the title's cap centre, opening Settings.
2. Hero card `--r-lg`, padding 20, in this order with these gaps: eyebrow tag
   "Today's foray" (narration style) → 10 → title `clamp(1.75rem, 7.2vw,
   2rem)`/1.2, 3 lines max, balanced, as a link → 12 → `band--mini` 8px full
   width → 10 → three show discs 40 overlapping by 12 + readout "about 22 min
   · 4 shows" → 12 → why-line body-lg 500 `--ink` → 16 → Play keycap 80
   persimmon round + "Details" paper 48. Hero bottom ≤ 540px at 393 (r7:
   514). The card is not a link; title and keycap are separate targets.
3. "Also today" (heading 1.375rem): three `.row-episode` rows at 92 with
   why-lines, one trailing Play keycap `sm` each, "+ Up Next" as the meta-line
   text action (44px tap via `::before`, "✓ Queued" in `--good` for 2s after);
   one of the three is the `.bridge` card: bridge sentence first as the
   headline (body-lg 600, ≤ 16 words, names both subjects), then the
   `48px 1fr 72px` grid, arc `M2 30 C 22 -6, 78 -6, 98 20` 2.5px ultramarine
   drawn on `--d-draw` with 3px dots at `(2,30)` and `(98,20)`, then the
   `stretch` tag and the row meta. The Stretch slot is always present.
4. "Playlists for you": 2-column composite cards (96 2×2 art, name 15/700,
   readout "4 episodes · 2 of 4 played", 4px progress well). "New ground":
   the gauge in a card, 24px well, `--line` bar, ultramarine hatch to ~0.33,
   needle cap 10px above the well, "New ground" heading left and `1 in 3`
   mono right, caption exactly "About a third of today sits outside your
   usual subjects. 4a keeps it that way.", `role="img"`, no input, no focus.
5. Section order Resume (mid-listen only, 124px card with the persimmon
   "Resume" tag, art 80, 4px progress + "12 min left", the mini's 48 key) →
   Today's foray → Also today → Playlists for you → New ground; no "Suggested"
   heading anywhere; `test/home-v2.test.js`'s floor assertion stays green on
   the new markup.
6. Fidelity regions header / hero / primary / rows / tabBar within 4px at
   375/393/412 in Cream; Bakelite holds by eye at 393.

#### 2.6 `home-first-run`: Today, first run  (app: `empty` / `home`)

1. No Resume card; the hero's why-line slot carries "4a starts with wide
   bets. Each listen narrows the dial." and no "Because you follow…" line
   exists anywhere on the page (test: the string "Because you follow" is
   absent from the rendered first-run DOM).
2. Also today why-lines are subject-based: none contains "your usual" or
   names a followed show.
3. The bridge card's known slot shows a subject tile (no known artwork
   exists yet); the arc and both dots still render.
4. The gauge still renders with the same copy: the floor is kept, not
   earned (mutation: hide the gauge when history is empty and the test
   fails).

#### 2.7 `home-offline`: Today, offline  (app: null → new state `offline`)

1. New state `offline` in `appStates()`: seed `returning`, after load
   `context.setOffline(true)`, steps `home` (route `#/`) and `foray`; the
   `screens.json` row repointed to `offline` / `home`.
2. Every Play keycap for an undownloaded item takes the offline-blocked
   state: fill `--paper-2`, lip `--line`, text `--ink-3`, `cloud-slash` icon
   + label "Needs a connection", `aria-disabled="true"`, no depress on press.
3. Downloaded items keep a live Play keycap and show the `downloaded` tag
   (check-circle 14 `--good`, `aria-label="Downloaded"`, the word visible
   in this state).
4. A row whose meta cannot fit (the downloaded mark at ≤ 393) wraps after
   the show name: name alone on line one, `35 min ✓ + Up Next` together on
   line two; "+ Up Next" never sits alone on a line (test at 393).
5. Fidelity regions within 4px of `#/home/offline`.

#### 2.8 `home-loading`: Today, loading  (app: null → new state `loading`)

1. New state `loading`: seed `returning`, the catalog/today fetch routed
   through a Playwright `page.route` that holds the response until the shot
   is taken; ready selector `.skel`; `screens.json` repointed.
2. Hero skeleton at the real positions inside a `--paper-2` card: eyebrow
   pill 24×112, three title lines 28px at 88/80/40%, the band as an 8px pill
   well, three 40px discs overlapping by 12 plus a 120×13 bar, two why-lines
   17px at 96/72%, an 80px circle and a 48×96 pill; its outer height equals
   the loaded hero's within 4px (so nothing jumps).
3. Row skeleton: 56px square, two title bars 90/60%, one 13px meta bar at
   50%, a 44px square right; playlist card: 96px square and two bars; all
   shapes `--line` on `--paper-2`.
4. Shimmer is opacity-only at 1.2s and named in the one reduced-motion block
   (static there); the region carries `aria-busy="true"` and the skeleton
   `aria-hidden="true"`.

### Group C: Find (branch `redesign/p4-tactile-search`, file `ui/search.js`)

#### 2.9 `search`: Find, idle  (app: `search` / `search-idle`)

1. "Find" `display-xl` one line at 375 (r7 ~96px) with the readout line
   "Type any subject and 4a builds a playlist" (label 13/500 `--ink-2`) in
   the date's slot; no separate "Name a subject" keycap exists.
2. The field (`#field` → app `#sh-compose`) is `position: fixed` at `bottom:
   deck + 12`, 52px, card fill, `--shadow-deck`, `--r-pill`, 16 padding,
   magnifier icon, placeholder "Search, or name a subject", a 44px clear
   button hidden until text; when the keyboard opens the deck hides and the
   field docks to the keyboard.
3. The mosaic: about 14 `.tile`s on a 2-column grid, gap 12, in `s` (1×1,
   ~170×120), `m` (2×1, min-height 120) and `l` (2×2, min-height 196, 2×2
   collage of 88 right-aligned, text column vertically centred); every tile
   name in `DialDisplay` (`l` at the title role, the rest at 17/24), the
   count as one mono readout ("14 shows"); size by subject weight; no two
   neighbours from one branch; fixed count, no infinite scroll, a "More
   subjects" paper keycap at the end swaps the set.
4. The mosaic is shuffled under the exploration floor: a test over the
   seeded profile asserts ≥ 30% of tiles sit outside the listener's own
   subjects (mutation: sort tiles by affinity and it fails).
5. "Followed shows" strip (72px items, art 64, name 12/600 clamp 2, no
   mid-word breaks, "Lingthusiasm" not clipped at the gutter) renders only
   when the listener follows something; absent in the `empty` seed.
6. Fidelity regions header / field / rows / tabBar within 4px.

#### 2.10 `search-typing`: Find, typing  (app: `search` / `search-results-history`)

1. Results replace the mosaic live as the query changes: "Shows" (`.row-show`
   56), "Episodes" (`.row-episode` 72), "Playlists" (cards), each heading 17
   with a count readout; the clear button is visible at 44px.
2. A final "Make a playlist about '{query}'" ultramarine keycap row carries
   the `sparkle` icon, never the bridge mark; the query is interpolated via
   `esc()` (test with `<b>x</b>` as the query).
3. Rows trail one Play keycap `sm` and carry "+ Up Next" on the meta line;
   the show name has `min-width: 112px`, the display-name rule applies, and
   seven of eight fixture names survive at 393 without ellipsis.
4. Fidelity regions within 4px of `#/search/typing`.
   **Built (group C `search-typing`, decisions the loop made):** (a) The typing
   screen is shot after the return key (`search-results-typing`, appended to the
   `search` state: type, press Enter, so the field lets go): a field that still
   holds focus hides the deck for a keyboard a headless page never raises, which
   is the right behaviour on a phone and the wrong state to compare with a
   prototype drawn with the deck up. `search-results-history` is unchanged and
   still the focused state the gates walk. (b) The closing key is last whether
   or not a playlist matched; the gate that decides when to offer it (the scorer
   can build one) is unchanged, so it still arrives on the idle scan, after the
   cards. (c) The episode row is `searchEpisodeRow` (ui/search.js) on the shared
   controls: the Play key is a `data-play` keycap sm (the player swaps its `<use>`
   icon, `paintCardControl`), "+ Up Next" is `upNextBtn` verbatim on the meta line.
   It drops what the prototype's row has not: the star, the date, the link on the
   show's name (a plain name, one tap from the title's episode page) and the first
   words of the description. Those are the row/card anatomy ruling (visual pass 1,
   2026-09-23) falling for this list, and the founder's 2026-10-03 request for the
   description under every title; the owner's Tactile pick draws search rows
   without them and the 4px bar is measured against that. (d) The show name has
   `min-width: 112px` and basis 112, so it takes what the length and the action
   leave and ellipsises last; the pair wraps to a second line together only when
   not even 112 fits beside them (375 wide, a long length, the "played" mark),
   never "+ Up Next" alone. At 412 the row is one line; at 393 and 375 the pair
   wraps (rows +16px; review fix 2026-10-08 restored the 112 floor after iteration 3 had
   dropped it to 96 to keep 393 on one line with the 48 key). (e) `tactileDisplayName` also drops a trailing generic
   noun ("Podcast", "Philosophy Podcast") when something real is left: BUILD-NOTES
   3.9's own example ("The Partially Examined Life") needs it and the prototype's
   `shortShow` does it. That is a primitive change: the gallery `*-rows` shots
   differ (the queue specimen's "The Moreish Podcast" reads "The Moreish") and the
   gallery baseline needs a re-lock after this merges. (f) A settled "No shows
   found" line (`#sh-note[data-state="empty"]`) gives way when Episodes, Playlists
   or Forays answered: the absent Shows group says it, as in the prototype; "Searching
   for ..." always stays. (g) "Make", not "Create": the prototype's word.

#### 2.11 `search-none`: Find, no results  (app: `search` / `search-no-results`)

1. Heading "No shows match '{q}'." then, when a subject matches, "{Subject}
   has {n} shows." with that subject's tile below as a filled
   `--ultramarine-soft` tile (never an outline); otherwise only the "Make a
   playlist about…" keycap. Never a bare sentence.
2. The sentence never contradicts the tile: the test asserts the named
   subject's count equals the rendered tile's count readout.
3. `{q}` through `esc()`; the copy passes `backend/test/copyRules.test.ts`
   ("subject", no banned words).
4. Fidelity regions within 4px of `#/search/none`.
   **Built (group C `search-none`, decisions the loop made):** (a) The screen is
   shot after the return key (`search-no-results-subject`, appended to the `search`
   state), for the reason `search-typing` gave: a field that still holds focus hides
   the deck. The query is "instrument", which finds no show in the lab's index and
   names one subject with shows; `search-no-results` ("zzqxjv", field focused) stays
   as the no-subject case the gates walk. (b) A subject matches when every word of the
   query is in its label (best: the label is the query, then starts with it, then
   contains it, then more shows) AND it holds shows of its own: the count is
   `showsForCategory(id).length`, so the sentence, the tile and the page behind the
   tile cannot disagree. A taxonomy root almost never carries a show itself, so
   "Science" keeps the existing "Shows filed under" chips instead of a tile.
   (c) The tile opens `#/category/<id>`, not `#/shows/q/<label>` (the prototype's
   tile is a search for its label): that search can itself find nothing, which would
   put the same tile on screen again. (d) The key is offered whatever the playlist
   scorer says. `createPlaylistCtaHtml`'s gate belongs to the results list, where an
   offer the scorer cannot meet would be a lie under real rows; here the alternative
   is a bare sentence, which the acceptance forbids, and Create answers for a query it
   cannot build from. When the scorer's own closing key arrives too, CSS draws one:
   this one, in the heading's 12px column. (e) When Episodes, Playlists or Forays
   answered, the heading (already hidden by `search-typing`'s rule), the sentence, the
   tile and this key all give way, and the box leaves layout (an empty flex item still
   took the page's 32px gap). (f) The heading is `textContent`, never markup; the
   offer writes the query and the subject's label through `esc()`. The offline line
   ("You're offline — no shows found for “q”.") is unchanged and keeps the offer
   under it. Fidelity `search-none-i5` (Cream): header, field, heading, sentence, tile,
   key and tab bar are all 0.0px at 393x852, 375x667 and 412x915.

### Group D: Yours (branch `redesign/p4-tactile-library`, file `ui/library.js`)

#### 2.12 `library`: Yours, Up Next  (app: `player` / `mini-player-library`)

1. "Yours" `display-xl` one line at 375 with the knob keycap right and the
   readout line for the selected chip ("5 queued · 4 hr 55 min"); chip strip
   `role="tablist"`, horizontal scroll, 36px chips, 8 gap, 16 gutters:
   Forays, Shows, Saved, Playlists, Up Next (badge), History; the selected
   chip is ink fill + paper text + check icon.
2. `.row-queue` 64: position readout mono 13 `--ink-3` 20px wide, artwork
   48, title 15/700 (2 lines), show + remaining 13, trailing `⋯` as
   `.iconbtn` 44 (no face, no lip; keycaps are for playback and collection
   actions only).
3. The current row: `--persimmon-soft` fill, the needle icon replacing the
   position number, tag "Playing" (persimmon 12/700 + needle 14), meta
   "Playing · 42 min left" with no show name; the played row jumps to the top
   (ruling kept).
4. `⋯` expands a 48px action row beneath on `--spring-settle`: Move up, Move
   down, Remove as paper keycaps `sm` with labels, exposed as buttons to AT;
   reorder swaps rows via translateY, no drag handles; Remove shows the 4s
   undo toast (2.16).
5. "Clear" is a paper keycap `sm` with a confirm sheet (focus in, trapped,
   restored); 8-10 rows visible at 852.
6. Fidelity regions header / rows / mini / tabBar within 4px.

#### 2.13 `library-empty`: Yours, empty  (app: `empty` / `library`)

1. One `.empty` state for the whole screen: the 96px radio mark (2px
   `--ink-2` stroke; the only illustration in the app), the line "Nothing
   here yet. Follow a show or play today's foray and it lands here." (13
   words), a persimmon keycap "Find a show" linking to `#/search`.
2. The chip strip still renders; the Up Next badge is hidden at count 0 and
   the readout line reads "0 queued".
3. Never a bare sentence: mutation removes the keycap and the test fails.
4. Fidelity regions within 4px of `#/library/empty`.

#### 2.14 `library-shows`: Yours, Shows  (app: `returning` / `starred-shows`)

1. 3-column art grid, 108px tiles, gap 12, `--r-sm`, name 13/600 on two
   lines below, artwork through `safeUrl()`; three columns fit at 375 with
   no overflow.
2. `⋯` or long-press reveals Unfollow as a real button (AT-visible); the
   followed state is a chip or tag, never colour alone.
3. The readout line reads "{n} shows"; the knob keycap stays top-right.
4. Fidelity regions within 4px of `#/library/shows`.

#### 2.15 `library-forays`: Yours, Forays  (app: `returning` / `forays`)

1. Cards carry a `.band--mini` (8px) built from real `data/forays.json`
   segments with per-show enamels `--seg-c{hash % 8}`, narration as solid
   ultramarine ticks (min 3px, no hatch), title 17/700 clamp 2 as the link,
   readout mono "about 22 min · 4 shows".
2. In-progress forays show resume progress: played bars at full, unplayed
   at 40% opacity, the needle in place.
3. The card is not a link; the title link and the Play keycap `sm` are
   siblings, both ≥ 44px.
4. Fidelity regions within 4px of `#/library/forays`.

#### 2.16 `toast`: Yours with toast  (app: null → append step `up-next-remove-toast` to `player`)

1. New step after `mini-player-library`: open `⋯` on the second queue row,
   press Remove, ready `.toast[role="status"]`; `screens.json` repointed.
2. The toast sits above the deck: card fill, `--shadow-deck`, 48px, text 15
   "Removed from Up Next" + an "Undo" text button 44 tall; `role="status"`;
   slides up on `--spring-settle` (named in the reduced-motion block, fades
   there), auto-hides after 4-5s, pauses while touched.
3. Undo restores the row at its original position; the Yours tab badge and
   the readout line tick down on Remove and back up on Undo (the prototype
   fixture: four rows and a "4" badge in both places).
4. Removal moves the following rows by translateY, never by animating
   `height`.

### Group E: Foray detail (branch `redesign/p4-tactile-foray`, file `ui/foray.js`)

#### 2.17 `foray`: Foray detail  (app: `returning` / `foray`)

1. Back keycap `sm` paper top-left; share keycap `sm` top-right (Web+ native
   share of `#/foray/{id}`, hidden in the unavailable state); tag "Foray"
   (narration style); title `display-xl` `DialDisplay` clamped at 4 lines
   with `text-wrap: balance` (fixture: 4/3/3 lines at 375/393/412), no
   descender clipped top or bottom.
2. Band `detail` (44: 28 bars + 16 label row) inside a card-wide well 16
   below the title; station codes once per run ≥ 24px (no `BR BR` at 412 on
   the un-narrated fixture), current run `--ink` 800, hatched narration ticks
   ≥ 8px, needle shown only in progress.
3. Readout "about 22 min · 4 shows · 8 segments" mono 13 `--ink-2`; summary
   body-lg; "Why today" label 13 + why-line body 500; "From" as `.row-show`
   56 with the 24px code-in-swatch and "2 segments" (never a bare letter);
   "Segments" grouped by slot title (heading 17, rows 56: swatch 24, show
   15/700, runtime readout, `narration` tag); tapping a segment row starts
   the foray there.
4. One extended pinned keycap, `keycap--persimmon keycap--lg keycap--round`,
   height 56, padding `0 20px 0 14px`, play icon 28 + "Play" 17/700 + mono
   13 readout at 85% `--on-persimmon`, right-aligned at `bottom: deck + 16`;
   in progress "Resume" + `12:40`; finished "Start over" with no readout;
   the bottom paper fade grows to `deck + safe-b + 100px` so the pin never
   sits on unfaded text.
5. States (prototype `#/foray/progress|done|unnarrated|unavailable`; the
   agent appends steps `foray-progress`, `foray-done`, `foray-unnarrated`,
   `foray-unavailable` to `returning` and adds their `screens.json` rows):
   in progress → needle on the band, played bars full and the rest 40%;
   finished → `played` tag beside the title; un-narrated → no ticks and the
   13px line "No narration yet on this one."; unavailable → an empty well
   with **no station labels** (`.band--empty .band__labels { display: none }`),
   the needle lifted 20°, heading "This foray isn't available right now.",
   keycaps "Try another foray" (persimmon, next available foray) and "Yours"
   (paper), share hidden, back kept.
6. Fidelity regions header / tabBar within 4px; the agent adds `band`,
   `primary` (the pinned keycap) and `rows` regions to the `screens.json`
   row so the next iteration measures the signature, not only the chrome.

### Group F: Onboarding (branch `redesign/p4-tactile-onboarding`, file `ui/onboarding.js`)

#### 2.18 `onboarding`: Onboarding  (app: `first-run` / `intro-sheet`)

1. Full screen on `--paper`, no deck; the top card `--r-lg` is 60dvh at ≥
   800px tall and 50dvh below 700, carrying only the 4a brand (heading role)
   in its top row, a `detail` band drawn from today's real foray with live
   artwork discs through `safeUrl()`, the band drawing in on `--d-draw` then
   a needle loop at 8% per second (both named in the reduced-motion block,
   off there), and the mono counter in the readout row **under the band**
   ("8:52 / 22:10 · 6 shows", the running part `--ink`), never top-right.
2. Headline `display` 2.25rem "Podcasts, lined up around you." (not "stitched": hard limit, see 1.7) balanced, 2
   lines at 375/393/412 with no lone last word; sub body-lg "4a picks real
   shows each day and lines up the best parts into one listen." (15 words).
3. Keycap `lg` 56 full width persimmon "Play today's foray" starts playback
   and lands on Today in first-run mode; text button "Just show me" 12px
   below; both above `safe-b + 16`; no account step; under the lab flag no
   sign-up or event POST fires (`test/lab-flag.test.js` extended with the
   onboarding path).
4. Returning after a skip (prototype `#/onboarding/return`): the same screen
   without the animation, keycap "Play"; `#first-time-sheet` keeps focus
   in/trap/restore (`test/modal-and-focus.test.js` ported unchanged).
5. Fidelity regions sheet / primary within 4px.

### Group G: Settings (branch `redesign/p4-tactile-settings`, file `ui/settings.js`)

#### 2.19 `settings`: Settings sheet  (app: null → append step `settings-sheet` to `returning`)

1. New step: on `#/` press the knob keycap, ready `#sheet.show` (or the
   app's equivalent); `screens.json` repointed. The sheet is modal
   (`aria-modal="true"`, background `inert`), focus moves to the sheet
   container (`tabindex="-1"`), never the first button, and returns to the
   knob on close; Escape and the grabber close it; its blur is one of the
   three allowed and goes opaque under `prefers-reduced-transparency`.
2. Appearance: a segmented control in a well, System / Cream / Bakelite,
   writing `cp_theme` through the storage shim and flipping
   `html[data-theme]` without a reload (test: select Bakelite, `--paper`
   computes to `#17130F`).
3. Dials (`.knobtrack`): a 44px well per dial with a persimmon fill from
   the left, the band needle at the value (2px `--ink`, 8px cap 6px above
   the track), a centre detent 2×16 drawn **above** the fill (`--ink-3` on
   the well, `--on-persimmon` at 70% where it overlaps) visible at every
   value; a hidden range input whose `step` snaps to the detent with a
   selection haptic; per-row readout `+2` / `−1` mono 13, empty at the
   detent; the line "4a's setting is the centre detent" at label 13/500
   `--ink-2` (not micro).
4. The exploration floor is a sentence, not a control: "The exploration
   floor stays at about a third. It is not a dial." No slider, no input for
   it (mutation: render it as a `.knobtrack` and the test fails).
5. Fidelity regions header / rows within 4px of `#/settings`; the row map's
   `hero`/`primary`/`tabBar` entries, which the prototype sheet does not
   have, are removed from the `settings` row so they are not reported as
   broken regions.

---

## 3. After the last screen

Full `node tools/ci/run-suites.mjs`, `gates.mjs --allow
tools/ui-lab/gates-known-debt.json --no-remote-images` on every state,
`a11y.mjs` on every route and state, `baseline.mjs compare` clean on
`tactile-gallery` and `tactile-app`, both schemes shot (Cream at 375/393/412,
Bakelite at 393), then hand to Phase 5. Lab builds are the orchestrator's to
dispatch, first after 2.1-2.4 are accepted (Now Playing in hands is the first
milestone: Risk 1, the keycap press feel, and Risk 3, `backdrop-filter` and
View Transitions on older Android WebViews, are decided on a phone, not in a
render).

## 4. Decisions recorded here

- Sub-states build in the parent screen's loop (one agent per `ui/*.js`);
  each remains its own `screens.json` row for shooting and judging.
- The four `app: null` rows (`home-offline`, `home-loading`, `toast`,
  `settings`) are built, each with a named state or step above.
- Re-cut and instanced font files ship under `DialDisplay` and `DialText`
  (OFL Reserved Font Name clause); Azeret is untouched and keeps its name.
- The weight ceiling is 800 on the display face (Big Shoulders' display
  weight), 700 on the text face.
- Groups A-G are the branch and file ownership; a shared-file change
  (tokens, sprite, primitives, `index.html`) goes in a one-line follow-up PR
  to the direction branch naming the screens it touches.
