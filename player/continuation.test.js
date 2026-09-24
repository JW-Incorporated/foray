/* What plays next, and the page's ledger for what the engine played (NE-13;
   docs/native-engine-plan.md §5.5).

   THIS SUITE READS ITS FIXTURES. Every test below runs the `continuation`
   family's cases that name it in `covers[]`
   (player/parity/fixtures/continuation/) against the real module, so the
   fixture is the assertion. The family is JS ONLY (`jsOnly`, plan C-2): the
   page computes the chain and the engine walks it, so no Swift card owes
   these ids — the file is still the one place the rule is written down, and a
   JS change that moves it turns the named test red until it is re-recorded
   on purpose.

   The page-side WIRING — app.js delegating, the Continuous playback switch
   re-sending the plan, `applyEngineAdvance` and `drainEngineEvents` writing
   `cp_engine_applied` before `logEvent` — is test/engine-continuation.test.js,
   because app.js is a classic script that runs in a node:vm page there. The
   listener-facing behaviour this extraction must not change is still pinned by
   test/up-next-autoadvance.test.js and test/up-next-queue.test.js, unchanged.

   TO SEE ONE FAIL: flip `rest.slice(at)` to `rest.slice(at + 1)` in
   planAfterEnded (Up Next), drop the `onChain` test (the list), make `canNext`
   return false when `autoAdvance` is false, or drop the in-loop watermark move
   in planAdvanceApply (replay) — each turns the named test red with the case
   id and the diff. */

import test from "node:test";
import assert from "node:assert/strict";
import { fixtureCases } from "./parity/suite.js";
import { loadFixtures } from "./parity/runner.js";
import { nextAfterEnded, continuationChain } from "./continuation.js";

const cases = fixtureCases("continuation", "continuation");

test("Up Next first: the row after the finished one, then the rows above it, and the finished one leaves", (t) => cases(t));
test("then the chosen list, after the last row that played, only while the chain is on it", (t) => cases(t));
test("an unplayable row is passed over, and the end of both is the end", (t) => cases(t));
test("nextAfterEnded moves the chain on to the pick, and the cursor only for a list row", (t) => cases(t));

/* The chain's recorded hops are checked twice: against the fixture (above),
   and here against nextAfterEnded walked one end at a time — the claim the
   engine relies on is that a hop is exactly what the page would have played
   had it been awake, never a second opinion. */
test("the chain is nextAfterEnded applied K times, in the order the ends would play", async (t) => {
  const n = await cases(t);
  assert.ok(n >= 3);
  const chainCases = loadFixtures(undefined, { family: "continuation" })
    .flatMap((fx) => fx.doc.cases)
    .filter((c) => c.call === "continuationChain" && c.covers.includes(`continuation::${t.name}`));
  for (const c of chainCases) {
    const [state] = c.args;
    const hops = continuationChain(state);
    let s = state;
    let finished = state.currentId;
    const walked = [];
    for (;;) {
      const step = nextAfterEnded(s, finished);
      if (!step.nextId) break;
      walked.push([finished, step.nextId, step.fromList, step.state.queue]);
      s = { ...s, ...step.state };
      finished = step.nextId;
    }
    assert.deepEqual(
      hops.map((h) => [h.finishedId, h.nextId, h.fromList, h.queueAfter]),
      walked,
      `${c.id}: the chain disagrees with the end of each episode`,
    );
  }
});

test("the chain stops at K, at an item the engine was not given, and with nothing playing", (t) => cases(t));
test("a hop carries its item and a lastEpisodeRow without updated_at", (t) => cases(t));
test("with Continuous playback off the chain is still planned, so skip-next is still offered", (t) => cases(t));
test("replaying the advance log twice applies each hop once, in plan order", (t) => cases(t));
test("the event drain logs each position once, at its original time", (t) => cases(t));
test("a missing or corrupt watermark reads as empty", (t) => cases(t));
