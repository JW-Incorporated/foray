/* The release watchdog and trigger — tools/release/watch-release.mjs.
 *
 * WHAT THIS SUITE IS FOR, STATED FIRST. The failure this exists to end is not
 * "a release failed" — releases will fail; Apple's ingestion server returns 500s.
 * It is "a release failed and nobody knew for sixteen hours". So the centre of
 * the suite is a REPLAY of that night, from the real run history, the real
 * summary-job log and the real git history, asserting every gate the watchdog
 * would have raised at 16:00 UTC on 2026-09-22 — the hour the founder found it
 * by hand — and that the trigger would have retried it on its own.
 *
 * THE FIXTURES ARE REAL (tools/release/fixtures/):
 *   release-runs-2026-09-23.json  `GET .../workflows/release.yml/runs`, trimmed to
 *                                 the fields the module reads. Runs 18-25.
 *   summary-job-35672098914.txt   the `summary` job log of the 00:28 failure,
 *                                 verbatim: the runner's script echo AND env echo.
 *   jobs-34042838342.json         the 2026-09-06 run where android died before
 *                                 its credential gate — the summary job went
 *                                 GREEN, which is the plan's §5 blind spot.
 *   summary-job-101513086385.txt  that run's `summary` job log, verbatim: no
 *                                 outcome line, and a BLANK `ANDROID_STATE: `
 *                                 in the env echo — the input G2 really gets.
 *   git-log-37554f6..a5f90c1.txt  `git log` in the exact format the workflows
 *                                 use, over the commits those runs shipped.
 * A suite written against paraphrased API output is the forgiving-fake failure
 * CLAUDE.md names; the field names and the log's shape ARE the mechanism.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  releaseTier, bundleSet, parseGitLog, pendingWork, lastSuccess, failuresSinceSuccess,
  parseOutcome, failedGate, divergentGate, stalledGate, stuckGate, livenessGate,
  watchVerdict, mainState, triggerDecision, triggerVerdict, selfBrokenVerdict, planIssue, renderIssueBody, run,
  GIT_LOG_FORMAT, ISSUE_MARKER, ISSUE_TITLE, GRACE_MINUTES, STALL_HOURS, STUCK_MINUTES,
  RETRY_BUDGET, TRIGGER_STALE_HOURS, WATCHDOG_STALE_HOURS,
} from "./watch-release.mjs";
import { code, block, step } from "../mobile/workflow-yaml.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FIX = (f) => path.join(HERE, "fixtures", f);

const RUNS = JSON.parse(fs.readFileSync(FIX("release-runs-2026-09-23.json"), "utf8")).workflow_runs;
const SUMMARY_LOG = fs.readFileSync(FIX("summary-job-35672098914.txt"), "utf8");
const JOBS_0906 = JSON.parse(fs.readFileSync(FIX("jobs-34042838342.json"), "utf8")).jobs;
const SUMMARY_LOG_0906 = fs.readFileSync(FIX("summary-job-101513086385.txt"), "utf8");
const GIT_LOG = fs.readFileSync(FIX("git-log-37554f6..a5f90c1.txt"), "utf8");
const COMMITS = parseGitLog(GIT_LOG);
const WATCH_WF = fs.readFileSync(path.join(ROOT, ".github/workflows/release-watch.yml"), "utf8");
const TRIGGER_WF = fs.readFileSync(path.join(ROOT, ".github/workflows/release-trigger.yml"), "utf8");

/* A small, explicit bundle for the hermetic tests. One test below reads the
 * REAL plan from prepare-webdir.mjs, which is what the workflows use. */
const BUNDLE = bundleSet(
  ["index.html", "app.js", "styles.css", "player/client.js", "player/media-session.js",
    "data/discover.json", "data/forays-directory.json"],
  [{ src: "mobile/plugins/foray-tts/web/foray-tts.js", dest: "foray-tts.js" }]
);

/** The world as it stood at `now`: runs that existed, and what `git log
 *  <last success>..origin/main` would have printed then. */
function asOf(now) {
  const runs = RUNS.filter((r) => Date.parse(r.created_at) <= Date.parse(now))
    .map((r) => (Date.parse(r.updated_at) > Date.parse(now) ? { ...r, status: "in_progress", conclusion: null } : r));
  const success = lastSuccess(runs);
  const cut = COMMITS.findIndex((c) => c.sha === success.head_sha);
  const commits = COMMITS.slice(0, cut).filter((c) => Date.parse(c.committedAt) <= Date.parse(now));
  return { runs, commits };
}

const ALIVE_PEER = { state: "active", created_at: "2026-09-01T00:00:00Z" };
const peerRunAt = (iso, extra = {}) => ({ id: 1, event: "schedule", status: "completed", conclusion: "success", created_at: iso, ...extra });

/* ═══════════════════════ the night it was built for ═══════════════════════ */

test("REPLAY 2026-09-22 16:00Z: the 00:28 partial failure raises G1, G2 and G3 — the three things the founder found by hand", () => {
  const now = "2026-09-22T16:00:00Z";
  const { runs, commits } = asOf(now);
  const v = watchVerdict({
    runs, jobs: [], summaryLog: SUMMARY_LOG, commits, bundle: BUNDLE,
    peerWorkflow: ALIVE_PEER, peerRuns: [peerRunAt("2026-09-22T15:47:00Z")], now,
  });
  const byId = Object.fromEntries(v.gates.map((g) => [g.id, g]));
  assert.equal(v.ok, false);
  assert.equal(byId.G1.code, "RELEASE_FAILED");
  assert.equal(byId.G1.facts.run_number, 23);
  // The real log: iOS ready but never reported an upload, Android uploaded.
  assert.equal(byId.G2.code, "STORES_DIVERGED");
  assert.match(byId.G2.message, /^Play received build 2026092223 and TestFlight did not/);
  // #732 (564e682) touched app.js at 00:27Z and never shipped: 15.5h by 16:00.
  assert.equal(byId.G3.code, "RELEASE_STALLED");
  assert.match(byId.G3.facts.oldest_waiting, /^564e682 /);
  assert.equal(byId.G4.ok, true);
  assert.equal(byId.L.ok, true);
});

test("REPLAY: the same failure 12 minutes after it happened is inside the grace, not an alarm", () => {
  const now = "2026-09-22T00:44:30Z";
  const { runs } = asOf(now);
  assert.equal(failedGate(runs, now).code, "FAILED_IN_GRACE");
  assert.equal(divergentGate(runs, [], parseOutcome(SUMMARY_LOG), now).code, "DIVERGED_IN_GRACE");
});

