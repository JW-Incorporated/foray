/* Tests for the MQ scorecard (GV-24). Run: node --test tools/generation-bench/score.test.mjs
 *
 * WHAT IS AT RISK. The scorecard is twenty-one numbers that will be read as a
 * Foray's quality, and every way it can be wrong is quiet: a clip-only Foray
 * scored as a voice of zero, a pool clip counted as a clean cut, the wrong
 * show credited with the tape, a report's own measurement overridden by the
 * candidate guess, the reference file drifting with nobody told. Each test
 * names the one-line mutation that makes it pass falsely, and each mutation
 * was run against it before this landed.
 *
 * FIXTURES. fixtures/score-synth/candidate.json is synthetic: two invented
 * shows, three minted clips (turn, sentence, claim-only) and one pool clip,
 * short invented narration, no transcript text. The frozen forays fixture
 * (tools/foray/fixtures/frozen/data) is the committed curation fixture: three
 * clip-only Forays and what-engineers with its 40 scripts. The committed
 * reference file is checked for SHAPE only; re-deriving it against
 * data/forays.json is the CLI's `--check`, deliberately not a unit test, so a
 * later change to data/forays.json cannot break CI.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSegmentPool, readJson } from "./run.mjs";
import { scoreVoice } from "../foray/voice-metrics.mjs";
import {
  MQ_IDS,
  MQ_SOURCES,
  REFERENCE_FILE,
  REFERENCE_LABELS,
  SCORECARD_COLUMNS,
  TIER_TARGET_SEC_PROPOSED,
  asCandidate,
  labelFor,
  loadSegmentSources,
  main,
  parseArgs,
  readJudged,
  referenceDrift,
  scoreCandidate,
  scoreForays,
  scorecardValues
} from "./score.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SYNTH = path.join(HERE, "fixtures", "score-synth", "candidate.json");
const FROZEN = path.join(REPO_ROOT, "tools", "foray", "fixtures", "frozen", "data");
const OUT9 = path.join(HERE, "fixtures", "out-9");
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gv24-"));

/* The synthetic candidate's one pool clip and the registry row that names its show. */
const SYNTH_POOL = new Map([["synth-ep-b2#10", { id: "synth-ep-b2#10", item_id: "synth-ep-b2", start_sec: 10, end_sec: 60 }]]);
const SYNTH_SOURCES = [{ id: "synth-ep-b2", show: "Synthetic Show B" }];
const synth = () => readJson(SYNTH);
const synthCard = (extra = {}) => scoreCandidate({ candidate: synth(), pool: SYNTH_POOL, sources: SYNTH_SOURCES, ...extra });

const VOICE = ["MQ-15", "MQ-16", "MQ-17", "MQ-18", "MQ-19"];

/** Over-25 counted independently of spokenLine: split on . ! ? and whitespace. */
function over25ByHand(scripts) {
  let n = 0;
  for (const s of scripts) {
    for (const sentence of s.split(/(?<=[.!?])\s+/)) if (sentence.trim().split(/\s+/).length > 25) n += 1;
  }
  return n;
}

function frozenRows() {
  return scoreForays(readJson(path.join(FROZEN, "forays.json")), {
    pool: loadSegmentPool(path.join(FROZEN, "segments.json")),
    sources: loadSegmentSources(path.join(FROZEN, "segment-sources.json"))
  });
}

test("synthetic two-show candidate: MQ-07 shows and largest share, MQ-06 clean share, MQ-08 tape shape", () => {
  /* MUTATION: in showVariety(), credit every clip's tape to the first show
     seen (`tapeByShow.set(first, ...)`). Ran it: red (share 1, not 160/300).
     MUTATION: in cleanCutShare(), divide by `known` instead of every clip.
     Ran it: red (0.667, not 0.5). */
  const card = synthCard();
  assert.equal(card["MQ-07"].value.distinctShows, 2);
  assert.equal(card["MQ-07"].value.distinctEpisodes, 4);
  assert.equal(card["MQ-07"].value.largestShow, "Synthetic Show A");
  assert.ok(Math.abs(card["MQ-07"].value.largestShowTapeShare - 160 / 300) < 1e-12);
  assert.equal(card["MQ-07"].source, "candidate");
  /* turn + sentence of 4 clips; claim-only is known and not clean, the pool clip unknown. */
  assert.equal(card["MQ-06"].value, 0.5);
  assert.match(card["MQ-06"].note, /2 clean of 4 clip\(s\); 1 unknown/);
  assert.deepEqual(card["MQ-08"].value, { tapeOfRuntime: 0.5, medianClipSec: 70, shareUnder60: 0.5 });
});

