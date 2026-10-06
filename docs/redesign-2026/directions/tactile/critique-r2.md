# Dial — critique, round 2

Art director's pass over the round-2 prototype (`prototype/`) against
`DIRECTION.md` and `BUILD-NOTES.md`, from the r2 renders: 66 routes × 3
viewports × 2 schemes (`data-local/redesign/shots/tactile/r2/`), plus the
six-frame hero Play press capture. Items are in priority order; each is a
concrete change with values. Where the build showed the direction itself was
wrong I changed the direction (marked **direction changed**); the new text is
already in `DIRECTION.md` / `BUILD-NOTES.md` and this file says why.

**Verdict:** round 2 cleared every P0 from r1 except one (the knob), and the
screens that were never seen in r1 now exist in both schemes. Bakelite works
first time: the station tint under the scrim, the persimmon `#FF6A3A` keys
and the inverted chip read as the same object at night, and the r1 contrast
table holds by eye. The r1 acceptance list is met on four of five points:
every route is shot in both schemes, station codes are unique, the hero
bottom is 535px at 393, nothing sits on unfaded text at rest on Home, Find,
Foray or Now Playing (the 375 Now Playing buries the "Up next" heading, which
is the intended cue). The fifth point, "the bridge card and gauge rendered
and critiqued once", is what this round is about: both signature moments
are now on screen and **both are under-built**: the arc reads backwards, the
gauge reads as a slider, and the knob is still a stopwatch. Those three are
the direction's identity; a third round is needed. Not ready.

What is right and must not regress: the Now Playing sheet in both schemes
(station tint, 56px scrubber with codes, the colon-tightened readout, the
secondary row at four items, the heading-as-scroll-cue); the Yours queue (5
rows above the mini, the quiet `⋯`, the current row); Find's typing and
no-results states; the onboarding card with the counter in the readout row;
the offline state (grey lip, cloud-slash, amber "Needs a connection"); the
keycap press capture (see P2); the mini player; the two-character codes
everywhere they appear.

---

## P0 — the signature moments

### P0-1. The bridge arc points at the wrong show (direction changed in part)

Rendered: the arc leaves the **stretch** artwork's left edge and ends on
the **known** artwork with a 3px dot at that end. Round-capped stroke plus a
terminal dot reads as an arrowhead, so the card says "Lingthusiasm → the
known show": the bridge is drawn in reverse. The direction says what the
listener knows is on the left and the stretch pick on the right, and the arc
carries them from the one to the other.

- The `bridge` icon in the sprite is already two 4px dots joined by an arc.
  The card's arc uses the same grammar: **a dot at both ends**, 3px, on the
  artwork edges; no single-ended dot anywhere. `path d="M2 34 C 22 -6, 78
  -6, 98 20"` stays; add `<circle class="dot" cx="98" cy="20" r="3"/>` and
  draw the dots after the path (`--d-draw` + 40ms) so the arc arrives before
  the far dot appears.
- The arc must touch both artworks, not vanish behind the right one:
  `.bridge__arc { grid-template-columns: 48px 1fr 72px; column-gap: 4px }`
  and the SVG keeps `overflow: visible`; the right dot sits 2px outside the
  art's left edge.
- Known art: `align-self: center`, not `end`. It sits low-left now, so the
  arc starts below the sentence's baseline and the composition sags to the
  bottom-left corner.
