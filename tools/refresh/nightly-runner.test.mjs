/* Tests for the nightly runner (issue #760, OPS-14).
 *   Run: node --test tools/refresh/nightly-runner.test.mjs
 *
 * WHAT THIS SUITE HAS TO PROVE
 * The runner is a sequence of shell calls with a handful of load-bearing
 * strings in them. The failure modes are all ordering and string bugs: a PR
 * opened before vitest ran, a branch named after the day the work was done
 * instead of the digest's date (#293 nearly did this), a third file in the
 * commit, a commit message that counts the digest instead of what merge.mjs
 * actually added. So every test here injects a recording `exec` and asserts the
 * EXACT ordered arg arrays, with `now` pinned to a different day than the
 * digest, and the fake git/merge/vitest scripted to fail at one chosen step.
 *
 * Every test names the one-line mutation that makes it fail. All of them were
 * run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { recoveryBranch } from "./watch-nightly.mjs";
import {
  EXIT,
  MERGE_SCRIPT,
  NIGHTLY_FILES,
  VITEST_ARGS,
  fetchDigest,
  finish,
  nightlyBranch,
  run,
} from "./nightly-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const CLI = path.join(REPO, "tools", "refresh", "nightly-runner.mjs");
/* An absolute fake repo root on either platform (`C:\repo` / `/repo`). */
const CWD = path.resolve(path.sep, "repo");

/* The digest the Action cut on the 14th; the runner wakes up on a LATER day so
 * that any `today` leaking into a branch name or message is visible. */
const DIGEST_AT = "2026-09-14T07:25:38.588Z";
const DIGEST_DATE = "2026-09-14";
const RUN_AT_FRESH = "2026-09-14T09:40:00Z"; // 2.2 h later, same day
const RUN_AT_NEXT_DAY = "2026-09-15T09:40:00Z"; // 26.2 h later

function digestJson({ generated_at = DIGEST_AT, resolved = 40, candidates } = {}) {
  const d = { generated_at, resolved: Array.from({ length: resolved }, (_, i) => ({ id: `ep-${i}` })), dropped: [] };
  if (candidates !== undefined) d.candidates = Array.from({ length: candidates }, (_, i) => ({ id: `c-${i}` }));
  return JSON.stringify(d);
}

/** A recording fs: no disk is touched. */
function fakeFs({ exists = () => true } = {}) {
  const writes = [];
  const mkdirs = [];
  return {
    writes,
    mkdirs,
    existsSync: (p) => exists(p),
    mkdirSync: (p, o) => mkdirs.push([p, o]),
    writeFileSync: (p, data) => writes.push([p, data]),
  };
}

/** A recording exec. `script(cmd, args, call)` returns a partial result for the
 *  call; anything unscripted succeeds with empty output. */
function fakeExec(script = () => ({})) {
  const calls = [];
  const exec = (cmd, args, opts) => {
    const call = { cmd, args: [...args], opts };
    calls.push(call);
    const r = script(cmd, args, call) || {};
    return { status: 0, stdout: "", stderr: "", ...r };
  };
  exec.calls = calls;
  return exec;
}

const is = (call, cmd, ...prefix) => call.cmd === cmd && prefix.every((p, i) => call.args[i] === p);

/** The happy-path script for `finish`: merge adds N, vitest is green, git stages
 *  exactly the two files, gh prints a URL. */
function happyFinish({ added = 17, staged = NIGHTLY_FILES, url = "https://github.com/JW-Incorporated/foray/pull/999" } = {}) {
  return (cmd, args) => {
    if (cmd === process.execPath && args[0] === MERGE_SCRIPT) {
      return { stdout: `MERGE: ok\nADDED ${added} items. built_at=2026-09-15T09:41:00.000Z\n` };
    }
    if (cmd === "git" && args[0] === "diff") return { stdout: staged.join("\n") + "\n" };
    if (cmd === "gh") return { stdout: url + "\n" };
    return {};
  };
}

