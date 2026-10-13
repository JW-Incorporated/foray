/* Tests for the G-42a benchmark harness. Run: node --test tools/generation-bench/
 *
 * WHAT IS ACTUALLY AT RISK HERE, AND THEREFORE WHAT THIS SUITE PINS
 * The harness prints numbers that go into a roadmap deck and, once D11 lands,
 * into a CI regression job. Every failure mode it has is a QUIET one — a number
 * that is wrong but plausible — so a suite that only checked "it renders a
 * table" would be worthless. The four things it pins are the four rules the
 * harness's own header states:
 *
 *   1. A missing field is ABSENT, never zero. Reports grew field by field
 *      across runs 4-9; `?? 0` anywhere in the read path publishes a
 *      fabricated KPI that reads as a clean run. Tests 1-8.
 *   2. A target is named only where §1.2 settled it. Tests 9-13.
 *   3. `tapeShare` (the report's, Q-05) and tape-over-runtime (the candidate's,
 *      the reading §1.2 quotes) are different numbers. Tests 14-16.
 *   4. Clip lengths are measured on the candidate, from its minted rows and the
 *      committed pool, or not at all. Tests 17-22.
 *
 * GV-04 (TM-10) adds the tests at the end: `entry.ms` is the SUM of the stage
 * durations, so the clock time is a separate column (`elapsed_min`: the
 * report's own `elapsedMs`, else the span of its stage timings), and every
 * column is `core` or `detail` so later columns can land without re-cutting
 * the committed KPI table.
 *
 * THE FIXTURES ARE REAL REPORTS
 * `fixtures/out-4/report.json` is run 4's report verbatim (the sparse one: a
 * `no-tape` stop with no `calls`, no `veracity`) and `fixtures/out-9/report.json`
 * is run 9's verbatim except that `entry.file`'s absolute host path is cut to
 * the basename the fixture carries. A hand-built report would have been more
 * forgiving than either — the whole point of rule 1 is what the REAL files
 * leave out, and an author writing a fixture writes the fields they remember.
 *
 * The candidate beside run 9's report IS redacted, to the five fields the
 * harness reads (`runtimeSec`, `items[].type/segment_id`, `segments[].id/
 * startSec/endSec`): the unredacted file is 41 KB of narration prose that
 * proves nothing here. `fixtures/segments.json` holds the four tier-1 pool rows
 * run 9 plays without minting, so the pool path is exercised offline.
 *
 * Every test names the one-line mutation that makes it pass falsely, and every
 * one was run against that mutation before this landed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ABSENT,
  candidateIdFor,
  loadListening,
  COLUMNS,
  CORE,
  DETAIL,
  PROPOSED,
  SETTLED,
  candidatePathFor,
  clipDurations,
  clipStats,
  collectRows,
  costUsdFor,
  formatCell,
  formatTable,
  jsonlLine,
  loadSegmentPool,
  main,
  markdownHeader,
  markdownRow,
  minutes,
  num,
  parseArgs,
  resolveReportPath,
  rowFor,
  rowFromJsonl,
  rowsForReport,
  runIdFor,
  runLogPathFor,
  spanMsOf,
  spliceRows,
  stackOf,
  tableColumns,
  targetFor,
  targetLabel,
  tierOf,
  tierTargetsLabel,
  seconds,
  TIER_TARGETS,
  ROWS_BEGIN,
  ROWS_END
} from "./run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FIXTURES = path.join(HERE, "fixtures");
const POOL = loadSegmentPool(path.join(FIXTURES, "segments.json"));

const run4 = () => rowsForReport(path.join(FIXTURES, "out-4", "report.json"), { pool: POOL })[0];
const run9 = () => rowsForReport(path.join(FIXTURES, "out-9", "report.json"), { pool: POOL })[0];

const column = (key) => COLUMNS.find((c) => c.key === key);
/* GV-17: the runlog's speed columns, in print order. */
const SPEED_KEYS = ["out_tok", "series", "reasks", "queue_p50", "ttft_p50", "cached", "prose_tps", "code_s", "render_x", "spark_s"];
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "g42a-"));

/* =================================================================== */
/* 1-8. Rule 1 — a missing field is ABSENT, never zero                  */
/* =================================================================== */

test("num() reads a missing, null or non-numeric field as absent", () => {
  /* MUTATION: `return typeof value === "number" ? value : 0` in num(). */
  assert.equal(num(undefined), null);
  assert.equal(num(null), null);
  assert.equal(num("7"), null);
  assert.equal(num(Number.NaN), null);
  assert.equal(num(0), 0, "a real measured zero is still a zero");
  assert.equal(num(0.05), 0.05);
});

test("minutes() of an absent duration is absent, not a zero-minute run", () => {
  /* MUTATION: `return (num(ms) ?? 0) / 60000` in minutes(). */
  assert.equal(minutes(undefined), null);
  assert.equal(minutes(null), null);
  assert.equal(minutes(120000), 2);
});

test("run 4's report carries no veracity block and every KPI cell is absent", () => {
  /* MUTATION: `const v = entry.veracity || {}` -> seed the object with zeros,
     e.g. `{ unverifiedPages: 0, introRestates: 0, ...entry.veracity }`. */
  const row = run4();
  assert.equal(row.values.outcome, "no-tape");
  for (const key of [
    "tape_share",
    "pages_per_seam",
    "narration_share",
    "first_pass",
    "unverified",
    "synth_verified",
    "seed_lost",
    "intro_restates",
    "calls_per_beat",
    "tokens"
  ]) {
    assert.equal(row.values[key], null, `${key} must be absent on run 4`);
    assert.equal(row.sources[key], "absent");
  }
});

test("run 4's report has no `calls` field, so the calls cell is absent and not 0", () => {
  /* MUTATION: `calls: num(entry.calls) ?? 0` in rowFor().
     The run ledger says run 4 spent 7 calls; the REPORT does not say so, and
     the harness prints what the report says. */
  const report = JSON.parse(fs.readFileSync(path.join(FIXTURES, "out-4", "report.json"), "utf8"));
  assert.equal("calls" in report.entries[0], false, "fixture drift: run 4's row gained a calls field");
  assert.equal(run4().values.calls, null);
  assert.equal(run4().sources.calls, "absent");
});

test("no report written so far carries seedLostBeats, so the column is absent on both fixtures", () => {
  /* MUTATION: `seed_lost: num(v.seedLostBeats) ?? 0`.
     F-99 added the field after run 9; `buildVeracityMetrics` reports it as null
     "rather than guessed at zero" for older callers, and so does this. */
  assert.equal(run4().values.seed_lost, null);
  assert.equal(run9().values.seed_lost, null);
  const report = JSON.parse(fs.readFileSync(path.join(FIXTURES, "out-9", "report.json"), "utf8"));
  assert.equal("seedLostBeats" in report.entries[0].veracity, false, "fixture drift: run 9 gained seedLostBeats");
});

test("a measured zero is printed as 0, and told apart from an absent field", () => {
  /* MUTATION: `if (!value) return ABSENT` at the top of formatCell().
     Run 9 really did have 0 synthesis-verified pages and 0 intro restatements;
     both must print as zeros, not as dashes, or F-88's and Q-02's live
     readings vanish from the trend. */
  const row = run9();
  assert.equal(row.values.synth_verified, 0);
  assert.equal(row.values.intro_restates, 0);
  assert.equal(formatCell(column("synth_verified"), row), "0");
  assert.equal(formatCell(column("intro_restates"), row), "0");
  assert.equal(row.sources.synth_verified, "report");
  assert.equal(formatCell(column("seed_lost"), row), ABSENT);
});

test("cost is never derived from tokens or a list price", () => {
  /* MUTATION: `?? num(entry.veracity?.pipelineTokens) * 3e-6` in costUsdFor().
     §1.2's "[estimated] ~ $1-4 per attempt" is an estimate because nobody has
     measured it; D0 is where it stops being one, not this file. */
  assert.equal(run9().values.cost_usd, null);
  assert.equal(run9().values.tokens, 128050, "the tokens the price would have been faked from");
  assert.equal(costUsdFor({ veracity: { pipelineTokens: 999999 } }, {}), null);
});

test("cost fills itself the day a report carries usage.costUsd", () => {
  /* MUTATION: `export function costUsdFor() { return null; }`.
     The column is empty today because no report has the field, not because the
     harness refuses to read one. */
  assert.equal(costUsdFor({ usage: { costUsd: 3.5 } }, {}), 3.5);
  assert.equal(costUsdFor({ costUsd: 1.25 }, {}), 1.25);
  assert.equal(costUsdFor({}, { usage: { costUsd: 8 } }), 8);
});

/* =================================================================== */
/* 9-13. Rule 2 — a target is named only where §1.2 settled it          */
/* =================================================================== */

test("the proposed targets are exactly the §1.2 rows marked *proposed*, on the column whose denominator the row names", () => {
  /* MUTATION: change `targetState: PROPOSED` to SETTLED on tape_of_runtime.
     These five are the ones §1.2's Target column marks *proposed*, all of them
     waiting on D0. Anything else with a target is settled.
     SECOND MUTATION (F-101): move the >= 70 % target back onto `tape_share`.
     §1.2's row is titled "Tape share OF RUNTIME" and its history divides tape
     by the candidate's whole runtime; `tape_share` divides by tape + narration
     and read 0.684 on run 9 where the row's own quantity read 0.557. Grading a
     proposed founder target against the flattering number is the defect F-101
     is about. Ran it — red here and in the target-label test. */
  /* GV-52 (R1-16): elapsed_min's <= 6 min and ttl_a1_min's 0.5 min targets
     are superseded by the per-tier delivery targets (TIER_TARGETS), so
     neither column carries a single target any more. */
  const proposed = COLUMNS.filter((c) => c.targetState === PROPOSED).map((c) => c.key).sort();
  assert.deepEqual(proposed, ["cost_usd", "narration_share", "pages_per_seam", "tape_of_runtime"]);
  const settled = COLUMNS.filter((c) => c.targetState === SETTLED).map((c) => c.key).sort();
  assert.deepEqual(settled, ["calls_per_beat", "first_pass_pages", "intro_restates", "tokens", "unverified"]);
  /* The 80 % first-attempt target is §1.2's "first-attempt PAGE pass rate", so
     it sits on the pages column and on neither of the other two. */
  assert.equal(column("first_pass_beats").target, undefined);
  assert.equal(column("first_pass").target, undefined);
});

test("every column with a target declares whether it is settled, and vice versa", () => {
  /* MUTATION: drop `targetState` from one column's definition.
     A target with no state would print as settled by default, which is the
     exact laundering rule 2 forbids. */
  for (const col of COLUMNS) {
    const hasTarget = col.target !== undefined && col.target !== null;
    const hasState = col.targetState === PROPOSED || col.targetState === SETTLED;
    assert.equal(hasTarget, hasState, `${col.key}: target and targetState must agree`);
  }
});

