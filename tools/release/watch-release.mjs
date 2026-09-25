#!/usr/bin/env node
/* The release watchdog and the release trigger — pieces 2 and 3 of
 * docs/release-reliability-plan.md. Read that plan's §1 and §3 first; this
 * header only carries what a reader of THIS file needs.
 *
 * FOUNDER, 2026-09-22: "the goal here is some lightweight script that doesn't
 * require agent involvement unless something is fucked."
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 *
 * Three defects, and piece 1 (tools/release/upload-retry.mjs, PR #737) fixed
 * only the second:
 *   D1  nothing triggers a release — 24 of 24 runs were typed by a person, and
 *       merged fixes sat unreleased for sixteen hours on 2026-09-22;
 *   D2  nothing retried an upload (fixed, #737);
 *   D3  nothing noticed. A failed release was found by the founder using the
 *       app, and "the run goes red" is demonstrably not a channel here:
 *       nightly-refresh and nightly-watch had both been red for over a week
 *       when this was written, and nobody had seen either.
 *
 * So this file does two jobs, from two workflows, and they watch each other:
 *
 *   --mode watch    (.github/workflows/release-watch.yml, hourly)
 *                   Five gates, G1-G4 from the plan plus the liveness of the
 *                   trigger. Its red goes to ONE sticky GitHub issue — opening
 *                   or reopening an issue notifies the founder; a red run does
 *                   not — and the issue closes itself when every gate is green.
 *
 *   --mode trigger  (.github/workflows/release-trigger.yml, every 2 hours)
 *                   Dispatches a FRESH release.yml run when a release-relevant
 *                   commit is on main and not in the last successful release,
 *                   nothing is already in flight, main is not red, and the
 *                   last failures have not used up the retry budget.
 *
 *   --mode issue    turns a verdict and the repo's issue list into ONE action
 *                   (create / reopen / edit / close / none) for the shell.
 *
 *   --mode self-broken    after the watchdog's OWN run failed: is this the
 *                   second failure in a row? (selfBrokenVerdict says why.)
 *
 *   --mode last-success   prints the head_sha of the newest successful release,
 *                   so the workflows can `git log <it>..origin/main` without a
 *                   second copy of "which run counts as a success" in YAML.
 *
 * ── THE ONE RULE THE TRIGGER MUST NEVER BREAK: DISPATCH, NEVER RE-RUN ───────
 *
 * release.yml's `version` job derives the build number from the workflow's
 * lifetime `run_number`. "Re-run failed jobs" does not even re-execute that job
 * — it reuses its cached outputs — so a re-run uploads the SAME build number,
 * and App Store Connect refuses a binary it already has (the plan's "BUILD
 * NUMBER COLLIDES ON A RE-RUN" section). A fresh `workflow_dispatch` gets a new
 * `run_number`, therefore a new build number, and rebuilds BOTH stores from one
 * commit — which is also what re-converges two stores that diverged. So the
 * trigger only ever dispatches, and watch-release.test.mjs pins that no
 * workflow here says `rerun`.
 *
 * ── WHY THE TWO WORKFLOWS WATCH EACH OTHER ──────────────────────────────────
 *
 * HUMAN-ACTIONS #46 is a scheduled watchdog that silently stopped firing. A
 * watchdog cannot report its own death, so each of these two checks the other:
 * the workflow's `state` (a disabled workflow is exactly the banner #46 asked
 * the founder to look for) and the age of its newest SUCCESSFUL scheduled run.
 * Both jobs exit 0 whenever they managed to evaluate and report — the issue
 * carries the verdict, the run colour carries only "did the watcher itself
 * work" — so "no recent success" means "not watching", never "found a problem".
 * If BOTH die, or Actions itself is off for the org, nothing in GitHub can
 * say so; that limit is stated in the plan rather than papered over.
 *
 * ── NO NETWORK, NO DEPENDENCIES ──────────────────────────────────────────────
 *
 * Same posture as tools/refresh/watch-nightly.mjs, which this is modelled on:
 * every input is a file the workflow fetched with `gh`, so every verdict is a
 * pure function of fixtures and can be shown to fire without waiting a day for
 * it to. The one import outside node: is prepare-webdir.mjs's own bundle plan,
 * loaded lazily by the CLI, because "which files reach a store build" has an
 * executable answer and a hand-kept copy of it would drift.
 *
 * EXPOSURE: `tools/release/` is on DENIED_PREFIXES (tools/ci/path-policy.mjs).
 * This file decides when macOS minutes are spent and whether an alarm is
 * raised, and upload-retry.mjs beside it runs in a step holding the App Store
 * Connect key; neither may land unread.
 *
 * USAGE (the workflows are the real callers — read them for the fetches)
 *   node tools/release/watch-release.mjs --mode last-success --runs runs.json
 *   node tools/release/watch-release.mjs --mode latest-completed --runs runs.json
 *   node tools/release/watch-release.mjs --mode watch --runs runs.json \
 *        --jobs jobs.json --summary-log summary.log --commits commits.txt \
 *        --peer-workflow trigger-workflow.json --peer-runs trigger-runs.json \
 *        --verdict-out verdict.json
 *   node tools/release/watch-release.mjs --mode trigger --runs runs.json \
 *        --commits commits.txt --main-runs main-runs.json --main-status status.json \
 *        --main-checks check-runs.json \
 *        --peer-workflow watch-workflow.json --peer-runs watch-runs.json \
 *        --verdict-out verdict.json
 *   node tools/release/watch-release.mjs --mode issue --verdict verdict.json \
 *        --issues issues.json [--may-close] --action-out action.json --body-out body.md
 *   node tools/release/watch-release.mjs --mode self-broken --runs own-runs.json \
 *        --current "$GITHUB_RUN_ID" --verdict-out self.json
 *   Common: --now <ISO> (tests), --plan <json array of bundle paths> (tests).
 *   Exit 0 when it evaluated (whatever it found), 1 when it could not read its
 *   inputs, 2 on a bad --mode, 3 when `last-success` / `latest-completed` has
 *   no run to name.
 */

