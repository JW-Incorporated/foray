# Dial — critique, round 5 (the type round, closed)

Art director's pass over the round-5 prototype (`prototype/`), judged only on
the display-face change and anything it moved. Renders:
`data-local/redesign/shots/tactile/r5/` (Bakelite, 7 routes × 3 viewports),
`r5-cream/` (Cream, same matrix), `r5-fonts/{archivo,ibm-plex-sans,
instrument-sans}/` (Home, Now Playing, Foray detail per candidate),
`r5-fonts/_switcher-ui.png` (the review control pressed once, Cream, 375).
Numbers below were measured in the prototype with Playwright
(`r5-fonts/_measure-r5.cjs`, gitignored): line counts from the range rects,
gaps from the last line's right edge to the element's box, tokens from
computed style.

**Verdict: the type is done. Archivo stays primary; no sixth round.** Every
r4 P1 item landed and did what it was meant to, both schemes hold at 375,
393 and 412, and neither alternate improves a single screen. The artifacts
can go to the owner as they are, with the switcher left in so he can cycle
the three faces on his phone. One defect remains in the renders he will see
on his Pixel (412 wide), and it is the band, not the type (§ "Not the type,
but on his phone"); it is a one-function fix that belongs to Phase 3 step 2
in any case and does not gate the font decision.

## The owner's objection, answered

"Cartoonish" was Bricolage at 800 / 90% at 32–40px: the curled `y`, the
hooked `g`, the bubble `a`. In r5 every display, title and heading role is
Archivo (computed: display-xl 40px 700 92% −0.8px; display 32px 700 92%;
hero `clamp()` 28.3px at 393 and 29.7px at 412; title 24px 650 94%
−0.36px; heading 20px 650 96% −0.2px; tile names 17px 650 96% and the
large tile at the title role). No role above 700, none under 92%. On the
screens he will open first:

- **Onboarding** "Podcasts, stitched / around you." at 32px: flat-terminal
  `P`, straight `y`, plain `g` in "stitched" is a straight stem. Reads as
  the plate on the front of the object. Two lines at all three widths
  (`text-wrap: balance`), last line 182–219px short of the gutter, so no
  widow at any width.
- **Today** "Today" at 40px beside the 44px knob keycap: the cap height
  sits on the keycap's optical centre line. The hero at 28–30px is two lines
  at 393 and 412 and three at 375 ("Barbecue: eight / stories from a much /
  longer history", min gap 70px: balanced, no single-word line).
- **Foray detail** at 40px, three lines at every width (min right gap 10px
  at 375, 28 at 393, 47 at 412), four `y`/`g` descenders in a row, still
  machine-cut. This is the hardest test and it passes in both schemes.
- **Now Playing** title 24/650 balances to two lines at every width (gap
  71–108px); beside the Azeret counter and the enamel band the title reads
  as the label under the dial, which is the thesis.
- **Find** "AI & robotics" (title role) and "Fermentation" (heading role at
  17px) are now one face 40px apart; the r4 two-face collision is gone.

Hierarchy: 40/700 → 32/700 → 24/650 → 20/650 → Bricolage 15/700 row titles.
The step from an Archivo heading to a Bricolage row title is visible and
not a jolt (x-heights within 2%, both grotesques). Contrast is unchanged by
the family swap (ink on paper 15.2:1 / 16.5:1; the Cream Now Playing over
the Moreish rose tint is carried by the scrim, not the face). Nothing
truncates: `.clamp2`/`.clamp4` never engage on the fixture.

**Body stays Bricolage.** Checked the largest Bricolage on any screen,
"Play today's foray" at 17/700 on the onboarding keycap, and "Details",
"Just show me", the chips and the tab labels at 12–15px: the `y` curl is a
2px feature at those sizes, not a voice, and the open shapes sit well
against Archivo's flat terminals. The pairing holds; no reason to pay for a
third text family. If the owner reads the row titles on his phone as still
too playful, the fallback is one token change, not a new face (P2.5).

## Alternates (final ranking, unchanged from r4)

Judged on `r5-fonts/*/shots/default__{home,now-playing,foray}__393x852.png`:

1. **Archivo.** Keeps the two-line hero at 393, the balanced Now Playing
   title and the three-line Foray detail; nineteenth-century jobbing-type
   warmth (`R`, `a`, `t`) that reads as a label plate on a radio.
2. **IBM Plex Sans.** Pushes the Home hero to three lines at 393 (wider
   shape at the same 92% token), costing the ≤ 540px hero rule its margin,
   and the engineered `a`/`g` read as an instrument panel, not a radio.
3. **Instrument Sans.** Same breaks as Archivo, but a neutral 2020s UI
   grotesque: cooler, and because it tops out at 700 the title and heading
   sit at 700 and the step down to the 700 row titles flattens.

Nothing seen in r5 changes this. `DIRECTION.md` and `BUILD-NOTES.md` already
name Archivo; both now record that r5 closed the question.

## The review switcher (verified in the prototype, not only the source)

- `.fp-btn` 44 × 44 at `top: safe-t + 6`, centred; accessible name "Font
  preview. Current display font: {name}. Tap to switch.", updated on every
  press.
- Four presses from a fresh load: Archivo → IBM Plex Sans → Instrument Sans
  → Archivo; `data-display-font` goes `null` → `plex` → `instrument` →
  `null` and the computed `font-family` on `h1.display-xl` follows. Only
  the display-role tokens move; text and mono roles are untouched.
- Toast `role="status"`, one line at 375: 198 × 32 for "Display font: IBM
  Plex Sans", 214 × 32 for Instrument Sans (32 = one 16px line plus 8px
  padding each side). The r4 wrap is fixed.
- `?review=off` sets `display: none` on both; the shooter's `_css/*.css`
  hides them too, and **no render in `r5`, `r5-cream` or `r5-fonts` shows
  the control** (checked every route at every width in both schemes).
- Persists under `cp_display_font_preview` in try/catch. Correct.

---

## P1 — type: nothing

No change to any display, title or heading token. A further round would
move numbers without moving the read.

## Not the type, but on his phone: band station codes double at 412

`r5/shots/default__now-playing__412x915.png` and `default__foray__412x915`
label the band `OS BR BR MP GC BC BC`; 375 and 393 read `OS BR MP GC BC`.
The owner's Android phone is 412 wide, so he sees the doubled codes on Now
Playing and Foray detail, which is exactly what r3 called a legend glitch.
Pre-existing (`r4/shots/default__now-playing__412x915.png` is identical);
the type change did not touch it.

Cause, `prototype/app.js` `bandHTML()`: a label is emitted **per segment**
when that one bar is ≥ 24px rendered (`it.w / 100 * W >= 24`). The
BUILD-NOTES 3.6 rule is one code per **run** of adjacent bars from one
show, narration ticks not breaking the run. At 375/393 the second `BR` and
`BC` bars fall under 24px and the per-bar gate happens to produce the right
picture; at 412 (stage 360px) they cross it.

Fix (build runs, label each run once at its centre):

```js
var runs = [];                                  /* {show, l, r, a, b}: a/b = first/last item index */
TL.items.forEach(function (it, ix) {
  if (it.type !== "segment") return;            /* narration never breaks a run */
  var last = runs[runs.length - 1];
  if (last && last.show === it.show_id) { last.r = it.l + it.w; last.b = ix; }
  else runs.push({ show: it.show_id, l: it.l, r: it.l + it.w, a: ix, b: ix });
});
runs.forEach(function (ru) {
  if ((ru.r - ru.l) / 100 * W < 24) return;
  labels += '<span data-a="' + ru.a + '" data-b="' + ru.b + '" data-v="--l:' + ((ru.l + ru.r) / 2).toFixed(3) + '">' + esc(codeFor(ru.show, FSH[ru.show].name)) + "</span>";
});
```

and in the needle update (`app.js` ~529) mark the run that contains the
current index: `sp.classList.toggle("is-cur", ci >= +sp.dataset.a && ci <=
+sp.dataset.b)`. Expected at 412: `OS BR MP GC BC`, each code centred under
its run (the `BR` label moves from under the first orange bar to the centre
of the pair). Apply whenever the prototype is next touched, and in Phase 3
step 2 (the band is built first) regardless. It does not gate the font
decision.

## P2 — checked and deliberately left alone

1. **Hero last line at 393 ends 4.3px before the card inset** (8px at 412,
   70px at 375). Still a display setting, not a defect: loosening tracking
   to −0.015em or width to 94% adds about 4px and makes the hero three
   lines at 393, the r3 geometry. If a future title breaks ugly, `balance`
   already handles the three-line case (375 proves it). Leave.
2. **Large Find tile name fits one line at 393 by 4.5px** ("AI & robotics",
   24px beside the 176px collage); at 375 it is two lines, centred in the
   196px tile, and reads fine. A longer subject wraps the same way. Leave.
3. **Review toast covers the date line for 2.2s.** `.fp-toast` at
   `top: safe-t + 56` overlaps "Today"'s descender zone and the mono date
   while shown. It is the review tool, it clears itself, and the only
   place with room for it at 375 is where it is. Leave; it leaves with the
   tool (P3).
4. **Bakelite weight.** Cream text on `#17130F` renders a touch heavier,
   counters of `a`, `e`, `g` stay open at 32 and 40px. No scheme token.
5. **Fallback if the owner still reads the text roles as playful:** set
   `.row__title`, `.mini__title`, `.pcard__name` and the keycap label to
   `var(--font-display)` at 650 / 96% / −0.01em and keep Bricolage for
   500-weight text only. One token group, no new file. Do not pre-empt it.

## P3 — Phase 3 housekeeping, not this round

6. Remove the review tool as `prototype/README.md` lists it (two tags in
   `index.html`, `font-preview.js/.css`, the "REVIEW ONLY" block in
   `tokens.css`, the Plex and Instrument `@font-face` lines and their two
   `.woff2`). Then instance Archivo to wdth 90–100 / wght 600–700 and
   Bricolage to wght 500–700 at width 100 (BUILD-NOTES 1).
7. Seen while checking Find, outside this round: the "Followed shows" strip
   clips its last item's name at the right gutter without a mask
   ("Lingthu / - A pod" at every width) where the Yours chip strip fades;
   and "Business of / Machining" breaks across the 72px item. Both are
   strip layout, not type. Phase 3, Find.

---

## What must not regress

Everything in `critique-r4.md`'s list, now measured: hero 3 / 2 / 2 lines at
375 / 393 / 412 with no single-word last line; onboarding and Now Playing 2
lines at every width; Foray detail 3; Archivo on every `display-xl`,
`display`, `title`, `heading` and `.tile__name`; no weight above 700 and no
width below 92% in any text or display role (the mono station code keeps
its 800); the switcher at 44px, labelled, cycling three, and absent from
every clean render.

## Acceptance

Met. No re-shoot needed for the type. When the band fix lands, re-render
`#/now-playing` and `#/foray` at 412 and confirm `OS BR MP GC BC`.
