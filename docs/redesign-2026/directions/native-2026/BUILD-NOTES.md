# Native 2026: build notes

Everything a front-end builder needs to reproduce the direction without the
art director. Read `DIRECTION.md` first for the argument; this file has the
numbers. Hard limits from `../../PLAN.md` apply throughout: `esc()` /
`safeUrl()`, strict CSP (no inline `style=` or `<script>`, fonts from `'self'`),
`cp_` storage keys, 44px targets, one `prefers-reduced-motion` block, AA
contrast, copy rules, no third-party imagery committed.

## 0. Platform switch and scheme switch

- `html[data-os="ios"]` or `html[data-os="android"]`, set once at boot from
  `Capacitor.getPlatform()` (web falls back to `ios` when the UA is Apple, else
  `android`). The prototype accepts `os=ios|android` in `location.search`
  **and in the hash query** (`#/home?os=android&scheme=light`), because
  `tools/ui-lab/shoot.mjs` drives hash routes and refuses a file path with a
  search string (critique r2). Every platform-specific rule below is scoped by
  that attribute; the content components never are. The prototype's drawn
  status bar is part of the shell: Android draws time left 14/500 and three
  plain glyphs right in a 24px bar, no iOS battery shape, gesture handle
  108x4; iOS draws the notch-era bar it has now.
- Colour scheme: `prefers-color-scheme` via a `@media` block that re-assigns the
  same token names. The prototype accepts `?scheme=light|dark`. Declare
  `color-scheme: light dark` on `:root` so form controls and scrollbars follow.
- `prefers-reduced-transparency` and `prefers-contrast: more` both switch
  `--glass-*` to the solid values (section 3). The prototype accepts
  `?transparency=reduced`.
- Viewport: `viewport-fit=cover`; every bar uses `env(safe-area-inset-*)`.

## 1. CSS tokens

All tokens live on `:root`; the scheme and OS blocks only re-assign.

### 1.1 Colour, iOS (`data-os="ios"`)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #F2F2F7 | #000000 | page base (grouped) |
| `--surface` | #FFFFFF | #1C1C1E | cards, rows, sheets |
| `--surface-2` | #FFFFFF | #2C2C2E | elevated card, chip, popover |
| `--fill` | rgba(120,120,128,.12) | rgba(120,120,128,.24) | pressed row, segmented track, skeleton |
| `--separator` | rgba(60,60,67,.18) | rgba(84,84,88,.45) | hairlines inside grouped lists only |
| `--label` | #1C1C1E | #FFFFFF | primary text |
| `--label-2` | #6E6E73 | #A9A9AE | secondary text |
| `--label-3` | #8E8E93 | #8E8E93 | decorative only (never body text; 3.0:1) |
| `--accent` | #A85A00 | #FFB24D | 4a amber: interactive + current |
| `--on-accent` | #FFFFFF | #1C1C1E | text/icon on an amber fill |
| `--accent-soft` | rgba(168,90,0,.12) | rgba(255,178,77,.16) | selected row tint, badge background |
| `--danger` | #C62828 | #FF6B6B | remove, errors |
| `--good` | #2E7D32 | #4ADE80 | downloaded tick, played tick |

