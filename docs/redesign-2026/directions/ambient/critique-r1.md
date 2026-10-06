# Afterglow: round-1 critique

Art director's review of the round-1 prototype
(`prototype/`), 2026-10-05. Shots reviewed: the orchestrator's set in
`data-local/redesign/shots/ambient/r1/` (seven routes, three viewports,
default state only) plus a set I shot myself in
`data-local/redesign/shots/ambient/r1-ad/`: Dawn on six routes, the lower
two-thirds of Today and Library, and the `firstrun`, `offline`, `loading`,
`empty`, `results`, `noresults`, `paused`, `ending`, `unavailable`,
`unnarrated` states, car posture and `textscale=1.3`. (How: serve
`prototype/` over http and pass `?state=` on the URL; the harness refuses a
query on a file path, and under Git Bash the route `#/home` must be passed
with `MSYS_NO_PATHCONV=1` or it becomes a Windows path.)

**Verdict: not ready. One more round is needed and will materially change
it.** The bones are right: the type pairing holds, the Dusk neutrals are
warm without going purple, the strip reads as a map, the Stretch bridge line
is the right idea, Dawn works on first sight. What is missing is the thesis.
"The artwork is the light source" is not yet visible on any screen except the
Foray detail: the Room is a flat colour band, the Glow on the chrome is
below perception, and Today's wash is a faint brown. Alongside that there are
four layout defects a founder would hit in the first minute.

Items are in priority order. Each has the fix with values. The direction
changes I made having seen it built are marked **[direction change]** and
are recorded in `DIRECTION.md` ("Changed after round 1") and in
`BUILD-NOTES.md`.

## P0: defects

### 1. The Stretch card is broken

`data-local/.../r1-ad/home-off1`: the meta row below the bridge renders as a
one-word-per-line column ("The / Ancients / · / 61 / min"), the Play button is
stretched into a full-width ellipse, and there is no episode title. Cause:
`.stretch .ep` has `align-items: center` but the button has no `flex: none`
and the text column's children are not block-level.

Fix. Below the bridge, the row is the EpisodeRow anatomy minus the art:
title `--t-headline` 2-line clamp; caption `show · duration · date`
(`--t-caption`, `--text-2`, one line, ellipsis); trailing Play 44 outlined
with `flex: none; width: 44px; height: 44px`. Text column `flex: 1 1 auto;
min-width: 0`. The two arts stay 56 with `--r-sm`; the line stays 2px Lamp
with the 6px dot. Card padding 16. Pill "Stretch" 22 tall top-left, as built.

### 2. The Room is a gradient, not the artwork

`afterglow.css` `.room-bg::before` is `radial-gradient(... var(--glow) ...)`;
`--room-art` is never set. Now Playing therefore shows a flat cornflower band
over a neutral charcoal, and the middle third (around the title) is a muddy
grey-blue. The direction's Room is the artwork at 64px blur under the scrim,
and this is the single most visible difference between "lit by the art" and
"tinted".

Fix, in `.room-bg`:
- `::before`: `background: var(--room-art) center / cover; filter: blur(64px)
  saturate(130%); transform: scale(1.4); inset: -12%; opacity: 0.9`. Set
  `--room-art` from script with `setProperty('--room-art', 'url("…")')`
  after `safeUrl()`. A CSS background does not need CORS, so this works for
  every publisher.
- Keep the radial Glow gradient as a second layer **under** the art (it is
  the fallback while the image loads and for a missing image).
- The base colour of `.room-bg` is `color-mix(in oklab, var(--bg0) 85%,
  var(--glow) 15%)`, not `var(--bg0)`, so the lower half stays in the show's
  colour instead of going neutral. **[direction change]** Text on that base
  is still above 10:1 for any clamped Glow; add the pair to
  `contrast-check.mjs` and print the number.
- Foray: on a segment change crossfade two `::before` layers (the spec's 560ms
  `--m-room`), and the Room follows the current segment's show. Today's shot
  does follow (Run the Numbers is blue) but only because the gradient reads
  the segment's Glow; keep that logic, feed it the art too.

### 3. Discover's chrome stack eats the screen

With the mini player present, Discover shows three floating lozenges at the
bottom (field 52, mini 64, tabs 64, three gaps) = 208px of chrome at 393, a
third of a 375x667 screen. Content shows through the 8px gaps between them
("The loan at the…" peeks between mini and tabs on Today, too), which reads as
a bug on every tab.

Fix **[direction change]**: one **Dock**. The mini player and the tab bar
are one `.veil` surface, `--r-xl`, inset `--gutter`, 12px above safe-bottom;
rows inside it are separated by a 1px `--rim` line, no gaps. On Discover the
search field is the Dock's top row (48 tall, pill inside the surface with 8px
inset) and the tab bar drops to its receded 36px state (icons 24, no labels)
whenever the field is present, so Discover-with-mini is 48 + 64 + 36 = 148px.
Today-with-mini is 128. While the field has focus the mini and tab rows hide
(as specified). The 2px Glow progress line runs along the top edge of the
Dock (or of the mini row when the field is above it). Blur area is the Dock's
height only; keep the `@supports not` and reduced-transparency fallbacks.

