# Clarity, round 4 critique

Art director's review of the round-4 prototype
(`docs/redesign-2026/directions/clarity/prototype/`) against `DIRECTION.md`
and `BUILD-NOTES.md`. Reviewed: the 21 default shots in
`data-local/redesign/shots/clarity/r4/` (contact sheets first, then the full
frames at 393×852, 375×667 and 412×915), the 21 light shots in `r4-light/`,
the 27 state shots in `r4-states/` and `r4-states-light/`, the builder's
scrub frames in `r4-tools/scrub/`, and the recording
`r4-motion/clarity-transitions-393x852.webm`, which I re-cut myself at 25 fps
around the close (t ≈ 3.5–4.1 s), the drag release (6.6–7.6 s), the row to
Foray detail (9.3–10.1 s) and the header collapse (11.4–13 s); tiles and
single frames in `r4-tools/ad-frames/`.

Verdict: **ready.** Both round-3 P0s are fixed as specified and nothing in
this round would be materially improved by a round 5. What remains is three
copy-and-label items that belong to the Phase 3 port, recorded below and in
`BUILD-NOTES.md` §9 so they are not lost.

## The two P0s, judged

### 1. The why-line finishes

Home 393: the lead's why ("Venture money is one option of eight; see which
fits a small company.") ends with a full stop on its third line and the strip
sits under it at 269px, every bar legible. Every board row's why runs under
the data column to the right gutter and finishes; the stretch row's bridge
stays the loudest line and its sentence ends. Onboarding at 393 shows three
rows under "says why" that each say why; at 375 two rows, 22px headline, no
scroll. Now Playing at 375 shows a two-line why, never one. Density matches
the round-3 prediction exactly: 393×852 lead + 2 full rows + the third's
title with the mini showing (lead + 3 without), 412×915 lead + 3, 375×667
lead + 1 + the second's title.

The builder's finding deserves the direction's attention more than the fix
does: three lines hold **about 90 characters**, not 102, because words wrap
whole. Ten of the forty hooks still needed a fourth line, three of them on
the first screen, and the builder trimmed those three in the data (the
untrimmed text kept beside them). That is the right prototype fix and the
wrong product fix: the layout is now correct and the copy rule is short by
one number. `DIRECTION.md` §2 and the `Row` entry now say ≤ 18 words **and
about 90 characters**, with the clamp as the fallback; Phase 3 adds the
character ceiling to `copyRules.test.ts`, which gates words only.

### 2. The dismiss is the open played backwards

Judged frame by frame on the four things round 3 named:

- **No grey square.** None, in either direction. While the flyers are in
  the air the slot is transparent; the only things moving are the two
  flyers and the plain sheet surface.
- **Nothing painted over the dock.** The close button is visible for the
  first ~100 ms (at y ≈ 340 and y ≈ 560, both above the dock's top edge at
  720) and gone before the sheet's edge reaches the dock. The show line and
  why fade in the same window. The two-line title flyer does pass over the
  page's last row at full opacity for two frames, which the open does in
  mirror; that is a shared element travelling, not debris.
- **The page behind dimmed until the sheet is gone.** The scrim fades
  linearly over the full 320 ms: at ~80 ms the board is clearly dimmer than
  at ~220 ms, and at full brightness only once the dock is clear.
- **The flyers land in the mini in the frame the dock is clear.** The art
  is in the mini slot and the title crossfaded with the mini's own title in
  the first frame that shows the tab labels. No two-line block over the
  mini's show line.

The drag release continues from where the finger left the sheet, with the
scrim already partly lifted, and runs the same path. The `hashchange`
double-render the builder found and silenced on the way is the kind of bug
that would have shown up as a scroll jump on a phone; good catch.

## What is right, keep it

- Row to Foray detail: the 4px strip is still the element that becomes the
  24px timeline; mid-travel in the second frame, home in the fourth. The
  ~80 ms text-over-text crossfade (r3 item 9) remains and remains optional.
- Today header collapse: large date out, small date in, hairline arriving;
  a real intermediate frame. Tab switch instant with the stroke step.
