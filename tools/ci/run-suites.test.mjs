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
  findSuites,
  discoverSuites,
  planSuiteRuns,
  commandsFor,
  formatPlan,
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

test("a dependency-carrying package inherits an outer test script rather than erroring", () => {
  const root = fixture({
    "tools/outer/package.json": pkg({ scripts: { test: "node --test" } }),
    "tools/outer/sub/package.json": pkg({ dependencies: { x: "1" } }),
    "tools/outer/sub/sub.test.mjs": EMPTY_SUITE,
  });
  const plan = planSuiteRuns(root);
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(plan.groups.map((g) => g.dir), ["tools/outer"]);
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
