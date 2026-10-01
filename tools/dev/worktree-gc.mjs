#!/usr/bin/env node
/* tools/dev/worktree-gc.mjs — classify every registered worktree and remove
 * only the ones whose PR merged and whose tree is clean (OPS-12).
 *
 * WHY THIS EXISTS
 * Every agent lane on the founder's workstation does `git worktree add` and
 * most of them never do the matching `remove`. On 2026-09-25 the main checkout
 * carried 261 registered worktrees; 208 of them were for PRs that had merged
 * long ago, and 47 stray regular files sat directly in `.claude/worktrees/`
 * (a lane's leftover `nul`, patch and log files). Each worktree is a full
 * 1,600-file checkout, so this is disk, memory for every `git status` an IDE
 * runs, and a `git worktree list` nobody can read.
 *
 * WHAT IT DOES
 * Three pure functions and a thin CLI, dry-run by default:
 *   parseWorktreeList  `git worktree list --porcelain` -> entries
 *   classify           entries + facts (PRs, status, existence, ancestry)
 *                      -> one verdict per entry, first match wins
 *   plan               verdicts -> { removeWorktrees, deleteBranches, prune }
 * `run` gathers the facts through an injected `exec` and `fs`, so the tests
 * drive it with canned output and a recording fake; no test runs git.
 *
 * THE RULE IS "ONLY THE MERGED AND CLEAN"
 * A worktree is removed only when its branch has a PR whose state is MERGED
 * and `git status --porcelain` is empty. Everything else is kept and named:
 * an OPEN PR, a CLOSED-unmerged PR (its work may exist nowhere else), a
 * branch with no PR at all, a dirty tree even when its PR merged, and a
 * detached head that is not reachable from `origin/main`, and a tree whose
 * `git status` itself fails (unreadable is not clean). PRs squash-merge
 * here, so "ancestor of origin/main" is useless for branches (only 6 of 246
 * were) — the PR state is the truth. Detached heads have no PR, so for them
 * ancestry IS the test: a detached checkout of a commit that is on main holds
 * nothing.
 *
 * `git worktree remove` is run WITHOUT `--force`. If git refuses (modified or
 * untracked files it saw and we did not), the refusal is printed and the entry
 * is skipped; its branch is then left alone too. Nothing is ever retried with
 * force, and nothing is ever `rm -rf`'d.
 *
 * PR LOOKUP
 * ONE `gh pr list --state all --limit 1000 --json number,state,headRefName`,
 * grouped by `headRefName`. If that ever returns exactly the limit, older PRs
 * may be missing and a merged branch would read as "no PR" and be KEPT — the
 * safe direction — and the tool says so. If gh refuses the call, the run
 * stops with the paging fallback named (`gh api --paginate`).
 *
 * Windows: every process is `spawnSync(cmd, argsArray)`; `gh.exe` on win32;
 * never a shell string, so a path with spaces (`Vibe Coding`) is one argument.
 *
 * `--json`: stdout is exactly one JSON document ({ repo, apply, entries, plan,
 * strayFiles, applied? }); every human line, including the dry-run summary
 * and the --apply log, goes to stderr so the document stays parseable.
 */

import nodeFs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_REPO = "JW-Incorporated/foray";
export const PR_LIST_LIMIT = 1000;
export const STRAY_DIR = ".claude/worktrees";
/** Prefix `run` stores in `statusByPath` when `git status` itself failed: the tree is unreadable, never "clean". */
export const STATUS_UNREADABLE = "!! status unreadable: ";

/** Verdicts in the order the table prints them: what goes first is what --apply touches. */
export const VERDICT_ORDER = [
  "remove",
  "remove-detached",
  "prune",
  "keep-dirty",
  "keep-open-pr",
  "keep-closed-pr",
  "keep-no-pr",
  "keep-detached",
  "keep-main",
];

/* ------------------------------------------------------------- parse */

