#!/usr/bin/env node
/* The decisions the native engine's CI gates make, as testable functions.
 *
 * Card NE-06 (docs/native-engine-plan.md §6.8 and §9, gates G-1a and G-1b).
 * Four questions, one per subcommand, each asked by a workflow step that would
 * otherwise have to answer it in inline YAML nobody can run before it merges:
 *
 *   engine-paths   which engine inputs did this event change?  (ci.yml)
 *   summary        the parity family table for $GITHUB_STEP_SUMMARY (ci.yml)
 *   ios-gate       did ios-kit pass, when it had to?  (ci.yml, required at G-1b)
 *   release-checks are engine-parity and ios-kit green on the SHA a TestFlight
 *                  is about to be cut from?  (release.yml)
 *
 * THE ONE RULE, SAME AS release-ci.mjs AND ios-ci.mjs: NOTHING HERE MAY REPORT
 * A PASS FROM ABSENT DATA. Every "I could not tell" answer is the expensive
 * one — run everything, or refuse — because each of these gates is about to be
 * a REQUIRED check, and GitHub counts a skipped or short-circuited required
 * check as satisfied. A classifier that says "nothing changed" when git failed
 * would wave a Swift PR past `ios-gate` with no Swift compiled at all.
 *
 * WHY IT LIVES IN tools/ci/. This directory is on path-policy's DENIED list:
 * a one-line `process.exit(0)` in a gate script neuters a required check with
 * no human in the loop, and `tools/` is otherwise allowlisted for auto-merge.
 * Every script a workflow runs must be denied or explicitly acknowledged
 * (tools/ci/path-policy.test.mjs), and these four are gates.
 *
 * USAGE (subcommands read env / argv and write to stdout / $GITHUB_OUTPUT)
 *   node tools/ci/engine-ci.mjs engine-paths      env EVENT_NAME BEFORE REF_NAME DEFAULT_BRANCH
 *   node tools/ci/engine-ci.mjs summary <parity-report.json>
 *   node tools/ci/engine-ci.mjs ios-gate          env SWIFT_CHANGED GITHUB_TOKEN GITHUB_REPOSITORY GITHUB_RUN_ID
 *   node tools/ci/engine-ci.mjs release-checks <sha>   env GITHUB_TOKEN GITHUB_REPOSITORY
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* ───────────────────────────── which paths count ──────────────────────────── */

/** What `engine-parity` reads. A change anywhere else cannot change its
 *  verdict, so the job short-circuits to success (plan §6.8, G-1b).
 *
 *  The card names the first three. The last two are added because they change
 *  the JOB rather than its inputs: a PR that edits the engine-parity job, or
 *  the script that decides whether it runs, must be exercised by that job on
 *  the PR that makes the change, or the only review a CI-only change can get
 *  (against real output) never happens. */
export const ENGINE_PREFIXES = [
  "player/parity/",
  "mobile/plugins/foray-audio/foray-engine-core/",
  "tools/parity/",
  ".github/workflows/ci.yml",
  "tools/ci/engine-ci.mjs",
];

/** What `ios-kit` reads, so what `ios-gate` must see green when touched.
 *
 *  Deliberately WIDER than "files ending in .swift", because ios-kit's verdict
 *  depends on more than Swift source: the parity FIXTURES (both XCTest parity
 *  wrappers read player/parity/ in place), the generator that writes
 *  EngineConstants.swift, every SwiftPM manifest and lockfile, the mobile/
 *  lockfile ios-kit installs @capacitor/preferences from for the Preferences
 *  pin, and the job's own definition. Over-inclusion costs a macOS run;
 *  under-inclusion lets a red Swift build merge behind a green gate. */
export const SWIFT_PREFIXES = [
  ...ENGINE_PREFIXES,
  "ios/",
  "mobile/plugins/",
  "mobile/package.json",
  "mobile/package-lock.json",
];

const SWIFT_BASENAMES = new Set(["Package.swift", "Package.resolved"]);

export function isEnginePath(file) {
  return ENGINE_PREFIXES.some((p) => file === p || file.startsWith(p));
}

export function isSwiftPath(file) {
  if (file.endsWith(".swift")) return true;
  if (SWIFT_BASENAMES.has(file.slice(file.lastIndexOf("/") + 1))) return true;
  return SWIFT_PREFIXES.some((p) => file === p || file.startsWith(p));
}

/** `files` is the changed-path list, or null when it could not be determined.
 *  NULL MEANS EVERYTHING CHANGED — see the header. */
export function classifyChanges(files) {
  if (files == null) {
    return { engine: true, swift: true, known: false, engineFiles: [], swiftFiles: [] };
  }
  const engineFiles = files.filter(isEnginePath);
  const swiftFiles = files.filter(isSwiftPath);
  return {
    engine: engineFiles.length > 0,
    swift: swiftFiles.length > 0,
    known: true,
    engineFiles,
    swiftFiles,
  };
}

