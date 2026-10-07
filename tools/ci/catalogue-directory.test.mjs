/* The catalogue directory pointer — tools/ci/catalogue-directory.mjs, and the
 * way tools/ci/generate-manifest.mjs stamps it into a BUILT tree (issue #40,
 * narrowed 2026-09-30; never committed, issue #701).
 *
 * WHAT THIS SUITE IS FOR. `data/catalogue-directory.json` is what the native
 * shell will trust to decide whether the five frozen catalogue documents it
 * holds are behind the live site, and what it verifies fetched files against.
 * A pointer naming the wrong version or the wrong hashes is a phone that never
 * updates or one that refuses a good catalogue forever. So: the pointer's shape
 * is measured from real bytes, every way it can disagree with the files is red
 * in `--verify`, it shares the Foray pointer's version and `built_at`, the
 * manifest's deploy id does not move because of it, and `--check` keeps it out
 * of the tree exactly as it keeps the Foray pointer out.
 *
 * TWO LAYERS, as in forays-directory.test.mjs: pure functions on scratch trees,
 * and the REAL generator (with every module it imports) copied into a scratch
 * tree of tiny LF fixtures and run as a subprocess, the way the Pages workflow
 * and CI's `data-and-site` job run it.
 *
 * EVERY TEST NAMES THE ONE-LINE MUTATION THAT KILLS IT, per CLAUDE.md, and each
 * one was run. The floor for this suite lives in test/suite-integrity.test.js.
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATALOGUE_POINTER_PATH,
  CATALOGUE_FILES,
  buildCataloguePointer,
  cataloguePointerText,
  cataloguePointerProblems,
} from "./catalogue-directory.mjs";
import { POINTER_PATH } from "./forays-directory.mjs";
import { GENERATED, RUNTIME_DATA, STAMP_MODULE_FILES, listedFiles } from "./generate-manifest.mjs";
import { pathMatters } from "../web/vercel-should-build.mjs";
import {
  CATALOGUE_POINTER_PATH as CLIENT_POINTER_PATH,
  CATALOGUE_FILE_KEYS,
  validateCataloguePointer,
  checkFetchedFile,
} from "../../player/catalogue-directory.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");

const sha = (s) => createHash("sha256").update(s).digest("hex");

const BODIES = Object.freeze({
  discover: '{"items":[{"id":"i1"}]}\n',
  session: '{"cards":[]}\n',
  taxonomy: '{"nodes":[]}\n',
  itemTags: '{"i1":["t1"]}\n',
  semanticIndex: '{"vectors":[]}\n',
});

function put(dir, rel, bytes) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}

/** A scratch tree holding just the five catalogue files. */
function dataTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "catalogue-directory-"));
  for (const [key, rel] of Object.entries(CATALOGUE_FILES)) put(dir, rel, BODIES[key]);
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

function writeP(dir, id, when) {
  put(dir, CATALOGUE_POINTER_PATH, cataloguePointerText(buildCataloguePointer(dir, id, when)));
}

const ID = "0123456789abcdef";
const WHEN = new Date("2026-10-05T03:00:00.000Z");

// --------------------------------------------------------------- the shape --

test("the catalogue pointer carries version, built_at, and the five files with their real bytes and sha256", () => {
  /* The contract the shell will read; every number measured from disk.
     KILLED BY: `bytes[key] = 0;` in makeDirectoryPointer's build, or dropping the
     `sha256[key] =` line. */
  withTree(dataTree, (dir) => {
    const p = buildCataloguePointer(dir, ID, WHEN);
    assert.deepEqual(Object.keys(p), ["version", "built_at", "files", "bytes", "sha256"]);
    assert.equal(p.version, ID);
    assert.equal(p.built_at, "2026-10-05T03:00:00.000Z");
    assert.deepEqual(p.files, { ...CATALOGUE_FILES });
    for (const key of Object.keys(CATALOGUE_FILES)) {
      assert.equal(p.bytes[key], Buffer.byteLength(BODIES[key]), `bytes.${key}`);
      assert.equal(p.sha256[key], sha(BODIES[key]), `sha256.${key}`);
    }
    assert.equal(cataloguePointerText(p), JSON.stringify(p, null, 2) + "\n");
  });
});

test("a catalogue file missing on disk is a thrown error naming it, not a pointer with a hole", () => {
  /* KILLED BY: deleting the `if (!existsSync(abs)) throw` in
     makeDirectoryPointer's build — readFileSync then throws a bare ENOENT. */
  withTree(dataTree, (dir) => {
    rmSync(path.join(dir, CATALOGUE_FILES.semanticIndex));
    assert.throws(() => buildCataloguePointer(dir, ID, WHEN), /catalogue-directory: listed file is missing on disk: data\/semantic-index\.json/);
  });
});

