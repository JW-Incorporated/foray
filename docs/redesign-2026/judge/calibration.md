# Judge calibration report

The rubric (`rubric.md`) is untrusted until it ranks reference apps above
today's 4a, and today's 4a above deliberately degraded variants of itself
(`protocol.md`, "Calibration"). This file records each calibration round. The
pair set is `calibration-pairs.json`. All images live in `data-local/redesign/`,
which is gitignored and never committed (third-party App Store imagery, public
repo). They are referenced here by path only.

## Round 1 (2026-10-05): PASSED

| Measure | Result | Bar |
|---|---|---|
| Pairs decided for the expected side | **14 of 14 (100%)** | at least 12 of 14 (protocol); 80% (round brief) |
| today-vs-degraded pairs decided for the degraded side | **0 of 6** | 0 |
| Ties | 0 | none required |
| Unanimous pairs | 14 of 14 (every pair 2-0) | none required |

**Verdict: the rubric is calibrated and trusted for Phase 2 and later.** No
misses, so the rubric is unchanged and no re-run is needed.

By kind:

| Kind | Pairs | Expected side won |
|---|---|---|
| ref-vs-today | rt-1 to rt-6 | 6 of 6, all 2-0 |
| today-vs-degraded | td-1 to td-6 | 6 of 6, all 2-0 |
| ref-vs-degraded | rd-1, rd-2 | 2 of 2, both 2-0 |

### How the round ran, and where it differs from the protocol

- **Two judges per pair, not three.** `protocol.md` asks for three judges in
  calibration. Round 1 used two. This cannot change the result: every pair was
  2-0, and a third vote cannot overturn a 2-0 majority (the worst case is 2-1
  for the same side). Recorded as a deviation, not re-run, because a re-run
  would spend judge runs without being able to change any outcome. Later
  rounds, and the Phase 2 direction ranking, use three judges as the protocol
  says.
- **Each judge's display order was opposite in every pair.** A judge's reasons
  say FIRST and SECOND for the image it was shown first and second. From those
  words, in all 14 pairs the two judges saw the images in opposite orders (for
  example in rt-1, judge 1 saw the reference first and judge 2 saw today's 4a
  first). Every expected winner therefore won once from the first position and
  once from the second, so position bias cannot explain any verdict. (With
  independent coin flips, 14 opposite pairs in a row has odds of 1 in 16,384. The order assignment was
  probably balanced on purpose rather than random. Balanced is the stronger
  design for this question, so it is noted, not corrected.)
- **The judges ignored the marketing frame.** No reason in any ref pair
  mentions a caption, backdrop or bezel. Every ref-pair reason names
  something inside the app UI (chrome, controls, type, cards). That is the
  confound `protocol.md` flags, and round 1 shows the judges managed it.
- **Spot-check of grounding.** Reasons are claims, so one was checked against
  its image. In td-3, judge 2 says the degraded library has its first Foray
  title clipped under the header, rows pressed against the left edge, and no
  "Forays" label. The render
  (`data-local/redesign/shots/degraded-1/shots/returning__library__393x852.png`)
  shows all three: the "startup can raise" title is cut off at the top, the
  rows run to the left edge, and no section label sits above the first card.

### What round 1 does and does not prove

- It proves the judges reliably separate **wide** quality gaps: a polished
  2026 app from today's 4a, and today's 4a from a deliberately broken variant.
- It does **not** yet prove that the judges can rank **close** designs, such as
  two good art directions in Phase 2. Every calibration pair had a wide gap. If
  Phase 2 rankings come out split or tied, the next step is a round with a mild
  degrader (one change, for example a slightly uneven gutter) against today's
  screen. That would show whether a 2-1 split there is signal or noise.
- The ref-vs-today wins lean on **2026 platform fit** (floating glass chrome,
  segmented controls, bottom-reachable controls). It is the dimension cited
  most in rt-2, rt-3, rt-4 and rt-6. Today's 4a loses that dimension
  consistently, and the redesign directions should expect to be judged on it.