### 1.2 Colour, Android (`data-os="android"`), M3 tonal roles

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` (surface) | #FDF8F3 | #15130F | page base |
| `--surface` (container) | #F3EEE9 | #211F1B | cards, rows |
| `--surface-2` (container-high) | #ECE6E0 | #2B2925 | nav bar, mini player, chips |
| `--fill` (container-highest) | #E6E0DA | #363330 | pressed state, skeleton, track |
| `--separator` (outline-variant) | #D8CFC4 | #4F463C | hairlines, rarely |
| `--label` (on-surface) | #1D1B18 | #ECE5DF | primary text |
| `--label-2` (on-surface-variant) | #5B5247 | #B9ADA0 | secondary text |
| `--label-3` | #8A8178 | #8A8178 | decorative only |
| `--accent` (primary) | #8A4A00 | #FFB868 | amber |
| `--on-accent` (on-primary) | #FFFFFF | #4A2600 | text on amber fill |
| `--accent-container` | #FFDCBE | #6B3800 | tonal button, selected chip, nav pill |
| `--on-accent-container` | #2E1500 | #FFDCBE | text on the container |
| `--danger` | #B3261E | #F2B8B5 | |
| `--good` | #2E7D32 | #4ADE80 | |

### 1.3 Contrast table (WCAG, computed)

| Pair | Ratio |
|---|---|
| iOS light label on surface / on bg | 17.01 / 15.25 |
| iOS light label-2 on surface / on bg | 5.07 / 4.54 |
| iOS light accent on surface / on bg; white on accent | 5.09 / 4.56; 5.09 |
| iOS dark label on bg / on surface | 21.00 / 17.01 |
| iOS dark label-2 on surface / on surface-2 | 7.27 / 5.96 |
| iOS dark accent on bg / surface / surface-2; #1C1C1E on accent | 11.73 / 9.50 / 7.78; 9.50 |
| Android light on-surface on bg / on container | 16.28 / 14.91 |
| Android light on-surface-variant on bg | 7.25 |
| Android light primary on bg; on-primary-container on container | 6.50; 13.27 |
| Android dark on-surface on bg / on container | 14.88 / 13.19 |
| Android dark on-surface-variant on container | 7.48 |
| Android dark primary on bg / on container-high; on-primary-container on container | 10.87 / 8.51; 7.41 |
| Text on glass fallback (dark #2A2A2D, light #E9E9EE) | 14.31 / 14.06 |

Rule: `--label-3` is never used for text that carries meaning. Any new pair
goes through `test/ui-tokens.test.js`'s contrast check before it ships.

### 1.4 Segment (show) palette, data colour

Keep today's `--seg-c0..7` for dark; the light-scheme values in `styles.css`
(the darker set) for light. Narration no longer has a colour token: it is the
thread, a dashed hairline in `--label` at 45% opacity under the whole strip
(`SeamStrip`, section 3). Keep `--seg-hatch` for the "unavailable clip"
pattern. Amber never appears on a strip.

### 1.5 Artwork-derived colour (Now Playing)

Extract once per artwork URL on a 24x24 canvas (`Web`, cached in memory by URL;
never persisted, never written into `cp_` keys): **vivid-first hue** (the
dominant hue among pixels with oklch chroma >= 0.10, weighted by chroma;
fall back to the plain dominant hue when fewer than 5% of pixels qualify) and
mean chroma. Set `--art-h`, `--art-c` on the player root. **Source for a
foray: the current clip's show artwork, never the composite** (a collage
averages to khaki; critique r1). Chroma floor 0.04 so grey art does not go
brown. One derivation on both platforms (critique r2: iOS blurred a pale
yellow cover under a black scrim into olive while Android derived maroon from
the same cover).
- iOS: the room is `linear-gradient(180deg, oklch(0.30 0.07 var(--art-h)) 0,
  oklch(0.16 0.04 var(--art-h)) 100%)` (dark) or `oklch(0.96 0.03 h)` to
  `oklch(0.90 0.05 h)` (light). Over it, a blurred, scaled (1.4x) copy of the
  art (`filter: blur(48px) saturate(1.6)`) at 30% opacity (dark) / 20%
  (light) as texture, not as the colour source. No black scrim. Text uses
  `--label` for the scheme. Harness assertion on the Now Playing fixtures
  (pure white, pure yellow, pure grey, Cider Chat): background sampled at the
  title's y has chroma >= 0.05 in dark and `--label` contrast >= 7:1 in both
  schemes.
- Android: derive a tonal palette with `oklch`, at the same chroma as iOS
  (critique r3: `oklch(0.22 0.03 h)` was grey-brown for every cover and
  failed the chroma floor by construction). Dark: the `.np` background is
  `linear-gradient(180deg, oklch(0.26 0.06 var(--art-h)) 0, oklch(0.15 0.04
  var(--art-h)) 100%)`, `--np-container: oklch(0.32 0.07 h)`, `--np-primary:
  oklch(0.82 0.12 h)`. Light: `linear-gradient(180deg, oklch(0.97 0.02 h) 0,
  oklch(0.93 0.035 h) 100%)`, `--np-container: oklch(0.92 0.04 h)`,
  `--np-primary: oklch(0.45 0.12 h)`. Those lightness values keep `--label`
  above 7:1 on the room for every hue; **check C runs on `android-dark` and
  `android-light` with the same thresholds as iOS.**
- Transition between items: `@property --art-h` registered as `<angle>` so the
  change animates over 600ms `--ease-out`.

### 1.6 Typography

Font stacks:
- `--font-text: -apple-system, system-ui, "Inter", sans-serif;` (iOS)
- `--font-text: "Roboto Flex", system-ui, "Inter", sans-serif;` (Android;
  `Roboto Flex` is the OEM name on stock Android. Do not ship it; it resolves
  from the system. Ship only Inter.)
- `--font-voice: "Newsreader", Georgia, serif;` both platforms.
- Shipped files, OFL, Latin subset, variable woff2 under `fonts/`:
  `Inter[opsz,wght].woff2` (about 100 KB), `Newsreader[opsz,wght].woff2` and
  `Newsreader-Italic[opsz,wght].woff2` (about 90 KB each). Fraunces and DM Sans
  files are removed from the direction's bundle.
- `font-feature-settings: "tnum"` on `.clock`, `.badge`, `.count`.

Scale (`--t-*`: size / weight / line-height / letter-spacing):

| Token | px | wght | lh | tracking | Used for |
|---|---|---|---|---|---|
| `--t-large-title` | 34 | 700 | 41 | -0.4 | Home "Today", Library title (iOS only) |
| `--t-title-1` | 28 | 700 | 34 | -0.3 | Android top bar title, onboarding promise (Newsreader) |
| `--t-title-2` | 22 | 600 | 28 | -0.2 | Now Playing title, Foray detail title, section headers |
| `--t-headline` | 17 | 600 | 22 | 0 | card titles, row titles, buttons |
| `--t-body` | 17 | 400 | 22 | 0 | show notes, dialogs |
| `--t-callout` | 16 | 400 | 21 | 0 | hero meta line |
| `--t-subhead` | 15 | 400 | 20 | 0 | row subtitle (show name), mini player title at 600 |
| `--t-footnote` | 13 | 400 | 18 | 0 | meta, clip lengths, tab labels at 500 |
| `--t-caption` | 12 | 400 | 16 | 0 | badges, eyebrows at 600 uppercase +0.6 tracking, always `--label-2` (never amber; critique r1) |
| `--t-hero-title` | 20 | 600 | 25 | -0.2 | HeroCard title only, clamp 3 (critique r1: 22px ran four lines beside the composite) |
| `--t-voice` | 17 | 400 italic | 24 | 0 | why-lines, narration labels (Newsreader, opsz 17) |
| `--t-voice-lg` | 19 | 400 italic | 26 | 0 | Stretch bridge headline (Newsreader, opsz 19) |

Text size follows the OS:
- Android: the WebView honours system font scale through text zoom (`Web+`,
  default behaviour). Sizes are in `rem` so it works; test at 130% and 200%.
- iOS: `Web+` bridge. On boot, measure `font: -apple-system-body` on a hidden
  element, compute its ratio to 17px and set `html { font-size }` accordingly,
  clamped to 85%-160%. Re-measure on `visibilitychange`. **Phase 3 verifies this
  on Wyatt's phone; if it does not track Dynamic Type, re-enable pinch zoom**
  (viewport meta without `user-scalable=no`, drop the gesture guard).
- Layouts must survive 160%: titles clamp (`-webkit-line-clamp: 2`), rows grow,
  the transport never shrinks below 44px, play stays on screen at 375x667.

### 1.7 Shape

| Token | iOS | Android | Use |
|---|---|---|---|
| `--r-sm` | 8 | 12 | chips, badges, small art (40px) |
| `--r-md` | 12 | 16 | rows' art, cards, buttons |
| `--r-lg` | 20 | 28 | hero card, sheets' top corners, dialogs |
| `--r-pill` | 999 | 999 | play, tab indicator, pills |
| `--r-art` | 8 (≤56px) / 12 (≤168px) / 16 (hero) | same | artwork, by size |

iOS corners use `corner-shape: superellipse(…)` behind `@supports`, square
`border-radius` otherwise.

### 1.8 Spacing and layout

- Scale: `--s-1: 4px`, `--s-2: 8`, `--s-3: 12`, `--s-4: 16`, `--s-5: 20`,
  `--s-6: 24`, `--s-8: 32`, `--s-10: 40`, `--s-12: 48`.
- `--gutter: 16px` at every viewport (iOS and Android both use 16 on phones).
- Section header to first item: 8. Between sections: 28. Rail card gap: 12.
- Rail peek: cards are 168px wide, so at 393px the third card's first 25px shows;
  at 375px, 7px; at 412px, 44px. Titles clamp to two lines; never cut mid-word.
- Rows: show 56, episode 72, Up Next 64, credits 56, settings 44. Row art is
  40 (56-row), 56 (72-row). Row padding 12 vertical, gutter horizontal.
- Minimum target: 44x44, including the 30px-tall mini-player buttons (padded).
- Bottom chrome heights: iOS tab bar 50 + mini player 56 + 8 gap +
  `safe-area-inset-bottom`; Android nav bar 80 + mini player 56 +
  `safe-area-inset-bottom`. Content gets `padding-bottom` equal to the stack.

### 1.9 Elevation and material

iOS:
- `--glass-bg: rgba(28,28,30,.78)` dark / `rgba(242,242,247,.85)` light;
  `--glass-filter: blur(20px) saturate(180%)`; `--glass-edge: inset 0 0.5px 0
  rgba(255,255,255,.12)` (dark) / `rgba(0,0,0,.06)` (light).
- Fallback (`prefers-reduced-transparency`, `prefers-contrast: more`, or no
  `backdrop-filter` support): `--glass-bg: #2A2A2D` / `#E9E9EE`, no filter.
