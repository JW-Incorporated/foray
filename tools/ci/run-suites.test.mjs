/* Tests for the CI suite runner (issue #140).
 *
 * The runner decides what CI executes, so a bug here is invisible in the worst
 * way: suites silently not running while the build stays green. Everything
 * below works on fixture trees in a temp directory — no network, no installs,
 * nothing spawned. The two tests that touch the real repo only READ the plan.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REPO_ROOT,
  SCANNED_DIRS,
  SUITE_RE,
  ANCHOR_SUITES,
  findSuites,
  discoverSuites,
  planSuiteRuns,
  commandsFor,
  formatPlan,
  missingAnchors,
  exitStatusOf,
  runPlan,
  runCli,
} from "./run-suites.mjs";

/* --- fixture helpers ------------------------------------------------- */

/** Build a throwaway tree from a { "rel/path": "contents" } map. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-run-suites-"));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return root;
}

const EMPTY_SUITE = "// fixture, never executed\n";
const pkg = (obj) => JSON.stringify(obj, null, 2);

/* --- discovery -------------------------------------------------------- */

test("discovery matches the same extensions as the floor check", () => {
  for (const name of ["a.test.js", "a.test.mjs", "a.test.cjs"]) {
    assert.ok(SUITE_RE.test(name), `${name} should be a suite`);
  }
  for (const name of ["a.js", "a.mjs", "test.js", "a.test.ts", "a.testmjs"]) {
    assert.ok(!SUITE_RE.test(name), `${name} should not be a suite`);
  }
});

test("scans the same trees the floor check scans", () => {
  assert.deepStrictEqual(SCANNED_DIRS, ["player", "test", "tools"]);
});

test("findSuites recurses into subdirectories — the whole point of #140", () => {
  const root = fixture({
    "tools/refresh/dai.test.mjs": EMPTY_SUITE,
    "tools/brandnew/deep/nested/thing.test.mjs": EMPTY_SUITE,
  });
  assert.deepStrictEqual(findSuites(root, "tools"), [
    "tools/brandnew/deep/nested/thing.test.mjs",
    "tools/refresh/dai.test.mjs",
  ]);
});

test("findSuites ignores non-suite files", () => {
  const root = fixture({
    "tools/a/helper.mjs": EMPTY_SUITE,
    "tools/a/README.md": "",
    "tools/a/fixtures.test.json": "{}",
    "tools/a/real.test.mjs": EMPTY_SUITE,
  });
  assert.deepStrictEqual(findSuites(root, "tools"), ["tools/a/real.test.mjs"]);
});

test("findSuites skips node_modules and dot-directories", () => {
  const root = fixture({
    "tools/a/node_modules/dep/dep.test.mjs": EMPTY_SUITE,
    "tools/a/.cache/stale.test.mjs": EMPTY_SUITE,
    "tools/a/mine.test.mjs": EMPTY_SUITE,
  });
  assert.deepStrictEqual(findSuites(root, "tools"), ["tools/a/mine.test.mjs"]);
});

test("a scanned tree that does not exist yet is not an error", () => {
  const root = fixture({ "test/only.test.js": EMPTY_SUITE });
  assert.deepStrictEqual(findSuites(root, "tools"), []);
  assert.deepStrictEqual(discoverSuites(root), ["test/only.test.js"]);
});

test("discoverSuites returns repo-relative POSIX paths, sorted", () => {
  const root = fixture({
    "tools/z/z.test.mjs": EMPTY_SUITE,
    "player/a.test.js": EMPTY_SUITE,
    "tools/a/a.test.mjs": EMPTY_SUITE,
  });
  const found = discoverSuites(root);
  assert.deepStrictEqual(found, [
    "player/a.test.js",
    "tools/a/a.test.mjs",
    "tools/z/z.test.mjs",
  ]);
  assert.ok(!found.some((f) => f.includes("\\")), "no backslashes in plan paths");
});

/* --- grouping --------------------------------------------------------- */

test("suites with no package.json above them go in the root group", () => {
  const root = fixture({
    "tools/segments/merge.test.mjs": EMPTY_SUITE,
    "test/app.test.js": EMPTY_SUITE,
  });
  const plan = planSuiteRuns(root);
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.groups.length, 1);
  assert.strictEqual(plan.groups[0].kind, "root");
  assert.deepStrictEqual(plan.groups[0].suites, [
    "test/app.test.js",
    "tools/segments/merge.test.mjs",
  ]);
  assert.strictEqual(plan.groups[0].install, null);
});

