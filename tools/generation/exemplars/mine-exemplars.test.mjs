/* Tests for the exemplar miner — tools/generation/exemplars/mine-exemplars.mjs
 * (GV-42, docs/roadmap/generation-v2.md, #1286).
 * Run: node --test tools/generation/exemplars/mine-exemplars.test.mjs
 *
 * WHAT IS AT RISK
 * The miner decides which seams the founder is offered and refuses a pick that
 * breaks a spoken-line rule. Its failures are quiet: a disclosure line scored
 * as an exemplar, a bridge shortlisted as a full intro, a seam with a digit or
 * a structure leak written into the file that shapes the writer prompt when
 * FORAY_WRITER_EXEMPLARS is on. Offline only: the frozen fixture and a small
 * synthetic candidate; nothing calls a model.
 *
 * EVERY TEST NAMES THE ONE-LINE MUTATION THAT MAKES IT PASS FALSELY, per
 * CLAUDE.md § "A green test is not evidence until you have broken it".
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

import {
  EXEMPLARS_FILE,
  MAX_EXEMPLARS,
  PROVENANCE,
  REPO_ROOT,
  ROLES,
  SHORTLIST_PER_ROLE,
  VOICE_CARD_MAX_WORDS,
  candidatesJson,
  exemplarsFileProblems,
  exemplarsJson,
  main,
  mine,
  selectExemplars,
  shortlist,
  shortlistMarkdown,
} from "./mine-exemplars.mjs";
import { loadSegmentPool } from "../../generation-bench/run.mjs";
import { loadSegmentSources } from "../../generation-bench/score.mjs";

const require = createRequire(import.meta.url);
const spokenLine = require("../../../backend/src/copy/spokenLine.js");

const FROZEN = path.join(REPO_ROOT, "tools", "foray", "fixtures", "frozen", "data");
const SCRIPT = path.join(REPO_ROOT, "tools", "generation", "exemplars", "mine-exemplars.mjs");
const FROZEN_ID = "what-engineers-actually-do-all-day-e08236";

const frozenContext = () => ({
  pool: loadSegmentPool(path.join(FROZEN, "segments.json")),
  sources: loadSegmentSources(path.join(FROZEN, "segment-sources.json")),
});
const committedInput = (doc, label = "frozen") => ({ doc, label, sourceKind: "committed", provenance: PROVENANCE.historic, generatedOnly: true });
const candidateInput = (doc, label = "synthetic") => ({ doc, label, sourceKind: "candidate", provenance: PROVENANCE.qwen, generatedOnly: false });
// The frozen FIXTURE, not data/forays.json: named apart so publishSuites'
// REAL_DATA_READ_RE does not read this suite as a real-data reader.
const FROZEN_FORAYS = path.join(FROZEN, "forays.json");
const readFrozen = () => JSON.parse(fs.readFileSync(FROZEN_FORAYS, "utf8"));
const mineFrozen = () => mine([committedInput(readFrozen())], frozenContext());

/* A 30-word sentence, a digit and a structure leak, plus clean seams. Shows are
   resolved through the candidate's own minted segments and segmentSources. */
const THIRTY =
  "The crew that built the second span worked through three winters, rebuilt the north pier twice, and still finished the deck before the city council had agreed on its name.";
function syntheticCandidate() {
  const n = (id, script) => ({ type: "narration", id, script, slot: "s1" });
  const seg = (segment_id) => ({ type: "segment", slot: "s1", segment_id });
  return {
    version: 1,
    forays: [
      {
        id: "synthetic-candidate",
        generated: true,
        segments: [
          { id: "seg-x1", itemId: "ep-x" },
          { id: "seg-x2", itemId: "ep-x" },
          { id: "seg-x3", itemId: "ep-x" },
          { id: "seg-y1", itemId: "ep-y" },
        ],
        segmentSources: [
          { id: "ep-x", show: "Show X" },
          { id: "ep-y", show: "Show Y" },
        ],
        items: [
          n("disclosure", "This is a Foray about bridges. Much of what you'll hear is written by AI."),
          n("act-1-introduction", "Bridges fail slowly. Then they fail all at once, and the city learns what the steel was carrying the whole time."),
          seg("seg-x1"),
          n("narration-act-1-0-connective", "The inspector found the crack in 1987."),
          seg("seg-x2"),
          n("narration-act-1-1-connective", THIRTY),
          seg("seg-y1"),
          n("narration-act-1-2-beat", "In this act we follow the money."),
          seg("seg-unknown"),
          n("narration-act-1-3-beat", "The repairs took a decade and cost more than the bridge itself."),
          n("act-1-exit", "What the inspectors missed was not a crack but a habit."),
          n("act-2-introduction", "Every city keeps a list of what it cannot afford to fix."),
          seg("seg-x3"),
        ],
      },
      { id: "synthetic-clip-only", items: [seg("seg-x1")] },
    ],
  };
}
const mineSynthetic = () => mine([candidateInput(syntheticCandidate())]);
const runOf = (result, firstItemId) => result.runs.find((r) => r.runId.endsWith(`:${firstItemId}`));

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gv42-"));