test("REPLAY: the trigger at 03:47Z would have retried the failure itself — a fresh dispatch, one failure under budget", () => {
  const now = "2026-09-22T03:47:00Z";
  const { runs, commits } = asOf(now);
  const d = triggerDecision({ runs, commits, bundle: BUNDLE, mainRuns: [], mainStatus: { total_count: 0, state: "pending" } });
  assert.equal(d.code, "DISPATCH");
  assert.equal(d.dispatch, true);
  assert.match(d.reason, /564e682/);
});

test("REPLAY: the present (after run 25 shipped a5f90c1) is all green", () => {
  const now = "2026-09-23T04:00:00Z";
  const { runs, commits } = asOf(now);
  assert.deepEqual(commits, [], "nothing on main is newer than the last release");
  const v = watchVerdict({
    runs, jobs: [], summaryLog: "", commits, bundle: BUNDLE,
    peerWorkflow: ALIVE_PEER, peerRuns: [peerRunAt("2026-09-23T03:47:00Z")], now,
  });
  assert.equal(v.ok, true, JSON.stringify(v.gates.filter((g) => !g.ok)));
});

/* ════════════════════════════ git log and tiers ═══════════════════════════ */

test("parseGitLog reads the workflows' own format, offsets and all", () => {
  assert.equal(COMMITS.length, 12);
  assert.equal(COMMITS[0].sha, "a5f90c124098086fc2358d67c0e72045c3d33f65");
  assert.ok(COMMITS[0].files.includes("app.js"));
  assert.match(COMMITS[0].subject, /^fix\(transport\)/);
  // 41c5b4c was committed at 20:04 -07:00, i.e. 03:04Z — AFTER 914936a (02:58Z).
  const pr737 = COMMITS.find((c) => c.sha.startsWith("41c5b4c"));
  assert.equal(new Date(pr737.committedAt).toISOString(), "2026-09-23T03:04:10.000Z");
  assert.deepEqual(parseGitLog(""), []);
  assert.deepEqual(parseGitLog(undefined), []);
  // A CRLF checkout of the same bytes parses identically.
  assert.deepEqual(parseGitLog(GIT_LOG.replace(/\n/g, "\r\n")), COMMITS);
});

test("the allow-list: the bundle and the native inputs trigger, the bot-rewritten files never do", () => {
  const cases = {
    "app.js": "release",
    "player/client.js": "release",
    "mobile/plugins/foray-tts/web/foray-tts.js": "release",
    "mobile/VERSION": "release",
    "mobile/ios/App/App/Info.plist": "release",
    ".github/workflows/release.yml": "release",
    ".github/actions/ios-archive/action.yml": "release",
    "tools/mobile/inject-splash.mjs": "release",
    "tools/mobile/prepare-webdir.mjs": "release",
    // What the manifest-autofix bot rewrites on nearly every PR (plan §3).
    "sw.js": null,
    "deploy-manifest.json": null,
    // Bundled data is the "seed is stale" tier, never a trigger; unbundled data is nothing.
    "data/forays-directory.json": "seed",
    "data/discover.json": "seed",
    "data/breadth-classification.json": null,
    // Tests and docs never reach a phone, wherever they live.
    "player/media-session.test.js": null,
    "mobile/README.md": null,
    "tools/mobile/foray-media-session.test.mjs": null,
    // Neither the site nor the CI reaches the store binary.
    "api/shows/[show_id]/episodes.ts": null,
    "vercel.json": null,
    ".github/workflows/ci.yml": null,
    "tools/mobile/ios-ci.mjs": null,
  };
  for (const [file, tier] of Object.entries(cases)) {
    assert.equal(releaseTier(file, BUNDLE), tier, file);
  }
});

test("the allow-list reads prepare-webdir.mjs's REAL plan, so a new player file is covered the day it lands", async () => {
  const { buildPlan, SHELL_ONLY_FILES } = await import("../mobile/prepare-webdir.mjs");
  const real = bundleSet(buildPlan(), SHELL_ONLY_FILES);
  assert.equal(releaseTier("app.js", real), "release");
  assert.equal(releaseTier("index.html", real), "release");
  assert.equal(releaseTier("player/client.js", real), "release");
  assert.equal(releaseTier("tools/mobile/kokoro-probe-passage.json", real), "release", "a shell-only file");
  assert.equal(releaseTier("sw.js", real), null, "excluded from the native bundle by prepare-webdir itself");
  assert.equal(releaseTier("data/discover.json", real), "seed");
  assert.equal(releaseTier("deploy-manifest.json", real), null);
});

test("pendingWork splits release from seed-only commits and finds the oldest by COMMIT date, not list order", () => {
  const p = pendingWork(COMMITS, BUNDLE);
  const shas = (list) => list.map((c) => c.sha.slice(0, 7));
  // 41c5b4c (#737) changed only the upload retry — but inside
  // .github/actions/ios-archive/, which is a native input: it changes how the
  // binary is shipped, so it waits for a release like any app change.
  assert.deepEqual(shas(p.release), ["a5f90c1", "41c5b4c", "eeda788", "564e682", "10a080e", "c57b538"]);
  assert.equal(p.oldest.sha.slice(0, 7), "c57b538");
  // #731 (vercel only), #734 (HUMAN-ACTIONS) and the docs commits wait for nothing.
  for (const c of ["d19c8b5", "7c663af", "914936a", "628612f"]) {
    assert.ok(!shas(p.release).includes(c) && !shas(p.seed).includes(c), c);
  }
  // Only the files that matter are carried, so the issue can say why.
  assert.deepEqual(p.release[0].files.sort(), ["app.js", "player/client.js"]);
});

/* ══════════════════════════════ the outcome line ═════════════════════════ */

test("parseOutcome falls back to the runner's env echo on runs from before the line existed — the real 00:28 log", () => {
  const o = parseOutcome(SUMMARY_LOG);
  assert.deepEqual(o, {
    build: "2026092223",
    ios: { state: "ready", uploaded: false },
    android: { state: "ready", uploaded: true },
  });
});

