# Afterglow (ambient): build plan

Art director's plan for phases 3 and 4 on `feature/redesign-2026-ambient`,
written 2026-10-06 against the round-4 prototype (`critique-r4.md`, ready) and
`../../build-loop.md`. `DIRECTION.md` is the intent, `BUILD-NOTES.md` the
numbers (BUILD-NOTES wins over DIRECTION where they disagree; §10 to §12 win
over older lines), this file the order of work and what "done" means per
screen. Every rule in `../../PLAN.md` "Hard limits" and `build-loop.md` §2
applies unchanged; nothing here relaxes one.

**Primary scheme for every render: Dusk, `--scheme dark`.** Dawn is the
secondary pass, `--scheme light`, shot once per screen as a check (build-loop
§0). Before publishing a render, sample a background pixel: Dusk is `#14110F`,
Dawn `#F7F2EB`. Now Playing has no scheme and must read `#14110F`-derived
(the Room base) in both passes.

## 0. Decisions made for the build (art director, final unless the owner says otherwise)

1. **Rulings this direction overturns**, so the PRs that adopt them say so by
   name (build-loop §2, `test-classification.md` §0): **dark-only** (Dusk +
   Dawn); **4 tabs + drawer** (three tabs Today / Discover / Library, no
   drawer; Settings, Tuning, About behind the gear on Today; Create folds into
   Discover's field); **violet = 4a authored** (Lamp `#F3E7D3` instead);
   **Interests as sliders** (three states per subject in Tuning);
   **no share sheet** (native share of the timestamp link); **"Suggested"**
   becomes **"Off your path"**; **home order** (hero, Keep listening, Today's
   picks, Playlists, Off your path). Kept: amber for the listener's own marks
   (Ember), no zoom, 15/30, "Show my picks", played-row-to-top, the ~30%
   floor, continuous playback.
2. **Glow source in the build is `data/palettes.json` plus a hash hue.** The
   catalog has no `show.art.palette` today and the nightly refresh lives under
   `tools/refresh/`, which ships to `main`; teaching it to write palettes is a
   separate PR to the trunk after the direction lands, not part of a screen
   loop. Phase 3 commits the prototype's `palettes.json` (numbers only, our
   script's output, no imagery) as `data/palettes.json` and the loader reads
   it; a show not in the file gets `fnv1a(showId) % 360`, chroma 0.10
   (BUILD-NOTES §1.2 c). **Runtime canvas extraction is not built**: it is
   tainted on most publisher art and would make the colour of the chrome
   depend on CORS headers.
3. **Haptics are a Phase 5 item.** `mobile/` has no `@capacitor/haptics`
   today. Screens call one `haptic(kind)` helper in `ui/haptics.js` that is a
   no-op when the plugin is absent; the plugin and the map in BUILD-NOTES §6
   land in Phase 5 with the lab build.
4. **Car posture ships with the manual trigger only** (long-press the mini
   player 600ms; `?posture=car` for the harness). The Bluetooth-route observer
   is Native and out of this build.
5. **Veil budget is the Dock alone** (BUILD-NOTES §1.5): 128px, 148px on
   Discover, plus a sheet header while a sheet is open. No `.veil` on anything
   that scrolls. The `@supports not` and reduced-transparency solid fallbacks
   land in the tokens PR, not later.
6. **View Transitions are progressive.** `document.startViewTransition` when
   present, FLIP via `element.animate()` otherwise, same `linear()` strings;
   both paths covered by the one reduced-motion block. Android WebView
   support is the reason for the FLIP path; it is not optional.
7. **Status bar** is overlaid (`StatusBar.setOverlaysWebView(true)`): light
   content on Dusk and in any Room, dark on Dawn; screens pad `--safe-top + 8`.
   The web harness has no inset, so every pixel figure below is harness
   geometry.
8. **The prototype's `tools/qa.mjs` facts are the seed for app tests.** Where
   a prototype assert pins a layout fact (Play bottom edge >= 24px above the
   viewport at 375x667, no text under the Dock fade, grid captions never
   overflow), the screen agent ports that fact into a `test/*.test.js` or the
   gates run, with its mutation named. Facts that only the prototype can hold
   (its own data shape) are not ported.
9. **One lab build after Now Playing + Dock** (screens 1 and 2 below), then
   one per group (Today; Discover + Library; Foray detail + Onboarding; the
   rest). Dispatch is the orchestrator's (build-loop §6).

## 1. Foundation (Phase 3), ambient values

Branches `redesign/p3-ambient-tokens`, `-icons`, `-primitives`, `-gallery`, in
that order, each merged before the next (build-loop §3).

### 1.1 Tokens (`styles.css` or `ui/tokens.css`, one file)

Colour, exactly BUILD-NOTES §1.1. Dusk on `:root`; Dawn under
`@media (prefers-color-scheme: light)` guarded by `:root:not([data-theme="dusk"])`
and again under `:root[data-theme="dawn"]`. The in-app override is one
`data-theme` attribute on `<html>` set from `cp_theme` through the shim
(values `dusk`, `dawn`, absent = follow the OS). The prototype used both
`data-theme` and `data-scheme`; the app uses `data-theme` only.

| Token | Dusk | Dawn |
|---|---|---|
| `--bg0` / `--bg1` / `--bg2` | `#14110F` / `#1D1916` / `#272220` | `#F7F2EB` / `#FDFAF5` / `#EFE8DF` |
| `--text` / `--text-2` / `--text-3` | `#F5EEE4` / `#B9AFA3` / `#9A9188` | `#1E1A17` / `#5E564E` / `#6B635A` |
| `--ember` (ink on it) | `#F0A64B` (bg0) | `#8E520E` (`#FFFFFF`) |
| `--lamp` | `#F3E7D3` | `#FFFFFF` (narration bars carry a 1px `#E0D6C8` edge); `--lamp-text` `#55391A` for Lamp copy on a Dawn Room |
| `--rim` / `--overlay` | `rgb(243 231 211 / .10)` / `rgb(243 231 211 / .06)` | `rgb(255 255 255 / .80)` / `rgb(255 255 255 / .55)` |
| `--shadow-1` / `--shadow-2` | `0 1px 2px rgb(10 6 4 / .40)` / `0 8px 24px rgb(10 6 4 / .35)` | `0 1px 2px rgb(60 40 20 / .10)` / `0 8px 24px rgb(60 40 20 / .10)` |
| `--ok` / `--warn` | `#7FCB8E` / `#E9B46A` | same (never alone, always with a glyph) |
| `--glow` default | `oklch(0.66 0.12 60)`, `@property` registered, `initial-value: #8A6A4E` | `L 0.56` |
| `--glow-veil` / `-row` / `-wash` / `-room` | bg0 72% + glow 28% / bg1 82% + 18% / bg0 60% + 40% / bg0 85% + 15% | Room base paper0 80% + 20%; Dock cast 9% not 14% |
| `--seg-c0..7`, `--seg-narration`, `--seg-dim` | the eight fallbacks in §1.1, `var(--lamp)`, `0.38` | same |

Static fallbacks declared first for every `color-mix`/`oklch` token
(`--glow-veil: #221C19` etc.). Room scrim stops in pixels from the top (§10.1),
onboarding's own stops (§11.2), Dock fade `calc(var(--safe-bottom) + 12px + 44px)`
reaching bg at 32px (§12.1), Dock cast 260px radial at 14% (§11.1) anchored to
the Dock's top edge and hidden when nothing plays (`#app:not(.has-mini)`).

**Type**, the seven styles in §1.3 and nothing else, each also in `rem`:
`--t-display 500 32px/1.125`, `--t-title 500 26px/30px`, `--t-headline 500 20px/1.2`
(Fraunces, `'SOFT' 100, 'WONK' 0`, `font-optical-sizing: auto`),
`--t-why italic 400 17px/24px` (Fraunces italic), `--t-body 400 16px/24px`,
`--t-label 600 14px/1.3`, `--t-caption 500 13px/18px` (DM Sans). Tabular
numerals on `.time`, `.count`, `.dur`. Eyebrows: caption, uppercase, `0.06em`,
Lamp when 4a authored, text-3 otherwise. Wordmark: Fraunces italic 500 26px,
Today header and onboarding only. Car posture: `--t-display`, `--t-headline`,
`--t-label` x1.25 under `[data-posture="car"]`. Fonts: the three variable
files already in `fonts/` (DM Sans 62.7KB, Fraunces 67.3KB, Fraunces italic
81.5KB, OFL, 211.5KB total); `font-src 'self'` stays; no new file.

**Space, radius, size**: §1.4 verbatim (`--s-1..12` on a 4px base; gutter 16
at 375, 20 from 393; `--r-xs 4` to `--r-xl 24`, pill, round; art 44/56/72/104/
120/160; rows 96/64/64; tab bar 64, mini 64, field 52, tap 44; `--chrome-bottom`
and `--chrome-bottom-mini`).

**Motion**: `--m-micro 160ms`, `--m-ui 280ms`, `--m-sheet 420ms`, `--m-room 560ms`;
`--e-out cubic-bezier(.2,.8,.2,1)`; `--e-spring` and `--e-spring-soft` as the
`linear()` strings in §1.6. Transform, opacity and registered properties only.
**One** `prefers-reduced-motion` block, the §1.6 block, which also covers
`::view-transition-*`; every animation added by a later screen is added to it
in the same PR. Materials: `.raised`, `.veil`, `.dock`, `.room` (+ `::before`
art layer, `::after` scrim) and Lit art (§10.2: `--lit-r` 40/64/96 at 104/160/
280+, 55% Dusk, 40% Dawn) with the `@supports not`, `prefers-reduced-transparency`,
`prefers-contrast: more` and `forced-colors` fallbacks in one place (§1.5).

Tests in this PR: `test/ui-tokens.test.js` rewritten for the new token list
(name the fallen ruling: dark-only), parametrised AA check over every pair in
`contrast-check.mjs` for both schemes (lowest allowed 4.5:1; today's lowest is
4.86), the Glow mix worst cases from `prototype/tools/contrast-glow.mjs`
(Dock cast text-3 5.15:1 worst hue, Dawn ink-3 4.73:1) pinned as fixed numbers.

### 1.2 Icon sprite (`icons.svg`, Phosphor Regular / Fill, 24px grid, 256 viewBox, `currentColor`)

Thirty-seven symbols, the prototype's set, no more: `i-house`, `i-house-fill`,
`i-compass`, `i-compass-fill`, `i-books`, `i-books-fill`, `i-play`, `i-play-fill`,
`i-pause`, `i-back15`, `i-fwd30`, `i-skip-next`, `i-bookmark`, `i-bookmark-fill`,
`i-check-circle`, `i-check-circle-fill`, `i-download`, `i-download-fill`,
`i-queue`, `i-dots`, `i-chevron-left`, `i-chevron-right`, `i-chevron-down`,
`i-magnifier`, `i-x`, `i-share`, `i-moon`, `i-gauge`, `i-sliders`, `i-gear`,
`i-wifi-slash`, `i-sparkle`, `i-car`, `i-arrow-up`, `i-arrow-down`, `i-plus`,
`i-trash`. `i-play`, `i-pause`, `i-back15`, `i-fwd30` are the custom glyphs in
BUILD-NOTES §2 (arc + numerals as outlines). Sizes 24 default, 20 in chips and
captions, 28 tab bar, 32 transport secondary, 36 inside the 88 Play and the 56
skips, 24 inside the 48 mini Play. No Unicode glyph anywhere, including the
ellipsis (CSS `text-overflow`). A test asserts every `<use href>` in `ui/*.js`
names a symbol in the sprite (mutation: rename one symbol).

### 1.3 Primitives (one treatment each, every state, `ui/primitives.js` + gallery)

The BUILD-NOTES §3 inventory: Dock (field row 48 / mini row 64 / tab row 64,
receded 36), TabBar, MiniPlayer, PlayButton (88/56/48/44), SkipButton,
Scrubber, Strip (48 thumbed / 32 / 12), EpisodeRow 96, StretchCard, ForayCard,
ForayTile, HeroPick, ShowTile, SubjectTile, PlaylistTile, QueueRow 64,
SearchField 52, Chip, Pill, SectionHead, Sheet, Toast, Skeleton (lamp sweep),
EmptyState, Collage (`.c1..c4`, first square whole and on top, §11.3). Buttons:
Primary (Ember pill 48), Secondary (outlined 1.5px text-2, 44), Quiet (text
Ember, 44 target), icon 44 round. States: default, pressed (scale .94 micro or
bg2), focus (2px Lamp ring outside), disabled (40% + `aria-disabled`), loading.

### 1.4 Gallery

`#/gallery` under `window.__FORAY_LAB__` or `?gallery=1` only; every primitive,
every state, both schemes, plus one Glow swatch row at hues 0/60/120/190/240/300
so the tinted materials are in the baseline. `gallery` state appended to
`lib/states.mjs`; `ambient-gallery` baseline recorded with `--scheme dark`
(then a `--scheme light` pass as the secondary check), gates exit 0, judged
once against the prototype before Phase 4.

## 2. Screens (Phase 4), in build order

One agent, one branch `redesign/p4-ambient-<id>`, one loop (cap 4 iterations)
per row. "Rows" are `screens.json` ids the loop pairs with `fidelity.mjs`;
"add rows" are entries the agent appends to `screens.json` (and the state or
step it appends to `lib/states.mjs`, never editing an existing one). A screen
with no prototype route (section 2.3) gets the is-it-better judge pair only and
is built from the component inventory; the fidelity pair is recorded as n/a in
`PROGRESS.md`, not skipped silently. Every screen: gates exit 0 against
`gates-known-debt.json`, both rolling baselines compared, KEEP suites green,
rewritten suites name the ruling, tests name and run their mutation.

### 2.1 Core (Now Playing sets the pattern; nothing parallel until it is accepted)

**1. `now-playing`** (`ui/foray-player.js`): rows `now-playing`,
`now-playing-episode`, `now-playing-paused`; add rows `now-playing-foray`
(new step in `player`: start a foray, open the sheet), `now-playing-segchange`,
`now-playing-detail`, `now-playing-ending`, `now-playing-textscale` (new steps
or `?`-hooks the agent appends). Today's `now-playing` step plays an episode,
so the existing `now-playing` row is repointed at the appended foray step and
`now-playing-episode` keeps the old one.
- The sheet is a `.room`: Glow-tinted base, blurred artwork layer, pixel-stop scrim; at 375x667 and 393x852 the eyebrow, title and show line all begin below `safe-top + 72px + --np-art + 20px`, and `--text` on the Room at the title's y measures >= 4.5:1 on every hue in `contrast-glow.mjs`.
- Glance posture fits 375x667 in every state: artwork `clamp(220px, 100vh - 520px, 320px)`, 220 under 700px tall, 180 with a three-line title; the 88px Play's bottom edge is >= 24px above the "More" handle and the handle is fully inside the viewport, including at `textscale=1.3` (why-line hidden, art 160).
- Foray playback shows the 32px strip: bars sized by runtime, show bars in derived segment colours, narration bars 4px Lamp, the current bar at full opacity 4px taller with a left-to-right fill, every bar a 44-tall `button` with `aria-label="Seek to <show>, <mm:ss>"`; tapping a bar seeks. Episode playback shows the 4px scrubber with a 16px Lamp thumb, `role="slider"`, `aria-valuetext` updated on change only.
- Segment change: `--glow` and `--room-art` crossfade 560ms, the show line under the title crossfades 280ms, the Lamp caption "Now: <show>" occupies the reserved 18px eyebrow slot for 3s then fades; the title's y does not move (assert equal bounding boxes before and after).
- Paused: `i-play`, Room art layer at 0.7; end of item: the next art enters from +100% with `--e-spring-soft` 560ms as the old exits to -24% and fades, title swaps. Detail posture below the handle: Speed / Sleep / Bookmark / Share as 44 icon buttons, segments or chapters as QueueRows (narration rows in Lamp, no art), "Where this came from" 3-up ShowTiles with Follow, show notes 4-line clamp + "More" through `esc()`/`safeUrl()`, Up Next peek with "4a added" eyebrow, title, one meta line, why-line two lines.
- Mini -> Now Playing: the 44 art is the shared element (`view-transition-name: np-art`, FLIP fallback), 420ms `--e-spring-soft`; drag-to-dismiss tracks the finger and springs home; reduced motion = 200ms crossfade; focus moves into the sheet, is trapped, returns to the mini player on close.

**2. `dock`** (`ui/tabbar.js` + the mini-player half of `ui/foray-player.js`; this is the IA change, so it lands before any tab page): rows `mini`; add rows `dock-discover` (Discover with field + mini + receded tabs), `dock-receded` (Today scrolled 120px).
- Three tabs only (Today `#/`, Discover `#/shows`, Library `#/library`); no drawer; `#/create` redirects to Discover with the field focused; `#/starred-shows` to Library; `#/interests` to Tuning. The tab-bar KEEP suites pass against the new markup and the rewritten ones name "4 tabs + drawer".
- One `.veil` surface at `--gutter` inset, 12px above safe-bottom, `--r-xl`, rows top to bottom field (Discover only, 48) / mini (when loaded, 64) / tabs (64, receded 36), divided by a 1px `--rim` inset and no gap: `getBoundingClientRect` of consecutive rows share an edge.
- Mini row: 44 art, `--t-label` title one line, show caption, Ember Play 48, Fwd30 44, a 2px Glow progress line on the Dock's top edge (`aria-hidden`); region label `Now playing: <title>, <show>`; tapping anywhere else opens Now Playing; a 600ms long-press enters car posture.
- Recede: tab row 64 -> 36 (labels fade, icons 28 -> 24) after 80px of downward scroll, restores on any upward scroll, 280ms `--e-out`; always receded on Discover while the field row is present; the Dock is hidden while the field has focus except the field row, and hidden in car posture.
- Dock fade (`calc(var(--safe-bottom) + 12px + 44px)`, bg at 32px) and Dock cast (260px, 14% / 9%, hidden with no mini) are present on every tab page: no text node intersects the band below the Dock's bottom edge at opacity > 0.02 on Today, Discover and Library at 375x667 and 393x852 in both schemes (ported prototype assert).
- Active tab = Fill glyph + `--text`, inert = Regular + `--text-2`; a tab change is a glyph change, visible in greyscale.

**3. `today`** (`ui/home.js`): rows `home`, `home-first-run`, `home-loading`
(no app state today: append a `loading` state to `lib/states.mjs` that holds
the catalog fetch open), plus `mini`; add rows `home-midlisten`, `home-offline`,
`home-stress` (`stress`/`home` exists).
- Header: wordmark Fraunces italic 26px left, gear 44 right, date caption text-3 under; the wash is 48vh behind header and hero, radial from 22%/20% at `--glow-wash` 60/40 with the 52% hot spot (`24% 17%` at 375), `--glow` = the hero's first show, and `--text-2` on the hot-spot row measures >= 4.5:1.
- HeroPick: 160 collage (136 at 375) with 2px gaps and the first show's square whole, Lit art at 64px radius; eyebrow Lamp; title `--t-title` clamped to 4 lines with no ellipsis (`scrollHeight <= clientHeight` on the stress seed); meta caption; Ember Play 56 under the collage's bottom edge; why-line full width, 2 lines, italic text-2.
- Order and copy: "Keep listening" (only mid-listen, one 72-art row with an Ember progress rim), "Today's picks" + count as 4-6 EpisodeRows at 96 min height with one StretchCard never first or last, "Playlists for you" as the only horizontal scroller (2 visible + 24px peek, scroll-snap), "Off your path" with the explainer "About a third of each day sits outside your usual subjects. This is today's third." and 2-3 rows with no Stretch pill. `home-v2` floor test stays green.
- First run: eyebrow "Today's picks", hero = first pick, the list starts at the second pick with its count reduced by one, no "usual subjects" in the hero, no Keep listening. Offline: 36px raised banner `i-wifi-slash` "Offline. Downloaded items play." and unplayable rows at 50% art with the glyph and Play disabled.
- Loading: skeletons for hero + 4 rows with the lamp sweep (both edges transparent, 1.6s), wash at the default Glow; static under reduced motion.
- Pick -> play: the row's art FLIPs into the mini slot 560ms `--e-spring`, `--glow` on `<html>` transitions 560ms; the playing row takes `--glow-row`, a Fill glyph and the Lamp caption "Playing".

**4. `discover`** (`ui/search.js`, `ui/browse.js`, `ui/create.js` folded):
rows `search`, `search-typing`, `search-results`, `search-no-results`; add
rows `discover-kb` (field focused, `?kb=1` pads 300px), `discover-nomini`.
- Idle: title "Discover", then five SectionHeads (Science & nature, People & society, Business & work, Arts & culture, Making & tech) each a 2-up grid of SubjectTiles (56 2x2 collage, name label, "<n> shows" caption); a full-width odd tile steps its name to headline; no pill wall, no "Shows you follow", no taxonomy ids in copy; the ~30% floor test on discovery surfaces stays green.
- The field is the Dock's top row (52 pill, `i-magnifier`, placeholder "Search, or name a subject", `i-x` 44 when filled, 2px Lamp focus ring outside) above the mini row and the receded 36 tab row; while focused the tab and mini rows hide and the field rides above the keyboard (`interactive-widget=resizes-content`).
- Typing (150ms debounce) replaces the list with groups Shows (art 56, name, "<n> episodes"), Episodes (compact row, art 56, no why-line), Playlists; a "Make a playlist from '<q>'" Primary button closes the results list once the text is 3+ characters; it is the Create path, with the lab flag honoured for any network write.
- No result: EmptyState "Nothing named '<q>'." and, when a subject matches by substring, "'<Subject>' is a subject, <n> shows." with that SubjectTile under it; the Make-a-playlist button is also present here.
- Followed shows in results carry the `i-check-circle-fill` Ember badge 20 at the art's bottom-right (the only place besides "Where this came from" where it renders).

**5. `library`** (`ui/library.js`, `ui/queue.js` section): rows `library`;
add rows `library-empty` (`empty`/`library` exists), `library-lower`
(`?scroll`), `library-up-next-menu`.
- Grid 3-up (art 104 at 393, 96 at 375, 112 at 412), forays first as ForayTiles (collage with the 12px strip inside its bottom radius, 20-tall Lamp "Foray" pill top-left, first square whole) then followed ShowTiles with **no** followed badge; names clamp to 3 lines, `align-items: start`, no `.name` with `scrollHeight > clientHeight` at 375 or 393, row gap >= 16px; max 9 cells then an "All" quiet button.
- Sections in order Saved (EpisodeRows, max 5 + "All saved"), Playlists (PlaylistTile rows), Up Next (QueueRows 64, current row first with a Fill glyph 20 and the Lamp caption "Playing", `--glow-row` bg), History (QueueRows, date caption, no menu); 32px between sections, 12 head-to-content, 8 between rows.
- Up Next row menu (`i-dots` 44): Move up, Move down, Remove, Play next; Remove shows a 48px Toast with Undo for 5s; neighbours translate 280ms `--e-out` on reorder; played rows move to the top (ruling kept); `up-next-autoadvance` suite stays green.
- Empty: every section is a SectionHead with no trailing count plus one line and one button ("Find shows" -> Discover, "See today's picks" -> Today); the grid's line is "Nothing followed yet."; no paragraphs.
- Lit art on every tile (40px radius at 104) in that art's own palette colour, no black shadow; the Dock cast is visible under the grid when something plays and absent when nothing does.

**6. `foray-detail`** (`ui/foray.js`): rows `foray`; add rows
`foray-resume` (new step: foray with progress), `foray-unavailable`,
`foray-unnarrated` (new seed flags the agent appends), `foray-dawn`
(`--scheme light` pass).
- A `.room` from the first show's art that follows the scheme: Dusk scrim stops at `safe-top + 56 / 196 / 276`, Dawn paper scrim (`--glow-room` paper0 80% + 20%, art layer 0.55), text ink / ink-2, eyebrow and why-line `--lamp-text`; `--text-2` at the eyebrow's y >= 4.5:1 on every hue in both schemes.
- Layout: chevron-left 44 and dots 44 (share), collage 160 centred with Lit art, eyebrow "Foray · <subject>" in Lamp, title `--t-title` 3-line clamp centred, caption "<n> shows · <m> min · narrated" or "not narrated yet", strip 48 in a sill (`rgb(20 17 15 / .22)`, 10px 12px padding; Dawn `rgb(255 255 255 / .35)`) with a 20px thumb under every bar >= 28px wide and no bar touching a thumb.
- Primary button full width: "Play" / "Resume · 18 min left" (middle dot) / "Play again"; resume also shows the strip fill; tapping a bar plays from there.
- Below: "Why 4a made this" italic 3 lines max, "Where this came from" 3-up ShowTiles with Follow badges (names clamp 3, never cut), then the segment list as QueueRows with narration rows in Lamp and no art.
- Unavailable: collage 50% with `i-wifi-slash`, art layer 0.35, `--glow-room` at 8%, strip 60%, button becomes "Find similar" (Discover with the subject), one line "This foray can't play right now. Its shows are below." Un-narrated: no narration bars, caption only, nothing else apologises.

**7. `onboarding`** (`ui/onboarding.js`): rows `onboarding`; add rows
`onboarding-412` (viewport 412x915), `onboarding-dawn`. Today's intro is a
sheet over Home; this replaces it with a full-screen Room on the same
`first-run` seed and the `#first-time-sheet` ready selector is retired in the
same PR (the row's `app.sheet` region repoints at the Room's inner column).
- A full-screen `.room` cycling four real show arts from the discover pool (6s each, 560ms crossfade; static first art under reduced motion); the wordmark row ends at `safe-top + 54`, the 176px sleeves row starts at `+94` and sits in the scrim's bright zone, the strip (48, drawing in over 1.2s from the first foray's segments) 24px under it, the display title 28px under that.
- Buttons bottom-anchored: Primary "Show my picks" (Ember, 48), Secondary "Skip for now" (44), gap 12, the Primary's bottom edge >= `safe-bottom + 24` above the viewport bottom at 375x667, 393x852 and 412x915; at 412x915 the surplus sits between copy and buttons, never above the sleeves.
- Copy exactly: "Hear things outside your lane." (`--t-display`) and "4a picks a few podcasts a day and says why. No account." (`--t-body`, text-2); `listener-copy` and `copyRules` stay green.
- "Show my picks" transitions into Today (strip collapses toward the hero collage, 420ms; crossfade under reduced motion) and sets the dismissed flag through the shim; "Skip for now" lands on Today with no sheet, and the intro is reachable again from Settings as "What 4a does".
- Dawn: same pixel stops with the Dawn scrim colours, buttons and copy on paper; head icons >= 3:1 over any art in both schemes.

