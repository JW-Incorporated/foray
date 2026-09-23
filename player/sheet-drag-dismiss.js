/* Drag-down-to-dismiss for a full-height sheet (founder report, 2026-09-13).
 *
 * Wyatt, live bug report: "I should be able to drag that page down from the
 * top to return to what I was looking at previously". The Now Playing sheet
 * is modal and full-height, so the only way out of it used to be finding the
 * "Close" button at the bottom of it — the Apple Podcasts sheet this is
 * modelled on comes down under your thumb instead.
 *
 * WHY THIS IS PURE
 * Exactly the split `player/strip-scrub-gesture.js` already makes, and for the
 * same reason: the caller (player/client.js) owns the real
 * `pointerdown`/`pointermove`/`pointerup` listeners, the real `translateY`
 * write and the real `scrollTop` read; it feeds this module y-coordinates and
 * timestamps and reads back "how far down is it" and "let go of it now — does
 * it close?". That is what makes the decision testable head-on, with no jsdom,
 * no fake timers and no device. What a device still has to confirm is the
 * FEEL — whether 120px is the right distance for a thumb — not the arithmetic.
 *
 * THE ONE RULE THAT IS NOT ARITHMETIC, stated here because it is the whole
 * reason `allowed` exists: a drag that starts inside a SCROLLED body is a
 * scroll, not a dismiss. Reading a long episode description and flicking down
 * to go back up the page must never throw the sheet away. So a drag is only
 * eligible if it starts on the grab handle (which is never scrollable) or with
 * the sheet's scroller already at its top. `atTop` is the caller's answer to
 * that, read once at `pointerdown` and never re-read — re-reading mid-gesture
 * would let a rubber-band bounce turn a scroll into a dismiss.
 *
 * UPWARD MOVEMENT IS CLAMPED, NOT TRACKED. A sheet that can be dragged UP off
 * the top of the screen is a bug, not a feature; `dy` never goes below 0.
 */

/** How far down the sheet must travel, in CSS px, before letting go closes it.
    Below this it springs back. Chosen as roughly a thumb's comfortable travel
    and a clear fraction of a phone screen (~15% of an 800px viewport) — far
    enough that a graze while reaching for the scrub bar cannot close a sheet
    someone is using, short enough that the gesture never feels like work. */
export const DISMISS_DISTANCE_PX = 120;

/** A FLICK closes it too, short of the distance above: releasing while still
    moving down at this speed (CSS px per ms — 0.5 is 500 px/s) is an unambiguous
    throw-it-away, and requiring the full 120px from a fast gesture is what makes
    a sheet feel sticky. Paired with `FLICK_MIN_PX` so a fast 3px twitch during a
    tap on the grab handle can never count. */
export const DISMISS_VELOCITY_PX_PER_MS = 0.5;

/** The floor under the flick rule. A flick must still have MOVED this far. */
export const FLICK_MIN_PX = 40;

/** How far a pointer must travel down before the gesture takes over from the
    scroller. Under this it is a tap (or a jitter) and the sheet does not move,
    so tapping the grab handle does nothing visible — which is correct, a
    handle is not a button. */
export const DIRECTION_LOCK_PX = 8;

/**
 * A fresh gesture, from a `pointerdown`/`touchstart` at `y`, at time `t` (ms).
 *
 * @param {number} y        pointer y in CSS px
 * @param {number} t        timestamp in ms (event.timeStamp / performance.now())
 * @param {object} [opts]
 * @param {boolean} [opts.fromHandle]  the press landed on the grab handle
 * @param {boolean} [opts.atTop]       the sheet's scroller is at scrollTop 0
 */
export function startDrag(y, t, { fromHandle = false, atTop = false } = {}) {
  return {
    active: true,
    allowed: !!(fromHandle || atTop),
    engaged: false,
    startY: y,
    dy: 0,
    lastY: y,
    lastT: t,
    prevY: y,
    prevT: t,
  };
}

/**
 * A `pointermove`/`touchmove` at (y, t).
 *
 * MUTATION TO BREAK THIS: drop the `state.allowed` guard and
 * `a drag that starts mid-scroll never engages` in the test file fails,
 * because a flick down inside a scrolled description would then start
 * dragging the sheet.
 *
 * MUTATION TO BREAK THE CLAMP: change `Math.max(0, y - state.startY)` to
 * `y - state.startY` and `upward movement is clamped at zero` fails.
 */
