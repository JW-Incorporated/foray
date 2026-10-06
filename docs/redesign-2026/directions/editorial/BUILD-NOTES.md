# Edition: build notes

Everything a front-end builder needs to reproduce the Edition direction
(`DIRECTION.md`) without the art director. Numbers here win over prose there.
Hard limits from `../../PLAN.md` apply unchanged: `esc()`/`safeUrl()`, strict
CSP (no inline `style=`/`<script>`), `cp_` storage keys, copy rules (why ≤18
words, hooks ≤16, no "we/us/our", "subject" not "topic"), ~30% floor, no
streaks or infinite scroll, 44px targets, one reduced-motion block, AA contrast,
no third-party imagery committed, fonts self-hosted.

## 0. Assets

| Asset | Source | Licence | Files |
|---|---|---|---|
| Fraunces (variable: wght, opsz, SOFT, WONK) | already in `fonts/` | OFL | `fraunces-variable.woff2`, `fraunces-italic-variable.woff2` |
| DM Sans (variable: wght, opsz) | already in `fonts/` | OFL | `dm-sans-variable.woff2` |
| Newsreader (variable: wght, opsz) | Google Fonts repo (`fonts/ofl/newsreader`) | OFL | add `newsreader-variable.woff2` (Latin subset), `newsreader-italic-variable.woff2` |
| Phosphor Icons, Regular + Fill | `phosphor-icons/core` | MIT | build one SVG sprite `icons/edition.svg`, 24px viewBox, `stroke-width` 1.5 where the set uses strokes; Fill variants only for the three active tab glyphs |
| Custom glyphs | drawn in-repo | ours | `skip-15`, `skip-30`, `stitch`, `explicit`, `ribbon` (see §4.9) |

Subset Newsreader to Latin + Latin-ext with `pyftsubset`, keep `opsz` 6–72
and `wght` 200–800, italics 400 only. Budget: both Newsreader files ≤ 110KB
together; total fonts ≤ 330KB. `font-display: swap`, with `size-adjust` /
`ascent-override` fallbacks: Fraunces → `Georgia`, Newsreader → `Georgia`
(`size-adjust: 97%`), DM Sans → `system-ui`.

Artwork is never committed; load from the catalog's published URLs via
`safeUrl()`.

## 1. Tokens (CSS custom properties)

Put these on `:root`; the Night block overrides under
`@media (prefers-color-scheme: dark)` guarded by
`:root:not([data-scheme="paper"])`, and again under `:root[data-scheme="night"]`.
The override is stored at `cp_scheme` ∈ `paper|night|auto`.

### 1.1 Colour, Paper

```
--page:        #F7F3EC;
--stock-2:     #EFE9DF;
--ink:         #17171A;   /* 16.4:1 on --page */
--ink-2:       #4A4A52;   /*  8.2:1 */
--ink-3:       #6B6A72;   /*  4.8:1, meta ≥12px only */
--rule:        #D9D2C5;   /* 1px rules, 1.5:1, decorative */
--rule-strong: #8E887C;   /* 3.2:1, rules that carry meaning: scrub track, skip-circle borders, .find border, grabber, dot leaders. (r1 critique: #B9B1A3 measured 1.9:1) */
--red:         #B5301C;   /*  5.6:1 on --page; text allowed */
--red-wash:    rgba(181,48,28,0.08);
--on-ink:      #F7F3EC;   /* text on ink buttons */
--veil:        rgba(247,243,236,0.70);
--scrim:       rgba(23,23,26,0.18);   /* page behind a sheet */
--plate-edge:  rgba(23,23,26,0.10);   /* 1px inner rule on artwork */
--shadow-sheet: 0 1px 2px rgba(20,16,10,.08), 0 12px 32px rgba(20,16,10,.14);
--chrome-bg:   rgba(247,243,236,0.86);
```

### 1.2 Colour, Night

```
--page:        #141416;
--stock-2:     #1C1C1F;
--ink:         #ECE7DC;   /* 15.1:1 */
--ink-2:       #B3AEA4;   /*  8.4:1 */
--ink-3:       #8A857C;   /*  5.0:1 */
--rule:        #2B2B30;
--rule-strong: #66666E;   /*  3.3:1 (r1 critique: #4A4A52 measured 1.6:1) */
--red:         #F07A62;   /*  6.5:1 */
--red-wash:    rgba(240,122,98,0.12);
--on-ink:      #141416;
--veil:        rgba(20,20,22,0.70);
--scrim:       rgba(0,0,0,0.30);
--plate-edge:  rgba(236,231,220,0.10);
--shadow-sheet: 0 1px 2px rgba(0,0,0,.30), 0 12px 32px rgba(0,0,0,.45);
--chrome-bg:   rgba(20,20,22,0.86);
```

Naming note: `--ink` is "text colour" in both schemes (cream at night). Do not
name tokens by hue.

### 1.3 Segment inks (`--seg-c0..7`, same names as today)

| Token | Paper | Night | Name |
|---|---|---|---|
| `--seg-c0` | `#1F6F8B` | `#4FA3C2` | teal |
| `--seg-c1` | `#B8862B` | `#D9A94A` | ochre |
| `--seg-c2` | `#6B4FA0` | `#9A80CC` | violet |
| `--seg-c3` | `#2E7D4F` | `#5BAE7C` | green |
| `--seg-c4` | `#8C5A2B` | `#B98453` | umber |
| `--seg-c5` | `#3B5BA5` | `#6F8BD1` | cobalt |
| `--seg-c6` | `#A3366F` | `#CC679B` | magenta |
| `--seg-c7` | `#5B6B2B` | `#8C9E4E` | olive |

Narration: `--seg-narration: repeating-linear-gradient(45deg, var(--red) 0 3px, transparent 3px 6px)` over `var(--red-wash)`. Pattern plus colour, never colour alone.

Artwork tint: `--tint-h` (hue, 0–360) and `--tint-s` set by JS after a cached
canvas extraction (16×16 downsample, most-saturated bin). Pages that take a
tint set `background: color-mix(in oklch, var(--page) 94%, oklch(60% 0.12 var(--tint-h)))`
on Paper and `… 90% …` on Night. Register `--tint-h` with `@property` (syntax
`<number>`, inherits, initial 40) so it transitions over `--t-page`.

### 1.4 Type

```
--f-display: "Fraunces", Georgia, serif;
--f-text:    "Newsreader", Georgia, serif;
--f-ui:      "DM Sans", system-ui, sans-serif;

--fs-masthead: 2.125rem;  /* 34 */  --lh-masthead: 2.25rem;
--fs-d1: 1.875rem;        /* 30 */  --lh-d1: 2.125rem;   /* 34 */
--fs-d2: 1.5rem;          /* 24 */  --lh-d2: 1.75rem;    /* 28 */
--fs-title: 1.1875rem;    /* 19 */  --lh-title: 1.5rem;  /* 24 */
--fs-num: 1.875rem;       /* 30 */  --lh-num: 1.875rem;
--fs-text: 1rem;          /* 16 */  --lh-text: 1.5rem;   /* 24 */
--fs-text-sm: 0.875rem;   /* 14 */  --lh-text-sm: 1.25rem;
--fs-label: 0.75rem;      /* 12 */  --lh-label: 1rem;
--fs-meta: 0.8125rem;     /* 13 */  --lh-meta: 1.125rem;
--fs-button: 0.9375rem;   /* 15 */  --lh-button: 1.25rem;
--fs-ticker: 0.9375rem;   /* 15, Fraunces, the one exception to the 19px band */

--w-display: 500; --w-display-bold: 600; --w-num: 400;
--w-text: 400; --w-label: 500; --w-button: 600;
--ls-label: 0.08em; --ls-d1: -0.01em;
```

