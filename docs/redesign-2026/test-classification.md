# Redesign 2026 — UI test classification (Phase 0c)

Scope: every suite that pins UI, read from the trunk (`feature/redesign-2026`)
on 2026-10-05. Two classes, defined by `PLAN.md`:

- **KEEP** — enforces a hard limit the redesign may not challenge: security
  (`esc`/`safeUrl`, CSP, no inline style/script), `cp_` keys, copy rules,
  exploration floor / no streaks / continuous playback, legally boring,
  accessibility (44px, focus in sheets, one reduced-motion block, AA contrast),
  production-write isolation. A redesign must keep it green, or port it
  unchanged to the new markup.
- **REWRITE-ON-PURPOSE** — pins today's look, or a founder ruling a direction
  may overturn (PLAN owner decision 1: dark-only, 4 tabs + drawer, no zoom, card
  anatomy, section order, palette). The test may be deleted or rewritten **only
  in the PR that adopts the direction that overturns the ruling**, and that PR
  must say which ruling fell. The *guarantee* column says what the rewrite must
  still prove.
- **KEEP / REWRITE-PART** — a suite with both halves; the table says which
  tests go which way.

Floors: any rewrite keeps `test/suite-integrity.test.js` FLOORS honest (a floor
may go down in the same PR that deletes the pinned behaviour, never silently),
and every new/rewritten test still names its one-line mutation and is run
against it (CLAUDE.md "A green test is not evidence until you have broken it").

## 0. The five rulings most likely to be overturned

| Ruling | Source | Suites that pin it |
|---|---|---|
| Dark-only / one palette (nine tokens, amber+violet split) | U-01, `docs/ui-transition-plan.md` | ui-tokens |
| Four tabs (Home, Search, Create, Library) + drawer menu | U-02; founder 2026-09-03 declutter | tab-bar, home-information-architecture, drawer-ownership, library-screen, create-page |
| No zoom (viewport, `touch-action`, `gesturestart`, `zoomEnabled:false`) | founder 2026-09-23 (reversal of 09-17) | no-horizontal-scroll, foray-type-scale (the Dynamic Type bridge assumes the zoom ruling) |
| Card/row/pill/tag/artwork anatomy | visual pass 1, 2026-09-23 | card-anatomy, transport-controls, ui-tokens (radius/type/elevation/headings) |
| Home section order and content | U-03; founder 2026-09-18 and 09-24 | home-v2, home-v2-real-data, home-play, jump-back-in-kinds, home-layout |

Not on the list because they are hard limits: continuous playback
(`up-next-autoadvance`, founder 2026-09-14, product principle 1), exploration
floor (home-v2 §3), copy rules, 44px, focus ownership.

## 1. The twelve named suites

### test/ui-tokens.test.js — 937 lines, 43 tests, TXT reader of styles.css + app.js + index.html + player/*.js

Pins: nine `body.ui-v2` tokens with spec hex values; no palette hex outside the
definition block; fonts self-hosted under `fonts/`; radius/type/elevation
scales and "every corner/size/shadow reads a token"; two faces (display/body);
wordmark Fraunces italic; amber/violet roles; one gutter; flat rows; the
Home card's branch dot removed; focus ring; Reduce Motion block; contrast.

**KEEP / REWRITE-PART. Split it into two files.**

