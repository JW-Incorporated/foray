/**
 * tools/dev/worktree-gc.test.mjs — the worktree collector (OPS-12).
 *
 * Injected data only: a porcelain fixture, a recording `exec` that answers
 * from a table, and a fake `fs`. No test runs git, touches the real
 * `.claude/worktrees/`, or unlinks anything. Each classify test names the
 * mutation that turns it red, because the classifier is an ordered chain of
 * checks and every reordering is a way to remove something that was dirty,
 * open or unknown.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { classify, parseWorktreeList, plan, run, strayFiles } from "./worktree-gc.mjs";

const MAIN = "C:/Users/w/Desktop/Vibe Coding/foray";
const MERGED = `${MAIN}/.claude/worktrees/merged-one`;
const OPEN = `${MAIN}/.claude/worktrees/open-one`;
const DETACHED = "C:/Users/w/AppData/Local/Temp/wt-detached";
const GONE = `${MAIN}/.claude/worktrees/gone`;

const PORCELAIN = [
  `worktree ${MAIN}`,
  "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "branch refs/heads/main",
  "",
  `worktree ${MERGED}`,
  "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "branch refs/heads/feat/merged-one",
  "",
  `worktree ${OPEN}`,
  "HEAD cccccccccccccccccccccccccccccccccccccccc",
  "branch refs/heads/feat/open-one",
  "",
  `worktree ${DETACHED}`,
  "HEAD dddddddddddddddddddddddddddddddddddddddd",
  "detached",
  "",
  `worktree ${GONE}`,
  "HEAD eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "branch refs/heads/feat/gone",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");

/** One entry with the shape parseWorktreeList produces. */
function entry(over = {}) {
  return { path: "/wt/x", head: "f".repeat(40), branch: "feat/x", detached: false, bare: false, prunable: false, ...over };
}

/** [main, candidate] so the candidate is never index 0. */
function pair(candidate, facts = {}) {
  const main = entry({ path: MAIN, branch: "main", head: "a".repeat(40) });
  const existsByPath = { [MAIN]: true, [candidate.path]: true, ...(facts.existsByPath ?? {}) };
  return classify([main, candidate], { ...facts, existsByPath })[1];
}

/* ------------------------------------------------------------ parse */

test("parseWorktreeList: main, a branch worktree, a detached one and a prunable one", () => {
  const got = parseWorktreeList(PORCELAIN);
  assert.equal(got.length, 5);
  assert.deepEqual(got[0], { path: MAIN, head: "a".repeat(40), branch: "main", detached: false, bare: false, prunable: false });
  assert.equal(got[1].branch, "feat/merged-one", "refs/heads/ is stripped");
  assert.equal(got[1].detached, false);
  assert.deepEqual(got[3], { path: DETACHED, head: "d".repeat(40), branch: null, detached: true, bare: false, prunable: false });
  assert.equal(got[4].prunable, true);
  assert.equal(got[4].branch, "feat/gone");
  // CRLF input parses the same (the porcelain may be read through a CRLF pipe on Windows).
  assert.deepEqual(parseWorktreeList(PORCELAIN.replace(/\n/g, "\r\n")), got);
  assert.deepEqual(parseWorktreeList(""), []);
});

/* --------------------------------------------------------- classify */

test("classify: main is kept whatever its state", () => {
  const main = entry({ path: MAIN, branch: "main" });
  const [got] = classify([main], {
    prsByBranch: { main: [{ number: 1, state: "MERGED" }] },
    statusByPath: { [MAIN]: " M file.js\n" },
    existsByPath: { [MAIN]: true },
  });
  assert.equal(got.verdict, "keep-main");
  // Even a missing directory at index 0 is not "prune" — the first entry is the main tree by git's contract.
  const [gone] = classify([main], { existsByPath: {} });
  assert.equal(gone.verdict, "keep-main");
});

