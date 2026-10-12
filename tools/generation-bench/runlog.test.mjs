/* Tests for the runlog reader (GV-17). Run: node --test tools/generation-bench/runlog.test.mjs
 *
 * WHAT IS AT RISK. Every number this module produces is a speed KPI the
 * Baseline doc lists as "not measured" (MT-04..MT-10, MT-12). The failure
 * modes are quiet: a chain DP that counts parallel calls as serial, a re-ask
 * counted twice, a reservation counted as spend, a decode rate computed over
 * calls that never reported a TTFT, or a `0` standing in for a field no
 * provider reported. Each test below names the mutation that breaks it, and
 * each was run against that mutation before this landed.
 *
 * THE FIXTURE IS SYNTHETIC. fixtures/runlog-synth/runlogs/synth.1.runlog.jsonl
 * is hand-built (no prompt or transcript text): 3 serial calls (understand,
 * spine, the spine's JSON re-ask), then 4 parallel writer calls (acts 0 and 1
 * on round 2, acts 2 and 3 on round 1; act 3 over its output budget), then 1
 * stitch call, with two parse events, two code aggregates, an act-0 ready
 * event, two renders and four meter events (one of them a reservation).
 * backend/test/runLogBenchParity.test.ts covers the other direction: a REAL
 * RunLog's toJsonl() through this reader.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CALL_FIELDS,
  EVENT_KINDS,
  RUNLOG_SCHEMA,
  SPARK_UNIT,
  UNSTAGED,
  p50,
  parseRunLog,
  readRunLog,
  repeatRequests,
  seriesDepth,
  summarizeRunLog,
  tokRates
} from "./runlog.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNTH_DIR = path.join(HERE, "fixtures", "runlog-synth");
const SYNTH = path.join(SYNTH_DIR, "runlogs", "synth.1.runlog.jsonl");
const synth = () => summarizeRunLog(readRunLog(SYNTH).events);

const HEADER = { schema: RUNLOG_SCHEMA, t0Iso: "2026-10-11T00:00:00.000Z" };
const jsonl = (...events) => [HEADER, ...events].map((e) => JSON.stringify(e)).join("\n") + "\n";
let seq = 0;
/** A CallRecord with every field null except what `over` sets. */
const call = (over) => ({
  kind: "call",
  seq: seq++,
  stage: null,
  act: null,
  seam: null,
  attempt: null,
  role: null,
  reask: null,
  provider: "test",
  machine: null,
  model: "m",
  label: "l",
  startMs: 0,
  endMs: 0,
  ms: 0,
  queueMs: null,
  ttftMs: null,
  promptTokens: null,
  cachedTokens: null,
  outputTokens: null,
  decodeTokPerSec: null,
  maxTokens: null,
  outputBudget: null,
  overBudget: null,
  stopReason: null,
  jsonValid: null,
  ...over,
  ...(over.startMs !== undefined && over.endMs !== undefined && over.ms === undefined ? { ms: over.endMs - over.startMs } : {})
});

