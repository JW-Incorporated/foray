# Native 2026: critique, round 4

Art director's pass over the round-4 prototype against `DIRECTION.md` and
`BUILD-NOTES.md`.

**Shots reviewed.** `data-local/redesign/shots/native-2026/r4/`: the full
matrix (`ios-dark`, `ios-light`, `android-dark`, `android-light`, 27 routes
x 3 viewports each, plus both reduced-transparency sets), the builder's
`checks/` output (A play-on-screen in every Now Playing state, B masonry,
C room chroma and contrast on all four pairs, D voice-not-clipped, E bridge
eyebrow baseline, F the six new routes and the sm strip runs). Contact
sheets first, then the 393x852 PNGs for Home, the scrolled Home, Now
Playing on all four pairs, Foray detail with the chip, the scrolled detail,
Library Up Next and its swipe, Search typing scrolled, onboarding. Then
eight renders of my own in `r4-ad/` for the states the builder's set does
not reach: Home at scroll 1000 and 1500 ("More picks" and its bridge row),
Library Saved, and Now Playing with the fold hidden (`np-below/`, via
`--css`) on both platforms, because `&scroll=` does not reach the sheet
(item 3). Crops of the two bridge placements at 2-3x in `r4-ad/crops/`.

**Verdict: not ready, but one short round from it.** Round 4 closed every
P0 and P1 from r3 and did it cleanly: not one `.voice` element is clipped
across 276 renders; the rail bridge card's eyebrow sits on its neighbours'
title baseline to the pixel on all twelve platform/scheme/viewport
combinations; iOS Up Next rows carry the number, the `graphic_eq` glyph and
`…`, with the handle and `⋮` only on Android; the Android dark room for
Satay? Okay! is `rgb(43,8,7)` at chroma 0.059 and the Android light rooms
are real tints; the status glyphs sit on a scrim that carries them; the
collapsing large title, the glass nav backing and the minimised tab pill
exist and look like iOS; the narration credits are in Newsreader; the
22-clip strips in Library are nine show runs, not beads; the onboarding
card reads as progress in a still frame. The two best screens in the
matrix are now Foray detail (both platforms, both schemes) and Now Playing
below the fold, which nobody has looked at until this round and which is
already right.

What is left is the bridge, and only the bridge. The second artwork is
there, sitting where it should, but the stitch that joins it to the cover
is invisible in every placement, the chip is too small to say which show it
is, and the rail card's text runs two and a half times the height of its
neighbours'. One of the direction's three signature moments is therefore
present in the DOM and absent on screen. Everything else below is P2.

`DIRECTION.md` and `BUILD-NOTES.md` are already edited for the two
direction changes (section "Direction changes" at the end).

## What is right (keep)

- Check D: zero clipped voice elements. The why-lines in "Jump back in",
  Search typing, More picks and Library Saved all run to their full stop at
  two lines; the rows grow to 94 and read as one card each. This was the
  P0 of r3 and it is closed properly, not patched.
- The seam at every size: lg in Now Playing with the playhead splitting the
  current bar; md on the hero and the detail; sm in Library with show runs
  (`F strip runs`: 22 clips become 9 bars) and the un-narrated rail strip
  with no thread.
- The rooms on all four pairs, now asserted on all four (`C room
  android-dark … chroma=0.058-0.059`, light 0.025-0.034, contrast 14:1 and
  up).
- The iOS shell at scroll: "Today" and "Search" collapse to 17/600 centred
  on glass; "Barbecue: eight stori…" collapses over the mosaic with the
  three glass circles kept, which is what iOS 26 does with nav buttons;
  the tab bar drops to the icon pill. Android hides the nav bar fully and
  keeps the opaque app bar.
- The foray hero scrim: "9:41" on Origin Stories' sky and the battery on
  BBQ Radio Show's orange are both legible at 393 and 375.
- Up Next, iOS: 64px rows, title clamp 2, current row at 12% amber with
  the number in amber and the eq glyph, swipe reveals "Remove" in
  `--danger` with the trash glyph. Android: handle, `⋮`, same row.
- Now Playing below the fold (my render): the credits list on the room
  with the current clip tinted and marked; the episode state's "Show notes"
  then "Up Next (5)" with the next item's why-line prefixed "Next:". This
  is the direction's "nothing is read for the first time" working.
- Onboarding: bars 1-2 at 100%, bar 3 filling, the block centred, two
  equal-height buttons, the glow behind the card only.
- The `4a` mark at 12px reads as two letters in every eyebrow.

## P1

### 1. The bridge's stitch is invisible in both placements

The spec: the chip sits on the cover's bottom-left corner, joined by a
16px horizontal stitch of the seam's thread. Built: `.stitch { left: 32px;
bottom: 3px }` (rail) and `.bart.sm .stitch { left: 20px; bottom: 3px }`
(row), which is to say the stitch is drawn **across the cover**, 3px above
its bottom edge, in `--label` at 45%. On Geology Bites (white) and Sticky
Notes (yellow) that is white on white; `r4-ad/crops/bridge-rail.png` and
`bridge-row.png` show a chip and a cover with nothing between them. The
join is the whole argument for the second artwork; without it the chip is
a sticker.

- Move the stitch into the band where the chip overhangs the cover, on the
  card's own surface: rail `left: 42px; bottom: -6px` (chip 32 at left 8,
  ring 2, so it starts 2px right of the ring and sits centred on the chip's
  lower half); row `left: 22px; bottom: -5px`. Same gradient, 2px, .45.
- Check G: the `.stitch` box does not intersect the `.main` cover box, and
  the stitch's sampled pixels differ from the surface by >= 20% luminance
  on the Geology Bites and Sticky Notes cards. Print the two boxes.

### 2. The rail bridge card is a different height from the rail

iOS dark 393, `#/home?scroll=320`: the Geology Bites card runs cover 168,
eyebrow, four lines of sentence at 17/22, then "How Earth got plate
tectonics and Venus…" at two lines, then "40 min · 1 show": a 230px text
block under the cover against the neighbours' 66px. The rail is sized by
its tallest card, so "The types of capital a startup can raise" has 160px
of void under it and "Playlists for you" starts 200px lower than it would.
Same on Android (`home-scroll-320-os-android`). The baseline check passes
because the eyebrow aligns; the bottom does not.

