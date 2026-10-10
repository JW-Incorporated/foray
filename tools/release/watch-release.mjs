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
 *                   (create / reopen / edit / close / none), and with --apply
 *                   makes the `gh issue` calls that carry it out. Both workflows
 *                   write the sticky issue through this one path (CH2-34a);
 *                   without --apply it only prints what it would do.
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
 * release.yml's `version` job computes the build number ONCE per run: the UTC
 * day plus a run-of-day slot from tools/release/build-number.mjs, the larger of
 * the count of release.yml runs created that day up to and including this one
 * and one past the highest slot an earlier run of the day printed (ci-release-4;
 * before it the slot was the lifetime run number wrapped at 99, which could go
 * backwards). "Re-run failed jobs" does not even re-execute that job — it
 * replays its cached outputs — so a re-run would upload the SAME build number,
 * and App Store Connect refuses a binary it already has (the plan's "BUILD
 * NUMBER COLLIDES ON A RE-RUN" section); since OPS-04 the `ios` and `android`
 * jobs refuse any run attempt but the first, before checkout. A fresh
 * `workflow_dispatch` is a new run of the day, so it counts one higher, gets a
 * new build number, and rebuilds BOTH stores from one commit — which is also
 * what re-converges two stores that diverged. So the trigger only ever
 * dispatches, and watch-release.test.mjs pins that no workflow here says
 * `rerun`.
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
 * every input is a file the workflow fetched with `gh` (the fetches live in
 * .github/actions/release-facts, which both workflows call), so every verdict
 * is a pure function of fixtures and can be shown to fire without waiting a day
 * for it to. The one outbound call is the sticky issue's write, and only under
 * `--mode issue --apply`: it spawns `gh issue ...` (issueCommands() names
 * each call), so the plan it carries out is the plan the tests read. The one
 * import outside node: is prepare-webdir.mjs's own bundle plan, loaded lazily
 * by the CLI, because "which files reach a store build" has an
 * executable answer and a hand-kept copy of it would drift. For the same reason
 * the native half of that answer is READ at module load from the three files
 * that build and sign the binary (NATIVE_INPUT_FILES below): files in the
 * workflow's own checkout, not a network call.
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
 *        --main-checks check-runs.json --run-jobs run-jobs/ \
 *        --peer-workflow watch-workflow.json --peer-runs watch-runs.json \
 *        --verdict-out verdict.json
 *   node tools/release/watch-release.mjs --mode failed-since-success --runs runs.json
 *   node tools/release/watch-release.mjs --mode gate-refusals --runs runs.json --run-jobs run-jobs/
 *   node tools/release/watch-release.mjs --mode issue --verdict verdict.json \
 *        --issues issues.json [--may-close] [--apply --repo owner/name] \
 *        [--action-out action.json] [--body-out body.md]
 *   node tools/release/watch-release.mjs --mode self-broken --runs own-runs.json \
 *        --current "$GITHUB_RUN_ID" --verdict-out self.json
 *   Common: --now <ISO> (tests), --plan <json array of bundle paths> (tests).
 *   Exit 0 when it evaluated (whatever it found), 1 when it could not read its
 *   inputs, 2 on a bad --mode, 3 when `last-success` / `latest-completed` has
 *   no run to name.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
/* protect-main's required contexts. ONE list, owned by the merge machinery: the
 * release trigger must call main "red" for exactly the checks that can block a
 * merge, and no others (ci-release-6). */
import { REQUIRED_CHECKS } from "../ci/pr-triage.mjs";
/* release.yml's iOS gate (ios-checks runs `engine-ci.mjs release-checks`).
 * The trigger reads that gate's refusals with the gate's OWN definitions -
 * which checks, "green on this SHA", what a superseded refusal prints - so the
 * two can never disagree about why TestFlight was refused (issue #745). */
import { RELEASE_REQUIRED_CHECKS, latestActionsRun, releaseChecksVerdict, releaseRefusalKind } from "../ci/engine-ci.mjs";

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

/** After this many failed release runs since the last success the trigger
 *  stops dispatching. One automatic retry of a failure is cheap insurance
 *  against a transient store outage; a second failure in a row is a pattern,
 *  the issue is already open by then, and every further automatic attempt is
 *  10x-billed macOS time spent proving the same thing. A human dispatch that
 *  succeeds resets it.
 *
 *  A run the iOS GATE refused is not one of those failures (issue #745): its
 *  `ios-checks` job failed, so the macOS `ios` job was SKIPPED and no macOS
 *  minute was spent (releaseRunKind, below). Runs 72 and 73 on 2026-10-09
 *  were both that - an ios-kit flake, then a commit main had already moved
 *  past - and counting them froze TestFlight while Play kept shipping. */
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
 * through `www/`; it is DERIVED, below, from what the release actually runs. */
export const NATIVE_INPUT_PREFIXES = [
  "mobile/",
  ".github/actions/ios-archive/",
  /* ios-archive runs this composite (CH2-16): the plist keys, encryption
   * declaration, privacy manifest, icon and splash that ship in the archive. */
  ".github/actions/ios-prepare/",
  ".github/actions/android-bundle/",
];
const INJECT_SCRIPT = /^tools\/mobile\/inject-[^/]+\.mjs$/;

function isTestOrDoc(file) {
  return /\.test\.[cm]?[jt]sx?$/.test(file) || /\.md$/i.test(file);
}

/* ── the native half: what the release RUNS, read from the files that run it ──
 *
 * CH2-19 (T2-05). This was five hand-picked files while the composites executed
 * a dozen more (wire-signing.mjs, ios-ci.mjs, release-ci.mjs, version.mjs,
 * build-number.mjs, upload-retry.mjs, the PNG code the icon and splash
 * injectors import), so a fix to the Android signing include never triggered a
 * release: release-trigger said NOTHING_TO_RELEASE and G3 never alarmed. Now
 * the list is every script these three files execute (`node <script>`, an
 * `npm run` followed into its package.json, `npm ci`'s manifests, a local
 * `uses: ./.github/actions/...` followed into its action.yml) plus everything
 * those scripts load by relative path: the walk tools/ci/path-policy.test.mjs
 * does over the signing jobs, here over the jobs of release.yml that make the
 * binary (releaseBinaryJobs, below). Tests are not followed (releaseTier never
 * treats a test as a trigger), which is why fetch-models.mjs is no longer
 * listed: since CH-20 only test/release-gates.test.js loads it, and that suite
 * pins that no build path runs it.
 *
 * GATE JOBS ARE NOT READ (PR #1202 review). release.yml also runs jobs that
 * only decide WHETHER to ship: `guard`, `ios-checks` (tools/ci/engine-ci.mjs
 * release-checks) and `summary`. A script that only they run never reaches a
 * store build, so an edit to it alone must not spend a TestFlight and a Play
 * upload. Which jobs make the binary is read from the workflow's structure,
 * not named here (releaseBinaryJobs). A script a gate job runs that a binary
 * job ALSO runs or imports stays a trigger: release-ci.mjs (the guard job, and
 * android-bundle's play-gate); generate-manifest.mjs and the stamp modules it
 * imports (prepare-webdir.mjs imports it for the bundle's data list, build
 * stamp and seed pointer, so they put bytes in the binary).
 *
 * The derivation can only ADD triggers to the old hand list: the bundle, the
 * prefixes above and the inject-* rule classify exactly as before, and every
 * file the hand list named is still reached from a binary job. */
export const NATIVE_INPUT_RUNNERS = [
  ".github/workflows/release.yml",
  ".github/actions/ios-archive/action.yml",
  ".github/actions/android-bundle/action.yml",
];

/* Inputs a release step reads by PATH, which no import walk can see, each with
 * the line that reads it:
 *   icon-1024.png            tools/mobile/inject-app-icon.mjs, DEFAULT_SOURCE
 *   tools/brand/4a-logo.png  tools/brand/build-icons.mjs, MASTER, which
 *                            inject-splash.mjs rasterises into both splashes */
export const NATIVE_DATA_INPUTS = ["icon-1024.png", "tools/brand/4a-logo.png"];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The jobs of a workflow that make the binary, read from the workflow's own
 *  structure (PR #1202 review):
 *    - a job whose steps use a local composite (`uses: ./.github/actions/...`)
 *      builds, signs or uploads the binary (release.yml: `ios`, `android`);
 *    - a job whose OUTPUTS such a job reads as data (`needs.<id>.outputs` on a
 *      line that is not an `if:`) feeds the binary too, transitively
 *      (`version`: the marketing version and build number the composites
 *      stamp into it).
 *  Every other job is a gate or a report (`guard`, `ios-checks`, `summary`):
 *  it can stop a release but puts no byte in one. An `if:` that reads a gate's
 *  output is a gate decision, so it does not pull the gate in.
 *  `code` has its full-line comments stripped. Returns `{ binary, jobs }`
 *  (sorted job ids; id -> body lines), or null for a file with no top-level
 *  `jobs:` (a composite's action.yml, which is read whole). */
export function releaseBinaryJobs(code) {
  const lines = code.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return null;
  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const header = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
    } else if (current) jobs.get(current).push(line);
  }
  const binary = new Set();
  for (const [id, body] of jobs) {
    if (body.some((l) => /uses:\s*\.\/\.github\/actions\//.test(l))) binary.add(id);
  }
  const queue = [...binary];
  while (queue.length) {
    for (const l of jobs.get(queue.shift())) {
      if (/^\s*(?:-\s*)?if:/.test(l)) continue;
      for (const m of l.matchAll(/\bneeds\.([\w-]+)\.outputs\b/g)) {
        if (jobs.has(m[1]) && !binary.has(m[1])) {
          binary.add(m[1]);
          queue.push(m[1]);
        }
      }
    }
  }
  return { binary: [...binary].sort(), jobs };
}

const repoPath = (wd, rel) => path.posix.normalize(path.posix.join(wd, rel)).replace(/^\.\//, "");

/** The relative module specifiers one source file loads: static imports and
 *  re-exports, bare side-effect imports, dynamic import(), require(), and the
 *  chained `createRequire(import.meta.url)("./x")` form. */
function relativeSpecifiers(src) {
  return [
    ...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["'](\.{1,2}\/[^"']+)["']/g),
    ...src.matchAll(/(?:^|\n)\s*import\s*["'](\.{1,2}\/[^"']+)["']/g),
    ...src.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
    ...src.matchAll(/\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
    ...src.matchAll(/\bcreateRequire\([^()]*\)\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
  ].map((m) => m[1]);
}

/** Every repo file the release runners execute or load, sorted.
 *  `read(repoPath)` returns a file's text, or null when it does not exist. A
 *  runner or a package.json it names that cannot be read THROWS: a renamed
 *  release.yml must fail this module's suite, never quietly shrink the list. */
export function deriveNativeInputs(read, runners = NATIVE_INPUT_RUNNERS) {
  const out = new Set();
  const must = (f) => {
    const text = read(f);
    if (typeof text !== "string") throw new Error(`watch-release: cannot read ${f} to derive the native inputs`);
    return text;
  };
  const add = (f) => {
    if (!isTestOrDoc(f)) out.add(f);
  };
  const seenScripts = new Set();
  const command = (cmd, wd) => {
    for (const m of cmd.matchAll(/\bnode\s+((?:\.\.?\/)*[\w@./-]+\.(?:mjs|cjs|js))\b/g)) add(repoPath(wd, m[1]));
    for (const m of cmd.matchAll(/\bnpm\s+ci\b([^\n&;|]*)/g)) {
      const prefix = /--prefix\s+(\S+)/.exec(m[1]);
      const dir = prefix ? repoPath(wd, prefix[1]) : wd;
      for (const f of ["package.json", "package-lock.json"]) add(repoPath(dir, f));
    }
    for (const m of cmd.matchAll(/\bnpm\s+run\s+([\w:.-]+)/g)) {
      const key = `${wd}:${m[1]}`;
      if (seenScripts.has(key)) continue;
      seenScripts.add(key);
      const manifest = repoPath(wd, "package.json");
      add(manifest);
      const script = JSON.parse(must(manifest)).scripts?.[m[1]];
      if (typeof script !== "string") throw new Error(`watch-release: ${manifest} has no "${m[1]}" script`);
      command(script, wd);
    }
  };
  const seenRunners = new Set();
  const runner = (f) => {
    if (seenRunners.has(f)) return;
    seenRunners.add(f);
    out.add(f);
    // Full-line comments are prose, not commands. Each step is its own chunk,
    // so a `working-directory` applies to its own `run` only.
    const code = must(f).split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#")).join("\n");
    // A workflow: only the jobs that make the binary. A composite: all of it.
    const structure = releaseBinaryJobs(code);
    let walked = code;
    if (structure) {
      if (!structure.binary.length) {
        throw new Error(`watch-release: ${f} has no job that makes the binary (none uses a local composite)`);
      }
      walked = structure.binary.map((id) => structure.jobs.get(id).join("\n")).join("\n");
    }
    for (const chunk of walked.split(/\n(?=\s*- (?:name|uses|run):)/)) {
      for (const m of chunk.matchAll(/uses:\s*\.\/(\.github\/actions\/[\w-]+)/g)) runner(`${m[1]}/action.yml`);
      command(chunk, /working-directory:\s*(\S+)/.exec(chunk)?.[1] ?? ".");
    }
  };
  for (const f of runners) runner(f);
  /* The import closure. A specifier that names no file is dropped: the
   * patterns also match an example in a comment (generate-manifest.mjs quotes
   * `import("./x.js")`), and a path that does not exist cannot be committed to. */
  const queue = [...out];
  while (queue.length) {
    const f = queue.shift();
    if (!/\.(?:mjs|cjs|js)$/.test(f)) continue;
    const src = read(f);
    if (typeof src !== "string") continue;
    for (const spec of relativeSpecifiers(src)) {
      const dep = repoPath(path.posix.dirname(f), spec);
      if (out.has(dep) || isTestOrDoc(dep) || typeof read(dep) !== "string") continue;
      out.add(dep);
      queue.push(dep);
    }
  }
  return [...out].sort();
}

function readRepoFile(f) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/** The native half of the allow-list, computed once at module load. */
export const NATIVE_INPUT_FILES = Object.freeze(
  [...new Set([...deriveNativeInputs(readRepoFile), ...NATIVE_DATA_INPUTS])].sort()
);
const NATIVE_INPUT_SET = new Set(NATIVE_INPUT_FILES);

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
  if (NATIVE_INPUT_SET.has(file)) return "release";
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

/** ONE definition of a red conclusion, for a workflow run, a job and a check
 *  run alike (CH2-19, T2-15). There were three: runs left out `cancelled`,
 *  jobs left out `action_required`, and check runs added `cancelled` ad hoc,
 *  so a manually cancelled pages.yml run on main's head read as "main green"
 *  while the same cancel on a check run read as "main red". A cancelled run
 *  shipped nothing and proved nothing, so it is red wherever it is read. The
 *  difference was not deliberate: no comment or test named it. `neutral`,
 *  `skipped` and `stale` are not red, and every reader treats them alike. */
const RED = new Set(["failure", "timed_out", "cancelled", "startup_failure", "action_required"]);
export const isRed = (conclusion) => RED.has(conclusion);

/** The newest release run that SUCCEEDED — the commit the stores last received.
 *
 *  No branch filter, deliberately: a tag-triggered run's `head_branch` is the
 *  tag, and it is still a release of a commit on main (release.yml's guard job
 *  refuses a tag that is not). A run the guard REFUSED exits 1, so it can never
 *  be mistaken for a success here. */
export function lastSuccess(runs) {
  return sortRuns(runs).find(isSuccess) || null;
}

/** release.yml's iOS gate job and the macOS job it gates (`ios` needs
 *  `ios-checks`). watch-release.test.mjs pins both names, the `needs` and the
 *  runner against release.yml itself. */
export const IOS_GATE_JOB = "ios-checks";
export const IOS_BUILD_JOB = "ios";

/** The ios-checks job of a run the iOS gate REFUSED, or null: ios-checks
 *  concluded `failure` and the macOS `ios` job was skipped because of it.
 *  Keyed on the iOS lane ONLY (issue #745): in runs 72 and 73 android built
 *  and uploaded to Play while TestFlight was refused, so "every binary job
 *  skipped" would never have matched. `jobs` is GET /actions/runs/{id}/jobs. */
export function iosGateRefusal(jobs) {
  const list = Array.isArray(jobs) ? jobs.filter((j) => j && typeof j === "object") : [];
  const gate = list.find((j) => j.name === IOS_GATE_JOB);
  const build = list.find((j) => j.name === IOS_BUILD_JOB);
  return gate && gate.conclusion === "failure" && build && build.conclusion === "skipped" ? gate : null;
}

/** One completed release run, as the retry budget sees it:
 *    "success"     it succeeded;
 *    "superseded"  the iOS gate refused it because main had moved past its
 *                  commit before CI could test it (the refusal's log carries
 *                  engine-ci.mjs's RELEASE_SUPERSEDED_MARKER) - a newer
 *                  commit was already waiting, so nothing failed;
 *    "refused"     the iOS gate refused it for any other reason (a red or
 *                  absent check on its own commit);
 *    "failed"      everything else, INCLUDING a run with no job facts: with
 *                  nothing to read, the run counts, as it always did.
 *  `facts` is `{ jobs, iosChecksLog }` for that run (loadRunJobs). Neither a
 *  refused nor a superseded run spent macOS time, so neither spends the
 *  retry budget; a run whose `ios` job RAN and failed still does. */
export function releaseRunKind(run, facts) {
  if (isSuccess(run)) return "success";
  if (!facts || !Array.isArray(facts.jobs) || !iosGateRefusal(facts.jobs)) return "failed";
  return releaseRefusalKind(facts.iosChecksLog) === "superseded" ? "superseded" : "refused";
}

/** Completed runs since the last success that did not succeed, newest first,
 *  each with its releaseRunKind. Without `runJobs` (an older caller) every one
 *  is "failed": stricter, never looser. */
export function runsSinceSuccess(runs, runJobs = null) {
  const out = [];
  for (const r of sortRuns(runs)) {
    if (!isCompleted(r)) continue;
    if (r.conclusion === "success") break;
    const facts = runJobs && typeof runJobs === "object" ? runJobs[String(r.id)] : undefined;
    out.push({ run: r, kind: runJobs ? releaseRunKind(r, facts) : "failed" });
  }
  return out;
}

/** The runs since the last success that COUNT against RETRY_BUDGET, newest
 *  first: those that did not succeed and were not refused (or superseded) at
 *  the iOS gate. Without `runJobs`, every completed non-success run. */
export function failuresSinceSuccess(runs, runJobs = null) {
  return runsSinceSuccess(runs, runJobs).filter((x) => x.kind === "failed").map((x) => x.run);
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
    return c === "success" ? true : isRed(c) ? false : null;
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
 *  caller), ci.yml is read as a whole run, as before: stricter, never looser.
 *
 *  ONLY WHEN ci.yml ACTUALLY RAN ON THIS SHA (round-3 review). A PR the Actions
 *  bot merged (automerge-nightly, or the pr-hygiene sweep, both arming with
 *  GITHUB_TOKEN) lands a push that triggers NO workflow, so ci.yml never runs
 *  on that SHA and no required check is ever reported there. Measured: 5 of 15
 *  consecutive main commits. Reading "no backend check" as "building" held
 *  every automatic release until a human-merged commit landed on top. With no
 *  ci.yml run on the head, the required checks are not applicable, exactly as
 *  before ci-release-6: the PR's own required checks gated that merge. */
export function mainState(mainRuns, combinedStatus, checkRuns = null, requiredChecks = REQUIRED_CHECKS) {
  const failing = [];
  const building = [];
  const ciRan = (Array.isArray(mainRuns) ? mainRuns : []).some(
    (r) => r && typeof r === "object" && typeof r.path === "string" && r.path.endsWith("/ci.yml")
  );
  const byChecks = Array.isArray(checkRuns) && ciRan;
  for (const r of Array.isArray(mainRuns) ? mainRuns : []) {
    if (!r || typeof r !== "object") continue;
    if (r.event === "schedule" || r.event === "workflow_dispatch") continue;
    if (typeof r.path === "string" && r.path.endsWith("/release.yml")) continue;
    if (byChecks && typeof r.path === "string" && r.path.endsWith("/ci.yml")) continue;
    if (isInFlight(r)) building.push(r.name);
    else if (isRed(r.conclusion)) failing.push(r.name);
  }
  if (byChecks) {
    for (const name of requiredChecks) {
      // The newest check run of that name (a re-run adds a second one).
      const latest = checkRuns
        .filter((c) => c && c.name === name)
        .sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")) || (b.id ?? 0) - (a.id ?? 0))[0];
      if (!latest) building.push(`${name} (not reported yet)`);
      else if (latest.status !== "completed") building.push(name);
      else if (isRed(latest.conclusion)) failing.push(name);
    }
  }
  const s = combinedStatus && typeof combinedStatus === "object" ? combinedStatus : {};
  if (s.total_count > 0) {
    if (s.state === "failure" || s.state === "error") failing.push("commit status");
    else if (s.state === "pending") building.push("commit status");
  }
  return { state: failing.length ? "red" : building.length ? "building" : "green", failing, building };
}

const sameCommit = (a, b) => {
  const x = String(a ?? "").toLowerCase();
  const y = String(b ?? "").toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

/** Should the trigger dispatch a release now? One decision, with its reason.
 *
 *  Held, in this order, when: a release is already queued or running (release.yml
 *  queues behind it anyway, but two dispatches would ship twice); nothing
 *  release-relevant is waiting; the retry budget is spent; the newest run was
 *  refused at the iOS gate on main's CURRENT head and a check that gate reads
 *  is still red there, or two runs were refused there (the backstop, below);
 *  or main is red or still building. Otherwise dispatch —
 *  which is also how a FAILED release is retried, since its commits are still
 *  waiting.
 *
 *  `runJobs` (issue #745) maps a run id to `{ jobs, iosChecksLog }` for the runs
 *  since the last success (loadRunJobs). A run the iOS gate refused does not
 *  spend the retry budget (releaseRunKind). WHY THE REFUSED-AT-HEAD HOLD: with
 *  refusals no longer counted, a red ios-kit on an unchanged main would be
 *  re-dispatched every two hours for ever, each run refused on sight (the gate
 *  never replaces a check run that exists) while shipping the same commit to
 *  Play again. Re-running the red check in ci.yml, or a new commit on main,
 *  clears it; a superseded run never triggers it.
 *
 *  THE BACKSTOP (PR #1270 review): that hold reads the gate's checks, so it only
 *  covers a refusal caused by a RED check. A gate that keeps refusing on main's
 *  head for any other reason (ios-checks crashes, a token failure, the ci.yml
 *  dispatch POST refused, checks that never appear, a job dying at setup) is
 *  each time "refused", spends no budget, and would be re-dispatched (and
 *  re-uploaded to Play) every two hours without limit. So, whatever the cause
 *  and whatever the checks say now: a SECOND gate refusal on main's current
 *  head since the last success holds. One refusal on a commit earns exactly
 *  one more dispatch of it; a new commit on main, or a success, clears it.
 *  Refusals on commits main has moved past, and superseded runs, never count. */
export function triggerDecision({ runs, commits, bundle, mainRuns, mainStatus, mainChecks = null, runJobs = null }) {
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
  const since = runsSinceSuccess(runs, runJobs);
  const failures = since.filter((x) => x.kind === "failed");
  const atGate = since.filter((x) => x.kind === "refused" || x.kind === "superseded");
  const uncounted = atGate.length
    ? ` (${atGate.length} run(s) since the last success were refused at the iOS gate before any macOS time was spent` +
      `${atGate.some((x) => x.kind === "superseded") ? `, ${atGate.filter((x) => x.kind === "superseded").length} of them superseded by a newer main` : ""}` +
      "; those do not count against the retry budget.)"
    : "";
  if (failures.length >= RETRY_BUDGET) {
    return { dispatch: false, code: "HOLD_RETRY_BUDGET",
      reason: `${failures.length} release runs since the last success failed after the iOS gate; ` +
        `not spending more macOS time until someone looks.${uncounted}` };
  }
  const newest = since[0];
  const head = Array.isArray(commits) && commits.length ? commits[0].sha : null;
  if (newest && newest.kind === "refused" && Array.isArray(mainChecks) && sameCommit(newest.run.head_sha, head)) {
    const byName = Object.fromEntries(RELEASE_REQUIRED_CHECKS.map((n) => [n, latestActionsRun(mainChecks, n)]));
    const gate = releaseChecksVerdict(byName);
    if (gate.done && !gate.ok) {
      return { dispatch: false, code: "HOLD_REFUSED_AT_HEAD",
        reason: `Release run #${newest.run.run_number} was refused at the iOS gate on ${String(head).slice(0, 7)}, ` +
          `still main's head, and a dispatch now would be refused the same way (${gate.message}). ` +
          "Re-run the red check in ci.yml, or land a fix." };
    }
  }
  const refusedAtHead = since.filter((x) => x.kind === "refused" && sameCommit(x.run.head_sha, head));
  if (refusedAtHead.length >= 2) {
    return { dispatch: false, code: "HOLD_REFUSED_AT_HEAD",
      reason: `${refusedAtHead.length} release runs since the last success ` +
        `(${refusedAtHead.map((x) => `#${x.run.run_number}`).join(", ")}) were refused at the iOS gate on ` +
        `${String(head).slice(0, 7)}, still main's head; not dispatching the same commit again, whatever the cause. ` +
        "Read the ios-checks log of the newest one; a new commit on main clears this." };
  }
  const main = mainState(mainRuns, mainStatus, mainChecks);
  if (main.state !== "green") {
    const names = main.state === "red" ? main.failing : main.building;
    return { dispatch: false, code: main.state === "red" ? "HOLD_MAIN_RED" : "HOLD_MAIN_BUILDING",
      reason: `main is ${main.state} (${names.join(", ")}).` };
  }
  return { dispatch: true, code: "DISPATCH",
    reason: `${pending.release.length} release-relevant commit(s) waiting; the oldest is ` +
      `${pending.oldest.sha.slice(0, 7)} from ${pending.oldest.committedAt}.${uncounted}` };
}

/** The trigger's own verdict: its decision, plus whether the WATCHDOG is alive. */
export function triggerVerdict({ runs, commits, bundle, mainRuns, mainStatus, mainChecks = null, runJobs = null, peerWorkflow, peerRuns, now }) {
  const decision = triggerDecision({ runs, commits, bundle, mainRuns, mainStatus, mainChecks, runJobs });
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

/** The `gh` calls that carry out one planned action — the ONE write path for
 *  the sticky issue (CH2-34a). Until it, each workflow turned the plan into
 *  `gh issue` calls with its own `case` block, and a change to one block would
 *  have left the two maintaining the same issue with different semantics.
 *
 *  `reopen` writes the body FIRST: reopening is what notifies, and the person
 *  it notifies should read the current verdict, not last week's. `close` leaves
 *  the red body as it was — the issue's history should say what went wrong — and
 *  says in its comment that it recovered. `close` without `mayClose` is refused:
 *  planIssue never plans it, and a job with no standing to call the gates green
 *  must not be able to close the alarm by any other route either. */
export function issueCommands(plan, { repo, bodyFile, mayClose }) {
  const n = plan.number == null ? null : String(plan.number);
  switch (plan.action) {
    case "create":
      return [["issue", "create", "--repo", repo, "--title", plan.title, "--body-file", bodyFile]];
    case "reopen":
      return [
        ["issue", "edit", n, "--repo", repo, "--body-file", bodyFile],
        ["issue", "reopen", n, "--repo", repo],
      ];
    case "edit":
      return [["issue", "edit", n, "--repo", repo, "--body-file", bodyFile]];
    case "close":
      if (!mayClose) throw new Error("refusing to close the sticky issue from a job that may not close it");
      return [["issue", "close", n, "--repo", repo, "--comment", plan.comment]];
    case "none":
      return [];
    default:
      throw new Error(`unknown issue action '${plan.action}'`);
  }
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

/** The per-run facts release-facts fetched for the trigger (issue #745), as
 *  triggerDecision's `runJobs`: for each run since the last success that did
 *  not succeed, `<dir>/<id>.json` (GET /actions/runs/{id}/jobs) and, for a
 *  refusal at the iOS gate, `<dir>/<id>.ios-checks.log` (that job's log). A
 *  run whose jobs file is missing gets no entry, so it counts as "failed";
 *  a missing log reads as a plain refusal, never as superseded. */
export function loadRunJobs(dir, runs) {
  const out = {};
  for (const { run } of runsSinceSuccess(runs)) {
    const jobsFile = path.join(dir, `${run.id}.json`);
    if (!fs.existsSync(jobsFile)) continue;
    const logFile = path.join(dir, `${run.id}.ios-checks.log`);
    out[String(run.id)] = {
      jobs: listOf(readJson(jobsFile), "jobs"),
      iosChecksLog: fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : null,
    };
  }
  return out;
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

/** `deps.spawnSync` is the seam the suite uses to see the `gh` calls without
 *  making them; the workflows get node's own. */
export async function run(argv, env = process.env, { spawnSync: spawn = spawnSync } = {}) {
  const mode = arg(argv, "--mode");
  const now = arg(argv, "--now", new Date().toISOString());
  const MODES = ["last-success", "latest-completed", "failed-since-success", "gate-refusals", "watch", "trigger", "issue", "self-broken"];
  if (!MODES.includes(mode)) {
    return { code: 2, text: `unknown --mode ${mode} (expected ${MODES.join("|")})\n` };
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
    /* issue #745: which runs' jobs release-facts fetches for the trigger, and
     * then which of those runs' ios-checks logs. Empty output is an answer
     * ("none"), so both exit 0. */
    if (mode === "failed-since-success") {
      const ids = runsSinceSuccess(listOf(readJson(arg(argv, "--runs")), "workflow_runs")).map((x) => x.run.id);
      return { code: 0, text: ids.map((id) => `${id}\n`).join("") };
    }
    if (mode === "gate-refusals") {
      const runJobs = loadRunJobs(arg(argv, "--run-jobs"), listOf(readJson(arg(argv, "--runs")), "workflow_runs"));
      const lines = [];
      for (const [id, facts] of Object.entries(runJobs)) {
        const gate = iosGateRefusal(facts.jobs);
        if (gate && gate.id != null) lines.push(`${id}:${gate.id}\n`);
      }
      return { code: 0, text: lines.join("") };
    }

    if (mode === "self-broken") {
      const verdict = selfBrokenVerdict(listOf(readJson(arg(argv, "--runs")), "workflow_runs"), arg(argv, "--current"));
      const verdictOut = arg(argv, "--verdict-out");
      if (verdictOut) fs.writeFileSync(verdictOut, JSON.stringify(verdict, null, 2) + "\n");
      return { code: 0, text: renderReport(verdict), verdict };
    }

    if (mode === "issue") {
      const verdict = readJson(arg(argv, "--verdict"));
      const mayClose = argv.includes("--may-close");
      const plan = planIssue({ issues: readJson(arg(argv, "--issues")), verdict, mayClose });
      const bodyOut = arg(argv, "--body-out");
      if (bodyOut) fs.writeFileSync(bodyOut, plan.body);
      const actionOut = arg(argv, "--action-out");
      if (actionOut) fs.writeFileSync(actionOut, JSON.stringify(plan, null, 2) + "\n");
      const head = `issue: ${plan.action}${plan.number ? ` #${plan.number}` : ""}`;
      return applyIssue(plan, { argv, env, mayClose, bodyOut, head, spawn });
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
        // issue #745: optional too; without it every failed run counts, as before.
        runJobs: arg(argv, "--run-jobs") ? loadRunJobs(arg(argv, "--run-jobs"), runs) : null,
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

/** `--mode issue`'s second half. DRY RUN BY DEFAULT: without `--apply` it names
 *  the `gh` calls and makes none, so a person running the CLI by hand (or a
 *  test) can never edit the live alarm by accident; the workflows pass
 *  `--apply` explicitly. A `gh` call that fails is exit 1 — the step goes red,
 *  as the shell's `set -e` made it before — and names the call. */
function applyIssue(plan, { argv, env, mayClose, bodyOut, head, spawn }) {
  const repo = arg(argv, "--repo", env.GITHUB_REPOSITORY || null);
  if (!argv.includes("--apply")) {
    const cmds = issueCommands(plan, { repo: repo || "<owner/name>", bodyFile: bodyOut || "<body file>", mayClose });
    const said = cmds.length ? cmds.map((c) => `  gh ${c.join(" ")}`).join("\n") : "  (no gh call)";
    return { code: 0, text: `${head} (dry run: pass --apply to make these calls)\n${said}\n`, plan, commands: cmds };
  }
  if (!repo) return { code: 1, text: "watch-release: --apply needs --repo owner/name (or GITHUB_REPOSITORY)\n", plan };
  let bodyFile = bodyOut;
  let scratch = null;
  if (!bodyFile) {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "release-issue-"));
    bodyFile = path.join(scratch, "body.md");
    fs.writeFileSync(bodyFile, plan.body);
  }
  try {
    const cmds = issueCommands(plan, { repo, bodyFile, mayClose });
    for (const c of cmds) {
      const r = spawn("gh", c, { stdio: "inherit" });
      if (r.error || r.status !== 0) {
        const why = r.error ? r.error.message : `exit ${r.status}`;
        return { code: 1, text: `watch-release: \`gh ${c.slice(0, 2).join(" ")}\` failed (${why}); the issue action '${plan.action}' is incomplete\n`, plan };
      }
    }
    return { code: 0, text: `${head} (applied: ${cmds.length} gh call${cmds.length === 1 ? "" : "s"})\n`, plan, commands: cmds };
  } catch (err) {
    return { code: 1, text: `watch-release: ${err.message}\n`, plan };
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (isEntryScript(import.meta.url)) {
  const { code, text } = await run(process.argv.slice(2));
  process.stdout.write(text);
  process.exit(code);
}
