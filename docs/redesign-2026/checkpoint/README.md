# Phase 2 checkpoint: pick the directions to build

Five art directions, each a clickable prototype of the hero screens built on
real catalog data and real artwork. This page is the owner's decision
package: the ranking, one short card per direction, and a recommendation. The
owner picks; two directions are recommended (PLAN.md, owner decision 8).

**Every direction is finished.** On 6 October 2026 all five went through the
same polish-to-ready process: critique and revise, round after round, until
the art director passed it, with a cap at round 6. All five passed before the
cap: Tactile at round 3, Ambient, Editorial and Clarity at round 4, Native
2026 at round 5. The first ranking stopped every direction at a fixed three
rounds, so only Tactile was ready and the comparison favoured polish. This
ranking compares five finished directions.

**How to look at them**

- `compare.html` (this folder) puts the same hero screen from every direction
  side by side, using each direction's final-round renders, with today's app
  as a baseline. It also has a **Pass the phone** mode: it shows two
  directions' Home screens with the names hidden, the person holding the
  phone taps the one they would rather use, and the tally stays on that
  device. "Copy results" gives a text summary to paste into chat.
- Each prototype and the comparison page are also published as private
  claude.ai artifacts (only the owner can open them until he shares them):
  - Comparison page and pass the phone: https://claude.ai/artifact/56qxbdHQ9V5LYyR8r5qCyE
  - Tactile: https://claude.ai/artifact/6N8mk5PZJc32D8shdHw7GK
  - Ambient: https://claude.ai/artifact/SAQuPQZudiWo3y3eDViZiW
  - Editorial: https://claude.ai/artifact/KJ216C5n7Yu927WKEVY6WD
  - Native 2026: https://claude.ai/artifact/GnXudytwoQVx57t98wNwGc
  - Clarity: https://claude.ai/artifact/1YAp1DjBVKMzZEgKpkW6UY

  The polish pass republishes each changed prototype at the same link. A
  published prototype is its final-round build with three bundle-only
  changes, so it runs inside an artifact: artwork served as local files,
  fonts inlined into the CSS, and `safeUrl()` widened to accept the bundle's
  own files. The source in `../directions/` is unchanged.
- Local copy: run `node docs/redesign-2026/checkpoint/build-checkpoint.mjs`
  once (add `--compare-only` to refresh just the renders and the comparison
  page). It copies each direction's final-round renders (the round list is
  `ROUNDS` in the script) and the artwork into `data-local/redesign/checkpoint/`
  (gitignored: podcast artwork never goes into this public repo). Then open
  `compare.html` in a browser.

## Ranking

Four judges voted on every pair of designs against the written rubric
(`../judge/rubric.md`), two with each design shown first, with today's app
included as a baseline. Each direction met five opponents, so 20 votes is the
maximum. The judges saw each direction's final-round still frames.

| Rank | Direction | Wins (of 20) | Beats today | Final round | Art director's verdict |
|---|---|---|---|---|---|
| 1 | **Tactile** ("Dial") | 20 | 4/4 | 3 | Ready |
| 2 | **Ambient** ("Afterglow") | 15 | 4/4 | 4 | Ready |
| 3 | **Editorial** ("Edition") | 11 | 4/4 | 4 | Ready |
| 4 | **Native 2026** | 10 | 4/4 | 5 | Ready |
| 5 | **Clarity** ("The Board") | 4 | 4/4 | 4 | Ready |
| 6 | Today's app (baseline) | 0 | — | — | — |

**Head to head.** Each cell is the row's votes against the column's, out of 4.
A 4-0 or 3-1 pair is a decision; 2-2 is a tie.

| | Tactile | Ambient | Editorial | Native 2026 | Clarity | Today |
|---|---|---|---|---|---|---|
| **Tactile** | — | 4-0 | 4-0 | 4-0 | 4-0 | 4-0 |
| **Ambient** | 0-4 | — | 3-1 | 4-0 | 4-0 | 4-0 |
| **Editorial** | 0-4 | 1-3 | — | **2-2** | 4-0 | 4-0 |
| **Native 2026** | 0-4 | 0-4 | **2-2** | — | 4-0 | 4-0 |
| **Clarity** | 0-4 | 0-4 | 0-4 | 0-4 | — | 4-0 |