test("a marker package.json (no deps, no test script) does not make a group", () => {
  // This is player/package.json: it exists only to set "type": "module".
  const root = fixture({
    "player/package.json": pkg({ type: "module" }),
    "player/queue.test.js": EMPTY_SUITE,
  });
  const plan = planSuiteRuns(root);
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(plan.groups.map((g) => g.kind), ["root"]);
  assert.deepStrictEqual(plan.groups[0].suites, ["player/queue.test.js"]);
});

test("a package declaring a test script owns its suites", () => {
  const root = fixture({
    "tools/corpusish/package.json": pkg({
      dependencies: { linkedom: "^0.18.0" },
      scripts: { test: "node --experimental-sqlite --test" },
    }),
    "tools/corpusish/package-lock.json": "{}",
    "tools/corpusish/db.test.mjs": EMPTY_SUITE,
    "tools/plain/plain.test.mjs": EMPTY_SUITE,
  });
  const plan = planSuiteRuns(root);
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(
    plan.groups.map((g) => [g.kind, g.dir]),
    [
      ["root", "."],
      ["package", "tools/corpusish"],
    ]
  );
  assert.deepStrictEqual(plan.groups[1].suites, ["tools/corpusish/db.test.mjs"]);
  assert.strictEqual(plan.groups[1].install, "ci");
});

test("a lockfile picks npm ci; its absence picks npm install", () => {
  const withLock = fixture({
    "tools/a/package.json": pkg({ dependencies: { x: "1" }, scripts: { test: "node --test" } }),
    "tools/a/package-lock.json": "{}",
    "tools/a/a.test.mjs": EMPTY_SUITE,
  });
  const noLock = fixture({
    "tools/a/package.json": pkg({ dependencies: { x: "1" }, scripts: { test: "node --test" } }),
    "tools/a/a.test.mjs": EMPTY_SUITE,
  });
  assert.strictEqual(planSuiteRuns(withLock).groups[0].install, "ci");
  assert.strictEqual(planSuiteRuns(noLock).groups[0].install, "install");
});

test("a dependency-free package with a test script is run, not installed", () => {
  const root = fixture({
    "tools/a/package.json": pkg({ scripts: { test: "node --experimental-vm-modules --test" } }),
    "tools/a/a.test.mjs": EMPTY_SUITE,
  });
  const plan = planSuiteRuns(root);
  assert.strictEqual(plan.groups[0].install, null);
  assert.deepStrictEqual(commandsFor(plan.groups[0]).steps, [
    { cmd: "npm", args: ["test", "--", "a.test.mjs"] },
  ]);
});

test("the nearest package with a test script wins", () => {
  const root = fixture({
    "tools/outer/package.json": pkg({ scripts: { test: "node --test" } }),
    "tools/outer/outer.test.mjs": EMPTY_SUITE,
    "tools/outer/inner/package.json": pkg({ scripts: { test: "node --test" } }),
    "tools/outer/inner/inner.test.mjs": EMPTY_SUITE,
  });
  const plan = planSuiteRuns(root);
  const byDir = Object.fromEntries(plan.groups.map((g) => [g.dir, g.suites]));
  assert.deepStrictEqual(byDir["tools/outer"], ["tools/outer/outer.test.mjs"]);
  assert.deepStrictEqual(byDir["tools/outer/inner"], ["tools/outer/inner/inner.test.mjs"]);
});

test("a package with deps but no test script is a loud error, not a skip", () => {
  // tools/corpus/embed/ is exactly this shape today (373MB quarantine, no test
  // script). Running its suites from the root would fail on missing deps;
  // skipping them would be the #140 bug all over again.
  const root = fixture({
    "tools/quarantine/package.json": pkg({ dependencies: { huge: "1" } }),
    "tools/quarantine/heavy.test.mjs": EMPTY_SUITE,
  });
  const plan = planSuiteRuns(root);
  assert.strictEqual(plan.groups.length, 0);
  assert.strictEqual(plan.errors.length, 1);
  assert.match(plan.errors[0], /tools\/quarantine\/heavy\.test\.mjs/);
  assert.match(plan.errors[0], /"test" script/);
});

