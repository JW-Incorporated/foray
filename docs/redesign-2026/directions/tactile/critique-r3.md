# Dial — critique, round 3

Art director's pass over the round-3 prototype (`prototype/`) against
`DIRECTION.md` and `BUILD-NOTES.md`, from the r3 renders: 66 routes × 3
viewports × 2 schemes (`data-local/redesign/shots/tactile/r3/`). Items are in
priority order, each a concrete change with values. Where the build showed the
spec was wrong or silent I changed the spec (marked **direction changed**);
the new text is already in `BUILD-NOTES.md` / `DIRECTION.md`.

**Verdict: ready.** Every round-2 acceptance item is met, and met well:

- The bridge arc has a 3px dot at both ends, leaves a centred known artwork
  and lands on the stretch artwork's edge. Read cold, the card says "this,
  therefore that": the reason as headline, then the two ends. It holds at
  375, 393 and 412 in both schemes.
- New ground is a band in a well: `--line` bar, ultramarine hatch to a third,
  the needle's cap 10px above the well, `1 in 3` on the heading line. Nobody
  will try to drag it, and it shares its grammar with the hero band three
  cards up.
- The knob is a knob: filled disc, groove pointer, two end-stop dots, nothing
  above. It reads the same at 44px in Cream and Bakelite.
- Settings dials have a needle, a centre detent and persimmon fills, with
  `+2` / `−1` readouts; the sheet opens without a focus ring.
- Foray detail's pin is one extended key in all three states (`Play 22 min`,
  `Resume 12:40`, `Start over`), and the unavailable well has no codes.
- The Resume card is 122px with a persimmon "Resume" tag and the mini's key.
  First run carries one body-lg line. The toast fixture has four rows and a
  4 badge in both places. Seven of eight show names survive at 393.

Bakelite still works first time on every new screen. What follows would not
change the owner's read of the direction at the pick; it is a last pass the
Phase 3/4 build applies from the spec, and it needs no fourth critique.

What must not regress: everything in the r2 "what is right" list, plus the
bridge card, the gauge, the knob, the extended pin, the Resume card and the
onboarding card with the counter in the readout row.

---

## P1 — fix in the build; visible, not identity-level

### P1-1. Un-narrated band stutters its codes (direction changed)

`#/foray/unnarrated` labels the band `OS · BR BR · MP · GC · BC BC`. With the
hatched ticks gone the adjacent bars of one show each clear 24px, and the
per-bar rule labels both. The narrated band reads `OS BR MP GC BC` only
because its second bars happen to fall under 24px. The band is the first
signature, and a repeated code reads as a chart legend glitch.

- Label **runs**, not bars: consecutive segments from one show (narration
  ticks between them do not break a run) get one code, centred under the
  run's combined width, when that width ≥ 24px rendered. `bandHTML` builds
  `labels` per item at `app.js` 223; group first, then emit.
