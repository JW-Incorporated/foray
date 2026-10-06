# Afterglow: round-4 critique

Art director's review of the round-4 prototype (`prototype/`), 2026-10-06.
Shots reviewed: `data-local/redesign/shots/ambient/r4/` — the three contact
sheets, the seven default routes at 375x667, 393x852 and 412x915, the four
state sheets, and the per-state PNGs round 3 named (onboarding at three
heights, Discover and Library in both schemes with `library-lower`, Library at
375x667, Foray detail at both sizes, `np-detail3`, `np-car`, `np-ending`,
`np-segchange`), plus the Dawn Today, Foray and onboarding, `discover-results`,
`library-empty`, `today-firstrun`, and the 375x667 `np-textscale` and
`np-ending` that nobody asked for and that are where regressions hide. The
builder's `ROUND4-NOTES.md` deviations (sleeves at `safe-top + 94` against the
measured wordmark row, the onboarding ramp starting 70px before the sleeves'
box ends, the Dock cast anchored to the Dock's top edge and hidden when nothing
plays, the strip's `<button>` centring as the real cause of item 4) are all
accepted: each is a measured correction of my estimate and each reads right.

**Verdict: ready.** Every round-3 item is fixed and visible, and the direction
is now on every hero screen: onboarding stands in its own light at 412x915
(the sleeves sit in the bright zone, the strip and copy follow them, the
buttons hold the bottom), Discover and Library carry a warm floor from the
Dock, the first show's square is whole on both Library foray tiles, no bar
touches a thumbnail on Foray detail, the Up Next peek carries the reason, the
car title runs to three lines, the ending frame shows one sleeve arriving, not
two halves. No contrast defect was found. Nothing below changes what a judge or
the owner would decide between directions.

Two cosmetic defects remain, each under ten lines of CSS and each pinnable by
`tools/qa.mjs` without an art-director reshoot. They go into the same polish
pass as the checkpoint package; they do not need a fifth round, and I am not
asking for one.

## Why this round, and not the last, is ready

Round 3 was held back because two of the seven hero screens, one of them the
first screen a founder sees, did not carry the thesis: the onboarding lamp sat
under the light and Discover and Library were unlit. Those were direction
gaps, not polish; a judge comparing directions would have scored Afterglow on
five screens, not seven. Round 4 closed them. What is left is the kind of
blemish a reviewer flags in a build loop, which is Phase 4's job, and the two
items below are written so the builder can land them with the asserts and
move on.

## P1: land with the checkpoint package (builder-contained, no reshoot review)

### 1. The Dock fade is too short; content ghosts under and beside the Dock

`shots/default__search__393x852.png`, bottom 20px: "16 shows" and "21 shows"
from the next subject row are readable below the Dock's bottom edge, unblurred.
`shots/default__library__375x667.png`: fragments of the next caption row show
beside the Dock's rounded corners. `shots/default__home__393x852.png` has the
same ghost at bottom-left. Cause, from `afterglow.css` line 412: `.dock-fade` is
`calc(var(--safe-bottom) + 28px)` tall with `linear-gradient(transparent,
var(--bg0) 70%)`, so it reaches `bg0` only in its last ~8px, while the Dock's
bottom edge sits 12px above the safe area and its corners are `--r-xl`. The
round-2 rule was "content is never sliced by the Dock's edge"; it is now sliced
by the Dock's bottom edge instead of its top.

Fix, replacing the two values:

```
.dock-fade { height: calc(var(--safe-bottom) + 12px + 44px);
  background: linear-gradient(transparent 0, var(--bg0) 32px); }
```

The fade's top is then 44px above the Dock's bottom edge, solid `bg0` from 12px
above that edge down to the screen bottom, and the gutters beside the Dock's
lower 44px (its corner radius) fade to `bg0`. It stays at z-index 19 under the
Dock, so the Veil's blur over its lower 12px sees `bg0`, which is correct: the
tab row sits on bg, not on text. Dawn keeps `--paper0`. Assert: with the Dock
present, no text node's box intersects the band from the Dock's bottom edge to
the screen bottom with a rendered opacity above 0.02, on every tab page in both
schemes at 375x667 and 393x852.

