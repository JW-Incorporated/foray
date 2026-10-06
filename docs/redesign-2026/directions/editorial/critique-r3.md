# Edition: critique, round 3

Art director's pass over the round-3 prototype (`prototype/`), 2026-10-05.
Judged against `DIRECTION.md` and `BUILD-NOTES.md`. Where the build exposed a
fault in the direction, the direction is changed (§6) and the builder follows
the changed text.

**Verdict: not ready. One more round, shorter than the last.** Every round-2
must-fix landed and the round-2 acceptance list passes on every point but one
(two splatter hooks still end in an ellipsis). The static screens are now at
checkpoint quality on both schemes and all three viewports. What stops the
verdict is motion: the prototype turns its own signature move off whenever
the harness is watching, so no capture has ever shown the page turn, and the
row-to-detail push reads as a double exposure. Both are small to fix and
neither can be waved through, because the page turn is the delight the
direction promises editors will see first.

## 0. How this was judged

- Builder's shots: `data-local/redesign/shots/editorial/r3/` (Paper, default
  state, three viewports, `motion-393x852.webm`), `r3-night/`.
- My renders, same harness (`--scheme light`): `r3-ad/` — Night on every
  route and the Colophon, `noart=1` on five routes, `first-run`, `offline`,
  `offline&dl=0`, `loading`, `mid-listen`, `text=130` on Today, Library, Foray
  and Now Playing, NP `paused|buffering|episode|large`, foray
  `progress|finished|unavailable`, search `history|fusion|kbd`,
  `library?cur=foray`; at 393×852 and 375×667. `r3-ad-full/` and
  `r3-ad-full2/` are full-page captures of the long screens.
- Motion: the webm tiled with ffmpeg into `r3-ad/motion/`: `motion-contact.png`
  (4fps), `motion-zoom-1-6s.png` and `motion-zoom-6-11s.png` (8fps), and two
  25fps strips, `motion-open-25fps-1.5-3.9s.png` (the page turn) and
  `motion-push-25fps-7.6-9.2s.png` (the dismiss and the push). 25fps is the
  recording rate, so a 320ms transition should occupy about eight frames.
- The round-2 acceptance list (`critique-r2.md` §7), point by point, in §1.

## 1. What is right (keep it exactly)

- **Round-2 acceptance.** No cover is cropped anywhere: the lead-and-column
  plate shows the first show as a full square at the left and three full
  squares in the column, on Today, Foray detail and onboarding, 375 and 393,
  Paper and Night; square plates keep the 2×2 and the Now Playing plate shows
  four whole covers. The Now Playing note is two full lines on 393×852 and
  412×915 and one line on 375×667. The plate sits 30px over its rule on 393
  and on 375, with the slack above it. `noart=1` initials are 64px in the lead
  cell, 24px in the column cells, 49px in the Now Playing cells, 18px in rows.
  No selection highlight in any frame of the capture. `UP NEXT · 5` is one
  run on one baseline; `All forays →`, `All saved →`, `All followed →` are
  13px feet with the arrow; `A playlist, on any subject` is 13px `--ink-3`;
  the key line has one `·` with even space; the `fusion` empty state ends in
  `Or commission a playlist on [fusion]`.
- The front page is finished. Masthead, two-line dateline, the strong rule,
  kicker, Display-1, the lead-and-column plate, the stitched rule, the
  two-line key with `+5 shows`, the editor's note on its red rule, meta with
  the ink circle: all on the first screen at 393×852, and the note still makes
  the first screen at 375×667. Below it, the numbered list with the Fraunces
  numerals and the Stretch card's red spine from slug to note, More forays,
  Your subjects, `Assembled 6:12 this morning · Why these?`.
- Foray detail is the best long page in the set: kicker, headline, plate,
  rule, the full seven-show key, note, the Play row, Contents with dot leaders
  and the stitch glyph on the narrated lines, Where this came from as ruled
  rows with each show's plate, and the About paragraph, which is the direction
  in four sentences ("Audio plays from the publishers' own feeds, untouched").
- Now Playing: plate, rule, clocks, key line, Display-2 title, the segment
  title as the second line, note, transport, the labelled row. At 130% on
  375×667 the note hides, the key line ellipsizes the show name, the five
  labels stay apart. The episode variant on Night (Odd Lots on ink with a
  cool tint) and the foray variant on Paper (warm tint) are both designed.
- Night is designed on every route I rendered, including the states: the
  offline dateline, the loading skeleton, the disabled play at 40%, the
  unavailable notice, the Colophon chips.
