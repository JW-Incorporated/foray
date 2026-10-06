# Clarity ("The Board"): build notes

Everything a front-end builder needs to reproduce the direction without the
art director. Read `DIRECTION.md` first for the why; this file is the what.
Values are in CSS px at 1x; type is authored in `rem` (16px root) so zoom and
OS text scaling work. Every rule here is written for the app's CSP: no inline
`style=`, no inline scripts, fonts self-hosted under `fonts/`, one
`prefers-reduced-motion` block.

Hard limits from `PLAN.md` are not restated; they apply. Copy rules: durations
read "45 min" under an hour and `3h 05m` at an hour or more (minutes padded to
two digits so the `h` aligns down the mono column; `fmtMin` only); the colon
clock (`12:30`, `-4:12`) appears only
in scrubbers and readouts; a zero count is never shown; "subject", never
"topic"; the app speaks as "4a", never "we".

## 1. Tokens

All tokens live on `:root`. Dark values are redefined under
`@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`,
and again under `:root[data-theme="dark"]` for the in-app override. Declare
`color-scheme: light dark` on `:root`. (Test note for the port: today's
`test/ui-tokens.test.js` pins the ui-v2 names; it is on the rewrite-on-purpose
list in `test-classification.md` and must be rewritten with this table.)

### 1.1 Colour

| Token | Light | Dark | Role | Contrast (light / dark) |
|---|---|---|---|---|
| `--bg` | `#FFFFFF` | `#0C0C0D` | page | |
| `--surface` | `#F4F4F2` | `#161618` | sheet body, pressed row, skeleton | |
| `--ink` | `#141414` | `#F2F2F0` | primary text, icons | 18.4 / 17.4 on bg |
| `--muted` | `#5C5C5C` | `#A3A3A0` | secondary text (body allowed) | 6.7 / 7.7 on bg; 6.1 / 7.2 on surface |
| `--faint` | `#8A8A86` | `#76766F` | inactive icons, tick marks, never text | 3.5 / 4.3 on bg |
| `--line` | `color-mix(in srgb, var(--ink) 12%, transparent)` | `color-mix(in srgb, var(--ink) 16%, transparent)` | hairlines (dark raised to 16% after r1: 12% on `#0C0C0D` was invisible) | decorative |
| `--line-strong` | `color-mix(in srgb, var(--ink) 24%, transparent)` | same | hairlines under `prefers-contrast: more`, focus-adjacent rules | |
| `--accent` | `#E8491D` | `#FF7A4D` | Signal: fills, bars, the one live mark | 3.9 / 7.6 on bg (UI component floor 3:1 met) |
| `--accent-ink` | `#B4330C` | `#FF7A4D` | Signal as small text | 6.1 / 7.6 on bg |
| `--on-accent` | `#141414` | `#0C0C0D` | text and glyphs on a Signal fill | 4.7 / 7.6 on accent |
| `--dock` | `#FFFFFF` | `#161618` | the dock capsule, **solid** (r2 ruling 1: at the .94 tint row text still read through at 2x, so the named fallback is the rule; no `backdrop-filter` anywhere) | |
| `--scrim` | `rgb(0 0 0 / .32)` | `rgb(0 0 0 / .56)` | behind sheets | |
| `--shadow-dock` | `0 8px 24px rgb(0 0 0 / .12)` | `0 8px 24px rgb(0 0 0 / .48)` | the only shadow | |
| `--focus` | `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)` | same | keyboard focus ring | |

Rules: `--accent` is never used for text below 22px; use `--accent-ink`.
White text never sits on `--accent` (3.9:1 in light fails). `--faint` is
never a text colour. Pressed state for rows: background `--surface`, no
opacity change. Disabled: `--faint` foreground, no opacity change, plus
`aria-disabled`. One named exception: an offline-dimmed row (no local file)
sets its text, its bridge and the word Stretch to `--muted` and its artwork to
`opacity: .5`, because artwork has no foreground colour to swap.

Show colours for the foray strip (`--seg-c0..7`, same names as today so
existing strip code ports). Each clears 3:1 against `--bg` and `--surface` in
its scheme (ratios computed 2026-10-05; lowest is c5 light on surface, 3.57).

| Token | Light | Dark |
|---|---|---|
| `--seg-c0` | `#1F8A7D` | `#3FB8A8` |
| `--seg-c1` | `#C9472A` | `#F07B5B` |
| `--seg-c2` | `#7A5BC7` | `#A990F0` |
| `--seg-c3` | `#2F6FD6` | `#5B9BFF` |
| `--seg-c4` | `#9A7416` | `#E0B04A` |
| `--seg-c5` | `#2E8BA3` | `#5EC2DD` |
| `--seg-c6` | `#B04E99` | `#E07BC6` |
| `--seg-c7` | `#5E8A3A` | `#9CC36A` |
| `--seg-narration` | `repeating-linear-gradient(135deg, var(--muted) 0 2px, transparent 2px 6px)` | same | 

Unplayed bars in a progress strip (`.strip--prog`) are the show colour mixed
into `--bg`: **62% on dark** for every token, and **per token on light**
(`--seg-u0..7`), where 62% fell to 2.2–2.6:1 and had to be raised. Measured by
the round-2 builder (`r2-tools/contrast.js`, WCAG relative luminance against
`--bg`); lowest values 3.01 (light c5) and 3.34 (dark c3). r1 shipped 38%,
which put c3/c6/c7 near 1.9:1 on dark. The progress strip sits on `--bg`
only; on `--surface` the light values read ~2.75, so a `.strip--prog` never
goes on a sheet body.

