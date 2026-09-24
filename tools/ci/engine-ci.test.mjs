/* tools/ci/engine-ci.mjs — the native engine's CI gates (card NE-06).
 *
 * Pure functions, a fake `git`, fake GitHub responses and a fake clock: no
 * network, no repo history, runnable on the Windows machine this engine is
 * written on. The workflow half (that ci.yml and release.yml CALL these, with
 * the right inputs) is pinned in ci-workflow.test.mjs and
 * tools/mobile/release-workflow.test.mjs.
 *
 * EVERY TEST NAMES THE MUTATION IT KILLS, and each was run by hand against the
 * source before this landed. The theme is one rule: an "I could not tell"
 * answer must never come out as a pass, because every gate here is about to be
 * a required check and GitHub counts a short-circuited one as satisfied.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ENGINE_PREFIXES,
  isEnginePath,
  isSwiftPath,
  classifyChanges,
  changedFiles,
  summaryMarkdown,
  iosGateVerdict,
  pollUntilDone,
  latestActionsRun,
  releaseChecksVerdict,
  RELEASE_REQUIRED_CHECKS,
} from "./engine-ci.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "engine-ci.mjs");

/* ────────────────────────────── classification ────────────────────────────── */

test("the three engine inputs the card names are engine paths", () => {
  /* MUTATION: drop "tools/parity/" from ENGINE_PREFIXES -> a PR that changes
     only the recorder (and so what every fixture will say) short-circuits the
     job that checks the fixtures. */
  for (const f of [
    "player/parity/fixtures/seam-gap/cases.json",
    "player/parity/swift-pending.json",
    "mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Policy/SeamGap.swift",
    "mobile/plugins/foray-audio/foray-engine-core/Package.swift",
    "tools/parity/record.mjs",
  ]) {
    assert.equal(isEnginePath(f), true, `${f} must count as an engine input`);
  }
});

test("a change to the gate itself, or to the job, runs the job", () => {
  /* MUTATION: drop ".github/workflows/ci.yml" from ENGINE_PREFIXES -> the PR
     that edits engine-parity short-circuits engine-parity, so a CI-only change
     is never exercised against real output before it merges. */
  assert.equal(isEnginePath(".github/workflows/ci.yml"), true);
  assert.equal(isEnginePath("tools/ci/engine-ci.mjs"), true);
});

test("content, docs, the web player and the backend are not engine inputs", () => {
  /* MUTATION: match on "includes('parity')" instead of a prefix -> a doc named
     parity-notes.md wakes the job; worse, the prefix form is what keeps
     `player/parity-old/` (a sibling, not the tree) out. */
  for (const f of [
    "data/discover.json",
    "docs/native-engine-plan.md",
    "docs/parity-notes.md",
    "player/seam-gap.js",
    "player/parity-old/x.json",
    "backend/src/index.ts",
    "STATE.md",
  ]) {
    assert.equal(isEnginePath(f), false, `${f} is not an engine input`);
  }
});

