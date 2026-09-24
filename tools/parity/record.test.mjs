/* The parity recorder (tools/parity/record.mjs, NE-03 plan §6.3).

   Three promises, each tested against a scratch copy of the harness so the
   real fixtures are never written by a test:

     1. --check is red on any fixture the JS no longer agrees with — including
        a hand-edited expect — and it runs in npm test (the first test below
        IS `record.mjs --check` over the real tree, in-process).
     2. Recording never overwrites an authored case, and every new or changed
        case lands in swift-pending.json tagged with the port card — so a JS PR
        hands the Swift card a list instead of turning its runner red.
     3. --mutate flips a named rule in a child process's loader only, and a
        mutant counts as killed only when BOTH the original JS test and the
        fixture family fail. A no-op "mutant" must survive, or "killed" would
        be the harness's constant answer.

   Child processes are spawned one at a time (spawnSync); nothing here runs
   in parallel. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAll, record, runMutation, loadMutations, stableJson, main } from "./record.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A scratch repo holding just what the seam-gap family needs: the module and
    its import, the ESM marker, the suite, and the whole parity directory. */
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-rec-"));
  const copy = (rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(root, rel));
  };
  for (const rel of ["player/package.json", "player/seam-gap.js", "player/queue-state.js", "player/seam-gap.test.js"]) copy(rel);
  fs.cpSync(path.join(ROOT, "player", "parity"), path.join(root, "player", "parity"), {
    recursive: true,
    filter: (src) => !/\.test\.js$/.test(src),
  });
  return root;
}
const FIXTURE = "player/parity/fixtures/seam-gap/seam-gap.json";
const readJ = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const writeJ = (root, rel, v) => fs.writeFileSync(path.join(root, rel), stableJson(v));
const quiet = () => {};

/* ---------- --check ---------- */

test("record.mjs --check is green over the real tree (this is --check running in npm test)", async () => {
  const r = await checkAll({ root: ROOT });
  assert.deepStrictEqual(r.problems, []);
  assert.ok(r.cases >= 20, `only ${r.cases} cases checked`);
});

