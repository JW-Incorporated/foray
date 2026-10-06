# Clarity, round 2 critique

Art director's review of the round-2 prototype
(`docs/redesign-2026/directions/clarity/prototype/`) against `DIRECTION.md`
and `BUILD-NOTES.md`. Reviewed: the 21 default shots in
`data-local/redesign/shots/clarity/r2/`, the 21 light shots in `r2-light/`,
the 27 state shots in `r2-states/` and `r2-states-light/`, and the recording
`r2-motion/clarity-transitions-393x852.webm`, read as 25 fps frame tiles.

Verdict: **not ready; one more round, and it should be the last.** Round 1's
six P0 items are all done and done well: the why-line is ink everywhere, the
Signal budget now holds on every screen, the unplayed strip clears 3:1 in
both schemes with the ratios written down, the light scheme is designed (not
inverted), every state exists, and the foray is the lead with its strip inside
the first viewport. What is left is the motion, which stills could not show
and which the recording now does: the two signature transitions do not do
what the direction says, and the dock is two capsules with a gap that content
leaks through. Those three change what a reviewer sees in the first three
seconds of touching the app. Everything else is a value.

Where the fault is in the direction, I have changed `DIRECTION.md` and
`BUILD-NOTES.md` and say so under "What I changed". The builder's five
deviations are each ruled on below; four are accepted and written in.

## What is right, keep it

- The board at 393 (dark and light): date, stat, foray lead with the strip,
  "Picked for you" rows with one-line titles and two-line ink why-lines, mono
  data column. This is the departures board the direction describes.
- The bridge as the loudest line on the stretch row, in `--accent-ink`, with
  the show name back in the stack. The one accident from round 1 is gone.
- Signal count per screen: Today = lead play + bridge; Library = the "Now"
  rule and word; Foray detail = Resume + playhead; Now Playing = play +
  playhead; Onboarding = one button; Find = none. The budget holds everywhere.
- Light scheme: paper and ink, Signal `#E8491D`, the strip retuned so it reads
  on white, Signal text as `#B4330C`. It is a second design, not an inversion.
- Every state is a row with an action and nothing apologises: "Offline. Saved
  episodes play. Show saved", "Nothing for 'fusion'. Fusion & energy systems
  has 5 shows" with the row under it, "Not available right now; the shows are
  still here", "No narration yet", "buffering" in place of the clock, the Up
  next title risen into the title slot at the end.
- Foray detail is finished: the back line with the eyebrow centred, display
  title, mono meta, 24px timeline with ticks, one Signal action, a 48px legend
  at one line per show.
- Find: the "Name a subject" row at 56px with the plus in a hairline circle,
  eight subjects then "All 11 subjects", the docked field in dock material.
- The unplayed-strip contrast table in the `clarity.css` header, with the
  light tokens raised per colour (72 to 83%) to clear 3:1. That is the work I
  asked for; it is now copied into BUILD-NOTES 1.1.

## Rulings on the builder's deviations

1. **Solid dock: accepted.** The direction said "no faux glass on Android" and
   named the solid fallback; the builder tested the tint at 2x and took it.
   `DIRECTION.md` §4 and the BUILD-NOTES `Dock`/`Field` rows now say solid.
   The blur is gone from the direction, not deferred.
2. **Now Playing artwork `min(100vw − 2·gutter, 56dvh − 175px, 390px)`:
   accepted.** The old rule clipped the control row at 393; the new one puts
   the transport at ~560/667 and keeps the control row on screen at 852.
   DIRECTION §11 and BUILD-NOTES 4.2 (with the budget) updated.
3. **Density lead + 4 at 393, lead + 2 at 375: accepted, target corrected.**
   The lead is 144 (two-line title, two-line why, strip) and the stat line is
   28; five rows would need 112px that the type scale does not have. The
   target in §8 and 4.1 is now four and two. Round 1 over-promised twice; this
   is the measured number and it stays.
4. **Prototype data (first-run reasons, Fusion count 5): accepted** as
   prototype values, noted in `data.json`.
5. **Onboarding one-line why-lines at height ≤ 700: not accepted.** A one-line
   why ("A long, careful guide to…") loses the reason, and the reason is the
   pitch. See item 14: two rows with two-line whys at ≤ 700, three above.

## P0: must change before round 3

### 1. Mini → Now Playing: the artwork vanishes for half a second