| Token | Light mix | Light result | ratio | Dark mix | Dark result | ratio |
|---|---|---|---|---|---|---|
| `--seg-c0` | 80% | `#4CA197` | 3.06 | 62% | `#2C776D` | 3.69 |
| `--seg-c1` | 72% | `#D87B66` | 3.02 | 62% | `#99513D` | 3.35 |
| `--seg-c2` | 73% | `#9E87D6` | 3.05 | 62% | `#6D5E9A` | 3.46 |
| `--seg-c3` | 74% | `#6594E1` | 3.05 | 62% | `#3D65A3` | 3.34 |
| `--seg-c4` | 79% | `#AF9147` | 3.02 | 62% | `#8F7233` | 4.30 |
| `--seg-c5` | 83% | `#529FB3` | 3.01 | 62% | `#3F7D8E` | 4.22 |
| `--seg-c6` | 74% | `#C57CB4` | 3.04 | 62% | `#8F5180` | 3.40 |
| `--seg-c7` | 82% | `#7B9F5D` | 3.02 | 62% | `#657D47` | 4.26 |

Narration is a hatched pattern on a transparent bar with a `--line` outline,
so it is distinguishable without colour. Show colour assignment: stable per
show id (hash mod 8), computed once and cached under `cp_` storage, never
re-rolled when a foray changes.

### 1.2 Type

Faces: `Geist` and `Geist Mono` (OFL 1.1), variable, Latin subset, woff2,
self-hosted at `fonts/Geist[wght].woff2` and `fonts/GeistMono[wght].woff2`.
`font-display: swap`. Fallback stacks: `"Geist", "Inter", system-ui,
sans-serif` and `"Geist Mono", "JetBrains Mono", ui-monospace, monospace`.
Global: `font-variant-numeric: tabular-nums; font-feature-settings: "ss01"
off; -webkit-font-smoothing: antialiased` on dark only.

| Token | Family | Size / line | Weight | Tracking | Use |
|---|---|---|---|---|---|
| `--t-display` | Geist | 2.125rem / 2.375rem (34/38) | 600 | -0.02em | one per screen |
| `--t-title` | Geist | 1.375rem / 1.625rem (22/26) | 600 | -0.015em | section heads, NP title |
| `--t-body-strong` | Geist | 1.0625rem / 1.375rem (17/22) | 560 | 0 | row titles |
| `--t-body` | Geist | 1.0625rem / 1.5rem (17/24) | 400 | 0 | why-lines, notes |
| `--t-label` | Geist | 0.9375rem / 1.25rem (15/20) | 500 | 0 | secondary row text, buttons |
| `--t-caption` | Geist | 0.8125rem / 1rem (13/16) | 500 | +0.01em | eyebrows, table heads |
| `--t-data-display` | Geist Mono | 2.125rem / 2.375rem (34/38) | 500 | -0.01em | the Today date only (r3: the build set it at display size and that is right; this row records it) |
| `--t-data-lg` | Geist Mono | 1.375rem / 1.625rem (22/26) | 500 | 0 | scrubber clock |
| `--t-data` | Geist Mono | 0.9375rem / 1.25rem (15/20) | 450 | 0 | durations, counts |
| `--t-data-sm` | Geist Mono | 0.75rem / 1rem (12/16) | 450 | +0.02em | legend, tick labels, badges |

Caption and table heads are sentence case, never all-caps. The explicit badge
is `--t-data-sm` "E" in a 16px box with a `--line-strong` border. Line clamps
use `-webkit-line-clamp`; clamped text gets `title` and, where the row opens
a detail page, no "..." affordance of its own.

### 1.3 Space, radius, size

| Token | Value |
|---|---|
| `--s-1 … --s-8` | 4, 8, 12, 16, 20, 24, 32, 48 |
| `--gutter` | 20px; 16px when `(max-width: 380px)` |
| `--col-data` | 72px (the right-aligned data column) |
| `--r-sm` | 6px (thumbnails, badges, buttons) |
| `--r-lg` | 12px (field, menu, undo bar) |
| `--r-sheet` | 24px (sheet top corners, dock capsule) |
| `--r-pill` | 999px (the one pill: chips, the play capsule) |
| `--art-row` | 56px |
| `--art-lead` | 72px |
| `--art-mini` | 44px |
| `--row-ep` | 112px min-height; a three-line why makes it 136 (r3: rows are content-sized, both on the 8 grid; r1: was 72, unreachable with a three-line stack); `--row-lead` 160 min-height, 184 with a three-line why (r2 said 144; the anatomy adds to 160); `--row-stretch` 136 / 160; `--row-resume` 80px |
| `--row-show` | 56px |
| `--row-queue` | 64px |
| `--row-seg` | 48px |
| `--tap` | 44px (minimum hit area, every control) |
| `--dock-h` | 120px: 64px mini player + hairline + 56px tab bar in **one** capsule (r2: no 8px gap, no shelf; content leaked through the gap); 56px when the mini is hidden |
| `--safe-b` | `env(safe-area-inset-bottom)` |
| `--hairline` | 1px (on 3x screens `0.5px` via `@media (min-resolution: 3dppx)`) |

### 1.4 Motion

| Token | Value | Use |
|---|---|---|
| `--t-1` | 120ms | state (pressed, toggle, fade) |
| `--t-2` | 200ms | reveal (menu, undo bar, skeleton to content) |
| `--t-3` | 320ms | navigate (push, strip to timeline, collapse) |
| `--t-4` | 480ms | sheet (mini to Now Playing) |
| `--ease` | `cubic-bezier(.2, 0, 0, 1)` | everything that is not a spring |
| `--spring` | `linear(0, 0.013, 0.05, 0.108 7.8%, 0.26 13.4%, 0.496 20.6%, 0.698 27.2%, 0.853 34%, 0.953 41.2%, 1.012 49.2%, 1.03 58.4%, 1.02 69.4%, 1.004 82.8%, 1)` | the sheet, the dock, the Signal play press |
| `--spring-stiff` | `linear(0, 0.08, 0.3 12%, 0.62 24%, 0.88 36%, 1.02 50%, 1.01 68%, 1)` | small snaps: scrubber release, chip select |

Only `transform` and `opacity` animate; never `height`, `top` or colour on
large areas. Colour transitions use `@property`-registered custom properties
only for the Signal fill of the play control.

The single reduced-motion block:

```css
@media (prefers-reduced-motion: reduce) {
  :root { --t-1: 0ms; --t-2: 120ms; --t-3: 120ms; --t-4: 120ms;
          --spring: var(--ease); --spring-stiff: var(--ease); }
  .strip__fill, .mini__title { animation: none; transition: none; }
  .today__date { animation: none; }
}
```

