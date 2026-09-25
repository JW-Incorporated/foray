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
  readCoveredSuites, facadeProblems, FACADE_MAPPED_SUITES, FACADE_SUITES,
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
    const seamOnly = { ...DATA, unported: {}, xctest: {}, facades: {}, exclusions: { "seam-gap": DATA.exclusions["seam-gap"] } };
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
test("media-session is wholly classified: media-episode, an exclusion, or NE-29j's Foray half (media) — nothing else, and nothing owed", () => {
  // NE-12j's acceptance, closed by NE-29j's ("media-session has zero unported
  // entries"). MUTATION: put one media-session test back in unported.json -> red;
  // add a media-session covers[] entry to a queue-state case -> red (a
  // lock-screen rule the reducer port would silently own instead of MediaMapping).
  const { status } = classify(REPO_ROOT, DATA, FIXTURES);
  const names = Object.entries(status["media-session"]);
  assert.ok(names.length > 0, "media-session has no tests on disk");
  const tally = { fixtured: 0, excluded: 0, owed: 0 };
  for (const [name, st] of names) {
    const label = `media-session :: ${JSON.stringify(name)}`;
    if (st.covered.length) {
      tally.fixtured++;
      for (const id of st.covered) assert.ok(id.startsWith("media-episode/") || id.startsWith("media/"), `${label} is covered by ${id}, outside media-episode and media`);
    } else if (st.excluded) tally.excluded++;
    else {
      assert.fail(`${label} must be fixtured or excluded; it is ${JSON.stringify(st.unported ?? "in no list")}`);
      tally.owed++;
    }
  }
  assert.ok(tally.fixtured > 0 && tally.excluded > 0 && tally.owed === 0, JSON.stringify(tally));
  // media-episode is charged to the episode capability and media to foray, so
  // the half NE-29j owes can never hold the episode capability back (plan §6.6).
  assert.ok(DATA.capabilities.episode.includes("media-episode"));
  assert.ok(DATA.capabilities.foray.includes("media") && !DATA.capabilities.episode.includes("media"));
});

test("seam-gap, interlude and seek-policy are wholly classified, own no unported entry, outpoint is recorded, and none of the four owes Swift anything", () => {
  // NE-28j's acceptance: "the guard shows zero unported entries for seam-gap,
  // interlude and seek-policy". MUTATION: put a seek-policy test back in
  // unported.json -> red; cover an interlude test from a seek-policy case -> red;
  // tag one outpoint id to another card in swift-pending.json -> red.
  const { status } = classify(REPO_ROOT, DATA, FIXTURES);
  const ownFamily = { "seam-gap": "seam-gap/", interlude: "interlude/", "seek-policy": "seek-policy/" };
  for (const [suite, prefix] of Object.entries(ownFamily)) {
    const names = Object.entries(status[suite]);
    assert.ok(names.length > 0, `${suite} has no tests on disk`);
    for (const [name, st] of names) {
      const label = `${suite} :: ${JSON.stringify(name)}`;
      if (st.covered.length) {
        /* The one frozen-Foray count is a rule over a real Foray: NE-29j
           recorded it into foray-structure, not into the interlude module's
           family. Nothing else may leave its own family. */
        const frozen = suite === "interlude" && name.startsWith("capital-types-1 (frozen)");
        for (const id of st.covered) {
          assert.ok(id.startsWith(frozen ? "foray-structure/" : prefix), `${label} is covered by ${id}, outside its own family`);
        }
      } else {
        assert.ok(st.excluded, `${label} must be fixtured or excluded`);
      }
    }
  }
  for (const fam of ["seam-gap", "interlude", "seek-policy", "outpoint"]) {
    const owedHere = Object.values(DATA.unported).flatMap((t) => Object.values(t ?? {})).filter((e) => e?.family === fam);
    assert.deepStrictEqual(owedHere, [], `${fam} has unported entries`);
    assert.ok(DATA.capabilities.foray.includes(fam), `${fam} is charged to the foray capability`);
  }
  const outpoint = FIXTURES.filter((f) => f.family === "outpoint").flatMap((f) => f.doc.cases);
  assert.ok(outpoint.some((c) => c.setup?.target === "deck"), "the outpoint family has op-log scenarios");
  // NE-28s burned the four families down: every case now runs in Swift, so
  // none may sit in swift-pending.json (plan §14, NE-28s acceptance: "zero
  // pending for every NE-28j family"). MUTATION: put one outpoint or
  // seek-policy id back in swift-pending.json -> red here (and the Swift
  // runner fails the stale entry as well).
  const recorded = FIXTURES.filter((f) => ["seam-gap", "interlude", "seek-policy", "outpoint"].includes(f.family))
    .flatMap((f) => f.doc.cases);
  assert.ok(recorded.length > 0, "the four families have fixtures");
  for (const c of recorded) {
    assert.equal(DATA.pending[c.id], undefined, `${c.id} is ported by NE-28s and must not be pending`);
  }
});

