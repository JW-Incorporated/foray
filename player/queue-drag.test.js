/* The drag that reorders Up Next (PQ-03, #762).
 *
 * `player/queue-drag.js` is pure by design — the same split
 * `sheet-drag-dismiss.js` makes — so the DECISIONS are testable head-on here:
 * when a press on the handle becomes a drag, which slot the finger is over
 * against the layout read at press time, and (the one that protects the
 * list) that only a claimed drag released over a different slot ever commits.
 * DECISIONS 2026-09-23 L2: the move happens on `pointerup`, never on the
 * click that may follow.
 *
 * WHAT THIS SUITE CANNOT TELL YOU: whether 6 px feels right under a thumb,
 * whether a row tracks the finger without lag, whether the autoscroll step
 * is too eager on a real phone. Those are device facts for PQ-04's wiring and
 * the device check after it. Everything below is arithmetic.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md, "a
 * green test is not evidence until you have broken it"), and each was run.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  HANDLE_LOCK_PX, AUTOSCROLL_EDGE_PX,
  startRowDrag, moveRowDrag, endRowDrag, autoscrollDelta, claimsTouch, rowHeight,
} from "./queue-drag.js";

/** Four 56 px rows: midpoints at 28, 84, 140, 196 (the last from the average). */
const EVEN = [0, 56, 112, 168];

/** Press row `index` at `y0`, replay `[y, t]` samples, return the state. */
function drag(index, y0, samples, rowTops = EVEN) {
  let s = startRowDrag({ index, y: y0, t: 0, rowTops });
  for (const [y, t] of samples) s = moveRowDrag(s, y, t);
  return s;
}

/* ---------- the lock: when a press becomes a drag ---------- */

test("the handle lock opens at 6 px, not 5", () => {
  /* MUTATION: change `>=` to `>` in moveRowDrag. The 6 px sample stays
     unclaimed and this fails. Pinning the constant alongside, because the
     number will appear in PQ-04's prose and a silent retune would leave it
     lying. */
  assert.equal(HANDLE_LOCK_PX, 6);
  const five = drag(1, 70, [[75, 16]]);
  assert.equal(five.claimed, false);
  assert.equal(claimsTouch(five), false);
  const six = drag(1, 70, [[76, 16]]);
  assert.equal(six.claimed, true);
  assert.equal(claimsTouch(six), true);
  /* The lock is direction-blind, and it latches: back through the origin is
     still a drag. */
  const upSix = drag(1, 70, [[64, 16]]);
  assert.equal(upSix.claimed, true);
  const wandered = drag(1, 70, [[76, 16], [70, 32]]);
  assert.equal(wandered.claimed, true);
  assert.equal(wandered.offsetPx, 0);
  /* Fresh state is not claimed, carries a copy of the layout, and is over
     its own row. */
  const fresh = startRowDrag({ index: 2, y: 130, t: 0, rowTops: EVEN });
  assert.equal(fresh.claimed, false);
  assert.equal(fresh.over, 2);
  assert.equal(fresh.fromIndex, 2);
  assert.notEqual(fresh.rowTops, EVEN);
  assert.deepEqual(fresh.rowTops, EVEN);
});

/* ---------- which slot the finger is over ---------- */

test("over follows row midpoints on the way down", () => {
  /* MUTATION: compare against `rowTops[i]` instead of the midpoint in slotAt.
     y=90 would then read as slot 1 still, but y=60 (above row 1's midpoint
     of 84) would read as slot 1 too, and the first assertion fails. */
  assert.equal(drag(0, 20, [[60, 16]]).over, 0);
  assert.equal(drag(0, 20, [[90, 16]]).over, 1);
  assert.equal(drag(0, 20, [[141, 16]]).over, 2);
  assert.equal(drag(0, 20, [[197, 16]]).over, 3);
  /* Exactly AT a midpoint is not past it. */
  assert.equal(drag(0, 20, [[84, 16]]).over, 0);
});