Every transition in the app reads its duration from these tokens, so this
block is the only one needed.

## 2. Component inventory

Class names are proposals for the Phase 3 port; keep them or map them, but
keep one class per component and modifiers as `--`.

| Component | Anatomy | Sizes and rules |
|---|---|---|
| `Row` (episode) | a grid of two rows: first row = art 56 · stack(show `caption` muted, title `body-strong` **1-line** clamp) · data column (duration `data`, optional state glyph); second row = the why `body` **`--ink`**, **3-line clamp**, `grid-column: 2 / -1` (from the stack's left edge to the right gutter, passing under the data column) | min-height 112 (12 + 16 + 22 + 2 + 48 + 12); 136 with a three-line why. 285px wide at 393 for the why: about 30 characters a line once words wrap whole, so three lines hold **about 90 characters** (r4 `fit.mjs` over all 40 hooks: 10 needed a fourth line at 285, 16 at the lead's 269). The copy budget is ≤ 18 words **and about 90 characters**; the clamp catches the rest. The art spans the first two grid rows only (r4: a three-row span gave the empty third row 8px and every row measured 144). r3 item 1: the 201px stack cut every hook at two lines. Padding 12 0, gap 12, hairline bottom. Whole row is one `<a>` or `<button>`; secondary actions live in a trailing 44px "more" menu, never inline. Durations ≥ 60 min are `3h 14m` on one line. |
| `Row--lead` | first row = art 72 · stack(eyebrow `caption` muted "Today's lead" / "Picked to start", one line `nowrap`; show line `caption` `--ink` 500: the show name, or "Foray · 6 shows" for a foray; title 2-line clamp) · data column: 44px Signal play circle above the duration; second row = why `body` 3-line clamp spanning columns 2 to the right gutter (269px at 393); then the 4px Strip at the same width | min-height 160 (12 + 16 + 16 + 44 + 2 + 48 + 6 + 4 + 12), 184 with a three-line why; padding 12 0. Only one per screen. The circle column is 64px tall (44 + 20) and the why starts 96px down, so they never meet. Mid-play: the circle keeps the play glyph with `aria-label` "Resume"; the duration becomes "35 min" `data` over "left" `data-sm` muted, the two lines set at 18 and 14 line height with no gap so the column is 76px (44 + 18 + 14), never taller than the stack above the why (r4: at 20/16 with a gap the column was 86 and grew the row to 194). The word Resume never goes in the 72px column (r2 item 5). Offline, the "saved" Badge sits on the eyebrow line after "Today's lead", not under the duration, for the same height reason (r4). |
| `Row--stretch` | adds a `Bridge` line as the first line of the stack: bridge · show `caption` · title, then the why in the second grid row as `Row` | the bridge replaces the eyebrow, never the show name; the data column holds the duration only. Min-height 136, 160 with a three-line why; the one taller row per section. |
| `Row--resume` | art 56 with a 2px Signal progress line 4px under it (art width, track `--line-strong`, radius 1) · stack(show `caption` muted, title `body-strong` 1-line) · data: "28 min" `data` over "left" `data-sm` muted | height 80 (12 + 56 + 12); no why-line (the pick was already chosen); hairline as other rows |
| `Row--show` | art 56 · name `body-strong` · data column: episode count `data` | height 56 |
| `Row--queue` | position `data` muted 24px wide · art 44 · stack(title `body-strong` 1-line, show `caption`) · data column: a started item shows "35 min" `data` over "left" `data-sm` muted; an unstarted one shows its duration on one line (r3 item 4: a bare "35 min" cannot say whether it is remaining or total) | height 64 (the two lines are 20 + 16); `--now` adds a 3px Signal left rule inside the gutter and the word "Now" in `data-sm` `--accent-ink` under the position (the position itself stays muted). The Up Next count, here and on the Now Playing control row, is the number of items **after** the one playing (r3 item 5) |
| `Row--segment` | index `data-sm` · colour chip 12×12 radius 3 · stack(show `label`, segment title `body` 1-line) · duration `data` | height 48; narration rows show the hatched chip and the label "Narration" |
| `Bridge` | `data` in `--accent-ink`: `from → to`, then the bridge sentence `body` in `--ink` | the arrow is the Lucide `arrow-right` glyph at 16px, not a text arrow; from/to are subject names, sentence case. `white-space: nowrap` on the **arrow + to** pair; the only permitted break is between `from` and the arrow, so a wrapped bridge reads "fusion" / "→ materials science", never "fusion →" / "materials science" (r2 item 9) |
| `Strip` | flex row of bars, height 4 (row), 24 (detail/NP) | bar width = segment seconds / total seconds; min bar width 3px; 1px gaps; narration bars hatched; `.strip__fill` on the current bar grows `transform: scaleX()` from the left; detail/NP variants add tick marks every 5 min (`--faint`, 1×6px) and mono tick labels every 10 min. Under a row the strip spans the why's width, stack-left to the right gutter (285px on a board row, 269 on the lead at 393), never the stack column alone (r3: 186px for 22 bars was not legible as bars) |
| `Stat` | `data` muted, one line | "6 picks · 2 outside your usual lane"; built from observed counts; omitted entirely when the count would be zero or on first run |
| `SectionHead` | `caption` muted + optional count `data` muted right-aligned | margin-top 24, margin-bottom 8; no rule under it (the first row's hairline is enough) |
| `Dock` | **one** capsule: `MiniPlayer` (64) on top, a `--line` hairline, `TabBar` (56) below; 12px from the sides, `--safe-b` + 12 from the bottom | background `--dock` solid, radius 24, one `--shadow-dock`, one inset hairline; no `backdrop-filter`, no gap, no shelf (r2 item 3: two capsules 8px apart let rows show through the gap). Under `prefers-contrast: more` the hairline is `--line-strong`. The mini slides out on `translateY` and the capsule height follows (`--t-2`) when the dock minimises after 48px of downward scroll; it returns on any upward scroll. The sheet opens **over** the dock; the dock is never hidden first. |
| `TabBar` | three 44×56 targets: Today (`calendar`), Find (`search`), Library (`library`) with `caption` labels | active = `--ink` icon at stroke 2.25 and label 600; inactive = `--muted`; no Signal in the tab bar |
| `MiniPlayer` | art 44 · stack(title `label` 1-line, show `caption` muted) · play/pause 48 · 30-forward 44 · 2px progress line on the capsule's top edge, inset 20px each side so it clears the radius; track **`--line`** (the same as the rim, so the unfilled part is the rim and only the Signal fill reads; r3 item 6: a `--line-strong` track made the rim look doubled in the middle), fill Signal, both `border-radius: 1px` | height 64; the body is one button "Now playing: title, show"; the progress line is `aria-hidden`; title marquee only when clipped, 8s loop, off under reduced motion. The art shows the foray composite drawn once when play started (see 4.2 states), never redrawn here |
| `Transport` | 15-back 56 · play 72 (Signal fill, `--on-accent` glyph) · 30-forward 56, gap 16 | glyph set below; press scales to .96 on `--spring-stiff` |
| `Scrubber` | 6px track (`--line-strong`), Signal fill, no thumb until touched (then 20px, Signal), 44px hit area, clocks `data-lg` on one baseline below: elapsed left, remaining right with a leading minus | `role="slider"` with `aria-valuetext` "12 minutes 30 of 48 minutes", step = 15s; the value text updates at most every 5s; drag shows a 28px mono bubble above the thumb |
| `Scrubber--foray` | the track is `Strip` at 24px; fill is per bar | selection haptic at each boundary; readout `data` under the clocks: "3 of 8 · Satay Okay · 4:12 left" |
| `Button` | capsule, height 44, padding 0 20, `label` 600 | `--primary`: Signal fill, `--on-accent` text; `--secondary`: hairline border `--line-strong`, `--ink` text; `--text`: no border, **`--ink` 500 with a trailing 16px `chevron-right`**, 44px hit area; `--text-quiet` ("Later"): `--muted` 500, no chevron. Never an outlined Signal button, never Signal text in a button: `--accent-ink` as text is only the Bridge and the word "Now". |
| `IconButton` | 44×44, 20px glyph | the only glyph-only control; always has `aria-label` |
| `Chip` | capsule, height 32 (hit area padded to 44), `label` | selected = `--ink` fill with `--bg` text; a chip never shows Signal |
| `Field` | height 48, radius 12, background `--surface`, hairline border; `search` glyph leading, clear button trailing | focus ring `--focus`; placeholder `--muted`; docked variant sits 8px above the dock capsule and takes the dock material (`--dock` solid, `--shadow-dock`, `--line-strong` inset) so rows scrolling under it never show through |
| `Sheet` | radius 24 top, grabber 36×4 `--faint` at 8px, close `IconButton` top right at 12/12 | opens from the dock (shared elements), drags to dismiss, traps focus, returns focus to the mini player. While a flyer is in the air (`.is-flying`, either direction) the art slot is **invisible**: `background: transparent; box-shadow: none`, not a `--surface` tile (r3 item 2: the empty tile rode down with the sheet on close) |
| `Menu` | 240px wide, radius 12, `--bg` with `--line-strong` border, rows 44 | anchored to the trailing "more" button; one hairline between groups |
| `Undo` | bar above the dock, height 48, `--ink` fill with `--bg` text, "Removed · Undo" | 6s then slides down; `role="status"` |
| `Skeleton` | the same row geometry with `--surface` blocks: hairline, a 40×16 data block, three why bars (rows 136), a 4px strip block under the lead (184) | shimmer is a 1.2s opacity pulse, off under reduced motion; most hooks are three lines, so the crossfade jumps 24px only on the short ones |
| `EmptyState` | one `body` line + one `Button--primary` or `--text`, left-aligned in the row grid | no illustration, no quoted button labels |
| `Badge` | `data-sm` in a 16px-high box, radius 3, `--line-strong` border | "E" explicit, "saved" (downloaded), "new" |

### 2.1 Icons

Lucide (ISC), sprite `icons.svg` with `<symbol>` ids, rendered as
`<svg class="i"><use href="#i-play"/></svg>`, 20×20, `stroke-width: 1.75`,
`stroke-linecap: round`, `currentColor`. Subset: calendar, search, library,
play, pause, arrow-right, chevron-right, chevron-left, chevron-down, more-
horizontal, plus, check, x, bookmark, bookmark-check, share, download,
download-done (check-circle), clock (sleep), gauge (speed), list (Up Next),
list-plus, arrow-up, arrow-down, trash-2, user, settings, wifi-off, refresh-cw,
info, alert-circle, car-front (glance mode).

Custom transport glyphs, drawn on the same 20px grid at the same stroke (the
sprite carries them as `#i-skip-back-15`, `#i-skip-fwd-30`, `#i-play`,
`#i-pause`): an open arc of 270° with an arrowhead, the number "15" / "30"
set in Geist Mono 8px inside the arc (the number is part of the symbol, not
HTML text). Play is a filled triangle; pause is two 3px bars.

## 3. Grid

- Base 4px; vertical rhythm 8px; every row height is a multiple of 8.
- Gutters `--gutter` left and right. All text shares the left gutter edge
  (artwork sits on it; text starts at gutter + art + 12).
- Four content columns are implicit; the only enforced column is the data
  column: the right `--col-data` (72px) of every row, right-aligned, mono.
  Nothing wraps into it on the row's first line; the why-line is a second
  grid row that passes beneath it to the right gutter (r3 item 1), and the
  column's content (one 20px line, or the lead's 64px circle and duration)
  is always shorter than the stack above the why.
