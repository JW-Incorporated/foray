# Afterglow: build notes

Everything a front-end builder needs to reproduce the "ambient" direction
(`DIRECTION.md`) without the director. Read that file first for the intent;
this one is the numbers. All values are CSS px at 1x. Hard limits from
`../../PLAN.md` apply throughout: `esc()`/`safeUrl()`, no inline `style=` or
`<script>`, `cp_` storage keys through the shim, 44px targets, one
`prefers-reduced-motion` block, AA contrast, no third-party imagery committed.

Prototype target: `docs/redesign-2026/directions/ambient/prototype/index.html`
plus `afterglow.css`, `afterglow.js`, `icons.svg`. Real data from
`data/catalog-client.json`, `data/discover.json`, `data/session.json`; artwork
loaded from its published URL at runtime; fonts self-hosted from `fonts/`.

## 1. Tokens

Put every token on `:root`. The Dawn block overrides neutrals and Ember under
`@media (prefers-color-scheme: light)` guarded by `:root:not([data-theme="dusk"])`,
and again under `:root[data-theme="dawn"]`. The player (`.room`) never reads
the scheme tokens for its backdrop; it reads Glow.

### 1.1 Colour

```
/* Dusk (default) */
--bg0: #14110F;        /* page */
--bg1: #1D1916;        /* raised card, row */
--bg2: #272220;        /* raised-on-raised: chips on a card, menu */
--text: #F5EEE4;       /* 16.3:1 on bg0 */
--text-2: #B9AFA3;     /* 8.7:1 on bg0, 7.3:1 on bg2 */
--text-3: #9A9188;     /* 6.1:1 on bg0, 5.1:1 on bg2; captions only, never under 13px */
--ember: #F0A64B;      /* listener's own; 9.2:1 on bg0 as text; ink on it = bg0 (9.2:1) */
--lamp: #F3E7D3;       /* 4a authored; 15.4:1 on bg0; ink on it = bg0 */
--rim: rgb(243 231 211 / 0.10);   /* 1px top highlight on Raised */
--overlay: rgb(243 231 211 / 0.06); /* Raised fill over bg0 */
--shadow-1: 0 1px 2px rgb(10 6 4 / 0.40);
--shadow-2: 0 8px 24px rgb(10 6 4 / 0.35);
--scrim-top: rgb(20 17 15 / 0.20);
--scrim-bottom: rgb(20 17 15 / 0.82);
--ok: #7FCB8E;         /* downloaded, done; 9.9:1 on bg0 */
--warn: #E9B46A;       /* offline, unavailable; never alone, always with a glyph */

/* Dawn */
--bg0: #F7F2EB; --bg1: #FDFAF5; --bg2: #EFE8DF;
--text: #1E1A17; --text-2: #5E564E; --text-3: #6B635A;   /* 15.5, 6.5, 5.3 on bg0; 4.9 lowest on bg2 */
--ember: #8E520E;      /* 5.6:1 on bg0, 5.1:1 on bg2; ink on it = #FFFFFF (6.2:1) */
--lamp: #FFFFFF;       /* narration bars on Dawn carry a 1px #E0D6C8 edge */
--rim: rgb(255 255 255 / 0.80);
--overlay: rgb(255 255 255 / 0.55);
--shadow-1: 0 1px 2px rgb(60 40 20 / 0.10);
--shadow-2: 0 8px 24px rgb(60 40 20 / 0.10);
--scrim-top: rgb(20 17 15 / 0.20);          /* the Room is always dark-scrimmed */
--scrim-bottom: rgb(20 17 15 / 0.82);

/* Glow: dynamic, set by JS on <html> (app-wide) and on .room (player) */
--glow: oklch(0.66 0.12 60);      /* default before any item plays: warm neutral */
--glow-l: 0.66;                   /* clamped lightness, see 1.2 (raised from 0.62 after round 1) */
--glow-veil: color-mix(in oklab, var(--bg0) 72%, var(--glow) 28%);   /* the Dock (round 1: 18% was invisible) */
--glow-row:  color-mix(in oklab, var(--bg1) 82%, var(--glow) 18%);   /* the playing row */
--glow-wash: color-mix(in oklab, var(--bg0) 60%, var(--glow) 40%);   /* Today top wash */
--glow-room: color-mix(in oklab, var(--bg0) 85%, var(--glow) 15%);   /* the Room's base under the scrim */

/* Segment colours: per show, derived (1.2); these are the fallback set */
--seg-c0: #2A9D8F; --seg-c1: #E76F51; --seg-c2: #8E6FD8; --seg-c3: #4C8DF5;
--seg-c4: #D9A441; --seg-c5: #5FB4C9; --seg-c6: #C46BAE; --seg-c7: #7BA05B;
--seg-narration: var(--lamp);
--seg-dim: 0.38;                  /* opacity of unplayed bars */
```

Register the dynamic colours so they animate:

```
@property --glow { syntax: '<color>'; inherits: true; initial-value: #8A6A4E; }
```

`color-mix(in oklab, …)` and `oklch()` are supported in current WKWebView and
Android WebView (Chrome 111+ / Safari 16.4+). Ship a static fallback declared
first (`--glow-veil: #221C19;`) for anything older.

### 1.2 Glow and segment colour derivation (JS, `palette.js`)

1. **Source order.** (a) `show.art.palette` from `catalog-client.json` if the
   nightly refresh has written one (a `[h, c]` pair in OKLCH, computed in
   `tools/refresh` from the artwork with a median-cut on a 32px thumbnail;
   this is the primary path because publisher art usually lacks CORS headers,
   which taints a canvas). (b) Runtime canvas extraction on the episode art,
   `crossorigin="anonymous"`, in a `try`; on a `SecurityError` fall through.
   (c) Hash hue: `h = (fnv1a(showId) % 360)`, `c = 0.10`.
2. **Clamp.** Keep hue and chroma; set lightness: Dusk `L = 0.66`, Dawn
   `L = 0.56`, chroma capped at `0.14`. Text never sits on Glow directly, so the
   clamp exists for mood consistency, not contrast. Contrast is guaranteed by
   the scrim and the mix percentages: at 28% in the Veil, 18% in a row and 15%
   in the Room base the worst case (a pure chroma 0.14 colour at L 0.66 over
   bg0) must still be darker than `#5A4A42` on Dusk and lighter than `#D9C7B8`
   on Dawn; add the three Dusk pairs and the Dawn Veil pair to
   `contrast-check.mjs`, re-run it, and record the worst case in its output
   (round 1 was measured at 18/12 only).
3. **Segment colours.** Per show in a foray, take the show's derived hue, set
   `L = 0.70`, `C = 0.13` (Dusk) or `L = 0.52`, `C = 0.13` (Dawn). Sort the
   shows by first appearance; if a show's hue is within 24 degrees of any
   earlier show's, rotate it +30 degrees and re-check (max 3 rotations). Cache
   the result per foray id in memory; cache per-show hue in
   `cp_palette` (through the shim) as `{showId: [h, c]}`, max 400 entries.
4. **Apply.** Set `--glow` on `document.documentElement` when the current item
   changes and on `.room` when a foray segment changes. The `@property`
   registration makes the transition `560ms` (token `--m-room`).

### 1.3 Type

```
--font-display: 'Fraunces', Georgia, serif;
--font-text: 'DM Sans', system-ui, sans-serif;

--t-display: 500 32px/1.125 var(--font-display);  /* Now Playing title only; unitless leading so car posture scales both */
--t-title:   500 26px/30px var(--font-display);   /* screen titles, foray names, the Today hero title */
--t-headline:500 20px/1.2 var(--font-display);    /* card titles, section heads */
--t-why:     italic 400 17px/24px var(--font-display);  /* why-lines, bridges */
--t-body:    400 16px/24px var(--font-text);
--t-label:   600 14px/1.3 var(--font-text);       /* buttons, tabs, chips, mini title, subject names */
--t-caption: 500 13px/18px var(--font-text);      /* meta, times, eyebrows (uppercase, 0.06em) */
```

Fraunces: `font-variation-settings: 'SOFT' 100, 'WONK' 0; font-optical-sizing: auto;`.
Numbers: `font-variant-numeric: tabular-nums` on `.time`, `.count`, `.dur`.
Every size is also expressed in `rem` in the stylesheet (16px root) so Android
font scale applies; the seven tokens above are the only sizes. Eyebrows are
`--t-caption` uppercase with `letter-spacing: 0.06em`, in `--lamp` when 4a
authored, `--text-3` otherwise. The wordmark is Fraunces italic 500, used once,
in the Today header.

Car posture multiplies `--t-display`, `--t-headline` and `--t-label` by 1.25 via
a `[data-posture="car"]` block; nothing else changes size. Those three tokens
carry unitless line-height for exactly this reason: round 1 scaled the size
but not the leading and the title double-spaced.

The wordmark is Fraunces italic 500 26px, used in the Today header and on
onboarding.

### 1.4 Space, radius, size

