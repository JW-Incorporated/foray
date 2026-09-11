/* The Foray directory pointer — tools/ci/forays-directory.mjs, and its wiring
 * into generate-manifest.mjs's `--write` / `--check` (FD-02).
 *
 * WHAT THIS SUITE IS FOR. `data/forays-directory.json` is what the native
 * shell (FD-03) trusts to decide whether the three Foray data files it holds
 * are current, and what it verifies the fetched files against. A pointer that
 * names the wrong version or the wrong hashes is either a phone that never
 * updates or a phone that refuses a good set forever. So the check has to be
 * red for every way the pointer can fall behind the files, and `--write` has
 * to be idempotent, or the manifest-autofix bot would push a commit to every
 * PR just to move `built_at`.
 *
 * TWO LAYERS, BOTH REAL. The pure functions are exercised on scratch trees
 * with real bytes on a real filesystem. The CLI tests copy the REAL
 * `generate-manifest.mjs` (and the two modules it imports) into a scratch
 * tree whose listed files are tiny LF fixtures, then run it as a subprocess
 * exactly the way CI's `data-and-site` job and manifest-autofix.yml do. That
 * is what lets a `--check` be driven to red on a Windows autocrlf checkout,
 * where the real tree is refused by the CRLF guard before any hash is read.
 * The listed-file names come from the committed `deploy-manifest.json`, not a
 * copy of the tool's private lists, so this suite cannot drift from them.
 *
 * EVERY TEST NAMES THE ONE-LINE MUTATION THAT KILLS IT, per CLAUDE.md § "A
 * green test is not evidence until you have broken it". Seven were applied
 * in a scratch copy on 2026-09-10 and each killed exactly the test(s) that
 * name it: the --check pointer block removed (stale pointer), the missing-
 * pointer error swallowed, the idempotence short-circuit removed, the
 * deployIdFrom filter removed, the sha256 compare disabled, the pointer's
 * manifest entry dropped, and the pointer dropped from the CRLF guard's list.
 * The rest are named and were not run.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
 */

import { test } from "node:test";
import assert from "node:assert";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  POINTER_PATH,
  DIRECTORY_FILES,
  deployIdFrom,
  buildPointer,
  pointerText,
  samePointerContent,
  writePointer,
  pointerProblems,
} from "./forays-directory.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const sha = (s) => createHash("sha256").update(s).digest("hex");

const FORAYS = '{"forays":[{"id":"f1","items":["s1"]}]}\n';
const SEGMENTS = '{"segments":[{"id":"s1","start":0,"end":30}]}\n';
const SOURCES = '{"sources":[{"id":"s1","url":"https://example.invalid/a.mp3"}]}\n';

function put(dir, rel, bytes) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}

/** A scratch tree holding just the three directory files. */
function dataTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "forays-directory-"));
  put(dir, DIRECTORY_FILES.forays, FORAYS);
  put(dir, DIRECTORY_FILES.segments, SEGMENTS);
  put(dir, DIRECTORY_FILES.sources, SOURCES);
  return dir;
}