test("an upward drag displaces a row only past its midpoint", () => {
  /* Row 3 (168–224) dragged up. At y=150 the finger is still in row 2's
     lower half (112–168, midpoint 140), so row 2 keeps its place; at y=139
     the finger has crossed it and the dragged row takes slot 2.
     MUTATION: drop the `+ 1` on the upward branch of slotAt. y=150 then
     reads as slot 2 (row 2 displaced early) and y=139 as slot 1, and both
     assertions fail. This is the correction to the plan's wording described
     in the module header; the test owns it. */
  assert.equal(drag(3, 190, [[150, 16]]).over, 3);
  assert.equal(drag(3, 190, [[139, 16]]).over, 2);
  assert.equal(drag(3, 190, [[83, 16]]).over, 1);
  assert.equal(drag(3, 190, [[20, 16]]).over, 0);
  /* And from the middle, both directions from one press agree with the
     corresponding one-way reads. */
  assert.equal(drag(1, 70, [[141, 16]]).over, 2);
  assert.equal(drag(1, 70, [[27, 16]]).over, 0);
  assert.equal(drag(1, 70, [[30, 16]]).over, 1);
});

test("over clamps at both ends of the list", () => {
  /* MUTATION: start `below` at 0 instead of -1 in slotAt. A finger above
     every midpoint then reads as "past row 0", the upward `+ 1` makes it
     slot 1, and the first assertion fails. MUTATION FOR THE FAR END: stop
     the loop at `i < n - 1`; the last midpoint is never passed and the
     second assertion reads 2. */
  assert.equal(drag(1, 70, [[-500, 16]]).over, 0);
  assert.equal(drag(1, 70, [[5000, 16]]).over, 3);
  assert.equal(drag(2, 130, [[-1, 16]]).over, 0);
  assert.equal(drag(2, 130, [[100000, 16]]).over, 3);
  /* The clamp itself guards the one input the arithmetic does not own: a
     stale `fromIndex` from a caller whose list repainted under the press.
     Row "7" of a four-row list dragged to the bottom must land on a slot
     that exists. MUTATION: drop the `Math.min(n - 1, …)` — this reads 4. */
  assert.equal(drag(7, 400, [[5000, 16]]).over, 3);
});

/* ---------- release: the only place a move happens ---------- */

test("a release commits only when the gesture was claimed and moved", () => {
  /* The press lands at y=80, 4 px under row 1's midpoint. A 5 px slip
     crosses that midpoint — `over` is 1 — but the lock has not opened, so
     letting go does nothing and the click that follows plays the row.
     MUTATION: make `commit` just `state.over !== state.fromIndex` in
     endRowDrag. The slip then reorders the list and this fails. */
  const slip = endRowDrag(drag(0, 80, [[85, 16]]));
  assert.deepEqual(slip, { commit: false, from: 0, to: 1 });
  /* One more pixel: claimed, and the same slot — now it commits. */
  const meant = endRowDrag(drag(0, 80, [[86, 16]]));
  assert.deepEqual(meant, { commit: true, from: 0, to: 1 });
  /* The lock alone is not enough either: claimed but still over its own slot
     (6 px from the midpoint of its own row). */
  const stayed = endRowDrag(drag(0, 20, [[26, 16]]));
  assert.deepEqual(stayed, { commit: false, from: 0, to: 0 });
  /* A press with no move at all is never a move. */
  assert.equal(endRowDrag(startRowDrag({ index: 2, y: 130, t: 0, rowTops: EVEN })).commit, false);
  assert.equal(endRowDrag(null).commit, false);
});

test("a claimed drag released at its own slot does not commit", () => {
  /* Row 1 is dragged to the bottom (claimed, over 3) and brought back up to
     where it started before release. `claimed` has latched; `over` is 1 again.
     MUTATION: make `commit` just `state.claimed` in endRowDrag. This fails —
     the list would be "moved" from 1 to 1 and PQ-04 would repaint for nothing. */
  const s = drag(1, 70, [[200, 16], [120, 32], [70, 48]]);
  assert.equal(s.claimed, true);
  assert.equal(s.over, 1);
  assert.deepEqual(endRowDrag(s), { commit: false, from: 1, to: 1 });
});

/* ---------- autoscroll ---------- */

test("autoscrollDelta nudges up at the top edge, down at the bottom, and not in between", () => {
  /* MUTATION: swap the two signs. Both edge assertions fail. */
  assert.equal(AUTOSCROLL_EDGE_PX, 48);
  assert.equal(autoscrollDelta(10, 800), -8);
  assert.equal(autoscrollDelta(790, 800), 8);
  assert.equal(autoscrollDelta(400, 800), 0);
  /* The edges are exclusive: exactly 48 from either end is the quiet zone. */
  assert.equal(autoscrollDelta(48, 800), 0);
  assert.equal(autoscrollDelta(752, 800), 0);
  assert.equal(autoscrollDelta(47, 800), -8);
  assert.equal(autoscrollDelta(753, 800), 8);
});