test("Swift paths: any .swift, any SwiftPM manifest or lockfile, and what ios-kit reads", () => {
  /* MUTATION: reduce isSwiftPath to `endsWith(".swift")` -> a Package.swift
     dependency bump, a fixture re-record (both parity wrappers read fixtures
     in place) or the mobile lockfile ios-kit installs Preferences from would
     all pass ios-gate without ios-kit. */
  for (const f of [
    "ios/ForayKit/Sources/ForayKit/IntentGrammar.swift",
    "ios/project.yml",
    "mobile/plugins/foray-tts/Package.swift",
    "mobile/plugins/foray-audio/Package.resolved",
    "mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift",
    "some/where/Else.swift",
    "player/parity/manifest.json",
    "tools/parity/gen-constants.mjs",
    "mobile/package-lock.json",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(isSwiftPath(f), true, `${f} must count as a Swift path`);
  }
  for (const f of ["data/catalog.json", "app.js", "player/queue-manager.js", "mobile/ENGINE_DEFAULT.json", "docs/x.swift.md"]) {
    assert.equal(isSwiftPath(f), false, `${f} is not a Swift path`);
  }
});

test("every engine path is a Swift path (ios-kit runs everything engine-parity does)", () => {
  /* MUTATION: build SWIFT_PREFIXES without spreading ENGINE_PREFIXES -> a
     fixture-only PR short-circuits ios-gate while ios-kit's plugin wrapper,
     which reads the same fixtures, goes red on it. */
  for (const p of ENGINE_PREFIXES) assert.equal(isSwiftPath(p + (p.endsWith("/") ? "x" : "")), true, p);
});

test("classifyChanges: an unknown file list is EVERYTHING changed", () => {
  /* MUTATION: return {engine:false, swift:false} for null -> a git failure in
     the engine-paths job short-circuits both required checks green. This is
     the single most important line in the file. */
  const c = classifyChanges(null);
  assert.equal(c.engine, true);
  assert.equal(c.swift, true);
  assert.equal(c.known, false);
});

test("classifyChanges: a content-only change touches neither; a fixture change touches both", () => {
  assert.deepEqual(
    (({ engine, swift, known }) => ({ engine, swift, known }))(classifyChanges(["data/discover.json", "docs/a.md"])),
    { engine: false, swift: false, known: true }
  );
  const f = classifyChanges(["docs/a.md", "player/parity/fixtures/rate/x.json"]);
  assert.equal(f.engine, true);
  assert.equal(f.swift, true);
  assert.deepEqual(f.engineFiles, ["player/parity/fixtures/rate/x.json"]);
  const s = classifyChanges(["mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/X.swift"]);
  assert.equal(s.engine, false, "a plugin Swift change is not an engine-parity input");
  assert.equal(s.swift, true);
});

/* ──────────────────────────── changed files per event ─────────────────────── */

/** A fake git: `answers` maps the joined argv to stdout, or to an Error. */
function fakeGit(answers) {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(" "));
    const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
    if (key === undefined) throw new Error(`unexpected git ${args.join(" ")}`);
    const v = answers[key];
    if (v instanceof Error) throw v;
    return v;
  };
  return { git, calls };
}

test("pull_request: the merge commit's first parent is the base, and renames are split", () => {
  /* MUTATION: drop --no-renames -> a PR that MOVES the fixtures out of
     player/parity/ is listed only under the new name and short-circuits the
     job that reads them. */
  const { git, calls } = fakeGit({
    "rev-list --parents -n 1 HEAD": "m b h\n",
    "diff --name-only --no-renames HEAD^1 HEAD": "player/parity/manifest.json\ndocs/x.md\n",
  });
  assert.deepEqual(changedFiles({ eventName: "pull_request" }, { git }), ["player/parity/manifest.json", "docs/x.md"]);
  assert.ok(calls.some((c) => c.includes("--no-renames")));
});

test("pull_request: HEAD that is not a merge commit is UNKNOWN, not its last commit", () => {
  /* MUTATION: drop the two-parent check -> on a non-merge checkout HEAD^1 is
     the PR's own previous commit, and a ten-commit Swift PR whose last commit
     edits a doc reads as "docs only". */
  const { git } = fakeGit({
    "rev-list --parents -n 1 HEAD": "h p\n",
    "diff --name-only --no-renames HEAD^1 HEAD": "docs/x.md\n",
  });
  assert.equal(changedFiles({ eventName: "pull_request" }, { git }), null);
});

test("push: before..HEAD, after fetching before", () => {
  const { git, calls } = fakeGit({
    "fetch --no-tags --depth=1 origin abc123": "",
    "diff --name-only --no-renames abc123 HEAD": "ios/ForayKit/Package.swift\n",
  });
  assert.deepEqual(changedFiles({ eventName: "push", before: "abc123" }, { git }), ["ios/ForayKit/Package.swift"]);
  assert.equal(calls[0], "fetch --no-tags --depth=1 origin abc123");
});

test("push with no before (a new branch) is UNKNOWN", () => {
  /* MUTATION: diff against an all-zero SHA and treat git's error as "no
     files" -> the first push of a branch short-circuits everything. */
  /* The fake ANSWERS the fetch and the diff, so only the guard can say null. */
  const { git } = fakeGit({ "fetch": "", "diff": "docs/x.md\n" });
  assert.equal(changedFiles({ eventName: "push", before: "0000000000000000000000000000000000000000" }, { git }), null);
  assert.equal(changedFiles({ eventName: "push", before: "" }, { git }), null);
});

