# Clarity, round 3 critique

Art director's review of the round-3 prototype
(`docs/redesign-2026/directions/clarity/prototype/`) against `DIRECTION.md`
and `BUILD-NOTES.md`. Reviewed: the 21 default shots in
`data-local/redesign/shots/clarity/r3/`, the 21 light shots in `r3-light/`,
the 27 state shots in `r3-states/` and `r3-states-light/`, and the recording
`r3-motion/clarity-transitions-393x852.webm`, read as 25 fps frame tiles
(the builder's two tiles plus my own for the close, the drag, the row to
Foray detail and back, and the tab switch; tiles in `r3-tools/crops/`).

Verdict: **not ready; one more round, and this time it is values plus two
mechanics.** Round 2's three P0s are done as asked: the artwork never
vanishes on open, the strip travels into the timeline, the dock is one
capsule. Seventeen of nineteen items are closed and the builder's six
deviations are all accepted below. The stills are a departures board.

What is left is one fault in the direction that three rounds of stills have
been showing me and I accepted twice, and one transition the round-2
recording could not show because it did not exist yet:

1. **Every why-line on the board is cut off.** Forty of forty hooks in the
   prototype's data truncate at two lines in a 201px column. The row's
   whole argument is "4a picks a few episodes and says why"; the build
   shows the reason for seven words and then an ellipsis, on the lead, on
   every pick, and on all three onboarding rows under a headline that
   promises the why. That is the direction's geometry, not the builder's
   choice, and it is changed below.
2. **The Now Playing dismiss is debris.** The open is right; the close
   sends an empty grey 300px square, the close button and the grabber
   sliding down over the dock while the page behind snaps to full
   brightness in the first frame.

Where the fault is in the direction I have changed `DIRECTION.md` and
`BUILD-NOTES.md` and say so under "What I changed".

## What is right, keep it

- Mini to Now Playing, open: the mini's art and title fly to their slots
  on the sheet's own spring, the dock stays painted under the sheet, the
  transport fades in from below. Judged frame by frame; no hole, no pop.
- Row to Foray detail: the row's 4px strip is the element that becomes
  the 24px timeline; it is mid-travel in the second frame and home in the
  fourth. Back reverses it. Fast and flat, as the direction asks.
- The dock: one capsule, one shadow, one hairline between the mini and the
  tab bar, nothing leaking through. The floating 12px margin shows rows
  scrolling past, which is a floating dock doing what floating docks do.
- Today header collapse: two date elements, a real intermediate frame, the
  hairline arriving. Tab switch instant with the stroke step.
- Lead anatomy at 375: "Today's lead" / "Foray · 7 shows" on two caption
  lines, no wrap. Mid-play: the 44px circle stays and the column reads
  "44 min / left". Resume rows carry the 2px Signal line under the art.
- The bridge wraps "fusion" / "→ materials science" at 375.
- Offline: the one unplayable row is now the quietest on the screen
  (muted bridge, half-opacity art), and the saved badge marks the rest.
- Now Playing strip: played bars full, unplayed at 62%, the current bar
  half-filled at the playhead, hatched narration gaps, Signal playhead
  through the bar, "buffering" on the clocks' baseline. This is the
  scrubber the direction describes.
- `3h 05m` aligns the `h` down the column. Find idle has artwork in the
  first viewport. Skeleton rows have hairlines and data blocks. Light
  scheme holds everywhere, including the strip's retuned unplayed tokens.
- The 34px Geist Mono date on Today. BUILD-NOTES said `data-lg` (22); the
  build set it at display size and the build is right. The token is now
  written down (1.2, `--t-data-display`).

## Rulings on the builder's deviations

1. **Lead 160, not 144: accepted.** The anatomy adds to 160 with a two-line
   why; it adds to 184 with the three-line why below. `--row-lead` is now
   the min-height 160 and the notes carry both numbers.
