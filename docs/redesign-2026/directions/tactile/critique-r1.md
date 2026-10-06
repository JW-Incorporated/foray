# Dial — critique, round 1

Art director's pass over the round-1 prototype (`prototype/`) against
`DIRECTION.md` and `BUILD-NOTES.md`, from the r1 renders at 393x852, 375x667
and 412x915 (light scheme only; see P0-3). Items are in priority order; each
is a concrete change with values. Where the build showed the direction itself
was wrong, I changed the direction (marked **direction changed**) and the
new text is already in `DIRECTION.md` / `BUILD-NOTES.md`; this file says why.

**Verdict:** the thesis survives contact with the screen. The keycaps read as
keys, not 2012 skeuomorphism; the band is recognisable at 8px, 44px and 56px;
Bricolage at width 90 gives the chunky radio voice; the deck with the mini
docked on top is the right chrome. Round 2 is needed: two of the three
signature moments were never rendered, the band's labels carry no
information on real data, and four screens have an element sitting on top of
content at rest. Not ready.

What is right and must not regress: hero Play keycap 80 with the lip; the
mini player (band line, 44 art, 48 Pause, 44 skip); the Yours density (5 queue
rows above the mini); the current bar splitting played/unplayed in Now
Playing; the Foray detail band in its well; the onboarding card drawing a real
foray; the bottom fade above the deck.

---

## P0 — signature and comprehension

### P0-1. Station labels collide on real data (direction changed)

The r1 foray renders `O · B B M · G G B B`: four different shows share "B".
A letter that repeats is not a key; the credits list then reads
"O · 2 segments" as if "O" were a word. Single initials fail on real catalog
data, so the direction now uses **two-character station codes**.

- Code rule (`BUILD-NOTES` §3.6): strip a leading "The "; take the first
  letter of the first two remaining words, upper-case; a one-word title takes
  its first two letters. Within one foray, resolve a collision by replacing
  the second letter with the first letter of the show's last word. Examples
  from the fixture: Origin Stories → `OS`, Satay? Okay! → `SO`, BBQ Radio
  Network → `BR`, The Moreish Podcast → `MP`, The Grill Coach → `GC`.
- Label type: mono 11/700 (not 12), `--ink-2`; the **current** station's
  label `--ink` 800. Labels only under bars ≥ 24px rendered (was 20; two
  characters need the room). Narrower bars keep the code in `aria-label`.
- The same code appears in: the Now Playing show chip (`MP The Moreish
  Podcast`), the segment rows' 24px swatch (`.segrow .sw`), and the Foray
  detail "From" rows. In "From", replace the 8x32 swatch with the 24px
  code-in-swatch used by `.segrow`, and drop the bare letter from the readout
  (`2 segments`, not `O · 2 segments`).

### P0-2. Narration ticks read as rendering glitches

At 28px bar height the hatched narration items are 4px wide with 2px
stripes: they look like a barber-pole artifact between bars, not a mark.
At 8px (hero band, onboarding card) they are blue slivers.

- `.band--detail .bar--n, .band--scrub .bar--n { min-width: 8px; }` and the
  hatch at 3px/3px (`repeating-linear-gradient(45deg, var(--ultramarine) 0 3px,
  var(--ultramarine-soft) 3px 6px)`).
- `.band--mini .bar--n`: solid `--ultramarine`, no hatch, `min-width: 3px`,
  full bar height. Hatch is for sizes where it can be seen.
- Keep the 2-unit gap on both sides of a tick so it never fuses with a bar.

### P0-3. Two signature moments and every state are unrendered

Nothing below "Also today" row 1 reaches the viewport on any device, so the
bridge card (signature 2) and the New ground gauge (signature 3) have never
been seen, and none of the built states (`#/home/resume`, `#/home/first`,
empty Yours, unavailable foray, queue ⋯ open, toast, typing, no results,
settings sheet, Bakelite) are in the r1 set. A critique cannot pass what it
cannot see, and neither can the judge.

- Add sub-routes that scroll a section to the top on mount
  (`scrollTop = section.offsetTop - 12`): `#/home/also`, `#/home/playlists`,
  `#/home/ground`, `#/foray/segments`, `#/now-playing/more` (sheet scrolled to
  "Up next"), `#/search/mosaic`.