test("synthetic candidate: MQ-16's over-25 count matches an independent word count, and MQ-19 finds the one leak", () => {
  /* MUTATION: in scoreCandidate(), build the voice from `scripts.slice(1)`.
     Ran it: red (over25 1, not 2). */
  const scripts = synth().items.filter((i) => i.type === "narration" && i.script).map((i) => i.script);
  const card = synthCard();
  assert.equal(over25ByHand(scripts), 2);
  assert.equal(card["MQ-16"].value.over25, 2);
  assert.equal(card["MQ-16"].value.maxWords, 32);
  assert.equal(card["MQ-19"].value, 1, "'In this act' is a structure leak");
  assert.equal(card["MQ-15"].value, scoreVoice(scripts).fkGrade);
  /* MUTATION: swap MQ-17 and MQ-18 in scoreCandidate() (MQ-17 reads
     fillerPer100, MQ-18 speakabilityPer100). Ran it: red. */
  assert.equal(card["MQ-17"].value, scoreVoice(scripts).speakabilityPer100);
  assert.equal(card["MQ-18"].value, scoreVoice(scripts).fillerPer100);
  assert.notEqual(card["MQ-17"].value, card["MQ-18"].value, "the fixture tells speakability from filler");
  /* The narration item with no script (a redacted outro) is not a script of 0 words. */
  assert.match(card["MQ-15"].note, /^3 script\(s\)/);
});

test("MQ-07 resolves a show from the candidate's sources, then the registry, then the pool row's show_id", () => {
  /* MUTATION: look the registry up BEFORE the candidate's own segmentSources.
     Ran it: red. */
  const registry = [
    { id: "synth-ep-a1", show: "Registry Says Otherwise" },
    { id: "synth-ep-b2", show: "Synthetic Show B" }
  ];
  const own = scoreCandidate({ candidate: synth(), pool: SYNTH_POOL, sources: registry })["MQ-07"].value;
  assert.equal(own.distinctShows, 2, "the candidate's own row wins for synth-ep-a1");
  /* No registry row: the pool row's show_id is the last resort. */
  const pool = new Map([["synth-ep-b2#10", { ...SYNTH_POOL.get("synth-ep-b2#10"), show_id: "Synthetic Show C" }]]);
  const viaPool = scoreCandidate({ candidate: synth(), pool, sources: [] })["MQ-07"];
  assert.equal(viaPool.value.distinctShows, 3);
  /* Neither: the clip is left out and the note says so — not credited to a show. */
  const none = scoreCandidate({ candidate: synth(), pool: SYNTH_POOL, sources: [] })["MQ-07"];
  assert.equal(none.value.distinctShows, 2);
  assert.match(none.note, /1 of 4 clip\(s\) with no resolvable show/);
});

test("MQ-06: a pool row is unknown even when it carries a boundary; no known boundary is null, not 0", () => {
  /* MUTATION: in cleanCutShare(), read `clip.poolRow?.boundary` when the clip
     has no minted row. Ran it: red (0.75). */
  const pool = new Map([["synth-ep-b2#10", { ...SYNTH_POOL.get("synth-ep-b2#10"), boundary: "turn" }]]);
  assert.equal(scoreCandidate({ candidate: synth(), pool, sources: SYNTH_SOURCES })["MQ-06"].value, 0.5);
  const unbounded = synth();
  unbounded.segments = unbounded.segments.map(({ boundary, ...row }) => row);
  const card = scoreCandidate({ candidate: unbounded, pool: SYNTH_POOL });
  assert.equal(card["MQ-06"].value, null);
  assert.match(card["MQ-06"].note, /no minted clip records a boundary/);
});

