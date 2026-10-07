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

## Display face: Big Shoulders (owner decision, 2026-10-06 20:55 PDT, final)

Display, title and heading set **Big Shoulders** (`fonts/big-shoulders-latin.woff2`,
OFL 1.1, Google Fonts Latin slice, variable wght 100-900 with an opsz axis
that follows font-size). Bricolage Grotesque stays for every text-size role,
Azeret Mono for readouts. History: Bricolage at 800 was called "cartoonish",
then Archivo "a little plain", then four candidates went to the owner on a
review switcher and he picked Big Shoulders. Anybody, Dela Gothic One and
Archivo, their `@font-face` rules, tokens and WOFF2 files, and the review-only
"Aa" switcher (`font-preview.js`, `font-preview.css`, the `data-display-font`
block, the `cp_display_font_preview` key and the `?font=` / `?review=off`
parameters) are deleted. Nothing else referenced them.

Tokens (`tokens.css`, from `../BUILD-NOTES.md` 1.1, the r7 values):

| Role | Size / line height | Weight | Width | Tracking |
|---|---|---|---|---|
| display-xl | 44 / 48 (`2.75rem` / `3rem`) | 800 | 100% | 0.005em |
| display | 36 / 40 | 800 | 100% | 0.005em |
| title | 26 / 30 | 750 | 100% | 0.01em |
| heading | 22 / 26 | 750 | 100% | 0.01em |

- No `wdth` axis, so `--wd-*` and `--wd-screen` read 100%; the screen titles
  (Today, Find, Yours) are plain display-xl.
- `.hero .display` takes line-height 1.2 (set in `app.css`, where the hero
  rules live, so it is not overridden by source order).
- 800 is Big Shoulders' display weight. The old 700 ceiling was Bricolage's
  curl, which this face does not have; the ceiling now applies to Bricolage
  only.
- `ascent-override: 84%` / `descent-override: 24%` on the `@font-face` centre
  the ink in the line box so clamped titles do not clip descenders. Chromium
  and Firefox honour them; **WebKit ignores them**, so Phase 3 re-cuts the
  file's `hhea` / `OS/2` ascent and descent with `fonttools` and renames the
  family per the OFL Reserved Font Name clause.
- Renders: `data-local/redesign/shots/tactile/r8/` (seven routes at 375 / 393
  / 412, all `--scheme light`, gitignored). The Home background pixel samples
  `#F7F0E4` (Cream). Shoot with `node tools/ui-lab/shoot.mjs --target url --url
  <path to prototype/index.html> --routes #/home,#/mini,#/now-playing,#/search,#/library,#/foray,#/onboarding
  --scheme light --out data-local/redesign/shots/tactile/r8`; the shooter takes
  a file path, not a `file://` URL, and serves it itself.

Measured with the same fixture at r7 (375 / 393 / 412): "Today" 98.5px, hero
3 / 2 / 2 lines (card bottom 547 / 514 / 517), Now Playing title 2 lines at
26px, Foray detail 4 / 3 / 3 lines at 44px, nothing clipped. Round-by-round
reasoning is in `../critique-r6.md`, `../critique-r7.md` and `../DIRECTION.md`.

### Earlier rounds still true

- Band station codes are built per run of adjacent same-show bars
  (`critique-r5.md`), so `BR BR` / `BC BC` no longer doubles at 412.
- `text-wrap: balance` on `.onb__copy .display`, `.hero .display`, `h1.clamp4`.
- `.tile__name` takes the display face at heading weight (Find tile names are
  one role); the large tile keeps the title role.

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

Fonts: Big Shoulders, Bricolage Grotesque and Azeret Mono, all OFL 1.1,
Latin subset, from Google Fonts. Icons: Phosphor Icons (MIT), Bold and Fill, plus custom marks.
