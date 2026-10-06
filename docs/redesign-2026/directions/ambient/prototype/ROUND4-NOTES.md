# Round 4 builder notes (for the art director)

Applies `critique-r3.md` items 1-8 in priority order. `tools/qa.mjs` now asserts 163 facts (27 new for round 4), 163/163 pass, 0 console errors. Shots: `data-local/redesign/shots/ambient/r4/` (default routes, three sizes) and `r4/states/` (every state, Dusk and Dawn, 393x852 and 375x667).

Deviations and findings, each measured:

- **Item 1, onboarding.** Applied as written (top-anchored sleeves, 176px at every height, strip +24, title +28, buttons bottom-anchored). The written stops put the sleeves at `safe-top + 72`; the wordmark row actually ends at `safe-top + 54`, so the sleeves start at `+94` (asserted: 40px gap). The scrim stops follow the measured box. The ramp's mid stop is at the strip (`+24` under the box) as written, but it starts 70px before the box ends, behind the sleeves' lower edge: a 24px ramp drew a hard seam at 412x915 (the same seam round 3 documented for Foray detail).
- **Item 2, Dock cast.** Written CSS, with two changes. Anchored `bottom: safe-bottom + 12 + dock-h - 24` (the Dock's top edge, not the screen bottom, where the Dock would cover two thirds of it). Hidden when nothing plays (`#app:not(.has-mini)`), which is the brief's "nothing is tinted when nothing plays". `?mini=0` now really hides the mini player, so `discover-idle-nomini` shows that state. It is deliberately quiet: 14% Glow behind raised tiles reads as a warmer floor, not a lamp. I did not raise it; the contrast rows leave room (below).
- **Item 3, collages.** Written CSS. c2 and c3 first squares whole and on top in Library at both sizes (asserted by hit-testing the first square's centre).
- **Item 4, strip.** Written fix (current bar grows upward; thumbs at `+6`) was not the whole cause. The bars are `<button>`s and a button centres its content, so a 28px bar sat 13px down in its 54px box while the thumbs row was placed from the top. `.strip.thumbed .sb` is now a top-aligned flex column, `--bt` is 4px and `--hit` 54px on the 48px strip. Every bar, the current one included, now clears its thumbnail by 6px (asserted).
- **Item 5.** Up Next peek: "4a added" eyebrow, title, one meta line (duration once), then the item's `hook` as a Fraunces italic `--text-2` why-line, two-line clamp.
- **Items 6 and 7.** Car title clamp 3 at >= 800px tall, 2 below; `np-ending` frozen at 85% travel (incoming +15%, outgoing -36% at 20% opacity).
- **Item 8.** The full-width odd Discover tile's name steps up to the headline style.

## Contrast, Dock-cast rows (`tools/contrast-glow.mjs`)

```
AA  13.85  text    on Dusk Dock cast 14% over bg0 (page text)  (worst hue 190)
AA   7.39  text-2  on Dusk Dock cast 14% over bg0 (page text)  (worst hue 190)
AA   5.15  text-3  on Dusk Dock cast 14% over bg0 (page text)  (worst hue 190)
AA  13.85  ink     on Dawn Dock cast 9% over bg0 (page text)   (worst hue 0)
AA   5.77  ink-2   on Dawn Dock cast 9% over bg0 (page text)   (worst hue 0)
AA   4.73  ink-3   on Dawn Dock cast 9% over bg0 (page text)   (worst hue 0)
```

The two FAIL rows the script still prints are round 3's evidence for `--on-wash-2` (unchanged).