/* ───────────────────────── what did this event change ─────────────────────── */

const ZERO_SHA = /^0+$/;

/** The changed files for one CI event, or null when git cannot say.
 *
 *  THREE EVENTS, THREE BASES, and each choice is the one that can only OVER-
 *  report:
 *
 *   pull_request       HEAD is the merge commit actions/checkout makes, and
 *                      its FIRST parent is the base branch's tip, so
 *                      HEAD^1..HEAD is exactly what merging the PR changes.
 *                      Checked to BE a merge (two parents): a plain commit's
 *                      HEAD^1 is its own parent, and diffing that would report
 *                      the last commit of a many-commit PR.
 *   push               github.event.before..HEAD. A new branch has no before
 *                      (all zeros): unknown.
 *   workflow_dispatch  the default branch's tip..HEAD. pr-hygiene dispatches
 *                      this workflow on a PR head it has just updated FROM
 *                      the default branch, so that is exactly the PR's diff; on
 *                      a branch that is behind, the tree diff also shows main's
 *                      newer files, which only over-reports. A dispatch ON the
 *                      default branch is unknown, deliberately: a manual run
 *                      on main is somebody asking for the real thing, and a
 *                      short-circuited success there would also be the newest
 *                      engine-parity check on that SHA, which is the one
 *                      release-checks reads.
 *
 *  `--no-renames` IS LOAD-BEARING. With rename detection a file MOVED OUT of
 *  player/parity/ is listed only under its new name, and a PR that relocates
 *  the fixtures would short-circuit the job that reads them. */
export function changedFiles({ eventName, before, refName, defaultBranch }, { git = defaultGit } = {}) {
  const diff = (base) =>
    git(["diff", "--name-only", "--no-renames", base, "HEAD"])
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  try {
    if (eventName === "pull_request") {
      const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
      if (parents.length !== 3) return null;
      return diff("HEAD^1");
    }
    if (eventName === "push") {
      if (!before || ZERO_SHA.test(before)) return null;
      git(["fetch", "--no-tags", "--depth=1", "origin", before]);
      return diff(before);
    }
    if (eventName === "workflow_dispatch") {
      if (!defaultBranch || !refName || refName === defaultBranch) return null;
      git(["fetch", "--no-tags", "--depth=1", "origin", `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`]);
      return diff(`refs/remotes/origin/${defaultBranch}`);
    }
    return null;
  } catch {
    return null;
  }
}