test("the five files are the ones the ruling froze, and every one ships in a deploy", () => {
  /* DECISIONS "v1 ships the catalogue frozen": discover, session, taxonomy,
     item-tags, semantic-index. A file outside RUNTIME_DATA is not copied into
     dist/, so stampBuild would throw on every Vercel build. KILLED BY: adding
     `forays: "data/forays.json"` to CATALOGUE_FILES (the Forays have their own
     pointer), or removing "item-tags.json" from generate-manifest's RUNTIME_DATA. */
  assert.deepEqual(Object.values(CATALOGUE_FILES), [
    "data/discover.json", "data/session.json", "data/taxonomy.json", "data/item-tags.json", "data/semantic-index.json",
  ]);
  for (const rel of Object.values(CATALOGUE_FILES)) {
    assert.ok(RUNTIME_DATA.includes(rel.replace(/^data\//, "")), `${rel} is not in RUNTIME_DATA, so no deploy ships it`);
  }
  assert.ok(Object.isFrozen(CATALOGUE_FILES));
});

test("writer and reader agree: one path, the same five keys in order, and a written pointer validates whole", () => {
  /* The writer is tools/ci; the reader is player/. Two copies of a contract
     drift, so this pins them. KILLED BY: renaming a key on either side
     (`itemTags` -> `item_tags`), or a different CATALOGUE_POINTER_PATH. */
  assert.equal(CLIENT_POINTER_PATH, CATALOGUE_POINTER_PATH);
  assert.deepEqual([...CATALOGUE_FILE_KEYS], Object.keys(CATALOGUE_FILES));
  withTree(dataTree, (dir) => {
    const v = validateCataloguePointer(JSON.parse(cataloguePointerText(buildCataloguePointer(dir, ID, WHEN))));
    assert.equal(v.ok, true, JSON.stringify(v));
    for (const [key, rel] of Object.entries(CATALOGUE_FILES)) {
      const bytes = readFileSync(path.join(dir, rel));
      assert.deepEqual(checkFetchedFile(v.pointer, key, { byteLength: bytes.length, sha256: sha(bytes) }), { ok: true, verified: true });
    }
  });
});

// --------------------------------------------------------- pointerProblems --

test("a current catalogue pointer has no problems; one for another deploy is named", () => {
  /* KILLED BY: dropping the `pointer.version !== deployId` comparison in
     makeDirectoryPointer's problems (forays-directory.mjs). */
  withTree(dataTree, (dir) => {
    writeP(dir, ID, WHEN);
    assert.deepEqual(cataloguePointerProblems(dir, ID), []);
    const stale = cataloguePointerProblems(dir, "fedcba9876543210");
    assert.equal(stale.length, 1);
    assert.match(stale[0], /version is "0123456789abcdef" but the tree computes to deploy_id fedcba9876543210/);
  });
});

test("a catalogue file edited after stamping is named by its sha256, even at the same size", () => {
  /* The torn deploy: a step that rewrote a file after the stamp. Same-size edit,
     so only the digest can see it. KILLED BY: dropping the `got !== want`
     comparison in makeDirectoryPointer's problems. */
  withTree(dataTree, (dir) => {
    writeP(dir, ID, WHEN);
    put(dir, CATALOGUE_FILES.session, BODIES.session.replace("cards", "carts"));
    const problems = cataloguePointerProblems(dir, ID);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /^sha256\.session is [0-9a-f]{12}… but data\/session\.json hashes to/);
  });
});

test("a resized file, a wrong path and an unknown entry are each named", () => {
  /* KILLED BY: dropping the `bytes[key] !== size` comparison, the `files[key]
     !== rel` comparison, or the unknown-entries filter. */
  withTree(dataTree, (dir) => {
    const p = buildCataloguePointer(dir, ID, WHEN);
    p.files.taxonomy = "data/elsewhere.json";
    p.sha256.forays = "0".repeat(64);
    put(dir, CATALOGUE_POINTER_PATH, cataloguePointerText(p));
    put(dir, CATALOGUE_FILES.itemTags, BODIES.itemTags + " ");
    const problems = cataloguePointerProblems(dir, ID).join("\n");
    assert.match(problems, /sha256 names unknown entries: forays/);
    assert.match(problems, /files\.taxonomy is "data\/elsewhere\.json", expected "data\/taxonomy\.json"/);
    assert.match(problems, /bytes\.itemTags is \d+ but data\/item-tags\.json is \d+ bytes on disk/);
  });
});

test("a missing, unparseable, non-object or undated pointer is a problem, never a pass", () => {
  /* KILLED BY: `return []` in place of the missing-pointer return, or dropping
     the built_at parse check. */
  withTree(dataTree, (dir) => {
    assert.deepEqual(cataloguePointerProblems(dir, ID), [`${CATALOGUE_POINTER_PATH} is missing`]);
    put(dir, CATALOGUE_POINTER_PATH, "{not json");
    assert.match(cataloguePointerProblems(dir, ID)[0], /is not valid JSON/);
    put(dir, CATALOGUE_POINTER_PATH, "[1]");
    assert.deepEqual(cataloguePointerProblems(dir, ID), [`${CATALOGUE_POINTER_PATH} is not a JSON object`]);
    const p = buildCataloguePointer(dir, ID, WHEN);
    p.built_at = "soon";
    delete p.bytes;
    put(dir, CATALOGUE_POINTER_PATH, cataloguePointerText(p));
    const problems = cataloguePointerProblems(dir, ID).join("\n");
    assert.match(problems, /built_at is not an ISO-8601 timestamp: "soon"/);
    assert.match(problems, /bytes is missing/);
  });
});

// ------------------------------- byte-for-byte (code-health CH2-22, T2-06) --

/* The catalogue pointer is built and checked by the SAME implementation as the
   Foray pointer (`makeDirectoryPointer` in forays-directory.mjs). These pin its
   output for the catalogue table byte for byte, as it was before the copy in
   this module was deleted; forays-directory.test.mjs pins the Foray table. */

test("CHARACTERIZATION: the exact catalogue pointer bytes, and the exact error for a missing listed file", () => {
  /* KILLED BY: `+ "\n"` -> `""` in makeDirectoryPointer's text, or passing
     "forays-directory" as catalogue-directory.mjs's label. */
  withTree(dataTree, (dir) => {
    assert.equal(
      cataloguePointerText(buildCataloguePointer(dir, ID, WHEN)),
      "{\n" +
        '  "version": "0123456789abcdef",\n' +
        '  "built_at": "2026-10-05T03:00:00.000Z",\n' +
        '  "files": {\n' +
        '    "discover": "data/discover.json",\n' +
        '    "session": "data/session.json",\n' +
        '    "taxonomy": "data/taxonomy.json",\n' +
        '    "itemTags": "data/item-tags.json",\n' +
        '    "semanticIndex": "data/semantic-index.json"\n' +
        "  },\n" +
        '  "bytes": {\n' +
        '    "discover": 24,\n' +
        '    "session": 13,\n' +
        '    "taxonomy": 13,\n' +
        '    "itemTags": 14,\n' +
        '    "semanticIndex": 15\n' +
        "  },\n" +
        '  "sha256": {\n' +
        '    "discover": "085f08a895a677b6ebefcd8241a63e422633c135341dd6d2273b98dd95db7d76",\n' +
        '    "session": "36a7aa3b38b6af1ef276fdf4a55359f227a260eada614a4b7db0977372c14e42",\n' +
        '    "taxonomy": "ac08ce34ba4f8123618661bef2425f7028ffb9ac740578a3ee88684d2523fee8",\n' +
        '    "itemTags": "24d2bdcc127b5977d85bdeb73db93b64d84a2a0751660fdd953662b43d9a6f6f",\n' +
        '    "semanticIndex": "e172ee052119a09a0e8f2fdb5113c6b89ca771b603039544ff02ea34195f0f4b"\n' +
        "  }\n" +
        "}\n"
    );
    rmSync(path.join(dir, CATALOGUE_FILES.discover));
    assert.throws(() => buildCataloguePointer(dir, ID, WHEN), {
      message: "catalogue-directory: listed file is missing on disk: data/discover.json",
    });
  });
});

test("CHARACTERIZATION: every catalogue problem line, in order, word for word", () => {
  /* One torn tree that trips every check at once, against the catalogue's own
     pointer path and table. KILLED BY: `…` -> `...` in the shared
     sha256-mismatch line, or the catalogue module handing the factory
     POINTER_PATH instead of CATALOGUE_POINTER_PATH. */
  withTree(dataTree, (dir) => {
    const p = buildCataloguePointer(dir, ID, WHEN);
    p.built_at = "soon";
    p.files.taxonomy = "data/elsewhere.json";
    p.sha256.forays = "0".repeat(64);
    p.sha256.discover = "abc";
    delete p.bytes;
    put(dir, CATALOGUE_POINTER_PATH, cataloguePointerText(p));
    put(dir, CATALOGUE_FILES.session, BODIES.session.replace("cards", "carts"));
    rmSync(path.join(dir, CATALOGUE_FILES.semanticIndex));
    assert.deepEqual(cataloguePointerProblems(dir, "fedcba9876543210"), [
      'version is "0123456789abcdef" but the tree computes to deploy_id fedcba9876543210',
      'built_at is not an ISO-8601 timestamp: "soon"',
      "bytes is missing",
      "sha256 names unknown entries: forays",
      'sha256.discover is not a 64-hex sha256: "abc"',
      "sha256.session is 36a7aa3b38b6… but data/session.json hashes to 865bea7400d7… on disk",
      'files.taxonomy is "data/elsewhere.json", expected "data/taxonomy.json"',
      "data/semantic-index.json is missing on disk",
    ]);
    rmSync(path.join(dir, CATALOGUE_POINTER_PATH));
    assert.deepEqual(cataloguePointerProblems(dir, ID), ["data/catalogue-directory.json is missing"]);
  });
});

// ------------------------------------------------ the generator, real repo --

test("REAL REPO: the pointer is a generated file — in GENERATED, ignored by .gitignore, and not tracked (#701)", () => {
  /* A committed pointer would conflict with every open PR, exactly as the Foray
     pointer did. KILLED BY: dropping CATALOGUE_POINTER_PATH from GENERATED, or
     the `/data/catalogue-directory.json` line from .gitignore. */
  assert.ok(GENERATED.includes(CATALOGUE_POINTER_PATH), "GENERATED does not name the catalogue pointer");
  const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", CATALOGUE_POINTER_PATH], { cwd: REPO });
  assert.equal(ignored.status, 0, ".gitignore does not cover the catalogue pointer");
  const tracked = execFileSync("git", ["ls-files", "--", CATALOGUE_POINTER_PATH], { cwd: REPO, encoding: "utf8" }).trim();
  assert.equal(tracked, "", "the catalogue pointer is committed");
});

test("REAL REPO: the catalogue module is a stamp module, so Vercel builds when it changes", () => {
  /* It writes bytes Vercel serves; a change to it that Vercel skips is a pointer
     format change that never deploys. KILLED BY: dropping
     "tools/ci/catalogue-directory.mjs" from STAMP_MODULE_FILES (and so from
     vercel-should-build's STAMP_MODULES, which forays-directory.test.mjs pins
     equal). */
  assert.ok(STAMP_MODULE_FILES.includes("tools/ci/catalogue-directory.mjs"));
  assert.equal(pathMatters("tools/ci/catalogue-directory.mjs"), true);
  assert.equal(pathMatters("tools/ci/catalogue-directory.test.mjs"), false, "its test does not build");
});

// ------------------------------------------------------------ the real CLI --

const CLI_MODULES = ["generate-manifest.mjs", "crlf-guard.mjs", "forays-directory.mjs", "catalogue-directory.mjs"];
const EPOCH = "1759633200"; // 2025-10-05T03:00:00Z — pins built_at for the CLI runs

const CATALOGUE_BY_PATH = Object.fromEntries(Object.entries(CATALOGUE_FILES).map(([k, rel]) => [rel, BODIES[k]]));

function cliTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "catalogue-directory-cli-"));
  mkdirSync(path.join(dir, "tools", "ci"), { recursive: true });
  for (const m of CLI_MODULES) copyFileSync(path.join(HERE, m), path.join(dir, "tools", "ci", m));
  for (const rel of listedFiles().map((f) => f.split(path.sep).join("/"))) {
    if (rel in CATALOGUE_BY_PATH) put(dir, rel, CATALOGUE_BY_PATH[rel]);
    else if (rel.endsWith(".png") || rel.endsWith(".woff2")) put(dir, rel, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    else put(dir, rel, `/* ${rel} */\n`);
  }
  put(dir, "sw.js", 'const CACHE_PREFIX = "foray-gen-";\nconst BUILD_ID = "unstamped";\n');
  return dir;
}