- **Direction changed:** the sentence sits **above** the arc as the
  headline, which is what the build did and it is right: at 345px the arc
  has no room for 13 words, and the headline-first reading ("the reason,
  then the two ends") is stronger. `DIRECTION.md` signature 2 now says so.
  Keep it at body-lg 600 `--ink`, 3 lines max.
- Add `+ Up Next` to the bridge card's meta line exactly as the episode rows
  carry it (P1-2 of r1). The Stretch pick is the one row without it, and it
  is the row most worth queueing.
- The meta's show name is "Lingthusiasm - A podcast that's …" on every
  viewport. See P1-1 for the name rule.

### P0-2. New ground reads as a slider (direction changed)

A 12px pill with a solid fill from the left and a round-capped 2px thumb at
its end is the OS range input. The first thing a reader does with it is try
to drag it, and the one thing the direction forbids on this gauge is the
idea that it is a setting ("4a keeps it that way"). It also borrows nothing
from the band, so the third signature shares no language with the first.

- The gauge becomes a **band in a well**: `.gauge { height: 24px; padding:
  4px; border-radius: var(--r-sm) }` (the well, not a pill). Inside, one
  bar the full inner width at `--paper-2`'s darker neighbour (`--line`),
  radius 2; the unfamiliar share (0.33) is the same **hatched ultramarine**
  as the narration ticks (3px/3px, `--ultramarine` / `--ultramarine-soft`),
  radius 2. Hatch = authored by 4a, which is exactly what this share is.
- The needle is the band needle, not a thumb: 2px `--ink`, cap 8px **above**
  the well (`top: -10px`), stem to the well's bottom edge, at x = 0.33 of
  the inner width. No cap inside the well.
- A mono readout on the heading line, right-aligned: `1 in 3` (readout 13,
  `--ink-2`). The heading "New ground" stays label 13/700 → make it heading
  20/700 like the other sections; the card then opens like "Also today",
  not like a settings row.
- Caption: label 13/500 `--ink-2` (it is micro 12 now; nothing on Today
  should be the smallest size on the screen but the tab labels).
- `role="img"` and the aria-label stay. The gauge never takes focus and has
  no `:active`.

### P0-3. The knob is still a stopwatch (direction changed)

Second attempt, same read. The cause is geometric: a dot at 12 o'clock above
a circle is a stopwatch crown, whatever the pointer does. The r1 spec (a
radial tick at 12) had the same flaw; the builder's slanted pointer did not
fix it because the top dot survived.

- New `knob` symbol, 24 grid: a **filled** disc `cx 12 cy 11 r 8` in
  `currentColor`; a pointer in the keycap's face colour (`var(--k-fill)`,
  so it reads as a groove cut in the knob) from `(12,11)` to `(7.4,6.4)`,
  2.5px, round cap; two end-stop dots r1.4 at `(4,20.5)` and `(20,20.5)`.
  **Nothing above the disc.** A potentiometer with its min and max marks.
- If the owner still reads it as something else at the pick, the fallback
  is Phosphor `faders` Bold (three vertical sliders), which is honest about
  "dials" and needs no explanation. Noted in BUILD-NOTES so the Phase 3
  build does not re-invent a third knob.

### P0-4. Settings: the Dials have no knob and no detent

`#/settings` renders each dial as an ultramarine fill to 50% in a 44px
well. There is no needle, so nothing says "this moves", and there is no
mark at the centre, so "4a's setting is the centre detent" describes
something invisible. The one place the app literally has dials has none.

- Render `.gauge__needle` on the knobtrack (the markup at `app.js` 844
  omits it): 2px `--ink`, 8px cap, cap 6px above the track, at the value.
- Centre detent: a 2px × 16px `--ink-3` tick at 50%, vertically centred,
  behind the fill. The input's `step` snaps to it with a selection haptic.
- The fill is a **persimmon** well-fill, not ultramarine: the dial is the
  listener's own setting. Ultramarine is 4a's; the floor sentence at the
  foot of the sheet stays ultramarine-free text.
- Drop the per-row "4a's setting" readout when the value is at the detent
  and show the offset otherwise (`+2`, `−1`, mono 13). At the detent the
  sheet-level line already says it.
- On open, focus the sheet container (`tabindex="-1"`), not the first
  button: the "Done" key renders with a 2px ultramarine ring on every
  screenshot (`app.js` 846 focuses `button`). Rings on `:focus-visible`
  only.

### P0-5. Foray detail: the pinned Play is two controls

An 80px round key with a detached "Play" pill to its left reads as a key
and a button. The pill has `--shadow-deck`, so it is a raised thing you
could press separately. One action, one key.

- The pin becomes a single **extended keycap**: `keycap--persimmon
  keycap--lg keycap--round`, height 56, padding `0 20px 0 14px`, play icon
  28 + "Play" 17/700 + readout `22 min` (mono 13, `--on-persimmon` at 85%).
  Right-aligned at `bottom: deck + 16`. In progress: "Resume" + `12:40`.
  Finished: "Start over" (no readout). The 80px size stays reserved for the
  hero and the transport.
- With the pin at 56 the Foray fade shrinks: `body.route-foray::after {
  height: calc(var(--deck-total) + var(--safe-b) + 100px) }`, stop at 60%.