**How far to trust it.** Thirteen of the 15 pairs were unanimous. Ambient over
Editorial was 3-1, still a decision. The only tie is Editorial against Native
2026, 2-2, so third and fourth place are not separated. The position-following
rate was 10%, under the protocol's 20% threshold, so the ranking stands rather
than being advisory. The judge was calibrated on wide quality gaps
(`../judge/calibration.md`), and the judges saw still frames only: no motion,
nothing pressed.

What the judges kept saying:

- **Tactile** won every vote, mostly on hierarchy: one bold headline and one
  big play button per screen, high contrast, tap targets well over 44pt, and a
  labelled segment bar that reads at a glance. Several votes also called its
  warm, raised look the most recognisable.
- **Ambient** won on identity: a warm palette and serif headlines held across
  all seven screens, with artwork-led cards and a floating glass dock. Its
  losses named polish: the "Foray" labels sit over the Library artwork, the
  search pill and mini player sit over cards, and the grey italic secondary
  text is small and low in contrast.
- **Editorial** still has the strongest typographic voice. Its translucent tab
  bar and search field let the content behind them show through and collide
  with them, and its metadata is small.
- **Native 2026** was the best fit for a 2026 phone (floating glass tab bar,
  full-bleed Now Playing). Most of its losing votes called it generic, and
  several noted the Foray header artwork running under the status bar and a
  crowded search mosaic.
- **Clarity** was dense: small mono text and rows of equal weight. It beat
  only today's app.

## The five directions

**Tactile ("Dial")**
- Thesis: 4a as a well-made little radio. Every foray is a band on the dial,
  every pick is a station, and every control is a key you can press.
- Signature moment: the band. A foray is a coloured, stitched timeline with
  two-letter station codes and a needle. In Now Playing the band is the
  scrubber, with a haptic detent at each segment boundary.
- Overturns: dark-only (Cream and Bakelite schemes); 4 tabs + drawer (now
  Today, Find, Yours); no zoom (pinch restored); Fraunces + DM Sans (now
  Bricolage Grotesque and Azeret Mono); card anatomy; the A-Z search list
  (now a subject mosaic); interest sliders (now a Dials screen); "Show my
  picks" (now "Play today's foray"); no share sheet.
- Art director: **ready at round 3** (unchanged in this pass). Three P1 and
  six P2 fixes are written into the build notes. Two risks remain for the Lab
  build: how pressing a key feels on a real phone, and `backdrop-filter` on
  older Android WebViews.

**Ambient ("Afterglow")**
- Thesis: the artwork is the light source. Every surface is lit by whatever
  is playing.
- Signature moment: the room changes colour mid-session. When a foray crosses
  from one show to the next, the whole player shifts to that show's colour.
  A Stretch pick is two artworks joined by a lit line.
