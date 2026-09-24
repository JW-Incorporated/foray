/* The parity coverage guard (NE-03, plan §6.5-6.6).

   WHY THIS EXISTS. The native engine reimplements rules that today live only
   in JS tests. A rule the Swift side never heard of is not a failing test — it
   is a missing one, and nothing goes red. So every top-level test() in the
   fifteen covered suites (player/parity/coverage.js COVERED_SUITES) must be
   accounted for: fixtured (a case's covers[]), mapped to a named XCTest,
   excluded with a closed reason, or owed in unported.json with a card. Adding
   a test to a covered suite therefore turns this red until someone decides
   which of the four it is — which is the point.

   The same file enforces the bookkeeping that makes those lists honest:
   manifest hashes match the fixture bytes, every pending/unported/xctest entry
   names something that exists, every family is charged to a capability, a
   capability the engine advertises has nothing owed, and the recorded floors
   hold. Every check below names the mutation that turns it red. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, loadFixtures } from "./runner.js";
import {
  COVERED_SUITES, EXCLUSION_REASONS, CARD_RE, classify, loadParityData, computeManifest, xctestProblems,
  swiftTestMethods, topLevelTests, capabilityFamilies, capabilityGate, advertisedCapabilities, counts,
  readCoveredSuites,
} from "./coverage.js";

const DATA = loadParityData(REPO_ROOT);
const FIXTURES = loadFixtures(REPO_ROOT);

/* ---------- the guard itself ---------- */

test("every top-level test in the fifteen covered suites is accounted for exactly once", () => {
  // MUTATION: add `test("x", () => {})` to seam-gap.test.js -> red, naming it
  // (the same check, on a scratch copy, is the next test).
  const { problems } = classify(REPO_ROOT, DATA, FIXTURES);
  assert.deepStrictEqual(problems, [], problems.slice(0, 20).join("\n"));
});

test("a new, unmapped test() in a covered suite turns the guard red and names it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-cov-"));
  try {
    fs.mkdirSync(path.join(root, "player"), { recursive: true });
    const src = fs.readFileSync(path.join(REPO_ROOT, "player", "seam-gap.test.js"), "utf8");
    fs.writeFileSync(path.join(root, "player", "seam-gap.test.js"), src);
    // Only seam-gap is on the scratch disk, so only seam-gap's entries are read:
    // its exclusions and its family's cases. Every other family's covers[] would
    // name a suite this disk does not hold (NE-07j added the first two).
    const seamOnly = { ...DATA, unported: {}, xctest: {}, exclusions: { "seam-gap": DATA.exclusions["seam-gap"] } };
    const seamFixtures = FIXTURES.filter((f) => f.family === "seam-gap");
    const suites = { "seam-gap": readCoveredSuites(root)["seam-gap"] };
    const before = classify(root, seamOnly, seamFixtures, suites).problems;
    assert.deepStrictEqual(before, [], "the scratch copy starts clean");

    fs.writeFileSync(path.join(root, "player", "seam-gap.test.js"), src + '\ntest("a brand-new seam rule", () => {});\n');
    const after = classify(root, seamOnly, seamFixtures, { "seam-gap": readCoveredSuites(root)["seam-gap"] }).problems;
    assert.equal(after.length, 1, after.join("\n"));
    assert.match(after[0], /"a brand-new seam rule" is in no case's covers\[\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a test accounted for twice is a stale list, not extra safety", () => {
  // Owed AND ported means the burn-down forgot to burn; the count lies.
  const [stem, names] = Object.entries(DATA.exclusions).find(([k]) => !k.startsWith("//"));
  const name = Object.keys(names)[0];
  const data = { ...DATA, unported: { ...DATA.unported, [stem]: { ...(DATA.unported[stem] ?? {}), [name]: { card: "NE-28j", family: "seam-gap" } } } };
  const { problems } = classify(REPO_ROOT, data, FIXTURES);
  assert.ok(problems.some((p) => p.includes(JSON.stringify(name)) && /excluded \+ unported/.test(p)), problems.join("\n"));
});

test("an entry that names no real test is refused — pending and unported ids exist", () => {
  const data = { ...DATA, unported: { ...DATA.unported, "seam-gap": { "a test nobody wrote": { card: "NE-28j", family: "seam-gap" } } } };
  assert.ok(classify(REPO_ROOT, data, FIXTURES).problems.some((p) => /no top-level test named "a test nobody wrote"/.test(p)));
  const bogus = { ...DATA, exclusions: { "not-a-suite": { x: { reason: "text-pin", why: "long enough why" } } } };
  assert.ok(classify(REPO_ROOT, bogus, FIXTURES).problems.some((p) => /"not-a-suite" is not a covered suite/.test(p)));
});