Role classes (one each, no ad-hoc sizes):

| Class | font | size/lh | weight | extras |
|---|---|---|---|---|
| `.t-masthead` | display, italic | masthead | 600 | `font-variation-settings: "opsz" 144, "WONK" 1, "SOFT" 0` |
| `.t-d1` | display | d1 | 500 | `"opsz" 72`, `letter-spacing: var(--ls-d1)`, `text-wrap: pretty` |
| `.t-d2` | display | d2 | 500 | `"opsz" 48` |
| `.t-title` | display | title | 500 | `"opsz" 24` |
| `.t-num` | display | num | 400 | `"opsz" 72`, `font-variant-numeric: lining-nums` |
| `.t-text` | text | text | 400 | `"opsz" 16` |
| `.t-note` | text, italic | text | 400 | editor's notes only; always inside `.note` (§4.4) |
| `.t-text-sm` | text | text-sm | 400 | |
| `.t-label` | ui | label | 500 | `text-transform: uppercase; letter-spacing: var(--ls-label)` |
| `.t-meta` | ui | meta | 400 | `font-variant-numeric: tabular-nums` |
| `.t-button` | ui | button | 600 | |

Text zoom: all sizes in rem; the Capacitor `TextZoom` plugin (Web+) applies the
OS text size; every screen is verified at 130% and nothing may clip (headlines
clamp by line count, not height). Minimum rendered size 12px. **One exemption
(r1 critique):** the 11px captions under the folio tabs and the Now Playing
action row are set in `px`, not rem; they are captions to a glyph, and at 130%
on 375px they overprint each other. At ≤ 380px wide they take
`letter-spacing: .04em`.

### 1.5 Space, radius, size

```
--sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px;
--sp-6: 24px; --sp-8: 32px; --sp-10: 40px; --sp-12: 48px;
--margin: 20px;            /* outer page margin, every screen */
--gutter: 12px;
--measure: 34em;
--r-rule: 2px;             /* bars, progress, segment ends */
--r-plate: 4px;            /* artwork, buttons, fields, chips that are not pills */
--r-sheet: 12px;           /* sheet top corners, action sheets */
--r-pill: 999px;           /* chips, slugs, the search field */
--tap: 44px;
--row-ep: 64px; --row-queue: 60px; --row-show: 56px; --row-foray: 80px;
--plate-xs: 40px; --plate-sm: 48px; --plate-md: 56px; --plate-lg: 64px; --plate-grid: 72px;
--ticker-h: 56px; --folio-h: 56px; --folio-gap: 8px; --folio-lift: 12px;
--safe-b: env(safe-area-inset-bottom, 0px); --safe-t: env(safe-area-inset-top, 0px);
```

### 1.6 Motion

```
--t-micro: 120ms; --t-state: 200ms; --t-page: 320ms; --t-sheet: 420ms; --t-fade-rm: 150ms;
--ease-out: cubic-bezier(.2,.7,.2,1);
--ease-in-out: cubic-bezier(.45,0,.2,1);
--ease-in: cubic-bezier(.5,0,.8,.2);
/* spring, stiffness 230 / damping 28 / mass 1, no visible overshoot, 420ms:
   50% at 105ms, 90% at 230ms, 99% at 365ms (r4: the 260/28 curve was at
   0.99 by 146ms and the sheet landed ~100ms before the plate and the rule) */
--spring-sheet: linear(0, 0.04 5%, 0.14 10%, 0.26 15%, 0.38 20%, 0.5 25%,
  0.6 30%, 0.69 35%, 0.76 40%, 0.82 45%, 0.86 50%, 0.9 55%, 0.93 60%,
  0.95 65%, 0.964 70%, 0.975 75%, 0.983 80%, 0.989 85%, 0.993 90%,
  0.996 95%, 1);
/* spring, stiffness 400 / damping 34, no visible overshoot, 240ms: chips, toggles, folio */
--spring-snap: linear(0, 0.06 4%, 0.3 12%, 0.62 22%, 0.84 32%, 0.95 44%, 0.99 58%, 1);
```

Regenerate either curve from the stated spring parameters if a tool is to
hand; keep overshoot ≤ 2%. Only `transform`, `opacity`, `font-variation-settings`
and registered colour properties animate, and colour only on controls no
larger than a chip (never a sheet or page background, see §6.1). The single
reduced-motion block:

```
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: var(--t-fade-rm) !important;
    animation-iteration-count: 1 !important;
    transition-duration: var(--t-fade-rm) !important;
    transition-property: opacity, color, background-color !important;
    scroll-behavior: auto !important;
  }
  ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) {
    animation: none !important;
  }
}
```

### 1.7 Chrome material

```
.chrome { background: var(--chrome-bg); -webkit-backdrop-filter: blur(20px) saturate(1.2);
          backdrop-filter: blur(20px) saturate(1.2); border-top: 1px solid var(--rule); }
@media (prefers-reduced-transparency: reduce) { .chrome { background: var(--page); backdrop-filter: none; } }
@supports not (backdrop-filter: blur(1px)) { .chrome { background: var(--page); } }
```

Only `.folio`, `.ticker`, `.find` (search field) and `.sheet-header` use
`.chrome`. Nothing else blurs.

`prefers-contrast: more`: `--rule` becomes `--rule-strong`, `--ink-3` becomes
`--ink-2`, plates get a 1px `--ink` edge, and the chrome background goes solid.

## 2. Layout grid

- Column: `padding-inline: var(--margin)`; four columns at `(100vw − 40 − 36) / 4`.
- Two-column sections (`.cols-2`): `grid-template-columns: 1fr 1fr; gap: var(--gutter)`.
- Vertical rhythm: section head `margin-top: 32px`, rule, 16px, content; between
  items in a list, 0 (rows carry their own 1px bottom rule); between distinct
  blocks, 24px.
- Scroll container: the page scrolls; bottom padding
  `calc(var(--folio-h) + var(--folio-lift) + var(--safe-b) + 16px)`, plus
  `var(--ticker-h) + var(--folio-gap)` while the ticker is shown
  (`body[data-ticker="1"]`).
- Viewports to verify: 393×852, 375×667, 412×915, each at 100% and 130% text.

## 3. Information architecture and routes

| Route | Screen | Tab |
|---|---|---|
| `#/` | Today | Today |
| `#/browse`, `#/browse?q=` | Browse / results | Browse |
| `#/library`, `#/library/up-next` | Library (Up Next is an in-page section with its own anchor) | Library |
| `#/foray/<id>` | Foray detail | keeps the originating tab |
| `#/episode/<id>`, `#/show/<id>`, `#/subject/<id>`, `#/playlist/<id>` | details | keeps the originating tab |
| `#/colophon` | Colophon sheet (scheme, large print, interests, about) | none (sheet) |
| `#/first` | Onboarding first screen (veil over Today) | none |
| Now Playing | sheet, not a route; `?np=1` opens it for the harness | none |

Removed: drawer, Create tab, the tagline header, the refresh glyph (pull to
refresh via the `.pull` indicator: a 2px red rule that grows from the masthead
rule, 44px pull threshold). Android system back closes a sheet first, then pops.

## 4. Component inventory

Each component: one class, one DOM shape, states listed. All text through
`esc()`, all URLs through `safeUrl()`.

