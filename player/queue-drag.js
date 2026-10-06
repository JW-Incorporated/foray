/* Drag-to-reorder for the Up Next list: the gesture arithmetic (PQ-03, #762).
 *
 * The founder's Up Next model (2026-09-24) gives the list one gesture it did
 * not have: grab a row by its handle and put it somewhere else. This module is
 * the ARITHMETIC of that gesture and nothing more — exactly the split
 * `player/sheet-drag-dismiss.js` and `player/strip-scrub-gesture.js` already
 * make, and for the same reason. The caller (PQ-04, in app.js) owns the real
 * `pointerdown`/`pointermove`/`pointerup` listeners, the real `translateY`
 * write, the real `scrollTop` nudge and the one row-layout read it does at
 * press time; it feeds this module y-coordinates and timestamps and reads back
 * "which slot is the finger over", "how far has the row travelled" and, on
 * release, "did they mean it, and from where to where". No DOM is touched
 * here, so every rule below is testable head-on under plain node:test.
 *
 * COMMIT ON RELEASE, NEVER ON THE CLICK AFTER (DECISIONS 2026-09-23, lane L2:
 * "a gesture commits on `pointerup`, never on the click that may follow").
 * That is why `endRowDrag` returns a DECISION rather than a state: the caller
 * applies the move (via `player/queue-order.js` `moveTo`) inside its pointerup
 * handler and has nothing further to feed in. A row that was pressed and not
 * dragged past the lock yields `commit: false`, and the click that Safari may
 * synthesise afterwards is the caller's ordinary "play this row" — the two
 * never see the same event.
 *
 * THE LAYOUT IS READ ONCE. `rowTops` is the top edge of every row, in list
 * order, measured by the caller at `pointerdown` and frozen in the state. All
 * "which slot" arithmetic runs against that ORIGINAL layout, never against
 * whatever the rows look like mid-drag — rows shuffling under the finger as
 * the caller paints placeholders must not move the targets the finger is
 * aiming at, or the gesture chases itself.
 *
 * WHICH SLOT IS THE FINGER OVER. Each row's midpoint is `top + height/2`,
 * with `height(i) = rowTops[i+1] - rowTops[i]` and the last row's height taken
 * as the average of the others (56 px, the design row height, when there is
 * only one row). Counting the OTHER rows whose midpoint the finger is below
 * gives the index the dragged row would take: dragging DOWN, a row is
 * displaced once the finger passes its midpoint; dragging UP, likewise. That
 * is the plan's rule — "the largest i with y > midpoint(i)" — for downward
 * drags, where the dragged row's own midpoint is among those passed. For
 * upward drags the dragged row sits BELOW the finger, so the same count is one
 * higher than that largest-i; stated as the plan wrote it, an upward drag
 * would displace a row while the finger was still in that row's lower half
 * (row 3 dragged to y=150 with rows at 0/56/112/168 would already have taken
 * row 2's place). The `+ 1` on the upward branch in `moveRowDrag` is that
 * correction — see `an upward drag displaces a row only past its midpoint` in
 * the test file, which is the test that owns it.
 *
 * THE LIST SCROLLS UNDER A HELD FINGER (integration review, 2026-10-04).
 * `autoscrollDelta` exists so a row can be carried past the bottom of the
 * screen — and the moment the page scrolls, `rowTops` (read in viewport
 * coordinates at press) and the finger's `clientY` stop sharing an origin: a
 * finger parked on the bottom edge while the list scrolls 300 px reads as
 * "still over the same slot" forever, so the row could never be carried past
 * what was visible at press, which is the one case autoscroll is for. Both
 * `startRowDrag` and `moveRowDrag` therefore take the scroller's offset
 * (`scrollY`, default 0) and every slot is computed in LIST coordinates,
 * `y + (scrollY - startScrollY)`; `offsetPx` is in the same coordinates, so
 * the row's `translateY` keeps it under the finger while the list moves.
 */

