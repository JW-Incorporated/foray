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
import { BUILDS_FILE, committedIds, overTable } from "./forays.js";
import { SCENARIO_BUILDS_FILE, SCENARIO_BUILD_FAMILIES, buildKey, expectedScenarioBuilds, currentScenarioBuilds } from "./scenario-builds.js";
import fs from "node:fs";
import path from "node:path";

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

test("NE-29s: foray-builds.json holds the page's build of every committed Foray a Swift case names, and each build passes the same authored expects", () => {
  /* The Swift half of the committed-Foray cases reads its INPUT from this table
     (the engine never builds a Foray, plan §3 A-1), so the table must hold a
     build for every Foray a case names, and every build in it must satisfy the
     case's authored expect when the JS rules run over it — which is exactly
     what the Swift runner computes. It is deliberately NOT required to be
     byte-fresh (a data publish must not turn npm test red; `node
     tools/parity/foray-builds.mjs --check` says when to refresh).
     MUTATION: delete one Foray's entry from foray-builds.json, or give one of
     its segments to "4a" as show, or drop an item's audio_url -> red here. */
  const table = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, BUILDS_FILE), "utf8"));
  const ids = committedIds(FIXTURES);
  assert.ok(ids.data.length >= 2 && ids.frozen.length >= 1, "the committed cases name Forays");
  for (const id of ids.data) assert.ok(Array.isArray(table.data?.[id]) && table.data[id].length > 0, `${id} has no build in ${BUILDS_FILE}`);
  for (const id of ids.frozen) assert.ok(Array.isArray(table.frozen?.[id]) && table.frozen[id].length > 0, `${id} has no frozen build`);
  let ran = 0;
  // JS-only files (NE-30j foray-data) are never run by Swift, so never over the table.
  for (const fx of FIXTURES.filter((f) => f.doc.module === "player/parity/forays.js" && f.doc.jsOnly !== true)) {
    for (const c of fx.doc.cases) {
      const args = expandInputs(c.args ?? [], { root: REPO_ROOT });
      const diffs = compare(c.expect, { return: encode(overTable(c.call, args, table)) }, { family: fx.family });
      assert.deepStrictEqual(diffs, [], `${c.id} over the table's build`);
      ran += 1;
    }
  }
  assert.ok(ran >= 30, `only ${ran} committed cases ran over the table`);
});