test("it stays an error when an OUTER package has a test script", () => {
  // The literal shape of tools/corpus/embed/ inside tools/corpus. Inheriting
  // the outer plan would run the suite under the outer package's `npm ci`,
  // which never installs the inner package's dependencies — a confusing red
  // that blames the suite instead of the plan.
  const root = fixture({
    "tools/outer/package.json": pkg({ dependencies: { y: "1" }, scripts: { test: "node --test" } }),
    "tools/outer/sub/package.json": pkg({ dependencies: { x: "1" } }),
    "tools/outer/sub/sub.test.mjs": EMPTY_SUITE,
  });
  const plan = planSuiteRuns(root);
  assert.strictEqual(plan.errors.length, 1);
  assert.match(plan.errors[0], /tools\/outer\/sub\/package\.json/);
  assert.match(plan.errors[0], /dependencies uninstalled/);
  assert.strictEqual(plan.groups.length, 0, "the suite is not planned under the outer package");
});

test("a nested package with NO dependencies still inherits the outer test script", () => {
  // Nothing to install, so nothing to get wrong: a marker package.json deep in
  // a tree must not become an error.
  const root = fixture({
    "tools/outer/package.json": pkg({ scripts: { test: "node --test" } }),
    "tools/outer/sub/package.json": pkg({ type: "module" }),
    "tools/outer/sub/sub.test.mjs": EMPTY_SUITE,
  });
  const plan = planSuiteRuns(root);
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(plan.groups.map((g) => g.dir), ["tools/outer"]);
});

test("optional and peer dependencies also require an install", () => {
  // A package declaring only these still needs node_modules before its suites
  // can import anything; install:null would run them against nothing.
  for (const field of ["optionalDependencies", "peerDependencies"]) {
    const root = fixture({
      "tools/a/package.json": pkg({ [field]: { x: "1" }, scripts: { test: "node --test" } }),
      "tools/a/a.test.mjs": EMPTY_SUITE,
    });
    assert.strictEqual(planSuiteRuns(root).groups[0].install, "install", field);
  }
});

test("every discovered suite lands in exactly one group", () => {
  const root = fixture({
    "player/package.json": pkg({ type: "module" }),
    "player/p.test.js": EMPTY_SUITE,
    "test/t.test.js": EMPTY_SUITE,
    "tools/refresh/r.test.mjs": EMPTY_SUITE,
    "tools/corpusish/package.json": pkg({ dependencies: { x: "1" }, scripts: { test: "node --test" } }),
    "tools/corpusish/c.test.mjs": EMPTY_SUITE,
  });
  const plan = planSuiteRuns(root);
  const planned = plan.groups.flatMap((g) => g.suites).sort();
  assert.deepStrictEqual(planned, plan.suites);
  assert.strictEqual(new Set(planned).size, planned.length, "no suite runs twice");
});

test("an unparseable package.json stops the line instead of being ignored", () => {
  const root = fixture({
    "tools/a/package.json": "{ not json",
    "tools/a/a.test.mjs": EMPTY_SUITE,
  });
  assert.throws(() => planSuiteRuns(root), /cannot parse/);
});

/* --- commands --------------------------------------------------------- */

test("the root group runs node --test with explicit paths, not a glob", () => {
  const root = fixture({
    "test/a.test.js": EMPTY_SUITE,
    "tools/refresh/b.test.mjs": EMPTY_SUITE,
  });
  const { cwd, steps } = commandsFor(planSuiteRuns(root).groups[0]);
  assert.strictEqual(cwd, ".");
  assert.deepStrictEqual(steps, [
    { cmd: "node", args: ["--test", "test/a.test.js", "tools/refresh/b.test.mjs"] },
  ]);
  // No wildcards anywhere: a pattern that stops matching fails silently green.
  assert.ok(!steps[0].args.some((a) => a.includes("*")));
});

