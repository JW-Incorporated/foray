/* The drag that closes the Now Playing sheet (founder report, 2026-09-13).
 *
 * Wyatt: "I should be able to drag that page down from the top to return to
 * what I was looking at previously."
 *
 * `player/sheet-drag-dismiss.js` is pure by design — the same split
 * `strip-scrub-gesture.js` makes — so the DECISION is testable head-on here:
 * how far is far enough, what counts as a flick, and (the one that actually
 * protects the feature) when the gesture must refuse to engage at all because
 * the listener is scrolling a long description rather than dismissing a sheet.
 *
 * WHAT THIS SUITE CANNOT TELL YOU, said plainly rather than dressed up in an
 * assertion that would pass either way: whether 120px FEELS right under a
 * thumb, whether the sheet tracks the finger without lag on a real phone, and
 * whether iOS hands us the pointermove stream at all once Safari decides a
 * gesture is a page swipe. Those are device facts. Everything below is
 * arithmetic, and arithmetic is what a unit test can own.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md, "a
 * green test is not evidence until you have broken it").
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DISMISS_DISTANCE_PX, DISMISS_VELOCITY_PX_PER_MS, FLICK_MIN_PX, DIRECTION_LOCK_PX,
  startDrag, moveDrag, endDrag, dragOffset, releaseVelocity, claimsTouch,
} from "./sheet-drag-dismiss.js";

/** Replay a whole gesture: a press at `y0`, then `[y, t]` samples, then release. */
function gesture(y0, t0, opts, samples) {
  let s = startDrag(y0, t0, opts);
  for (const [y, t] of samples) s = moveDrag(s, y, t);
  return { state: s, result: endDrag(s), offset: dragOffset(s) };
}

/* ---------- the thresholds are values, not opinions ---------- */

test("the published thresholds are the ones the sheet is documented to use", () => {
  /* MUTATION: change DISMISS_DISTANCE_PX to 200. This fails, and so does the
     boundary test below — the point of pinning it here as well is that the
     number appears in the PR description and in styles.css's prose, and a
     silent retune would leave both lying. */
  assert.equal(DISMISS_DISTANCE_PX, 120);
  assert.equal(DISMISS_VELOCITY_PX_PER_MS, 0.5);
  assert.equal(FLICK_MIN_PX, 40);
  assert.equal(DIRECTION_LOCK_PX, 8);
});

/* ---------- eligibility: the rule that protects the scroller ---------- */

test("a drag that starts mid-scroll never engages, however far it travels", () => {
  /* THE ONE THAT MATTERS. Reading a long episode description and flicking
     down to get back up the page must not throw the sheet away.
     MUTATION: drop the `state.allowed` guard from moveDrag(). This fails —
     a 300px pull from a scrolled body would dismiss. */
  const { result, offset } = gesture(300, 0, { atTop: false, fromHandle: false }, [
    [400, 100], [500, 200], [600, 300],
  ]);
  assert.equal(offset, 0, "the sheet must not move at all");
  assert.equal(result.dismiss, false);
});

test("the same drag from the grab handle engages even with the body scrolled", () => {
  /* The handle is never part of the scroller, so it is always a dismiss.
     MUTATION: drop `fromHandle` from startDrag's `allowed` expression. This
     fails — the handle would be inert on any scrolled sheet. */
  const { result } = gesture(300, 0, { atTop: false, fromHandle: true }, [
    [400, 100], [500, 200],
  ]);
  assert.equal(result.dismiss, true);
});

test("a drag that starts at the top of the scroller engages without the handle", () => {
  /* Apple's sheet comes down when you pull anywhere in a body already at its
     top; this is that. MUTATION: require `fromHandle` alone (drop `atTop`).
     This fails. */
  const { result } = gesture(200, 0, { atTop: true }, [[260, 100], [340, 200]]);
  assert.equal(result.dismiss, true);
});

test("eligibility is decided once, at pointerdown, and never re-read", () => {
  /* A rubber-band bounce that momentarily reports scrollTop 0 mid-gesture must
     not convert a scroll into a dismiss. The module cannot re-read scrollTop —
     it never sees it — which is the structural guarantee; this pins that the
     flag lives on the state object rather than being passed per move.
     MUTATION: add an `atTop` parameter to moveDrag() that can flip `allowed`.
     This fails to compile against the call below, which passes no such thing. */
  let s = startDrag(300, 0, { atTop: false });
  s = moveDrag(s, 900, 500);
  assert.equal(s.allowed, false);
  assert.equal(dragOffset(s), 0);
});

