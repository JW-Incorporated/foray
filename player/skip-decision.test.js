/* skipped_at's decision (docs/roadmap/catalogue-personalization.md §PKG-19,
   "Guards at that seam"): one test per guard in player/skip-decision.js, plus
   the row itself.

   Every case starts from the same SKIP (an episode that loaded, 30 s into
   100 s, switched for another) and changes ONE field, so the guard under
   test is the only thing standing between it and a row.

   MUTATIONS, each run and red (the test that kills it in brackets):
     - drop `if (outgoingIsForay) return null;`                       [a Foray outgoing]
     - drop the outgoing-id guard (`!isObj(outgoing) || ...`)          [no outgoing episode]
     - drop `if (outgoingLoaded !== true) return null;`               [never loaded]
     - drop `!isNum(durationSec) ||` from the duration guard          [unknown duration]
     - drop `if (incomingId === outgoing.id) return null;`            [the same id again]
     - drop the elapsed guard (`!isNum(elapsedSec) || elapsedSec <= 0`) [nothing heard]
     - `>=` -> `>` in the ceiling, or SKIP_THRESHOLD 0.85 -> 0.9       [listened through]
     - drop the ceiling line                                          [listened through]
     - episode_id: incomingId, or elapsed/duration swapped            [the row]
   EQUIVALENT, said so rather than claimed: dropping only `durationSec <= 0`
   changes no answer. Elapsed has to be > 0 to get past the elapsed guard, and
   any elapsed > 0 is >= 0.85 x a duration <= 0, so the ceiling refuses it
   too. The guard is kept because the spec names it and it says why on its own
   line; the unknown-duration test asserts the answer for 0 and a negative. */

import test from "node:test";
import assert from "node:assert/strict";

import { SKIP_THRESHOLD, skipDecision } from "./skip-decision.js";

const SKIP = Object.freeze({
  outgoing: { id: "ep-out" },
  outgoingIsForay: false,
  incomingId: "ep-in",
  outgoingLoaded: true,
  elapsedSec: 30,
  durationSec: 100,
});
const decide = (change) => skipDecision({ ...SKIP, ...change });

test("PKG-19: a loaded episode switched before 85% is a skip -- its id, elapsed and duration", () => {
  assert.equal(SKIP_THRESHOLD, 0.85);
  assert.deepEqual(decide({}), { episode_id: "ep-out", elapsed_seconds: 30, duration_seconds: 100 });
  assert.deepEqual(decide({ elapsedSec: 84.9 }), { episode_id: "ep-out", elapsed_seconds: 84.9, duration_seconds: 100 },
    "just under the ceiling is still a skip");
  assert.equal(decide({ incomingId: undefined }).episode_id, "ep-out", "an incoming with no id is still a different episode");
});

test("PKG-19 guard: a Foray outgoing is never a skipped episode", () => {
  assert.equal(decide({ outgoingIsForay: true }), null);
  assert.notEqual(decide({ outgoingIsForay: false }), null, "premise: the same switch from an episode is a skip");
});

test("PKG-19 guard: no outgoing episode (none, not a record, no id) is no row and never a throw", () => {
  for (const outgoing of [null, undefined, "ep-out", ["ep-out"], {}, { id: "" }, { id: 7 }]) {
    assert.equal(decide({ outgoing }), null, `outgoing ${JSON.stringify(outgoing)}`);
  }
  assert.equal(skipDecision(undefined), null, "no argument at all");
  assert.equal(skipDecision(null), null);
});

test("PKG-19 guard: an outgoing episode that never loaded is not a skip (its position is the requested resume point)", () => {
  for (const outgoingLoaded of [false, undefined, null, 1, "yes"]) {
    assert.equal(decide({ outgoingLoaded }), null, `outgoingLoaded ${JSON.stringify(outgoingLoaded)}`);
  }
});

test("PKG-19 guard: an unknown duration cannot decide '< 0.85 x duration' -- no row", () => {
  for (const durationSec of [undefined, null, NaN, Infinity, -Infinity, "100"]) {
    assert.equal(decide({ durationSec }), null, `duration ${String(durationSec)}`);
  }
  for (const durationSec of [0, -100]) {
    assert.equal(decide({ durationSec }), null, `duration ${durationSec}`);
  }
});

test("PKG-19 guard: replaying the same id is not a switch", () => {
  assert.equal(decide({ incomingId: "ep-out" }), null);
});

test("PKG-19 guard: nothing heard (elapsed unknown or <= 0) is not a skip", () => {
  for (const elapsedSec of [0, -5, NaN, undefined, null, Infinity, "30"]) {
    assert.equal(decide({ elapsedSec }), null, `elapsed ${String(elapsedSec)}`);
  }
});

test("PKG-19 guard: at or past 85% of the duration is listened through, not skipped", () => {
  assert.equal(decide({ elapsedSec: 85 }), null, "exactly 0.85 x duration");
  assert.equal(decide({ elapsedSec: 99 }), null);
  assert.equal(decide({ elapsedSec: 100 }), null);
  assert.equal(decide({ elapsedSec: 140 }), null, "past the end (a stale duration)");
  assert.equal(decide({ elapsedSec: 3060, durationSec: 3600 }), null, "0.85 x an hour");
  assert.notEqual(decide({ elapsedSec: 3059, durationSec: 3600 }), null, "premise: a second under it is a skip");
});