test("a proposed target prints with `?` and a settled one prints plain", () => {
  /* MUTATION: `return n` (drop the `?`) in targetLabel(). */
  assert.equal(targetLabel(column("tape_of_runtime")), "0.700?");
  assert.equal(targetLabel(column("elapsed_min")), "", "GV-52: the 6 min target is superseded by R1-16");
  assert.equal(targetLabel(column("ttl_a1_min")), "", "GV-52: the 0.5 min target is superseded by R1-16");
  assert.equal(targetLabel(column("first_s")), "per tier");
  assert.equal(targetLabel(column("wall_min")), "", "TM-10: the stage sum is not wall time and grades against nothing");
  assert.equal(targetLabel(column("first_pass_pages")), "0.80");
  assert.equal(targetLabel(column("tape_share")), "", "F-101: the report's tape/(tape+narration) grades against nothing");
  assert.equal(targetLabel(column("unverified")), "0");
  assert.equal(targetLabel(column("clips")), "", "a column with no target names none");
});

test("the legend says what `?` means and names D0", () => {
  /* MUTATION: delete the "targets:" legend line from formatTable().
     A table of numbers with `?` beside some of them and no key is worse than
     one with no targets at all. */
  const table = formatTable([run9()]);
  assert.match(table, /a bare number is SETTLED; a number with \? is PROPOSED and waits on founder decision D0/);
  assert.match(table, /never read as zero/);
});

test("nothing in the harness compares a value to a target", () => {
  /* MUTATION: add a `pass`/`fail` field to jsonlLine or a verdict column.
     G-42a's card: "a trend with a tolerance band rather than a hard pass/fail
     - LLM runs are non-deterministic and a hard gate would be flaky by
     construction." Run 9 missed every settled target; the row says so only by
     printing the numbers. */
  const line = JSON.parse(jsonlLine(run9()));
  assert.deepEqual(Object.keys(line).sort(), [
    "calls_by_stage",
    "candidate_read",
    "clips_measured",
    "generated_at",
    "last_listen",
    "metrics",
    "outcome",
    "prompt",
    "prose_basis",
    "run",
    "sources",
    "tier",
    "valid"
  ]);
  const table = formatTable([run9()]);
  assert.equal(/\b(PASS|FAIL|OK|BAD|regressed|over target|under target)\b/.test(table), false, "no verdict is rendered");
});

/* =================================================================== */
/* 14-16. Rule 3 — two different numbers are both called "tape share"   */
/* =================================================================== */

test("tape_share is the report's Q-05 number and tape_of_runtime is the candidate's", () => {
  /* MUTATION: `tape_of_runtime: num(v.tapeShare)` in rowFor().
     The report's is tape / (tape + narration) as the writer estimated it; the
     candidate's is tape / runtimeSec, which also counts jingles and markers -
     the reading §1.2 quotes as "59-61 % (runs 5-7), 78 % (run 8)". */
  const row = run9();
  assert.equal(row.values.tape_share, 0.6842928756466785);
  assert.equal(row.sources.tape_share, "report");
  assert.equal(Number(row.values.tape_of_runtime.toFixed(3)), 0.557);
  assert.equal(row.sources.tape_of_runtime, "candidate");
  assert.notEqual(row.values.tape_share, row.values.tape_of_runtime);
});

test("F-101 — the two first-attempt units are separate columns, and an undeclared unit is never guessed into one", () => {
  /* MUTATION: `first_pass_pages: num(v.firstAttemptPassRate)` in rowFor(), or
     drop the `=== undefined` guard so a declaring report fills `1stPass?` too.
     Runs 4-8's 0.68 is a share of kept PAGES; run 9's 0.048 is a share of
     narration BEATS the verifier confirmed on round 1, and the old reports say
     which only by their vintage. Folding them into one column is the defect
     F-101 is about: `writeAct.ts` cites run 8's 0.68 against run 9's 0.048 as
     evidence the Q-03 contract did not converge, and that pair is two
     different measurements. Ran it - red on run 9's columns below. */
  const legacy = run9();
  /* Run 9's committed report predates F-101: one scalar, no unit. */
  assert.equal(legacy.values.first_pass, 0.047619047619047616);
  assert.equal(legacy.sources.first_pass, "report");
  assert.equal(legacy.values.first_pass_pages, null);
  assert.equal(legacy.values.first_pass_beats, null);
  assert.equal(legacy.sources.first_pass_pages, "absent");
  assert.equal(legacy.sources.first_pass_beats, "absent");

  /* A report written from F-101 on declares both, and the undeclared column
     goes absent rather than repeating one of them. */
  const declared = rowFor(
    { outcome: "generated", detail: "OK x", veracity: { firstAttemptPassRate: 0.05, firstAttemptUnit: "beats", firstAttemptPassRatePages: 0.6, firstAttemptPassRateBeats: 0.05 } },
    { runId: "run-10" }
  );
  assert.equal(declared.values.first_pass_pages, 0.6);
  assert.equal(declared.values.first_pass_beats, 0.05);
  assert.equal(declared.values.first_pass, null);
  assert.equal(declared.sources.first_pass, "absent");
});

test("F-101 — tape_share reads the renamed report field and falls back to the old name", () => {
  /* MUTATION: read only `v.tapeShare`, or only `v.tapeOfTapePlusNarration`.
     The first leaves every post-F-101 report's column empty; the second leaves
     runs 4-9's empty and erases the trend the harness exists to draw. The two
     names are the same quantity, so reading either is a rename, not a guess. */
  const renamed = rowFor({ outcome: "generated", veracity: { tapeOfTapePlusNarration: 0.71, narrationOfTapePlusNarration: 0.29 } }, { runId: "run-10" });
  assert.equal(renamed.values.tape_share, 0.71);
  assert.equal(renamed.values.narration_share, 0.29);
  const old = rowFor({ outcome: "generated", veracity: { tapeShare: 0.684, narrationShare: 0.316 } }, { runId: "run-9" });
  assert.equal(old.values.tape_share, 0.684);
  assert.equal(old.values.narration_share, 0.316);
});

test("the candidate reading reproduces the roadmap's own 56 % for run 9", () => {
  /* MUTATION: divide by (tapeSec + narrationSec) instead of runtimeSec in
     clipStats(). The deck's run-9 line reads "tape share 56 % (run 8: 78 %)",
     measured on the candidate; reproducing it is what makes the backfilled
     rows checkable against the ledger at all. */
  const candidate = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "out-9", "what-engineers-actually-do-all-day-how-e-4e64fd43.json"), "utf8")
  );
  const stats = clipStats(candidate, POOL);
  assert.equal(stats.runtimeSec, 1929.48);
  assert.equal(Math.round(stats.tapeOfRuntime * 100), 56);
});

test("tape_of_runtime is absent, not zero, when no clip could be measured", () => {
  /* MUTATION: `tapeOfRuntime: tapeSec / runtimeSec` unguarded in clipStats()
     - which is 0/1929 = 0, a Foray reported as having played no tape. */
  const candidate = { runtimeSec: 1000, items: [{ type: "segment", segment_id: "nobody-knows-this" }], segments: [] };
  const stats = clipStats(candidate, new Map());
  assert.equal(stats.count, 1);
  assert.equal(stats.measured, 0);
  assert.equal(stats.tapeOfRuntime, null);
  assert.equal(stats.meanSec, null);
  assert.equal(stats.maxSec, null);
});

/* =================================================================== */
/* 17-22. Rule 4 — clip lengths come from the candidate, or not at all  */
/* =================================================================== */

test("clip mean and max are measured over minted rows AND committed pool rows", () => {
  /* MUTATION: delete the `pool.get(item.segment_id)` branch in clipStats().
     Run 9 minted 6 of its 10 clips and pointed at 4 rows already in
     `data/segments.json`. Reading only the candidate silently drops those four
     and reports a mean over 6 clips as the run's mean. */
  const row = run9();
  assert.equal(row.values.clips, 10);
  assert.equal(row.meta.clips_measured, 10);
  assert.equal(Number(row.values.clip_mean_s.toFixed(1)), 107.5);
  assert.equal(Number(row.values.clip_max_s.toFixed(1)), 188.3);
});

test("an unresolved clip lowers `measured` and marks the cell, instead of being dropped silently", () => {
  /* MUTATION: `count: durations.length` in clipStats(), so count and measured
     always agree and the `*` can never appear. */
  const row = rowsForReport(path.join(FIXTURES, "out-9", "report.json"), { pool: new Map() })[0];
  assert.equal(row.values.clips, 10, "all ten clips are still counted");
  assert.equal(row.meta.clips_measured, 6, "only the six minted rows resolve without the pool");
  assert.match(formatCell(column("clip_mean_s"), row), /\*$/);
  assert.equal(formatCell(column("clips"), row), "10", "the count itself is never starred");
});

test("with no candidate beside the report, the clip columns are absent", () => {
  /* MUTATION: `const clips = candidateFile ? clipStats(...) : { count: 0, ... }`
     in rowsForReport(). Run 4 stopped at sourcing and wrote no candidate; a
     zero-clip row would say it played no tape rather than that it never got
     that far. */
  const row = run4();
  assert.equal(row.meta.candidate_read, false);
  assert.equal(row.values.clips, null);
  assert.equal(row.values.clip_mean_s, null);
  assert.equal(row.values.tape_of_runtime, null);
  assert.equal(row.sources.clips, "absent");
});

test("the candidate is found by basename beside the report, never by the report's absolute path", () => {
  /* MUTATION: `return fs.existsSync(entry.file) ? entry.file : null` in
     candidatePathFor(). `entry.file` is an absolute path on the generation
     host; following it reads a stale file on that one machine and nothing
     anywhere else, which is invisible until two runs disagree. */
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "cand.json"), JSON.stringify({ runtimeSec: 10, items: [], segments: [] }));
  const reportPath = path.join(dir, "report.json");
  const found = candidatePathFor({ file: "Z:\\gone\\host\\only\\cand.json" }, reportPath);
  assert.equal(found, path.join(dir, "cand.json"));
  assert.equal(candidatePathFor({ file: "Z:\\gone\\absent.json" }, reportPath), null);
  assert.equal(candidatePathFor({}, reportPath), null);
  assert.equal(candidatePathFor({ file: "" }, reportPath), null);
});

test("--candidates points the search at another directory", () => {
  /* MUTATION: ignore `candidatesDir` in candidatePathFor().
     The bench archives reports and candidates apart on the host; without this
     the clip columns go quietly empty rather than failing. */
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "c.json"), "{}");
  assert.equal(candidatePathFor({ file: "/x/c.json" }, "/nowhere/report.json", dir), path.join(dir, "c.json"));
});

