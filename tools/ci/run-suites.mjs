#!/usr/bin/env node
/* Run every committed test suite. One command, no list to maintain.
 *
 * WHY THIS EXISTS (issue #140)
 * CI used to name each suite directory in its own `ci.yml` step:
 *
 *     node --test "test/*.test.js"
 *     node --test "tools/refresh/*.test.mjs"
 *     node --test "tools/segments/*.test.mjs"        ... and so on
 *
 * Those are single-directory globs, so coverage was opt-in per directory: a
 * suite landing in a NEW `tools/<dir>/` ran nowhere until someone remembered to
 * add a step. Meanwhile `test/suite-integrity.test.js` scans `tools/`
 * RECURSIVELY, so that same suite would immediately be floored — protected from
 * deletion while never executing. A floor on an unrun suite is worse than no
 * floor: it reads as coverage and is not. (Nothing was actually dark when this
 * landed — every directory had been wired up by hand as it appeared. This
 * removes the hand.)
 *
 * WHY NOT JUST `node --test "tools/**\/*.test.mjs"`
 * Two reasons.
 *
 * 1. `tools/corpus/` carries its own package.json with real dependencies and
 *    needs `--experimental-sqlite` on CI's Node 22. A blanket recursive glob
 *    from the repo root sweeps those files in with no node_modules and no flag,
 *    and fails. The obvious patch — recursive glob plus a hardcoded exception
 *    for `tools/corpus` — reintroduces the exact "someone has to remember"
 *    failure the moment a SECOND dependency-carrying directory appears.
 * 2. A glob that stops matching fails silently and GREEN, which is the same
 *    class of bug as the one being fixed. This script passes explicit file
 *    paths and asserts, from `suite-integrity`, that the set it will run equals
 *    the set on disk. There is no pattern left to silently under-match.
 *
 * HOW IT WORKS
 * Discovery is deliberately identical to `test/suite-integrity.test.js`: the
 * same scanned trees (`player`, `test`, `tools`), the same suite regex, the
 * same node_modules/dotdir skips. Suites are then grouped by which package owns
 * them:
 *
 *   - No package.json above them (below the repo root)  -> the ROOT group, run
 *     as `node --test <files>` from the repo root. The root stays
 *     dependency-free, so nothing to install.
 *   - Under a package.json that declares a `test` script -> that package's own
 *     group. The runner installs there (`npm ci` when a lockfile exists, else
 *     `npm install`) and runs `npm test -- <files>`. The PACKAGE declares how
 *     its suites run, including any flags: `tools/corpus/package.json` carries
 *     `--experimental-sqlite` because node:sqlite is flagged on Node 22.x.
 *     Nothing about `tools/corpus` is named here — the next
 *     dependency-carrying directory works the same day it lands, unedited.
 *   - Under a package.json that declares dependencies but NO `test` script ->
 *     a hard error naming the file. That is the one case the runner genuinely
 *     cannot guess, and it must be loud rather than run the suite from the root
 *     with its dependencies missing (or, worse, skip it).
 *
 * A package.json that declares neither (e.g. `player/package.json`, which only
 * sets `"type": "module"`) is a marker, not a package: its suites roll up to
 * the root group, exactly as they ran before.
 *
 * THE LOOP IS CLOSED IN test/suite-integrity.test.js
 * That file asserts the plan this module produces covers every suite it finds
 * on disk, and that every floored suite is in the plan. So: anything floored is
 * executed, anything executed is floored. Narrowing discovery HERE (dropping an
 * extension, a directory) fails there, and vice versa.
 *
 * USAGE
 *   node tools/ci/run-suites.mjs              # install + run everything
 *   node tools/ci/run-suites.mjs --list       # print the plan, run nothing
 *   node tools/ci/run-suites.mjs --skip-install
 *       # local convenience: reuse already-installed package deps. CI never
 *       # passes this — a stale node_modules is exactly what npm ci prevents.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file's location (tools/ci/). */
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/* KEEP IN SYNC with SCANNED_DIRS in test/suite-integrity.test.js. The sync is
 * not a convention: that file asserts the two agree, and fails if they drift. */
