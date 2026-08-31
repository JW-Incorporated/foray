/* Press-and-hold zoom-to-scrub gesture for the Foray timeline strip (V1).
 *
 * Joey, live iPhone testing: "a brief click just jumps ahead to that
 * location; if I press and hold then there's a bubble view that pops up
 * showing a zoomed-in portion of the timeline". V1 ships the zoomed strip
 * view during the hold-drag, no floating bubble graphic (that is V2, its own
 * child card). This module is the "is this a tap or a hold/drag" half of
 * that ask.
 *
 * WHY THIS IS PURE
 * No DOM, no `document`, no real timers. The caller (app.js) owns the actual
 * `pointerdown`/`pointermove`/`pointerup` listeners and the real
 * `setTimeout` for the hold threshold; it feeds this module x/y coordinates
 * and "the hold timer fired" as an event, and reads back whether the
 * gesture has become a hold/drag. That is what makes the state machine
 * testable head-on, without jsdom or fake timers, the same split
 * `foray-resolve.js` and `segment-strip.js` already make between the pure
 * arithmetic and the DOM that reads it.
 *
 * WHY THE SEEK IS NOT HERE
 * `#fy-strip`'s existing `click` handler in app.js already computes the drop
 * position via `stripElapsedAt` and commits through `foraySeek`/`startAt` --
 * UNCHANGED by this feature. A `click` still fires, at the release
 * coordinate, after a `pointerup`/`touchend` that never left the element --
 * so "commit wherever the finger ended" falls out of the platform for free,
 * for a plain tap AND for a held-and-dragged gesture alike. This module only
 * ever decides whether to show the zoomed preview while the pointer is
 * down; it never seeks, so there is no second implementation of "where did
 * they drop it" to drift from the first (the task's own constraint: "do not
 * fork the seek logic, only the input/preview gesture is new").
 */

/** How long a STATIONARY press must be held before it becomes a zoom, in ms.
    Short enough that "press and hold" does not feel like a dead control,
    long enough that an ordinary tap-to-jump never grazes it -- iOS's own
    press-and-hold text-selection gesture lands in the same 300-500ms band. */
export const HOLD_MS = 350;

/** How far a pointer may move, in CSS px, before a STILL-PENDING gesture is
    read as a drag rather than a tap held in place. A drag past this crosses
    into zoom immediately -- it does not have to wait out `HOLD_MS` too,
    because a moving finger has already shown it wants to scrub, not tap. */
export const MOVE_TOLERANCE_PX = 10;

/**
 * A fresh gesture, from a `pointerdown`/`touchstart` at (x, y).
 * @returns {{downX:number, downY:number, zooming:boolean, active:boolean}}
 */
export function startGesture(x, y) {
  return { downX: x, downY: y, zooming: false, active: true };
}

/**
 * A `pointermove`/`touchmove` at (x, y). Movement past `MOVE_TOLERANCE_PX`
 * enters zoom immediately -- a drag does not wait out the hold timer, only a
 * stationary press does. Once zooming (by either path) further moves are a
 * no-op here; the caller tracks live x/y itself for the preview position.
 *
 * MUTATION TO BREAK THIS: change `>` to `>=` at the tolerance boundary and
 * `moves right at the tolerance boundary stay pending` in the test file
 * fails, because a move of EXACTLY the tolerance would then enter zoom.
 */
export function moveGesture(state, x, y) {
  if (!state || !state.active || state.zooming) return state;
  const dx = x - state.downX;
  const dy = y - state.downY;
  if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) return { ...state, zooming: true };
  return state;
}

/**
 * The caller's `HOLD_MS` timer fired: the pointer is still down and never
 * moved past tolerance. Reaches the same `zooming: true` state `moveGesture`
 * reaches by movement -- a stationary hold and a drag are two ways into one
 * state, not two states, because the strip does not need to know WHY it is
 * zooming to render the zoom.
 *
 * A gesture that already ended (`active: false`, e.g. the timer fired after
 * `endGesture` because the caller forgot to `clearTimeout`) or that is
 * already zooming is returned unchanged -- this is the second half of that
 * safety net, so a late timer callback can never resurrect a finished
 * gesture into zoom.
 */
export function holdTimeoutGesture(state) {
  if (!state || !state.active || state.zooming) return state;
  return { ...state, zooming: true };
}

/**
 * `pointerup`/`pointercancel`/`touchend`: the gesture is over. The caller
 * still owns clearing its own hold timer; this only marks the state inert so
 * a stray late callback that DOES still fire is a no-op against it (see
 * `holdTimeoutGesture`).
 */
export function endGesture(state) {
  return { ...(state ?? {}), active: false, zooming: false };
}

/* ---------- zoom visual: where to anchor the magnification ---------- */

/** Default magnification while zooming -- big enough that a boundary a
    couple of percent of the strip's width becomes easy to land a thumb on. */
export const ZOOM_SCALE = 2.5;

/**
 * Where to anchor the CSS `transform-origin` for the zoomed strip -- and
 * where to draw the scrub-preview marker -- as a percentage of the strip's
 * OWN width. Clamped to [0, 100] so a finger dragged past either end of the
 * strip still anchors at the strip's own edge rather than a percentage
 * `transform-origin` cannot usefully resolve past.
 *
 * Takes the strip's bounding box as an argument rather than reading
 * `getBoundingClientRect` itself (this file has no DOM access at all) --
 * the caller must pass the box MEASURED BEFORE the zoom transform is
 * applied. `transform: scale()` changes what `getBoundingClientRect` reports
 * for the element without changing its layout box, so re-measuring mid-zoom
 * would feed this a box already distorted by the previous frame's scale and
 * the anchor would walk during the gesture.
 *
 * MUTATION TO BREAK THIS: drop either `Math.max(0, ...)` or
 * `Math.min(100, ...)` and the "clamps past either edge" tests fail.
 *
 * @param {number} x     pointer clientX
 * @param {{left:number,width:number}} rect  the strip's box, measured pre-zoom
 * @returns {number|null} percent in [0, 100], or null when unmeasurable
 */
export function zoomOriginPercent(x, rect) {
  if (!rect || !(rect.width > 0) || typeof x !== "number" || !Number.isFinite(x)) return null;
  const frac = (x - rect.left) / rect.width;
  return Math.max(0, Math.min(100, frac * 100));
}