test("a package group installs then runs npm test with package-relative paths", () => {
  const root = fixture({
    "tools/corpusish/package.json": pkg({ dependencies: { x: "1" }, scripts: { test: "node --test" } }),
    "tools/corpusish/package-lock.json": "{}",
    "tools/corpusish/a.test.mjs": EMPTY_SUITE,
    "tools/corpusish/nested/b.test.mjs": EMPTY_SUITE,
  });
  const group = planSuiteRuns(root).groups[0];
  const { cwd, steps } = commandsFor(group);
  assert.strictEqual(cwd, "tools/corpusish");
  assert.deepStrictEqual(steps, [
    { cmd: "npm", args: ["ci"] },
    { cmd: "npm", args: ["test", "--", "a.test.mjs", "nested/b.test.mjs"] },
  ]);
});

test("formatPlan names every group and command", () => {
  const root = fixture({
    "test/a.test.js": EMPTY_SUITE,
    "tools/corpusish/package.json": pkg({ dependencies: { x: "1" }, scripts: { test: "node --test" } }),
    "tools/corpusish/package-lock.json": "{}",
    "tools/corpusish/b.test.mjs": EMPTY_SUITE,
  });
  const text = formatPlan(planSuiteRuns(root));
  assert.match(text, /2 suite\(s\) in 2 group\(s\)/);
  assert.match(text, /tools\/corpusish \(package, 1 suite\(s\)\)/);
  assert.match(text, /npm ci/);
});

/* --- the anchor guard: discovery cannot narrow itself out of its checks --- */

test("an empty plan is a failure, not a green run of nothing", () => {
  // Without this, `0 suite(s) ... All 0 suite(s) passed. EXIT 0` — CI green
  // having executed nothing. The realistic trigger is a wrong REPO_ROOT after
  // this file moves, not malice.
  const root = fixture({ "README.md": "" });
  const err = [];
  const code = runCli([], { root, log: () => {}, err: (m) => err.push(m), spawn: () => 0 });
  assert.strictEqual(code, 1);
  assert.match(err.join("\n"), /Discovery is broken/);
});

test("a plan that drops the suites verifying discovery is refused", () => {
  // SCANNED_DIRS narrowed to ["player"] against the real repo: 4 suites run,
  // 21 vanish, and neither the floor check nor this file is in the plan to
  // notice. The anchors are what make that loud.
  const plan = { suites: ["player/queue-state.test.js"], groups: [], errors: [] };
  assert.deepStrictEqual(missingAnchors(plan), ANCHOR_SUITES);
  const err = [];
  const code = runCli([], {
    root: fixture({ "player/queue-state.test.js": EMPTY_SUITE }),
    log: () => {},
    err: (m) => err.push(m),
    spawn: () => 0,
  });
  assert.strictEqual(code, 1);
  assert.match(err.join("\n"), /test\/suite-integrity\.test\.js/);
});

test("the real repo's plan contains both anchors", () => {
  assert.deepStrictEqual(missingAnchors(planSuiteRuns(REPO_ROOT)), []);
});

/* --- exit status: the only logic whose bug is "green when it failed" ---- */

test("exitStatusOf treats a signal kill and a launch failure as failures", () => {
  assert.strictEqual(exitStatusOf({ status: 0 }), 0);
  assert.strictEqual(exitStatusOf({ status: 1 }), 1);
  assert.strictEqual(exitStatusOf({ status: null }), 1, "SIGKILL must not read as pass");
  assert.strictEqual(exitStatusOf({ error: new Error("ENOENT") }), 1);
});

/** A plan with a root group and a package group, for the runPlan tests. */
function twoGroupPlan() {
  const root = fixture({
    "test/a.test.js": EMPTY_SUITE,
    "tools/corpusish/package.json": pkg({ dependencies: { x: "1" }, scripts: { test: "node --test" } }),
    "tools/corpusish/package-lock.json": "{}",
    "tools/corpusish/b.test.mjs": EMPTY_SUITE,
  });
  return planSuiteRuns(root);
}

test("runPlan reports nothing when every step passes", () => {
  const seen = [];
  const failed = runPlan(twoGroupPlan(), {
    log: () => {},
    spawn: ({ step }) => (seen.push(`${step.cmd} ${step.args[0]}`), 0),
  });
  assert.deepStrictEqual(failed, []);
  assert.deepStrictEqual(seen, ["node --test", "npm ci", "npm test"]);
});