import fs from "node:fs";
import process from "node:process";
/* protect-main's required contexts. ONE list, owned by the merge machinery: the
 * release trigger must call main "red" for exactly the checks that can block a
 * merge, and no others (ci-release-6). */
import { REQUIRED_CHECKS } from "../ci/pr-triage.mjs";

/* ─────────────────────────── the numbers, and why ────────────────────────── */

/** G1/G2 grace. A release takes 4-19 minutes (measured, runs 20-25), so an hour
 *  after a failed run finished is not "still settling"; it is long enough that a
 *  person watching the Actions tab would already have seen it, and short enough
 *  that the founder hears about it the same evening rather than the next day. */
export const GRACE_MINUTES = 60;

/** G3. The trigger runs every 2 hours (founder, 2026-09-23; it was 3) and GitHub's
 *  cron has been measured 85 minutes late on this repo (nightly-watch.yml's header).
 *  A commit that lands just after a trigger slot waits up to ~3.5h for the next one
 *  and ships ~25 minutes later: a healthy worst case of roughly four hours. Six is
 *  that plus a generous margin, and still the same working day — the plan's number,
 *  kept, since a looser stall bar only ever pages later, never falsely. */
export const STALL_HOURS = 6;

/** G4. The slowest healthy run measured took 19 minutes; an hour is three times
 *  that. A run still going at that point is hung, or queued behind one that is. */
export const STUCK_MINUTES = 60;

/** Liveness. NOMINALLY the watchdog runs hourly and the trigger every two hours,
 *  and the first cut set each threshold to the interval plus the 85-minute drift
 *  nightly-watch had measured (3 h and 4 h). MEASURED ON THIS REPO'S FIRST DAY
 *  (2026-09-23) that was wrong: GitHub skipped most slots of both new schedules.
 *  release-watch ran at 15:05 and 19:06Z (hourly cron, ~4 h apart); release-trigger
 *  at 15:11 and 19:49Z (2-hourly cron, 4.6 h apart), and its FIRST scheduled run
 *  came ~5 h after the workflow landed. At 3 h / 4 h the watchdog therefore
 *  paged on its very first run (issue #745, PEER_SILENT for a trigger that simply
 *  had not been scheduled yet) and would have kept flapping - and this repo's
 *  rule is that a flaky alarm is worse than none. 8 h for both covers the
 *  measured gaps with margin and still reports a genuinely dead peer inside a
 *  working day. If the measured gaps grow, raise these with the new numbers
 *  written here, never by feel. */
export const WATCHDOG_STALE_HOURS = 8;
export const TRIGGER_STALE_HOURS = 8;

/** After this many consecutive failed release runs the trigger stops
 *  dispatching. One automatic retry of a failure is cheap insurance against a
 *  transient store outage; a second failure in a row is a pattern, the issue is
 *  already open by then, and every further automatic attempt is 10x-billed macOS
 *  time spent proving the same thing. A human dispatch that succeeds resets it. */
export const RETRY_BUDGET = 2;

/** How the sticky issue is found again. The title is for people; the marker is
 *  for this code, because a title a person edits must not orphan the alarm. */
export const ISSUE_MARKER = "<!-- release-watch:sticky -->";
export const ISSUE_TITLE = "Release watchdog: the app stores need attention";

/* ─────────────────── which commits need a release: an ALLOW-list ─────────── */

/* WHY AN ALLOW-LIST, when tools/web/vercel-should-build.mjs is a deny-list.
 * The failure modes swap. There, allow-list drift silently stops DEPLOYING a
 * file that started mattering — a production 404. Here allow-list drift silently
 * stops NAGGING, which is the status quo and harmless, while deny-list drift
 * produced a false alarm on nearly every PR, because the manifest-autofix bot
 * rewrote deploy-manifest.json, sw.js and data/forays-directory.json on most of
 * them (until issue #701 made those deploy build outputs). A flaky alarm is worse
 * than none (nightly-watch.yml).
 *
 * The web half of the list is prepare-webdir.mjs's own plan, which is the
 * executable definition of "what is in the bundle". The native half never passes
 * through `www/`, so it is named here — exactly the plan's list. */
export const NATIVE_INPUT_PREFIXES = [
  "mobile/",
  ".github/actions/ios-archive/",
  ".github/actions/android-bundle/",
];
export const NATIVE_INPUT_FILES = [
  ".github/workflows/release.yml",
  "tools/mobile/prepare-webdir.mjs",
  "tools/mobile/minify.mjs",
  "tools/mobile/fetch-models.mjs",
  "tools/mobile/ios-embedded-frameworks.mjs",
];
const INJECT_SCRIPT = /^tools\/mobile\/inject-[^/]+\.mjs$/;

function isTestOrDoc(file) {
  return /\.test\.[cm]?[jt]sx?$/.test(file) || /\.md$/i.test(file);
}

/** "release", "seed" or null for one repo-relative path.
 *
 *  `data/` is its own tier and never a release trigger. The app fetches the Foray
 *  directory live from the site at boot (prepare-webdir.mjs, FD-04), so data
 *  changes reach phones WITHOUT a release, and nightly-refresh commits
 *  `data/discover.json` every day — treating it as a trigger would ship a build a
 *  day for nothing. A bundled data file that changed is reported as "the seed is
 *  stale", for information. */
export function releaseTier(file, bundle) {
  if (typeof file !== "string" || file === "" || isTestOrDoc(file)) return null;
  const inBundle = bundle instanceof Set && bundle.has(file);
  if (file.startsWith("data/")) return inBundle ? "seed" : null;
  if (inBundle) return "release";
  if (NATIVE_INPUT_FILES.includes(file)) return "release";
  if (NATIVE_INPUT_PREFIXES.some((p) => file.startsWith(p))) return "release";
  if (INJECT_SCRIPT.test(file)) return "release";
  return null;
}