- Add state routes, each deterministic from its fixture: `#/home/first`,
  `#/home/resume`, `#/home/offline`, `#/home/loading`, `#/library/empty`,
  `#/library/upnext/open` (row 2's ⋯ expanded), `#/library/shows`,
  `#/library/forays`, `#/foray/progress`, `#/foray/done`, `#/foray/unnarrated`,
  `#/foray/unavailable`, `#/now-playing/paused`, `#/now-playing/buffering`,
  `#/now-playing/episode` (an episode, chapter ticks), `#/search/typing`
  (query "chern"), `#/search/none` (query "fusion"), `#/settings` (sheet
  open), `#/toast` (Yours with the Remove toast showing), `#/onboarding/return`.
- Theme: read `theme=dark` from the query string and set
  `html[data-theme="dark"]` before first paint, so the r2 shoot can render
  `index.html?theme=dark#/…` for every route above. Bakelite has never been
  seen; the contrast table in BUILD-NOTES §2.2 is unverified until it is.
- Write `prototype/routes.json`: an array of `{ route, label, states }` the
  harness can consume, so r2 shoots the full matrix without hand-listing.

### P0-4. Now Playing: the Up next card sits under the transport at rest

At 393x852 and 375x667 the "Up next" card's second line is cut by the dock's
gradient and the transport keys sit on its text. It reads as a layout bug,
not as "the body scrolls under the pinned transport".

- Wrap everything above `.np__more` in `.np__top { min-height: calc(100% -
  176px - var(--safe-b)); display: flex; flex-direction: column; }` so at
  rest the **"Up next" heading peeks 24px above the dock edge** and the card
  is below the fold. (Dock = 36 + 80 + 14 + 44 + 16 = 190; 176 leaves the
  heading visible as the scroll cue.) At 375x667 the `max-height: 740px`
  block uses the same rule with its smaller dock (156px).
- The dock's gradient then only ever covers the heading's lower edge; keep
  `linear-gradient(to bottom, transparent, var(--paper) 34%)`.

### P0-5. Now Playing tint is mud (direction changed)

The average of a four-artwork collage is a grey-beige (around `#D6D0C8`) and
under the 78% paper scrim the top half of the sheet reads as dirty paper,
not enamel. Averaging many artworks always converges on grey.

- **The tint follows the station.** For a foray, `--np-tint` is the enamel
  (`--seg-cN`) of the show under the needle, and it transitions to the next
  show's enamel over `--d-sheet` when the needle crosses a bar boundary
  (narration ticks keep the previous tint). This is the radio: the set warms
  to the station. For an episode, the artwork tint stays, with the fallback
  below.
- Episode tint fallback: after the 32x32 average, convert to OKLCH; if chroma
  < 0.04, use `--seg-cN` for that show instead of the grey. Clamp lightness
  0.45-0.6 (was 0.35-0.65; the low end reads as soot under the scrim).
- Keep the scrim at 0.78 and the 60% radial fade to `--paper`; keep the
  runtime contrast check.

### P0-6. Foray detail: the pinned Play collides with rows

At 393 the "Play" label pill sits on "Satay? Okay! · 1 segment"; at 375 the
keycap sits on the why-line. A pinned key is right; a pinned key on top of
unfaded text is not.

- On `#/foray` only, grow the bottom fade: `body.route-foray::after { height:
  calc(var(--deck-total) + var(--safe-b) + 132px); }` with the gradient stop
  at 60% so rows fade to paper under the pin.
- `.pin__label` gets `--shadow-deck` (it is on the deck layer now) and
  `--ink`; keep 15/700.
- `.screen--fdet` padding-bottom 140 is fine.

### P0-7. The knob icon is an alarm clock

The top-right button on Today and Yours renders a Phosphor alarm/timer. A
first-time user reads "set a timer". The direction asks for a knob.

- Replace with the custom `knob` mark on the 24 grid: a 2px-stroke circle r9
  at centre, a 2px radial tick from (12,5) to (12,9), and three 1.5px dots
  at 7, 12 and 5 o'clock positions outside the circle (r11). `aria-label=
  "Settings and dials"`.

---

## P1 — type, hierarchy, layout

### P1-1. Today hero is 100px over budget

At 393 the hero is ~420px (BUILD-NOTES: ~320), so "Also today" shows one
row before the deck. The cause is the title at 32/36 wrapping to three lines
plus 12px gaps everywhere.

- Hero title: `font-size: clamp(1.75rem, 7.2vw, 2rem); line-height: 1.125`
  (28/32 at 375-393, 32/36 at 412+), clamp 3 lines.
- Gaps inside the hero: eyebrow → title 10, title → band 12, band → discs 10,
  discs → why 12, why → keys 16. (`.hero { gap: 0 }` and explicit margins;
  the uniform 12 is what makes it feel padded.)
- Card padding 20 stays; Play 80 stays. Target: hero bottom ≤ 540px from the
  top at 393 so the first "Also today" row is fully visible above the mini.

### P1-2. Episode rows lose their titles to two trailing keycaps (direction changed)

"How Teams Are Working to Fix…" — the title gets ~185px because the row
trails a 44 "+" keycap and a 44 Play keycap. Podcast titles are long; the
row's job is to show them.

- Trailing: **Play keycap sm only** (persimmon, 44, radius 12).
- Add to Up Next moves into the meta line as a text action: after
  `show · 39 min`, right-aligned, `+ Up Next` at label 13/700 `--ink-2` with
  the plus icon at 16px; 44px tap height via the `::before` inset trick
  (`.chip` already does this). On add, the artwork chip flies to the Yours
  tab as specified; the text swaps to `✓ Queued` (`--good`) for 2s.
- Show name in the meta: `flex: 1 1 auto; min-width: 72px` so it never
  collapses to "Od…"; the duration readout `flex: none`.

### P1-3. Yours / Up Next: the ⋯ column is a column of keys (direction changed)

Five identical paper keycaps stacked at the right edge weigh as much as the
content. Keys are for actions you press to make something happen (play,
skip, add, follow, clear). A menu opener is not a key.

- `⋯` becomes `.iconbtn`: 44x44, no face, no lip, icon `--ink-2`, pressed
  state `--paper-2` fill at radius 12 on `--d-quick`. Same component for any
  future overflow opener.
- The current row: keep `--persimmon-soft` fill and the needle in the
  position column. The `Playing` tag loses its persimmon fill: transparent,
  text `--persimmon` 12/700, needle icon 14px, padding 0. The row fill
  carries the state; the word names it; the solid orange block was a third
  shout.
- Current row meta reads `Playing · 42 min left` only; the show name is
  dropped on this row (artwork and title identify it, and the mini player
  below repeats the show). Other rows keep `show · duration`.
- Position numbers stay mono 13 `--ink-3`.

### P1-4. Find idle (direction changed)

The "Name a subject" ultramarine keycap with a wrapping 13px hint beside it
is a button next to its own explanation, and the field at the bottom
already says "Search, or name a subject". Redundant and weak.

- Remove the keycap + hint row. Under the "Find" title, the readout line
  (the slot Today uses for the date) reads **"Type any subject and 4a builds
  a playlist"** at label 13/500 `--ink-2`.
- The ultramarine "Make a playlist about '{q}'" keycap stays in the typing
  state; its icon is Phosphor `sparkle` Bold, not the bridge mark (the
  bridge mark means Stretch, nowhere else).
- Large tile (`.tile--l`): the 132px collage in a 224px tile leaves a cream
  field. Collage becomes 2x2 of 88 (178px square), right-aligned and
  vertically centred; name and count stack at the bottom-left with 2px gap
  (remove `.tile--l > span:last-child { margin-top: auto }`); `min-height:
  196px`.
- Followed shows strip: items 72px wide (was 64), name 12/600 clamp 2 with
  `overflow-wrap: normal` so "Lingthusiasm" is not cut mid-word; the
  art 64.
- The fixed field sits on the mosaic at rest. On `#/search`, the bottom fade
  grows to `calc(var(--deck-total) + var(--safe-b) + 100px)` so tiles fade
  under the field.

### P1-5. Now Playing secondary row and readouts

- The "Up Next 4" chip is the widest item and squeezes the row at 375. It
  becomes icon + count badge only (`list` icon 20 + the 18px ultramarine
  badge), `aria-label="Up Next, 4 queued"`.
- The sleep chip reads "⏱ Off": name the control. `Sleep · Off` / `Sleep ·
  15 min`, the value in mono, the word in 15/700. The timer icon goes.
- Azeret's colon has wide sidebearings: "11 : 40". `.readout-lg { letter-
  spacing: -0.05em }` and wrap the colon in `<span class="colon">` with
  `margin: 0 -0.06em`. Apply the same colon span in the mini bubble and the
  remaining readout.
- The show chip under the title becomes `MP The Moreish Podcast` per P0-1,
  swatch 10px, code mono 11/700.

### P1-6. Onboarding

- The mono counter sits top-right of the card where a status-bar clock
  lives: it reads as a fake status bar. Move it to the readout row: `8:52 /
  22:10 · 6 shows`, the running part in `--ink`, the rest `--ink-2`. The
  watermark row keeps only the `4a` brand at left.
- The gap between the sub-line and the keycap is ~150px of cream at 393.
  Set `.onb__card { height: 60dvh }` at ≥ 800px tall viewports so the card
  takes the slack; at 375x667 keep 50dvh.

### P1-7. Bridge sentence must name its ends

The fixture's bridge reads "Parts wear into tolerance; words wear into
irregular forms. Same slow erosion, new field." It is a nice line and it
names neither subject; the copy rule says the bridge is stated. Replace
with **"Machining wears parts into tolerance; linguistics wears words into
new forms. Same slow erosion."** (13 words.) The bridge sentence always
contains the known subject and the stretch subject by name.

### P1-8. Fixtures and consistency

- Up Next count is 4 on Home/Now Playing and 5 on Yours. One fixture, one
  count: 5 everywhere.
- The hero band at 8px in a pill well with 4px padding reads as a toothpaste
  strip at 412 because the bars have 2px radius on a 8px height. Radius 1px
  for `.band--mini .bar`.
- Date readout under "Today" is mono 13 `--ink-2`; good. Yours has no
  readout line, so its title floats 8px higher than Today's. Give Yours the
  same slot: `5 queued · 4 hr 55 min` moves up there when the Up Next chip
  is selected, else the chip's own readout (`12 forays`, `8 shows`).

---

## P2 — polish

- `.row--show .swatch` (8x32) and `.segrow .sw` (24 code square) are two
  treatments of one thing; keep only the code square (P0-1).
- The Yours chip strip starts scrolled so "Forays" and "Shows" are clipped
  at the left edge with a 4px sliver visible. Scroll the selected chip into
  view with `inline: "nearest"`, not `"center"`, so the first chips stay
  whole when they fit.
- Mini band line: `left/right: 14px` insets leave the line short of the
  deck's rounded corners; set 22px (the deck radius) so the line starts
  where the straight edge starts.
- Keycap press depth (2px, lip to 1px) cannot be judged from stills. Record
  a 6-frame capture of the hero Play press in r2 (`tools/ui-lab` supports a
  sequence) so it can be tuned; this is Risk 1 in the direction.
- `tokens.css` drops the `--w-*` weight tokens from BUILD-NOTES §2.1 and
  app.css hard-codes 800/700. Fine for a prototype; restore them in Phase 3.

---

## Not changed, on purpose

- Transport centre at 82% of the viewport at 375x667: the direction says 72%
  or lower, never below the fold; it is lower and on screen. Leave it.
- The four-item secondary row mixing three chips and one keycap: the keycap
  is the only one that does something (bookmark); the chips show values.
  That is the rule, so it stays.
- Row `+`/Play being two keycaps on Today was my spec; the build showed it
  costs the title. Changed above (P1-2), not the builder's error.

## Round-2 acceptance

Ready when: every route in P0-3 is in the r2 set in both schemes; station
codes are unique in the fixture foray; nothing sits on unfaded content at
rest on Home, Find, Foray, Now Playing; the hero bottom is ≤ 540px at 393;
and the bridge card and gauge have been rendered and critiqued once.
