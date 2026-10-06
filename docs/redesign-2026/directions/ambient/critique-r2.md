# Afterglow: round-2 critique

Art director's review of the round-2 prototype (`prototype/`), 2026-10-05.
Shots reviewed: `data-local/redesign/shots/ambient/r2/` — the seven default
routes at 375x667, 393x852 and 412x915, plus the builder's state sheets
(`states/states-{393x852,375x667}-{dusk,dawn}.png` and the per-state PNGs
under `states/<viewport>/<scheme>/`): 29 states per scheme per viewport.
Everything round 1 asked for was shot. Good.

**Verdict: not ready, but close. One more round, and it is mostly contained
CSS.** Every round-1 P0 is fixed and verified in the shots: the Stretch card
is a card, the Room is the blurred artwork, the Dock is one surface, show
names wrap instead of cutting, car posture keeps Play on screen, Library's
empty state is honest, first run no longer duplicates the hero. The thesis is
now visible on Now Playing and Foray detail, and the Dawn Today wash finally
reads as light from the collage.

What remains: two accessibility defects (text on the bright upper third of a
Room; max text size clips the glance posture at 375x667), one hero screen
that breaks the scheme in Dawn, and five places where the art is still a
*tint* rather than a *light*. The direction changes I made having seen the
build are marked **[direction change]** and are folded into `DIRECTION.md`
("Changed after round 2") and `BUILD-NOTES.md` §10.

Items are in priority order, each with the fix and its values.

## P0: defects

### 1. Text on the bright upper Room fails contrast (Foray detail, Now Playing head)

`states/393x852/dusk/foray.png`: the Foray Room's top third is near-pure YC
orange (the layer is at 0.9 over a 15% Glow base, and `--scrim-top` is only
`rgb(20 17 15 / 0.20)` for the top 35% of the screen). The eyebrow, the
title's first line and the caption "4 shows · 19 min · narrated" all sit
inside that 35%. Lamp on that orange is about 2.9:1; `--text-2` is under
3:1. The same shape on Now Playing: at 393x852 the chevron and dots at the
top sit on pale blurred white from the Run the Numbers art, roughly 2.4:1,
under the 3:1 floor for icons.

Fix, `.room-bg::after`. Define the scrim in **pixels from the top**, not in
percent, so the text block always starts in the mid zone whatever the
viewport height:

```
background:
  linear-gradient(180deg,
    rgb(20 17 15 / 0.42) 0,                         /* head icons: >= 3:1 on any art */
    var(--scrim-top)  calc(var(--safe-top) + 56px),
    var(--scrim-top)  calc(var(--safe-top) + 196px), /* the collage's lower edge (Foray) */
    var(--scrim-mid)  calc(var(--safe-top) + 276px), /* the eyebrow's y, already mid */
    var(--scrim-low)  100%);
```

and raise `--scrim-mid` from `rgb(20 17 15 / 0.82)` to `0.86` inside the
mix. On Now Playing the art is taller (280 to 320), so give it its own
stops: `196px` becomes `calc(var(--safe-top) + 72px + var(--np-art))` and
`276px` becomes that plus 20. Then extend `prototype/tools/contrast-glow.mjs`
with two new rows and print them: `Room at the eyebrow's y` = Lamp and
`--text-2` over (`scrim-mid` composited over Glow at L 0.66, C 0.14, every
hue) and `Room head` = `--text` over (`0.42` black over Glow). Both must
clear 4.5:1 (3:1 for the head icons); if the sweep's worst hue fails, raise
the alpha until it passes and record the number.

### 2. Max text size clips the glance posture at 375x667

`states/375x667/dusk/np-textscale.png` (1.3x): the "More" handle is cut at
the bottom edge, and the why-line runs to one truncated line while the title
takes three. Round 1's car fix was asserted at 1.0x only.