/* ---------- the direction lock ---------- */

test("a tap on the handle does not nudge the sheet", () => {
  /* A handle is not a button; a press-and-release with a few px of thumb roll
     must leave the sheet exactly where it was.
     MUTATION: change `dy > DIRECTION_LOCK_PX` to `dy > 0` in moveDrag. This
     fails on the MID-GESTURE assertion below — checked there and not only at
     the end, because a roll out and back finishes at dy 0 either way, so an
     end-state-only assertion would sit green through exactly that mutation
     (measured: it did, on the first draft of this file). */
  let s = startDrag(200, 0, { fromHandle: true });
  s = moveDrag(s, 204, 40);
  assert.equal(dragOffset(s), 0, "a 4px thumb roll must not translate the sheet");
  assert.equal(s.engaged, false);
  s = moveDrag(s, 200, 80);
  assert.equal(endDrag(s).dismiss, false);
});

test("past the direction lock the offset tracks the pointer exactly", () => {
  /* MUTATION: return a damped `dy * 0.5` from dragOffset(). This fails — the
     sheet would lag the thumb, which is the single most noticeable way a
     sheet feels wrong. */
  let s = startDrag(100, 0, { fromHandle: true });
  s = moveDrag(s, 160, 50);
  assert.equal(dragOffset(s), 60);
  s = moveDrag(s, 230, 100);
  assert.equal(dragOffset(s), 130);
});

test("upward movement is clamped at zero — the sheet never lifts off the top", () => {
  /* MUTATION: change `Math.max(0, y - state.startY)` to `y - state.startY`.
     This fails with a negative offset, which paints the sheet partly off the
     top of the screen. */
  let s = startDrag(300, 0, { fromHandle: true });
  s = moveDrag(s, 100, 50);
  assert.equal(s.dy, 0);
  assert.equal(dragOffset(s), 0);
});

/* ---------- the distance rule ---------- */

test("a release exactly at the dismiss distance closes the sheet", () => {
  /* The boundary, pinned in the inclusive direction.
     MUTATION: change `dy >= DISMISS_DISTANCE_PX` to `dy >`. This fails. */
  const { result } = gesture(100, 0, { fromHandle: true }, [
    [150, 400], [100 + DISMISS_DISTANCE_PX, 1000],
  ]);
  assert.equal(result.dy, DISMISS_DISTANCE_PX);
  assert.equal(result.dismiss, true);
});

test("a slow release one pixel short of the distance springs back", () => {
  /* MUTATION: change the comparison to `dy >= DISMISS_DISTANCE_PX - 1`. This
     fails. Deliberately SLOW (0.12 px/ms) so the flick rule below cannot be
     what carries it. */
  const { result } = gesture(100, 0, { fromHandle: true }, [
    [150, 400], [100 + DISMISS_DISTANCE_PX - 1, 1000],
  ]);
  assert.equal(result.dismiss, false);
});

/* ---------- the flick rule ---------- */

test("a fast flick closes the sheet well short of the full distance", () => {
  /* 10px in 10ms is 1.0 px/ms, twice the threshold, at dy = 50 — under half
     the distance rule. MUTATION: delete the velocity branch from endDrag().
     This fails, and a real thumb-flick would feel like a stuck sheet. */
  const { result } = gesture(100, 0, { atTop: true }, [[140, 10], [150, 20]]);
  assert.equal(result.dy, 50);
  assert.ok(releaseVelocity({ prevY: 140, prevT: 10, lastY: 150, lastT: 20 }) >= DISMISS_VELOCITY_PX_PER_MS);
  assert.equal(result.dismiss, true);
});

test("a fast twitch shorter than the flick floor does not close it", () => {
  /* Same speed, a third of the travel. MUTATION: delete the
     `dy >= FLICK_MIN_PX` half of the velocity branch. This fails — a 30px
     twitch while reaching for the scrub bar would dismiss the sheet. */
  const { result } = gesture(100, 0, { atTop: true }, [[120, 10], [130, 20]]);
  assert.equal(result.dy, 30);
  assert.equal(result.dismiss, false);
});