function run(dir, args) {
  const r = spawnSync(process.execPath, [path.join(dir, "tools", "ci", "generate-manifest.mjs"), ...args], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, SOURCE_DATE_EPOCH: EPOCH, CI: "true" },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const readJson = (dir, rel) => JSON.parse(readFileSync(path.join(dir, rel), "utf8"));

function git(dir, args) {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid",
    },
  });
}

test("CLI: --stamp writes the catalogue pointer under the Foray pointer's version and built_at, and the manifest does not list it", () => {
  /* One build, one identity: catalogue.version == forays.version ==
     manifest.deploy_id, one built_at for both pointers, and the deploy id is
     unchanged by the catalogue pointer (it is not a manifest entry).
     KILLED BY: dropping the `writeFileSync(path.join(dir, CATALOGUE_POINTER_PATH), ...)`
     line in stampBuild (the pointer is never written). */
  withTree(cliTree, (dir) => {
    const w = run(dir, ["--stamp", "."]);
    assert.equal(w.status, 0, w.stderr);
    const catalogue = readJson(dir, CATALOGUE_POINTER_PATH);
    const forays = readJson(dir, POINTER_PATH);
    const manifest = readJson(dir, "deploy-manifest.json");
    assert.equal(catalogue.version, manifest.deploy_id);
    assert.equal(catalogue.version, forays.version);
    assert.equal(catalogue.built_at, "2025-10-05T03:00:00.000Z");
    assert.equal(catalogue.built_at, forays.built_at);
    assert.deepEqual(catalogue.sha256, Object.fromEntries(Object.entries(BODIES).map(([k, b]) => [k, sha(b)])));
    assert.equal(manifest.files[CATALOGUE_POINTER_PATH], undefined, "the catalogue pointer is not a manifest entry");
    assert.ok(manifest.files[POINTER_PATH], "premise: the Foray pointer still is");
  });
});