/** The bundle as a Set of repo paths: prepare-webdir's copy plan plus the
 *  shell-only sources it copies under another name. */
export function bundleSet(plan, shellOnly = []) {
  const out = new Set(Array.isArray(plan) ? plan : []);
  for (const f of Array.isArray(shellOnly) ? shellOnly : []) {
    if (f && typeof f.src === "string") out.add(f.src);
  }
  return out;
}

/* ─────────────────────────────── git log input ───────────────────────────── */

/** The format the workflows pass to `git log`. A record separator (0x1e) opens
 *  each commit, so no file name or subject can be mistaken for a header. */
export const GIT_LOG_FORMAT = "%x1e%H %cI %s";

/** `git log --first-parent --diff-merges=first-parent --no-renames --name-only
 *  --format=<GIT_LOG_FORMAT> <last-success>..origin/main` -> commits, newest
 *  first (git's order).
 *
 *  WHY git log AND NOT THE COMPARE API the plan names. `GET /compare` caps at 250
 *  commits and 300 files, and its `files[]` is the AGGREGATE diff, so it cannot
 *  say which commit touched what — and "the OLDEST release-relevant commit" needs
 *  exactly that. The workflow already has a full-history checkout; git has no cap
 *  and no rate limit. `--first-parent` + `--diff-merges=first-parent` makes a
 *  merge commit count once, as the change it brought to main, dated when it
 *  landed; `--no-renames` makes a moved file show under both of its names. */
export function parseGitLog(text) {
  if (typeof text !== "string") return [];
  const commits = [];
  for (const record of text.split("\x1e")) {
    const lines = record.split(/\r?\n/);
    const head = lines.shift();
    const m = /^([0-9a-f]{7,40}) (\S+)(?: (.*))?$/.exec(head || "");
    if (!m) continue;
    const files = lines.map((l) => l.trim()).filter(Boolean);
    commits.push({ sha: m[1], committedAt: m[2], subject: m[3] || "", files });
  }
  return commits;
}

/** What is waiting to ship, split into the two tiers. `oldest` is the
 *  release-relevant commit that has waited longest — G3's clock. */
export function pendingWork(commits, bundle) {
  const release = [];
  const seed = [];
  for (const c of Array.isArray(commits) ? commits : []) {
    const tiers = new Map();
    for (const f of c.files || []) {
      const tier = releaseTier(f, bundle);
      if (tier) tiers.set(f, tier);
    }
    const releaseFiles = [...tiers].filter(([, t]) => t === "release").map(([f]) => f);
    const seedFiles = [...tiers].filter(([, t]) => t === "seed").map(([f]) => f);
    if (releaseFiles.length) release.push({ ...c, files: releaseFiles });
    else if (seedFiles.length) seed.push({ ...c, files: seedFiles });
  }
  let oldest = null;
  for (const c of release) {
    if (!oldest || ms(c.committedAt) < ms(oldest.committedAt)) oldest = c;
  }
  return { release, seed, oldest };
}

/* ─────────────────────────────── runs and time ───────────────────────────── */

function ms(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : NaN;
}

function minutesBetween(fromIso, nowIso) {
  return (ms(nowIso) - ms(fromIso)) / 60000;
}

/** The API's `workflow_runs`, newest first, whatever order they arrived in. */
function sortRuns(runs) {
  const list = Array.isArray(runs) ? runs.filter((r) => r && typeof r === "object") : [];
  return [...list].sort((a, b) => ms(b.created_at) - ms(a.created_at));
}

const isCompleted = (r) => r.status === "completed";
const isSuccess = (r) => isCompleted(r) && r.conclusion === "success";
const IN_FLIGHT = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const isInFlight = (r) => IN_FLIGHT.has(r.status);

/** The newest release run that SUCCEEDED — the commit the stores last received.
 *
 *  No branch filter, deliberately: a tag-triggered run's `head_branch` is the
 *  tag, and it is still a release of a commit on main (release.yml's guard job
 *  refuses a tag that is not). A run the guard REFUSED exits 1, so it can never
 *  be mistaken for a success here. */
export function lastSuccess(runs) {
  return sortRuns(runs).find(isSuccess) || null;
}

/** Completed runs since the last success that did not succeed, newest first. */
export function failuresSinceSuccess(runs) {
  const out = [];
  for (const r of sortRuns(runs)) {
    if (!isCompleted(r)) continue;
    if (r.conclusion === "success") break;
    out.push(r);
  }
  return out;
}

/* ─────────────────────── the summary job's outcome line ──────────────────── */

/** Per-store outcome of one run, from the `summary` job's log, or null.
 *
 *  WHY THE LOG. REST cannot see a composite action's outputs or a step summary
 *  (verified while writing the plan), and "the ios JOB is green" does not mean
 *  "TestFlight got the build" — a job is also green when its credentials were
 *  absent and it skipped the upload on purpose. release.yml's summary step
 *  prints one `RELEASE_OUTCOME` line for exactly this reader. Runs from before
 *  that line existed still carry the same four values in the runner's own echo
 *  of the step's `env:` block, which is the fallback; a run with neither falls
 *  back again, to job conclusions, in divergentGate(). */