function withTree(make, fn) {
  const dir = make();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ID = "0123456789abcdef";
const WHEN = new Date("2026-09-10T12:00:00.000Z");

// --------------------------------------------------------------- the shape --

test("the pointer carries version, built_at, and the three files with their real bytes and sha256", () => {
  /* The contract FD-03 reads. Every number is measured from the bytes on disk,
     not copied from anywhere else.
     KILLED BY: `bytes[key] = 0;` in buildPointer — or dropping the
     `sha256[key] =` line. */
  withTree(dataTree, (dir) => {
    const p = buildPointer(dir, ID, WHEN);
    assert.deepEqual(Object.keys(p), ["version", "built_at", "files", "bytes", "sha256"]);
    assert.equal(p.version, ID);
    assert.equal(p.built_at, "2026-09-10T12:00:00.000Z");
    assert.deepEqual(p.files, {
      forays: "data/forays.json",
      segments: "data/segments.json",
      sources: "data/segment-sources.json",
    });
    assert.deepEqual(p.bytes, {
      forays: Buffer.byteLength(FORAYS),
      segments: Buffer.byteLength(SEGMENTS),
      sources: Buffer.byteLength(SOURCES),
    });
    assert.deepEqual(p.sha256, { forays: sha(FORAYS), segments: sha(SEGMENTS), sources: sha(SOURCES) });
  });
});

test("a directory file missing on disk is a thrown error, not a pointer with a hole in it", () => {
  /* KILLED BY: deleting the `if (!existsSync(abs)) throw` in buildPointer —
     readFileSync then throws ENOENT with no mention of what was listed. */
  withTree(dataTree, (dir) => {
    rmSync(path.join(dir, DIRECTORY_FILES.segments));
    assert.throws(() => buildPointer(dir, ID, WHEN), /listed file is missing on disk: data\/segments\.json/);
  });
});

test("pointerText is the exact bytes written, LF-terminated", () => {
  /* The manifest hashes these bytes; the writer and the text helper must agree.
     KILLED BY: `+ "\n"` -> `""` in pointerText. */
  withTree(dataTree, (dir) => {
    writePointer(dir, ID, WHEN);
    const onDisk = readFileSync(path.join(dir, POINTER_PATH), "utf8");
    assert.equal(onDisk, pointerText(buildPointer(dir, ID, WHEN)));
    assert.ok(onDisk.endsWith("}\n"));
    assert.ok(!onDisk.includes("\r"));
  });
});

// ---------------------------------------------------------- deploy id input --

test("the pointer's own manifest entry does not feed the deploy id", () => {
  /* The pointer CONTAINS the deploy id, so its hash cannot be an input to it.
     KILLED BY: removing `.filter((p) => p !== POINTER_PATH)` in deployIdFrom. */
  const files = { "app.js": "sha256:aa", "data/forays.json": "sha256:bb" };
  const withPointer = { ...files, [POINTER_PATH]: "sha256:cc" };
  assert.equal(deployIdFrom(withPointer), deployIdFrom(files));
});

test("every OTHER file's hash does feed the deploy id, and listing order does not", () => {
  /* KILLED BY: `.sort()` removed from deployIdFrom (order then matters), or
     `map((p) => p)` in place of the `path:hash` line (content then does not). */
  const a = { "app.js": "sha256:aa", "data/forays.json": "sha256:bb" };
  const b = { "data/forays.json": "sha256:bb", "app.js": "sha256:aa" };
  const c = { "app.js": "sha256:aa", "data/forays.json": "sha256:b2" };
  assert.equal(deployIdFrom(a), deployIdFrom(b));
  assert.notEqual(deployIdFrom(a), deployIdFrom(c));
  assert.match(deployIdFrom(a), /^[0-9a-f]{16}$/);
});

// ------------------------------------------------------------ idempotence --

test("writing the same pointer twice changes nothing — built_at is kept", () => {
  /* Otherwise every `--write` on an unchanged tree moves built_at, the
     manifest entry, and manifest-autofix pushes a commit to every PR.
     KILLED BY: `if (existing && samePointerContent(existing, fresh))` ->
     `if (false)` in writePointer. */
  withTree(dataTree, (dir) => {
    const first = writePointer(dir, ID, WHEN);
    const bytesAfterFirst = readFileSync(path.join(dir, POINTER_PATH));
    const second = writePointer(dir, ID, new Date("2027-01-01T00:00:00.000Z"));
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(second.pointer.built_at, "2026-09-10T12:00:00.000Z");
    assert.ok(readFileSync(path.join(dir, POINTER_PATH)).equals(bytesAfterFirst));
  });
});

test("a changed file rewrites the pointer with a new built_at", () => {
  /* The other half of idempotence: unchanged means UNCHANGED, not "never
     rewrite". KILLED BY: `strip = (p) => ""` in samePointerContent — every
     pointer then compares equal and a stale one is never replaced. */
  withTree(dataTree, (dir) => {
    writePointer(dir, ID, WHEN);
    put(dir, DIRECTORY_FILES.forays, FORAYS.replace("f1", "f2"));
    const later = new Date("2026-09-11T00:00:00.000Z");
    const r = writePointer(dir, "fedcba9876543210", later);
    assert.equal(r.changed, true);
    assert.equal(r.pointer.version, "fedcba9876543210");
    assert.equal(r.pointer.built_at, later.toISOString());
    assert.equal(r.pointer.sha256.forays, sha(FORAYS.replace("f1", "f2")));
  });
});

test("samePointerContent ignores built_at and nothing else", () => {
  /* KILLED BY: `built_at: undefined` removed from `strip` (timestamps then
     differ), or `strip = (p) => JSON.stringify(p.version)` (hashes then do not). */
  withTree(dataTree, (dir) => {
    const a = buildPointer(dir, ID, WHEN);
    const b = buildPointer(dir, ID, new Date("2030-01-01T00:00:00.000Z"));
    assert.equal(samePointerContent(a, b), true);
    assert.equal(samePointerContent(a, { ...b, sha256: { ...b.sha256, forays: "0".repeat(64) } }), false);
    assert.equal(samePointerContent(a, { ...b, version: "x" }), false);
    assert.equal(samePointerContent(a, null), false);
  });
});

// --------------------------------------------------------------- problems --

test("a freshly written pointer has no problems", () => {
  /* The baseline every red test below is measured against.
     KILLED BY: `problems.push("always")` at the top of pointerProblems. */
  withTree(dataTree, (dir) => {
    writePointer(dir, ID, WHEN);
    assert.deepEqual(pointerProblems(dir, ID), []);
  });
});

test("a missing pointer is a problem that names the file", () => {
  /* KILLED BY: `return { pointer: null, error: null }` for the missing case in
     readPointer — pointerProblems then reports "not a JSON object" at best. */
  withTree(dataTree, (dir) => {
    const problems = pointerProblems(dir, ID);
    assert.deepEqual(problems, ["data/forays-directory.json is missing"]);
  });
});

test("a pointer that is not JSON, or not an object, is a problem rather than a crash", () => {
  /* KILLED BY: removing the try/catch around JSON.parse in readPointer. */
  withTree(dataTree, (dir) => {
    put(dir, POINTER_PATH, "{not json");
    assert.match(pointerProblems(dir, ID)[0], /not valid JSON/);
    put(dir, POINTER_PATH, "[1,2]");
    assert.match(pointerProblems(dir, ID)[0], /not a JSON object/);
  });
});

test("a pointer whose version is not the tree's deploy id is stale", () => {
  /* The one FD-03 compares. KILLED BY: `pointer.version !== deployId` ->
     `false`. */
  withTree(dataTree, (dir) => {
    writePointer(dir, ID, WHEN);
    const problems = pointerProblems(dir, "fedcba9876543210");
    assert.equal(problems.length, 1);
    assert.match(problems[0], /version is "0123456789abcdef" but the tree computes to deploy_id fedcba9876543210/);
  });
});

test("a file that changed size after the pointer was written is caught by bytes AND sha256", () => {
  /* KILLED BY: removing the `bytes.${key}` push — the sha256 line still fires,
     so this asserts BOTH are reported. */
  withTree(dataTree, (dir) => {
    writePointer(dir, ID, WHEN);
    put(dir, DIRECTORY_FILES.segments, SEGMENTS + '{"appended":true}\n');
    const problems = pointerProblems(dir, ID);
    assert.equal(problems.length, 2, problems.join("\n"));
    assert.match(problems[0], /^bytes\.segments is \d+ but data\/segments\.json is \d+ bytes on disk$/);
    assert.match(problems[1], /^sha256\.segments is [0-9a-f]{12}… but data\/segments\.json hashes to [0-9a-f]{12}… on disk$/);
  });
});

test("a same-size edit is caught by sha256 alone — bytes is a hint, not the check", () => {
  /* A Foray id retyped, a URL with one character changed: same length, wrong
     content. If only the size were compared this would pass.
     KILLED BY: `if (got !== want)` -> `if (false)` in pointerProblems. */
  withTree(dataTree, (dir) => {
    writePointer(dir, ID, WHEN);
    put(dir, DIRECTORY_FILES.sources, SOURCES.replace("a.mp3", "b.mp3"));
    const problems = pointerProblems(dir, ID);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /^sha256\.sources /);
  });
});

