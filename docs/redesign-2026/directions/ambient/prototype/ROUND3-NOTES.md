# Round 3 builder notes (for the art director)

Applies `critique-r2.md` items 1-22. Values that differ from the written ones, each measured by `tools/contrast-glow.mjs` and asserted by `tools/qa.mjs` (136/136 pass):

- **Scrim head alpha 0.52, not 0.42.** At 0.42 the chevron and dots measure 2.41:1 on pure white art; 0.52 gives 3.27:1 (0.50 is the first value over 3:1).
- **Scrim ramp starts behind the artwork** (Foray detail 120px; Now Playing 72 + 0.4 x art) and the mid stop sits at the eyebrow's measured y (Foray 236; Now Playing art bottom + 12). The written 196/276 stops did not match the build (collage ends at 220, eyebrow at 236), and a 16-20px ramp at the sleeve's lower edge drew a hard seam.
- **Dawn Room mid scrim alpha 0.92, not 0.86**: ink-2 measured 4.27:1 at 0.86, 4.57:1 at 0.92.
- **Today hot spot kept at 52%; secondary text on the wash steps up** to `--on-wash-2: #E2D9CD` (Dusk). `--text-2` is 3.55:1 at the hot spot and 3.78:1 at the eyebrow's measured falloff (the two FAIL rows left in the script's output are that evidence); capping at 46% cannot fix it. `--on-wash-2` is 5.49:1 / 5.85:1. It applies to the greeting, hero captions and hero why-line. The hot spot is centred on the measured collage centre (x = gutter + half the art, y = 86 + half the art), not 22%/16%.
- **Transport margin at 1.3x**: 12px only above 700px tall; at <= 700px it stays 8px (the built value; 12 would cost the fit at 375x667).
- Library has a third foray tile, "Three chairs at the table": three shows with artwork cut from the real capital foray, so the 3-show collage is on screen. `tools/build-data.mjs` also had a `/s+/` typo that made narration bars one word long; fixed.
- The artwork class is `lit-art` (the existing `.lit` was onboarding's highlighted-sleeve state).
- `?eyebrow=on` re-enables the transient Now Playing caption on a deep link; by default a deep-linked Now Playing is at rest (item 16).

New states: `np-segchange`, `np-detail3`. Shots: `data-local/redesign/shots/ambient/r3/` (default routes, harness) and `r3/states/` (every state, Dusk and Dawn, 393x852 and 375x667).