### 4.1 `.masthead`
Row, height 56px, `align-items: baseline`. Left: `<a class="t-masthead">4a</a>`
(44×44 hit area, opens `#/colophon`). Right: `.btn-text` `Play the edition`
(`play` glyph 20px + label), hidden on first run with no playable item.
Below: `.dateline` (`.t-label`, `--ink-2`, 16px top margin) then a 1px
`--ink` rule (not `--rule`: the masthead rule is the one strong rule on the
page), 12px below the dateline. Dateline composition:
two explicit `display: block` lines, never `text-wrap: balance` (r1: a line
began with `·`): `{WEEKDAY} {D} {MONTH} · YOUR EDITION` then `{n} PICKS · {s}
STRETCH · {duration}`; first run: `FIRST EDITION · {D} {MONTH}` then `{n} PICKS
· {s} STRETCH`; offline: a line **above** both, `OFFLINE · DOWNLOADED ONLY`,
with a 14px `wifi-slash` glyph before it, still `--ink-2` (a state, not 4a's
authorship, so not red). Zero stretch is never shown (floor guarantees ≥1).

### 4.2 `.section-head`
`.t-label` in `--ink-2`, with an optional count at the right in `.t-meta`
(`Up Next · 5`); 1px `--rule` under it; 32px above, 16px below. No chevrons;
the head is not a link. A section with more than its inline list gets a
`.btn-text` `All forays` at the foot.

### 4.3 `.plate`
Artwork container: `border-radius: var(--r-plate); overflow: hidden;
background: var(--stock-2); box-shadow: inset 0 0 0 1px var(--plate-edge)`.
`img` `object-fit: cover`, `loading="lazy"`, `decoding="async"`, `alt=""` when the
title sits beside it. Sizes: xs 40, sm 48, md 56, lg 64, grid 72, lead 4:3
full column, np `min(100vw − 40px, 38vh)` square. Loading: stock-2 only.
Missing art: stock-2 with the show's initial in `.t-d2` `--ink-3`.

`.plate--contact` (foray or playlist): 2×2 grid of the first four distinct
show artworks, 1px `--page` gutters, same outer radius. Fewer than four: 1 →
single; 2 → side by side; 3 → one tall left, two stacked right. A cell whose
show has no artwork is filled with that show's segment ink at 16% over
`--stock-2` and carries the show's initial in `.t-d2` set in the same ink
(single plates: the same, in `--ink-3`). Blank stock never ships.

**Cells are never cropped** (r2 critique: at 4:3 the 2×2 beheaded every
typographic cover, `Bootstrapped` and `The Science of Startups` both cut).
Square plates (Now Playing, rows, grids) keep the 2×2. The **4:3 plates** (the
Today lead, Foray detail, onboarding) use the **lead-and-column** composition,
`.plate--contact.is-lead`: the first content segment's show fills a square on
the left at the plate's full height; the next three shows stack in a column at
the right, each a square one third of the height, 1px `--page` gutters
throughout (`display: grid; grid-template-columns: 3fr 1fr;
grid-template-rows: repeat(3, 1fr)`; the lead spans three rows). At 393 the
lead is 265px and the column cells 87px; at 375, 251 and 83. Three shows: lead
plus two half-height cells; two: lead plus one; one: single. In Now Playing
the current segment's cell carries no outline (the key line names it).

Fallback initials scale with the cell: `font-size: clamp(14px, 28cqh, 64px)`
on a `container-type: size` cell (a 40px cell reads 14px, a 64px-row cell
18px, the 265px lead 64px, a 170px splatter plate 48px). The initial never
sits under 14px and never exceeds 64px.

### 4.4 `.note` (editor's note)
```
<p class="note"><span class="t-note">…</span></p>
.note { position: relative; padding-left: 14px; margin-top: 8px; }
.note::before { content: ""; position: absolute; left: 0; top: 3px; bottom: 3px; width: 2px; background: var(--red); border-radius: 1px; }
```
Max 18 words by the copy rule; clamps to 3 lines in rows (`-webkit-line-clamp`),
unclamped on the lead and on detail pages. A Stretch note begins with its
bridge; see `.slug`.

### 4.5 `.slug`
`.t-label` in `--red`, with a 1px `--red` rule beneath that spans only the
text width (`display: inline-block; border-bottom`), 8px above the title it
labels. Values: `STRETCH`, `PLAYING`, `RESUME`, `DOWNLOADED`, `NARRATED BY 4A`.
`PLAYING` and `RESUME` prefix a 16px glyph (`stitch`, `ribbon`).

### 4.6 `.kicker`
`.t-label` in `--ink-2`, 8px above a headline. `TODAY'S FORAY`,
`TODAY'S EPISODE`, `A FORAY · 43 MIN · 4 SHOWS`, `A PLAYLIST · 4 EPISODES`.

### 4.7 `.strip` (the stitched rule)
```
<div class="strip" role="img" aria-label="7 segments from 4 shows, 43 minutes">
  <i class="seg" data-show="2" style-free; width set via --w> … </i>
</div>
```
Widths come from a `--w: <percent>` custom property set by JS on each `.seg`
(custom properties set via `el.style.setProperty` are not `style=` attributes
in markup and are allowed; if the CSP review disagrees, use 100 width-step
utility classes `.w-1 … .w-100`). Heights: 4px in rows, 6px on cards, 12px on
Foray detail, 6px in Now Playing (12px while dragging). Gaps between segments
2px (`--page`). Ends `--r-rule`. Narration segments use `--seg-narration` and
`min-width: 6px`. Minimum visible segment width 3px. Colours by
`data-show="0..7"` → `--seg-c*`. Progress: `.strip[data-progress]` draws a
`--ink` overlay at 55% opacity across played segments and a 2px `--red` cursor
(`.strip-cursor`) 14px tall, centred on the current position.

`.strip-key`: a wrapped row of `.key` items (`8×8` swatch with `--r-rule`, 6px
gap, show name in `.t-meta` `--ink-2`), 8px under the strip; narration key reads
`4a` with the hatched swatch. In rows the key is omitted. On Today's lead the
key is capped at two lines (`max-height: calc(2 * var(--lh-meta) + 4px);
overflow: hidden`) and ends with a `.t-meta` `+3 shows` link to the detail;
the Foray detail shows the full key.

### 4.8 `.contents` (foray table of contents)
`<ol class="contents">` rows, 44px min height, 1px `--rule` between:
`.c-num` (`.t-num` at 20px size variant `.t-num--sm`, 28px wide, `--ink-3`,
narration shows the `stitch` glyph in `--red` instead), `.c-title` (`.t-text`
one line, `text-overflow: ellipsis`), `.c-lead` (flex 1, `border-bottom: 1px
dotted var(--rule-strong)`, 6px margin each side, aligned to the title
baseline via `margin-bottom: 6px`), `.c-time` (`.t-meta`, width 56px, right
aligned, `tabular-nums`, shows start time; the segment duration is the row's
`aria-description`). Show name on a second line in `.t-meta` `--ink-2` with an
8×8 swatch. Current segment: `PLAYING` slug replaces the numeral. Tap seeks
(44px row). Chapters use the same component without swatches. **Numbering
counts content segments only**, 1–n; narration rows carry the stitch glyph
and no number, and the same count is used everywhere (`11 segments`,
`9 of 11`, the contents numerals).