- Today's 4a repeatedly lost the ref pairs on the same visible faults. These
  are useful design input for Phase 2:
  - Now Playing mixes control treatments: a red-outlined Stop, a purple-outlined
    Saved, filled pills and bare text links, set on an uneven grid. It uses text
    glyphs (↺15, ⏭) where icons belong (rt-1, rt-5).
  - Long serif titles push the transport controls down (rt-1, rt-5).
  - Every row title uses the same heavy serif weight, so nothing leads (rt-2,
    rt-6).
  - A flat, web-style hamburger header (rt-2, rt-3, rt-4, rt-6).
  - On Home: repeated, mostly empty cards, a duplicated section and clipped
    titles ("Short historie", "2 HR 58 MIN") (rt-4).
  - On search results, the search field overlaps the last row (rt-6).

### Per-pair results

`expected` is the side in `calibration-pairs.json` that should win. Each pick is
already mapped back to the pair's `a`/`b` sides. Reasons are verbatim. FIRST and
SECOND in a reason mean the order that judge saw, which the "J saw first"
column shows.

#### rt-1 (ref-vs-today): expected `a`, outcome `a` 2-0

`a` = `refs/spotify/2.png`, `b` = `shots/today/shots/player__now-playing__393x852.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | ref | a | Consistency: SECOND's controls mix five treatments (red-outlined Stop, purple-outlined Saved, filled tiles, bare text links) on an uneven grid, while FIRST uses one icon family. Hierarchy: FIRST has a single white play button as the focus. SECOND's three-line serif title crowds the controls. |
| 2 | today | a | Consistency/iconography: SECOND uses one family of outline glyphs in a single, evenly spaced transport row. FIRST mixes a red-outlined Stop, a purple-outlined Saved, a filled Bookmark pill and bare text links across a ragged three-row grid. Hierarchy: in SECOND the art, title and play button step down cleanly. FIRST's controls compete with each other. |

#### rt-2 (ref-vs-today): expected `b`, outcome `b` 2-0

`a` = `shots/today/shots/returning__library__393x852.png`, `b` = `refs/overcast/1.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | ref | b | Platform fit: FIRST uses floating circular glass-style buttons and a segmented control, while SECOND's hamburger bar and outlined cards look like a web page. Colour: FIRST's playlist icons use colour with meaning. Hierarchy: SECOND gives every row the same heavy serif weight, so nothing leads. |
| 2 | today | b | Platform fit: SECOND has floating circular glass buttons, a segmented control and horizontal shelves, while FIRST pairs a hamburger with a tab bar and looks web-like. Hierarchy: FIRST's bordered cards are all identical and show-name rows leave empty space. SECOND varies its section treatments with clear purpose. |

#### rt-3 (ref-vs-today): expected `a`, outcome `a` 2-0

`a` = `refs/apple-podcasts/2.png`, `b` = `shots/today/shots/returning__show__393x852.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | ref | a | FIRST is ahead on 2026 platform fit. It has floating translucent glass chrome, a mini player and a bottom-reachable tab bar, while SECOND has a flat web-style header. FIRST's type scale is tighter. SECOND puts a large centred explanatory paragraph under the button and has a stranded "E" badge and a text-glyph back chevron. |
| 2 | today | a | Platform fit: SECOND's floating glass back/star controls and pill tab bar look like 2026 iOS, while FIRST has a flat web-style header and tab bar. Hierarchy: SECOND's branded hero steps down cleanly. FIRST mixes a serif heavily with a sans, and its centered explainer text is cramped. |

#### rt-4 (ref-vs-today): expected `b`, outcome `b` 2-0

`a` = `shots/today/shots/returning__home__393x852.png`, `b` = `refs/tide-guide/2.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | ref | b | Hierarchy: FIRST pairs big numbers with charts inside layered translucent cards and floating glass chrome, which fits 2026 well. SECOND repeats the same cards, mostly empty, with no imagery. It has clipped/truncated titles ("Short historie", "2 HR 58 MIN") and a flat 2015-web header. |
| 2 | today | b | SECOND has a clear hierarchy: big readouts sit above the charts, a floating glass tab bar and segmented pills match 2026 platform style, and the cards are styled the same way throughout. FIRST has repeated, mostly empty cards, a duplicated section, clipped titles and truncated "Suggested" text, and a flat top bar that looks like a dated web page. |

#### rt-5 (ref-vs-today): expected `a`, outcome `a` 2-0