**Direction change.** In the rail and in rows the bridge card shows the
sentence and one footer line, "show · length", and no episode title:

- Rail: eyebrow at cover + 18 (10 overhang + 8), sentence 17/22 **clamp 3**
  (66px), footer `--t-footnote` `--label-2` "Geology Bites · 40 min". Text
  block 16 + 4 + 66 + 4 + 18 = 108 against the neighbours' 66-88: inside
  the two-line-title budget rails already carry. Copy rule: **rail bridge
  sentences are 10 words or fewer.** The current line is 12 and runs four
  lines; cut it to "Like Don't Panic Geocast, but deeper into how plates
  began." (10). Check D keeps it honest.
- Row (`.row.bridge-row`): sentence 19/26 clamp 3, footer "Sticky Notes ·
  54 min". Today the meta reads "Mozart Clarinet Concerto ·…" and cuts the
  show name, the one fact a Stretch pick needs. Remove the 8px
  `padding-left` on `.row-body`: the bridge's text column starts at x 217
  while every neighbour's starts at 201.
- The episode title lives in Now Playing and on the detail; a rail card
  with sentence + show + length is enough to tap on.

### 3. The chip is too small to name a show (rail)

At 24px the "Don't Panic Geocast" cover in the rail is a smudge
(`crops/bridge-rail.png`); the familiar show is the half of the bridge the
listener recognises, so it has to be legible. Rail chip **32px**, `left:
8px; bottom: -10px; border-radius: 8px`, same 2px `--surface` ring; the
row keeps 24. Eyebrow moves to cover + 18; check E's tolerance covers it.

## P2

4. **Now Playing's below-the-fold is outside the matrix.** `&scroll=`
   scrolls `.view`, but the sheet scrolls `#np-scroll`, so
   `#/now-playing?scroll=520` and `?scroll=1100` are pixel-identical to
   scroll 0 (`r4-ad/shots/now-playing-os-ios-scroll-*`). The content is
   built and good (my `np-below/` renders); it simply has never been shot
   by the builder's plan. Route `&scroll=` to `#np-scroll` when the sheet is
   open and add `#/now-playing?os=<os>&scroll=720` and
   `?state=episode&scroll=720` to the plan, both OS, both schemes. Add
   `#/home?os=<os>&scroll=1500` too: "More picks" and the bridge row have
   also never been in a builder shot.
5. **The foray chip pop is not on its bar.** `#/foray?state=chip` draws the
   "Satay? Okay!" chip at x 100-365, over "23 min · … made today", while
   the tapped bar is at x 165-205. Centre the chip on the tapped bar's
   midpoint, clamp to the gutters, add a 6px tail pointing down at the bar.
   Overlapping the meta line while the finger is down is fine; being
   90px to the left of the thing it names is not.
6. **Library Forays titles are clamp 1 and four of five are cut**
   ("Barbecue: eight stories from…", "The types of capital a startu…",
   "How Earth got plate tectonic…", "Beyond the algorithm:…"). r1 chose
   clamp 1 to hold the 76px row; the strip under the title is what makes
   the row a foray. I am leaving the rule; it is the sans, and the detail
   is one tap away. Noting it so nobody re-opens it.
7. **Search typing, `?scroll=300`:** the bottom field at 44px glass over
   the last row's why-line shows the serif through it ("A tribute, 55
   minutes…"). Expected glass behaviour mid-scroll; the list's
   `padding-bottom` already clears the stack at rest. No change.
8. **Android credits header under a hidden fold** collides with the
   clock in my `np-below` render. Artefact of hiding `.np-fold` with CSS,
   not of the prototype; it will not reproduce with item 4's real scroll.

## Checks for round 5 (hand-check and write into the hand-off)

- Check G (item 1): stitch box outside the cover box, stitch pixels
  >= 20% luminance from the surface, on both bridge placements, 393, both
  schemes.
- Check D unchanged: zero clipped voice elements, now with the rail
  sentence at clamp 3 and 10 words.
- Check E unchanged, with the 32px chip and cover + 18 eyebrow.
- Rail height: the bridge card's bottom within 48px of the tallest plain
  `RailCard`'s bottom at 393 (item 2). Print both.
- The Now Playing scrolled routes and `#/home?scroll=1500` in the matrix
  (item 4).
- Chip pop centred on the tapped bar within 4px (item 5).

## Direction changes made in this round

Edited by the art director so the builder reconciles one document, not two:

- `DIRECTION.md` §Signature moments, "The bridge": the stitch runs in the
  chip's overhang band on the surface, never across the cover; the chip is
  32px in the rail, 24 in rows; rail and row variants show sentence + "show
  · length" and no episode title. §Typography: rail bridge sentences are 10
  words or fewer.
- `BUILD-NOTES.md` `BridgeCard`: the values above (chip sizes and
  positions, stitch positions, clamp 3 in the rail, the footer line, no
  `.row-body` indent, check G).
- `BUILD-NOTES.md` §8: round-5 additions (`&scroll=` reaches `#np-scroll`;
  the Now Playing and Home scroll-1500 routes; the chip pop centred on its
  bar; check G).