- `is-cur` follows the run, not the bar (`app.js` 529 toggles by item index;
  compare by show id over the run's index range instead).
- BUILD-NOTES 3.6 now says this.

### P1-2. Episode tint reads as dishwater in Cream (direction changed)

`#/now-playing/episode` (Odd Lots): the 32×32 average of a dark purple
artwork with gold and green in it is a mauve with chroma just over the 0.04
floor, and under the 78% paper scrim it is grey-brown. The foray sheet beside
it, tinted with the rose enamel, shows what this surface is meant to be.
Bakelite hides the problem (the dark scrim swallows it); Cream is the default.

- Raise the enamel fallback to **chroma < 0.07**, and after the lightness
  clamp **floor chroma at 0.10** (then the in-gamut walk at `app.js` 712
  reduces it only as far as sRGB needs). A tint is a colour or it is the
  enamel; nothing in between.
- The runtime contrast check stays; with a stronger tint it will raise the
  scrim to 0.9 more often, which is correct.
- BUILD-NOTES §7 now carries both numbers.

### P1-3. Loading skeleton is a slab (direction changed)

`#/home/loading` paints the hero as one 405px rectangle and each row as one
block (`app.css` 595: hide every child, recolour the container). Nothing
about it says a band is coming, and the hero jumps from a flat slab to a
composed card. 3.15 asked for band-shaped and row-shaped placeholders at the
final heights; the build matched the outer height and nothing inside.

- Hero skeleton, inside the card at the real positions: eyebrow pill 24×112
  (`--r-sm`), three title lines 28px tall at 88/80/40% width (`--r-sm`),
  the band as an 8px pill well full width, three 40px discs overlapping by
  12 plus a 120×13 readout bar, two why-lines 17px at 96/72%, then an 80px
  circle and a 48×96 pill. Fill `--line` on a `--paper-2` card (two tones,
  so the shapes read); shimmer stays opacity-only.
- Row skeleton: 56px square, two title lines at 90/60%, one meta bar 13px at
  50%, a 44px square at the right. Playlist card: a 96px square and two bars.
- Reduced motion: static, as now.

---

## P2 — polish

### P2-1. Secondary row: four items, three shapes

`1.0×` and `Sleep · Off` are 44px pills, the bookmark is a 44px square
keycap with a lip, Up Next is a 44px round paper disc with a badge. Three
silhouettes on one row of four.

- Up Next becomes `keycap keycap--sm keycap--paper` like the bookmark, badge
  at `top: -4px; right: -4px`. Two chips, two keys; the row reads as
  "settings, then actions". BUILD-NOTES 4.2 item 6 updated.

### P2-2. Dials: the detent vanishes above centre

`.dial__detent` sits behind `.dial__fill`, so at `+2` the Engineering dial
shows no centre mark at all, and "4a's setting is the centre detent" points
at nothing on exactly the rows that moved away from it.

- Draw the detent above the fill: `z-index: 1`, colour `--ink-3` on the
  well, and where it overlaps the fill `--on-persimmon` at 70% (a second
  `::after` clipped to the fill, or `mix-blend-mode: luminosity` on the
  tick). It must be visible at every value.
- "4a's setting is the centre detent" is micro 12 (`app.js` 863); make it
  label 13/500 `--ink-2`. Nothing in a sheet should be smaller than the
  readouts.

### P2-3. Meta line wraps "+ Up Next" alone

T+325 on Today (the row with the downloaded mark) breaks its meta into
"Main Engine Cut Off 35 min ✓" and a lone right-aligned "+ Up Next" below.
The README chose this to save the name; it is the right trade, but the
orphan reads as a second action row.

- When the meta must wrap, wrap after the **show name** instead: name alone
  on line one, `35 min ✓ + Up Next` on line two (`.row__meta { flex-wrap:
  wrap }` with the name `flex: 1 1 100%` only when `:has(.tag--icon)` and
  the viewport ≤ 393). Readout, mark and action stay together.

### P2-4. Unavailable foray keeps its share key

`#/foray/unavailable` offers a share button for a foray that cannot be
played. Hide the share keycap in this state; the back key stays. The large
empty paper below the two keys is accepted: the empty well with the lifted
needle is this screen's drawn mark and it should not compete with a radio
illustration.

### P2-5. Known artwork dot sits on a corner

The arc's left dot (`(2,34)` in the 200×48 box) lands on the known art's
bottom-right corner rather than its right edge. It reads fine; it would read
cleaner at `(2,30)` so the dot touches the edge above the corner radius.
One number, no re-shoot.

### P2-6. Settings floor sentence

"The exploration floor stays at about a third. It is not a dial." is
correct and speaks as 4a; keep it. If a shorter line is wanted later:
"The exploration floor stays near a third and has no dial." (11 words).

---

## Not changed, on purpose

- Mono readouts ("14 shows", "7 shows"): the gap is Azeret's full-cell space,
  the same as in "about 22 min · 6 shows" on the hero. One font, one space,
  as r2 asked. No `word-spacing` tweak.
- The plum `SO` bar never earns a label at 393 (18px rendered) while "From"
  lists `SO`. The 24px floor is the right floor; the From row is the key.
- Today tab icon stays sun-horizon; the builder tried the `band` mark at
  Bold and it read as a list. Accepted.
- Up Next action row wrapping to two lines at 393: accepted in r2, still
  accepted.
- 375×667 Now Playing hiding the "Up next" heading under the dock fade:
  accepted in r2, still accepted.
- Onboarding, Find (idle, typing, none), Yours (all chips), offline Today,
  the mini player, both Now Playing postures: no change.

## Where this leaves the direction

At its ceiling for a prototype. The two risks that remain belong to the Lab
build, not to another round: press feel on a phone (Risk 1, unchanged since
r2) and `backdrop-filter` / View Transitions on older Android WebViews
(Risk 3). The checkpoint package should show the owner `#/home`,
`#/home/also`, `#/now-playing`, `#/foray` and `#/settings` in both schemes;
those five carry every signature moment and every overturned ruling.