test("workflow_dispatch on a PR branch diffs against the default branch's tip", () => {
  const { git, calls } = fakeGit({
    "fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main": "",
    "diff --name-only --no-renames refs/remotes/origin/main HEAD": "mobile/plugins/foray-audio/foray-engine-core/Sources/X.swift\n",
  });
  const files = changedFiles({ eventName: "workflow_dispatch", refName: "engine/ne-06", defaultBranch: "main" }, { git });
  assert.deepEqual(files, ["mobile/plugins/foray-audio/foray-engine-core/Sources/X.swift"]);
  assert.match(calls[0], /refs\/heads\/main:refs\/remotes\/origin\/main/);
});

test("workflow_dispatch ON the default branch is UNKNOWN, so a manual run on main runs everything", () => {
  /* MUTATION: diff main against itself -> empty list -> a founder's manual
     re-run on main short-circuits green, and that green is the NEWEST
     engine-parity check on the SHA release-checks reads. */
  const { git } = fakeGit({ "fetch": "", "diff": "" });
  assert.equal(changedFiles({ eventName: "workflow_dispatch", refName: "main", defaultBranch: "main" }, { git }), null);
  assert.equal(changedFiles({ eventName: "workflow_dispatch", refName: "x", defaultBranch: "" }, { git }), null);
});

test("any git failure, and any other event, is UNKNOWN", () => {
  /* MUTATION: `catch { return [] }` -> a failed fetch reads as "nothing
     changed". */
  const { git } = fakeGit({ "fetch": new Error("shallow fetch refused") });
  assert.equal(changedFiles({ eventName: "push", before: "abc" }, { git }), null);
  assert.equal(changedFiles({ eventName: "merge_group" }, { git: fakeGit({}).git }), null);
  assert.equal(changedFiles({ eventName: "schedule" }, { git: fakeGit({}).git }), null);
});

/* ──────────────────────────────── the summary ─────────────────────────────── */

const REPORT = {
  families: [
    { family: "compare", hasRunner: true, floor: 37, cases: 37, executed: 37, passed: 37, owed: 0, failed: 0 },
    { family: "queue-state", hasRunner: false, floor: 87, cases: 87, executed: 0, passed: 0, owed: 87, failed: 0 },
    { family: "seam-gap", hasRunner: true, floor: 30, cases: 30, executed: 30, passed: 30, owed: 0, failed: 0 },
  ],
  results: [],
  problems: [],
};

test("summary: one row per family, a total, and the books stated", () => {
  /* MUTATION: drop the per-family loop -> the job summary says nothing about
     which families the Swift side actually ran, which is what G-1a's table is
     for. */
  const md = summaryMarkdown(REPORT);
  assert.match(md, /\| compare \| 37 \| 37 \| 37 \| 0 \| 0 \| yes \| 37 \|/);
  assert.match(md, /\| queue-state \| 87 \| 0 \| 0 \| 87 \| 0 \| none yet \| 87 \|/);
  assert.match(md, /\| \*\*total\*\* \| 154 \| 67 \| 67 \| 87 \| 0 \|/);
  assert.match(md, /books balance/);
  assert.doesNotMatch(md, /RED/);
});

test("summary: failures and problems turn the headline red and are listed", () => {
  /* MUTATION: compute the headline from families' `failed` only -> a
     whole-tree problem (a floor not reached, a stray fixture id) reads as a
     balanced book. */
  const md = summaryMarkdown({
    ...REPORT,
    results: [
      { id: "seam-gap.a", family: "seam-gap", outcome: "failed", detail: "expected 2 | got 3" },
      { id: "rate.b", family: "rate", outcome: "stale-pending", detail: "delete the entry" },
      { id: "rate.c", family: "rate", outcome: "pending", detail: "owed by NE-09" },
    ],
    problems: ["family seam-gap executed 1 case(s), below its floor of 30 in floors.json"],
  });
  assert.match(md, /Parity is RED:\*\* 2 failing case\(s\), 1 whole-tree problem/);
  assert.match(md, /`seam-gap.a` \[failed\] expected 2 \\\| got 3/, "a pipe in a detail must not break the table");
  assert.match(md, /`rate.b` \[stale-pending\]/);
  assert.doesNotMatch(md, /rate\.c/, "a pending case is owed, not failing");
  assert.match(md, /below its floor/);
  assert.doesNotMatch(summaryMarkdown({ ...REPORT, problems: ["x"] }), /books balance/);
});

