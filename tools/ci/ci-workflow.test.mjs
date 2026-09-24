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

/* ───────────── NE-06: engine-parity, ios-gate, and the one classifier ─────────────
 *
 * Card NE-06 (docs/native-engine-plan.md §6.8, G-1a and G-1b). The decisions
 * are tools/ci/engine-ci.mjs and are tested in engine-ci.test.mjs; what is
 * pinned here is that ci.yml CALLS them, on the right events, with the inputs
 * that make "unknown" mean "run it". Every one of these jobs is about to be a
 * required check, and a required check GitHub skips is a required check GitHub
 * counts as passed. */

/** The non-comment lines of a job block: assertions about YAML, not prose. */
const codeOf = (name) =>
  jobBlock(name)
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");

/** The steps of a job (non-comment lines), one chunk each. */
const stepsOf = (job) =>
  codeOf(job)
    .split(/\n(?= {6}- (?:name|uses):)/)
    .filter((c) => /^\s*- (?:name|uses):/.test(c));

/** One step of a job, by a fragment of its name or `uses:`. */
const jobStep = (job, fragment) => stepsOf(job).find((c) => c.includes(fragment)) ?? null;

test("NE-06: ci.yml still triggers on push, pull_request AND workflow_dispatch", () => {
  /* MUTATION: drop `workflow_dispatch` -> engine-parity (G-1a says it runs on
     all three) never reports on a pr-hygiene-updated head, and once it is
     required, every such PR strands at "Expected". */
  const on = CI.slice(CI.indexOf("\non:"), CI.indexOf("\njobs:"))
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  for (const e of ["push:", "pull_request:", "workflow_dispatch:"]) assert.match(on, new RegExp(`^ {2}${e}`, "m"), e);
});

