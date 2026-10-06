# Edition: critique, round 2

Art director's pass over the round-2 prototype (`prototype/`), 2026-10-05.
Judged against `DIRECTION.md` and `BUILD-NOTES.md`. Where the build exposed a
fault in the direction, the direction is changed (§6) and the builder follows
the changed text.

**Verdict: not ready. One more round, a short one.** Twelve of the thirteen
round-1 must-fixes landed as specified and the should-fixes with them; the
round-1 acceptance list passes on every point it names. What remains is one
fault the direction itself caused (the 4:3 contact plate crops every cover),
three finish faults on Now Playing and its motion, and copy that a judge will
read as broken. None of it is structural. A third round that does only §2 will
be the checkpoint build.

## 0. How this was judged

- Builder's shots: `data-local/redesign/shots/editorial/r2/` (Paper, default
  state, three viewports, plus `motion-393x852.webm`) and `r2-night/`,
  `r2-check/` (the 130% and onboarding checks).
- My renders, same harness: `r2-ad/` — Night on every route, Colophon,
  `first-run`, `offline`, `offline&dl=0`, `loading`, `mid-listen`, `text=130`
  on Today, Library, Foray and Now Playing, NP `paused|buffering|episode|large`,
  foray `progress|finished|unavailable`, search `history|fusion|kbd`,
  `library?cur=foray`, `noart=1` on three routes; at 393×852 and 375×667.
  `r2-ad-full/` has full-page captures of the five long screens.
  `r2-ad-light/` is the persistence check (`#/home?scheme=night` then `#/home`
  under `--scheme light`: the second renders Paper, so r1 must-fix 12 holds).
- The harness defaults to `--scheme dark`, so every `r2-ad` render is Night
  unless the route says otherwise; that is the harness, not the prototype.
- Motion: the webm tiled at 4 and 8 fps into
  `r2-ad/motion/motion-contact.png`, `motion-zoom-1.5-6.5s.png`,
  `motion-zoom-6.5-11.5s.png`. Still frames judge choreography and faults,
  not easing; the easing was read from `styles.css`.

## 1. What is right (keep it exactly)

- **Round-1 acceptance, point by point.** Up Next plates share one x (the
  current row's glyph sits in the 28px column, the `PLAYING` slug above the
  title, red spine on the left; the same treatment on the foray current row
  and in Contents). Onboarding's buttons sit on a solid band with a rule, the
  veil cut lets the lead plate through at 40%. The skip circles are visible on
  Night (`--rule-strong #66666E`). Now Playing at 130% on 375×667 keeps a
  200px plate, hides the note, ellipsizes the show name on the key line, and
  the five labels (`SPEED SLEEP BOOKMARK UP NEXT · 5 MORE`) no longer touch at
  any width. The editor's note is on Today's first screen at 100% and at 130%
  (393). No blank plate anywhere, including `noart=1` and the first two frames
  of the motion capture, where the initials hold the cells until the art
  lands. Contents numbers 1–11, narration rows carry the stitch glyph and no
  number, the key line reads `7 of 11`. The dateline is two set lines and the
  offline line sits above with `wifi-slash`. The Commission box is ruled with
  the pencil glyph; the pill is `.find` alone. The Resume row shows on
  `mid-listen` with its 4px progress rule and is gone whenever the ticker
  carries the item. The Stretch card's red spine runs slug to note.
- The front page is still the best first screen in the set: masthead,
  dateline, the one strong rule, kicker, Display-1, note, meta with the ink
  circle. The foray Now Playing with the segment title under the headline
  (`Investors who want earnings, not exits`) is the right second line.
- Night is a designed palette on every route I rendered, including the states
  r1 never saw: the offline dateline, the disabled play at 40%, the loading
  skeleton of rules, the Colophon's cream `Follow system` chip, the unavailable
  notice. The Now Playing tint reads warm on both schemes.
- Browse's `fusion` empty state is exactly the direction's sentence in
  Fraunces with the two subject rows beneath it. The `history` results page
  (Shows, Episodes with the `check` on a played row, Playlists with the 4px
  progress rule) is a clean ruled page.
- Motion, as far as stills show it: the ticker lifts into the sheet with the
  page behind scaled and dimmed; the row push and pop share the plate; the
  spring overshoots 1.2% (`--spring-sheet`, read from the file), under the 2%
  line; nothing animates `height`, `left` or `max-height` any more.

## 2. Must fix (priority order, with values)