const EDITS = path.join(CWD, "data-local", "edits.json");

/* ------------------------------------------------------------- fetch-digest */

test("fetch-digest: a fresh digest prints DIGEST_OK with the digest's UTC date and exits 0", () => {
  // Mutation: `digestDate(generatedAt)` -> `digestDate(new Date(nowMs(now)).toISOString())`
  // prints the runner's day; with RUN_AT_FRESH on the same day that survives, so
  // the second assertion below runs the SAME digest from the next morning at a
  // 48 h threshold and demands the 14th again.
  const exec = fakeExec((cmd, args) => (cmd === "git" && args[0] === "show" ? { stdout: digestJson() } : {}));
  const fs = fakeFs();
  const r = fetchDigest({ exec, fs, now: RUN_AT_FRESH, cwd: CWD });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.text, `DIGEST_OK date=${DIGEST_DATE} resolved=40 age_h=2.2\n`);
  // Steps 1 then 1b, nothing else: fetch the branch, show the file.
  assert.deepEqual(
    exec.calls.map((c) => [c.cmd, ...c.args]),
    [
      ["git", "fetch", "origin", "refresh-digest"],
      ["git", "show", "origin/refresh-digest:resolved.json"],
    ],
  );
  // The file lands where step 1 of the prompt put it, byte for byte.
  assert.equal(fs.writes.length, 1);
  assert.equal(fs.writes[0][0], path.join(CWD, "data-local", "resolved.json"));
  assert.equal(fs.writes[0][1], digestJson());
  assert.equal(fs.mkdirs[0][0], path.join(CWD, "data-local"));

  const late = fetchDigest({ exec: fakeExec(() => ({ stdout: digestJson() })), fs: fakeFs(), now: RUN_AT_NEXT_DAY, maxAgeHours: 48, cwd: CWD });
  assert.equal(late.code, EXIT.OK);
  assert.match(late.text, new RegExp(`^DIGEST_OK date=${DIGEST_DATE} `));
});

test("fetch-digest: a digest older than 12 h exits 3 and writes nothing else", () => {
  // Mutation: `ageH > max` -> `ageH > max * 24` (or dropping the branch): the
  // 26 h digest reads as fresh and DIGEST_OK is printed for yesterday's items —
  // the silently skipped night the prompt's step 2 exists to prevent.
  const exec = fakeExec((cmd, args) => (cmd === "git" && args[0] === "show" ? { stdout: digestJson({ candidates: 3 }) } : {}));
  const fs = fakeFs();
  const r = fetchDigest({ exec, fs, now: RUN_AT_NEXT_DAY, cwd: CWD });
  assert.equal(r.code, EXIT.STALE);
  // One line, no CANDIDATES, no DIGEST_OK — the candidates are stale too.
  assert.equal(r.text, `DIGEST_STALE generated_at=${DIGEST_AT} age_h=26.2\n`);
  // The digest itself is still saved for a human to look at; nothing else is.
  assert.equal(fs.writes.length, 1);
  assert.equal(exec.calls.length, 2);
  // Stale wins over empty: an empty, stale digest is "the Action has not run",
  // not "nothing to do".
  const both = fetchDigest({ exec: fakeExec(() => ({ stdout: digestJson({ resolved: 0 }) })), fs: fakeFs(), now: RUN_AT_NEXT_DAY, cwd: CWD });
  assert.equal(both.code, EXIT.STALE);
});

test("fetch-digest: an empty resolved list exits 4", () => {
  // Mutation: `resolved.length === 0` -> `resolved.length < 0`: an empty digest
  // prints DIGEST_OK resolved=0 and the agent goes on to open an empty PR.
  const r = fetchDigest({ exec: fakeExec(() => ({ stdout: digestJson({ resolved: 0 }) })), fs: fakeFs(), now: RUN_AT_FRESH, cwd: CWD });
  assert.equal(r.code, EXIT.NOTHING);
  assert.equal(r.text, `DIGEST_EMPTY date=${DIGEST_DATE}\n`);
});

