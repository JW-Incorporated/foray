# Dial — critique, round 7 (the fun-face round, closed)

Art director's pass over the round-7 prototype (`prototype/`), judged only on
the display-face change and anything it moved. Renders:
`data-local/redesign/shots/tactile/r7/` (Anybody, Cream, 7 routes × 3
viewports) and `r7-fonts/{anybody,big-shoulders,dela-gothic-one,archivo}/`
(Home, Now Playing, Foray detail, Yours per face, Cream, 3 viewports).
Numbers below were measured on the shipped prototype with Playwright, no
injected CSS (`r7-fonts/_ad/_measure-r7.cjs`, gitignored): line counts from
the range rects, gaps from the last line's right edge to the element's box,
tokens from computed style, descender clipping by diffing the 12px strips
above and below each clamped title with and without `overflow: hidden`, the
screen title's cap centre from canvas `TextMetrics` against the knob keycap.
My own renders are in `r7-fonts/_ad/` (`dark-anybody__*__393.png`,
`ta-anybody-heading-w100*__393.png`, `switcher-after-5-presses.png`).

**Verdict: Anybody stays the display face, at the r7 tokens. The type is
closed from the art director's side; what remains is the owner's pick at the
switcher.** No P1. Every r6 P1 item landed as specified and measured clean,
and the one further tune I trialled (P2.1) moves nothing a listener would
see. The owner's round-2 question, answered on the screens he will open
first, is below; if he picks Anybody the type ships as is, if he picks Big
Shoulders or Dela the Phase 3 items in P3 apply, and if he picks none of the
three, Archivo ships at its r5 tokens.

## The owner's question, answered

"Maintain the original thinking with a fun font, not that particular one."
The original thinking is a radio, and a radio's lettering is the wide, heavy
grotesque on a 1970s hi-fi fascia. Anybody at 700 is that face, and r7 lets
it do the one thing r6 did not: run wide where there is room.