/** How far, in CSS px, the finger must travel from the press before the row
    follows it and the gesture claims the touch. Below this it is a tap on
    the handle (or jitter), the row does not move and a click may follow.
    Smaller than `sheet-drag-dismiss.js`'s lock because a handle is an explicit
    affordance — the finger is already saying "drag" by landing on it — and
    a list row is shorter than a sheet, so the first 6 px matter more. */
export const HANDLE_LOCK_PX = 6;

/** How close to the top or bottom edge of the scroller, in CSS px, the finger
    must be before the list scrolls by itself (see `autoscrollDelta`). */
export const AUTOSCROLL_EDGE_PX = 48;

/** The design height of an Up Next row, used only for the height of the sole
    row in a one-row list, where there is no neighbour to measure against. */
const DEFAULT_ROW_HEIGHT_PX = 56;

/** How far the list scrolls per frame while the finger holds an edge. */
const AUTOSCROLL_STEP_PX = 8;

/**
 * Height of row `i`, in CSS px, from the frozen layout: the gap to the next
 * row's top; for the LAST row (which has no next top) the average of the
 * others, and `DEFAULT_ROW_HEIGHT_PX` when it is the only row.
 *
 * @param {number[]} rowTops   top edge of every row, list order, N >= 1
 * @param {number} i
 */
export function rowHeight(rowTops, i) {
  const n = rowTops.length;
  if (n <= 1) return DEFAULT_ROW_HEIGHT_PX;
  if (i < n - 1) return rowTops[i + 1] - rowTops[i];
  return (rowTops[n - 1] - rowTops[0]) / (n - 1);
}

/** Vertical midpoint of row `i` from the frozen layout. */
function midpoint(rowTops, i) {
  return rowTops[i] + rowHeight(rowTops, i) / 2;
}

/**
 * The slot the finger at `y` is over, against the ORIGINAL layout.
 *
 * `below` is the largest index whose midpoint the finger is past — the plan's
 * rule verbatim, and the answer for a downward drag. For an upward drag the
 * dragged row is not among the rows passed, so the slot is one further down
 * (see the header). A finger above every midpoint (`below === -1`) lands on
 * slot 0 by that same `+ 1`; a finger below every midpoint lands on `N-1`
 * because that is as far as the loop goes. The arithmetic therefore cannot
 * leave `[0, N-1]` by itself; the clamp guards the one input it does not own,
 * `fromIndex` — a caller that read a stale row index after the list repainted
 * under the press must still get a slot that exists.
 *
 * MUTATION TO BREAK THE DOWNWARD RULE: compare `y > rowTops[i]` instead of
 * against the midpoint and `over follows row midpoints on the way down` fails.
 * MUTATION TO BREAK THE UPWARD RULE: drop the `+ 1` and `an upward drag
 * displaces a row only past its midpoint` fails.
 * MUTATION TO BREAK THE ENDS: start `below` at 0 instead of -1, or stop the
 * loop at `n - 1`, and `over clamps at both ends of the list` fails; drop the
 * `Math.min` and its stale-index case fails.
 */
function slotAt(rowTops, fromIndex, y) {
  const n = rowTops.length;
  let below = -1;
  for (let i = 0; i < n; i++) {
    if (y > midpoint(rowTops, i)) below = i;
  }
  const over = below < fromIndex ? below + 1 : below;
  return Math.min(n - 1, Math.max(0, over));
}

/**
 * A fresh gesture: the handle of row `index` pressed at `y`, at time `t`
 * (ms), with the rows laid out at `rowTops`.
 *
 * @param {object} press
 * @param {number} press.index      the row whose handle was pressed
 * @param {number} press.y          pointer y in CSS px
 * @param {number} press.t          timestamp in ms
 * @param {number[]} press.rowTops  top edge of every row, list order, N >= 1
 * @param {number} [press.scrollY]  the scroller's offset at the press (e.g.
 *        `window.scrollY`); see "THE LIST SCROLLS UNDER A HELD FINGER"
 */