/* 1. Killing mutations: delete `if (item.id === DISCLOSURE_ID) continue;` in
      seamRuns (the disclosure joins act 1's first run: 40 items in runs, not
      39), or delete the clip-only skip (3 more Foray(s) mined). */
test("frozen fixture: 1 generated Foray, 4 acts, 40 narration items, the disclosure excluded from seam runs, 3 clip-only Forays skipped", () => {
  const result = mineFrozen();
  assert.equal(result.summary.forays, 1);
  assert.equal(result.summary.acts, 4);
  assert.equal(result.summary.narrationItems, 40);
  assert.equal(result.summary.disclosureItems, 1);
  assert.deepEqual(
    result.skipped.map((s) => [s.forayId, s.reason]),
    [
      ["grilling-history-1", "clip-only"],
      ["grilling-history-2", "clip-only"],
      ["capital-types-1", "clip-only"],
    ]
  );
  const inRuns = result.runs.flatMap((r) => r.itemIds);
  assert.equal(inRuns.length, 39, "every narration item but the disclosure sits in exactly one run");
  assert.equal(new Set(inRuns).size, 39);
  assert.ok(!inRuns.includes("disclosure"));
  assert.ok(result.runs.every((r) => r.forayId === FROZEN_ID && r.provenance === PROVENANCE.historic && r.sourceKind === "committed"));
  assert.equal(result.summary.seamRuns, result.runs.length);
});

/* 2. Killing mutation: in seamRuns, stop closing the run at a non-narration
      item (drop the `close(next)` call): runs then span segments. Also kills
      dropping the act-change close (act-1-exit and act-2-introduction merge). */
test("a seam run is the consecutive narration between two segments, never spanning an act change", () => {
  const frozen = readFrozen().forays.find((f) => f.id === FROZEN_ID);
  const index = new Map(frozen.items.map((it, i) => [it.id, i]));
  for (const run of mineFrozen().runs) {
    const at = run.itemIds.map((id) => index.get(id));
    for (let k = 1; k < at.length; k++) assert.equal(at[k], at[k - 1] + 1, `${run.runId}: items are consecutive`);
    const acts = new Set(run.itemIds.map((id) => Number(/act-(\d+)/.exec(id)[1])));
    assert.equal(acts.size, 1, `${run.runId} stays inside one act`);
  }
  const syn = mineSynthetic();
  assert.deepEqual(runOf(syn, "narration-act-1-3-beat").itemIds, ["narration-act-1-3-beat", "act-1-exit"]);
  assert.deepEqual(runOf(syn, "act-2-introduction").itemIds, ["act-2-introduction"]);
});

/* 3. Killing mutations: in roleOf, drop `!showsHeard.has(nextShow)` (the
      bridge into a second Show X clip becomes full-intro), or drop
      `nextShow !== null &&` (the unresolved seg-unknown becomes full-intro). */
test("roles come from item ids and the shows of neighbouring segments; an unresolved show yields bridge", () => {
  const syn = mineSynthetic();
  const roles = Object.fromEntries(syn.runs.map((r) => [r.itemIds[0], r.role]));
  assert.deepEqual(roles, {
    "act-1-introduction": "act-introduction",
    "narration-act-1-0-connective": "bridge",
    "narration-act-1-1-connective": "full-intro",
    "narration-act-1-2-beat": "bridge",
    "narration-act-1-3-beat": "act-exit",
    "act-2-introduction": "act-introduction",
  });
  assert.equal(runOf(syn, "narration-act-1-1-connective").nextShow, "Show Y");
  assert.equal(runOf(syn, "narration-act-1-2-beat").nextShow, null, "seg-unknown resolves to no show");
  assert.deepEqual(syn.summary.byRole, { "act-introduction": 2, "full-intro": 1, bridge: 2, "act-exit": 1 });
  assert.deepEqual(syn.skipped, [{ forayId: "synthetic-clip-only", source: "synthetic", reason: "clip-only" }]);
});

