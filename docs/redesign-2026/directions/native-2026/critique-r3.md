# Native 2026: critique, round 3

Art director's pass over the round-3 prototype against `DIRECTION.md` and
`BUILD-NOTES.md`.

**Shots reviewed.** `data-local/redesign/shots/native-2026/r3/`: the full
matrix this time (`ios-dark`, `ios-light`, `android-dark`, `android-light`,
22 routes x 3 viewports each, plus `ios-dark-reduced-transparency` and
`ios-light-reduced-transparency`), the builder's `checks/` output (play on
screen in every Now Playing state on both platforms and three viewports; the
masonry edge gap; the iOS room chroma and contrast; the strip's DOM shape and
the onboarding loop under reduced motion). Contact sheets first, then the
393x852 PNGs for Home, Now Playing, Foray detail, Search, Library and
onboarding on every platform/scheme pair, and 375x667 and 412x915 where a
fit question arose.

**Verdict: not ready. A fourth round will materially improve it, and the
list is short.** Round 3 closed every P0 and P1 from r2: the lead foray's six
covers are the six shows named beside them (Origin Stories, Satay? Okay!,
BBQ Radio Show, More-ish, The Grill Coach, BBQ Central Show; the rail's
"types of capital" foray credits The Bootstrapped Founder, Y Combinator, The
Startup Solution and Feel the Boot, which are its tiles); the seam is a
stitched thread, not morse code, and progress by opacity with a `--label`
playhead reads at a glance; Android has Android's status bar, 28px hero and
mini corners, edge-bleeding chips, a transparent app bar over the mosaic and
M3 circles; the iOS dark room for a red cover is a deep maroon, not khaki,
and the light rooms are clean tints; the foray title sits below a 200px
mosaic; rows carry one play; the tonal pill is the secondary action on both
the hero and the detail; the mini hairline shows on Home; the empty card
carries a real glyph; the fold no longer underlines a header. The platform
shell is now credible on all four platform/scheme pairs, and iOS light and
Android light are the two best sets in the matrix.

What remains is concentrated in one idea the prototype still gets wrong
everywhere it appears: **4a's own sentences are cut off.** The serif voice
is the brand ("logo covered, you would still know it"), and in round 3 every
why-line in a row ends in an ellipsis, the bridge headline in the rail is
chopped at three lines, and the narration lines in the credits are set in
the system sans. The rest is a bridge chip that hangs instead of sitting, an
Up Next row that borrowed Android's grammar on iOS, an Android dark room
that is still grey-brown, a hero scrim that does not do its one job, and a
set of scrolled states that have never been rendered in three rounds.

Where seeing it built changed my mind, I say so; `DIRECTION.md` and
`BUILD-NOTES.md` are already edited (section "Direction changes" at the
end).

## What is right (keep)

- Every cover belongs to the show named beside it, on Home, in the rails, in
  Now Playing and in the credits. `data.json`'s note says how (iTunes Search
  API, feed URL matched against `segment-sources.json`); no stand-ins remain.
- The seam, lg and md: solid bars on a dashed thread, gaps only where 4a
  narrates, played 100% / unplayed 40%, the current bar split at a white
  playhead, and in the narration state the playhead sits on the thread in
  the gap. In the Now Playing foray state it is visibly the scrubber.
- The rooms: iOS dark Satay? Okay! gives `rgb(64,27,28)`-class maroon with
  chroma 0.058 and 15:1 on `--label`; Origin Stories gives navy; The Rest Is
  History gives wine. iOS light gives a pink, a periwinkle and a rose that a
  first-party player would ship. The builder's check C pins this.
- Android shell: status bar glyphs and 14/500 time at the left, 108x4 gesture
  handle, tonal nav bar with the pill indicator and filled selected icon,
  chips that bleed to the edge, the labelled five-up secondary row, the
  bottom-sheet context menu with the episode title as its header, the
  Android arrow back in a 40px circle over the mosaic.
