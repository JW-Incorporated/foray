# Clarity prototype, round 4: builder's notes against critique-r3

Shots: `data-local/redesign/shots/clarity/r4` (default, 21), `r4-light`, `r4-states`, `r4-states-light` (27 each).
Recording (393x852): `r4-motion/clarity-transitions-393x852.webm`. Tools: `r4-tools/` (`measure4.mjs`, `probe-close.mjs`, `scrub.mjs`, `fit.mjs`).

## Items

| # | Done | How |
|---|---|---|
| 1 | yes | `.row` is a grid of three rows: art / stack / data column, then `.row__why` at `grid-column: 2 / -1`, then the 4px strip, same width. Why clamps at three lines. Measured at 393: rows 112 / 136, lead 160 / 184, stretch 136 / 160; why 285px (board) and 269px (lead); strip 269px on the lead. Skeleton: three why bars, rows 138, lead 184. Onboarding at <= 700 high: headline at 22/26, 32px top padding, two rows, `#view` top padding removed so the page no longer scrolls 12px. Now Playing why: three lines, two at <= 700 (never one). |
| 2 | yes | Close is the open played backwards, one group, one duration (`--t-3`, `--ease`): sheet, scrim (1 to 0 linear over the whole exit; a drag brightens the page in step with the sheet and the release continues from there), art flyer, title flyer. Content (top bar, show, why, scrubber, transport, control row, sections) fades out in the first 120 ms. While `.is-flying` the art slot is `transparent` with no hairline, both directions. Open fades the same content in from 16px below over the second half. The mini's own title crossfades with the title flyer over the last fifth, so a two-line sheet title never lands as a block over the mini's show line. A second bug found on the way: `history.back()` fires `popstate` and `hashchange`, and the second one re-rendered the page behind (and reset its scroll); `onNavEvent` now ignores it. |
| 3 | yes | Library grid names: `caption` muted, two-line clamp, 4px under the art ("Lex Fridman Podcast" wraps; "FermUp - The Fermented Food Podcast" is three lines long and still clamps). |
| 4 | yes | Up Next: a started item is "35 min" over "left", an unstarted one is its duration. |
| 5 | yes | Up Next count = items after the one playing, everywhere (Library head and Now Playing control row both read 8). |
| 6 | yes | Mini progress track is `--line`, the same as the rim. |
| 7 | yes | np-end: title slot rises early, artwork stays the finishing item's until 0:00, then art and title crossfade on `--t-3`. |
| 8 | yes | One position per item: `forayPos()` reads the player when the foray is playing. midlisten seeds 9:40 everywhere (lead "44 min left", mini, Library Now row, detail "Resume at 9:40"). Default `#/mini` reads 35 min left in all four places. |
| 9 | not done | Optional. The ghost still fades on `--t-1`; the two pages overlap for about 80 ms at a third of their opacity. |
| 10 | flagged | Phase 3 taxonomy pass. |

## Density (measure4.mjs, dark, with the mini showing where stated)

| Viewport | Home, no mini | Home with mini (`#/mini`) |
|---|---|---|
| 393x852 | lead + 3 full rows | lead + 2 full rows + the third's title (as predicted) |
| 412x915 | lead + 3 full rows + the fourth's title | lead + 3 full rows |
| 375x667 | lead + 1 full row + the second's title | lead + 1 full row |

At 375x667 the second row is the stretch row (172: the bridge wraps to two lines).

## Things the art director should know

1. **The geometry alone does not make every hook finish.** `fit.mjs` sets all 40 hooks in the real column widths: three lines hold about 90 characters, not 102 (words do not break at the line end). 10 of 40 hooks still need a fourth line at 285px, 16 at 269px. The three on-screen picks (Lex #353, Damascus steel, Fall of Civilizations) are among them, so as shipped they would have been cut again. Fix applied in the data, not the layout: those three why-lines and the foray's are trimmed to 69 to 90 characters (Damascus uses the sentence from `DIRECTION.md`), with the untrimmed text kept beside them as `hook_full` / `why_full` in `data.json`. Result: no why on any screen is clamped at 375, 393 or 412 (`measure4.mjs` reports `cut: []`). The 30 hooks that fit are untouched. The copy rule (16 words) can run to 113 characters; a character budget of about 90 belongs in the writer's brief.
2. Mid-play lead: the data column (circle 44 + "35 min" + "left") is 86px at the old spacing, taller than the 76px stack above the why, which grew the row to 194. The column now sets its two text lines at 18 and 14 line height with no gap: 76px, row 184.
3. Offline lead: the "saved" badge rides the eyebrow ("Today's lead" + badge) instead of stacking under the duration, for the same reason (row 200 became 184).
4. Loading: three board rows under the lead (BUILD-NOTES 4.1), not four.
5. Row grid: the art spans two grid rows, not three; with three, Chrome gave the empty third row 8px and every row measured 144.
6. The harness `--url` takes a file path, not a `file:///` URL.
