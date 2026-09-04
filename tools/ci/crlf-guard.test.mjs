/* The LF-checkout guard on the deploy manifest — tools/ci/crlf-guard.mjs.
 *
 * WHAT THIS SUITE IS FOR. `generate-manifest.mjs` hashes bytes on disk. On the
 * Windows `core.autocrlf=true` checkout this repo is developed in, every
 * committed-LF text file is CRLF on disk, so `--write` there rewrites all 40
 * manifest entries to hashes of bytes we never ship. The guard refuses instead.
 * Measured on 2026-09-03 in such a worktree: 37 of the 38 listed text files
 * differed, and `--check` reported "deploy-manifest.json is stale" — advice
 * pointing straight at the command that breaks it.
 *
 * THE HARNESS IS NOT MORE FORGIVING THAN THE REAL THING. The guard is a pure
 * function over (root, files), so these tests hand it real files on a real
 * filesystem with real bytes — no fake, nothing stubbed. The one thing a
 * fixture cannot reproduce is git's own conversion, which is why the last test
 * asserts against the REAL repo tree rather than a temp directory.
 *
 * EVERY TEST NAMES THE ONE-LINE MUTATION THAT KILLS IT, per CLAUDE.md § "A
 * green test is not evidence until you have broken it". Each was applied and
 * observed to fail before this file was committed.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { crlfOffenders, crlfFatalMessage, BINARY_LISTED } from "./crlf-guard.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/* The real list, taken from the committed artifact rather than by importing
   generate-manifest.mjs — that module runs its CLI at top level and would
   exit(2) on import, which is the same reason the guard lives in its own file.
   These keys ARE `listedFiles()`: the required `data-and-site` check runs
   `--check`, which fails unless the committed key set equals the computed one. */
function manifestListedFiles() {
  return Object.keys(JSON.parse(readFileSync(path.join(REPO, "deploy-manifest.json"), "utf8")).files);
}

function scratch(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "crlf-guard-"));
  for (const [rel, bytes] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  return dir;
}