test("summary: a missing report is SAID, never tabulated as zeros", () => {
  /* MUTATION: default a missing report to {families: []} -> a package that
     failed to compile shows an empty table under "books balance". */
  for (const r of [null, undefined, {}, { families: "nope" }]) {
    const md = summaryMarkdown(r);
    assert.match(md, /No parity-report\.json/);
    assert.doesNotMatch(md, /books balance|\| family \|/);
  }
});

test("summary: a long failure list is capped and says how many it left out", () => {
  const results = Array.from({ length: 30 }, (_, i) => ({ id: `f.${i}`, family: "f", outcome: "failed", detail: "x" }));
  const md = summaryMarkdown({ ...REPORT, results }, { maxFailures: 25 });
  assert.match(md, /`f\.24`/);
  assert.doesNotMatch(md, /`f\.25`/);
  assert.match(md, /and 5 more/);
});

test("summary CLI: reads the report file, and a missing file prints the no-report text", () => {
  /* The CLI path the workflow runs, end to end, one node process each. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-ci-"));
  const file = path.join(dir, "parity-report.json");
  fs.writeFileSync(file, JSON.stringify(REPORT));
  const ok = execFileSync(process.execPath, [SCRIPT, "summary", file], { encoding: "utf8" });
  assert.match(ok, /\| seam-gap \| 30 \|/);
  const missing = execFileSync(process.execPath, [SCRIPT, "summary", path.join(dir, "absent.json")], { encoding: "utf8" });
  assert.match(missing, /No parity-report\.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ───────────────────────────────── ios-gate ───────────────────────────────── */

test("ios-gate: no Swift change passes without looking at ios-kit", () => {
  const v = iosGateVerdict({ swiftChanged: false, job: { status: "completed", conclusion: "failure" } });
  assert.equal(v.done, true);
  assert.equal(v.ok, true, "a content PR is never held by an ios-kit flake");
});

test("ios-gate: a Swift change needs ios-kit's success, and nothing else will do", () => {
  /* MUTATION: accept `skipped` (GitHub's own notion of satisfied) -> a Swift
     PR whose ios-kit never ran passes the gate that exists to say it didn't. */
  const job = (conclusion) => ({ status: "completed", conclusion });
  assert.equal(iosGateVerdict({ swiftChanged: true, job: job("success") }).ok, true);
  for (const c of ["failure", "cancelled", "skipped", "timed_out", "neutral", "action_required", null]) {
    const v = iosGateVerdict({ swiftChanged: true, job: job(c) });
    assert.equal(v.done, true, String(c));
    assert.equal(v.ok, false, `ios-kit ${c} must not pass the gate`);
  }
});

test("ios-gate: an in-flight ios-kit is a wait, and a missing one is a failure", () => {
  /* MUTATION: treat a missing job as "no Swift" -> renaming ios-kit in ci.yml
     silently turns the required gate into a no-op. */
  assert.deepEqual(
    (({ done, ok }) => ({ done, ok }))(iosGateVerdict({ swiftChanged: true, job: { status: "in_progress", conclusion: null } })),
    { done: false, ok: false }
  );
  const missing = iosGateVerdict({ swiftChanged: true, job: null });
  assert.equal(missing.done, true);
  assert.equal(missing.ok, false);
});

/** A fake clock whose sleep advances it. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test("pollUntilDone: waits through in-flight answers and returns the first final one", async () => {
  const clock = fakeClock();
  const seq = [{ status: "queued" }, { status: "in_progress" }, { status: "completed", conclusion: "success" }];
  let i = 0;
  const v = await pollUntilDone({
    fetchOnce: async () => seq[Math.min(i++, seq.length - 1)],
    decide: (job) => iosGateVerdict({ swiftChanged: true, job }),
    ...clock,
    timeoutMs: 60_000,
    intervalMs: 10_000,
  });
  assert.equal(v.ok, true);
  assert.equal(i, 3);
});

test("pollUntilDone: a timeout is a refusal carrying the last thing seen", async () => {
  /* MUTATION: return the last verdict's `ok` on timeout, or `ok: true` -> an
     ios-kit stuck in a macOS queue for an hour passes the gate. */
  const clock = fakeClock();
  const v = await pollUntilDone({
    fetchOnce: async () => ({ status: "queued" }),
    decide: (job) => iosGateVerdict({ swiftChanged: true, job }),
    ...clock,
    timeoutMs: 60_000,
    intervalMs: 20_000,
  });
  assert.equal(v.done, true);
  assert.equal(v.ok, false);
  assert.match(v.message, /timed out .* ios-kit is queued/);
});

