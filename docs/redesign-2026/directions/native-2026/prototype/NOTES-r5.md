# native-2026 prototype, round 5 hand-off

Applies `critique-r4.md` in priority order. Shots: `data-local/redesign/shots/native-2026/r5/`
(the seven-route set at the root, the full matrix in `ios-dark`, `ios-light`, `android-dark`,
`android-light` and the two reduced-transparency folders; `checks/` holds `check.mjs`, `extra.mjs`,
`matrix.mjs` and their output). Run the matrix with `node checks/matrix.mjs`, the checks with
`node checks/check.mjs [A..J]`.

## What changed

- **P1 1, stitch.** `.stitch` now lives in the chip's overhang band on the card's surface: rail
  `left: 42px; bottom: -6px`, row `left: 22px; bottom: -5px`, same gradient, 2px, .45. It never
  touches the cover.
- **P1 2, rail height.** Bridge cards show sentence + one footer "show · length" and no episode
  title. Rail sentence 17/22 clamp 3, footer in `--t-footnote`. The row sentence is 19/26 clamp 3
  with the same footer; the 8px `.row-body` indent is gone. The rail line is the director's
  ("Like Don't Panic Geocast, but deeper into how plates began.", 10 words) and fits three lines.
- **P1 3, chip.** Rail chip 32px, `left: 8px; bottom: -10px`, radius 8, 2px `--surface` ring. Rows keep 24.
- **P2 4, Now Playing scroll.** `&scroll=` reaches `#np-scroll` on `#/now-playing`. Routes
  `#/now-playing?scroll=720`, `?state=episode&scroll=720` and `#/home?scroll=1500` are in the matrix, both OS, both schemes.
- **P2 5, chip pop.** Centred on the tapped bar, clamped to the gutters, 6px tail (`--tail`) on the bar.
- P2 6, 7, 8: no change, as the critique says.

## Two things found while doing it (not in the critique)

1. **Class collision.** The rail's sentence carried the class `rail`, which is also the horizontal
   scroller (`.rail { display: flex; padding: 0 16px 4px; overflow-x: auto }`). It gave the sentence
   32px of side padding (a 136px measure, which is why 10 words ran 4 lines), 4px of bottom padding,
   and replaced the line clamp with `display: flex`. Renamed `.voice.vrail`. The 4-line rail card
   in r4 was partly this bug, not only the copy length.
2. **Footer names.** Several shows carry a tagline ("Sticky Notes: The Classical Music Podcast").
   `shortShow()` keeps the part before the colon, so the footer reads "Sticky Notes · 54 min" and
   never cuts the show name.

## Decision that departs from the critique's numbers

The critique asks for the rail eyebrow at "cover + 18" and also for check E unchanged (eyebrow
baseline within 2px of the neighbours' title baseline). They cannot both hold: at `margin-top: 18px`
the eyebrow sits 12px above the neighbours' baseline (measured, delta 12.0). I kept the baseline
(`margin-top: 30px`, delta 0.0 on all 12 platform/scheme/viewport pairs) and recovered the height
budget elsewhere (no gap above the sentence, 2px above the footer). Result: bridge card 300px
against the tallest plain RailCard's 253, a 47px difference against the 48 allowed.

## Checks (all PASS in `checks/check-output.txt`)

- **G** stitch box outside the cover box and >= 20% luminance from the surface, with covers
  stubbed white (worst case): rail 37-45%, row 35-40%, all four pairs. Boxes are printed per line.
- **D** zero clipped `.voice` elements across 276 renders.
- **E** eyebrow baseline delta 0.0 on 12 pairs; chip overhang 10.
- **H** rail height: bridge bottom 972/1024 vs tallest plain 925/977 (diff 47px), 10 words, 3 lines.
- **I** chip pop centre equals the bar centre to 0.0px, tail within 0.1px, at 393, 375 and 412.
- **J** `#np-scroll` reaches 720 (foray) and its maximum (episode) on both OS.
- A, B, C, F as in r4, unchanged.

Harness note: `shoot.mjs --url` takes a repo path, not a `file:///` URL, and Git Bash rewrites a
bare `#/home` argument into `C:/Program Files/Git/home`; run it from PowerShell or spawn it
without a shell (as `matrix.mjs` does).