test("a long drag that has STOPPED moving is judged on distance, not on how it got there", () => {
  /* Covered ground early, then held still at 90px for a second. The flick
     rule must not fire on the average speed of the whole gesture.
     MUTATION: measure velocity from `startY`/`startT` instead of the last two
     samples. This fails — the early speed would carry it over the line. */
  const { result } = gesture(100, 0, { fromHandle: true }, [
    [180, 20], [190, 40], [190, 1200],
  ]);
  assert.equal(result.dy, 90);
  assert.equal(result.dismiss, false);
});

/* ---------- velocity's own edges ---------- */

test("releaseVelocity is zero for a zero time delta and for upward movement", () => {
  /* Two ways to produce a nonsense number: dividing by zero, and a negative
     speed compared against a positive threshold.
     MUTATION: drop the `dt > 0` guard and this returns Infinity (or NaN),
     which compares true against the threshold and dismisses on a stationary
     press whose samples share a timestamp. */
  assert.equal(releaseVelocity({ prevY: 10, prevT: 5, lastY: 400, lastT: 5 }), 0);
  assert.equal(releaseVelocity({ prevY: 400, prevT: 0, lastY: 10, lastT: 10 }), 0);
  assert.equal(releaseVelocity(null), 0);
});

/* ---------- nothing survives a finished gesture ---------- */

test("a gesture that never engaged reports no dismiss and no offset", () => {
  /* MUTATION: drop the `!state.engaged` guard from endDrag(). A press with no
     movement at all would then be judged on `dy` (0) — still false today, but
     the guard is what makes "a tap is not a dismiss" true by construction
     rather than by arithmetic accident. */
  const s = startDrag(200, 0, { fromHandle: true });
  assert.equal(endDrag(s).dismiss, false);
  assert.equal(dragOffset(s), 0);
  assert.equal(endDrag(null).dismiss, false);
  assert.equal(dragOffset(null), 0);
});

/* ---------- who owns the finger: the sheet or the scroller (touch-2) ---------- */

test("an eligible pull claims the touch from the first downward pixel, before the direction lock", () => {
  /* The browser decides "scroll or not" on the first touchmove past ITS slop,
     which on iOS is under DIRECTION_LOCK_PX — so waiting for `engaged` hands
     the pan to the scroller and the sheet springs back on pointercancel.
     MUTATION: `return !!(state && state.engaged)` -> the 3px sample below is
     not claimed; red. */
  let s = startDrag(200, 0, { atTop: true });
  assert.equal(claimsTouch(s), false, "a press that has not moved claims nothing (a tap on the body must scroll-lock nothing)");
  s = moveDrag(s, 203, 10);
  assert.equal(s.engaged, false, "precondition: still under the direction lock");
  assert.equal(claimsTouch(s), true);
  s = moveDrag(s, 260, 40);
  assert.equal(claimsTouch(s), true, "and keeps claiming it once engaged");
});

test("ROUND 2 review: 1 px of downward jitter on a swipe UP does not claim the touch (which would kill the scroll)", () => {
  /* Cancelling the first touchmove disables panning for the whole sequence,
     so claiming on 1 px swallowed an upward read-the-notes swipe. MUTATION:
     restore `state.dy > 0` -> the 201 sample is claimed; red. */
  let s = startDrag(200, 0, { atTop: true });
  s = moveDrag(s, 201, 8);
  assert.equal(claimsTouch(s), false, "1 px of jitter is not a pull");
  s = moveDrag(s, 150, 16);
  assert.equal(claimsTouch(s), false, "and the swipe up is the scroller's");
  let back = startDrag(200, 0, { atTop: true });
  back = moveDrag(back, 205, 8);
  back = moveDrag(back, 204, 16);
  assert.equal(claimsTouch(back), false, "a sample turning upward before the lock is not claimed");
});

test("a finger moving UP, or a drag that started mid-scroll, never claims the touch — the scroller scrolls", () => {
  /* MUTATION: drop the `state.allowed` guard -> the mid-scroll pull below is
     claimed and a flick back up a long description would cancel the scroll. */
  let up = startDrag(200, 0, { atTop: true });
  up = moveDrag(up, 150, 10);
  assert.equal(claimsTouch(up), false, "upward movement clamps to 0 and is the scroller's");
  let mid = startDrag(200, 0, { atTop: false });
  mid = moveDrag(mid, 300, 10);
  assert.equal(claimsTouch(mid), false, "not eligible: the body was scrolled");
  assert.equal(claimsTouch(null), false);
});