export function startRowDrag({ index, y, t, rowTops, scrollY = 0 }) {
  return {
    index,
    fromIndex: index,
    startY: y,
    startScrollY: Number.isFinite(scrollY) ? scrollY : 0,
    y,
    t,
    rowTops: [...rowTops],
    claimed: false,
    over: index,
    offsetPx: 0,
  };
}

/**
 * A `pointermove` at (y, t). Returns the new state, never mutating the old.
 *
 * `claimed` latches once the finger has travelled `HANDLE_LOCK_PX` in EITHER
 * direction and never un-latches — a drag that wanders back through its
 * origin is still a drag. `over` and `offsetPx` track every sample, claimed
 * or not, so the caller can decide for itself whether to paint under the
 * lock; `endRowDrag` is what refuses to commit an unclaimed gesture.
 *
 * `scrollY` is the scroller's offset now (default 0, i.e. it never moved):
 * the finger is placed in list coordinates by how far the list has scrolled
 * since the press, and so is `offsetPx`.
 *
 * MUTATION TO BREAK THIS: change `>=` to `>` on the lock comparison and
 * `the handle lock opens at 6 px, not 5` fails.
 * MUTATION TO BREAK THE SCROLL: set `scrolled` to 0 and `a list that scrolls
 * under a held finger moves the slot and the row with it` fails.
 */
export function moveRowDrag(state, y, t, scrollY = 0) {
  if (!state) return state;
  const scrolled = (Number.isFinite(scrollY) ? scrollY : 0) - (state.startScrollY || 0);
  const listY = y + scrolled;
  const offsetPx = listY - state.startY;
  const claimed = state.claimed || Math.abs(offsetPx) >= HANDLE_LOCK_PX;
  const over = slotAt(state.rowTops, state.fromIndex, listY);
  return { ...state, y, t, offsetPx, claimed, over };
}

/**
 * `pointerup`/`pointercancel`: the gesture is over. Returns the DECISION —
 * whether to move the row, and from which slot to which — not a state. This
 * is the L2 rule made concrete: the move happens here, on release, and the
 * click that may follow sees an ordinary row.
 *
 * MUTATION TO BREAK THIS: make `commit` just `state.over !== state.fromIndex`
 * and `a release commits only when the gesture was claimed and moved` fails,
 * because a 5 px slip across a midpoint would reorder the list.
 * MUTATION TO BREAK THE OTHER HALF: make `commit` just `state.claimed` and
 * `a claimed drag released at its own slot does not commit` fails.
 */
export function endRowDrag(state) {
  if (!state) return { commit: false, from: -1, to: -1 };
  return {
    commit: state.claimed && state.over !== state.fromIndex,
    from: state.fromIndex,
    to: state.over,
  };
}

/**
 * How far the caller should scroll the list this frame while a drag holds a
 * finger near an edge: `-8` px within `AUTOSCROLL_EDGE_PX` of the top, `+8`
 * within it of the bottom, else 0. Pure so the caller can run it from a
 * `requestAnimationFrame` loop it owns.
 *
 * MUTATION TO BREAK THIS: swap the signs and `autoscrollDelta nudges up at the
 * top edge, down at the bottom, and not in between` fails.
 */
export function autoscrollDelta(y, viewportHeight) {
  if (y < AUTOSCROLL_EDGE_PX) return -AUTOSCROLL_STEP_PX;
  if (y > viewportHeight - AUTOSCROLL_EDGE_PX) return AUTOSCROLL_STEP_PX;
  return 0;
}

/**
 * Does this gesture own the finger — should the caller cancel the browser's
 * own `touchmove` so the list under it cannot start a pan? Yes once the lock
 * has opened; before that the finger may still be a tap on the handle or the
 * start of a scroll, and the scroller keeps it. Same question, same name, as
 * `sheet-drag-dismiss.js`'s `claimsTouch`, so PQ-04 wires it the same way —
 * but each is its own gesture's "does this finger belong to me" predicate
 * over its own state (this one reads `claimed`, the sheet's reads
 * `allowed`/`engaged`/`dy`), not one shared rule.
 */
export function claimsTouch(state) {
  return !!(state && state.claimed);
}