export function parseOutcome(log) {
  if (typeof log !== "string" || log === "") return null;
  /* Anchored to the start of a log line, after the runner's timestamp, and no
   * `$` or quote allowed in a value: the runner ALSO echoes the step's script
   * source into the same log, and that copy says `ios_state=${IOS_STATE:-}`. An
   * unanchored match reads the source line first and reports its text as the
   * outcome. */
  const line = /^\S+ RELEASE_OUTCOME((?: [a-z_]+=[^\s$"]*)+)[ \t\r]*$/m.exec(log);
  const read = {};
  if (line) {
    for (const pair of line[1].trim().split(/\s+/)) {
      const i = pair.indexOf("=");
      read[pair.slice(0, i)] = pair.slice(i + 1);
    }
  } else {
    /* The runner's echo is `  IOS_STATE: ready` inside a `##[group]Run` block,
     * after a timestamp. `[ \t]` rather than `\s` keeps an EMPTY value empty —
     * IOS_UPLOADED is blank when the ios job died before writing it — instead of
     * running on into the next line and reading that line's name as this value. */
    const env = (name) => {
      const m = new RegExp(`^\\S*[ \\t]+${name}:[ \\t]*(\\S*)[ \\t\\r]*$`, "m").exec(log);
      return m ? m[1] : undefined;
    };
    const keys = { ios_state: "IOS_STATE", ios_uploaded: "IOS_UPLOADED", android_state: "ANDROID_STATE",
      android_uploaded: "ANDROID_UPLOADED", build: "BUILD_NUMBER" };
    for (const [k, name] of Object.entries(keys)) {
      const v = env(name);
      if (v !== undefined) read[k] = v;
    }
    if (read.ios_state === undefined && read.android_state === undefined) return null;
  }
  /* An empty or missing `uploaded` is false: the platform never reported an
   * upload, which is the only thing "uploaded" can safely mean. */
  return {
    build: read.build || null,
    ios: { state: read.ios_state || "not reached", uploaded: read.ios_uploaded === "true" },
    android: { state: read.android_state || "not reached", uploaded: read.android_uploaded === "true" },
  };
}

/* ─────────────────────────────────── gates ───────────────────────────────── */

function gate(id, ok, code, message, facts = {}) {
  return { id, ok, code, message, facts };
}

function runFacts(r) {
  return {
    run: r.id,
    run_number: r.run_number,
    conclusion: r.conclusion ?? r.status,
    commit: typeof r.head_sha === "string" ? r.head_sha.slice(0, 7) : null,
    finished: r.updated_at ?? null,
  };
}

/** G1 — the newest completed release did not succeed, and no newer one has.
 *
 *  "Newest completed" is by definition not followed by a completed success, so
 *  that half of the plan's sentence is structural. A newer run still IN FLIGHT
 *  does not quiet this: it is a retry, not a result, and G4 watches it. The grace
 *  clock starts when the failed run finished, not when it started. */
export function failedGate(runs, now) {
  const latest = sortRuns(runs).find(isCompleted);
  if (!latest) return gate("G1", true, "NO_COMPLETED_RELEASE", "No release run has completed yet.");
  if (latest.conclusion === "success") {
    return gate("G1", true, "LATEST_RELEASE_OK", "The newest completed release succeeded.", runFacts(latest));
  }
  if (minutesBetween(latest.updated_at, now) < GRACE_MINUTES) {
    return gate("G1", true, "FAILED_IN_GRACE",
      `The newest release failed less than ${GRACE_MINUTES} minutes ago; not alarming yet.`, runFacts(latest));
  }
  return gate("G1", false, "RELEASE_FAILED",
    `Release run #${latest.run_number} ended \`${latest.conclusion}\` and nothing has succeeded since.`,
    runFacts(latest));
}

const RED_JOB = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);

/** G2 — the two stores did not get the same build.
 *
 *  Judged on the newest completed run only: a later run that uploaded to both
 *  stores re-converges them, and would be the newest. Each platform is read from
 *  the outcome line when that line says it got as far as its credential gate —
 *  which is the only reading that can see "green but skipped" — and otherwise
 *  from its own `ios`/`android` job conclusion. The plan's qualification
 *  stands: a store whose credentials are documented-absent (an EXPLICIT
 *  non-ready state, e.g. `absent`) is a known gap with its own HUMAN-ACTIONS
 *  card, not an alarm every hour.
 *
 *  WHY PER PLATFORM, NOT PER RUN. A store job that dies BEFORE its credential
 *  gate leaves its state blank, and the runner still echoes the blank
 *  (`ANDROID_STATE: `) — so the outcome is non-null, and blank reads as
 *  "not reached". That is 2026-09-06: TestFlight got the build, android failed,
 *  the summary went green. Reading "not reached" as "not ready" filed that
 *  divergence as a documented gap; "not reached" is UNKNOWN, and the job
 *  conclusion is what knows. */
const NOT_REACHED = "not reached";

export function divergentGate(runs, jobs, outcome, now) {
  const latest = sortRuns(runs).find(isCompleted);
  if (!latest) return gate("G2", true, "NO_COMPLETED_RELEASE", "No release run has completed yet.");
  const facts = runFacts(latest);
  const reached = (p) => Boolean(outcome && outcome[p] && outcome[p].state && outcome[p].state !== NOT_REACHED);
  if (outcome && ((reached("ios") && outcome.ios.state !== "ready") ||
    (reached("android") && outcome.android.state !== "ready"))) {
    const st = (p) => (outcome[p] && outcome[p].state) || NOT_REACHED;
    return gate("G2", true, "NOT_BOTH_READY",
      `Not both stores had credentials (iOS ${st("ios")}, Android ${st("android")}); ` +
        "that is a documented gap, not a divergence.", facts);
  }
  const list = Array.isArray(jobs) ? jobs : [];
  const conclusion = (name) => (list.find((j) => j && j.name === name) || {}).conclusion;
  /* true / false / null (undecided) / undefined (no such job). */
  const fromJob = (name) => {
    const c = conclusion(name);
    if (!c) return undefined;
    return c === "success" ? true : RED_JOB.has(c) ? false : null;
  };
  const read = (p) => (reached(p) ? outcome[p].uploaded : fromJob(p));
  const ios = read("ios");
  const android = read("android");
  const source = reached("ios") && reached("android") ? "outcome"
    : !reached("ios") && !reached("android") ? "jobs" : "outcome+jobs";
  if (ios === undefined || android === undefined) {
    return gate("G2", true, "NO_STORE_JOBS", "The newest release never reached its store jobs.", facts);
  }
  if (ios === null || android === null) {
    return gate("G2", true, "STORE_JOBS_UNDECIDED", "A store job neither succeeded nor failed.", facts);
  }
  if (ios === android) {
    return gate("G2", true, "STORES_AGREE", `Both stores agree (uploaded=${ios}).`, { ...facts, source });
  }
  if (minutesBetween(latest.updated_at, now) < GRACE_MINUTES) {
    return gate("G2", true, "DIVERGED_IN_GRACE", "The stores diverged less than an hour ago; not alarming yet.",
      { ...facts, source });
  }
  const got = ios ? "TestFlight" : "Play";
  const missed = ios ? "Play" : "TestFlight";
  return gate("G2", false, "STORES_DIVERGED",
    `${got} received build ${outcome && outcome.build ? outcome.build : `from run #${latest.run_number}`} and ` +
      `${missed} did not. Testers on the two platforms are now on different builds.`,
    { ...facts, source });
}

/** G3 — release-relevant work has waited too long.
 *
 *  The clock is the COMMIT date of the oldest release-relevant commit not in the
 *  last successful release: when it landed on main, which is when a listener
 *  could first have had it. This is the gate that catches a trigger that is alive
 *  but always finds a reason to hold. */
export function stalledGate(pending, success, now) {
  if (!success) {
    return gate("G3", false, "NO_SUCCESSFUL_RELEASE",
      "No successful release run is on record, so nothing can say what the stores hold.");
  }
  const facts = { last_release_commit: String(success.head_sha || "").slice(0, 7), last_release_run: success.id };
  if (!pending || !pending.oldest) {
    return gate("G3", true, "NOTHING_WAITING", "Everything release-relevant on main is in the last release.", facts);
  }
  const waitedHours = minutesBetween(pending.oldest.committedAt, now) / 60;
  const list = {
    ...facts,
    waiting_commits: pending.release.length,
    oldest_waiting: `${pending.oldest.sha.slice(0, 7)} (${pending.oldest.committedAt})`,
  };
  if (waitedHours <= STALL_HOURS) {
    return gate("G3", true, "WAITING_IN_BUDGET",
      `${pending.release.length} release-relevant commit(s) waiting, the oldest under ${STALL_HOURS}h.`, list);
  }
  return gate("G3", false, "RELEASE_STALLED",
    `${pending.release.length} release-relevant commit(s) on main have not reached the stores; ` +
      `the oldest has waited over ${STALL_HOURS} hours.`, list);
}

/** G4 — a release run has been queued or running for too long. */
export function stuckGate(runs, now) {
  for (const r of sortRuns(runs)) {
    if (!isInFlight(r)) continue;
    const since = r.status === "in_progress" ? r.run_started_at || r.created_at : r.created_at;
    if (minutesBetween(since, now) > STUCK_MINUTES) {
      return gate("G4", false, "RELEASE_STUCK",
        `Release run #${r.run_number} has been \`${r.status}\` for over ${STUCK_MINUTES} minutes.`,
        { run: r.id, run_number: r.run_number, status: r.status, since });
    }
  }
  return gate("G4", true, "NOTHING_STUCK", "No release run is stuck.");
}

/** Is the OTHER release workflow still running on its schedule?
 *
 *  `workflow.state` first, because that is the #46 failure verbatim: GitHub
 *  disables a scheduled workflow (by hand, or after 60 days of repo inactivity)
 *  and says so only in a banner. Then the newest successful SCHEDULED run — a
 *  person clicking "Run workflow" proves the code works, not that the cron fires.
 *  A workflow too new to have run yet is measured from its creation, so merging
 *  these two files cannot page anyone in its first hours. */
export function livenessGate(id, name, workflow, runs, staleHours, now) {
  const state = workflow && typeof workflow.state === "string" ? workflow.state : "unknown";
  if (state !== "active") {
    return gate(id, false, "PEER_DISABLED",
      `\`${name}\` is not active (state: \`${state}\`), so it is not running at all.`, { workflow: name, state });
  }
  const scheduled = sortRuns(runs).filter((r) => r.event === "schedule" && isSuccess(r));
  const since = scheduled.length ? scheduled[0].created_at : workflow.created_at;
  const facts = { workflow: name, last_scheduled_success: scheduled.length ? since : null };
  if (!Number.isFinite(ms(since)) || minutesBetween(since, now) / 60 > staleHours) {
    return gate(id, false, "PEER_SILENT",
      `\`${name}\` has not completed a scheduled run in over ${staleHours} hours.`, facts);
  }
  return gate(id, true, "PEER_ALIVE", `\`${name}\` is running on schedule.`, facts);
}

/** Is the watchdog ITSELF broken — this run failed, and so did the one before?
 *
 *  Liveness covers a watchdog that stops FIRING. It cannot cover one that fires
 *  and fails, when the cause is shared with its peer: both workflows import the
 *  same module and the same bundle plan, so a change that breaks one breaks both,
 *  each sees the other red, and neither reaches its issue step. So the watchdog's
 *  issue step also runs after a failure and asks this question of its own run
 *  history. Twice running, not once: a single failure after four retries is most
 *  likely GitHub's API having a bad minute, and a flaky alarm is worse than none. */
export function selfBrokenVerdict(ownRuns, currentRunId) {
  const previous = sortRuns(ownRuns).find((r) => r.id !== Number(currentRunId) && r.event === "schedule" && isCompleted(r));
  const broken = Boolean(previous) && previous.conclusion !== "success";
  return verdictOf("self", [broken
    ? gate("W", false, "WATCHDOG_BROKEN",
      "`release-watch` has failed on two scheduled runs in a row, so the release gates are not being checked. " +
        "Read the newest run's log: it failed before reaching a verdict.", { previous_run: previous.id })
    : gate("W", true, "WATCHDOG_BLIP", "One failed watchdog run; the next one decides whether it was a blip.")]);
}

/* ─────────────────────────────── the two verdicts ────────────────────────── */

function verdictOf(mode, gates, extra = {}) {
  return { mode, ok: gates.every((g) => g.ok), gates, ...extra };
}

/** Everything the hourly watchdog says, as one verdict. */
export function watchVerdict({ runs, jobs, summaryLog, commits, bundle, peerWorkflow, peerRuns, now }) {
  const outcome = parseOutcome(summaryLog);
  const success = lastSuccess(runs);
  const pending = pendingWork(commits, bundle);
  return verdictOf("watch", [
    failedGate(runs, now),
    divergentGate(runs, jobs, outcome, now),
    stalledGate(pending, success, now),
    stuckGate(runs, now),
    livenessGate("L", "release-trigger", peerWorkflow, peerRuns, TRIGGER_STALE_HOURS, now),
  ], { seed_waiting: pending.seed.length });
}

const RED_RUN = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

/** Is main itself red or still building, ignoring the release machinery?
 *
 *  What runs on a push to main: ci.yml (the same jobs a PR ran), Pages, and a
 *  commit status from the deploy host. Only runs of OTHER workflows on main's
 *  head count (release.yml and the scheduled/dispatched watchers attach to the
 *  same commit and must not hold themselves up), and a combined status with
 *  zero statuses is ignored, because GitHub reports that as `pending` forever.
 *
 *  ci.yml IS JUDGED BY ITS REQUIRED CHECKS, NOT ITS RUN (ci-release-6, round-3
 *  audit). The run's conclusion is `failure` whenever ANY job fails, including
 *  the advisory ones protect-main deliberately does not require (ios-kit, the
 *  macOS Swift build; playwright, "ADVISORY-ONLY ... DELIBERATELY"). Reading
 *  the run held every automatic release behind a red ios-kit that release.yml
 *  does not even build from (measured: runs 35950411353 and 35900753042 failed
 *  with only ios-kit red). So when the head's check runs are supplied, a ci.yml
 *  run is skipped here and the REQUIRED contexts — pr-triage's REQUIRED_CHECKS,
 *  the same list the merge gate uses — are read instead: a failed one is red,
 *  a running or not-yet-reported one is building. Without check runs (an older
 *  caller), ci.yml is read as a whole run, as before: stricter, never looser. */
export function mainState(mainRuns, combinedStatus, checkRuns = null, requiredChecks = REQUIRED_CHECKS) {
  const failing = [];
  const building = [];
  const byChecks = Array.isArray(checkRuns);
  for (const r of Array.isArray(mainRuns) ? mainRuns : []) {
    if (!r || typeof r !== "object") continue;
    if (r.event === "schedule" || r.event === "workflow_dispatch") continue;
    if (typeof r.path === "string" && r.path.endsWith("/release.yml")) continue;
    if (byChecks && typeof r.path === "string" && r.path.endsWith("/ci.yml")) continue;
    if (isInFlight(r)) building.push(r.name);
    else if (RED_RUN.has(r.conclusion)) failing.push(r.name);
  }
  if (byChecks) {
    for (const name of requiredChecks) {
      // The newest check run of that name (a re-run adds a second one).
      const latest = checkRuns
        .filter((c) => c && c.name === name)
        .sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")) || (b.id ?? 0) - (a.id ?? 0))[0];
      if (!latest) building.push(`${name} (not reported yet)`);
      else if (latest.status !== "completed") building.push(name);
      else if (RED_RUN.has(latest.conclusion) || latest.conclusion === "cancelled") failing.push(name);
    }
  }
  const s = combinedStatus && typeof combinedStatus === "object" ? combinedStatus : {};
  if (s.total_count > 0) {
    if (s.state === "failure" || s.state === "error") failing.push("commit status");
    else if (s.state === "pending") building.push("commit status");
  }
  return { state: failing.length ? "red" : building.length ? "building" : "green", failing, building };
}

/** Should the trigger dispatch a release now? One decision, with its reason.
 *
 *  Held, in this order, when: a release is already queued or running (release.yml
 *  queues behind it anyway, but two dispatches would ship twice); nothing
 *  release-relevant is waiting; the retry budget is spent; or main is red or
 *  still building. Otherwise dispatch — which is also how a FAILED release is
 *  retried, since its commits are still waiting. */
export function triggerDecision({ runs, commits, bundle, mainRuns, mainStatus, mainChecks = null }) {
  const inFlight = sortRuns(runs).find(isInFlight);
  if (inFlight) {
    return { dispatch: false, code: "HOLD_IN_FLIGHT", reason: `Release run #${inFlight.run_number} is already ${inFlight.status}.` };
  }
  const pending = pendingWork(commits, bundle);
  if (!pending.release.length) {
    return { dispatch: false, code: "NOTHING_TO_RELEASE",
      reason: "Nothing release-relevant has landed since the last successful release." +
        (pending.seed.length ? ` (${pending.seed.length} commit(s) changed bundled data only; the app fetches that live.)` : "") };
  }
  const failures = failuresSinceSuccess(runs);
  if (failures.length >= RETRY_BUDGET) {
    return { dispatch: false, code: "HOLD_RETRY_BUDGET",
      reason: `The last ${failures.length} release runs failed; not spending more macOS time until someone looks.` };
  }
  const main = mainState(mainRuns, mainStatus, mainChecks);
  if (main.state !== "green") {
    const names = main.state === "red" ? main.failing : main.building;
    return { dispatch: false, code: main.state === "red" ? "HOLD_MAIN_RED" : "HOLD_MAIN_BUILDING",
      reason: `main is ${main.state} (${names.join(", ")}).` };
  }
  return { dispatch: true, code: "DISPATCH",
    reason: `${pending.release.length} release-relevant commit(s) waiting; the oldest is ` +
      `${pending.oldest.sha.slice(0, 7)} from ${pending.oldest.committedAt}.` };
}

/** The trigger's own verdict: its decision, plus whether the WATCHDOG is alive. */
export function triggerVerdict({ runs, commits, bundle, mainRuns, mainStatus, mainChecks = null, peerWorkflow, peerRuns, now }) {
  const decision = triggerDecision({ runs, commits, bundle, mainRuns, mainStatus, mainChecks });
  return verdictOf("trigger", [
    livenessGate("L", "release-watch", peerWorkflow, peerRuns, WATCHDOG_STALE_HOURS, now),
  ], { decision });
}

/* ──────────────────────────────── the one issue ──────────────────────────── */

/* What to do about each red gate. Said, not inferred: an alarm nobody knows how
 * to clear becomes an alarm people mute. */
const HOW_TO_CLEAR = {
  G1: "Dispatch a FRESH release: Actions → release → Run workflow (main, bump `none`), or " +
    "`gh workflow run release.yml --ref main -f bump=none`. **Never \"Re-run failed jobs\"** — it reuses the build " +
    "number and App Store Connect refuses a binary it already has. `release-trigger` retries once on its own.",
  G2: "A fresh dispatch rebuilds BOTH stores from one commit under a new build number, which re-converges them. " +
    "Same command as above; not a re-run.",
  G3: "Open the newest `release-trigger` run's summary: it names why it held (main red, retry budget spent, a run " +
    "stuck in flight). Clear that, or dispatch by hand.",
  G4: "Open the run. If it is hung, cancel it, then dispatch fresh. A queued run is waiting on the `release` " +
    "concurrency group, so the stuck one is the run ahead of it.",
  W: "Open the newest `release-watch` run and read the step that failed. Until it is fixed nothing is checking " +
    "the releases, and `release-trigger` cannot be relied on either: the two share this module.",
  L: "Open the workflow in the Actions tab. A banner saying the scheduled workflow is disabled means click " +
    "**Enable workflow**. If it is enabled, open its newest run and read why it failed.",
};

export function renderIssueBody(verdict) {
  const red = (verdict.gates || []).filter((g) => !g.ok);
  const lines = [ISSUE_MARKER, ""];
  if (!red.length) {
    lines.push("Every release gate is green.");
    return lines.join("\n") + "\n";
  }
  lines.push(
    "The release pipeline needs a person. This issue is maintained by `tools/release/watch-release.mjs` " +
      "(docs/release-reliability-plan.md): it is edited as things change and closes itself when every gate is green.",
    ""
  );
  for (const g of red) {
    lines.push(`### ${g.id} — \`${g.code}\``, "", g.message, "");
    const facts = Object.entries(g.facts || {}).filter(([, v]) => v !== undefined);
    if (facts.length) {
      lines.push("| fact | value |", "| --- | --- |");
      for (const [k, v] of facts) lines.push(`| ${k} | ${v === null ? "—" : String(v)} |`);
      lines.push("");
    }
    if (HOW_TO_CLEAR[g.id]) lines.push(`**To clear:** ${HOW_TO_CLEAR[g.id]}`, "");
  }
  return lines.join("\n");
}

function sameBody(a, b) {
  const norm = (s) => String(s || "").replace(/\r\n/g, "\n").trim();
  return norm(a) === norm(b);
}

/** One action for the sticky issue.
 *
 *  The sticky issue is the OLDEST issue (never a PR — the issues API returns
 *  both) carrying ISSUE_MARKER, open or closed, so the alarm has one history
 *  instead of a trail of duplicates. Reopening notifies; an edit does not, which
 *  is why an unchanged verdict is `none` rather than a rewrite every hour.
 *
 *  `mayClose` is false for the trigger: it only ever reports the watchdog's
 *  liveness, so it has no standing to call G1-G4 green. */
export function planIssue({ issues, verdict, mayClose }) {
  const sticky = (Array.isArray(issues) ? issues : [])
    .filter((i) => i && !i.pull_request && typeof i.body === "string" && i.body.includes(ISSUE_MARKER))
    .sort((a, b) => a.number - b.number)[0];
  const body = renderIssueBody(verdict);
  if (!verdict.ok) {
    if (!sticky) return { action: "create", title: ISSUE_TITLE, body };
    if (sticky.state === "closed") return { action: "reopen", number: sticky.number, body };
    if (!sameBody(sticky.body, body)) return { action: "edit", number: sticky.number, body };
    return { action: "none", number: sticky.number, body };
  }
  if (sticky && sticky.state === "open" && mayClose) {
    return { action: "close", number: sticky.number, body,
      comment: "Every release gate is green again. Closing; this issue reopens itself if one goes red." };
  }
  return { action: "none", number: sticky ? sticky.number : null, body };
}

/* ─────────────────────────────────── report ──────────────────────────────── */

export function renderReport(verdict) {
  const lines = [`### ${verdict.ok ? "PASS" : "RED"} — release ${verdict.mode}`, ""];
  if (verdict.decision) {
    lines.push(`**${verdict.decision.dispatch ? "Dispatching a release" : "Not dispatching"}** — ` +
      `\`${verdict.decision.code}\`: ${verdict.decision.reason}`, "");
  }
  lines.push("| gate | | code | detail |", "| --- | --- | --- | --- |");
  for (const g of verdict.gates) lines.push(`| ${g.id} | ${g.ok ? "ok" : "RED"} | \`${g.code}\` | ${g.message} |`);
  if (verdict.seed_waiting) {
    lines.push("", `${verdict.seed_waiting} commit(s) changed only bundled data; the app fetches that live, so the ` +
      "bundled seed is merely stale. Not a reason to release.");
  }
  return lines.join("\n") + "\n";
}

/* ───────────────────────────────────── CLI ───────────────────────────────── */

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** `gh api .../runs` returns `{ workflow_runs: [...] }`, `.../jobs` returns
 *  `{ jobs: [...] }`; accept either shape or a bare array. */
function listOf(doc, key) {
  if (Array.isArray(doc)) return doc;
  return doc && Array.isArray(doc[key]) ? doc[key] : [];
}

async function loadBundle(argv) {
  const planPath = arg(argv, "--plan");
  if (planPath) return bundleSet(readJson(planPath));
  const { buildPlan, SHELL_ONLY_FILES } = await import("../mobile/prepare-webdir.mjs");
  return bundleSet(buildPlan(), SHELL_ONLY_FILES);
}

function writeOutput(env, line) {
  if (!env.GITHUB_OUTPUT) return;
  try {
    fs.appendFileSync(env.GITHUB_OUTPUT, line + "\n");
  } catch {
    /* The shell reads the decision from verdict.json too; losing this line
     * costs one release slot, not correctness. */
  }
}

export async function run(argv, env = process.env) {
  const mode = arg(argv, "--mode");
  const now = arg(argv, "--now", new Date().toISOString());
  if (!["last-success", "latest-completed", "watch", "trigger", "issue", "self-broken"].includes(mode)) {
    return { code: 2, text: `unknown --mode ${mode} (expected last-success|latest-completed|watch|trigger|issue|self-broken)\n` };
  }

  try {
    /* The two lookups the workflows need BEFORE they can fetch the rest. Here
     * rather than as `jq` in YAML so "which run counts" has one definition. */
    if (mode === "last-success") {
      const s = lastSuccess(listOf(readJson(arg(argv, "--runs")), "workflow_runs"));
      return s && s.head_sha ? { code: 0, text: s.head_sha + "\n" } : { code: 3, text: "" };
    }
    if (mode === "latest-completed") {
      const r = sortRuns(listOf(readJson(arg(argv, "--runs")), "workflow_runs")).find(isCompleted);
      return r ? { code: 0, text: r.id + "\n" } : { code: 3, text: "" };
    }

    if (mode === "self-broken") {
      const verdict = selfBrokenVerdict(listOf(readJson(arg(argv, "--runs")), "workflow_runs"), arg(argv, "--current"));
      const verdictOut = arg(argv, "--verdict-out");
      if (verdictOut) fs.writeFileSync(verdictOut, JSON.stringify(verdict, null, 2) + "\n");
      return { code: 0, text: renderReport(verdict), verdict };
    }

    if (mode === "issue") {
      const verdict = readJson(arg(argv, "--verdict"));
      const plan = planIssue({ issues: readJson(arg(argv, "--issues")), verdict, mayClose: argv.includes("--may-close") });
      const bodyOut = arg(argv, "--body-out");
      if (bodyOut) fs.writeFileSync(bodyOut, plan.body);
      const actionOut = arg(argv, "--action-out");
      if (actionOut) fs.writeFileSync(actionOut, JSON.stringify(plan, null, 2) + "\n");
      return { code: 0, text: `issue: ${plan.action}${plan.number ? ` #${plan.number}` : ""}\n`, plan };
    }

    const bundle = await loadBundle(argv);
    const runs = listOf(readJson(arg(argv, "--runs")), "workflow_runs");
    const commitsPath = arg(argv, "--commits");
    const commits = commitsPath ? parseGitLog(fs.readFileSync(commitsPath, "utf8")) : [];
    const peerWorkflow = readJson(arg(argv, "--peer-workflow"));
    const peerRuns = listOf(readJson(arg(argv, "--peer-runs")), "workflow_runs");

    let verdict;
    if (mode === "watch") {
      const jobsPath = arg(argv, "--jobs");
      const logPath = arg(argv, "--summary-log");
      verdict = watchVerdict({
        runs,
        jobs: jobsPath && fs.existsSync(jobsPath) ? listOf(readJson(jobsPath), "jobs") : [],
        summaryLog: logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
        commits, bundle, peerWorkflow, peerRuns, now,
      });
    } else {
      verdict = triggerVerdict({
        runs, commits, bundle,
        mainRuns: listOf(readJson(arg(argv, "--main-runs")), "workflow_runs"),
        mainStatus: readJson(arg(argv, "--main-status")),
        // ci-release-6: optional, so an older trigger workflow still runs.
        mainChecks: arg(argv, "--main-checks") ? listOf(readJson(arg(argv, "--main-checks")), "check_runs") : null,
        peerWorkflow, peerRuns, now,
      });
      writeOutput(env, `dispatch=${verdict.decision.dispatch}`);
    }

    const verdictOut = arg(argv, "--verdict-out");
    if (verdictOut) fs.writeFileSync(verdictOut, JSON.stringify(verdict, null, 2) + "\n");
    const report = renderReport(verdict);
    if (env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(env.GITHUB_STEP_SUMMARY, report);
      } catch {
        /* A summary we cannot write must never change the verdict. */
      }
    }
    return { code: 0, text: report, verdict };
  } catch (err) {
    /* "I could not read my inputs" is NOT a verdict about the release, so it is
     * not spelled like one: exit 1, touch no issue, and let the peer's liveness
     * check notice if it keeps happening. */
    return { code: 1, text: `watch-release: could not read its inputs: ${err.message}\n` };
  }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("tools/release/watch-release.mjs");
if (invokedDirectly) {
  const { code, text } = await run(process.argv.slice(2));
  process.stdout.write(text);
  process.exit(code);
}