### 4.9 Glyphs (sprite `icons/edition.svg`, `<svg><use href="#…"/></svg>`)
Phosphor Regular: `newspaper`, `magnifying-glass`, `bookmarks-simple` (+ `-fill`
for active), `play`, `pause`, `plus`, `check`, `bookmark-simple`, `bookmark-simple-fill`,
`dots-three`, `x`, `caret-left`, `caret-down`, `arrow-up`, `arrow-down`,
`moon` (sleep), `gauge` (speed), `share-network`, `cloud-slash`, `download-simple`,
`list-plus` (add to Up Next), `queue`, `clock-counter-clockwise` (history),
`info`, `wifi-slash`.
Custom, 24px viewBox, 1.5px stroke, round caps:
- `skip-15` / `skip-30`: a 270° arc (r=8, centre 12,13) opening at the top with
  a 4px arrowhead at the arc's end (left-pointing for 15, right for 30), the
  numeral `15`/`30` set in DM Sans 600 at 8px, centred, as `<text>` converted
  to paths.
- `stitch`: three 7px horizontal rules at y=7, 12, 17, x from 4 to 11, 13 to 20,
  4 to 11, joined by a single red (`currentColor` on a `--red` parent) zigzag
  path 1px wide. The foray mark.
- `explicit`: 14×14 rect with 1px stroke, radius 2, letter E as paths.
- `ribbon`: a 10×16 bookmark ribbon outline with a notched bottom.

Sizes: 24 default, 20 in buttons with labels, 16 in slugs. Tabs: 24 icon over
`.t-label` at 11px (`--fs-label-sm: 0.6875rem`), 2px gap.

### 4.10 Buttons
- `.btn-play` circle, `--ink` fill, `--on-ink` glyph (`play` 28px, 2px optical
  shift right; `pause` 28px). Sizes: 56 (lead, detail), 80 (Now Playing), 96
  (large print). Pressed: `transform: scale(.96)` over `--t-micro`.
- `.btn-skip` circle 56 (64 large print), transparent, 1px `--rule-strong`
  border, glyph `skip-15`/`skip-30` 28px `--ink`.
- `.btn-icon` 44×44, transparent, glyph 24 `--ink-2`; active (`aria-pressed`)
  glyph `--ink`, fill variant where one exists.
- `.btn-text` `.t-button` `--ink`, 44px tall, 12px inline padding, optional 20px glyph.
- `.btn-primary` full width, 52px, `--ink` fill, `--on-ink` `.t-button`, `--r-plate`.
- `.btn-secondary` same box, transparent, 1px `--rule-strong` border.
- `.btn-labelled` (Now Playing action row): 44px tall, 20px glyph above an
  11px `.t-label`, `--ink-2`; active `--ink`.
Focus: `outline: 2px solid var(--red); outline-offset: 2px` on `:focus-visible`.

### 4.11 `.chip`
Pill, 36px tall (44px hit area via padding on the wrapper), `.t-meta` in `--ink`,
1px `--rule` border (not `--rule-strong`, which is now 3:1 and too heavy for
a filled chip), `--stock-2` fill. Selected: `--ink` fill, `--on-ink`.
One chip component everywhere (commission examples, filters).

### 4.12 Rows
All rows: `display: grid; grid-template-columns: auto 1fr auto; column-gap: 12px;
align-items: center; min-height: var(--row-*); border-bottom: 1px solid var(--rule)`;
the last row in a section has no rule. The whole row is a link (`<a>` wrapping)
except the trailing action, which is a sibling button positioned in the third
column (no stretched-link trick: two real elements).
- `.row-ep` 64: plate-lg, `.t-title` (2 lines) + `.t-meta` (`show · 48 min`),
  trailing `.btn-icon` `list-plus` (or `list-checks` when queued; never a
  bare `check`, which reads as "played" in Saved and History, r3 critique).
- `.row-queue` 60: `.t-num--sm` (28px wide), plate-sm, `.t-title` at 16px
  (`.t-title--sm`, one line) + `.t-meta` (`show · 32 min left`), trailing
  `.btn-icon` `dots-three` opening an action sheet: Play next, Move up, Move
  down, Remove. Current row (r1 critique: the slug in the numeral column broke
  the plate alignment): the numeral column stays 28px and holds a 16px `--red`
  glyph (`stitch` for a foray, `speaker-simple-high` for an episode); the
  `PLAYING` slug sits in the text column 8px above the title; `min-height:
  72px`; a 2px `--red` rule along the row's left edge (`box-shadow: inset 2px
  0 0 var(--red)`); title weight 600. Removed row → `.toast` `Removed · Undo` (5s).
- `.row-show` 56: plate-md, `.t-title` one line, `.t-meta` (`12 episodes · Energy`).
- `.row-foray` 80: plate-contact 64, `.t-title` (2 lines), `.strip` 4px (no key),
  `.t-meta` (`43 min · 4 shows`), optional progress on the strip.
- `.row-numbered` (Today, Also today): `.t-num` (36px wide, `--ink-3`), plate-lg,
  `.t-title`, `.note` (clamp 3), `.t-meta`. Min height 96; rule below. The
  duration in the meta is wrapped `white-space: nowrap`; the show name
  ellipsizes first. `.is-stretch`: one 2px `--red` rule at `left: -14px` of
  the text column runs from the top of the `STRETCH` slug to the bottom of
  the note (it replaces the note's own rule); the card is the only one with a
  red spine, which is how the slug is the loudest line without being larger.
- `.row-subject` (index): `.t-title` + `.t-meta` count at right, 48px, in `.cols-2`.

### 4.13 `.ticker` (mini player)
Fixed, `bottom: calc(var(--folio-h) + var(--folio-lift) + var(--safe-b) + var(--folio-gap))`,
`left/right: var(--margin)` (it is inset like the folio, not full bleed), height
56, `--r-plate`, `.chrome`, 1px `--rule` border all round, `--shadow-sheet`
lite (first layer only). Grid `40px 1fr 44px 44px`, gap 12, padding-inline 8.
Top edge: `.ticker-progress`, 2px `--red` rule from the left, width = progress,
`aria-hidden`. Title `.t-ticker` (Fraunces 15/20, 500, one line, ellipsis, no
marquee), show `.t-label` at 11px `--ink-2`. Buttons: `play/pause` 44 (glyph
24, `--ink`), `skip-30` 44. Body `<button>` with `aria-label="Now playing: {title}, {show}. Open player"`.
Gestures: tap body or drag up ≥ 24px opens Now Playing; drag down ≥ 48px
with velocity shows `Stopped · Undo` and stops (never on a vertical scroll of
the page: the ticker's own `touch-action: none`).

### 4.14 `.folio` (tab bar)
Fixed, `bottom: calc(var(--folio-lift) + var(--safe-b))`, inset `var(--margin)`,
height 56, `--r-plate`, `.chrome`, 1px `--rule`. Three equal cells, each a
44px+ target: glyph 24 + label 11px. Active: fill glyph, `--ink`, label 600;
inactive `--ink-2`. On scroll down > 24px the bar collapses to 44px and hides
labels (`--t-state`, `--ease-out`); scroll up or scroll end restores. Hidden
while the keyboard is open (`visualViewport` height drop > 120px) and under
Now Playing.

### 4.15 `.find` (search field)
Fixed above the ticker/folio stack, inset `var(--margin)`, 48px, `--r-pill`,
`.chrome`, 1px `--rule-strong`, glyph `magnifying-glass` 20 at left, `.t-text`
input (`--f-ui` 16px so iOS does not zoom), clear `x` 44 at right while typing.
Focus: border `--ink`. Placeholder `Find a show, episode or subject`.

### 4.16 `.sheet`
`position: fixed; inset: 0`, `.sheet-panel` from the bottom, `--page`, top
radius `--r-sheet`, `--shadow-sheet`, grabber 36×4 `--rule-strong` at 8px, a
`.sheet-header` (56px, `.chrome` once content scrolls under it). The page
behind: `transform: scale(.96); filter: none; opacity: .82` under `--scrim`.
Focus moves to the panel's first heading on open and returns to the opener on
close; `Escape` and Android back close; `inert` on the page behind. Detents:
Now Playing = full; action sheets = content height; Colophon = 80%.

### 4.17 `.toast`
Above the ticker, inset `var(--margin)`, 48px, `--ink` fill, `--on-ink` `.t-meta`
text at left, `.btn-text` in `--on-ink` at right (`Undo`). 5s, `role="status"`.

### 4.18 `.empty`
`.t-d2` sentence in `--ink`, max 2 lines, then a `.btn-text` next step. No
illustration, no grey block. Examples (all within copy rules):
- Library/Saved: "Nothing saved yet. Save an episode from any edition and it lands here." → `Open today's edition`
- Up Next: "The queue is empty. 4a keeps playing after an item ends anyway." → `Browse`
- Forays: "No forays yet. The next edition brings one." → `Open today's edition`
- Browse, no results: "Nothing titled '{q}'. Subjects that touch it:" then subject rows (never shown alongside a visible match).