```
--s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 20px; --s-6: 24px; --s-8: 32px; --s-10: 40px; --s-12: 48px;
--gutter: 16px;                 /* 375 */
@media (min-width: 393px) { --gutter: 20px; }

--r-xs: 4px;   /* strip bars, progress lines, badges */
--r-sm: 8px;   /* artwork <= 56 */
--r-md: 12px;  /* artwork 72-120, buttons, inputs */
--r-lg: 16px;  /* cards, rows, hero collage, artwork 160+ */
--r-xl: 24px;  /* sheets, Now Playing artwork */
--r-pill: 999px;
--r-round: 50%;

--art-mini: 44px; --art-queue: 56px; --art-row: 72px; --art-tile: 104px; --art-foray: 120px; --art-hero: 160px;
--row-episode: 96px; --row-queue: 64px; --row-show: 64px;      /* episode rows carry a two-line why-line */
--tab-bar: 64px; --mini: 64px; --field: 52px;
--tap: 44px;
--safe-top: env(safe-area-inset-top, 0px); --safe-bottom: env(safe-area-inset-bottom, 0px);
--chrome-bottom: calc(var(--tab-bar) + var(--safe-bottom) + 12px);   /* content padding when no mini */
--chrome-bottom-mini: calc(var(--chrome-bottom) + var(--mini) + 8px);
```

### 1.5 Materials

```
.raised {            /* cards, rows, tiles */
  background: linear-gradient(var(--overlay), var(--overlay)) var(--bg1);
  box-shadow: inset 0 1px 0 var(--rim), var(--shadow-1), var(--shadow-2);
  border-radius: var(--r-lg);
}
.veil {              /* the Dock and sheet headers: the only backdrop-filter */
  background: var(--glow-veil);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  backdrop-filter: blur(20px) saturate(140%);
  box-shadow: inset 0 1px 0 var(--rim), var(--shadow-2);
}
.dock {              /* one .veil holding, top to bottom: [field row 48, Discover only] [mini row 64, when playing] [tab row 64 / 36 receded] */
  position: absolute; left: var(--gutter); right: var(--gutter); bottom: calc(var(--safe-bottom) + 12px);
  border-radius: var(--r-xl); overflow: hidden;
}
.dock > * + * { box-shadow: inset 0 1px 0 var(--rim); }   /* rows divided by the rim, no gaps */
.room {              /* Now Playing and Foray detail backdrop */
  background: var(--glow-room);          /* never plain bg0: the lower half stays in the show's colour */
  isolation: isolate;
}
.room::before {      /* the artwork, blurred, over the Glow gradient (the gradient is the fallback, not the Room) */
  content: ''; position: absolute; inset: -12%;
  background:
    var(--room-art) center / cover,
    radial-gradient(120% 55% at 50% 18%, color-mix(in oklab, var(--glow) 55%, transparent), transparent 75%);
  filter: blur(64px) saturate(130%);
  transform: scale(1.4);
  opacity: 0.9;
}
.room::after {       /* the scrim; text sits only on the lower 55% */
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(180deg, var(--scrim-top) 0%, var(--scrim-top) 35%, var(--scrim-bottom) 55%, rgb(20 17 15 / 0.92) 100%);
}
```

`--room-art` is set by JS as `url("…")` after `safeUrl()`; no inline
`style=`, so set it with `el.style.setProperty('--room-art', …)` from script
(CSP allows CSSOM writes; it forbids inline attributes).

Fallbacks, all in one place:

```
@supports not (backdrop-filter: blur(1px)) { .veil { background: var(--bg1); } }
@media (prefers-reduced-transparency: reduce) { .veil { backdrop-filter: none; background: var(--bg1); } }
@media (prefers-contrast: more) {
  .veil { backdrop-filter: none; background: var(--bg0); }
  .room::before { opacity: 0.35; }
  .raised { box-shadow: inset 0 0 0 1px var(--text-3); }
}
```

Veil area budget: the Dock is the only blurred surface: tabs (64) + mini (64)
= 128px, or on Discover field (48) + mini (64) + receded tabs (36) = 148px;
a sheet header adds 56px only while a sheet is open. Never put `.veil` on a
scrolling list item. Because the Dock is one surface, no content ever shows
through a gap between the mini player and the tab bar (a round-1 defect).

### 1.6 Motion

```
--m-micro: 160ms; --m-ui: 280ms; --m-sheet: 420ms; --m-room: 560ms;
--e-out: cubic-bezier(0.2, 0.8, 0.2, 1);
--e-spring: linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077 20.4%, 1.121, 1.149 24.3%, 1.159, 1.163 27.8%, 1.154, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1.001 85.5%, 1);
--e-spring-soft: linear(0, 0.013, 0.05 2.5%, 0.2 5.6%, 0.56 11.2%, 0.86 16.8%, 0.98 20.4%, 1.03 24%, 1.045 27.6%, 1.04 31.2%, 1.02 36.8%, 1.004 42.4%, 0.996 48%, 0.998 58%, 1);
```

`--e-spring` has overshoot (use on the mini player snap, the strip draw-in,
the Up Next add). `--e-spring-soft` is near-critical (sheets, the Room expand).
Animate only `transform`, `opacity` and registered custom properties.

Reduced motion, one block, nothing outside it:

```
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 200ms !important; transition-property: opacity, color, background-color !important; }
  .strip .bar { transition: none; }           /* fill steps */
  .room::before { transition: none; }         /* no Room drift */
  ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
}
```

## 2. Icons

Phosphor Icons (MIT), Regular weight for inert, Fill for toggled states, 24px
grid, `stroke: none` (Phosphor is filled paths at every weight). Build one
sprite `icons.svg` with `<symbol id="i-…" viewBox="0 0 256 256">`, referenced
as `<svg class="icon" aria-hidden="true"><use href="icons.svg#i-house"/></svg>`,
`fill: currentColor`. Default size 24; 20 inside chips and captions; 28 in the
tab bar; 32 for transport secondary; the play glyph is drawn at 36 inside the
88px button and 24 inside the 48px mini button.

Required symbols (Regular / Fill pairs where a toggle exists):

| id | Phosphor name | use |
|---|---|---|
| i-house, i-house-fill | house | Today tab |
| i-compass, i-compass-fill | compass | Discover tab |
| i-books, i-books-fill | books | Library tab |
| i-play, i-pause | custom (see below) | transport, mini, rows |
| i-back15, i-fwd30 | custom | transport, mini, lock screen |
| i-skip-next | skip-forward | Up Next peek, detail posture |
| i-bookmark, i-bookmark-fill | bookmark-simple | save |
| i-check-circle-fill | check-circle | followed, played |
| i-download, i-download-fill | arrow-circle-down | downloaded state |
| i-queue | list-plus | add to Up Next |
| i-dots | dots-three | row menu |
| i-chevron-left / -right / -down | caret-* | nav, disclosure |
| i-magnifier | magnifying-glass | field |
| i-x | x | clear field, dismiss toast |
| i-share | share-network | share |
| i-moon | moon | sleep timer |
| i-gauge | gauge | speed |
| i-sliders | sliders-horizontal | Tuning |
| i-gear | gear-six | settings button on Today |
| i-wifi-slash | wifi-slash | offline |
| i-sparkle | sparkle | "4a picked this" eyebrow, Stretch pill |
| i-car | car | car posture indicator |

Custom glyphs (three), drawn on the same 256 grid, filled paths:

- `i-play`: an equilateral triangle, corners rounded 12 units, optical centre
  shifted +8 units right. `i-pause`: two bars 40 wide, gap 32, corners 12.
- `i-back15` / `i-fwd30`: a 270 degree arc of stroke width 22 (expanded to a
  fill) with an arrowhead at the open end (anticlockwise for back, clockwise
  for forward), and the numeral "15" or "30" set in DM Sans 600 converted to
  outlines, 84 units tall, centred. The lock screen uses the same artwork
  rasterised to the media-session action icon sizes.

No Unicode glyphs anywhere, including `…`: truncation is CSS `text-overflow`.

## 3. Component inventory

Every component below has one treatment. If a screen needs something not
listed, add it here first.

