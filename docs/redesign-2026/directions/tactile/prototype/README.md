# Dial prototype (direction folder: tactile), round 3

Clickable, high-fidelity prototype of the Dial direction. Open `index.html`
(file or any static server). No build step, no dependencies. Round 2 applies
every point of `../critique-r2.md` (r2 applied `../critique-r1.md`).

Routes: `#/home`, `#/mini` (Home with the mini player), `#/now-playing`,
`#/search`, `#/library`, `#/foray`, `#/onboarding`, plus the full state matrix
in `routes.json` (sub-routes that scroll a section to the top, and fixture
states: first run, resume, offline, loading, empty, row menu open, in
progress, finished, un-narrated, unavailable, paused, buffering, episode,
typing, no results, settings sheet, toast, returning onboarding).
`?theme=dark` forces Bakelite before first paint (`boot.js`), e.g.
`index.html?theme=dark#/now-playing`.

A route typed or loaded from outside resets the state to that route's
fixture; taps inside the app keep state (it uses `history.pushState`).

## What is real, what is simulated

- Real: 40 episodes sampled from `data/discover.json` (title, show, hook,
  duration, artwork URL loaded at runtime), subject counts, and one foray from
  `data/forays.json` (`grilling-history-2`). Show artwork for its six shows
  comes from public listings.
- Simulated: playback (a 250 ms timer), haptics (`navigator.vibrate`), the
  share sheet.
- Demo-only: the four narration ticks in the band (that foray has none in
  `data/forays.json` yet; flagged `demo: true`), and the six "Chapter N" rows
  and chapter ticks on the episode Now Playing (the catalogue carries no
  chapters).
- Artwork tint: foray = the enamel of the show under the needle, crossing as
  the needle does; episode = 32x32 canvas average in linear light, converted
  to OKLCH, enamel when chroma < 0.04, lightness clamped 0.45 to 0.6, runtime
  contrast check raising the scrim to 0.9 when needed.
- `data.js` carries the same content as `data.json` so the page works from
  `file://` (fetch is blocked there).

## Post-pick change (2026-10-06): display face

The owner picked Tactile with one objection, the "cartoonish" headers.
Round 1 set display, title and heading in Archivo (700/92% display,
650/94% title, 650/96% heading; renders `data-local/redesign/shots/tactile/r4/`,
`r5/`). Round 2, the same evening, the owner called Archivo, Plex and
Instrument "a little plain" and asked for a fun face that is not
Bricolage. Display, title and heading now set **Anybody**
(`fonts/anybody-latin.woff2`, OFL, Google Fonts Latin slice; 700/90%
display, 650/92% title, 650/94% heading, tokens in `tokens.css`).
Bricolage stays for every text-size role, Azeret for readouts. Renders:
`data-local/redesign/shots/tactile/r6/` (Anybody, Cream, all seven routes)
and `r6-fonts/<face>/` (Anybody, Big Shoulders, Dela Gothic One and
Archivo, Cream, Home / Now Playing / Foray detail). The r6 shoot held no
Bakelite render; the art director's own Bakelite check of Anybody is in
`r6-fonts/_ad/dark-anybody__*.png`. The reasoning and the measurements are
in `../DIRECTION.md` (Typography, round-2 note and r6 verdict),
`../BUILD-NOTES.md` 1.1 and `../critique-r6.md`, whose P1 list is the
round-7 brief (screen titles at width 110; clamp padding, tracking and
scale for the alternates).

### Round 7 (`../critique-r6.md` P1.1-P1.4, applied)

- Screen titles (`.top__title .display-xl`: Today, Find, Yours) take `--wd-screen: 110%` / `--tracking-screen: 0.005em`; the Foray detail `h1.clamp4` stays at width 90. Big Shoulders and Dela set the token to 100% (no `wdth` axis), Archivo to its r5 92%.
- Metric overrides on the Dela and Big Shoulders `@font-face` rules (`ascent-override` 84%, `descent-override` 28% / 24%) stop clamped titles clipping descenders. WebKit ignores them: Phase 3 re-cuts the font metrics if either face is picked.
- Dela: display tracking 0, line heights 42 / 33, hero line-height 1.16. Big Shoulders: 800 / 750 / 750 at 44 / 36 / 26 / 22 with its own line heights, hero line-height 1.2 (800 is a switcher-only exception to the 700 ceiling).
- Band station codes are built per run of adjacent same-show bars (`critique-r5.md`), so `BR BR` / `BC BC` no longer doubles at 412.
- Renders (all `--scheme light`, Cream `#F7F0E4`): `data-local/redesign/shots/tactile/r7/` (seven routes) and `r7-fonts/<anybody|big-shoulders|dela-gothic-one|archivo>/` (Home, Now Playing, Foray detail, Yours). Shoot with `?review=off` (and `&font=<id>`) through a local static server; the shooter rejects `file:///` URLs.

### Round 5 (type round, `../critique-r4.md` P1)

- `text-wrap: balance` on `.onb__copy .display`, `.hero .display`, `h1.clamp4`: onboarding reads "Podcasts, stitched / around you." and the 375px hero has no one-word last line.
- `.tile__name` takes the display face at heading weight (Find tile names are one role); the large tile keeps the title role.
- `.fp-toast` centres with `left/right: 16px; width: fit-content; margin-inline: auto` and stays on one line at every width (checked at 375: 198 x 32).
- Renders: `data-local/redesign/shots/tactile/r5/` (Bakelite), `r5-cream/`, `r5-fonts/<face>/` (Home, Now Playing, Foray detail per candidate). The switcher is hidden in all of them by `r5-fonts/_css/*.css` (`.fp-btn,.fp-toast{display:none}`); the owner build keeps it in.

