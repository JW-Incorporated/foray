# Dial — critique, round 6 (the fun-face round)

Art director's pass over the round-6 prototype (`prototype/`), judged only on
the display-face change and anything it moved. Renders:
`data-local/redesign/shots/tactile/r6/` (Anybody, Cream, 7 routes × 3
viewports), `r6-fonts/{anybody,big-shoulders,dela-gothic-one,archivo}/`
(Home, Now Playing, Foray detail per face, Cream, 3 viewports). Numbers
below were measured in the prototype with Playwright
(`r6-fonts/_measure-r6.cjs` through `_measure-r6f.cjs` and `_ink.cjs`,
gitignored; my trial renders are in `r6-fonts/_ad/`): line counts from the
range rects, gaps from the last line's right edge to the element's box,
tokens from computed style, descender clipping by diffing the 12px strips
above and below each clamped title with and without `overflow: hidden`,
font metrics from canvas `TextMetrics`.

**Verdict: Anybody stays the display face. Not closed: one more round.**
The owner's round-2 brief was "the original thinking with a fun font", and
Anybody at 700 / width 90 is that: the squared counters, the flat-topped
`t`, the straight-tailed `y` and the plain `g` are the lettering on a
hi-fi fascia, and none of them curls. It is not Archivo (plainer) and it is
not Bricolage at 800 (the bubble `a`, the hooked `g`). But r6 is a family
swap with the r5 tokens, and the width axis, which is the whole reason
Anybody beat the other thirty-six, is set to 90 everywhere, which is the
narrow end of its own character. The one place the app has room to let it
run wide is the three one-word screen titles, and at 110 "Today", "Find"
and "Yours" become the extended fascia lettering the direction describes
(`_ad/t1-anybody-screen-title-w110__393.png`, `_ad/dark-anybody__library-
fixed__393.png`). That is P1.1, and it is the material change. The other
three P1 items are for the switcher: on the owner's phone each alternate
must lose or win on its character, not on a defect, and today Dela and Big
Shoulders both clip descenders inside the clamped titles.

## The owner's objection, answered

"A little plain" was Archivo, Plex and Instrument: neutral grotesques that
fixed the cartoon by removing the voice. Anybody is a 1970s American wide
grotesque with a width axis, and on the screens he will open first:

- **Today** "Today" at 40 / 700 / 90 beside the 44px knob keycap: squared
  `o` and `d`, a `y` whose tail is a straight cut. Reads as the name plate
  on the fascia. The hero at 28.3px (393) is three lines at every width
  ("Barbecue: eight / stories from a / much longer history", min right gap
  32 / 47 / 53px at 375 / 393 / 412, balanced, no one-word line); card
  bottom 537 / 537 / 542, inside the ≤ 540 rule at 393 with 3px to spare.
- **Onboarding** "Podcasts, stitched / around you." at 32px: two lines at
  every width (last line 164–201px short of the gutter). The `P`, `d`,
  `t` and `y` are the chunky rhythm r3 had, without the curl.