test("absent is null, never 0: no candidate, no scripts, no report", () => {
  /* MUTATION: drop the `scripts.length === 0` branch so scoreVoice([]) runs.
     Ran it: red (MQ-15 0, MQ-19 0). */
  const empty = scoreCandidate({});
  for (const id of MQ_IDS) {
    assert.equal(empty[id].value, null, `${id} with nothing to read`);
    assert.equal(empty[id].source, MQ_SOURCES[id]);
    assert.equal(typeof empty[id].note, "string", `${id} says why it is absent`);
  }
  const clipOnly = synth();
  clipOnly.items = clipOnly.items.filter((i) => i.type === "segment");
  const card = scoreCandidate({ candidate: clipOnly, pool: SYNTH_POOL, sources: SYNTH_SOURCES });
  for (const id of VOICE) assert.equal(card[id].value, null, `${id} on a clip-only candidate`);
  assert.notEqual(card["MQ-07"].value, null, "tape metrics still apply");
});

test("on out-9, report-sourced fields are filled; judged and listen fields are null", () => {
  /* MUTATION: read `entry.veracity` as `{}` in scoreCandidate(). Ran it: red. */
  const report = readJson(path.join(OUT9, "report.json"));
  const candidate = readJson(path.join(OUT9, "what-engineers-actually-do-all-day-how-e-4e64fd43.json"));
  const card = scoreCandidate({ candidate, entry: report.entries[0], pool: loadSegmentPool(path.join(HERE, "fixtures", "segments.json")) });
  assert.deepEqual([card["MQ-01"].value, card["MQ-04"].value, card["MQ-13"].value], [1, 8, 0]);
  for (const id of ["MQ-01", "MQ-04", "MQ-13"]) assert.equal(card[id].source, "report");
  for (const id of ["MQ-02", "MQ-03", "MQ-05", "MQ-10", "MQ-12", "MQ-20"]) assert.equal(card[id].value, null, id);
  /* Run 9 predates GV-26: tape yield, beat coverage and publishable are not on it. */
  for (const id of ["MQ-09", "MQ-11", "MQ-21"]) assert.match(card[id].note, /report does not carry/);
  /* The fixture candidate is redacted to its clips, so its voice is absent. */
  for (const id of VOICE) assert.equal(card[id].value, null);
  assert.equal(card["MQ-08"].value.medianClipSec !== null, true);
});

test("the report's own measurements win: showVariety, tierFit, tapeYield, beatCoverage, publishable", () => {
  /* MUTATION: compute MQ-07 from the candidate even when veracity.showVariety
     is there. Ran it: red. */
  const entry = {
    publishable: false,
    veracity: {
      showVariety: { distinctShows: 5, distinctEpisodes: 7, largestShowKey: "show-x", largestShowTapeShare: 0.4, tapeSecByShow: {} },
      tierFit: { tier: "short", targetSec: 900, runtimeSec: 1800, ratio: 2, withinTolerance: false },
      tapeYield: { tapeBeats: 3, wantedBeats: 4, rate: 0.75, seedsPlaced: 1, seedsLost: 0 },
      beatCoverage: { beats: 10, carried: 9, rate: 0.9 }
    }
  };
  const card = synthCard({ entry });
  assert.deepEqual(card["MQ-07"], {
    value: { distinctShows: 5, distinctEpisodes: 7, largestShow: "show-x", largestShowTapeShare: 0.4 },
    source: "report",
    note: "report veracity.showVariety (GV-83)"
  });
  assert.equal(card["MQ-14"].value, 2);
  assert.equal(card["MQ-14"].source, "report");
  assert.equal(card["MQ-09"].value, 0.75);
  assert.equal(card["MQ-11"].value, 0.9);
  assert.equal(card["MQ-21"].value, false, "a refused run is false, not absent");
  /* MUTATION: read veracity.showVariety only when a candidate is there (the
     report-only path of run.mjs --scorecard). Ran it: red (MQ-07 null). */
  const reportOnly = scoreCandidate({ entry });
  assert.equal(reportOnly["MQ-07"].source, "report");
  assert.equal(reportOnly["MQ-07"].value.distinctShows, 5);
});