- Unavailable: the empty well keeps the lifted needle but **drops the
  labels** (`.band--empty .band__labels { display: none }`). Five station
  codes under nothing read as a legend for a chart that failed to load.

---

## P1 — hierarchy, states, fixtures

### P1-1. Show names in meta lines are cut on every row (direction changed)

"The World's Be…", "Main Engin…", "Choiceology w…", "Design Matters wit…",
"The Partially Examined Li…", "Lingthusiasm - A podcast that's …". Six of
eight rows on Today and Yours lose the show name at 393; at 375 all of
them do. The `min-width: 72px` floor is working as specified and the
specification was too low.

- **Display-name rule** (data, not CSS): strip a trailing ` - …`, ` | …`,
  ` with …`, ` (…)` clause from show names for meta lines only
  (`Lingthusiasm`, `Choiceology`, `Design Matters`, `The Partially Examined
  Life` survive intact; `The World's Best Construction Podcast` stays long
  and ellipsises honestly). Full names stay on show tiles, Find, and the
  "From" rows.
- `.row__meta .ell { min-width: 112px }` (was 72) and the duration readout
  `flex: none`. `+ Up Next` keeps its place.

### P1-2. Resume card has no name and a third key shape

`#/home/resume` shows a card with artwork, title, progress and "42 min
left" — but no word says resume, and the Play key is a 64×48 rectangle at
radius 14, a shape that exists nowhere else.

