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
import { loadFixtures } from "../../player/parity/runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Repo-relative module paths plus everything they import relatively,
    transitively. NE-10j's rows adapter (player/parity/rows.js) reaches three
    player modules, one of which imports a fourth, and NE-12j's media-episode
    family reaches player/media-session.js, which imports foray-queue.js,
    which imports seek-policy.js (and its adapter,
    player/parity/media-actions.js, imports media-session.js): copying only
    each fixture's `module` left a scratch tree whose whole-tree record could
    not run a single rows or media-episode case. Static
    `import ... from "./x.js"` / `export ... from` is the only shape the
    player modules use. */
function withImports(rels) {
  const out = new Set();
  const todo = [...rels];
  while (todo.length) {
    const rel = todo.pop();
    if (out.has(rel)) continue;
    out.add(rel);
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/gm)) {
      todo.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
  }
  return out;
}

/** A scratch repo holding what the recorded families need: every fixture
    file's module and its imports (read from the fixtures, so a new family
    cannot make a whole-tree record in here fail on a module nobody copied),
    the ESM marker, the seam-gap suite, and the whole parity directory. */
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-rec-"));
  const copy = (rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(root, rel));
  };
  const modules = withImports(loadFixtures(ROOT).map((fx) => fx.doc.module).filter(Boolean));
  for (const rel of ["player/package.json", "player/seam-gap.test.js", ...modules]) copy(rel);
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
    fs.writeFileSync(mod, fs.readFileSync(mod, "utf8").replace("export const SEAM_GAP_SEC = 0.5;", "export const SEAM_GAP_SEC = 2.5;"));
    const before = fs.readFileSync(path.join(root, FIXTURE), "utf8");
    const pendingBefore = fs.readFileSync(path.join(root, "player/parity/swift-pending.json"), "utf8");
    const r = await record({ root, portCard: "NE-28s", log: quiet });
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some((x) => /seam-gap\/rule-is-0\.5s is AUTHORED/.test(x)), r.refusals.join("\n"));
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

/* NE-13 (plan §5.5 C-2): the continuation hops are computed by the page and
   only walked by the engine, so their family is ported by nobody. Without the
   flag the recorder would hand its ids to some Swift card forever, and the
   capability gate would never let "continuation" ship. */
