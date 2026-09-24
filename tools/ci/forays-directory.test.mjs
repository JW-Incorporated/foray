/* The deploy stamp — tools/ci/forays-directory.mjs (the Foray directory
 * pointer, FD-02) and tools/ci/generate-manifest.mjs (the manifest, sw.js's
 * BUILD_ID, and the rule that none of it is committed, issue #701).
 *
 * WHAT THIS SUITE IS FOR. `data/forays-directory.json` is what the native
 * shell (FD-03) trusts to decide whether the three Foray data files it holds
 * are current, and what it verifies the fetched files against. A pointer that
 * names the wrong version or the wrong hashes is either a phone that never
 * updates or a phone that refuses a good set forever. So a built tree's stamp
 * has to be red for every way the pointer can disagree with the files, and
 * `built_at` has to move forward with `main` — a revert included.
 *
 * WHAT CHANGED WITH #701. The stamp used to be committed, regenerated on every
 * PR by manifest-autofix.yml, and so every merge conflicted with every open PR.
 * It is written into a BUILT tree now (`dist/`, the Pages checkout), `built_at`
 * is the built commit's committer date, and `--check` only asserts that nothing
 * generated is committed. The old idempotence tests (so the bot would not push
 * a built_at-only commit) and the merge-base "floor" tests (so a revert's
 * restored old stamp was restamped) are gone with the committed file; the revert
 * case is pinned again below, end to end, against the new clock.
 *
 * TWO LAYERS, BOTH REAL. The pure functions are exercised on scratch trees
 * with real bytes on a real filesystem. The CLI tests copy the REAL
 * `generate-manifest.mjs` (and the two modules it imports) into a scratch
 * tree whose listed files are tiny LF fixtures, then run it as a subprocess
 * exactly the way the Pages workflow and CI's `data-and-site` job do. The
 * listed-file names come from the generator's own `listedFiles()`, so this
 * suite cannot drift from them.
 *
 * EVERY TEST NAMES THE ONE-LINE MUTATION THAT KILLS IT, per CLAUDE.md § "A
 * green test is not evidence until you have broken it".
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
  pointerProblems,
  buildTimestamp,
} from "./forays-directory.mjs";
import { listedFiles } from "./generate-manifest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

/** What a build writes for the pointer — the same two calls `stampBuild` makes. */
function writeP(dir, id, when) {
  put(dir, POINTER_PATH, pointerText(buildPointer(dir, id, when)));
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
    writeP(dir, ID, WHEN);
    const onDisk = readFileSync(path.join(dir, POINTER_PATH), "utf8");
    assert.equal(onDisk, JSON.stringify(buildPointer(dir, ID, WHEN), null, 2) + "\n");
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

// --------------------------------------------------------------- problems --

test("a freshly written pointer has no problems", () => {
  /* The baseline every red test below is measured against.
     KILLED BY: `problems.push("always")` at the top of pointerProblems. */
  withTree(dataTree, (dir) => {
    writeP(dir, ID, WHEN);
    assert.deepEqual(pointerProblems(dir, ID), []);
  });
});

test("a missing pointer is a problem that names the file", () => {
  /* KILLED BY: `return { pointer: null, error: null }` for the missing case in
     readPointer — pointerProblems then reports "not a JSON object" at best. */
  withTree(dataTree, (dir) => {
    assert.deepEqual(pointerProblems(dir, ID), ["data/forays-directory.json is missing"]);
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
    writeP(dir, ID, WHEN);
    const problems = pointerProblems(dir, "fedcba9876543210");
    assert.equal(problems.length, 1);
    assert.match(problems[0], /version is "0123456789abcdef" but the tree computes to deploy_id fedcba9876543210/);
  });
});

test("a file that changed size after the pointer was written is caught by bytes AND sha256", () => {
  /* KILLED BY: removing the `bytes.${key}` push — the sha256 line still fires,
     so this asserts BOTH are reported. */
  withTree(dataTree, (dir) => {
    writeP(dir, ID, WHEN);
    put(dir, DIRECTORY_FILES.segments, SEGMENTS + '{"appended":true}\n');
    const problems = pointerProblems(dir, ID);
    assert.equal(problems.length, 2, problems.join("\n"));
    assert.match(problems[0], /^bytes\.segments is \d+ but data\/segments\.json is \d+ bytes on disk$/);
    assert.match(problems[1], /^sha256\.segments is [0-9a-f]{12}… but data\/segments\.json hashes to [0-9a-f]{12}… on disk$/);
  });
});

test("a same-size edit is caught by sha256 alone — bytes is a hint, not the check", () => {
  /* A Foray id retyped, a URL with one character changed: same length, wrong
     content. KILLED BY: `if (got !== want)` -> `if (false)` in pointerProblems. */
  withTree(dataTree, (dir) => {
    writeP(dir, ID, WHEN);
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
    writeP(dir, ID, WHEN);
    rmSync(path.join(dir, DIRECTORY_FILES.forays));
    assert.deepEqual(pointerProblems(dir, ID), ["data/forays.json is missing on disk"]);
  });
});

// ------------------------------------------------ built_at: the phone's order --

/* `core.autocrlf=false` is not incidental: the developer machines this runs on
   set it globally to `true`, and a checkout that rewrote these fixtures' LFs to
   CRLF would change their sha256s. */
function git(dir, args, env = {}) {
  const r = spawnSync("git", ["-c", "user.email=t@t.invalid", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** A commit whose committer date is `iso` — how a merge to main lands. */
function commitAt(dir, message, iso, authorIso = iso) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", message], { GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: authorIso });
}

const NO_EPOCH = { env: {} };

test("built_at is the built commit's committer date, normalised to UTC", () => {
  /* Two builds of one commit (the Vercel build and the Pages workflow of the same
     merge, or a redeploy) must serve the SAME pointer, and the stamp means "when
     this version reached main". KILLED BY: `%cI` -> `%aI` in buildTimestamp (a
     squash merge keeps the PR's older AUTHOR date), or returning the clock first. */
  withTree(dataTree, (dir) => {
    git(dir, ["init", "-q", "-b", "main"]);
    /* A squash merge: authored days earlier on the PR branch, committed at merge. */
    commitAt(dir, "v1", "2026-09-10T05:00:00-07:00", "2026-09-01T00:00:00Z");
    const t = buildTimestamp(dir, NO_EPOCH);
    assert.deepEqual(t, { builtAt: "2026-09-10T12:00:00.000Z", source: "git" });
    assert.deepEqual(buildTimestamp(dir, NO_EPOCH), t, "stable across builds of one commit");
  });
});

test("SOURCE_DATE_EPOCH wins when it is an integer, and is ignored when it is not", () => {
  /* The reproducible-builds convention: a rebuild or a test can pin the stamp
     without git. KILLED BY: dropping the SOURCE_DATE_EPOCH branch, or dropping
     its `/^\d+$/` guard (a garbage value then becomes "Invalid Date" and throws). */
  withTree(dataTree, (dir) => {
    assert.deepEqual(buildTimestamp(dir, { env: { SOURCE_DATE_EPOCH: "1757505600" } }), {
      builtAt: "2025-09-10T12:00:00.000Z",
      source: "SOURCE_DATE_EPOCH",
    });
    const fallback = buildTimestamp(dir, { env: { SOURCE_DATE_EPOCH: "yesterday" }, now: () => WHEN });
    assert.notEqual(fallback.source, "SOURCE_DATE_EPOCH");
  });
});

test("no git at all falls back to the clock rather than throwing", () => {
  /* A build that cannot read git must still ship. KILLED BY: removing the
     try/catch in gitOut. */
  withTree(dataTree, (dir) => {
    assert.deepEqual(buildTimestamp(dir, { env: {}, now: () => WHEN }), {
      builtAt: WHEN.toISOString(),
      source: "clock",
    });
  });
});

test("END TO END (audit finding C, re-pinned for #701): a git revert gets a NEWER built_at, so a phone adopts the rollback", async () => {
  /* The defect the old merge-base floor patched: a revert restored the COMMITTED
     pointer's old `built_at`, and every phone holding the reverted version refused
     it forever (`player/foray-directory.js`, STATUS.OLDER). With nothing committed,
     the stamp is the revert commit's own date — newer by construction.
     KILLED BY: deriving built_at from anything a revert restores (a committed
     value, or the date of the last commit to touch data/), or by `buildTimestamp`
     reading the AUTHOR date — `git revert` keeps neither old. */
  const { isOlderThan } = await import("../../player/foray-directory.js");

  withTree(dataTree, (dir) => {
    git(dir, ["init", "-q", "-b", "main"]);
    commitAt(dir, "v1", "2026-09-10T12:00:00Z");
    const v1 = buildPointer(dir, ID, new Date(buildTimestamp(dir, NO_EPOCH).builtAt));

    put(dir, DIRECTORY_FILES.forays, FORAYS.replace("f1", "f2"));
    commitAt(dir, "v2 — Generated Foray", "2026-09-11T12:00:00Z");
    const v2 = buildPointer(dir, "fedcba9876543210", new Date(buildTimestamp(dir, NO_EPOCH).builtAt));
    assert.equal(isOlderThan(v2.built_at, v1.built_at), false);

    // The rollback: a revert COMMIT, landing later.
    git(dir, ["revert", "--no-edit", "HEAD"], { GIT_COMMITTER_DATE: "2026-09-12T12:00:00Z" });
    assert.equal(readFileSync(path.join(dir, DIRECTORY_FILES.forays), "utf8"), FORAYS, "the revert restores v1's data");
    const rolledBack = buildPointer(dir, ID, new Date(buildTimestamp(dir, NO_EPOCH).builtAt));
    assert.equal(rolledBack.built_at, "2026-09-12T12:00:00.000Z");
    assert.deepEqual(rolledBack.sha256, v1.sha256, "the rollback ships v1's content");
    assert.equal(
      isOlderThan(rolledBack.built_at, v2.built_at),
      false,
      "and a phone holding v2 reads it as NEWER, so it adopts the rollback"
    );
  });
});

// ------------------------------------------------------------ the real CLI --

/* The real tool, run against a scratch tree that has every file the generator
   lists (so its private SHELL / RUNTIME_DATA / player lists are satisfied
   whatever they are today) with tiny LF bodies. */
const CLI_MODULES = ["generate-manifest.mjs", "crlf-guard.mjs", "forays-directory.mjs"];
const EPOCH = "1757505600"; // 2025-09-10T12:00:00Z — pins built_at for the CLI runs

function cliTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "forays-directory-cli-"));
  for (const m of CLI_MODULES) {
    mkdirSync(path.join(dir, "tools", "ci"), { recursive: true });
    copyFileSync(path.join(HERE, m), path.join(dir, "tools", "ci", m));
  }
  for (const rel of listedFiles().map((f) => f.split(path.sep).join("/"))) {
    if (rel === DIRECTORY_FILES.forays) put(dir, rel, FORAYS);
    else if (rel === DIRECTORY_FILES.segments) put(dir, rel, SEGMENTS);
    else if (rel === DIRECTORY_FILES.sources) put(dir, rel, SOURCES);
    else if (rel.endsWith(".png") || rel.endsWith(".woff2")) put(dir, rel, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    else put(dir, rel, `/* ${rel} */\n`);
  }
  put(dir, "sw.js", 'const CACHE_PREFIX = "foray-gen-";\nconst BUILD_ID = "unstamped";\n');
  return dir;
}

function run(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(dir, "tools", "ci", "generate-manifest.mjs"), ...args], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, SOURCE_DATE_EPOCH: EPOCH, CI: "true", ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readJson(dir, rel) {
  return JSON.parse(readFileSync(path.join(dir, rel), "utf8"));
}

test("CLI: --stamp writes the pointer, lists it in the manifest, and stamps one id into all three", () => {
  /* The whole stamp in one run: pointer.version == manifest.deploy_id ==
     sw.js BUILD_ID, the manifest carries the pointer's real sha256, and the
     id does not depend on the pointer.
     KILLED BY: dropping the `[POINTER_PATH]: ...` entry in withPointerEntry,
     or the `stampBuildId(...)` call in stampBuild. */
  withTree(cliTree, (dir) => {
    const w = run(dir, ["--stamp", "."]);
    assert.equal(w.status, 0, w.stderr);
    assert.match(w.stdout, /stamped \. — deploy_id [0-9a-f]{16}/);

    const pointer = readJson(dir, POINTER_PATH);
    const manifest = readJson(dir, "deploy-manifest.json");
    const sw = readFileSync(path.join(dir, "sw.js"), "utf8");
    assert.equal(pointer.version, manifest.deploy_id);
    assert.equal(pointer.built_at, "2025-09-10T12:00:00.000Z");
    assert.match(sw, new RegExp(`const BUILD_ID = "${manifest.deploy_id}";`));
    assert.equal(manifest.files[POINTER_PATH], "sha256:" + sha(readFileSync(path.join(dir, POINTER_PATH))));
    assert.equal(manifest.deploy_id, deployIdFrom(manifest.files));
    assert.deepEqual(pointer.sha256, { forays: sha(FORAYS), segments: sha(SEGMENTS), sources: sha(SOURCES) });
    assert.deepEqual(Object.keys(manifest.files), Object.keys(manifest.files).slice().sort(), "manifest keys are sorted");
  });
});

test("CLI: --verify is green right after --stamp, and stamping one commit twice is byte-identical", () => {
  /* Two builds of one commit must serve the same bytes, or the Vercel and Pages
     copies of one merge disagree. KILLED BY: `builtAt` taken from the clock in
     place of buildTimestamp — the second stamp then moves built_at, the pointer's
     bytes and its manifest entry. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, ["--stamp", "."]).status, 0);
    const c = run(dir, ["--verify", "."]);
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /verifies/);
    const before = [readFileSync(path.join(dir, POINTER_PATH)), readFileSync(path.join(dir, "deploy-manifest.json"))];
    assert.equal(run(dir, ["--stamp", "."]).status, 0);
    assert.ok(readFileSync(path.join(dir, POINTER_PATH)).equals(before[0]));
    assert.ok(readFileSync(path.join(dir, "deploy-manifest.json")).equals(before[1]));
  });
});

test("CLI: a data file changed after stamping turns --verify red, naming the pointer", () => {
  /* A build step that touched a data file after the stamp is the torn deploy the
     phone and sw.js would both refuse in production. KILLED BY: removing the
     `pointerProblems` line from stampedProblems — the run still fails on the
     manifest, but the pointer-specific lines this asserts are gone. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, ["--stamp", "."]).status, 0);
    put(dir, DIRECTORY_FILES.forays, FORAYS.replace("f1", "f9"));
    const c = run(dir, ["--verify", "."]);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /data\/forays-directory\.json: version is "[0-9a-f]{16}" but the tree computes to deploy_id [0-9a-f]{16}/);
    assert.match(c.stderr, /sha256\.forays /);
  });
});

test("CLI: a pointer whose version was hand-edited turns --verify red even though every file matches", () => {
  /* KILLED BY: `pointer.version !== deployId` -> `false` in pointerProblems
     (the manifest entry would still catch the changed pointer bytes, but on the
     wrong message — this asserts the version line). */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, ["--stamp", "."]).status, 0);
    const p = readJson(dir, POINTER_PATH);
    put(dir, POINTER_PATH, pointerText({ ...p, version: "0000000000000000" }));
    const c = run(dir, ["--verify", "."]);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /version is "0000000000000000"/);
  });
});