- Library: grid names at caption over two lines ("Lex Fridman Podcast"
  wraps); Up Next's Now row reads "35 min / left", the unstarted row its
  duration; the count is 8 on the head and on the Now Playing control row.
- The mini progress line reads as the capsule's top edge filling with
  Signal, nothing else. The dock is one capsule.
- np-end: Conan's artwork stays at 56:57 / −0:03 under "Up next · in 0:03";
  the picture no longer lies. np-buffering: the word on the clock's
  baseline. find-empty: "Nothing for 'fusion'." then the subject row that
  answers it. foray-unavailable: faint strip, the sentence, live legend.
  foray-unnarrated: no hatching, "No narration yet", and the runtime drops
  to 51 min, which is the honest number. firstrun: "Picked to start", no
  stat, the foray strip inside the first viewport. offline: the one
  unplayable row quietest on the screen, "saved" badges on the rest.
- Light scheme holds on every screen, including the retuned strip and the
  Signal play circle with black glyph.
- Mid-listen: one position per item; "44 min left" on the lead, the mini,
  the Library Now row and "Resume at 9:40" all agree.

## Rulings on the builder's round-4 deviations

1. **Mid-play lead column at 18/14 line heights, row 184: accepted** and
   written into `Row--lead`. The column must never be taller than the stack
   above the why; this is how it stays 76px.
2. **Offline "saved" badge on the eyebrow line: accepted**, same entry,
   same reason.
3. **Art spans two grid rows, not three: accepted**, written into `Row`.
4. **Loading shows three board rows: that is the spec** (4.1); no change.
5. **Foray subject centred in the detail header line** (BUILD-NOTES 4.6
   had it as an eyebrow under the header): **accepted**. It is the page's
   running head, the one centred caption in the app, and it saves 24px on
   the small viewport. 4.6 and DIRECTION §11 updated.
6. **Foray Now Playing at 375×667: the control row's glyphs peek at the
   fold.** The 24px strip with ticks and labels costs ~46px over the 6px
   track, so the transport centre lands at ~573 and the control row below
   it. That is the glance posture the spec describes; the transport is in
   the thumb zone. Recorded in 4.2's budget note, no change.

## P2: carried to Phase 3, not a round 5

1. **Find's "Name a subject" row promises a foray.** Its second line reads
   "Build a foray on anything" (`clarity.js` line 286); custom forays are
   out of UI scope (D8) and the no-results block offers a playlist. The
   board never promises what it cannot build. Change to "Build a playlist
   on anything". BUILD-NOTES 4.4 updated.
2. **Legend rows abbreviate: "4 seg".** The board labels everything; "seg"
   is not a word. Set "4 segments" in `data-sm`; the show name's one-line
   clamp absorbs the ~36px ("Y Combinator Startup Podc…" becomes
   "Y Combinator Startup…"). `clarity.js` line 384. BUILD-NOTES 4.6 updated.
3. **The ~90-character why-line ceiling** goes into the writer's brief and
   `copyRules.test.ts` when the direction is ported (item 1 above).
4. Carried unchanged: r3 item 9 (optional page crossfade), r3 item 10
   (subject-name casing is a taxonomy pass).

## What I changed in the direction

- `DIRECTION.md` §2: the ~90-character why-line budget and where it goes.
  §11 Find: the row's second line promises a playlist. §11 Foray detail:
  legend count as a word; the centred running head accepted.
- `BUILD-NOTES.md` `Row`: characters per line corrected, the two-row art
  span. `Row--lead`: the mid-play column's line heights and the offline
  badge placement. 4.2: the foray budget at 375×667. 4.4: the row's second
  line. 4.6: header running head, legend row anatomy and wording. §9: item
  9, round 4 closed.

## Ready?

Yes. The one transition a reviewer touches first now reads the same both
ways, every row says its reason to the end, and the states are designed
rather than left over. The three P2 items are copy on the port, an
afternoon inside Phase 3, and would not change what the owner sees at the
pick.
