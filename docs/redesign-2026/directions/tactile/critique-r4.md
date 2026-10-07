# Dial — critique, round 4 (the type round)

Art director's pass over the round-4 prototype (`prototype/`), judged only on
the display-face change the owner asked for and anything it moved. Renders:
`data-local/redesign/shots/tactile/r4/` (Bakelite, 25 routes × 3 viewports),
`r4-fonts/{archivo,ibm-plex-sans,instrument-sans}/` (Home, Now Playing, Foray
detail, the three faces side by side), `r4-fonts/_switcher-ui.png` (the review
control, Cream), and `r4-cream/` (Cream, 7 routes × 2 viewports; shot for this
critique with `--scheme light`, because the default scheme had no Archivo
render at all). Baseline for "before": `r3-type/` (Bricolage 800 / 90%).

**Verdict: the face is settled, the round is not.** Archivo stays as primary;
neither alternate is better on the real screens (§ Alternates). Three concrete
defects remain that the owner would see on the first and third screens he
opens, each a one-rule fix, so the builder applies P1 and re-shoots before the
owner sees the artifacts. No fifth type round after that.

## What the owner was right about, and whether it is fixed

The r3 "cartoon" was three letters at two settings. Bricolage at weight 800
and width 90% has a curled `y`, a hooked single-storey `g` and a bubble `a`;
at 32–40px in "Today", "eight stories", "longer history" those shapes were the
whole impression (`r3-type/shots/default__home__393x852.png`). In r4 the same
words set in Archivo 700 / 92% read as cut, not drawn: a straight-tailed `y`,
a plain `g`, flat terminals, square-shouldered `r` and `t`. The Foray detail
title at 40px is the hardest test (three lines, four `y`/`g` descenders) and
it holds in both schemes. Beside the enamel band, the keycaps and the Azeret
readouts the headers now look like the lettering on the object, which is the
Tactile thesis. Fixed.

What else the change did, checked at 375, 393 and 412 in both schemes:

- **Line breaks.** Home hero is two lines at 393 and 412 (r3 needed three),
  three at 375. Now Playing title balances to two. Foray detail is three lines
  at all three widths. No new truncation anywhere; `.clamp2`/`.clamp4` never
  engage on the fixture data.
- **Alignment with the raised controls.** The hero title's left edge, the
  band's well, the Play keycap and "Details" still share the card's 20px
  inset; the 40px display cap height sits on the same optical line as the
  44px knob keycap on Today and Yours. Unchanged, because only the family,
  weight and width moved and the line-heights (44/36/28/24) did not.
- **Contrast.** Ink on paper and on the Now Playing tint is unchanged; a
  heavier, narrower face does not lower it. Cream Now Playing over the
  Moreish rose tint still reads at the ink-on-paper figure (the scrim is
  doing the work, not the type).
- **Hierarchy.** Display 700 → title 650 → heading 650/96% → Bricolage row
  titles 700 at 15px: the step from an Archivo heading to a Bricolage row
  title is visible but not a jolt, because the x-heights are within 2% and
  both are grotesques. Section headings ("Also today", "Up next", "From",
  "Followed shows", "Subjects") read as labels on a panel, which is right.
- **Bricolage at text sizes.** The why-lines (17/500), row titles (15/700),
  chips and keycap labels keep Bricolage. At those sizes the `y` curl is a
  2px feature, not a voice; "Play today's foray" at 17/700 is the largest
  Bricolage on any screen and it reads as a friendly keycap label, not a
  cartoon. The pairing holds, so body stays Bricolage. The one place it does
  not hold is the Find tiles (P1.2), which is a role inconsistency, not a
  pairing failure.

## Alternates

Judged on `r4-fonts/*/shots/default__{home,now-playing,foray}__393x852.png`:

- **IBM Plex Sans.** Stiffer and cooler; the `a` and `g` are engineered, the
  `y` has a flat tail. It pushes the Home hero to three lines at 393 (the
  shape is wider at the same width token), which costs the ≤ 540px hero rule
  its margin, and it reads as an instrument panel rather than a radio. Second
  of three.
- **Instrument Sans.** At these sizes nearly indistinguishable from Archivo in
  line breaks and colour, but the letterforms are a neutral 2020s UI
  grotesque: the `R`, `a` and `t` lose the nineteenth-century jobbing-type
  warmth that makes Archivo read as a label plate. It also tops out at 700,
  so title and heading sit at 700 and the step down to the Bricolage row
  titles (also 700) flattens. Third.
- **Archivo** keeps the breaks, the hierarchy and the character. Primary.
  `DIRECTION.md` and `BUILD-NOTES.md` already say so; no change.

## The review switcher

`font-preview.js` / `font-preview.css`, checked in the source and in
`_switcher-ui.png`:

- 44 × 44 (`min-width`/`min-height` 44), fixed at top centre under the safe
  area, `--ink` disc with "Aa", 3px ultramarine `:focus-visible` ring.
- Accessible name set and updated on every press: "Font preview. Current
  display font: {name}. Tap to switch." The toast is `role="status"`.