- iOS shell: large titles, the floating glass tab pill with the mini docked
  above it as a second capsule, the blurred-page context menu with the row
  lifted out of it, the grabber and chevron on the Now Playing sheet, solid
  bars under reduced transparency.
- Foray detail: the 200px 3x2 mosaic with the title, meta, strip, why-line
  and the action row on `--bg`. Play lands at y 480 (393) and y 464 (375),
  on screen unscrolled on both platforms.
- Home: the hero card is the best element on the screen on all four pairs.
  The loading skeleton is now the hero's real boxes. The first-run eyebrow
  says "YOUR FIRST FORAY" with an impersonal why-line. The offline banner
  sits under the title at 36px.
- Search: the masonry's columns never share a horizontal edge (check B,
  24-40px); the typed state leads with "Build a playlist about history" on
  the soft card; the empty state names the subject and its show count.
- Library: six labels in the iOS segmented control at 375; foray rows 76
  with no chevron; the Up Next header "5 queued · 4 hr 11 min"; the empty
  card with `i-library_music` and one action.
- Onboarding: the glow starts behind the card, the block is centred, two
  equal-height buttons.

## P0

### 1. 4a's sentences are truncated wherever they sit in a row

Observed (iOS dark, 393): "Jump back in" why-line "A CEO's climb from
dropout. You finished the last..."; Search typing: "First of the Roman
wars, to pick up where your las...", "Part four of a Roman series. You
played parts one ...", "Pairs with the Roman civil war episodes: how one...";
the rail bridge card: "You play Don't Panic Geocast. This one goes deeper
into how plate..." at three lines with the verb missing. In every case the
thing the direction calls the brand is the thing cut off, while the sans
title beside it is also cut ("From high school dropo...", "704. Roman Civil
War:...", "What Mussolini's rise a..."). `BUILD-NOTES` `PickRow` said
`clamp 1` for the why-line; that spec was wrong and is changed.

**Direction change.** The voice face is never ellipsized. Values:

- `PickRow` second tier: why-line `--t-voice` 16/22, `clamp 2`; the row is
  `min-height: 72px` and grows to 94 when the why-line wraps (it does for
  most 18-word lines at 393: 100 characters at ~6.8px is 680px over 361).
- `PickRow` title: 17/600/22 `clamp 2`; meta stays one line, duration first.
  A one-line title keeps the row at 72; two lines make it 80 before the
  why-line.
- `BridgeCard` in a rail (168 wide): the bridge sentence at **17/22 italic,
  `clamp 4`** (88px), and a copy rule: **rail bridge sentences are 12 words
  or fewer** (the row and detail variants keep 16 at 19/26, `clamp 3`). The
  current line is 13 words; cut it to "You play Don't Panic Geocast. This
  goes deeper into how plates began." (12).
- Hero and detail why-lines: no clamp (18 words is at most three lines at
  393 and four at 375).
- Harness assertion: no element with `.voice` has `scrollHeight >
  clientHeight` on any shot; the builder runs it as check D and prints the
  offenders.

### 2. The bridge chip hangs under the cover instead of sitting on it

`BUILD-NOTES` `BridgeCard` says the 24px chip of the familiar show sits at
the cover's **bottom-left corner**, joined by a 12px stitch. The rail card
(iOS dark 412, `#/home`, the Geology Bites card) draws the chip **below** the
cover, 12px down on a vertical dashed stitch, inside a 204px art block. Two
effects: the bridge card's eyebrow starts 36px lower than its neighbour's
title, so the rail's text baselines jump card to card; and the chip reads as
a pin hanging off the cover rather than two artworks joined. Fix:

- `.rcard.bridge .bart { height: 168px }` (same as `RailCard`); the chip at
  `position: absolute; left: 8px; bottom: -8px; width: 24px; height: 24px;
  border-radius: 6px; box-shadow: 0 0 0 2px var(--surface)`; the stitch is a
  16px horizontal thread segment (`repeating-linear-gradient(90deg,
  var(--label) 0 4px, transparent 4px 8px)`, 2px tall, opacity .45) running
  from the chip's right edge at the chip's vertical centre. The eyebrow then
  starts at cover + 16 (8 for the chip's overhang + 8), two pixels off its
  neighbours' title line, which is the budget.
- Row variant (`.row.bridge-row`): the same chip at `left: -4px; bottom:
  -8px` already; show the stitch there too (`display: none` today) so the
  two placements are one idea.

## P1

### 3. Up Next rows on iOS wear Android's grammar

iOS dark `#/library?state=upnext`: every row has a leading `=` drag handle
and a trailing vertical `⋮`. Both are Material: iOS lists put reorder grips
at the trailing edge in edit mode and use `…` (horizontal) for overflow, and
Apple Podcasts' Up Next has neither visible, just long-press to drag and
swipe for actions. The row also tints the current item in `--accent-soft`
at full strength, a brown band directly above a mini player that shows the
same item.

- iOS: no leading handle; trailing: position number (`tnum`, `--accent` on
  the current row) + `i-graphic_eq` on the current row + `i-more_horiz` 44.
  Reorder: native long-press drag when it lands, overflow Move up / Move
  down until then.
- Android: keep the leading `i-drag_handle` and `i-more_vert`.
- Both: title 15/600/20 **`clamp 2`** (today "Computer-Use...", "704. Roman
  Civil...", "The Deep Tech...", "Questionably...", "Do data centers..." are
  five truncations in five rows), show 13/18 one line; the row stays 64.
- Current row tint on both platforms: `color-mix(in srgb, var(--accent) 12%,
  transparent)`, so the row stays a row; the number, the glyph and the mini
  already say "playing".

### 4. The Android dark room is grey-brown

Android dark Now Playing for Satay? Okay! is `oklch(0.22 0.03 h)`: on screen
a near-black brown, and Origin Stories' blue gives a navy-grey, both far
quieter than the iOS dark rooms for the same covers. The builder's check C
ran only for iOS, so the direction's "chroma >= 0.05 in dark" was never
asserted on Android, and `0.03` fails it by construction.

- Android dark `.np` background: `linear-gradient(180deg, oklch(0.26 0.06
  var(--art-h)) 0, oklch(0.15 0.04 var(--art-h)) 100%)`; `--np-container:
  oklch(0.32 0.07 h)`; `--np-primary` unchanged. `--label` on L 0.26 is
  about 11:1 for every hue.
- Android light: keep `oklch(0.97 0.02 h)` as the surface, add the same
  gentle gradient to `oklch(0.93 0.035 h)` at the bottom so the screen is a
  room rather than a tint.
- Check C runs for `android-dark` and `android-light` too, same thresholds.

### 5. The foray hero scrim does not carry the status bar

iOS dark `#/foray`, 393 and 375: the status glyphs sit on BBQ Radio Show's
orange "BBQ RADIO SHOW" lettering and the white battery outline sits on the
cover's white text; the clock sits on Origin Stories' sky. The scrim
(`rgba(0,0,0,.45) 0 → 0 at 40%`) is too shallow and ends too soon for a 3x2
mosaic whose top row is 100px of busy covers. Values: `linear-gradient(180deg,
rgba(0,0,0,.62) 0, rgba(0,0,0,.32) 22%, rgba(0,0,0,0) 48%)`. Same on Android.
The circles stay 40px; on iOS give them the glass tint at 78% rather than
`--surface-2` at 60% so they match the tab bar's material.

### 6. The scrolled iOS shell has never been rendered (process)

Three rounds, and the collapsing large title, the glass nav backing "once
content scrolls under it", and the tab bar minimising on scroll down have not
appeared in a single shot, because every route renders at scroll 0. These
are the iOS 27 shell's two defining moves. Add a hash parameter the prototype
honours after layout: `&scroll=<px>` (`window.scrollTo` on the page's
scroller, then dispatch `scroll`), and shoot `#/home?os=ios&scroll=320`,
`#/foray?os=ios&scroll=420`, `#/search?os=ios&state=typing&scroll=300`, both
schemes, at 393. Android gets `#/home?os=android&scroll=320` to show the
opaque app bar over scrolled content. Also add `#/foray?state=chip` (a
tapped bar's chip with show art and name) and
`#/library?state=upnext&swipe=1` (the trailing "Remove" revealed), since
neither signature affordance has been seen.

## P2

7. **Narration rows in the credits** set "Narration" in the sans at 15/600
   and 4a's line ("Next: where cooking may have started.") in the sans
   footnote; the builder did not apply `.t.voice`. **Direction change**: the
   narration row's title is the narration line itself in `--t-voice` 16/22
   (it is what 4a says, so it is in 4a's voice), and the footnote is
   "4a narration · 12 sec" in 13 `--label-2`. Now Playing's "4a Narration"
   subline stays as it is.
8. **Small strips with many clips are beads.** The 22-clip foray in Library
   and in the rail renders 22 bars of 4-10px. **Direction change** for `sm`
   strips only: when a foray has more than 12 clips, consecutive clips of one
   show merge into one bar (a show run); opacity applies per run and the
   current run is split at `--p`. md and lg keep one bar per clip.
9. **Onboarding card reads as disabled** in a still frame: the loop starts
   with every bar at 40%. Start the loop with bars 1-2 at 100% and animate
   bar 3, so any frame reads as progress; under reduced motion the same
   state, static.
10. **Android top app bar title** sits at x 20 while the gutter is 16 (Home
    and Library). M3's headline padding is 16 with no navigation icon: set
    `padding-inline: 16px` on `.topbar` under `data-os="android"`.
11. **Home's settings glyph** is `i-tune` (sliders), which reads as "filter".
    Use `i-settings` (gear), 24 in a 44 target, `--accent`, both platforms.
12. **`1×`** in the secondary row: set `font-variant-numeric: tabular-nums`
    (r2 #16; not visible in a static shot, confirm in the hand-off).
13. **Foray detail strip labels**: with ten clips nothing fits under a bar, so
    the label row is correctly dropped; `#/foray?state=chip` (item 6) is the
    only way to see the show under a bar, so it must be in the r4 set.

## Checks for round 4 (hand-check and write into the hand-off)

- Check D (item 1): zero ellipsized `.voice` elements across the matrix.
- Check C on all four platform/scheme pairs.
- The play-on-screen assertion in every Now Playing state (passes; keep).
- The six new routes from item 6, in both schemes.
- The rail: the bridge card's eyebrow baseline within 2px of its
  neighbours' title baseline at 393.

## Direction changes made in this round

Edited by the art director so the builder reconciles one document, not two:

- `DIRECTION.md` §Typography and `BUILD-NOTES.md` `PickRow`, `BridgeCard`,
  §4.4: the voice face is never ellipsized; why-lines in rows clamp 2 and the
  row grows; rail bridge sentences are 17/22 clamp 4 and 12 words or fewer;
  titles in `PickRow` and `QueueRow` clamp 2.
- `BUILD-NOTES.md` `BridgeCard`: the chip sits on the cover's bottom-left
  corner with a horizontal stitch; the art block is 168 tall; the row
  variant shows its stitch.
- `BUILD-NOTES.md` `QueueRow` and §4.4: iOS has no leading handle and uses
  `i-more_horiz`; the current-row tint is accent at 12%.
- `BUILD-NOTES.md` 1.5 and `DIRECTION.md` §Now Playing: Android dark room is
  a gradient `oklch(0.26 0.06 h)` to `oklch(0.15 0.04 h)`; check C runs on
  Android.
- `BUILD-NOTES.md` §4.5: the hero scrim values; narration credit rows carry
  the narration line in the voice face. `DIRECTION.md` §Typography: "narration
  lines", not "narration labels".
- `BUILD-NOTES.md` `SeamStrip`: sm strips merge show runs above 12 clips.
- `BUILD-NOTES.md` §8: `&scroll=`, `state=chip`, `swipe=1` routes and checks C
  (all pairs) and D in the shoot plan.