test("CLI: a stamped tree with its pointer deleted turns --verify red", () => {
  /* The phones read the pointer from the live origin; a deploy without one is a
     phone that never updates. KILLED BY: `if (error) return [error];` ->
     `return [];` in pointerProblems. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, ["--stamp", "."]).status, 0);
    rmSync(path.join(dir, POINTER_PATH));
    const c = run(dir, ["--verify", "."]);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /data\/forays-directory\.json is missing/);
  });
});

test("CLI: a pointer whose bytes moved but whose content is still right is caught by the manifest entry", () => {
  /* sw.js verifies the served pointer's bytes against its manifest entry; a
     pointer the manifest cannot vouch for is a torn generation. KILLED BY: the
     per-entry comparison loop in stampedProblems. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, ["--stamp", "."]).status, 0);
    const p = readJson(dir, POINTER_PATH);
    put(dir, POINTER_PATH, pointerText({ ...p, built_at: "2030-01-01T00:00:00.000Z" }));
    const c = run(dir, ["--verify", "."]);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /entry data\/forays-directory\.json does not match the bytes on disk/);
    assert.ok(!/version is/.test(c.stderr), "the pointer itself is content-correct");
  });
});

test("CLI: sw.js left unstamped (or stamped with another id) turns --verify red", () => {
  /* Without the stamp an app.js-only deploy leaves sw.js byte-identical and no
     returning browser ever reinstalls. KILLED BY: dropping the BUILD_ID branch
     from stampedProblems. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, ["--stamp", "."]).status, 0);
    put(dir, "sw.js", 'const CACHE_PREFIX = "foray-gen-";\nconst BUILD_ID = "unstamped";\n');
    const c = run(dir, ["--verify", "."]);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /sw\.js's BUILD_ID is "unstamped" but the tree computes to [0-9a-f]{16}/);
  });
});

test("CLI: a data change followed by a new stamp moves version and BUILD_ID together", () => {
  /* Publishing a Foray IS this transition. KILLED BY: stamping sw.js with the
     manifest's OLD id, or writing the pointer before computing the id. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, ["--stamp", "."]).status, 0);
    const before = readJson(dir, POINTER_PATH);
    put(dir, DIRECTORY_FILES.segments, SEGMENTS.replace('"end":30', '"end":31'));
    const w = run(dir, ["--stamp", "."], { SOURCE_DATE_EPOCH: "1757592000" });
    assert.equal(w.status, 0, w.stderr);
    const after = readJson(dir, POINTER_PATH);
    const manifest = readJson(dir, "deploy-manifest.json");
    assert.notEqual(after.version, before.version);
    assert.equal(after.version, manifest.deploy_id);
    assert.match(readFileSync(path.join(dir, "sw.js"), "utf8"), new RegExp(`BUILD_ID = "${after.version}"`));
    assert.notEqual(after.sha256.segments, before.sha256.segments);
    assert.equal(after.sha256.forays, before.sha256.forays);
    assert.ok(Date.parse(after.built_at) > Date.parse(before.built_at));
    assert.equal(run(dir, ["--verify", "."]).status, 0);
  });
});

test("CLI: --stamp refuses a CRLF tree before writing anything", () => {
  /* A stamp computed over CRLF bytes names a deploy no Linux build serves.
     KILLED BY: removing the `crlfIn(dir)` check from stampBuild. */
  withTree(cliTree, (dir) => {
    put(dir, "app.js", "/* app.js */\r\nconst x = 1;\r\n");
    const c = run(dir, ["--stamp", "."]);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /CRLF line endings/);
    assert.match(c.stderr, /app\.js/);
    assert.equal(existsSync(path.join(dir, POINTER_PATH)), false);
    assert.equal(existsSync(path.join(dir, "deploy-manifest.json")), false);
  });
});