test("a pointer that names a different path, an unknown entry, or a malformed hash is a problem", () => {
  /* The shape is the contract; a client resolving `files.forays` must get the
     manifest's key for it. KILLED BY: `pointer.files[key] !== rel` -> `false`,
     or dropping the `extra.length` push, or the HEX64 test. */
  withTree(dataTree, (dir) => {
    const good = buildPointer(dir, ID, WHEN);
    put(dir, POINTER_PATH, pointerText({ ...good, files: { ...good.files, forays: "data/forays-v2.json" } }));
    assert.match(pointerProblems(dir, ID).join("\n"), /files\.forays is "data\/forays-v2\.json", expected "data\/forays\.json"/);

    put(dir, POINTER_PATH, pointerText({ ...good, sha256: { ...good.sha256, extra: "0".repeat(64) } }));
    assert.match(pointerProblems(dir, ID).join("\n"), /sha256 names unknown entries: extra/);

    put(dir, POINTER_PATH, pointerText({ ...good, sha256: { ...good.sha256, forays: "sha256:" + good.sha256.forays } }));
    assert.match(pointerProblems(dir, ID).join("\n"), /sha256\.forays is not a 64-hex sha256/);

    put(dir, POINTER_PATH, pointerText({ ...good, built_at: "yesterday" }));
    assert.match(pointerProblems(dir, ID).join("\n"), /built_at is not an ISO-8601 timestamp/);
  });
});