/**
 * `git worktree list --porcelain` -> [{ path, head, branch, detached, bare, prunable }].
 * Records are separated by blank lines. Lines: `worktree <path>`, `HEAD <sha>`,
 * `branch refs/heads/<name>`, `detached`, `bare`, `prunable <reason>`.
 */
export function parseWorktreeList(porcelainText) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.path) out.push(cur);
    cur = null;
  };
  for (const raw of String(porcelainText ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length), head: null, branch: null, detached: false, bare: false, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
    else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
  }
  flush();
  return out;
}

/* ---------------------------------------------------------- classify */

function short(sha) {
  return sha ? String(sha).slice(0, 7) : "?";
}

function prList(prs, state) {
  return prs.filter((p) => p?.state === state).map((p) => `#${p.number}`);
}

/**
 * entries -> entries.map(e => ({ ...e, verdict, why })), first match wins:
 *   keep-main        index 0
 *   prune            directory missing, or git says prunable
 *   keep-dirty       `git status --porcelain` non-empty
 *   keep-open-pr     any PR OPEN
 *   remove           a branch, some PR MERGED, tree clean
 *   keep-closed-pr   only CLOSED PRs
 *   remove-detached  detached and an ancestor of origin/main
 *   keep-detached    detached, not an ancestor (or unknown)
 *   keep-no-pr       a branch with no PR
 *
 * `prsByBranch[branch]` -> [{ number, state }]; `statusByPath[path]` -> the
 * porcelain status text; `existsByPath[path]` -> boolean; `ancestorByHead[head]`
 * -> boolean. A missing fact is read in the safe direction (keep).
 */
export function classify(entries, { prsByBranch = {}, statusByPath = {}, existsByPath = {}, ancestorByHead = {} } = {}) {
  return entries.map((e, i) => {
    const prs = e.branch ? prsByBranch[e.branch] ?? [] : [];
    const merged = prList(prs, "MERGED");
    const open = prList(prs, "OPEN");
    const closed = prList(prs, "CLOSED");
    const named = merged[0] ?? open[0] ?? closed[0] ?? null;
    const verdict = (v, why) => ({ ...e, verdict: v, why });

    if (i === 0) return verdict("keep-main", "The main working tree is never removed.");
    if (existsByPath[e.path] !== true) {
      return verdict("prune", `Its directory is missing; \`git worktree prune\` drops the registration${named ? ` (${named})` : ""}.`);
    }
    if (e.prunable) return verdict("prune", `git marks it prunable; \`git worktree prune\` drops the registration${named ? ` (${named})` : ""}.`);
    const status = String(statusByPath[e.path] ?? "").trim();
    if (status.startsWith(STATUS_UNREADABLE)) {
      return verdict(
        "keep-dirty",
        `${status.slice(STATUS_UNREADABLE.length)}; a tree whose status cannot be read is never removed${named ? ` even though ${named} ${merged.length ? "merged" : "exists"}` : ""}.`,
      );
    }
    if (status !== "") {
      const n = status.split(/\r?\n/).length;
      return verdict(
        "keep-dirty",
        `${n} uncommitted change${n === 1 ? "" : "s"}; a dirty tree is never removed${named ? ` even though ${named} ${merged.length ? "merged" : "exists"}` : ""}.`,
      );
    }
    if (open.length) return verdict("keep-open-pr", `${open.join(", ")} is OPEN.`);
    if (e.branch && merged.length) return verdict("remove", `${merged.join(", ")} MERGED and the tree is clean.`);
    if (closed.length) return verdict("keep-closed-pr", `${closed.join(", ")} was CLOSED without merging; the work may exist nowhere else.`);
    if (e.detached) {
      if (ancestorByHead[e.head] === true) {
        return verdict("remove-detached", `Detached at ${short(e.head)}, which is an ancestor of origin/main.`);
      }
      return verdict("keep-detached", `Detached at ${short(e.head)}, which is not an ancestor of origin/main.`);
    }
    if (e.branch) return verdict("keep-no-pr", `Branch ${e.branch} has no PR.`);
    return verdict("keep-detached", `No branch at ${short(e.head)}; nothing to judge it by.`);
  });
}