Recording, t ≈ 1.4–2.1 s. Frame by frame: the page dims; the dock disappears
in one frame; the 44px mini art detaches and travels up the screen for ~160 ms;
it then **disappears**, and for the next ~12 frames (~480 ms) the sheet sits
on screen with its title, strip, clocks and transport in place and a black
hole where the artwork should be; the full-size composite then pops in with no
motion. The shared element never arrives. What the direction promised, "the
44px artwork and the title are shared elements travelling to their full-size
slots", is the one transition a reviewer will touch first, and in the build it
reads as a glitch.

The likely cause is in the build: the 2×2 composite (`.art--comp`) is drawn
on a canvas when the sheet renders, after four image loads, so the slot is
empty until the draw completes, and the FLIP element is removed when its
animation ends rather than when the slot is painted.

Change:
- Draw the composite **once, when the item starts playing** (the mini player
  already shows it), keep the canvas or its `toDataURL()` in memory for the
  session, and reuse it in the mini, the sheet and the lead row. Never draw it
  during a transition.
- FLIP the mini's own art element: measure the mini rect and the sheet slot
  rect, set `transform` from one to the other on the full-size element (which
  already has the composite), animate to identity on `--t-4` `--spring`. The
  slot is never empty: if the composite is somehow not ready, the slot shows
  the mini's bitmap scaled up until it is.
- The dock stays painted under the sheet until the sheet covers it (sheet
  z-index above the dock; do not hide the dock on open). Nothing may blink.
- The title is the second shared element: FLIP `.mini__title` to the sheet
  title's rect on the same curve, opacity crossfade for the size change.
- Total 480 ms; the transport fades in from 16px below over the second half.
- Round-3 recording: the same clip, plus the dismiss (drag or close) so the
  reverse can be judged.

### 2. Row → Foray detail: the strip does not travel, the page cuts

Recording, t ≈ 5.2 s. The detail page appears in one frame (no fade), and the
timeline grows from 4px to 24px **in place** over ~3 frames (~120 ms). The
direction and BUILD-NOTES §5: the row's 4px strip is the shared element and
scales into the 24px timeline from the row's rect, 320 ms, with the page
fading in beneath it. The in-place scaleY is not that; it reads as a
flicker on the strip, not as the strip becoming the timeline.

Change: measure the row strip's rect before navigation, render the detail
page at opacity 0, set `transform: translate(dx, dy) scale(sx, sy)` on the
24px strip so it covers the row strip's rect exactly (`transform-origin: 0 0`),
then animate the strip to identity and the page to opacity 1 on `--t-3`
`--ease`. The strip's own bars keep their proportions throughout (it is the
same element). Reverse on back. View Transitions (`view-transition-name:
strip-<id>`) may replace this where supported; FLIP ships first.

### 3. The dock is two capsules, and content leaks through the gap

