# Clarity, round 1 critique

Art director's review of the round-1 prototype
(`docs/redesign-2026/directions/clarity/prototype/`) against `DIRECTION.md`
and `BUILD-NOTES.md`. Shots reviewed: all 21 in
`data-local/redesign/shots/clarity/r1/` (dark, three viewports, one state).
Verdict: **not ready; one more round is needed.** The bones are right, and the
build is faithful to the notes in most measurable places (tokens, fonts,
sprite, dock geometry, timeline ticks, mono data column). What is off is
hierarchy and density, the one accent being spent in several places, the
unplayed strip failing contrast, and the fact that half the direction (light
scheme, every non-default state, the foray on Today's first screen) was never
rendered, so it cannot have been judged.

Items are in priority order. Each one says what, where, the value, and why.
Where the fault is in the direction rather than the build, I have changed
`DIRECTION.md` / `BUILD-NOTES.md` and say so; the builder follows the updated
notes, not round-1 memory.

## What is right, keep it

- Geist / Geist Mono, tabular figures, the mono data column: every number on
  the screen lines up on the right edge. That is the board. Do not touch it.
- Hairlines from the text edge, not the art edge. Rows read as a table.
- The 24px timeline with 5-minute ticks and 10-minute mono labels on Now
  Playing and Foray detail, the 2px Signal playhead, the hatched narration
  gaps. The readout "8 of 22 · The Bootstrapped Founder · 1:58 left" is exactly
  the sentence the direction asked for.
- Now Playing proportions at 375×667: artwork shrinks, the transport sits at
  ~570/667, in the thumb. The `min(100vw − 40px, 100dvh − 420px)` rule works.
- The transport glyphs with the number inside the arc; the 72px Signal play.
- Dock as one capsule, mini player above the tab bar, 2px progress line on the
  top edge, no Signal in the tab bar.
- Foray detail: display title, mono stat line, "Why for you", one Signal
  action, legend as "Where this came from". This screen is the closest to the
  direction and needs only the small items below.
- Onboarding is the product, not a tutorial: real rows, real strip, 11-word
  headline, one Signal button.

## P0: must change before round 2

### 1. The why-line is grey on every row but the stretch row

Shots: home, onboarding, library, all viewports. `.row__why { color:
var(--muted) }`; only `.row--stretch .row__why` is ink. DIRECTION §10 says the
why-line is the loudest line on the row; today's render makes it the quietest.
The board's whole argument is "4a says why"; the why is the one thing a new
user should read first.

Change: `.row__why { color: var(--ink); }` on every row type (board, lead,
onboarding, library, queue). Keep `--t-body` 17/24 400. The show line drops to
`caption` 13/16 muted (was `label` 15/20) so the stack has one quiet line, one
strong line (title), one plain ink line (why). Direction updated (§2 scale,
§10).

### 2. Density: the direction promised 7–9 rows, the build shows 4.5

Shots: home 393×852 shows the lead plus 3.5 rows; 375×667 shows the lead plus
1.5. Rows measure ~136px (show 20 + title 44 + why 48 + padding 24), not 72.
The 72px row in BUILD-NOTES 1.3 was never achievable with a 3-line stack of
17px text; the direction promised a density its own type scale cannot produce.
That is my error, not the builder's, and I have corrected the direction rather
than ask for 72px rows.

Change (direction updated, §8, §11, BUILD-NOTES Row, 4.1):

- Board row stack: show `caption` 13/16 muted · title `body-strong` 17/22
  **clamped to one line** · why `body` 17/24 ink, clamped to two. Padding 12/12.
  Row = 12 + 16 + 22 + 2 + 48 + 12 = **112px**. One line per train is the
  departures-board idiom; the why-line carries the subject the ellipsis cuts.
- Lead row keeps a two-line title (it is the one row allowed to be tall);
  min-height 128, not 112.
- Target: **five board rows visible at 393×852 after the lead, three at
  375×667.** Measure it in the round-2 shots and write the count in the PR
  body.
- Section head margin-top 32 → 24. The 32 + lead row's 16px bottom padding +
  the hairline read as a hole between the lead and "Picked for you" (home
  393: 60px of nothing).

### 3. Signal is spent three to four times per screen

The direction: one accent marking exactly one thing per screen. Counts in the
shots (excluding the mini player, which is global):

- Library: "All 14 shows" text link, the "Now" rule, the word "Now", the
  position "1". Four.
- Onboarding: "Show my picks" and "Later". Two; the skip action is as loud as
  the primary.
- Foray detail: "Resume at 18:34" plus the playhead. Two is correct here (the
  playhead is the live mark); keep.
- Now Playing: play, playhead, nothing else. Correct.

Change: `Button--text` becomes `--ink` 500 with a trailing 16px
`chevron-right`, never `--accent-ink` (BUILD-NOTES component table updated).
"Later" on onboarding: `--muted` 500, no chevron. "All 14 shows", "All 22
segments", "More"/"Less" under notes, "Show saved": all ink. `--accent-ink`
as text is reserved for exactly two things: the bridge line (`fusion →
materials science`) and the word "Now" on the playing queue row. The queue
position "1" above "Now" goes back to `--muted`.

### 4. Unplayed strip bars fail 3:1

`.strip--prog .seg:not(.seg--n) { background: color-mix(in srgb, var(--c) 38%,
var(--bg)) }`. On `#0C0C0D`, c3 (`#5B9BFF`) at 38% is roughly `#2A4066`, about
1.9:1; c6 and c7 are in the same range. In the Now Playing shots bars 9–22 are
navy-on-black smudges; the stitched timeline, the signature, is illegible for
the part of the foray you have not heard yet, which is the part you want to
read. BUILD-NOTES 1.1 promised every bar clears 3:1 on both backgrounds.

Change: 38% → **62%**, then compute the ratio of all eight mixed colours
against `--bg` in both schemes and put the table in BUILD-NOTES 1.1 under the
seg table (lowest value named). If any bar is under 3:1 at 62%, raise the mix
for that token only. Played bars stay at 100%. The `.strip--done` neutral and
`.strip--off` faint variants are fine as they are because they are not meant
to be read bar by bar.

### 5. Light scheme and every non-default state are unrendered

`index.json` lists one state, `default`, and every PNG is dark. The direction's
headline overturn ("dark-only is overturned; neither scheme is an inversion of
the other") is unjudged, and so are first run, offline, loading, empty Find,
buffering, foray end, the Resume section, "Not available right now", "No
narration yet". DIRECTION §12 claims "every empty, offline and error state is a
row with an action"; the build has `noresult` for Find and nothing else
(`grep -i "skeleton|offline|Picked to start|buffering"` on `clarity.js` returns
nothing).

Change, prototype side so the harness can reach them without new harness
work:

- Honour `?theme=light|dark` in the URL: set `data-theme` on `<html>` before
  first paint (inline in `clarity.js`'s first statement, not a `<script
  style>`; CSP still applies). Keep the in-app Appearance control.
- Honour `?state=` with these values, each forcing the seeded data into that
  condition: `firstrun` (no stat line, lead eyebrow "Picked to start"),
  `midlisten` (Resume section second, lead capsule reads "Resume"), `offline`
  (saved badge in the data column, unsaved rows `--muted` + `aria-disabled`,
  the one EmptyState line at the top with "Show saved"), `loading` (skeleton:
  1 lead + 4 rows, same geometry), `find-empty` (query "fusion" typed; the
  "Nothing for 'fusion'. Fusion & energy systems has 5 shows" line with that
  row under it), `np-buffering` (clock replaced by the word), `np-end` (Up next
  line risen into the title slot), `foray-unavailable`, `foray-unnarrated`.
- Document the parameters in a comment at the top of `index.html` and ask the
  orchestrator, in the round-2 return, to add `theme × state` to the shoot
  config. Until the shots exist, the direction's light scheme is a claim.

### 6. The foray is not on Today's first screen

"Forays for you" exists in the build (`clarity.js:179`) but sits below
"Picked for you" and is off-screen in all three viewports. The direction calls
the stitched timeline the thing that makes 4a visibly its own kind of thing;
the Today screen, the one a reviewer sees first, shows no strip at all.

Change (direction updated, §11; BUILD-NOTES 4.1): section order on Today is
**lead · Resume (only when something is mid-play) · Forays for you · Picked
for you**. When today's session carries a foray, the lead row may be the foray
(72px mosaic art, 4px strip under the stack, eyebrow "Today's lead · Foray · 6
shows"); the stat line counts it. At 393×852 the strip must be inside the first
viewport in the `default` state.

## P1: should change

### 7. The stretch row's show name wraps badly in the data column

Home 393: "Stuff You / Should" under "37 min"; 375: "fusion →" / "materials
science" then the same. The data column is for numbers; a proper noun broken
across two lines in 12px mono is the one thing on the screen that looks like
an accident.

Change (BUILD-NOTES Row--stretch updated): the bridge replaces the eyebrow,
and the show name stays in the stack as the `caption` line under the bridge:
bridge · show · title (1 line) · why (2 lines, ink). Data column: duration
only. The arrow is the Lucide glyph at 16px with `white-space: nowrap` on the
`from →` pair so a wrap breaks before the target subject, never after the
arrow. Stretch rows are the one taller row per section (128px) and that is
fine.

### 8. Long durations split into two mono lines

"3 hr" over "14 min" in every row over an hour (home lead, Fall of
Civilizations, onboarding). Two stacked values read as two facts.

Change: durations at or over 60 minutes render `3h 14m` (one line, six
characters, fits the 72px column at `data` 15px); under an hour stays `37
min`. Remaining time keeps the clock form (`-35:07`, `28 min left`). Apply in
`fmtMin` and nowhere else.

### 9. Queue row title is the wrong size

Library 393: the Up Next row title renders at roughly 20–22px, larger than any
board row title, and clamps to two lines against a 44px thumbnail. The row
breaks the table.

Change: queue row title `body-strong` 17/22 clamped to one line, show
`caption` under it; position `data` 15px muted; the "Now" word `data-sm` in
`--accent-ink` under the position. Row height returns to 64.

### 10. Dock tint lets scrolled rows show through

Home 393: "…ured ier R…son" is legible through the tab bar behind "Today";
foray and library: "12 min", "4 segments" ghost through the mini player.
`--dock` is 90% and the blur is 20px; in these renders the result reads as a
glass pane with text behind it, which is the Liquid-Glass look the direction
explicitly declines.

Change: `--dock` to `rgb(12 12 13 / .94)` dark and `rgb(255 255 255 / .93)`
light; blur stays 20px. Verify in round-2 shots that no row text is readable
through the capsule. If it still is, drop the blur and go solid; the
direction already says "no faux glass on Android".

### 11. The Find field floats over list rows with no material

Search 393: "Fusion & energy systems" runs under the docked field's edge.
Change: the docked `Field` takes the dock material (`--dock` tint, same blur
and shadow), 8px above the dock. The idle list then needs no extra padding,
but keep the 96px clearance so the last row can scroll clear.

### 12. Hairlines are too faint on dark

`--line` is `ink 12%` on both schemes; on `#0C0C0D` that is roughly `#272728`,
and in every dark shot the rules are barely there. A board without visible
rules is a list.

Change: dark `--line` to `color-mix(in srgb, var(--ink) 16%, transparent)`;
light stays 12%. `--line-strong` unchanged. Tokens table in BUILD-NOTES 1.1
updated.

### 13. Now Playing: the gap under the why-line

393: ~50px between the why-line and the strip, more than anywhere else on the
sheet, so the strip reads as a separate panel. Change: 32px. The space the
sheet gains goes under the transport, where the control row is clipped at
393.

### 14. "Name a subject" reads as a heading

Search 393: 17px 560 ink with a bare `+` at the right, 72px tall; it looks like
a section title above "Subjects". Change: row height 56, label `body-strong`,
the plus inside a 44px hairline circle (`--line-strong`), and a `caption` line
under the label: "Build a foray on anything". It stays a row, not a field; the
screen already has one field and it should keep one.

### 15. Subjects board pushes "Shows you follow" below the fold

Eleven 56px rows. Change: show eight, then an ink text row "All 11 subjects"
(chevron). Static, not infinite, so principle 1 is untouched.

## P2: polish

16. Foray legend rows: one line each at 48px, chip · show (1 line) · `4 seg`
    in `data-sm` muted · `10 min` in `data`. Two-line legend rows at ~60px
    make the table taller than the timeline it explains.
17. Onboarding why-lines are hooks ("MIT's Dennis Whyte (Commonwealth
    Fusion…"). The direction says the first-run why comes from the pick's own
    reason. Use the seeded `why` field; if the data has none, write three
    first-run reasons into `data.json` that say what the pick is for, not what
    it contains.
18. Lead row eyebrow "Today's lead" and the show name are both `label` muted
    and stack as two identical grey lines. Eyebrow → `caption` with
    `letter-spacing .01em`; show stays `caption` but in `--ink` at 500 on the
    lead only, so the lead has one more ink line than a board row.
19. Section-head counts ("5", "11", "9") are `data-sm` muted and nearly
    invisible at 12px on dark. `data` 15px, still muted.
20. Back chevron on Foray detail sits alone at top-left with 68px of air to
    the eyebrow. Put the eyebrow "Foray · Startups" on the same 44px line,
    centred, as the sheet title would be; the display title then starts 12px
    below the line.
21. The mini player's 2px progress line is Signal on a `--line-strong` track;
    at 393 the track is invisible against the capsule, so the line looks like a
    stray mark when progress is low. Track at `--line-strong` over the full
    width is fine; add `border-radius: 1px` to both so the end is intentional.

## Motion, haptics, states I could not judge from stills

The shots are static. Round 2 should include, besides the state matrix above,
a short screen recording or a GIF of (a) mini → Now Playing, (b) row → Foray
detail strip-to-timeline, (c) the Today header collapse, each at 393. Playwright
can record video; the harness owner decides the format. Until then the three
signature transitions are unreviewed and the direction's motion section is a
spec, not a result.

## What I changed in the direction

- `DIRECTION.md` §2: show line in rows is caption, not label; why-line is ink
  on every row. §8: density target corrected to "five board rows after the
  lead at 393×852, three at 375×667"; rows are 112/128/64/56/48, not 72. §10:
  stretch row carries the show name as a caption under the bridge; durations
  over an hour are `3h 14m`. §11: Today's order is lead, Resume, Forays for
  you, Picked for you; board titles clamp to one line, the lead's to two.
- `BUILD-NOTES.md` 1.1: dark `--line` 16%, `--dock` tints 0.94/0.93, unplayed
  strip mix 62% with a contrast table to fill in. Component table: Row,
  Row--lead, Row--stretch, Row--queue, Button--text, Field (docked) updated.
  4.1 Today reordered. Open items: `?theme=` and `?state=` parameters added.

## Ready?

No. Items 1–6 change what a reviewer sees in the first three seconds; until
they are built and the light scheme and the states are rendered, a round-2
pass will materially improve it. I expect round 2 to be close.