- Hairlines run from the text's left edge (not the artwork's) to the right
  gutter, so rows read as a table.
- Vertical: screen top padding = `env(safe-area-inset-top)` + 12; header line
  44 high; section gap 32; row padding 12; content bottom padding = dock
  height + `--safe-b` + 16, so the last row clears the dock.

## 4. Per-screen specs

Every screen is a scroll view under the dock. Viewports: 393×852 (reference),
375×667 (small), 412×915. Numbers below are for 393; at 375 the gutter is 16
and the lead artwork stays 72.

### 4.1 Today

```
[safe-top + 12]
Header (44):  date `data-lg` "Mon 5 Oct" left · IconButton `user` right ("You")
[8]
Stat (20):    `data` muted "6 picks · 2 outside your usual lane"   (omitted on first run)
[24]
Row--lead (160 / 184): art 72 · eyebrow "Today's lead" · show line ("Lex Fridman Podcast" / "Foray · 7 shows") · title (2 lines) · data: [Play circle 44] [1h 05m]; then why (up to 3 lines, stack-left to the right gutter) · [Strip 4px at the same width, if foray]
SectionHead "Resume"            (only when something is mid-play; count "2"; 24 above, 8 below)
Row--resume ×1–2 (80): 2px progress line under the artwork, data "28 min" / "left"
SectionHead "Forays for you"    (whenever a foray exists and is not the lead; its strip is inside the first viewport at 393×852)
Row ×1–2 with Strip (4px) under the why, data "22 min", show line "Foray · 6 shows"
SectionHead "Picked for you"
Row ×3–5 (112, or 136 with a three-line why): one is Row--stretch (136 / 160)
[dock clearance]
```

