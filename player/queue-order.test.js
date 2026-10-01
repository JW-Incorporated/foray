/* Up Next list arithmetic: Play next, Clear and move-to (#762, PQ-01).
 *
 * The model (founder, 2026-09-24; re-confirmed 2026-09-30): Up Next is one
 * ordered list; the row you play jumps to the top and nothing else moves.
 * The three tools #762 adds are each a new order for that same list, and
 * `player/queue-order.js` is pure by design — app.js owns storage and the
 * screen — so every rule is tested head-on here, with no jsdom.
 *
 * WHAT THIS SUITE CANNOT TELL YOU: whether the Play next / Clear controls
 * are on the right pages, whether a drag lands where a thumb meant it to, or
 * whether the engine re-reads the list after an edit. Those belong to the
 * PQ cards that wire this module in (PQ-02, PQ-04, PQ-06, PQ-07) and their
 * own suites. Everything below is arithmetic.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md, "a
 * green test is not evidence until you have broken it").
 */

import test from "node:test";
import assert from "node:assert/strict";

import { moveTo, playNextOrder, clearOrder } from "./queue-order.js";

test("moveTo puts the row at the index and keeps every other row in order", () => {
  // Mutation: `return ids;` from moveTo — the drag would never land.
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(moveTo(ids, "d", 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveTo(ids, "a", 2), ["b", "c", "a", "d"]);
  assert.deepEqual(ids, ["a", "b", "c", "d"], "the input is never mutated");
});

test("moveTo clamps past either end and is a no-op for an unknown id", () => {
  // Mutation: drop the clamp — splice(99) still appends, but splice(-5)
  // counts from the end and puts "a" second-to-last instead of first.
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(moveTo(ids, "d", 99), ["a", "b", "c", "d"], "past the end lands at the end");
  assert.deepEqual(moveTo(ids, "a", -5), ["a", "b", "c", "d"], "before the start lands at the start");
  assert.deepEqual(moveTo(ids, "a", 99), ["b", "c", "d", "a"]);
  assert.equal(moveTo(ids, "zzz", 0), ids, "an unknown id returns the same reference");
  assert.equal(moveTo(ids, "b", 1), ids, "an unchanged index returns the same reference");
  assert.equal(moveTo(ids, "d", 99), ids, "a clamp onto the row's own index is also unchanged");
});

test("Play next inserts after the playing row", () => {
  // Mutation: insert at 0 regardless of currentId — "c" would land AHEAD of
  // the episode in the listener's ears.
  assert.deepEqual(playNextOrder(["a", "b", "c"], "c", "a"), ["a", "c", "b"]);
  assert.deepEqual(playNextOrder(["a", "b", "c", "d"], "a", "c"), ["b", "c", "a", "d"]);
});

test("Play next with nothing playing goes to the head", () => {
  // Mutation: `at + 1` with at = -1 → index 0 is correct only because -1 + 1
  // is 0; change the fallback to `rest.length` and this is red.
  assert.deepEqual(playNextOrder(["a", "b", "c"], "c", null), ["c", "a", "b"]);
  assert.deepEqual(playNextOrder(["a", "b", "c"], "c", "not-queued"), ["c", "a", "b"],
    "a playing episode that is not in Up Next counts as nothing playing");
});

test("Play next on an id not yet queued adds it", () => {
  // Mutation: `if (list.indexOf(id) < 0) return ids;` — Play next from an
  // episode page would silently do nothing.
  assert.deepEqual(playNextOrder(["a"], "z", "a"), ["a", "z"]);
  assert.deepEqual(playNextOrder([], "z", null), ["z"]);
});

test("Play next on the playing row changes nothing", () => {
  // Mutation: drop the `id === currentId` guard — the result is equal but a
  // NEW array, and the caller's `next !== ids` check would write storage
  // and repaint Up Next for nothing.
  const ids = ["a", "b", "c"];
  assert.equal(playNextOrder(ids, "a", "a"), ids);
  assert.equal(playNextOrder(ids, "b", "b"), ids);
});

test("Clear keeps only the playing row", () => {
  // Mutation: `return [];` always — the episode in the listener's ears would
  // vanish from Up Next mid-play, which the model says only its ending does.
  assert.deepEqual(clearOrder(["a", "b", "c"], "b"), ["b"]);
  assert.deepEqual(clearOrder(["a"], null), []);
  assert.deepEqual(clearOrder(["a", "b"], "zzz"), [], "a playing episode not in the list leaves nothing");
  assert.deepEqual(clearOrder([], "a"), []);
});

test("non-string entries are dropped before any rule runs", () => {
  // Mutation: skip cleanIds — 7 and "" would be carried into the new order
  // and render as permanently-broken rows.
  assert.deepEqual(playNextOrder(["a", 7, ""], "b", "a"), ["a", "b"]);
  assert.deepEqual(moveTo(["a", null, "b", ""], "b", 0), ["b", "a"]);
  assert.deepEqual(clearOrder(["a", 0, "b"], "b"), ["b"]);
  assert.deepEqual(clearOrder("not-an-array", "a"), []);
});