test("CLI: --stamp refuses the checkout it lives in unless CI says the tree is throwaway", () => {
  /* Stamping your own working tree rewrites the tracked sw.js — the exact commit
     --check refuses. KILLED BY: dropping the `realOrSelf(dir) === realOrSelf(ROOT)`
     guard. */
  withTree(cliTree, (dir) => {
    const c = run(dir, ["--stamp", "."], { CI: "" });
    assert.equal(c.status, 1);
    assert.match(c.stderr, /would rewrite this checkout's tracked sw\.js/);
    assert.match(readFileSync(path.join(dir, "sw.js"), "utf8"), /BUILD_ID = "unstamped"/);
  });
});

test("CLI: --write is gone, and says where the stamp is made now", () => {
  /* An agent following an old doc must be told, not silently handed a
     working-tree stamp to commit. KILLED BY: deleting the `--write` branch —
     the usage line exits 2 without naming prepare-dist. */
  withTree(cliTree, (dir) => {
    const c = run(dir, ["--write"]);
    assert.equal(c.status, 2);
    assert.match(c.stderr, /no longer exists \(issue #701\)/);
    assert.match(c.stderr, /prepare-dist\.mjs/);
  });
});

// ------------------------------------------ --check: nothing is committed --

/** The CLI tree as a git repo with the real .gitignore rules for the stamp. */
function gitCliTree() {
  const dir = cliTree();
  put(dir, ".gitignore", "/deploy-manifest.json\n/data/forays-directory.json\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  return dir;
}

test("CLI: --check is green on a clean source tree: nothing generated tracked, sw.js unstamped", () => {
  /* The baseline. KILLED BY: `problems.push` of anything unconditional in
     sourceProblems. */
  withTree(gitCliTree, (dir) => {
    const c = run(dir, ["--check"]);
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /no generated deploy artefact is committed/);
  });
});

test("CLI: --check is red when a generated file is committed again — the #701 conflict magnet", () => {
  /* The regression this whole change exists to prevent. `git add -f` is how it
     would come back past the .gitignore. KILLED BY: dropping the `ls-files` loop
     from sourceProblems. */
  withTree(gitCliTree, (dir) => {
    assert.equal(run(dir, ["--stamp", "."]).status, 0);
    put(dir, "sw.js", 'const CACHE_PREFIX = "foray-gen-";\nconst BUILD_ID = "unstamped";\n');
    git(dir, ["add", "-f", "deploy-manifest.json"]);
    const c = run(dir, ["--check"]);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /deploy-manifest\.json is committed/);
    assert.match(c.stderr, /git rm --cached deploy-manifest\.json/);
  });
});

test("CLI: --check is red on a committed sw.js that carries a stamp", () => {
  /* A stamped BUILD_ID line is the other half of the conflict. KILLED BY:
     dropping the UNSTAMPED_BUILD_ID comparison from sourceProblems. */
  withTree(gitCliTree, (dir) => {
    put(dir, "sw.js", 'const CACHE_PREFIX = "foray-gen-";\nconst BUILD_ID = "8319327039d3563f";\n');
    const c = run(dir, ["--check"]);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /sw\.js carries BUILD_ID "8319327039d3563f"/);
  });
});

test("CLI: --check is red when .gitignore stops covering a generated file", () => {
  /* Without the ignore, the first `git add -A` after a local build commits it.
     KILLED BY: dropping the `check-ignore` loop from sourceProblems. */
  withTree(gitCliTree, (dir) => {
    put(dir, ".gitignore", "/deploy-manifest.json\n");
    const c = run(dir, ["--check"]);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /data\/forays-directory\.json is not in \.gitignore/);
  });
});