| Component | Anatomy | Sizes | States |
|---|---|---|---|
| **Dock** `.veil` | the one floating chrome surface: rows top to bottom are SearchField (Discover only), MiniPlayer (when something is loaded), TabBar; rows divided by a 1px `--rim` inset line, no gaps; 12px above safe bottom at `--gutter` inset, `--r-xl`, `overflow: hidden` | 64 (tabs) / 128 (tabs + mini) / 148 (Discover: field + mini + receded tabs) | hides while the field has focus except the field row; hidden in car posture; the 2px `--glow` progress line runs along the Dock's top edge, or along the mini row's top edge when the field is above it |
| **TabBar** (Dock row) | 3 items, icon 28 over label `--t-caption`; active = Fill icon + `--text`; inert = `--text-2` | 64 tall, items 44+ wide | recedes to 36px (label hidden, icons 24) after 80px of downward scroll, returns on any upward scroll; always receded on Discover while the field row is present |
| **MiniPlayer** (Dock row) | art 44 `--r-sm`; title `--t-label` 1 line; show `--t-caption` `--text-2`; Play 48 round Ember (ink bg0); Fwd30 44 `--text` | 64 tall | playing / paused (Fill vs Regular) / buffering (glyph opacity breathes 1.0→0.85, 900ms) / drag (follows finger, opens at 96px) |
| **PlayButton** | round, Ember fill, `i-play`/`i-pause` in bg0 | 88 (Now Playing), 56 (hero, Foray detail), 48 (mini), 44 (rows: outlined `--text-2`, no fill) | pressed: scale 0.94 `--m-micro`; disabled: 40% opacity + `aria-disabled` |
| **SkipButton** | `i-back15`/`i-fwd30`, `--text` | 56 target, 32 glyph (Now Playing); 44/24 (mini) | pressed scale 0.94 |
| **Scrubber** | track 4px `--r-xs` on `rgb(255 255 255 / 0.18)`, fill `--lamp`; thumb 16px round `--lamp`, grows to 24 on drag; times `--t-caption` tabular under each end | hit area 44 tall, full width minus gutters | drag shows a 32px time bubble `.raised` above the thumb |
| **Strip** (foray) | bars with 2px gaps, `--r-xs`; width proportional to runtime, min 6px; show bars in their segment colour; narration bars `--seg-narration` and 4px tall centred (thin lights); unplayed bars at `--seg-dim`; **current bar**: full opacity, 4px taller than its neighbours (all centre-aligned), fill `color-mix(in oklab, var(--c) 85%, var(--lamp))` growing left-to-right; **no ring, no outline** (a hairline) | 48 tall on Foray detail: a 24px bar row, 4px gap, a 20px thumb row with a `--r-xs` artwork thumb left-aligned under every bar 28px or wider, never overlapping a bar; 32 in Now Playing (bars 16, no thumbs); 12 in cards and tiles (bars 8, no thumbs) | draw-in (bars scale-x from 0 in sequence, 60ms stagger, `--e-spring`); each bar is a 44-tall `button` with `aria-label="Seek to <show>, <mm:ss>"` |
| **EpisodeRow** `.raised` | art 72 `--r-md`; title `--t-headline` 2 lines; show `--t-caption` `--text-2`; why-line `--t-why` **2 lines** `--text-2`; meta row: duration tabular, dot, date; trailing Play 44 outlined (`flex: none`); a 4px Ember progress rim inside the art's bottom edge when started | 96 min height (grows with text), padding 12, gap 12 | playing (`--glow-row` background, Fill play glyph, "Playing" caption in `--lamp`); played (`i-check-circle-fill` `--text-3` before duration); downloaded (`i-download-fill` `--ok`); unavailable (art 50%, `i-wifi-slash` `--warn`, play disabled); pressed (background `--bg2`) |
| **StretchCard** `.raised` | pill "Stretch" (`i-sparkle` + label, `--lamp` fill, ink bg0) top-left; two arts 56 `--r-sm` at the ends of a 2px `--lamp` line with a 6px round dot at its midpoint; bridge `--t-why` `--text`; then a row: text column (`flex: 1 1 auto; min-width: 0`) holding title `--t-headline` 2 lines and caption `show · duration · date` one line ellipsis, trailing Play 44 outlined (`flex: none; width: 44px; height: 44px`) | padding 16, line spans the width minus 2×56+24 | same as EpisodeRow. Round 1 shipped this with no title, a one-word-per-line caption and the Play button stretched full width; the flex rules above are the fix |
| **ForayCard** `.raised` | collage 120 `--r-md` (2×2 of show arts, 2px gaps; 1, 2 or 3 shows per the no-crop rule in §10.5); eyebrow "Foray" `--lamp`; title `--t-headline`; "4 shows, 42 min" `--t-caption`; strip 12 tall | 2-up tiles 164 wide at 393; **never in a 3-up grid** (use ForayTile) | in progress (strip fill), finished (`i-check-circle-fill`) |
| **ForayTile** | collage 104 `--r-md` with the 12-tall strip (bars 8) drawn along the collage's bottom edge inside its radius; a 16px Lamp pill "Foray" at the collage's top-left; name `--t-caption` 2 lines under | 3-up in the Library grid, same cell as ShowTile | in progress (strip fill), finished (`i-check-circle-fill` badge bottom-right, like followed) |
| **HeroPick** | collage 160 `--r-lg` left; right column: eyebrow `--lamp` ("Today's foray" / "Today's picks"), title `--t-title` **4 lines max, never an ellipsis** (§10.6), meta caption, PlayButton 56; the why-line `--t-why` `--text-2` spans the full width under the pair, 2 lines | grid `160px 1fr`, gap 16; at 375 the collage is 136 | first run (hero = the first pick; the picks list then starts at the second pick and its count drops by one; copy per 4.1) |
| **ShowTile** | art 104 `--r-md` grid cell with name `--t-caption` under, 2 lines, `overflow-wrap: normal; text-overflow: ellipsis` (never cut mid-word: round 1's 4-up clipped "Unexplainabl") | 3-up everywhere: 104 at 393, 96 at 375, 112 at 412; Lit art at 40px (§10.2) | followed (`i-check-circle-fill` Ember badge, 20, bottom-right of art) **only where the state varies**: Discover results and "Where this came from". Never in Library, where everything is followed (§10.7) |
| **SubjectTile** `.raised` | Collage 56 `--r-sm` (2×2 of the subject's first four shows, 2px gaps) left; name `--t-label`; "5 shows" `--t-caption` `--text-2` | 2-up, 72 tall, padding 12, gap 12 | pressed |
| **PlaylistTile** `.raised` | composite cover 2×2 of episode arts 120 `--r-md`; name `--t-headline`; "6 episodes, 2 hr 10 min" caption; "3 of 6 played" in Ember when started | 2-up | — |
| **QueueRow** `.raised` | art 56 `--r-sm`; title `--t-label` 2 lines; show + remaining `--t-caption`; `i-dots` 44 trailing | 64 min | current: Fill play glyph 20 before the title, "Playing" caption `--lamp`, `--glow-row` bg; auto-added: eyebrow "4a added" `--lamp` + its reason line |
| **SearchField** `.veil` | `i-magnifier` 20; input `--t-body`; `i-x` 44 when filled; placeholder "Search, or name a subject" | 52 tall, pill, docked above MiniPlayer/TabBar | focus: 2px `--lamp` ring outside (not inside); typing: a trailing "Make a playlist" chip appears once the text is 3+ chars and matches no show |
| **Chip** | `--t-label`, pill, `--bg2` fill, `--text`; selected: `--lamp` fill, ink bg0 | 36 tall, 44 target via padding | — |
| **Pill (eyebrow badge)** | `--t-caption` uppercase, `--lamp` fill, ink bg0; icon 16 optional | 22 tall | used for Stretch, Foray, 4a added |
| **SectionHead** | `--t-headline` + optional trailing count `--t-caption` `--text-3`; optional one-line explainer `--t-body` `--text-2` under | margin-top 32, bottom 12 | — |
| **Sheet** | `--r-xl` top corners, `.veil` header 56 with grabber 36×4 `--text-3` at top centre, title `--t-headline`, close `i-x` 44 right; body `--bg0` | partial 60% / full; drag to dismiss | focus trapped; returns to opener on close |
| **Toast** `.raised` | `--t-label` + action "Undo" in Ember | 48, bottom 8 above MiniPlayer, 5s | — |
| **Skeleton** | `--bg1` blocks with the component's radii; lamp sweep: `linear-gradient(90deg, transparent 0%, var(--overlay) 50%, transparent 100%)` at `background-size: 40% 100%`, position animated from -40% to 140% every 1.6s (both edges transparent: round 1's sweep had a hard left edge) | — | reduced motion: static |
| **EmptyState** | one line `--t-body` `--text-2`, one button (outlined `--text`, pill, 44) | centred in the section, 32 padding | — |
| **Collage** | 2×2 arts with 2px gaps inside one radius, `overflow: hidden`; 3 arts = 1 big left + 2 stacked right; 1 art = plain | per parent | lazy `loading="lazy"`, `decoding="async"` |

Buttons: three styles only. **Primary** Ember fill, ink bg0, pill, `--t-label`,
48 tall. **Secondary** outlined 1.5px `--text-2`, text `--text`, pill, 44.
**Quiet** text-only `--t-label` `--ember`, 44 target. Icon buttons are 44
round, no fill, `--text`. No other button exists; "Stop", "Saved ✓", boxed
"Bookmark" and the orange outline all map onto these.

## 4. Screens

Column: `padding-inline: var(--gutter)`. Vertical rhythm: 32 between sections,
12 between a head and its content, 8 between rows, 16 between cards. Content
`padding-bottom: var(--chrome-bottom[-mini])`. Status bar is transparent
(`StatusBar.setOverlaysWebView(true)`, light content on Dusk and the Room, dark
on Dawn); screens pad `--safe-top + 8`.

### 4.1 Today

```
[safe-top + 8]
Header row (44): wordmark "4a" Fraunces italic 500 26px left; gear 44 right. Greeting caption under: "Monday, 5 October" --text-3.
Wash: 48vh, position absolute, z -1, pointer-events none, behind header and hero:
  background: radial-gradient(120% 70% at 22% 20%, var(--glow-wash) 0%, transparent 70%), linear-gradient(var(--glow-wash), var(--bg0));
  The light comes from the collage (its centre is near 22%/20% of the wash). --glow here = the hero's first show.
[20]
HeroPick (3.x). First run copy: eyebrow "Today's picks", title = first pick title, why = its why-line, button "Play"; the picks list below then starts at the second pick. The first-run hero never cites "usual subjects".
[32]
"Keep listening" (only when something is mid-listen): one EpisodeRow, art with progress rim.
[32]
"Today's picks" + count: 4-6 EpisodeRows in a vertical list; one StretchCard in the list (never first, never last).
[32]
"Playlists for you": horizontal rail of PlaylistTiles, 2 visible + 24px peek, scroll-snap, 12 gap; the rail is the only horizontal scroller on the screen.
[32]
"Off your path", explainer "About a third of each day sits outside your usual subjects. This is today's third.": 2-3 EpisodeRows. Items here carry no Stretch pill (the section is the label).
[chrome-bottom]
```

States: **returning** as above; **first run** no Keep listening, hero copy per
above, "Off your path" still present; **mid-listen** Keep listening present
and MiniPlayer docked; **stress** titles clamp at 2 lines in rows, 3 in the
hero, never cut mid-word (`overflow-wrap: anywhere` is off; `-webkit-line-clamp`
on); **offline** a 36px `.raised` banner under the header with `i-wifi-slash`
and "Offline. Downloaded items play." and unplayable rows in the unavailable
state; **loading** skeletons for hero + 4 rows, the wash stays at the default
Glow.

At 375: hero collage 136, gutter 16, rail tiles 156. At 412: as 393 with gutter
20 and 2-up tiles 176.

### 4.2 Now Playing (sheet over everything, `.room`)

```
[safe-top + 12]
Grabber 36×4 centred; chevron-down 44 left; dots 44 right (menu: share, show page, sleep).
[16]
Artwork: --np-art square, --r-xl, shadow-2, centred. Foray: the collage.
  --np-art: clamp(220px, calc(100vh - 520px), 320px) so a tall screen grows the art instead of leaving a band of nothing between the why-line and the strip (round 1 had ~95px of it at 393x852); 220 under 700px tall; 180 with a 3-line title (.np--long, JS measures once after layout).
[20]
Eyebrow slot, 18px, reserved so the title never jumps: holds only the transient --lamp caption "Now: <show>" for 3s after a segment change and for 3s after the sheet opens, then fades (280ms). Never a permanent line (round 1 showed the show name twice).
Title --t-display, 3-line clamp, centred, --text.
Show --t-body --text-2, 1 line. Foray: "4 shows · <current show>", which crossfades on each segment.
Why-line --t-why --lamp, 2-line clamp.
[24]
Strip (foray, 32 tall) or Scrubber (episode). Times under: elapsed left, "-remaining" right, tabular.
[20]
Transport row: Back15 (56) — Play (88) — Fwd30 (56), gap 24, centred. Bottom of the Play button sits at >= 24px above the detail handle.
[16]
Detail handle: caption "More" + chevron-down, 44 tall, centred (scroll cue). The first viewport ends here.
---- scroll ----
Secondary row: Speed (shows "1x"), Sleep, Bookmark, Share as 44 icon buttons with captions, evenly spaced.
Chapters / Segments list: QueueRow anatomy; foray segments show the show art, the show name, clip time range, and "Narration" rows in --lamp with no art.
"Where this came from" (foray): ShowTiles 3-up with Follow.
Show notes: --t-body, 4-line clamp + "More" quiet button; feed HTML through esc()/safeUrl(); timestamps as Chips that seek.
Up Next peek: "Up next" head + one QueueRow with its reason line + "Up Next (5)" quiet button opening Library > Up Next.
[safe-bottom + 24]
```

375×667 check (no safe-area in the harness; title 2 lines): 12+44+16+280+20+72+24+48+16+32+18+20+88+16+44 = 750. That overflows, so under `@media (max-height: 700px)` the artwork is 220 and the why-line clamps to 1 line: 12+44+16+220+20+72+24+24+16+32+18+20+88+16+44 = 666; with a 3-line title (`.np--long`) the artwork drops to 180: 662. Play and the detail handle stay on screen at 375×667 in every state; the builder asserts this in the harness.

States: **episode** scrubber; **foray** strip plus segment list, the Room
colour follows the segment, the show name under the title crossfades 280ms;
**paused** Play shows `i-play`, Room `::before` opacity 0.7; **buffering**
glyph breathes, scrubber fill at the buffered position in `--text-3` under
the played fill; **offline/downloaded** `i-download-fill` `--ok` before the
elapsed time; **end of item** next artwork enters from +100% x with
`--e-spring-soft` 560ms as the old one exits to -24% and fades, Room
crossfades, title swaps; **long title at 375** handled above; **max text
size** everything in rem, artwork min 160, title max 3 lines at 1.3x then
2 lines beyond.

**Car posture** (`[data-posture="car"]` on `<html>`): Dock hidden, Now
Playing opens automatically, secondary row, why-line and the "More" handle
hidden, artwork 240 (200 under 700px tall), Play 112, skips 72, type ×1.25,
show notes and chapters not rendered. Harness assertion: the Play button's
bottom edge is at least 24px above the viewport bottom at 393x852 and
375x667 (round 1 clipped it).

**Skip glyphs**: `i-back15`/`i-fwd30` are drawn at 36 inside the 56 targets
(round 1's ~28 was dwarfed by the 88 Play). Trigger: a car
Bluetooth route observed (Native plugin; stubbed in the prototype by
`?posture=car`), or long-press on the MiniPlayer (600ms) as the manual path;
leaving: the route ends, or tap the `i-car` chip at the top.

### 4.3 Mini player (a Dock row)

The mini player is the row above the tab row inside the Dock (section 3):
one Veil surface, one radius, a rim line between rows, no gap. Tapping
anywhere except the two buttons opens Now Playing. Drag up: the sheet follows
the finger from 0 (`translateY(100%)`) to the open state; past 96px of travel
on release it springs open (`--e-spring`, 420ms) with one medium haptic;
otherwise it springs back. Swipe down on the open sheet mirrors this. Swipe
left/right on the mini bar does nothing (walking protection); dismissing
playback is "Stop" in the dots menu, with an undo toast.

`role="region" aria-label="Now playing: <title>, <show>"`; the progress line is
`aria-hidden`.

### 4.4 Discover

```
[safe-top + 8]
Title "Discover" --t-title.
[20]
Subjects, grouped under five heads (Science & nature, People & society, Business & work, Arts & culture, Making & tech) as SectionHeads; each a 2-up grid of SubjectTiles. The taxonomy is internal: group names are the only labels, no taxonomy ids in copy. (Round 1 opened with "Shows you follow"; it duplicated Library's grid and pushed the subjects below the fold, so it is gone from Discover.)
[chrome-bottom + dock rows]
SearchField as the Dock's top row (48), above the MiniPlayer row and the receded (36) tab row.
```

Results: a "Make a playlist from '<q>'" Primary button sits at the bottom of
the results list as well as under the no-result message (round 1 had it only
in `noresults`).

**Typing**: the list is replaced by results as it types (debounced 150ms).
Groups: Shows (ShowTile rows: art 56, name, "12 episodes"), Episodes
(EpisodeRow compact: art 56, no why-line), Playlists (PlaylistTile rows).
A "Make a playlist from 'semiconductor supply chain'" Primary button sits at
the bottom of results when the text is 3+ characters; it is the Create
function. **No result**: EmptyState with "Nothing named '<q>'." plus, when a
subject or group matches by substring, a second line "'<Subject>' is a subject,
<n> shows." with that SubjectTile under it, so the message never contradicts
visible content. **Keyboard open**: the field rides above the keyboard
(`interactive-widget=resizes-content` in the viewport meta; the harness stubs
this with `?kb=1` which pads the bottom by 300px); the TabBar and MiniPlayer
hide while the field has focus.

### 4.5 Library

```
[safe-top + 8]
Title "Library" --t-title.
[20]
Grid: ForayTiles and followed ShowTiles mixed, 3-up (art 104 at 393, 96 at 375), forays first, every cell the same height. Max 9 then "All" quiet button.
[32]
"Saved" (count): EpisodeRows, max 5 + "All saved".
"Playlists" (count): PlaylistTile rows.
"Up Next" (count): QueueRows; the current row first; each row's dots menu: Move up, Move down, Remove, Play next. Remove shows a Toast with Undo. Played rows jump to the top (founder ruling kept) with a 280ms translate of the neighbours (insert-with-gap).
"History": QueueRows without the menu, date caption.
```

Empty (first run): each section is a SectionHead + EmptyState with one line
and one button ("Find shows" opens Discover; "See today's picks" opens
Today); the grid's own line is "Nothing followed yet." A SectionHead shows
no trailing count when its section is empty (round 1 showed the seed counts
beside empty sections). No paragraphs, no quoted button labels.

### 4.6 Foray detail (`.room` from the first show's art)

```
[safe-top + 8]
chevron-left 44; dots 44 (share).
[8]
Collage 160 --r-lg centred (shows' arts).
[16]
Eyebrow "Foray · <subject>" --lamp, centred.
Title --t-title, 3-line clamp, centred.
Caption "4 shows · 42 min · narrated" (or "not narrated yet").
[16]
Strip 48 tall with thumbs; tapping a bar plays from there.
[16]
Primary button: "Play" / "Resume · 18 min left" / "Play again", 48, full width minus gutters (middle dot, not a comma). The resume state also shows the fill on the strip.
[24]
"Why 4a made this": --t-why, 3 lines max.
[24]
"Where this came from": ShowTiles 3-up with Follow badges, then the segment list (QueueRow anatomy, narration rows in --lamp).
```

**Unavailable**: collage at 50% with `i-wifi-slash` badge, strip still drawn,
Primary button replaced by "Find similar" (opens Discover with the subject),
one line: "This foray can't play right now. Its shows are below."
**Un-narrated**: no narration bars; caption says "not narrated yet"; nothing
else apologises.

### 4.7 Onboarding (first launch)

Full-screen `.room` whose `--room-art` cycles through four real show arts
from `discover.json` (6s each, Room crossfade; reduced motion: static first
art). Centre: a Strip at 48 tall drawing itself in over 1.2s, built from the
first foray's segments. Below: title `--t-display` "Hear things outside your
lane." and body `--t-body` `--text-2` "4a picks a few podcasts a day and says
why. No account." Buttons stacked at the bottom above safe-bottom + 24:
Primary "Show my picks", Secondary "Skip for now", both 48, gap 12. Tapping
"Show my picks" runs transition 2 into Today (the strip collapses into the hero
collage). Returning after skip: Today directly, no sheet; the intro is
reachable from Settings as "What 4a does".

## 5. Motion specs

| Transition | Mechanism | Timing | Reduced motion |
|---|---|---|---|
| Mini → Now Playing | `view-transition-name: np-art` on the 44 art and the 280 art; `document.startViewTransition` when available, else FLIP on the art (translate+scale) while the sheet translates from 100% to 0; Veil tint: `.room` starts clipped to the mini bar's rect (`clip-path: inset(...)` round 24px) and expands to the full screen | 420ms `--e-spring-soft`; art 420ms; TabBar sinks 24px + fades 280ms | 200ms crossfade of sheet and art |
| Now Playing → Mini | reverse, finger-tracked; release velocity > 0.5 px/ms closes | 420ms | crossfade |
| Pick → play | the row's art clones into a fixed element, FLIPs to the mini art slot; `--glow` on `<html>` transitions | 560ms `--e-spring`; glow 560ms ease-out | art fades in place; glow still changes (colour only) |
| Strip draw-in | each `.bar` `transform: scaleX(0)→1`, `transform-origin: left`, delay `index × 60ms` | 280ms each, `--e-spring` | all bars appear at once |
| Segment change (in play) | `.room --glow` and `--room-art` crossfade (two stacked `::before` layers, the new one fades in); show-name line crossfades; a `--lamp` caption "Now: <show>" fades in for 3s then out | 560ms; caption 280ms in/out | step change, caption still shown |
| Tab bar recede | `height 64→36`, label opacity 1→0, icon 28→24 on scroll down > 80px, any scroll up restores | 280ms `--e-out` | instant |
| Up Next add | the tapped row's art flies to the Library tab icon (FLIP), the tab's count badge scales 1→1.3→1 | 420ms `--e-spring` | badge count updates only |
| Queue reorder / remove | neighbours translateY by the row height with 8px gap | 280ms `--e-out` | instant |
| Toggle fills (save, follow, download) | icon Regular → Fill via opacity cross of two `<use>`; scale 1→1.15→1 | 160ms | opacity only |
| Sheet open/close | translateY, grabber drag, focus trap | 420ms `--e-spring-soft` | fade |
| Skeleton sweep | background-position loop | 1600ms linear | static |
| Buffering breathe | opacity 1→0.85→1 | 900ms, infinite | static at 0.9 |

View Transitions: wrap in `if (document.startViewTransition)`; the FLIP path
uses `element.animate()` with the same `linear()` easing string.

## 6. Haptics map (Web+, `@capacitor/haptics`; no-op on the web)

| Moment | Call |
|---|---|
| play / pause | `impact({ style: 'light' })` |
| add to Up Next, save, follow | `impact({ style: 'light' })` |
| scrubbing crosses a segment or chapter | `selectionChanged()` (throttled to once per boundary) |
| mini drag passes open threshold | `impact({ style: 'medium' })` once per gesture |
| bookmark set, download complete | `notification({ type: 'success' })` |
| end of item handoff | none |

## 7. Accessibility checklist (what the builder asserts)

- Every text pair in `contrast-check.mjs` ≥ 4.5; the script runs in the
  prototype's test.
- Every interactive element ≥ 44×44, including strip bars (44 tall hit area
  on 24px visuals) and the 16px scrubber thumb (44 hit area).
- State never by colour alone: playing = Fill glyph + "Playing"; played =
  check glyph; followed = check badge; stretch = pill with text; narration =
  thin bar **and** "Narration" in the segment list; offline = glyph + text.
- Mini player region label; Play/Pause `aria-pressed` with a live label;
  scrubber `role="slider"` with `aria-valuetext` "12 min 30 of 48 min",
  updated on change, not per second.
- Sheets trap focus and return it; Escape and the close button both work.
- Min text 13px; all sizes in rem; the 375×667 long-title layout keeps Play
  on screen (harness assertion).
- One `prefers-reduced-motion` block (section 1.6) covering every animation,
  including View Transitions.
- `prefers-contrast: more` and `prefers-reduced-transparency` handled in
  section 1.5.

## 8. Harness hooks (for `tools/ui-lab/`)

Query parameters the prototype honours: `?screen=today|np|discover|library|foray|onboarding`,
`?state=firstrun|returning|midlisten|stress|offline|loading|empty|typing|results|noresults|kb|paused|buffering|downloaded|ending|unavailable|unnarrated|finished`,
`?theme=dusk|dawn`, `?posture=car`, `?mini=1`, `?textscale=1.3`, and
`?scroll=<px>` (scrolls `.screen` after render, so the harness can shoot the
lower sections: Stretch card, Playlists rail, Off your path, the segment
list, the Now Playing detail posture). The seed clock is frozen by the
harness; the prototype reads `Date` only for the greeting.

`?state=ending` must render the handoff mid-flight: next artwork at 60% of
its travel from the right, the current one at -24% x and 40% opacity, the
Room half-crossfaded, the title already swapped, a `--lamp` caption "Up
next". Round 1 rendered the default frame.

Shooting the states: the harness takes a file path or an http URL and
refuses a query string on a file path, so serve `prototype/` over http
(any static server) and put the query on that URL. Under Git Bash, pass
`--routes '#/home'` with `MSYS_NO_PATHCONV=1` or the hash is rewritten into
a Windows path. The round-2 contact sheets must cover every state in
`critique-r1.md` "What round 2 must shoot".

## 9. Three risks and their mitigations, restated for the builder

1. **CORS-tainted canvas.** Do not rely on runtime extraction. Read
   `show.art.palette` first; the prototype ships a static `palettes.json`
   computed once by a Node script in `prototype/tools/` from the artwork URLs
   (that script is our code; the output is numbers, not images, so it can be
   committed).
2. **Blur cost on Android.** Only the three `.veil` surfaces blur; measure
   scroll FPS on the Android lab build with the Veil on and off, and keep the
   `@supports not` solid fallback one token away.
3. **Contrast on tinted surfaces.** Text never sits on raw Glow or on the top
   45% of the Room; the mix percentages and scrim stops in 1.1 and 1.5 are the
   guarantee, so change them only with the contrast script re-run.

## 10. Changed after round 2 (art director, 2026-10-05, see `critique-r2.md`)

Values the round-3 builder implements. Each is also folded into the sections
above where it contradicts them; where this section and an older line
disagree, this section wins.

### 10.1 Room scrim in pixels from the top (critique items 1, 3)

`.room-bg::after` stops are pixel offsets, never percentages, so the eyebrow,
title and caption always begin in the mid zone on every viewport height:

```
background: linear-gradient(180deg,
  rgb(20 17 15 / 0.42) 0,                           /* head icons >= 3:1 on any art */
  var(--scrim-top)  calc(var(--safe-top) + 56px),
  var(--scrim-top)  calc(var(--safe-top) + 196px),  /* Foray: the collage's lower edge */
  var(--scrim-mid)  calc(var(--safe-top) + 276px),  /* Foray: the eyebrow's y */
  var(--scrim-low)  100%);
```

Now Playing has taller art, so its two middle stops are
`calc(var(--safe-top) + 72px + var(--np-art))` and that plus 20px.
`--scrim-mid` alpha rises from 0.82 to 0.86 inside its mix.

**Dawn Room** (`[data-theme="dawn"] .foray-room, [data-theme="dawn"] .onb`
and the `prefers-color-scheme: light` twins; **never `.np`**, which always
uses the Dusk scrim):

```
--glow-room: color-mix(in oklab, var(--paper0) 80%, var(--glow) 20%);
.layer.on { opacity: 0.55; }
--scrim-top: rgb(247 242 235 / 0.10);
--scrim-mid: color-mix(in oklab, rgb(247 242 235 / 0.86) 80%, var(--glow) 20%);
--scrim-low: color-mix(in oklab, rgb(247 242 235 / 0.96) 80%, var(--glow) 20%);
```

Text on it: `--ink` / `--ink-2`; eyebrow and why-line `--lamp-text`
(`#55391A`); raised rows are the Dawn raised material.

`contrast-glow.mjs` gains four rows, printed with the rest: `Dusk Room at
the eyebrow's y` (Lamp, `--text-2` over scrim-mid over Glow L 0.66 C 0.14,
all hues), `Dusk Room head` (`--text` over 0.42 black over Glow), `Dawn Room
at the eyebrow's y` (ink, ink-2 over the Dawn scrim-mid over Glow L 0.56),
`Dusk Today hot spot 48/52` (`--text-2`, Lamp). Floors: 4.5:1 for text,
3:1 for the head icons. If a sweep fails at any hue, raise that alpha until
it passes and record the number here.

### 10.2 Lit art, the fifth material (item 5)

Every artwork 104px or larger: `box-shadow: var(--shadow-1), 0 0 var(--lit-r)
calc(var(--lit-r) / -4) color-mix(in oklab, var(--art-glow) 55%,
transparent)`. `--art-glow` is **that artwork's** palette colour (from
`palettes.json`, clamped like Glow), set per element by script, not the
screen's `--glow`. `--lit-r`: 40px at 104, 64px at 160, 96px at 280 and
above. Dawn: 40% instead of 55%. The black shadows on `.np-art .swap > *`,
`.hero-art`, `.foray-collage`, `.onb-arts .art` and `.ptile` are removed, not
stacked. Dropped (not replaced) under `prefers-reduced-transparency` and
`forced-colors: active`.

### 10.3 Today hot spot (item 6)

`.wash` gets a third layer on top: `radial-gradient(60% 34% at 22% 16%,
color-mix(in oklab, var(--glow) 52%, transparent) 0%, transparent 100%)`;
`24% 17%` at 375. If `--text-2` fails 4.5:1 on the hot-spot row of
`contrast-glow.mjs`, cap the mix at 46%.

### 10.4 Max text size in the glance posture (item 2)

`html.big` (textscale >= 1.2): `--np-art: 160px` (as built); `.np-titles
.why { display: none }`; `.np-eyebrow { height: 0 }`; the detail handle is
the 24px chevron with no caption; transport row `margin-top: 12px`. Harness:
`textscale=1.3` at 375x667 asserts the Play button's bottom edge >= 24px
above the viewport bottom and the handle fully inside it. Hero title at
`html.big`: `--t-headline` 20/24, 4 lines.

### 10.5 Collages never crop a square (item 4)

`.collage.c1`: the art. `.c2`: two full squares at 68% of the cell, first at
top-left, second at bottom-right on top with `--shadow-1`. `.c3`: three
squares at 58%, top-left, top-right, bottom-centre, the last on top. `.c4`:
the 2x2 as built. Each square `--r-sm`; cell background `--bg1` (Dawn
`--paper2`). Applies to ForayTile, ForayCard, HeroPick, PlaylistTile and
SubjectTile alike.

### 10.6 HeroPick title (item 12)

`--t-title` 26/30, `clamp 4`, never an ellipsis. Four lines (120px) plus the
18px eyebrow still fit beside the 160 collage; the Play row lands under the
collage's bottom edge.

### 10.7 Library followed badge (item 10)

ShowTile shows the `i-check-circle-fill` badge only in Discover results and
"Where this came from". In the Library grid it is not rendered.

### 10.8 Foray detail strip sill; unavailable dims the Room (items 7, 9)

Foray detail's 48px strip sits in a sill: `background: rgb(20 17 15 /
0.22); padding: 10px 12px; border-radius: var(--r-lg)` (Dawn Room: `rgb(255
255 255 / 0.35)`). Now Playing's strip has no sill. Current-bar fill is
`color-mix(in oklab, var(--c) 78%, var(--lamp))` everywhere (was 85%).

Unavailable foray: `.layer.on { opacity: 0.35 }`, `--glow-room` mixed at 8%
(not 15%), the strip at 60% opacity, the collage at 50% as built.

### 10.9 Dock bottom fade (item 19)

A non-interactive element behind the Dock: `position: absolute; left: 0;
right: 0; bottom: 0; height: calc(var(--safe-bottom) + 28px); background:
linear-gradient(transparent, var(--bg0) 70%); pointer-events: none` (Dawn:
`--paper0`). Hidden with the Dock in car posture.

### 10.10 Now Playing surplus split (item 8)

Art + eyebrow + titles + why-line live in `.np-mid { flex: 1 1 auto;
min-height: 0; display: flex; flex-direction: column; justify-content:
center }`; strip, transport and handle keep their fixed spacing below. At
375x667 nothing changes.

### 10.11 Library "Foray" pill (item 14)

20 tall, `600 0.8125rem/20px`, uppercase, `letter-spacing: 0.06em`, padding
0 8px, Lamp on `rgb(20 17 15 / 0.55)`.

### 10.12 States round 3 must add (items 11, 16, 18)

- `?state=np-segchange`: frozen at t+280ms after a segment boundary; the two
  Room layers at 50/50; eyebrow caption "Now: The Bootstrapped Founder" lit;
  outgoing bar full, incoming bar fill at 4%; show line under the title
  mid-crossfade.
- `?state=np-detail3`: the detail posture scrolled to its end, showing show
  notes (4-line clamp + "More") and the Up Next peek; build them if missing.
- Now Playing default shots are taken at open + 4s (or with `?eyebrow=off`)
  so the transient caption is not scored as a permanent line.
- Everything in `critique-r2.md` "What round 3 must shoot".

## 11. Changed after round 3 (art director, 2026-10-05, see `critique-r3.md`)

### 11.1 The Dock casts upward (item 2)

`.page-glow`: absolute, full width, bottom 0, height 260px, z-index 0 (over
`bg0`, under content and the Dock fade), `pointer-events: none`;
`radial-gradient(90% 100% at 50% 100%, color-mix(in oklab, var(--glow) 14%,
transparent) 0%, transparent 100%)`, Dawn 9%. Hidden under `np-open`,
`no-chrome` and car posture. Present on every tab page; on Today it stacks
under the hero wash. With the neutral `--glow` fallback (nothing playing) it is
invisible by construction. New `contrast-glow.mjs` row: `--text-2` over 14%
Glow over `bg0`, every hue.

### 11.2 Onboarding composition (item 1)

`.onb-mid` is `justify-content: flex-start; padding-top: 40px`; `.onb-arts`
176px at every height (1.15 scale still at >= 800 tall); strip 24 under the
sleeves, display title 28 under the strip; `.actions` stay bottom-anchored.
The onboarding Room scrim uses its own pixel stops: head 0.52 to
`safe-top + 72`, bright zone to `safe-top + 248`, mid at `safe-top + 272`,
low at 100%. Same stops in Dawn with the Dawn scrim colours.

### 11.3 Collage z-order (item 3)

§10.5 positions stand; the first child is the complete square on top:
`.c2` first at bottom-right, second at top-left; `.c3` first at bottom-centre,
second top-left, third top-right (third above second). `.c4` unchanged.

### 11.4 Small corrections (items 4 to 7)

- Foray detail strip: the current bar grows upward only; thumbs row at
  `--bt + --bh + 6px`.
- Up Next peek: eyebrow "4a added" (Lamp), title, one meta line with the
  duration once, then the item's why-line in `--t-why` clamped to two lines.
- Car posture: title clamp 3 at >= 800px tall, 2 below.
- `np-ending` state freezes at 85% travel.

## 12. After round 4 (art director, 2026-10-06, see `critique-r4.md`)

No direction change. The round is ready; two builder corrections land in the
polish pass before the checkpoint package, each pinned by `tools/qa.mjs`, no
art-director reshoot review.

### 12.1 Dock fade reaches bg before the Dock's bottom edge (item 1)

`.dock-fade { height: calc(var(--safe-bottom) + 12px + 44px); background:
linear-gradient(transparent 0, var(--bg0) 32px); }` (Dawn `--paper0`),
still z-index 19 under the Dock. Solid bg from 12px above the Dock's bottom
edge to the screen bottom; the gutters beside the Dock's corner radius fade.
Assert: no text node intersects the band below the Dock's bottom edge at
rendered opacity above 0.02, every tab page, both schemes, 375x667 and 393x852.

### 12.2 Grid captions clamp to three lines (item 2)

`.stile .name, .ftile .name` clamp 3; `.grid-3 { align-items: start }`; the
three `t-caption name clamp2` spans in `afterglow.js` become `clamp3`. Assert:
no `.name` on Library or "Where this came from" has `scrollHeight >
clientHeight` at 375 or 393; tile row gap never under 16px.

## 13. As built: phase 3, tokens (`redesign/ambient-p3-tokens`, `ui/tokens.css`)

Where the build departs from the lines above, or fills a gap in them. The file's
own header is the long form; `test/afterglow-tokens.test.js` pins every number here.

1. **Location and scope.** One new stylesheet, `ui/tokens.css`, linked after
   `styles.css` and listed in the three shell lists (`generate-manifest`,
   `prepare-dist`, `prepare-webdir`). It changes no screen: the trunk-app
   baseline compares 138 of 138 shots identical. Screens adopt the system by
   wearing **`.ag`** (any scope root, including a gallery panel); a Room wears
   **`.room`**. Names `styles.css` already declares (`--text`, `--gutter`,
   `--seg-c0..7`, `--seg-narration`) are declared only on `.ag, .room`; the
   scheme blocks carry the ink as `--ag-text` and the gutter as `--ag-gutter`.
   When the last legacy screen is gone, `.ag` is hoisted to `:root` and the
   mirrors go.
2. **Themes.** `data-theme` is read on `<html>` or on any scope root; Now
   Playing's Room is `data-theme="dusk"`, so it reads Dusk in both passes.
   `.room[data-theme="dusk"]` reads `--text-2: #C9BFB3` and `--text-3: #B0A79D`
   (the prototype's Room neutrals, one step brighter than the page's).
