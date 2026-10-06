# Phase 2 checkpoint: pick the directions to build

Five art directions reached round 3. Each one is a clickable prototype of the
hero screens, built on real catalog data and real artwork. This page is the
owner's decision package: the ranking, one short card per direction, and a
recommendation. The owner picks; two directions are recommended (PLAN.md,
owner decision 8).

**How to look at them**

- `compare.html` (this folder) puts the same hero screen from every direction
  side by side, with today's app as a baseline. It also has a **Pass the
  phone** mode: it shows two directions' Home screens with the names hidden,
  the person holding the phone taps the one they would rather use, and the
  tally stays on that device. "Copy results" gives a text summary to paste
  into chat.
- Each prototype and the comparison page are also published as private
  claude.ai artifacts (only the owner can open them until he shares them):
  - Comparison page and pass the phone: https://claude.ai/artifact/56qxbdHQ9V5LYyR8r5qCyE
  - Tactile: https://claude.ai/artifact/6N8mk5PZJc32D8shdHw7GK
  - Ambient: https://claude.ai/artifact/SAQuPQZudiWo3y3eDViZiW
  - Editorial: https://claude.ai/artifact/KJ216C5n7Yu927WKEVY6WD
  - Native 2026: https://claude.ai/artifact/GnXudytwoQVx57t98wNwGc
  - Clarity: https://claude.ai/artifact/1YAp1DjBVKMzZEgKpkW6UY

  The published prototypes are the round-3 builds with three bundle-only
  changes, so they run inside an artifact: artwork served as local files,
  fonts inlined into the CSS, and `safeUrl()` widened to accept the
  bundle's own files. The source in `../directions/` is unchanged.
- Local copy: run `node docs/redesign-2026/checkpoint/build-checkpoint.mjs`
  once. It copies the renders and artwork into `data-local/redesign/checkpoint/`
  (gitignored: podcast artwork never goes into this public repo). Then open
  `compare.html` in a browser.

## Ranking

Three judges voted on every pair of designs against the written rubric
(`../judge/rubric.md`), with today's app included as a baseline. Each
direction met five opponents, so 15 votes is the maximum.

| Rank | Direction | Wins (of 15) | Beats today | Art director's last verdict |
|---|---|---|---|---|
| 1 | **Tactile** ("Dial") | 15 | 3/3 | Ready |
| 2 | **Ambient** ("Afterglow") | 12 | 3/3 | Not ready, by a small margin |
| 3 | **Editorial** ("Edition") | 8 | 3/3 | Not ready, one short round |
| 4 | **Native 2026** | 7 | 3/3 | Not ready, round 4 needed |
| 5 | **Clarity** ("The Board") | 3 | 3/3 | Not ready, round 4 needed |
| 6 | Today's app (baseline) | 0 | — | — |

**How far to trust it.** The judge is calibrated: round 1 of calibration
decided 14 of 14 reference pairs the expected way (`../judge/calibration.md`).
That round only proved the judges separate wide quality gaps, though, not
close ones. Here, 9 of the 10 pairs between directions were unanimous (3-0).
The one split was Editorial over Native 2026, 2-1, and those two are
effectively tied. The judges saw round-3 still frames only. They saw no
motion and pressed nothing.

What the judges kept saying:

- **Tactile** won on hierarchy: one bold card and one big play button per
  screen, large type, tap targets well over 44pt. Almost every Tactile vote said so.
- **Ambient** won on distinctiveness: a warm gradient, serif headlines and
  artwork-led cards. It lost points for small, low-contrast text on the warm
  gradients.
- **Editorial** had the strongest identity of all five. It lost on legibility
  (tiny small-caps captions) and on content showing through its flat tab bar.
- **Native 2026** was the best fit for 2026 phones. Seven of its eight losing
  votes called it generic, and its Foray header art collides with the status
  bar.
- **Clarity** was dense, with truncated rows and small mono text. It beat only
  today's app.

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
- Art director: **ready** after round 3. Three P1 and six P2 fixes are written
  into the build notes. Two risks remain for the Lab build: how pressing a key
  feels on a real phone, and `backdrop-filter` on older Android WebViews.

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
- Art director: **not ready, by a small margin.** Onboarding and Discover /
  Library are not yet lit by the artwork, and one collage hides its first
  show. Each fix is under 20 lines of CSS. Round 3 can be shown as it stands,
  with those gaps named.

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
- Art director: **not ready, one short round.** The still screens are
  checkpoint quality. The signature page-turn has never been captured (a
  harness guard turns it off), the push to detail double-exposes, and two
  hooks are clipped.

**Native 2026**
- Thesis: the chrome belongs to the phone and the content belongs to 4a.
  Controls are drawn the way iOS 27 or Material 3 Expressive would draw them.
  Everything 4a says is set in a serif voice.
- Signature moment: the seam. A foray's scrubber is a run of clips stitched
  along one continuous thread, with narration showing as the thread.
- Overturns: dark-only; the type and palette rulings (drops Fraunces);
  4 tabs + drawer (now Home, Search, Library); the A-Z list; interest sliders;
  no share sheet. Keeps no zoom, conditionally.
- Art director: **not ready.** Two P0s: 4a's own sentences are truncated
  wherever they sit in a row, and the bridge chip hangs below the cover
  instead of sitting on it. Four P1s; round 4 needed.

**Clarity ("The Board")**
- Thesis: a listening schedule you can read at arm's length, like a
  departures board for your day. One grid, one accent, numbers that line up.
- Signature moment: the board. Today is a ruled list where the why-line is
  the largest text in each row, under one stat: "6 picks · 2 outside your
  usual lane".
- Overturns: Fraunces + DM Sans (now Geist and Geist Mono); dark-only; the
  accent roles; the Create tab and the drawer; the A-Z list; no zoom; card
  anatomy; the Home order.
- Art director: **not ready.** Two P0s: every why-line truncates (a fault in
  the direction's own geometry), and the Now Playing dismiss leaves debris
  behind. Round 4 needed.

## Recommendation: build Tactile and Ambient

1. **They are the top two, by a margin.** Tactile won all 15 of its votes and
   Ambient won 12, losing only to Tactile. Both beat every other direction
   3-0. No ranking change is within reach of the one split vote.
2. **They are ready, or nearly.** Tactile is the only direction the art
   director passed. Ambient's remaining items are small builder fixes. The
   other three each carry P0s that change what every row says.
3. **They are two different bets.** Tactile is physical controls, a light
   scheme by default and its own grotesk. Ambient is artwork-lit, dark by
   default and carries a serif voice. Building both tests two answers, rather
   than two versions of one answer.
4. **They agree on the structure,** so Phase 3 shares more work. Both replace
   4 tabs + drawer with three tabs and no drawer, both fold Create into the
   search field, both ship two colour schemes, and both add native share.

What to watch in the build:

- **Tactile:** how a key press feels on Joey's Android phone, and
  `backdrop-filter` support on older Android WebViews.
- **Ambient:** contrast of small text on the warm gradients (the judges'
  repeated complaint), and the light Dawn scheme, which is the less proven of
  its two rooms.

If the owner wants a print-like serif voice in the pair, **Editorial** is the
third choice. It had the most distinctive identity in the judges' notes, and
its weak spot is legibility, which can be fixed.

**Rulings the owner decides with this pick.** Both recommended directions
overturn dark-only and 4 tabs + drawer. Tactile also restores pinch zoom and
replaces Fraunces + DM Sans, while Ambient keeps both. Product principles,
security, accessibility and the copy rules are hard limits and none of the
five directions challenges them (PLAN.md).