test("CLI: --verify goes red when the stamped catalogue pointer no longer describes the tree", () => {
  /* A built tree that verifies is what ships. KILLED BY: dropping the
     `cataloguePointerProblems(...)` push from stampedProblems. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, ["--stamp", "."]).status, 0);
    assert.equal(run(dir, ["--verify", "."]).status, 0, "premise: a fresh stamp verifies");
    put(dir, CATALOGUE_FILES.taxonomy, BODIES.taxonomy.replace("nodes", "nodez"));
    const v = run(dir, ["--verify", "."]);
    assert.equal(v.status, 1);
    assert.match(v.stderr, /data\/catalogue-directory\.json: sha256\.taxonomy is/);
  });
});

test("CLI: --verify goes red when the catalogue pointer is missing from a stamped tree", () => {
  /* KILLED BY: the same stampedProblems push — and it is the only check that
     notices a build step deleting the file. */
  withTree(cliTree, (dir) => {
    assert.equal(run(dir, ["--stamp", "."]).status, 0);
    rmSync(path.join(dir, CATALOGUE_POINTER_PATH));
    const v = run(dir, ["--verify", "."]);
    assert.equal(v.status, 1);
    assert.match(v.stderr, /data\/catalogue-directory\.json: data\/catalogue-directory\.json is missing/);
  });
});

