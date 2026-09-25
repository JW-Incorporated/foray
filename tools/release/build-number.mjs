#!/usr/bin/env node
/* The run-of-day slot of the build number — ci-release-4 (round-3 audit).
 *
 * WHAT WAS WRONG. release.yml passed `version.mjs pair` a run-of-day of
 * `(run_number - 1) % 99 + 1`: the LIFETIME run counter, wrapped. Run 99 gave
 * nn=99 and run 100 gave nn=01, so when both fell on one UTC day the second
 * build number (YYYYMMDD01) was LOWER than one already uploaded that day. Play
 * rejects a lower versionCode and App Store Connect a lower
 * CFBundleVersion, so every later release that day failed, release-trigger
 * spent its retry budget on them, and automatic releases stopped until a human
 * dispatched one by hand. docs/DECISIONS.md (R-02) calls monotonicity "a
 * correctness requirement, not a style preference"; the wrap broke it.
 *
 * WHAT IT IS NOW. Two numbers, and the larger wins:
 *   - COUNT: how many release.yml runs were created on this run's UTC day up
 *     to and including this one. Run ids grow with creation time, so a later
 *     run always counts at least one more.
 *   - FLOOR: one more than the highest run-of-day an EARLIER run of the same
 *     day actually printed (its version job logs `BUILD_NUMBER=YYYYMMDDnn`).
 *     This is the "strictly greater than the last one uploaded" assertion, and
 *     it is what makes the switch-over day safe: runs made earlier that day
 *     under the old wrapped scheme may have used nn=31, and a count of 3 would
 *     otherwise go backwards.
 * Past 99 it refuses, loudly, in the ubuntu `version` job — before any macOS
 * minute is spent — rather than wrapping.
 *
 * Pure function plus a thin CLI, like the rest of tools/release/. The workflow
 * gathers the runs and the logs; nothing here talks to a network.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const MAX_RUN_OF_DAY = 99;

/** YYYY-MM-DD -> YYYYMMDD, or null if it is not that shape. */
function compactDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(day ?? "")) ? String(day).replace(/-/g, "") : null;
}

/**
 * -> { ok: true, runOfDay, count, floor } | { ok: false, error }
 *
 * `runs`: release.yml runs (the runs API's objects; only `id` and `created_at`
 *   are read). Runs from other days are ignored, so the caller may over-fetch.
 * `runId`: this run's id. It must be among `runs` — a count that cannot find
 *   the run it is counting for is not a count.
 * `day`: this run's own UTC creation day, YYYY-MM-DD.
 * `usedBuildNumbers`: build numbers earlier runs printed (strings or numbers);
 *   anything not of the form <this day>nn is ignored.
 */
export function runOfDay({ runs = [], runId, day, usedBuildNumbers = [] } = {}) {
  const compact = compactDay(day);
  if (!compact) return { ok: false, error: `not a UTC day: ${JSON.stringify(day)}` };
  const me = Number(runId);
  if (!Number.isFinite(me)) return { ok: false, error: `not a run id: ${JSON.stringify(runId)}` };

  const ids = new Set();
  for (const r of Array.isArray(runs) ? runs : []) {
    const id = Number(r?.id);
    if (!Number.isFinite(id) || id > me) continue;
    if (typeof r?.created_at !== "string" || !r.created_at.startsWith(day)) continue;
    ids.add(id);
  }
  if (!ids.has(me)) {
    return { ok: false, error: `run ${me} is not among release.yml's runs for ${day}; refusing to guess a build number` };
  }
  const count = ids.size;

  let highest = 0;
  for (const b of Array.isArray(usedBuildNumbers) ? usedBuildNumbers : []) {
    const s = String(b ?? "").trim();
    if (s.length === compact.length + 2 && s.startsWith(compact) && /^\d+$/.test(s)) {
      highest = Math.max(highest, Number(s.slice(-2)));
    }
  }
  const floor = highest + 1;
  const n = Math.max(count, floor);
  if (n > MAX_RUN_OF_DAY) {
    return {
      ok: false,
      error:
        `this would be run-of-day ${n} on ${day} (count ${count}, last used ${highest}); the build number has ` +
        `two digits for it (YYYYMMDDnn), and a lower or repeated number is rejected by both stores. Wait for 00:00 UTC.`,
    };
  }
  return { ok: true, runOfDay: n, count, floor };
}

/** `BUILD_NUMBER=...` values from a version job's log text. */
export function buildNumbersInLog(text) {
  return [...String(text ?? "").matchAll(/BUILD_NUMBER=(\d+)/g)].map((m) => m[1]);
}

/* --------------------------------------------------------------------- CLI */

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** -> { code, out, err }. Usage:
 *  build-number.mjs run-of-day --runs runs.json --run-id N --day YYYY-MM-DD [--used-log logs.txt]
 *  `--runs` accepts the runs API envelope, a bare array, or JSON lines. */
export function runCli(argv, io = {}) {
  const read = io.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  if (argv[0] !== "run-of-day") {
    return { code: 2, out: "", err: "usage: build-number.mjs run-of-day --runs <json> --run-id <id> --day <YYYY-MM-DD> [--used-log <file>]\n" };
  }
  let runs;
  try {
    const text = read(arg(argv, "--runs"));
    const trimmed = text.trim();
    if (trimmed === "") runs = [];
    else {
      try {
        const doc = JSON.parse(trimmed);
        runs = Array.isArray(doc) ? doc : (doc?.workflow_runs ?? []);
      } catch {
        runs = trimmed.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      }
    }
  } catch (e) {
    return { code: 2, out: "", err: `could not read --runs: ${e.message}\n` };
  }
  const logPath = arg(argv, "--used-log");
  let used = [];
  if (logPath) {
    try {
      used = buildNumbersInLog(read(logPath));
    } catch (e) {
      return { code: 2, out: "", err: `could not read --used-log: ${e.message}\n` };
    }
  }
  const r = runOfDay({ runs, runId: arg(argv, "--run-id"), day: arg(argv, "--day"), usedBuildNumbers: used });
  if (!r.ok) return { code: 1, out: "", err: `::error::${r.error}\n` };
  return {
    code: 0,
    out: `RUN_OF_DAY=${r.runOfDay}\n`,
    err: `run-of-day ${r.runOfDay} (runs today up to this one: ${r.count}; one past the highest already used: ${r.floor})\n`,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { code, out, err } = runCli(process.argv.slice(2));
  process.stdout.write(out);
  process.stderr.write(err);
  process.exit(code);
}