test("a failing group does not hide the state of the next one", () => {
  const failed = runPlan(twoGroupPlan(), { log: () => {}, spawn: () => 1 });
  assert.deepStrictEqual(failed, [".: node --test", "tools/corpusish: npm ci"]);
});

test("a failed install abandons that group's tests but not the whole run", () => {
  const seen = [];
  const failed = runPlan(twoGroupPlan(), {
    log: () => {},
    spawn: ({ step }) => {
      seen.push(`${step.cmd} ${step.args[0]}`);
      return step.args[0] === "ci" ? 1 : 0;
    },
  });
  assert.deepStrictEqual(seen, ["node --test", "npm ci"], "npm test is not run after a failed ci");
  assert.deepStrictEqual(failed, ["tools/corpusish: npm ci"]);
});

test("--skip-install skips installs and never the test step", () => {
  const seen = [];
  const failed = runPlan(twoGroupPlan(), {
    log: () => {},
    skipInstall: true,
    spawn: ({ step }) => (seen.push(`${step.cmd} ${step.args[0]}`), 0),
  });
  assert.deepStrictEqual(seen, ["node --test", "npm test"]);
  assert.deepStrictEqual(failed, []);
});

/* --- CLI ---------------------------------------------------------------- */

test("a failing run exits non-zero", () => {
  const code = runCli([], {
    root: REPO_ROOT,
    log: () => {},
    err: () => {},
    spawn: () => 1,
  });
  assert.strictEqual(code, 1);
});

test("--list runs nothing", () => {
  let spawned = 0;
  const code = runCli(["--list"], {
    root: REPO_ROOT,
    log: () => {},
    err: () => {},
    spawn: () => (spawned++, 0),
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(spawned, 0);
});

test("an unrecognised flag is refused, not ignored", () => {
  // `--lst` must not quietly run everything for real.
  let spawned = 0;
  const err = [];
  const code = runCli(["--lst"], {
    root: REPO_ROOT,
    log: () => {},
    err: (m) => err.push(m),
    spawn: () => (spawned++, 0),
  });
  assert.strictEqual(code, 2);
  assert.strictEqual(spawned, 0);
  assert.match(err.join("\n"), /unknown option\(s\): --lst/);
});

test("a plan with errors refuses to run anything", () => {
  let spawned = 0;
  const root = fixture({
    "tools/quarantine/package.json": pkg({ dependencies: { huge: "1" } }),
    "tools/quarantine/heavy.test.mjs": EMPTY_SUITE,
    "test/suite-integrity.test.js": EMPTY_SUITE,
    "tools/ci/run-suites.test.mjs": EMPTY_SUITE,
  });
  const code = runCli([], {
    root,
    log: () => {},
    err: () => {},
    spawn: () => (spawned++, 0),
  });
  assert.strictEqual(code, 1);
  assert.strictEqual(spawned, 0, "a suite the runner cannot place stops the whole run");
});

/* --- against the real repo -------------------------------------------- */

test("the real repo plans every suite it has, with no errors", () => {
  const plan = planSuiteRuns(REPO_ROOT);
  assert.deepStrictEqual(plan.errors, []);
  const planned = plan.groups.flatMap((g) => g.suites).sort();
  assert.deepStrictEqual(planned, discoverSuites(REPO_ROOT));
  assert.ok(planned.includes("test/suite-integrity.test.js"), "the floor check must itself run");
  assert.ok(planned.includes("tools/ci/run-suites.test.mjs"), "this suite must itself run");
});

test("tools/corpus is planned as its own package, install included", () => {
  // The dependency-carrying case, derived rather than hardcoded: nothing in
  // run-suites.mjs names tools/corpus, so this is the plan reacting to the
  // package.json that is actually on disk.
  const group = planSuiteRuns(REPO_ROOT).groups.find((g) => g.dir === "tools/corpus");
  assert.ok(group, "tools/corpus should be its own group");
  assert.strictEqual(group.install, "ci");
  assert.ok(group.suites.length >= 12, `expected the corpus suites, got ${group.suites.length}`);
  const { steps } = commandsFor(group);
  assert.deepStrictEqual(steps[0], { cmd: "npm", args: ["ci"] });
  assert.ok(steps[1].args.every((a) => !a.startsWith("tools/")), "paths are package-relative");
});