test("pollUntilDone: an API error is a wait, never a verdict, and times out as a refusal", async () => {
  /* MUTATION: let the fetch error propagate as a pass, or stop polling on the
     first 502 -> one flaky API call decides a release. */
  const clock = fakeClock();
  let calls = 0;
  const v = await pollUntilDone({
    fetchOnce: async () => {
      calls++;
      if (calls < 3) throw new Error("GET x -> 502");
      return { status: "completed", conclusion: "success" };
    },
    decide: (job) => iosGateVerdict({ swiftChanged: true, job }),
    ...clock,
    timeoutMs: 600_000,
    intervalMs: 1_000,
  });
  assert.equal(v.ok, true);
  assert.equal(calls, 3);
  const never = await pollUntilDone({
    fetchOnce: async () => { throw new Error("GET x -> 401"); },
    decide: () => ({ done: true, ok: true, message: "unreachable" }),
    ...fakeClock(),
    timeoutMs: 5_000,
    intervalMs: 1_000,
  });
  assert.equal(never.ok, false);
  assert.match(never.message, /401/);
});

/* ────────────────────────────── release refusal ───────────────────────────── */

const run = (id, name, status, conclusion, slug = "github-actions") => ({ id, name, status, conclusion, app: { slug } });

test("the release requires exactly engine-parity and ios-kit", () => {
  /* MUTATION: drop "ios-kit" from the list -> a TestFlight from a SHA whose
     Simulator tests are red. */
  assert.deepEqual(RELEASE_REQUIRED_CHECKS, ["engine-parity", "ios-kit"]);
});

test("latestActionsRun: newest by id, github-actions only", () => {
  /* MUTATION: take the first run in the list, or accept any app -> a re-run
     that went green is ignored in favour of the old red (or the reverse), and
     a third-party app's `engine-parity` check can wave a release through. */
  const runs = [
    run(10, "engine-parity", "completed", "failure"),
    run(12, "engine-parity", "completed", "success"),
    run(99, "engine-parity", "completed", "success", "some-other-app"),
    { id: 100, name: "engine-parity", status: "completed", conclusion: "success" },
    run(11, "ios-kit", "completed", "failure"),
  ];
  assert.equal(latestActionsRun(runs, "engine-parity").id, 12);
  assert.equal(latestActionsRun(runs, "ios-kit").id, 11);
  assert.equal(latestActionsRun(runs, "ios-gate"), null);
  assert.equal(latestActionsRun(undefined, "ios-kit"), null);
});

test("release-checks: both green ships", () => {
  const v = releaseChecksVerdict({
    "engine-parity": run(1, "engine-parity", "completed", "success"),
    "ios-kit": run(2, "ios-kit", "completed", "success"),
  });
  assert.deepEqual([v.done, v.ok], [true, true]);
});

test("release-checks: red parity refuses, whatever ios-kit says", () => {
  /* MUTATION: `ok = runs.some(success)` -> green ios-kit carries red parity
     onto the founder's phone. The acceptance line is exactly this case. */
  for (const c of ["failure", "cancelled", "skipped", "timed_out", "neutral"]) {
    const v = releaseChecksVerdict({
      "engine-parity": run(1, "engine-parity", "completed", c),
      "ios-kit": run(2, "ios-kit", "completed", "success"),
    });
    assert.deepEqual([v.done, v.ok], [true, false], `engine-parity ${c}`);
    assert.match(v.message, new RegExp(`engine-parity: ${c}`));
  }
  const iosRed = releaseChecksVerdict({
    "engine-parity": run(1, "engine-parity", "completed", "success"),
    "ios-kit": run(2, "ios-kit", "completed", "failure"),
  });
  assert.deepEqual([iosRed.done, iosRed.ok], [true, false]);
});