1. **The 4:3 contact plate crops every cover.** The 2×2 contact is square by
   nature; at 4:3 each cell loses a quarter of its height and every
   typographic cover is beheaded: `Bootstrapped` is cut to its descenders,
   `Feel the Boot · The Science of Startups` loses its first and last lines,
   and the YC cover's orange border survives as a stray 1px red line down the
   plate's right edge (`home`, `foray`, `onboarding`, all viewports, both
   schemes). Podcast art is mostly type, so cover-cropping is not a cosmetic
   loss. This is the direction's fault, not the builder's, and §6 changes it:
   at 4:3 the plate is **lead-and-column**: the first content segment's show
   as a full-height square at the left, the next three shows stacked in a
   column at the right, `grid-template-columns: 3fr 1fr; grid-template-rows:
   repeat(3, 1fr)`, 1px `--page` gutters, no cell ever cropped. Square plates
   (Now Playing, rows, grids) keep the 2×2. Spec in `BUILD-NOTES.md` §4.3.
2. **Now Playing clamps the editor's note to one line at every height.**
   `.np-titles .note .t-note` is `line-clamp: 1` unconditionally, so
   `Eight ways to fund a company, from an in-law's…` ends in an ellipsis on
   393×852 and 412×915, screens with 110px of slack around the plate. The note
   is the second-loudest element in the direction; it may not end in an
   ellipsis where there is room. Clamp to **2 lines** by default, 1 line only
   under `(max-height: 700px)`, hidden under `(max-height: 700px)` at ≥ 120%
   text as already built. (§6.)
3. **The plate floats 62px above its rule.** `.np-plate-region` has
   `padding-bottom: 24px`, `.np-scrub` adds `margin-top: 16px`, and the rule is
   centred in a 44px hit area: 24 + 16 + 19 = 59–62px of air between the plate
   and the stitched rule on 393×852 (`now-playing`, `np=episode`, Night too),
   while only 50px separates the plate from the header. The plate reads as the
   header's. Set `padding-bottom: 8px` on the region and `margin-top: 0` on
   `.np-scrub`; the visual gap becomes 27px and the slack moves above the
   plate, which is where the should-fix in r1 asked for it. (§6.)
4. **Drag-to-dismiss selects text.** In the capture, `Up next: Spolia` carries
   a blue selection highlight from the first drag frame to the last
   (`motion-zoom-1.5-6.5s.png`, row 3 col 6 onward). Add `user-select: none;
   -webkit-user-select: none; -webkit-touch-callout: none` to the sheet's
   header row, grabber and plate region, and `preventDefault()` on the
   drag's `pointerdown`. Titles and notes below stay selectable. (§6.)
5. **The splatter hooks are fragments.** `data.json` has no `hook` field; the
   hooks are episode notes cut by `fitHooks` at the last clause boundary, and
   the result is `Guitarist and producer Nate Mercereau on the gear,
   philosophy.` — grammatical, and still a fragment a judge will read as a
   bug. Hooks are authored, never derived: write the six splatter hooks by
   hand into `data.json` (≤ 16 words, a complete sentence, copy rule), keep
   `fitHooks` only as the 3-line guard, and drop the clause-cutter. For the
   two visible ones, something like `Nate Mercereau on the gear and the
   philosophy behind his guitar sound.` and `How 'phobia' went from a founding
   father's coinage to a word for rabies.` In Phase 3 the classify pipeline
   writes the field; an item without one is not eligible. (§6.)
6. **Fallback initials are fixed at 20px.** In `noart=1` the lead's 265px
   cells and Browse's 170px plate carry a 20–24px initial that reads as a
   stray glyph, not a plate. Scale it with the cell: `container-type: size` on
   the cell and `font-size: clamp(14px, 28cqh, 64px)` on `.initial` (40px cell
   → 14, 64px row → 18, 170px plate → 48, 265px lead → 64). Keep the ink
   colour and the 16% wash. (§6.)
7. **The tint transitions.** `.np .sheet-panel` transitions `--tint-h` over
   `--t-page`, which repaints the whole sheet every frame for 320ms during the
   end-of-item cross-fade. Set it instantly; the plate and title cross-fade
   already cover the change. The motion rule in §1.6 now says colour animates
   on controls no larger than a chip. (§6.)

## 3. Should fix

- **`UP NEXT · 5` count sits on a different baseline from its label**
  (`library`, all viewports): the numeral is Fraunces and raised like a
  superscript. Set the count in the same `.t-label` run as the word, same
  size, same baseline; `FORAYS … 3` at the right edge is the other pattern and
  is fine, but one section head should not do both.
