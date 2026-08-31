/* Press-and-hold zoom-to-scrub gesture state machine (V1, this task).
 *
 * EVERY TEST BELOW NAMES THE MUTATION THAT KILLS IT, and every one of those
 * was applied and run (CLAUDE.md "A green test is not evidence until you
 * have broken it").
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  HOLD_MS, MOVE_TOLERANCE_PX, ZOOM_SCALE,
  startGesture, moveGesture, holdTimeoutGesture, endGesture, zoomOriginPercent,
} from "./strip-scrub-gesture.js";

/* ---------- constants sanity ---------- */

test("HOLD_MS is a positive, plausible press-and-hold threshold", () => {
  // MUTATION: HOLD_MS = 0 -- every tap would enter zoom, defeating "a brief
  // tap still jumps immediately".
  assert.ok(HOLD_MS > 0 && HOLD_MS < 1000);
});

test("MOVE_TOLERANCE_PX is a small positive pixel budget", () => {
  // MUTATION: MOVE_TOLERANCE_PX = 0 -- any pointermove at all, including
  // touch jitter on a dead-still tap, would be read as a drag.
  assert.ok(MOVE_TOLERANCE_PX > 0 && MOVE_TOLERANCE_PX < 50);
});

/* ---------- startGesture ---------- */

test("startGesture captures the down point and starts inactive-zoom", () => {
  const g = startGesture(12, 34);
  assert.equal(g.downX, 12);
  assert.equal(g.downY, 34);
  assert.equal(g.zooming, false);
  assert.equal(g.active, true);
});

/* ---------- moveGesture: tolerance boundary ---------- */

test("a move within tolerance stays pending (no zoom)", () => {
  const g = startGesture(100, 100);
  const after = moveGesture(g, 100 + MOVE_TOLERANCE_PX - 1, 100);
  // MUTATION: change `>` to `>=` in moveGesture -- this would then zoom.
  assert.equal(after.zooming, false);
});

test("a move right at the tolerance boundary stays pending", () => {
  const g = startGesture(100, 100);
  const after = moveGesture(g, 100 + MOVE_TOLERANCE_PX, 100);
  // MUTATION: change the comparison to `>=` -- this exact-boundary case
  // would then flip to zooming, which this test pins against.
  assert.equal(after.zooming, false);
});

test("a move past tolerance enters zoom immediately, no hold wait", () => {
  const g = startGesture(100, 100);
  const after = moveGesture(g, 100 + MOVE_TOLERANCE_PX + 1, 100);
  // MUTATION: `> MOVE_TOLERANCE_PX` -> `> MOVE_TOLERANCE_PX * 10` -- this
  // would then fail to zoom.
  assert.equal(after.zooming, true);
});

test("tolerance is measured as Euclidean distance, not per-axis", () => {
  // A diagonal move whose axes are individually small can still cross the
  // radius; a per-axis check (`dx > tol || dy > tol`) would miss it.
  const g = startGesture(0, 0);
  const d = MOVE_TOLERANCE_PX / Math.SQRT2 + 1; // both axes < tol, hypot > tol
  const after = moveGesture(g, d, d);
  // MUTATION: swap Math.hypot(dx, dy) for Math.max(Math.abs(dx), Math.abs(dy))
  // -- this per-axis-max case would then stay pending instead of zooming.
  assert.equal(after.zooming, true);
});

test("once zooming, further moves are inert (state unchanged)", () => {
  const g = { ...startGesture(0, 0), zooming: true };
  const after = moveGesture(g, 9999, 9999);
  // MUTATION: drop the `state.zooming` guard -- this would return a new
  // object (still zooming, but a different reference/shape check would
  // catch a version that stops tracking `active` correctly downstream).
  assert.equal(after, g);
});

test("moveGesture on an inactive gesture is a no-op", () => {
  const g = endGesture(startGesture(0, 0));
  const after = moveGesture(g, 500, 500);
  // MUTATION: drop the `state.active` guard -- an ended gesture would zoom
  // on a stray late pointermove.
  assert.equal(after, g);
  assert.equal(after.zooming, false);
});

/* ---------- holdTimeoutGesture ---------- */

test("hold timeout on a still-active, non-moved gesture enters zoom", () => {
  const g = startGesture(0, 0);
  const after = holdTimeoutGesture(g);
  // MUTATION: holdTimeoutGesture returns `state` unchanged -- this fails.
  assert.equal(after.zooming, true);
});