test("exclusions carry a closed reason and a sentence; unported entries carry a card and a family", () => {
  assert.deepStrictEqual([...EXCLUSION_REASONS], ["webview-only", "dom-only", "text-pin", "js-module-shape"]);
  const bad = { ...DATA, exclusions: { "seam-gap": { "every refusal explains itself differently": { reason: "boring", why: "x" } } } };
  const p = classify(REPO_ROOT, bad, FIXTURES).problems.join("\n");
  assert.match(p, /reason "boring" is not one of/);
  assert.match(p, /an exclusion says why/);
  for (const [stem, names] of Object.entries(DATA.unported)) {
    if (stem.startsWith("//")) continue;
    for (const [name, v] of Object.entries(names)) {
      assert.match(v.card, CARD_RE, `${stem}::${name}`);
      assert.equal(typeof v.family, "string", `${stem}::${name}`);
    }
  }
});

test("the fifteen covered suites are the plan's fifteen, and each not-yet-written one names its card", () => {
  assert.deepStrictEqual(Object.keys(COVERED_SUITES).sort(), [
    "continuation", "foray-playback", "foray-progress", "html-audio-backend", "interlude", "media-session",
    "playback-rate", "position-store", "queue-manager", "queue-state", "seam-gap", "seek-policy",
    "transport-policy", "transport-reconcile", "tts-bridge",
  ]);
  for (const [stem, cfg] of Object.entries(COVERED_SUITES)) {
    assert.match(cfg.card, CARD_RE, stem);
    if (cfg.awaiting) assert.match(cfg.awaiting, CARD_RE, stem);
  }
});

/** Suites whose recording card has landed: stem -> the family its tests were
    recorded into, and the card that did it. Such a suite is DONE on the JS
    side, so from then on it owes nothing — a new test() in it is fixtured (or
    excluded) in the same PR, which is plan §6's rule-change discipline (JS,
    re-record, then Swift), not parked in unported.json where the port card
    has already been and gone. Each j card appends its suites here. */
const RECORDED_SUITES = Object.freeze({
  "queue-state": { family: "queue-state", card: "NE-07j" },
  "playback-rate": { family: "rate", card: "NE-07j" },
  "continuation": { family: "continuation", card: "NE-13" },
});

test("a suite whose recording card has landed owes nothing, and is fixtured into its own family only", () => {
  // NE-07j's acceptance: zero unported entries for queue-state and
  // playback-rate. MUTATION: move one queue-state test from its case's covers[]
  // back into unported.json -> red; add a covers[] entry for a queue-state test
  // to a seam-gap case -> red (a reducer rule the rate or seam port would
  // silently own instead of NE-07s).
  const { status } = classify(REPO_ROOT, DATA, FIXTURES);
  for (const [stem, { family, card }] of Object.entries(RECORDED_SUITES)) {
    assert.ok(stem in COVERED_SUITES, `${stem} is not a covered suite`);
    assert.deepStrictEqual(Object.keys(DATA.unported[stem] ?? {}), [], `${stem} was recorded by ${card} and may owe nothing`);
    const names = Object.entries(status[stem]);
    assert.ok(names.length > 0, `${stem} has no tests on disk`);
    for (const [name, st] of names) {
      assert.ok(st.covered.length > 0 || st.excluded, `${stem} :: ${JSON.stringify(name)} is neither fixtured nor excluded`);
      for (const id of st.covered) assert.ok(id.startsWith(`${family}/`), `${stem} :: ${JSON.stringify(name)} is covered by ${id}, outside the ${family} family`);
    }
  }
});

/* media-session is the one suite recorded in two halves (plan §14): NE-12j
   classified all of it, fixturing the episode subset into media-episode, and
   left the Foray and narration tests for NE-29j to record into `media`. So it
   is not a RECORDED_SUITE — it still owes — but what it owes is fixed: only
   NE-29j's half, and only in the foray capability's family. */