- Cycles all three (`(cur + 1) % 3`), persists under `cp_display_font_preview`
  in try/catch, `?font=` forces a face before first paint, `?review=off`
  hides it. The shooter hides it with `.fp-btn,.fp-toast{display:none
  !important}` and **no r4 render shows it** (checked every route viewed).
- Only the three display-role tokens move: `:root[data-display-font]`
  overrides `--font-display` and its weight/width/tracking; text and mono
  roles are untouched. Correct.
- One defect, P1.3 below: the toast wraps "Display font: IBM Plex / Sans" on
  two lines in `_switcher-ui.png`.

---

## P1 — apply before the owner sees r4

1. **Onboarding headline widow.** "Podcasts, stitched around / you." leaves
   `you.` alone on line two at 393 and 412 (375 happens to break after
   "stitched"). This is the first screen the owner opens. Add
   `text-wrap: balance` to the display roles that carry a sentence:

   ```css
   .onb__copy .display, .hero .display, h1.clamp4 { text-wrap: balance; }
   ```

   Expected: onboarding "Podcasts, stitched / around you." at all three
   widths; Home hero at 375 becomes "Barbecue: eight / stories from a much /
   longer history" instead of leaving `history` alone; 393/412 keep their
   two lines (balance never adds a line, so the ≤ 540px hero rule is safe).
   `.np__text .title` already has it. Progressive: older WebViews ignore it.

2. **Find tile names: one role.** The large tile sets its name in Archivo
   (title role, 24px) while the medium and small tiles set theirs in
   Bricolage 17/700, so "AI & robotics" and "Fermentation" sit 40px apart in
   two faces (`r4-cream/shots/default__search__393x852.png`). Tile names are
   titles of things, the same as the large tile already says. Change
   `.tile__name` to the display face at its current size:

   ```css
   .tile__name { font-family: var(--font-display); font-size: 1.0625rem; line-height: 1.5rem; font-weight: var(--w-heading); font-stretch: var(--wd-heading); letter-spacing: var(--tracking-heading); }
   ```

   (`.tile--l .tile__name` keeps the title role.) Spec updated: BUILD-NOTES
   2.1 and 3.10, DIRECTION Typography. Row titles, playlist card names and
   the mini title stay Bricolage 700: they are list items at 15px, not tiles,
   and the pairing holds there.

3. **Review toast wraps.** `.fp-toast` is positioned with `left: 50%` and
   `transform: translateX(-50%)`, so its shrink-to-fit width is half the
   viewport; the longest label does not fit and wraps despite `nowrap`.
   Replace the centring:

   ```css
   .fp-toast { left: 16px; right: 16px; width: fit-content; margin-inline: auto; transform: none; }
   ```

   One line at every width, still centred, still hidden by `?review=off`.

## P2 — checked and deliberately left alone (so nobody "fixes" them)

4. **Display tracking stays at −0.02em.** The hero's second line at 393
   ("from a much longer history", 32px) ends about 4px short of the card's
   inner edge; loosening to −0.015em adds about 4px across 26 characters and
   would push the hero to three lines, which is the r3 geometry the change
   just bought back. The tight fit is a display setting, not a defect, and at
   40px (Foray detail) the same tracking is comfortable. If a future title
   proves tighter, change `--wd-display` to 90% before touching tracking.

5. **Bakelite weight.** Cream text on `#17130F` renders a touch heavier than
   ink on paper, but at 700/92% it does not bloat: the counters of `a`, `e`,
   `g` stay open at 32 and 40px. No scheme-specific weight token.

6. **Bricolage 700 in rows, chips and keycaps.** Kept, as above. If the owner
   reads the row titles on his phone as still too playful, the fallback is
   one token change, not a new face: set `.row__title`, `.mini__title` and
   `.pcard__name` to `var(--font-display)` at 650 / 96% / −0.01em and keep
   Bricolage for 500-weight text only. Do not pre-empt it; the Find tiles
   (P1.2) are the only place the two faces collide today.

## P3 — housekeeping for Phase 3, not this round

7. Remove the review tool as `prototype/README.md` lists it: the two tags in
   `index.html`, `font-preview.js/.css`, the "REVIEW ONLY" block in
   `tokens.css`, the Plex and Instrument `@font-face` lines and their two
   `.woff2` files. Then instance Archivo to wdth 90–100 / wght 600–700 and
   Bricolage to wght 500–700 at width 100 (BUILD-NOTES 1).

---

## What must not regress

Everything in `critique-r3.md`'s list, plus: the two-line hero at 393/412,
the balanced Now Playing title, Archivo on every `display-xl`, `display`,
`title` and `heading` role (and now every `.tile__name`), no weight above 700
and no width below 92% anywhere, and a clean render set with the switcher
hidden.

## Acceptance for the re-shoot

Re-render `r4` (both schemes this time: `--scheme light` and `dark`) and
confirm: onboarding headline two lines with "around you." together at 375,
393 and 412; Home hero three lines at 375 with no single-word last line;
"AI & robotics" and "Fermentation" in one face on Find; the toast on one
line when the switcher is pressed (one manual shot, not in the clean set).
Then the artifacts go to the owner with the switcher left in so he can cycle
the three faces on his phone.