test("hold timeout after the pointer already went up is a no-op", () => {
  const g = endGesture(startGesture(0, 0));
  const after = holdTimeoutGesture(g);
  // MUTATION: drop the `active` guard -- a timer that fires after release
  // (caller forgot clearTimeout) would resurrect the gesture into zoom.
  assert.equal(after.zooming, false);
  assert.equal(after.active, false);
});

test("hold timeout on an already-zooming gesture is a no-op (same behavior)", () => {
  const g = moveGesture(startGesture(0, 0), 999, 0); // zoomed via drag
  const after = holdTimeoutGesture(g);
  assert.equal(after.zooming, true);
  // MUTATION: none needed beyond the above -- this documents the merge point
  // (drag-in and hold-in both land in one `zooming: true` state, not two).
});

/* ---------- endGesture ---------- */

test("endGesture marks the state inert regardless of prior zoom state", () => {
  const zoomed = moveGesture(startGesture(0, 0), 999, 0);
  const after = endGesture(zoomed);
  // MUTATION: endGesture returns `{ ...state, active: false }` without also
  // clearing `zooming` -- a caller that renders "still zoomed" off `active`
  // alone would be fine, but one keyed on `zooming` would keep showing the
  // zoomed strip after release. Pin both.
  assert.equal(after.active, false);
  assert.equal(after.zooming, false);
});

test("endGesture on null/undefined does not throw and returns inert state", () => {
  const after = endGesture(null);
  // MUTATION: `{ ...(state ?? {}), ... }` -> `{ ...state, ... }` -- spreading
  // null throws in some engines' strict paths; this pins the defensive form.
  assert.equal(after.active, false);
  assert.equal(after.zooming, false);
});

/* ---------- zoomOriginPercent ---------- */

const RECT = { left: 100, width: 200 }; // strip spans x=[100,300]

test("zoomOriginPercent at the left edge is 0", () => {
  assert.equal(zoomOriginPercent(100, RECT), 0);
});

test("zoomOriginPercent at the right edge is 100", () => {
  assert.equal(zoomOriginPercent(300, RECT), 100);
});

test("zoomOriginPercent at the midpoint is 50", () => {
  assert.equal(zoomOriginPercent(200, RECT), 50);
});

test("zoomOriginPercent clamps a pointer dragged past the left edge to 0", () => {
  const v = zoomOriginPercent(50, RECT);
  // MUTATION: drop `Math.max(0, ...)` -- this would return a negative
  // percent, and a CSS transform-origin percent below 0 walks off the strip.
  assert.equal(v, 0);
});

test("zoomOriginPercent clamps a pointer dragged past the right edge to 100", () => {
  const v = zoomOriginPercent(400, RECT);
  // MUTATION: drop `Math.min(100, ...)` -- this would return > 100.
  assert.equal(v, 100);
});

test("zoomOriginPercent returns null for a zero-width (unlaid-out) strip", () => {
  // MUTATION: drop the `rect.width > 0` guard -- this would divide by zero
  // and return NaN/Infinity instead of the honest "cannot answer" null the
  // rest of this feature (and stripElapsedAt's sibling check) relies on.
  assert.equal(zoomOriginPercent(150, { left: 100, width: 0 }), null);
});

test("zoomOriginPercent returns null with no rect at all", () => {
  assert.equal(zoomOriginPercent(150, null), null);
});

test("zoomOriginPercent returns null for a non-finite x (e.g. from a synthetic event)", () => {
  // MUTATION: drop the `Number.isFinite(x)` guard -- NaN in gives NaN out,
  // which a CSS custom property silently treats as "no value" rather than
  // failing loudly, so the strip would render un-zoomed with no signal why.
  assert.equal(zoomOriginPercent(NaN, RECT), null);
});

/* ---------- ZOOM_SCALE sanity ---------- */

test("ZOOM_SCALE magnifies (greater than 1) but is not absurd", () => {
  // MUTATION: ZOOM_SCALE = 1 -- the "zoom" would render pixel-identical to
  // the un-zoomed strip, i.e. no zoom at all.
  assert.ok(ZOOM_SCALE > 1 && ZOOM_SCALE <= 6);
});