test("MQ-14: entry.tierTargetSec, else the PROPOSED tier table; no tier is null", () => {
  /* MUTATION: default an unknown tier to `short` in tierFitOf(). Ran it: red. */
  assert.deepEqual(TIER_TARGET_SEC_PROPOSED, { short: 900, medium: 3600, long: 10800 });
  const short = synthCard({ entry: { duration: "short" } })["MQ-14"];
  assert.ok(Math.abs(short.value - 600 / 900) < 1e-12);
  assert.match(short.note, /PROPOSED/);
  assert.match(short.note, /8-12 min/);
  assert.equal(synthCard({ entry: { duration: "short", tierTargetSec: 600 } })["MQ-14"].value, 1);
  assert.equal(synthCard({ entry: { duration: "medium" }, tierTargets: { medium: 1200 } })["MQ-14"].value, 0.5);
  const unknown = synthCard({ entry: {} })["MQ-14"];
  assert.equal(unknown.value, null);
  assert.match(unknown.note, /no tier recorded/);
});

test("judged metrics: the judged file wins, then the report's judge fields; MQ-20 from the listen join", () => {
  /* MUTATION: prefer `v[field]` over the judged file. Ran it: red. */
  const entry = { veracity: { supportedSentenceRate: 0.5, promptFit: 3 } };
  const judged = { "MQ-02": 0.9, "MQ-05": { value: 0.8 }, seamCoherence: 4.5 };
  const card = synthCard({ entry, judged, listen: { meanOverall: 3.5, lastListenedAt: "2026-10-01T10:00:00Z", cards: 2 } });
  assert.equal(card["MQ-02"].value, 0.9);
  assert.equal(card["MQ-02"].note, "judged file");
  assert.equal(card["MQ-05"].value, 0.8);
  assert.equal(card["MQ-10"].value, 3);
  assert.equal(card["MQ-10"].note, "report veracity.promptFit");
  assert.equal(card["MQ-12"].value, 4.5);
  assert.equal(card["MQ-03"].value, null);
  for (const id of ["MQ-02", "MQ-05", "MQ-10", "MQ-12"]) assert.equal(card[id].source, "judged");
  assert.equal(card["MQ-20"].value, 3.5);
  assert.match(card["MQ-20"].note, /2 card\(s\), last 2026-10-01/);
  /* readJudged: one object applies to whoever is scored; JSONL rows by id. */
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "one.json"), JSON.stringify({ questionsVersion: 1, "MQ-10": 4 }));
  assert.equal(readJudged(path.join(dir, "one.json"))("anything")["MQ-10"], 4);
  fs.writeFileSync(path.join(dir, "many.jsonl"), [{ candidateId: "a", "MQ-10": 1 }, { candidateId: "b", "MQ-10": 2 }].map((r) => JSON.stringify(r)).join("\n"));
  assert.equal(readJudged(path.join(dir, "many.jsonl"))("b")["MQ-10"], 2);
  assert.equal(readJudged(path.join(dir, "many.jsonl"))("c"), null);
});