3. **Derived Glow tokens are formulas over tokens**: `--mix-veil` 28% (Dawn 24%),
   `--mix-row` 18%, `--mix-wash` 40%, `--mix-room` 15% (Dawn 20%), `--mix-scrim`
   24% (Dawn 20%), `--cast-mix` 14% (Dawn 9%), `--lit-mix` 55% (Dawn 40%). Dawn's
   Veil is 76/24, not the plan table's 72/28: ink-2 measured 4.48:1 at 72/28.
   The formulas sit inside `@supports (color: color-mix(...))` and the static
   values for older engines inside `@supports not`, because a custom property
   never falls back on a value it cannot parse.
4. **Dawn `--ok` / `--warn`** are `#2A7541` / `#8A5A12`, not "same as Dusk" (the
   plan table): `#7FCB8E` is 1.9:1 on paper. `#2A7541` rather than the
   prototype's `#2E7D45`, which is 4.18:1 on `--bg2`.
5. **Reduced motion.** One block, scoped to `:root`, `.ag` and `.room` subtrees
   (not `*`), so it cannot re-time or re-enable a legacy transition;
   `styles.css` keeps its own block until the last screen adopts. **Open for
   the first screen that animates under `.ag`:** `gates.mjs`'s reduced-motion
   gate counts any transition over 1ms as motion, and this block's 200ms
   crossfade is over 1ms. It records nothing today (no `.ag` element
   transitions in a baseline state); the first screen whose reduced-motion
   state changes opacity will need either the gate's `MIN_MOTION_MS` ruling or a
   state that does not trigger it. That is an orchestrator decision.