/* 4. Killing mutation: resolve the show only from the candidate's own
      segmentSources (drop the registry lookup in showOfSegment): every frozen
      run then has nextShow null, since the frozen Foray carries no
      segmentSources. */
test("frozen fixture: a segment's show resolves through segments.json, then segment-sources.json", () => {
  const result = mineFrozen();
  const toTape = result.runs.filter((r) => r.nextSegmentId !== null);
  assert.ok(toTape.length > 0);
  for (const r of toTape) assert.equal(r.nextShow, "Being an Engineer", r.runId);
  const bare = mine([committedInput(readFrozen())]);
  assert.ok(bare.runs.every((r) => r.nextShow === null && (r.role !== "full-intro")), "with no registry nothing resolves, so nothing is a full intro");
});

/* 5. Killing mutations: drop `structureLeaks.length` from `findings`, or call
      spokenLineErrors on the joined run text instead of per sentence with
      { hasTape: true }, or count overMax from SENTENCE_MAX_WORDS + 5. */
test("metrics: the digit is a check-narration finding, the 30-word sentence is over the maximum, the leak is a structure finding", () => {
  const syn = mineSynthetic();
  const digit = runOf(syn, "narration-act-1-0-connective").metrics;
  assert.equal(digit.lineFindings.length, 1);
  assert.match(digit.lineFindings[0], /^narration-act-1-0-connective sentence 1: digit in a spoken line/);
  assert.equal(digit.findings, 1);

  const long = runOf(syn, "narration-act-1-1-connective").metrics;
  assert.equal(long.maxWords, 30);
  assert.equal(long.overMax, 1);
  assert.equal(long.findings, 0, "length is a violation, not a finding");
  assert.equal(long.meanOutOfBand, true);
  assert.equal(long.violations, 2);

  const leak = runOf(syn, "narration-act-1-2-beat").metrics;
  assert.deepEqual(leak.structureLeaks, [{ itemId: "narration-act-1-2-beat", phrase: "this act", rule: "self-determiner" }]);
  assert.equal(leak.lineFindings.length, 0);
  assert.equal(leak.findings, 1);

  const clean = runOf(syn, "act-1-introduction").metrics;
  assert.equal(clean.findings, 0);
  assert.equal(clean.sentences, 2);
  assert.equal(clean.shortSentences, 1, "'Bridges fail slowly.' is under six words");
});

/* 6. Killing mutation: compute fkGrade or the sentence split with a local
      formula / regex instead of spokenLine.js (decision 16): the grade and the
      count drift from the shared implementation on the frozen seams. */
test("FK grade, sentence count and mean come from spokenLine.js", () => {
  for (const run of mineFrozen().runs) {
    const text = run.text.split("\n").join(" ");
    assert.equal(run.metrics.fkGrade, Math.round(spokenLine.fleschKincaidGrade(text) * 100) / 100, run.runId);
    const sentences = run.text.split("\n").flatMap((s) => spokenLine.splitSpokenSentences(s));
    const shape = spokenLine.sentenceShape(sentences);
    assert.equal(run.metrics.sentences, shape.n, run.runId);
    assert.equal(run.metrics.meanWords, Math.round(shape.mean * 1000) / 1000, run.runId);
  }
});

/* 7. Killing mutations: drop the mean tie-break in compareRuns (equal
      violations then sort by run id: z-close would follow a-far), or drop
      `.slice(0, per)` (all 7 runs listed). */
test("shortlist: top 5 per role by fewest violations, then mean sentence length closest to 13.5", () => {
  const run = (id, violations, meanWords) => ({ runId: id, role: "bridge", metrics: { violations, meanWords } });
  const runs = [
    run("a-far", 0, 20),
    run("z-close", 0, 13),
    run("m-exact", 0, 13.5),
    run("b-worse", 2, 13.5),
    run("c-one", 1, 30),
    run("d-two", 2, 14),
    run("e-three", 3, 13.5),
    { runId: "intro", role: "act-introduction", metrics: { violations: 9, meanWords: 1 } },
  ];
  const list = shortlist(runs);
  assert.deepEqual(list.bridge.map((r) => r.runId), ["m-exact", "z-close", "a-far", "c-one", "b-worse"]);
  assert.equal(list.bridge.length, SHORTLIST_PER_ROLE);
  assert.deepEqual(list["act-introduction"].map((r) => r.runId), ["intro"]);
  assert.deepEqual(Object.keys(list), ROLES);
});