Order changed after r1: the foray was below the fold on every viewport, so
the signature was invisible on the first screen. Target density in the
`default` state, re-derived in round 3 for the three-line why: at 393×852
the lead, two full board rows and the third row's title (108 header block +
184 lead + 56 to the first row = 348; 720 − 348 = 372 = 2 × 136 + 100); at
412×915 the lead and three; at 375×667 the lead, one row and the second's
title. Round 2's lead + four was measured on rows whose why was cut at seven
words on every one of them; the trade is deliberate (DIRECTION §8). Measure
it in every round's shots (`r3-tools/measure.mjs`) and put the numbers in
the builder's notes.

- Scrolling: once the header passes 48px, the date shrinks to `caption` in a
  44px sticky header line with a hairline. Two date elements are always in
  the header line, `data-lg` and `caption`; collapsed, the large one goes
  `opacity: 0; transform: translateY(-8px) scale(.6)` (`transform-origin: 0
  50%`) and the small one comes from `opacity: 0; translateY(8px)` to
  identity, both on `--t-3` `--ease`, and the line's hairline fades in.
  Scroll-driven over the first 48px behind `@supports (animation-timeline:
  scroll())`, else a class toggle at 48px. Never transition `font-size`
  (r2 item 7: the build snapped between sizes in one frame).
- First run: no Stat; eyebrow on the lead reads "Picked to start"; why-lines
  come from the pick's own reason, never from "your usual subjects".
- Mid-listen: the Resume section appears second; when the lead is the
  resumable item its circle is labelled "Resume" and its data column reads
  "35 min" / "left". The circle never becomes a word pill and the data column
  never widens (r2 item 5).
- After a text-button row ("All 14 shows", "All 11 subjects"), the next
  SectionHead's margin-top is 8, not 24: the button row already carries a
  44px line (r2 item 17).
- Offline: rows with a local file show the "saved" Badge in the data column;
  rows without are `--muted` with `aria-disabled`; one `EmptyState` line at
  the top: "Offline. Saved episodes play." plus a text button "Show saved".
