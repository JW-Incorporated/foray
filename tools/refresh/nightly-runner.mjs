#!/usr/bin/env node
/* nightly-runner — the mechanical halves of the nightly as two commands (#760).
 *
 *   node tools/refresh/nightly-runner.mjs fetch-digest [--ref origin/refresh-digest]
 *                                                      [--out data-local/resolved.json]
 *                                                      [--max-age-hours 12]
 *   node tools/refresh/nightly-runner.mjs finish --date YYYY-MM-DD [--suffix <s>]
 *                                                [--edits data-local/edits.json]
 *                                                [--resolved <path>]
 *                                                [--trailer <line>]...
 *
 * WHY
 * `docs/agents/runner-prompts/foray-nightly.md` asks the agent for seven steps,
 * and exactly ONE of them needs judgement: step 4, authoring `edits.json`. The
 * other six are shell that the agent has to retype every night, and every
 * retyping is a chance to get one load-bearing string wrong — the branch named
 * after today instead of the digest's date (#293 nearly did), a third file in
 * the commit, a PR opened on a red vitest. This file is those six steps as two
 * commands with the strings pinned, so the runner's prompt (OPS-17) shrinks to
 * "run fetch-digest, write edits.json, run finish".
 *
 *   fetch-digest  = prompt steps 1-3: pull the digest from the branch, refuse
 *                   it when stale, stop when empty, report candidates.
 *   finish        = prompt steps 5-7: merge, validate, branch, add exactly two
 *                   files, commit, push, open the PR.
 *
 * EXIT CODES (one per verdict, so a shell can branch on them)
 *   0  DIGEST_OK / PR_OPENED
 *   1  a git/gh call failed, or the digest could not be read
 *   2  usage: unknown command, bad --date, EDITS_MISSING
 *   3  DIGEST_STALE       the Action has not published today — open no PR
 *   4  DIGEST_EMPTY / NOTHING_ADDED   nothing to do — open no PR
 *   5  MERGE_FAILED       merge.mjs refused (copy rules / topics) — fix edits.json
 *   6  TESTS_FAILED       copyRules / poolIntegrity red — fix or drop offenders
 *   7  UNEXPECTED_FILES   the staged set was not exactly the two data files
 *
 * Every git/gh/node call goes through an injected `exec(cmd, args, opts)` with
 * args arrays (default: spawnSync), file I/O through an injected `fs`, and the
 * clock through an injected `now`, so the test suite can pin the ORDER of the
 * calls and the exact strings without a git repo. The one date rule is
 * `digestDate()` from watch-nightly.mjs — the watchdog and the runner must agree
 * on what day a digest belongs to, or `nightly/<date>` matches nothing.
 */

import nodeFs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_THRESHOLD_HOURS, digestDate } from "./watch-nightly.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root, resolved from this file's location (tools/refresh/). */
export const REPO_ROOT = path.resolve(HERE, "..", "..");

export const DEFAULT_REF = "origin/refresh-digest";
export const DEFAULT_OUT = "data-local/resolved.json";
export const DEFAULT_EDITS = "data-local/edits.json";
export const MERGE_SCRIPT = "tools/refresh/merge.mjs";
export const VITEST_ARGS = ["vitest", "run", "test/copyRules.test.ts", "test/poolIntegrity.test.ts"];
/** The ONLY two paths a nightly commit may carry (prompt step 7, issue #701). */
export const NIGHTLY_FILES = ["data/discover.json", "data/item-tags.json"];

export const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  STALE: 3,
  NOTHING: 4,
  MERGE_FAILED: 5,
  TESTS_FAILED: 6,
  UNEXPECTED_FILES: 7,
});

/* ------------------------------------------------------------------ helpers */

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

function argAll(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && i + 1 < argv.length) out.push(argv[i + 1]);
  }
  return out;
}

function nowMs(now) {
  const v = typeof now === "function" ? now() : now;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string") return Date.parse(v);
  return Date.now();
}

/** `npx` is `npx.cmd` on Windows, and Node refuses to spawn a .cmd without a
 *  shell. The args are fixed literals (VITEST_ARGS), so the shell is safe. */
function defaultExec(cmd, args, opts = {}) {
  const win = process.platform === "win32";
  const resolved = win && cmd === "npx" ? "npx.cmd" : cmd;
  const r = spawnSync(resolved, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
    shell: win && /\.(cmd|bat)$/i.test(resolved),
  });
  return {
    status: r.status === null || r.status === undefined ? (r.error ? 127 : 1) : r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error,
  };
}

function output(r) {
  return [r.stdout, r.stderr].filter((s) => s && s.trim()).join("\n");
}

function fail(code, line, extra) {
  const text = extra && extra.trim() ? `${extra.trimEnd()}\n${line}\n` : `${line}\n`;
  return { code, text };
}