Fix. Under `html.big` (textscale >= 1.2): art 160 (as built), why-line
hidden (as in car posture), eyebrow slot collapses to 0, the detail handle
becomes the 24px chevron alone with no caption, and the transport row's top
margin drops from 20 to 12. Add the harness assertion for `textscale=1.3`
at 375x667: the Play button's bottom edge is at least 24px above the
viewport bottom and the handle is fully inside the viewport. Above 1.3x the
glance posture may scroll; below it, never.

### 3. Foray detail in Dawn is a dark screen inside a light app **[direction change]**

`states/393x852/dawn/foray.png` is pixel-identical to Dusk. Library is paper,
you tap a foray, and the whole screen goes to a dark Room with cream text,
then back to paper. It reads as a second app. Now Playing is a sheet and a
different place; it may keep "no scheme". A page in the navigation stack
may not.

Fix: the Room gets two scrims, chosen by scheme, and **Now Playing is the
only Room that always uses the Dusk scrim**. Dawn Room (`[data-theme="dawn"]
.foray-room`, and the `prefers-color-scheme: light` twin):

```
--glow-room: color-mix(in oklab, var(--paper0) 80%, var(--glow) 20%);
.layer.on { opacity: 0.55; }
--scrim-top: rgb(247 242 235 / 0.10);
--scrim-mid: color-mix(in oklab, rgb(247 242 235 / 0.86) 80%, var(--glow) 20%);
--scrim-low: color-mix(in oklab, rgb(247 242 235 / 0.96) 80%, var(--glow) 20%);
```

Text on it is `--ink`/`--ink-2`, the eyebrow and why-line use the Dawn
`--lamp-text` (`#55391A`, as elsewhere in Dawn), raised rows are the Dawn
`paper1` raised material. Same pixel stops as item 1. Add the Dawn Room rows
to `contrast-glow.mjs` (ink and ink-2 over scrim-mid over Glow at the Dawn
L 0.56); both must clear 4.5:1. Onboarding is a Room too: it follows the
scheme the same way, so a Dawn first launch is a bright room.

### 4. Two-show and three-show collages crop the art through its title

`shots/default__library__375x667.png`, third foray tile: "Beyond the
algorithm" has two shows, and `.collage.c2` (`grid-template: 1fr / 1fr 1fr`)
shows each art as a half-width crop, so "PRACTICAL AI" reads "ACTICAL" twice
across the Library. `.c3` does the same to its first cell. A cropped logo is
the one thing a publisher notices.

Fix: a collage never crops a square. `c1`: the art. `c2`: two full squares
at 68% of the cell, the first at top-left, the second at bottom-right,
overlapping, the second on top with `--shadow-1`. `c3`: three squares at
58%, at top-left, top-right and bottom-centre, the last on top. `c4`: the
2x2 as built. All with `--r-sm` on each square inside the cell and the cell
background `--bg1` (Dawn `paper2`). Apply the same rule to the Today hero, the
Playlist covers and the SubjectTile collage, and re-shoot Library.

## P1: the art as light, not tint

### 5. The artwork casts shadow; it should cast light **[direction change]**

`.np-art .swap > .art` carries `0 24px 60px rgb(0 0 0 / 0.35)`, the hero
collage carries `--shadow-2`, the Foray collage and the onboarding sleeves
carry black shadows. The thesis is that the sleeve is the lamp, and a lamp
does not throw a black shadow onto the wall it lights. In the Today shot the
collage sits on the wash with a dark halo, which is the opposite of the
sentence in the brief.

Fix, a fifth material, **Lit art**: every artwork 104px or larger gets
`box-shadow: var(--shadow-1), 0 0 var(--lit-r) calc(var(--lit-r) / -4)
color-mix(in oklab, var(--art-glow) 55%, transparent)` where `--art-glow` is
that artwork's own extracted colour (not the screen's `--glow`) and
`--lit-r` is 40px at 104, 64px at 160, 96px at 280 and above. The black
shadow goes. Under `prefers-reduced-transparency` and `forced-colors` the
lit shadow is dropped, not replaced. Dawn: the same at 40% so paper stays
paper. Apply to: hero collage, Playlist covers (2-up), Now Playing art, Foray
collage, onboarding sleeves, ShowTile (at 104, 40px).