test("a hand-edited recorded expect turns --check red, twice over: the case and the manifest", async () => {
  const root = scratch();
  try {
    const doc = readJ(root, FIXTURE);
    const c = doc.cases.find((x) => x.id === "seam-gap/length-overridable");
    assert.deepStrictEqual(c.expect, { return: 3.5 }, "precondition");
    c.expect = { return: 3.0 };
    writeJ(root, FIXTURE, doc);
    const r = await checkAll({ root });
    assert.ok(r.problems.some((p) => p.startsWith("seam-gap/length-overridable: JS no longer matches")), r.problems.join("\n"));
    assert.ok(r.problems.some((p) => /does not match its recorded hash/.test(p)), "the manifest notices the edit too");
    assert.equal(r.failed, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI's --check exits 1 on a red tree and 0 on a green one", async () => {
  const root = scratch();
  try {
    assert.equal(await main(["--check"], { root, log: quiet, err: quiet }), 0);
    const doc = readJ(root, FIXTURE);
    delete doc.cases[1].expect;
    writeJ(root, FIXTURE, doc);
    const errs = [];
    assert.equal(await main(["--check"], { root, log: quiet, err: (m) => errs.push(m) }), 1);
    assert.match(errs.join("\n"), /unrecorded/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- recording ---------- */

test("JS that disagrees with an authored case is refused, and nothing is written", async () => {
  const root = scratch();
  try {
    const mod = path.join(root, "player", "seam-gap.js");
    fs.writeFileSync(mod, fs.readFileSync(mod, "utf8").replace("export const SEAM_GAP_SEC = 2.0;", "export const SEAM_GAP_SEC = 2.5;"));
    const before = fs.readFileSync(path.join(root, FIXTURE), "utf8");
    const pendingBefore = fs.readFileSync(path.join(root, "player/parity/swift-pending.json"), "utf8");
    const r = await record({ root, portCard: "NE-28s", log: quiet });
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some((x) => /seam-gap\/rule-is-2\.0s is AUTHORED/.test(x)), r.refusals.join("\n"));
    assert.equal(fs.readFileSync(path.join(root, FIXTURE), "utf8"), before, "the fixture is untouched");
    assert.equal(fs.readFileSync(path.join(root, "player/parity/swift-pending.json"), "utf8"), pendingBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recording a new case writes its expect and adds its id to swift-pending.json with the port card", async () => {
  const root = scratch();
  try {
    const doc = readJ(root, FIXTURE);
    doc.cases.push({ id: "seam-gap/brand-new", covers: [], call: "seamGapSec", args: [{ from: { $seg: ["a"] }, to: { $seg: ["b"] }, gapSec: 1.25 }] });
    writeJ(root, FIXTURE, doc);

    const refused = await record({ root, log: quiet });
    assert.equal(refused.ok, false, "a new id without --port-card is refused");
    assert.match(refused.refusals.join("\n"), /pass --port-card/);

    const r = await record({ root, portCard: "NE-28s", log: quiet });
    assert.equal(r.ok, true, r.refusals.join("\n"));
    assert.deepStrictEqual(r.pendingAdded, ["seam-gap/brand-new"]);
    assert.equal(readJ(root, "player/parity/swift-pending.json")["seam-gap/brand-new"], "NE-28s");
    const rec = readJ(root, FIXTURE).cases.find((c) => c.id === "seam-gap/brand-new");
    assert.deepStrictEqual(rec.expect, { return: 1.25 });
    assert.ok(readJ(root, "player/parity/manifest.json").families["seam-gap"].ids.includes("seam-gap/brand-new"));
    assert.equal(readJ(root, "player/parity/floors.json").families["seam-gap"], doc.cases.length, "the floor rose with the family");
    assert.deepStrictEqual((await checkAll({ root })).problems, [], "a fresh record is --check clean");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a JS change to a recorded (non-authored) case re-records it and puts it back in swift-pending", async () => {
  const root = scratch();
  try {
    // Pretend the Swift side already burned the family down.
    writeJ(root, "player/parity/swift-pending.json", {});
    const mod = path.join(root, "player", "seam-gap.js");
    // A rule change: bridged seams get the beat too. Not an authored case.
    fs.writeFileSync(mod, fs.readFileSync(mod, "utf8").replace("  if (bridged) return 0;\n", ""));
    const r = await record({ root, portCard: "NE-28s", log: quiet });
    assert.equal(r.ok, true, r.refusals.join("\n"));
    assert.deepStrictEqual(r.pendingAdded, ["seam-gap/bridged-no-beat"]);
    assert.deepStrictEqual(readJ(root, "player/parity/swift-pending.json"), { "seam-gap/bridged-no-beat": "NE-28s" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("re-recording an unchanged tree changes no byte", async () => {
  const root = scratch();
  try {
    const files = ["player/parity/manifest.json", "player/parity/swift-pending.json", "player/parity/floors.json", FIXTURE];
    const before = files.map((f) => fs.readFileSync(path.join(root, f), "utf8"));
    const r = await record({ root, log: quiet });
    assert.equal(r.ok, true, r.refusals.join("\n"));
    assert.deepStrictEqual(files.map((f) => fs.readFileSync(path.join(root, f), "utf8")), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a family that loses cases is refused unless --lower-floors says so", async () => {
  const root = scratch();
  try {
    const doc = readJ(root, FIXTURE);
    doc.cases.pop();
    writeJ(root, FIXTURE, doc);
    const r = await record({ root, portCard: "NE-28s", log: quiet });
    assert.equal(r.ok, false);
    assert.match(r.refusals.join("\n"), /below its floor/);
    const lowered = await record({ root, portCard: "NE-28s", lowerFloors: true, log: quiet });
    assert.equal(lowered.ok, true, lowered.refusals.join("\n"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a --port-card that is not a card id is refused", async () => {
  const root = scratch();
  try {
    const r = await record({ root, portCard: "later", log: quiet });
    assert.equal(r.ok, false);
    assert.match(r.refusals.join("\n"), /not a card id/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- --mutate ---------- */

test("the four named mutation rules exist, and each anchor occurs exactly once in its file", () => {
  const rules = loadMutations();
  assert.deepStrictEqual(Object.keys(rules), ["seam-gap", "never-early", "15/30", "pause-silence"]);
  for (const [name, r] of Object.entries(rules)) {
    const src = fs.readFileSync(path.join(ROOT, r.patch.file), "utf8");
    assert.equal(src.split(r.patch.find).length - 1, 1, `${name}: anchor drifted in ${r.patch.file}`);
    assert.notEqual(r.patch.find, r.patch.replace, name);
    assert.match(r.recordedBy, /^NE-\d{2}[a-z]?$/, name);
  }
});

test("--mutate on the seam-gap rule fails both the original JS test and the fixture family", () => {
  const r = runMutation("seam-gap", loadMutations()["seam-gap"], { root: ROOT });
  assert.equal(r.js, "killed", r.detail.join("\n"));
  assert.equal(r.fixture, "killed", r.detail.join("\n"));
  assert.equal(r.killed, true);
});

test("a no-op mutant SURVIVES both halves, so 'killed' is not the harness's constant answer", () => {
  const rule = structuredClone(loadMutations()["seam-gap"]);
  rule.patch.replace = rule.patch.find + " /* same rule */";
  const r = runMutation("no-op", rule, { root: ROOT });
  assert.equal(r.js, "survived", r.detail.join("\n"));
  assert.equal(r.fixture, "survived", r.detail.join("\n"));
  assert.equal(r.killed, false);
});

test("a rule whose family is not recorded yet reports PENDING for the fixture half, naming the card", () => {
  const rule = { ...structuredClone(loadMutations()["seam-gap"]), family: "no-such-family", recordedBy: "NE-99j" };
  const r = runMutation("pending", rule, { root: ROOT });
  assert.equal(r.fixture, "pending");
  assert.match(r.detail.join("\n"), /NE-99j records it/);
  assert.equal(r.js, "killed", "the JS half is still enforced");
});

test("a drifted anchor is an error, never a survivor or a kill", () => {
  const rule = structuredClone(loadMutations()["seam-gap"]);
  rule.patch.find = "export const SEAM_GAP_SEC = 9.9;";
  const r = runMutation("drift", rule, { root: ROOT });
  assert.equal(r.js, "error");
  assert.equal(r.killed, false);
});