2. **Dock height animates 56 to 120: accepted.** One non-transform
   animation on a 64px change, clipped by the capsule, is cheaper than the
   alternative (a translateY on the tab bar plus a resized clearance).
3. **View Transitions gone, FLIP only: accepted.** One path to test on
   two WebViews is the right trade; `DIRECTION.md` §6 and §12 now say FLIP.
4. **Row to Now Playing flies the row's art: accepted.** The shared
   element is whatever the user tapped.
5. **12px floating margin shows rows: accepted.** See above.
6. **No light-scheme motion recording: accepted.** Nothing in the motion
   is scheme-dependent.

## P0: must change before round 4

### 1. The why-line never fits; the row geometry is wrong, and it is mine

Measured in home 393: the board stack is 201px wide (393 − 40 gutter − 56
art − 12 − 12 − 72 data column). Geist at 17px sets about 8.4px per
character here ("Venture money is one" = 167px), so a line holds 24
characters and the two-line clamp holds 48. The prototype's forty hooks
run 65 to 113 characters (median about 90); the copy rule allows 16 words,
which is about 100. So the clamp cuts every one of them, and the lead
(185px stack, 94-character why) is cut at "see…". Onboarding 393 shows the
headline "picks a few episodes and says why" over three rows that each stop
saying why mid-clause. The r1 critique moved the why to ink so it would be
the loudest line on the row; a loud line that ends in an ellipsis on every
row is worse than a grey one that finishes.

The fix is anatomy, not copy. The data column exists for numbers on one
line at the top of the row; nothing it holds is taller than 20px (the
duration) or 64px (the lead's circle and duration). The why starts at
least 40px below the row's top (caption + title) and 96px on the lead.
So the why can pass under the data column without ever meeting it.

Change (`DIRECTION.md` §8 and §11, BUILD-NOTES `Row`, `Row--lead`,
`Row--stretch`, `Strip`, §3 and 4.1 updated):
- `.row__why` spans from the stack's left edge to the right gutter: in the
  row grid it is a second grid row, `grid-column: 2 / -1`; the show line,
  the title and the data column stay in the first grid row. At 393 that is
  285px for board rows (34 characters a line) and 269px for the lead (32).
- The why clamps at **three** lines, not two. Two lines (68 characters)
  fit 13 of the 40 hooks; three (102) fit 37, and the three longest lose
  their last word or two. Rows are content-sized: 112 with a two-line why,
  136 with three. Both are multiples of 8; the hairline rhythm holds.
- The lead's why likewise, under its circle column: lead 160 with two
  lines, 184 with three. The stretch row adds its 20px bridge line: 136 or
  160.
- The 4px strip under a foray row spans the same width as the why
  (stack-left to the right gutter), not the stack column. In home 393 it
  is 186px for 22 bars; it becomes 269px on the lead and 285px on a board
  row, and the bars become legible as bars.
- Density, re-measured for the direction: at 393×852 the first viewport
  holds the lead and two full rows plus the third row's title; at 412×915
  the lead and three; at 375×667 the lead and one plus the second's title.
  That is down from lead + 4 / 4 / 2 and it is the right trade: four rows
  that each say seven words are not denser than three that finish. Board
  titles still clamp to one line; that stays, because the title is
  metadata and the why is the destination. Measure it in round 4 and put
  the numbers in the notes.
- Onboarding: the same rows, so the sample whys finish. At viewports 700px
  high or less the budget no longer closes with a 34px headline (48 + 114 +
  24 + 272 + 24 + 24 + 8 + 72 + 44 + 8 + 44 + 16 = 698 > 667), so at ≤ 700
  the headline is set at `title` (22/26) with 32px top padding: 636. Two
  rows there, three above, as before.
- Skeleton rows: three why bars, 136 high (most hooks will be three lines;
  the crossfade jumps 24px on the short ones, which is the smaller lie).
- Now Playing's why (muted, under the show line): three-line clamp at
  viewports over 700px high; the segments head drops below the fold at
  393, which is fine. At ≤ 700 the build clamps it to **one** line
  (`clarity.css` line 470); the r2 budget was computed with two (534 <
  667) and the one-line why in now-playing 375 is "Venture money is one
  option of eight; see…", which says nothing. Two lines at ≤ 700.

### 2. Now Playing dismiss: the sheet leaves its furniture behind

Recording, t ≈ 3.7–4.0 s (close button) and the tail of the drag release.
Frame by frame at full resolution (`r3-tools/crops/tile-close-full.png`):

- Frame 2 (40 ms in): the page behind is at **full brightness** already;
  the scrim is gone in the first frame instead of fading with the sheet.
- Frames 2–6: a 300px `--surface` square with a hairline, empty, rides
  down with the sheet while the art bitmap flies separately and shrinks
  inside and then outside it. It is the sheet's own art slot:
  `.np.is-flying .np__art > * { visibility: hidden }` hides the slot's
  content but the slot keeps `background: var(--surface)` and its inset
  hairline (`clarity.css` 383, 365), so an empty grey tile travels the
  whole way. On open the same tile rises and the flyer lands in it, which
  reads as a frame; on close the flyer leaves it and it reads as debris.
- Frames 2–7: the close button, the grabber, the show line and the why
  text slide down with the sheet at full opacity, **over** the dock
  (the sheet is above the dock, correctly, so its chrome paints over the
  tab bar until it has fully left the screen). The "×" is visible under
  the tab bar in frames 6 and 7.
- The title flyer lands in the mini two frames after the dock is clear.

The open is the reference; the close must be the open played backwards.
Change (BUILD-NOTES §5 "Mini → Now Playing", `Sheet` row updated):
- Scrim: opacity 1 → 0 over the full dismiss duration, linear, on the same
  animation group as the sheet. If the scrim is being hidden by the
  hashchange path before `closeNP` runs, that is the bug to find.
- While `.is-flying`, in both directions: `.np__art { background:
  transparent; box-shadow: none }`. The slot is invisible until the flyer
  lands (open) and from the moment the flyer leaves (close). Nothing but
  the two flyers and the plain sheet surface moves.
- On close, the sheet's content (everything in `.sheet__in` except the
  flyer sources: top bar, show line, why, strip, clocks, readout,
  transport, control row, sections) fades to 0 over the first `--t-1`
  (120 ms) of the 320 ms exit, so nothing with text or glyphs crosses the
  dock. On open the mirror is already there for the transport (fade in
  from 16px below over the second half); extend it to the rest of the
  content so open and close are symmetric.
