# Clarity prototype, round 2: what changed, what was measured

Builder's notes against `critique-r1.md`. Open `index.html` (file or http); the
header comment lists `?theme=` and `?state=`.

## Critique items

| # | Item | Done |
|---|---|---|
| 1 | why-line ink on every row | yes (`.row__why`), show line is caption muted |
| 2 | row 112 / lead 128 / head margin 24 | yes; board title 1 line (ellipsis), why 2 lines. Measured below |
| 3 | Signal budget | text buttons ink + chevron, "Later" muted, queue position muted; accent-ink text only on the bridge and the word "Now" |
| 4 | unplayed strip 62% | dark 62%, light raised per token (72 to 83%); table in the `clarity.css` header; lowest 3.01 (light c5), 3.34 (dark c3) |
| 5 | light + states | `?theme=` first statement of `clarity.js`; all nine `?state=` values built |
| 6 | foray on Today's first screen | Today order lead, Resume, Forays for you, Picked for you; default lead is the foray (strip bottom at y=228 of 852) |
| 7 | stretch row | bridge, show, title, why; data column duration only; `from ->` pair is nowrap |
| 8 | `3h 14m` | `fmtMin` only |
| 9 | queue row | title 1 line, 64px, position muted, "Now" is the Signal word |
| 10 | dock | see deviation 1 |
| 11 | docked Field | takes the dock material |
| 12 | hairlines | dark `--line` 16% |
| 13 | NP gap | 32px; see deviation 2 |
| 14 | Name a subject | 56px row, 44px circle, caption |
| 15 | subjects | eight rows then "All 11 subjects" (expands in place) |
| 16-21 | polish | legend 48px one line; first-run whys written (`fr` in data.json); lead eyebrow/show; counts 15px; Foray header eyebrow on the back line; mini progress track and radius |

## Deviations (art director to confirm)

1. **Dock is solid, not blurred.** At the critique's 0.94 tint row text was still
   readable through the capsule (checked at 2x), so I took the stated fallback:
   `--dock` is `#161618` dark / `#FFFFFF` light, no `backdrop-filter`, and a
   `--bg` shelf under the tab bar hides rows in the gutters around the capsule.
   DIRECTION s4 and BUILD-NOTES `Dock`/`Field` still say tint + blur.
2. **Now Playing artwork** is `min(100vw - 40px, 56dvh - 175px, 390px)`, not
   `100dvh - 420px`. The old rule gave 353px at 393x852, which pushed the
   control row off the bottom (the r1 clipping). New: 300px at 852, 198px at
   667 (transport still at about 560/667), 337px at 915.
3. **Density target is missed, honestly measured** (`r2-tools/measure.mjs`, rows
   fully above the tab bar, default state): 393x852 lead + **4** board rows
   (+ a fifth about a quarter visible); 375x667 lead + **2** (+ part of a third); 412x915
   lead + 4. Why: the foray lead is 144px (160 at 375, where its eyebrow wraps),
   plus the 28px stat line. Five full rows would need about 90px more at 393.
4. **Data.** The `fr` first-run reasons and the Fusion subject count (1 to 5, to
   match the direction's find-empty example) are prototype values, noted in
   `data.json`. The live data has one stretch pick, so the stat reads "6 picks
   · 1 outside your usual lane".
5. Onboarding at height <= 700 keeps why-lines to one line (the screen has no
   spare height); at 393x852 they take two.

## For the orchestrator

- Add `theme x state` to the shoot config. Until then these were shot by passing
  the query in `--routes`: `r2` (dark, 7 routes), `r2-light`, `r2-states`,
  `r2-states-light` under `data-local/redesign/shots/clarity/`.
- Recording of the three signature transitions: `r2-motion/clarity-transitions-393x852.webm`
  (mini to Now Playing, row to Foray detail, Today header collapse). Script:
  `r2-tools/record.mjs`.
- BUILD-NOTES 1.1 still has "(fill in)" for the unplayed-strip table; the values
  are in the `clarity.css` header.