- **Foray detail** at 40px: four lines at every width ("Barbecue: / eight
  stories / from a much / longer history", min right gap 67 / 85 / 104px),
  nothing truncated, the `g` and `y` descenders in "longer history" the
  hardest test and still machine-cut. Holds in Bakelite
  (`_ad/dark-anybody__foray-fixed__393.png`: cream ink on `#17130F`,
  counters open).
- **Now Playing** title 24 / 650 / 92: two lines at every width (right gap
  25 / 43 / 62px), balanced; under the Azeret counter and beside the band
  it reads as the label under the dial. Holds in Bakelite over the Moreish
  rose tint (`_ad/dark-anybody__now-playing__393.png`).
- **Find** "AI & robotics" (title role) is two lines at 375 and 393 and
  one line at 412 by 5.9px; "Fermentation" (heading role at 17) is the
  same face 40px away. No two-face collision.

Hierarchy: 40 / 700 → 32 / 700 → 24 / 650 → 20 / 650 → Bricolage 15 / 700
row titles. The Anybody-to-Bricolage step stays one family at a glance
(both wide grotesques, square counters, x-heights within 2%), so the body
does not change. No role above 700, no width below 90. Contrast is the
r5 table, unchanged by the family (ink on paper 15.2:1 / 16.5:1). No
clamped Anybody title clips ink (all five tested clean).

**Is it a cartoon?** No. The three letters that made r3 a cartoon were
`y`, `g` and `a` at 32–40px; in Anybody all three are built from straight
stems and squared bowls. The risk with this face is the other way: at 90
on a sentence it can read as merely sturdy, which is why P1.1 exists.

## Verified in the prototype, not only the source

- **Scheme.** Every render in `r6/` and `r6-fonts/` is Cream: `body`
  computes to `rgb(247, 240, 228)` (`#F7F0E4`) under the shooter's
  `--scheme light`, the contact sheets are titled "Cream", and no PNG
  shows the Bakelite paper. (`DIRECTION.md` and the prototype README said
  r6-fonts also held Anybody in Bakelite; it did not. I shot it myself:
  `_ad/dark-anybody__{home,now-playing,foray-fixed,onboarding-fixed,
  library-fixed}__393.png`, `body` = `rgb(23, 19, 15)`. It holds; the
  README line is corrected in this round.)
- **Switcher.** `.fp-btn` 44 × 44 at `top: safe-t + 6`, centred. Five
  presses from a fresh load at 375: Anybody → Big Shoulders → Dela Gothic
  One → Archivo → Anybody; `data-display-font` goes `null` → `bigshoulders`
  → `dela` → `archivo` → `null` and the computed family on `h1.display-xl`
  follows; the hero size drops to 24px on Dela (its own scale) and returns.
  `.row__title` stays Bricolage throughout: only the display roles move.
  Toast `role="status"`, one line at 375 (158–210 × 32px). Persists under
  `cp_display_font_preview` in try/catch. `?review=off` sets both to
  `display: none`; `r6/index.json` records the shoot URL as
  `?review=off`, and **no render in `r6/` or `r6-fonts/` shows the
  control** (checked every route at every width).
- **Axes.** Anybody's `wdth` is live in the shipped file ("Today" at 40 /
  700 measures 112px at 90, 142.8 at 110, 163.1 at 120). Big Shoulders'
  `opsz` is live (the 40px setting is 3.7% wider with optical sizing than
  without).

## The alternates, ranked (3 routes × 3 widths, Cream)

1. **Anybody.** Above. Three-line hero, four-line Foray detail, nothing
   clipped, the only face with an axis to tune instead of argue with.
2. **Big Shoulders** at 750 / 700 / 700. The Chicago sign-painter's gothic
   is handsome at 40 ("Today" is a shop sign) and everything fits with room
   (hero two lines, bottom 505 / 506 / 509; Foray detail three lines). But
   it is condensed, so at the same size it carries about a third less
   visual mass than Anybody (the "Today" word is 88px wide to Anybody's
   112), the 20px headings ("Also today", "Up next") read as an athletic
   headline next to the Bricolage rows, and it sits nearest the "plain"
   verdict of the three. Its font ascent is oversized (0.98em against
   0.82em of ink), so the baseline sits low and the Foray detail title
   clips the descender of "history" (measured; visible at 44px in
   `_ad/tuned-bigshoulders__foray-fixed__393.png`). P1.2 and P1.4.
3. **Dela Gothic One** at its own smaller scale (36 / 28 / 22 / 18). The
   loudest fun, and the most "1970s Japanese hi-fi" of the three; but one
   black weight with tight sidebearings on a sentence-length hero is
   poster type, and at 375 the Now Playing title fits by 0.8px. Its content
   ascent is 1.17em against 0.85em of ink, so the hero, Now Playing and
   Foray detail titles all clip the descenders today (6px at 36px).
   It stays in the switcher because the owner asked for fun and should see
   the loud end of it, tuned (P1.2, P1.3); it is not the default because
   it is the face most likely to earn the word he used in round 1.