- **Today / Find / Yours** at 40 / 700 / **width 110**, tracking 0.005em.
  "Today" is 142.8px wide (112 at r6's 90), "Yours" 147.8, "Find" 96.3,
  each one line at 375 beside the 44px knob with 20px to spare on the
  tightest ("Yours"). This is the extended fascia nameplate the direction
  describes: squared `o` and `d`, a `y` whose tail is a straight cut, an `r`
  with a flat arm. The cap-height centre sits 0.5px above the knob keycap's
  centre (49.5 against 50), so the plate and the key read as one row. Holds
  in Bakelite (`_ad/dark-anybody__home__393.png`, `__library__393.png`:
  cream ink on `#17130F`, counters open).
- **Today hero** at 28.3px (393) / 700 / 90: three lines at every width
  ("Barbecue: eight / stories from a / much longer history"), balanced, min
  right gap 32 / 47 / 53px at 375 / 393 / 412, card bottom 537 / 537 / 542.
  Unchanged from r6, as P1.1 promised: the width change touched the three
  one-word titles only.
- **Foray detail** at 40 / 700 / 90: four lines, min gap 67 / 85 / 104px,
  nothing truncated, the `g` and `y` of "longer history" the hardest test
  and clean top and bottom.
- **Now Playing** title 24 / 650 / 92: two lines at every width, gap 25 /
  43 / 62px. **Onboarding** "Podcasts, stitched / around you." two lines.
  **Find** "AI & robotics" (title role) two lines at 375 / 393, one at 412
  by 5.9px; "Fermentation" at the 17px heading role is the same face.

**Is it fun?** Yes, and in the way the direction asked for: the personality
is in the proportions (wide, flat-topped, square-countered), not in any
curled or bouncy letter. **Is it a cartoon?** No. The three letters that
made r3 a cartoon (`y`, `g`, `a` at 32–40px) are built here from straight
stems and squared bowls, and the screen titles at 110 lean further into
machine-cut, not further into toy. **Is it plain?** Not next to Archivo:
side by side on the r7 contact sheets "Today" at 110 is 37% wider than
Archivo's and reads as a label, where Archivo's reads as a heading.

## Verified in the prototype, not only the renders

- **Scheme.** Every render in `r7/` and `r7-fonts/` is Cream: the paper
  pixel samples `247, 240, 228` (`#F7F0E4`) in every file checked across all
  four faces and three widths, and the shoot URL in each `index.json` is
  `?review=off` (plus `&font=<id>` for the alternates). `body` computes to
  `rgb(247, 240, 228)` under `colorScheme: light`. No PNG shows Bakelite.
- **Switcher.** `.fp-btn` 44 × 44 at `top: 6` (safe-t 0), centred. Five
  presses from a fresh load at 375: Anybody → Big Shoulders → Dela Gothic
  One → Archivo → Anybody → Big Shoulders; `data-display-font` goes `null`
  → `bigshoulders` → `dela` → `archivo` → `null`, and `h1.display-xl`
  follows at 40/110%/700 → 44/100%/800 → 36/100%/400 → 40/92%/700 →
  40/110%/700. The hero drops to 24px on Dela and returns. `.row__title`
  stays Bricolage throughout. Toast `role="status"`, one line (158–210 ×
  32px), persists under `cp_display_font_preview`. `?review=off` computes
  both to `display: none`, and **no render in `r7/` or `r7-fonts/` shows the
  control** (checked every route at every width).
- **Clipping.** 10 clamped or display elements × 4 faces × 3 widths (hero,
  Now Playing title, Foray detail `h1`, large and medium Find tile names,
  onboarding headline, the three screen titles, the "Also today" heading):
  **120 strip diffs, all clean top and bottom.** The r6 defect (Dela 6px,
  Big Shoulders 2–5px) is gone with the metric overrides in `tokens.css`.
- **Dates.** The builder's shoot ran under the harness's frozen clock ("Mon
  5 Oct"); my `_ad/` renders did not ("Tue 6 Oct"). The readout line did not
  change; only the clock did.

## The alternates, as tuned (3 widths, Cream)

Each now loses or wins on its character, not on a defect; the owner should
see all three on his phone before deciding.

1. **Anybody** (default). Above.
2. **Big Shoulders** at 800 / 750 / 750, 44 / 36 / 26 / 22px, tracking
   0.005–0.01em. The r7 upsizing gave the condensed gothic its mass:
   "Today" 98.5px at 44 (88 at r6's 40 / 750), hero 3 / 2 / 2 lines (bottom
   547 / 514 / 517; the ≤ 540 rule is a 393 rule and holds there), Now
   Playing 2 at 26, Foray detail 4 / 3 / 3 at 44 (the third line at 393 ends
   12px from the box, the tightest line in the matrix, and still clean).
   Handsome and crafted, the Chicago sign-painter's gothic. Its risk is
   unchanged: condensed and 800 reads athletic next to the Bricolage rows,
   and "Also today" at 22 / 750 is a headline in a sports section. Nearest
   the "plain" edge of the three; furthest from "cartoon".
3. **Dela Gothic One** at 400, 36 / 28 / 22 / 18px, tracking 0 (from
   −0.01em), line heights 42 / 33 / 26 / 22, hero `clamp(1.5rem, 6.4vw,
   1.75rem)` at 1.16. "Today" 133px, hero 3 lines (gap 26 / 30 / 35, bottom
   523 / 528 / 532), Foray detail 4 (gap 49 / 67 / 86), Now Playing 2 (fits
   by 0.8px at 375; a longer fixture title goes to three and the artwork
   drops to 160, the designed behaviour), onboarding 2, nothing clipped.
   The loudest fun and the most "1970s Japanese hi-fi" of the three; one
   black weight on a sentence-length hero is poster type, and it is the face
   most likely to earn the round-1 word. It is in the switcher so the owner
   sees the loud end, tuned.
4. **Archivo** (the owner's named fallback, r5 tokens untouched): hero
   3 / 2 / 2, bottom 537 / 506 / 509, Foray detail 3, screen titles at its
   display width 92 ("Today" 104.5px). Nothing clips. Plain, as he said; it
   ships only if nothing above lands.

---

## P1 — type

None. Every r6 P1 item is applied and measured; nothing in the type would be
materially better for another round.

## P2 — checked and deliberately left alone

1. **Headings at width 100 (trialled, rejected).** With the screen titles
   at 110 and the hero at 90, the 20px headings at 94 are the narrowest cut
   on the Today and Find screens. I set `.heading { font-stretch: 100% }`
   and shot Home, Find and Now Playing at 393
   (`_ad/ta-anybody-heading-w100*__393.png`): "Also today" goes 104.5 →
   112.1px, "Followed shows" and "Subjects" open by the same 7%, no line
   count moves anywhere (medium tiles stay one line, small tiles two). Side
   by side with the shipped renders the difference is below what a listener
   would notice, and the 94 → 92 → 90 step down from heading to title to
   display is the deliberate rhythm of the scale. Leave. If Phase 3 instances
   the font to wdth 88–112 (P3.3) the value stays available.
2. **Hero bottom 537 at 393** (3px inside the rule; 542 at 412 where the
   viewport is 63px taller). `--wd-display: 88%` is the relief valve and
   costs Anybody the width that is its character. Leave until a real title
   breaks it.
3. **Dela's screen title sits 2.5px high** against the knob centre (cap
   centre 47.5 against 50; Anybody 0.5, Big Shoulders 1, Archivo 1.5 the
   other way). Visible only with a ruler; a `padding-top: 4px` on
   `:root[data-display-font="dela"] .top__title` would centre it, and it is
   not worth a line of switcher-only CSS. If the owner picks Dela, Phase 3
   folds it into the metric re-cut (P3.1), which moves the ink anyway.
4. **Large Find tile name fits one line at 412 by 5.9px**; two centred
   lines at 375 and 393. Leave.
5. **Review toast covers the screen title for 2.2s** (r5 P2.3;
   `_ad/switcher-after-5-presses.png`). Leaves with the tool.
6. **"Also today" sits under the deck at 375 × 667** for every face (the
   hero rule is written for 393 × 852). Pre-existing, not the type; the
   mini-player posture at the smallest phone is a Phase 4 Today item.
7. **Followed-shows strip clips "Lingthusiasm" at the gutter** (r5 P3.7).
   Strip layout, Phase 3 Find.

## P3 — Phase 3 housekeeping, by pick

1. **If the owner picks Big Shoulders or Dela:** re-cut the file's
   `hhea`/`OS/2` ascent and descent to the override values (Dela 84 / 28,
   Big Shoulders 84 / 24) with `fonttools` and rename the family under the
   OFL's Reserved Font Name clause. The CSS `ascent-override` /
   `descent-override` is the prototype's stand-in and **WebKit ignores it**:
   on the iPhone founder's build the r6 clipping returns until the file is
   re-cut. Then rewrite the 700 ceiling for Big Shoulders (800 is its
   display weight, not an exception) or the scale table for Dela (36 / 28 /
   22 / 18 is its scale, not a reduction).
2. **Whatever the pick:** remove the review tool as `prototype/README.md`
   lists it (`font-preview.js`, `font-preview.css`, their tags, the "REVIEW
   ONLY" block in `tokens.css`, the `@font-face` lines and `fonts/*.woff2`
   of the faces not picked).
3. **If Anybody:** instance to wdth 88–112 / wght 600–700 (the screen
   titles use 110) and Bricolage to wght 500–700 at width 100 (BUILD-NOTES
   1); the text roles do not change.

---

## What must not regress

Hero 3 / 3 / 3 lines at 375 / 393 / 412 with no single-word last line and
the card bottom ≤ 540 at 393; onboarding and Now Playing 2 lines at every
width; Foray detail 4; screen titles one line at 375 at width 110 with the
cap centre within 1px of the knob centre; Anybody on every `display-xl`,
`display`, `title`, `heading`, `.tile__name` and `.onb__brand`; no weight
above 700 and no width below 90 in any Anybody role (the mono station code
keeps its 800; Big Shoulders' 800 is the switcher exception); no clamped
title clipping ink in any face (the 120-strip diff in `_measure-r7.cjs` is
the check); the switcher at 44px, labelled, cycling four, absent from every
clean render; Bakelite holds on Home, Foray detail, Now Playing, Yours and
Find.

## Acceptance

No further prototype round. The owner reviews the switcher build on his
phone (Anybody default; "Aa" cycles Big Shoulders, Dela Gothic One, Archivo)
and names a face; Phase 3 applies P3 for that face. The r7 renders are the
checkpoint evidence for the type: `r7/` for the default, `r7-fonts/` for the
four faces side by side.