test("fetch-digest: prints CANDIDATES <n> when the digest carries a candidates array", () => {
  // Mutation: delete the `Array.isArray(digest.candidates)` line: the S-11
  // curation candidates are fetched and never mentioned.
  const r = fetchDigest({ exec: fakeExec(() => ({ stdout: digestJson({ candidates: 5 }) })), fs: fakeFs(), now: RUN_AT_FRESH, cwd: CWD });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.text, `DIGEST_OK date=${DIGEST_DATE} resolved=40 age_h=2.2\nCANDIDATES 5\n`);
  // Absent array → no line at all (not `CANDIDATES 0`).
  const none = fetchDigest({ exec: fakeExec(() => ({ stdout: digestJson() })), fs: fakeFs(), now: RUN_AT_FRESH, cwd: CWD });
  assert.doesNotMatch(none.text, /CANDIDATES/);
});

test("fetch-digest: --ref and --out are honoured and a failed fetch/show stops before writing", () => {
  // Mutation: hardcode `origin/refresh-digest` in the show call: a recovery run
  // pointed at another ref silently reads the wrong digest.
  const exec = fakeExec((cmd, args) => (cmd === "git" && args[0] === "show" ? { stdout: digestJson() } : {}));
  const fs = fakeFs();
  const r = run(["fetch-digest", "--ref", "upstream/other-digest", "--out", "tmp/d.json", "--max-age-hours", "1"], { exec, fs, now: RUN_AT_FRESH, cwd: CWD });
  assert.deepEqual(exec.calls[0].args, ["fetch", "upstream", "other-digest"]);
  assert.deepEqual(exec.calls[1].args, ["show", "upstream/other-digest:resolved.json"]);
  assert.equal(fs.writes[0][0], path.join(CWD, "tmp", "d.json"));
  assert.equal(r.code, EXIT.STALE, "2.2 h is stale against --max-age-hours 1");

  const broken = fakeFs();
  const f = fetchDigest({ exec: fakeExec((cmd, args) => (args[0] === "show" ? { status: 128, stderr: "fatal: path 'resolved.json' does not exist" } : {})), fs: broken, now: RUN_AT_FRESH, cwd: CWD });
  assert.equal(f.code, EXIT.FAILED);
  assert.match(f.text, /SHOW_FAILED/);
  assert.equal(broken.writes.length, 0, "a failed show must not write an empty digest over a good one");
});

/* ------------------------------------------------------------------- finish */

test("finish: merge, tests, branch, add, commit, push, pr — in that order, and the branch is named after the digest date, not today", () => {
  // Mutations (each run): swap the vitest exec below the `git switch`; drop the
  // `git diff --cached` step; build the branch from `new Date()` instead of
  // `--date`. The ordered deepEqual catches all three.
  const exec = fakeExec(happyFinish({ added: 17 }));
  const fs = fakeFs();
  const env = { PATH: "/usr/bin", RESOLVED_PATH: "data-local/resolved.json" };
  const r = finish({ date: DIGEST_DATE, exec, fs, env, now: RUN_AT_NEXT_DAY, cwd: CWD });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.text, "PR_OPENED https://github.com/JW-Incorporated/foray/pull/999\n");
  assert.equal(r.branch, `nightly/${DIGEST_DATE}`);

  const msg = `Nightly refresh: +17 episodes (${DIGEST_DATE})`;
  assert.deepEqual(
    exec.calls.map((c) => [c.cmd, ...c.args]),
    [
      [process.execPath, MERGE_SCRIPT],
      ["npx", ...VITEST_ARGS],
      ["git", "switch", "-c", `nightly/${DIGEST_DATE}`],
      ["git", "add", "data/discover.json", "data/item-tags.json"],
      ["git", "diff", "--cached", "--name-only"],
      ["git", "commit", "-m", msg],
      ["git", "push", "-u", "origin", "HEAD"],
      ["gh", "pr", "create", "--base", "main", "--title", msg, "--body",
        `Automated nightly content refresh. 17 new episodes from the refresh-digest of ${DIGEST_DATE}. Copy rules + pool integrity green.`],
    ],
  );
  // merge.mjs gets the edits path and the caller's RESOLVED_PATH; vitest runs in backend/.
  assert.equal(exec.calls[0].opts.env.EDITS_PATH, EDITS);
  assert.equal(exec.calls[0].opts.env.RESOLVED_PATH, "data-local/resolved.json");
  assert.equal(exec.calls[1].opts.cwd, path.join(CWD, "backend"));
  // Nothing in the whole transcript mentions the day the runner actually ran.
  assert.ok(!JSON.stringify(exec.calls).includes("2026-09-15"), "today's date leaked into a git/gh call");
});

