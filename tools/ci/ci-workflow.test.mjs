/* What `.github/workflows/ci.yml` must still be doing.
 *
 * WORKFLOW YAML IS NOT DIRECTLY TESTABLE — nothing here can make GitHub run a
 * job — so this asserts over the file's TEXT, the same way
 * `tools/mobile/ios-workflow.test.mjs` and `android-workflow.test.mjs` already
 * do for the release workflows. That is a real limit and worth stating: this
 * catches a step being deleted or renamed, and it cannot catch a step that runs
 * and does nothing. It is the second failure this file exists for that makes it
 * worth having anyway.
 *
 * THE FIRST: measured 2026-09-12, `grep -rn "typecheck\|tsc \|noEmit\|eslint"
 * .github/workflows/` returned ZERO hits. `backend/package.json` had defined
 * `typecheck` (`tsc -p tsconfig.json --noEmit`) and `lint` for months and no CI
 * job had ever called either, so every line of TypeScript in the product was
 * type-ungated. `vitest` does not close that hole — it transpiles per file and
 * type-checks nothing, so a signature change that breaks a caller no test
 * executes is green. There were four real errors sitting in the tree at the
 * time, all `TS2532` in `backend/test/breadthCatalog.test.ts`.
 *
 * THE SECOND: a gate that exists only in a workflow file is one careless
 * "simplify CI" edit from being gone with nothing to say so. Deleting the
 * typecheck step now takes this file with it, in a diff that says what it is.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const BACKEND_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "backend", "package.json"), "utf8"));

/** The lines of one top-level job block in ci.yml, by name. */
function jobBlock(name) {
  const lines = CI.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.notEqual(start, -1, `ci.yml has no job called \`${name}\``);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    // A new top-level job is the only thing at exactly two spaces of indent.
    if (/^ {2}\S/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

test("the backend job runs the typecheck", () => {
  /* MUTATION: delete the `- run: npm run typecheck` line from ci.yml's backend
     job. This is the whole finding: with it gone, `tsc` runs nowhere in CI and
     the TypeScript backend is ungated again, silently and greenly. */
  const backend = jobBlock("backend");
  assert.match(backend, /run:\s*npm run typecheck/, "ci.yml's `backend` job no longer runs `npm run typecheck`");
});

test("the typecheck runs before the suite, so a type error is not buried under a 14-minute run", () => {
  /* MUTATION: move the typecheck step after `npm test`. Ordering is not
     correctness, but it is the difference between a 20-second answer and a
     14-minute one, and a red typecheck usually explains the red suite. */
  /* Over the `- run:` STEPS, not over the raw text: the block's comments
     mention `npm test` while explaining the ordering, and matching those would
     make this test assert about prose. */
  const steps = jobBlock("backend")
    .split(/\r?\n/)
    .map((l) => /^\s*-\s*run:\s*(.+)$/.exec(l)?.[1]?.trim())
    .filter(Boolean);
  assert.ok(
    steps.indexOf("npm run typecheck") !== -1 &&
      steps.indexOf("npm run typecheck") < steps.indexOf("npm test"),
    `the typecheck must run before the vitest suite; steps are ${JSON.stringify(steps)}`
  );
});

test("`typecheck` is the real thing — tsc, the full tsconfig, and no emit", () => {
  /* MUTATION: point `typecheck` at `tsconfig.build.json` (which excludes
     `test/`) or drop `--noEmit`. The first would have left all four of the
     errors this change fixed invisible, because every one of them was in a test
     file; the second turns a check into a build that litters the tree. */
  assert.equal(BACKEND_PKG.scripts.typecheck, "tsc -p tsconfig.json --noEmit");
});

test("the tsconfig the gate reads still has noUncheckedIndexedAccess on", () => {
  /* MUTATION: set `noUncheckedIndexedAccess: false` in backend/tsconfig.json.
     That is the "fix" the four TS2532 errors invite, and it would silently
     un-gate every indexed read in the backend rather than the four that were
     wrong. The brief for this change said in as many words: do not weaken the
     tsconfig. This is that instruction, executable. */
  const tsconfig = fs.readFileSync(path.join(ROOT, "backend", "tsconfig.json"), "utf8");
  // Comments are legal in tsconfig, so read the text rather than JSON.parse.
  assert.match(tsconfig, /"noUncheckedIndexedAccess"\s*:\s*true/);
  assert.doesNotMatch(tsconfig, /"strict"\s*:\s*false/);
});

test("`lint` is still defined, so adding it to CI stays a one-line change", () => {
  /* `lint` is deliberately NOT in ci.yml: `eslint src test` reports a backlog
     nobody has triaged, and a job that is red on arrival teaches everyone to
     ignore the red. That is a decision to revisit, not a script to delete —
     if the script goes, the decision quietly becomes permanent. */
  assert.equal(BACKEND_PKG.scripts.lint, "eslint src test");
  assert.doesNotMatch(jobBlock("backend"), /npm run lint/);
});