test("media-session is wholly classified: media-episode, an exclusion, or NE-29j's Foray half — nothing else", () => {
  // NE-12j's acceptance. MUTATION: re-tag one unported media-session entry to
  // NE-12j / media-episode (what `record.mjs --classify` would give a new test)
  // -> red; add a media-session covers[] entry to a queue-state case -> red (a
  // lock-screen rule the reducer port would silently own instead of NE-12s).
  const { status } = classify(REPO_ROOT, DATA, FIXTURES);
  const names = Object.entries(status["media-session"]);
  assert.ok(names.length > 0, "media-session has no tests on disk");
  const tally = { fixtured: 0, excluded: 0, owed: 0 };
  for (const [name, st] of names) {
    const label = `media-session :: ${JSON.stringify(name)}`;
    if (st.covered.length) {
      tally.fixtured++;
      for (const id of st.covered) assert.ok(id.startsWith("media-episode/"), `${label} is covered by ${id}, outside media-episode`);
    } else if (st.excluded) tally.excluded++;
    else {
      assert.deepStrictEqual(st.unported, { card: "NE-29j", family: "media" }, `${label} must be fixtured, excluded, or NE-29j's`);
      tally.owed++;
    }
  }
  assert.ok(tally.fixtured > 0 && tally.excluded > 0 && tally.owed > 0, JSON.stringify(tally));
  // media-episode is charged to the episode capability and media to foray, so
  // the half NE-29j owes can never hold the episode capability back (plan §6.6).
  assert.ok(DATA.capabilities.episode.includes("media-episode"));
  assert.ok(DATA.capabilities.foray.includes("media") && !DATA.capabilities.episode.includes("media"));
});

test("the continuation capability owes nothing: its family is JS-only, so the gate would let it ship today", () => {
  // Plan §5.5 C-2: the page computes the hops, the engine walks them, and no
  // Swift card ports the rule. MUTATION: drop `"jsOnly": true` from the
  // continuation fixture and re-record with a --port-card -> its 48 ids land
  // in swift-pending and advertising "continuation" is refused.
  assert.ok(FIXTURES.filter((f) => f.family === "continuation").every((f) => f.doc.jsOnly === true));
  assert.deepStrictEqual(capabilityGate(new Map([["continuation", "a test"]]), DATA), []);
});

