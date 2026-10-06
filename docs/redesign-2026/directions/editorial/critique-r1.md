# Edition: critique, round 1

Art director's pass over the round-1 prototype (`prototype/`), 2026-10-05.
Judged against `DIRECTION.md` and `BUILD-NOTES.md`. Where the build exposed a
fault in the direction itself, the direction is changed (§6) and the builder
follows the changed text.

**Verdict: not ready. One more round.** The bones are right and the two
signature marks (the editor's note, the stitched rule with its contents) are
already the best things on any of these screens. What is off is mostly
finish: two layout faults that read as bugs (the current queue row, the
onboarding buttons), a contrast token that was wrong in the build notes, a
Now Playing that does not survive 130% text, and the lead's key crowding the
editor's note off the first screen.

## 0. How this was judged

- Round-1 shots: `data-local/redesign/shots/editorial/r1/` (Paper, default
  state, viewport only). Those show one state of seven screens, so I rendered
  the rest myself with the same harness:
  - `data-local/redesign/shots/editorial/r1-ad/` — Night, `first-run`,
    `offline`, `loading`, NP `paused|buffering|episode`, `large=1`, `text=130`,
    foray `unavailable|finished|progress`, search results, keyboard, Colophon,
    at 393×852 and 375×667.
  - `data-local/redesign/shots/editorial/r1-ad-full/` — full-page captures of
    Today, Browse, Library, Foray detail (everything below the fold).
- Note for the builder: in `r1-ad` every route after the first `?scheme=night`
  rendered in Night, because the prototype writes `?scheme=` to the store. See
  must-fix 12.

## 1. What is right (keep it exactly)

- Masthead, dateline, the one strong rule, kicker, Display-1 headline: the
  front page reads as a front page. Fraunces at 30/34 with `opsz 72` is
  correct; do not touch the sizes.
- The editor's note: Newsreader italic beside the 2px red rule is the
  direction in one line. Same on Today, detail, onboarding.
- The stitched rule: proportional segments, hatched narration, the red
  cursor, the key with the hatched `4a` swatch. The Foray detail **Contents**
  (numeral, dot leaders, time, show line with swatch, stitch glyph on
  narration rows) is the best screen in the set.
- Now Playing's tinted stock (Paper and Night), the plate-strip-clocks-key
  line stack, the 80px ink circle with Fill glyphs, the five labelled actions.
  At 375×667 everything fits without the detail posture, as specified.
- Night is a designed palette, not an inversion: cream type, lifted segment
  inks, warm tint on Now Playing, cream play circle. Correct.
- The folio and ticker as inset floating chrome, the red progress rule on the
  ticker, Fraunces 15 for the ticker title.
- Browse's subject index (two columns, counts) and the Colophon sheet (page
  behind scaled, chips for scheme, ranked interests with weight words).
- Unavailable foray: plate and strip at 50%, ruled `.notice` with the `info`
  glyph, `Browse similar`. Exactly as written.

## 2. Must fix (priority order, with values)

1. **Up Next: the current row breaks the column grid.** The `PLAYING` slug
   sits in the numeral column, so that row's plate starts at x≈118 while
   every other plate starts at x≈60 (`library`, 393). It reads as a bug.
   Change (and §6 changes the spec to match): the numeral column stays
   28px for every row; on the current row it holds a 16px glyph in `--red`
   (`stitch` if the item is a foray, `speaker-simple-high` if an episode);
   the `PLAYING` slug moves into the text column, 8px above the title; the row
   grows to `min-height: 72px`; the 2px red left rule and 600 title weight stay.
