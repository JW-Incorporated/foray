# Clarity prototype, round 3: builder's notes against critique-r2

Shots: `data-local/redesign/shots/clarity/r3` (default, 21), `r3-light`, `r3-states`, `r3-states-light`.
Recording (393x852): `r3-motion/clarity-transitions-393x852.webm` (mini to Now Playing and close, drag dismiss,
row to Foray detail and back, Today header collapse, tab switch). Tools: `r3-tools/` (measure, scrub, record, flows).

## Items

| # | Done | How |
|---|---|---|
| 1 | yes | Composite is drawn once on a 256px master canvas (`ensureComp`, at boot and on play) and copied with `drawImage` into every slot. Open and close fly fixed clones (art, title) on the sheet's own spring; the real art slot keeps its tile (`--surface`) while the flyer is in the air; dock stays painted under the sheet. Verified at t = 20..420 ms by pausing animations (`r3-tools/scrub.mjs`). |
| 2 | yes | `pageSwap`: the 24px strip is cloned onto the row strip's rect, animates `translate+scale` (origin 0 0) to identity on `--t-3` `--ease`; every other element of the page fades in; a ghost of the old page fades out (`--t-1`). Reverse on back. |
| 3 | yes | One `.dock` capsule: mini 64, hairline, tab bar 56; one shadow; no shelf. Progress line inside at the top edge, inset 20px. Mini hidden: capsule is 56. |
| 4 | yes | Lead eyebrow "Today's lead" (nowrap), then show line ("Foray · 7 shows") in ink. |
| 5 | yes | Lead control is always the 44px circle; mid-play the data column reads "44 min / left". 92px variant removed. |
| 6 | yes | `Row--resume`: 2px progress line 4px under the art, 80px. |
| 7 | yes | Two date elements; `transform` + `opacity` only; scroll-driven over 48px under `@supports (animation-timeline: scroll())`, class toggle at 48px otherwise; hairline follows. |
| 8 | yes | Why's last line box to the strip: 32px at 393 and 412 (measured). At <= 700 high it is the compact 16px (episode 19px to the track). |
| 9 | yes | `.bridge__to` is nowrap (arrow + target); wraps as "fusion" / "-> materials science". |
| 10 | yes | Offline rows: bridge `--muted`, art `opacity .5`. |
| 11 | yes | Six subjects then "All 11 subjects"; "Shows you follow" head at y=575 and its first row ends at 656 (field top 728) at 393x852. |
| 12 | yes | `fmtMin`: `3h 05m`. |
| 13 | yes | Clock row is baseline-aligned (verified: buffering word sits on the digits' baseline). |
| 14 | yes | Onboarding at <= 700 high: two rows, two-line whys; three above. |
| 15 | yes | Skeleton rows are 112/144 high with hairline, 40x16 data block, 4px strip block under the lead. |
| 16 | no change | Already as asked: notes follow the finishing item until the swap, then the new item (`buildNP` after `playEp`). |
| 17 | yes | `.textrow + .sechead` margin-top 8 (Library: 8px between "All 14 shows" and "Forays"). |
| 18, 19 | flagged | 18 is a Phase 3 taxonomy pass; 19 confirmed in the recording. |

Tab switch is instant; the active icon's stroke steps 1.75 to 2.25 on `--t-1`.

## Deviations, for the art director

1. **Lead row measures 160, not 144.** Two caption lines (16 + 16) + two-line title (44) + two-line why (48) + strip (10) + padding 24. 144 is the min-height; the arithmetic of the anatomy gives 160. Density is unchanged: lead + 4 board rows at 393x852 and 412x915, lead + 2 at 375x667 (`r3-tools/measure.mjs`).
2. **Dock height animates** (56 to 120 on `--t-2`) so the capsule follows the mini; it is the one non-transform animation, on a 64px change, clipped by the capsule. Everything else in the dock is `transform`/`opacity`.
3. **View Transitions are gone**, not deferred: FLIP covers the three transitions in every browser, so there is one path to test.
4. Row to Now Playing (tapping an episode row) flies the row's art and title, not the mini's, because the mini is not yet showing that item.
5. The 12px under the capsule shows scrolling rows (no shelf, per item 3). It is the floating margin, not a gap inside the dock.
6. Light-scheme motion recording not made (stills only).
