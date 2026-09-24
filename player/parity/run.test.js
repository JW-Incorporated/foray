/* The JS parity runner (NE-03, plan §6.3): every fixture case, run against the
   JS reference, plus the harness's own rules — the codec, the comparator, the
   schema checks and the scenario driver — each pinned here because the Swift
   `ForayEngineParity` library is ported from exactly these behaviours.

   One test per fixture case, named by its id, so a red run says WHICH rule the
   JS stopped honouring. `tools/parity/record.test.mjs` runs `record.mjs
   --check` over the whole tree; this file is the per-case view of the same
   comparison, and the only place a case's failure is a single named test.

   Nothing here waits on a real clock (see player/queue-manager.test.js, "the
   seam beat's clock", for why that rule exists in this repo). */

import test from "node:test";
import assert from "node:assert/strict";
import { REPO_ROOT, loadFixtures, validateFixtures, runCase, closedSets, loadSchema, PENDING_DRIVERS, MANAGER_CALLS } from "./runner.js";
import { encode, decodeSpecial, expandInputs, containsMacro, MACROS, SPECIAL_NUMBERS } from "./codec.js";
import { compare, NATIVE_TOKEN_FAMILIES } from "./compare.js";
import { manualScheduler, instantScheduler, OpLog, FakeBackend } from "./fakes.js";

const FIXTURES = loadFixtures(REPO_ROOT);

/* ---------- every recorded case ---------- */

for (const fx of FIXTURES) {
  for (const c of fx.doc.cases) {
    test(`${c.id} matches the JS reference`, async () => {
      assert.ok("expect" in c, `${c.id} has never been recorded — run tools/parity/record.mjs --port-card <card>`);
      const actual = await runCase(c, fx);
      const diffs = compare(c.expect, actual, { family: fx.family, tolerance: c.tolerance });
      assert.deepStrictEqual(diffs, [], `${c.id}${c.authored ? " (AUTHORED)" : ""} differs from the JS reference`);
    });
  }
}

test("there is at least one fixture family, and the seam-gap family is seeded end to end", () => {
  // A runner over zero fixtures passes, and says nothing. NE-03 seeds seam-gap
  // so the harness is exercised by a real family from the day it lands.
  const seam = FIXTURES.filter((f) => f.family === "seam-gap");
  assert.ok(seam.length >= 1, "no seam-gap fixture");
  assert.ok(seam.flatMap((f) => f.doc.cases).length >= 20, "the seam-gap family lost its cases");
});

test("every fixture on disk satisfies the schema", () => {
  assert.deepStrictEqual(validateFixtures(FIXTURES), []);
});

/* ---------- the schema's closed sets ---------- */

test("the closed sets are read from the schema file, and hold what the plan names", () => {
  const s = closedSets();
  // Plan §6.2's verbs, exactly.
  assert.deepStrictEqual(s.verbs, ["call", "settle", "clock", "deck", "tts", "interlude", "session", "lifecycle", "remote", "checkpoint"]);
  assert.deepStrictEqual(loadSchema().$defs.macro.enum, [...MACROS], "codec.js and the schema name the same macros");
  assert.deepStrictEqual(loadSchema().$defs.special.oneOf[0].properties.$num.enum, [...SPECIAL_NUMBERS]);
  assert.ok(s.harnessErrors.includes("E_NO_JS_DRIVER"));
});

test("a verb with no JS driver yet names the card that adds it, and is a schema verb", () => {
  const { verbs } = closedSets();
  for (const [verb, card] of Object.entries(PENDING_DRIVERS)) {
    assert.ok(verbs.includes(verb), verb);
    assert.match(card, /^NE-\d{2}[a-z]?$/);
  }
});

/* ---------- the codec ---------- */