6. **Not in this PR, by the build plan's order:** the icon sprite, primitives
   and gallery (the next three tasks), `data/palettes.json` and its loader (the
   palette script lands with Now Playing, which is its first reader).

## 14. As built: phase 3, icons (`redesign/ambient-p3-icons`, `ui/icons.svg`, `ui/icons.js`)

The sprite, its helper and the `.icon` rules. No screen changed: the trunk-app
baseline compares 138 of 138 shots identical, gates exit 0 with 0 new.
`test/afterglow-icons.test.js` pins every number here.

1. **Location.** `ui/icons.svg` (not the repo root: `vercel.json` already revalidates
   `/ui/(.*)`, so the sprite never goes stale behind a cached shell), listed in the
   three shell lists beside `ui/tokens.css`. Referenced as `href="ui/icons.svg#i-house"`;
   routes are hash-based so the document base never moves. `ui/icons.js` is a new
   classic script loaded after `ui/home.js`; it runs nothing at the top level.
2. **Generated, not hand-edited.** `node tools/icons/build-sprite.mjs` writes it
   (`--check` verifies); a test fails if the file is not what the script writes. The 33
   Phosphor (MIT) paths are taken as they stand from the prototype's sprite; the four
   transport glyphs are drawn by the script. Complete Phosphor MIT and DM Sans OFL 1.1
   notices live in `ui/icons-LICENSES.txt`; the web dist, service-worker generation and
   native webDir all ship that human-readable surface beside the sprite, and
   `docs/legal/third-party-notices.md` records both dependencies.