export const SCANNED_DIRS = ["player", "test", "tools"];

/* KEEP IN SYNC with SUITE_RE in test/suite-integrity.test.js. `.mjs` and `.cjs`
 * matter — every suite under tools/ is an ES module. */
export const SUITE_RE = /\.test\.(js|mjs|cjs)$/;

/** Directories never scanned: vendored trees and tool caches are not ours. */
function skipDir(name) {
  return name === "node_modules" || name.startsWith(".");
}

/**
 * Recursively list suites under `relDir`, as repo-relative POSIX paths.
 * A directory that does not exist contributes nothing — same rule as
 * suite-integrity, so a tree being created in a parallel branch is not a
 * failure. Sorted, so plans and diffs are stable.
 */
export function findSuites(root, relDir) {
  const abs = path.join(root, relDir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const entries = fs
    .readdirSync(abs, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (skipDir(entry.name)) continue;
      out.push(...findSuites(root, rel));
    } else if (SUITE_RE.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

/** Every suite in the repo, repo-relative POSIX paths, sorted. */
export function discoverSuites(root = REPO_ROOT) {
  return SCANNED_DIRS.flatMap((d) => findSuites(root, d)).sort();
}

function readPackageJson(abs) {
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (err) {
    // A package.json we cannot parse is a stop-the-line error: guessing would
    // mean silently running (or not running) somebody's suites.
    throw new Error(`cannot parse ${abs}: ${err.message}`);
  }
}

function hasDeps(pkg) {
  return (
    Object.keys(pkg.dependencies || {}).length > 0 ||
    Object.keys(pkg.devDependencies || {}).length > 0
  );
}

/**
 * Walk up from a suite's directory looking for the package that owns it.
 * Stops below the repo root: the root manifest is deliberately
 * dependency-free and its `test` script is a convenience alias, not the
 * definition of what CI runs.
 *
 * Returns { dir, pkg } for the nearest package.json declaring a `test` script,
 * or { dir: null, blocked } where `blocked` names a dependency-carrying
 * package.json that declared no way to run tests.
 */
function findOwner(root, relDir) {
  let cur = relDir;
  let blocked = null;
  while (cur && cur !== "." && cur !== "/") {
    const pkgPath = path.join(root, cur, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = readPackageJson(pkgPath);
      if (pkg.scripts && pkg.scripts.test) return { dir: cur, pkg };
      // Deps but no test script: remember it, but keep walking — an outer
      // package with a test script would still know how to run this.
      if (!blocked && hasDeps(pkg)) blocked = cur;
    }
    cur = path.posix.dirname(cur);
  }
  return { dir: null, blocked };
}

/**
 * Build the execution plan.
 *
 * -> { suites, groups: [{ kind, dir, suites, install }], errors: [string] }
 *
 * `kind` is "root" (run from the repo root, no install) or "package" (install
 * and run inside `dir`). `install` is "ci", "install", or null. The root group
 * is first; package groups follow in directory order, so CI logs are stable.
 */
export function planSuiteRuns(root = REPO_ROOT) {
  const suites = discoverSuites(root);
  const rootGroup = { kind: "root", dir: ".", suites: [], install: null };
  const packageGroups = new Map();
  const errors = [];

  for (const rel of suites) {
    const { dir, pkg, blocked } = findOwner(root, path.posix.dirname(rel));
    if (!dir) {
      if (blocked) {
        errors.push(
          `${rel} sits under ${blocked}/package.json, which declares ` +
            `dependencies but no "test" script. The runner will not guess: add ` +
            `a "test" script to ${blocked}/package.json (it owns the flags and ` +
            `the install), or move the suite out of that package.`
        );
        continue;
      }
      rootGroup.suites.push(rel);
      continue;
    }
    let group = packageGroups.get(dir);
    if (!group) {
      group = {
        kind: "package",
        dir,
        suites: [],
        install: !hasDeps(pkg)
          ? null
          : fs.existsSync(path.join(root, dir, "package-lock.json"))
            ? "ci"
            : "install",
      };
      packageGroups.set(dir, group);
    }
    group.suites.push(rel);
  }

  const groups = [...packageGroups.values()].sort((a, b) =>
    a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0
  );
  if (rootGroup.suites.length) groups.unshift(rootGroup);
  return { suites, groups, errors };
}

/**
 * The commands for one group: { cwd, steps: [{ cmd, args }] }.
 * `cmd` is always the logical name ("node"/"npm"); the platform-specific
 * executable is resolved at spawn time so plans stay comparable in tests.
 */
export function commandsFor(group) {
  if (group.kind === "root") {
    return { cwd: ".", steps: [{ cmd: "node", args: ["--test", ...group.suites] }] };
  }
  const local = group.suites.map((s) => path.posix.relative(group.dir, s));
  const steps = [];
  if (group.install) steps.push({ cmd: "npm", args: [group.install] });
  // `npm test -- <files>` appends the files to the package's own test script,
  // so the package keeps ownership of the runner flags (see the header).
  steps.push({ cmd: "npm", args: ["test", "--", ...local] });
  return { cwd: group.dir, steps };
}

export function formatPlan(plan) {
  const lines = [`${plan.suites.length} suite(s) in ${plan.groups.length} group(s):`];
  for (const group of plan.groups) {
    const { cwd, steps } = commandsFor(group);
    lines.push(`  ${group.dir} (${group.kind}, ${group.suites.length} suite(s))`);
    for (const s of steps) lines.push(`    $ (cd ${cwd} && ${s.cmd} ${s.args.join(" ")})`);
  }
  return lines.join("\n");
}

function exe(cmd) {
  // Windows needs the .cmd shim for npm, and Node >=18.20 refuses to spawn a
  // .cmd without a shell. CI is Linux; this is for local verification.
  return process.platform === "win32" && cmd === "npm" ? "npm.cmd" : cmd;
}

function runStep(root, cwd, step) {
  const cmd = exe(step.cmd);
  console.log(`\n$ (cd ${cwd} && ${step.cmd} ${step.args.join(" ")})`);
  const res = spawnSync(cmd, step.args, {
    cwd: path.join(root, cwd),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.error) {
    console.error(`  failed to launch: ${res.error.message}`);
    return 1;
  }
  return res.status === null ? 1 : res.status;
}

function main(argv) {
  const listOnly = argv.includes("--list") || argv.includes("--dry-run");
  const skipInstall = argv.includes("--skip-install");
  const plan = planSuiteRuns(REPO_ROOT);

  console.log(formatPlan(plan));
  if (plan.errors.length) {
    console.error("\nCannot build a complete plan:");
    for (const e of plan.errors) console.error(`  - ${e}`);
    return 1;
  }
  if (listOnly) return 0;

  const failed = [];
  for (const group of plan.groups) {
    const { cwd, steps } = commandsFor(group);
    console.log(`\n=== ${group.dir} (${group.suites.length} suite(s)) ===`);
    for (const step of steps) {
      const isInstall = step.cmd === "npm" && step.args[0] !== "test";
      if (isInstall && skipInstall) {
        console.log(`  (skipping ${step.args[0]} — --skip-install)`);
        continue;
      }
      if (runStep(REPO_ROOT, cwd, step) !== 0) {
        // Stop this group (a failed install makes its test run meaningless)
        // but keep going: one red suite should not hide the state of the rest.
        failed.push(`${group.dir}: ${step.cmd} ${step.args[0]}`);
        break;
      }
    }
  }

  console.log("");
  if (failed.length) {
    console.error(`FAILED (${failed.length}):`);
    for (const f of failed) console.error(`  - ${f}`);
    return 1;
  }
  console.log(`All ${plan.suites.length} suite(s) passed.`);
  return 0;
}

/* Import-safe: suite-integrity imports this module for the closure check, and
 * importing it must never execute anything. */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
