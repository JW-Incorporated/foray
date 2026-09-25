/* The run-of-day slot of the build number — tools/release/build-number.mjs.
 *
 * ci-release-4 (round-3 audit): the old slot was the lifetime run_number
 * wrapped modulo 99, which goes DOWN (99 -> 1) and, on a day that straddles
 * the wrap, makes both stores reject every later release. Each test names the
 * mutation that defeats it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_RUN_OF_DAY, buildNumbersInLog, runCli, runOfDay } from "./build-number.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAY = "2026-09-24";
const run = (id, at = `${DAY}T12:00:00Z`) => ({ id, created_at: at });

test("the slot is the count of today's runs up to and including this one", () => {
  const runs = [run(10, `${DAY}T01:00:00Z`), run(20, `${DAY}T05:00:00Z`), run(30, `${DAY}T09:00:00Z`)];
  assert.equal(runOfDay({ runs, runId: 20, day: DAY }).runOfDay, 2);
  assert.equal(runOfDay({ runs, runId: 30, day: DAY }).runOfDay, 3);
});

test("THE WRAP: run_number 99 then 100 on one day no longer goes 99 -> 1", () => {
  /* The finding's exact scenario. The old formula gave (100-1)%99+1 = 1 for
     the second run after the first printed ...99. MUTATION: drop the floor
     (return `count`) -> 2, lower than 99, and the test fails. */
  const runs = [run(1), run(2)];
  const r = runOfDay({ runs, runId: 2, day: DAY, usedBuildNumbers: ["2026092499"] });
  assert.equal(r.ok, false, "a 100th slot must refuse, not wrap");
  const r2 = runOfDay({ runs, runId: 2, day: DAY, usedBuildNumbers: ["2026092431"] });
  assert.equal(r2.runOfDay, 32, "strictly above what an earlier run of the day really used");
});

test("the switch-over day: runs made earlier under the wrapped scheme set the floor", () => {
  // 2026-09-25 had runs #31 and #32 before this change could merge; they used
  // nn=31 and nn=32. A bare count would say 3 and go backwards.
  const runs = [run(100), run(200), run(300)];
  const r = runOfDay({ runs, runId: 300, day: DAY, usedBuildNumbers: ["2026092431", "2026092432"] });
  assert.equal(r.runOfDay, 33);
});

test("strictly increasing across consecutive runs of one day", () => {
  const runs = [];
  const used = [];
  let last = 0;
  for (let i = 1; i <= 20; i++) {
    runs.push(run(i * 7));
    const r = runOfDay({ runs, runId: i * 7, day: DAY, usedBuildNumbers: used });
    assert.ok(r.ok && r.runOfDay > last, `run ${i}: ${JSON.stringify(r)} after ${last}`);
    last = r.runOfDay;
    used.push(`20260924${String(r.runOfDay).padStart(2, "0")}`);
  }
});

test("runs from other days, later runs and junk are not counted", () => {
  const runs = [run(1, "2026-09-23T23:59:59Z"), run(2), run(3), run(4), { id: "x" }, null];
  assert.equal(runOfDay({ runs, runId: 3, day: DAY }).runOfDay, 2);
});

test("build numbers from other days never raise today's floor", () => {
  const r = runOfDay({ runs: [run(5)], runId: 5, day: DAY, usedBuildNumbers: ["2026092399", "202609249", "x"] });
  assert.equal(r.runOfDay, 1);
});

test(`past ${MAX_RUN_OF_DAY} it refuses loudly instead of wrapping`, () => {
  /* MUTATION: wrap (`% 99`) or clamp instead of refusing -> ok:true here. */
  const runs = Array.from({ length: 100 }, (_, i) => run(i + 1));
  const r = runOfDay({ runs, runId: 100, day: DAY });
  assert.equal(r.ok, false);
  assert.match(r.error, /00:00 UTC/);
  assert.equal(runOfDay({ runs, runId: 99, day: DAY }).runOfDay, 99);
});

test("a run that is not in its own list is refused, never guessed", () => {
  assert.equal(runOfDay({ runs: [run(1)], runId: 2, day: DAY }).ok, false);
  assert.equal(runOfDay({ runs: [run(1)], runId: 1, day: "yesterday" }).ok, false);
  assert.equal(runOfDay({ runs: [run(1)], runId: "nope", day: DAY }).ok, false);
});

test("buildNumbersInLog reads the version job's own echo", () => {
  const log = "2026-09-24T12:00:01.0Z MARKETING_VERSION=1.2.0\n2026-09-24T12:00:01.1Z BUILD_NUMBER=2026092403\n";
  assert.deepEqual(buildNumbersInLog(log), ["2026092403"]);
});

test("CLI: prints RUN_OF_DAY and exits 0; refuses with exit 1 and an ::error::", () => {
  const files = {
    runs: JSON.stringify({ workflow_runs: [run(1), run(2)] }),
    log: "BUILD_NUMBER=2026092407\n",
    lines: `${JSON.stringify(run(1))}\n${JSON.stringify(run(2))}\n`,
  };
  const io = { readFile: (p) => files[p] };
  const ok = runCli(["run-of-day", "--runs", "runs", "--run-id", "2", "--day", DAY, "--used-log", "log"], io);
  assert.equal(ok.code, 0);
  assert.equal(ok.out, "RUN_OF_DAY=8\n");
  assert.equal(runCli(["run-of-day", "--runs", "lines", "--run-id", "2", "--day", DAY], io).out, "RUN_OF_DAY=2\n");
  const bad = runCli(["run-of-day", "--runs", "runs", "--run-id", "3", "--day", DAY], io);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^::error::/);
  assert.equal(runCli(["nope"], io).code, 2);
});

test("release.yml computes the slot with this script, from its own day, and not from run_number", () => {
  /* MUTATION: put back `RUN_OF_DAY=$(( (${{ github.run_number }} - 1) % 99 + 1 ))`. */
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
  assert.doesNotMatch(wf, /github\.run_number/, "the lifetime run counter must not feed the build number");
  assert.match(wf, /node tools\/release\/build-number\.mjs run-of-day/);
  assert.match(wf, /version\.mjs pair --run-of-day "\$RUN_OF_DAY" --now "\$CREATED_AT"/);
  assert.match(wf, /actions\/workflows\/release\.yml\/runs\?created=\$DAY/);
});