test("NE-30s: scenario-builds.json is the page's current build of every Foray a manager-foray or prepare scenario plays", async () => {
  /* The Swift scenario drivers read a scenario's Foray from this table (the
     engine never builds one, plan §3 A-1). It depends on the fixtures and the
     frozen fixture data only, so it is held CURRENT here: a re-recorded
     scenario refreshes it in the same PR (node tools/parity/scenario-builds.mjs
     --write). MUTATION: edit one built item's start_sec, or delete one entry
     -> red; add a playForay step to a manager-foray case without --write -> red. */
  assert.equal(currentScenarioBuilds(REPO_ROOT), await expectedScenarioBuilds(FIXTURES),
    `${SCENARIO_BUILDS_FILE} is stale: node tools/parity/scenario-builds.mjs --write`);
  const table = JSON.parse(currentScenarioBuilds(REPO_ROOT)).builds;
  let steps = 0;
  for (const f of FIXTURES.filter((x) => SCENARIO_BUILD_FAMILIES.includes(x.family))) {
    for (const c of f.doc.cases) {
      for (const [i, s] of c.steps.entries()) {
        if (s.call !== "playForay" && s.call !== "setQueueFromForay") continue;
        assert.ok(table[buildKey(c.id, i)], `${c.id} step ${i} has no build`);
        steps += 1;
      }
    }
  }
  assert.ok(steps >= 60, `only ${steps} Foray plays have a build`);
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

test("scenario: a remote press goes through the real action table into the real manager, and a press the OS could not deliver is refused", async () => {
  /* NE-29j. The `remote` driver: nexttrack loads the next item at its in-point
     and arms its out-point, pause pauses the element, seekto without a usable
     time is not a seek to zero (the table's own refusal), and an action name the
     OS does not have is a malformed case, not a no-op. */
  const got = await scenario([
    { call: "loadQueue", args: [[{ $seg: ["a", 100, 210] }, { $seg: ["b", 400, 500] }]] }, { call: "play", args: [0] },
    { checkpoint: "started" },
    { remote: "nexttrack" }, { checkpoint: "next" },
    { remote: "seekto", details: {} }, { checkpoint: "no-time" },
    { remote: "pause" }, { checkpoint: "paused" },
  ], { seamGapSec: 0 });
  const [, next, noTime, paused] = got.checkpoints;
  assert.ok(next.ops.includes("load:b@400"), next.ops.join(" "));
  assert.ok(next.ops.includes("outPoint:500"), next.ops.join(" "));
  assert.equal(next.index, 1);
  assert.deepStrictEqual(noTime.ops, [], "seekto with no time does nothing");
  assert.ok(paused.ops.includes("pause"));
  await assert.rejects(scenario([{ remote: "next" }]), /E_BAD_CASE.*unknown remote action/);
  assert.deepStrictEqual(Object.keys(PENDING_DRIVERS), [], "every schema verb has a JS driver");
});

/* ---------- NE-14j: the session, lifecycle and held-load drivers ---------- */

test("scenario: session and lifecycle steps drive the manager's own interruption, route and cold-launch paths", async () => {
  // An OS interruption ending with should-resume steps back 1.5 s in place
  // (INTERRUPTION_REWIND_SEC) — the same op log queue-manager.test.js asserts.
  const rewound = await scenario([
    { call: "loadQueue", args: [[{ $ep: ["a"] }]] }, { call: "play", args: [0] },
    { deck: "time", sec: 42.5 }, { session: "interruptionBegan" }, { checkpoint: "began" },
    { session: "interruptionEnded", shouldResume: true }, { checkpoint: "ended" },
  ]);
  assert.deepStrictEqual(rewound.checkpoints[0].ops.slice(-2), ["store.save:a@43", "pause"]);
  assert.deepStrictEqual(rewound.checkpoints[1].ops, ["load:a@41", "rate:1", "play"]);
  const routed = await scenario([
    { call: "loadQueue", args: [[{ $ep: ["a"] }]] }, { call: "play", args: [0] },
    { session: "routeLost", routeName: "Civic", isCarRoute: true }, { checkpoint: "lost" },
    { session: "routeAvailable", routeName: "Civic" }, { checkpoint: "back" },
  ]);
  assert.equal(routed.checkpoints[0].state, "interrupted");
  assert.equal(routed.checkpoints[1].state, "playing", "a route seen as a car resumes");
  const cold = await scenario([{ lifecycle: "coldLaunch", items: [{ $ep: ["a"] }], autoplay: true }], { positions: { a: 1800 } });
  assert.deepStrictEqual(cold.checkpoints[0].ops, ["load:a@1800", "rate:1", "play"]);
  // The page's two reconcile routes ask the element and only ever move towards paused.
  const fg = await scenario([
    { call: "loadQueue", args: [[{ $ep: ["a"] }]] }, { call: "play", args: [0] },
    { deck: "audible", audible: false }, { lifecycle: "foreground" }, { checkpoint: "fg" },
  ]);
  assert.equal(fg.checkpoints[0].state, "interrupted");
});

test("scenario: a session or lifecycle step it cannot read is a harness error, never a silent no-op", async () => {
  await assert.rejects(scenario([{ session: "interruption" }]), /E_BAD_CASE/);
  await assert.rejects(scenario([{ session: "interruptionEnded" }]), /E_BAD_CASE.*shouldResume/);
  await assert.rejects(scenario([{ lifecycle: "reboot" }]), /E_BAD_CASE/);
  await assert.rejects(scenario([{ deck: "loaded" }]), /E_BAD_CASE.*no held load/);
});

test("scenario: a held load settles only when the deck says so, so a superseded load can land late", async () => {
  const got = await scenario([
    { call: "loadQueue", args: [[{ $ep: ["a"] }, { $ep: ["b"] }]] },
    { call: "play", args: [0], await: false }, { call: "play", args: [1], await: false }, { settle: 2 },
    { checkpoint: "in-flight" },
    { deck: "loaded", id: "b" }, { checkpoint: "b" },
    { deck: "loaded", id: "a" }, { checkpoint: "a-late" },
  ], { backend: { holdLoads: true } });
  const [inFlight, b, late] = got.checkpoints;
  assert.deepStrictEqual(inFlight.ops, ["load:a@0", "load:b@0"], "both loads issued, nothing audible yet");
  assert.deepStrictEqual(b.ops, ["rate:1", "play"]);
  assert.deepStrictEqual(late.ops, [], "the superseded load plays nothing when it lands");
  assert.equal(late.playhead, "b");
});

test("scenario: positionEvents puts the real PositionStore behind the manager, once-a-minute event and all", async () => {
  const got = await scenario([
    { call: "loadQueue", args: [[{ $ep: ["a"] }]] }, { call: "play", args: [0] },
    { deck: "time", sec: 30 }, { call: "pause" }, { checkpoint: "first" },
    { call: "resume" }, { deck: "time", sec: 45 }, { call: "pause" }, { checkpoint: "second" },
  ], { positionEvents: true });
  assert.ok(got.checkpoints[0].ops.includes("event.position:a@30:3600"), got.checkpoints[0].ops.join(" "));
  assert.ok(got.checkpoints[0].ops.includes("store.set:cp_pos:a"));
  assert.ok(!got.checkpoints[1].ops.some((o) => o.startsWith("event.position")), "15 s on is inside the minute");
});

test("scenario: only the manager's public surface is callable", async () => {
  assert.ok(!MANAGER_CALLS.some((m) => m.startsWith("_")));
  await assert.rejects(scenario([{ call: "_handle", args: [] }]), /E_UNKNOWN_EXPORT/);
  // NE-30j gave "engine" its driver (the prepare family); a target outside the
  // schema's set still has none.
  await assert.rejects(runCase({ id: "f/s", covers: [], setup: { target: "nowhere" }, steps: [] }, { family: "f", doc: {} }), /E_SCENARIO_TARGET/);
});

const deckScenario = (steps, setup = {}) => runCase({ id: "f/d", covers: [], setup: { target: "deck", ...setup }, steps }, { family: "f", doc: {} });

test("scenario (deck, NE-28j): the driven clock moves the playhead by elapsed x rate and delivers the watchdog when it is due", async () => {
  const got = await deckScenario([
    { deck: "load", outPointSec: 210, sec: 100 }, { deck: "play" }, { clock: 100000 }, { checkpoint: "far" },
    { clock: 10000 }, { checkpoint: "done" },
  ]);
  const [far, done] = got.checkpoints;
  assert.deepEqual(far.ops, ["endTime:210", "boundary:210", "watchdog.arm:108500"], "one timer until the window, nothing while it waits");
  assert.equal(far.atSec, 200);
  assert.equal(done.ops.at(-1), "outPoint.stop:watchdog:0", "the stop lands on the boundary, never before it");
  assert.equal(done.ops.filter((o) => o === "watchdog.arm:250").length, 6, "250 ms polls inside the 1.5 s window only");
  // A deck event or a verb the deck target cannot read is a harness error.
  await assert.rejects(deckScenario([{ deck: "explode" }]), /E_BAD_CASE/);
  await assert.rejects(deckScenario([{ deck: "boundary" }]), /E_BAD_CASE.*nothing loaded/);
  await assert.rejects(deckScenario([{ call: "play", args: [] }]), /E_BAD_CASE/);
  await assert.rejects(deckScenario([{ clock: 1.5 }]), /E_BAD_CASE/);
});

test("scenario (NE-30j): the engine target stamps T on every checkpoint, the manager's opt-in views and report projection, a real Foray build, and the deck's natural end", async () => {
  // The engine target: a Foray over reference-engine, its beat on the manual
  // clock, and a refused command a harness error unless the step expects it.
  const seg = (id, url, start, end) => ({ type: "segment", id, audio_url: url, start_sec: start, end_sec: end, duration_sec: 3600 });
  const pf = { call: "playForay", args: { forayId: "f1", title: "F", items: [seg("s0", "https://cdn.test/a.mp3", 100, 200), seg("s1", "https://cdn.test/b.mp3", 300, 400)], buildReport: {}, isLocalFile: false, allowAdPad: false, voiceId: null } };
  const engine = (steps) => runCase({ id: "f/e", covers: [], setup: { target: "engine" }, steps }, { family: "f", doc: {} });
  const got = await engine([pf, { deck: "window" }, { deck: "ended", reason: "outPoint" }, { clock: 500 }, { checkpoint: "audible" }]);
  assert.equal(got.checkpoints[0].nowMs, 500);
  assert.deepEqual(got.checkpoints[0].ops, [
    "load:f1#0@100", "rate:1", "outPoint:200", "play", "n.prepare:f1#1@300",
    "n.handover:f1#1@300", "load:f1#1@300", "rate:1", "outPoint:400", "play",
  ], "prepared in the window, handed over at the seam, audible at the beat");
  await assert.rejects(engine([{ call: "play" }]), /E_BAD_CASE.*not-loaded/);
  await assert.rejects(engine([{ deck: "explode" }]), /E_BAD_CASE/);
  // The manager's views are opt-in (no earlier family changes shape), closed,
  // and timersLive needs the manual clock; a report is a closed projection.
  const mgr = (steps, setup = {}) => runCase({ id: "f/m", covers: [], setup: { target: "manager", ...setup }, steps }, { family: "f", doc: {} });
  const plain = await mgr([{ call: "loadQueue", args: [[{ $ep: ["a"] }]] }, { checkpoint: "c" }]);
  assert.equal("outPoint" in plain.checkpoints[0], false);
  await assert.rejects(mgr([{ checkpoint: "c" }], { view: ["everything"] }), /E_BAD_CASE/);
  await assert.rejects(mgr([{ checkpoint: "c" }], { view: ["timersLive"] }), /E_BAD_CASE.*manual/);
  await assert.rejects(mgr([{ call: "loadQueue", args: [[]], returns: "everything" }]), /E_BAD_CASE/);
  // A real Foray, built as the page builds it, played with no arguments.
  const real = await mgr([{ call: "playForay", returns: "forayReport" }, { checkpoint: "c" }], { forayBuild: { id: "grilling-history-2", data: "frozen" } });
  assert.equal(real.checkpoints[0].returned[0].items.length, 10);
  assert.equal(real.checkpoints[0].ops[0], "load:grilling-history-2#0@147");
  await assert.rejects(mgr([], { forayBuild: { id: "no-such-foray", data: "frozen" } }), /E_BAD_CASE/);
  // The deck's natural end spends the watch: a later boundary report is stale.
  const deck = await runCase({ id: "f/d", covers: [], setup: { target: "deck" }, steps: [
    { deck: "load", sec: 100, outPointSec: 400 }, { deck: "play" }, { deck: "ended" }, { deck: "boundary", sec: 400 }, { checkpoint: "c" },
  ] }, { family: "f", doc: {} });
  assert.deepEqual(deck.checkpoints[0].ops.slice(-3), ["watchdog.cancel", "ended:natural", "outPoint.stale:boundary"]);
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