function defaultGit(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/* ──────────────────────────── the step summary ────────────────────────────── */

const cell = (v) => String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The markdown engine-parity appends to $GITHUB_STEP_SUMMARY.
 *
 *  `report` is parity-report.json as ForayEngineParity's `SuiteReport` writes
 *  it ({families, results, problems}), or null when the file is missing.
 *  A MISSING REPORT IS SAID, NOT TABULATED AS ZEROS: an empty table reads as
 *  "nothing failed", and the usual reason there is no report is that the
 *  package did not compile. This step never decides the job's verdict —
 *  `swift test` does — so a wrong table is a lie, not a gate bypass, and this
 *  function refuses to print one. */
export function summaryMarkdown(report, { maxFailures = 25 } = {}) {
  const out = ["## engine-parity (Linux, swift:5.10)", ""];
  if (!report || !Array.isArray(report.families)) {
    out.push(
      "**No parity-report.json.** `swift test` did not reach the parity run: the package " +
        "failed to build, or the fixture tree was not found. The step log says which; " +
        "nothing below this line was measured."
    );
    return out.join("\n") + "\n";
  }
  const families = report.families;
  const results = Array.isArray(report.results) ? report.results : [];
  const problems = Array.isArray(report.problems) ? report.problems : [];
  const failures = results.filter((r) => ["failed", "stale-pending", "unaccounted"].includes(r.outcome));
  const sum = (k) => families.reduce((n, f) => n + (Number(f[k]) || 0), 0);

  out.push(
    failures.length === 0 && problems.length === 0
      ? `**Parity books balance:** ${sum("executed")} case(s) executed across ${families.length} famil${families.length === 1 ? "y" : "ies"}, ${sum("owed")} owed by a port card, none failed.`
      : `**Parity is RED:** ${failures.length} failing case(s), ${problems.length} whole-tree problem(s).`,
    "",
    "| family | cases | executed | passed | owed | failed | Swift runner | floor |",
    "|---|---:|---:|---:|---:|---:|---|---:|"
  );
  for (const f of families) {
    out.push(
      `| ${cell(f.family)} | ${f.cases} | ${f.executed} | ${f.passed} | ${f.owed} | ${f.failed} | ${f.hasRunner ? "yes" : "none yet"} | ${f.floor ?? ""} |`
    );
  }
  out.push(
    `| **total** | ${sum("cases")} | ${sum("executed")} | ${sum("passed")} | ${sum("owed")} | ${sum("failed")} | | |`
  );
  if (problems.length) {
    out.push("", "### Problems", "");
    for (const p of problems) out.push(`- ${cell(p)}`);
  }
  if (failures.length) {
    out.push("", "### Failing cases", "");
    for (const r of failures.slice(0, maxFailures)) {
      out.push(`- \`${cell(r.id)}\` [${r.outcome}] ${cell(r.detail).slice(0, 300)}`);
    }
    if (failures.length > maxFailures) out.push(`- … and ${failures.length - maxFailures} more (parity-report.json has them all)`);
  }
  return out.join("\n") + "\n";
}

/* ─────────────────────────────── ios-gate ─────────────────────────────────── */

/** The verdict of the required `ios-gate` check, from the ios-kit JOB in the
 *  same workflow run (null when the run has no such job).
 *
 *  WHY A GATE JOB AT ALL, rather than requiring ios-kit: ios-kit is a 10-minute
 *  macOS job behind a macOS runner queue (measured 5 minutes of queue on run
 *  35963024160). Requiring it would put every content PR — most of this repo's
 *  traffic, all auto-merged — behind a Swift build that cannot be affected by
 *  what they change. The gate is green in seconds when no Swift path changed,
 *  and waits for ios-kit only when one did.
 *
 *  Only `success` passes. `skipped` is a FAILURE here even though GitHub counts
 *  a skipped required job as satisfied: a Swift change whose ios-kit did not
 *  run has not been compiled, and saying so is this job's whole purpose. */
export function iosGateVerdict({ swiftChanged, job }) {
  if (!swiftChanged) {
    return { done: true, ok: true, message: "no Swift path changed: ios-kit is not needed for this change" };
  }
  if (!job) {
    return { done: true, ok: false, message: "a Swift path changed and this run has no ios-kit job" };
  }
  if (job.status !== "completed") {
    return { done: false, ok: false, message: `ios-kit is ${job.status}` };
  }
  if (job.conclusion === "success") {
    return { done: true, ok: true, message: "a Swift path changed and ios-kit passed on this run" };
  }
  return {
    done: true,
    ok: false,
    message: `a Swift path changed and ios-kit ended '${job.conclusion}'${job.html_url ? ` (${job.html_url})` : ""}`,
  };
}

/** Poll until `decide(await fetchOnce())` is done, or `timeoutMs` passes.
 *  A timeout is a refusal with the last thing seen, never a pass. */
export async function pollUntilDone({ fetchOnce, decide, sleep, now = Date.now, timeoutMs, intervalMs, log = () => {} }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let verdict;
    try {
      verdict = decide(await fetchOnce());
    } catch (e) {
      verdict = { done: false, ok: false, message: `could not read the GitHub API: ${e instanceof Error ? e.message : e}` };
    }
    if (verdict.done) return verdict;
    log(verdict.message);
    if (now() >= deadline) {
      return { done: true, ok: false, message: `timed out after ${Math.round(timeoutMs / 60000)} min; last seen: ${verdict.message}` };
    }
    await sleep(intervalMs);
  }
}

/* ──────────────────────────── release refusal ─────────────────────────────── */

/** The two checks a TestFlight build needs green on its own SHA (G-1b). */
export const RELEASE_REQUIRED_CHECKS = ["engine-parity", "ios-kit"];

/** The newest github-actions check run of one name, or null.
 *
 *  FILTERED TO THE github-actions APP, and a run with no app is not it: any
 *  installed app with checks:write can publish a check run called
 *  `engine-parity`, and this gate is about the one ci.yml produced. NEWEST BY ID, because a re-run adds a check run rather
 *  than replacing one, and GitHub's own required-check logic reads the latest. */
export function latestActionsRun(checkRuns, name) {
  const mine = (checkRuns ?? []).filter(
    (r) => r && r.name === name && r.app?.slug === "github-actions"
  );
  if (!mine.length) return null;
  return mine.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
}

/** `runsByName` maps each required check to its newest run (or null).
 *  `missingIsFinal` turns "no such check on this SHA yet" from a wait into a
 *  refusal, once CI has had long enough to have created it. */
export function releaseChecksVerdict(runsByName, { missingIsFinal = false } = {}) {
  const lines = [];
  let pending = false;
  let red = false;
  for (const name of RELEASE_REQUIRED_CHECKS) {
    const run = runsByName[name];
    if (!run) {
      lines.push(`${name}: no check run on this SHA`);
      if (missingIsFinal) red = true;
      else pending = true;
    } else if (run.status !== "completed") {
      lines.push(`${name}: ${run.status}`);
      pending = true;
    } else if (run.conclusion === "success") {
      lines.push(`${name}: success`);
    } else {
      lines.push(`${name}: ${run.conclusion}${run.html_url ? ` (${run.html_url})` : ""}`);
      red = true;
    }
  }
  const message = lines.join("; ");
  if (red) return { done: true, ok: false, message };
  if (pending) return { done: false, ok: false, message };
  return { done: true, ok: true, message };
}