/* -------------------------------------------------------------- plan */

/** classified -> { removeWorktrees, deleteBranches, prune, counts }. Branches only for `remove`. */
export function plan(classified) {
  const counts = {};
  for (const v of VERDICT_ORDER) counts[v] = 0;
  const removeWorktrees = [];
  const deleteBranches = [];
  let prune = false;
  for (const c of classified) {
    counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;
    if (c.verdict === "remove") {
      removeWorktrees.push(c.path);
      if (c.branch) deleteBranches.push(c.branch);
    } else if (c.verdict === "remove-detached") {
      removeWorktrees.push(c.path);
    } else if (c.verdict === "prune") {
      prune = true;
    }
  }
  return { removeWorktrees, deleteBranches, prune, counts };
}

/** Names of REGULAR files directly under `dir`. Never a directory, never anything nested. */
export function strayFiles(dir, fs = nodeFs) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .sort();
}

/* -------------------------------------------------------------- exec */

/** `exec(cmd, args)` -> { status, stdout, stderr }. Throws only when the binary cannot be started. */
export function defaultExec(cmd, args) {
  const bin = cmd === "gh" && process.platform === "win32" ? "gh.exe" : cmd;
  const res = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`could not run ${cmd}: ${res.error.message}`);
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/* --------------------------------------------------------------- CLI */