test("parseOutcome reads the RELEASE_OUTCOME line and is not fooled by the script's own echo of it", () => {
  const log = [
    "2026-09-24T00:00:01.0000000Z \x1b[36;1mecho \"RELEASE_OUTCOME ios_state=${IOS_STATE:-} ios_uploaded=${IOS_UPLOADED:-} android_state=${ANDROID_STATE:-} android_uploaded=${ANDROID_UPLOADED:-} build=${BUILD_NUMBER}\"\x1b[0m",
    "2026-09-24T00:00:02.0000000Z   IOS_STATE: absent",
    "2026-09-24T00:00:03.0000000Z RELEASE_OUTCOME ios_state=ready ios_uploaded=true android_state=ready android_uploaded= build=2026092401",
  ].join("\n");
  assert.deepEqual(parseOutcome(log), {
    build: "2026092401",
    ios: { state: "ready", uploaded: true },
    android: { state: "ready", uploaded: false },
  });
  assert.equal(parseOutcome(""), null);
  assert.equal(parseOutcome("nothing relevant here\n"), null);
});

test("CONTRACT: the line release.yml's summary step echoes is the line parseOutcome reads", () => {
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
  const echo = /^\s*echo "(RELEASE_OUTCOME [^"]+)"\s*$/m.exec(code(wf));
  assert.ok(echo, "release.yml's summary step no longer prints a RELEASE_OUTCOME line — the watchdog is blind to G2");
  const env = { IOS_STATE: "ready", IOS_UPLOADED: "", ANDROID_STATE: "ready", ANDROID_UPLOADED: "true", BUILD_NUMBER: "2026092402" };
  const expanded = echo[1].replace(/\$\{(\w+)(?::-[^}]*)?\}/g, (_, name) => env[name] ?? "");
  assert.deepEqual(parseOutcome(`2026-09-24T00:00:00.0000000Z ${expanded}\n`), {
    build: "2026092402",
    ios: { state: "ready", uploaded: false },
    android: { state: "ready", uploaded: true },
  });
  // It must print before the step can exit, or a divergence never reaches the log.
  const summary = wf.slice(wf.indexOf("One table"));
  assert.ok(summary.indexOf("RELEASE_OUTCOME") < summary.indexOf("exit 1"), "the outcome line must come before the first exit");
});

/* ═════════════════════════════════ the gates ═════════════════════════════ */

