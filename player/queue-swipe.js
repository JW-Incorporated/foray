/* Swipe-left-to-remove for an Up Next row (#762, PQ-05).
 *
 * The Up Next list gets the tools a listener expects of a queue — drag to
 * reorder, Play next, Clear, and this one: swipe a row to the left and it
 * leaves the queue. This module is the ARITHMETIC of that swipe and nothing
 * else; PQ-06 wires it to the rows in app.js.
 *
 * WHY THIS IS PURE
 * The same split `player/sheet-drag-dismiss.js` and `player/strip-scrub-gesture.js`
 * make, for the same reason: the caller owns the real `pointerdown`/
 * `pointermove`/`pointerup` listeners, the real `translateX` write and the
 * real `removeFromQueue` call; it feeds this module x/y coordinates and
 * timestamps and reads back "how far left is the row" and "let go of it now —
 * does it go?". The decision is then testable head-on with no DOM, no fake
 * timers and no device. What a device still has to confirm is the FEEL.
 *
 * THE RULES, in the order a finger meets them:
 *
 *  1. DIRECTION LOCK. The first axis to travel past `SWIPE_LOCK_PX` wins. A
 *     vertical win REJECTS the gesture for good — the listener is scrolling the
 *     list, and nothing the finger does afterwards (a long fast leftward pull
 *     included) can turn that scroll into a removal. A horizontal win CLAIMS it.
 *     Before either, nothing moves: a tap on a row is a tap.
 *
 *  2. ONLY LEFTWARD COUNTS. Travel is measured as `startX - x`, clamped at 0.
 *     A finger moving right never claims the gesture and never removes; once
 *     claimed, a finger that comes back past where it started paints 0.
 *
 *  3. COMMIT ON RELEASE (DECISIONS 2026-09-23, lane L2: a gesture commits on
 *     `pointerup`, never on the click that may follow). `endSwipe` returns the
 *     DECISION: the row is removed when it was dragged at least
 *     `REMOVE_DISTANCE_PX`, or flicked — still moving at
 *     `REMOVE_VELOCITY_PX_PER_MS` or faster over the last two samples AND past
 *     `SWIPE_FLICK_MIN_PX`, so a fast twitch during a tap can never count.
 *
 *  4. RUBBER-BAND. Past `RUBBER_BAND_PX` the painted offset grows at a third
 *     of the finger's speed, so a row cannot be flung off the screen and the
 *     listener feels the end of its travel.
 *
 * The release speed is `player/gesture-math.js`'s `releaseVelocity`, shared
 * with the sheet's drag-to-dismiss. The thresholds below are this gesture's
 * own: they are tuned for a list row and do not follow the sheet's.
 */

import { releaseVelocity } from "./gesture-math.js";

/** How far the finger must travel on one axis, in CSS px, before that axis
    wins the gesture. Under this it is a tap or a jitter and the row does not
    move. Tuned for this gesture, independently of `sheet-drag-dismiss.js`'s
    `DIRECTION_LOCK_PX` and `queue-drag.js`'s `HANDLE_LOCK_PX`. */
export const SWIPE_LOCK_PX = 8;

/** How far left the row must be dragged, in CSS px, before letting go removes
    it. Below this it springs back. About a quarter of a phone's width — far
    enough that a graze while scrolling the list cannot remove a row, short
    enough that the gesture never feels like work. */
export const REMOVE_DISTANCE_PX = 96;

/** A FLICK removes it too, short of the distance above: releasing while still
    moving left at this speed (CSS px per ms — 0.6 is 600 px/s) is an
    unambiguous throw-it-away. Paired with `SWIPE_FLICK_MIN_PX` below. */
export const REMOVE_VELOCITY_PX_PER_MS = 0.6;

/** The floor under the flick rule. A flick must still have MOVED this far.
    Named for the swipe because the sheet has its own (`SHEET_FLICK_MIN_PX`),
    with a different value. */
export const SWIPE_FLICK_MIN_PX = 32;

/** Past this leftward travel the painted offset is rubber-banded (see
    `swipeOffset`). The DECISION still reads the raw distance. */
export const RUBBER_BAND_PX = 160;

/**
 * A fresh gesture, from a `pointerdown` at (x, y), at time `t` (ms).
 *
 * `dx` is the LEFTWARD travel in CSS px, never negative. `claimed` and
 * `rejected` are the two outcomes of the direction lock; at most one of them
 * ever becomes true, and neither ever becomes false again.
 *
 * @param {number} x  pointer x in CSS px
 * @param {number} y  pointer y in CSS px
 * @param {number} t  timestamp in ms (event.timeStamp / performance.now())
 */
export function startSwipe(x, y, t) {
  return {
    active: true,
    claimed: false,
    rejected: false,
    startX: x,
    startY: y,
    dx: 0,
    lastX: x,
    lastT: t,
    prevX: x,
    prevT: t,
  };
}