const USAGE = `usage: node tools/dev/worktree-gc.mjs [--apply] [--json] [--repo owner/name]
  Dry-run by default: classifies every registered worktree and prints what
  --apply would do. --apply removes only the worktrees whose PR MERGED and
  whose tree is clean (plus detached heads already on origin/main), deletes
  those branches, prunes, and deletes stray regular files under ${STRAY_DIR}/.
`;

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function repoFromOrigin(exec) {
  try {
    const r = exec("git", ["remote", "get-url", "origin"]);
    const m = String(r.stdout ?? "")
      .trim()
      .match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

function groupPrs(json) {
  const byBranch = {};
  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error("gh pr list did not return an array");
  for (const p of list) {
    const b = p?.headRefName;
    if (!b) continue;
    (byBranch[b] ??= []).push({ number: p.number, state: p.state });
  }
  return { byBranch, total: list.length };
}

function shortenPath(p, cwd) {
  const norm = (s) => String(s).replace(/\\/g, "/").replace(/\/+$/, "");
  const a = norm(p);
  const c = norm(cwd);
  if (a.toLowerCase() === c.toLowerCase()) return ".";
  if (a.toLowerCase().startsWith(c.toLowerCase() + "/")) return a.slice(c.length + 1);
  return a;
}

export function renderTable(classified, cwd) {
  const rank = (v) => {
    const i = VERDICT_ORDER.indexOf(v);
    return i < 0 ? VERDICT_ORDER.length : i;
  };
  const rows = [...classified].sort((a, b) => rank(a.verdict) - rank(b.verdict) || String(a.path).localeCompare(String(b.path)));
  const cells = rows.map((r) => [r.verdict, r.branch ?? `@${short(r.head)}`, shortenPath(r.path, cwd), r.why]);
  const w = [0, 0, 0];
  for (const c of cells) for (let i = 0; i < 3; i++) w[i] = Math.max(w[i], c[i].length);
  const header = ["VERDICT", "BRANCH", "PATH", "WHY"];
  for (let i = 0; i < 3; i++) w[i] = Math.max(w[i], header[i].length);
  const line = (c) => `${c[0].padEnd(w[0])}  ${c[1].padEnd(w[1])}  ${c[2].padEnd(w[2])}  ${c[3]}`;
  return [line(header), ...cells.map(line)].join("\n") + "\n";
}

function renderCounts(counts, total) {
  const parts = VERDICT_ORDER.filter((v) => counts[v]).map((v) => `${v} ${counts[v]}`);
  return `${total} worktrees: ${parts.join(", ") || "none"}\n`;
}

/**
 * -> { code, out, err }. `exec`, `fs` and `cwd` are injectable; `progress`
 * receives one line per 25 trees so a 300-tree run on a slow disk is not
 * silent (it goes to stderr live, not into `err`).
 */
export function run(argv = [], { exec = defaultExec, fs = nodeFs, cwd = process.cwd(), progress = null } = {}) {
  const apply = argv.includes("--apply");
  const json = argv.includes("--json");
  if (argv.includes("--help") || argv.includes("-h")) return { code: 0, out: USAGE, err: "" };
  for (const a of argv) {
    if (a.startsWith("-") && !["--apply", "--json", "--repo"].includes(a)) {
      return { code: 2, out: "", err: `unknown flag ${a}\n${USAGE}` };
    }
  }
  const repo = argValue(argv, "--repo") ?? repoFromOrigin(exec) ?? DEFAULT_REPO;
  let out = "";
  let err = "";

  // 1. The registered worktrees.
  const wl = exec("git", ["worktree", "list", "--porcelain"]);
  if (wl.status !== 0) return { code: 2, out: "", err: `git worktree list failed (${wl.status}): ${String(wl.stderr).trim()}\n` };
  const entries = parseWorktreeList(wl.stdout);
  if (entries.length === 0) return { code: 2, out: "", err: "git worktree list returned nothing; is this a git checkout?\n" };

  // 2. ONE PR listing, grouped by head branch.
  const pl = exec("gh", ["pr", "list", "--repo", repo, "--state", "all", "--limit", String(PR_LIST_LIMIT), "--json", "number,state,headRefName"]);
  if (pl.status !== 0) {
    return {
      code: 2,
      out: "",
      err:
        `gh pr list --repo ${repo} --state all --limit ${PR_LIST_LIMIT} was refused (${pl.status}): ${String(pl.stderr).trim()}\n` +
        `Nothing changed. Page it instead: gh api --paginate "repos/${repo}/pulls?state=all&per_page=100" and read head.ref.\n`,
    };
  }
  let prs;
  try {
    prs = groupPrs(pl.stdout);
  } catch (e) {
    return { code: 2, out: "", err: `could not read gh pr list output: ${e.message}\n` };
  }
  if (prs.total >= PR_LIST_LIMIT) {
    err += `warning: gh pr list returned ${prs.total} PRs, the limit; older merged branches may read as "no PR" and be kept.\n`;
  }

  // 3. Per-tree facts: existence, status, ancestry for detached heads.
  const existsByPath = {};
  const statusByPath = {};
  const ancestorByHead = {};
  entries.forEach((e, i) => {
    existsByPath[e.path] = fs.existsSync(e.path);
    if (existsByPath[e.path] && !e.prunable) {
      const st = exec("git", ["-C", e.path, "status", "--porcelain"]);
      // A failed status is NOT a clean tree: keep it and say why.
      statusByPath[e.path] =
        st.status === 0 ? st.stdout : `${STATUS_UNREADABLE}git status exited ${st.status}: ${String(st.stderr ?? "").trim().split(/\r?\n/)[0] || "no stderr"}`;
    }
    if (e.detached && e.head && !(e.head in ancestorByHead)) {
      const mb = exec("git", ["merge-base", "--is-ancestor", e.head, "origin/main"]);
      ancestorByHead[e.head] = mb.status === 0;
    }
    if (progress && (i + 1) % 25 === 0) progress(`  …inspected ${i + 1}/${entries.length} worktrees\n`);
  });

  const classified = classify(entries, { prsByBranch: prs.byBranch, statusByPath, existsByPath, ancestorByHead });
  const p = plan(classified);
  const strayDir = path.join(cwd, STRAY_DIR);
  const strays = strayFiles(strayDir, fs);

  // Under --json stdout is ONE JSON document and nothing else; the human lines go to stderr.
  const say = (s) => {
    if (json) err += s;
    else out += s;
  };
  const emitJson = (applied) => {
    out += JSON.stringify({ repo, apply, entries: classified, plan: p, strayFiles: strays, ...(applied ? { applied } : {}) }, null, 2) + "\n";
  };

  if (!json) {
    out += renderTable(classified, cwd);
    out += "\n" + renderCounts(p.counts, classified.length);
    if (strays.length) out += `${strays.length} stray regular file${strays.length === 1 ? "" : "s"} directly under ${STRAY_DIR}/: ${strays.join(", ")}\n`;
  }

  if (!apply) {
    say(
      `Nothing changed. Re-run with --apply to remove ${p.removeWorktrees.length} worktrees, ` +
        `delete ${p.deleteBranches.length} branches, prune, and delete ${strays.length} stray files under ${STRAY_DIR}/.\n`,
    );
    if (json) emitJson(null);
    return { code: 0, out, err };
  }

  // --apply. Only now does a mutating command run, and only on the plan.
  const applied = { removedWorktrees: [], refusedWorktrees: [], deletedBranches: [], keptBranches: [], pruned: false, deletedFiles: [], skippedFiles: [] };
  const failedPaths = new Set();
  const byPath = new Map(classified.map((c) => [c.path, c]));
  for (const wt of p.removeWorktrees) {
    const r = exec("git", ["worktree", "remove", wt]);
    if (r.status === 0) {
      applied.removedWorktrees.push(wt);
      say(`removed worktree ${shortenPath(wt, cwd)}\n`);
    } else {
      failedPaths.add(wt);
      applied.refusedWorktrees.push(wt);
      say(`SKIPPED ${shortenPath(wt, cwd)}: git worktree remove refused (${r.status}): ${String(r.stderr).trim()}\n`);
    }
  }
  const stillCheckedOut = new Set([...failedPaths].map((wt) => byPath.get(wt)?.branch).filter(Boolean));
  for (const b of p.deleteBranches) {
    if (stillCheckedOut.has(b)) {
      applied.keptBranches.push(b);
      say(`kept branch ${b}: its worktree was not removed\n`);
      continue;
    }
    const r = exec("git", ["branch", "-D", b]);
    if (r.status === 0) {
      applied.deletedBranches.push(b);
      say(`deleted branch ${b}\n`);
    } else {
      applied.keptBranches.push(b);
      say(`SKIPPED branch ${b}: git branch -D refused (${r.status}): ${String(r.stderr).trim()}\n`);
    }
  }
  const pr = exec("git", ["worktree", "prune"]);
  applied.pruned = pr.status === 0;
  say(pr.status === 0 ? "pruned\n" : `SKIPPED prune: git worktree prune refused (${pr.status}): ${String(pr.stderr).trim()}\n`);
  for (const name of strays) {
    const f = path.join(strayDir, name);
    try {
      fs.unlinkSync(f);
      applied.deletedFiles.push(name);
      say(`deleted stray file ${STRAY_DIR}/${name}\n`);
    } catch (e) {
      applied.skippedFiles.push(name);
      say(`SKIPPED stray file ${STRAY_DIR}/${name}: ${e.message}\n`);
    }
  }
  say(
    `Done: removed ${p.removeWorktrees.length - failedPaths.size} of ${p.removeWorktrees.length} worktrees` +
      (failedPaths.size ? ` (${failedPaths.size} refused, left alone)` : "") +
      `, deleted ${applied.deletedBranches.length} branches, pruned, deleted ${applied.deletedFiles.length} stray files.\n`,
  );
  if (json) emitJson(applied);
  return { code: failedPaths.size ? 1 : 0, out, err };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { code, out, err } = run(process.argv.slice(2), { progress: (s) => process.stderr.write(s) });
  process.stdout.write(out);
  process.stderr.write(err);
  process.exit(code);
}