### 2.2 Posture and settings (after the core; need new states)

**8. `now-playing-car`** (`ui/foray-player.js`, `[data-posture="car"]`):
no app state today: append a step `now-playing-car` to `player` that
long-presses the mini player (and honour `?posture=car`); add rows
`now-playing-car`, `now-playing-car-375`.
- Entering: 600ms long-press on the mini row (medium haptic hook), Now Playing opens by itself, the Dock, Dock fade and Dock cast are hidden; leaving: the `i-car` chip at the top.
- Artwork 240 (200 under 700px tall), Play 112, skips 72, `--t-display`/`-headline`/`-label` x1.25 with unitless leading (line-height scales with size), why-line, secondary row and "More" handle hidden, show notes and chapters not rendered.
- The Play button's bottom edge is >= 24px above the viewport bottom at 393x852 and 375x667 (harness assertion ported as a test with its mutation).
- Title clamps to 3 lines at >= 800px tall and 2 below; no ellipsis beside empty Room space at 393x852.

**9. `settings-tuning-about`** (`ui/interests.js` becomes Tuning; a new
`ui/settings.js`): app state `interests` exists for Tuning; Settings and About
need a new `settings` state (append `settings`, `tuning`, `about` steps to
`returning`). The prototype draws no settings page, so this screen takes the
is-it-better pair only and builds from the inventory.
- One gear on Today opens a Sheet (veil header 56 with grabber, `i-x` 44, focus trapped and returned) listing Settings, Tuning, About, "What 4a does"; no drawer remains in the DOM.
- Tuning: one row per subject with three states (less / 4a's pick / more) as a segmented control of 44-tall Chips, selected = Lamp fill, ink bg0; no sliders; the choice persists through the shim under an existing `cp_` key and the delete-data path still clears it.
- Settings: appearance Dusk / Dawn / Follow system (writes `cp_theme`, applies `data-theme` live), downloads, delete data; About: version, licences (fonts OFL, Phosphor MIT); every control 44px, every pair AA in both schemes.
- Copy obeys the rules: no "we/us/our", "subject" not "topic", why/hook limits where applicable.

### 2.3 The rest, in `lib/states.mjs` order (no prototype route; is-it-better pair only, built from the inventory)

**10. `show`** (`ui/show.js`, `returning`/`show`): art 160 Lit at the top on a scheme-following `.room` from the show's palette colour; Follow as a Secondary button that becomes Fill `i-check-circle-fill` + "Following"; episodes as EpisodeRows 96 with two-line why-lines; latest first; no hairline borders. 3-5 criteria: Room scrim text pairs AA; Follow toggle is a fill change; rows match the gallery EpisodeRow pixel-for-pixel in the gallery baseline.

**11. `episode`** (`ui/episode.js`, `returning`/`episode`, `stress`/`episode`, `episode-token`): art 160 Lit, title `--t-title` 3-line clamp never cut mid-word (stress seed, unbreakable token), show caption, why-line italic, Primary Play 48 + Save (bookmark fill) + Add to Up Next (`i-queue`, art flies to the Library tab) as 44 targets, show notes 4-line clamp through `esc()`/`safeUrl()` with timestamp Chips that seek. Criteria: no horizontal overflow at 375/393/412 on the token seed; the three actions are 44px; Up Next add animates and updates the tab badge (count only under reduced motion).

**12. `playlist-detail`** and **`playlists`** (`ui/playlist.js`, `returning`/`playlist-detail`, `playlists`, `playlist-not-found`): PlaylistTile composite cover 120 2x2 at the top, name headline, "<n> episodes, <h> hr <m> min", "3 of 6 played" in Ember when started, episodes as EpisodeRows; the playlists page is 2-up PlaylistTiles. Not found: EmptyState one line, one button. Criteria: composite never crops a square; counts tabular; the 2-up grid is 164 wide at 393, 176 at 412.

**13. `up-next`** (`ui/queue.js`, `#/queue`, `returning`/`up-next`, `player`/`mini-player-up-next`): the Library Up Next section as a full page, same QueueRow, same menu and undo Toast; current row first and marked by glyph + "Playing". Criteria: `up-next-autoadvance` green; the toast sits 8px above the mini row; reorder translates neighbours 280ms.

**14. `forays-list`** (`ui/forays.js`, `returning`/`forays`): 2-up ForayCards (collage 120, eyebrow "Foray", title headline, "<n> shows, <m> min", strip 12), in-progress fill and finished check. Criteria: never a 3-up ForayCard; first square whole; the page has the Dock cast when something plays.

**15. `category-and-browse`** (`ui/browse.js`, `returning`/`category`, `browse-pill`): the subject page is Discover's result anatomy under a SectionHead with the subject's 56 collage; shows as ShowTiles 3-up with Follow badges (state varies here), episodes as EpisodeRows; no pill wall. Criteria: names clamp 3 and never cut; the floor test on discovery surfaces green; the field stays docked.

**16. `not-found`** (`empty`/`playlist-not-found`, `episode-not-found`): EmptyState centred, one line ("Nothing here any more."), one Secondary button to Today; Dock present. Criteria: copy passes the rules; the button is 44px; no horizontal overflow.

## 3. Exit

After screen 16: full `node tools/ci/run-suites.mjs`, `gates.mjs` on every
state with `--allow` and `--no-remote-images`, `a11y.mjs` on every route and
state in both schemes, `ambient-gallery` and `ambient-app` baselines compared
clean, one `PROGRESS.md` line per screen, then Phase 5 (QA, perf budget with
the Veil on and off on the Android lab build, store shots and copy, haptics,
palette in the nightly refresh as a trunk PR). No app icon.