/* 8. Killing mutations: in selectExemplars, drop the `run.metrics.findings > 0`
      refusal (the digit seam and the leak seam are accepted), or drop
      `structureLeaks.length` from findings (the leak seam is accepted). */
test("--select refuses a run with a check-narration finding or a structure leak", () => {
  const { runs } = mineSynthetic();
  const ok = { voiceCard: "Plain, concrete, unhurried.", listenedOn: "2026-10-12", selectedBy: "founder" };
  const digitId = runOf({ runs }, "narration-act-1-0-connective").runId;
  const leakId = runOf({ runs }, "narration-act-1-2-beat").runId;
  assert.throws(() => selectExemplars(runs, { ...ok, runIds: [digitId] }), /has 1 finding\(s\): .*digit in a spoken line/);
  assert.throws(() => selectExemplars(runs, { ...ok, runIds: [leakId] }), /structure leak "this act"/);
  assert.throws(() => selectExemplars(runs, { ...ok, runIds: ["synthetic-candidate:nope"] }), /unknown run id/);
});

/* 9. Killing mutations: VOICE_CARD_MAX_WORDS = 61, MAX_EXEMPLARS = 3, or drop
      either the selectedBy or the listenedOn requirement. */
test("--select refuses a voice card over 60 words, more than 2 exemplars, and a selection without selectedBy or listenedOn", () => {
  const { runs } = mineSynthetic();
  const clean = ["act-1-introduction", "narration-act-1-3-beat", "act-2-introduction"].map((id) => runOf({ runs }, id).runId);
  const ok = { runIds: clean.slice(0, 2), voiceCard: "Plain, concrete, unhurried.", listenedOn: "2026-10-12", selectedBy: "founder" };
  assert.equal(VOICE_CARD_MAX_WORDS, 60);
  assert.equal(MAX_EXEMPLARS, 2);
  const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
  assert.doesNotThrow(() => selectExemplars(runs, { ...ok, voiceCard: words(60) }));
  assert.throws(() => selectExemplars(runs, { ...ok, voiceCard: words(61) }), /voice card is 61 words; the limit is 60/);
  assert.throws(() => selectExemplars(runs, { ...ok, runIds: clean }), /3 exemplars selected; at most 2/);
  assert.throws(() => selectExemplars(runs, { ...ok, selectedBy: undefined }), /--selected-by is required/);
  assert.throws(() => selectExemplars(runs, { ...ok, selectedBy: "  " }), /--selected-by is required/);
  assert.throws(() => selectExemplars(runs, { ...ok, listenedOn: undefined }), /--listened-on is required/);
  assert.throws(() => selectExemplars(runs, { ...ok, listenedOn: "last tuesday" }), /not a YYYY-MM-DD date/);
});

/* 10. Killing mutation: build the exemplar from run.itemIds[0]'s script only,
       or set provenance from sourceKind instead of the input's provenance. */
test("--select writes the card's shape: version 1, voiceCard {text, words}, exemplars with role, text, forayId, itemIds, sourceKind, provenance, selectedBy, listenedOn", () => {
  const { runs } = mineSynthetic();
  const exitId = runOf({ runs }, "narration-act-1-3-beat").runId;
  const introId = runOf({ runs }, "act-1-introduction").runId;
  const file = selectExemplars(runs, { runIds: [exitId, introId], voiceCard: "  Plain, concrete, unhurried.\n", listenedOn: "2026-10-12", selectedBy: "founder" });
  assert.deepEqual(file, {
    version: 1,
    voiceCard: { text: "Plain, concrete, unhurried.", words: 3 },
    exemplars: [
      {
        role: "act-exit",
        text: "The repairs took a decade and cost more than the bridge itself.\nWhat the inspectors missed was not a crack but a habit.",
        forayId: "synthetic-candidate",
        itemIds: ["narration-act-1-3-beat", "act-1-exit"],
        sourceKind: "candidate",
        provenance: "qwen-pipeline",
        selectedBy: "founder",
        listenedOn: "2026-10-12",
      },
      {
        role: "act-introduction",
        text: "Bridges fail slowly. Then they fail all at once, and the city learns what the steel was carrying the whole time.",
        forayId: "synthetic-candidate",
        itemIds: ["act-1-introduction"],
        sourceKind: "candidate",
        provenance: "qwen-pipeline",
        selectedBy: "founder",
        listenedOn: "2026-10-12",
      },
    ],
  });
  assert.deepEqual(exemplarsFileProblems(file), []);
  assert.equal(exemplarsJson(file), JSON.stringify(file, null, 2) + "\n");
});