test("a jsOnly family records with no port card, owes swift-pending nothing, and must be jsOnly throughout", async () => {
  const root = scratch();
  const CONT = "player/parity/fixtures/continuation/continuation.json";
  try {
    const doc = readJ(root, CONT);
    assert.equal(doc.jsOnly, true, "precondition: the continuation family is JS-only");
    doc.cases.push({ id: "continuation/brand-new", covers: [], call: "canNext", args: [{ chain: [{}] }] });
    writeJ(root, CONT, doc);
    const pendingBefore = fs.readFileSync(path.join(root, "player/parity/swift-pending.json"), "utf8");

    const r = await record({ root, log: quiet });
    assert.equal(r.ok, true, r.refusals.join("\n"));
    assert.deepStrictEqual(r.pendingAdded, []);
    assert.deepStrictEqual(r.jsOnlyRecorded, ["continuation/brand-new"]);
    assert.equal(fs.readFileSync(path.join(root, "player/parity/swift-pending.json"), "utf8"), pendingBefore);
    assert.deepStrictEqual(readJ(root, CONT).cases.at(-1).expect, { return: true });
    assert.deepStrictEqual((await checkAll({ root })).problems, []);

    // A pending entry naming a JS-only case is a stale promise no card can keep.
    writeJ(root, "player/parity/swift-pending.json", { ...readJ(root, "player/parity/swift-pending.json"), "continuation/brand-new": "NE-14s" });
    assert.ok((await checkAll({ root })).problems.some((p) => /continuation\/brand-new is in a jsOnly family/.test(p)));

    // Half a family JS-only would hide its ported half from swift-pending.
    writeJ(root, "player/parity/fixtures/continuation/second.json", { family: "continuation", module: "player/continuation.js", cases: [{ id: "continuation/second", covers: [], read: "CHAIN_HOPS" }] });
    assert.ok((await checkAll({ root })).problems.some((p) => /jsOnly disagrees with another file of family "continuation"/.test(p)));
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

test("recording one family never vouches for another: its authored cases still reach swift-pending on their own run", async () => {
  /* NE-07j found this. `--family queue-state` wrote the WHOLE tree's manifest,
     including the not-yet-recorded rate family's ids; the rate run then read
     those ids as already recorded, and an authored case (which never needs a
     re-record, so is pending only when its id is new) was left out of
     swift-pending. The Swift runner fails on an id that is neither executed
     nor pending, so that is a red Swift build handed to the port card.
     MUTATION: drop the `if (family)` block after computeManifest in record(). */
  const root = scratch();
  try {
    const fam = "probe";
    fs.mkdirSync(path.join(root, "player/parity/fixtures", fam), { recursive: true });
    writeJ(root, `player/parity/fixtures/${fam}/${fam}.json`, {
      family: fam,
      module: "player/playback-rate.js",
      cases: [
        { id: `${fam}/max`, covers: [], authored: true, read: "MAX_RATE", expect: { value: 2 } },
        { id: `${fam}/snap`, covers: [], call: "normalizeRate", args: [1.6] },
      ],
    });
    const first = await record({ root, family: "seam-gap", log: quiet });
    assert.equal(first.ok, true, first.refusals.join("\n"));
    assert.equal(readJ(root, "player/parity/manifest.json").families[fam], undefined,
      "a seam-gap run must not write the probe family's ids into the manifest");

    const r = await record({ root, family: fam, portCard: "NE-09", log: quiet });
    assert.equal(r.ok, true, r.refusals.join("\n"));
    assert.deepStrictEqual([...r.pendingAdded].sort(), [`${fam}/max`, `${fam}/snap`]);
    const pending = readJ(root, "player/parity/swift-pending.json");
    assert.equal(pending[`${fam}/max`], "NE-09", "the authored case is owed to the port card too");
    assert.deepStrictEqual((await checkAll({ root })).problems, []);
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

test("--mutate on the 15/30 rule fails both the original JS test and the media-episode family", () => {
  /* NE-12j recorded media-episode, so the fixture half of this rule stopped
     reporting PENDING: WebKit's 10 s forward step now turns the authored
     seek-forward-is-30 read and every recorded seekforward press red, not only
     media-session.test.js. MUTATION: drop the seekforward cases and the
     authored read from media-episode -> "fixture: ... still pass". */
  const r = runMutation("15/30", loadMutations()["15/30"], { root: ROOT });
  assert.equal(r.js, "killed", r.detail.join("\n"));
  assert.equal(r.fixture, "killed", r.detail.join("\n"));
  assert.equal(r.killed, true);
});

test("--mutate on the never-early rule fails both the original JS test and the deck-episode family", () => {
  /* NE-14j recorded deck-episode, so the fixture half stopped reporting
     PENDING: a fine wake that stops half a second short turns the authored
     wake cases red as well as html-audio-backend.test.js. MUTATION: drop the
     authored fineWakeAction cases from deck-episode -> "fixture: ... still pass". */
  const r = runMutation("never-early", loadMutations()["never-early"], { root: ROOT });
  assert.equal(r.js, "killed", r.detail.join("\n"));
  assert.equal(r.fixture, "killed", r.detail.join("\n"));
  assert.equal(r.killed, true);
});

test("--mutate on the pause-silence rule fails both the original JS test and the manager-episode family", () => {
  /* NE-14j recorded manager-episode. The mutant trusts the reducer and leaves
     an audible element playing behind a paused machine; the
     pause-silences-an-audible-element scenario loses its `pause`. MUTATION:
     delete that scenario -> "fixture: ... still pass". */
  const r = runMutation("pause-silence", loadMutations()["pause-silence"], { root: ROOT });
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