test("a directory file missing on disk is reported once per file, not as a crash", () => {
  /* KILLED BY: removing the `${rel} is missing on disk` push + `continue` —
     statSync then throws out of the checker. */
  withTree(dataTree, (dir) => {
    writePointer(dir, ID, WHEN);
    rmSync(path.join(dir, DIRECTORY_FILES.forays));
    assert.deepEqual(pointerProblems(dir, ID), ["data/forays.json is missing on disk"]);
  });
});

// ------------------------------------------------------------ the real CLI --

/* The real tool, run against a scratch tree that has every file the committed
   manifest lists (so the tool's private SHELL / RUNTIME_DATA / player lists
   are satisfied whatever they are today) with tiny LF bodies. */
const CLI_MODULES = ["generate-manifest.mjs", "crlf-guard.mjs", "forays-directory.mjs"];

function cliTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "forays-directory-cli-"));
  for (const m of CLI_MODULES) {
    mkdirSync(path.join(dir, "tools", "ci"), { recursive: true });
    copyFileSync(path.join(HERE, m), path.join(dir, "tools", "ci", m));
  }
  const listed = Object.keys(JSON.parse(readFileSync(path.join(REPO, "deploy-manifest.json"), "utf8")).files);
  for (const rel of listed) {
    if (rel === POINTER_PATH) continue;
    if (rel === DIRECTORY_FILES.forays) put(dir, rel, FORAYS);
    else if (rel === DIRECTORY_FILES.segments) put(dir, rel, SEGMENTS);
    else if (rel === DIRECTORY_FILES.sources) put(dir, rel, SOURCES);
    else if (rel.endsWith(".png")) put(dir, rel, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    else put(dir, rel, `/* ${rel} */\n`);
  }
  put(dir, "sw.js", 'const CACHE_PREFIX = "foray-gen-";\nconst BUILD_ID = "unset";\n');
  return dir;
}