`a` = `refs/pocket-casts/2.png`, `b` = `shots/today/shots/stress__now-playing__393x852.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | ref | a | Hierarchy: in FIRST, the artwork and pause button lead the screen, while in SECOND a six-line serif title pushes the controls down. Consistency: SECOND mixes red-outline, purple-outline and filled button styles. Iconography: FIRST uses one matched icon set, while SECOND uses text glyphs like ↺15 and ⏭. |
| 2 | today | a | Consistency: FIRST mixes red-outlined, purple-outlined and plain button treatments across two crowded control rows, with a clipped third row; SECOND has one coherent control set. Iconography: FIRST uses text glyphs (↺15, ⏭); SECOND has matched drawn icons. Hierarchy: SECOND's large play button clearly dominates. |

#### rt-6 (ref-vs-today): expected `b`, outcome `b` 2-0

`a` = `shots/today/shots/search__search-results-history__393x852.png`, `b` = `refs/moonlitt/2.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | ref | b | Platform fit and material: FIRST uses translucent glass pills and floating controls on a cohesive indigo palette, while SECOND is a plain bordered-card list. Distinctiveness: FIRST's moon-phase grid has a clear voice. Polish: in SECOND the search bar overlaps a clipped last row, and every title is set in the same heavy serif. |
| 2 | today | b | Platform fit: SECOND has floating glass pill controls and a layered context menu; FIRST has a web-style hamburger header. Hierarchy: in FIRST, every row title is the same oversized bold serif, so nothing stands out. Polish: in FIRST, the search field overlaps the last row's title, which shows through it. |

#### td-1 (today-vs-degraded): expected `a`, outcome `a` 2-0

`a` = `shots/today/shots/returning__home__393x852.png`, `b` = `shots/degraded-1/shots/returning__home__393x852.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | today | a | Typography: SECOND mixes condensed, monospace, italic and serif type with all-caps card titles, a chaotic scale; FIRST keeps one serif and one sans. Spacing: SECOND's text butts against card edges and the play pill nearly touches the screen edge. Polish: SECOND's progress bar and dotted rule collide with card borders. |
| 2 | degraded | a | Typography: FIRST mixes monospace caps, italic serif and condensed display at odd sizes, while SECOND uses a coherent serif/sans scale. Spacing: FIRST's cards have cramped padding, clipped text and an uneven gutter, where SECOND keeps a consistent 32px margin. Hierarchy: SECOND's sentence-case headings step down clearly. |

#### td-2 (today-vs-degraded): expected `b`, outcome `b` 2-0

`a` = `shots/degraded-2/shots/player__now-playing__393x852.png`, `b` = `shots/today/shots/player__now-playing__393x852.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | today | b | Colour: SECOND clashes magenta, blue, green and orange, and its green-on-pink labels have poor contrast. Consistency/polish: SECOND adds dashed outlines, yellow boxes, a blue offset shadow and a centred title over left-aligned metadata. Hierarchy: FIRST's single lavender play button anchors the screen clearly. |
| 2 | degraded | b | Colour: FIRST mixes a garish magenta, blue, orange and green palette with low-contrast green-on-pink text, while SECOND uses one restrained dark palette with a single purple accent. Polish: FIRST has dashed debug outlines and a misaligned blue offset shadow. Hierarchy: SECOND's left-aligned title and round primary play button read cleanly. |

#### td-3 (today-vs-degraded): expected `b`, outcome `b` 2-0

`a` = `shots/degraded-1/shots/returning__library__393x852.png`, `b` = `shots/today/shots/returning__library__393x852.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | degraded | b | Typography: FIRST mixes condensed, monospace, italic-caps and serif faces, while SECOND uses one serif/sans pairing throughout. Spacing: FIRST has cramped cards, a crowded header and a missing "Forays" label, while SECOND keeps consistent gutters and padding. Hierarchy: SECOND steps title, section labels and rows down cleanly. |
| 2 | today | b | Polish: SECOND's first Foray title is clipped under the header, and its rows press against the left edge. Typography: SECOND mixes a monospace, a condensed face, italics and all-caps; FIRST holds to one serif/sans pair. Spacing: FIRST keeps consistent gutters and section labels, while SECOND is cramped and lacks them. |

#### td-4 (today-vs-degraded): expected `a`, outcome `a` 2-0

`a` = `shots/today/shots/search__search-results-history__393x852.png`, `b` = `shots/degraded-2/shots/search__search-results-history__393x852.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | degraded | a | Colour: FIRST mixes a garish blue header, green background, magenta cards and yellow borders, while SECOND uses a restrained dark palette with one amber accent. Typography: FIRST puts wavy underlines on every title and its header text has low contrast. Polish: FIRST's artwork indents differ from row to row, and SECOND's rounded cards line up on one edge. |
| 2 | today | a | Colour: SECOND clashes blue, green, purple, magenta and yellow, and puts wavy underlines on every title. Alignment: SECOND's thumbnails and titles shift indent from row to row, and its header and SHOWS label sit off the margin. FIRST keeps one dark palette, rounded cards and a shared left edge. |