test("finish: a merge failure stops before any git command", () => {
  // Mutation: `if (merge.status !== 0) return ...` deleted: a copy-rule refusal
  // is followed by vitest, a branch, and a commit of whatever was on disk.
  const exec = fakeExec((cmd, args) =>
    cmd === process.execPath && args[0] === MERGE_SCRIPT
      ? { status: 1, stdout: "", stderr: 'copy rule violation: hook ends with "..." (ep-3)' }
      : {},
  );
  const r = finish({ date: DIGEST_DATE, exec, fs: fakeFs(), env: {}, cwd: CWD });
  assert.equal(r.code, EXIT.MERGE_FAILED);
  assert.match(r.text, /copy rule violation/, "merge's own output is surfaced");
  assert.match(r.text, /MERGE_FAILED exit=1$/m);
  assert.equal(exec.calls.length, 1, "nothing after merge ran");
  assert.ok(exec.calls.every((c) => c.cmd !== "git" && c.cmd !== "gh" && c.cmd !== "npx"));
});

test("finish: a third staged file is refused (exit 7) and nothing is committed", () => {
  // Mutation: the exact-set comparison -> `!want.every((f) => staged.includes(f))`
  // ("are my two files in there?"): a stray deploy-manifest.json rides into the
  // commit and `data-and-site` fails the PR (issue #701). (`!==` -> `<` on the
  // length alone is an equivalent mutant: the index-wise `some` still trips on
  // the third entry.)
  const exec = fakeExec(happyFinish({ staged: [...NIGHTLY_FILES, "deploy-manifest.json"] }));
  const r = finish({ date: DIGEST_DATE, exec, fs: fakeFs(), env: {}, cwd: CWD });
  assert.equal(r.code, EXIT.UNEXPECTED_FILES);
  assert.equal(r.text, "UNEXPECTED_FILES data/discover.json data/item-tags.json deploy-manifest.json\n");
  assert.ok(!exec.calls.some((c) => c.cmd === "git" && c.args[0] === "commit"), "no commit");
  assert.ok(!exec.calls.some((c) => c.cmd === "git" && c.args[0] === "push"), "no push");
  assert.ok(!exec.calls.some((c) => c.cmd === "gh"), "no PR");
  // One file missing is just as wrong as one too many.
  const one = finish({ date: DIGEST_DATE, exec: fakeExec(happyFinish({ staged: ["data/discover.json"] })), fs: fakeFs(), env: {}, cwd: CWD });
  assert.equal(one.code, EXIT.UNEXPECTED_FILES);
});

test("finish: a missing edits.json is refused before merge", () => {
  // Mutation: delete the `existsSync` guard: merge.mjs crashes with ENOENT and
  // the exit is 5 MERGE_FAILED, which tells the runner to fix a file it never wrote.
  const exec = fakeExec(happyFinish());
  const r = finish({ date: DIGEST_DATE, exec, fs: fakeFs({ exists: () => false }), env: {}, cwd: CWD });
  assert.equal(r.code, EXIT.USAGE);
  assert.equal(r.text, "EDITS_MISSING data-local/edits.json\n");
  assert.equal(exec.calls.length, 0, "no process was spawned");
  // The guard checks the path that will be forwarded, so `--edits` is honoured.
  const seen = [];
  finish({ date: DIGEST_DATE, edits: "other/edits.json", exec: fakeExec(happyFinish()), fs: fakeFs({ exists: (p) => (seen.push(p), true) }), env: {}, cwd: CWD });
  assert.deepEqual(seen, [path.join(CWD, "other", "edits.json")]);
});