test("classify: a dirty tree is kept even with a merged PR", () => {
  // Mutation: swap the keep-dirty and remove checks -> this reads "remove".
  const got = pair(entry(), {
    prsByBranch: { "feat/x": [{ number: 42, state: "MERGED" }] },
    statusByPath: { "/wt/x": "?? scratch.txt\n M src/a.js\n" },
  });
  assert.equal(got.verdict, "keep-dirty");
  assert.match(got.why, /#42/);
  assert.match(got.why, /2 uncommitted changes/);
});

test("classify: a merged, clean branch worktree is removed and its branch deleted", () => {
  const got = pair(entry(), {
    prsByBranch: { "feat/x": [{ number: 42, state: "MERGED" }] },
    statusByPath: { "/wt/x": "" },
  });
  assert.equal(got.verdict, "remove");
  assert.match(got.why, /#42 MERGED/);
  const p = plan([entry({ path: MAIN, verdict: "keep-main" }), got]);
  assert.deepEqual(p.removeWorktrees, ["/wt/x"]);
  assert.deepEqual(p.deleteBranches, ["feat/x"]);
  assert.equal(p.prune, false);
});

test("classify: an open PR is kept, even when an earlier PR on the branch merged", () => {
  const got = pair(entry(), {
    prsByBranch: { "feat/x": [{ number: 40, state: "MERGED" }, { number: 41, state: "OPEN" }] },
  });
  assert.equal(got.verdict, "keep-open-pr");
  assert.match(got.why, /#41 is OPEN/);
});

test("classify: a closed-unmerged PR is kept", () => {
  const got = pair(entry(), { prsByBranch: { "feat/x": [{ number: 7, state: "CLOSED" }] } });
  assert.equal(got.verdict, "keep-closed-pr");
  assert.match(got.why, /#7 was CLOSED without merging/);
});

test("classify: a branch with no PR is kept", () => {
  const got = pair(entry(), { prsByBranch: {} });
  assert.equal(got.verdict, "keep-no-pr");
  assert.match(got.why, /feat\/x has no PR/);
});

test("classify: a missing directory is pruned, and so is one git marks prunable", () => {
  // Mutation: drop the existsByPath check -> the first reads "remove" (its PR merged and status is empty).
  const missing = pair(entry(), {
    prsByBranch: { "feat/x": [{ number: 42, state: "MERGED" }] },
    existsByPath: { "/wt/x": false },
  });
  assert.equal(missing.verdict, "prune");
  assert.match(missing.why, /directory is missing/);
  assert.match(missing.why, /#42/);
  const flagged = pair(entry({ prunable: true }), { prsByBranch: {} });
  assert.equal(flagged.verdict, "prune");
  const p = plan([entry({ path: MAIN, verdict: "keep-main" }), missing, flagged]);
  assert.equal(p.prune, true);
  assert.deepEqual(p.removeWorktrees, [], "prune never removes through git worktree remove");
  assert.deepEqual(p.deleteBranches, []);
});

test("classify: a detached head that is an ancestor of origin/main is removed, otherwise kept", () => {
  const on = pair(entry({ branch: null, detached: true, head: "d".repeat(40) }), { ancestorByHead: { ["d".repeat(40)]: true } });
  assert.equal(on.verdict, "remove-detached");
  assert.match(on.why, /ddddddd, which is an ancestor/);
  const off = pair(entry({ branch: null, detached: true, head: "e".repeat(40) }), { ancestorByHead: { ["e".repeat(40)]: false } });
  assert.equal(off.verdict, "keep-detached");
  const unknown = pair(entry({ branch: null, detached: true, head: "1".repeat(40) }), {});
  assert.equal(unknown.verdict, "keep-detached", "an unknown ancestry reads as keep");
  // A dirty detached tree is kept before ancestry is consulted.
  const dirty = pair(entry({ branch: null, detached: true, head: "d".repeat(40) }), {
    ancestorByHead: { ["d".repeat(40)]: true },
    statusByPath: { "/wt/x": "?? x\n" },
  });
  assert.equal(dirty.verdict, "keep-dirty");
  const p = plan([entry({ path: MAIN, verdict: "keep-main" }), on, off]);
  assert.deepEqual(p.removeWorktrees, ["/wt/x"]);
  assert.deepEqual(p.deleteBranches, [], "remove-detached has no branch to delete");
});

test("plan: counts every verdict and deletes branches only for `remove`", () => {
  const classified = [
    { ...entry({ path: MAIN, branch: "main" }), verdict: "keep-main" },
    { ...entry({ path: "/a", branch: "a" }), verdict: "remove" },
    { ...entry({ path: "/b", branch: "b" }), verdict: "remove" },
    { ...entry({ path: "/c", branch: null, detached: true }), verdict: "remove-detached" },
    { ...entry({ path: "/d", branch: "d" }), verdict: "keep-dirty" },
    { ...entry({ path: "/e", branch: "e" }), verdict: "keep-no-pr" },
  ];
  const p = plan(classified);
  assert.deepEqual(p.removeWorktrees, ["/a", "/b", "/c"]);
  assert.deepEqual(p.deleteBranches, ["a", "b"]);
  assert.equal(p.prune, false);
  assert.equal(p.counts["keep-main"], 1);
  assert.equal(p.counts.remove, 2);
  assert.equal(p.counts["remove-detached"], 1);
  assert.equal(p.counts["keep-dirty"], 1);
  assert.equal(p.counts["keep-no-pr"], 1);
  assert.equal(p.counts.prune, 0);
});

/* ------------------------------------------------------ fake fs/exec */

function dirent(name, isFile) {
  return { name, isFile: () => isFile, isDirectory: () => !isFile };
}

/** A fake fs over a {path: "file" | "dir"} map, recording every mutation. */
function fakeFs(tree) {
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const calls = [];
  return {
    calls,
    existsSync: (p) => norm(p) in tree,
    readdirSync: (dir, opts) => {
      const d = norm(dir);
      const names = Object.keys(tree)
        .filter((k) => k.startsWith(d + "/") && !k.slice(d.length + 1).includes("/"))
        .map((k) => k.slice(d.length + 1));
      return opts?.withFileTypes ? names.map((n) => dirent(n, tree[`${d}/${n}`] === "file")) : names;
    },
    unlinkSync: (p) => {
      calls.push(["unlinkSync", norm(p)]);
    },
    rmSync: (p) => {
      calls.push(["rmSync", norm(p)]);
    },
  };
}

/** A recording exec answering from `answers` ([cmd, ...args] prefix -> result). */
function fakeExec(answers, { failRemove = [] } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(" ");
    for (const [prefix, result] of answers) {
      if (key === prefix || key.startsWith(prefix + " ")) return typeof result === "function" ? result(args) : result;
    }
    if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
      return failRemove.includes(args[2])
        ? { status: 128, stdout: "", stderr: `fatal: '${args[2]}' contains modified or untracked files, use --force to delete it` }
        : { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  exec.calls = calls;
  exec.mutating = () =>
    calls.filter(
      (c) =>
        c[0] === "git" &&
        ((c[1] === "worktree" && (c[2] === "remove" || c[2] === "prune")) || (c[1] === "branch" && c[2] === "-D")),
    );
  return exec;
}

const PRS = JSON.stringify([
  { number: 10, state: "MERGED", headRefName: "feat/merged-one" },
  { number: 11, state: "OPEN", headRefName: "feat/open-one" },
  { number: 12, state: "MERGED", headRefName: "feat/gone" },
]);

function scenario({ failRemove } = {}) {
  const exec = fakeExec(
    [
      ["git worktree list --porcelain", { status: 0, stdout: PORCELAIN, stderr: "" }],
      ["gh pr list", { status: 0, stdout: PRS, stderr: "" }],
      ["git remote get-url origin", { status: 0, stdout: "https://github.com/JW-Incorporated/foray.git\n", stderr: "" }],
      [`git -C ${MERGED} status --porcelain`, { status: 0, stdout: "", stderr: "" }],
      [`git -C ${OPEN} status --porcelain`, { status: 0, stdout: " M a.js\n", stderr: "" }],
      [`git -C ${DETACHED} status --porcelain`, { status: 0, stdout: "", stderr: "" }],
      [`git merge-base --is-ancestor ${"d".repeat(40)} origin/main`, { status: 0, stdout: "", stderr: "" }],
    ],
    { failRemove },
  );
  const strayDir = `${MAIN}/.claude/worktrees`;
  const fs = fakeFs({
    [MAIN]: "dir",
    [MERGED]: "dir",
    [OPEN]: "dir",
    [DETACHED]: "dir",
    [strayDir]: "dir",
    [`${strayDir}/nul`]: "file",
    [`${strayDir}/leftover.patch`]: "file",
    [`${strayDir}/merged-one`]: "dir",
    [`${strayDir}/merged-one/nested.txt`]: "file",
    [`${strayDir}/open-one`]: "dir",
  });
  return { exec, fs, strayDir };
}

/* --------------------------------------------------------------- CLI */

test("CLI dry-run runs no mutating git command and no fs.unlink/rm", () => {
  // Mutation: apply without the flag -> mutating calls and unlinks are recorded.
  const { exec, fs } = scenario();
  const r = run([], { exec, fs, cwd: MAIN });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(exec.mutating(), [], "no worktree remove / branch -D / worktree prune");
  assert.deepEqual(fs.calls, [], "no unlinkSync / rmSync");
  // Exactly one PR listing, with the repo read from origin.
  const prCalls = exec.calls.filter((c) => c[0] === "gh");
  assert.equal(prCalls.length, 1);
  assert.deepEqual(prCalls[0], ["gh", "pr", "list", "--repo", "JW-Incorporated/foray", "--state", "all", "--limit", "1000", "--json", "number,state,headRefName"]);
  // No status call for the missing directory.
  assert.ok(!exec.calls.some((c) => c[0] === "git" && c[1] === "-C" && c[2] === GONE), "status is skipped for a missing dir");
  // The table and the counts.
  assert.match(r.out, /^VERDICT\s+BRANCH\s+PATH\s+WHY/m);
  assert.match(r.out, /^remove\s+feat\/merged-one\s+\.claude\/worktrees\/merged-one\s+#10 MERGED/m);
  assert.match(r.out, /^remove-detached\s+@ddddddd/m);
  assert.match(r.out, /^keep-dirty\s+feat\/open-one/m);
  assert.match(r.out, /^prune\s+feat\/gone/m);
  assert.match(r.out, /^keep-main\s+main\s+\.\s/m);
  assert.match(r.out, /^5 worktrees: remove 1, remove-detached 1, prune 1, keep-dirty 1, keep-main 1$/m);
  assert.match(r.out, /2 stray regular files directly under \.claude\/worktrees\/: leftover\.patch, nul/);
  assert.match(
    r.out,
    /Nothing changed\. Re-run with --apply to remove 2 worktrees, delete 1 branches, prune, and delete 2 stray files under \.claude\/worktrees\/\.\n$/,
  );
});

test("--apply removes only regular files directly under .claude/worktrees/, never a directory or a nested path", () => {
  // Mutation: drop the isFile() check -> merged-one/ and open-one/ are unlinked too.
  const { exec, fs, strayDir } = scenario();
  const r = run(["--apply"], { exec, fs, cwd: MAIN });
  assert.equal(r.code, 0, r.out);
  const unlinks = fs.calls.filter((c) => c[0] === "unlinkSync").map((c) => c[1]);
  assert.deepEqual(unlinks, [`${strayDir}/leftover.patch`, `${strayDir}/nul`]);
  assert.ok(!fs.calls.some((c) => c[0] === "rmSync"), "rmSync is never used");
  assert.ok(!unlinks.some((p) => p.includes("nested.txt")), "nested files are untouched");
});

test("--apply removes the planned worktrees, deletes their branches, prunes, and never touches a keep-*", () => {
  const { exec, fs } = scenario();
  const r = run(["--apply"], { exec, fs, cwd: MAIN });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(exec.mutating(), [
    ["git", "worktree", "remove", MERGED],
    ["git", "worktree", "remove", DETACHED],
    ["git", "branch", "-D", "feat/merged-one"],
    ["git", "worktree", "prune"],
  ]);
  // Mutating calls come AFTER every fact was gathered: the plan is complete before the first remove.
  const firstMutating = exec.calls.findIndex((c) => c[1] === "worktree" && c[2] === "remove");
  const lastStatus = exec.calls.map((c) => c[1] === "-C").lastIndexOf(true);
  assert.ok(firstMutating > lastStatus);
  for (const kept of [MAIN, OPEN, GONE]) {
    assert.ok(!exec.calls.some((c) => c[1] === "worktree" && c[2] === "remove" && c[3] === kept), `never removes ${kept}`);
  }
  assert.ok(!exec.calls.some((c) => c[1] === "branch" && c[2] === "-D" && c[3] === "feat/open-one"));
  assert.ok(!exec.calls.some((c) => c.includes("--force")), "never --force");
  assert.match(r.out, /removed worktree \.claude\/worktrees\/merged-one/);
  assert.match(r.out, /deleted branch feat\/merged-one/);
  assert.match(r.out, /^pruned$/m);
  assert.match(r.out, /Done: removed 2 of 2 worktrees, deleted 1 branches, pruned, deleted 2 stray files\./);
});

test("--apply: a refused `git worktree remove` is printed and skipped, never forced, and its branch is kept", () => {
  const { exec, fs } = scenario({ failRemove: [MERGED] });
  const r = run(["--apply"], { exec, fs, cwd: MAIN });
  assert.equal(r.code, 1, "a refusal is a non-zero exit so the operator looks");
  assert.match(r.out, /SKIPPED \.claude\/worktrees\/merged-one: git worktree remove refused \(128\): fatal: .*contains modified or untracked files/);
  assert.match(r.out, /kept branch feat\/merged-one: its worktree was not removed/);
  assert.equal(exec.calls.filter((c) => c[1] === "worktree" && c[2] === "remove" && c[3] === MERGED).length, 1, "no retry");
  assert.ok(!exec.calls.some((c) => c[1] === "branch" && c[2] === "-D" && c[3] === "feat/merged-one"));
  assert.ok(!exec.calls.some((c) => c.includes("--force")));
  assert.match(r.out, /Done: removed 1 of 2 worktrees \(1 refused, left alone\), deleted 0 branches/);
});

test("--json prints the classified entries, the plan and the stray files as one document", () => {
  // Mutation: append the "Nothing changed." line to stdout under --json -> JSON.parse throws.
  const { exec, fs } = scenario();
  const r = run(["--json"], { exec, fs, cwd: MAIN });
  assert.equal(r.code, 0, r.err);
  const doc = JSON.parse(r.out);
  assert.match(r.err, /^Nothing changed\. Re-run with --apply to remove 2 worktrees/m, "the human summary goes to stderr");
  assert.equal(doc.repo, "JW-Incorporated/foray");
  assert.equal(doc.apply, false);
  assert.equal(doc.applied, undefined, "a dry run reports nothing applied");
  assert.deepEqual(
    doc.entries.map((e) => e.verdict),
    ["keep-main", "remove", "keep-dirty", "remove-detached", "prune"],
  );
  assert.deepEqual(doc.plan.removeWorktrees, [MERGED, DETACHED]);
  assert.deepEqual(doc.plan.deleteBranches, ["feat/merged-one"]);
  assert.equal(doc.plan.prune, true);
  assert.deepEqual(doc.strayFiles, ["leftover.patch", "nul"]);
  assert.deepEqual(exec.mutating(), []);
  assert.deepEqual(fs.calls, []);
});

test("--json --apply: stdout is still one document, now carrying what was applied; the log goes to stderr", () => {
  const { exec, fs } = scenario({ failRemove: [MERGED] });
  const r = run(["--json", "--apply"], { exec, fs, cwd: MAIN });
  assert.equal(r.code, 1);
  const doc = JSON.parse(r.out);
  assert.equal(doc.apply, true);
  assert.deepEqual(doc.applied, {
    removedWorktrees: [DETACHED],
    refusedWorktrees: [MERGED],
    deletedBranches: [],
    keptBranches: ["feat/merged-one"],
    pruned: true,
    deletedFiles: ["leftover.patch", "nul"],
    skippedFiles: [],
  });
  assert.match(r.err, /SKIPPED \.claude\/worktrees\/merged-one: git worktree remove refused/);
  assert.match(r.err, /Done: removed 1 of 2 worktrees \(1 refused, left alone\)/);
});

test("CLI: a tree whose `git status` fails is kept as unreadable, never read as clean and removed", () => {
  // Mutation: store "" for a failed status -> merged-one reads "remove" and --apply removes it.
  const { exec, fs } = scenario();
  const broken = fakeExec([
    [`git -C ${MERGED} status --porcelain`, { status: 128, stdout: "", stderr: "fatal: not a git repository: .git\nmore\n" }],
  ]);
  const routed = (cmd, args) => (cmd === "git" && args[0] === "-C" && args[1] === MERGED ? broken(cmd, args) : exec(cmd, args));
  const dry = run(["--json"], { exec: routed, fs, cwd: MAIN });
  assert.equal(dry.code, 0, dry.err);
  const doc = JSON.parse(dry.out);
  const row = doc.entries.find((e) => e.path === MERGED);
  assert.equal(row.verdict, "keep-dirty");
  assert.match(row.why, /git status exited 128: fatal: not a git repository: \.git; a tree whose status cannot be read is never removed even though #10 merged\./);
  assert.deepEqual(doc.plan.removeWorktrees, [DETACHED]);
  assert.deepEqual(doc.plan.deleteBranches, []);
  const { exec: exec2, fs: fs2 } = scenario();
  const routed2 = (cmd, args) => (cmd === "git" && args[0] === "-C" && args[1] === MERGED ? broken(cmd, args) : exec2(cmd, args));
  const applied = run(["--apply"], { exec: routed2, fs: fs2, cwd: MAIN });
  assert.equal(applied.code, 0, applied.out);
  assert.ok(!exec2.calls.some((c) => c[1] === "worktree" && c[2] === "remove" && c[3] === MERGED), "the unreadable tree is never removed");
  assert.ok(!exec2.calls.some((c) => c[1] === "branch" && c[2] === "-D" && c[3] === "feat/merged-one"));
  assert.match(applied.out, /^keep-dirty\s+feat\/merged-one/m);
});

test("CLI: a refused `gh pr list` stops the run with the paging fallback named, and nothing changes", () => {
  const exec = fakeExec([
    ["git worktree list --porcelain", { status: 0, stdout: PORCELAIN, stderr: "" }],
    ["gh pr list", { status: 1, stdout: "", stderr: "HTTP 403: rate limit" }],
  ]);
  const fs = fakeFs({ [MAIN]: "dir" });
  const r = run(["--apply", "--repo", "owner/name"], { exec, fs, cwd: MAIN });
  assert.equal(r.code, 2);
  assert.match(r.err, /gh pr list --repo owner\/name --state all --limit 1000 was refused \(1\): HTTP 403/);
  assert.match(r.err, /gh api --paginate "repos\/owner\/name\/pulls\?state=all&per_page=100"/);
  assert.deepEqual(exec.mutating(), []);
  assert.deepEqual(fs.calls, []);
  // --repo wins over origin: no remote lookup was needed.
  assert.ok(!exec.calls.some((c) => c[1] === "remote"));
  // And an unknown flag is refused before anything runs.
  const bad = run(["--yes"], { exec: fakeExec([]), fs, cwd: MAIN });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown flag --yes/);
});

/* -------------------------------------------------------- strayFiles */

test("strayFiles: regular files directly under the dir only; a missing dir is empty", () => {
  const dir = "/repo/.claude/worktrees";
  const fs = fakeFs({
    [dir]: "dir",
    [`${dir}/b.log`]: "file",
    [`${dir}/a.patch`]: "file",
    [`${dir}/lane`]: "dir",
    [`${dir}/lane/deep.txt`]: "file",
  });
  assert.deepEqual(strayFiles(dir, fs), ["a.patch", "b.log"]);
  assert.deepEqual(strayFiles("/repo/.claude/nope", fs), []);
  assert.deepEqual(fs.calls, []);
  // path.join is what run() uses to build the dir; a Windows cwd still lands under .claude/worktrees.
  assert.ok(path.join(MAIN, ".claude/worktrees").replace(/\\/g, "/").endsWith("/.claude/worktrees"));
});