/* ---------- the layout is the rows', not a constant ---------- */

test("uneven heights use each row's own midpoint", () => {
  /* Rows of 40, 120, 40 and an unmeasured last row (average 66.67):
     midpoints 20, 100, 180, 233.3.
     MUTATION: replace `rowHeight(rowTops, i)` in midpoint with 56. Row 1's
     midpoint becomes 68, y=90 reads as slot 1, and the first assertion fails. */
  const UNEVEN = [0, 40, 160, 200];
  assert.equal(rowHeight(UNEVEN, 0), 40);
  assert.equal(rowHeight(UNEVEN, 1), 120);
  assert.equal(rowHeight(UNEVEN, 2), 40);
  assert.ok(Math.abs(rowHeight(UNEVEN, 3) - 200 / 3) < 1e-9);
  assert.equal(drag(0, 10, [[90, 16]], UNEVEN).over, 0);
  assert.equal(drag(0, 10, [[101, 16]], UNEVEN).over, 1);
  assert.equal(drag(0, 10, [[181, 16]], UNEVEN).over, 2);
  assert.equal(drag(0, 10, [[234, 16]], UNEVEN).over, 3);
  /* Upward through the same layout. */
  assert.equal(drag(3, 220, [[181, 16]], UNEVEN).over, 3);
  assert.equal(drag(3, 220, [[179, 16]], UNEVEN).over, 2);
  assert.equal(drag(3, 220, [[99, 16]], UNEVEN).over, 1);
});

test("a single-row list never commits", () => {
  /* One row, 56 px tall by the fallback, dragged far in both directions.
     MUTATION: change `n <= 1` to `n < 1` in rowHeight. The lone row's height
     becomes 0/0 — NaN — and the pinned fallback below fails; the slot
     assertions then pass only by accident of `y > NaN` being false, which is
     why the height is pinned rather than inferred. MUTATION FOR THE COMMIT:
     make `commit` just `state.claimed` in endRowDrag and both releases
     "move" the only row onto itself. */
  assert.equal(rowHeight([0], 0), 56);
  assert.equal(rowHeight([120], 0), 56);
  const up = drag(0, 20, [[-300, 16]], [0]);
  assert.equal(up.claimed, true);
  assert.equal(up.over, 0);
  assert.deepEqual(endRowDrag(up), { commit: false, from: 0, to: 0 });
  const down = drag(0, 20, [[900, 16]], [0]);
  assert.equal(down.claimed, true);
  assert.equal(down.over, 0);
  assert.equal(down.offsetPx, 880);
  assert.deepEqual(endRowDrag(down), { commit: false, from: 0, to: 0 });
});

/* ---------- the list scrolling under the finger ---------- */

/* Integration review (2026-10-04): autoscroll moves the list while the finger
   holds still, so the slot must follow the LIST, not the viewport. Eight
   56 px rows, row 0 pressed at y=28 with the page at scrollY 0; the finger
   parks on the bottom edge (y=200, between row 3 and row 4 on the screen)
   while the page scrolls.
   MUTATION: set `scrolled` to 0 in `moveRowDrag` and the slot stays at 3 and
   the offset at 172, so every assertion after the first fails. */
test("a list that scrolls under a held finger moves the slot and the row with it", () => {
  const tops = [0, 56, 112, 168, 224, 280, 336, 392];
  let s = startRowDrag({ index: 0, y: 28, t: 0, rowTops: tops, scrollY: 0 });
  s = moveRowDrag(s, 200, 16, 0);
  assert.equal(s.over, 3, "before any scroll: finger past row 3's midpoint (196)");
  assert.equal(s.offsetPx, 172);
  // The page autoscrolls 112 px; the finger has not moved on the screen.
  s = moveRowDrag(s, 200, 32, 112);
  assert.equal(s.over, 5, "list y 312 is past row 5's midpoint (308)");
  assert.equal(s.offsetPx, 284, "the row is translated by finger travel PLUS the scroll, so it stays under the finger");
  assert.deepEqual(endRowDrag(s), { commit: true, from: 0, to: 5 });
  // Scrolling back up with the finger still parked brings the slot back.
  s = moveRowDrag(s, 200, 48, 0);
  assert.equal(s.over, 3);
  // A caller that never passes scrollY gets the viewport rule unchanged.
  assert.equal(moveRowDrag(startRowDrag({ index: 0, y: 28, t: 0, rowTops: tops }), 200, 16).over, 3);
});