### REVIEW TOOL: font switcher (remove before Phase 3)

A floating "Aa" button (44px, top centre, accessible name "Font preview. ...")
cycles the display/title/heading face between Anybody (the round-2 pick),
Big Shoulders, Dela Gothic One and Archivo (the owner's fallback), and a
small toast names the current family. Text and mono roles never change.
The choice persists in `localStorage` (`cp_display_font_preview`, try/catch)
so it survives a reload on a phone. Files: `font-preview.js`,
`font-preview.css`, the two tags in `index.html`, the "REVIEW ONLY" block at
the end of `tokens.css`, and the `@font-face` lines plus `fonts/*.woff2` of
the faces the owner does not pick (`dela-gothic-one-latin`,
`big-shoulders-latin`, `archivo-latin`, or `anybody-latin`). It sets
`data-display-font` on `<html>` (CSP-safe: no inline script or style).
`?font=anybody|bigshoulders|dela|archivo` forces a face; `?review=off` (or
`<html data-review="off">`) hides the control, which is how renders stay clean
(the shooter passes a `--css` file hiding `.fp-btn, .fp-toast` instead).
To remove it: delete those pieces; nothing else references them. IBM Plex
Sans and Instrument Sans left the prototype in round 2.

Pairing note: body stays Bricolage at text sizes. Its square counters and
open shapes sit beside Anybody's at 15-17px as one wide-grotesque family;
the cartoon read came only from the 800 weight, curled `y` and hooked `g`
at 32-40px. Measured at 393: Anybody sets the Today hero in three lines
(card bottom 537px, inside the ≤ 540 rule), Big Shoulders and Archivo in
two; Dela Gothic One overflows the three-line clamp at the current scale
and needs the smaller display scale listed in `../BUILD-NOTES.md` 1.1.

## Round 3 changes worth knowing

- Bridge card: the arc has a dot at both ends (HTML dots over an SVG path in a
  200x48 viewBox so they stay round); the far dot lands 40ms after the stroke.
  Known art is centred; `+ Up Next` rides the meta line like the rows.
- New ground: a 24px well holding a `--line` bar, the unfamiliar third as
  ultramarine hatching, the needle's cap 10px above the well, a `1 in 3`
  readout, heading 20/700. No thumb.
- `knob` mark: a filled disc, a groove pointer in the key's face colour, two
  end-stop dots, nothing above the disc. Fallback if it fails at the pick:
  Phosphor `faders`.
- Settings dials: persimmon fill, needle with cap, centre detent tick, mono
  offset (`+2`, `−1`) that disappears at the detent. The fixture opens with
  Engineering at +2 and History at -1 so both states of the readout show; the
  sheet container takes focus on open, not the Done key.
- Foray detail: one extended keycap (icon, word, mono readout): Play 22 min,
  Resume 12:40, Start over. An unavailable foray's empty well has no codes.
- Resume card: persimmon "Resume" tag, the mini player's key, progress and
  "42 min left" on one line, about 122px tall (the show name left the card to
  fit; it stays in the section's aria-label).
- First run: the wide-bets line replaces the why-line.
- Toast fixture: row 4 removed (four rows, "4 queued", badge 4); Undo puts it
  back at position 4.
- Show names in meta lines use a display-name rule in `shortShow()`: a trailing
  " - ...", " | ...", " with ..." or " (...)" clause goes, and so does a trailing
  "Podcast" or "Philosophy Podcast" (the data carries "The Partially Examined
  Life Philosophy Podcast"). Measured at 393: 7 of the 8 names on Today and
  Yours survive; 375 keeps 6. Full names stay on tiles, Find and "From".
  The row holding a downloaded mark lets `+ Up Next` wrap to a second line so
  the name survives.
- Find: `tile--m` is a row (discs left, name and count right); `tile--l` centres
  its text; a no-results tile is filled, not outlined; counts are one readout.
- Yours chip strip fades partial chips at both gutters (mask), episode Now
  Playing has a 44px band with no label row, Bakelite rubber is `#3A332C`, the
  fade under the dock is shorter so no why-line shows under the mini.
- Kept the sun-horizon Today icon: the `band` mark (three left-aligned bars)
  reads as a list at 24px, so the critique's fallback applies.

## Round 2 changes worth knowing

- Station codes are two characters (`OS`, `BR`, `MP`), unique within a foray.
- Narration ticks: 8px minimum, 3px hatch on detail/scrub bands, solid on the
  8px hero band and the mini line.
- Episode rows trail one Play key; "+ Up Next" is a text action on the meta line.
- Overflow openers are `.iconbtn`, not keycaps. Find idle lost its keycap row.
- Custom marks: `knob` (superseded in r3, see above) and `ph-sparkle` (drawn on
  the 24 grid, not the Phosphor path).
- `../../../../data-local/redesign/shots/tactile/r2/press/` (r3 shots: `.../r3/`) holds the six-frame
  hero Play press capture (Risk 1 in the direction).

## Motion

Springs as `linear()` tokens (`tokens.css`). The deck opens with a shared
artwork flyer (FLIP via Web Animations) under a sheet that is finger-tracked
on drag and released onto `--spring-sheet`; tab changes use View Transitions
where supported. The reduced-motion block is the single one in `tokens.css`.

## Licences

Fonts: Anybody, Bricolage Grotesque and Azeret Mono, plus the review-only
Dela Gothic One, Big Shoulders and Archivo, all OFL 1.1, Latin subset, from
Google Fonts. Icons: Phosphor Icons (MIT), Bold and Fill, plus custom marks.