3. **The prototype's four custom glyphs were not copied.** They used strokes and a
   `<text>` numeral. `<text>` in an externally referenced sprite does not see the page's
   `@font-face`, so it would draw in a fallback face, and the notes above ask for filled
   paths. Rebuilt as fills: play is an equilateral triangle (circumradius 104, corners
   rounded 12, centroid at x=136 = the +8 optical shift; it is larger than the prototype's
   26-wide stroked triangle because that stroke added 13 on every side); pause is two 40
   bars 32 apart; back-15 and forward-30 are a 270 degree ring (radius 84, stroke 22
   expanded, round caps), a rounded arrowhead (the prototype's, offset by its 4 stroke
   and rounded to 4), and the numerals as **DM Sans outlines at wght 600, opsz 14** (the
   text optical size: the glyphs are drawn at 36px or less), font-size 84, figure 59 high,
   centred on the ring. Forward is the exact mirror of back. The outlines come from
   `tools/icons/extract-numerals.py` (fontTools, one-off) into the committed
   `tools/icons/dm-sans-600-numerals.json`; CI needs neither.
4. **Helper.** `agIcon(name, size)` returns `<svg class="icon icon-28" aria-hidden="true"
   focusable="false"><use href="ui/icons.svg#i-house"></use></svg>`; sizes 20/24/28/32/36
   are classes (strict CSP), a name or size outside the lists returns `""` rather than
   markup. `safeUrl()` accepts this one anchored relative-asset form
   (`ui/icons.svg#i-...`) and rejects other relative URLs; the helper writes
   `esc(safeUrl(...))` so the same invariant as every other href/src holds.
   `agIconGallery()` renders every symbol with its name and the Sizes row; the gallery
   task mounts it under `#/gallery`.