test("a pool row with no start or end is not measured as a zero-length clip", () => {
  /* MUTATION: `durations.push((row.end_sec || 0) - (row.start_sec || 0))`.
     A malformed pool row would otherwise pull the mean toward zero and count
     as measured. */
  const pool = new Map([["broken", { id: "broken", start_sec: 10 }]]);
  const stats = clipStats({ runtimeSec: 100, items: [{ type: "segment", segment_id: "broken" }], segments: [] }, pool);
  assert.equal(stats.count, 1);
  assert.equal(stats.measured, 0);
});

/* =================================================================== */
/* 23-27. Rows, provenance and rendering                                */
/* =================================================================== */

test("`valid` asks the driver's own publishable question, not the outcome field", () => {
  /* MUTATION: `valid: entry.outcome === "generated" ? "yes" : "no"`.
     Run 5's row reads `outcome: "generated"` with `detail: "INVALID ... D5
     FAIL ..."` - the pipeline built a candidate and check-forays refused it.
     generateForays.ts counts publishable runs by the `detail` prefix, and a
     bench that called run 5 a success would put a phantom Foray in the trend. */
  const row = rowsForReport(path.join(FIXTURES, "out-9", "report.json"), { pool: POOL })[0];
  assert.equal(row.values.valid, "yes");
  const invalid = { outcome: "generated", detail: "INVALID the-real-work — D5 FAIL: ...", ms: 1 };
  assert.equal(rowFromJsonl(jsonlLine({ ...invalid, values: {}, sources: {}, meta: {} })).values.valid, null);
  const built = rowsForReport(writeReport(tmpdir(), [invalid]), {})[0];
  assert.equal(built.values.outcome, "generated");
  assert.equal(built.values.valid, "no");
});

test("every cell's source says report, candidate, derived or absent - and absent iff the value is null", () => {
  /* MUTATION: `sources[col.key] = col.from` unconditionally in rowFor().
     The `sources` map is how a consumer tells "the run did not do it" from
     "the file did not say", which is the whole of rule 1 in machine form. */
  for (const row of [run4(), run9()]) {
    for (const col of COLUMNS) {
      const absent = row.values[col.key] === null || row.values[col.key] === undefined;
      assert.equal(row.sources[col.key] === "absent", absent, `${row.values.run}/${col.key}`);
      if (!absent) assert.equal(row.sources[col.key], col.from);
    }
  }
  assert.equal(run9().sources.tokens, "report");
  assert.equal(run9().sources.wall_min, "derived");
  assert.equal(run9().sources.clip_max_s, "candidate");
});

test("an absent cell prints the dash and never a zero", () => {
  /* MUTATION: `return String(value ?? 0)` in formatCell(). */
  const table = formatTable([run4(), run9()]);
  const run4Line = table.split("\n").find((l) => l.trim().startsWith("run-4"));
  assert.equal(run4Line.includes("0"), false, `run 4's row must contain no zeros: ${run4Line}`);
  /* GV-52 added four core columns (tier, 1stAudio s, allReady s, minLead s),
     all absent on run 4: 20 + 4. */
  assert.equal((run4Line.match(/—/g) || []).length, 24);
});

test("the machine line is one line per run, and absent metrics survive as null", () => {
  /* MUTATION: `JSON.stringify(obj, null, 2)` in jsonlLine(), or drop null
     metrics from the object. G-42b diffs these line by line; a pretty-printed
     or hole-punched line breaks both the diff and rule 1. */
  const line = jsonlLine(run9());
  assert.equal(line.includes("\n"), false);
  const parsed = JSON.parse(line);
  assert.equal(parsed.metrics.seed_lost, null);
  assert.equal("seed_lost" in parsed.metrics, true, "the key stays even when the value is absent");
  assert.equal(parsed.metrics.tokens, 128050);
  const numeric = COLUMNS.filter((c) => c.kind === "number").map((c) => c.key).sort();
  assert.deepEqual(Object.keys(parsed.metrics).sort(), numeric);
});

test("a baseline line round-trips back into the same table row", () => {
  /* MUTATION: drop `valid` (or any metric) from jsonlLine()'s object.
     G-42b reads the committed baseline without the archived reports, so
     anything the line loses is a column the regression job cannot see. */
  const row = run9();
  const back = rowFromJsonl(jsonlLine(row));
  assert.equal(markdownRow(back), markdownRow(row));
});

/* =================================================================== */
/* 28-31. The run id, multiple entries, and the CLI                     */
/* =================================================================== */

test("the run id comes from the out-N directory the host writes", () => {
  /* MUTATION: `return dir` in runIdFor().
     The host writes relay/run/out-9; the deck, the ledger and the baseline all
     say "run 9". The rewrite is the only thing that keeps the three joinable. */
  assert.equal(runIdFor("/x/relay/run/out-9/report.json"), "run-9");
  assert.equal(runIdFor("/x/relay/run/out-12/report.json"), "run-12");
  assert.equal(runIdFor("/x/nightly-bench/report.json"), "nightly-bench");
});

test("a report with two prompts yields two rows, distinguished by index", () => {
  /* MUTATION: `const id = runId` in rowsForReport().
     G-42a's bench is "two Forays per run" (roadmap §7), so the two-entry
     report is the SHAPE the scheduled job will write - one row each, or the
     second silently overwrites the first in every consumer keyed by run id. */
  const dir = tmpdir();
  const file = writeReport(dir, [
    { prompt: "a", outcome: "generated", detail: "OK a", ms: 60000, veracity: { pipelineTokens: 10 } },
    { prompt: "b", outcome: "no-tape", detail: "no tape", ms: 30000 }
  ]);
  const rows = rowsForReport(file, {});
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.values.run), [`${runIdFor(file)}#1`, `${runIdFor(file)}#2`]);
  assert.equal(rows[0].values.wall_min, 1);
  assert.equal(rows[1].values.tokens, null);
});

test("a directory argument is read as its report.json, and --format selects one output", () => {
  /* MUTATION: `if (args.format === "both") ...` dropped from main()'s table
     branch, so --format jsonl also prints the table into the redirected file. */
  assert.equal(resolveReportPath(path.join(FIXTURES, "out-9")), path.join(FIXTURES, "out-9", "report.json"));
  const seg = path.join(FIXTURES, "segments.json");
  const jsonlOut = [];
  main(["--format", "jsonl", "--segments", seg, path.join(FIXTURES, "out-9")], (s) => jsonlOut.push(s));
  assert.equal(jsonlOut.length, 1);
  JSON.parse(jsonlOut[0]);
  const tableOut = [];
  main(["--format", "table", "--segments", seg, path.join(FIXTURES, "out-9")], (s) => tableOut.push(s));
  assert.equal(tableOut.join("\n").includes('{"run"'), false);
  assert.match(tableOut.join("\n"), /run-9/);
});

test("parseArgs refuses an unknown flag, an empty target list and a mis-scoped --run-id", () => {
  /* MUTATION: `else args.targets.push(a)` for every unrecognised argument,
     so `--fromat jsonl` becomes two report paths and the run reads nothing. */
  assert.throws(() => parseArgs(["--fromat", "jsonl", "x"]), /unknown flag --fromat/);
  assert.throws(() => parseArgs([]), /usage:/);
  assert.throws(() => parseArgs(["--format", "csv", "x"]), /unknown --format csv/);
  assert.throws(() => parseArgs(["--run-id", "run-9", "a", "b"]), /--run-id names one run/);
  assert.equal(parseArgs(["--run-id", "run-9", "a"]).runId, "run-9");
});

/* =================================================================== */
/* 32-35. The KPI doc: splicing, and the committed table                */
/* =================================================================== */

test("a run id already in the doc is replaced, not appended a second time", () => {
  /* MUTATION: `const kept = existing` in spliceRows().
     A scheduled bench re-reading an archived report would otherwise grow the
     trend table by a duplicate row on every run. */
  const doc = `head\n${ROWS_BEGIN}\n| run-9 | old |\n${ROWS_END}\ntail\n`;
  const row = run9();
  const once = spliceRows(doc, [row]);
  assert.equal((once.match(/\| run-9 \|/g) || []).length, 1);
  assert.equal(once.includes("| run-9 | old |"), false);
  assert.equal(spliceRows(once, [row]), once, "splicing the same row twice is idempotent");
});

test("rows sort by run number, so run-10 lands after run-9", () => {
  /* MUTATION: `merged.sort()` (lexicographic) in spliceRows(), which puts
     run-10 between run-1 and run-2 and makes the trend read backwards. */
  const doc = `${ROWS_BEGIN}\n| run-10 | x |\n| run-9 | y |\n| run-4 | z |\n${ROWS_END}\n`;
  const order = spliceRows(doc, [])
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split("|")[1].trim());
  assert.deepEqual(order, ["run-4", "run-9", "run-10"]);
});

test("splicing into a document with no marker block fails loudly", () => {
  /* MUTATION: `if (begin === -1) return doc + rows.join("\\n")`.
     Appending to the end of a document that has no table is a silent corruption
     of a committed deck. */
  assert.throws(() => spliceRows("no markers here\n", [run9()]), /no <!-- bench:rows:begin -->/);
  assert.throws(() => spliceRows(`${ROWS_END}\n${ROWS_BEGIN}\n`, [run9()]), /no <!-- bench:rows:begin -->/);
});

test("the committed KPI doc's header matches the harness's columns", () => {
  /* MUTATION: add a column to COLUMNS without re-generating the doc.
     The header is committed text and the rows are spliced in; a column added
     on one side shifts every cell in the committed table one place. */
  const doc = fs.readFileSync(path.join(REPO_ROOT, "docs", "curation", "generation-kpis.md"), "utf8");
  const [header, rule] = markdownHeader();
  assert.equal(doc.includes(header), true, `the doc's table header must read:\n${header}`);
  assert.equal(doc.includes(rule), true);
  assert.equal(doc.indexOf(header) < doc.indexOf(ROWS_BEGIN), true, "the header sits above the spliced rows");
});

