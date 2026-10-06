# Native 2026: critique, round 1

Art director's pass over the round-1 prototype (`prototype/`) against
`DIRECTION.md` and `BUILD-NOTES.md`. Shots reviewed: the three contact sheets
and the full-size 393x852 set, plus 375x667 for Home, Now Playing and Foray
detail (`data-local/redesign/shots/native-2026/r1`, iOS, dark, default state
only; 21 shots).

**Verdict: not ready. A second round will materially improve it.** The bones
are right: the chrome reads as iOS, the Newsreader voice lands, the floating
tab bar and mini player are credible, Library and Search are close. What is
off is concentrated in the signature moments (the seam, the `4a` mark, Now
Playing's colour) and in a handful of hierarchy decisions. Everything below is
in priority order; P0 items change what the direction *is* and must land
before any judge sees it.

Where I changed my own mind after seeing it built, I say so and have already
edited `DIRECTION.md` / `BUILD-NOTES.md` (section "Direction changes" at the
end).

## What is right (keep)

- Platform shell: floating glass tab bar with inset 16 and the mini docked
  above it; large titles; grouped cards with no borders; chevron disclosure in
  `--label-2`; trailing nav actions in amber. Reads as first-party.
- Newsreader italic why-lines at 17px: the voice is distinct and settled.
- Hero composite on Home, rails of 168 with the third card peeking, "See all".
- Home dedupes correctly: when the resume item is in the mini player, "Jump
  back in" disappears (`mini` shot). Keep that logic.
- Now Playing structure: grabber, "Playing from **Today**", 64px amber play,
  15/30 glyphs with the number inside, secondary row with the Up Next badge.
- Library segmented control + grouped list + inset separators.
- Search clusters with the field in a glass pill at the bottom.
- Onboarding buttons: stacked 50px pills, amber then tonal.
- Code hygiene: `esc()`/`safeUrl()`, no inline styles, CSSOM for dynamic sizes.

## P0: signature moments

### 1. The `4a` mark reads as "4." (eyebrow says "4. TODAY'S FORAY")

Home hero, Foray detail hero and the onboarding card all show the mark as a
"4" followed by a dot-sized "a". At 12-16px the "a" collapses to a period and
the eyebrow reads as a numbered list item. This is the authorship mark; it
must read as `4a` at 12px.

Fix (`index.html` symbol `i-4a`): redraw on the 24 grid with the "a" at full
x-height, not tucked: the "4" occupies x 2-13 (stem at x 11, crossbar y 15),
the "a" occupies x 13.5-22 as a bowl of r 3.6 centred (17.8, 16.4) plus a
stem at x 21.4 from y 11.5 to 20, strokes 2.2 round-capped. Test: render at
12px on `--surface` and confirm two letters are visible. If it still fails at
12px, the eyebrow uses the word "4a" set in the text face at 600 and the
symbol is kept only at 20px and above (credits narration rows, onboarding).

### 2. Now Playing does not say what is playing, and its colour is mud

- The subline under the foray title is "Satay? Okay!", an *episode* title.
  The direction asks for the show. The listener's first question in a stitched
  listen is "which show is this?" and the screen does not answer it.
- The background tint, averaged from a four-tile composite, lands on khaki
  (#4F4F3C-ish). Averaging a collage always produces mud; a single artwork
  does not.
- The current clip's bar is invisible: it is a 1-minute clip, so at lg it is a
  12px dot and its progress fill cannot be seen. There is no hairline thumb.

Fix (direction change, already written into `DIRECTION.md` §Now Playing and
`BUILD-NOTES.md` §4.2):
- For a foray, the Now Playing art slot shows the **current clip's show
  artwork** full size; the four-tile composite stays on Home, rails, Library
  and the mini player's closed state is also the current clip's art, so the
  shared-element transition is one image. On hand-off the art crossfades
  (`--spring-default`, 450ms) and the tint follows (`@property --art-h`,
  600ms). The room changes colour as the show changes: that is the third
  signature moment made visible.
- Subline: `<show name>` 15 `--label-2`, then " · clip 3 of 10" in `tnum`.
  The episode title moves to the credits row's second line.
- Tint source: the current clip's art, never the composite. Chroma floor:
  if mean chroma < 0.04 (oklch), set `--art-c` to 0.04 so greys do not go
  brown. Scrim stays as specified.
- Current bar: `min-width: 24px` at lg (sm/md keep 6), 100% opacity, the
  inner fill in `--accent`, plus a 2px `--label` hairline thumb at the fill's
  leading edge, 16px tall (2px above and below the bar). Others 70%.

### 3. Seam labels truncate with ellipses ("Origin ...", "BBQ R...")

Now Playing and Foray detail render show names under bars with
`text-overflow: ellipsis`, so four of ten bars get a chopped name and the row
looks like a bug. A label that cannot fit is worse than none.

Fix (`styles.css` `.seam-labels`): measure each label; show it only when the
full name fits under its bar at 12px with 4px padding (use `scrollWidth <=
clientWidth` after layout, toggle `.hide`); never ellipsize. If no label
fits, remove the 16px row entirely (saves 22px at 375x667, where it matters).
The tap-chip (art + full name) remains the way to identify a short bar; make
sure it exists: tapping a bar in the prototype should raise it.

### 4. "Where this came from" is rendered twice, and with the wrong names

Foray detail shows a horizontal row of five 64px tiles ("Origin Stories 3
min", "Origin Stories 1 min", "Satay? Okay! 1 min" ...) *and* the 56px
credits rows beneath it. The tiles clip at the right edge, repeat names
because consecutive clips share a show, and label Cider Chat as "Satay?
Okay!" (episode title in the show slot).

Fix: delete the tile row. Credits are 56px rows only, in play order: art 40,
show name 15/600, second line 13 `--label-2` "Satay? Okay! · 1 min 12 sec",
trailing `i-open`. Narration rows: `i-4a` in a 40px `--fill` square and
"Narration" in `--t-voice`. Current clip row: `--accent-soft` + `i-eq`.
`DIRECTION.md` said "a row of artwork tiles"; that was mine and it was wrong
once built. Changed to rows.

### 5. Amber discipline

"TODAY'S FORAY" (hero) is amber. The rule is one line: amber marks what is
interactive and what is current. An eyebrow is neither.

Fix: `.eyebrow` is `--label-2` everywhere, including STRETCH (the fork icon
plus the word plus the serif headline carry it; `BUILD-NOTES.md` BridgeCard
updated). Amber stays on: play, selected tab, the current bar's fill, "See
all" / "Details" / nav actions, the Up Next badge, the current queue number,
the progress hairlines. Audit the sheet: nothing else.

## P1: hierarchy and density

### 6. Home hero title runs four lines

"Barbecue: eight stories from a much longer history" at 22/600 in the 200px
right column wraps to four lines; the title block out-tops the 132px
composite and the card is 310px tall at 393 (345 at 375). The direction said
clamp 2, which would cut this real title mid-sense.

Fix: hero title 20/600, line-height 25, letter-spacing -0.2, clamp 3. Three
lines (75) + eyebrow (16) + 6 + 6 + meta (21) = 124 < 132, so the composite
governs the row height. `BUILD-NOTES.md` HeroCard updated. Also add the word
"Play" (17/600, `--label`) 12px right of the hero's 56px play button, as
Foray detail already does; the two action rows should be the same component.

### 7. `PickRow` is single-tier, so "Jump back in" truncates three times

"From high school...", "Masters of Scale · 31...", "A CEO's climb from..."
in one 72px row. The spec is two-tier: tier 1 art 56 + title (clamp 1) +
show + trailing actions; tier 2 the why-line full width under the title
block, not beside the art.

Fix: `grid-template-areas: "art title actions" "art voice voice"` is not
enough because the why-line still sits in the title column; use
`"art title actions" "voice voice voice"` with the why-line starting at the
row's left padding, clamp 1, 6px above the bottom. Meta line: "31 min · Masters
of Scale" (duration first so the number survives truncation). Resume variant
keeps the 2px progress hairline along the bottom edge.

### 8. `ArtComposite` tiles are individually rounded with visible gaps

Every composite (hero, rails, Library, Now Playing, Search) shows four
separate rounded tiles with a 2px gutter, which reads as a collage of thumbnails
instead of one cover. The direction wants one artwork with four quadrants.

Fix (`.comp`): `gap: 1px`, `border-radius` only on the container with
`overflow: hidden`, tiles square (`.comp img { border-radius: 0 }`), gutter
colour `--bg`. Foray detail's 3x2 mosaic: same, `gap: 1px`.

### 9. Library foray rows are ~105px, not 72

Two-line titles plus a seam strip plus a meta line give five rows per screen;
the direction's density target is eight to ten. Also "2 of 4 played" is text
only; the strip shows no progress.

Fix: in Library rows the title clamps to 1 (17/600), strip sm at 5px, meta
13: row height 76. Played bars at 100% opacity, unplayed at 35% (progress
legible at a glance). Episodes list rows (Saved, History) stay 72/56.

### 10. Segmented control

Six segments at 393 are tight; at 375 they will touch. Use the iOS values:
height 32, labels 13/500, selected 13/600, padding 0 8, container radius 9,
thumb radius 7. Do not let it scroll on iOS.

### 11. Foray detail hero is too tall and the scrim too thin

Rendered 330px at 393 (spec 220); "FORAY" sits over Beer In Front's wood
grain and the status bar sits on raw artwork. Play lands at y 1055/852 only
because the screen scrolls; at 375x667 it is at the fold.

Fix: hero height 240 at 393 (`aspect-ratio: 393/240`), 3x2 mosaic cropped
with `object-fit: cover`; scrim `linear-gradient(180deg, rgba(0,0,0,.35) 0,
rgba(0,0,0,0) 28%, rgba(0,0,0,.82) 100%)` so both the status bar and the
title have ground. Eyebrow + title block bottom-aligned 16 above the hero's
edge. Title 28/700 clamp 2.

### 12. Onboarding composition

Hero card, headline and sentence sit in the top 40%; 500px of black separate
them from the buttons. The mini hero's why-line is sans in `--label-2`,
unlike the real hero (Newsreader italic), and its title clamps at 3 with an
ellipsis.

Fix: centre the content block (card + headline + sentence, gap 24/12) in the
space between the safe-area top and the buttons' top minus 32. The card is the
real `HeroCard` at `transform: scale(.86)` with `transform-origin: top
center`; its why-line is `--t-voice`. Keep the warm radial glow but cap it at
rgba(255,178,77,.06) and start it behind the card, not the status bar.

### 13. Search

- The masonry is a grid: both columns start at the same y and tiles are the
  same height, so there is no "splatter". Offset the right column by 28px
  (`.masonry > :nth-child(even) { margin-top: 28px }`) and alternate
  `.tall` (1:1.18) on items 1, 4, 5 so neighbours never align.
- The bottom field is ~56px; spec 44 (glass pill, 8 above the tab bar).
- Content needs `padding-bottom` = tab bar 50 + 8 + field 44 + 8 + safe area;
  scroll to the end and confirm the last cluster clears the field.

### 14. Hero action row balance

Play at far left, "Details" at far right, nothing between. With item 6's
"Play" label the row reads as [Play ●Play ........ Details]; acceptable.
Alternative if it still looks empty at 412: make Details a 44px tonal pill.

## P2: polish

15. **Narration stitch.** At lg the dashes are 2px on/2px off and read as a
    dotted leader. Use `repeating-linear-gradient(90deg, currentColor 0 3px,
    transparent 3px 5px)`, 2px tall, 12px wide, 55% opacity. Keep sm/md as
    is.
16. **Mini player hairline.** The CSS exists (`.mini-prog`) but the shot shows
    none; confirm `--p` is set by `hydrate()` and shoot the mini at 40%
    progress.
17. **Fonts.** `index.html` loads Inter and Newsreader from Google Fonts. The
    direction ships them from `prototype/fonts/` (OFL, variable woff2, Latin
    subset) and the app's CSP is `font-src 'self'`. Self-host now so the
    harness can run offline and the judge sees the shipped metrics.
18. **Settings glyph.** The sliders icon is fine (it opens Interests and
    settings); set `aria-label="Interests and settings"`.
19. **Seam bars as beads.** Clips under ~40 s render as circles. That is
    honest; leave it, but set `min-width: 8px` at lg so no bar is smaller
    than the stitch beside it.
20. **"Up Next" badge** on the Now Playing queue glyph overlaps the icon's
    top-right by 6px; move to `top: -4px; right: -6px`.

## Missing renders (round 2 must ship these before critique 2)

Only iOS, dark, default state was shot. The prototype already accepts
`?os=`, `?scheme=`, `?transparency=` and `?state=` (first-run, loading,
offline, empty, episode, narration, unnarrated, buffering, paused=1), so this
is a shoot plan, not code. Produce the full matrix and the two contact sheets
per OS, so the critique can cover Android and light:

```
node tools/ui-lab/shoot.mjs --target url \
  --url docs/redesign-2026/directions/native-2026/prototype/index.html?os=ios \
  --routes "#/home,#/home?state=first-run,#/home?state=offline,#/home?state=loading,#/mini,#/now-playing,#/now-playing?paused=1,#/now-playing?state=narration,#/now-playing?state=unnarrated,#/now-playing?state=episode,#/now-playing?state=buffering,#/search,#/search?state=typing,#/search?state=empty,#/library,#/library/upnext,#/library?state=empty,#/foray,#/foray?state=unavailable,#/onboarding" \
  --scheme dark --out data-local/redesign/shots/native-2026/r2/ios-dark
# repeat with --scheme light, and with ?os=android for both schemes
```

If a listed state is not implemented, implement it (they are all in
`BUILD-NOTES.md` §4) rather than dropping it from the plan. Also hand-check and
write down: the 375x667 play-button assertion in every Now Playing state, and
`?transparency=reduced` on Home and Now Playing.

## Direction changes made in this round

Edited by the art director, with reasons, so the builder does not have to
reconcile two documents:

- `DIRECTION.md` §Now Playing: foray art slot = current clip's show art;
  tint from that art; crossfade on hand-off; composite stays elsewhere.
- `DIRECTION.md` §Signature moments: "Where this came from" is a list of
  56px rows, not tiles; seam labels appear only when the full name fits.
- `BUILD-NOTES.md` HeroCard: title 20/600/25 clamp 3; "Play" label.
- `BUILD-NOTES.md` §4.2: art source and subline for forays; current bar
  min-width and thumb; label rule.
- `BUILD-NOTES.md` BridgeCard and §1: eyebrows are `--label-2`, never amber.
- `BUILD-NOTES.md` §4.4: Library foray rows clamp 1, 76px, progress opacity.
- `BUILD-NOTES.md` §4.5: hero 240, scrim values, credits rows only.
- `BUILD-NOTES.md` §4.6: centred content block.
- `BUILD-NOTES.md` `ArtComposite` rule (gap 1, outer radius only) and
  `Segmented` values.
