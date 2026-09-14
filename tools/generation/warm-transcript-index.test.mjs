/* Tests for the corpus-warming launcher — tools/generation/warm-transcript-index.mjs.
 * Run: node --test tools/generation/
 *
 * WHAT IS ACTUALLY AT RISK HERE
 * This file is a launcher, and the failure mode of a launcher is the same as
 * the relay's: it is QUIET. `start-run.mjs`'s header records why it reads its
 * driver entry out of `backend/package.json` rather than hardcoding it — a
 * hardcoded path that stops existing produces a spawn that exits non-zero with
 * a message nobody reads, and the run goes ahead on a corpus nobody warmed.
 * This launcher has no npm script to read from, so the entry IS hardcoded, and
 * the test below is the thing that keeps it honest.
 *
 * EVERY TEST NAMES THE ONE-LINE MUTATION THAT MAKES IT PASS FALSELY, per
 * CLAUDE.md § "A green test is not evidence until you have broken it".
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT, WARM_ENTRY, warmArgs } from "./warm-transcript-index.mjs";

/* 1. Killing mutation: change WARM_ENTRY to a path that does not exist (or
      rename the CLI without updating it). The launcher would spawn tsx on a
      missing file, exit non-zero, and a run would proceed on the cold corpus
      #703 was filed about. */
test("the entry the launcher spawns is a file that exists", () => {
  const entry = path.join(REPO_ROOT, "backend", WARM_ENTRY);
  assert.ok(fs.existsSync(entry), `${WARM_ENTRY} must exist under backend/ (looked at ${entry})`);
  assert.match(WARM_ENTRY, /\.ts$/, "the entry must be the TypeScript source tsx runs, not a build artifact");
});

/* 2. Killing mutation: resolve REPO_ROOT one level too high or too low. Every
      path this tool reads and writes hangs off it — the corpus, the digests,
      the index cache — so an off-by-one directory makes a warm that reports
      success and warms nothing. */
test("REPO_ROOT is the checkout root, not tools/ and not tools/generation/", () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "backend", "package.json")));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "tools", "generation", "start-run.mjs")));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "data", "catalog.json")));
});

/* 3. Killing mutation: filter or reorder the arguments. `--show <id>` is what
      keeps a warm on a 16 GB machine down to one show; dropping it turns a
      targeted 3 MB pass into a 449 MB one, which is exactly the "do not take
      the box down" failure. */
test("every argument reaches the warmer unchanged and in order", () => {
  const given = ["--show", "this-podcast-will-kill-you", "--offline", "--build-only"];
  assert.deepEqual(warmArgs(given), given);
});

/* 4. Killing mutation: return the caller's array instead of a copy. The
      launcher passes this straight into `spawn`, and a shared array is how a
      later mutation quietly changes what was already run. */
test("the argument list is a copy, so nothing downstream can edit the run after the fact", () => {
  const given = ["--offline"];
  const copied = warmArgs(given);
  copied.push("--build-only");
  assert.deepEqual(given, ["--offline"]);
});

/* 5. Killing mutation: delete the `isMain` guard. `relay.test.mjs` and this
      file both import their module for its exports; a module that ran `main()`
      on import would start a full corpus warm inside the test suite. */
test("importing the launcher does not start a warm", async () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "tools", "generation", "warm-transcript-index.mjs"), "utf8");
  assert.match(source, /if \(isMain\) await main\(\);/);
});