function run(dir, flag) {
  const r = spawnSync(process.execPath, [path.join(dir, "tools", "ci", "generate-manifest.mjs"), flag], {
    encoding: "utf8",
    cwd: dir,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readJson(dir, rel) {
  return JSON.parse(readFileSync(path.join(dir, rel), "utf8"));
}

test("CLI: --write writes the pointer, lists it in the manifest, and stamps one id into all three", () => {
  /* The whole card in one run: pointer.version == manifest.deploy_id ==
     sw.js BUILD_ID, the manifest carries the pointer's real sha256, and the
     id does not depend on the pointer.
     KILLED BY: dropping the `[POINTER_PATH]: ...` entry in withPointerEntry
     (generate-manifest.mjs), or `writePointer(...)` there. */
  withTree(cliTree, (dir) => {
    const w = run(dir, "--write");
    assert.equal(w.status, 0, w.stderr);
    assert.match(w.stdout, /forays-directory\.json written — version [0-9a-f]{16}/);

    const pointer = readJson(dir, POINTER_PATH);
    const manifest = readJson(dir, "deploy-manifest.json");
    const sw = readFileSync(path.join(dir, "sw.js"), "utf8");
    assert.equal(pointer.version, manifest.deploy_id);
    assert.match(sw, new RegExp(`const BUILD_ID = "${manifest.deploy_id}";`));
    assert.equal(manifest.files[POINTER_PATH], "sha256:" + sha(readFileSync(path.join(dir, POINTER_PATH))));
    assert.equal(manifest.deploy_id, deployIdFrom(manifest.files));
    assert.deepEqual(pointer.sha256, { forays: sha(FORAYS), segments: sha(SEGMENTS), sources: sha(SOURCES) });
    assert.deepEqual(Object.keys(manifest.files), Object.keys(manifest.files).slice().sort(), "manifest keys are sorted");
  });
});

test("CLI: --check is green right after --write, and --write again is byte-identical", () => {
  /* KILLED BY: `now = new Date()` -> a fresh pointer written unconditionally
     (removing the samePointerContent short-circuit) — the second --write then
     moves built_at and the manifest entry with it. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, "--write").status, 0);
    const c = run(dir, "--check");
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /deploy-manifest\.json is up to date/);
    const before = [readFileSync(path.join(dir, POINTER_PATH)), readFileSync(path.join(dir, "deploy-manifest.json"))];
    const w2 = run(dir, "--write");
    assert.equal(w2.status, 0, w2.stderr);
    assert.match(w2.stdout, /forays-directory\.json unchanged/);
    assert.ok(readFileSync(path.join(dir, POINTER_PATH)).equals(before[0]));
    assert.ok(readFileSync(path.join(dir, "deploy-manifest.json")).equals(before[1]));
  });
});

test("CLI: a stale pointer (data file changed after --write) turns --check red, naming the pointer", () => {
  /* The card's named mutation. The manifest is stale too, but the pointer is
     reported FIRST and by name, so the reader is not sent to the wrong file.
     KILLED BY: removing the `pointerProblems` block from --check in
     generate-manifest.mjs — the run still fails, but on the manifest diff,
     and the pointer-specific message this asserts is gone. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, "--write").status, 0);
    put(dir, DIRECTORY_FILES.forays, FORAYS.replace("f1", "f9"));
    const c = run(dir, "--check");
    assert.equal(c.status, 1);
    assert.match(c.stderr, /FATAL: data\/forays-directory\.json is stale or malformed/);
    assert.match(c.stderr, /version is "[0-9a-f]{16}" but the tree computes to deploy_id [0-9a-f]{16}/);
    assert.match(c.stderr, /sha256\.forays /);
    assert.match(c.stderr, /generate-manifest\.mjs --write/);
  });
});

test("CLI: a pointer whose version was hand-edited turns --check red even though every file matches", () => {
  /* KILLED BY: `pointer.version !== deployId` -> `false` in pointerProblems
     (the manifest diff would still catch the changed pointer bytes, but on the
     wrong message — this asserts the version line). */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, "--write").status, 0);
    const p = readJson(dir, POINTER_PATH);
    put(dir, POINTER_PATH, pointerText({ ...p, version: "0000000000000000" }));
    const c = run(dir, "--check");
    assert.equal(c.status, 1);
    assert.match(c.stderr, /version is "0000000000000000"/);
  });
});