- Eyebrow tag top-left of the card, like the hero's: `tag` with the needle
  icon, fill `--persimmon-soft`, text `--persimmon`, reading "Resume"
  (persimmon: the listener's own thread).
- The key is the mini player's: `keycap--persimmon keycap--round` at
  `--key` 48. Same action as the mini (continue this), same key.
- `#/home/resume` at 393 pushes the hero's bottom to 737px; that is the
  cost of the state and is accepted. Keep the Resume card ≤ 128px (it is
  about 170 now: artwork 80, two text lines, progress, a 48-tall foot row).
  Put the progress well and the "42 min left" readout on one line (well
  `flex: 1`, readout `flex: none`, 12 gap) and the key beside the artwork
  column's bottom; target 124.

### P1-3. First-run hero contradicts itself

`#/home/first` shows "4a starts with wide bets. Each listen narrows the
dial." **and** "Because you follow food and history shows." A first-run
listener follows nothing; the second line is false and the hero carries two
body-lg lines where every other state carries one.

- First run: the wide-bets line **replaces** the why-line (same slot, same
  style); nothing is inserted between the title and the band.
- Fixture why-line for first run, if a why-line is wanted later: "A wide
  bet for day one: six shows on food and history." (10 words) — not used in
  r3; the wide-bets line is the copy.

### P1-4. Toast fixture removes nothing

`#/toast` shows "Removed from Up Next · Undo" over a queue that still has
five rows, "5 queued · 4 hr 55 min" and a 5 badge. The state it depicts
cannot exist.

- Fixture: row 4 removed (Snake Stuff), four rows, readout "4 queued · 3 hr
  58 min", Yours badge 4, Now Playing badge 4. Undo restores row 4 at
  position 4.

### P1-5. Find mosaic: tiles are mostly empty, and the readouts are not readouts

- `.tile--l` (AI & robotics): the name sits bottom-left under 110px of
  cream while the collage is centred on the right. `justify-content:
  center` for the text column (it was moved to `flex-end` in the P1-4 r1
  override). Name beside the art, both centred, reads as one object.
- `.tile--m` (Fermentation, 2×1): 240px tall for three 36px discs and two
  lines. `min-height: 120px`, discs and text on one row (`flex-direction:
  row; align-items: center; gap 12`), discs left, name + count right.
- "14  shows", "8  shows", "9  shows", "7  shows" (Yours header): the number
  is mono and the word is Bricolage with a mono space between. The whole
  readout is `--font-mono` 13 `--ink-2` with one space, like "6 shows" in
  the hero. Check `.tile .readout` and `#libread`'s markup: the count must
  not be wrapped separately from its noun.
- No-results tile: the 2px ultramarine outline reads as a focus ring.
  Replace with a fill: `.tile.is-hit { background: var(--ultramarine-soft);
  outline: none }` in both schemes. The sentence already names the tile.

### P1-6. Yours chip strip still starts clipped

`#/library` with Up Next selected scrolls the strip so a 4px sliver of
"Shows" shows at the left edge (r1 P2, not fixed; the chip set is six wide
and cannot fit, so `inline: "nearest"` alone cannot solve it).

- `.strip[role="tablist"] { mask-image: linear-gradient(to right,
  transparent, #000 16px, #000 calc(100% - 16px), transparent) }` so
  partial chips fade at both gutters instead of being cut.
- `scroll-padding-inline: 16px` on the strip so `scrollIntoView` lands the
  selected chip inside the mask.

### P1-7. Episode Now Playing: the band's label row is empty

`#/now-playing/episode` keeps the 56px well with a 40px bar and 16px of
nothing below it where station codes would be. An episode has no stations.

- `.band--scrub.band--episode { height: 44px; --bh: 32px }`, no label row;
  chapter ticks stay as 1px `--ink-3` at 80%. The readout row moves up with
  it.
- The "Downloaded" tag between show name and band is the only `--good`
  element on the sheet and it is fine; keep its 20px gaps.

### P1-8. Bakelite rubber keys sink into the sheet

In the dark Now Playing the 15/30 keys are `#2E2822` on a `#17130F` paper
under a plum tint. They are the darkest things on a dark screen; the lip
disappears and they read as holes, not keys.

- Bakelite: `--rubber: #3A332C; --rubber-lip: #120E0B`. The face lifts to
  about 1.5:1 against paper (it is a surface, not text; the glyph on it
  stays `--ink` at 11:1). Cream is unchanged.

---

## P2 — polish

- **Keycap press (Risk 1): tuned.** The six-frame capture shows the face
  drop 2px with the lip going 3→1 and the shadow holding; it reads as a key,
  not a 2012 button, because nothing changes colour. Keep exactly this.
  Device check on the Lab build is still owed (the direction's risk is about
  the hand, not the still), but there is nothing left to change in CSS.
- `.row__meta` downloaded mark (the 14px green check between "35 min" and
  "+ Up Next" on T+325): keep it, give it `aria-label="Downloaded"`, and in
  the offline state let those rows say "Downloaded" where undownloaded rows
  say "Needs a connection". At rest an unlabelled glyph is a riddle, but a
  wordless mark that becomes a word when it matters is the right trade.
- Mini player on Home: the last visible why-line ("shows. This one is about
  a dome that") is only half-faded above the mini's band line. `body::after
  { height: calc(var(--deck-total) + var(--safe-b) + 56px) }` with the
  paper stop at 56% so the line under the mini is fully gone.
- Hero band at 8px: the narration ticks render 5px solid ultramarine
  between 1px-radius bars. Right now; do not add the hatch back at this
  size.
- Playlist cards: good. The `2 of 4 played` readout and 4px progress well
  are the right density. No change.
- Today tab icon (sun-horizon): acceptable, but the `band` mark exists for
  exactly this tab. Try it in r3 at Bold weight; if it reads as a barcode
  at 24px, keep the sun.
- `tokens.css` still hard-codes 800/700 without `--w-*` tokens. Phase 3.

---

## Not changed, on purpose

- The sentence-above-arc bridge layout: adopted into the direction (P0-1).
- Up Next's three-key action row (Move up / Move down / Remove) wrapping
  to two lines at 393: keys are right for actions that change the
  collection, and a second line is better than three cramped keys.
- The 375×667 Now Playing hiding the "Up next" heading under the dock
  fade: the sheet is 667px tall with an 80px transport; the heading's top
  edge still peeks and the scroll cue holds.
- "Also today" why-lines at body 15/500 `--ink` under a 17/700 title: the
  reason is the pitch and should not be greyed. Row height ~130 with a
  three-line why is accepted; the copy rule (≤18 words) bounds it.

## Round-3 acceptance

Ready when: the arc has a dot at both ends and starts from a centred known
artwork; the gauge is a hatched band in a well with the needle's cap above
it and a `1 in 3` readout; the knob mark has nothing above the disc; Settings
dials show a needle and a centre detent; Foray detail's pin is one extended
keycap; the first-run hero carries one body-lg line; the toast fixture has
four rows; show names survive on at least six of eight rows at 393. Then
the direction is at its ceiling for a prototype, and the remaining risk
(press feel on a phone) belongs to the Lab build, not another round.