export function moveDrag(state, y, t) {
  if (!state || !state.active || !state.allowed) return state;
  const dy = Math.max(0, y - state.startY);
  const engaged = state.engaged || dy > DIRECTION_LOCK_PX;
  return { ...state, dy, engaged, prevY: state.lastY, prevT: state.lastT, lastY: y, lastT: t };
}

/**
 * Downward speed at the moment of release, in CSS px per ms. Measured over the
 * last TWO samples rather than the whole gesture, because "was it still moving
 * when they let go" is the question — a slow drag out and a hold at the bottom
 * must not read as a flick just because it covered ground earlier.
 *
 * Returns 0 when the two samples share a timestamp (division by zero) or when
 * the movement was upward, so every caller gets a number it can compare.
 */
export function releaseVelocity(state) {
  if (!state) return 0;
  const dt = state.lastT - state.prevT;
  if (!(dt > 0)) return 0;
  const v = (state.lastY - state.prevY) / dt;
  return v > 0 ? v : 0;
}

/**
 * `pointerup`/`pointercancel`/`touchend`: the gesture is over. Returns the
 * DECISION, not a state — the caller either animates the sheet away or springs
 * it back, and has nothing further to feed in.
 *
 * MUTATION TO BREAK THIS: change `>=` to `>` on the distance comparison and
 * `a release exactly at the dismiss distance closes the sheet` fails.
 */
export function endDrag(state) {
  /* `engaged` ALONE, not `engaged && allowed`: `engaged` can only ever become
     true inside moveDrag(), and only past the eligibility guard there. Making
     this a second, independent check of `allowed` would look safer and would in
     fact be worse — it would hide a broken guard in moveDrag behind a duplicate,
     so the mutation that matters most in this file would no longer turn any test
     red. One gate, checked once, at the only place that can open it. */
  if (!state || !state.active || !state.engaged) {
    return { dismiss: false, dy: state ? state.dy : 0 };
  }
  const dy = state.dy;
  if (dy >= DISMISS_DISTANCE_PX) return { dismiss: true, dy };
  if (dy >= FLICK_MIN_PX && releaseVelocity(state) >= DISMISS_VELOCITY_PX_PER_MS) {
    return { dismiss: true, dy };
  }
  return { dismiss: false, dy };
}

/**
 * The `translateY` the caller should paint for this state, in CSS px.
 * Zero while the gesture is still under the direction lock, so a tap on the
 * handle never nudges the sheet.
 */
export function dragOffset(state) {
  if (!state || !state.active || !state.engaged) return 0;   /* see endDrag on why not `allowed` too */
  return state.dy;
}

/**
 * Does this gesture own the finger — should the caller cancel the browser's
 * own `touchmove` so the scroller under the sheet cannot start a pan?
 *
 * WHY A SEPARATE QUESTION FROM `dragOffset` (audit round 2, touch-2). The
 * body of the sheet has no `touch-action: none` — it is the scroller, and it
 * must keep scrolling when the listener reads a long description. The only
 * thing that keeps a pull-DOWN at scrollTop 0 from becoming a rubber-band
 * scroll is a cancelled, non-passive `touchmove`; `preventDefault` on
 * `pointermove`, which this sheet used to do, has no effect on panning at
 * all. But the browser decides "is this a scroll" on the FIRST touchmove
 * past its own slop, which on iOS is smaller than `DIRECTION_LOCK_PX` — so
 * the caller cannot wait for `engaged`. The rule is therefore: an ELIGIBLE
 * gesture (`allowed`) whose finger is below where it started claims every
 * touchmove from the first pixel; a finger moving UP (dy clamps to 0) claims
 * none, and the scroller scrolls.
 *
 * MUTATION TO BREAK THIS: return `state.engaged` instead and `an eligible
 * pull claims the touch from the first downward pixel` fails.
 */
export function claimsTouch(state) {
  return !!(state && state.active && state.allowed && state.dy > 0);
}