- Drag-to-dismiss and the dismiss itself record correctly: the sheet follows
  the finger, the page behind scales and dims, the spring-back is visible,
  the close slides the sheet out over about five frames.

## 2. Must fix (priority order, with values)

1. **The page turn is a hard cut under the harness, so it has never been
   seen.** `openNP` passes `instant: !booted || webdriver` to `openSheet` and
   `flyPlate` is skipped when `navigator.webdriver` is true. The capture is
   recorded under Playwright, so in `motion-open-25fps-1.5-3.9s.png` row 2
   col 8 is Today with the ticker and col 9 is the full Now Playing sheet:
   40ms, no sheet rising, no plate in flight, no rule stretching, no page
   scaling behind. Round 2's "the ticker lifts into the sheet" was read off
   the spring-back after a drag, not the open. Fix: the webdriver guard
   freezes the playhead and keeps `?np=…` route-opens instant (static renders
   must repeat), and nothing else. A tap on the ticker runs the full
   choreography under the harness, and `?motion=1` on any route runs every
   transition. Re-record the same 10-second capture by tapping, with
   `?motion=1`, at 25fps; the open must occupy at least eight frames showing
   the sheet rising on `--spring-sheet`, the 40px plate scaling into the large
   plate, the red progress rule travelling into the scrubber, the title
   cross-fading in place, and the page behind at `scale(.96)` and 82%. (§6,
   `BUILD-NOTES.md` §6.1 and §10.)
2. **The push is a double exposure.** `push-in` fades the incoming page
   0 → 1 over the whole 320ms while `vt-out` leaves the outgoing at .9, so in
   `motion-push-25fps-7.6-9.2s.png` row 3 col 1–2 both Display-1 headlines
   are readable at once, one 16px above the other, and the same on the pop in
   `motion-zoom-6-11s.png` row 4 col 4. Keyframes: `push-in { from { opacity:
   0; transform: translateX(24px) } 31% { opacity: 1 } to { opacity: 1;
   transform: none } }` so the incoming page is opaque after 100ms;
   `vt-out { to { opacity: .6; transform: translateX(-8px) } }`; mirror for
   `pop-in` and `html.vt-back`. The incoming page stays above the outgoing
   (View Transitions already put `new` above `old`; give the `?vt=0` FLIP path
   the same `z-index`). (§6, `BUILD-NOTES.md` §6.2.)
3. **Two splatter hooks are clamped with an ellipsis.** The hooks are authored
   now, but two of the six run to four lines in the 170px column at
   Newsreader 14/20 and the three-line clamp cuts them: `Why databases dodge
   the hardest distributed problems, and what Rust…` (85 characters) and
   `Seven Navy destroyers ran aground at Honda Point, the largest peacetime
   loss…` (93). Sixteen words is the wrong unit for a narrow column; the
   limit is **72 characters** including the full stop. Rewrite the two:
   `Databases dodge the hardest distributed problems. Rust borrows the trick.`
   (72) and `Seven destroyers ran aground at Honda Point in one night, in
   1923.` (65). Keep the clamp as the guard, but `fitHooks` marks an
   overflowing item `data-hook-overflow` and logs `console.error`, so an
   overflow fails the README's check instead of warning. (§6, `BUILD-NOTES.md`
   §5.4 and §10.)

## 3. Should fix

- **`Forays by commission come later.`** is the first sentence on Browse and
  reads as an apology for an unbuilt feature; it was my line (§5.4) and it was
  wrong once built. Drop it. Commission is today's Create: submitting the
  field or tapping a chip opens the results page for that subject with the
  `PLAYLISTS` group first (the prototype already renders `History, set in
  order` for `?q=history`), then `SHOWS` and `EPISODES`. (§6.)
- **Queued rows carry a bare `check`.** On Today's Also-today list, in Saved
  and in search results, an episode already in Up Next shows `check` where the
  others show `list-plus`. Next to an episode a bare check reads as "played"
  (every other podcast app uses it so), and Saved mixes the two meanings in
  one column. Use `list-checks` for the queued state, same 24px frame, same
  `aria-pressed`. One token in `queueBtn` and one in the §6.3 cross-fade.
  (§6, `BUILD-NOTES.md` §4.12.)
- **Onboarding, the band's rule cuts a line of type.** At 393×852 the top
  rule of `.first-actions` runs through the second line of the lead's note
  (`A first edition, picked widely. Play one and` with the descenders of the
  next line showing above the band). Give the band a 48px fade above its rule:
  `.first-actions::before { content: ""; position: absolute; left: 0; right:
  0; bottom: 100%; height: 48px; background: linear-gradient(to bottom,
  transparent, var(--page)); pointer-events: none; }`. The veiled page then
  dissolves into the band at every viewport and the 375×667 `max-height` from
  round 2 is no longer needed. (§6, `BUILD-NOTES.md` §5.7.)