- Loading: `Skeleton` rows in the same geometry (1 lead + 3 rows).
- Stress: board titles clamp 1 line (the lead's 2), why clamps **3** lines
  (r3 item 1; it spans the data column, so a 16-word hook fits), show clamps
  1; the data column never shrinks; a 40-character show name truncates with
  an ellipsis.

### 4.2 Now Playing (full)

```
Sheet, full height, radius 24 top
[12] grabber 36×4 centred · IconButton `x` top right (12, 12)
[20]
Artwork: square, width = min(100vw − 2·gutter, 56dvh − 175px, 390px), centred, radius 6, hairline border   (r2 ruling 2)
[20]
Title `title`, 2-line clamp (tap toggles full title in place, sheet grows)
Show `label` muted (1 line)
Why `body` muted (3-line clamp; 2 at viewports ≤ 700px high, never 1: r3 found the build at one line there, which reads "…one option of eight; see…")   ← the pick's reason; a foray shows its subject line here
[32]  ← measured from the why's last line box to the top of the strip/track, not to a wrapper (r2 item 8: the shot showed 54)
Scrubber: track 6px; clocks `data-lg` below on one baseline: "12:30" left, "-35:42" right (`align-items: baseline`, so the word "buffering" at `data` sits on the same baseline)
   foray: Strip 24px as the track; readout `data` muted under the clocks
[24]
Transport, centred: [15-back 56] 16 [Play 72 Signal] 16 [30-fwd 56]
[16]
--- fold on 375×667 lands here or below; everything above is the glance posture ---
Control row (44): speed "1.5×" `data` · sleep · bookmark · share · Up Next "5" `data`   (five 44px IconButtons with `caption` labels under, spread to the gutters)
[32]
SectionHead "Segments" (foray) or "Chapters" (episode, when the feed has them)
Row--segment × n (48 each); the current one has the 3px Signal left rule and "Now"
SectionHead "Notes"
Show notes `body`, 4-line clamp, "More" text button; feed HTML sanitised via esc()/safeUrl(), links 44px
SectionHead "Up next"
Row (72) for the next queue item, why-line present, data "in 4:12"
[dock clearance not needed; the sheet covers the dock]
```

Budget check at 375×667: safe-top 0 (harness) + 12 + 4 + 20 + artwork
(min(335, 198, 390) = 198) + 20 + title 52 + show 20 + why 48 + 32 + scrubber
6 + clocks 26 + 24 + transport 72 = 534 < 667, transport centred at ~560.
At 393×852: artwork 300, transport at ~760, control row on screen. Play stays
on screen with a two-line title and a two-line why-line. For a **foray** the
track is the 24px Strip plus ticks and labels (about 46px more than the 6px
track), so at 375×667 the transport centre lands at ~573 and the control
row's glyphs peek at the fold with their labels below it (r4 shot); that is
the glance posture working, not a cut. The transport never leaves the thumb
zone. If the title is
expanded, the sheet scrolls; the transport is never pushed off by a clamp.

States:
- Foray: artwork is a 2×2 composite of the first four shows' art, built on a
  canvas from the published URLs **once, when the item starts playing**, kept
  in memory for the session (canvas or `toDataURL()`), never persisted and
  never redrawn for the sheet, the mini or the lead row (r2 item 1: drawing
  it on sheet open left the slot black for ~500 ms mid-transition); the track
  is the Strip; narration bars are hatched; the readout alternates nothing,
  it just reads "3 of 8 · Satay Okay · 4:12 left" and, during narration,
  "Narration · 0:38 left".
- Paused: play glyph swaps to pause; nothing else changes (no dimming).
- Buffering: the elapsed clock is replaced by the word "buffering" in `data`
  muted; the track keeps its position; no spinner anywhere.
- Offline / downloaded: "saved" Badge after the show name.
- End of item: in the last seconds the Up next row's title rises into the
  title slot under the eyebrow "Up next · in 0:03"; the **artwork stays the
  finishing item's until 0:00**, then crossfades (`--t-3`) as the clocks reset
  (r3 item 7: the state shot swapped the art three seconds early, so the
  picture lied about what was playing); the Up next section now shows the
  item after.
- Max text size: artwork shrinks first (the `min()` does this), then the why
  clamps to 1 line; the transport never resizes below 56/72/56.
- Glance mode (car route observed via the media session route, or pinned from
  the control row's overflow): artwork 160, title 1 line at `title`, transport
  72/96/72 with 24 gaps, control row hidden, scrubber hidden behind a single
  tap on the artwork. Exiting the route restores the layout on `--t-3`.

### 4.3 Mini player

Part of the Dock capsule. 64 high: 12 left padding, art 44 (radius 6),
12 gap, title `label` 1-line + show `caption` muted, 12 gap, play/pause 48
(Signal fill, `--on-accent` glyph), 4 gap, 30-forward 44 (`--ink` glyph),
12 right padding. Progress line 2px Signal across the top edge, inset 12 each
side. Hidden when nothing has ever played; present (paused) after the first
play until the queue is empty. Swipe down on the capsule stops playback and
shows `Undo` ("Stopped · Undo") for 6s.

### 4.4 Find

```
[safe-top + 12]
Header (44): "Find" `title`
[16]
Idle:
  Row (56): "Name a subject" over `caption` muted "Build a playlist on anything" (r4: the build said "foray"; custom forays are out of UI scope, D8, and the row must not promise one) → focuses the docked Field with placeholder "A subject, a show, or an episode"
  SectionHead "Subjects" (count "24")
  Row--show ×6 without art: subject name `body-strong` · data: show count `data`; then a text-button row "All 24 subjects" (chevron) that expands in place (r2 item 11: eight rows pushed every piece of artwork under the fold)
  SectionHead "Shows you follow" (count)
  Row--show ×n with art
  SectionHead "Recent"
  Row ×n
Typing (field focused, keyboard open, results replace the idle content):
  SectionHead "Shows" (count) · Row--show ×n
  SectionHead "Episodes" (count) · Row ×n
  SectionHead "Playlists" (count) · Row ×n (no art; a 2×2 composite when 4 episodes have art)
No results:
  `body`: "Nothing for 'fusion'."
  then, when a subject matches by prefix: `body` muted "Fusion & energy systems has 5 shows" + that subject row underneath
  else: `body` muted "Try a show name or a subject." (no button)
Field: docked 8px above the dock; with the keyboard open the dock hides and the field sits on the keyboard
```

The field is a `Field` with `type="search"`, `enterkeyhint="search"`, results
update after 250ms idle; the first result is focusable with a `Tab`. The
"Name a subject" row carries the Create function: submitting a subject that
matches nothing offers "Build a playlist on 'X'" as a `Button--secondary` in
the no-results block (custom forays are out of UI scope, D8, so no Foray
option is drawn).

### 4.5 Library

```
[safe-top + 12]
Header (44): "Library" `title` · IconButton `download` right ("Saved")
[16]
Grid: followed shows, 3 columns, gap 8, cell = (100vw − 2·gutter − 16) / 3 ≈ 112, art square radius 6, name `caption` `--muted` **2-line** clamp 4px under the art (r3 item 3: the build set names at `body-strong` 17px and cut four of six; "Lex Fridman Podcast" wraps, never truncates); max 2 rows then a "All shows" text button row
SectionHead "Forays" (count) · Row ×n with Strip 4px
SectionHead "Up Next" (count) · Row--queue ×n (max 5 here, then "All 12" text button)
SectionHead "Saved" (count) · Row ×n
SectionHead "Playlists" (count) · Row ×n
SectionHead "History" · Row ×n with data "Yesterday" / "3 Oct" / "3 Oct 2025" (year only when not this year)
```

- Up Next full page: same `Row--queue`, each with a trailing 44px "more"
  `IconButton` opening a `Menu`: Play now, Move up, Move down, Remove. The
  played row jumps to the top (founder ruling kept); a row that moves animates
  `translateY` on `--t-3` while neighbours open the gap; Remove shows `Undo`.
  Up Next count badge on the "Up Next" `IconButton` in Now Playing updates
  with a 1.1 scale pulse on `--spring-stiff`.
- Empty: the header, then one `EmptyState` per section that has a sensible
  action: Shows "Follow a show to see it here" + text button "Find shows";
  Forays "Forays appear here once 4a has made one for you"; Up Next "Add an
  episode from its row" (no quoted button labels; "from its row" points at the
  more menu); Saved and Playlists likewise. Sections with no action show one
  line only.

### 4.6 Foray detail

```
[safe-top + 12]
Header (44): IconButton `chevron-left` ("Back") · `caption` muted "Foray · Food" centred (the subject, sentence case; r4 ruling: the build put the eyebrow in the header line as a running head and it reads right, so the 8px + eyebrow block below is gone) · an empty 44px spacer so the caption centres
Title `display`, 3-line max
[8]
Meta `data` muted: "22 min · 8 segments · 6 shows"
[20]
Strip 24px with ticks (every 5 min) and tick labels `data-sm` (every 10 min): "0", "10", "20"
[20]
Why `body`: the foray's why-line (≤18 words)
[20]
Button--primary 44: "Play" / "Resume at 9:40" / "Play again"   +   Button--secondary "Up Next" (list-plus)   +   IconButton share
[32]
SectionHead "Where this came from" (count "6 shows")
Legend row × n (48): chip 12×12 · show `label` 1-line · `data-sm` muted "4 segments" (the word, never "seg": r4) · `data` "10 min"; show name is a link to the show page (safeUrl). One row per show, in strip order; the per-segment `Row--segment` list is Now Playing's, not this page's.
[32]
Summary `body` muted (the foray's summary field)
```

States:
- Unplayed: "Play". In progress: "Resume at 9:40" and the Strip shows the
  fill to the position. Finished: "Play again" and the Strip fully filled in
  `--muted` (not Signal).
- Un-narrated: no hatched bars; a `caption` line under the Strip: "No
  narration yet". Nothing apologises.
- Unavailable: the Strip renders in `--faint`, the primary button is replaced
  by `body` "Not available right now; the shows are still here", the segment
  rows stay live and link to the shows.
- The transition in: the row's 4px Strip is the shared element for the 24px
  one, `--t-3`; everything else fades in. FLIP (the only path): measure the
  row strip, set `transform` on the detail strip from that rect, animate to
  identity. Verified travelling in r3.

### 4.7 Onboarding, first screen

Full-screen, no dock, no tabs.

```
[safe-top + 48; 32 at viewports ≤ 700px high]
Headline `display`, left: "Each morning, 4a picks a few episodes and says why."   (at ≤ 700 high: `title` 22/26, two lines; the budget with three-line whys is 698 at 34px and 636 at 22px against 667)
[24]
Board sample: three `Row`s from data/session.json (slots 1–3) with their why-lines finishing (up to three lines, the r3 row anatomy); **two rows** when the viewport is 700px high or less (never a clipped why: the reason is the pitch); **no Bridge** on any sample row (nothing is observed yet; r2 item 14); non-interactive (`aria-hidden` on controls, no data-column play)
[24]
Strip sample 24px for one foray from data/forays.json + `body` muted: "A foray is one listen built from parts of several shows, with short narration between them."
[flex spacer]
Button--primary full width: "Show my picks"
[8]
Button--text centred: "Later"
[safe-bottom + 16]
```

Returning after skip: the headline becomes "Your picks are ready" and the
sample rows are today's real lead + two picks. No account is asked for.
Both buttons go to Today; "Later" sets nothing but the dismissal under `cp_`.

## 5. Motion specs

| Moment | What moves | Duration / curve | Fallback |
|---|---|---|---|
| Mini → Now Playing | sheet translates up over the dock (the dock stays painted beneath it); the **full-size** art element, already carrying the composite, starts transformed onto the mini art's rect and animates to identity; the title likewise; the rest of the sheet's content (top bar, show, why, strip, clocks, transport, control row, sections) fades in from 16px below over the second half. The slot is never empty and never a grey tile: nothing is drawn or loaded during the transition (r2 item 1), and while a flyer is in the air the slot is transparent with no hairline (r3 item 2) | `--t-4` `--spring` | FLIP with the Web Animations API, the only path (View Transitions dropped r3); drag follows the finger 1:1 and releases to the spring; dismiss threshold 120px or velocity > 0.6px/ms |
| Now Playing → mini (close button, drag release, Escape) | the same path back, from wherever the sheet is: the sheet translates down to `100%`; the scrim fades 1 → 0 over the **same** duration, linear, in the same animation group (r3: it vanished in the first frame); the art and title flyers travel from their sheet rects to the mini rects; the sheet's content fades to 0 over the first `--t-1` so nothing with text or glyphs crosses the dock (r3: the close button and grabber slid over the tab bar); the slot is transparent from the frame the flyer leaves; the flyers are removed in the frame the mini slot is painted | `--t-3` `--ease` (an exit never overshoots into the dock) | springs back on `--spring` when the release is under threshold |
| Row → Foray detail | measure the row Strip's rect before navigation; render the page at opacity 0; set `transform: translate(dx,dy) scale(sx,sy)` (`transform-origin: 0 0`) on the 24px Strip so it covers the row Strip's rect; animate the Strip to identity and the page to opacity 1. The Strip **travels**; an in-place scaleY is not this (r2 item 2) | `--t-3` `--ease` | `view-transition-name: strip-<id>` where supported; `@capgo/capacitor-transitions` push/pop with edge-swipe back is optional and must be tested per Capacitor version |
| Today header collapse | two date elements crossfade with `transform` (large: `translateY(-8px) scale(.6)` out; small: `translateY(8px)` in), sticky line's hairline fades in; never `font-size` (r2 item 7) | scroll-driven over 48px | class toggle at 48px, `--t-3` `--ease` |
| Dock recede | dock translates down by 72 (mini hidden) on downward scroll past 48px, back on upward scroll | `--t-2` `--ease` | none needed |
| Play press | play capsule scales .96 → 1 | `--t-1` then `--spring-stiff` | none |
| Strip fill | current bar `scaleX` from 0 to progress; a 1s CSS transition per tick, not a 60fps loop | `linear` | static fill under reduced motion |
| Queue reorder | moved row `translateY`, neighbours open the gap | `--t-3` `--ease` | none |
| Undo bar | translateY 100% → 0 | `--t-2` `--ease` | fade |
| Skeleton → content | opacity crossfade | `--t-2` | none |
| End of item | Up next title crossfades into the title slot, artwork crossfades | `--t-3` | none |
| Tab switch | none (instant); the active icon's stroke weight steps 1.75 → 2.25 | `--t-1` | none |

The FLIP path uses the Web Animations API with the same tokens and is the
only path (r3 ruling 3: one path on two WebViews). Nothing waits on an
animation: state changes first, motion follows.

## 6. Haptics map (Web+, `@capacitor/haptics`)

| Event | Call |
|---|---|
| play / pause | `impact({ style: 'light' })` |
| 15-back / 30-forward | `impact({ style: 'medium' })` |
| scrubber crosses a segment or chapter boundary | `selectionChanged()` |
| bookmark saved, added to Up Next | `notification({ type: 'success' })` |
| undo | `impact({ style: 'light' })` |
| glance mode enters (car route observed) | `notification({ type: 'success' })` once |

No haptic on scroll, tab change or row tap. All calls are wrapped so a web
build without the plugin is silent.

## 7. Accessibility checklist (per feature)

- Every `IconButton` has `aria-label`; play/pause exposes state ("Pause").
- Rows are single controls with a composed accessible name: "title, show,
  1 hr 5 min, why-line"; the stretch row prepends "Stretch pick:".
- Scrubber: `role="slider"`, `aria-valuetext`, keyboard arrows step 15s; the
  foray scrubber announces "segment 3 of 8, Satay Okay" on boundary.
- Sheets trap focus, set `inert` on the page behind, and return focus to the
  opener (the mini player).
- Meaning never by colour alone: narration is hatched and labelled; the
  current row has the word "Now"; saved items carry the "saved" Badge; the
  stretch row carries the word "Stretch" in the eyebrow.
- `prefers-contrast: more`: `--line` becomes `--line-strong`, `--muted`
  becomes `--ink`, the dock goes solid.
- `prefers-reduced-transparency: reduce`: the dock goes solid.
- Zoom: viewport meta allows `maximum-scale=5`; no `touch-action: none` on
  the page (only on the scrubber and the sheet grabber).
- Text scales: all type in rem; row heights are minimums, not fixed; artwork
  uses `min()`; nothing is `overflow: hidden` on a text container except the
  deliberate line clamps.
- Tap targets 44px everywhere; transport 56/72/56; 12px minimum between
  adjacent transport controls (the spec uses 16).
- Contrast: the table in §1.1 is the record; the two pairs that must never
  be used are white on light Signal and `--faint` as text.
- One reduced-motion block (§1.4).

## 8. Data the screens read

- Today: `data/session.json` cards (why_line, fit_line, archetype, the
  provenance bridge for stretch), joined to `data/catalog-client.json` for
  show, title, duration and artwork URL.
- Forays: `data/forays.json` (`runtime_sec`, `items[]` with `type`,
  `segment_id`, `role`), joined to `data/segments.json` for per-segment
  seconds and show; show colour by hashed show id; narration items are
  `type: "narration"` or `role: "narration"` (check the live field when
  porting; the strip must not guess).
- Artwork: loaded from the published feed URL at runtime through `safeUrl()`;
  the 2×2 foray composite is drawn on a canvas at render time and never
  persisted.
- Stat line: counts from the session's `provenance.wildcard` flags ("outside
  your usual lane" = wildcard true), rendered only when both counts exceed 0.

## 9. Open items for the builder

1. Confirm Geist and Geist Mono variable woff2 subsets fit under about 160 KB
   together; if not, drop to static 400/500/600 instances.
2. (Closed r2.) The dock is solid on both platforms; there is no
   `backdrop-filter` to test. `DIRECTION.md` §4 records the ruling.
3. (Closed r3.) FLIP is the only transition path; View Transitions are not
   feature-detected or used. The FLIP owns the artwork end to end: the
   composite is drawn when play starts and cached (4.2 states), so the
   full-size element has its bitmap before the transition begins, and the
   slot is transparent while a flyer is in the air (§5).
4. The car-route observation needs the media-session plugin to expose the
   output route; until it does, glance mode is reachable from the control
   row's overflow only, and the automatic behaviour is marked future.
5. (r1 critique) The prototype honours two URL parameters so the screenshot
   harness can render what the direction claims: `?theme=light|dark` sets
   `data-theme` on `<html>` before first paint (first statement of
   `clarity.js`, no inline script); `?state=` forces the seeded data into one
   of `firstrun`, `midlisten`, `offline`, `loading`, `find-empty`,
   `np-buffering`, `np-end`, `foray-unavailable`, `foray-unnarrated`. Both are
   documented in a comment at the top of `index.html`. Round 2 is not
   reviewable without `theme × state` shots.
6. (r1 critique) Round-2 shots ship with a short recording (Playwright video
   or GIF, 393×852) of mini → Now Playing, row → Foray detail, and the Today
   header collapse. The three signature transitions cannot be judged from
   stills. (Done r2: `r2-motion/clarity-transitions-393x852.webm`; reviewed
   as 25 fps frame tiles.)
7. (r2 critique) Round-3 recording: the same three clips re-shot after items
   1, 2 and 7, plus the Now Playing dismiss (drag and close) and one tab
   switch, all at 393×852. Round-3 shots: the same `theme × state` matrix as
   round 2, plus `state=midlisten` at all three viewports, and the density
   count from `measure.mjs` in the builder's notes. (Done r3; the dismiss
   failed review, see 8.)
9. (r4 critique) Closed: the dismiss passed all four frame checks and the
   stills match the table. No round 5. The three P2 items in
   `critique-r4.md` (Find subline, legend wording, the ~90-character copy
   ceiling in the copy test) are Phase 3 work on the port, not prototype
   work.
8. (r3 critique) Round-4 recording: the same five clips at 393×852. The
   close and the drag release are judged frame by frame on four things: no
   grey square, nothing painted over the dock, the page behind dimmed until
   the sheet is gone, the flyers landing in the mini in the frame the dock
   is clear. Round-4 shots: the full `theme × state` matrix again, and the
   density count re-measured for the three-line why (expected: 393×852
   lead + 2 full rows + the third's title; 412×915 lead + 3; 375×667 lead
   + 1 + the second's title). State the row heights `measure.mjs` finds
   (112 / 136, lead 160 / 184) in the notes.