test("finish: the commit message counts what merge.mjs reported", () => {
  // Mutation: `Number(m[1])` -> `resolved.length` (or any constant): the title
  // says +40 when merge skipped 23 already-published items and added 17.
  const exec = fakeExec(happyFinish({ added: 3 }));
  const r = finish({ date: DIGEST_DATE, exec, fs: fakeFs(), env: {}, cwd: CWD });
  assert.equal(r.added, 3);
  const commit = exec.calls.find((c) => c.cmd === "git" && c.args[0] === "commit");
  assert.deepEqual(commit.args, ["commit", "-m", `Nightly refresh: +3 episodes (${DIGEST_DATE})`]);
  const pr = exec.calls.find((c) => c.cmd === "gh");
  assert.equal(pr.args[pr.args.indexOf("--title") + 1], `Nightly refresh: +3 episodes (${DIGEST_DATE})`);
  assert.match(pr.args[pr.args.indexOf("--body") + 1], /^Automated nightly content refresh\. 3 new episodes /);
});

test("finish: `MERGE: 0 items added` exits 4 NOTHING_ADDED and runs no git", () => {
  // Mutation: `/^MERGE: 0 items added/m` -> `/^ADDED 0 items/m`: merge's real
  // nothing-to-do line (merge.mjs:158) is not matched, the ADDED regex fails,
  // and the run dies as MERGE_UNPARSED instead of a clean "nothing to do".
  const exec = fakeExec((cmd, args) =>
    cmd === process.execPath && args[0] === MERGE_SCRIPT ? { stdout: "MERGE: 0 items added (nothing to merge).\n" } : {},
  );
  const r = finish({ date: DIGEST_DATE, exec, fs: fakeFs(), env: {}, cwd: CWD });
  assert.equal(r.code, EXIT.NOTHING);
  assert.match(r.text, /NOTHING_ADDED$/m);
  assert.equal(exec.calls.length, 1);
});

test("finish: red vitest exits 6 before the branch exists", () => {
  // Mutation: move the `git switch` above the vitest exec: a red pool-integrity
  // run leaves the checkout on a half-made nightly/<date> branch.
  const exec = fakeExec((cmd, args) => {
    if (cmd === process.execPath) return { stdout: "ADDED 17 items. built_at=x\n" };
    if (cmd === "npx") return { status: 1, stdout: "FAIL test/poolIntegrity.test.ts > duplicate ids\n" };
    return {};
  });
  const r = finish({ date: DIGEST_DATE, exec, fs: fakeFs(), env: {}, cwd: CWD });
  assert.equal(r.code, EXIT.TESTS_FAILED);
  assert.match(r.text, /duplicate ids/);
  assert.match(r.text, /TESTS_FAILED exit=1$/m);
  assert.deepEqual(exec.calls.map((c) => c.cmd), [process.execPath, "npx"]);
});