test("the committed KPI table is exactly what the committed baseline renders", () => {
  /* MUTATION: hand-edit one cell in docs/curation/generation-kpis.md (say
     run-8's tape/rt to 0.700), or delete a line from baseline.jsonl.
     The archived reports live on the generation host, not in the repo, so this
     pair is the only thing that can catch a number in the deck drifting from
     the number the harness produced. */
  const doc = fs.readFileSync(path.join(REPO_ROOT, "docs", "curation", "generation-kpis.md"), "utf8");
  const committed = doc
    .slice(doc.indexOf(ROWS_BEGIN) + ROWS_BEGIN.length, doc.indexOf(ROWS_END))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const baseline = fs
    .readFileSync(path.join(HERE, "baseline.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => markdownRow(rowFromJsonl(l)));
  assert.deepEqual(committed, baseline);
  assert.equal(baseline.length, 6, "runs 4-9 are backfilled");
});

test("the committed baseline carries no zero standing in for an unmeasured field", () => {
  /* MUTATION: regenerate the baseline from a harness with `?? 0` in the read
     path. This is rule 1 asserted on the artefact rather than on the code:
     every metric is either a number whose source names a file, or null whose
     source is "absent". */
  const lines = fs
    .readFileSync(path.join(HERE, "baseline.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.run), ["run-4", "run-5", "run-6", "run-7", "run-8", "run-9"]);
  for (const line of lines) {
    for (const [key, value] of Object.entries(line.metrics)) {
      const source = line.sources[key];
      assert.equal(value === null, source === "absent", `${line.run}/${key}: ${value} vs source ${source}`);
      if (value !== null) assert.equal(["report", "candidate", "derived"].includes(source), true);
    }
  }
  /* Every report so far: no cost, no seed-lost beats. */
  assert.deepEqual([...new Set(lines.map((l) => l.metrics.cost_usd))], [null]);
  assert.deepEqual([...new Set(lines.map((l) => l.metrics.seed_lost))], [null]);
});

test("collectRows reads several reports into one table", () => {
  /* MUTATION: `return rows` inside collectRows()'s loop, so only the first
     report is ever read and a multi-run trend renders one row. */
  const rows = collectRows({
    targets: [path.join(FIXTURES, "out-4"), path.join(FIXTURES, "out-9")],
    segments: path.join(FIXTURES, "segments.json"),
    candidatesDir: null,
    runId: null
  });
  assert.deepEqual(rows.map((r) => r.values.run), ["run-4", "run-9"]);
  const table = formatTable(rows);
  assert.equal(table.split("\n").filter((l) => /^\s*run-\d/.test(l)).length, 2);
});

/* =================================================================== */
/* GV-04 (TM-10). Elapsed time beside the stage sum; core/detail groups */
/* =================================================================== */

const run9Timings = () =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, "out-9", "report.json"), "utf8")).entries[0].veracity.stageTimings;

test("TM-10: run 9's stage timings span 2,676,202 ms, printed as 44.6 elapsed beside the 107.7 stage sum", () => {
  /* MUTATION: `return stageTimings.reduce((sum, t) => sum + t.ms, 0)` in
     spanMsOf() (the stage sum again), or `last = start` (drop `+ ms`). Ran
     both: red. Run 9's four narrate stages ran side by side, so the sum is
     6,460,925 ms and the clock 2,676,202 ms (04:38:34.525 to 05:23:10.727). */
  assert.equal(spanMsOf(run9Timings()), 2676202);
  const row = run9();
  assert.equal(row.values.elapsed_min, 2676202 / 60000);
  assert.equal(row.sources.elapsed_min, "derived");
  assert.equal(formatCell(column("elapsed_min"), row), "44.6");
  assert.equal(formatCell(column("wall_min"), row), "107.7");
  const out = [];
  main(["--format", "table", "--segments", path.join(FIXTURES, "segments.json"), path.join(FIXTURES, "out-9")], (s) => out.push(s));
  const lines = out.join("\n").split("\n");
  const header = lines[0].trim().split(/\s{2,}/);
  const cells = lines.find((l) => l.trim().startsWith("run-9")).trim().split(/\s{2,}/);
  assert.equal(cells[header.indexOf("stageSum m")], "107.7");
  assert.equal(cells[header.indexOf("elapsed m")], "44.6");
  assert.equal(header.indexOf("elapsed m"), header.indexOf("stageSum m") + 1, "elapsed sits beside the stage sum");
});

test("TM-10: a stage timing marked resumed is left out of the span", () => {
  /* MUTATION: drop the `t.resumed === true` skip in spanMsOf(). Ran it: red.
     A banked stage carries the EARLIER attempt's startedAt; keeping it would
     stretch the span over the hours between the two attempts. */
  const timings = [
    { name: "understand", startedAt: "2026-09-12T01:00:00.000Z", ms: 60000, resumed: true },
    { name: "spine", startedAt: "2026-09-12T04:00:00.000Z", ms: 30000 },
    { name: "narrate:0", startedAt: "2026-09-12T04:00:30.000Z", ms: 90000 },
    { name: "narrate:1", startedAt: "2026-09-12T04:00:30.000Z", ms: 60000 }
  ];
  assert.equal(spanMsOf(timings), 120000);
  assert.equal(spanMsOf(timings.slice(0, 1)), null, "only resumed timings: nothing was measured this attempt");
  const row = rowFor({ outcome: "generated", ms: 240000, veracity: { stageTimings: timings } }, { runId: "run-x" });
  assert.equal(row.values.elapsed_min, 2);
  assert.equal(row.values.wall_min, 4);
});

test("TM-10: a report's own elapsedMs wins over the derived span", () => {
  /* MUTATION: `spanMsOf(v.stageTimings) ?? num(entry.elapsedMs)` in rowFor()
     (the order flipped). Ran it: red. Reports written after the per-run log
     (GV-01) carry elapsedMs. */
  const row = rowFor(
    { outcome: "generated", ms: 6460925, elapsedMs: 2700000, veracity: { stageTimings: run9Timings() } },
    { runId: "run-10" }
  );
  assert.equal(row.values.elapsed_min, 45);
  assert.equal(row.sources.elapsed_min, "derived");
  /* A non-numeric elapsedMs is absent (rule 1) and the span is used instead. */
  const junk = rowFor({ outcome: "generated", elapsedMs: "45 min", veracity: { stageTimings: run9Timings() } }, { runId: "run-10" });
  assert.equal(junk.values.elapsed_min, 2676202 / 60000);
});

test("TM-10: no stage timings reads as absent elapsed, never as zero", () => {
  /* MUTATION: `return first === null ? 0 : last - first` in spanMsOf(). Ran
     it: red. Runs 4-8 predate stage timings; a zero-minute run is a fabricated
     KPI. A timing with no parseable start or no ms is skipped, not zeroed. */
  assert.equal(spanMsOf(undefined), null);
  assert.equal(spanMsOf([]), null);
  assert.equal(spanMsOf([{ name: "x", startedAt: "not a date", ms: 5 }, { name: "y", ms: 5 }]), null);
  assert.equal(spanMsOf([{ name: "x", startedAt: "2026-09-12T04:00:00.000Z" }]), null);
  const row = run4();
  assert.equal(row.values.elapsed_min, null);
  assert.equal(row.sources.elapsed_min, "absent");
  assert.equal(formatCell(column("elapsed_min"), row), ABSENT);
  assert.equal(row.values.wall_min, 4.44105, "the stage sum run 4 does carry is still printed");
});

test("core/detail: a detail column is in the JSONL and --wide, never in the committed markdown table", () => {
  /* MUTATION: `return COLUMNS` unconditionally in tableColumns() (every column
     in the committed header and the default table). Ran it: red. */
  for (const col of COLUMNS) assert.equal([CORE, DETAIL].includes(col.group), true, `${col.key} declares a group`);
  /* GV-08 added the first detail columns and GV-17 the runlog's speed
     columns; every earlier column stays core. GV-55 adds the stack. */
  assert.deepEqual(COLUMNS.filter((c) => c.group === DETAIL).map((c) => c.key), [
    "listen",
    "last_listen",
    ...SPEED_KEYS,
    "lead15_s",
    "render_rtf",
    "stack"
  ]);
  const probe = { key: "probe_x", group: DETAIL, header: "probeX", from: "report", width: 6, kind: "number", digits: 1 };
  COLUMNS.push(probe);
  try {
    const line = JSON.parse(jsonlLine(run9()));
    const row = rowFromJsonl({ ...line, metrics: { ...line.metrics, probe_x: 7.25 } });
    assert.equal(row.values.probe_x, 7.25);
    assert.equal(JSON.parse(jsonlLine(row)).metrics.probe_x, 7.25, "the JSONL carries the detail column");
    assert.equal(markdownHeader()[0].includes("probeX"), false, "the committed header stays core");
    assert.equal(markdownRow(row).includes("7.3"), false);
    assert.equal(formatTable([row]).includes("probeX"), false, "the default table is core only");
    assert.equal(formatTable([row], { wide: true }).includes("probeX"), true, "--wide prints it");
    assert.equal(tableColumns({ wide: true }).length, tableColumns().length + COLUMNS.filter((c) => c.group === DETAIL).length);
  } finally {
    COLUMNS.pop();
  }
  assert.equal(COLUMNS.includes(probe), false);
});

test("--wide is a flag the CLI parses and passes to the table", () => {
  /* MUTATION: drop the `--wide` branch in parseArgs() (it then throws
     "unknown flag"), or call `formatTable(rows)` without options in main().
     Ran both: red. */
  assert.equal(parseArgs(["x"]).wide, false);
  assert.equal(parseArgs(["--wide", "x"]).wide, true);
  const probe = { key: "probe_y", group: DETAIL, header: "probeY", from: "report", width: 6, kind: "number", digits: 0 };
  COLUMNS.push(probe);
  try {
    const seg = path.join(FIXTURES, "segments.json");
    const wide = [];
    main(["--wide", "--format", "table", "--segments", seg, path.join(FIXTURES, "out-9")], (s) => wide.push(s));
    assert.match(wide.join("\n"), /probeY/);
    const narrow = [];
    main(["--format", "table", "--segments", seg, path.join(FIXTURES, "out-9")], (s) => narrow.push(s));
    assert.equal(narrow.join("\n").includes("probeY"), false);
  } finally {
    COLUMNS.pop();
  }
});

test("the committed baseline keeps run 9's elapsed_min through a round trip, and runs 4-8 stay absent", () => {
  /* MUTATION: delete `"elapsed_min":44.60...` from the run-9 baseline line, or
     add `"elapsed_min":0` to run 8's metrics. Ran both: red. The run-9 line is
     the only one patched; the other five are byte-for-byte what they were. */
  const lines = fs
    .readFileSync(path.join(HERE, "baseline.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const nine = rowFromJsonl(lines[5]);
  assert.equal(nine.values.run, "run-9");
  assert.equal(nine.values.elapsed_min, 2676202 / 60000);
  assert.equal(nine.sources.elapsed_min, "derived");
  assert.equal(JSON.parse(jsonlLine(nine)).metrics.elapsed_min, 2676202 / 60000);
  assert.equal(markdownRow(rowFromJsonl(jsonlLine(nine))), markdownRow(nine));
  assert.match(markdownRow(nine), /^\| run-9 \| generated \| yes \| 107\.7 \| 44\.6 \|/);
  for (const line of lines.slice(0, 5)) {
    const row = rowFromJsonl(line);
    assert.equal(row.values.elapsed_min, null, `${row.values.run} carries no stage timings`);
    assert.equal(row.sources.elapsed_min, "absent");
  }
});

test("the KPI doc no longer calls the stage sum the driver's elapsed time", () => {
  /* MUTATION: restore the old provenance note ("`wall m` is the driver's own
     per-prompt elapsed (`entry.ms`)"). Ran it: red. That note is what TM-10
     found wrong: entry.ms is a sum over concurrent stages. */
  const doc = fs.readFileSync(path.join(REPO_ROOT, "docs", "curation", "generation-kpis.md"), "utf8");
  assert.equal(/wall m` is the driver's own per-prompt elapsed/.test(doc), false);
  /* GV-52 (R1-16): the 6 min target is superseded by the per-tier one. */
  assert.match(doc, /\| `elapsed m` \| — \| superseded by R1-16 \|/);
  assert.match(doc, /\| `stageSum m` \| — \| — \|/);
});

/* =================================================================== */
/* GV-08 (MQ-20). What the founder heard: listen and lastListen         */
/* =================================================================== */

/* Run 9's candidate id as a listening key names it: the report entry's
   `file` basename without `.json`. */
const RUN9_CANDIDATE = "what-engineers-actually-do-all-day-how-e-4e64fd43";

/** A synthetic listen-card/1 card (no transcript text). */
function listenCard(packId, label, overall, listenedAt, n = 1) {
  return {
    schema: "listen-card/1",
    cardId: `${packId}-${label}-${n}`,
    packId,
    label,
    act: 1,
    listener: "founder",
    listenedAt,
    scores: { onSubject: overall, flowsAtSeams: overall, oneNarrator: overall, nothingFalseOrOdd: overall },
    overall,
    q06: { oneVoice: true, everyClipIntroduced: true, anyClipCutShort: false },
    winces: [],
    ...(label === "solo" ? {} : { preference: "A" })
  };
}

/** A store and a key directory in a temp dir: two solo listens of run 9's
   candidate and one pair whose B arm is another candidate. */
function listeningFixture() {
  const dir = tmpdir();
  const keys = path.join(dir, "keys");
  fs.mkdirSync(keys);
  const key = (packId, arms) => fs.writeFileSync(path.join(keys, `${packId}.key.json`), JSON.stringify({ schema: "listen-key/1", packId, promptId: "p", act: 1, ...arms }));
  const arm = (candidateId) => ({ candidateId, provider: "local:spark", stageSwap: "baseline" });
  key("s1", { solo: arm(RUN9_CANDIDATE) });
  key("s2", { solo: arm(RUN9_CANDIDATE) });
  key("p1", { A: arm("someone-else"), B: { ...arm("another"), stageSwap: "spine:local:second" } });
  const cards = path.join(dir, "cards.jsonl");
  fs.writeFileSync(
    cards,
    [
      listenCard("s1", "solo", 3, "2026-10-11T22:30:00Z"),
      listenCard("s2", "solo", 4, "2026-10-14T22:00:00-04:00"),
      listenCard("p1", "A", 5, "2026-10-20T09:00:00Z")
    ]
      .map((c) => JSON.stringify(c))
      .join("\n") + "\n"
  );
  return { dir, keys, cards };
}

const wideCells = (argv) => {
  const out = [];
  main(["--wide", "--format", "table", "--segments", path.join(FIXTURES, "segments.json"), ...argv, path.join(FIXTURES, "out-9")], (s) => out.push(s));
  const lines = out.join("\n").split("\n");
  const header = lines[0].trim().split(/\s{2,}/);
  const cells = lines.find((l) => l.trim().startsWith("run-9")).trim().split(/\s{2,}/);
  return (name) => cells[header.indexOf(name)];
};

test("GV-08: listen and lastListen are detail columns from the listening store; the committed KPI header does not change", () => {
  /* MUTATION: `group: "core"` on the listen column. Ran it: red here and in
     "the committed KPI doc's header matches the harness's columns". The
     committed table is the core table; MQ-20 lands beside it. */
  assert.equal(column("listen").group, DETAIL);
  assert.equal(column("last_listen").group, DETAIL);
  assert.equal(column("listen").from, "listening");
  assert.equal(column("last_listen").kind, "text");
  assert.equal(column("listen").target, undefined, "MQ-20 grades nothing here");
  assert.equal(markdownHeader()[0].includes("listen"), false);
  assert.equal(tableColumns({ wide: true }).some((c) => c.header === "lastListen"), true);
});

test("GV-08: the bench prints lastListen as — until the first real card exists", () => {
  /* MUTATION: `last_listen: heard ? heard.lastListenedAt : "never"` in
     rowFor(). Ran it: red. "Nobody has listened" is the dash, not a word a
     reader could take for a date column's value. This reads the COMMITTED
     store with an empty key directory: an unkeyed or unheard candidate is
     absent either way, and stays so after the founder's first card (which
     names another candidate and whose key is not in this temp dir). */
  const keys = tmpdir();
  const cell = wideCells(["--listen-keys", keys]);
  assert.equal(cell("lastListen"), ABSENT);
  assert.equal(cell("listen"), ABSENT);
  const row = collectRows({ targets: [path.join(FIXTURES, "out-9")], segments: path.join(FIXTURES, "segments.json"), listenKeys: keys })[0];
  assert.equal(row.values.last_listen, null);
  assert.equal(row.sources.last_listen, "absent");
});

test("GV-08: with the keys and cards, listen is the candidate's mean overall and lastListen the latest card's UTC date", () => {
  /* MUTATION: `listen: null` in rowFor(), or join on `entry.prompt` instead of
     candidateIdFor(entry). Ran both: red. The 3 and the 4 are run 9's two
     solo listens; the pair's 5 belongs to another candidate. The second card
     is 22:00 on the 14th at -04:00, i.e. 02:00Z on the 15th: the column is a
     UTC date. THIRD MUTATION: `heard.lastListenedAt.slice(0, 10)` (the
     card's local date). Ran it: red. */
  const fx = listeningFixture();
  const cell = wideCells(["--cards", fx.cards, "--listen-keys", fx.keys]);
  assert.equal(cell("listen"), "3.50");
  assert.equal(cell("lastListen"), "2026-10-15");
  const row = collectRows({ targets: [path.join(FIXTURES, "out-9")], segments: path.join(FIXTURES, "segments.json"), cards: fx.cards, listenKeys: fx.keys })[0];
  assert.equal(row.values.listen, 3.5);
  assert.equal(row.sources.listen, "listening");
  assert.equal(row.sources.last_listen, "listening");
  /* The default table is unchanged by a listen. */
  const narrow = [];
  main(["--format", "table", "--segments", path.join(FIXTURES, "segments.json"), "--cards", fx.cards, "--listen-keys", fx.keys, path.join(FIXTURES, "out-9")], (s) => narrow.push(s));
  assert.equal(narrow.join("\n").includes("lastListen"), false);
});

test("GV-08: the JSONL carries listen and lastListen, and a baseline line round-trips them", () => {
  /* MUTATION: drop `last_listen` from jsonlLine()'s object, or from
     rowFromJsonl()'s values. Ran both: red. A diff over the JSONL is how a
     scheduled bench would see "nobody has listened since". */
  const fx = listeningFixture();
  const row = rowsForReport(path.join(FIXTURES, "out-9", "report.json"), { pool: POOL, listening: loadListening({ cards: fx.cards, keyDir: fx.keys }) })[0];
  const line = JSON.parse(jsonlLine(row));
  assert.equal(line.metrics.listen, 3.5);
  assert.equal(line.last_listen, "2026-10-15");
  const back = rowFromJsonl(jsonlLine(row));
  assert.equal(back.values.last_listen, "2026-10-15");
  assert.equal(back.sources.last_listen, "listening");
  assert.equal(formatTable([back], { wide: true }), formatTable([row], { wide: true }));
  /* A baseline line written before GV-08 has neither: absent, not zero. */
  const old = rowFromJsonl({ run: "run-9", metrics: {}, sources: {} });
  assert.equal(old.values.listen, null);
  assert.equal(old.values.last_listen, null);
  assert.equal(old.sources.listen, "absent");
});

test("GV-08: the join is skipped (absent) when the keys are not on this machine; a broken key still fails loudly", () => {
  /* MUTATION: drop the `err.code === KEY_MISSING` return in loadListening()
     (the refusal then crashes every bench run on a machine without the
     keys). Ran it: red. SECOND MUTATION: `catch { return null; }` (swallow
     everything). Ran it: red on the malformed key below: a broken file is
     not a missing machine. */
  const fx = listeningFixture();
  assert.equal(loadListening({ cards: fx.cards, keyDir: path.join(fx.dir, "not-here") }), null, "no key directory");
  fs.rmSync(path.join(fx.keys, "s2.key.json"));
  assert.equal(loadListening({ cards: fx.cards, keyDir: fx.keys }), null, "a card whose pack key is not here");
  const cell = wideCells(["--cards", fx.cards, "--listen-keys", fx.keys]);
  assert.equal(cell("listen"), ABSENT);
  fs.writeFileSync(path.join(fx.keys, "s2.key.json"), "{broken");
  assert.throws(() => loadListening({ cards: fx.cards, keyDir: fx.keys }), /cannot read key/);
  fs.writeFileSync(fx.cards, "not a card\n");
  assert.throws(() => loadListening({ cards: fx.cards, keyDir: fx.keys }), /not JSON/);
});

test("GV-08: the candidate id is the report entry's file basename without .json", () => {
  /* MUTATION: drop the `.replace(/\.json$/i, "")` in candidateIdFor(). Ran
     it: red. The key names the candidate by that id; with the extension the
     join silently finds nothing. */
  assert.equal(candidateIdFor({ file: `C:\\Users\\op\\AppData\\Local\\Temp\\${RUN9_CANDIDATE}.json` }), RUN9_CANDIDATE);
  assert.equal(candidateIdFor({ file: "/tmp/x/cand.JSON" }), "cand");
  assert.equal(candidateIdFor({}), null);
  assert.equal(candidateIdFor({ file: "" }), null);
});

test("GV-08: --cards and --listen-keys are flags the CLI parses", () => {
  /* MUTATION: drop the `--listen-keys` branch in parseArgs() (it then throws
     "unknown flag"). Ran it: red. */
  const args = parseArgs(["--cards", "c.jsonl", "--listen-keys", "k", "x"]);
  assert.equal(args.cards, "c.jsonl");
  assert.equal(args.listenKeys, "k");
  assert.equal(parseArgs(["x"]).listenKeys, null);
});

test("GV-08: the KPI doc defines MQ-20 and says the listening columns are detail", () => {
  /* MUTATION: delete the MQ-20 section from docs/curation/generation-kpis.md.
     Ran it: red. */
  const doc = fs.readFileSync(path.join(REPO_ROOT, "docs", "curation", "generation-kpis.md"), "utf8");
  assert.match(doc, /### MQ-20 · the founder's listen/);
  assert.match(doc, /`listen` \| — \| — \|/);
  assert.match(doc, /`lastListen` \| — \| — \|/);
});

/* =================================================================== */
/* GV-17 (MT-04..MT-12). The per-call speed columns, from the runlog    */
/* =================================================================== */

/* fixtures/runlog-synth is SYNTHETIC: a report whose one entry names
   `runlogs/synth.1.runlog.jsonl` (relative to the report), and a runlog of 3
   serial calls, 4 parallel writer calls and 1 stitch call. No prompt or
   transcript text. tools/generation-bench/runlog.test.mjs pins every number
   in it; these tests pin how run.mjs reads and prints them. */
const SYNTH = path.join(FIXTURES, "runlog-synth");
const synthRow = () => rowsForReport(path.join(SYNTH, "report.json"), { pool: POOL })[0];

/** A report plus a runlog in a temp dir; `calls` are partial CallRecords. */
function writeRunLogReport(calls) {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "runlogs"));
  const lines = [{ schema: "runlog/1", t0Iso: "2026-10-11T00:00:00.000Z" }, ...calls.map((c, seq) => ({ kind: "call", seq, ...c }))];
  fs.writeFileSync(path.join(dir, "runlogs", "x.1.runlog.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return writeReport(dir, [{ outcome: "generated", detail: "OK x", ms: 1, runLog: "runlogs/x.1.runlog.jsonl" }]);
}

test("GV-17: the speed columns are detail columns read from the runlog; the committed KPI header does not change", () => {
  /* MUTATION: `group: "core"` on out_tok. Ran it: red. */
  for (const key of SPEED_KEYS) {
    const col = column(key);
    assert.ok(col, `${key} is a column`);
    assert.equal(col.group, DETAIL, `${key} is detail`);
    assert.equal(col.from, "runlog", `${key} comes from the runlog`);
    assert.equal(col.kind, "number");
    assert.equal(col.target, undefined, `${key} grades nothing`);
  }
  assert.equal(markdownHeader()[0].includes("outTok"), false);
});

test("GV-17: out-4 and out-9 carry no runLog, so every speed column prints — and the core row is unchanged", () => {
  /* MUTATION: `out_tok: runlog ? ... : 0` (or `?? 0` on any speed cell) in
     rowFor(). Ran it: red. Runs 4-9 predate the runlog; a 0 would read as a
     run that made no output tokens. */
  for (const row of [run4(), run9()]) {
    for (const key of SPEED_KEYS) {
      assert.equal(row.values[key], null, `${row.values.run}/${key}`);
      assert.equal(row.sources[key], "absent");
    }
    assert.equal(row.meta.calls_by_stage, null);
    assert.equal(row.meta.prose_basis, null);
  }
  const cell = wideCells([]);
  for (const header of ["outTok", "series", "reasks", "queueP50", "ttftP50", "cached", "proseTps", "code s", "renderX", "spark s"]) {
    assert.equal(cell(header), ABSENT, header);
  }
  assert.match(markdownRow(run9()), /^\| run-9 \| generated \| yes \| 107\.7 \| 44\.6 \|.* 128050 \| — \|$/);
});

test("GV-17: entry.runLog is resolved against the report's directory, and the synthetic runlog fills every speed column", () => {
  /* MUTATION: `path.resolve(entry.runLog)` in runLogPathFor() (the working
     directory, which is the repo root under the suite). Ran it: red — every
     cell is absent. */
  const reportPath = path.join(SYNTH, "report.json");
  const entry = JSON.parse(fs.readFileSync(reportPath, "utf8")).entries[0];
  assert.equal(runLogPathFor(entry, reportPath), path.join(SYNTH, "runlogs", "synth.1.runlog.jsonl"));
  const row = synthRow();
  assert.equal(row.values.run, "runlog-synth");
  assert.equal(row.values.out_tok, 5150);
  assert.equal(row.values.series, 5, "3 serial calls, the 4 parallel writers as one link, then stitch");
  assert.equal(row.values.reasks, 3, "1 JSON re-ask + 2 extra writer rounds");
  assert.equal(row.values.queue_p50, 0.02);
  assert.equal(row.values.ttft_p50, 0.4);
  assert.equal(row.values.cached, 12800 / 18000);
  assert.equal(row.values.prose_tps, 2550 / 12.4);
  assert.equal(row.values.code_s, 2.4);
  assert.equal(row.values.render_x, 4);
  assert.equal(row.values.spark_s, 20.5, "reconciled charges only; the 10 s reservation is a hold");
  for (const key of SPEED_KEYS) assert.equal(row.sources[key], "runlog", key);
  assert.equal(row.meta.prose_basis, "ttft");
});

test("GV-17: a runLog named but not on disk is absent; a file without the runlog/1 header fails loudly", () => {
  /* MUTATION: `catch { return null; }` around readRunLog in
     runLogSummaryFor(). Ran it: red on the headerless file — a broken runlog
     is not a missing one. SECOND MUTATION: drop the existsSync check in
     runLogPathFor() (a missing file then throws ENOENT). Ran it: red. */
  const dir = tmpdir();
  const missing = writeReport(dir, [{ outcome: "generated", detail: "OK x", ms: 1, runLog: "runlogs/gone.1.runlog.jsonl" }]);
  const row = rowsForReport(missing, {})[0];
  assert.equal(row.values.series, null);
  assert.equal(row.sources.series, "absent");
  fs.mkdirSync(path.join(dir, "runlogs"));
  fs.writeFileSync(path.join(dir, "runlogs", "gone.1.runlog.jsonl"), JSON.stringify({ kind: "call" }) + "\n");
  assert.throws(() => rowsForReport(missing, {}), /no runlog\/1 header/);
});

test("GV-17: prose_tps is the decode rate when the writer's calls carry a ttft, and is labelled e2e otherwise", () => {
  /* MUTATION: drop the `e2e` suffix branch in formatCell(). Ran it: red. An
     end-to-end rate includes queue and prefill; printed bare it reads as a
     (much slower) decode rate. */
  const writer = { stage: "narrate:0", role: "writer", attempt: 1, reask: null, startMs: 0, endMs: 2000, ms: 2000, outputTokens: 300 };
  const e2e = rowsForReport(writeRunLogReport([{ ...writer, ttftMs: null }]), {})[0];
  assert.equal(e2e.values.prose_tps, 150);
  assert.equal(e2e.meta.prose_basis, "e2e");
  assert.equal(formatCell(column("prose_tps"), e2e), "150.0 e2e");
  const decode = rowsForReport(writeRunLogReport([{ ...writer, ttftMs: 500 }]), {})[0];
  assert.equal(decode.values.prose_tps, 200);
  assert.equal(decode.meta.prose_basis, "ttft");
  assert.equal(formatCell(column("prose_tps"), decode), "200.0");
  /* The basis survives the JSONL, so a baseline line prints the same label. */
  const back = rowFromJsonl(jsonlLine(e2e));
  assert.equal(back.meta.prose_basis, "e2e");
  assert.equal(formatTable([back], { wide: true }), formatTable([e2e], { wide: true }));
});

test("GV-17: the JSONL carries calls_by_stage as a meta object, not a column, and round-trips it", () => {
  /* MUTATION: drop `calls_by_stage` from jsonlLine()'s object. Ran it: red. */
  const line = JSON.parse(jsonlLine(synthRow()));
  assert.deepEqual(line.calls_by_stage, { understand: 1, spine: 2, "narrate:0": 1, "narrate:1": 1, "narrate:2": 1, "narrate:3": 1, stitch: 1 });
  assert.equal("calls_by_stage" in line.metrics, false);
  assert.equal(COLUMNS.some((c) => c.key === "calls_by_stage"), false);
  for (const key of SPEED_KEYS) assert.equal(key in line.metrics, true, `${key} is in the JSONL metrics`);
  assert.equal(line.metrics.series, 5);
  const back = rowFromJsonl(line);
  assert.deepEqual(back.meta.calls_by_stage, line.calls_by_stage);
  assert.equal(formatTable([back], { wide: true }), formatTable([synthRow()], { wide: true }));
  assert.equal(JSON.parse(jsonlLine(run9())).calls_by_stage, null);
});

test("GV-17: --wide prints the speed columns for the synthetic run", () => {
  /* MUTATION: drop `runlog` from the context rowsForReport() hands
     rowFor(). Ran it: red. */
  const out = [];
  main(["--wide", "--format", "table", "--segments", path.join(FIXTURES, "segments.json"), SYNTH], (s) => out.push(s));
  const lines = out.join("\n").split("\n");
  const header = lines[0].trim().split(/\s{2,}/);
  const cells = lines.find((l) => l.trim().startsWith("runlog-synth")).trim().split(/\s{2,}/);
  const cell = (name) => cells[header.indexOf(name)];
  assert.equal(cell("outTok"), "5150");
  assert.equal(cell("series"), "5");
  assert.equal(cell("reasks"), "3");
  assert.equal(cell("proseTps"), "205.6");
  assert.equal(cell("spark s"), "20.5");
});

test("GV-17: the KPI doc legend names each speed column and its MT id", () => {
  /* MUTATION: delete the out_tok row from the doc's speed legend. Ran it: red. */
  const doc = fs.readFileSync(path.join(REPO_ROOT, "docs", "curation", "generation-kpis.md"), "utf8");
  assert.match(doc, /### Per-call speed \(GV-17\)/);
  const ids = { out_tok: "MT-05", series: "MT-06", reasks: "MT-07", queue_p50: "MT-04", ttft_p50: "MT-04", cached: "MT-04", prose_tps: "MT-12", code_s: "MT-08", render_x: "MT-09", spark_s: "MT-10" };
  for (const key of SPEED_KEYS) {
    const header = column(key).header;
    const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(doc, new RegExp("\\| `" + escaped + "` \\| — \\| — \\| \\*\\*detail, " + ids[key] + "\\.\\*\\*"), `${header} (${ids[key]})`);
  }
});

/* =================================================================== */
/* GV-24 — the MQ scorecard under --scorecard                           */
/* =================================================================== */

const OUT9_DIR = path.join(FIXTURES, "out-9");
const scored9 = () => rowsForReport(path.join(OUT9_DIR, "report.json"), { pool: POOL, scorecard: true, segmentSources: new Map() })[0];

test("GV-24: without --scorecard the JSONL line and the --wide table carry no scorecard", () => {
  /* MUTATION: in jsonlLine(), always add `scorecard: row.scorecard ?? null`.
     Ran it: red. */
  const line = JSON.parse(jsonlLine(run9()));
  assert.equal("scorecard" in line, false);
  assert.equal("scorecard" in run9(), false);
  assert.equal(tableColumns({ wide: true }).some((c) => c.from === "scorecard"), false);
  assert.equal(tableColumns({ wide: true, scorecard: true }).filter((c) => c.from === "scorecard").length > 0, true);
  /* Detail columns: the core table never shows them, scored or not. */
  assert.deepEqual(tableColumns({ scorecard: true }), tableColumns());
  assert.equal(markdownRow(scored9()), markdownRow(run9()));
});

test("GV-24: --scorecard on out-9 fills the report cells, leaves judged and listen null, and --wide prints the MQ columns", () => {
  /* MUTATION: drop `scorecard` from the context rowsForReport() hands
     rowFor(). Ran it: red. */
  const out = [];
  main(["--scorecard", "--wide", "--segments", path.join(FIXTURES, "segments.json"), OUT9_DIR], (s) => out.push(s));
  const text = out.join("\n");
  const lines = text.split("\n");
  const header = lines[0].trim().split(/\s{2,}/);
  const cells = lines.find((l) => l.trim().startsWith("run-9")).trim().split(/\s{2,}/);
  const cell = (name) => cells[header.indexOf(name)];
  assert.equal(cell("MQ01"), "1.000");
  assert.equal(cell("MQ04"), "8");
  assert.equal(cell("MQ13"), "0");
  assert.equal(cell("MQ02"), ABSENT);
  assert.equal(cell("MQ21"), ABSENT);
  assert.match(text, /MQ-01 grounded quote rate/);
  const json = JSON.parse(lines.find((l) => l.startsWith("{")));
  assert.equal(json.scorecard["MQ-01"].value, 1);
  assert.equal(json.scorecard["MQ-01"].source, "report");
  for (const id of ["MQ-02", "MQ-03", "MQ-05", "MQ-10", "MQ-12", "MQ-20"]) assert.equal(json.scorecard[id].value, null, id);
  assert.equal(Object.keys(json.scorecard).length, 21);
});

test("GV-24: a scored line round-trips through rowFromJsonl to the same --wide table", () => {
  /* MUTATION: in rowFromJsonl(), drop the `scorecardValues` merge. Ran it: red. */
  const row = scored9();
  const back = rowFromJsonl(jsonlLine(row));
  assert.deepEqual(back.scorecard, row.scorecard);
  assert.equal(formatTable([back], { wide: true, scorecard: true }), formatTable([row], { wide: true, scorecard: true }));
});

test("GV-24: a judged.json beside the candidate fills the judged MQ cells", () => {
  /* MUTATION: in scorecardFor(), pass `judged: null`. Ran it: red. */
  const dir = tmpdir();
  for (const f of fs.readdirSync(OUT9_DIR)) fs.copyFileSync(path.join(OUT9_DIR, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, `${RUN9_CANDIDATE}.judged.json`), JSON.stringify({ questionsVersion: 1, "MQ-10": 4, "MQ-12": 3.5 }));
  const row = rowsForReport(path.join(dir, "report.json"), { pool: POOL, scorecard: true })[0];
  assert.equal(row.scorecard["MQ-10"].value, 4);
  assert.equal(row.scorecard["MQ-12"].value, 3.5);
  assert.equal(row.values.mq10, 4);
});

test("GV-24: clipStats aggregates clipDurations, one entry per clip, null where unresolved", () => {
  /* MUTATION: in clipDurations(), `.filter()` out the unresolved clips instead
     of returning null for them. Ran it: red (length 2). */
  const candidate = {
    runtimeSec: 400,
    items: [{ type: "segment", segment_id: "m" }, { type: "narration" }, { type: "segment", segment_id: "gone" }, { type: "segment", segment_id: "p" }],
    segments: [{ id: "m", startSec: 0, endSec: 100 }]
  };
  const pool = new Map([["p", { id: "p", start_sec: 10, end_sec: 60 }]]);
  assert.deepEqual(clipDurations(candidate, pool), [100, null, 50]);
  const stats = clipStats(candidate, pool);
  assert.equal(stats.count, 3);
  assert.equal(stats.measured, 2);
  assert.equal(stats.tapeSec, 150);
});

/* ------------------------------------------------------------------ */

/** A minimal report.json in `dir`, for the shapes no fixture carries. */
function writeReport(dir, entries) {
  const file = path.join(dir, "report.json");
  fs.writeFileSync(file, JSON.stringify({ generated_at: "2026-09-12T00:00:00.000Z", dry_run: false, entries }));
  return file;
}

/* =================================================================== */
/* GV-52 (R1-16; MT-01, MT-02, MT-11) — delivery columns, per-tier      */
/* targets                                                              */
/* =================================================================== */

const DELIVERY = path.join(FIXTURES, "delivery");
/* The synthetic report: #1 short publishable (with a render block), #2
   medium publishable, #3 short whose gate failed, #4 long and resumed. */
const deliveryRows = () => rowsForReport(path.join(DELIVERY, "report.json"), { pool: POOL });
const DELIVERY_CORE = ["tier", "first_s", "full_s", "lead_s"];
const DELIVERY_DETAIL = ["lead15_s", "render_rtf"];

test("GV-52: a short row's first-audio target is 30 s and a medium row's is 40 s; long and tierless rows have none", () => {
  /* MUTATION: `TIER_TARGETS.short[col.key]` in targetFor() (every row read as
     short). Ran it: red — the medium row reads 30. */
  const [short, medium, , long] = deliveryRows();
  assert.equal(short.values.tier, "short");
  assert.equal(medium.values.tier, "medium");
  assert.deepEqual(targetFor(column("first_s"), short), { target: 30, targetState: SETTLED });
  assert.deepEqual(targetFor(column("first_s"), medium), { target: 40, targetState: PROPOSED });
  assert.deepEqual(targetFor(column("full_s"), short), { target: 90, targetState: SETTLED });
  assert.deepEqual(targetFor(column("full_s"), medium), { target: 240, targetState: SETTLED });
  assert.deepEqual(targetFor(column("lead_s"), short), { target: 30, targetState: PROPOSED });
  assert.deepEqual(targetFor(column("lead_s"), medium), { target: 30, targetState: PROPOSED });
  assert.equal(targetFor(column("first_s"), long), null, "long has no target");
  assert.equal(targetFor(column("first_s"), run9()), null, "run 9's report names no tier");
  /* A single-target column is the same whatever the row. */
  assert.deepEqual(targetFor(column("tokens"), short), { target: 50000, targetState: SETTLED });
  assert.equal(targetFor(column("clips"), short), null);
});

test("GV-52: the split targets follow decision 15 — short first audio and whole-Foray targets settled, medium first audio and lead proposed", () => {
  /* MUTATION: `targetState: SETTLED` on medium.first_s (laundering the
     proposed 40 s into a settled one). Ran it: red. */
  assert.deepEqual(TIER_TARGETS, {
    short: {
      first_s: { target: 30, targetState: SETTLED },
      full_s: { target: 90, targetState: SETTLED },
      lead_s: { target: 30, targetState: PROPOSED }
    },
    medium: {
      first_s: { target: 40, targetState: PROPOSED },
      full_s: { target: 240, targetState: SETTLED },
      lead_s: { target: 30, targetState: PROPOSED }
    }
  });
  /* A per-tier column carries no single target, so the
     target-and-targetState agreement holds and nothing reads it as settled. */
  for (const key of ["first_s", "full_s", "lead_s"]) {
    assert.equal(column(key).perTier, true, key);
    assert.equal(column(key).target, undefined, key);
    assert.equal(column(key).targetState, undefined, key);
  }
  assert.equal(tierTargetsLabel(column("first_s")), "short 30, medium 40?, long none");
  assert.equal(tierTargetsLabel(column("full_s")), "short 90, medium 240, long none");
  assert.equal(tierTargetsLabel(column("lead_s")), "short 30?, medium 30?, long none");
});

test("GV-52: full_s is absent for a row whose gate failed, even when elapsedMs and allItemsReadyMs exist", () => {
  /* MUTATION: drop the `entry.publishable === true ?` guard in rowFor() (full_s
     = allItemsReadyMs whatever the gate said). Ran it: red. */
  const [short, medium, failed] = deliveryRows();
  assert.equal(short.values.full_s, 86.4);
  assert.equal(medium.values.full_s, 229.7);
  assert.equal(failed.values.full_s, null);
  assert.equal(failed.sources.full_s, "absent");
  assert.equal(formatCell(column("full_s"), failed), ABSENT);
  /* The row's own clock and first audio are still printed: only MT-02 waits
     on the gate. */
  assert.equal(failed.values.elapsed_min, 95000 / 60000);
  assert.equal(failed.values.first_s, 29);
  assert.equal(failed.values.lead_s, 18);
  /* A row that does not say it is publishable is not ready either. */
  const dir = tmpdir();
  const entry = {
    outcome: "generated",
    detail: "OK x",
    ms: 1,
    duration: "short",
    delivery: { granularity: "act", items: 1, allItemsReadyMs: 5000, firstServableMs: 1000 }
  };
  const row = rowsForReport(writeReport(dir, [entry]), { pool: POOL })[0];
  assert.equal(row.values.full_s, null);
  assert.equal(row.values.first_s, 1);
});

test("GV-52: the synthetic delivery report prints the four columns, and the legend names the per-tier targets", () => {
  /* MUTATION: read `entry.veracity.delivery` instead of `entry.delivery` in
     rowFor(). Ran it: red — every delivery cell is —. */
  const out = [];
  main(["--wide", "--format", "table", "--segments", path.join(FIXTURES, "segments.json"), DELIVERY], (s) => out.push(s));
  const text = out.join("\n");
  const lines = text.split("\n");
  const header = lines[0].trim().split(/\s{2,}/);
  const cellsOf = (run) => lines.find((l) => l.trim().startsWith(run)).trim().split(/\s{2,}/);
  const cell = (run, name) => cellsOf(run)[header.indexOf(name)];
  assert.equal(cell("delivery#1", "tier"), "short");
  assert.equal(cell("delivery#1", "1stAudio s"), "24.8");
  assert.equal(cell("delivery#1", "allReady s"), "86.4");
  assert.equal(cell("delivery#1", "minLead s"), "41.3");
  assert.equal(cell("delivery#1", "lead1.5x s"), "12.5");
  assert.equal(cell("delivery#1", "render RTF"), "4.20");
  assert.equal(cell("delivery#2", "tier"), "medium");
  assert.equal(cell("delivery#2", "minLead s"), "-6.5", "a stall prints negative, never clamped");
  assert.equal(cell("delivery#2", "render RTF"), ABSENT, "no render block yet (GV-74)");
  assert.equal(cell("delivery#3", "allReady s"), ABSENT, "gate failed");
  /* The legend: per tier, every tier's target, and the provenance. */
  assert.match(text, /1stAudio s per tier/);
  assert.match(text, /targets \(s\): short 30, medium 40\?, long none/);
  assert.match(text, /targets \(s\): short 90, medium 240, long none/);
  assert.match(text, /targets \(s\): short 30\?, medium 30\?, long none/);
  assert.match(text, /per tier: orchestrator's adopted reading of the 30 s KPI \(OQ-03; docs\/roadmap\/generation-v2\.md decision 15; #1286\)/);
  assert.match(text, /not ready: gate failed/);
  assert.equal(/\b(PASS|FAIL|BAD|regressed|over target|under target)\b/.test(text), false, "no verdict is rendered");
});

test("GV-52: out-4 and out-9 carry no delivery block, so every delivery column is — and never 0; a resumed attempt is — too", () => {
  /* MUTATION: `lead_s: num(delivery?.minLeadSec) ?? 0` (or `?? 0` on any
     delivery cell). Ran it: red. SECOND MUTATION: an `?? seconds(entry.elapsedMs)`
     fallback on full_s (the resumed row then reads 610 s). Ran it: red. */
  for (const row of [run4(), run9()]) {
    for (const key of [...DELIVERY_CORE, ...DELIVERY_DETAIL]) {
      assert.equal(row.values[key], null, `${row.values.run}/${key}`);
      assert.equal(row.sources[key], "absent");
      assert.equal(formatCell(column(key), row), ABSENT);
    }
  }
  const resumed = deliveryRows()[3];
  assert.equal(resumed.values.tier, "long");
  for (const key of ["first_s", "full_s", "lead_s", "lead15_s", "render_rtf"]) assert.equal(resumed.values[key], null, `resumed/${key}`);
  /* Sources name the column's producer when there is a number. */
  const short = deliveryRows()[0];
  assert.equal(short.sources.first_s, "derived");
  assert.equal(short.sources.lead_s, "report");
  assert.equal(short.sources.tier, "report");
  /* An unknown tier string is no tier, not a guessed one. */
  assert.equal(tierOf({ duration: "epic" }), null);
  assert.equal(tierOf({}), null);
  assert.equal(seconds(undefined), null);
});

test("GV-52: the core columns gain tier and the three delivery columns, after ttlA1; lead at 1.5x and render RTF are detail", () => {
  /* MUTATION: `group: "detail"` on first_s (the committed table then drops
     the first-audio column). Ran it: red. */
  for (const key of DELIVERY_CORE) assert.equal(column(key).group, CORE, key);
  for (const key of DELIVERY_DETAIL) assert.equal(column(key).group, DETAIL, key);
  assert.match(markdownHeader()[0], /\| ttlA1 m \| tier \| 1stAudio s \| allReady s \| minLead s \| calls \|/);
});

test("GV-52: JSONL carries the tier and the delivery metrics, and a line round-trips to the same wide table", () => {
  /* MUTATION: drop `tier` from jsonlLine(). Ran it: red — the round-tripped
     row loses its tier and so its per-tier targets. */
  for (const row of deliveryRows()) {
    const line = JSON.parse(jsonlLine(row));
    assert.equal(line.tier, row.values.tier);
    for (const key of ["first_s", "full_s", "lead_s", "lead15_s", "render_rtf"]) {
      assert.equal(key in line.metrics, true, key);
      assert.equal(line.metrics[key], row.values[key], `${row.values.run}/${key}`);
    }
    const back = rowFromJsonl(line);
    assert.equal(back.values.tier, row.values.tier);
    assert.deepEqual(targetFor(column("first_s"), back), targetFor(column("first_s"), row));
    assert.equal(formatTable([back], { wide: true }), formatTable([row], { wide: true }));
  }
  /* A baseline line written before GV-52 has no tier: absent, not a guess. */
  const old = rowFromJsonl({ run: "run-x", metrics: {}, sources: {} });
  assert.equal(old.values.tier, null);
  assert.equal(old.sources.tier, "absent");
  assert.equal(old.sources.first_s, "absent");
});

test("GV-52: runs 4-9 render unchanged apart from the four new absent cells after ttlA1", () => {
  /* MUTATION: move `tier` before `stageSum m` in COLUMNS. Ran it: red. The
     committed run-9 row from before GV-52 is pinned verbatim; removing the four
     new cells gives it back. */
  const lines = fs
    .readFileSync(path.join(HERE, "baseline.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const nine = markdownRow(rowFromJsonl(lines[5]));
  const before =
    "| run-9 | generated | yes | 107.7 | 44.6 | 38.7 | 69 | 0.684 | 0.557 | 10 | 107.5 | 188.3 | 0.86 | 0.316 | — | — | 0.05 | 8 | 0 | — | 0 | 0.55 | 128050 | — |";
  const cells = nine.split(" | ");
  assert.deepEqual(cells.slice(6, 10), ["—", "—", "—", "—"]);
  assert.equal([...cells.slice(0, 6), ...cells.slice(10)].join(" | "), before);
});

test("GV-52: the KPI doc's targets table names MT-01, MT-02 and MT-11 with per-tier values and their provenance", () => {
  /* MUTATION: delete the MT-01 row from the doc's per-tier table. Ran it: red. */
  const doc = fs.readFileSync(path.join(REPO_ROOT, "docs", "curation", "generation-kpis.md"), "utf8");
  assert.match(doc, /### Delivery and the per-tier targets \(GV-52, R1-16\)/);
  assert.match(doc, /\| MT-01 \| `1stAudio s` \| ≤ 30 s \(settled\) \| ≤ 40 s \(\*\*proposed\*\*\) \| — \|/);
  assert.match(doc, /\| MT-02 \| `allReady s` \| ≤ 90 s \(settled\) \| ≤ 4 min \/ 240 s \(settled\) \| — \|/);
  assert.match(doc, /\| MT-11 \| `minLead s` \| ≥ 30 s \(\*\*proposed\*\*\) \| ≥ 30 s \(\*\*proposed\*\*\) \| — \|/);
  assert.match(doc, /decision\s+15 of `docs\/roadmap\/generation-v2\.md` \(#1286\)/);
  assert.match(doc, /\| `ttlA1 m` \| — \| superseded by R1-16 \|/);
  /* The roadmap's §1.2 records the split and points at the table. */
  const roadmap = fs.readFileSync(path.join(REPO_ROOT, "docs", "curation", "foray-to-spec-roadmap.md"), "utf8");
  assert.match(roadmap, /\*\*R1-16 \(GV-52\): the time targets are split by tier\.\*\*/);
  assert.match(roadmap, /generation-kpis\.md#delivery-and-the-per-tier-targets-gv-52-r1-16/);
});

/* GV-55 (R2-21, from W7-02): the driver records `stageAssignments` on every
   report row ({stage: {impl, model, machine?}}); the bench shows it as one
   compact `stack` detail cell. */
const LOCAL_ASSIGNMENTS = {
  "understand.clarity": { impl: "local", model: "qwen-spark", machine: "spark" },
  "understand.intent": { impl: "local", model: "qwen-spark", machine: "spark" },
  "understand.title": { impl: "local", model: "qwen-spark", machine: "spark" },
  research: { impl: "none", model: "none" },
  spine: { impl: "local", model: "qwen-second", machine: "second" },
  deepen: { impl: "local", model: "qwen-spark", machine: "spark" },
  writer: { impl: "local", model: "qwen-spark", machine: "spark" },
  verifier: { impl: "local", model: "qwen-spark", machine: "spark" },
  continuity: { impl: "local", model: "qwen-spark", machine: "spark" },
  judge: { impl: "jev", model: "jev" }
};

test("GV-55: stackOf names the common impl@machine first, then every stage that differs, in the report's stage order", () => {
  /* MUTATION: drop the `@${a.machine}` suffix in stackOf's tag (spine on the
     second box then reads as the majority 'local' and vanishes). Ran it: red. */
  assert.equal(stackOf(LOCAL_ASSIGNMENTS), "local@spark research=none spine=local@second judge=jev");
  /* An all-stub run is one word; an all-legacy run likewise. */
  const all = (impl) => Object.fromEntries(Object.keys(LOCAL_ASSIGNMENTS).map((stage) => [stage, { impl, model: impl }]));
  assert.equal(stackOf(all("stub")), "stub");
  assert.equal(stackOf({ ...all("anthropic"), judge: { impl: "none", model: "none" } }), "anthropic judge=none");
  /* A tie keeps the first stage's tag first. MUTATION: `n >= counts.get(top)`
     in stackOf (the last tied tag wins). Ran it: red. */
  assert.equal(
    stackOf({ spine: { impl: "local", model: "a", machine: "spark" }, deepen: { impl: "stub", model: "stub" } }),
    "local@spark deepen=stub"
  );
  /* Rule 1: nothing recorded is absent, never a guessed stack. */
  assert.equal(stackOf(undefined), null);
  assert.equal(stackOf({}), null);
  assert.equal(stackOf({ spine: { model: "x" } }), null, "an assignment without impl is not read");
});

test("GV-55: the stack column is detail, shows on a row with stageAssignments, and is absent on out-4 and out-9", () => {
  /* MUTATION: `stack: stackOf(entry.stageAssignments) ?? "stub"` in rowFor.
     Ran it: red (out-4/out-9 then claim a stack they never recorded). */
  assert.equal(column("stack").group, DETAIL);
  assert.equal(column("stack").kind, "text");
  assert.equal(markdownHeader()[0].includes("stack"), false, "the committed KPI table is unchanged");
  for (const row of [run4(), run9()]) {
    assert.equal(row.values.stack, null, row.values.run);
    assert.equal(row.sources.stack, "absent");
    assert.equal(formatCell(column("stack"), row), ABSENT);
    assert.equal("stack" in JSON.parse(jsonlLine(row)), false, "an older report's JSONL line gains no stack key");
  }
  const row = rowFor({ prompt: "p", outcome: "generated", detail: "OK x", stageAssignments: LOCAL_ASSIGNMENTS }, { runId: "run-l" });
  assert.equal(row.values.stack, "local@spark research=none spine=local@second judge=jev");
  assert.equal(row.sources.stack, "report");
  const wide = formatTable([row], { wide: true });
  assert.match(wide, /local@spark research=none spine=local@second judge=jev/);
  assert.equal(formatTable([row]).includes("local@spark"), false, "the default table prints core columns only");
});

test("GV-55: the JSONL carries the stack and a baseline line round-trips it", () => {
  /* MUTATION: drop the `stack` spread from jsonlLine(). Ran it: red. */
  const row = rowFor({ prompt: "p", outcome: "generated", detail: "OK x", stageAssignments: LOCAL_ASSIGNMENTS }, { runId: "run-l" });
  const line = JSON.parse(jsonlLine(row));
  assert.equal(line.stack, row.values.stack);
  const back = rowFromJsonl(line);
  assert.equal(back.values.stack, row.values.stack);
  assert.equal(formatTable([back], { wide: true }), formatTable([row], { wide: true }));
  assert.equal(rowFromJsonl({ run: "run-x", metrics: {}, sources: {} }).values.stack, null);
});