test("NE-06: engine-parity runs swift test on the core in swift:5.10 on Linux, with the parity env", () => {
  /* MUTATION: drop FORAY_PARITY_DIR or PARITY_REPORT, or move the job to
     macOS -> no report for the summary, or no fast Linux loop at all, which
     is the whole of G-1a. */
  const job = codeOf("engine-parity");
  assert.match(job, /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(job, /^ {4}container: swift:5\.10$/m);
  const run = jobStep("engine-parity", "swift test (foray-engine-core, Linux)");
  assert.ok(run, "no Linux swift test step");
  assert.match(run, /swift test --package-path mobile\/plugins\/foray-audio\/foray-engine-core/);
  assert.match(run, /FORAY_PARITY_DIR="\$GITHUB_WORKSPACE\/player\/parity"/);
  assert.match(run, /PARITY_REPORT="\$GITHUB_WORKSPACE\/parity-report\.json"/);
  assert.match(run, /set -euo pipefail/);
});

test("NE-06: the family table goes to the job summary, from the report the run wrote", () => {
  /* MUTATION: drop the summary step, or read a different file than
     PARITY_REPORT names -> G-1a's acceptance (the family table on the PR) is
     gone, or it always prints "no report". */
  const s = jobStep("engine-parity", "Parity family table");
  assert.ok(s, "no summary step");
  assert.match(s, /node tools\/ci\/engine-ci\.mjs summary parity-report\.json >> "\$GITHUB_STEP_SUMMARY"/);
  assert.match(s, /!cancelled\(\)/, "the table must print when swift test FAILED, which is when it matters most");
});

test("NE-06: engine-parity never copies ios-kit's dispatch skip, and survives a failed classifier", () => {
  /* MUTATION: give engine-parity `if: github.event_name != 'workflow_dispatch'`,
     or a bare `needs: engine-paths` with no `if` -> it skips on a dispatch, or
     skips when engine-paths fails; either way a skipped required check passes. */
  const job = codeOf("engine-parity");
  assert.doesNotMatch(job, /workflow_dispatch/);
  assert.match(job, /^ {4}needs: engine-paths$/m);
  assert.match(job, /^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m);
});

test("NE-06: the short-circuit is step-level, and only an explicit 'false' triggers it", () => {
  /* MUTATION: `RUN_PARITY: ${{ needs.engine-paths.outputs.engine }}` -> an
     empty output (engine-paths failed) short-circuits green; a job-level
     `if:` on the output -> the job SKIPS instead of reporting; an unguarded
     swift test -> no short-circuit at all. */
  const job = codeOf("engine-parity");
  assert.match(job, /RUN_PARITY: \$\{\{ needs\.engine-paths\.outputs\.engine == 'false' && 'false' \|\| 'true' \}\}/);
  assert.doesNotMatch(job, /^ {4}if:.*outputs\.engine/m, "a job-level short-circuit skips the job, and a skip is a pass");
  const steps = stepsOf("engine-parity");
  const unguarded = steps.filter((c) => !/RUN_PARITY == 'true'/.test(c)).map((c) => c.split("\n")[0].trim());
  // Only the checkout and the notice run unguarded: setup-node, swift test, summary and upload wait on it.
  assert.deepEqual(unguarded, ["- uses: actions/checkout@v4", "- name: Short-circuit — no engine input changed"]);
  const notice = jobStep("engine-parity", "Short-circuit");
  assert.match(notice, /if: env\.RUN_PARITY != 'true'/);
  assert.match(notice, /GITHUB_STEP_SUMMARY/, "a short-circuit must say so in the summary, not look like an empty run");
});

test("NE-06: engine-paths classifies through the tested script with the event context in env", () => {
  /* MUTATION: interpolate `${{ github.ref_name }}` into the run line -> a
     branch name is author-controlled shell; or fetch-depth 1 -> the merge
     commit has no base parent, the script says "unknown" and nothing ever
     short-circuits (safe, but G-1b's content-PR acceptance fails). */
  const job = codeOf("engine-paths");
  assert.match(job, /run: node tools\/ci\/engine-ci\.mjs engine-paths$/m);
  assert.match(job, /fetch-depth: 2/);
  for (const k of [
    "EVENT_NAME: ${{ github.event_name }}",
    "BEFORE: ${{ github.event.before }}",
    "REF_NAME: ${{ github.ref_name }}",
    "DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}",
  ]) {
    assert.ok(job.includes(k), `engine-paths is missing ${k}`);
  }
  assert.match(job, /engine: \$\{\{ steps\.classify\.outputs\.engine \}\}/);
  assert.match(job, /swift: \$\{\{ steps\.classify\.outputs\.swift \}\}/);
});

test("NE-06: ios-gate runs on every event and waits on ios-kit through the tested script", () => {
  /* MUTATION: `needs: [engine-paths, ios-kit]` -> every content PR waits ~15
     minutes on a Mac; an event `if:` -> it skips on dispatch and a skipped
     required check passes. */
  const job = codeOf("ios-gate");
  assert.match(job, /^ {4}needs: engine-paths$/m);
  assert.match(job, /^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m);
  assert.match(job, /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(job, /run: node tools\/ci\/engine-ci\.mjs ios-gate$/m);
  assert.match(job, /SWIFT_CHANGED: \$\{\{ needs\.engine-paths\.outputs\.swift \}\}/);
  assert.match(job, /actions: read/, "the gate reads ios-kit's job through the Actions API");
  assert.match(job, /timeout-minutes: \d+/);
});

test("NE-06: ios-kit runs on a dispatch when a Swift path changed, and never skips for a failed classifier", () => {
  /* MUTATION: restore `if: github.event_name != 'workflow_dispatch'` -> a
     Swift PR updated by pr-hygiene has no ios-kit on its new head and ios-gate
     goes red for want of a run; drop `!cancelled()` -> a failed engine-paths
     skips ios-kit on every PR. */
  const job = codeOf("ios-kit");
  assert.match(job, /^ {4}needs: engine-paths$/m);
  assert.match(
    job,
    /^ {4}if: \$\{\{ !cancelled\(\) && \(github\.event_name != 'workflow_dispatch' \|\| needs\.engine-paths\.outputs\.swift != 'false'\) \}\}$/m
  );
  // G-1a's "a macOS swift test of the core in ios-kit" (landed by NE-01; kept).
  assert.match(job, /swift test --package-path mobile\/plugins\/foray-audio\/foray-engine-core/);
});