test("frozen forays: null voice metrics (not zeros) for the 3 clip-only rows, numbers for what-engineers", () => {
  /* MUTATION: in scoreCandidate(), call scoreVoice(scripts) even when there
     are no scripts (drop the `scripts.length === 0` branch): a clip-only
     Foray then reads grade 0 and 0 leaks. Ran it: red. */
  const rows = frozenRows();
  assert.equal(rows.length, 4);
  const clipOnly = rows.filter((r) => r.label === "curated clip-only");
  assert.deepEqual(clipOnly.map((r) => r.id), ["grilling-history-1", "grilling-history-2", "capital-types-1"]);
  for (const row of clipOnly) {
    for (const id of VOICE) assert.equal(row.scorecard[id].value, null, `${row.id} ${id}`);
    assert.equal(typeof row.scorecard["MQ-08"].value.medianClipSec, "number", `${row.id} still has tape`);
  }
  const we = rows.find((r) => r.id === "what-engineers-actually-do-all-day-e08236");
  assert.equal(we.label, "generated pre-Q-03");
  const forays = readJson(path.join(FROZEN, "forays.json")).forays;
  const scripts = forays.find((f) => f.id === we.id).items.filter((i) => i.type === "narration").map((i) => i.script);
  assert.equal(scripts.length, 40);
  assert.equal(we.scorecard["MQ-15"].value, scoreVoice(scripts).fkGrade);
  assert.equal(we.scorecard["MQ-16"].value.over25, scoreVoice(scripts).over25);
  assert.equal(we.scorecard["MQ-17"].value, scoreVoice(scripts).speakabilityPer100);
  assert.equal(we.scorecard["MQ-18"].value, scoreVoice(scripts).fillerPer100);
  for (const id of VOICE) assert.equal(typeof (id === "MQ-16" ? we.scorecard[id].value.over25 : we.scorecard[id].value), "number", id);
  assert.ok(we.scorecard["MQ-19"].value > 0, "the pre-rule Forays say structural words aloud");
  /* No report: MQ-01/02/04/11 are absent by construction (RQ-04). */
  for (const id of ["MQ-01", "MQ-02", "MQ-04", "MQ-11"]) assert.equal(we.scorecard[id].value, null);
  assert.match(we.scorecard["MQ-01"].note, /no report/);
});

test("a published Foray reads runtime_sec as runtimeSec; a candidate keeps its own", () => {
  /* MUTATION: `return foray` unconditionally in asCandidate(). Ran it: red. */
  assert.equal(asCandidate({ runtime_sec: 120, items: [] }).runtimeSec, 120);
  assert.equal(asCandidate({ runtimeSec: 90, runtime_sec: 120 }).runtimeSec, 90);
  assert.equal(asCandidate(null), null);
  assert.equal(labelFor({ id: "x", generated: true, items: [] }), "generated");
  assert.equal(labelFor({ id: "x", items: [{ type: "segment" }] }), "curated clip-only");
  assert.equal(labelFor({ id: "capital-types-1", items: [] }), "curated clip-only");
});

test("--write then --check: no drift at write time; a changed cell is reported and exits 1", () => {
  /* MUTATION: `return []` at the top of referenceDrift(). Ran it: red. */
  const dir = tmpdir();
  const out = path.join(dir, "ref.jsonl");
  const common = ["--forays", path.join(FROZEN, "forays.json"), "--segments", path.join(FROZEN, "segments.json"), "--segment-sources", path.join(FROZEN, "segment-sources.json"), "--out", out];
  const lines = [];
  assert.equal(main([...common, "--write"], (s) => lines.push(s)), 0);
  assert.equal(main([...common, "--check"], (s) => lines.push(s)), 0);
  assert.match(lines.at(-1), /no drift \(4 Foray\(s\)\)/);
  const rows = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  rows[3].scorecard["MQ-19"].value += 1;
  rows.pop();
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const drift = [];
  assert.equal(main([...common, "--check"], (s) => drift.push(s)), 1);
  assert.match(drift.join("\n"), /DRIFT/);
  assert.match(drift.join("\n"), /what-engineers-actually-do-all-day-e08236: not in the committed reference/);
  /* A changed cell is named by id and MQ. */
  const fresh = frozenRows();
  const edited = fresh.map((r) => JSON.parse(JSON.stringify(r)));
  edited[0].scorecard["MQ-08"].value.shareUnder60 = 0.5;
  assert.deepEqual(referenceDrift(fresh, edited.map((r) => JSON.stringify(r)).join("\n")).map((l) => l.split(" ").slice(0, 2).join(" ")), ["grilling-history-1: MQ-08"]);
});