test("a CRLF file is reported and an LF file beside it is not", () => {
  /* The whole point: the guard must separate the two, not answer "this tree
     looks fine" or "this tree looks bad" wholesale.
     KILLED BY: `if (readFileSync(abs).includes("\n")) bad.push(key);` in
     crlfOffenders — every text file then reads as an offender, including on a
     clean Linux runner, and the manifest can never be generated anywhere. */
  const dir = scratch({ "crlf.js": "a\r\nb\r\n", "lf.js": "a\nb\n" });
  try {
    assert.deepEqual(crlfOffenders(dir, ["crlf.js", "lf.js"]), ["crlf.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lone CR is not CRLF, and a lone LF preceded by other bytes is not either", () => {
  /* Old-Mac CR endings are not what git's autocrlf produces and are not the
     hazard; only the `\r\n` pair means "this text was converted at checkout".
     KILLED BY: `if (readFileSync(abs).includes("\r")) bad.push(key);` — the
     lone-CR file then reports as an offender it is not. */
  const dir = scratch({ "cr-only.js": "a\rb\rc", "lf.js": "a\nb\n" });
  try {
    assert.deepEqual(crlfOffenders(dir, ["cr-only.js", "lf.js"]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE LOAD-BEARING EXCLUSION: a binary listed file holding \\r\\n bytes is not an offender", () => {
  /* This is not defensive tidiness. Both committed icons really do contain
     `\r\n` byte pairs (verified with `git cat-file blob` on 2026-09-03), and
     git never line-converts them because it detects them as binary. Without
     the exclusion the guard fires on a CLEAN Linux CI checkout and blocks
     `data-and-site` on every PR in the repo.
     KILLED BY: deleting the `if (BINARY_LISTED.has(key)) continue;` line in
     crlfOffenders — icon-180.png is then reported and the manifest gate is
     dead everywhere. */
  const dir = scratch({ "icon-180.png": Buffer.from([0x89, 0x50, 0x0d, 0x0a, 0x1a, 0x0a]) });
  try {
    assert.ok(BINARY_LISTED.has("icon-180.png"));
    assert.deepEqual(crlfOffenders(dir, ["icon-180.png"]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both committed icons are excluded, because both really do carry \\r\\n bytes", () => {
  /* Pins the measurement the exclusion rests on against the REAL files, so a
     future re-export of either icon that happens to lose its `\r\n` pairs does
     not quietly make this look like an arbitrary allowance. Deliberately an
     invariant rather than a behaviour (CLAUDE.md § point 5): it cannot fail on
     today's tree, and it is the only thing that would flag the exclusion list
     drifting away from what it documents.
     KILLED BY: removing "icon-512.png" from BINARY_LISTED in crlf-guard.mjs. */
  for (const icon of ["icon-180.png", "icon-512.png"]) {
    assert.ok(BINARY_LISTED.has(icon), `${icon} must stay excluded`);
  }
  assert.deepEqual(crlfOffenders(REPO, ["icon-180.png", "icon-512.png"]), []);
});

test("a listed file missing from disk is left to generate-manifest's own error", () => {
  /* sha256File already fails with "listed file is missing on disk: <path>",
     which names the file. Reporting it here as a CRLF offender would replace a
     precise message with a wrong one.
     KILLED BY: deleting the `if (!existsSync(abs)) continue;` line — readFileSync
     then throws ENOENT out of the guard, which is neither message. */
  const dir = scratch({ "there.js": "a\n" });
  try {
    assert.deepEqual(crlfOffenders(dir, ["there.js", "gone.js"]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("offenders come back POSIX-slashed, matching the manifest's own keys", () => {
  /* The manifest keys are forward-slashed on every OS (generate-manifest.mjs
     does `rel.split(path.sep).join("/")`), and the guard's message is read
     next to those keys.
     KILLED BY: `const key = rel;` in crlfOffenders — on Windows the reported
     path becomes `player\client.js`, which appears in no manifest. */
  const dir = scratch({ [path.join("player", "client.js")]: "a\r\n" });
  try {
    assert.deepEqual(crlfOffenders(dir, [path.join("player", "client.js")]), ["player/client.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fatal message names the count, some offenders, and says NOT to run --write", () => {
  /* The message is the entire remedy path for a developer who hits this: the
     pre-guard behaviour told them to run the command that causes the damage.
     KILLED BY: replacing crlfFatalMessage's body with `return "FATAL: CRLF";`. */
  const msg = crlfFatalMessage(["app.js", "sw.js"]);
  assert.match(msg, /offenders \(2\)/);
  assert.match(msg, /app\.js/);
  assert.match(msg, /Do NOT 'fix' it by running --write/);
  assert.match(msg, /core\.autocrlf/);
});

test("the fatal message truncates a long offender list rather than printing all 38", () => {
  /* KILLED BY: `bad.slice(0, 5)` -> `bad` in crlfFatalMessage — the ellipsis
     disappears and the message becomes a wall. */
  const msg = crlfFatalMessage(["a", "b", "c", "d", "e", "f", "g"]);
  assert.match(msg, /offenders \(7\): a, b, c, d, e, \.\.\./);
});

test("every file the manifest lists is either binary-excluded or actually checked", () => {
  /* Pins the guard's coverage to generate-manifest.mjs's real list, so a new
     shipped file cannot arrive outside the guard's reach without someone
     deciding it is binary. Not a behaviour test — an anti-drift one.
     KILLED BY: adding `"styles.css"` to BINARY_LISTED in crlf-guard.mjs, which
     would silently stop guarding a text file. */
  const listed = manifestListedFiles();
  assert.ok(listed.length >= 40, `expected the real manifest list, got ${listed.length}`);
  for (const key of BINARY_LISTED) {
    assert.ok(listed.includes(key), `${key} is excluded but is not on the manifest's list at all`);
    assert.ok(/\.(png|jpg|jpeg|gif|webp|woff2?|ico)$/.test(key), `${key} is excluded but is not a binary extension`);
  }
});

test("the real repo tree is checked with the real list without throwing", () => {
  /* The guard runs on every `--check` in the required `data-and-site` job, so
     it must survive the actual 40-file list — including the icons, the large
     data/*.json files, and whatever player/*.js currently exists. On a Linux
     checkout this returns []; on the Windows dev checkout it returns the text
     files, and BOTH are correct answers, so this asserts the shape, not the
     verdict.
     KILLED BY: deleting the `if (BINARY_LISTED.has(key)) continue;` line in
     crlfOffenders — the icons are then reported against the REAL tree, which is
     exactly the failure that would break `data-and-site` for the whole repo. */
  const bad = crlfOffenders(REPO, manifestListedFiles());
  assert.ok(Array.isArray(bad));
  for (const key of bad) assert.ok(!BINARY_LISTED.has(key), `${key} is binary and must never be reported`);
});
