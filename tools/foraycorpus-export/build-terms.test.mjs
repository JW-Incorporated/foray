/* Tests for the corpus-terms launcher — tools/foraycorpus-export/build-terms.mjs
   (PKG-27, docs/roadmap/corpus.md §3).
   Run: npm test --prefix tools/foraycorpus-export -- build-terms.test.mjs

   A launcher fails QUIETLY: a hardcoded entry that stops existing produces a
   spawn that exits non-zero with a message nobody reads, and PKG-29's topic
   assignment then reads a stale or missing episode-terms.jsonl. The entry is
   hardcoded (there is no npm script for it), so test 1 keeps it honest.

   EVERY TEST NAMES THE ONE-LINE MUTATION THAT MAKES IT FAIL, per CLAUDE.md
   § "A green test is not evidence until you have broken it". The floor for
   this suite lives in test/suite-integrity.test.js. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ROOT } from "./config.mjs";
import { TERMS_ENTRY, termsArgs } from "./build-terms.mjs";

/* 1. Killing mutation: change TERMS_ENTRY to a path that does not exist (or
      rename buildCorpusTerms.ts without updating it), or point it at a built
      .js. The launcher would spawn tsx on a missing file and exit non-zero. */
test("the entry the launcher spawns is a .ts file that exists under backend/", () => {
  const entry = path.join(ROOT, "backend", TERMS_ENTRY);
  assert.ok(fs.existsSync(entry), `${TERMS_ENTRY} must exist under backend/ (looked at ${entry})`);
  assert.match(TERMS_ENTRY, /\.ts$/, "the entry must be the TypeScript source tsx runs, not a build artifact");
});

/* 2. Killing mutation: filter or reorder the arguments (e.g. `argv.slice(1)`
      or `argv.slice().sort()`). `--show <id>` is what keeps a pass on a 16 GB
      machine to one show; `--normalized <dir> --out <dir>` must stay paired. */
test("every argument reaches buildCorpusTerms unchanged and in order", () => {
  const given = ["--show", "this-podcast-will-kill-you", "--normalized", "C:/tmp/n", "--out", "C:/tmp/o"];
  assert.deepEqual(termsArgs(given), given);
});

/* 3. Killing mutation: `return argv;` instead of a copy. The launcher hands the
      array straight to spawn, and a shared array is how a later edit quietly
      changes what was already run. */
test("the argument list is a copy, so nothing downstream can edit the run after the fact", () => {
  const given = ["--show", "x"];
  const copied = termsArgs(given);
  assert.notEqual(copied, given);
  copied.push("--out");
  assert.deepEqual(given, ["--show", "x"]);
});