test("CLI: a missing pointer turns --check red", () => {
  /* The card's other named mutation. KILLED BY: `if (error) return [error];`
     -> `if (error) return [];` in pointerProblems — the manifest diff then
     reports the pointer as a "removed" file, which is a different, less
     useful message. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, "--write").status, 0);
    rmSync(path.join(dir, POINTER_PATH));
    const c = run(dir, "--check");
    assert.equal(c.status, 1);
    assert.match(c.stderr, /data\/forays-directory\.json is missing/);
  });
});

test("CLI: a pointer whose bytes moved but whose content is still right is caught by the manifest entry", () => {
  /* A rewritten built_at is content-correct for FD-03 but the manifest entry
     is what sw.js verifies the served bytes against; a pointer the manifest
     cannot vouch for is a torn generation. KILLED BY: dropping
     `[POINTER_PATH]` from withPointerEntry in generate-manifest.mjs — the
     pointer then has no manifest entry to be caught by. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, "--write").status, 0);
    const p = readJson(dir, POINTER_PATH);
    put(dir, POINTER_PATH, pointerText({ ...p, built_at: "2030-01-01T00:00:00.000Z" }));
    const c = run(dir, "--check");
    assert.equal(c.status, 1);
    assert.match(c.stderr, /deploy-manifest\.json is stale/);
    assert.ok(!/forays-directory\.json is stale or malformed/.test(c.stderr), "the pointer itself is content-correct");
  });
});

test("CLI: a data change followed by --write moves version, built_at and BUILD_ID together", () => {
  /* Publishing a Foray IS this transition. KILLED BY: `stampBuildId(computed
     .deploy_id)` removed from --write — the pointer and manifest move, sw.js
     does not, and --check's own BUILD_ID guard is what would then fire. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, "--write").status, 0);
    const before = readJson(dir, POINTER_PATH);
    put(dir, DIRECTORY_FILES.segments, SEGMENTS.replace('"end":30', '"end":31'));
    const w = run(dir, "--write");
    assert.equal(w.status, 0, w.stderr);
    const after = readJson(dir, POINTER_PATH);
    const manifest = readJson(dir, "deploy-manifest.json");
    assert.notEqual(after.version, before.version);
    assert.equal(after.version, manifest.deploy_id);
    assert.match(readFileSync(path.join(dir, "sw.js"), "utf8"), new RegExp(`BUILD_ID = "${after.version}"`));
    assert.notEqual(after.sha256.segments, before.sha256.segments);
    assert.equal(after.sha256.forays, before.sha256.forays);
    assert.ok(Date.parse(after.built_at) > Date.parse(before.built_at) || after.built_at !== before.built_at);
    assert.equal(run(dir, "--check").status, 0);
  });
});

test("CLI: the guard still refuses a CRLF tree before touching the pointer", () => {
  /* The pointer is on the guard's list: a CRLF checkout must not get as far as
     writing it. KILLED BY: `[...listedFiles(), POINTER_PATH]` ->
     `listedFiles()` in assertLfCheckout — with only the pointer CRLF the tool
     then runs, and hashes bytes we do not ship. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, "--write").status, 0);
    const lf = readFileSync(path.join(dir, POINTER_PATH), "utf8");
    put(dir, POINTER_PATH, lf.replace(/\n/g, "\r\n"));
    const c = run(dir, "--check");
    assert.equal(c.status, 1);
    assert.match(c.stderr, /CRLF line endings/);
    assert.match(c.stderr, /forays-directory\.json/);
    assert.ok(existsSync(path.join(dir, POINTER_PATH)));
  });
});