Shots: foray 393, library 393, mini 393. The mini player and the tab bar are
separate rounded rectangles 8px apart, each with its own shadow, and rows show
through the 8px gap (foray 393: a legend chip is visible between them at the
left; library: a row's top edge). The `--bg` shelf under the tab bar hides the
gutters but not the gap. DIRECTION §4 says one capsule; BUILD-NOTES said "8px
apart", which contradicted it. That was my contradiction; it is now resolved
as one capsule.

Change (BUILD-NOTES `Dock` and `MiniPlayer` rows updated):
- One container: radius 24, background `--dock`, one `--shadow-dock`, one
  hairline inset. Inside it: the mini player (64) on top, a hairline, the tab
  bar (56) below. No gap, no shelf. Dock height 120 + `--safe-b` + 12.
- The mini's 2px progress line sits **inside** the capsule at its top edge,
  inset 20px from each side so it clears the radius; track `--line-strong`,
  fill Signal, both `border-radius: 1px`. Today it floats on the capsule's
  outer edge and starts left of the radius (foray 393, library 393), which
  reads as a stray mark.
- Mini hidden: the capsule is the tab bar alone (56); the mini slides out
  with `translateY` and the capsule height follows on `--t-2`.
- The docked Find field sits 8px above the capsule, unchanged.

## P1: should change

### 4. Lead eyebrow wraps at 375

Home 375: "Today's lead · Foray · 7" / "shows", and the lead grows to 160. The
stack at 375 is 175px wide; that string is ~190px at 13px. The fix is anatomy,
not copy per viewport: the lead gets the same two caption lines as every other
lead (first-run shows it already: "Picked to start" / "Lex Fridman Podcast").

Change (DIRECTION §11, BUILD-NOTES `Row--lead` and 4.1 updated): eyebrow
`caption` muted "Today's lead" (one line, `white-space: nowrap`), then the
show line `caption` `--ink` 500: the show name, or for a foray "Foray · 7
shows". Then the two-line title, the why, the strip. Lead min-height 144.

### 5. Mid-listen: the "Resume" capsule eats the stack

State midlisten, 393: the lead's capsule reads the word "Resume" on a 160px
Signal pill; `.row--lead.row--resume` widens the data column to 92px and the
title and why rewrap to "The types of capital / a startup can raise",
"Venture money is / one option of eight;…". The data column is 72px and holds
numbers; a word does not fit it. That instruction was mine (r1 item 5) and it
was wrong.

Change (BUILD-NOTES 4.1 updated): the lead's control is always the 44px
Signal circle (play glyph; `aria-label` "Resume" when mid-play). Mid-play, the
duration under it becomes the remaining time in two lines: "35 min" `data`
and "left" `data-sm` muted, the same form the Resume rows use. Remove the
92px column variant.

### 6. Resume rows: missing progress line; define the row

State midlisten, 393: the two Resume rows (show, title, "20 min / left") have
no why-line, which is right (you already chose it), but also no 2px Signal
progress line under the artwork, which 4.1 asks for and which is the only
thing that says "in progress" without reading the data column.

Change (BUILD-NOTES component table: `Row--resume` added): art 56 ·
stack(show `caption` muted, title `body-strong` 1 line) · data "28 min" `data`
+ "left" `data-sm` muted; a 2px Signal progress line under the artwork, the
artwork's width, 4px below it, track `--line-strong`; height 80 (12 + 56 + 12).
Hairline as other rows.

### 7. Today header collapse snaps instead of animating

Recording, t ≈ 7.8 s: the display date is 34px mono in one frame and 13px
caption in the next; no intermediate frame at 25 fps, so the class toggle
runs with no transition, or transitions `font-size` (which the build rules
forbid and which browsers drop). The scroll-driven path (`animation-timeline:
scroll()`) is not in effect either.

Change: two elements in the header line, the `data-lg` date and the `caption`
date, both present; past 48px the large one goes `opacity: 0; transform:
translateY(-8px) scale(.6)` (`transform-origin: 0 50%`) and the small one
comes from `opacity: 0; translateY(8px)` to identity, both on `--t-3`
`--ease`; the sticky line gains its hairline at the same time (`border-color`
on a hairline is a permitted colour transition at that size). Where
`@supports (animation-timeline: scroll())` holds, the same two keyframe sets
run over the first 48px of scroll. The round-3 recording shows it.

### 8. Now Playing: the gap under the why-line is still ~52px

Now-playing 393 (2x): the why's last line box ends at y ≈ 1010 and the strip
begins at y ≈ 1118, 54px at 1x. The builder reports 32; the measurement in
the shot says the strip container carries extra top space (tick row,
`.scrub` margin plus the strip's own padding). The number that matters is
from the why's last line to the top of the 24px strip: **32px**, measured in
the shot. The surplus goes below the control row, where there is now room.

### 9. Bridge wrap order at 375

Home 375 (both schemes): "fusion →" / "materials science". The arrow is
stranded at the end of the first line, pointing at nothing. Round 1's
wording ("nowrap on the from → pair") caused this; the right rule is the
opposite.

Change (BUILD-NOTES `Bridge` row updated): `white-space: nowrap` on the
**arrow + to** pair; the only break allowed is between `from` and the arrow,
so the second line begins with the arrow: "fusion" / "→ materials science".
At 393 it stays on one line.

### 10. Offline: muted rows keep a full-Signal bridge and full-colour art

State offline, 393: the SYSK row is muted (text `--muted`, `aria-disabled`)
but its bridge is still `--accent-ink` at full strength, so the one unplayable
row is the loudest on the screen, and every muted row's artwork is as bright
as the playable ones'.

Change: in the offline-dimmed row, the bridge and the word Stretch take
`--muted`; artwork `opacity: .5`. This is the one named exception to
"disabled: no opacity change" (BUILD-NOTES 1.1 rules updated), because the
artwork has no foreground colour to swap.

### 11. Find idle: the first screen is all text

Search 393: the "Name a subject" row and eight 56px subject rows fill the
viewport to the docked field; "Shows you follow" (the first artwork on the
page) sits under the field. The board idiom is text, but a page with no
artwork above the fold is the only such page in the app and the one that
should invite browsing.

Change (BUILD-NOTES 4.4 updated): six subjects, then "All 11 subjects"; the
"Shows you follow" head and its first row enter the first viewport at 393.

## P2: polish

12. **Hour durations align on the column.** "3h 14m" over "3h 5m": the `h`
    shifts one character between rows, which a mono column exists to prevent.
    Pad minutes to two digits when hours are present: `3h 05m`. In `fmtMin`
    only (BUILD-NOTES copy note updated).
13. **"buffering" sits off the clocks' baseline.** State np-buffering: the
    word (`data` 15) and "-35:08" (`data-lg` 22) are vertically centred, not
    baseline-aligned. `align-items: baseline` on the clock row.
14. **Onboarding at height ≤ 700: two rows, two-line whys** (ruling 5 above),
    three rows above 700. And the sample rows carry **no bridge**: on first run
    nothing is observed, so "fusion → materials science / You care how…" would
    claim a lane 4a has not seen. The build already omits it; the direction
    now says so (DIRECTION §11, BUILD-NOTES 4.7). Stretch appears on Today
    once there is a lane to stretch from.
15. **Skeleton geometry.** State loading: skeleton rows have no hairlines and
    no data-column block, so the skeleton is lighter than the rows it stands
    for, and the crossfade to content will jump. Add the hairline and a 40×16
    `--surface` block in the data column per row, and the 4px strip block
    under the lead.
16. **np-end notes belong to the finishing item.** State np-end shows Weather
    Geeks in the title slot with the notes "Zero homework: Conan and an old
    friend…" below. Prototype data wiring; the notes section should show the
    item still playing until the swap completes, then the new item's.
17. **Library: 55px between "All 14 shows" and "Forays".** The text-button row
    carries its own 44px line plus the 32 section gap plus the head's 24
    margin. After a text-button row the next head's margin-top is 8, not 24.
18. **Subject names are mixed case in the data** ("Mental Health", "Energy
    Grid" beside "AI & robotics", "Casual hangs"). Not a build fault: the
    taxonomy names arrive as-is. Flag for Phase 3: the board renders subjects
    in sentence case, so the taxonomy's display names need a pass (proper
    nouns kept). Do not transform at render time.
19. **Collapsed header hairline.** Confirm in the round-3 recording that the
    sticky 44px line carries a `--line` hairline once collapsed; at the
    recording's scale it cannot be seen.

## Motion, judged from the recording

- Mini → Now Playing: see item 1. Not acceptable as is.
- Row → Foray detail: see item 2. Fast and flat, but the shared element does
  not travel.
- Today header collapse: see item 7. A snap.
- Round 3 ships the same three clips plus the Now Playing dismiss, at 393, and
  the tab switch (which should be instant, with the active icon's stroke
  stepping 1.75 → 2.25 on `--t-1`).

## What I changed in the direction

- `DIRECTION.md` §4: the dock is solid, one capsule, the only shadow; the
  blur is gone. §8: density target is lead + four at 393×852, lead + two at
  375×667; the lead is 144. §11: lead anatomy (eyebrow "Today's lead", then
  the show line, which for a foray is "Foray · 7 shows"); Now Playing artwork
  `min(100vw − 40px, 56dvh − 175px, 390px)`; onboarding rows carry no bridge
  and drop to two rows at ≤ 700 high; the mid-play lead keeps the 44px circle
  and shows remaining time.
- `BUILD-NOTES.md` 1.1: `--dock` solid values; unplayed-strip table filled in
  from the builder's measurements (light per-token, dark 62%); the offline
  artwork opacity exception. 1.3: `--dock-h` 120 (one capsule), `--row-lead`
  144, `--row-resume` 80. Component table: `Dock`, `MiniPlayer`, `Row--lead`,
  `Row--resume` (new), `Bridge`, `Field` updated. 4.1: lead and mid-listen
  rules, density, section-head margin after a text-button row. 4.2: artwork
  rule and the budget recomputed. 4.4: six subjects. 4.7: two rows at ≤ 700,
  no bridge. §5 motion table: the three transitions restated with the FLIP
  mechanics from items 1, 2 and 7. Open items: composite pre-render; round-3
  clips.

## Ready?

No. Items 1–3 are the signature moment and the one piece of chrome on every
screen; a round that fixes them changes what the app feels like to touch,
which is what the pick will be made on. The stills are close to done; after
round 3 I expect nothing but values.