test("G1: red only after the grace, and any non-success counts — a cancelled release shipped nothing", () => {
  const failed = { id: 9, run_number: 9, status: "completed", conclusion: "failure", created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:10:00Z" };
  assert.equal(failedGate([failed], "2026-09-24T01:09:00Z").ok, true);
  assert.equal(failedGate([failed], `2026-09-24T01:${10 + 1}:00Z`).code, "RELEASE_FAILED");
  assert.equal(failedGate([{ ...failed, conclusion: "cancelled" }], "2026-09-24T03:00:00Z").ok, false);
  assert.equal(failedGate([], "2026-09-24T03:00:00Z").code, "NO_COMPLETED_RELEASE");
  // A newer success clears it; a newer IN-FLIGHT run does not — that is a retry, not a result.
  const ok = { ...failed, id: 10, run_number: 10, conclusion: "success", created_at: "2026-09-24T02:00:00Z", updated_at: "2026-09-24T02:05:00Z" };
  assert.equal(failedGate([ok, failed], "2026-09-24T03:00:00Z").ok, true);
  const retrying = { ...ok, status: "in_progress", conclusion: null };
  assert.equal(failedGate([retrying, failed], "2026-09-24T03:00:00Z").ok, false);
  assert.equal(GRACE_MINUTES, 60);
});

const RUN_0906 = { id: 34042838342, run_number: 1, status: "completed", conclusion: "failure",
  created_at: "2026-09-06T15:36:20Z", updated_at: "2026-09-06T15:40:20Z", head_sha: "c3f2411fc88333a96bb2ac044b6ac5806af7d2da" };

test("G2 REPLAY 2026-09-06 through the real wiring: android died before its gate, the summary went GREEN, and G2 says the stores diverged", () => {
  const summary = JOBS_0906.find((j) => j.name === "summary");
  assert.equal(summary.conclusion, "success", "the fixture is the §5 blind spot: the summary job did not flag it");
  /* The workflow fetches this log because the summary job was not skipped. It
   * has no RELEASE_OUTCOME line, and the runner echoed android's blank state
   * (`ANDROID_STATE: `) — so the outcome is NOT null. This is the path the
   * watchdog actually takes; passing `null` by hand skipped it and passed
   * while the real run reported "a documented gap". */
  const outcome = parseOutcome(SUMMARY_LOG_0906);
  assert.deepEqual(outcome, {
    build: "2026090601",
    ios: { state: "ready", uploaded: true },
    android: { state: "not reached", uploaded: false },
  });
  const g = divergentGate([RUN_0906], JOBS_0906, outcome, "2026-09-06T17:00:00Z");
  assert.equal(g.code, "STORES_DIVERGED", `G2 read the 09-06 run as ${g.code}: ${g.message}`);
  assert.equal(g.ok, false);
  assert.match(g.message, /^TestFlight received build 2026090601 and Play did not/);
  assert.equal(g.facts.source, "outcome+jobs");
  // …and end to end, exactly as the Judge step calls it.
  const v = watchVerdict({ runs: [RUN_0906], jobs: JOBS_0906, summaryLog: SUMMARY_LOG_0906, commits: [], bundle: BUNDLE,
    peerWorkflow: ALIVE_PEER, peerRuns: [peerRunAt("2026-09-06T16:47:00Z")], now: "2026-09-06T17:00:00Z" });
  assert.equal(v.gates.find((x) => x.id === "G2").code, "STORES_DIVERGED");
});

test("G2 from job conclusions alone when there is no summary log at all (expired, or never fetched)", () => {
  for (const log of ["", undefined]) {
    const g = divergentGate([RUN_0906], JOBS_0906, parseOutcome(log), "2026-09-06T17:00:00Z");
    assert.equal(g.code, "STORES_DIVERGED");
    assert.match(g.message, /^TestFlight received build from run #1 and Play did not/);
    assert.equal(g.facts.source, "jobs");
  }
});

test("G2: 'not reached' is UNKNOWN, not 'not ready' — the job decides; only an explicit non-ready state is a documented gap", () => {
  const r = { ...RUN_0906, conclusion: "success", updated_at: "2026-09-24T00:05:00Z" };
  const jobs = (ios, android) => [{ name: "ios", conclusion: ios }, { name: "android", conclusion: android }];
  const notReached = { build: "7", ios: { state: "ready", uploaded: true }, android: { state: "not reached", uploaded: false } };
  const now = "2026-09-24T05:00:00Z";
  assert.equal(divergentGate([r], jobs("success", "failure"), notReached, now).code, "STORES_DIVERGED");
  assert.equal(divergentGate([r], jobs("success", "success"), notReached, now).code, "STORES_AGREE");
  assert.equal(divergentGate([r], jobs("success", "skipped"), notReached, now).code, "STORE_JOBS_UNDECIDED");
  assert.equal(divergentGate([r], [], notReached, now).code, "NO_STORE_JOBS");
  // An explicit non-ready state on either side is still the documented gap, whatever the jobs say.
  const absent = { ...notReached, ios: { state: "absent", uploaded: false } };
  assert.equal(divergentGate([r], jobs("success", "failure"), absent, now).code, "NOT_BOTH_READY");
  const partial = { ...notReached, android: { state: "partial", uploaded: false } };
  assert.equal(divergentGate([r], jobs("success", "failure"), partial, now).code, "NOT_BOTH_READY");
  // A reached-and-ready state still wins over its job: green-but-skipped is a non-upload.
  const skipped = { build: "7", ios: { state: "ready", uploaded: true }, android: { state: "ready", uploaded: false } };
  assert.equal(divergentGate([r], jobs("success", "success"), skipped, now).code, "STORES_DIVERGED");
});

test("G2: a store with documented-absent credentials is a known gap, not a divergence", () => {
  const r = { id: 1, run_number: 1, status: "completed", conclusion: "success", created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:05:00Z" };
  const absent = { build: "1", ios: { state: "ready", uploaded: true }, android: { state: "absent", uploaded: false } };
  assert.equal(divergentGate([r], [], absent, "2026-09-24T05:00:00Z").code, "NOT_BOTH_READY");
  const agree = { build: "1", ios: { state: "ready", uploaded: true }, android: { state: "ready", uploaded: true } };
  assert.equal(divergentGate([r], [], agree, "2026-09-24T05:00:00Z").code, "STORES_AGREE");
});

test("G3: work inside the budget waits quietly; past it is red; no success on record is red", () => {
  const success = { id: 1, head_sha: "a".repeat(40) };
  const pending = pendingWork([{ sha: "b".repeat(40), committedAt: "2026-09-24T00:00:00Z", subject: "x", files: ["app.js"] }], BUNDLE);
  assert.equal(stalledGate(pending, success, `2026-09-24T0${STALL_HOURS - 1}:00:00Z`).code, "WAITING_IN_BUDGET");
  assert.equal(stalledGate(pending, success, `2026-09-24T0${STALL_HOURS + 1}:00:00Z`).code, "RELEASE_STALLED");
  const seedOnly = pendingWork([{ sha: "c".repeat(40), committedAt: "2026-09-20T00:00:00Z", subject: "nightly", files: ["data/discover.json"] }], BUNDLE);
  assert.equal(stalledGate(seedOnly, success, "2026-09-24T00:00:00Z").code, "NOTHING_WAITING", "a nightly data commit never stalls a release");
  assert.equal(stalledGate(pending, null, "2026-09-24T00:00:00Z").code, "NO_SUCCESSFUL_RELEASE");
});

test("G4: running or queued for over an hour is stuck; half an hour is a slow run", () => {
  const running = { id: 5, run_number: 5, status: "in_progress", created_at: "2026-09-24T00:00:00Z", run_started_at: "2026-09-24T00:00:00Z" };
  assert.equal(stuckGate([running], "2026-09-24T00:30:00Z").ok, true);
  assert.equal(STUCK_MINUTES, 60);
  assert.equal(stuckGate([running], "2026-09-24T01:01:00Z").code, "RELEASE_STUCK");
  const queued = { ...running, status: "queued", run_started_at: null };
  assert.equal(stuckGate([queued], "2026-09-24T01:30:00Z").code, "RELEASE_STUCK");
});

test("liveness: #46's disabled banner is red at once; silence past the threshold is red; a brand-new peer is not", () => {
  const now = "2026-09-24T12:00:00Z";
  assert.equal(livenessGate("L", "release-trigger", { state: "disabled_inactivity" }, [], 6, now).code, "PEER_DISABLED");
  assert.equal(livenessGate("L", "release-trigger", { state: "disabled_manually" }, [peerRunAt("2026-09-24T11:47:00Z")], 6, now).code, "PEER_DISABLED");
  assert.equal(livenessGate("L", "release-trigger", ALIVE_PEER, [peerRunAt("2026-09-24T03:47:00Z")], TRIGGER_STALE_HOURS, now).code, "PEER_SILENT");
  assert.equal(livenessGate("L", "release-trigger", ALIVE_PEER, [peerRunAt("2026-09-24T08:47:00Z")], TRIGGER_STALE_HOURS, now).ok, true);
  /* The gaps GitHub actually left on 2026-09-23 (#745): 4.6 h between trigger
     runs, 4 h between watchdog runs, ~5 h before a new workflow's first
     scheduled run. None of them may page. MUTATION: WATCHDOG_STALE_HOURS or
     TRIGGER_STALE_HOURS back to 3 / 4 - these go red. */
  assert.equal(livenessGate("L", "release-trigger", ALIVE_PEER, [peerRunAt("2026-09-24T07:22:00Z")], TRIGGER_STALE_HOURS, now).ok, true);
  assert.equal(livenessGate("L", "release-watch", ALIVE_PEER, [peerRunAt("2026-09-24T08:00:00Z")], WATCHDOG_STALE_HOURS, now).ok, true);
  assert.equal(livenessGate("L", "release-trigger", { state: "active", created_at: "2026-09-24T07:00:00Z" }, [], TRIGGER_STALE_HOURS, now).ok, true);
  // Merged an hour ago, never scheduled yet: measured from the workflow's creation.
  assert.equal(livenessGate("L", "release-watch", { state: "active", created_at: "2026-09-24T11:00:00Z" }, [], WATCHDOG_STALE_HOURS, now).ok, true);
  // A person clicking "Run workflow" proves the code works, not that the cron fires.
  const manual = peerRunAt("2026-09-24T11:59:00Z", { event: "workflow_dispatch" });
  assert.equal(livenessGate("L", "release-watch", ALIVE_PEER, [manual], WATCHDOG_STALE_HOURS, now).code, "PEER_SILENT");
});

/* ═════════════════════════════════ the trigger ═══════════════════════════ */

const WAITING = [{ sha: "d".repeat(40), committedAt: "2026-09-24T00:00:00Z", subject: "fix: a thing", files: ["app.js"] }];
const DONE = { id: 1, run_number: 1, status: "completed", conclusion: "success", head_sha: "e".repeat(40), created_at: "2026-09-23T00:00:00Z", updated_at: "2026-09-23T00:05:00Z" };
const FAILED = (n) => ({ ...DONE, id: 100 + n, run_number: 100 + n, conclusion: "failure", created_at: `2026-09-24T0${n}:00:00Z`, updated_at: `2026-09-24T0${n}:05:00Z` });
const GREEN = { mainRuns: [], mainStatus: { total_count: 1, state: "success" } };

test("trigger: dispatches waiting work on a green main", () => {
  assert.equal(triggerDecision({ runs: [DONE], commits: WAITING, bundle: BUNDLE, ...GREEN }).code, "DISPATCH");
});

test("trigger: holds while a release is in flight — two dispatches would ship twice", () => {
  const inFlight = { ...DONE, id: 2, run_number: 2, status: "queued", conclusion: null, created_at: "2026-09-24T01:00:00Z" };
  assert.equal(triggerDecision({ runs: [inFlight, DONE], commits: WAITING, bundle: BUNDLE, ...GREEN }).code, "HOLD_IN_FLIGHT");
});

test("trigger: nothing release-relevant waiting is a hold, and a data-only night says why", () => {
  const nightly = [{ sha: "f".repeat(40), committedAt: "2026-09-24T00:00:00Z", subject: "nightly", files: ["data/discover.json", "deploy-manifest.json", "sw.js"] }];
  const d = triggerDecision({ runs: [DONE], commits: nightly, bundle: BUNDLE, ...GREEN });
  assert.equal(d.code, "NOTHING_TO_RELEASE");
  assert.match(d.reason, /bundled data only/);
});

test(`trigger: retries one failure, and stops after ${RETRY_BUDGET} in a row`, () => {
  assert.deepEqual(failuresSinceSuccess([FAILED(2), FAILED(1), DONE]).map((r) => r.id), [102, 101]);
  assert.equal(triggerDecision({ runs: [FAILED(1), DONE], commits: WAITING, bundle: BUNDLE, ...GREEN }).code, "DISPATCH");
  assert.equal(triggerDecision({ runs: [FAILED(2), FAILED(1), DONE], commits: WAITING, bundle: BUNDLE, ...GREEN }).code, "HOLD_RETRY_BUDGET");
});

test("trigger: holds on a red or building main, but never on the release machinery's own runs or an empty status", () => {
  const pagesFailed = { name: "pages build and deployment", event: "dynamic", status: "completed", conclusion: "failure", path: "dynamic/pages/pages-build-deployment" };
  assert.equal(triggerDecision({ runs: [DONE], commits: WAITING, bundle: BUNDLE, mainRuns: [pagesFailed], mainStatus: {} }).code, "HOLD_MAIN_RED");
  const building = { ...pagesFailed, status: "in_progress", conclusion: null };
  assert.equal(triggerDecision({ runs: [DONE], commits: WAITING, bundle: BUNDLE, mainRuns: [building], mainStatus: {} }).code, "HOLD_MAIN_BUILDING");
  // A failed RELEASE on main's head must not block its own retry, and the
  // trigger's own in-progress scheduled run must not block itself.
  const ownRelease = { name: "release", event: "workflow_dispatch", status: "completed", conclusion: "failure", path: ".github/workflows/release.yml" };
  const tagRelease = { ...ownRelease, event: "push" };
  const self = { name: "release-trigger", event: "schedule", status: "in_progress", conclusion: null, path: ".github/workflows/release-trigger.yml" };
  assert.equal(mainState([ownRelease, tagRelease, self], { total_count: 0, state: "pending" }).state, "green");
  assert.equal(mainState([], { total_count: 1, state: "failure" }).state, "red");
  assert.equal(mainState([], { total_count: 1, state: "pending" }).state, "building");
});

test("triggerVerdict carries the watchdog's liveness beside the decision", () => {
  const now = "2026-09-24T12:00:00Z";
  const v = triggerVerdict({ runs: [DONE], commits: WAITING, bundle: BUNDLE, ...GREEN,
    peerWorkflow: ALIVE_PEER, peerRuns: [peerRunAt("2026-09-24T03:23:00Z")], now });
  assert.equal(v.decision.code, "DISPATCH");
  assert.equal(v.ok, false);
  assert.equal(v.gates[0].code, "PEER_SILENT");
});

test("a watchdog that FAILS twice running says so — the one failure its peer cannot see, because they share this module", () => {
  const run = (id, conclusion, event = "schedule", status = "completed") =>
    ({ id, event, status, conclusion, created_at: `2026-09-24T${String(id).padStart(2, "0")}:23:00Z` });
  const current = run(10, null, "schedule", "in_progress");
  assert.equal(selfBrokenVerdict([current, run(9, "failure"), run(8, "success")], 10).gates[0].code, "WATCHDOG_BROKEN");
  assert.equal(selfBrokenVerdict([current, run(9, "success")], "10").ok, true, "one failure is a blip");
  assert.equal(selfBrokenVerdict([current], 10).ok, true, "a first-ever run has no history to be broken against");
  // A person's manual run failing does not make the schedule broken.
  assert.equal(selfBrokenVerdict([current, run(9, "failure", "workflow_dispatch"), run(8, "success")], 10).ok, true);
  // The id arrives from $GITHUB_RUN_ID as a string: it must still exclude the current run.
  const completedCurrent = { ...current, status: "completed", conclusion: "failure" };
  assert.equal(selfBrokenVerdict([completedCurrent, run(9, "success")], "10").ok, true);
  assert.match(renderIssueBody(selfBrokenVerdict([current, run(9, "failure")], 10)), /nothing is checking/);
});

test("the watchdog's issue step runs after a failure too", () => {
  const issueStep = WATCH_WF.slice(WATCH_WF.indexOf("- name: Keep the one issue in step"));
  assert.match(issueStep, /^\s*if: always\(\)/m);
  assert.match(issueStep, /--mode self-broken --runs own-runs\.json \\\s*\n\s*--current "\$GITHUB_RUN_ID"/);
});

/** The `run: |` body of one workflow step, dedented — the text bash runs. */
function runBody(wf, nameFragment) {
  const lines = step(wf, nameFragment).split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*run: \|\s*$/.test(l));
  assert.ok(at >= 0, `step "${nameFragment}" has no run block`);
  const body = [];
  let indent = null;
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === "") { body.push(""); continue; }
    const n = l.length - l.trimStart().length;
    if (indent === null) indent = n;
    if (n < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

test("EXECUTED: an expired summary log (404 after 90 days) does not fail the Fetch step — G2 reads the job conclusions instead", async () => {
  /* The REAL step text, run by bash, with `gh`/`jq`/`git`/`sleep` shimmed.
   * Actions keeps logs 90 days; the runs list and jobs list outlive them. The
   * step once fetched the log fatally, so after a quiet quarter the watchdog
   * went red every hour and then raised WATCHDOG_BROKEN over a log that can
   * never come back. MUTATION: drop the `if !` guard and this test fails at
   * the execFileSync, with gh's 404 as the reason. */
  const posix = (p) => p.replaceAll("\\", "/");
  const script = runBody(WATCH_WF, "Fetch the release history")
    .replaceAll("tools/release/watch-release.mjs", JSON.stringify(posix(path.join(HERE, "watch-release.mjs"))));
  /* Under the repo, not os.tmpdir(): /tmp is noexec in some sandboxes, and the
   * shims must execute (the same call publish-digest.test.mjs made). */
  const scratch = fs.mkdtempSync(path.join(ROOT, ".scratch-release-watch-"));
  try {
    const bin = path.join(scratch, "bin");
    const work = path.join(scratch, "work");
    const fx = path.join(scratch, "fx");
    for (const d of [bin, work, fx]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(fx, "runs.json"), JSON.stringify({ workflow_runs: RUNS }));
    fs.writeFileSync(path.join(fx, "jobs.json"), JSON.stringify({ jobs: JOBS_0906 }));
    const shim = (name, body) => fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
    // gh: everything the step asks for, except the log — which is gone. `gh api`
    // prints the error BODY to stdout on a 4xx, so the step must not keep it.
    shim("gh", [
      "#!/bin/bash",
      '[ "$1" = "api" ] || { echo "mock gh: $*" >&2; exit 2; }',
      `echo "$2" >> "${posix(fx)}/calls.txt"`,
      'case "$2" in',
      `  */actions/jobs/*/logs) echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;`,
      `  */workflows/release.yml/runs*) cat "${posix(fx)}/runs.json" ;;`,
      `  */actions/runs/*/jobs) cat "${posix(fx)}/jobs.json" ;;`,
      `  */workflows/release-trigger.yml/runs*) echo '{"workflow_runs":[]}' ;;`,
      `  */workflows/release-trigger.yml) echo '{"state":"active"}' ;;`,
      '  *) echo "mock gh: unexpected endpoint $2" >&2; exit 2 ;;',
      "esac",
      "",
    ].join("\n"));
    // jq: exactly the one filter the step uses; anything else fails loudly.
    shim("jq", [
      "#!/usr/bin/env node",
      "const [flag, filter, file] = process.argv.slice(2);",
      'if (flag !== "-r" || !filter.includes(\'select(.name == "summary" and .conclusion != "skipped") | .id\')) {',
      '  console.error("jq shim: unexpected invocation " + process.argv.slice(2).join(" ")); process.exit(2);',
      "}",
      'for (const j of JSON.parse(require("fs").readFileSync(file, "utf8")).jobs) {',
      '  if (j.name === "summary" && j.conclusion !== "skipped") console.log(j.id);',
      "}",
      "",
    ].join("\n"));
    shim("git", "#!/bin/bash\nexit 0\n");
    shim("sleep", "#!/bin/bash\nexit 0\n");
    const scriptPath = path.join(work, "fetch-step.sh");
    fs.writeFileSync(scriptPath, script);
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, REPO: "JW-Incorporated/foray" };
    const out = execFileSync("bash", [scriptPath], { cwd: work, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const calls = fs.readFileSync(path.join(fx, "calls.txt"), "utf8");
    assert.ok(calls.includes("/actions/jobs/101513086385/logs"), `the step never asked for the summary log:\n${calls}`);
    assert.match(out, /::warning::.*summary job's log/);
    assert.equal(fs.readFileSync(path.join(work, "summary.log"), "utf8"), "",
      "the 404 body gh printed must not be left in summary.log as if it were the log");
    for (const f of ["runs.json", "jobs.json", "peer-workflow.json", "peer-runs.json"]) {
      assert.ok(fs.existsSync(path.join(work, f)), `the step stopped before writing ${f}`);
    }
    // …and the Judge step, given exactly those files, still reaches a G2 reading.
    const W = (f) => path.join(work, f);
    const res = await run(["--mode", "watch", "--now", "2026-09-24T00:00:00Z", "--runs", W("runs.json"),
      "--jobs", W("jobs.json"), "--summary-log", W("summary.log"), "--commits", W("commits.txt"),
      "--peer-workflow", W("peer-workflow.json"), "--peer-runs", W("peer-runs.json"),
      "--verdict-out", W("verdict.json")], {});
    assert.equal(res.code, 0, res.text);
    const g2 = JSON.parse(fs.readFileSync(W("verdict.json"), "utf8")).gates.find((g) => g.id === "G2");
    assert.equal(g2.facts.source, "jobs", "with no log, G2 must still read the store jobs");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

/* ═════════════════════════════════ the issue ═════════════════════════════ */

const RED = { mode: "watch", ok: false, gates: [{ id: "G1", ok: false, code: "RELEASE_FAILED", message: "Release run #23 ended `failure`.", facts: { run: 1 } }] };
const ALL_GREEN = { mode: "watch", ok: true, gates: [{ id: "G1", ok: true, code: "LATEST_RELEASE_OK", message: "", facts: {} }] };
const issue = (n, state, body, extra = {}) => ({ number: n, state, body, ...extra });

test("issue: red with no sticky issue creates one; closed reopens it; open and changed edits it; unchanged does nothing", () => {
  assert.equal(planIssue({ issues: [], verdict: RED, mayClose: true }).action, "create");
  assert.equal(planIssue({ issues: [], verdict: RED, mayClose: true }).title, ISSUE_TITLE);
  assert.deepEqual(planIssue({ issues: [issue(7, "closed", ISSUE_MARKER)], verdict: RED, mayClose: true }).action, "reopen");
  assert.equal(planIssue({ issues: [issue(7, "open", `${ISSUE_MARKER}\nold`)], verdict: RED, mayClose: true }).action, "edit");
  // An edit sends no notification, but an hourly rewrite is noise in the history;
  // and a CRLF round-trip through the API must not count as a change.
  const same = renderIssueBody(RED).replace(/\n/g, "\r\n");
  assert.equal(planIssue({ issues: [issue(7, "open", same)], verdict: RED, mayClose: true }).action, "none");
});

test("issue: green closes the sticky issue only for a job allowed to — the trigger never calls the gates green", () => {
  const open = [issue(7, "open", ISSUE_MARKER)];
  const closing = planIssue({ issues: open, verdict: ALL_GREEN, mayClose: true });
  assert.equal(closing.action, "close");
  assert.match(closing.comment, /reopens itself/);
  assert.equal(planIssue({ issues: open, verdict: ALL_GREEN, mayClose: false }).action, "none");
  assert.equal(planIssue({ issues: [issue(7, "closed", ISSUE_MARKER)], verdict: ALL_GREEN, mayClose: true }).action, "none");
});

test("issue: ONE sticky issue — found by marker, oldest wins, pull requests and unmarked issues ignored", () => {
  const issues = [
    issue(40, "open", `${ISSUE_MARKER} a later duplicate`),
    issue(12, "closed", `${ISSUE_MARKER} the original`),
    issue(5, "open", `${ISSUE_MARKER}`, { pull_request: { url: "x" } }),
    issue(3, "open", "Release watchdog: the app stores need attention, but no marker"),
  ];
  const plan = planIssue({ issues, verdict: RED, mayClose: true });
  assert.equal(plan.action, "reopen");
  assert.equal(plan.number, 12);
});

test("the issue body says what to do, and never tells anyone to re-run", () => {
  const body = renderIssueBody(RED);
  assert.ok(body.startsWith(ISSUE_MARKER));
  assert.match(body, /gh workflow run release\.yml --ref main -f bump=none/);
  assert.match(body, /Never "Re-run failed jobs"/);
  assert.doesNotMatch(body.replace(/Never "Re-run failed jobs"/, ""), /re-?run/i);
});

/* ═══════════════════════════════════ the CLI ═════════════════════════════ */

test("CLI: last-success and latest-completed name the right run from the API's own shape", async () => {
  const runs = FIX("release-runs-2026-09-23.json");
  assert.deepEqual(await run(["--mode", "last-success", "--runs", runs], {}), { code: 0, text: "a5f90c124098086fc2358d67c0e72045c3d33f65\n" });
  assert.deepEqual(await run(["--mode", "latest-completed", "--runs", runs], {}), { code: 0, text: "35813248277\n" });
  assert.equal((await run(["--mode", "nope"], {})).code, 2);
});

test("CLI: watch evaluates from files, writes its verdict, and exits 0 on a RED verdict; unreadable input is exit 1", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-release-test-"));
  try {
    const write = (name, value) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value));
      return p;
    };
    const args = [
      "--mode", "watch", "--now", "2026-09-22T16:00:00Z",
      "--runs", write("runs.json", { workflow_runs: asOf("2026-09-22T16:00:00Z").runs }),
      "--summary-log", FIX("summary-job-35672098914.txt"),
      "--commits", write("commits.txt", GIT_LOG),
      "--peer-workflow", write("wf.json", ALIVE_PEER),
      "--peer-runs", write("peer.json", { workflow_runs: [peerRunAt("2026-09-22T15:47:00Z")] }),
      "--plan", write("plan.json", [...BUNDLE]),
      "--verdict-out", path.join(dir, "verdict.json"),
    ];
    const res = await run(args, {});
    assert.equal(res.code, 0, "a red verdict is reported through the issue, not the exit code");
    const verdict = JSON.parse(fs.readFileSync(path.join(dir, "verdict.json"), "utf8"));
    assert.equal(verdict.ok, false);
    assert.match(res.text, /RED — release watch/);

    const issueRes = await run(["--mode", "issue", "--verdict", path.join(dir, "verdict.json"),
      "--issues", write("issues.json", []), "--may-close",
      "--action-out", path.join(dir, "action.json"), "--body-out", path.join(dir, "body.md")], {});
    assert.equal(issueRes.plan.action, "create");
    assert.ok(fs.readFileSync(path.join(dir, "body.md"), "utf8").startsWith(ISSUE_MARKER));

    const broken = await run(["--mode", "watch", "--runs", path.join(dir, "missing.json")], {});
    assert.equal(broken.code, 1, "'I could not tell' must not be spelled like a verdict");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ════════════════════════ the two workflows' promises ════════════════════ */


test("NEITHER workflow ever re-runs a release — MUTATION: `gh run rerun` reuses the build number Apple already has", () => {
  for (const [name, wf] of [["release-watch", WATCH_WF], ["release-trigger", TRIGGER_WF]]) {
    assert.doesNotMatch(code(wf), /\brerun\b|\/rerun|rerun-failed-jobs/, `${name} must dispatch fresh, never re-run`);
  }
  assert.match(code(TRIGGER_WF), /gh workflow run release\.yml --repo "\$REPO" --ref main -f bump=none/);
  assert.match(code(TRIGGER_WF), /if: steps\.decide\.outputs\.dispatch == 'true'/);
});

test("the watchdog is read-only apart from the alarm; only the trigger may dispatch", () => {
  const watchPerms = block(WATCH_WF, "permissions");
  assert.match(watchPerms, /contents: read/);
  assert.match(watchPerms, /actions: read/);
  assert.match(watchPerms, /issues: write/);
  assert.doesNotMatch(watchPerms, /(contents|actions|pull-requests): write/);
  assert.doesNotMatch(code(WATCH_WF), /gh workflow run/);
  assert.match(block(TRIGGER_WF, "permissions"), /actions: write/);
  assert.doesNotMatch(block(TRIGGER_WF, "permissions"), /contents: write|pull-requests: write/);
});

test("only the watchdog may close the issue — MUTATION: --may-close on the trigger lets a liveness-only job call G1-G4 green", () => {
  // And only from a real verdict: the broken-watchdog branch must not close either.
  assert.match(code(WATCH_WF), /if \[ -s verdict\.json \]; then\s*\n\s*VERDICT=verdict\.json; MAY_CLOSE=--may-close\s*\n\s*else/);
  assert.match(code(WATCH_WF), /VERDICT=self\.json; MAY_CLOSE=[ \t]*\n/);
  assert.match(code(WATCH_WF), /--mode issue --verdict "\$VERDICT" \\\s*\n\s*--issues issues\.json \$MAY_CLOSE/);
  assert.doesNotMatch(code(TRIGGER_WF), /--may-close/);
  assert.doesNotMatch(code(TRIGGER_WF), /gh issue close/);
});

test("both workflows run on a schedule, each in its OWN concurrency group, and walk git in parseGitLog's format", () => {
  /* ci-release-9: a shared group kept one running and ONE pending run between
     the two workflows and cancelled the older pending one, so a watchdog or
     trigger run could vanish. MUTATION: put both back in `release-alarm`. */
  const groups = [WATCH_WF, TRIGGER_WF].map((wf) => (block(wf, "concurrency") ?? "").match(/group: (\S+)/)?.[1]);
  assert.deepEqual(groups, ["release-watch", "release-trigger"]);
  for (const wf of [WATCH_WF, TRIGGER_WF]) {
    assert.match(block(wf, "on"), /schedule:\s*\n\s*- cron: "[^"]+"/);
    assert.match(block(wf, "concurrency"), /cancel-in-progress: false/);
    assert.match(wf, /fetch-depth: 0/, "G3 needs the full history");
    const formats = [...code(wf).matchAll(/--format='([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(formats, [GIT_LOG_FORMAT]);
  }
  // Each watches the other; the peer names must be the real file names.
  assert.match(code(WATCH_WF), /workflows\/release-trigger\.yml\/runs\?event=schedule&status=success/);
  assert.match(code(TRIGGER_WF), /workflows\/release-watch\.yml\/runs\?event=schedule&status=success/);
  assert.ok(fs.existsSync(path.join(ROOT, ".github/workflows/release-trigger.yml")));
});

/* ══════════════════ ci-release-6: main is judged by its required checks ══════════ */

const CI_RUN_RED = { name: "CI", event: "push", status: "completed", conclusion: "failure", path: ".github/workflows/ci.yml" };
const check = (name, conclusion, status = "completed", started_at = "2026-09-24T10:00:00Z") => ({ name, status, conclusion, started_at });
/* ci.yml's push run on the head: the required checks are judged only when it exists. */
const CI_RAN = [{ name: "CI", event: "push", status: "in_progress", conclusion: null, path: ".github/workflows/ci.yml" }];

test("ci-release-6: an advisory ios-kit failure no longer holds the release", () => {
  /* The measured case: runs 35950411353 and 35900753042 were `failure` with
     only ios-kit red. MUTATION: drop the `/ci.yml` skip in mainState -> the
     whole-run conclusion wins again and this is HOLD_MAIN_RED. */
  const mainChecks = [check("backend", "success"), check("data-and-site", "success"), check("ios-kit", "failure"), check("playwright", "failure")];
  const d = triggerDecision({ runs: [DONE], commits: WAITING, bundle: BUNDLE, mainRuns: [CI_RUN_RED], mainStatus: {}, mainChecks });
  assert.equal(d.code, "DISPATCH", d.reason);
});

test("ci-release-6: a red REQUIRED check still holds it, and names the check", () => {
  const mainChecks = [check("backend", "failure"), check("data-and-site", "success")];
  const d = triggerDecision({ runs: [DONE], commits: WAITING, bundle: BUNDLE, mainRuns: [CI_RUN_RED], mainStatus: {}, mainChecks });
  assert.equal(d.code, "HOLD_MAIN_RED");
  assert.match(d.reason, /backend/);
});

test("ci-release-6: a required check still running, or not reported yet, is building", () => {
  const running = [check("backend", null, "in_progress"), check("data-and-site", "success")];
  assert.equal(mainState(CI_RAN, {}, running).state, "building");
  const missing = [check("backend", "success")];
  const m = mainState(CI_RAN, {}, missing);
  assert.equal(m.state, "building");
  assert.match(m.building.join(), /data-and-site \(not reported yet\)/);
});

test("ci-release-6: the newest run of a required check wins (a green re-run clears an old red)", () => {
  const rerun = [
    check("backend", "failure", "completed", "2026-09-24T10:00:00Z"),
    check("backend", "success", "completed", "2026-09-24T11:00:00Z"),
    check("data-and-site", "success"),
  ];
  assert.equal(mainState(CI_RAN, {}, rerun).state, "green");
});

test("ci-release-6: without check runs (an older caller), ci.yml is still read as a whole run — stricter, never looser", () => {
  assert.equal(mainState([CI_RUN_RED], {}).state, "red");
});

test("ci-release-6: the required list IS pr-triage's REQUIRED_CHECKS, and the trigger fetches the head's check runs", async () => {
  const { REQUIRED_CHECKS } = await import("../ci/pr-triage.mjs");
  const all = REQUIRED_CHECKS.map((n) => check(n, "success"));
  assert.equal(mainState(CI_RAN, {}, all).state, "green");
  assert.equal(mainState(CI_RAN, {}, all.slice(1)).state, "building", "every required check is consulted");
  assert.match(code(TRIGGER_WF), /commits\/\$HEAD_SHA\/check-runs\?per_page=100" main-checks\.json/);
  assert.match(code(TRIGGER_WF), /--main-checks main-checks\.json/);
});

test("ci-release-6: a BOT-MERGED head (no ci.yml run, so no required checks at all) still releases", () => {
  /* Replays f33caadf: merged by the Actions bot with GITHUB_TOKEN, so the push
     triggered no workflow — no CI:push run and an EMPTY check_runs list, only
     Pages. Reading the missing checks as "not reported yet" returned
     HOLD_MAIN_BUILDING on every 2-hourly run until a human merge landed on top.
     MUTATION: drop `&& ciRan` from mainState's byChecks -> HOLD_MAIN_BUILDING. */
  const pages = { name: "pages build and deployment", event: "dynamic", status: "completed", conclusion: "success", path: "dynamic/pages/pages-build-deployment" };
  const d = triggerDecision({ runs: [DONE], commits: WAITING, bundle: BUNDLE, mainRuns: [pages], mainStatus: { state: "success", total_count: 1 }, mainChecks: [] });
  assert.equal(d.code, "DISPATCH", d.reason);
  assert.equal(mainState([pages], {}, []).state, "green");
  // ...and once ci.yml DOES run on the head, a missing required check is building again.
  assert.equal(mainState([...CI_RAN, pages], {}, []).state, "building");
});