test("NE-29j/NE-29s: foray-progress and media-session owe nothing, the Foray families are ported (nothing pending) and default-voice is owed to NE-33, and 4a is never the artist of a committed Foray", () => {
  /* NE-29j's acceptance: "the families pass in JS and sit in swift-pending
     tagged NE-29s. media-session has zero unported entries. 'Never 4a as artist
     of anything audible' is an authored case over every committed Foray."
     NE-29s's acceptance: "equal counts and zero pending for foray-clock,
     foray-progress, foray-structure and media" — every case of the four now
     runs in Swift, so none may sit in swift-pending.json.
     MUTATION: put a foray-progress test back in unported.json -> red; put one
     foray-clock id back in swift-pending.json (any card) -> red; put one
     default-voice id back in swift-pending.json (NE-33 ported it) -> red; drop the never-4a case of one
     committed Foray (or un-author it) -> red. */
  const { status } = classify(REPO_ROOT, DATA, FIXTURES);
  for (const [name, st] of Object.entries(status["foray-progress"])) {
    const label = `foray-progress :: ${JSON.stringify(name)}`;
    assert.ok(st.covered.length > 0 || st.excluded, `${label} must be fixtured or excluded`);
    for (const id of st.covered) assert.ok(/^(foray-progress|resume-rules|rows)\//.test(id), `${label} is covered by ${id}`);
  }
  for (const stem of ["foray-progress", "media-session"]) {
    assert.deepStrictEqual(Object.keys(DATA.unported[stem] ?? {}), [], `${stem} owes unported.json nothing`);
  }
  const owedTo = { "foray-clock": null, "foray-progress": null, "foray-structure": null, media: null, "default-voice": null };
  for (const [fam, card] of Object.entries(owedTo)) {
    const cases = FIXTURES.filter((f) => f.family === fam).flatMap((f) => f.doc.cases);
    assert.ok(cases.length > 0, `${fam} is recorded`);
    for (const c of cases) {
      if (card) assert.equal(DATA.pending[c.id], card, `${c.id} must be owed to ${card} until the Swift port burns it down`);
      else assert.equal(DATA.pending[c.id], undefined, `${c.id} is ported (NE-29s; default-voice by NE-33) and must not be pending`);
    }
    assert.ok(DATA.capabilities.foray.includes(fam), `${fam} is charged to the foray capability`);
    const owedHere = Object.values(DATA.unported).flatMap((t) => Object.values(t ?? {})).filter((e) => e?.family === fam);
    assert.deepStrictEqual(owedHere, [], `${fam} has unported entries`);
  }
  /* Over the committed Forays as recorded (one case each, by $foray id). A
     publish that ADDS a Foray does not turn this red — that would block data
     publishes on a parity file — but its case should be added with the next
     parity change; a Foray removed from data/ fails its case loudly (E_BAD_MACRO). */
  const never4a = FIXTURES.filter((f) => f.family === "media").flatMap((f) => f.doc.cases).filter((c) => c.call === "appAsArtist");
  assert.ok(never4a.length >= 2, "at least two committed Forays carry the never-4a case");
  for (const c of never4a) {
    assert.equal(typeof c.args?.[0]?.$foray, "string", `${c.id} runs over a committed Foray by id`);
    assert.equal(c.authored, true, `${c.id} must be authored`);
    assert.deepStrictEqual(c.expect, { return: 0 }, `${c.id} must expect zero`);
  }
});

/** NE-31j's manager-foray files: the narration overlay, the jingle's clock
    and audition, ported by NE-31s rather than NE-30s. */
const NE31J_NARRATION_FILES = Object.freeze(["narration.json", "jingle.json", "audition.json"].map((f) => `player/parity/fixtures/manager-foray/${f}`));

test("NE-30j/NE-30s/NE-32: html-audio-backend and foray-playback owe nothing, the tape/deck/prepare families are burned down (NE-30s, and the pair's decisions by NE-32), and prepare is authored with its n.* tokens", () => {
  /* NE-30j's acceptance: "the families pass in JS (prepare against
     reference-engine). The guard shows zero unported entries for
     html-audio-backend and foray-playback, apart from those tagged NE-31j and
     NE-39j." MUTATION: put a foray-playback test back in unported.json -> red;
     put a manager-foray id back in swift-pending.json (NE-30s burned the tape,
     deck and prepare families down) -> red; un-author a
     prepare case, or strip its n.* tokens from the expect -> red; mark foray-data
     not jsOnly -> red (the page's build is never owed to Swift). */
  for (const stem of ["html-audio-backend", "foray-playback"]) {
    const owed = Object.entries(DATA.unported[stem] ?? {}).filter(([, v]) => !["NE-31j", "NE-39j"].includes(v.card));
    assert.deepStrictEqual(owed, [], `${stem} owes unported.json nothing outside NE-31j / NE-39j`);
  }
  for (const [stem, names] of Object.entries(DATA.unported)) {
    if (stem.startsWith("//")) continue;
    for (const [name, v] of Object.entries(names)) assert.notEqual(v.card, "NE-30j", `${stem} :: ${name} is still owed to NE-30j, the card that records it`);
  }
  /* NE-32 ported the pair's decisions (deck-pair.json), so nothing in these
     families is owed to any card. MUTATION: put a deck/ id back in
     swift-pending.json -> red. */
  for (const fam of ["manager-foray", "deck", "prepare"]) {
    // NE-31j's narration files are NE-31s's (its own test below).
    const files = FIXTURES.filter((f) => f.family === fam && !NE31J_NARRATION_FILES.includes(f.file));
    assert.ok(files.length > 0, `${fam} is recorded`);
    assert.ok(DATA.capabilities.foray.includes(fam), `${fam} is charged to the foray capability`);
    for (const f of files) for (const c of f.doc.cases) {
      assert.equal(DATA.pending[c.id], undefined, `${c.id}: nothing may owe it (NE-30s and NE-32 ported them)`);
    }
  }
  const prepare = FIXTURES.filter((f) => f.family === "prepare").flatMap((f) => f.doc.cases);
  for (const c of prepare) {
    assert.equal(c.authored, true, `${c.id} must be authored (plan §6: the prepare timing)`);
    assert.equal(c.setup?.target, "engine", `${c.id} runs against reference-engine`);
    assert.ok(c.expect.checkpoints.every((k) => typeof k.nowMs === "number"), `${c.id}: every checkpoint carries T`);
  }
  assert.ok(prepare.some((c) => c.expect.ops.some((o) => o.startsWith("n.handover:"))), "the prepare family asserts the native handover tokens");
  const data = FIXTURES.filter((f) => f.family === "foray-data");
  assert.ok(data.length > 0 && data.every((f) => f.doc.jsOnly === true), "foray-data is JS only");
  assert.ok(DATA.capabilities.foray.includes("foray-data"));
  for (const f of data) for (const c of f.doc.cases) assert.equal(c.authored, true, `${c.id} must be authored at the rule`);
});

test("NE-31j/NE-31s: tts-bridge owes nothing, nothing is owed to NE-31j, the narration families are burned down by NE-31s and speech-rate is owed to NE-33, the card's spec cases are authored, and every spoken line is 1x", () => {
  /* NE-31j's acceptance: "the families pass in JS. tts-bridge has zero
     unported entries." MUTATION: put a tts-bridge test back in unported.json ->
     red; put a speech-rate id back in swift-pending.json (NE-33 ported it) -> red;
     un-author the stop-never-advances case -> red; record a line at the
     listener's rate (put `rate: this._rate` back into `_speakNarration`) ->
     the authored at-1x cases refuse to record, and the last loop goes red. */
  const { status } = classify(REPO_ROOT, DATA, FIXTURES);
  assert.deepStrictEqual(Object.keys(DATA.unported["tts-bridge"] ?? {}), [], "tts-bridge owes unported.json nothing");
  for (const [name, st] of Object.entries(status["tts-bridge"])) {
    assert.ok(st.covered.length || st.excluded || st.xctest, `tts-bridge :: ${JSON.stringify(name)} is covered, excluded or mapped`);
  }
  for (const [stem, names] of Object.entries(DATA.unported)) {
    if (stem.startsWith("//")) continue;
    for (const [name, v] of Object.entries(names)) assert.notEqual(v.card, "NE-31j", `${stem} :: ${name} is still owed to NE-31j, the card that records it`);
  }
  const NARRATION_FILES = NE31J_NARRATION_FILES;
  const files = [...FIXTURES.filter((f) => NARRATION_FILES.includes(f.file)), ...FIXTURES.filter((f) => f.family === "speech-rate")];
  assert.equal(files.filter((f) => f.family === "manager-foray").length, NARRATION_FILES.length, "the narration, jingle and audition files are recorded");
  assert.ok(files.some((f) => f.family === "speech-rate"), "speech-rate is recorded");
  assert.ok(DATA.capabilities.foray.includes("speech-rate"), "speech-rate is charged to the foray capability");
  const ids = new Map(files.flatMap((f) => f.doc.cases.map((c) => [c.id, c])));
  /* speech-rate is burned down by NE-33 (its Swift runner is registered). NE-31s's acceptance: "the
     narration and interlude families pass on both sides with zero pending",
     so no manager-foray narration, jingle or audition id is pending (the
     Swift runner refuses a stale entry, so each one really runs). MUTATION:
     put one of them back in swift-pending.json -> red. */
  for (const [id] of ids) {
    if (id.startsWith("speech-rate/")) assert.equal(DATA.pending[id], undefined, `${id} is owed to ${DATA.pending[id]}; NE-33 burned speech-rate down`);
    else assert.equal(DATA.pending[id], undefined, `${id} is owed to ${DATA.pending[id]}; NE-31s ported the narration overlay`);
  }
  for (const [id, card] of Object.entries(DATA.pending)) assert.notEqual(card, "NE-31s", `${id} is still owed to NE-31s`);
  for (const [stem, names] of Object.entries(DATA.unported)) {
    if (stem.startsWith("//")) continue;
    for (const [name, v] of Object.entries(names)) assert.notEqual(v.card, "NE-31s", `${stem} :: ${name} is still owed to NE-31s`);
  }
  const SPEC = [
    "manager-foray/each-utterance-finishes-at-most-once", "manager-foray/a-pause-holds-the-utterance",
    "manager-foray/stop-never-advances", "manager-foray/stop-during-a-bridge-never-advances",
    "manager-foray/a-call-during-a-spoken-bridge-resumes-into-the-next-real-item",
    "manager-foray/a-call-during-a-rendered-bridge-resumes-into-the-next-real-item",
    "manager-foray/audition-is-refused-while-running", "speech-rate/narration-rate-is-1x",
    "speech-rate/a-line-is-spoken-at-1x-at-0.75x", "speech-rate/a-line-is-spoken-at-1x-at-1.5x", "speech-rate/a-line-is-spoken-at-1x-at-2x",
  ];
  for (const id of SPEC) assert.equal(ids.get(id)?.authored, true, `${id} is the card's spec and must be authored`);
  const speaks = [...ids.values()].flatMap((c) => c.expect?.ops ?? []).filter((o) => o.startsWith("tts.speak:"));
  assert.ok(speaks.length > 20, `the families speak (${speaks.length} lines)`);
  for (const op of speaks) assert.match(op, /@1(:[^@]*)?$/, `${op}: narration is 1x (founder, 2026-09-24)`);
});

/* transport-reconcile is NE-21's (plan §6.5): each of its tests is a rule the
   page keeps in native mode (a JS-only facade test in native-facades.test.js,
   facades.json), a rule with no Swift meaning (an exclusion), or a rule the
   engine reimplements and that another card owes. NE-21 itself owes nothing
   after it lands, so a new test here that `record.mjs --classify` tags with the
   suite's default card turns this red until someone decides which it is. */
test("transport-reconcile is wholly classified: a facade test, an exclusion, or owed to the engine's own cards", () => {
  // NE-21's acceptance ("the transport-reconcile mapping is complete in the
  // guard"). MUTATION: re-tag one facades.json entry back into unported.json as
  // {card: "NE-21"} -> red; map a Foray reconcile test to a facade test -> the
  // family check below goes red only if it was owed, so the tally checks the
  // three routes are all in use.
  //
  // NE-14k: the rules the engine reimplements are no longer only OWED. The
  // episode ones NE-14j was charged with are now fixtured (manager-episode,
  // or the pure transport-policy rule a page path reads) or mapped to the
  // XCTest that carries them natively (xctest.json), and what is still owed
  // must not be owed to the episode capability, which ships in M1.
  // MUTATION: re-tag one fixtured reconcile test back into unported.json as
  // {card: "NE-14j", family: "manager-episode"} -> red on the episode check;
  // cover a reconcile test from a foray-capability family -> red.
  const { status } = classify(REPO_ROOT, DATA, FIXTURES);
  const names = Object.entries(status["transport-reconcile"]);
  assert.ok(names.length > 0, "transport-reconcile has no tests on disk");
  const tally = { facade: 0, excluded: 0, owed: 0, fixtured: 0, xctest: 0 };
  for (const [name, st] of names) {
    const label = `transport-reconcile :: ${JSON.stringify(name)}`;
    if (st.covered.length) {
      /* The episode capability's families, or — for a Foray reconcile rule the
         manager itself carries — NE-30j's manager-foray. The page-side Foray
         reconcile rules are owed to NE-35 (native Forays on the page). */
      for (const id of st.covered) {
        const fam = id.split("/")[0];
        assert.ok(DATA.capabilities.episode.includes(fam) || fam === "manager-foray", `${label} is covered by ${id}, outside the episode capability and manager-foray`);
      }
      tally.fixtured++;
    } else if (st.xctest) tally.xctest++;
    else if (st.facade) tally.facade++;
    else if (st.excluded) tally.excluded++;
    else {
      assert.ok(st.unported, `${label} is unaccounted for`);
      assert.notEqual(st.unported.card, "NE-21", `${label} is still owed to NE-21, which is the card that classifies it`);
      assert.ok(!DATA.capabilities.episode.includes(st.unported.family), `${label} is owed to the episode capability (${JSON.stringify(st.unported)})`);
      tally.owed++;
    }
  }
  assert.ok(tally.facade > 0 && tally.excluded > 0 && tally.owed > 0 && tally.fixtured > 0 && tally.xctest > 0, JSON.stringify(tally));
});

test("every facades.json mapping names a native-facades test that exists", () => {
  // MUTATION: rename any facade test in native-facades.test.js -> red, naming it.
  assert.deepStrictEqual(facadeProblems(REPO_ROOT, DATA.facades), []);
  assert.deepStrictEqual([...FACADE_MAPPED_SUITES], ["transport-reconcile"]);
  assert.deepStrictEqual([...FACADE_SUITES], ["native-facades", "native-mode"]);
});

test("a facade mapping is refused for a missing test, a non-facade suite, or a suite whose rules Swift owns", () => {
  const name = Object.keys(DATA.facades["transport-reconcile"])[0];
  const ghost = { "transport-reconcile": { [name]: "facade:native-facades::a facade test nobody wrote" } };
  assert.match(facadeProblems(REPO_ROOT, ghost).join("\n"), /does not declare/);
  const wrongSuite = { "transport-reconcile": { [name]: "facade:queue-manager::anything" } };
  assert.match(facadeProblems(REPO_ROOT, wrongSuite).join("\n"), /not a facade suite/);
  const malformed = { "transport-reconcile": { [name]: "xctest:Foo/testBar" } };
  assert.match(facadeProblems(REPO_ROOT, malformed).join("\n"), /is not "facade:/);
  // The route that could hide a Swift rule: a covered suite other than
  // transport-reconcile mapped to a JS test. Refused, and the guard says so.
  const [seamName] = Object.keys(DATA.exclusions["seam-gap"]);
  const hiding = { "seam-gap": { [seamName]: `facade:native-facades::${Object.values(DATA.facades["transport-reconcile"])[0].split("::")[1]}` } };
  assert.match(facadeProblems(REPO_ROOT, hiding).join("\n"), /only transport-reconcile may be mapped/);
  const { problems } = classify(REPO_ROOT, { ...DATA, facades: { ...DATA.facades, ...hiding } }, FIXTURES);
  assert.ok(problems.some((p) => /only transport-reconcile may be mapped/.test(p)), problems.join("\n"));
  // Control: a real mapping is clean, so the reds above are not vacuous.
  assert.deepStrictEqual(facadeProblems(REPO_ROOT, { "transport-reconcile": { [name]: DATA.facades["transport-reconcile"][name] } }), []);
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
/* NE-30j recorded the Foray half: queue-manager's tape scenarios into
   manager-foray, and html-audio-backend's remainder into deck (the pair's
   decisions and the single deck's slices), prepare (the handover's audible
   seam) and the manager families (its integration tests). What queue-manager
   still owes is NE-39j's M3 remainder (the one narration rule no scenario can
   reach, a deadline mid-transition, NE-31s mapped to an XCTest);
   html-audio-backend owes nothing. NE-31j recorded the narration
   half: manager-foray (the overlay, the jingle's clock) and speech-rate (what
   reaches the synthesiser). */
const MANAGER_DECK_OWED = Object.freeze({
  "queue-manager": { fixtured: ["manager-episode", "manager-foray", "speech-rate"], mustOwe: true, owed: [
    { card: "NE-39j", family: "manager-remainder" },
  ] },
  "html-audio-backend": {
    fixtured: ["deck-episode", "deck", "prepare", "manager-episode", "manager-foray"], mustOwe: false, owed: [],
  },
});

test("queue-manager and html-audio-backend are wholly classified, and owe the episode capability nothing", () => {
  // NE-14j's acceptance. MUTATION: re-tag one unported queue-manager entry to
  // NE-14j / manager-episode (what `record.mjs --classify` gives a new test) ->
  // red; add a queue-manager covers[] entry to a deck-episode case -> red.
  const { status } = classify(REPO_ROOT, DATA, FIXTURES);
  for (const [stem, { fixtured, owed, mustOwe }] of Object.entries(MANAGER_DECK_OWED)) {
    const names = Object.entries(status[stem]);
    assert.ok(names.length > 0, `${stem} has no tests on disk`);
    const tally = { fixtured: 0, excluded: 0, xctest: 0, owed: 0 };
    for (const [name, st] of names) {
      const label = `${stem} :: ${JSON.stringify(name)}`;
      if (st.covered.length) {
        tally.fixtured++;
        for (const id of st.covered) assert.ok(fixtured.includes(id.split("/")[0]), `${label} is covered by ${id}, outside ${fixtured.join(", ")}`);
      } else if (st.excluded) tally.excluded++;
      else if (st.xctest) tally.xctest++;
      else {
        assert.ok(owed.some((o) => o.card === st.unported?.card && o.family === st.unported?.family),
          `${label} is owed as ${JSON.stringify(st.unported)}; it must be fixtured, excluded, mapped, or one of ${JSON.stringify(owed)}`);
        assert.ok(!DATA.capabilities.episode.includes(st.unported.family), `${label} is owed to the episode capability`);
        tally.owed++;
      }
    }
    assert.ok(tally.fixtured > 0 && tally.excluded > 0 && (mustOwe ? tally.owed > 0 : tally.owed === 0), `${stem}: ${JSON.stringify(tally)}`);
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
  // literal. Since NE-27b (the M1 flip) both name episode, continuation and
  // restore, so this is the live gate on the shipping build; the synthetic
  // cases below are what prove it has teeth.
  // MUTATION: add one manager-episode id to swift-pending.json -> red, naming
  // mobile/ENGINE_DEFAULT.json (or the Swift file) and the case.
  const advertised = advertisedCapabilities(REPO_ROOT);
  assert.deepStrictEqual([...advertised.keys()].sort(), ["continuation", "episode", "restore"],
    "NE-27b: the M1 build advertises exactly episode, continuation and restore");
  assert.deepStrictEqual(capabilityGate(advertised, DATA), []);
});

test("the episode capability owes nothing: zero swift-pending cases and zero unported tests in every family it lists", () => {
  // NE-14k (M1 audit gap): NE-27 advertises `episode` from the Swift build, so
  // its gate has to be clean before that build ships, not when it is flipped.
  // MUTATION: re-tag one ported transport-reconcile test into unported.json as
  // {card: "NE-14j", family: "manager-episode"}, or add any manager-episode id
  // to swift-pending.json -> red, naming it.
  assert.deepStrictEqual(capabilityGate(new Map([["episode", "NE-14k"]]), DATA), []);
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

test("NE-33: speech-rate, lexicon and default-voice owe nothing, the lexicon family is recorded from foray-tts.js and charged to the foray capability, and nothing is owed to NE-33", () => {
  /* NE-33's acceptance: "speech-rate, lexicon and default-voice pass on both
     sides with zero pending." The Swift runner refuses a stale pending entry,
     so each burned-down id really runs there (SpeechFamilies.swift).
     MUTATION: put any lexicon, speech-rate or default-voice id back in
     swift-pending.json -> red; move the lexicon fixture off foray-tts.js ->
     red; drop lexicon from the foray capability -> red. */
  for (const fam of ["speech-rate", "lexicon", "default-voice"]) {
    const files = FIXTURES.filter((f) => f.family === fam);
    const cases = files.flatMap((f) => f.doc.cases);
    assert.ok(cases.length > 0, `${fam} is recorded`);
    for (const c of cases) assert.equal(DATA.pending[c.id], undefined, `${c.id} is owed to ${DATA.pending[c.id]}; NE-33 ported ${fam}`);
    assert.ok(DATA.capabilities.foray.includes(fam), `${fam} is charged to the foray capability`);
  }
  for (const f of FIXTURES.filter((x) => x.family === "lexicon")) {
    assert.equal(f.doc.module, "mobile/plugins/foray-tts/web/foray-tts.js", "the lexicon rule is foray-tts.js buildIpaOverrides");
    for (const c of f.doc.cases) assert.equal(c.call, "buildIpaOverrides");
  }
  for (const [id, card] of Object.entries(DATA.pending)) assert.notEqual(card, "NE-33", `${id} is still owed to NE-33`);
});