4. **Archivo** (the owner's named fallback, r5 tokens untouched): hero
   3 / 2 / 2 lines, bottom 537 / 506 / 509, Foray detail 3. Nothing clips.
   Plain, as he said; it ships only if nothing above lands.

---

## P1 — type

1. **Screen titles take Anybody wide.** Add `--wd-screen: 110%;
   --tracking-screen: 0.005em` to `:root` and set `.top__title .display-xl
   { font-stretch: var(--wd-screen); letter-spacing: var(--tracking-screen)
   }` (the three tab-screen `h1`s only: "Today", "Find", "Yours"; the Foray
   detail `h1.display-xl.clamp4` is a sentence and stays at 90). Measured
   at 40 / 700: "Today" 142.8px, "Find" 96.3px, "Yours" 147.8px (163 at
   120), all one line beside the 44px knob at 375 (287px available). The
   cap height still sits on the keycap's centre line. In the alternates'
   blocks the token inherits that face's display width (Big Shoulders and
   Dela have no `wdth`; Archivo keeps its r5 92). Do not take the hero or
   the Foray title wider: at 100 the fixture hero is four lines at 375 and
   the ≤ 540 rule breaks.
2. **Clamped titles must not clip ink: fix the two fonts' vertical
   metrics, not the layout.** Canvas `TextMetrics` on the shipped files
   (`_ink.cjs`) show the cause. Dela's font ascent is 1.167em against an
   ink ascent of 0.85em, and Big Shoulders' is 0.977em against 0.82em, so
   the baseline sits low in every line box and the descender ink (0.28em
   and 0.23em, right at the bottom of each content area) hangs below the
   box: 6px at Dela 36/40, 2px at Big Shoulders 40/44, 5px at 44/44.
   Anybody (1.05em content area at 40px) and Archivo (1.075em) are inside
   their boxes by 1px. Two mechanisms were tested and rejected: padding the
   clamp box (`padding-block` + negative margin) paints the next line's
   cap tops into the pad when a title truncates (`_ad/clamp-pad-probe__
   393.png`, `_measure-r6d.cjs`); inflating the line height needs 1.44em
   for Dela (`_measure-r6e.cjs`), which puts the hero at 556 and breaks
   the ≤ 540 rule. What works is centring the ink with metric overrides on
   the two `@font-face` rules: Dela `ascent-override: 84%; descent-override:
   28%`, Big Shoulders `ascent-override: 84%; descent-override: 24%`, with
   the line heights in P1.3 and P1.4. Measured (`_measure-r6f.cjs`): every
   clamped title in both faces is clean top and bottom at 375, 393 and
   412. **Caveat the builder must carry:** WebKit does not implement the
   override descriptors (Chromium 87+ and Firefox 89+ do), so the fix
   holds on the owner's Android phone and in the Playwright renders, and
   on the iPhone founder's build the r6 clipping returns. If the owner
   picks either face, Phase 3 re-cuts the font's `hhea`/`OS/2` ascent and
   descent to those values with `fonttools` and renames the family as the
   OFL's Reserved Font Name clause requires; the CSS override is the
   prototype's stand-in, not the shipping fix. Anybody needs neither.
3. **Dela: open the display tracking and give the lines 2px.**
   `--tracking-display: 0` (from −0.01em); title and heading tracking stay
   0; `--lh-display-xl: 2.625rem` (42), `--lh-display: 2.0625rem` (33),
   `--lh-title: 1.625rem` (26, unchanged), `--lh-heading: 1.375rem` (22,
   unchanged), `.hero .display { line-height: 1.16 }`; sizes and the hero
   `clamp(1.5rem, 6.4vw, 1.75rem)` unchanged. Measured with P1.2 at 375 /
   393 / 412: "Today" 133px, hero three lines (gap 26 / 30 / 35px, bottom
   523 / 528 / 532), Now Playing two (fits by 0.8px at 375), Foray detail
   four (gap 49 / 67 / 86px), onboarding two, nothing truncated, nothing
   clipped (`_ad/r7-dela__*__393.png`).
