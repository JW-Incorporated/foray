/* Swipe-left-to-remove on an Up Next row (#762, PQ-05).
 *
 * `player/queue-swipe.js` is pure by design — the same split
 * `sheet-drag-dismiss.js` makes — so the DECISION is testable head-on here:
 * which axis wins the finger, how far left is far enough, what counts as a
 * flick, and (the one that protects the list) that a scroll can never turn
 * into a removal however it ends.
 *
 * WHAT THIS SUITE CANNOT TELL YOU: whether 96 px FEELS right under a thumb,
 * whether the row tracks the finger without lag, and whether the browser hands
 * us the pointer stream once it decides the list is panning. Those are device
 * facts. Everything below is arithmetic.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md, "a
 * green test is not evidence until you have broken it"); each was run once.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SWIPE_LOCK_PX, REMOVE_DISTANCE_PX, REMOVE_VELOCITY_PX_PER_MS, FLICK_MIN_PX, RUBBER_BAND_PX,
  startSwipe, moveSwipe, endSwipe, swipeOffset, releaseVelocity,
} from "./queue-swipe.js";

/** Replay a whole gesture: a press at (x0, y0), then `[x, y, t]` samples, then release. */
function gesture(x0, y0, t0, samples) {
  let s = startSwipe(x0, y0, t0);
  for (const [x, y, t] of samples) s = moveSwipe(s, x, y, t);
  return { state: s, result: endSwipe(s), offset: swipeOffset(s) };
}

/* ---------- the direction lock ---------- */

test("a gesture that moves vertically first is rejected for good", () => {
  /* The listener is scrolling the list: 20 px down (with 3 px of leftward
     drift) wins the lock for the scroller.
     MUTATION: drop the vertical branch from moveSwipe() — `rejected` then
     reads false. (What "for good" means is the last test in this file.) */
  assert.equal(SWIPE_LOCK_PX, 8);
  const { state, result, offset } = gesture(200, 100, 0, [[197, 120, 16]]);
  assert.equal(state.rejected, true);
  assert.equal(state.claimed, false);
  assert.equal(offset, 0);
  assert.deepEqual(result, { remove: false, offsetPx: 0 });
  /* Both axes past the lock in one sample: the larger travel wins, a tie goes
     to the scroller. */
  assert.equal(gesture(200, 100, 0, [[180, 112, 16]]).state.claimed, true);
  assert.equal(gesture(200, 100, 0, [[188, 112, 16]]).state.rejected, true);
});

test("a gesture that moves horizontally first claims the row", () => {
  /* 20 px left with 1 px of drift wins the lock for the swipe; the row follows.
     MUTATION: swap `ay >= ax` for `ay <= ax` in the vertical branch — the
     1 px of drift then rejects a plainly horizontal pull. */
  const { state, offset } = gesture(200, 100, 0, [[180, 101, 16]]);
  assert.equal(state.claimed, true);
  assert.equal(state.rejected, false);
  assert.equal(offset, 20);
  /* Under the lock nothing moves: a tap is a tap. */
  const tap = gesture(200, 100, 0, [[196, 100, 16]]);
  assert.equal(tap.state.claimed, false);
  assert.equal(tap.offset, 0);
});

test("a rightward drag never claims and never removes", () => {
  /* A fast 100 px pull to the RIGHT. Travel is `startX - x` clamped at 0, so
     it neither claims the gesture nor counts toward the distance.
     MUTATION: measure `dx` as `Math.abs(x - state.startX)` and `offsetPx`
     reads 100 (and the claim fires). */
  const { state, result, offset } = gesture(200, 100, 0, [[250, 100, 16], [300, 100, 32]]);
  assert.equal(state.claimed, false);
  assert.equal(offset, 0);
  assert.deepEqual(result, { remove: false, offsetPx: 0 });
  /* And once claimed leftward, coming back past the start paints 0 — the row
     is never pushed to the right of its resting place. */
  const back = gesture(200, 100, 0, [[180, 100, 16], [230, 100, 32]]);
  assert.equal(back.state.claimed, true);
  assert.equal(back.offset, 0);
  assert.equal(back.result.remove, false);
});

/* ---------- commit on release ---------- */