/* ─────────────────────────────── GitHub API ───────────────────────────────── */

function githubGetter(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const api = env.GITHUB_API_URL || "https://api.github.com";
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return async (route) => {
    const res = await fetch(`${api}${route}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`GET ${route} -> ${res.status}`);
    return res.json();
  };
}

/** A minutes setting from env, defaulting only when unset: 0 is a real value
 *  (the tests use it to make a refusal immediate). */
const minutes = (v, dflt) => (v === undefined || v === "" ? dflt : Number(v)) * 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────────────── CLI ──────────────────────────────────── */

function appendOutput(line) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${line}\n`);
  else console.log(line);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const env = process.env;
  if (cmd === "engine-paths") {
    const files = changedFiles({
      eventName: env.EVENT_NAME,
      before: env.BEFORE,
      refName: env.REF_NAME,
      defaultBranch: env.DEFAULT_BRANCH,
    });
    const c = classifyChanges(files);
    console.log(
      c.known
        ? `${files.length} changed file(s) on ${env.EVENT_NAME}; engine=${c.engine} (${c.engineFiles.length}) swift=${c.swift} (${c.swiftFiles.length})`
        : `could not determine the changed files for '${env.EVENT_NAME}': treating every engine and Swift path as changed`
    );
    for (const f of c.swiftFiles.slice(0, 20)) console.log(`  swift/engine input: ${f}`);
    appendOutput(`engine=${c.engine}`);
    appendOutput(`swift=${c.swift}`);
    return 0;
  }
  if (cmd === "summary") {
    const [file] = rest;
    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      report = null;
    }
    process.stdout.write(summaryMarkdown(report));
    return 0;
  }
  if (cmd === "ios-gate") {
    /* Only an explicit "false" skips the wait: an empty value means the
       engine-paths job did not report, and that is "unknown", not "no". */
    const swiftChanged = env.SWIFT_CHANGED !== "false";
    let verdict;
    if (!swiftChanged) {
      verdict = iosGateVerdict({ swiftChanged, job: null });
    } else {
      const get = githubGetter(env);
      const route = `/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/jobs?filter=latest&per_page=100`;
      verdict = await pollUntilDone({
        fetchOnce: async () => (await get(route)).jobs?.find((j) => j.name === "ios-kit") ?? null,
        decide: (job) => iosGateVerdict({ swiftChanged, job }),
        sleep,
        timeoutMs: minutes(env.IOS_GATE_TIMEOUT_MIN, 80),
        intervalMs: 20000,
        log: (m) => console.log(`waiting: ${m}`),
      });
    }
    console.log(`ios-gate: ${verdict.ok ? "PASS" : "FAIL"} — ${verdict.message}`);
    return verdict.ok ? 0 : 1;
  }
  if (cmd === "release-checks") {
    const [sha] = rest;
    if (!/^[0-9a-f]{7,40}$/i.test(sha ?? "")) {
      console.error(`release-checks: '${sha}' is not a commit SHA`);
      return 2;
    }
    const get = githubGetter(env);
    const started = Date.now();
    const missingGraceMs = minutes(env.RELEASE_CHECKS_MISSING_GRACE_MIN, 10);
    const verdict = await pollUntilDone({
      fetchOnce: async () => {
        const byName = {};
        for (const name of RELEASE_REQUIRED_CHECKS) {
          const body = await get(`/repos/${env.GITHUB_REPOSITORY}/commits/${sha}/check-runs?check_name=${name}&per_page=100`);
          byName[name] = latestActionsRun(body.check_runs, name);
        }
        return byName;
      },
      decide: (byName) => releaseChecksVerdict(byName, { missingIsFinal: Date.now() - started >= missingGraceMs }),
      sleep,
      timeoutMs: minutes(env.RELEASE_CHECKS_TIMEOUT_MIN, 40),
      intervalMs: 30000,
      log: (m) => console.log(`waiting: ${m}`),
    });
    if (verdict.ok) {
      console.log(`release-checks: ${sha} may ship to TestFlight — ${verdict.message}`);
      return 0;
    }
    console.log(
      `::error::release-checks: refusing to cut an iOS TestFlight from ${sha}: ${verdict.message}. ` +
        "engine-parity and ios-kit must both be green on the exact SHA being released (docs/native-engine-plan.md G-1b)."
    );
    return 1;
  }
  console.error("Usage: node tools/ci/engine-ci.mjs <engine-paths|summary <report>|ios-gate|release-checks <sha>>");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  );
}
