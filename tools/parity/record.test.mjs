/* The parity recorder (tools/parity/record.mjs, NE-03 plan §6.3).

   Three promises, each tested against a scratch copy of the harness so the
   real fixtures are never written by a test:

     1. --check is red on any fixture the JS no longer agrees with — including
        a hand-edited expect — and it runs in npm test (the first test below
        IS `record.mjs --check` over the real tree, in-process).
     2. Recording never overwrites an authored case, and every new or changed
        case is reported as Swift work the SAME change carries: NE-39s (M3)
        burned swift-pending.json and unported.json to nothing and deleted
        them, so nothing can be owed, --port-card and --classify are refused,
        and a retired list back on disk is a --check problem. A-63 did the
        same to the JVM's books: jvm-pending.json holds "runs" only,
        --jvm-card is refused, and books that owe are a --check problem.
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
import { checkAll, record, runMutation, loadMutations, stableJson, main, CLASSIFY_RETIRED } from "./record.mjs";
import { loadFixtures } from "../../player/parity/runner.js";
import { CARD_RE } from "../../player/parity/coverage.js";

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
  /* The engine target (prepare, prepare-narration) names no `module`: it runs
     player/parity/reference-engine.js, so that file's imports are seeded too
     (NE-45j: it reads PREFETCH_LEAD_SEC from html-audio-backend.js, which no
     fixture's module reaches). */
  const modules = withImports([
    ...loadFixtures(ROOT).map((fx) => fx.doc.module).filter(Boolean),
    "player/parity/reference-engine.js",
  ]);
  for (const rel of ["player/package.json", "player/seam-gap.test.js", ...modules]) copy(rel);
  /* NE-29j: `$foray: "<id>"` reads the committed Foray from data/, and the
     committed-Foray adapter (player/parity/forays.js) builds it against the
     other two documents, or against the frozen fixture's three. */
  for (const dir of ["data", "tools/foray/fixtures/frozen/data"]) {
    for (const name of ["forays", "segments", "segment-sources"]) copy(`${dir}/${name}.json`);
  }
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
    const manifestBefore = fs.readFileSync(path.join(root, "player/parity/manifest.json"), "utf8");
    const r = await record({ root, log: quiet });
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some((x) => /seam-gap\/rule-is-0\.5s is AUTHORED/.test(x)), r.refusals.join("\n"));
    assert.equal(fs.readFileSync(path.join(root, FIXTURE), "utf8"), before, "the fixture is untouched");
    assert.equal(fs.readFileSync(path.join(root, "player/parity/manifest.json"), "utf8"), manifestBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recording a new case writes its expect and reports it as Swift work this change carries; a --port-card is refused (NE-39s)", async () => {
  /* NE-39s deleted swift-pending.json: a new case is no longer handed to a
     later Swift card, it is engine-parity's to run in this change. MUTATION:
     let record() write swift-pending.json again -> the file assertion fails;
     accept --port-card again -> the refusal assertion fails. */
  const root = scratch();
  try {
    const doc = readJ(root, FIXTURE);
    doc.cases.push({ id: "seam-gap/brand-new", covers: [], call: "seamGapSec", args: [{ from: { $seg: ["a"] }, to: { $seg: ["b"] }, gapSec: 1.25 }] });
    writeJ(root, FIXTURE, doc);

    const refused = await record({ root, portCard: "NE-28s", log: quiet });
    assert.equal(refused.ok, false, "a --port-card has nowhere to write");
    assert.match(refused.refusals.join("\n"), /--port-card "NE-28s" was retired with swift-pending\.json by NE-39s/);

    // The JVM runs seam-gap too: the new case is JVM work this change carries (A-63), never owed.
    const jvmBefore = fs.readFileSync(path.join(root, "player/parity/jvm-pending.json"), "utf8");
    const r = await record({ root, log: quiet });
    assert.equal(r.ok, true, r.refusals.join("\n"));
    assert.deepStrictEqual(r.swiftAffected, ["seam-gap/brand-new"]);
    assert.deepStrictEqual(r.jvmAffected, ["seam-gap/brand-new"]);
    for (const retired of ["swift-pending.json", "unported.json"]) {
      assert.equal(fs.existsSync(path.join(root, "player/parity", retired)), false, `record never writes ${retired}`);
    }
    assert.equal(fs.readFileSync(path.join(root, "player/parity/jvm-pending.json"), "utf8"), jvmBefore, "record never writes the JVM's books");
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
test("a jsOnly family records as Swift work for nobody, and must be jsOnly throughout", async () => {
  const root = scratch();
  const CONT = "player/parity/fixtures/continuation/continuation.json";
  try {
    const doc = readJ(root, CONT);
    assert.equal(doc.jsOnly, true, "precondition: the continuation family is JS-only");
    doc.cases.push({ id: "continuation/brand-new", covers: [], call: "canNext", args: [{ chain: [{}] }] });
    writeJ(root, CONT, doc);

    const r = await record({ root, log: quiet });
    assert.equal(r.ok, true, r.refusals.join("\n"));
    assert.deepStrictEqual(r.swiftAffected, []);
    assert.deepStrictEqual(r.jsOnlyRecorded, ["continuation/brand-new"]);
    assert.deepStrictEqual(readJ(root, CONT).cases.at(-1).expect, { return: true });
    assert.deepStrictEqual((await checkAll({ root })).problems, []);

    // Half a family JS-only would hide its ported half from the Swift runner.
    writeJ(root, "player/parity/fixtures/continuation/second.json", { family: "continuation", module: "player/continuation.js", cases: [{ id: "continuation/second", covers: [], read: "CHAIN_HOPS" }] });
    assert.ok((await checkAll({ root })).problems.some((p) => /jsOnly disagrees with another file of family "continuation"/.test(p)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a JS change to a recorded (non-authored) case re-records it and reports it for the Swift port in the same change", async () => {
  const root = scratch();
  try {
    const mod = path.join(root, "player", "seam-gap.js");
    // A rule change: bridged seams get the beat too. Not an authored case.
    fs.writeFileSync(mod, fs.readFileSync(mod, "utf8").replace("  if (bridged) return 0;\n", ""));
    // The JVM runs seam-gap too: the re-recorded case is the JVM port this change carries (A-63).
    const r = await record({ root, log: quiet });
    assert.equal(r.ok, true, r.refusals.join("\n"));
    assert.deepStrictEqual(r.swiftAffected, ["seam-gap/bridged-no-beat"]);
    assert.deepStrictEqual(r.jvmAffected, ["seam-gap/bridged-no-beat"]);
    assert.equal(fs.existsSync(path.join(root, "player/parity/swift-pending.json")), false, "nothing is owed: no list to put it in");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("re-recording an unchanged tree changes no byte", async () => {
  const root = scratch();
  try {
    const files = ["player/parity/manifest.json", "player/parity/jvm-pending.json", "player/parity/floors.json", FIXTURE];
    const before = files.map((f) => fs.readFileSync(path.join(root, f), "utf8"));
    const r = await record({ root, log: quiet });
    assert.equal(r.ok, true, r.refusals.join("\n"));
    assert.deepStrictEqual(files.map((f) => fs.readFileSync(path.join(root, f), "utf8")), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recording one family never vouches for another: its authored cases are still reported on their own run", async () => {
  /* NE-07j found this. `--family queue-state` wrote the WHOLE tree's manifest,
     including the not-yet-recorded rate family's ids; the rate run then read
     those ids as already recorded, and an authored case (which never needs a
     re-record, so is reported only when its id is new) was left out of what
     the record handed on: to swift-pending then, to the Swift runner's change
     and the JVM's books now (NE-39s).
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

    // A-63: a brand-new family carries its JVM runner; until it is in "runs", --check says so.
    const r = await record({ root, family: fam, log: quiet });
    assert.equal(r.ok, true, r.refusals.join("\n"));
    assert.deepStrictEqual([...r.swiftAffected].sort(), [`${fam}/max`, `${fam}/snap`], "the authored case is reported too");
    assert.match((await checkAll({ root })).problems.join("\n"), new RegExp(`jvm-pending: family ${fam} is recorded but the JVM does not run it`));
    const books = readJ(root, "player/parity/jvm-pending.json");
    writeJ(root, "player/parity/jvm-pending.json", { ...books, runs: [...books.runs, fam].sort() });
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
    const r = await record({ root, log: quiet });
    assert.equal(r.ok, false);
    assert.match(r.refusals.join("\n"), /below its floor/);
    const lowered = await record({ root, lowerFloors: true, log: quiet });
    assert.equal(lowered.ok, true, lowered.refusals.join("\n"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("NE-39s: any --port-card is refused, a card id or not, and nothing is written", async () => {
  const root = scratch();
  try {
    const manifestBefore = fs.readFileSync(path.join(root, "player/parity/manifest.json"), "utf8");
    for (const card of ["later", "NE-39s"]) {
      const r = await record({ root, portCard: card, log: quiet });
      assert.equal(r.ok, false);
      assert.match(r.refusals.join("\n"), /was retired with swift-pending\.json by NE-39s/);
    }
    assert.equal(fs.readFileSync(path.join(root, "player/parity/manifest.json"), "utf8"), manifestBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("NE-39s: a retired burn-down list back on disk is a --check problem, and --classify is refused", async () => {
  /* The lists are gone for good: one that comes back would owe again, and no
     gate reads it (coverage.js loads both as empty; the Swift loader refuses to
     run). MUTATION: drop the retiredBooksOnDisk loop from checkAll -> red; let
     --classify write unported.json again -> red. */
  const root = scratch();
  try {
    assert.deepStrictEqual((await checkAll({ root })).problems, [], "precondition: the scratch tree is clean");
    for (const retired of ["swift-pending.json", "unported.json"]) {
      writeJ(root, `player/parity/${retired}`, {});
      assert.ok((await checkAll({ root })).problems.some((p) => p.startsWith(`${retired} is back on disk: NE-39s retired it`)), retired);
      fs.rmSync(path.join(root, "player/parity", retired));
    }
    const said = [];
    assert.equal(await main(["--classify"], { root, log: quiet, err: (m) => said.push(m) }), 1);
    assert.deepStrictEqual(said, [CLASSIFY_RETIRED]);
    assert.equal(fs.existsSync(path.join(root, "player/parity/unported.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- the JVM's books (A-22, retired to "runs" by A-63) ---------- */

/* jvm-pending.json kept the JVM parity runner's books the way swift-pending.json
   kept the Swift one's until NE-39s: a family the JVM did not run was owed whole,
   and a JS rule change handed an Android card a list (--jvm-card). A-63 ported
   the last owed family and case and retired owing: the file holds "runs" only,
   every recorded family that is not jsOnly is in it, and a record never writes it.
   MUTATION: accept --jvm-card again, or let record() write the books -> the first
   test fails; drop the retired-key problem from loadJvmPending -> the second; drop
   the partition loop from checkJvmPending -> the third. */
const NUMBER_FORMAT = "player/parity/fixtures/number-format/number-format.json";
const JVM = "player/parity/jvm-pending.json";

test("A-63: --jvm-card is refused, a record never writes the JVM's books, and a case new in a family the JVM runs is JVM work this change carries", async () => {
  const root = scratch();
  try {
    assert.deepStrictEqual(Object.keys(readJ(root, JVM)).filter((k) => !k.startsWith("//")), ["runs"], "precondition: the books hold runs only");
    assert.ok(readJ(root, JVM).runs.includes("number-format"), "precondition: the JVM runs number-format");
    const before = fs.readFileSync(path.join(root, JVM), "utf8");

    const nf = readJ(root, NUMBER_FORMAT);
    nf.cases.push({ id: "number-format/brand-new-2.5", covers: [], call: "jsonNumber", args: [2.5] });
    writeJ(root, NUMBER_FORMAT, nf);
    for (const card of ["A-63", "NE-10s"]) {
      const refused = await record({ root, jvmCard: card, log: quiet });
      assert.equal(refused.ok, false);
      assert.match(refused.refusals.join("\n"), new RegExp(`--jvm-card "${card}" was retired with the JVM's owed books by A-63`));
    }

    const said = [];
    const r = await record({ root, log: (m) => said.push(m) });
    assert.equal(r.ok, true, r.refusals.join("\n"));
    assert.deepStrictEqual(r.jvmAffected, ["number-format/brand-new-2.5"]);
    assert.ok(said.some((m) => /jvm: 1 id\(s\) new or changed; android-build's JVM runner holds this change to them/.test(m)), said.join("\n"));
    assert.equal(fs.readFileSync(path.join(root, JVM), "utf8"), before, "the books do not move");
    assert.deepStrictEqual((await checkAll({ root })).problems, [], "nothing is owed, so nothing is out of balance");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A-63: --check is red on JVM books that owe anything again: a families or cases key (even empty), or an unknown key", async () => {
  const root = scratch();
  try {
    const books = readJ(root, JVM);
    assert.deepStrictEqual((await checkAll({ root })).problems, [], "precondition: the scratch tree is clean");
    for (const key of ["families", "cases"]) {
      for (const value of [{}, { "number-format/zero": "A-63" }]) {
        writeJ(root, JVM, { ...books, [key]: value });
        const problems = (await checkAll({ root })).problems.join("\n");
        assert.match(problems, new RegExp(`jvm-pending: "${key}" is back: A-63 retired owing to the JVM`), `${key} = ${JSON.stringify(value)}`);
        const r = await record({ root, log: quiet });
        assert.equal(r.ok, false, "a record refuses books that owe, too");
      }
    }
    writeJ(root, JVM, { ...books, owed: {} });
    assert.match((await checkAll({ root })).problems.join("\n"), /jvm-pending: unknown key "owed"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("--check holds every recorded family that is not jsOnly to the JVM's runs, and runs to recorded, non-jsOnly families", async () => {
  /* Without "runs" the JS side could not tell a family the JVM runs from one nobody
     ports, so a family recorded with no JVM runner would merge with ci.yml green and
     only the (non-required) android-build red. */
  const root = scratch();
  try {
    const jvm = readJ(root, JVM);
    assert.ok(jvm.runs.includes("default-voice") && jvm.runs.includes("compare"), "precondition: the JVM runs default-voice and compare");
    writeJ(root, JVM, { ...jvm, runs: [...jvm.runs.filter((f) => f !== "default-voice"), "continuation", "no-such-family"] });
    const problems = (await checkAll({ root })).problems.join("\n");
    assert.match(problems, /jvm-pending: family default-voice is recorded but the JVM does not run it: A-63 retired owing/);
    assert.match(problems, /jvm-pending: "runs" lists family continuation, which is jsOnly/);
    assert.match(problems, /jvm-pending: "runs" lists family no-such-family, which is not recorded/);
    assert.doesNotMatch(problems, /family compare/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- --mutate ---------- */

test("the seven named mutation rules exist, and each anchor occurs exactly once in its file", () => {
  const rules = loadMutations();
  assert.deepStrictEqual(Object.keys(rules), ["seam-gap", "never-early", "15/30", "pause-silence", "warm-across", "route-listener", "stale-load"]);
  for (const [name, r] of Object.entries(rules)) {
    const src = fs.readFileSync(path.join(ROOT, r.patch.file), "utf8");
    assert.equal(src.split(r.patch.find).length - 1, 1, `${name}: anchor drifted in ${r.patch.file}`);
    assert.notEqual(r.patch.find, r.patch.replace, name);
    assert.match(r.recordedBy, CARD_RE, name);
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

test("--mutate on the warm-across rule fails both the original JS test and the prepare-narration family", () => {
  /* NE-45j's acceptance: --mutate back to the beat rule turns a clip -> line
     case red. The mutant warms only a segment-to-segment seam, so the rendered
     line after a clip is not prepared (queue-manager.test.js) and neither the
     authored clip -> line -> clip seams nor the warmsAcross rows hold.
     MUTATION: drop every clip -> line case from prepare-narration ->
     "fixture: ... still pass". */
  const r = runMutation("warm-across", loadMutations()["warm-across"], { root: ROOT });
  assert.equal(r.js, "killed", r.detail.join("\n"));
  assert.equal(r.fixture, "killed", r.detail.join("\n"));
  assert.equal(r.killed, true);
});

test("--mutate on the route-listener rule fails both the original JS test and the route-resume family", () => {
  /* NE-38rj's acceptance: the founder's Q5 rule (a listener's pause is never
     resumed) is held by a case, not only by a sentence. The mutant is main's
     EngineCore.onRoute guard before NE-38rs, which lets a listener's pause
     through; the authored decide-listener-paused case turns red, as does
     route-resume.test.js. MUTATION: drop that authored case and the replay
     case beside it -> "fixture: ... still pass". */
  const r = runMutation("route-listener", loadMutations()["route-listener"], { root: ROOT });
  assert.equal(r.js, "killed", r.detail.join("\n"));
  assert.equal(r.fixture, "killed", r.detail.join("\n"));
  assert.equal(r.killed, true);
});

test("--mutate on the stale-load rule fails both the original JS test and the manager-await family", () => {
  /* NE-39j recorded player-core-9 as a manager-remainder case; NE-39s moved it
     to the jsOnly manager-await family (a load parked on the synthesiser's
     pause exists only where that pause is awaited), so the case still holds the
     rule beside queue-manager.test.js: without the stale-target check the first
     skip's load (s1) runs after the second's (s2), and the recorded op log
     loses its single load:s2@400. MUTATION: drop the
     a-skip-load-a-newer-skip-replaced-is-dropped case -> "fixture: ... still pass". */
  const r = runMutation("stale-load", loadMutations()["stale-load"], { root: ROOT });
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