test("finish: --suffix names the recovery branch the watchdog is looking for, and --trailer lines reach the commit", () => {
  // Mutation: `nightly/${date}-${suffix}` -> `nightly/${suffix}-${date}`:
  // `--suffix recovery` no longer matches recoveryBranch(), so the overwrite
  // guard in nightly-refresh.yml stays red after a successful recovery (#293).
  assert.equal(nightlyBranch(DIGEST_DATE, "recovery"), recoveryBranch(DIGEST_DATE));
  const exec = fakeExec(happyFinish());
  const trailer = "Co-Authored-By: Claude <noreply@anthropic.com>";
  const r = run(["finish", "--date", DIGEST_DATE, "--suffix", "recovery", "--trailer", trailer, "--trailer", "Claude-Session: https://example.test/s"], { exec, fs: fakeFs(), env: {}, cwd: CWD });
  assert.equal(r.code, EXIT.OK);
  const sw = exec.calls.find((c) => c.cmd === "git" && c.args[0] === "switch");
  assert.deepEqual(sw.args, ["switch", "-c", `nightly/${DIGEST_DATE}-recovery`]);
  const commit = exec.calls.find((c) => c.cmd === "git" && c.args[0] === "commit");
  assert.deepEqual(commit.args, [
    "commit", "-m", `Nightly refresh: +17 episodes (${DIGEST_DATE})`,
    "--trailer", trailer,
    "--trailer", "Claude-Session: https://example.test/s",
  ]);
});

test("finish: a --date that is not YYYY-MM-DD is a usage error before anything runs", () => {
  // Mutation: drop the regex check: `--date today` yields `nightly/today`, which
  // matches no digest and the watchdog never clears.
  for (const bad of [undefined, "today", "2026-9-14", "20260914"]) {
    const exec = fakeExec(happyFinish());
    const r = finish({ date: bad, exec, fs: fakeFs(), env: {}, cwd: CWD });
    assert.equal(r.code, EXIT.USAGE, `date=${bad}`);
    assert.match(r.text, /^BAD_DATE /);
    assert.equal(exec.calls.length, 0);
  }
});

/* ---------------------------------------------------------------------- CLI */

test("CLI: an unknown command exits 2 with usage, and the real script dispatches finish's EDITS_MISSING", () => {
  // Mutation: `return { code: EXIT.USAGE, ... }` -> `EXIT.OK`: a typo'd command
  // reports success and the cron thinks the night was handled.
  const r = run(["fetch"], {});
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.text, /^UNKNOWN_COMMAND fetch\nusage:/);

  // Through the real entry point, with a `--edits` that cannot exist: proves the
  // `invokedDirectly` guard fires, the exit code is the verdict, and nothing was
  // spawned (there is no git state to clean up afterwards).
  let out = "";
  let status = 0;
  try {
    out = execFileSync(process.execPath, [CLI, "finish", "--date", DIGEST_DATE, "--edits", "data-local/definitely-not-here.json"], { cwd: REPO, encoding: "utf8" });
  } catch (err) {
    status = err.status;
    out = err.stdout;
  }
  assert.equal(status, EXIT.USAGE);
  assert.equal(out, "EDITS_MISSING data-local/definitely-not-here.json\n");
});

/* ------------------------------------------------------------------- prompt */

test("the runner prompt calls fetch-digest and finish and names the digest-date rule", () => {
  // Nothing executes the prompt, so this is the only thing that notices when a
  // later edit of docs/agents/runner-prompts/foray-nightly.md drifts back to the
  // hand steps (OPS-17, #760). Mutation: delete `--suffix recovery` from step 2's
  // recovery block — the agent re-cuts a stranded digest and names the branch
  // after today, and the overwrite guard in nightly-refresh.yml stays red.
  const prompt = readFileSync(path.join(REPO, "docs", "agents", "runner-prompts", "foray-nightly.md"), "utf8");
  for (const needle of ["nightly-runner.mjs fetch-digest", "nightly-runner.mjs finish --date", "--suffix recovery"]) {
    assert.ok(prompt.includes(needle), `prompt names ${JSON.stringify(needle)}`);
  }
  // The old hand steps survive only as reference, inside a <details> block: the
  // first mention of the by-hand branch command must come after the first
  // <details>, or an agent following the steps in order would run it.
  const handBranch = prompt.indexOf('git switch -c "nightly/$(date -u +%F)"');
  const firstDetails = prompt.indexOf("<details>");
  assert.ok(firstDetails >= 0, "the prompt has a <details> block");
  assert.ok(handBranch === -1 || handBranch > firstDetails, `hand branch command at ${handBranch} is before the first <details> at ${firstDetails}`);
});