test("readRunLog requires the runlog/1 header and names a bad line", () => {
  /* MUTATION: skip the header check (treat the first line as an event). Ran
     it: red. A file of another schema would be summarised as a run with no
     calls — a fast, clean-looking run that never happened. */
  const { header, events } = readRunLog(SYNTH);
  assert.equal(header.schema, "runlog/1");
  assert.equal(events.length, 26);
  assert.throws(() => parseRunLog(JSON.stringify({ kind: "call" }) + "\n", "x"), /no runlog\/1 header/);
  assert.throws(() => parseRunLog(JSON.stringify({ schema: "runlog/2", t0Iso: "t" }) + "\n", "x"), /no runlog\/1 header/);
  assert.throws(() => parseRunLog("\n\n", "x"), /empty file/);
  assert.throws(() => parseRunLog(jsonl() + "{broken\n", "x"), /line 2 is not JSON/);
  /* CRLF (a runlog copied through a Windows checkout) reads the same. */
  assert.deepEqual(parseRunLog(jsonl(call({ stage: "s" })).replace(/\n/g, "\r\n")).events.length, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv17-"));
  assert.throws(() => readRunLog(path.join(dir, "missing.jsonl")), /cannot read/);
});

test("MT-06: the synthetic run is 5 calls in series (3 serial, 4 parallel writers as one link, stitch)", () => {
  /* MUTATION: `xs[j].endMs < xs[i].startMs` (strict) in seriesDepth(). Ran
     it: red — a call that starts the instant the previous one ends is in
     series, and the fixture's calls abut exactly. SECOND MUTATION: count
     every call (`best = xs.length`). Ran it: red (8). */
  const s = synth();
  assert.equal(s.calls, 8);
  assert.equal(s.seriesDepth, 5);
  /* Up to act 0's ready event at 9,500 ms: the 3 serial calls plus the two
     writers that ended by then (parallel, so one link). */
  assert.equal(s.seriesBeforeFirstReady, 4);
  assert.equal(seriesDepth([]), 0);
  const overlap = [call({ startMs: 0, endMs: 100 }), call({ startMs: 50, endMs: 150 }), call({ startMs: 99, endMs: 300 })];
  assert.equal(seriesDepth(overlap), 1);
  /* Order of the input does not matter: the DP sorts by start. */
  assert.equal(seriesDepth([call({ startMs: 200, endMs: 300 }), call({ startMs: 0, endMs: 100 }), call({ startMs: 100, endMs: 200 })]), 3);
});

test("MT-06: seriesBeforeFirstReady is null without a ready event, never 0", () => {
  /* MUTATION: `firstReadyMs === null ? 0 : ...`. Ran it: red. */
  const s = summarizeRunLog(parseRunLog(jsonl(call({ startMs: 0, endMs: 10 }))).events);
  assert.equal(s.seriesBeforeFirstReady, null);
  assert.equal(s.seriesDepth, 1);
});

test("MT-07: repeat work on the synthetic run is 1 JSON re-ask and 2 extra rounds", () => {
  /* MUTATION: `c.attempt > 0` for extraRounds (writeAct's round is
     1-based). Ran it: red (4). */
  const s = synth();
  assert.deepEqual(s.repeatWork, { jsonReasks: 1, spineReasks: 0, extraRounds: 2, continuations: 0, parseFailures: 1 });
  assert.equal(repeatRequests(s.repeatWork), 3);
  assert.equal(repeatRequests(null), null);
});

test("MT-07: each repeat request is counted once, under the kind the backend's context gives it", () => {
  /* MUTATION: drop the `reask === null` guard on extraRounds. Ran it: red —
     a JSON re-ask made inside writer round 2 would count as a re-ask AND an
     extra round. SECOND MUTATION: count only `structural` as a spine re-ask.
     Ran it: red (postSeedSpine's re-ask is `seed-floor`). */
  const events = parseRunLog(
    jsonl(
      call({ stage: "spine", reask: "structural", attempt: 1 }),
      call({ stage: "spine", reask: "seed-floor" }),
      call({ stage: "narrate:0", role: "writer", attempt: 2 }),
      call({ stage: "narrate:0", role: "writer", attempt: 2, reask: "json" }),
      call({ stage: "narrate:0", role: "verifier", attempt: 2 }),
      call({ stage: "narrate:0", role: "writer", attempt: 1, reask: "continuation" }),
      { kind: "parse", ok: false, reask: false },
      { kind: "parse", ok: true, reask: true },
      { kind: "parse", ok: false, reask: true }
    )
  ).events;
  const s = summarizeRunLog(events);
  assert.deepEqual(s.repeatWork, { jsonReasks: 1, spineReasks: 2, extraRounds: 1, continuations: 1, parseFailures: 2 });
  assert.equal(repeatRequests(s.repeatWork), 5);
});

test("MT-05: output tokens per stage and overall; per-stage budget and over-budget count", () => {
  /* MUTATION: `overBudget: overFlags.filter(Boolean).length` with no
     null branch (a stage whose calls never said reads 0). Ran it: red on
     stitch. */
  const s = synth();
  assert.equal(s.outputTokens, 5150);
  assert.equal(s.promptTokens, 19000);
  assert.deepEqual(s.outputTokensByStage, { understand: 100, spine: 2300, "narrate:0": 600, "narrate:1": 600, "narrate:2": 600, "narrate:3": 750, stitch: 200 });
  assert.deepEqual(s.callsByStage, { understand: 1, spine: 2, "narrate:0": 1, "narrate:1": 1, "narrate:2": 1, "narrate:3": 1, stitch: 1 });
  assert.deepEqual(s.perStage.spine, {
    calls: 2,
    promptTokens: 5200,
    cachedTokens: 2800,
    outputTokens: 2300,
    outputBudget: 3000,
    overBudget: 0,
    ms: 5000,
    p50CallMs: 2500,
    proseTokPerSec: null,
    e2eTokPerSec: 460
  });
  assert.equal(s.perStage["narrate:3"].overBudget, 1);
  assert.equal(s.perStage.stitch.overBudget, null);
  assert.equal(s.perStage.stitch.outputBudget, null);
  assert.equal(s.perStage.stitch.cachedTokens, null);
});

test("a sum skips a call whose field is null instead of adding 0, and a call with no stage is filed under (none)", () => {
  /* MUTATION: `(c.outputTokens ?? 0)` summed with a 0 start, so a stage
     whose calls never reported reads 0. Ran it: red on `b`. */
  const s = summarizeRunLog(
    parseRunLog(jsonl(call({ stage: "a", outputTokens: 5 }), call({ stage: "a", outputTokens: null }), call({ stage: "b" }), call({ outputTokens: 2 }))).events
  );
  assert.equal(s.perStage.a.outputTokens, 5);
  assert.equal(s.perStage.b.outputTokens, null);
  assert.equal(s.outputTokensByStage.b, null);
  assert.equal(s.perStage[UNSTAGED].outputTokens, 2);
  assert.equal(s.outputTokens, 7);
});

test("MT-04: queue and TTFT medians and the cache share, over the calls that report them", () => {
  /* MUTATION: `cachedShare: ... : 0` (the empty-log reading below, and
     rule 1's test). Ran it: red. */
  const s = synth();
  assert.equal(s.queueP50Ms, 20);
  assert.equal(s.ttftP50Ms, 400);
  /* Stitch carries prompt tokens but no cached count, so it is out of BOTH
     sides of the share: 12,800 / 18,000, not 12,800 / 19,000. */
  assert.equal(s.cachedShare, 12800 / 18000);
  assert.equal(p50([4, 1, 3, 2]), 2.5);
  assert.equal(p50([null, 7, undefined]), 7);
  assert.equal(p50([null]), null);
});

test("MT-12: the prose rate is the decode rate over calls with a TTFT; the e2e rate is kept apart", () => {
  /* MUTATION: fold the no-TTFT calls into the decode sum (`proseMs += ms`).
     Ran it: red. A decode rate diluted with end-to-end calls reads slower
     than the model is. */
  const s = synth();
  assert.deepEqual(s.prose, { tokPerSec: 2550 / 12.4, basis: "ttft" });
  assert.equal(s.perStage["narrate:1"].proseTokPerSec, 600 / 3);
  assert.equal(s.perStage.understand.e2eTokPerSec, 100);
  const mixed = tokRates([call({ startMs: 0, endMs: 2000, ttftMs: 500, outputTokens: 300 }), call({ startMs: 0, endMs: 4000, outputTokens: 100 })]);
  assert.deepEqual(mixed, { proseTokPerSec: 200, e2eTokPerSec: 25 });
  /* No writer TTFT anywhere: the end-to-end rate, labelled. */
  const e2e = summarizeRunLog(parseRunLog(jsonl(call({ role: "writer", startMs: 0, endMs: 2000, outputTokens: 300 }))).events);
  assert.deepEqual(e2e.prose, { tokPerSec: 150, basis: "e2e" });
  /* No writer at all: absent. */
  assert.deepEqual(summarizeRunLog(parseRunLog(jsonl(call({ role: "verifier", startMs: 0, endMs: 10, outputTokens: 1 }))).events).prose, {
    tokPerSec: null,
    basis: null
  });
});

test("MT-08, MT-09, MT-10: code time per stage, render rate, and spend net of reservations", () => {
  /* MUTATION: drop the `reserved === true` split (a reservation then counts
     as spend: 30.5 Spark seconds). Ran it: red. SECOND MUTATION:
     `firstRenderMs: renders.at(-1).ms`. Ran it: red. */
  const s = synth();
  assert.deepEqual(s.codeMsByStage, { "research-shape": 900, source: 1500 });
  assert.equal(s.codeMs, 2400);
  assert.equal(s.renderRealtime, 4);
  assert.equal(s.firstRenderMs, 5000);
  assert.deepEqual(s.unitSpend, { sparkSeconds: 20.5, jevCalls: 1 });
  assert.deepEqual(s.unitReserved, { sparkSeconds: 10 });
  assert.equal(SPARK_UNIT, "sparkSeconds");
});

test("rule 1: a runlog with no calls, codes, renders or meters reads every measurement as absent", () => {
  /* MUTATION: `codeMs: ... : 0`. Ran it: red. A log from a run with no
     code spans did not spend 0 s in code, and one with no render worker did
     not render at 0x. */
  const s = summarizeRunLog(parseRunLog(jsonl({ kind: "stage", name: "understand", startMs: 0, endMs: 5, ms: 5, status: "ok" })).events);
  assert.equal(s.calls, 0);
  assert.equal(s.seriesDepth, 0, "zero calls is a measured zero");
  for (const key of ["promptTokens", "cachedTokens", "outputTokens", "queueP50Ms", "ttftP50Ms", "cachedShare", "codeMs", "renderRealtime", "firstRenderMs", "seriesBeforeFirstReady"]) {
    assert.equal(s[key], null, key);
  }
  assert.deepEqual(s.prose, { tokPerSec: null, basis: null });
  assert.deepEqual(s.unitSpend, {});
  assert.deepEqual(s.repeatWork, { jsonReasks: 0, spineReasks: 0, extraRounds: 0, continuations: 0, parseFailures: 0 });
});

test("the synthetic fixture uses only declared event kinds and complete CallRecords, and carries no prompt text", () => {
  /* MUTATION: drop "render" from EVENT_KINDS. Ran it: red. The parity test
     in the backend checks the same two lists against a real RunLog. */
  const { events } = readRunLog(SYNTH);
  for (const e of events) assert.equal(EVENT_KINDS.includes(e.kind), true, e.kind);
  for (const c of events.filter((e) => e.kind === "call")) {
    for (const field of CALL_FIELDS) assert.equal(field in c, true, `call ${c.seq} has ${field}`);
  }
  const report = JSON.parse(fs.readFileSync(path.join(SYNTH_DIR, "report.json"), "utf8"));
  assert.equal(report.entries.length, 1);
  assert.match(report.entries[0].prompt, /^synthetic runlog fixture/);
  assert.equal(report.entries[0].runLog, "runlogs/synth.1.runlog.jsonl");
});
