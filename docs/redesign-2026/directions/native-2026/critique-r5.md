# Native 2026: critique, round 5

Art director's pass over the round-5 prototype against `DIRECTION.md` and
`BUILD-NOTES.md`.

**Shots reviewed.** `data-local/redesign/shots/native-2026/r5/`: the full
matrix (`ios-dark`, `ios-light`, `android-dark`, `android-light`, 30 routes
x 3 viewports each, plus both reduced-transparency sets, 396 renders, 0
errors) and the builder's `checks/check-output.txt` (A through J, all
PASS). Contact sheets at 393 and 375 on all four pairs first, then the
393x852 PNGs for the three routes this round existed for: `#/home?scroll=320`
(the rail bridge card) on iOS dark, iOS light and Android light,
`#/home?scroll=1500` (the bridge row) on iOS dark and Android light,
`#/foray?state=chip`, `#/now-playing?scroll=720` and
`?state=episode&scroll=720` on both OS. Then the Android Now Playing default
and the Library Up Next on Android light for the states the fixes touch.

**Verdict: ready.** The bridge, which r4 called "present in the DOM and
absent on screen", is now on screen in both placements: the 32px chip of the
familiar show sits on the cover's corner and names it (Don't Panic Geocast is
legible as a cover, not a smudge), the stitch runs in the overhang band on
the surface and reads as two dashes of the seam's thread on Geology Bites
(white) and Sticky Notes (yellow) alike (check G: 35-45% luminance from the
surface on all four pairs), the rail card carries the sentence at three
lines and "Geology Bites · 40 min" and ends 47px below its tallest
neighbour instead of 160 (check H), and the row carries "Sticky Notes · 52
min" with its text column on the neighbours' x. The builder also found the
real cause of r4's four-line sentence (a class collision that gave the
sentence the rail scroller's padding and killed its clamp) and the footer
truncation (taglines after the colon), and fixed both at the source. The
chip pop sits on its bar with a tail (check I, 0.0px). Now Playing below the
fold is in the matrix on both OS and both schemes (check J).

Two things were still off, both small enough that handing them back for a
sixth round would cost more than fixing them. **I made both changes in
`prototype/styles.css` myself** (the prototype is under this direction's
path), verified them with my own checks K and L across both schemes and all
three viewports, ran the mutation that makes each fail, re-ran the builder's
A and J, and re-rendered the four main matrix pairs so `r5/` shows the
shipped CSS. The pre-fix renders are kept in `r5-ad/before/`; the checks,
their output and the post-fix renders are in `r5-ad/`.

## What is right (keep)

- The bridge in the rail (iOS dark 393, `#/home?scroll=320`): cover 168,
  chip 32 with the 2px surface ring at the bottom-left corner, the stitch
  right of it on the card, `STRETCH` eyebrow on the neighbours' title
  baseline (check E, delta 0.0 on 12 pairs), three lines of Newsreader at
  17/22 ending in a full stop, one footnote line. It is the only card with
  two artworks and the join between them is visible; that is the moment.
- The bridge row (`#/home?scroll=1500`): 24px chip, stitch, sentence at
  19/26 on three lines, "Sticky Notes · 52 min" uncut, text column at x 100
  (CSS) with every neighbour. Same on Android light.
- The chip pop (`#/foray?state=chip`): the Satay? Okay! chip is centred on
  the tapped orange bar with a 6px tail; overlapping the meta line while the
  finger is down is the intended cost.
- Now Playing scrolled on iOS, both states: the credits list on the room
  with the current clip tinted and marked; "Show notes" then "Up Next (5)"
  with the "Next: ..." why-line. The transport row's bottoms clip at the
  sheet's rounded top edge, which is what a scrolled sheet does.
- Nothing regressed: the rooms (check C, chroma 0.053-0.059 dark, contrast
  11-15:1), zero clipped voice elements across 276 renders (check D), play
  on screen in every Now Playing state at 375 (check A), the masonry edge
  gaps (check B), the strip runs, the swipe, the collapsing titles.
- Reduced transparency: solid bars and a solid room, nothing else moves.

## Fixed in this round by the art director

### 1. Android Now Playing scrolled under the status clock (was P1)

`#/now-playing?os=android&scroll=720` and `?state=episode&scroll=720`, both
schemes: the title "the Republic (Part 4)" and the "1× Speed" label ran
under "9:41" because `.np-scroll` was `inset: 0` with the status-bar height
carried as the fold's `padding-top`, so once scrolled the content painted
through the status band. r4 item 8 saw the same collision in a CSS-hidden
render and called it an artefact; with real scroll (check J) it reproduced.

- `html[data-os="android"] .np-scroll { top: var(--sb) }` and the fold's
  `padding-top` back to 12px, so the layout at rest is identical (check A
  bottoms unchanged: 705/630/724) and scrolled content clips at the status
  bar's bottom edge, with the room (`.np-bg`, still `inset: 0`) carrying the
  glyphs. iOS is untouched: the sheet already sits below the status bar.
- Check K: on Android, `#np-scroll.getBoundingClientRect().top == --sb`
  (24) with `scrollTop > 0`, both states, both schemes, three viewports: 12
  PASS. Mutation `top: 0` fails all 12 (scrollerTop=0).

### 2. The bridge row's play glyph was 14px above its cover's centre (was P2)

In every plain row the play glyph is centred on the 56px cover. The bridge
row sets `align-items: start` (so the tall text column does not centre the
cover), which also started the 44px button at the row's top, 14px above the
cover's centre; the glyph read as attached to the eyebrow rather than to the
row.

- `.row.bridge-row .row-act { margin-top: 14px }`.
- Check L: play centre equals cover centre to 0.0px on both OS, both
  schemes, three viewports (the plain row's delta is 0.0 too), 12 PASS.
  Mutation `margin-top: 0` fails all 12 (delta 14.0).

## Noted, not changing

3. **"More picks" meta cuts long show names** ("54 min · Business of...",
   "1 hr 9 min · Good Hang with..."). The length is the fact the row needs
   first, the show is on the detail, and Apple Podcasts cuts the same way.
   `shortShow()` would not help here (no tagline). Leave it.
4. **Library Forays titles at clamp 1** (r4 item 6): unchanged, by rule.
5. **The void under plain rail cards next to the bridge** is 47px at 393,
   the budget check H allows 48. It reads as rail air, not as a hole; the
   r4 version was 160px. Leave it.
6. **Android credits header meets the status bar when hidden by CSS** (r4
   item 8): superseded by item 1; with real scroll the scroller now clips
   at the status bar.

## Checks on file

`r5-ad/check-r5ad.mjs` (K and L; `--mutate` injects the two reverts and
must print 24 FAIL). Output in `r5-ad/check-output.txt`. The builder's A
through J re-run clean after the change (`r5/checks/check.mjs A J`).

## Direction changes made in this round

- `DIRECTION.md` §Hero screens, Now Playing: on Android the scroller starts
  below the status bar and scrolled content clips at its edge.
- `BUILD-NOTES.md` §4.2: the Android scroller rule; `PickRow` bridge
  variant: play centred on the cover; §8: round-5 close-out with checks K
  and L.