2. **Onboarding: the two buttons sit on the real page's meta row.** At
   393×852 `Not now` has `53 min · 7 shows · 11 segments` showing through it
   and the 56px play circle peeks out at its right. Give the action block a
   solid band: `.first-actions { background: var(--page); border-top: 1px
   solid var(--rule); padding: 16px var(--margin) calc(16px + var(--safe-b));
   margin-inline: calc(-1 * var(--margin)); }`. Build the `.veil-cut` from
   §5.7 (veil at 40% over the lead plate's box only); the plate is currently
   under the same 70% as everything else, which was the one thing the veil
   was meant to let through.
3. **`--rule-strong` fails 3:1 on both schemes; the build notes were wrong.**
   `#B9B1A3` on `#F7F3EC` is 1.9:1, not 3.1; Night's `#4A4A52` on `#141416`
   is 1.6:1 (the skip circles all but vanish at night). New tokens (§6):
   Paper `--rule-strong: #8E887C` (3.2:1), Night `#66666E` (3.3:1). They are
   used by the scrub track, the skip-circle borders, the `.find` border, the
   grabber and the dot leaders. **Chips move to `--rule`** so they do not get
   heavier.
4. **Now Playing does not survive 130% text at 375×667.** In
   `now-playing-text-130__375x667` the plate shrinks to ~100px (spec floor
   160), the key line wraps to two lines, and the action labels collide
   (`BOOKMARK` overprints `UP NEXT · 5` overprints `MORE`). Three changes:
   - Tab and action labels are **captions, not text**: set `.btn-labelled`
     and `.folio .t-label` at a fixed `11px` (not rem), the one role exempt
     from text zoom (§6). At ≤ 380px wide add `letter-spacing: .04em`. Grid
     `grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px`.
   - When `(max-height: 700px)` and text ≥ 120% (`html[data-text="130"]` in
     the prototype): hide the `.note` in the Now Playing header posture (it
     is still in the detail posture below) and clamp the key line to one
     line with ellipsis on the show name. That returns ~70px to the plate.
   - Assert in the harness that the plate is ≥ 160px at `?text=130` on
     375×667. If it still is not, drop the show line before the title, never
     the transport.
   Also in the default 375×667 render the labels `BOOKMARK UP NEXT · 5` touch;
   the fixed 11px plus `.04em` fixes that too.
5. **The lead's key crowds the editor's note.** Seven shows plus narration
   make a four-line key (five at 130%) between the plate and the note, so the
   note, the second-loudest element, lands at the bottom of the first screen
   on 393×852 and off it at 130%. On Today only: cap `.strip-key` at two
   lines (`max-height: calc(2 * var(--lh-meta) + 4px); overflow: hidden`) and
   append a `.t-meta` `+3 shows` item that is a link to the detail. Full key on
   Foray detail. (§6 records it.)
6. **Dateline wraps with a leading separator.** `· 3 PICKS · 1 STRETCH …`
   starts line two on every viewport. Compose it as two explicit lines, each
   `display: block`: `MONDAY 5 OCTOBER · YOUR EDITION` / `3 PICKS · 1 STRETCH
   · 2 HR 22 MIN`. Offline: a third line **above**, `OFFLINE · DOWNLOADED ONLY`
   with a 14px `wifi-slash` glyph before it, still `--ink-2` (offline is a
   state, not 4a's authorship, so not red). Drop `text-wrap: balance` here.
7. **Missing artwork renders as blank stock.** `More forays` row two shows
   four empty cells; Browse's and Library's `Followed` grids have four blank
   squares each. Build the §4.3 fallback and extend it for contact plates
   (§6): a cell with no art is filled with that show's segment ink at 16%
   over `--stock-2` and carries the show's initial in `.t-d2` set in the same
   ink. Four blank cells may never ship, even in a prototype the judges see.
8. **Browse hooks are truncated descriptions, not hooks.** `Tracing 'phobia'
   from a founding father's coinage through rabies to its Gree…` is a cut
   sentence with an ellipsis; the direction asks for a hook of ≤ 16 words that
   ends. Use the catalog's hook field where it exists; where it does not,
   take the first sentence of the description, and if that exceeds 16 words,
   cut at the last clause boundary (comma, semicolon, colon) before the 16th
   word and end with a full stop. No mid-word ellipsis anywhere in the
   splatter. Clamp stays at 3 lines as a guard, not a method.
9. **Segment numbering counts narration.** Today says `11 segments`; Now
   Playing says `9 of 15`; Contents skips 6 and 12 where narration rows sit.
   Number content segments only, 1–11, everywhere (Contents numerals, the key
   line, the meta). Narration rows keep the stitch glyph and no number; the
   key line during narration reads `4a · narration · 40 s left` as specified.
10. **Two identical search fields on Browse.** The Commission inset and the
    floating `.find` are both a stock-2 pill with a magnifier; the screen reads
    as having two search boxes. The Commission field becomes a ruled box, not
    a pill: `border-radius: var(--r-plate)`, 1px `--rule-strong`, `--stock-2`,
    glyph `pencil-simple-line` 20px, placeholder `Name a subject…`. The pill
    stays unique to `.find`. (§6.)
11. **Resume row duplicates the ticker.** In `mini` the `RESUME` row and the
    ticker show the same Odd Lots episode. Hide the Resume block while
    `body[data-ticker="1"]` and the ticker item is the resume item; Resume is
    for a cold start or after Stop. Also add the 4px progress rule under the
    Resume title (§5.1.2), which is missing.
12. **Harness params must not persist.** `?scheme=`, `?text=`, `?large=`,
    `?state=` are render instructions; the prototype writes `scheme` to the
    store (`app.js` 718–728), so one Night route turned every later route
    Night. Apply URL params to the DOM only; write the store only from the
    Colophon chips. Lab builds inherit this rule.
13. **The Stretch slug is not the loudest line on its card.** Red 12px caps
    with a hairline reads quieter than the 19px title beside it. Keep the
    size, but on `.row-numbered.is-stretch` the red margin rule runs the full
    height of the text column, from the top of the slug to the bottom of the
    note (one 2px `--red` rule at `left: -14px`), replacing the note's own
    rule. The card becomes the only one with a red spine; that is loud without
    being bigger. (§6.)

## 3. Should fix

- **Now Playing plate region**: at 393×852 the slack lands between the plate
  and the scrubber (~60px), which separates the plate from the strip it
  belongs to. Use `align-items: end; padding-bottom: 24px` on
  `.np-plate-region` so the slack sits under the header and the
  plate-strip-clocks block stays tight.
- **Foray Now Playing show line**: `THE BOOTSTRAPPED FOUNDER` repeats the key
  line one row above. For a foray, replace the show label with the current
  segment's title in `.t-text` `--ink-2`, one line, ellipsis; the key line
  keeps the show. Episodes unchanged. (§6.)
- **`Where this came from` rows**: the trailing `Open` button truncates every
  title (`Y Combinator Startu…`). The row is the link; drop the trailing
  button and let the title run the width. Record in §5.6.
- **Row meta orphans**: `The Matt Walker Podcast · 32` / `min`. Wrap the
  duration in a `white-space: nowrap` span; the show name ellipsizes first.
- **Followed grid**: 4 × 72px cells leave 40px slack at 393. Use
  `grid-template-columns: repeat(4, minmax(0, 1fr))`, `aspect-ratio: 1`.
- **`Play the edition` during `loading`**: hide it until the lead exists
  (`.masthead .btn-text` is already specified as hidden with no playable item).
- **Offline lead**: the lead renders identically to online; it is not clear
  whether it is downloaded. Show the `DOWNLOADED` slug under the kicker when
  it is; when it is not, the play circle is `aria-disabled` at 40% opacity and
  the meta gains the 16px `cloud-slash` glyph.
- **Night skip-circle glyphs**: once `--rule-strong` is fixed the circles
  return; verify the arc numerals (8px `<text>`) stay legible on Night. If
  not, numerals to 9px/600.
- **`Also today` section head**: in the full-page capture it is hidden under
  the fixed folio; verify it renders at 32px above the first numbered row.

## 4. Data and prototype notes (not design faults, carry forward)

- Contents rows 7–9 are three segments with the identical title from one
  show. Phase 3 pipeline: merge consecutive same-title segments from one
  show into one contents row, or suffix them `(2)`, `(3)`. Not the builder's
  job this round.
- Your subjects rows lack the 4px progress rule under the meta (§5.1.6);
  low priority.
- The `More forays` plates borrow neighbour artwork; fine for a prototype,
  say so in the README (it does).

## 5. Motion (unverified in stills)

The page turn, row push and insert-with-gap are built per the README; the
harness captures stills, so this round judges none of them. Round 2: the
builder records a 10-second screen capture of ticker → Now Playing → drag
down, and row → detail → back, into `data-local/redesign/shots/editorial/r2/`.
Overshoot above 2% or any animated property other than `transform`/`opacity`
is a must-fix on sight.

## 6. Direction changes made in this round

Written into `DIRECTION.md` and `BUILD-NOTES.md` today; the builder follows
the files, not this summary.

- `--rule-strong`: Paper `#8E887C`, Night `#66666E`. Chips use `--rule`.
- Tab and action labels are fixed 11px captions, exempt from text zoom.
- Today's lead key caps at two lines plus `+n shows`.
- Queue current row: glyph in the numeral column, `PLAYING` slug above the
  title, 72px. `PLAYING` glyph is `stitch` only on forays.
- Segment numbering excludes narration.
- Commission field is a ruled box with `pencil-simple-line`; the pill is
  `.find` only.
- Stretch card: one red spine from slug to note.
- Foray Now Playing: segment title replaces the show label.
- Contact plates with missing art: show-ink cell with initial.
- Dateline: explicit lines; offline line with `wifi-slash`.
- Now Playing at ≥120% text on short screens: note hidden, key line one line.
- `Where this came from`: no trailing `Open`.
- Harness params never persist.

## 7. Round 2 acceptance

Ready when, at 393×852 and 375×667, Paper and Night, 100% and 130%:
Up Next's plates share one x; onboarding's buttons sit on solid page; the
skip circles are visible at night; Now Playing's plate is ≥ 160px at 130%
on 375×667 with no label collisions; the editor's note is on Today's first
screen at 100%; no blank plate anywhere; no hook ends mid-word; Contents
numbers 1–11; the dateline never starts a line with `·`. Plus the two motion
captures from §5.