### 4. Show names cut mid-word

Discover "Shows you follow", 4-up at 393: "Freakonomic / Radio" and
"Unexplainabl" are clipped by overflow with no ellipsis. The direction says
titles never cut. 4-up gives 79px columns; "Unexplainable" at the spec'd 13px
caption is 85px wide.

Fix **[direction change]**: every ShowTile grid is 3-up (art 104 at 393, 96
at 375, 112 at 412), names `--t-caption` 2 lines, `overflow-wrap: normal`,
`text-overflow: ellipsis`. And item 10 below removes this grid from Discover
entirely, so the only ShowTile grids are Library and "Where this came from".

### 5. Car posture clips the Play button and double-spaces the title

`r1-ad/np-car` at 393x852: the 112px Play's bottom edge is off-screen, and
the Display title shows a line gap of roughly a full line because the 1.25x
multiplier hit the line-height differently from the size.

Fix: the three type tokens scaled in car posture use unitless line-height
(`--t-display: 500 2rem/1.125`, `--t-headline: 500 1.25rem/1.2`, `--t-label:
600 0.875rem/1.3`) so size and leading scale together. In car posture hide
the why-line and the "More" handle, artwork 240 (200 under 700px tall), and
assert in the harness that the Play button's bottom edge is at least 24px
above the viewport bottom at 393x852 and 375x667.

### 6. Library empty state shows counts for empty sections

`r1-ad/library-empty`: "Saved 3", "Playlists 4", "Up Next 6" beside "Nothing
saved yet." Counts come from the seed data, not the state. Hide the count when
a section is empty. Also give the first block a line that names the section:
"Nothing followed yet." + "Find shows" (today it reads "Nothing here yet."
under the screen title with no head).

### 7. First run duplicates the hero in the list

`r1-ad/home-firstrun`: the hero is the first pick, and the first row of
"Today's picks" is the same episode. When the hero is a pick, the list starts
at the second pick and the count reads 4.

## P1: the thesis is not visible

### 8. The Glow is below perception on the chrome

The mini player and tab bar on Dusk read as neutral dark brown while an
orange-and-black episode plays. 18% in oklab over `#14110F` lands at L≈0.22,
which the eye reads as "dark".

Fix: `--glow-veil: color-mix(in oklab, var(--bg0) 72%, var(--glow) 28%)`,
`--glow-row: color-mix(in oklab, var(--bg1) 82%, var(--glow) 18%)`, and the
Dusk Glow clamp `L = 0.66` (Dawn stays 0.56). Re-run `contrast-check.mjs`
with the new mixes and record the worst case; it should still clear 7:1. The
Keep-listening row while playing must be visibly warmer than the row below
it in a screenshot; if it is not, the mix is still too low.

### 9. Today's wash is a flat brown band

The spec'd linear 40vh wash exists but reads as a slightly warmer page. The
hero collage is the lamp; the light should come from it.

Fix: `.wash { height: 48vh; background: radial-gradient(120% 70% at 22% 20%,
var(--glow-wash) 0%, transparent 70%), linear-gradient(var(--glow-wash),
var(--bg0)); }` with `--glow-wash` at 60/40 (`bg0 60%, glow 40%`). The
`--glow` on Today is the hero's first show, as built. Loading keeps the
default Glow. On Dawn the pink wash already reads (`r1-ad/dawn-home`); the
radial will make it read as coming from the collage.

### 10. Discover opens with the Library

**[direction change]** "Shows you follow" at the top of Discover is the same
grid Library opens with, and it pushes the subjects (the reason the screen
exists) below the fold. Remove it from Discover. Discover idle = title, then
the five subject groups, SubjectTiles 2-up. Library keeps the followed grid.

### 11. The SubjectTile collage reads as a glitch

The 48+32+32 stack shows one art with a sliver of a second behind it
("Physics and cosmos" = Lex Fridman plus a 4px strip). At this size three
overlapping arts cannot read.

Fix: SubjectTile collage = a 56px 2x2 of the subject's first four shows,
`--r-sm`, 2px gaps (the same Collage component as forays); name `--t-label`
14/18 (built is larger); "21 shows" `--t-caption` `--text-2`. Tile 72 tall,
2-up, padding 12, gap 12.

### 12. Strip thumbnails overlap the bars

Foray detail: the 20px thumbs sit half over, half under the bars, and the
Y thumb under the current bar collides with its ring.

Fix: at 48 tall the strip is two rows: bars 24 on top, then a 4px gap, then a
20px row of thumbs, each thumb left-aligned under its bar, only on bars 28px
or wider, never overlapping a bar. At 32 (Now Playing) and 12 (cards) there
are no thumbs. **Current bar: no ring** (the 1.5px `box-shadow` is a
hairline, which the direction bans); instead the current bar is 28 tall
(the others 24, all centre-aligned) at full opacity with its fill in
`color-mix(in oklab, var(--c) 85%, var(--lamp))`. In Now Playing the same
rule at 16/20.

### 13. Why-lines truncated to one line

Every row shows "Why déjà vu is a sign of a healt…". The why-line is the
product's main copy element and the copy rule caps it at 18 words precisely
so it can be read.