/**
 * A `pointermove` at (x, y, t). Returns the next state; a rejected gesture is
 * returned unchanged, whatever the sample.
 *
 * THE LOCK IS DECIDED ONCE. While neither axis has won, the sample is only
 * compared against the lock; the moment one axis is past it the gesture is
 * claimed or rejected and the comparison is never made again — so a claimed
 * swipe that drifts up or down a little keeps the row, and a rejected scroll
 * that drifts left stays a scroll. When ONE sample carries both axes past the
 * lock the larger travel wins and a tie goes to the scroller, because
 * refusing a removal costs a second swipe while a wrong removal costs a row;
 * and when the larger travel is RIGHTWARD it cannot win (only leftward
 * counts), so the vertical axis past the lock takes it for the scroller.
 *
 * MUTATION TO BREAK THE LOCK: drop the vertical branch and
 * `a gesture that moves vertically first is rejected for good` fails.
 *
 * MUTATION TO BREAK THE CLAMP: change `Math.max(0, state.startX - x)` to
 * `Math.abs(x - state.startX)` and `a rightward drag never claims and never
 * removes` fails.
 */
export function moveSwipe(state, x, y, t) {
  if (!state || !state.active) return state;
  /* THE line that makes a rejection final: a rejected gesture is frozen, and
     no later sample is even looked at. */
  if (state.rejected) return state;
  let claimed = state.claimed;
  let rejected = false;
  if (!claimed) {
    const ax = Math.abs(x - state.startX);
    const ay = Math.abs(y - state.startY);
    if (state.startX - x > SWIPE_LOCK_PX && ax > ay) {
      /* Horizontal, leftward, and the larger travel: the swipe wins. */
      claimed = true;
    } else if (ay > SWIPE_LOCK_PX) {
      /* The vertical axis is past the lock and the swipe did not win it —
         either vertical travel was the larger (a tie included), or the
         horizontal travel was rightward, which can never claim (rule 2). The
         list is scrolling; reject. Checking this AFTER the claim is what makes
         a diagonal leftward pull with the larger horizontal travel a swipe. */
      rejected = true;
    }
    /* Otherwise — under the lock on both axes, or a purely rightward sample
       past it — nothing is decided: a finger that wanders right along the row
       and then pulls left can still remove it. */
  }
  if (rejected) {
    return { ...state, rejected: true, dx: 0 };
  }
  const dx = Math.max(0, state.startX - x);
  return { ...state, claimed, dx, prevX: state.lastX, prevT: state.lastT, lastX: x, lastT: t };
}

/** Leftward speed at release over the last two samples (see gesture-math.js). */
function leftwardReleaseVelocity(state) {
  return releaseVelocity({ x: state.prevX, t: state.prevT }, { x: state.lastX, t: state.lastT }, "-x");
}

/**
 * `pointerup`/`pointercancel`: the gesture is over. Returns the DECISION
 * `{ remove, offsetPx }` — `offsetPx` is the raw leftward travel of a CLAIMED
 * swipe, so the caller can animate the row from where the finger left it. A
 * gesture that never claimed the row (a tap under the lock, a scroll) reports
 * `offsetPx: 0`, the same figure `swipeOffset` painted for it, so the
 * spring-back never starts from a position the row was never drawn at.
 *
 * `remove = claimed && !rejected && (dx >= 96 || (velocity >= 0.6 && dx >= 32))`.
 *
 * MUTATION TO BREAK THIS: change `>=` to `>` on the distance comparison and
 * `the distance threshold is exact at 96 px` fails.
 */
export function endSwipe(state) {
  if (!state || !state.active || !state.claimed || state.rejected) {
    return { remove: false, offsetPx: 0 };
  }
  const offsetPx = state.dx;
  if (offsetPx >= REMOVE_DISTANCE_PX) return { remove: true, offsetPx };
  if (offsetPx >= SWIPE_FLICK_MIN_PX && leftwardReleaseVelocity(state) >= REMOVE_VELOCITY_PX_PER_MS) {
    return { remove: true, offsetPx };
  }
  return { remove: false, offsetPx };
}

/**
 * The leftward offset the caller should paint for this state, in CSS px
 * (`translateX(-${swipeOffset}px)`). Zero while the gesture is still under the
 * direction lock or was rejected, so a tap or a scroll never nudges the row.
 * Past `RUBBER_BAND_PX` the row follows at a third of the finger:
 * `160 + (d - 160) / 3`.
 *
 * MUTATION TO BREAK THIS: return `state.dx` unconditionally and
 * `the painted offset is rubber-banded past 160 px` fails.
 */
export function swipeOffset(state) {
  if (!state || !state.active || !state.claimed || state.rejected) return 0;
  const d = state.dx;
  if (d <= RUBBER_BAND_PX) return d;
  return RUBBER_BAND_PX + (d - RUBBER_BAND_PX) / 3;
}
