/* player/foray-structure.js — the structure the engine re-validates on
   playForay (docs/native-engine-plan.md §5.2, J-4; NE-29j).

   The case-by-case table lives in the parity fixtures
   (player/parity/fixtures/foray-structure/, run by player/parity/run.test.js),
   where the Swift StructuralCheck reads the same cases. This suite holds the
   properties no single case can: that the check is exactly buildForayQueue's
   post-condition (everything the build emits passes it), that its vocabulary is
   closed and on the wire, and that nothing hostile makes it throw. */

import test from "node:test";
import assert from "node:assert/strict";

import { structuralCheck, seamCensus, REFUSED_STRUCTURE, STRUCTURE_PROBLEMS, QUEUE_KINDS } from "./foray-structure.js";
import { buildForayQueue, JINGLE } from "./foray-queue.js";
import { REFUSALS } from "./engine-contract.js";
import { interludeEligible } from "./interlude.js";

const CATALOGUE = {
  a: { id: "a", title: "Fire", show: "Origin Stories", audio_url: "https://example.test/a.mp3", duration_sec: 3600 },
  b: { id: "b", title: "Smoke", show: "Food Talk", audio_url: "https://example.test/b.mp3", duration_sec: 3600 },
  dai: { id: "dai", title: "Ads", show: "Stuff", audio_url: "https://example.test/d.mp3", duration_sec: 2200, dai_suspected: true },
};
const resolveItem = (id) => CATALOGUE[id] ?? null;
const segment = (item_id, start_sec, end_sec, more = {}) => ({ type: "segment", item_id, start_sec, end_sec, ...more });

test("every queue buildForayQueue emits passes the structural check — the check is the build's post-condition", () => {
  /* MUTATION (killed): make structuralCheck demand an asset for narration — the
     script-only intro below is red; make it demand a `source_item_id` on a
     jingle — the narrated Foray is red. */
  const forays = [
    { id: "tape", items: [segment("a", 100, 210), segment("a", 300, 420), segment("b", 10, 70)] },
    { id: "narrated", items: [
      { type: "narration", id: "intro", script: "This is a Foray about fire." },
      segment("a", 100, 210),
      { type: "narration", id: "bridge", audio_url: "https://example.test/n.mp3", duration_sec: 4.2 },
      { type: JINGLE, id: "jingle-1" },
      segment("b", 400, 460),
    ] },
    { id: "dai", items: [segment("dai", 600, 700, { start_anchor: "and so", end_anchor: "that was it", reference_duration_sec: 1800 })] },
    { id: "dup-ids", items: [
      { type: "narration", id: "same", script: "One." }, { type: "narration", id: "same", script: "Two." }, segment("a", 1, 2),
    ] },
  ];
  for (const foray of forays) {
    const { items } = buildForayQueue(foray, { resolveItem });
    assert.ok(items.length > 0, `${foray.id} built nothing`);
    assert.deepStrictEqual(structuralCheck(items), { ok: true, reason: null, problems: [] }, foray.id);
  }
  /* And what the build DROPS would not have passed: a segment with no out-point
     and a narration line with nothing to say never reach the queue, and the
     check refuses both if a page sends them anyway. */
  const report = buildForayQueue({ id: "bad", items: [
    { type: "segment", item_id: "a", start_sec: 100 }, { type: "narration", id: "mute" }, segment("a", 5, 9),
  ] }, { resolveItem });
  assert.equal(report.skipped.length, 2);
  const smuggled = [
    { id: "bad#0", kind: "episode", audio_url: "https://example.test/a.mp3", start_sec: 100 },
    { id: "mute", kind: "tts", audio_url: null, script: "", duration_sec: 8 },
    ...report.items,
  ];
  assert.deepStrictEqual(structuralCheck(smuggled).problems, [
    { index: 0, code: "bad-bounds" }, { index: 1, code: "silent-narration" },
  ]);
});

test("the refusal is on the wire and its vocabulary is closed", () => {
  assert.ok(REFUSALS.includes(REFUSED_STRUCTURE), "engine-contract.js REFUSALS must carry the token playForay refuses with");
  assert.deepStrictEqual([...QUEUE_KINDS], ["episode", "tts", "jingle"]);
  const hostile = [
    null, undefined, 3, "x", [], [null], [{}], [{ id: 1, kind: "episode" }], [{ id: "a", kind: "tts" }],
    [{ id: "a", kind: "jingle" }], [{ id: "a", kind: "episode", start_sec: 5, end_sec: 1, dai_suspected: true, needs_drift_check: true }],
    [{ id: "a", kind: "x" }, { id: "a", kind: "x" }],
  ];
  const seen = new Set();
  for (const items of hostile) {
    const r = structuralCheck(items);
    assert.equal(r.ok, r.problems.length === 0);
    assert.equal(r.reason, r.ok ? null : REFUSED_STRUCTURE);
    for (const p of r.problems) {
      assert.ok(STRUCTURE_PROBLEMS.includes(p.code), `${p.code} is not in STRUCTURE_PROBLEMS`);
      assert.ok(Number.isInteger(p.index) && p.index >= -1);
      seen.add(p.code);
    }
  }
  assert.deepStrictEqual([...seen].sort(), [...STRUCTURE_PROBLEMS].sort(), "every code is reachable, and nothing else is emitted");
});

test("seamCensus counts a jingle exactly where the source changes on a tape-only Foray", () => {
  /* The capital-types-1 rule (interlude.test.js), stated for any tape-only queue:
     the sting sounds at a change of source and nowhere else. */
  const { items } = buildForayQueue({ id: "t", items: [
    segment("a", 100, 210), segment("a", 300, 420), segment("b", 10, 70), segment("b", 90, 120), segment("a", 900, 960),
  ] }, { resolveItem });
  const census = seamCensus(items);
  assert.equal(census.seams, 4);
  assert.equal(census.beats, 4, "every join of two segments is a beat");
  assert.equal(census.sameSource, 2);
  assert.equal(census.jingles, 2);
  assert.equal(census.jingles, census.sourceChanges);
  let eligible = 0;
  for (let i = 1; i < items.length; i++) if (interludeEligible({ from: items[i - 1], to: items[i] })) eligible++;
  assert.equal(census.jingles, eligible, "the census asks interlude.js, it does not re-derive it");
});

test("nothing hostile makes either function throw", () => {
  for (const v of [undefined, null, 0, "", {}, [undefined], [[]], [{ kind: "episode", start_sec: "1", end_sec: "2" }]]) {
    assert.doesNotThrow(() => structuralCheck(v));
    assert.doesNotThrow(() => seamCensus(v));
  }
});