- The sheet keeps translating on `--t-3` `--ease` (an exit is faster than
  an entrance and never overshoots into the dock); the flyers travel on
  the same duration and curve from their sheet rects to the mini rects.
  Drag: unchanged, the sheet follows 1:1 and the release runs this from
  the current offset, as the build already does.
- Round-4 recording: the same five clips. The close is judged on: no grey
  square, nothing painted over the dock, the page behind dimmed until the
  sheet is gone, the flyers landing in the mini in the frame the dock is
  clear.

## P1: should change

### 3. Library grid names are off-spec and truncate

Library 393: "Lex Fridman Pod…", "Stuff You Should…", "Conan O'Brien N…",
"FermUp - The Fe…": four of six names cut, set at `body-strong` 17px under
112px cells. BUILD-NOTES 4.5 says `caption`. Change (4.5 updated): name at
`caption` (13/16) `--muted`, **two-line** clamp, 4px under the art; cell
height grows 16px. "Lex Fridman Podcast" wraps instead of truncating.

### 4. Up Next rows: a bare number says nothing about what it is

Library 393, Up Next: the Now row reads "35 min", row 2 reads "38 min".
Thirty-five is the remaining time of a 54-minute foray at 18:35; the row
cannot say so and the reader cannot tell remaining from total. Change
(BUILD-NOTES `Row--queue` updated): a started item shows "35 min" `data`
over "left" `data-sm` muted, the same two-line form as the Resume rows
and the mid-play lead; an unstarted item shows its duration on one line.
64px holds the two lines (20 + 16).