/* ------------------------------------------------------------- fetch-digest */

/** Prompt steps 1-3. Returns `{ code, text, digest? }`; never throws. */
export function fetchDigest({
  ref = DEFAULT_REF,
  out = DEFAULT_OUT,
  maxAgeHours = DEFAULT_THRESHOLD_HOURS,
  exec = defaultExec,
  fs = nodeFs,
  now = () => new Date(),
  cwd = REPO_ROOT,
} = {}) {
  const max = Number(maxAgeHours);
  if (!Number.isFinite(max) || max <= 0) {
    return fail(EXIT.USAGE, `BAD_MAX_AGE ${maxAgeHours}`);
  }
  /* `origin/refresh-digest` → fetch `refresh-digest` from `origin`. A ref with
   * no remote prefix is fetched by name from origin. */
  const slash = ref.indexOf("/");
  const remote = slash > 0 ? ref.slice(0, slash) : "origin";
  const branch = slash > 0 ? ref.slice(slash + 1) : ref;

  const fetched = exec("git", ["fetch", remote, branch], { cwd });
  if (fetched.status !== 0) return fail(EXIT.FAILED, `FETCH_FAILED ${remote} ${branch}`, output(fetched));

  const shown = exec("git", ["show", `${ref}:resolved.json`], { cwd });
  if (shown.status !== 0) return fail(EXIT.FAILED, `SHOW_FAILED ${ref}:resolved.json`, output(shown));

  const outPath = path.isAbsolute(out) ? out : path.join(cwd, out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, shown.stdout);

  let digest;
  try {
    digest = JSON.parse(shown.stdout);
  } catch (err) {
    return fail(EXIT.FAILED, `DIGEST_UNREADABLE ${err.message}`);
  }
  const generatedAt = digest && digest.generated_at;
  const date = digestDate(generatedAt);
  if (!date) return fail(EXIT.FAILED, `DIGEST_UNREADABLE generated_at=${JSON.stringify(generatedAt ?? null)}`);

  const ageH = (nowMs(now) - Date.parse(generatedAt)) / 3.6e6;
  const age = ageH.toFixed(1);
  /* Stale FIRST (prompt step 2 runs before step 3): a stale digest is yesterday's
   * whether or not it is empty, and the right answer is "the Action has not run",
   * not "nothing to do". */
  if (ageH > max) {
    return { code: EXIT.STALE, text: `DIGEST_STALE generated_at=${generatedAt} age_h=${age}\n`, digest };
  }
  const resolved = Array.isArray(digest.resolved) ? digest.resolved : [];
  const lines = [];
  if (resolved.length === 0) {
    lines.push(`DIGEST_EMPTY date=${date}`);
  } else {
    lines.push(`DIGEST_OK date=${date} resolved=${resolved.length} age_h=${age}`);
  }
  /* Informational (prompt step 3, S-11): the curation candidates ride along in
   * the same file when the Action emits them. */
  if (Array.isArray(digest.candidates)) lines.push(`CANDIDATES ${digest.candidates.length}`);
  return { code: resolved.length === 0 ? EXIT.NOTHING : EXIT.OK, text: lines.join("\n") + "\n", digest };
}

/* ------------------------------------------------------------------- finish */

export function nightlyBranch(date, suffix) {
  return suffix ? `nightly/${date}-${suffix}` : `nightly/${date}`;
}

export function commitMessage(added, date) {
  return `Nightly refresh: +${added} episodes (${date})`;
}

export function prBody(added, date) {
  return `Automated nightly content refresh. ${added} new episodes from the refresh-digest of ${date}. Copy rules + pool integrity green.`;
}

/** Prompt steps 5-7. Returns `{ code, text, added?, branch?, url? }`; never throws.
 *
 *  The ORDER is the contract: merge → tests → branch → add → check staged →
 *  commit → push → pr. Nothing touches git until merge AND tests are green,
 *  because a red PR is worse than no PR (automerge-nightly.yml would wait on it
 *  forever and the watchdog would count it as "handled"). */