- `--shadow-card` (light only): `0 1px 2px rgba(0,0,0,.06), 0 4px 12px
  rgba(0,0,0,.06)`. Dark: none.
- `--shadow-sheet: 0 -8px 32px rgba(0,0,0,.35)`.
- Cards have no border. Separators appear only between rows inside one grouped
  list, inset by the art width + gutter.

Android:
- Levels: 0 = `--bg`, 1 = `--surface`, 2 = `--surface-2`, 3 = `--fill`.
- Shadow only on the 64px play (`0 2px 6px rgba(0,0,0,.3)`) and the Android
  mini player (`0 1px 3px rgba(0,0,0,.25)`).
- No `backdrop-filter` anywhere on Android. Bars are opaque `--surface-2`.

### 1.10 Motion tokens

```
--dur-xs: 120ms;  --dur-s: 200ms;  --dur-m: 320ms;  --dur-l: 450ms;  --dur-xl: 600ms;
--ease-out: cubic-bezier(0.2, 0, 0, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
--spring-snappy:  linear(0, 0.013 1.6%, 0.051 3.3%, 0.199 6.9%, 0.429 11%, 0.665 15.5%, 0.856 20.3%, 0.977 25.5%, 1.045 31.1%, 1.065 36.4%, 1.052 42.6%, 1.019 51.5%, 0.996 62.5%, 0.993 72%, 1);
--spring-default: linear(0, 0.009 2%, 0.037 4.2%, 0.142 8.7%, 0.316 14%, 0.52 19.7%, 0.716 25.6%, 0.868 31.6%, 0.967 37.6%, 1.021 43.7%, 1.04 49.9%, 1.034 57.2%, 1.014 66.3%, 1 78%, 0.997 89%, 1);
--spring-gentle:  linear(0, 0.006 2.6%, 0.025 5.4%, 0.096 11%, 0.219 17.5%, 0.378 24.6%, 0.55 32%, 0.707 39.6%, 0.836 47.4%, 0.93 55.4%, 0.99 63.6%, 1.017 72%, 1.02 80.7%, 1.01 89.6%, 1);
```

Durations paired with the springs: snappy 320ms, default 450ms, gentle 600ms.
(The curves approximate response 0.35 / 0.5 / 0.65 at damping 0.85 / 0.8 / 0.9;
regenerate with any spring-to-linear tool if the feel is off; they are tokens,
not physics, and are not interruptible: for the drag-driven sheet, drive
`transform` from the pointer directly and only spring the release.)

One block, at the end of the stylesheet, covering everything:

```
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
    transition-duration: 120ms !important; transition-timing-function: ease-out !important;
    scroll-behavior: auto !important;
  }
  ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
  .np-art, .mini-art, .hero-strip, .play-btn { transition-property: opacity !important; transform: none !important; }
}
```

## 2. Iconography

- Set: **Material Symbols Rounded**, Apache 2.0, weight 400, grade 0, optical
  size 24, `FILL 0` and `FILL 1`. Export each needed glyph as a 24x24 path and
  put all of them into `icons.svg` as `<symbol id="i-<name>">` and
  `<symbol id="i-<name>-fill">`. Use with `<svg class="ic"><use href="#i-play-fill"/></svg>`;
  `currentColor`; sizes 20 (row actions), 24 (default), 28 (tab bar), 32 (skip),
  40 (play glyph inside the 64px button).
- Needed glyphs (about 40): home, search, library_music, settings, more_horiz,
  more_vert, chevron_left (iOS back), arrow_back (Android back), close,
  play_arrow, pause, replay (15 back; render the number inside the arc via a
  `<text>`-free approach: two symbols `i-back15` and `i-fwd30` are custom paths
  built from `replay`/`forward_media` plus a drawn 15/30), skip_next,
  speed, bedtime (sleep), bookmark, bookmark-fill, share (iOS: `ios_share`,
  Android: `share`), playlist_add, queue_music, download, download_done, check,
  check_circle, drag_handle, vertical_align_top, arrow_upward, arrow_downward,
  delete, undo, headphones, graphic_eq (playing indicator), schedule,
  wifi_off, error, refresh, open_in_new, explicit (badge), info.
- Custom glyphs, same 24 grid, 2px rounded strokes: `i-4a` (the wordmark in
  mark form; used at 12-16px as the authorship mark. **It must read as two
  letters at 12px**: the "4" in x 2-13 with its stem at x 11 and crossbar at
  y 15; the "a" at full x-height in x 13.5-22, bowl r 3.6 centred (17.8, 16.4),
  stem at x 21.4 from y 11.5 to 20; strokes 2.2. Round 1's tucked "a" read as a
  full stop, "4." If a redraw still fails at 12px, eyebrows set the word "4a"
  in the text face at 600 and the symbol is used only at 20px and above), `i-stretch` (a fork: one stem splitting into two, the
  right branch slightly longer), `i-foray` (three horizontal bars of unequal
  length joined by two short dashes: the seam in miniature).
- Tab bar: outline when idle, fill when selected, both platforms. Label always
  shown (iOS 13px/500; Android 12px/500).