5. **CSS** (`ui/tokens.css` section 6b): five size tokens (`--icon-sm 20`, `--icon 24`,
   `--icon-tab 28`, `--icon-lg 32`, `--icon-play 36`), `.ag .icon, .room .icon` with
   `fill: currentColor`, `stroke: none`, `flex: none`, `pointer-events: none` (the
   control owns the tap). Scoped like every other rule in the file, so no legacy screen
   changes. `test/afterglow-tokens.test.js`'s "nothing today's markup emits" scan now
   skips `ui/icons.js` only, since the helper emits the classes the file styles.
6. **Not in this PR:** replacing any Unicode glyph in a screen (Phase 4, screen by screen),
   the gallery route itself, the 3:1 non-text contrast check of a glyph on its control
   (each screen's own pass).

## 15. As built: phase 3, primitives and gallery (`redesign/ambient-p3-primitives`)

The component system now exists without a Phase 4 screen adopting it. `ui/primitives.js`
returns inert, escaped markup; `ui/primitives.css` is wholly scoped below `.ag`; and the
lab-only `#/gallery` route displays Dusk and Dawn plus a separately captured live-sheet
state for each scheme. The 138 pre-existing `trunk-app` shots compare at zero changed
pixels; 41 stable capture plates at three viewports make the 123-shot gallery baseline.

1. **Inventory.** The gallery covers Primary, Secondary, Quiet, Icon, Play (44/48/56/88)
   and Skip controls; chips, pills, SectionHead, search, scrubber and the three Strip
   scales; every artwork size and Collage c1-c4; EpisodeRow and QueueRow states;
   StretchCard, ForayCard/Tile, HeroPick, ShowTile, SubjectTile and PlaylistTile; Dock,
   TabBar and MiniPlayer; Sheet, Toast, Skeleton and EmptyState. Card strips are static;
   player/detail strips use real 44px seek buttons.
2. **States and semantics.** Default, pressed, focus, disabled and loading treatments are
   visible in both schemes; scrubber, MiniPlayer and Sheet also show drag. Pressed controls
   use an inset treatment instead of shrinking their hit rectangle. Disabled cards keep
   full text contrast. Artwork and Glow swatches are named images. The scrubber is a native
   range slider with a 44px input target; its value, clocks and `aria-valuetext` move
   together. Duplicate gallery landmarks are disambiguated, and Skeleton announces Loading
   without putting ARIA on a generic span.
3. **Sheet behavior.** The decorative preview is not a dialog. Each scheme's live sheet is
   a direct child of its panel, has a stable dialog/opener id for the gate, moves focus to
   its close button, makes siblings inert, traps Tab with `a[href]` (not SVG `<use href>`),
   closes on Escape or the visible control, and restores the opener. The gates trace both
   live dialogs rather than accepting static source.
4. **Shipping and isolation.** `ui/primitives.css` is explicit in the service-worker, web
   and native shell lists; the two JS files follow `ui/icons.js` and precede `ui/boot.js`.
   `galleryAllowed()` requires `window.__FORAY_LAB__` or `?gallery=1`. The token isolation
   census excludes only `icons.js`, `primitives.js` and `gallery.js`; screen-bearing files
   still fail if they emit a new-system class before Phase 4.
5. **Verification.** Gallery gates: 41 screens, zero new violations in all eight gates, two
   live sheets traced. Axe is clean for the gallery except the existing owner decision that
   disables viewport zoom. Dusk and Dawn were shot explicitly. Visual review against the
   final Ambient r4 prototype kept its warm room, Fraunces hierarchy, Ember controls, Lit
   art and compact density. Baselines: `ambient-gallery` 123 shots, fresh compare 123/123
   identical; rolling `ambient-app` 261 shots. The primary background remains token
   `--bg0` (`#14110F`), with the Dawn panel sampled at `#F7F2EB`.
   The one full Windows runner reached the runbook's known CRLF-only root red and
   exposed a real mobile asset-budget red from the first slider implementation.
   The compact native-range implementation plus the documented 16 KB ceiling fixed
   that: targeted mobile bundle verification passes 87/87. Corpus passed 285/285,
   foraycorpus-export 69/69, shows 117/117 (+6 skipped), and UI lab 55/55. All
   change-targeted root suites pass.
6. **Executed mutations.** The suite now has sixteen tests. The review follow-up was run red
   by literally replacing `safeUrl(artUrl(src, px * 3))` with `safeUrl(src)`, omitting
   `pressed: playing`, restoring the broad `.p0 { width: 0 }` rule, changing the native
   scrubber input from `range` to `text`, deleting the gallery's scrubber-drag entry, and
   deleting the `cards-tiles` capture plate from the gallery harness.
   The existing disabled semantics, 44px target, single reduced-motion owner, route guard,
   sheet focus and shipping-list mutations remain pinned. Every mutation was restored.
7. **Phase 4 boundary.** No existing screen calls a primitive. Screens adopt this system
   one at a time, with the gallery baseline guarding unintended foundation changes.
8. **Native bundle alarm.** The complete minified bundle is 2.88 MB and remains below
   the independent 3 MB hard cap. The legacy-growth alarm stays unchanged at 2.85 MB;
   `prepare-webdir.test.mjs` subtracts only the measured foundation files from that
   quantity and gives `primitives.css`, `primitives.js` and `gallery.js` tight 20/16/9 KB
   per-file ceilings. The JavaScript ceiling rose by 1 KB for the accessible slider binder;
   after the blocking-review corrections its measured minified size is 16,375 bytes, still
   within the 16 KB ceiling. Removing the CSS carve-out was run as the named mutation and
   restored the red 2.85 MB alarm. Artwork primitives also reserve their intrinsic
   square and request a 3x CDN rendition before the final `safeUrl()` gate; the root
   boot-path image census pins that no small tile fetches the 600px original.
9. **Blocking-review corrections.** The detail Strip now carries its separate 20px
   thumbnail row, and its current 24px show bar is exactly `--s-1` taller, bottom-anchored
   so it grows upward. Row Play at 44px is the outlined, unfilled treatment; larger Play
   controls remain Ember-filled. A current QueueRow exposes the visible "Playing" caption
   beside its filled glyph. SubjectTile accepts `default` / `pressed`, and the gallery
   records both in Dusk and Dawn. Four focused tests name mutations that ran red against
   removal of each correction.
10. **Second blocking review, closed (2026-10-07).** (a) *Loading never dims text.* The
   `opacity: .55` on a loading EpisodeRow's copy and `.7` on a loading StretchCard
   composited `text-2` to 3.15:1 (Dusk) / 2.51:1 (Dawn) and Dawn card metadata to 3.49:1.
   Both rules are gone: a loading row or card keeps its copy at full contrast and its own
   Play control takes the `loading` state (spinner + `aria-busy`). A test scans every
   `opacity` below 1 in `primitives.css` and allows it only on disabled controls (WCAG
   1.4.3 exempts them) and non-text parts (dim artwork, strip bars, the invisible range
   input). (b) *Spinner replaces the glyph.* A loading control used to render glyph and
   spinner side by side, which pushed the spinner out of a 44px circle; the spinner now
   takes the glyph's 24px slot, so a control keeps its width when it starts loading.
   (c) *Buffering breathes, as §3 says.* The MiniPlayer's buffering state keeps its Play
   glyph (the `ag-breathe` rule now has something to animate), shows no spinner, and marks
   the group `aria-busy`. (d) *Disabled chip* renders at 40% (it was identical to default).
   (e) HeroPick's caption read "4 shows Â· 42 min" (double-encoded middle dot); fixed, and
   a test rejects mojibake in the primitive sources. (f) The drag MiniPlayer plate no longer
   lifts over the buffering plate above it. The review's other two items were already closed
   by the gallery unit: every section of both schemes is a capture plate (pinned by "the
   gallery baseline visits every visual plate"), and `compare --name ambient-gallery` ran
   123/123 identical before this change. On the final code a fresh gallery recorded into a
   private root compared 123/123 identical twice in a row, so the capture is deterministic.
   Seven tests were added (suite floor 12 -> 23), each mutation run red and restored; the
   round-4 review added an eighth (the state line's class modifier and caption go through
   `esc()`), floor 24.
   Intended gallery diffs against the shared `ambient-gallery`: the loading button/row/card
   plates, the disabled chip, the hero caption and the Dock plates, plus plates whose
   viewport shows them; at 412 wide the narrower loading Primary reflows the button grid,
   and the drag plate's 24px spacing moves every plate below it in each scheme (including
   sub-pixel antialiasing on the live sheet behind `sheet-open`). Re-record it on merge. The `trunk-app` screens are
   unchanged (138/138 identical). Minified `primitives.js` is 16,355 bytes after the
   round-4 `esc()` calls (the row state lines became a table to stay inside the 16 KB
   ceiling; 29 bytes of headroom, so Phase 4 additions to this file need room made first).
11. **Round-5 review (Codex, 2026-10-07): merge, zero blocking.** Its nits were taken:
   under Reduce Motion the buffering glyph now holds at 0.9 (§5's motion table) through a
   `.ag`-scoped rule inside the one reduce block in `ui/tokens.css`, where it used to end
   its 1ms animation back at 1 and show no cue; a test pins it (mutation run red, floor
   24 -> 25). The spinner-width test now says it covers glyph-bearing controls only (a
   text button gains the spinner and may widen). Add the buffering MiniPlayer plates to the
   intended `ambient-gallery` diffs above if the baseline renders under reduced motion.


## 13. Foray detail, as built (2026-10-07, branch `redesign/ambient-foray-detail`)

Decisions the builder made while no one could be asked; each is also in the code or a test.

1. **The mid scrim stop is 236, not 276 (and the ramp starts at 120, iteration 2).** §10.1's stops assume an eyebrow at `safe-top + 276`. The prototype's own stack puts the
   eyebrow at `safe-top + 236` (8, the 44px head, 8, the 160 collage, 16), and the token suite pins text contrast at the mid stop, so
   the stop must not sit below the first line of text. `.fd-room` sets `--rs2: calc(var(--safe-top) + 236px)`; `--rs1` stays 196 and
   every other number (the 56 head stop, Dawn's paper mix and 0.55 layer, the 8% / 0.35 unavailable Room) is the tokens'.
   **Iteration 2:** `--rs1` is now 120 too (the prototype's own `.room-bg` value), not the token's 196: at 196 the scrim climbed from
   0.20 to 0.89 in 40px right under the 220px collage and drew a hard horizontal seam, the round-1 flat band. The climb is 116px now.
   `test/ambient-foray-detail.test.js` computes the eyebrow's top from the page's own spacing and fails if the stop is lower.
2. **Share is the `i-share` glyph**, not `i-dots`: §4.6's "dots 44 (share)" and the prototype's own button disagree, and the
   prototype's glyph says what the button does. The target is 44 either way. Share opens the native sheet where there is one and
   otherwise copies `https://jw-incorporated.github.io/foray/#/foray/<id>` and says so; it writes nothing anywhere.
3. **The runtime says "about" when part of it is an estimate** ("5 shows · about 43 min · narrated"), as the page always has
   (audit 2026-09-22): a narrated Foray's bridges are timed from their script until real audio exists.
4. **Thumbs: a bar of 12px or more, 4px clear of the last thumb, inside the strip (iteration 2; was "28px or more").** The first build
   hid the row when no bar was 28px wide, which on the only narrated Foray in the data (50 clips, 39 of them narration, one show,
   bars of 8 to 16px) left the sill without its thumbnail row, the sill's signature. The rule is now greedy from the left, so the
   widest-first bars win by coming first, thumbs never overlap, and none hangs off the right edge (`forayThumbCells`, `stripWidth`).
   A strip with no tape bar of 12px still has no row (`:empty`). The strip's region delta is the row in the 1-show case.
5. **"Unavailable" is the resolver's answer** (`r.playable` is empty: no clip has audio), not a guess about the network. A narrated
   Foray whose tape cannot play still plays its narrator's bridges (they need no source), so it is not unavailable; its rows say
   "This clip isn't available right now." as they always did. The harness opens the not-narrated Foray with every audio URL removed.
6. **"Start over" is gone (iteration 2; the first build kept it as a Quiet button).** The direction defines one button (Play / Resume /
   Play again); the extra link under it cost 44px of action and stretched button to "Why 4a made this" from the prototype's 24px
   to about 100. The way back to the top is the first clip's row or the strip's first bar (a named index beats the stored
   point, `player/foray-playback.test.js`). `#fy-restart`, `#fy-resume` and their bindings are deleted; `clearForayResume` stays
   in the player API. The `foray_restart` event is no longer emitted from this page.
7. **"Where this came from" keeps what the credit block carried**: a show with a page of its own links in-app, one without opens its
   Apple Podcasts page (or a search, and says which in its accessible name), "Every clip plays from the show's own feed." stays, and
   FOLLOW_NOTE sits where Follow is tapped (review 2026-09-23). Follow needs a catalogue record; a show known only to the show index
   links but has no Follow.
8. **First paint is not animated**: `.is-fresh` (transitions off, the one `!important` in the sheet, because tokens.css's
   reduced-motion block uses one) comes off two frames after render. The Glow and the artwork URL are worked out before the markup is
   inserted so the Room opens already lit; the reduced-motion gate reads 0.
9. **Iteration 2, narration lights.** A narration bar is a 6px Lamp pill (`--r-pill`), centred on the 24px bars (9 under, 9 over),
   and is never dimmed: `.has-position` dims the coloured show bars to `--seg-dim`, which turned the ivory lights tan beside a
   resume point. The strip reads as coloured shows joined by ivory lights, in greyscale too.
10. **Iteration 2, the Dock findings are not this screen's.** The four-tab bar, the violet mini-player play button, the flat orange
    progress line, the Fraunces mini title, the missing rim and cast, and the Dock slicing the last tile all belong to
    `redesign/ambient-dock` (`ui/dock.css`, `ui/tabbar.js`), which is not on the direction branch yet; this page changes none of
    the shared chrome. Once the Dock merges, the page's own bottom padding (`--chrome-bottom`) is what lets content run under
    its fade.
11. **Not built here**: the "lamps light in sequence" strip draw-in (§5, motion 3), the Room shifting colour as playback crosses a
   segment (a Now Playing behaviour), per-show palette from the nightly refresh (the committed table in `ui/palette.js` and the hash
   hue are the sources), and the legacy tab bar and mini player the Dock unit replaces.
