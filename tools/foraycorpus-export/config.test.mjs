/* PKG-01 (docs/roadmap/corpus.md): the scaffold's config module. No network,
   no credentials, no database: every assertion is against constants, the
   package's own package.json, and the tracked file set. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as config from "./config.mjs";
import { safeKey as farmSafeKey } from "../segments/fetch-transcripts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/* The R2 prefixes are the farm's strings (foray-db transcript-farm/farm/r2.py
   writes `transcripts/normalized/...` and `transcripts/raw/...`). A drift by a
   single character makes the sync list nothing and report success.
   Mutation that turns this red: change one character of NORMALIZED_PREFIX in
   config.mjs (e.g. "transcripts/normalised"). */
test("R2 prefixes equal the transcript farm's key layout", () => {
  assert.equal(config.NORMALIZED_PREFIX, "transcripts/normalized");
  assert.equal(config.RAW_PREFIX, "transcripts/raw");
  assert.equal(config.FINGERPRINT_PREFIX, "fingerprints");
});

/* safeKey must BE the pipeline's safeKey, not a lookalike: the sync writes
   files at paths transcriptArchiveLookup reads, so a re-implementation that
   differs on any input (slug length, hash width, case) silently orphans bodies.
   The input carries separators and a query string so slug + hash both matter.
   Mutation that turns this red: replace the re-export in config.mjs with a
   local `export function safeKey(g) { return String(g).replace(/\W+/g, "-"); }`. */
test("safeKey is the fetch-transcripts safeKey, byte for byte", () => {
  const input = "https://a/b?c=1";
  assert.equal(config.safeKey(input), farmSafeKey(input));
  assert.equal(config.safeKey, farmSafeKey);
});

/* tools/ci/run-suites.mjs invokes `npm test -- <files>`. A script that does
   not end in `node --test` (e.g. one with a baked-in glob, or a wrapper that
   ignores positionals) would be planned and floored while the named suite
   never ran.
   Mutation that turns this red: set scripts.test in package.json to
   "node --test *.test.mjs". */
test("package.json test script ends in `node --test` so file arguments are forwarded", () => {
  const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
  assert.equal(typeof pkg.scripts?.test, "string");
  assert.match(pkg.scripts.test, /(^|\s)node(\s+--[\w-]+)*\s+--test$/);
});

/* No new identity strings in this package: every UA comes from
   tools/segments/politeness.mjs via config.mjs.
   The file set is `git ls-files`, NOT a directory walk, on purpose:
   node_modules/ is untracked and @aws-sdk/* contains the HTTP header name
   followed by a colon — a walk would either fail on vendored code or need a skip
   list that could quietly grow to hide our own files. git ls-files is exactly
   the code we ship. Fixtures (later tasks) are data, not code, and are
   excluded.
   The needles are spelled split ("User-" + "Agent:") so this suite does not
   flag itself; it is scanned like every other tracked .mjs here.
   Mutation that turns this red: add a comment naming the Mozilla browser UA
   prefix (Mozilla, slash, 5.0) to config.mjs and `git add` it. */
test("no tracked .mjs in the package carries an identity string of its own", () => {
  const repoRoot = join(HERE, "..", "..");
  const listed = execFileSync("git", ["ls-files", "tools/foraycorpus-export"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
  const files = listed.filter(
    (p) => p.endsWith(".mjs") && !p.split("/").includes("fixtures"),
  );
  assert.ok(files.includes("tools/foraycorpus-export/config.mjs"), `config.mjs not tracked: ${JSON.stringify(listed)}`);
  const offenders = [];
  for (const rel of files) {
    const text = readFileSync(join(repoRoot, rel), "utf8");
    for (const needle of ["User-" + "Agent:", "Mozilla" + "/"]) {
      if (text.includes(needle)) offenders.push(`${rel}: ${needle}`);
    }
  }
  assert.deepEqual(offenders, []);
});