export function finish({
  date,
  suffix = "",
  edits = DEFAULT_EDITS,
  resolved,
  trailers = [],
  exec = defaultExec,
  fs = nodeFs,
  env = process.env,
  cwd = REPO_ROOT,
} = {}) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return fail(EXIT.USAGE, `BAD_DATE ${JSON.stringify(date ?? null)} (expected --date YYYY-MM-DD, the digest's date)`);
  }
  if (suffix && !/^[A-Za-z0-9._-]+$/.test(suffix)) {
    return fail(EXIT.USAGE, `BAD_SUFFIX ${JSON.stringify(suffix)}`);
  }
  const editsPath = path.isAbsolute(edits) ? edits : path.join(cwd, edits);
  /* Before ANYTHING: merge.mjs would crash on a missing edits file, but a crash
   * that reads "ENOENT" is not the message. The runner has not written its one
   * judgement step; say so. */
  if (!fs.existsSync(editsPath)) return fail(EXIT.USAGE, `EDITS_MISSING ${edits}`);

  const mergeEnv = { ...env, EDITS_PATH: editsPath };
  if (resolved) mergeEnv.RESOLVED_PATH = path.isAbsolute(resolved) ? resolved : path.join(cwd, resolved);

  /* 5. merge */
  const merge = exec(process.execPath, [MERGE_SCRIPT], { cwd, env: mergeEnv });
  if (merge.status !== 0) return fail(EXIT.MERGE_FAILED, `MERGE_FAILED exit=${merge.status}`, output(merge));
  if (/^MERGE: 0 items added/m.test(merge.stdout)) {
    return fail(EXIT.NOTHING, "NOTHING_ADDED", merge.stdout);
  }
  const m = /^ADDED (\d+) items\./m.exec(merge.stdout);
  if (!m) return fail(EXIT.MERGE_FAILED, "MERGE_UNPARSED (expected `ADDED N items.`)", output(merge));
  const added = Number(m[1]);

  /* 6. validate */
  const tests = exec("npx", VITEST_ARGS, { cwd: path.join(cwd, "backend"), env });
  if (tests.status !== 0) return fail(EXIT.TESTS_FAILED, `TESTS_FAILED exit=${tests.status}`, output(tests));

  /* 7. branch, add exactly two files, commit, push, pr */
  const branch = nightlyBranch(date, suffix);
  /* Each git step either returns its result or the failure verdict to hand back. */
  const git = (step, args) => {
    const r = exec("git", args, { cwd, env });
    return r.status === 0 ? { r } : { failure: fail(EXIT.FAILED, `GIT_FAILED ${step}`, output(r)) };
  };

  let step = git("switch", ["switch", "-c", branch]);
  if (step.failure) return step.failure;
  step = git("add", ["add", ...NIGHTLY_FILES]);
  if (step.failure) return step.failure;
  step = git("diff", ["diff", "--cached", "--name-only"]);
  if (step.failure) return step.failure;
  const staged = step.r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
  const want = [...NIGHTLY_FILES].sort();
  if (staged.length !== want.length || staged.some((f, i) => f !== want[i])) {
    return fail(EXIT.UNEXPECTED_FILES, `UNEXPECTED_FILES ${staged.join(" ") || "(nothing staged)"}`);
  }
  const message = commitMessage(added, date);
  const commitArgs = ["commit", "-m", message];
  for (const t of trailers) commitArgs.push("--trailer", t);
  step = git("commit", commitArgs);
  if (step.failure) return step.failure;
  step = git("push", ["push", "-u", "origin", "HEAD"]);
  if (step.failure) return step.failure;

  const pr = exec("gh", ["pr", "create", "--base", "main", "--title", message, "--body", prBody(added, date)], { cwd, env });
  if (pr.status !== 0) return fail(EXIT.FAILED, "PR_FAILED", output(pr));
  const url = pr.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  return { code: EXIT.OK, text: `PR_OPENED ${url || ""}\n`, added, branch, url };
}

/* ---------------------------------------------------------------------- CLI */

export const USAGE = `usage:
  nightly-runner fetch-digest [--ref ${DEFAULT_REF}] [--out ${DEFAULT_OUT}] [--max-age-hours ${DEFAULT_THRESHOLD_HOURS}]
  nightly-runner finish --date YYYY-MM-DD [--suffix <s>] [--edits ${DEFAULT_EDITS}] [--resolved <path>] [--trailer <line>]...
`;

export function run(argv, deps = {}) {
  const [command, ...rest] = argv;
  if (command === "fetch-digest") {
    return fetchDigest({
      ref: arg(rest, "--ref", DEFAULT_REF),
      out: arg(rest, "--out", DEFAULT_OUT),
      maxAgeHours: arg(rest, "--max-age-hours", DEFAULT_THRESHOLD_HOURS),
      ...deps,
    });
  }
  if (command === "finish") {
    return finish({
      date: arg(rest, "--date", undefined),
      suffix: arg(rest, "--suffix", ""),
      edits: arg(rest, "--edits", DEFAULT_EDITS),
      resolved: arg(rest, "--resolved", undefined),
      trailers: argAll(rest, "--trailer"),
      ...deps,
    });
  }
  return { code: EXIT.USAGE, text: `UNKNOWN_COMMAND ${command ?? "(none)"}\n${USAGE}` };
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("tools/refresh/nightly-runner.mjs");
if (invokedDirectly) {
  const { code, text } = run(process.argv.slice(2));
  process.stdout.write(text);
  process.exit(code);
}