Fix **[direction change]**: why-lines in EpisodeRow and QueueRow clamp at
2 lines. Row min-height 96 (was 80). 7-8 rows per viewport instead of 8-10,
accepted.

### 14. Now Playing: the empty band and the double "Now"

At 393x852 and 412x915 there is ~95px of nothing between the why-line and
the strip because the stack is pinned top and bottom. At 375x667 the layout
is correct. And "Now: Run the Numbers" appears twice: an eyebrow above the
title and again in "4 shows · Run the Numbers".

Fix:
- Artwork grows with the viewport: `--np-art: clamp(220px, 100vh - 520px,
  320px)` on screens 760px tall or more, so the surplus goes into the art
  and why→strip stays 24. Keep the 220/180 rules below 700px.
- The eyebrow slot above the title is reserved (18px) and holds only the
  **transient** Lamp caption "Now: <show>" for 3s after a segment change
  (and for 3s after the sheet opens), then fades. The permanent show line
  under the title stays as built. **[direction change, recorded]**

### 15. Hero title size

Today's hero uses `--t-display` (32/36) in a 193px column: four lines. The
spec is `--t-title` 26/30, 3-line clamp. At 26px the sample title is three
lines. The why-line spanning the full width under the row is the builder's
call and it is the right one; keep it and it is now in the spec. Collage 160
at 393, 136 at 375, as built.

### 16. Library foray cards

The full ForayCard at 3-up (104 wide) truncates every title ("The types of
capital a…") and makes row one twice the height of rows two and three.

Fix **[direction change]**: in the Library grid a foray is a compact tile:
collage 104 `--r-md` with an 8px strip along its bottom edge inside the
radius, name `--t-caption` 2 lines, a 16px Lamp "Foray" pill at the
collage's top-left. The full ForayCard (2-up, 164) is for Today only if a
second foray ever appears there.

## P2: polish

17. **Skeleton sweep** has a hard left edge (`r1-ad/home-loading`). Use
    `linear-gradient(90deg, transparent 0%, var(--overlay) 50%, transparent
    100%)` at 40% width with `background-size: 40% 100%` and ease the
    keyframe from -40% to 140%.
18. **Offline**: the banner is right; the rows below it do not dim. In the
    prototype mark two of the five picks downloaded (`i-download-fill`
    `--ok` before the duration) and put the other three in the unavailable
    state (art 50%, `i-wifi-slash` `--warn`, Play disabled).
19. **Search results** lack the "Make a playlist from 'money'" Primary button
    at the bottom (present in `noresults`, missing in `results`).
20. **`?state=ending`** renders the default frame. Show the handoff: next
    artwork at 60% of its travel from the right, current at -24% x and 40%
    opacity, Room half-crossfaded, title already swapped, a Lamp caption
    "Up next".
21. **Skip glyphs**: back-15 and forward-30 are drawn at ~28 inside 56; draw
    at 36 so they are not dwarfed by the 88px Play.
22. **Resume copy**: "Resume · 12 min left" (middle dot, as every other
    caption), not a comma.
23. **Onboarding**: keep the scattered sleeves (it is on-thesis and better
    than the strip-only idea); set rotations -8, 4, -3, 7 degrees and
    opacity 1 with `--shadow-2` plus `0 24px 48px rgb(0 0 0 / 0.4)`. Tighten
    the gap under the body copy: the sleeves + strip + copy block centres in
    the space above the buttons. The wordmark may stay here (spec updated:
    Today header and onboarding).
24. **Tab bar inert label colour** is `--text-2`; fine. The active label is
    `--text`; fine. No change, noted so nobody "fixes" it.
25. **Eyebrows**: "Today's foray", "Foray · Building companies" and the
    Library "Foray" are `--text-3`. 4a-authored eyebrows are `--lamp`
    (`.eyebrow.lamp` exists; apply it).

## What round 2 must shoot

The default-state top-of-screen set hid items 1, 6, 7, 11, 13, 16, 18, 19
and 20 entirely. Round 2's contact sheets must include, at 393x852 and
375x667, Dusk and Dawn:

- Today: `returning`, `firstrun`, `midlisten` (with mini), `offline`,
  `loading`, and the lower half of the page (Stretch card, Playlists rail,
  Off your path).
- Now Playing: `foray`, `episode` (scrubber), `paused`, `ending`, `car`,
  `textscale=1.3` at 375x667, and the detail posture (scrolled).
- Discover: idle, `results`, `noresults`, `kb`.
- Library: default (full length), `empty`.
- Foray: default, `unavailable`, `unnarrated`, and the segment list.
- Onboarding, with reduced motion.

The prototype scrolls inside `.screen`, so the harness's `--full` does not
help; the builder should either expose `?scroll=<px>` on the prototype or
add a `--scroll` option to `tools/ui-lab/shoot.mjs` (harness owner's call;
the prototype query is the smaller change).

## Round verdict

Not ready (`ready=false`). The next round changes the Room, the Dock, the
Glow mixes and the row anatomy, all of which change every screen. After
that round I expect the remaining work to be polish.