### 2. Show names still cut on 3-up grids

`shots/default__foray__393x852.png` and `__375x667.png`, and the Dawn
`states/393x852/dawn/foray.png`: "Where this came from" reads "The
Bootstrapped…" in the middle column. `shots/default__library__393x852.png` and
`__375x667.png`: "The types of capital a startu…" and "Beyond the
algorithm:…". `DIRECTION.md` says art grids are 3-up "so show names never cut",
and the 3-up column at 393 is 109px, where "Bootstrapped" alone fills a line
and the `clamp2` on `.stile .name` (`afterglow.js` lines 563, 570, 894) drops
"Founder". At 412x915 it fits, which is why it was not seen before.

Fix: three lines on grid captions, and the grid lets rows be tall:

```
.stile .name, .ftile .name { -webkit-line-clamp: 3; line-clamp: 3; }
.grid-3 { align-items: start; }
.foray-body .came .stile .name, .np-detail .stile .name { min-height: 2.25rem; }   /* unchanged */
```

In `afterglow.js`, the three `t-caption name clamp2` spans become `clamp3`.
Foray titles on Library tiles are not show names, but the same clamp applies:
a title that a listener saved should be readable on the tile that opens it.
Assert: on Library and on Foray detail's "Where this came from", at 375 and
393, no `.name` has `scrollHeight > clientHeight`, and the row gap between
tile rows is never under 16px.

## Accepted as built (so nobody re-raises them)

3. **Dock cast at 14% / 9% stays.** `states/393x852/dusk/discover-idle.png`
   against `discover-idle-nomini.png`: with something playing the floor under
   the tiles is warmer and the Dock's surroundings glow; without, the page is
   plain `bg0`. The builder calls it quiet and it is, deliberately: Discover
   and Library are rooms the lamp is carried into, not rooms lit from the
   ceiling. Raising it would make every page the hero's orange and flatten the
   difference Today earns with its hot spot. The contrast rows in
   `ROUND4-NOTES.md` (text-3 5.15:1 at the worst hue) are recorded.
4. **Onboarding's lower surplus stays empty.** At 412x915 about 285px of dark
   Room sits between the copy and the buttons. That is the composition round 3
   asked for: the sleeves are top-anchored in the bright zone, the buttons are
   thumb-anchored, and the surplus goes where there is nothing to light. A
   one-time screen with a quiet lower half is right; filling it would be
   decoration.
5. **Ember on primary actions** (Play, Resume, "Show my picks", "Make a
   playlist from 'money'") alongside Ember as the listener's marks: consistent
   since round 1 and read correctly in `discover-results` next to the
   "Following" check. One warm colour for "yours and what you do next" is one
   rule, not two.
6. **The "Foray" pill clips the top-left corner of a `.c4` collage** (Library,
   "The types of capital"): the pill straddles the tile edge by design and the
   YC square still reads. Not a defect.
7. **`np-ending` at 85%** leaves a sliver of the outgoing art at the left
   edge at 20% opacity. That is the motion read as a still; a judge sees one
   sleeve arriving. Keep.

## What round 5 would shoot, if one ran

Nothing that needs me. After items 1 and 2 land, the builder reshoots the
default routes at 375x667 and 393x852 and attaches the two new asserts'
output to `ROUND5-NOTES.md` or to the checkpoint package. I do not need to
review those shots; the asserts are the review.

## Round verdict

Ready (`ready=true`). No further art-director round would materially change
what a judge sees. Items 1 and 2 are builder corrections with mechanical
asserts, to land in the polish pass before the checkpoint package is cut;
they are not a reason to hold the direction.