test("release-checks: in flight waits; red beats in flight; missing waits, then refuses", () => {
  /* MUTATION: drop `missingIsFinal` -> a SHA ci.yml never ran on (a tag on a
     commit from before NE-06) waits the full timeout instead of the grace;
     treat missing as success -> the same SHA ships. */
  const flying = releaseChecksVerdict({
    "engine-parity": run(1, "engine-parity", "in_progress", null),
    "ios-kit": run(2, "ios-kit", "completed", "success"),
  });
  assert.deepEqual([flying.done, flying.ok], [false, false]);
  const redAndFlying = releaseChecksVerdict({
    "engine-parity": run(1, "engine-parity", "completed", "failure"),
    "ios-kit": run(2, "ios-kit", "queued", null),
  });
  assert.deepEqual([redAndFlying.done, redAndFlying.ok], [true, false], "no point waiting on ios-kit once parity is red");
  const missing = { "engine-parity": null, "ios-kit": run(2, "ios-kit", "completed", "success") };
  assert.deepEqual((({ done, ok }) => [done, ok])(releaseChecksVerdict(missing)), [false, false]);
  assert.deepEqual((({ done, ok }) => [done, ok])(releaseChecksVerdict(missing, { missingIsFinal: true })), [true, false]);
});

test("CLI: release-checks refuses a malformed SHA before touching the network", () => {
  /* The SHA arrives from github.sha through env:, but the script is also the
     founder's dry-run tool; a typo must not become an API path. MUTATION:
     delete the SHA check -> the request goes to the (unreachable) API, times
     out at once, and exits 1 rather than 2. */
  let status = 0;
  try {
    execFileSync(process.execPath, [SCRIPT, "release-checks", "main; rm -rf /"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_TOKEN: "x",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_API_URL: "http://127.0.0.1:9",
        RELEASE_CHECKS_TIMEOUT_MIN: "0",
      },
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    status = e.status;
  }
  assert.equal(status, 2);
});

test("CLI: release-checks against an unreachable API refuses (exit 1) at the timeout, never passes", () => {
  /* MUTATION: `minutes()` falling back to the default on "0" -> this test
     waits 40 minutes (and dies at its 30 s cap); any pass-on-error -> exit 0. */
  let status = 0;
  let stdout = "";
  try {
    execFileSync(process.execPath, [SCRIPT, "release-checks", "a".repeat(40)], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_TOKEN: "x", GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "http://127.0.0.1:9", RELEASE_CHECKS_TIMEOUT_MIN: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (e) {
    status = e.status;
    stdout = String(e.stdout);
  }
  assert.equal(status, 1);
  assert.match(stdout, /::error::release-checks: refusing to cut an iOS TestFlight/);
});

test("CLI: ios-gate with SWIFT_CHANGED=false passes with no token and no network", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "ios-gate"], {
    encoding: "utf8",
    env: { ...process.env, SWIFT_CHANGED: "false", GITHUB_TOKEN: "" },
  });
  assert.match(out, /ios-gate: PASS — no Swift path changed/);
});

test("CLI: ios-gate with SWIFT_CHANGED empty (engine-paths failed) is NOT a skip", () => {
  /* MUTATION: `swiftChanged = env.SWIFT_CHANGED === "true"` -> a failed
     engine-paths job reads as "no Swift" and the required gate goes green.
     With no token the only honest outcome is a failure. */
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [SCRIPT, "ios-gate"], {
      encoding: "utf8",
      env: { ...process.env, SWIFT_CHANGED: "", GITHUB_TOKEN: "", GH_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    status = e.status;
    stderr = String(e.stderr);
  }
  assert.equal(status, 1);
  assert.match(stderr, /GITHUB_TOKEN is not set/);
});