- **`All forays` / `All followed` / `All saved` feet read as headings**: 17px
  DM Sans 600 on their own line, heavier than the section head above them.
  Set the foot as `.t-meta` 13px 500 `--ink-2` with a trailing 16px
  `arrow-right` glyph from the sprite, 12px above the next rule. A "continued
  on" line, not a title.
- **Browse's `A playlist, on any subject` reads as a second heading** at 15px
  `--ink-2` beside the 12px label. Set it `.t-meta` 13px `--ink-3`.
- **Key line spacing on Now Playing**: `7 of 11 ·  The Bootstrapped Founder
  · 2 min left` has double spaces around the show name (the `.ell` span's
  margin plus the literal spaces). One `·` with 6px either side, no literal
  spaces inside the spans.
- **Offline, not downloaded**: the `cloud-slash` glyph sits on its own line
  above the meta instead of before it. Make the meta row `inline-flex; gap:
  6px; align-items: center`.
- **`fusion` empty state** leaves 1000px of page. Below the subject rows add a
  Commission line: `.t-text` `Or commission a playlist on` + a `.chip`
  `fusion` that focuses the Commission box with the query. It ties the two
  halves of Browse together and the empty page stops looking unfinished.
- **Page turn, the title**: the capture shows the ticker title flying with its
  ellipsis (`Robert Friedland on the Worl…` scaled up) and then cutting to the
  two-line title. The direction says the title cross-fades 15 to 24px; the
  plate and the rule are the shared elements, not the title. Cross-fade the
  title in place and let only the plate and rule fly. Not a must-fix because
  it is 160ms long and the stills cannot prove the scale.
- **Onboarding at 375×667**: the action band's top rule cuts through the
  veiled plate mid-cell. With the lead-and-column plate it will cut the lead
  cell instead; acceptable under the veil, but if the builder has time, give
  the veiled region `max-height` so the band's rule lands at the plate's
  bottom edge at this one viewport.

## 4. Data and prototype notes (carry forward, not design faults)

- Contents rows 7–9 are still three same-titled segments from one show
  (pipeline merge, Phase 3; unchanged from r1).
- The Up Next numerals start at `1` on the row after the current item
  (412×915 shows `1 Spolia`). Sensible: the current row has the glyph, the
  next is first in line. Keep.
- Newsreader at ~278KB stays over the 110KB budget; the Phase 3 subset is the
  fix, as the README says.
- The harness defaults to dark; any builder check that renders Paper needs
  `--scheme light`, as r2 did.

## 5. Motion (verified in stills and in the file)

Choreography is per §6.1–6.3; the page behind scales and dims; the row push
shares the plate; the spring is within 2%; no property outside
`transform`/`opacity`/colour is animated. The two faults are the selection
highlight (must-fix 4) and the full-sheet tint transition (must-fix 7). The
title's flight is a should-fix. Round 3: re-record the same 10-second capture
after the fixes; the selection highlight must be absent in every frame.

## 6. Direction changes made in this round

Written into `DIRECTION.md` and `BUILD-NOTES.md` today; the builder follows
the files, not this summary.

- 4:3 contact plates (lead, detail, onboarding) are **lead-and-column**; the
  2×2 stays for square plates. Cells are never cropped. (`DIRECTION.md`
  signature moments; `BUILD-NOTES.md` §4.3, §5.1, §5.6.)
- Now Playing note clamps to two lines; one line only at ≤ 700px tall.
  (§5.2, `DIRECTION.md` hero screens.)
- Plate region `padding-bottom: 8px`, `.np-scrub` margin 0; the plate sits
  27px over its rule. (§5.2.)
- Sheet header, grabber and plate region are `user-select: none`; the drag
  prevents default. (§6.1.)
- `--tint-h` is set, not transitioned; colour transitions only on controls
  no larger than a chip. (§1.6, §6.1.)
- Hooks are authored (`hook` field), never cut from descriptions; no field,
  no splatter slot. (§5.4, `DIRECTION.md` Browse.)
- Fallback initials scale with the cell, 14–64px. (§4.3.)

## 7. Round 3 acceptance

Ready when, at 393×852 and 375×667, Paper and Night: no cover is cropped on
Today, Foray detail or onboarding (the lead cell and the three column cells
are full squares); the Now Playing note shows two full lines on 393×852 and
one on 375×667, never an ellipsis with slack on screen; the plate sits within
30px of its rule; every splatter hook is a complete sentence with no cut
clause; `noart=1` initials are no smaller than 14px and fill the lead cell at
64px; and the re-recorded motion capture shows no selection highlight in any
frame. Plus §3's first three items, which are each one line of CSS.