/* 11. Killing mutation: add a timestamp to candidatesJson or
       shortlistMarkdown (e.g. `built_at: new Date().toISOString()`). Two runs
       over the same inputs must be byte-identical, through the CLI as well. */
test("output is byte-stable for the same inputs", () => {
  const a = mine([committedInput(readFrozen()), candidateInput(syntheticCandidate())], frozenContext());
  const b = mine([committedInput(readFrozen()), candidateInput(syntheticCandidate())], frozenContext());
  assert.equal(candidatesJson(a), candidatesJson(b));
  assert.equal(shortlistMarkdown(a), shortlistMarkdown(b));
  assert.doesNotMatch(candidatesJson(a), /20\d\d-\d\d-\d\dT/, "no timestamps");

  const tmp = tmpDir();
  const cand = path.join(tmp, "candidate.json");
  fs.writeFileSync(cand, JSON.stringify(syntheticCandidate()));
  const args = (out) => ["--forays", path.join(FROZEN, "forays.json"), "--segments", path.join(FROZEN, "segments.json"), "--segment-sources", path.join(FROZEN, "segment-sources.json"), "--candidate", cand, "--out-dir", out];
  const logs = [];
  assert.equal(main(args(path.join(tmp, "one")), (l) => logs.push(l)), 0);
  assert.equal(main(args(path.join(tmp, "two")), (l) => logs.push(l)), 0);
  for (const f of ["candidates.json", "shortlist.md"])
    assert.equal(fs.readFileSync(path.join(tmp, "one", f), "utf8"), fs.readFileSync(path.join(tmp, "two", f), "utf8"), f);
  const written = JSON.parse(fs.readFileSync(path.join(tmp, "one", "candidates.json"), "utf8"));
  assert.equal(written.summary.forays, 2);
  assert.equal(written.runs.length, 20 + 6);
  assert.match(logs[0], /^mined 2 Foray\(s\), 6 act\(s\), 48 narration item\(s\) \(2 disclosure excluded\)/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* 12. Killing mutation: commit narration-exemplars.json with an exemplar or a
       voice card the founder has not selected (no selectedBy / listenedOn), or
       drop the selectedBy check from exemplarsFileProblems. */
test("the committed narration-exemplars.json starts empty, and an unselected exemplar is a problem", () => {
  const committed = JSON.parse(fs.readFileSync(EXEMPLARS_FILE, "utf8"));
  assert.deepEqual(exemplarsFileProblems(committed), []);
  if (committed.exemplars.length === 0) assert.deepEqual(committed, { version: 1, voiceCard: null, exemplars: [] });
  const unselected = { version: 1, voiceCard: null, exemplars: [{ role: "bridge", text: "x", forayId: "f", itemIds: ["i"], sourceKind: "committed", provenance: PROVENANCE.historic }] };
  assert.deepEqual(exemplarsFileProblems(unselected), ["exemplar 1: missing selectedBy", "exemplar 1: missing or malformed listenedOn"]);
});

/* 13. Killing mutation: in main, write the --select output to EXEMPLARS_FILE
       even when --out is given, or exit 0 on a refusal. Runs the real CLI
       (a child node process, no network). */
test("CLI: --select writes the file named by --out, and a refused selection exits 1 and writes nothing", () => {
  const tmp = tmpDir();
  const card = path.join(tmp, "card.txt");
  fs.writeFileSync(card, "Plain, concrete, unhurried.\n");
  const base = ["--forays", path.join(FROZEN, "forays.json"), "--segments", path.join(FROZEN, "segments.json"), "--segment-sources", path.join(FROZEN, "segment-sources.json")];
  const runId = mineFrozen().runs.find((r) => r.metrics.findings === 0).runId;
  const out = path.join(tmp, "picked.json");
  const ok = spawnSync(process.execPath, [SCRIPT, ...base, "--select", runId, "--voice-card", card, "--listened-on", "2026-10-12", "--selected-by", "founder", "--out", out], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const picked = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(picked.exemplars[0].forayId, FROZEN_ID);
  assert.equal(picked.exemplars[0].provenance, "claude-pipeline-historic");

  const bad = path.join(tmp, "refused.json");
  const refused = spawnSync(process.execPath, [SCRIPT, ...base, "--select", runId, "--voice-card", card, "--listened-on", "2026-10-12", "--out", bad], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--selected-by is required/);
  assert.equal(fs.existsSync(bad), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});