### 6. Today's wash is warmer but still a band; give it a hot spot

`shots/default__home__393x852.png`: the radial is there and the top reads
warm, but it is an even brown from edge to edge; nothing says the light is
*coming from* the collage. Add a second, tight radial on top of the two
layers already built:

```
radial-gradient(60% 34% at 22% 16%, color-mix(in oklab, var(--glow) 52%, transparent) 0%, transparent 100%)
```

(22%/16% is the collage's centre at 393; at 375 use 24%/17%.) The eyebrow
and "4 shows · 19 min" sit at the hot spot's right edge, so add the row
`Dusk Today hot spot 48/52` to `contrast-glow.mjs` for `--text-2` and Lamp;
if `--text-2` falls under 4.5:1 at any hue, cap the hot spot at 46%. With
item 5 on the collage, the hot spot is the collage's own light.

### 7. Foray detail's strip disappears into its own Room

`states/393x852/dusk/foray.png`: the YC bars are salmon on orange. On a Room
lit by the first show, the first show's bars are by construction close to
the backdrop, and the strip is the screen's map. Give it a sill: the 48px
strip on Foray detail sits in a well, `background: rgb(20 17 15 / 0.22);
padding: 10px 12px; border-radius: var(--r-lg)` (Dawn Room: `rgb(255 255
255 / 0.35)`). Now Playing's strip sits in the mid zone and reads; no sill
there. Also bump the current-bar fill to `color-mix(in oklab, var(--c) 78%,
var(--lamp))` (built: 85%), so "current" is lighter by a visible step.

### 8. Now Playing at 393x852 still leaves the surplus between why-line and strip

`shots/default__now-playing__393x852.png`: the art grows to 320 (good), but
the remaining ~70px of surplus all lands between the why-line and the strip,
which makes the strip look detached from the text. Split it: wrap art +
eyebrow + titles + why-line in `.np-mid { flex: 1 1 auto; min-height: 0;
display: flex; flex-direction: column; justify-content: center; }` so the
surplus goes half above the art and half below the why-line; strip,
transport and handle keep their fixed spacing below. At 375x667 nothing
changes (there is no surplus).

### 9. The unavailable foray keeps its lamp on

`states/393x852/dusk/foray-unavailable.png`: the collage dims to 50% but the
Room behind it is at full orange, so a dim object sits in a bright room,
which reads as a loading glitch, not as "can't play". **[direction change]**
When a foray is unavailable the lamp goes down: `.layer.on` opacity 0.35,
`--glow-room` mixed at 8% not 15%, the strip at 60%. The copy stays as
built. Offline on Today is already "cached art stays, unplayable rows dim";
this is the same rule applied to a Room.

### 10. Library shows a Followed badge on every show in Library

`shots/default__library__375x667.png`: all six followed shows carry the
Ember `check-circle-fill` badge. In Library every show is followed, so the
badge is six identical marks saying nothing. **[direction change]** The
badge appears only where follow state varies: Discover result rows and
"Where this came from". In Library the grid is clean art; the tile's name
row carries nothing. Keep the `i-check-circle-fill` in the sprite.

### 11. The segment change is the signature moment and no shot shows it

The brief's first signature moment is the Room shifting colour mid-foray
with the show name surfacing in Lamp. `np-ending` shows the handoff (good,
and correctly built: next art at 60% travel, current at -24% and 40%, "Up
next" caption). Add `?state=np-segchange`: frozen at t+280ms after a
boundary, the two Room layers at 50/50, the caption "Now: The Bootstrapped
Founder" lit, the outgoing bar full and the new bar's fill at 4%, the show
line under the title mid-crossfade. The judge needs to see it; the owner
needs to see it at the pick.

### 12. Hero title: accept four lines **[direction change]**

`shots/default__home__393x852.png`: at `--t-title` 26/30 beside a 160
collage the sample title takes four lines, not the three the spec promised
(round 1's arithmetic was wrong; the column is 177px at 393). Four lines of
26/30 is 120px plus the 18px eyebrow, which still sits inside the 160
collage, so the layout holds and the Play row lands under the collage's
bottom edge. Spec is now `clamp 4`, never an ellipsis in a hero. At 1.3x
the title drops to `--t-headline` 20/24 at 4 lines.

## P2: polish

13. **Now Playing head icons**: with item 1's top band the chevron and dots
    are fine; no disc behind them. Noted so nobody adds one.
14. **Library "Foray" pill** is drawn ~24px tall; spec is 20 tall at 13/20
    600 uppercase, `letter-spacing: 0.06em`, padding 0 8px, Lamp on
    `rgb(20 17 15 / 0.55)` so it reads on any art (built: cream on the art,
    which vanishes on Run the Numbers' white).
15. **Eyebrow in the Foray Room** is already `.eyebrow.lamp`; it only looked
    like `--text-3` because of item 1. No change beyond item 1.
16. **Transient caption in shots**: the harness shoots inside the 3s window,
    so every Now Playing shot shows "Now: Run the Numbers" twice (eyebrow and
    show line). Shoot the resting state: freeze the clock at open + 4s, or
    expose `?eyebrow=off`. The judge should not score a transient.
17. **Onboarding at 393x852 and 412x915**: the block is centred (checked:
    210 to 570 inside 60 to 720) but reads top-heavy because the sleeves'
    box includes their rotation overhang. Scale the sleeves 1.15 at >= 800px
    tall and raise the strip's gap to 20 so the group fills its third.
18. **Detail posture tail**: `np-detail2` ends at "Where this came from";
    show notes (4-line clamp, "More") and the Up Next peek are specified in
    BUILD-NOTES 4.2 and not visible in any shot. Add `?state=np-detail3`
    scrolled to the end; if they are missing, build them.
19. **Dock bottom fade**: content runs under the Dock and is cut flat by the
    Dock's rounded bottom edge ("A breakthrough in" under the Dock on
    `default__mini__375x667`). On devices with a 34px home indicator that
    band is 46px tall. Add a non-interactive fade behind the Dock: `height:
    calc(var(--safe-bottom) + 28px); background: linear-gradient(transparent,
    var(--bg0) 70%)` (Dawn: `paper0`). The Dock stays floating; the content
    stops being sliced.
20. **Discover subject grid**: an odd group leaves an empty right cell
    (Science & nature, People & society, Business & work all show it).
    Acceptable; alternatively the last tile spans both columns with the same
    anatomy at 56 collage. Builder's call; not a blocker.
21. **"Keep listening" progress rim**: the Ember bar along the art's bottom
    edge is right. Note the 2px must be inside the art's radius (it is).
22. **Playlist covers**: "3 of 6 played" in Ember is the listener's mark;
    correct per the colour rule. Keep.

## What round 3 must shoot

Everything round 2 shot, plus: `np-segchange` (item 11), `np-detail3` (item
18), `textscale=1.3` on Now Playing at 375x667 **after** item 2, Foray
detail in Dawn after item 3, Library after item 4 (the two- and three-show
tiles), and Today at 393x852 after items 5 and 6 so the hot spot and the
lit collage are judged together. Print the `contrast-glow.mjs` output in the
builder's notes with the four new rows.

## Round verdict

Not ready (`ready=false`). Items 1 to 4 are defects a founder or a reviewer
would hit (two of them are AA failures); items 5 to 7 are the last step from
"tinted by the art" to "lit by the art", and they are small CSS with
measurable gates. After round 3 I expect no further round to change what a
judge sees.
