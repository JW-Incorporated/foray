# Edition: critique, round 4

Art director's pass over the round-4 prototype (`prototype/`), 2026-10-06.
Judged against `DIRECTION.md`, `BUILD-NOTES.md` and the round-4 acceptance
list in `critique-r3.md` §7.

**Verdict: ready. This is the checkpoint build.** Every point of the round-4
acceptance list passes, nothing in round 3's "keep it exactly" list moved, and
the one thing I would still have changed (the page turn's spring) was a single
token inside this direction's own path, so I retuned it, re-recorded the same
capture, and measured it rather than spend a round on it. No further round
would materially improve the prototype; what remains is Phase 3 work (font
subset, pipeline data) and is listed in §4.

## 0. How this was judged

- Builder's shots: `data-local/redesign/shots/editorial/r4/` (Paper, three
  viewports, contact sheets), `r4-night/`, the builder's checks in
  `r4/checks/` and the motion strips in `r4/motion/`.
- The builder's acceptance script (`r4/motion/check.mjs`) re-run by me into
  `data-local/redesign/shots/editorial/r4-ad/checks/`; its numbers are quoted
  below as mine, not the README's.
- Motion: per-frame luminance difference of the builder's capture
  (`ffmpeg tblend=difference,signalstats`) to count the frames the open
  occupies, and my own 25fps tiles at full size (`r4-ad/open-2.52-3.12s-25fps.png`).
  After the retune, the same capture re-recorded with the builder's
  `record.mjs` into `r4-ad/motion/` (`motion-393x852-retuned.webm`,
  `open-retuned-1.88-2.48s-25fps.png`, `motion-retuned-contact-5fps.png`).

## 1. Round-4 acceptance, point by point

1. **The page turn is recorded and spans eight frames or more.** Builder's
   capture: twelve consecutive frames of change from 2.64s to 3.08s (luminance
   difference 18 → 41 → 35 → 40 → 26 → 17 → 21 → 13 → 10 → 5 → 3 → 2 on a scale
   where a static frame is 0.01). The tiles show the sheet rising, the 40px
   plate in flight and scaling into the large plate, the red rule travelling
   under it into the scrubber, the page behind scaled and dimmed, and the
   title cross-fading in place. No selection highlight in any frame.
2. **The push is no longer a double exposure.** `push-in` is opaque at 15%
   (48ms), `vt-out` dims to 60% and moves 8px, `new` above `old` with
   `mix-blend-mode: normal`. One 40ms frame still shows the outgoing headline
   as a ~20% ghost under the incoming page's whitespace (the first frame,
   caught at ~75% opacity); it is not readable and it is one frame. The pop is
   mirrored and clean: the leaving page stays opaque on top and slides right,
   the list underneath eases .6 → 1.
3. **Splatter hooks render whole.** `hookOverflow: 0`, six hooks, at 393, 375
   and 412; `errors: 0`. The two rewrites are 70 and 66 characters, and the
   third the builder found at 375 (`Anansi…`, 63) is a better line than the
   one it replaced.
4. **Browse carries no deferral line, and a chip opens results with the
   playlist first.** `deferral: false`; chip and typed-Enter both give
   `Playlists, Shows, Episodes`. `The history of salt, set in order · 2
   episodes · new` leads the page.
5. **Queued rows show `list-checks`.** `addedIcon: #list-checks`,
   `anyBareCheck: 0`; the `Added to Up Next · Undo` band is on the ink stock.
6. **The onboarding band fades in at both viewports.** `::before` is 48px; at
   393×852 the note's second line dissolves into the band, at 375×667 the
   plate does, and no rule cuts a line of type at either.
7. **The More-forays meta agrees with its plate.** `22 min · 6 shows` over six
   inks and four covers; `40 min · 4 shows` over four inks and four different
   covers (the repeated cover is gone). `forayInks` reads `7, 6, 4`.
8. **Browse's Followed grid** renders 8 of 8 covers when scrolled to in a
   viewport render (`followedImgs: 8`, `followedFallbacks: 0`); the initials
   in round 3's full-page captures were load timing, as the builder said.

Round 3 §1, unchanged: the front page, the lead-and-column plate with no cover
cropped, the two-line key with `+5 shows`, the red spine on the Stretch card,
Foray detail's Contents and Where this came from, Now Playing's plate / rule /
clocks / key line / Display-2 title / segment line / note / transport /
labelled row, Night on every route, and the 375×667 and 412×915 variants all
match the round-3 renders.

## 2. What I changed, and why it did not need a round

The builder met the brief: the sheet opened on `--spring-sheet` over 420ms. But
the curve I had specified in `BUILD-NOTES.md` §1.6 (stiffness 260, damping 28)
reaches 0.99 at 35% of its duration, so the sheet had effectively landed by
146ms and then sat still for 270ms while the plate and the rule, flying on a
plain `--ease-out`, were still arriving. In the full-size tiles the sheet is
up at 2.76s and the plate is still scaling at 2.80s; the three parts of one
gesture landed ~100ms apart, and the sheet read as a drawer snapping, not a
page turning. That was my token, not the builder's error.

Retuned, in the prototype and in both documents:

- `--spring-sheet` is now stiffness 230 / damping 28 / mass 1 over 420ms:
  50% at 105ms, 90% at 230ms, 99% at 365ms, no visible overshoot
  (`styles.css`, `BUILD-NOTES.md` §1.6, `DIRECTION.md` motion 1).
- The plate and the rule fly on the same `linear()` string, read from the
  stylesheet at run time, so the three land in the same frame; the title
  fades in over the sheet's second half (opacity 0 until 40%); the rule
  travels for the full 420ms, then thickens and fades over `--t-micro` into
  the real scrubber (`app.js` `flyPlate`, `BUILD-NOTES.md` §6.1).

Measured on the re-recorded capture: eleven consecutive frames of change
from 2.04s to 2.44s with an even profile (24, 25, 31, 27, 35, 31, 28, 26, 17,
15, 10) instead of a spike in the first three frames; the sheet, plate and
rule arrive together at 2.28–2.32s and the title completes at 2.36s. Drag
spring-back, dismiss, push and pop are unchanged in the same recording, and
there is still no selection highlight in any frame. `node --check` passes and
the recording logs no console error.

## 3. Minor, noted, not blocking

- The push's single ghost frame (§1.2) comes from the incoming view's own
  background being transparent during the first 48ms. If it ever shows at
  higher opacity on a slower device, give `.view--push` and
  `::view-transition-new(root)` `background: var(--page)`; not worth a round.
- The 375×667 Browse viewport puts the floating search field over the first
  splatter hook (`Podcast 562: Nate Mercereau`) at rest. Floating chrome over
  scrolling content is the design; the hook is whole once scrolled. Keep.

## 4. Carry forward to Phase 3 (not prototype faults)

- Newsreader at ~278KB stays over the 110KB budget; subset it in Phase 3.
- Contents rows 5–7 are three same-titled segments from one show (pipeline
  merge, unchanged since round 1).
- Playback is simulated; haptics, edge-swipe back, pull-to-refresh and the
  sticky scrubber on scroll are Web+ and unbuilt, as the README says.
- The spring parameters above are the motion tokens Phase 3 should start
  from; regenerate the `linear()` from them rather than hand-editing points.