| Keep (hard limit) | Rewrite-on-purpose (pins today's look) |
|---|---|
| fonts self-hosted, never a third-party origin (CSP, `font-src 'self'`) | the nine token names and hex values; amber/violet split |
| no live rule reads a token the page does not own; every token a `colour-scheme` query redefines is re-owned | radius scale order; type scale order; the four elevation tokens |
| JS-written tokens are really written by JS | two-faces rule naming Fraunces; wordmark = Fraunces italic; heading kinds |
| `--faint` never paints text/controls; token readable on both surfaces (AA contrast) | section title = display face at `--fs-xl` 600; row title weights |
| one authored focus ring, reaches the search field, no bare `outline: none` | capsule/circle button radii; flat-row/shadow rule; one-gutter value |
| Reduce Motion is **one** block and names every transition | the Home branch dot / v1 hexes; "N min left" amber-bold; wordmark-once on Home; episode head two lines |
| range inputs are the listener's own material, never UA blue (a11y/readability) | C1-control check can stay as is (pure hygiene, KEEP) |
| no C1 control char in the sheet (hygiene) | |

Rewrite must still guarantee: (1) **every colour/size/shadow/radius goes
through a named token** (the leak-a-hex failure the file's header names) —
parametrise the test over the new token list instead of hardcoding nine names;
(2) AA contrast for every text/background pair in every theme the direction
ships; (3) one focus ring, authored; (4) one Reduce Motion block covering every
`transition`/`animation`; (5) fonts self-hosted and OFL; (6) no inline style
(CSP). If a direction is **light + dark** the "dark is declared" test becomes
"each declared scheme re-owns every token". Mutation per test: hardcode one
token's hex outside the definition block.

### test/card-anatomy.test.js — 575 lines, 18 tests, VM + TXT (styles.css)

Pins: no `<button>` inside `<a>` (walks emitted HTML tag by tag, nested
templates included); stretched-link card (title is the link, control a lifted
sibling); two-tier episode row; one pill (`.fy-chip`); one artwork treatment;
one tag shape/tint; cards on `--surface` read `--radius-lg`; numbering only for
ordered lists; kicker redundancy; ‹ only on non-root pages; credits ↗ column.

**KEEP / REWRITE-PART.**

- KEEP: "no template literal nests a `<button>` inside an `<a>`" (invalid HTML,
  a11y); "title is the one real link, control is a sibling" (the structure, not
  its radius); "Continue banner is gone: no renderer, no rule" (dead-code
  guard); ‹ on non-root pages only (navigation honesty).
- REWRITE: two-tier row geometry; one pill; one artwork radius/border/shadow;
  tag shape/tint (18% mix); card radius; Up Next round-control silhouette;
  kicker/eyebrow naming; the "numbered list" rule is content policy and can
  stay.
- Rewrite must still guarantee: valid interactive nesting, one real link per
  card, ≥44px controls (see tap-targets), the whole name reachable on a
  truncated row (a11y), no duplicated section/kicker label.

### test/tap-targets.test.js — 575 lines, 24 tests, TXT of app.js + index.html + player/*.js + styles.css

Pins: the hit-area rule (centred zero-specificity `::after`, ≥44x44); **walks
every `<button>` the app renders** (`<button …>` templates and `el("button",…)`
in `app.js`, `player/*.js`, `index.html`) and requires each to be classified and
reach 44px; scrub/strip gesture arbitration; row tap target; stop/speed
distinction; mini-bar geometry; disabled look; hover ≠ playing.

**KEEP (accessibility hard limit).** The classification table inside it
(`MARKUP_FILES`, per-class reason) is data to be re-pointed, not rewritten.
Rewrite only: mini-bar fill/dock-offset assertions, Foray strip dimensions,
"Stop reads as different from the speed box" — those pin today's layout; the
guarantee they keep is "no control < 44px, no two destructive/benign controls
adjacent without clearance, a flick scrolls and only sideways movement
scrubs". After the `app.js` split `MARKUP_FILES` must list every new script
(see §3) — a missed file means buttons go unwalked and the suite stays green:
**add a test that the list equals the set of scripts in `index.html`.**

### test/tab-bar.test.js — 419 lines, 8 tests, VM + TXT (styles.css)

Pins: bar always renders; four tabs in order Home, Search, Create, Library;
**every route highlights exactly one tab** (`aria-current="page"`); all 14
routes resolve; Library → `#/library`, Create → `#/create`; bar height equals
body reservation at both insets; mini player docks above the bar.

**REWRITE-ON-PURPOSE** (ruling: four tabs, U-02/U-11). Rewrite must still
guarantee: every route resolves to a real page; **exactly one nav item is
current for every route, never zero or two**; the bar's height equals the
space reserved for it (no content under the bar, safe-area counted once); the
mini player never overlaps the bar. Rewrite the tab count/order/hrefs only
when a direction replaces the IA.

### test/home-v2.test.js — 366 lines, 10 tests, VM

Pins: five sections in order (greeting, Jump back in, Forays for you, Playlists
for you, Suggested); **the floor** — both "for you" sections carry a visible
Stretch label with its bridge line on 20 seeded renders, never one without the
other; bridge line never reads as a taste-match reason; "Generated for you"
badge only on generated cards; F14 generated-playlist rules; "Shared with you"
/ "Build your own" not built.

**KEEP / REWRITE-PART.** KEEP: tests 3, 4, 5 (exploration floor, bridge copy,
badge honesty) and F14 (generated playlist is an interest leaf, never a card
slot) — these are product principle 1 and 2. REWRITE: section order, section
names, the greeting. Rewrite must still guarantee: **~30% stretch floor on
whatever surface replaces "for you"**, bridge stated for every stretch pick,
no "because you like X" on a stretch, generated vs own distinguished. Keep the
20-seeded-render loop; it is what makes the floor testable.

### test/home-information-architecture.test.js — 475 lines, 11 tests, VM + TXT (index.html)

Pins: the 2026-09-03 declutter matrix — each moved surface (playlist builder,
show search, "Shows 4a vouches for", Up Next) absent from Home **and** present
on its destination; the menu lists exactly five destinations in the founder's
order; `#/forays` routing; Up Next is a page over real `cp_queue`; Starred
Shows is under Shows; a Foray's back link lands on `#/forays`.

**REWRITE-ON-PURPOSE** (ruling: Home is four cards then done; five-item menu).
The two-direction ("absent here, present there") pattern is worth keeping as the
form. Must still guarantee: every moved surface is reachable from a nav path
(no orphaned feature), Up Next reads real `cp_queue` state, back navigation
lands somewhere that still lists what you came from, a fresh install shows no
dead-end row.

### test/no-horizontal-scroll.test.js — 190 lines, 11 tests, TXT (styles.css, index.html, app.js)

Pins: html/body `overflow-x` fallback-then-`clip` ordering; wrapping text and
shrinkable chapter titles; `touch-action: manipulation` on html/body and
controls; **viewport meta forbids zoom** (inverted 2026-09-23); `gesturestart`
cancelled in app.js; native shell `zoomEnabled: false`.

**KEEP / REWRITE-PART.** KEEP: no horizontal pan (html/body overflow rules,
wrapping, shrinkable flex items) and `touch-action: manipulation` — "never a
gesture the app did not mean to offer", directly an accessibility/robustness
limit. REWRITE-ON-PURPOSE: the four zoom tests (viewport `user-scalable=no`,
`gesturestart` guard, shell `zoomEnabled`) — ruling is the owner's own
2026-09-23 words; a direction may overturn it. **Caution for the owner pick:**
`user-scalable=no` fails WCAG 1.4.4 and iOS ignores it; if zoom is restored the
test becomes "viewport allows scaling, and layout survives 200% text without
sideways pan" and `foray-type-scale.test.mjs` (Dynamic Type bridge) is the
companion that must stay green.

### test/modal-and-focus.test.js — 1144 lines, ~40 tests, VM + TXT (styles.css, index.html)

Pins: one owner for "a modal is open" (`openSheet`/`closeSheet`); focus moves in,
page `inert`, Tab trapped, Escape closes the top sheet; focus survives list
rebuilds (Up Next ↑/✕, voice picker); a render closes sheets inside `#view`;
route focus landing + document title; async paint renames the document; drag
to dismiss and slide timing; reduced motion = no motion; every sheet rides the
soft keyboard.

**KEEP.** This is the accessibility hard limit ("focus management in sheets",
reduced motion). Do not rewrite for a new look. The only look-coupled parts are
specific copy ("Get started", "Home") and which chrome stays reachable (the ☰);
those follow the IA but the guarantees stay: focus enters, is trapped, returns;
background is inert except named chrome; closing undoes only what open changed.
**Any redesigned sheet must be routed through the one owner, and a new
`role="dialog"` that bypasses it must fail a test** (the existing "no sheet
writes the modal lock itself" test is the pin; extend its source list to every
new script).

### test/listener-copy.test.js — 549 lines, ~21 tests, VM + TXT (reads app.js via `listenerProse("app.js")` plus `player/*.js`)

Pins: no production vocabulary (segment/clip/piece/part/beat → clips/parts/"this
foray"); no outlived strings; "we/us/our" banned; "subject" not "topic"; no
browser/reload words in a native shell; failure copy pairs; labelled text
fields, live-region notes; explicit badge is a named image; down-vote reason
logic.

**KEEP.** Copy rules are a PLAN hard limit. Its scanner reads **plain strings,
template text across lines and interpolations** from `app.js` and the player
modules — **after the split it must scan every UI script and every new
component file** (see §3); a file not in the scan is unpoliced copy, which is
exactly how new screens leak jargon. Add: a test that the scanned set equals
the scripts in `index.html`. REWRITE only individual assertions that cite a
retired surface (e.g. the returning-listener popup) when that surface goes.

### test/app-security.test.js — 543 lines, ~24 tests, VM

Pins: `esc` escapes every breakout char, ampersand-first, null/undefined;
`safeUrl` allow/replace; **every interpolated `href`/`src` passes `safeUrl`**;
no inline `style=` (CSP `style-src 'self'`); no inline `<script>`; no
`javascript:`; `cp_` prefix on localStorage keys; `${rel}` names localStorage in
one sanctioned place; the shim prefers `window.forayStorage`; strip click
geometry.

**KEEP, unchanged.** The most important suite for the redesign. It scans
**source text**, so after the split it must iterate every UI script. Rules for
rewriting its harness only: (1) the scan list is derived from `index.html`'s
`<script src>` set, not hand-listed; (2) a new component that builds HTML must
go through `esc()`/`safeUrl()` — the regexes that detect interpolation without
`esc` should be run over new files (an SVG sprite `<use href="#id">` is a
fragment href: add an explicit allowance and a test, do not weaken the rule).
The strip-geometry tests (segLenOf, mountForayStrip, "an older cached module
costs the show colours, never the strip") pin player wiring: KEEP while the
strip exists, move with it.

### test/legal-citations.test.js — 1041 lines, ~28 tests, VM + TXT-style resolution of anchors in app.js (and index.html)

Pins: store legal docs (`docs/legal/privacy-policy.md`, `data-safety.md`) cite
code as `file:anchor` where the anchor is a **declared symbol**; no line
numbers; every anchor resolves in the file it names; event types leaving the
device equal the policy's list; `connect-src` origins match the CSP and the
policy; `font-src 'self'` only; input caps; native-player keys and diagnostics
file.

**KEEP (CSP, data-flow honesty, privacy — hard limits).** **Split-sensitive:**
citations name `app.js:<symbol>` (e.g. `app.js:toEventRow()`, `app.js:SB_ARCHETYPES`,
`app.js:#cr-input`). When symbols move to new files, **either keep `app.js` as
the file that declares them or update the legal docs and the `resolveFile`
mapping in the same change.** Preferred: make the resolver search the whole UI
script set for the anchor and require it to be declared exactly once. No
rewrite of intent.

### test/api-origin.test.js — 145 lines, 5 tests, TXT

Pins: `API_ORIGIN` is a bare https origin; `apiUrl()` produces absolute URLs;
**every `api/*` call in app.js goes through `apiUrl()`**, none through
`pinnedUrl()`; CSP names the API origin and nothing wider; privacy policy no
longer says search never leaves the device.

**KEEP.** Guards the "only 3 episodes per show" fails-green defect, and the CSP.
**Lab-build note:** the PLAN's lab flag disables production *writes*
(`/auth/v1/signup`, `/rest/v1/events`), not catalogue GETs; this suite must keep
passing and a new test must pin that the lab flag turns those two off
(mutation: remove the flag check, lab build posts an event). After the split,
scan every UI script for bare `fetch("api/` / `"/api/`.

### player/now-playing-sheet.test.js — 572 lines, ~29 tests, TXT of `player/client.js`, `styles.css`, `app.js`

Pins (source-text suite; `player/client.js` cannot load under node): opening
resets the scroller *after* unhide; artwork then title; notes built as nodes
from the one tokeniser (never an HTML string); exactly one scroller; full-height
overlay stopping under the topbar; scroll lock behind; drag-to-dismiss wiring
(four pointer phases, cancel springs back, controls own their presses, custom
property not a style attribute, one finger); dialog semantics and routing through
the sheet owner; Stop releases the owner; Bookmark after Save, uses
`episodePositionSec()`; live region is a sibling; slide in/out with reduced
motion off; every `.fy-panel` can move.

**KEEP / REWRITE-PART (the largest single rewrite).**

- KEEP: notes built as nodes (no innerHTML of untrusted text), dialog semantics
  through the owner, Stop releases focus/owner, live region reachable, drag
  uses a custom property (CSP), reduced-motion for slide, one finger, bookmark
  uses `episodePositionSec()`, failure message on bar and in sheet, hook/timing
  hidden when empty.
- REWRITE-ON-PURPOSE (Now Playing is the first screen the redesign builds):
  artwork-then-title ordering, sheet geometry (full height, under the topbar,
  no body padding), button row order (Stop leads second row, Bookmark after
  Save), mini-bar artwork tap target. Ruling: Wyatt 2026-09-13 ("same as Apple
  Podcasts") for geometry; the *behaviour* — scrollable, starts at the top,
  drag down from the top to return — stays a requirement unless the direction
  states otherwise.
- Rewrite must still guarantee: the sheet starts at the top on every open
  (the original bug), has one scroller, is a named modal dialog under the
  owner, is draggable down only from the top, never lets a control press start
  a drag, and every transform/transition respects reduced motion.

## 2. Remaining UI suites, by family

Legend: **K** keep, **R** rewrite-on-purpose, **K/R** split. "Pins" is a
phrase, not the whole suite.

### 2a. Chrome, layout, tokens (TXT readers of CSS/HTML)

| Suite | Pins | Class | Must still guarantee |
|---|---|---|---|
| home-layout | topbar/`#view` offsets equal under safe-area insets; `[hidden]` really hides; Home v2 rail snap rests on gutter; stretch card | R (geometry) | no content under fixed chrome at inset 0 and 59px; `[hidden]` beats author `display`; no horizontal rail clipping |
| transport-controls | mini bar = ▶ + ↺15, 44px; transport shape on every surface | R | transport ≥44px on every surface; skip is distinguishable |
| collapsing-header-scroll | header reappears on scroll-up (Wyatt 09-05) | R (mechanic) | a collapsed header never strands the listener without back |
| keyboard-chrome-and-scroll | chrome gets out of the soft keyboard's way | K | search field/mini bar never behind the keyboard |
| now-playing-keyboard | mini bar hidden while keyboard up | K | same |
| search-field-bottom | search field floats at bottom as a capsule | R (placement) | field reachable and not covered by keyboard or tab bar |
| search-page-chrome | search page chrome (three 09-13 reports) | R | same as above plus tab-bar clearance |
| app-name | app's own name on every surface (index.html, CSS, docs) | K/R | one display name everywhere; update value to "4a" if rename lands |
| deploy-id-meta, boot-path | index.html names its deploy; boot path preloads, perf budget, first-paint | K | one boot document set; preload lists equal script set (**split-sensitive**) |
| vercel-headers | CSP/headers per route (index.html read) | K | CSP is the security boundary |
| episode-row-snippet | description snippet under the row title (founder 10-03) | R | row says what the episode is about; text escaped |
| show-description-source | publisher's description, credits (founder 09-21) | K | never present our words as the publisher's |
| foray-row-links | each Foray row links to its show | K/R | row has a link to the show page; geometry R |

### 2b. Navigation, sheets, drawer, onboarding

| Suite | Pins | Class | Must still guarantee |
|---|---|---|---|
| drawer-ownership | drawer closes on use; Diagnostics closes it (founder 09-23) | R (drawer) | menu closes after navigation; focus returns |
| drawer-settings-toggle | settings toggles keep drawer open; dead `playerPref` strings gone | K/R | toggle state observable; dead keys stay dead |
| engine-developer-rows, voice-probe-switch, voice-settings, diagnostics-surface | developer rows, probe, voice picker, diagnostics sheet | K/R | gated behind unlock; no raw ids; sheets via owner |
| back-navigation, navigation-memory, route-scroll-position, router | ‹ goes back one step; scroll memory; router decoding and safety | K | back is one step; a new page starts at top; hand-typed `%` never throws |
| first-time-onboarding, onboarding-sheet-once | consent/explanation, mounts once, parkable | K/R | consent honest and once per visit; Escape parks it |
| library-screen, create-page, interests-page, interests-roots | those pages' content, ruling-per-page (D6/D7/D8) | R | interests 0–1 keyboard operable, no history feed; Create's Foray option disabled until built |
| starred-shows, category-browse | starred shows section; browse by category (A2.4/A3.2) | K/R | feature still reachable; copy |
| load-states, show-episode-load-states, toggle-labels | loading vs failed vs empty are different; name and text move together | K | three states, one writer, aria-label tracks text |
| async-identity | async work knows which page asked | K | no late paint into another page |

### 2c. Home, content surfaces

home-v2-real-data (R, with real-data floor K), home-play (R: one Home play
button, founder 09-24; keep "plays what is first in the list"), jump-back-in-kinds
(R: forays + podcasts + playlists, founder 09-18), foray-surfaces (K/R), foray-directory
(K/R), foray-ribbon-restore (K: ribbon offers the last played), episode-page and
its siblings (episode-page-publish-date-description-chapters, episode-description-links,
episode-deeplink, episode-row-links, explicit-badge): **K** on behaviour
(`#/episode/:id`, `?t=N`, links never leave the app, E badge shows, description
links/timestamps tokenised not HTML-injected); R only on layout words. show-page,
show-pages-3b-full-catalogue, show-page-pagination, show-page-search, show-episodes-cache,
show-search*, offline-search, search-playlists, search-probe-record, episode-search:
**K** (behaviour and data flow, not look). generated-playlists, save-playlist,
playlist-durability, up-next-queue, up-next-autoadvance, up-next-gestures,
card-play-pause, downloads, bookmarks, data-deletion, personas-client,
event-sync-mapping, format-helpers, clock-formatters, playable-episodes,
draft-forays-switch: **K** (behaviour; `cp_` keys; deletion honesty; continuous
playback).

### 2d. Pure data / no UI (not affected by a redesign)

`api` data tests, search-engine unit tests (search-matcher, -tiering, -plural-scaling,
-df-scaling, -thin-anchor, -showname-rescue, -bar-exposure, show-index, show-search-ranking,
-shard), data-entities, data-topic-integrity, audit-status, human-actions-integrity,
jingle-duration, supabase-*, vercel-functions, playwright-fixture-server,
prepare-dist-out, similar-shows-eval, vouch-eval (VM — see §3). All **K**.

### 2e. player/ and tools/mobile suites that read UI files

| Suite | Reads | Class | Note |
|---|---|---|---|
| player/segment-strip | `styles.css` rules for the strip, real running orders | K/R | strip look R, scrub contract K |
| player/sheet-drag-dismiss | gesture arithmetic, `styles.css` | K | |
| player/foray-playback | VM-loads app.js + index.html | K | split-sensitive (§3) |
| player/media-session | text of `app.js` + `client.js`; index.html | K | lock screen / car metadata; split-sensitive |
| player/engine-contract, native-mode | scan `app.js`, `sw.js`, `search-engine.js` for `cp_` keys; read app.js for engine copy | K | split-sensitive: key scan must read all UI scripts |
| tools/mobile/prepare-webdir | derives the data list from `fetchJson("data/…")` text of **app.js**; minify; plan must carry every `<script>` in index.html; byte budget comments | K | **breaks on split** unless derived from all scripts |
| tools/mobile/minify | app.js/styles.css/index.html as inputs | K | |
| tools/mobile/shell-invariants | **VM-loads app.js**; checks serviceWorker registration only in sw/app; ios/project.yml | K | split-sensitive |
| tools/mobile/foray-type-scale | `styles.css` `:root[data-type-scale]` rule | K | Dynamic Type bridge; companion to the zoom ruling |
| tools/mobile/webview-probe, foray-media-session, *-workflow, ios-ci | index.html markers / workflow text | K | lab build adds a new bundle id: rewrite *only* the id assertions in the lab path, not the real app's |
| test/playwright/* (Playwright e2e) | the live DOM via a fixture server | R for selectors, K for focus/drawer/close flows | not under node:test; not run by `run-suites`; selector rewrites follow the new markup |

## 3. Every test that reads `app.js` as text or loads it into `node:vm`

**Counts.** 155 files mention `app.js`. By pattern (measured with `grep` on the
trunk):

- **~97 files load it into `node:vm`** — 91 under `test/`, plus
  `player/foray-playback.test.js`, `tools/mobile/shell-invariants.test.mjs`,
  `tools/mobile/android-playback.test.mjs`, `backend/test/breadthCatalog.test.ts`.
- **~68 files read it as text only** (no vm).
- ~35 files additionally call `evalIn(...)` — evaluate an expression inside the
  vm context to reach a top-level `function`/`const`/`let` by name.

### 3.1 The vm pattern (the one that matters for splitting)

The canonical harness (copied across ~90 suites; `test/helpers/fake-dom.js` is
shared by some, the rest carry their own copy):

```js
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");   // sometimes .replace(/\r\n/g, "\n")
const ctx = { document: fakeDom, localStorage: …, window, location, history,
              fetch: stub, setTimeout, Date, URL, crypto, CSS: { escape }, … };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(APP_SRC, ctx, { filename: "app.js" });                // ONE script, one string
// later:
ctx.evalIn("renderHome()") / vm.runInContext("someTopLevelName", ctx) // top-level names by bare identifier
```

Consequences for a split into several classic scripts:

1. **One source string.** Every harness reads exactly one file. A split needs a
   shared helper, e.g. `test/helpers/load-app.js` exporting `appScripts()`
   (the ordered list from `index.html`'s `<script src>` tags) and
   `runApp(ctx)` that runs each in the same context in order. Migrate the ~90
   suites by replacing the two lines (`APP_SRC = readFileSync…` /
   `vm.runInContext(APP_SRC…)`), not by rewriting their tests.
2. **Shared top-level scope.** Classic scripts in one vm context share global
   function declarations and the global lexical scope for `const`/`let`, so
   `evalIn("someConst")` keeps working **provided load order matches
   `index.html`** and no module syntax (`import`/`export`) is introduced. An ES
   module split would break every one of these harnesses.
3. **Self-reading harnesses.** Several slice the source before running it:
   `draft-forays-switch` and `voice-probe-switch` (`appSrc` modified),
   `boot-path` (`APP_SRC.includes(decl)` then patches the declaration to
   control `waitForStorage()` timing; its `mount()` asserts "app.js no longer
   declares `<decl>`"), `drawer-settings-toggle` (reads comment-stripped source),
   `foray-directory` (modifies `appSrc`). These need the helper to expose the
   concatenated text *and* to support a transform per file.
4. **`filename: "app.js"`** appears in every `runInContext` call (stack traces,
   not asserted). Use each script's real filename.
5. **Boot order.** Suites call `markFirstPagePainted()`, park `init()`'s
   rejection with `process.on("unhandledRejection", noop)` and stub `fetch` for
   `data/*.json`; the entry point (the code that runs `init()`) must stay last.
6. **Declaration-regexp extractors.** `clock-formatters` extracts
   `function fmtChapterTime(seconds) {…\n}` with
   `/function fmtChapterTime\(seconds\) \{[\s\S]*?\n\}/` and runs it alone
   (`vm.runInContext(m[0]…)`). It breaks if the function moves file or changes
   shape; make the helper search the concatenation.

### 3.2 Text-read patterns (no vm) — each breaks differently on a split

| Pattern | Suites | Split risk |
|---|---|---|
| `readFileSync(app.js)` then **regex over template literals** to find `<button`, `<a`, `href=`, `src=`, `style=` | app-security (href/src/style/inline script/`javascript:`), tap-targets (`MARKUP_FILES`), card-anatomy (nested button-in-a), ui-tokens (`APP_JS` + sources list), listener-copy (`listenerProse`), boot-path (perf-2 images) | **silent false-green** if a new script is not in the list. Derive the list from `index.html`. |
| `readFileSync(app.js)` then `assert(!src.includes("…"))` for **dead code** | category-browse (`browse-all-link`), drawer-settings-toggle (`playerPref`…), card-anatomy (Continue banner), home-layout | pass vacuously on a missing file; run over the concatenation |
| `readFileSync(app.js)` then **count/derive**: `fetchJson("data/…")`, `cp_` keys, event types, `apiUrl()` | prepare-webdir (data list), engine-contract (`cp_` literal scan over `app.js`, `sw.js`, `search-engine.js`), api-origin, data-deletion (`cp_` key inventory), legal-citations (symbol anchors), event-sync-mapping (`toEventRow`) | counts change when code moves between files only if scanned from one file; scan all |
| **codeOnly()** stripper (removes comments/strings before scanning) | media-session part 6 (reuses for `client.js` and `app.js`; notes "cannot survive 1,800 lines of template-literal HTML"), now-playing-sheet | the stripper's template-literal weakness is why `app.js` is read raw there; keep that distinction |
| single-function slice | clock-formatters | as above |
| `sw-generation.test.js` | VM-loads app.js **and** models `app.js` as a cached file in the service-worker precache (`"app.js": "APP@A"`, `fetched.includes("app.js")`) | the SW manifest and precache list must include every new script; `generate-manifest.mjs` hashes bytes (see `crlf-guard`) |
| `vercel-headers` | `/app.js` among the headers paths | add the new script paths |
| `tools/mobile/prepare-webdir` | derives the **bundle plan from the source `app.js` text before minifying**; asserts index.html's script/style references are all bundled; `fetchJson("data/...")` derivation; byte-budget comment history | the biggest tooling dependency; derive from every script referenced by `index.html` |
| `tools/ci/path-policy` | `app.js` is an allow-list entry (`ALLOWED_PREFIXES`); `matchesPrefix` unit tests use the literal string | new script paths must be added to the allow-list **and** `docs/android-native-code.md` §8 policy, or PRs touching them stop auto-merging (they land as "unlisted": CLEAN but never merge) |

### 3.3 File-by-file list of vm loaders (for the migration checklist)

`test/`: app-security, app-surface-round3, async-identity, back-navigation,
bookmarks, boot-path, card-anatomy, card-play-pause, category-browse,
clock-formatters (slice), collapsing-header-scroll, create-page, data-deletion,
diagnostics-surface, downloads, draft-forays-switch (modified source),
drawer-ownership, drawer-settings-toggle, engine-continuation,
engine-developer-rows, episode-deeplink, episode-description-links,
episode-page-publish-date-description-chapters, episode-page, episode-row-links,
episode-row-snippet, episode-search, explicit-badge, first-time-onboarding
(two vm loads), foray-directory (modified source), foray-ribbon-restore,
foray-row-links, foray-surfaces, format-helpers, generated-playlists,
home-information-architecture, home-play, home-v2-real-data, home-v2,
interests-page, interests-roots, jump-back-in-kinds, keyboard-chrome-and-scroll,
legal-citations, library-screen, listener-copy, load-states, modal-and-focus,
navigation-memory, now-playing-keyboard, offline-search, onboarding-sheet-once,
personas-client, playable-episodes, playlist-durability, route-scroll-position,
router, save-playlist, search-field-bottom, search-page-chrome,
search-playlists, search-probe-record, show-description-source,
show-episode-load-states, show-episodes-cache, show-page-pagination,
show-page-search, show-page, show-pages-3b-full-catalogue, show-search-cache,
show-search-fallthrough, show-search-live, show-search-reach, show-search,
similar-shows-eval, starred-shows, sw-generation, tab-bar, toggle-labels,
up-next-autoadvance, up-next-gestures, up-next-queue, vouch-eval,
voice-probe-switch (modified source), voice-settings.
`player/`: foray-playback. `tools/mobile/`: shell-invariants,
android-playback. `backend/test/`: breadthCatalog (TS).

Text-only readers of `app.js`: see the "text readers" family above plus
test/{api-origin, app-name, data-entities, deploy-id-meta, event-sync-mapping,
home-layout, no-horizontal-scroll, release-gates, suite-integrity,
tap-targets, transport-controls, ui-tokens, vercel-headers};
player/{diagnostic-record, durable-store, engine-contract, media-session,
native-mode, now-playing-sheet, segment-strip, tts-bridge};
tools/{ci/crlf-guard, ci/deck-claims, ci/forays-directory, ci/path-policy,
foray/check-forays, mobile/prepare-webdir, mobile/minify,
mobile/android-*-workflow, mobile/ios-*, mobile/webview-probe,
mobile/fetch-models, release/watch-release}; backend/test/{dataSchemaCompliance,
publishForay, publishSuites}. Many of those only name the file in a path list
(`path-policy`, workflow tests) and need a path-list update, not a loader.

## 4. Recommended order for step 0d (the split)

1. Add `test/helpers/load-app.js` (`appScriptPaths()` from `index.html`,
   `appSource()` = ordered concatenation, `runApp(ctx)`), keeping `app.js` as
   the single script until the helper is adopted by all ~90 suites. Green.
2. Convert text scans to `appSource()` and **add the equality tests**: (a) the
   scanned set equals `index.html`'s scripts; (b) `tap-targets` `MARKUP_FILES`,
   `ui-tokens` sources, `listener-copy` scan, `app-security` scan all consume
   that one list; (c) `prepare-webdir` plan, `sw.js` precache/manifest, and
   `path-policy` allow-list each contain every script.
3. Then split, behaviour-preserving. `legal-citations` anchors stay valid via
   the symbol-search resolver.
4. Mutation to name for (2): add a new `app/foo.js` containing
   `` `<button class="x">` `` to `index.html` and not to the list → the equality
   test, not the scanners, goes red.

## 5. Notes and limits

- Classification came from each suite's own header, test names and read
  pattern, not from running it; no suite was executed or edited.
- Where a suite is marked R it is **not** to be deleted by a Phase 3–4 builder
  on its own initiative: the rewrite lands with the direction's PR and states
  the ruling it overturns.
- Playwright specs under `test/playwright/` are a separate floor (they run the
  real DOM); their selectors are R, their flows (drawer-and-close, focus) are K.
