/* Up Next list arithmetic: Play next, Clear and move-to (#762, PQ-01).
 *
 * THE MODEL (founder, 2026-09-24; re-confirmed 2026-09-30): Up Next is one
 * ordered list, `cp_queue`. The row you PLAY jumps to the top and nothing
 * else moves (`playedFromUpNext` in app.js owns that rule and is not
 * repeated here). The three tools #762 adds on top of it are the same kind
 * of thing — a new order for the same list — and that is all this module
 * computes:
 *
 *   - move-to: a row dragged (or arrowed) to a new index; every other row
 *     keeps its relative order.
 *   - Play next: a row placed directly AFTER the playing row, so it is what
 *     continuous playback reaches first; with nothing playing it goes to the
 *     head. A row not yet in the list is added by the same move — "Play
 *     next" on an episode page is how a listener queues something to hear
 *     right after this one.
 *   - Clear: the list emptied, except the playing row, which stays until it
 *     ends — "the finished episode leaves Up Next" is what removes it, the
 *     same as it always has.
 *
 * WHY THIS IS PURE
 * The same split `player/sheet-drag-dismiss.js` and `player/continuation.js`
 * make: app.js owns `queueIds()`, `saveQueueIds()` (THE one writer of
 * `cp_queue`) and the DOM; it hands this module arrays of episode ids and
 * writes back whatever comes out. Nothing here reads storage, the engine or
 * the screen, so each rule is testable head-on with node:test and no jsdom.
 *
 * SAME REFERENCE MEANS "NOTHING CHANGED". `moveTo` and `playNextOrder` return
 * the input array itself when the rule would reproduce it, so a caller can
 * `if (next !== ids) saveQueueIds(next)` and skip a storage write and the Up
 * Next repaint that every `saveQueueIds` triggers.
 *
 * IDS ARE NON-EMPTY STRINGS, the filter `queueIds()` applies: a non-string or
 * empty entry cannot resolve against the item index and could only render as
 * a permanently-broken row, so it is dropped before any rule runs rather than
 * carried along. Inputs are never mutated.
 */

/** The `queueIds()` guard, applied to any list handed in: non-string and
    empty entries are gone, and a non-array is an empty list. */
export function cleanIds(ids) {
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id) : [];
}

/** `id` placed at `toIndex`, clamped into the list, every other row in its
    original order. Returns `ids` itself when `id` is not in the list or the
    clamped index is where it already is. */
export function moveTo(ids, id, toIndex) {
  const list = cleanIds(ids);
  const from = list.indexOf(id);
  if (from < 0) return ids;
  const last = list.length - 1;
  const n = Number(toIndex);
  const to = Number.isFinite(n) ? Math.min(last, Math.max(0, Math.trunc(n))) : from;
  if (to === from) return ids;
  const rest = list.filter((x) => x !== id);
  rest.splice(to, 0, id);
  return rest;
}

/** `id` placed directly after `currentId` when that row is in the list,
    else at the head; `id` leaves its old place first and is added when it
    was not queued. Returns `ids` itself when `id` is the playing row. */
export function playNextOrder(ids, id, currentId) {
  if (id === currentId || typeof id !== "string" || !id) return ids;
  const list = cleanIds(ids);
  const rest = list.filter((x) => x !== id);
  const at = typeof currentId === "string" && currentId ? rest.indexOf(currentId) : -1;
  const to = at < 0 ? 0 : at + 1;
  rest.splice(to, 0, id);
  return rest;
}

/** The list emptied, except the playing row when it is in the list. */
export function clearOrder(ids, currentId) {
  const list = cleanIds(ids);
  return typeof currentId === "string" && currentId && list.includes(currentId) ? [currentId] : [];
}