- No Unicode glyphs anywhere, including `›` in links and `·` in meta (use the
  middle dot character only inside text meta lines, never as an affordance).

## 3. Component inventory

Each component is one CSS block and one render helper. Platform differences are
limited to the listed properties; everything else is shared.

| Component | What it is | Platform deltas |
|---|---|---|
| `TopBar` | iOS: large title 34px that collapses to a 44px centred 17/600 title with glass backing once content scrolls under it (scroll-driven; JS fallback toggles `.is-collapsed` at 24px scroll). Android: 64px top app bar, 22/400 title left, no collapse, opaque. Trailing action slot (settings glyph on Home; overflow elsewhere). Back: iOS chevron + no label; Android arrow. | collapse, backing material, back glyph |
| `TabBar` | 3 items. iOS: floating pill 50px tall, inset 16 from the sides and 8 from the bottom safe area, glass, selected item `--accent` fill icon + label; minimises to a 36px icon-only pill on scroll down (scroll-driven, `@supports`), restores on scroll up or tap. Android: full-width 80px navigation bar, `--surface-2`, 24px icons, pill indicator 64x32 `--accent-container` behind the selected icon, label 12/500 below. | shape, float, minimise |
| `MiniPlayer` | 56px. iOS: docked directly above the tab bar as its accessory, same inset and glass, `--r-md`; Android: `--surface-2` card above the nav bar, `--r-lg`. Layout: art 40 (`--r-sm`) · title 15/600 one line · show 13 `--label-2` · play/pause 44 · forward-30 44. Top edge carries a 2px progress hairline in `--accent`. Tap anywhere else opens Now Playing; swipe up also opens; swipe down on nothing. | material, radius |
| `ArtComposite` | 2x2 (or 3x2 on the Foray detail hero) tiles in one square: `gap: 1px` in `--bg`, tiles square, `border-radius` only on the container with `overflow: hidden`. It must read as one cover, not four thumbnails (critique r1). | none |
| `HeroCard` | Full width, `--r-lg`, `--surface`. Top: `ArtComposite` 4 tiles at 2x2 filling a 1:1 area on the left 40% at 393 (min 132px), right column: eyebrow 12/600 uppercase `--label-2` (`i-4a` + "TODAY'S FORAY" or "JUMP BACK IN"), title `--t-hero-title` 20/600/25 clamp 3, meta 16 `--label-2` ("24 min · 3 shows"). Full width below: `SeamStrip` 12px, then why-line `--t-voice`, then an action row: 56px `PlayButton` + "Play" 17/600 label (same row component as Foray detail) left, and right a **tonal pill** (44px, `--fill`, 17/600 `--label`, padding 0 16, glyph 20 when it has one): "Details" here, "Add to Up Next" with `i-playlist_add` on Foray detail (critique r2: a bare text button on Home and a pill on detail were two grammars for one row). In-progress variant: meta becomes "12 min left", the label "Resume", and the strip shows progress. | none |
| `PickRow` | Two-tier row, `min-height: 72px`, grows: art 56 (`--r-sm`) · title 17/600/22 **clamp 2** · meta 15 `--label-2` one line with the duration first ("31 min · Masters of Scale", so the number survives truncation) · why-line `--t-voice` 16/22 **clamp 2, never ellipsized** (critique r3: clamp 1 cut every why-line in Jump back in and Search; the voice is the brand, so the row pays the 22px) on the second tier, **full row width from the left padding** (grid areas `"art title actions" / "voice voice voice"`; critique r1: a why-line in the title column truncated three things at once). Heights: 72 (one-line title, one-line why), 80 (two-line title), 94 (two-line why), 102 (both). Trailing: **one 44px play glyph (outline), no overflow** (critique r2: play + overflow left a 200px title column and ellipsized both title and show name); every overflow item is in the `ContextMenu`. Pressed: `--fill`. Long-press (iOS) opens a context menu; Android long-press opens the same bottom menu. | long-press surface |
| `RailCard` | 168 wide: art 168 square (`--r-md`) or `ArtComposite`; title 17/600 clamp 2; meta 13 `--label-2`; forays add a 5px `SeamStrip` between art and title. | none |
| `BridgeCard` | The Stretch slot. Same footprint as `RailCard` (in rails) or `PickRow` (in lists) with: `i-stretch` + "STRETCH" eyebrow in `--label-2` (not amber: the icon, the word and the serif headline carry it); art pair: the pick's art (the art block is **168 tall in rails, the same as `RailCard`**, so the card's text starts where its neighbours' does; critique r3: a 204px block with the chip hanging 12px below the cover on a vertical stitch read as a pin and dropped the eyebrow 36px), and **on its bottom-left corner** a 24px chip (`position: absolute; left: 8px; bottom: -8px; border-radius: 6px; box-shadow: 0 0 0 2px var(--surface)`) of the familiar show it bridges from, joined by a **16px horizontal stitch** from the chip's right edge at its vertical centre (the seam's thread: `repeating-linear-gradient(90deg, var(--label) 0 4px, transparent 4px 8px)`, 2px tall, opacity .45); the row variant shows the same stitch. Eyebrow at cover + 16. The bridge sentence is the headline: `--t-voice-lg` 19/26 **clamp 3** in rows and on the detail, **17/22 clamp 4** in the 168px rail card, **never ellipsized**; copy rule: **rail bridge sentences are 12 words or fewer** (rows and detail 16). Title and show below it in `--t-subhead`. Rule: the bridge is never the smallest text on the card. | none |
| `SeamStrip` | The foray timeline (rewritten in critique r2: short dashed bars between clips read as morse code). `position: relative; display: flex`, heights 5 (sm), 8 (md), 12 (lg); **gap 6 (sm) / 8 (md) / 10 (lg)**. **The thread**: `::before` at `position: absolute; left: 0; right: 0; top: 50%; height: 2px; transform: translateY(-50%); background: repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 8px); color: var(--label); opacity: .45`, under the bars (z-index 0); it shows only in the gaps. Narration has no DOM element; un-narrated forays set `.no-thread` (no `::before`, gap 2). Clip bars: `flex: <seconds> 0 0`, `min-width` 6 (sm) / 8 (md) / 10 (lg), `--r-pill`, colour `--seg-c<n>`; unavailable clip: `--seg-hatch`. **Progress is opacity, never amber**: a strip with no progress shows every bar at 100%; with progress, played bars 100%, unplayed 40%; the current bar is split at the playhead by an `::after` overlay in `--bg` at 60% opacity, `left: calc(var(--p) * 100%); right: 0`. Playhead: 2px `--label` hairline, 18px tall at lg, 12 at md, none at sm, at the current bar's fill edge; during narration it sits on the thread in the gap after the last played bar. Library rows (sm): same opacity rule ("9 of 22 played"), no playhead; **at sm only, when a foray has more than 12 clips, consecutive clips of one show merge into one bar (a show run)**, opacity applies per run and the current run splits at `--p` (critique r3: 22 bars of 4-10px in a 240px strip were beads); md and lg keep one bar per clip. At lg, a show name under a bar **only when the whole name fits** at 12px with 4px padding (measure after layout, toggle `.hide`); never ellipsize; drop the 16px label row when nothing fits (the tap chip identifies short bars). Accessible: `role="slider"` at lg (it is the scrubber), `aria-valuetext` "Clip 2 of 5, The Rest Is History, 4 min 10 sec in" or "Narration before clip 3 of 5". | none |
| `PlayButton` | 64 (Now Playing), 56 (hero, foray detail), 44 (rows): `--accent` fill, `--on-accent` glyph. Android: shape morph on state, circle (playing) to `--r-lg` rounded square (paused), spring-default. iOS: no morph; scale 0.94 on press. | morph |
| `Transport` | Row: back-15 (44, 32px glyph) · PlayButton 64 · fwd-30 (44). Gap 32. Below: speed, sleep, bookmark, share, Up Next (count badge) in a 5-up row of 44px targets, 20px glyphs, 13px labels only on Android (iOS icons only, labels via `aria-label`). | labels |
| `Scrubber` | Episode: 8px track `--fill`, 8px fill `--accent`, 20px thumb appears on touch only; times 13 `tnum` 8px below, left current, right remaining ("-12:04"). Foray: `SeamStrip` lg replaces the track; the thumb is a 2px `--label` hairline. Chapter/segment boundaries snap with a selection haptic. | none |
| `Sheet` | iOS: `--r-lg` top corners, grabber 36x5 `--fill` at 8px, glass, detents 50% / full, drag to dismiss. Android: M3 modal bottom sheet, `--surface-2`, grabber 32x4, full-height expand. Focus: on open, focus the sheet's title; on close, return focus to the opener; `inert` on the page behind. | material |
| `Segmented` | iOS: 32px segmented control, `--fill` track radius 9, `--surface-2` thumb radius 7 with shadow in light, labels 13/500, selected 13/600, padding 0 8, never scrolls; Android: M3 filter chips row (32px, `--accent-container` selected). Library uses it. | component |
| `Cluster` | Search idle tile: 2x2 `ArtComposite` 160-180 wide (masonry decides), `--r-md`, subject name 15/600 below, show count 13. | none |
| `SearchField` | iOS: 44px glass pill at the bottom, 8px above the tab bar (the tab bar collapses to the icon-only pill while the field is focused), magnifier leading, clear trailing, keyboard pushes it up (`interactive-widget=resizes-content`). Android: M3 search bar 56px at the top, `--surface-2`, `--r-pill`. Focus ring: 2px `--accent` outline offset 2 (`:focus-visible` only). | position, shape |
| `QueueRow` | 64px: **Android only** a leading drag handle (`i-drag_handle`, visible but inert until native drag lands) · art 44 · title 15/600/20 **clamp 2** (critique r3: clamp 1 cut five titles in five rows) · show 13/18 one line · trailing: position number 13 `tnum` in `--accent` for the current row plus `i-graphic_eq`; others `--label-2`; then the overflow glyph, **`i-more_horiz` on iOS, `i-more_vert` on Android** (critique r3: iOS rows carried the Android handle and `⋮`; iOS reorders by long-press drag when native drag lands, overflow Move up / Move down until then). Swipe leading: "Top" (`--accent`); trailing: "Remove" (`--danger`) with a snackbar undo. Overflow: Move up, Move down, Play next, Remove. Current row tint: `color-mix(in srgb, var(--accent) 12%, transparent)` on both platforms (critique r3: `--accent-soft` at full strength was a banner above a mini showing the same item; meaning by number, icon and tint, not colour alone). | handle, overflow glyph, swipe visuals |
| `Banner` | Thin 36px offline/notice strip under the top bar: `i-wifi_off` + 13px text, `--surface-2`. Not dismissible; disappears with the condition. | none |
| `EmptyCard` | `--surface`, `--r-lg`, 20px padding: `i-<icon>` 28px in `--label-2`, one line 17/600, one line 15 `--label-2`, one 44px tonal button. No underlined links, no quoted button names. | none |
| `Skeleton` | Same boxes as the real component, `--fill`, 1.2s opacity pulse (disabled under reduced motion). | none |
| `Badge` | 18px pill, 12/600 `tnum`, `--accent` fill `--on-accent` text (Up Next count); `--fill` and `--label` for neutral badges ("E" explicit uses `i-explicit`). | none |
| `ContextMenu` | iOS: long-press, blurred page, the row lifts (scale 1.03) and a glass menu appears beneath; Android: long-press bottom sheet with a list. Items: Play, Play next, Add to Up Next, Save, Download, Share, Go to show. | component |
| `Snackbar` | Android only, 48px, `--fill` inverse, undo action; iOS uses a 44px glass toast at the top with the same undo. | component |

## 4. Per-screen layout specs

Dimensions assume 393x852; the same CSS must render at 375x667 and 412x915.
Vertical positions are from the top of the content area (below the status bar).

### 4.1 Home

```
TopBar      large title "Today" (iOS) / top app bar "Today" (Android)   trailing: settings
            [Banner when offline]
0           HeroCard  (margin 16, padding 16; composite 148 square at 393;
            strip 12 at +12; why-line at +8; action row at +12; total ≈ 300)
+28         Section "Forays for you"  header 22/600 + "See all" 15 accent, rail of RailCard 168
+28         Section "Playlists for you"  rail of RailCard with ArtComposite
+28         Section "More picks"  header + PickRow list (6 rows); one BridgeCard row
            in position 2 or 3, never last
+bottom     padding = tab bar + mini player + safe area
```

States: **first run**: hero eyebrow "YOUR FIRST FORAY", why-line cites the
subject only; no "Jump back in"; "More picks" shows 6. **Returning**: hero is
today's foray; the resume item (if any) becomes a 72px `PickRow` variant with a
progress hairline, placed directly under the hero as "Jump back in", no rail.
**Mid-listen**: when the resume item is the hero's own foray, the hero shows
progress and "12 min left" and nothing repeats below. Never show the same item
twice above the fold (dedupe by id across hero, resume, rails). **Stress**:
titles clamp 2, why-lines clamp 2 in the hero and 1 in rows; a rail with 12
items ends with a "See all" card. **Offline**: Banner; hero becomes the first
downloaded item; undownloaded rows at 55% opacity with a footnote "Needs a
connection". **Loading**: Skeleton hero + two skeleton rails.

### 4.2 Now Playing (full) and mini

iOS sheet / Android full screen, background per 1.5.

```
0     Grabber (iOS) / 12px top padding (Android)
12    Context line 13 --label-2 centred: "Playing from Today" ; trailing overflow 44
+16   Art: width − 48, square, --r-lg, centred. Paused: scale .6 (spring-gentle)
      Foray: the CURRENT CLIP's show artwork (not the composite); crossfade to the
      next show on hand-off (--spring-default 450ms); the mini player shows the same
      image so the shared element is one picture (critique r1)
+24   Title 22/600 clamp 2 ; Show 15 --label-2 (tap goes to show) ; foray: show name
      + " · clip 3 of 10" tnum (the clip's episode title lives in the credits row)
+16   Scrubber (episode) or SeamStrip lg (foray) ; times 13 tnum at +8
+24   Transport: back-15 · Play 64 · fwd-30 ; centred ; gap 32
+20   Secondary row: speed ("1×" 15/600) · sleep · bookmark · share · Up Next (badge)
+24   ---- fold at 852 ends here ; scroll continues ----
      Foray: "Where this came from" credits (56px rows ONLY, no tile row: art 40,
      show name 15/600, second line 13 --label-2 "<episode title> · 1 min 12 sec",
      trailing i-open; repeated show names are correct, each clip is a row)
      Episode: Chapters list (44px rows, time tnum leading) when present, else hidden
      Show notes (17/400, "More" after 6 lines)
      Up Next: next item PickRow with why-line prefixed "Next: " ; "Up Next (5)" header
```

Size budget at **375x667** (content height ≈ 600 after status bar): art is
`min(width − 48, 46vh)` so the art is 276 at 375x667; with a 2-line title the
transport's centre lands at about 560 and the secondary row is partly below
the fold, which is allowed; play is not. The harness asserts
`play.getBoundingClientRect().bottom <= viewport.height`.

Foray states: current clip's bar at 100% with progress fill; narration playing
shows "4a" (`i-4a`) + "Narration" in `--t-voice` where the show name would be;
hand-off tick haptic; "Where this came from" rows mark the current clip with
`i-graphic_eq`. **Un-narrated**: no dashed bars; a 13px footnote under the
strip: "Clips play back to back." **Buffering**: the play glyph swaps to a
24px indeterminate ring inside the same 64px button; nothing else moves.
**Offline/downloaded**: `i-download_done` in `--good` next to the show name.
**End of item**: the next item's art slides in from the right in the art slot
(spring-default) while the title crossfades; the Up Next why-line was already
visible, so nothing is read for the first time. **Max text size**: title clamp
2, show notes reflow, transport fixed.

Mini: see `MiniPlayer`. Progress hairline mirrors the scrubber. Accessibility:
the mini is a `role="region"` labelled "Now playing: <title>"; the open action
is a 44px button covering the text area.

### 4.3 Search / Discover

```
iOS:  TopBar "Search" large title ; content ; SearchField at the bottom (glass)
And:  SearchField at the top (56) ; content
Idle: 16 margin, two-column masonry of Cluster tiles (gap 12), 6 clusters; the
      right column starts 28px lower and items 1, 4, 5 are `.tall` (1:1.18) so no
      two neighbours align (critique r1: equal tiles made a grid, not a splatter),
      then "Followed shows" as a horizontal row of 56px art circles (optional),
      then nothing else. No pill wall.
Typing: results list; groups "Shows" (56px rows: art 40, name 15/600, episode
      count 13), "Episodes" (PickRow), "Playlists" (72px with ArtComposite);
      when the query reads as a subject (matches a taxonomy label), the first
      row is "Build a playlist about <query>" with i-playlist_add.
No results: EmptyCard: "No shows match 'fusion'." + "The subject Fusion &
      energy systems has 5 shows." + button "Open Fusion & energy systems".
      The copy is generated from the taxonomy so it can never contradict a
      visible cluster.
Keyboard open: iOS field rides above the keyboard; the tab bar hides; Android
      field stays at the top, results scroll.
```

### 4.4 Library

```
TopBar "Library" (large title / app bar) ; trailing: "+" (new playlist) ; overflow
Segmented / chips: Forays · Shows · Saved · Playlists · Up Next · History
Forays:    PickRow variant 76: title 17/600 clamp 1, SeamStrip sm (played 100%,
           unplayed 40%), meta 13 "9 of 22 clips played" (critique r1: 2-line titles
           gave 105px rows). No chevron: the row is the target (critique r2: the
           chevron cost 36px and three of five titles ellipsized)
Shows:     3-column grid, art square (gap 8, margin 16 → 115px tiles at 393), name 13 clamp 1 beneath
Saved:     PickRow list
Playlists: 72px rows with ArtComposite 56
Up Next:   header "5 queued · 1 hr 40 min" + QueueRow list ; "Clear" in the overflow with a confirm
History:   56px rows with a played tick in --good
Empty (each): one EmptyCard with one action ("Find shows", "Open today's picks")
```

Up Next rules: reorder without dragging (move up / down / to top in overflow and
swipe), remove with undo (5 s), the played row jumps to the top (founder
ruling kept), rows 64 with two-line titles, current row marked by number
colour + `i-graphic_eq` + a 12% accent tint; the leading drag handle and `⋮`
are Android's, iOS gets `…` and no handle (critique r3).

### 4.5 Foray detail

```
TopBar: back ; trailing: share, overflow. Transparent over the hero on BOTH
      platforms; the three controls are 40px circles (iOS glass, Android
      --surface-2). Critique r2: Android's opaque app bar cropped the mosaic
      to a 60px first row.
0     Hero: ArtComposite full width, height 200 at 393 (aspect-ratio 393/200, 3x2
      mosaic, object-fit cover, gap 1). NO text on the art (critique r2: a
      title over six covers never found ground, after a scrim and a bolder
      weight). Scrim only for the top band, for the status bar and the circles:
      linear-gradient(180deg, rgba(0,0,0,.62) 0, rgba(0,0,0,.32) 22%,
      rgba(0,0,0,0) 48%) (critique r3: .45 ending at 40% left the status
      glyphs on orange lettering). iOS circles take the glass tint at 78%,
      Android --surface-2.
+16   Eyebrow i-4a "FORAY" --label-2, on --bg
+4    Title 28/700 clamp 2 (Newsreader is NOT used for titles)
+8    Meta 16 --label-2: "24 min · 3 shows · made today"
+16   SeamStrip lg with show labels beneath
+12   Why-line --t-voice (2-3 lines)
+16   Action row (the HeroCard's): PlayButton 56 + label ("Play" / "Resume · 12 min
      left" / "Play again") + tonal pill "Add to Up Next" with i-playlist_add.
      Play lands at about y 520 at 393 and 500 at 375: on screen unscrolled.
+24   "Where this came from": credits rows (56) in play order, each: art 40, show 15/600,
      "<episode title> · 4 min 10 sec" 13, trailing i-open_in_new to the show page;
      narration rows show the i-4a tile and, as the title, the narration line
      itself in --t-voice 16/22 ("Next: where cooking may have started."),
      footnote "4a narration · 12 sec" 13 --label-2 (critique r3: "Narration"
      in the sans with the line in the footnote put 4a's sentence in the
      system voice). Rows only: no tile strip above them (critique r1)
+24   "Why this foray" paragraph 17/400 (the explanatory text today's screen has)
```

States: unplayed (Play); in progress (strip shows progress, "Resume");
finished (`i-check_circle` `--good` next to the meta, "Play again");
un-narrated (no dashed bars, footnote); unavailable (hero stays, strip hatched,
an EmptyCard "This foray can't play right now: <reason>" + "Find something
similar" button that runs a subject search).

### 4.6 Onboarding, first screen

Full screen, `--bg`, safe-area padded.

```
centred   The block (card + headline + sentence) is vertically centred in the
          space between the safe-area top and 32px above the buttons (critique
          r1: top-anchored left a 500px void). Radial amber glow behind the card
          only, max rgba(255,178,77,.06).
          The real HeroCard at scale .86 (transform-origin top center), pointer-
          events none, why-line in --t-voice like the real one, with its SeamStrip
          animating a 6 s loop of a clip filling then handing to a narration dash
          (disabled under reduced motion: static strip at 40%)
+24       "Podcasts, stitched around you" Newsreader 28/400, --label
+12       One sentence 17/400 --label-2 (max 18 words): "4a picks real shows and
          joins their best parts into one listen, with a reason for each."
bottom    Two 50px buttons, full width, stacked, gap 12: "Show my picks" (accent fill),
          "Skip for now" (tonal / --fill)
```

Returning after skip: no screen; Home opens. The intro can be reopened from
settings ("How 4a works").

## 5. Motion specs

| Transition | iOS | Android | Fallback |
|---|---|---|---|
| Mini to Now Playing | `document.startViewTransition`; `view-transition-name: np-art` on the mini art and the full art; the sheet translates up with `--spring-default` 450ms while the tab bar translates down 100% + fades; drag-down to close follows the pointer, release springs to the nearer end | Container transform: the mini card's box grows to full screen (`clip-path: inset(... round 28px)` to `round 0`), `--spring-default`; nav bar fades 150ms | FLIP on `.mini-art` to `.np-art` (translate + scale), 450ms |
| Row art to mini | `view-transition-name` assigned on the tapped row's art only for the duration of the transition; scale 56 to 40 into the mini slot, `--spring-snappy` 320ms; Up Next badge: scale 1 to 1.25 to 1, 200ms | same | FLIP |
| Push / pop | `@capgo/capacitor-transitions` if it works on WKWebView (Web+, unverified); else CSS: incoming `translateX(100%) to 0`, outgoing `0 to -30%` with a 0.15 scrim, 350ms `--ease-out`; edge-swipe back via pointer events on the left 20px | Shared-axis X: incoming slides 30px + fades, outgoing slides -30px + fades, 300ms | crossfade 200ms |
| Tab switch | none (instant), content keeps scroll position per tab | fade-through 200ms | instant |
| Tab bar minimise | scroll-driven: `animation-timeline: scroll(root)`, `animation-range: 0 120px`, tab bar height 50 to 36 and labels opacity 1 to 0; restores on any scroll up via a 50px upward-delta JS toggle | nav bar hides fully on scroll down (translateY 100%), returns on scroll up, 250ms `--ease-out` | always expanded |
| Large title collapse | scroll-driven: title scale 1 to 0.5 and translate into the bar, glass backing opacity 0 to 1 over 0-44px | n/a | class toggle at 24px |
| Sheet open / close | translateY 100% to 0, `--spring-default`; scrim 0 to .4, 200ms | same with `--surface-2`, no scrim blur | 200ms fade |
| Play / pause | glyph crossfade 120ms; art scale 1 to .6 `--spring-gentle` on pause, back on play | same + shape morph circle to rounded square `--spring-default` | opacity only |
| Seam fill | the current bar's inner fill width follows `currentTime` via a CSS variable set on `timeupdate` (4 Hz); no CSS transition on the fill (it would lag); hand-off: next bar opacity .7 to 1 over 200ms | same | same |
| Artwork colour change | `@property --art-h` transition 600ms `--ease-out` | same | instant |
| Queue insert / remove | list gap opens with `grid-template-rows` 0 to 64px 320ms `--spring-snappy` (height animate via `interpolate-size: allow-keywords` behind `@supports`, else fixed 64px) | same | instant |
| Skeleton to content | content fades in 200ms; no layout shift (same boxes) | same | same |

Haptics (`@capacitor/haptics`, Web+; no-op on the web):

| Moment | iOS | Android |
|---|---|---|
| play / pause | `impact({style: 'MEDIUM'})` | `impact({style: 'LIGHT'})` |
| scrub snap to chapter / segment | `selectionChanged()` | same |
| foray hand-off (clip to narration) | `selectionChanged()` once | same |
| bookmark | `notification({type: 'SUCCESS'})` | same |
| add to Up Next | `impact({style: 'LIGHT'})` | same |
| context menu open | `impact({style: 'MEDIUM'})` | `impact({style: 'LIGHT'})` |
| tab change | none | `selectionChanged()` |

Media session (Web+, `capacitor-media-session`): title, show, artwork, position,
and handlers for play, pause, seekbackward (15), seekforward (30), seekto,
nexttrack / previoustrack only when the route is headset or car (existing
rule). The Up Next item's title goes into the Android notification's subtitle
slot where supported; iOS gets it on item change.

## 6. Accessibility checklist (feature by feature)

- Every icon-only control has `aria-label`; the tab bar is a `nav` with
  `aria-current="page"`.
- The seam strip is a `slider` with `aria-valuetext` naming clip, show and
  position; the credits list repeats the same information as text.
- Current queue row: number colour, icon and tint (three signals).
- Stretch: icon + eyebrow word + serif headline (not colour alone).
- Focus: sheets trap focus, return it on close; `:focus-visible` ring 2px
  `--accent`, offset 2, never removed.
- Contrast: every pair in 1.3; `--label-3` never carries meaning.
- Text size: rem throughout; verified at 160% on both platforms; play on
  screen at 375x667 at 160%.
- Reduced motion: the single block in 1.10; the onboarding strip loop stops.
- Reduced transparency / increased contrast: solid glass fallback.
- Targets: 44x44 everywhere; the 30px-tall mini-player buttons are padded to 44.

## 7. Mapping to the ten problems (brief section 5)

1. Imagery: `ArtComposite` on hero, rails, playlists, forays, Up Next, Search clusters.
2. Now Playing: no app header, one sprite, one accent, art sized by viewport so play stays on screen at 375x667.
3. Hierarchy: one `HeroCard` with eyebrow, title, strip, why-line and play; rails step down; dedupe by id.
4. Density: rows 56-72, Up Next 64 with two visible controls, Interests gone from the main flow.
5. Icons: `icons.svg`, Material Symbols Rounded + three custom glyphs.
6. Accent: one amber; everything else neutral or data colour.
7. Chrome: no tagline header, no drawer, no refresh glyph, platform back glyph, collapsing large title, floating/receding bars.
8. Forays: `SeamStrip`, `ArtComposite`, credits, Foray detail hero; "Build a playlist" lives in Search, no disabled control.
9. Consistency: one `Badge`, one `Segmented`/chip set, `aria-current` tab state from the route, blurred (or solid) field.
10. Empty states: `EmptyCard` with one action; Banner for offline; honest no-results built from the taxonomy.

## 8. Prototype notes for the Sonnet builder

- Files: `prototype/index.html`, `prototype/styles.css`, `prototype/app.js`,
  `prototype/icons.svg`, `prototype/fonts/` (Inter, Newsreader only).
- Query parameters: `?screen=home|player|search|library|foray|onboarding`,
  `&state=<name from section 4>`, `&os=ios|android`, `&scheme=light|dark`,
  `&transparency=reduced`, `&viewport=393|375|412` is the harness's job, not
  the page's.
- Data: `data/catalog-client.json`, `data/discover.json`, `data/session.json`.
  Artwork from each show's published URL at runtime through `safeUrl()`. No
  images in the repo. **A show outside the committed catalog gets its real
  cover, never a stand-in** (critique r2: the lead foray's stand-ins put Cider
  Chat under "Satay? Okay!" and The Ancients under "Origin Stories"): resolve
  it once through the iTunes Search API
  (`https://itunes.apple.com/search?term=<show>&entity=podcast&limit=3`,
  take `artworkUrl600` of the matching `collectionName`), store the URL in
  `show_art`, regenerate `art.h/c`. If a show cannot be resolved, choose a
  lead foray whose shows all resolve and say so in the hand-off.
- Copy rules: why-lines ≤ 18 words, hooks ≤ 16, the banned words list, no
  "we/us/our", "subject" not "topic", durations "45 min / 1 hr 5 min",
  colon clocks only in scrubbers.
- Write the CSS as if under the app's CSP from the first line: classes only,
  no inline styles, one reduced-motion block at the end.
- Before every critique round, render all six screens at the three
  viewports in both OS modes and both schemes, **in every state section 4
  names**, and check the 375x667 Now Playing play-button assertion by hand in
  each Now Playing state. Rounds 1 and 2 both shipped iOS dark default only
  (21 shots) because the r1 shoot commands put `?os=` on a file path, which
  the harness refuses. With `os`/`scheme` read from the hash query (section
  0) the plan is, per OS and scheme:

  ```
  node tools/ui-lab/shoot.mjs --target url \
    --url docs/redesign-2026/directions/native-2026/prototype/index.html \
    --routes "#/home?os=android,#/home?os=android&state=first-run,…" \
    --scheme light --title "native-2026 r3 android light" \
    --out data-local/redesign/shots/native-2026/r3/android-light
  ```

  (the r1 route list, each route suffixed with `os=<os>`; `--scheme` sets
  `prefers-color-scheme` for the page). Run from PowerShell on Windows. The
  art director's own r2 renders are in
  `data-local/redesign/shots/native-2026/r2-ad/` for comparison.
- **Round 4 additions (critique r3).** The page honours three more hash
  parameters after layout: `&scroll=<px>` (scroll the route's scroller, then
  dispatch `scroll`, so the collapsed large title, the glass nav backing and
  the minimised tab bar render; none had been seen in three rounds),
  `state=chip` on `#/foray` (a tapped clip bar's chip with show art and
  name), `swipe=1` on `#/library?state=upnext` (the trailing "Remove"
  revealed). Routes to add, both schemes, 393: `#/home?os=ios&scroll=320`,
  `#/foray?os=ios&scroll=420`, `#/search?os=ios&state=typing&scroll=300`,
  `#/home?os=android&scroll=320`, `#/foray?os=ios&state=chip`,
  `#/library?os=ios&state=upnext&swipe=1`. Checks: C on all four
  platform/scheme pairs; **D: no `.voice` element has `scrollHeight >
  clientHeight` on any shot** (print the offenders); the bridge card's
  eyebrow baseline within 2px of its neighbours' title baseline at 393.
- Fonts are self-hosted under `prototype/fonts/` (OFL, variable woff2, Latin
  subset), not loaded from Google Fonts: the app's CSP is `font-src 'self'`
  and the harness should run offline.