test("the committed reference holds the 7 Forays, labelled 3 curated clip-only and 4 generated pre-Q-03, as references", () => {
  /* MUTATION: set one committed row's role to 'target'. Ran it: red. Shape only: re-deriving
     against data/forays.json is `score.mjs --forays data/forays.json --check`. */
  const rows = fs.readFileSync(REFERENCE_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.id).sort(), Object.keys(REFERENCE_LABELS).sort());
  for (const row of rows) {
    assert.equal(row.schema, "scorecard/1");
    assert.equal(row.label, REFERENCE_LABELS[row.id]);
    assert.equal(row.role, "reference, not target");
    assert.deepEqual(Object.keys(row.scorecard), MQ_IDS);
    assert.equal(row.scorecard["MQ-20"].value, null, "no machine's listening keys in a committed file");
  }
  assert.equal(rows.filter((r) => r.label === "curated clip-only").length, 3);
  assert.equal(rows.filter((r) => r.label === "generated pre-Q-03").length, 4);
});

test("every scorecard carries all 21 MQ keys with their producer, and the bench columns read them", () => {
  /* MUTATION: drop MQ-12 from JUDGED_FIELDS. Ran it: red. */
  const card = synthCard();
  assert.deepEqual(Object.keys(card), MQ_IDS);
  for (const id of MQ_IDS) assert.ok(["report", "candidate", "judged", "listen"].includes(card[id].source), id);
  const values = scorecardValues(card);
  assert.equal(values.mq07_shows, 2);
  assert.equal(values.mq16_over25, 2);
  assert.equal(values.mq21, null);
  assert.equal(scorecardValues(synthCard({ entry: { publishable: true } })).mq21, "yes");
  for (const col of SCORECARD_COLUMNS) assert.equal(col.group, "detail", col.key);
});

test("the CLI refuses ambiguous or incomplete arguments", () => {
  /* MUTATION: drop the `--candidate` xor `--forays` check. Ran it: red. */
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["--candidate", "a.json", "--forays", "b.json"]), /usage/);
  assert.throws(() => parseArgs(["--candidate", "a.json", "--check"]), /apply to --forays/);
  assert.throws(() => parseArgs(["--forays", "b.json", "--write", "--check"]), /not both/);
  assert.throws(() => parseArgs(["--forays"]), /needs a value/);
  assert.throws(() => parseArgs(["--candidate", "a.json", "--entry", "0"]), /1-based/);
  assert.equal(parseArgs(["--forays", "b.json", "--ids", "x,y"]).ids.length, 2);
});

test("--candidate prints one scorecard line; a judged.json beside the candidate is read", () => {
  /* MUTATION: skip judgedPathFor() in main(). Ran it: red. */
  const dir = tmpdir();
  const file = path.join(dir, "score-synth.json");
  fs.copyFileSync(SYNTH, file);
  fs.writeFileSync(path.join(dir, "score-synth.judged.json"), JSON.stringify({ questionsVersion: 1, "MQ-10": 4 }));
  const lines = [];
  assert.equal(main(["--candidate", file, "--segments", path.join(dir, "none.json"), "--segment-sources", path.join(dir, "none.json")], (s) => lines.push(s)), 0);
  const row = JSON.parse(lines[0]);
  assert.equal(row.id, "score-synth");
  assert.equal(row.scorecard["MQ-10"].value, 4);
  assert.equal(row.scorecard["MQ-01"].value, null);
});

test("the KPI doc lists every MQ id with its source and today's availability", () => {
  /* MUTATION: delete the MQ-12 row from the doc's scorecard table. Ran it: red. */
  const doc = fs.readFileSync(path.join(REPO_ROOT, "docs", "curation", "generation-kpis.md"), "utf8");
  assert.match(doc, /### The quality scorecard \(GV-24, MQ-01\.\.MQ-21\)/);
  for (const id of MQ_IDS) {
    assert.match(doc, new RegExp(`^\\| ${id} \\| [^|]+ \\| ${MQ_SOURCES[id]} \\| [^|]+ \\| [^|]+ \\|$`, "m"), `${id} row`);
  }
});
