/* Arithmetic the pure gesture modules share (code-health CH-14, P2-15).
 *
 * `player/queue-swipe.js` (swipe a row left to remove it) and
 * `player/sheet-drag-dismiss.js` (drag the Now Playing sheet down to close it)
 * both ask "was the finger still moving when it let go, and how fast?". They
 * used to answer it with two copies of the same five lines, one per axis; the
 * next fix to one (a guard, a smoothing window) would have missed the other.
 * This file is the one answer. It owns no thresholds: each gesture tunes its
 * own distances and speeds, and they are deliberately not shared.
 */

/** Which way along which axis counts as forward travel for `releaseVelocity`.
    Screen coordinates: x grows rightward, y grows downward. */
const AXES = {
  "+x": { key: "x", sign: 1 },
  "-x": { key: "x", sign: -1 },
  "+y": { key: "y", sign: 1 },
  "-y": { key: "y", sign: -1 },
};

/**
 * Speed at the moment of release, in CSS px per ms, along `axis` — measured
 * over the last TWO samples rather than the whole gesture, because "was it
 * still moving when they let go" is the question: a slow drag out followed by
 * a hold must not read as a flick because it covered ground earlier.
 *
 * `prev` and `last` are samples `{ t, x }` or `{ t, y }` (whichever coordinate
 * `axis` reads; the other is ignored). `axis` is "-x" for leftward (the queue
 * swipe), "+y" for downward (the sheet), or "+x" / "-y".
 *
 * Returns 0 when either sample is missing, when the two share a timestamp
 * (division by zero), or when the last movement went the other way — so every
 * caller gets a number it can compare against a positive threshold.
 *
 * @param {{t: number, x?: number, y?: number}} prev  the sample before the last
 * @param {{t: number, x?: number, y?: number}} last  the last sample
 * @param {"+x"|"-x"|"+y"|"-y"} axis
 */
export function releaseVelocity(prev, last, axis) {
  const dir = AXES[axis];
  if (!prev || !last || !dir) return 0;
  const dt = last.t - prev.t;
  if (!(dt > 0)) return 0;
  const v = (dir.sign * (last[dir.key] - prev[dir.key])) / dt;
  return v > 0 ? v : 0;
}