4. **Big Shoulders: give the condensed gothic its size.** In its block:
   `--t-display-xl: 2.75rem; --lh-display-xl: 3rem; --w-display: 800;
   --t-display: 2.25rem; --lh-display: 2.5rem; --t-title: 1.625rem;
   --lh-title: 1.875rem; --w-title: 750; --t-heading: 1.375rem;
   --lh-heading: 1.625rem; --w-heading: 750; .hero .display { line-height:
   1.2 }`; hero clamp unchanged. Measured with P1.2 at 375 / 393 / 412:
   "Today" 98.5px at 44 / 800, hero three lines at 375 (bottom 547) and
   two at 393 / 412 (gap 11.7 / 16.1px, bottom 514 / 517), Now Playing
   two at 26 (gap 60–97px), Foray detail four / three / three lines at
   44 (gap 102 / 12 / 31px), nothing clipped (`_ad/r7-bigshoulders__*__
   393.png`). 800 is above the 700 ceiling: that ceiling was set for
   Bricolage's curled `y` and hooked `g`, which this face does not have;
   it is a switcher-only exception until the owner picks, and if he picks
   Big Shoulders the ceiling line is rewritten for it, not bent.

## P2 — checked and deliberately left alone

1. **Hero bottom 537 at 393** (3px inside the rule; 542 at 412 where the
   viewport is 63px taller). `--wd-display: 88%` is the relief valve and
   costs Anybody the width that is its character. Leave until a real title
   breaks it.
2. **Large Find tile name fits one line at 412 by 5.9px**; two centred
   lines at 375 and 393. Leave.
3. **Band station codes still double at 412** (`BR BR`, `BC BC` on Now
   Playing and Foray detail; `r6-fonts/anybody/shots/default__foray__
   412x915.png`). Pre-existing, not the type, the fix is written in
   `critique-r5.md`. It is the owner's phone width, so apply it in the same
   r7 pass if the prototype is touched anyway; it does not gate the font.
4. **Review toast covers the title for 2.2s** (r5 P2.3). Leaves with the
   tool.
5. **Followed-shows strip clips "Lingthusiasm" at the gutter** (r5 P3.7).
   Strip layout, Phase 3 Find.
6. **Dela at 375, Now Playing**: the fixture title fits two lines by 0.8px;
   a longer title goes to three and the artwork drops to 160, which is the
   designed behaviour. Leave.

## P3 — Phase 3 housekeeping

7. Remove the review tool as `prototype/README.md` lists it. Then instance
   Anybody to wdth 88–112 / wght 600–700 (the screen titles now use 110)
   and Bricolage to wght 500–700 at width 100 (BUILD-NOTES 1).

---

## What must not regress

Hero 3 / 3 / 3 lines at 375 / 393 / 412 with no single-word last line and
the card bottom ≤ 540 at 393; onboarding and Now Playing 2 lines at every
width; Foray detail 4; Anybody on every `display-xl`, `display`, `title`,
`heading`, `.tile__name` and `.onb__brand`; no weight above 700 and no
width below 90 in any Anybody role (the mono station code keeps its 800;
Big Shoulders' 800 is the switcher exception in P1.4); no clamped title
clipping ink in any face; the switcher at 44px, labelled, cycling four,
absent from every clean render; Bakelite holds on all four routes above.

## Acceptance for r7

Apply P1.1–P1.4, then re-shoot with `--scheme light`: all seven routes at
375 / 393 / 412 for Anybody, and Home, Now Playing, Foray detail and Yours
for the three alternates (Yours is new to the matrix: it is where the wide
screen title shows). Shoot Anybody in Bakelite as the secondary check.
Re-run the strip diff (`_measure-r6f.cjs`) and the line measurements
(`_measure-r6.cjs`); every clamped title reads clean and the numbers
above hold. If the owner picks Anybody at that point the type is
closed; if he picks neither fun face, Archivo at its r5 tokens ships and
P1.1 does not apply to it.