test("a suite that appears while still marked awaiting is refused, so it is never outside the guard", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-await-"));
  try {
    fs.mkdirSync(path.join(root, "player"), { recursive: true });
    /* A synthetic entry: the real awaiting suites land one by one (NE-13 made
       continuation.test.js real), and this refusal must outlive the last. */
    const covered = { ...COVERED_SUITES, hopper: { card: "NE-99", family: "continuation", awaiting: "NE-99" } };
    fs.writeFileSync(path.join(root, "player", "hopper.test.js"), 'test("hop", () => {});\n');
    const suites = { hopper: readCoveredSuites(root, { hopper: covered.hopper }).hopper };
    const { problems } = classify(root, DATA, FIXTURES, suites, covered);
    assert.ok(problems.some((p) => /still marks it awaiting NE-99/.test(p)), problems.join("\n"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- reading test names ---------- */

test("topLevelTests reads literal names, decodes escapes, and ignores nested test() calls", () => {
  const src = [
    'test("plain", () => {});',
    "test('single \\'quoted\\'', () => {});",
    "test(`template`, () => {});",
    'test("unicode \\u2014 dash", () => {});',
    '  test("indented is not top level", () => {});',
  ].join("\n");
  const { names, problems } = topLevelTests(src);
  assert.deepStrictEqual(names, ["plain", "single 'quoted'", "template", "unicode — dash"]);
  assert.deepStrictEqual(problems, []);
});

test("a computed or duplicated test name is a problem: the guard cannot map what it cannot name", () => {
  const { problems } = topLevelTests('test(`x ${y}`, () => {});\ntest(name, () => {});\ntest("a", f);\ntest("a", g);\n');
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.match(problems.join("\n"), /duplicate test name "a"/);
});

/* ---------- xctest: mappings ---------- */

test("every xctest: mapping names a test method the Swift sources declare", () => {
  assert.deepStrictEqual(xctestProblems(REPO_ROOT, DATA.xctest), []);
});

test("a mapping to a non-existent Swift method turns the guard red; a real one does not", () => {
  const name = "an unbridged segment-to-segment auto-advance gets the full beat";
  const ghost = { "seam-gap": { [name]: "xctest:ForayAudioPluginTests/testNoSuchMethod" } };
  assert.equal(xctestProblems(REPO_ROOT, ghost).length, 1);
  // Control: the grep can see a method that exists, so red above is not vacuous.
  const real = { "seam-gap": { [name]: "xctest:ForayAudioPluginTests/testPluginTypeExists" } };
  assert.deepStrictEqual(xctestProblems(REPO_ROOT, real), []);
});

test("the Swift grep attributes methods to their class and ignores non-test funcs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-swift-"));
  try {
    const f = path.join(dir, "T.swift");
    fs.writeFileSync(f, [
      "final class AlphaTests: XCTestCase {",
      "    func testOne() {}",
      "    func helper() {}",
      "}",
      "@MainActor final class BetaTests: XCTestCase {",
      "    @MainActor func testTwo() async throws {}",
      "}",
    ].join("\n"));
    assert.deepStrictEqual([...swiftTestMethods([f])].sort(), ["AlphaTests/testOne", "BetaTests/testTwo"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- the manifest ---------- */

test("the manifest's hashes and ids match the fixture bytes on disk", () => {
  // MUTATION: hand-edit any recorded expect -> the file's sha256 no longer
  // matches, and this is red until record.mjs re-records it (which also puts
  // the id into swift-pending.json).
  assert.deepStrictEqual(computeManifest(REPO_ROOT, FIXTURES), DATA.manifest);
});

test("every swift-pending id names a recorded case and is tagged with a card", () => {
  const ids = new Set(Object.values(DATA.manifest.families).flatMap((f) => f.ids));
  for (const [id, card] of Object.entries(DATA.pending)) {
    if (id.startsWith("//")) continue;
    assert.ok(ids.has(id), `${id} is pending but no fixture case has that id`);
    assert.match(card, CARD_RE, id);
  }
});

/* queue-manager and html-audio-backend were classified whole by NE-14j (plan
   §14): the episode rules fixtured into manager-episode and deck-episode (the
   episode capability's families), the WebView- and Node-only tests excluded
   with a reason, a few mapped to the AVDeck and click-track XCTests, and the
   rest OWED to the cards that record them — NE-30j and NE-31j into the foray
   capability's families (M2), NE-39j into manager-remainder (M3). So neither
   suite is a RECORDED_SUITE — they still owe — but what they owe is fixed, and
   none of it is charged to the episode capability, which ships in M1. */
const MANAGER_DECK_OWED = Object.freeze({
  "queue-manager": { fixtured: "manager-episode", owed: [
    { card: "NE-30j", family: "manager-foray" },
    { card: "NE-31j", family: "manager-foray" },
    { card: "NE-39j", family: "manager-remainder" },
  ] },
  "html-audio-backend": { fixtured: "deck-episode", owed: [{ card: "NE-30j", family: "deck" }] },
});

test("queue-manager and html-audio-backend are wholly classified, and owe the episode capability nothing", () => {
  // NE-14j's acceptance. MUTATION: re-tag one unported queue-manager entry to
  // NE-14j / manager-episode (what `record.mjs --classify` gives a new test) ->
  // red; add a queue-manager covers[] entry to a deck-episode case -> red.
  const { status } = classify(REPO_ROOT, DATA, FIXTURES);
  for (const [stem, { fixtured, owed }] of Object.entries(MANAGER_DECK_OWED)) {
    const names = Object.entries(status[stem]);
    assert.ok(names.length > 0, `${stem} has no tests on disk`);
    const tally = { fixtured: 0, excluded: 0, xctest: 0, owed: 0 };
    for (const [name, st] of names) {
      const label = `${stem} :: ${JSON.stringify(name)}`;
      if (st.covered.length) {
        tally.fixtured++;
        for (const id of st.covered) assert.ok(id.startsWith(`${fixtured}/`), `${label} is covered by ${id}, outside ${fixtured}`);
      } else if (st.excluded) tally.excluded++;
      else if (st.xctest) tally.xctest++;
      else {
        assert.ok(owed.some((o) => o.card === st.unported?.card && o.family === st.unported?.family),
          `${label} is owed as ${JSON.stringify(st.unported)}; it must be fixtured, excluded, mapped, or one of ${JSON.stringify(owed)}`);
        assert.ok(!DATA.capabilities.episode.includes(st.unported.family), `${label} is owed to the episode capability`);
        tally.owed++;
      }
    }
    assert.ok(tally.fixtured > 0 && tally.excluded > 0 && tally.owed > 0, `${stem}: ${JSON.stringify(tally)}`);
  }
  assert.ok(DATA.capabilities.episode.includes("manager-episode") && DATA.capabilities.episode.includes("deck-episode"));
});

/* ---------- families and capabilities ---------- */

test("every family a fixture, an unported entry or a pending id uses is charged to a capability", () => {
  const charged = capabilityFamilies(DATA.capabilities);
  const used = new Set([
    ...FIXTURES.map((f) => f.family),
    ...Object.entries(DATA.unported).filter(([k]) => !k.startsWith("//")).flatMap(([, n]) => Object.values(n).map((v) => v.family)),
    ...Object.keys(DATA.pending).filter((k) => !k.startsWith("//")).map((id) => id.split("/")[0]),
    ...Object.values(COVERED_SUITES).map((c) => c.family),
  ]);
  const loose = [...used].filter((f) => !charged.has(f));
  assert.deepStrictEqual(loose, [], "a family no capability names can hold owed work that no gate reads");
});

test("capabilities.json holds the plan §6.6 map", () => {
  assert.deepStrictEqual(Object.keys(DATA.capabilities).filter((k) => !k.startsWith("//")), ["episode", "continuation", "restore", "foray", "remainder"]);
  assert.ok(DATA.capabilities.foray.includes("seam-gap"));
  assert.ok(DATA.capabilities.episode.includes("manager-episode"));
  /* `remainder` (NE-14j) holds only the M3 manager remainder NE-39j owes, so the
     episode and foray capabilities never wait on it; nothing may ever advertise
     it. MUTATION: add "remainder" to the advertised list -> the next test's
     gate is red for as long as NE-39j owes anything. */
  assert.deepStrictEqual(DATA.capabilities.remainder, ["compare", "manager-remainder"]);
  assert.ok(!advertisedCapabilities(REPO_ROOT).has("remainder"), "the remainder is a bookkeeping gate, never a capability a build ships");
});

test("every capability the engine advertises has zero pending and zero unported entries", () => {
  // Read from mobile/ENGINE_DEFAULT.json and the Swift `advertisedCapabilities`
  // literal. Today neither exists, so nothing is advertised and this passes
  // trivially; the synthetic cases below are what prove it has teeth.
  const advertised = advertisedCapabilities(REPO_ROOT);
  assert.deepStrictEqual(capabilityGate(advertised, DATA), []);
});

test("advertising a capability with owed work is refused, naming the work", () => {
  const pendingSeam = { ...DATA, pending: { "seam-gap/rule-is-0.5s": "NE-05" }, unported: {} };
  const p1 = capabilityGate(new Map([["foray", "test"]]), pendingSeam);
  assert.equal(p1.length, 1);
  assert.match(p1[0], /1 swift-pending case/);
  const owed = { ...DATA, pending: {}, unported: { "queue-state": { "some rule": { card: "NE-07j", family: "queue-state" } } } };
  assert.match(capabilityGate(new Map([["episode", "test"]]), owed).join("\n"), /1 unported test/);
  assert.deepStrictEqual(capabilityGate(new Map([["continuation", "test"]]), owed), [], "another capability's owed work is not this one's");
  assert.match(capabilityGate(new Map([["teleport", "test"]]), DATA).join("\n"), /does not define/);
});

test("the advertised list is read from ENGINE_DEFAULT.json and from the Swift source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-cap-"));
  try {
    fs.mkdirSync(path.join(root, "mobile", "plugins", "foray-audio", "ios", "Sources"), { recursive: true });
    fs.writeFileSync(path.join(root, "mobile", "ENGINE_DEFAULT.json"), JSON.stringify({ mode: "native", capabilities: ["episode"] }));
    fs.writeFileSync(path.join(root, "mobile", "plugins", "foray-audio", "ios", "Sources", "E.swift"),
      'enum Engine { static let advertisedCapabilities: [String] = ["episode", "foray"] }\n');
    assert.deepStrictEqual([...advertisedCapabilities(root).keys()].sort(), ["episode", "foray"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- floors ---------- */

test("every fixture family holds its recorded floor, and every family has one", () => {
  // MUTATION: delete a case from the seam-gap fixture -> red (and --check is
  // red too, on the manifest). Welded to test/suite-integrity.test.js, which
  // reads the same floors.json.
  const { families } = counts({}, FIXTURES);
  for (const [fam, n] of Object.entries(families)) {
    assert.ok(fam in DATA.floors.families, `family ${fam} has no floor in floors.json (record it)`);
    assert.ok(n >= DATA.floors.families[fam], `family ${fam} has ${n} cases, below its floor of ${DATA.floors.families[fam]}`);
  }
});

test("every covered suite still has at least the test count the recorder last saw", () => {
  const { status } = classify(REPO_ROOT, DATA, FIXTURES);
  const { suites } = counts(status, FIXTURES);
  for (const [stem, floor] of Object.entries(DATA.floors.suites)) {
    assert.ok(stem in COVERED_SUITES, `${stem} is floored but not covered`);
    assert.ok(suites[stem].tests >= floor, `${stem} has ${suites[stem].tests} top-level tests, below the recorded ${floor}`);
  }
});