### 5. The Up Next count disagrees with itself

Now Playing control row: "8 / Up Next". Library head: "Up Next 9". One
counts the playing item, one does not. Rule: the count is the items
**after** the one playing, everywhere. Both read 8.

## P2: polish

6. **Mini progress line reads as a brighter patch of rim.** Dock crop at
   4x: the 2px line sits on the capsule's top edge over the hairline; its
   track is `--line-strong` (24%) between 20px insets while the rim is
   `--line` (16%), so the rim looks doubled in the middle. Make the track
   `--line`, the same as the rim; only the Signal fill reads, and the
   capsule's top edge filling with Signal as the item plays is the design.
   (BUILD-NOTES `MiniPlayer` updated.)
7. **np-end swaps the artwork three seconds early.** State np-end: Weather
   Geeks art at 56:57 / -0:03 of the Conan episode. The Up next line rising
   into the title slot at -0:03 is right; the artwork stays the finishing
   item's until 0:00, then crossfades on `--t-3` with the title's second
   step. (BUILD-NOTES 4.2 end-of-item updated.) The notes section already
   follows the finishing item, as asked.
8. **Mid-listen data disagree.** State midlisten: the lead reads "44 min
   left" for the foray that the mini, the Library Now row and the detail
   button ("Resume at 18:34") all place at 35 left. Prototype wiring; one
   source of position per item.
9. **Row to Foray detail crossfade muddles two text pages for ~80 ms.**
   Frames 2–3 show the home rows and the detail page both at about half.
   Acceptable at 320 ms; if the builder has a cheap improvement, fade the
   old page's **text** on `--t-1` while its background stays until
   covered, so only one page's words are ever legible. Not required.
10. **Subject names in mixed case** ("Mental Health", "Decision Making")
    beside "AI & robotics": still a Phase 3 taxonomy pass, not a build
    fault. Carried from r2 item 18.

## Motion, judged from the recording

- Mini → Now Playing, open: right.
- Now Playing → mini, close and drag release: item 2. Not acceptable.
- Row → Foray detail and back: right (item 9 is optional).
- Today header collapse: right; the hairline arrives with the small date.
- Tab switch: instant, stroke steps. Right.

## What I changed in the direction

- `DIRECTION.md` §2: the date's display-size mono named; the why-line
  rule gains "up to three lines, passing under the data column". §6: the
  mini → Now Playing moment restated as the sheet rising over the dock
  with two shared elements, and its reverse as the same path back; FLIP
  only, View Transitions dropped. §8: row heights 112/136, lead 160/184,
  stretch 136/160; density re-measured and the trade stated. §11: Today's
  stress rule (why clamps at three, spans the data column), the row strip's
  width, Now Playing's why at three lines (two at ≤ 700), Library grid names
  at caption over two lines, Up Next remaining time in two lines, onboarding
  headline at `title` size at ≤ 700. §12: FLIP only.
- `BUILD-NOTES.md` 1.2: `--t-data-display` (Geist Mono 34/38 500, the
  Today date only). 1.3: `--row-ep` 112/136, `--row-lead` 160/184,
  `--row-stretch` 136/160. §2: `Row`, `Row--lead`, `Row--stretch`,
  `Row--queue`, `Strip`, `MiniPlayer`, `Sheet`, `Skeleton` rows. §3: "nothing
  wraps into the data column" qualified for the why-line. 4.1: lead and row
  anatomy, density numbers, stress rule, skeleton. 4.2: why clamp, end-of-
  item artwork. 4.5: grid names. 4.7: ≤ 700 headline. §5: the dismiss
  mechanics. §9: round-4 recording and density measurement.

## Ready?

No. Item 1 changes what every row says and item 2 changes what the one
transition a reviewer touches first feels like on the way back. Both are
mechanical now that the values are written down; items 3–5 are an
afternoon. After round 4 I expect to return ready.