/** The CLI tree as a git repo with the real .gitignore rules for the stamp. */
function gitCliTree() {
  const dir = cliTree();
  put(dir, ".gitignore", "/deploy-manifest.json\n/data/forays-directory.json\n/data/catalogue-directory.json\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  return dir;
}

test("CLI: --check is red when the catalogue pointer is committed again", () => {
  /* `git add -f` is how it would come back past the .gitignore. KILLED BY:
     dropping CATALOGUE_POINTER_PATH from GENERATED. */
  withTree(gitCliTree, (dir) => {
    assert.equal(run(dir, ["--check"]).status, 0, "premise: the clean tree passes");
    assert.equal(run(dir, ["--stamp", "."]).status, 0);
    put(dir, "sw.js", 'const CACHE_PREFIX = "foray-gen-";\nconst BUILD_ID = "unstamped";\n');
    git(dir, ["add", "-f", CATALOGUE_POINTER_PATH]);
    const c = run(dir, ["--check"]);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /data\/catalogue-directory\.json is committed/);
    assert.match(c.stderr, /git rm --cached data\/catalogue-directory\.json/);
  });
});

test("CLI: --check is red when .gitignore stops covering the catalogue pointer", () => {
  /* Without the ignore, the first `git add -A` after a local build commits it.
     KILLED BY: dropping CATALOGUE_POINTER_PATH from GENERATED. */
  withTree(gitCliTree, (dir) => {
    put(dir, ".gitignore", "/deploy-manifest.json\n/data/forays-directory.json\n");
    const c = run(dir, ["--check"]);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /data\/catalogue-directory\.json is not in \.gitignore/);
    assert.ok(!existsSync(path.join(dir, CATALOGUE_POINTER_PATH)), "--check writes nothing");
  });
});