#### td-5 (today-vs-degraded): expected `a`, outcome `a` 2-0

`a` = `shots/today/shots/returning__show__393x852.png`, `b` = `shots/degraded-1/shots/returning__show__393x852.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | today | a | Typography: SECOND mixes a condensed sans, a monospaced all-caps font and a bold serif, while FIRST keeps one consistent serif-plus-sans scale. Spacing and polish: in SECOND the header overlaps and clips the artwork, and the cards are cramped and nearly edge-to-edge. Hierarchy: FIRST's Followed button and cards step down clearly. |
| 2 | degraded | a | FIRST has broken typography: all-caps monospace titles mixed with Times and condensed headers, with the header overlapping and clipping the artwork. Its cards have almost no padding and the text runs to the edges. SECOND keeps one consistent serif/sans scale, a clear hierarchy and even gutters. |

#### td-6 (today-vs-degraded): expected `b`, outcome `b` 2-0

`a` = `shots/degraded-2/shots/returning__up-next__393x852.png`, `b` = `shots/today/shots/returning__up-next__393x852.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | today | b | Colour: SECOND clashes magenta, green, yellow and blue, and its green-on-purple metadata has poor contrast. Consistency/polish: SECOND's cards are tilted and misaligned, with dashed outlines and squiggly underlines. FIRST uses a restrained dark palette, consistent round controls and a clear type hierarchy. |
| 2 | degraded | b | Colour: FIRST has a garish blue/green/magenta palette with low-contrast green text on green and on purple, which fails accessibility. Consistency/polish: FIRST has rotated, misaligned cards and dashed outlines on every button. SECOND has a restrained dark palette, one rounded control family and a single orange accent. |

#### rd-1 (ref-vs-degraded): expected `a`, outcome `a` 2-0

`a` = `refs/tide-guide/2.png`, `b` = `shots/degraded-1/shots/returning__home__393x852.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | ref | a | Typography: FIRST uses one controlled sans scale. SECOND mixes monospace, serif italic and condensed display faces in clashing sizes. Polish: SECOND clips card text and lets body copy overflow its cards. Platform fit: FIRST has translucent glass cards, a floating tab bar and a consistent blue palette. |
| 2 | degraded | a | Typography: FIRST mixes monospace caps, italic serif, condensed display and bold serif. SECOND uses one clean sans scale. Polish: FIRST's play pill is off the left edge, its card text is clipped and its rows overflow. SECOND's cards share consistent radii and edges. Platform fit: SECOND has a floating glass tab bar and a coherent blue palette. |

#### rd-2 (ref-vs-degraded): expected `b`, outcome `b` 2-0

`a` = `shots/degraded-2/shots/player__now-playing__393x852.png`, `b` = `refs/spotify/2.png`

| Judge | Saw first | Pick | Reasons |
|---|---|---|---|
| 1 | ref | b | Colour: SECOND's magenta, purple, blue and orange palette is garish, and its low-contrast green text on purple fails AA. Consistency and polish: SECOND has dashed debug outlines, mismatched button shapes and yellow box borders. FIRST has a restrained dark-teal palette, one primary play control and a clear type hierarchy. |
| 2 | degraded | b | Colour: FIRST mixes magenta, blue, orange, green and yellow outlines at random, and green-on-magenta text has poor contrast. Hierarchy and consistency: FIRST's dashed debug borders and mismatched pill buttons fight each other, while SECOND has one restrained palette and a clear play-button focal point. |

Paths in the per-pair headers are relative to `data-local/redesign/`.

### Misses

None. Every pair went to its expected side unanimously, so no miss needed
explaining from the screenshots.