- Overturns: dark-only (Dusk and Dawn); 4 tabs + drawer (now Today, Discover,
  Library in one floating Dock); "violet means 4a wrote it" (now ivory
  "Lamp"); interest sliders (now less / 4a's pick / more); no share sheet;
  "Suggested" (now "Off your path"). Keeps no zoom.
- Art director: **ready at round 4.** Round 4 fixed every round-3 item, and
  the artwork now lights all seven hero screens, onboarding and Discover /
  Library included. Two small CSS corrections (the Dock fade and a caption
  clamp) are in BUILD-NOTES §12. Critique: `../directions/ambient/critique-r4.md`.

**Editorial ("Edition")**
- Thesis: a daily listening edition, dated and typeset, with every reason
  marked in red pencil by an editor.
- Signature moment: the front page. A masthead and a dateline print the
  exploration floor every day ("3 picks · 1 stretch"). Why-lines are italic
  editor's notes, and a foray is a stitched rule with a table of contents.
- Overturns: dark-only (Paper and Night); 4 tabs + drawer (now Today, Browse,
  Library, plus a Colophon sheet); the amber/violet roles (now one red
  pencil); radii and elevations; adds Newsreader as the reading face. Keeps
  no zoom, as long as type follows the OS text size.
- Art director: **ready at round 4.** Every round-4 acceptance point passes,
  re-verified. The sheet spring was retuned so the sheet, the plate and the
  rule land together, and the motion was re-recorded and measured. Critique:
  `../directions/editorial/critique-r4.md`.

**Native 2026**
- Thesis: the chrome belongs to the phone and the content belongs to 4a.
  Controls are drawn the way iOS 27 or Material 3 Expressive would draw them.
  Everything 4a says is set in a serif voice.
- Signature moment: the seam. A foray's scrubber is a run of clips stitched
  along one continuous thread, with narration showing as the thread.
- Overturns: dark-only; the type and palette rulings (drops Fraunces);
  4 tabs + drawer (now Home, Search, Library); the A-Z list; interest sliders;
  no share sheet. Keeps no zoom, conditionally.
- Art director: **ready at round 5.** The bridge chip now sits on the cover.
  The last two leftovers (an Android Now Playing status-bar clip and the
  bridge-row play button's centring) were fixed in round 5. Critique:
  `../directions/native-2026/critique-r5.md`.

**Clarity ("The Board")**
- Thesis: a listening schedule you can read at arm's length, like a
  departures board for your day. One grid, one accent, numbers that line up.
- Signature moment: the board. Today is a ruled list where the why-line is
  the largest text in each row, under one stat: "6 picks · 2 outside your
  usual lane".
- Overturns: Fraunces + DM Sans (now Geist and Geist Mono); dark-only; the
  accent roles; the Create tab and the drawer; the A-Z list; no zoom; card
  anatomy; the Home order.
- Art director: **ready at round 4.** Why-lines now finish (a 90-character
  why budget), and the Now Playing dismiss passes all four frame checks. Three
  P2 copy items are deferred to Phase 3. Critique:
  `../directions/clarity/critique-r4.md`.

## Recommendation: build Tactile and Ambient (unchanged)

The recommendation is the same as before the polish pass. What changed is the
reason: readiness no longer separates the directions, because all five are
ready. The head-to-head votes alone now make the call.

1. **Tactile is a clear first.** It won all 20 of its votes and beat every
   direction 4-0, Ambient included.
2. **Ambient is a clear second.** It lost only to Tactile. It beat Native 2026
   and Clarity 4-0, and Editorial 3-1. All three are decisions, not ties.
3. **Polishing the others did not close the gap.** Editorial, Native 2026 and
   Clarity each gained a round or two of fixes and are now ready, and the top
   two did not change. Editorial and Native 2026 finished level with each
   other (2-2), a step behind Ambient.
4. **They are two different bets.** Tactile is physical controls, a light
   scheme by default and its own grotesk. Ambient is artwork-lit, dark by
   default and carries a serif voice. Building both tests two answers rather
   than two versions of one answer.
5. **They agree on the structure,** so Phase 3 shares more work. Both replace
   4 tabs + drawer with three tabs and no drawer, both fold Create into the
   search field, both ship two colour schemes, and both add native share.

What to watch in the build:

- **Tactile:** how a key press feels on Joey's Android phone, and
  `backdrop-filter` support on older Android WebViews.
- **Ambient:** the judges' repeated polish notes (the "Foray" labels over the
  Library artwork, cards running under the search pill and mini player, small
  low-contrast secondary text), and the light Dawn scheme, which is the less
  proven of its two rooms.

If the owner wants a third direction, or a swap for one of the two, Editorial
and Native 2026 are tied for it. **Editorial** has the most distinctive
typographic identity; its weak spots are chrome that lets content show through
and small metadata. **Native 2026** is the best fit for a 2026 phone; its weak
spot is that it looks generic.

**Rulings the owner decides with this pick.** Both recommended directions
overturn dark-only and 4 tabs + drawer. Tactile also restores pinch zoom and
replaces Fraunces + DM Sans, while Ambient keeps both. Product principles,
security, accessibility and the copy rules are hard limits and none of the
five directions challenges them (PLAN.md).
