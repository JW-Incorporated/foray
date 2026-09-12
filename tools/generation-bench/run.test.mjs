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
  COLUMNS,
  PROPOSED,
  SETTLED,
  candidatePathFor,
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
  spliceRows,
  targetLabel,
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
  const proposed = COLUMNS.filter((c) => c.targetState === PROPOSED).map((c) => c.key).sort();
  assert.deepEqual(proposed, ["cost_usd", "narration_share", "pages_per_seam", "tape_of_runtime", "wall_min"]);
  const settled = COLUMNS.filter((c) => c.targetState === SETTLED).map((c) => c.key).sort();
  assert.deepEqual(settled, ["calls_per_beat", "first_pass_pages", "intro_restates", "tokens", "ttl_a1_min", "unverified"]);
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
  assert.equal(targetLabel(column("wall_min")), "6.0?");
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
    "candidate_read",
    "clips_measured",
    "generated_at",
    "metrics",
    "outcome",
    "prompt",
    "run",
    "sources",
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
  assert.equal((run4Line.match(/—/g) || []).length, 19);
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

/* ------------------------------------------------------------------ */

/** A minimal report.json in `dir`, for the shapes no fixture carries. */
function writeReport(dir, entries) {
  const file = path.join(dir, "report.json");
  fs.writeFileSync(file, JSON.stringify({ generated_at: "2026-09-12T00:00:00.000Z", dry_run: false, entries }));
  return file;
}
