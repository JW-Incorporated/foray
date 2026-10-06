# Afterglow: round-3 critique

Art director's review of the round-3 prototype (`prototype/`), 2026-10-05.
Shots reviewed: `data-local/redesign/shots/ambient/r3/` — the seven default
routes at 375x667, 393x852 and 412x915, the four state sheets
(`states/states-{393x852,375x667}-{dusk,dawn}.png`) and the per-state PNGs
under `states/<viewport>/<scheme>/`: 34 states per scheme per viewport,
including the two new ones (`np-segchange`, `np-detail3`). Everything round 2
asked for was shot, and the builder's deviations in `prototype/ROUND3-NOTES.md`
(head scrim 0.52, Dawn mid scrim 0.92, `--on-wash-2` instead of capping the
hot spot, ramp starting behind the artwork) are all accepted: each is a
measured number replacing my estimate, and each reads correctly in the shots.

**Verdict: one short round, builder-contained, then done.** Every round-2 P0
and P1 is fixed and visible: the Room's text sits in the mid zone on both
schemes, the Dawn Foray page is paper, collages no longer crop a logo, the
artwork casts its own colour (clearest on Library's bottom row and on "Where
this came from"), the hot spot on Today finally says where the light comes
from, the unavailable foray turns its lamp down, the segment change exists as a
state, max text size fits at 375x667. The thesis is now on the screen on Today,
Now Playing, Foray detail and Library.

What remains is two hero screens the thesis has not reached yet, one of them
the first screen a founder sees, and a handful of small layout corrections. No
contrast defects were found in this round. Items are in priority order; the
direction changes made on seeing the build are marked **[direction change]**
and are folded into `DIRECTION.md` ("Changed after round 3") and
`BUILD-NOTES.md` §11.

## P1: the thesis on the last two hero screens

### 1. Onboarding puts the lamp under the light **[direction change]**

`shots/default__onboarding__412x915.png` (Joey's phone size): the top 215px
of the screen is a flat band of saturated orange with nothing in it but the
wordmark, the sleeves sit below it on the dark part of the Room, and a second
empty band of ~170px separates the copy from the buttons. The group is
vertically centred (`.onb-mid { justify-content: center }`), so on a tall
phone it floats in the middle with light above it and dark around it: the
brightest part of the room is where there is nothing, and the artwork, which
the thesis calls the light source, sits in the shadow. At 375x667 it is
acceptable only because there is no surplus to misplace.

Fix, layout: the sleeves are top-anchored and the buttons bottom-anchored; the
copy follows the sleeves; the gap between copy and buttons takes the surplus.

```
.onb .onb-mid { justify-content: flex-start; padding-top: 40px; }   /* below the wordmark row */
.onb-arts { height: 176px; }                                          /* all heights; 1.15 scale stays at >= 800 */
.onb .strip { margin-top: 24px; }
.onb .t-display { margin-top: 28px; }
```

Fix, scrim: the onboarding Room's stops follow the sleeves, which are now at a
known y. The head band stays (0.52 for the wordmark), the ramp's bright zone is
the sleeves' box, and the mid stop is 24px under it, where the strip begins:

```
.onb .room-bg::after { background: linear-gradient(180deg,
  rgb(20 17 15 / 0.52) 0,
  var(--scrim-top) calc(var(--safe-top) + 72px),
  var(--scrim-top) calc(var(--safe-top) + 72px + 176px),
  var(--scrim-mid) calc(var(--safe-top) + 72px + 176px + 24px),
  var(--scrim-low) 100%); }
```

Dawn uses the same stops with the Dawn scrim colours. Reshoot at all three
heights; at 412x915 the orange band above the sleeves must be no taller than
the wordmark row plus 40px, and "Show my picks" must still sit above
safe-bottom + 24.

### 2. Discover and Library are the only unlit rooms **[direction change]**

`shots/default__search__393x852.png`, `states/393x852/dusk/library-lower.png`:
both pages are a flat `bg0` with raised tiles; the only Glow on them is inside
the Dock. Beside Today (lit from the collage) and Now Playing (lit from the
art), they read as a different, ordinary app, and Discover is a hero screen the
owner will judge. The brief's thesis is "every surface is lit by whatever is
playing", and on these two pages what is playing is in the Dock.

Fix, a sixth light: **the Dock casts upward.** A non-interactive radial behind
the content, anchored to the Dock's top edge, in the screen's Glow:

```
.page-glow { position: absolute; left: 0; right: 0; bottom: 0; z-index: 0; pointer-events: none;
  height: 260px;
  background: radial-gradient(90% 100% at 50% 100%,
    color-mix(in oklab, var(--glow) 14%, transparent) 0%, transparent 100%); }
[data-scheme="dawn"] .page-glow { background: radial-gradient(90% 100% at 50% 100%,
    color-mix(in oklab, var(--glow) 9%, transparent) 0%, transparent 100%); }
#app.np-open .page-glow, #app.no-chrome .page-glow, [data-posture="car"] .page-glow { display: none; }
```

It sits under the Dock fade and over `bg0`, so the fade still ends in `bg0`.
On Today it stacks under the hero wash (Today is lit from both ends only when
something other than the foray is playing, which is exactly when the two lights
differ, and that is the point). Nothing but the Dock is tinted when nothing is
playing (`--glow` is the neutral fallback, as built). Add the row `Dock cast,
text-2 at 14% Glow over bg0` to `contrast-glow.mjs`; it will pass at every hue
(14% over `#14110F` moves L by under 0.04) but the number belongs in the notes.

### 3. The first show's square is the one that is hidden **[direction change]**

`shots/default__library__375x667.png`, "Three chairs at the table": the
`.c3` collage puts Y Combinator at top-left and Acquiring Minds on top at the
bottom, so the first show, the one whose colour lights the foray's Room and
whose bars open the strip, is the one reduced to a corner. "Beyond the
algorithm" (`.c2`) does the same: Practical AI, the first show, is behind
causality and under the Foray pill, so its name is the one that cannot be read.

Rule: **the first show's square is always complete; the others peek out behind
it.** It is the show the Room is lit by, so it is the one a listener should
recognise from the tile. Implementation: keep the positions as built and
reverse the z-order and offsets so the first child lands on top at
bottom-right (`.c2`) or bottom-centre (`.c3`):

```
.collage.c2 > .art:nth-child(1) { right: 8%; bottom: 8%; left: auto; top: auto; z-index: 1; box-shadow: var(--shadow-1); }
.collage.c2 > .art:nth-child(2) { left: 8%; top: 8%; }
.collage.c3 > .art:nth-child(1) { left: 21%; bottom: 6%; top: auto; z-index: 2; box-shadow: var(--shadow-1); }
.collage.c3 > .art:nth-child(2) { left: 6%; top: 6%; }
.collage.c3 > .art:nth-child(3) { right: 6%; top: 6%; z-index: 1; box-shadow: var(--shadow-1); }
```

The `.c4` 2x2 is unchanged (nothing is hidden). Reshoot Library; both foray
tiles must show their first show's logo whole.

### 4. The current bar on Foray detail sits on the thumbnails

`states/393x852/dusk/foray.png`, `states/375x667/dusk/foray.png`: the thumbs
row is placed at `--bt + --bh + 4px`, but the current bar is taller than
`--bh`, so when the current bar is a wide one its lower edge lands on the
thumbnail beneath it; in both shots the Y and B thumbs read as badges hanging
off the bars rather than a row of their own. Fix: the current bar grows upward
only (`.sb .bar.cur { transform-origin: 50% 100%; }` if it scales, or anchor
its bottom to the row's bottom if it changes height), and the thumbs row moves
to `--bt + --bh + 6px`. Then no bar touches a thumb at any width.

## P2: polish

5. **Up Next peek copy** (`np-detail3`): the meta reads "How I Built This with
   Guy Raz · 39 min" and the next line "next in the queue, 39 min." The
   duration is twice and the reason is missing; the spec is "the next item's
   art and reason". Second line becomes the item's why-line in `--t-why`
   (Fraunces italic, `--text-2`, two-line clamp): "Guy Raz takes founder calls
   on cooling devices and wholesale growth, plus Kip Tindell's…". Keep the
   "4a added" eyebrow in Lamp.
6. **Car posture title clamp** (`np-car`, 393x852): the title ends in an
   ellipsis ("capital a startup…") while ~110px of empty Room sits between the
   show line and the strip. Allow three lines at >= 800px tall:
   `@media (min-height: 800px) { [data-posture="car"] .np .t-display {
   -webkit-line-clamp: 3; line-clamp: 3; } }`. At 375x667 two lines stay.
7. **`np-ending` freeze point**: the frame is taken at 60% travel, so the
   incoming art is a square cut by the right edge, over the outgoing art's
   right half, and a judge sees two half sleeves. Freeze the state at 85%
   travel instead (incoming at 15% off centre, outgoing at -36% and 20%
   opacity); the motion spec itself is unchanged.
8. **Discover's full-width odd tile** ("How bodies work", "Community and
   change", "How things get built"): the builder chose the span; keep it. The
   name may step up to `--t-headline` on the spanning tile only, so the extra
   width carries something. Builder's call.
9. **Today hero lit glow** reads faint at 160 because the collage's extracted
   colour (YC orange) and the hot spot are the same hue; that is correct
   behaviour, not a defect, and it will separate on a foray whose first show is
   blue or green. Noted so nobody raises `--lit-mix` for it.
10. **Dawn Foray detail**: the orange-to-paper ramp is right; the band above
    the collage is the only strongly saturated area on the whole Dawn scheme,
    which makes it the page's lamp. Keep.
11. **Dusk `np-foray` at rest** (eyebrow off by default on deep links): the
    eyebrow slot collapses cleanly and nothing jumps. Good; keep
    `?eyebrow=on` for the segchange shot only.

## What round 4 must shoot

Onboarding at all three heights (item 1), Discover and Library at 393x852 in
both schemes (item 2; include `library-lower` so the cast is seen under the
grid), Library at 375x667 (item 3), Foray detail at 375x667 and 393x852 (item
4), `np-detail3` (item 5), `np-car` at 393x852 (item 6), `np-ending` (item 7).
Print the `contrast-glow.mjs` output with the Dock-cast row in the builder's
notes.

## Round verdict

Not ready (`ready=false`), by a small margin. Items 1 to 3 change what the
owner sees on two of the seven hero screens, one of them the first screen of
the app, and they are each under 20 lines of CSS. Items 4 to 7 are corrections
a reviewer would find. After round 4 I expect no further round to change what a
judge sees; if round 4 cannot run before the pick, round 3 is presentable as it
stands, with items 1 and 2 named as known gaps in the checkpoint package.