test("specials round-trip: NaN, ±Infinity, -0 and undefined survive JSON", () => {
  for (const v of [NaN, Infinity, -Infinity, -0, undefined]) {
    const wire = JSON.parse(JSON.stringify(encode(v)));
    assert.ok(Object.is(decodeSpecial(wire), v), `lost ${String(v)}`);
  }
  assert.deepStrictEqual(encode(0), 0, "+0 is a plain 0; only -0 is tagged");
});

test("encode sorts object keys, so a fixture's bytes do not depend on build order", () => {
  assert.deepStrictEqual(Object.keys(encode({ b: 1, a: 2 })), ["a", "b"]);
});

test("encode drops an undefined property, as JSON and Swift both do", () => {
  assert.deepStrictEqual(encode({ a: undefined, b: 1 }), { b: 1 });
});

test("encode refuses what Swift could not rebuild instead of recording nothing", () => {
  assert.throws(() => encode(() => 1), /E_UNENCODABLE/);
  assert.throws(() => encode({ m: new Map() }), /E_UNENCODABLE/);
  assert.throws(() => encode(1n), /E_UNENCODABLE/);
});

test("$seg defaults to seam-gap.test.js's seg(): a 100-210 s slice of an episode", () => {
  assert.deepStrictEqual(expandInputs({ $seg: ["a"] }), { id: "a", kind: "episode", start_sec: 100, end_sec: 210 });
  assert.deepStrictEqual(expandInputs({ $seg: ["a", 0, 90, { why: "x" }] }), { id: "a", kind: "episode", start_sec: 0, end_sec: 90, why: "x" });
});

test("$ep and $tts expand to an unbounded episode and a narration item", () => {
  assert.deepStrictEqual(expandInputs({ $ep: ["a", { rate: 1 }] }), { id: "a", kind: "episode", rate: 1 });
  assert.deepStrictEqual(expandInputs({ $tts: ["n1"] }), { id: "n1", kind: "tts" });
});

test("$foray reads a committed Foray by id, and a literal one as given", () => {
  const f = expandInputs({ $foray: "grilling-history-2" }, { root: REPO_ROOT });
  assert.equal(f.id, "grilling-history-2");
  assert.ok(Array.isArray(f.items) && f.items.length > 0, "the committed Foray has items");
  assert.deepStrictEqual(expandInputs({ $foray: { id: "x", items: [{ $seg: ["s"] }] } }).items[0].start_sec, 100);
  assert.throws(() => expandInputs({ $foray: "no-such-foray" }, { root: REPO_ROOT }), /E_BAD_MACRO/);
});

test("macros are closed, alone in their object, and never legal in an expect", () => {
  assert.throws(() => expandInputs({ $segment: ["a"] }), /E_BAD_MACRO/);
  assert.throws(() => expandInputs({ $seg: ["a"], extra: 1 }), /E_BAD_MACRO/);
  assert.throws(() => expandInputs({ $num: "nan" }), /E_BAD_SPECIAL/);
  assert.equal(containsMacro({ return: { $seg: ["a"] } }), true);
  const bad = [{ family: "f", file: "f.json", doc: { family: "f", module: "player/x.js", cases: [{ id: "f/a", covers: [], read: "X", expect: { value: { $ep: ["a"] } } }] } }];
  assert.match(validateFixtures(bad).join("\n"), /macros are inputs only/);
});

/* ---------- the comparator ---------- */

test("compare is exact by default and names the path of every difference", () => {
  assert.deepStrictEqual(compare({ return: 2 }, { return: 2 }), []);
  const d = compare({ return: { a: [1, 2] } }, { return: { a: [1, 3] } });
  assert.equal(d.length, 1);
  assert.equal(d[0].path, "$.return.a[1]");
  assert.equal(compare(2, 2.0000001).length, 1, "no silent tolerance");
});

test("a case-level tolerance is absolute and never forgives a special number", () => {
  assert.deepStrictEqual(compare(2, 2.05, { tolerance: 0.1 }), []);
  assert.equal(compare(2, 2.2, { tolerance: 0.1 }).length, 1);
  assert.equal(compare({ $num: "-0" }, 0, { tolerance: 1 }).length, 1, "0 within any tolerance of -0 is the sign bug");
  assert.deepStrictEqual(compare({ $num: "NaN" }, { $num: "NaN" }), []);
});