test("the distance threshold is exact at 96 px", () => {
  /* A slow drag (no flick) released exactly at REMOVE_DISTANCE_PX removes;
     one pixel short springs back.
     MUTATION: change `>=` to `>` on the distance comparison in endSwipe() —
     the 96 px release then reads `remove: false`. */
  assert.equal(REMOVE_DISTANCE_PX, 96);
  const slow = (d) => [[200 - 20, 100, 100], [200 - 60, 100, 500], [200 - d, 100, 2000]];
  const at = gesture(200, 100, 0, slow(96));
  assert.ok(releaseVelocity(at.state) < REMOVE_VELOCITY_PX_PER_MS, "this is a drag, not a flick");
  assert.deepEqual(at.result, { remove: true, offsetPx: 96 });
  const short = gesture(200, 100, 0, slow(95));
  assert.deepEqual(short.result, { remove: false, offsetPx: 95 });
});

test("a flick short of the distance removes once it has moved FLICK_MIN_PX", () => {
  /* 40 px left, the last 25 px in 25 ms (1 px/ms): a throw-it-away.
     MUTATION: drop the velocity clause from endSwipe() — the 40 px release
     then reads `remove: false`. */
  assert.equal(REMOVE_VELOCITY_PX_PER_MS, 0.6);
  assert.equal(FLICK_MIN_PX, 32);
  const flick = gesture(200, 100, 0, [[185, 100, 20], [160, 100, 45]]);
  assert.equal(releaseVelocity(flick.state), 1);
  assert.deepEqual(flick.result, { remove: true, offsetPx: 40 });
  /* The floor under it: the same speed over 20 px is a twitch, not a flick. */
  const twitch = gesture(200, 100, 0, [[190, 100, 10], [180, 100, 20]]);
  assert.equal(releaseVelocity(twitch.state), 1);
  assert.deepEqual(twitch.result, { remove: false, offsetPx: 20 });
});

test("a slow, short release springs back", () => {
  /* 60 px left in 100 ms — 0.6 px/ms over the WHOLE gesture — but the quick
     part was the first 50 px and the finger had all but stopped (0.125 px/ms
     over the last two samples) when it let go. Velocity is read at the
     release, so neither the distance nor the flick rule is met.
     MUTATION: in moveSwipe() keep `prevX: state.prevX, prevT: state.prevT`
     (the previous sample never advances, so speed is measured from the
     pointerdown) — this release then reads 0.6 px/ms and `remove: true`. */
  const { state, result } = gesture(200, 100, 0, [
    [150, 100, 20],   /* a quick 50 px to begin with */
    [145, 100, 60],
    [140, 100, 100],
  ]);
  assert.equal(releaseVelocity(state), 0.125);
  assert.deepEqual(result, { remove: false, offsetPx: 60 });
});

/* ---------- the paint ---------- */

test("the painted offset is rubber-banded past 160 px", () => {
  /* Under RUBBER_BAND_PX the row follows the finger; past it, at a third of
     the finger's travel: 220 px of pull paints 160 + 60/3 = 180. The DECISION
     still reads the raw 220.
     MUTATION: return `state.dx` unconditionally from swipeOffset() — the
     220 px pull then paints 220. */
  assert.equal(RUBBER_BAND_PX, 160);
  assert.equal(gesture(300, 100, 0, [[200, 100, 100]]).offset, 100);
  assert.equal(gesture(300, 100, 0, [[140, 100, 100]]).offset, 160);
  const far = gesture(300, 100, 0, [[80, 100, 100]]);
  assert.equal(far.offset, 180);
  assert.deepEqual(far.result, { remove: true, offsetPx: 220 });
});

/* ---------- the rule that protects the list ---------- */

test("a rejected gesture reports remove:false whatever follows", () => {
  /* Vertical first, then a 300 px leftward flick that would pass every rule
     on its own. The rejection is final: no claim, no offset, no removal.
     MUTATION: make the rejection reversible — in moveSwipe() change
     `if (state.rejected) return state;` to
     `if (state.rejected) return moveSwipe({ ...state, rejected: false }, x, y, t);`
     — the flick then claims the gesture and `remove` reads true. */
  const { state, result, offset } = gesture(400, 100, 0, [
    [400, 130, 16],
    [250, 130, 100],
    [100, 130, 150],
  ]);
  assert.equal(state.rejected, true);
  assert.equal(state.claimed, false);
  assert.equal(offset, 0);
  assert.deepEqual(result, { remove: false, offsetPx: 0 });
  /* And the rejection survives a later swipeOffset/endSwipe pair on the same
     state — nothing resets it short of a new pointerdown. */
  assert.equal(swipeOffset(moveSwipe(state, 0, 130, 200)), 0);
  assert.equal(endSwipe(moveSwipe(state, 0, 130, 200)).remove, false);
});
