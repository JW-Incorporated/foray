/* The tail — "more of what fits" with the stretch share (PQ-10, #691;
   docs/roadmap/player-features.md §3; README default Q18: every third tail
   pick is the stretch subject).

   WHAT IS PINNED. The tail is a pure function of the day's deal
   (`state.cardSlots`, seeded here directly — the dealer never runs in tests)
   and the caller's exclusions. Each test names the one-line mutation in
   player/tail-fill.js that turns it red; run the mutation before trusting a
   green here (CLAUDE.md, "A green test is not evidence until you have broken
   it"). The page-side wiring — `continuationState().tail`, the why-line and
   announcement for a tail start, the engine plan carrying tail hops — is
   PQ-11's, in test/up-next-autoadvance.test.js and
   test/engine-continuation.test.js, not here.

   THE SEED. Three top slots with three episodes each plus a stretch slot with
   three — `SUBJECT_QUEUE_SIZE` is 3 in app.js, so this is the real shape of a
   full deal, and the twelve ids are enough for a ten-long tail with every
   third position stretch (3 stretch, 7 top). Every show title is distinct per
   episode unless a test says otherwise, so the same-show rule never fires by
   accident and masks a round-robin bug. */

import test from "node:test";
import assert from "node:assert/strict";
import { buildTail, tailReason, STRETCH_EVERY, TAIL_LENGTH } from "./tail-fill.js";

function slot(slotNo, branch, role, items) {
  const list = items.map(([id, show]) => ({ id, show, title: id }));
  return { slot: slotNo, branch, role, item: list[0] || null, items: list };
}

/** A full deal: stretch first (as buildCards writes it), then three top slots. */
function deal() {
  return [
    slot(1, "philosophy", "stretch", [["s1", "Show S1"], ["s2", "Show S2"], ["s3", "Show S3"]]),
    slot(2, "history", "top", [["a1", "Show A1"], ["a2", "Show A2"], ["a3", "Show A3"]]),
    slot(3, "science", "top", [["b1", "Show B1"], ["b2", "Show B2"], ["b3", "Show B3"]]),
    slot(4, "music", "top", [["c1", "Show C1"], ["c2", "Show C2"], ["c3", "Show C3"]])
  ];
}

const STRETCH_IDS = new Set(["s1", "s2", "s3"]);

test("positions 3, 6 and 9 are the stretch slot's ids, in the slot's order (mutation: `p % STRETCH_EVERY === 0` -> `!== 0` in isStretchPosition)", () => {
  assert.equal(STRETCH_EVERY, 3);
  assert.equal(TAIL_LENGTH, 10);
  const tail = buildTail({ slots: deal() });
  assert.equal(tail.length, 10);
  // 1-based positions 3, 6, 9 are indexes 2, 5, 8.
  assert.deepEqual([tail[2], tail[5], tail[8]], ["s1", "s2", "s3"]);
  // And nowhere else: the stretch share is exactly every third, not more.
  tail.forEach((id, i) => {
    const p = i + 1;
    assert.equal(STRETCH_IDS.has(id), p % 3 === 0, `position ${p} (${id})`);
  });
});

test("top positions round-robin the top slots in slot order (mutation: drop `cursor = (idx + 1) % tops.length`)", () => {
  const tail = buildTail({ slots: deal() });
  const topOnly = tail.filter((id) => !STRETCH_IDS.has(id));
  // A, B, C, A, B, C, A — the rotation does not restart after a stretch position.
  assert.deepEqual(topOnly, ["a1", "b1", "c1", "a2", "b2", "c2", "a3"]);
  // Reordering the array must not reorder the rotation: `slot` is the order.
  const shuffled = deal().reverse();
  assert.deepEqual(buildTail({ slots: shuffled }), tail);
});

test("exclude is honoured: an excluded id never appears, whichever slot holds it (mutation: `new Set(exclude)` -> `new Set()`)", () => {
  const exclude = ["a1", "s1", "c2"];
  const tail = buildTail({ slots: deal(), exclude });
  for (const id of exclude) assert.ok(!tail.includes(id), `${id} was played or queued already`);
  // The stretch positions move on to the next stretch ids, still every third.
  assert.deepEqual([tail[2], tail[5]], ["s2", "s3"]);
  // The caller's array is data, not a ledger: it is not written to.
  assert.deepEqual(exclude, ["a1", "s1", "c2"]);
  // No id is ever repeated inside one tail either.
  assert.equal(new Set(tail).size, tail.length);
});