test("object key order never matters; array order always does", () => {
  assert.deepStrictEqual(compare({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
  assert.equal(compare(["play", "pause"], ["pause", "play"]).length, 2);
  assert.match(compare({ a: 1 }, { a: 1, b: 2 })[0].why, /unexpected key/);
  assert.match(compare({ a: 1, b: 2 }, { a: 1 })[0].why, /missing key/);
});

test("native-only n.* tokens are stripped from op logs, except in the prepare family", () => {
  const want = { ops: ["load:a@0", "play"] };
  const got = { ops: ["load:a@0", "n.prepare:b", "play"] };
  assert.deepStrictEqual(compare(want, got, { family: "manager-episode" }), []);
  assert.ok(NATIVE_TOKEN_FAMILIES.includes("prepare"));
  assert.equal(compare(want, got, { family: "prepare" }).length, 1, "prepare asserts the n.* tokens");
  // Only an `ops` array is an op log: a value that happens to start with n. elsewhere is data.
  assert.equal(compare({ ids: ["a"] }, { ids: ["a", "n.x"] }, { family: "x" }).length, 1);
});

/* ---------- the schema checks the runner applies ---------- */

const fx = (cases, over = {}) => [{ family: "f", file: "player/parity/fixtures/f/f.json", doc: { family: "f", module: "player/seam-gap.js", cases, ...over } }];

test("validation: a file's family must be its directory, and ids carry the family", () => {
  assert.match(validateFixtures(fx([{ id: "f/a", covers: [], read: "X" }], { family: "g" })).join("\n"), /does not match its directory/);
  assert.match(validateFixtures(fx([{ id: "g/a", covers: [], read: "X" }])).join("\n"), /must start with "f\/"/);
});

test("validation: ids are unique across the whole tree, not only within a file", () => {
  const two = [...fx([{ id: "f/a", covers: [], read: "X" }]), { ...fx([{ id: "f/a", covers: [], read: "Y" }])[0], file: "player/parity/fixtures/f/g.json" }];
  assert.match(validateFixtures(two).join("\n"), /duplicate id/);
});

test("validation: a case is exactly one of read / call / scenario, with a matching expect", () => {
  assert.match(validateFixtures(fx([{ id: "f/a", covers: [], read: "X", call: "y" }])).join("\n"), /exactly one of read/);
  assert.match(validateFixtures(fx([{ id: "f/a", covers: [], call: "y", expect: { value: 1 } }])).join("\n"), /exactly one of \{return\}/);
  assert.match(validateFixtures(fx([{ id: "f/a", covers: [], call: "y", expect: { throws: { name: "Oops" } } }])).join("\n"), /throws.name/);
  assert.match(validateFixtures(fx([{ id: "f/a", covers: [], read: "X", authored: true }])).join("\n"), /authored case must carry its expect/);
  assert.match(validateFixtures(fx([{ id: "f/a", covers: ["no separator"], read: "X" }])).join("\n"), /covers entry/);
});

test("validation: every scenario step carries exactly one closed verb", () => {
  const scen = (steps) => fx([{ id: "f/s", covers: [], setup: { target: "manager" }, steps }], { module: undefined });
  assert.deepStrictEqual(validateFixtures(scen([{ call: "play", args: [0] }, { checkpoint: "x" }])), []);
  assert.match(validateFixtures(scen([{ jump: 1 }])).join("\n"), /exactly one verb/);
  assert.match(validateFixtures(scen([{ call: "play", settle: 1 }])).join("\n"), /exactly one verb/);
});

/* ---------- running pure cases ---------- */

const SEAM = { family: "seam-gap", doc: { module: "player/seam-gap.js" } };

test("a thrown error is recorded by class only; a message is text, and text is a text-pin", async () => {
  // seamGapSec(null): the `= {}` default covers undefined, not null, so the
  // destructuring throws a TypeError from inside the rule itself.
  const got = await runCase({ id: "seam-gap/x", covers: [], call: "seamGapSec", args: [null] }, SEAM);
  assert.deepStrictEqual(got, { throws: { name: "TypeError" } });
});

test("an unknown export is a harness error, never a recorded expect", async () => {
  await assert.rejects(runCase({ id: "seam-gap/x", covers: [], call: "nope", args: [] }, SEAM), /E_UNKNOWN_EXPORT/);
  await assert.rejects(runCase({ id: "seam-gap/x", covers: [], call: "SEAM_GAP_SEC", args: [] }, SEAM), /E_NOT_A_FUNCTION/);
});

/* NE-12j's adapter (media-actions.js) turns mediaSessionActions' list of
   handlers into data. What it records is only as good as what it refuses: a
   press of a button the surface never installed would otherwise record "no
   calls" — indistinguishable from seekto's real "no usable time does nothing"
   rule — and a misspelt surface method would quietly test a smaller surface.
   MUTATION: drop the `if (!handler)` refusal -> the first rejection becomes a
   TypeError recorded as `throws`, and this goes red. */
const MEDIA_ACTIONS_FX = { family: "media-episode", doc: { module: "player/parity/media-actions.js" } };
const pressCase = (input) => runCase({ id: "media-episode/x", covers: [], call: "mediaActions", args: [input] }, MEDIA_ACTIONS_FX);

test("the media-actions adapter records real arity, and refuses a press the OS could never deliver", async () => {
  assert.deepStrictEqual(await pressCase({ surface: ["next", "stop"], presses: [["nexttrack", { action: "nexttrack" }], ["stop", { $undefined: true }]] }), {
    return: { calls: [["next"], ["stop", { $undefined: true }]], installed: ["stop", "nexttrack"] },
  });
  await assert.rejects(pressCase({ surface: ["play"], presses: [["nexttrack"]] }), /E_BAD_CASE.*nexttrack.*not installed/);
  await assert.rejects(pressCase({ surface: ["play", "skip"] }), /E_BAD_CASE.*"skip"/);
  await assert.rejects(pressCase({ surface: ["play"], presses: [["play", {}, "extra"]] }), /E_BAD_CASE/);
});

/* ---------- scenarios over the real manager ---------- */

const scenario = (steps, setup = {}) => runCase({ id: "f/s", covers: [], setup: { target: "manager", ...setup }, steps }, { family: "f", doc: {} });

test("scenario: play loads, applies the rate, then starts — the same op log queue-manager.test.js asserts", async () => {
  // queue-manager.test.js "play loads then starts, in that order" asserts
  // ["load:a@0", "rate:1", "play"] on its own FakeBackend. The shared fake
  // must produce the identical grammar, or a recorded manager case would not
  // read the same as the test it came from.
  const got = await scenario([
    { call: "setQueueFromPick", args: [{ $ep: ["a", { rate: 1 }] }] },
    { call: "play", args: [0] },
    { checkpoint: "played" },
  ]);
  assert.deepStrictEqual(got.checkpoints[0].ops, ["load:a@0", "rate:1", "play"]);
  assert.equal(got.checkpoints[0].state, "playing");
  assert.equal(got.checkpoints[0].playhead, "a");
  assert.equal(got.checkpoints.at(-1).name, "end", "an implicit final checkpoint closes every scenario");
});

test("scenario: a checkpoint holds only the ops since the previous one", async () => {
  const got = await scenario([
    { call: "setQueueFromPick", args: [{ $ep: ["a"] }] },
    { call: "play", args: [0] },
    { checkpoint: "one" },
    { call: "pause" },
    { checkpoint: "two" },
  ]);
  assert.ok(!got.checkpoints[1].ops.includes("load:a@0"));
  assert.ok(got.checkpoints[1].ops.includes("pause"));
  assert.deepStrictEqual(got.ops, [...got.checkpoints[0].ops, ...got.checkpoints[1].ops, ...got.checkpoints[2].ops]);
});

test("scenario: on a manual clock the seam beat holds the next play until the clock says so", async () => {
  const foray = { $foray: { id: "foray-1", title: "Fire", items: [
    { type: "segment", item_id: "ep-static", start_sec: 100, end_sec: 210 },
    { type: "segment", item_id: "ep-other", start_sec: 400, end_sec: 500 },
  ] } };
  const catalogue = {
    "ep-static": { id: "ep-static", title: "Static", audio_url: "https://example.test/a.mp3", duration_sec: 3600 },
    "ep-other": { id: "ep-other", title: "Other", audio_url: "https://example.test/b.mp3", duration_sec: 3600 },
  };
  const got = await scenario([
    { call: "playForay", args: [foray] },
    { checkpoint: "started" },
    { deck: "time", sec: 210 },
    { deck: "ended", reason: "outPoint" },
    { checkpoint: "in-beat" },
    { clock: 2000 },
    { checkpoint: "after-beat" },
  ], { scheduler: "manual", catalogue });
  const [started, inBeat, after] = got.checkpoints;
  assert.deepStrictEqual(started.ops.filter((o) => o === "play"), ["play"], "the first segment started");
  assert.equal(inBeat.inSeamGap, true, "the beat is running");
  assert.equal(inBeat.ops.filter((o) => o === "play").length, 0, "nothing audible inside the beat");
  assert.ok(after.ops.includes("play"), `the next segment starts when the beat ends: ${after.ops}`);
  assert.equal(after.inSeamGap, false);
});

test("scenario: a verb with no JS driver fails loudly with its card, never silently skips", async () => {
  await assert.rejects(scenario([{ session: "interruption" }]), /E_NO_JS_DRIVER.*NE-11j/);
  await assert.rejects(scenario([{ remote: "next" }]), /E_NO_JS_DRIVER.*NE-29j/);
});

test("scenario: only the manager's public surface is callable", async () => {
  assert.ok(!MANAGER_CALLS.some((m) => m.startsWith("_")));
  await assert.rejects(scenario([{ call: "_handle", args: [] }]), /E_UNKNOWN_EXPORT/);
  await assert.rejects(runCase({ id: "f/s", covers: [], setup: { target: "engine" }, steps: [] }, { family: "f", doc: {} }), /E_SCENARIO_TARGET/);
});

/* ---------- the fakes ---------- */

test("manualScheduler fires nothing until advanced, then in due order", async () => {
  const s = manualScheduler();
  const seen = [];
  s.schedule(200, () => seen.push("b"));
  s.schedule(100, () => seen.push("a"));
  const cancel = s.schedule(150, () => seen.push("x"));
  cancel();
  assert.deepStrictEqual(seen, []);
  await s.advance(250);
  assert.deepStrictEqual(seen, ["a", "b"]);
  assert.equal(s.live, 0);
});

test("instantScheduler never fires inside schedule() — setTimeout semantics, zero wall clock", async () => {
  const s = instantScheduler();
  let fired = false;
  s.schedule(2000, () => { fired = true; });
  assert.equal(fired, false);
  await Promise.resolve();
  assert.equal(fired, true);
});

test("FakeBackend writes queue-manager.test.js's tokens into a shared log", async () => {
  const log = new OpLog();
  const b = new FakeBackend({ log });
  await b.load({ id: "a" }, { startOffset: 99.6 });
  b.setOutPoint(210.4); b.setOutPoint(null); b.seek(12.2); b.setRate(1.5); b.play(); b.pause(); b.release();
  assert.deepStrictEqual(log.ops, ["load:a@100", "outPoint:210", "outPoint:null", "seek:12", "rate:1.5", "play", "pause", "release"]);
});