- **`40 min · 1 show` under a four-cover plate.** The second More-forays row
  (`How Earth got plate tectonics and Venus never did`) shows a 2×2 contact
  of four covers and a six-segment rule in five inks over the meta `1 show`.
  The data note in r2 §4 explains why, but a judge reads a contradiction. Set
  `shows` to the key's length for both borrowed forays, and derive the meta
  from the key everywhere so the three cannot disagree. (`BUILD-NOTES.md`
  §10.)
- **Browse's Followed grid in full-page captures.** In both of my full-page
  renders four or five of the eight Followed plates on Browse render as
  initials (`C P M O`, once `T`) while Library's grid, same `S.followed`
  array, same URLs, renders every cover; the set differs between the two
  runs, so this is load timing on a tall page rather than a wrong URL. Verify
  with a viewport render scrolled to the grid; if the covers are there, note
  it in the README and move on. If they are not, it is a must-fix.

## 4. Data and prototype notes (carry forward, not design faults)

- Contents rows 5–7 are three same-titled segments from one show (pipeline
  merge, Phase 3; unchanged since r1).
- Newsreader at ~278KB stays over the 110KB budget; the Phase 3 subset is the
  fix.
- Now Playing on 375×667 has 60px between the header and the plate and 30px
  between the plate and its rule. That is the slack landing where round 2
  asked for it; the plate reads as the rule's. Keep.
- The Library ticker's red progress rule sits directly under `All forays →`
  at 375×667 and reads, in a still, as an underline. It scrolls; keep.
- The harness defaults to dark; any builder check that renders Paper needs
  `--scheme light`.

## 5. Motion (what the stills prove and what they cannot)

Proved: no selection highlight in any frame; the drag follows the finger with
the page behind interpolating scale; the spring-back and the close both
record over several frames; the row push shares the plate, which lands in the
detail plate's position in the first frame; nothing animates outside
`transform`/`opacity` (read from the file). Not proved: the page turn itself
(must-fix 1, never recorded) and the title cross-fade in place, which depends
on it. The push's double exposure is must-fix 2. Round 4: the same 10-second
capture, re-recorded by tapping with `?motion=1`, and the two 25fps strips
re-cut from it; I will judge the open from the strip.

## 6. Direction changes made in this round

Written into `DIRECTION.md` and `BUILD-NOTES.md` today; the builder follows
the files, not this summary.

- The harness guard freezes the playhead only; taps and `?motion=1` run every
  transition under the harness; the motion capture is recorded that way.
  (`BUILD-NOTES.md` §6.1, §10.)
- Push: incoming opaque within 100ms, outgoing dims to 60%; two headlines are
  never readable at once. Pop mirrored. (`DIRECTION.md` motion 2;
  `BUILD-NOTES.md` §6.2.)
- Splatter hooks are ≤ 72 characters as well as ≤ 16 words; an overflow is a
  failed check. (`DIRECTION.md` Browse; `BUILD-NOTES.md` §5.4, §10.)
- Browse carries no deferral line; Commission submits to results with the
  playlist first. (`DIRECTION.md` Browse; `BUILD-NOTES.md` §5.4.)
- Queued state is `list-checks`, never a bare `check`. (`BUILD-NOTES.md`
  §4.12, §6.3.)
- The onboarding band fades the veiled page in over 48px above its rule.
  (`DIRECTION.md` hero screens; `BUILD-NOTES.md` §5.7.)
- A foray's `shows`, key and plate are one fact. (`BUILD-NOTES.md` §10.)

## 7. Round 4 acceptance

Ready when: the re-recorded capture, cut at 25fps, shows the page turn over
at least eight frames (sheet rising, plate in flight from 40px to the large
plate, rule travelling into the scrubber, page behind scaled and dimmed,
title cross-fading in place) with no selection highlight in any frame; no
frame of the push or the pop shows two headlines at readable opacity; every
splatter hook renders whole at 393×852 and 375×667 with no `data-hook-overflow`
in the DOM; Browse has no deferral line and a chip opens results with the
playlist group first; queued rows show `list-checks`; the onboarding band
fades in at both viewports; the More-forays meta agrees with its plate.
Nothing in §1 may move. If that list passes, this is the checkpoint build and
round 4 needs no critique beyond a one-line confirmation.