test("an exhausted stretch slot leaves its positions unfilled — never borrowed from a top slot (mutation: let a stretch position fall through to the top rotation)", () => {
  const slots = deal();
  slots[0].items = slots[0].items.slice(0, 1); // one stretch episode today
  const tail = buildTail({ slots });
  // 10 positions, 3 of them stretch, only one fillable -> 8 ids, and the top
  // slots still had two episodes left (a3, b3, c3 minus the one used).
  assert.equal(tail.length, 8);
  assert.equal(tail[2], "s1");
  assert.equal(tail.filter((id) => STRETCH_IDS.has(id)).length, 1);
  // The top slots were not drained to fill the gaps: 7 top picks out of 9.
  assert.equal(tail.filter((id) => !STRETCH_IDS.has(id)).length, 7);
  // No stretch slot at all: the same, with no stretch ids anywhere.
  const noStretch = buildTail({ slots: deal().slice(1) });
  assert.equal(noStretch.length, 7);
  assert.ok(noStretch.every((id) => !STRETCH_IDS.has(id)));
  // And the mirror: tops exhausted, the stretch is not borrowed into top positions.
  const onlyStretch = buildTail({ slots: deal().slice(0, 1) });
  assert.deepEqual(onlyStretch, ["s1", "s2", "s3"]);
  assert.equal(onlyStretch.length, 3, "three stretch positions in ten, nothing else");
});

test("two consecutive positions never share a show when an alternative exists (mutation: `showOf(it) !== prevShow` -> `true` in pickFrom)", () => {
  const slots = [
    slot(1, "philosophy", "stretch", [["s1", "Same Pod"], ["s2", "Other Pod"]]),
    slot(2, "history", "top", [["a1", "Same Pod"], ["a2", "History Hour"]]),
    slot(3, "science", "top", [["b1", "Same Pod"], ["b2", "Science Weekly"]])
  ];
  const tail = buildTail({ slots, length: 6 });
  const shows = new Map(slots.flatMap((sl) => sl.items.map((it) => [it.id, it.show])));
  for (let i = 1; i < tail.length; i++) {
    assert.notEqual(shows.get(tail[i]), shows.get(tail[i - 1]), `positions ${i} and ${i + 1}: ${tail[i - 1]} -> ${tail[i]}`);
  }
  // Position 1 is a1 ("Same Pod"); position 2 skips b1 for b2 inside the same
  // slot, and position 3 (stretch) skips nothing — s1 differs from b2's show.
  assert.deepEqual(tail.slice(0, 3), ["a1", "b2", "s1"]);
  // When the only thing left IS the same show, it still plays: the rule is
  // "avoid", not "refuse" — a short tail is worse than a hard cut.
  const stuck = buildTail({
    slots: [slot(1, "history", "top", [["x1", "One Pod"], ["x2", "One Pod"], ["x3", "One Pod"]])],
    length: 2
  });
  assert.deepEqual(stuck, ["x1", "x2"]);
});

test("length is respected: never longer than asked, the default is TAIL_LENGTH, and the walk stops early when the deal is spent (mutation: `p <= total` -> `p <= total + 1`)", () => {
  assert.equal(buildTail({ slots: deal(), length: 4 }).length, 4);
  assert.equal(buildTail({ slots: deal() }).length, TAIL_LENGTH);
  assert.deepEqual(buildTail({ slots: deal(), length: 0 }), []);
  // Spent: 12 ids in the deal, 30 asked for -> at most 12, and in fact 12
  // (3 stretch positions among the first 9 cover every stretch id; the top
  // ids run out by position 12 and the walk stops rather than padding).
  const long = buildTail({ slots: deal(), length: 30 });
  assert.equal(long.length, 12);
  assert.equal(new Set(long).size, 12);
  // An empty deal is an empty tail, not a throw.
  assert.deepEqual(buildTail({ slots: [] }), []);
  assert.deepEqual(buildTail({}), []);
});

test("tailReason names the slot behind an id — stretch, top, or null when no slot holds it (mutation: return `{ role: \"top\" }` for every hit)", () => {
  const slots = deal();
  assert.deepEqual(tailReason(slots, "s2"), { role: "stretch", branch: "philosophy" });
  assert.deepEqual(tailReason(slots, "b3"), { role: "top", branch: "science" });
  assert.equal(tailReason(slots, "nope"), null);
  assert.equal(tailReason(slots, null), null);
  assert.equal(tailReason([], "s2"), null);
  // Every id the tail returns has a reason, and it agrees with the position rule.
  const tail = buildTail({ slots });
  tail.forEach((id, i) => {
    const why = tailReason(slots, id);
    assert.ok(why, `${id} has no slot`);
    assert.equal(why.role, (i + 1) % STRETCH_EVERY === 0 ? "stretch" : "top", `position ${i + 1}`);
  });
});

test("deterministic: the same deal and exclusions give the same tail, and the inputs are left as they were (mutation: shuffle `tops` with Math.random before the walk)", () => {
  const a = deal();
  const b = deal();
  const before = JSON.stringify(a);
  const t1 = buildTail({ slots: a, exclude: ["b1"] });
  const t2 = buildTail({ slots: b, exclude: ["b1"] });
  const t3 = buildTail({ slots: a, exclude: ["b1"] });
  assert.deepEqual(t1, t2);
  assert.deepEqual(t1, t3);
  assert.equal(JSON.stringify(a), before, "slots were mutated");
  // Round-trips as JSON: no function, no Set, no Date in or out — a fixture
  // can hold the whole decision.
  assert.deepEqual(JSON.parse(JSON.stringify(t1)), t1);
});