### 4.19 `.skeleton`
Rules, not blocks: `.sk-line` is a 2px `--rule` rule with widths 92/70/84/40%
at the line-height of the text it stands for, 6px apart; a plate skeleton is
`--stock-2`. Pulse opacity .6→1 over 1.2s (fade under reduced motion).

### 4.20 `.notice`
Ruled box for warnings (unavailable foray, offline): 1px `--ink` rule above and
below, 16px padding, `.t-text` with a 20px `info`/`wifi-slash` glyph inline,
then a `.btn-text` next step. No colour fill.

## 5. Screens

Spacing values are top-to-bottom; "rule" means a 1px `--rule` unless noted.

### 5.1 Today (`#/`)
1. Safe-area top + 8px. `.masthead` 56px. `.dateline` (16px above). Masthead
   rule 12px below. 24px.
2. **Resume** (state mid-listen only): `.slug` `RESUME` with `ribbon`, then a
   `.row-ep` variant with a 4px progress rule (`--ink` on `--rule`) under the
   title, meta `18 min left`. Tap resumes. Rule, 24px. Hidden while the ticker
   is showing the same item (`body[data-ticker="1"]`): Resume is for a cold
   start or after Stop, never a duplicate of the ticker.
3. **Lead**: `.kicker`, 8px, `.t-d1` headline (clamp 3), 16px, `.plate` lead
   (4:3; `.plate--contact.is-lead`, the lead-and-column composition of §4.3,
   for a foray), 8px, `.strip` 6px + `.strip-key` (foray only),
   12px, `.note`, 12px, meta row: `.t-meta` (`43 min · 4 shows · 7 segments`
   or `48 min · Show name`) left, `.btn-play` 56 right. Tapping anything but
   the play circle opens the detail. 32px.
4. **Also today**: `.section-head` `ALSO TODAY`, 2–4 `.row-numbered` (the
   numeral continues from the lead, which is 1). One row carries `.slug`
   `STRETCH` above its title and its note begins with the bridge. 32px.
5. **More forays**: `.section-head`, up to 3 `.row-foray`, `All forays` foot. 32px.
6. **Your subjects** (playlists for you): `.section-head` `YOUR SUBJECTS`, up to
   4 `.row-foray`-shaped rows with contact plates and `4 episodes · 2 of 4
   played` meta (progress as `.t-meta` text plus the 4px rule). 32px.
7. Footer: `.t-meta` `--ink-3` `Assembled 6:12 this morning` · `.btn-text`
   `Why these?` → sheet explaining the edition and the floor in three sentences.
   Bottom padding per §2.

States: first run (dateline `FIRST EDITION`, no Resume, lead note "A first
edition, picked widely. Play one and tomorrow's narrows.", no Your subjects);
returning; mid-listen (Resume present, and the lead is never the resumed item);
stress (long titles clamp, numerals stay in their 36px column, `.t-d1` drops
to 26px via `@container` when the headline exceeds 3 lines at 30px);
offline (dateline prefix; rows whose items are not downloaded render
`--ink-3` text with a `cloud-slash` 16px glyph before the meta; play on them is
disabled with `aria-disabled` and a `.notice` at the top of Also today:
"Offline. Downloaded items play; the rest wait for a connection."); loading
(masthead and dateline real, everything else `.skeleton`).

### 5.2 Now Playing (sheet)
Panel `display: grid; grid-template-rows: auto auto 1fr auto auto auto; height: 100%`,
`padding-inline: var(--margin)`, tinted background (§1.3).
1. Grabber 8px from top. Header row 44px: `.t-label` `NOW PLAYING` left
   (`A FORAY` for forays), right a `.btn-text` `Up next: {short title}` (one
   line, ellipsis, `caret-down`) opening the peek (§5.2b); `x` is not shown:
   drag or back closes.
2. Plate region: `1fr`, `min-height: 0`, plate horizontally centred and
   **aligned to the region's end** (`align-items: end; padding-bottom: 8px`)
   so slack sits under the header and the plate stays tight to the scrubber
   it belongs to; size `min(100vw − 40px, 38vh)`; 375×667 → 253px; 393×852 → 324px.
   The scrubber block has **no margin of its own** (`.np-scrub { margin-top: 0 }`):
   the rule is centred in its 44px hit area, so the visual gap from plate to
   rule is 8 + 19 = 27px. Round 2 measured 62px (24 + 16 + 19), which read as
   the plate belonging to the header rather than to the rule.
3. Scrubber block (0px above, see 2): `.strip` 6px (forays) or `.scrub-track` 6px
   `--rule-strong` with a `--ink` fill (episodes); 44px hit area via a
   transparent `::before`; `input type=range` underneath for accessibility
   (`aria-valuetext` "18 minutes 40 seconds of 43 minutes"). While dragging:
   track 12px, `.time-bubble` (`.t-d2` tabular, `--ink` on `--page` with
   `--shadow-sheet`) 16px above the thumb. Clocks row 8px below: `.t-meta`
   elapsed left, remaining right (`−24:20`). Foray key line 4px below the
   clocks: `.t-meta` `--ink-2` `3 of 7 · Hard Fork · 6 min left`, narration
   reads `4a · narration · 40 s left` with the `stitch` glyph in `--red`.
4. Titles (16px above): `.t-d2` title (clamp 2; 3 at 412×915), 4px, then for an
   episode the `.t-label` show in `--ink-2` (an `<a>` to the show); for a foray
   the **current segment's title** in `.t-text` `--ink-2`, one line, ellipsis
   (the show is already on the key line; do not print it twice), 8px, `.note`
   **clamped to two lines** (`-webkit-line-clamp: 2`), which holds any 18-word
   note at 393 and 412; tap expands in place (`--t-state`). The one-line clamp
   is for `(max-height: 700px)` only. At `(max-height: 700px)` with text ≥ 120%
   the `.note` is omitted from this posture (it stays in the detail posture)
   and the key line clamps to one line, ellipsis on the show name, so the plate
   keeps ≥ 160px. Round 2 clamped the note to one line at every height, so the
   second-loudest element on the sheet ended in an ellipsis on an 852px screen
   that had 110px of slack.
5. Transport (24px above, 24px below): row centred, gap 24: `.btn-skip` 56
   `skip-15`, `.btn-play` 80, `.btn-skip` 56 `skip-30`. Large print: 64/96/64.
6. Action row (0 above, `16px + var(--safe-b)` below): five `.btn-labelled`
   equally spaced: `1×` (`gauge`; sheet with 0.8–2.5 presets, 1× stays for
   narration), `Sleep` (`moon`), `Bookmark` (`bookmark-simple`, fill when set),
   `Up Next · 5` (`queue`), `More` (`dots-three`: Share, Show notes, Go to
   episode, Download/Remove download, Stop).

The whole panel is a scroll container; content below the action row is the
**detail posture**, reached by scrolling: 32px, `.section-head` `CONTENTS`
(forays) / `CHAPTERS` (episodes with chapters; otherwise omitted) +
`.contents`; `.section-head` `WHERE THIS CAME FROM` (forays): per show a
`.row-show` with the episode title in meta and a trailing `.btn-text` `Open`;
`.section-head` `NOTES`: show notes in `.t-text`, links underlined `--ink`,
measure `--measure`; `.section-head` `UP NEXT`: the first 3 `.row-queue` and
`All of Up Next`. The scrubber block gets `position: sticky; top: 0` with
`.chrome` once the panel scrolls, so transport leaves but the scrubber stays.

At 375×667 the grid rows above the detail posture sum to ≤ 667 − safe areas:
8 + 44 + 253 + 16 + 6 + 8 + 18 + 16 + 56 + 4 + 16 + 8 + 24 + 24 + 80 + 24 + 44 + 16 = 665.
If the title wraps to 2 lines (the clamp maximum) the plate region shrinks
first (`1fr` with `min-height: 0`; plate `max-height: 100%`), never the
transport. Verify at 130% text: the title clamps to 2 lines and the plate
yields.

States: episode; foray (strip scrubber, key line, contents, credits); paused
(`play` glyph; nothing else changes; the cursor stays); buffering
(`.strip-cursor`/thumb pulses opacity .4→1 at 1s; clocks unchanged; `role=status`
"Buffering" announced once); offline/downloaded (`DOWNLOADED` slug at the right
of the clocks row); end of item (over `--t-page`: plate cross-fades, title
cross-fades, the `Up next:` header line becomes the new `NOW PLAYING` and the
following item fills `Up next:`; a medium haptic); long title at 375×667 (above);
maximum text size (title 2 lines at 1.3×, plate ≥ 160px, transport unchanged).

**5.2b Up Next peek**: an action-sheet-height panel over Now Playing listing
the next 5 `.row-queue` with a `.note` under the first automatically appended
item: "Added by 4a under the stretch rule: {bridge}" (bridge ≤ 18 words
total); `All of Up Next` opens Library at `#/library/up-next`.

### 5.3 Ticker (mini player)
§4.13. Appears with `translateY(8px)→0` + fade over `--t-state` when playback
starts. Removed on Stop (after the undo window).

### 5.4 Browse (`#/browse`)
1. Safe-area + 8. `.t-d1` `Browse` as page title, 44px row with nothing else.
   Masthead rule. 24px.
2. **Commission**: `.section-head` `COMMISSION` with meta `A playlist, on any
   subject`; an inset field (`.find` styling but static, 48px, `--stock-2`,
   placeholder `Name a subject…`) that on focus becomes the real bottom `.find`
   with `data-mode="commission"`; 12px; three `.chip`s from `discover.json`
   example subjects. 32px. **No deferral line.** r2 and r3 carried `Forays by
   commission come later.` under the chips; built, it is the first sentence a
   judge reads on Browse and it reads as an apology for an unbuilt feature.
   Commission is today's Create: submitting the field, or tapping a chip,
   opens the results page for that subject with the `PLAYLISTS` group first
   (`{subject}, set in order`, the real catalog playlist) and `SHOWS`,
   `EPISODES` after. Nothing on the screen says what is coming later.
3. **Off your beaten path**: `.section-head` + `.cols-2` of six items: plates
   in two sizes (column width and 60% width, alternating so the grid reads as a
   splatter: pattern L S / S L / L S), each with `.t-title` (2 lines) and a
   `.t-text-sm` hook (≤16 words) under the plate, 8px gaps; chosen so no two
   adjacent items share a subject branch and ≥ 2 are outside the listener's
   usual subjects. 32px. **Hooks are authored, never derived.** A hook is a
   `hook` field on the item, written to the copy rule (≤ 16 words, a complete
   sentence, no banned words, no withholding). The r2 clause-cutter produced
   "Guitarist and producer Nate Mercereau on the gear, philosophy." — a
   grammatical fragment is still a fragment. In the prototype the six splatter
   items carry hand-written hooks in `data.json`; in Phase 3 the classify
   pipeline writes them (it already writes why-lines to the same rule). With
   no `hook` field the item is not eligible for the splatter. **Length is
   measured in characters, not words** (r3: two 16-word hooks of 85 and 93
   characters ran to four lines in the 170px column and were clamped with an
   ellipsis): a splatter hook is **≤ 72 characters** including the full stop,
   which is three lines of Newsreader 14/20 in the narrow column. The
   three-line clamp stays as the guard; `fitHooks` marks an overflowing item
   `data-hook-overflow` and logs `console.error`, so a render with one is a
   failed check, not a warning.
4. **Subjects**: `.section-head` + `.cols-2` of `.row-subject` (name,
   count). 32px.
5. **Followed**: `.section-head` + 4-column grid of `.plate` grid (72px),
   8px gap, `aria-label` the show name; `All followed` foot. Bottom padding +
   `.find` height (48 + 8).

The Commission field is a ruled box, not a pill (r1 critique: two identical
pills read as two search boxes): `border-radius: var(--r-plate)`, 1px
`--rule-strong`, `--stock-2`, glyph `pencil-simple-line` 20px. The pill shape
belongs to `.find` alone. `.find` floats at the bottom of this tab only. Typing (`q.length ≥ 1`, 200ms
debounce) replaces 2–5 with results: `.section-head` `SHOWS` + `.row-show`
(meta `38 episodes · Energy`), `EPISODES` + `.row-ep`, `PLAYLISTS` + `.row-foray`
shape with contact plates. Each group shows 5 and `More shows (12)`. Empty
groups are omitted, never labelled "none". No results at all: `.empty` with
the subject rows that fuzzy-match (§4.18); if nothing matches: "Nothing titled
'{q}'." + `.btn-text` `Browse subjects`. Keyboard open: `.folio` hides, `.find`
sits at `visualViewport` bottom, results keep 16px bottom padding.

### 5.5 Library (`#/library`)
1. Page title `Library`, masthead rule, 24px.
2. **Forays**: `.section-head` with count; `.row-foray` × up to 5 (progress on
   the strip; finished rows get `check` 16 before the meta); `All forays`.
3. **Up Next** (`id="up-next"`): `.section-head` `UP NEXT · 5` with a trailing
   `.btn-text` `Clear` (opens an action sheet: `Clear 5 items` / `Cancel`);
   `.row-queue` × all (the queue is bounded, no infinite scroll); played row
   jumps to the top (founder ruling kept), animated as an insert-with-gap
   (§6.3). Empty: `.empty`.
4. **Followed**: 4-column plate grid, 72px, show name below in `.t-meta` one
   line (optional; hidden under 375 wide).
5. **Saved**: `.row-ep` × 5, `All saved`.
6. **Playlists**: `.row-foray` shape with contact plates.
7. **History**: `.row-ep` × 5 with `Played Tuesday` meta, `All history`.

States: empty (every section an `.empty`, but the page keeps its heads so the
structure is visible); returning; many items (counts in heads, `All …` feet,
no section longer than 5 inline except Up Next).

### 5.6 Foray detail (`#/foray/<id>`)
1. Safe-area + 8. Nav row 44: `.btn-icon` `caret-left` (label `Back`) left,
   `.btn-icon` `share-network` and `dots-three` right. No title in the nav row.
2. 8px. `.kicker` `A FORAY · 43 MIN · 4 SHOWS`. 8px. `.t-d1` headline. 16px.
3. `.plate--contact.is-lead` (lead-and-column, §4.3) full width 4:3. 12px.
   `.strip` 12px tall + `.strip-key`.
4. 16px. `.note` (why this foray, ≤ 18 words). 16px.
5. Action row: `.btn-play` 56 at left with `.t-button` `Play` beside it (or
   `Resume at 18:40`, `Play again`), `.btn-icon` `list-plus`, `download-simple`
   at right. 32px.
6. `.section-head` `CONTENTS` + `.contents` (every segment; narration rows
   show the `stitch` glyph and `4a` as the show). 32px.
7. `.section-head` `WHERE THIS CAME FROM` + one `.row-show` per show (episode
   title as meta; the whole row is the link, no trailing `Open` button, which
   truncated every title in r1). 32px.
8. `.section-head` `ABOUT` + `.t-text` paragraph (the explanatory paragraph the
   critique said to keep), then `.t-meta` `--ink-3` `Assembled {date}`.

States: unplayed; in progress (progress overlay on the strip, `PLAYING` slug on
the current contents row if it is the current item, action reads `Resume at
18:40`); finished (`Played Tuesday` meta under the kicker, action `Play again`);
un-narrated (kicker gains `· NO NARRATION`, `.note` "No narration yet. Segments
play back to back.", no narration rows in contents); unavailable (plate and
strip rendered at 50% opacity, action row replaced by `.notice`: "This foray
can't play right now: one show moved its audio. 4a re-checks tonight." with
`Browse similar` → `#/browse?q={subject}`).

### 5.7 Onboarding first screen (`#/first`)
Today renders underneath, real data, with `inert`. Over it, `.veil`
(`--veil`, full screen, `backdrop-filter: none`). Content, `padding-inline:
var(--margin)`, vertically: safe-area + 48px, `.t-masthead` `4a` (not a
button), 8px, `.t-label` `FIRST EDITION · {date}`, masthead rule, 32px,
`.t-d1` "A daily listening edition, set from real podcasts, around you." (max
3 lines; at 130% it may take 4), 16px, `.note` "About a third is picked to
stretch you. 4a says why, every time.", then `1fr` of space that lets the real
lead plate show through the veil at ≥ 60% of its height (the veil is lighter
over the lead: a second `.veil-cut` element with `--veil` at 40% clipped to the
lead's bounding box, positioned by JS), then the action band `.first-actions`
on solid page (`background: var(--page); border-top: 1px solid var(--rule);
padding: 16px var(--margin) calc(16px + var(--safe-b))`, full bleed; the real
page's meta row and play circle must never show through the buttons; the band
carries a 48px fade above its rule, `.first-actions::before { position:
absolute; left: 0; right: 0; bottom: 100%; height: 48px; background:
linear-gradient(to bottom, transparent, var(--page)); pointer-events: none }`,
so the veiled page dissolves into the band instead of being cut mid-line, r3:
at 393×852 the rule cut the lead's editor's note through its second line):
`.btn-primary` `Open today's edition`, 8px, `.btn-secondary` `Not now`. "Not now" sets
`cp_first_seen` and removes the veil; Today then shows the `FIRST EDITION`
dateline until the first play. Both buttons go to Today; the only difference
is the dateline copy. No swipeable pages, no dots.

### 5.8 Colophon (`#/colophon`, sheet at 80%)
Sections with `.section-head`: `EDITION` (scheme: Paper / Night / Follow
system, as three `.chip`s; Large print toggle; text size note "Follows your
phone's text size"), `INTERESTS` (the top 8 subjects as `.row-subject` with a
`.t-meta` weight word `more / usual / less` and a `.btn-text` `Reset`; `All
interests` opens the full list, still rows, no sliders), `ABOUT` (`.t-text`:
what 4a is, in three sentences; version; `Open source licences`).

## 6. Motion specs

All transitions are interruptible: a new gesture cancels the running
animation and continues from the current transform (use the Web Animations
API with `commitStyles()` or View Transitions with `skipTransition()` on
interrupt).

### 6.1 Ticker → Now Playing (page turn)
- Trigger: tap on ticker body, or drag up ≥ 24px; opening via `?np=1` for the harness.
- Shared element: the plate (`view-transition-name: np-plate`) 40px → NP size;
  the title (`np-title`) 15px → 24px, `font-size` animated on the pseudo
  (`::view-transition-new(np-title)` only; old fades).
- The sheet panel: `transform: translateY(100%) → 0`, `--spring-sheet`, 420ms.
- **The plate, the rule and the sheet ride one curve** (r4): the flights use
  `--spring-sheet` too (Web Animations `easing` takes the same `linear()`
  string; read it from the stylesheet, never a second copy), so the three
  land in the same frame. The title fades in over the sheet's second half
  (opacity 0 until 40%, then to 1 at 420ms).
- The ticker progress rule → the scrubber: `view-transition-name: np-scrub`,
  width/height morph is done by the group animation; it travels for the full
  420ms, then thickens (`scaleY(3)`) and fades out over `--t-micro` into the
  real scrubber underneath.
- The page behind: `scale(1) → scale(.96)`, opacity 1 → .82, `--ease-out`, 320ms.
- Close: reverse with `--ease-in`, 280ms; drag down follows the finger 1:1 with
  the page behind interpolating scale by progress; release above 35% or
  velocity > 0.6px/ms closes, otherwise springs back (`--spring-sheet`).
- Fallback (no View Transitions): FLIP the plate with `transform` only
  (translate + scale), title cross-fades, same durations.
- **No selection during a drag.** The sheet's header row, grabber and plate
  region carry `user-select: none; -webkit-user-select: none;
  -webkit-touch-callout: none`, and the drag handler calls `preventDefault()`
  on `pointerdown` (r2's capture shows `Up next: Spolia` highlighted blue
  through the whole drag-to-dismiss). Titles and notes below stay selectable.
- **The tint is set, not transitioned.** `--tint-h` changes instantly when the
  item changes; a transition on it repaints the whole sheet every frame for
  320ms behind the plate cross-fade, which is the one place a mid-range
  Android drops frames. Registered colour properties animate on small
  controls only (chips, the switch, `.find`), never on a sheet background.
- Haptic: light impact on open completion.
- Reduced motion: panel fades in over 150ms; no shared elements.
- **The harness guard freezes the playhead, never the motion.** r3's
  `openNP` opened the sheet `instant` and skipped `flyPlate` whenever
  `navigator.webdriver` was true, so the recorded capture showed the page turn
  as a hard cut (r3 critique, must-fix 1) and no round could have judged it.
  Under the harness: `?np=…` route-opens stay instant (static renders must
  repeat), a tap on the ticker runs the full choreography, and `?motion=1`
  on any route runs every transition. The motion capture is recorded with
  `?motion=1`, by tapping, at 25fps.

### 6.2 Row → detail (push)
- Incoming page: `translateX(24px) → 0` over 320ms `--ease-out`; its opacity
  goes 0 → 1 **in the first 100ms only** (keyframe `{ opacity: 1; offset:
  .31 }`), so the incoming page is opaque and covering for the rest of the
  slide. Outgoing: `translateX(0) → −8px`, opacity 1 → .6. The incoming page
  is above the outgoing (View Transitions put `new` above `old`; the FLIP
  fallback sets `z-index` the same way). r3's capture had the incoming page
  translucent for the whole 320ms over an outgoing at .9, and the two
  Display-1 headlines read together as a double exposure.
- Back (pop): mirrored, the outgoing page opaque until its last 100ms.
- Shared element: the row's plate → the detail plate (`view-transition-name`
  set on tap to `detail-plate`, cleared after).
- Back: mirrored, 280ms; edge swipe (Web+ plugin, or a pointer-driven FLIP on
  the left 20px) tracks the finger.
- Reduced motion: cross-fade 150ms.

### 6.3 Add to Up Next / reorder (insert with gap)
- On `list-plus`: the row's plate clones (`position: fixed`), scales to 24px
  while translating to the Library tab glyph over 320ms `--ease-in`, then
  fades; the glyph bumps `scale(1.15)` for 120ms; the `Up Next · n` count in
  any visible `.section-head` rolls: old numeral `translateY(−100%)` out, new in
  from `+100%`, 120ms, clipped. Success haptic. `list-plus` → `list-checks` cross-fade 200ms.
- In the queue: inserted/moved rows animate height 0 → 60px and neighbours
  `translateY` over 200ms `--ease-out` (FLIP on the list). Removal reverses;
  `.toast` offers undo, which re-inserts with the same animation.
- Played row jumps to the top with the same FLIP.
- Reduced motion: no clone flight; count and rows fade.

### 6.4 Small states
- Buttons pressed: `scale(.96)`, `--t-micro`.
- Tab change: fill glyph cross-fades 200ms; content cross-fades 200ms, no slide.
- Folio collapse/expand: height and label opacity, 200ms `--ease-out`.
- Chips select: `--spring-snap`, 240ms, background and colour.
- Strip progress: cursor moves by `transform` on each `timeupdate` with a
  250ms `linear` transition so it glides between updates; segment boundary
  crossing: the new segment's bar brightens `filter: brightness(1.15)` for
  200ms and a selection haptic fires (also on scrub).
- End of item (§5.2 states): 320ms cross-fades, medium haptic.
- Pull to refresh: the masthead rule thickens 1 → 2px in `--red` and a
  `.t-meta` `Checking for a new edition…` appears; release spins nothing; on
  completion the dateline updates with a 200ms cross-fade.
- Skeleton pulse: opacity .6 ↔ 1, 1.2s, `ease-in-out`.

## 7. Haptics map (Web+, `@capacitor/haptics`)

| Moment | Call |
|---|---|
| Play / pause / bookmark | `impact({ style: 'LIGHT' })` |
| Scrubber crosses a segment or chapter; scrub release | `selectionChanged()` |
| Item ends, next begins | `impact({ style: 'MEDIUM' })` |
| Added to Up Next; download complete | `notification({ type: 'SUCCESS' })` |
| Now Playing opened | `impact({ style: 'LIGHT' })` |
| Remove / Stop (with undo shown) | none (no "punish" haptics) |
| Scroll, tab change, folio collapse | none |

Web fallback: no `navigator.vibrate`; silent.

## 8. Media session and OS surfaces (Web+)

`navigator.mediaSession.metadata`: title = item title; artist = show (forays:
`4a · {n} shows`); album = `4a · {edition date}`; artwork: the plate at 96,
128, 192, 256, 384, 512 (contact plates rendered to canvas once per foray).
Handlers: play, pause, seekbackward (15), seekforward (30), seekto,
previoustrack/nexttrack only when the route is a headset or car (existing
rule), stop. `setPositionState` on every `timeupdate` ≥ 1s apart. The lock
screen's `Up next` is the queue's next title in the `artist` line during the
last 30 s of an item (`{show} · next: {title}`), the OS's only slot for it.

## 9. Accessibility checklist (per screen, verify in the harness)

- Every control ≥ 44×44 (hit area may exceed the visual).
- Contrast: text ≥ 4.5:1 (`--ink-3` only at ≥ 12px meta), non-text UI ≥ 3:1
  (`--rule-strong`, segment inks, `--red`).
- Meaning never by colour alone: narration hatched; `PLAYING` is a slug plus
  rule; Stretch is a slug; progress has text (`2 of 4 played`, clocks).
- Sheets: `inert` behind, focus moved in and restored, Escape/back closes.
- `.strip` has `role="img"` + label; `.contents` rows are buttons with
  `aria-description` durations; the scrubber is a real `range` input.
- Text zoom to 130% verified on all six hero screens; no clipping; headlines
  clamp by lines.
- Reduced motion: the single block in §1.6; reduced transparency and
  increased contrast handled in §1.7.
- Screen-reader names: ticker (§4.13), plates with `alt=""` when titled
  beside, tabs with `aria-current="page"`, counts spoken (`Up Next, 5 items`).
- Live regions: `.toast` `role=status`; buffering announced once; end-of-item
  announces "Now playing {title}".

## 10. Data mapping (prototype and Phase 3)

- Today: `data/session.json` (picks, why-lines, stretch flag + bridge, the
  foray's segments with `show`, `start`, `end`, `narration` flags, and
  artwork URLs via `data/catalog-client.json`).
- Browse: `data/discover.json` (subjects, example commissions, the splatter
  pool), `catalog-client.json` for shows and episodes.
- Library: `cp_*` state through the storage shim (queue, saved, followed,
  history, resume positions, `cp_scheme`, `cp_large_print`, `cp_first_seen`).
- Dateline: the session's `assembledAt` (local time) and counts derived from
  the picks; never a hard-coded date.
- Harness states: `?state=first-run|returning|mid-listen|stress|offline|loading`
  on every route; `?np=1&np=foray|episode|paused|buffering|downloaded|ending`
  for Now Playing; `?kbd=1` for keyboard-open Browse; `?scheme=paper|night`;
  `?text=130`; `?motion=1` runs every transition under the harness (§6.1).
  **URL params are render instructions and never write the
  store**; only the Colophon controls write `cp_scheme` / `cp_large_print`
  (r1: a `?scheme=night` route turned every later route Night).
- Hooks in the splatter are authored (`hook` field, §5.4): one complete
  sentence, ≤ 16 words and ≤ 72 characters, ending in a full stop. No field,
  no splatter slot; nothing is ever cut from a description.
- A foray's `shows` count, its key and its contact plate are one fact: the
  plate shows the first four of the key's shows and the count is the key's
  length (r3: `40 min · 1 show` under a four-cover plate and a six-ink rule).

## 11. Top risks and the fallback for each

1. **Fonts.** Three families. Latin subsets, ≤ 330KB total, metric-matched
   fallbacks so the swap does not reflow headlines. If budget fails, drop
   Newsreader roman and keep only its italic (notes), using DM Sans 16/24 for
   `.t-text`.
2. **Paper in a dark car.** Night follows the OS by default; Large print exists;
   the Colophon override is two taps from Today. If testing shows drivers on
   Paper at night, default `auto` to Night between sunset and sunrise using
   the clock (state observed), and say so in the Colophon.
3. **Dot leaders with long titles.** Title clamps to one line with ellipsis,
   the time column is fixed at 56px, the leader has `min-width: 16px`; at 130%
   text the leader is dropped (`@container` query) and the time wraps under the
   title, right-aligned.
4. **View Transitions in Android System WebView.** Feature-detect
   `document.startViewTransition`; the FLIP path must be visually identical at
   normal speed. Test both paths in the harness (`?vt=0`).
5. **Blur cost.** Only four surfaces blur; if the Android profile shows jank,
   the `@supports`-style solid fallback is one token change (`--chrome-bg` to
   `--page`).
