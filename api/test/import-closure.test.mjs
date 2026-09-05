// Import-closure check for api/** (S-02, kanban t_4bd3c0a3).
//
// WHY THIS EXISTS
// `GET /api/shows/[show_id]/episodes` crashed with FUNCTION_INVOCATION_FAILED
// on every request in production because it transitively imported
// `backend/src/config/env`, which pulls in `dotenv` — a dependency declared
// in `backend/package.json` but never in `api/package.json`. Vercel's
// `installCommand` (vercel.json) is `npm install --prefix api` only, so
// anything api/**'s module graph reaches that isn't declared there, or a
// Node builtin, is missing at runtime. This crashed at MODULE LOAD, before
// any request routing ran — so it wasn't caught by a handler-level test, and
// wouldn't be caught by one now either: it has to be caught by walking the
// import graph statically, the same shape of gap `test/suite-integrity.test.js`
// closes for deleted tests and `tools/ci/run-suites.mjs` closes for
// undiscovered suites.
//
// WHAT IT DOES
// Starting from every `api/**/*.ts` file (excluding this suite itself),
// follows every relative import/require (`./x`, `../x`) into
// `backend/src/**` and anywhere else in the repo a relative specifier can
// reach, resolving `.ts`/`.js`/index files the way Node/TS would. Every
// BARE specifier encountered anywhere in that closure (i.e. not starting
// with `.` or `/`) must be either a Node builtin or a key in
// `api/package.json`'s `dependencies`. `pg` and `fast-xml-parser` are the
// two expected today.
//
// This intentionally does NOT resolve into node_modules (a package's own
// internal requires are its own business) — only the repo's own source
// tree is walked.

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const API_DIR = path.join(ROOT, "api");
const SELF = path.join(HERE, "import-closure.test.mjs");

const BUILTIN_MODULES = new Set(Module.builtinModules);

/** Bare specifier -> true if it's a Node builtin, accounting for the `node:` prefix form. */
function isBuiltin(specifier) {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return BUILTIN_MODULES.has(bare) || BUILTIN_MODULES.has(specifier);
}

/** Every `.ts`/`.js`/`.mjs`/`.cjs` file under `dir`, recursively, skipping node_modules/dotdirs. */
function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** All `import ... from "spec"` / `require("spec")` / `export ... from "spec"` specifiers in one file's text. */
function extractSpecifiers(source) {
  const specs = [];
  const patterns = [
    /import\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g,
    /export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
    /require\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) specs.push(m[1]);
  }
  return specs;
}

/** Resolves a relative specifier from `fromFile` to an actual file on disk, trying TS/JS extensions and index files. */
function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, "index.ts"),
    path.join(base, "index.js")
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null; // unresolved relative import — not this test's concern (would fail typecheck/build separately)
}

/**
 * Walks the full import closure reachable from `entryFiles`, following only
 * relative specifiers. Returns { bareSpecifiers: Set<string>, visited: Set<string> }.
 */
function walkClosure(entryFiles) {
  const bareSpecifiers = new Set();
  const visited = new Set();
  const queue = [...entryFiles];

  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);

    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue; // unreadable file — not this test's concern
    }

    for (const specifier of extractSpecifiers(source)) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const resolved = resolveRelative(file, specifier);
        if (resolved && !visited.has(resolved)) queue.push(resolved);
      } else {
        bareSpecifiers.add(specifier);
      }
    }
  }

  return { bareSpecifiers, visited };
}

test("every bare import reachable from api/** is declared in api/package.json or a Node builtin", () => {
  const entryFiles = walkFiles(API_DIR).filter((f) => f !== SELF && !f.includes(`${path.sep}test${path.sep}`));
  assert.ok(entryFiles.length > 0, "no api/**.ts files found — is API_DIR correct?");

  const { bareSpecifiers } = walkClosure(entryFiles);

  const pkg = JSON.parse(fs.readFileSync(path.join(API_DIR, "package.json"), "utf8"));
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));

  const undeclared = [...bareSpecifiers]
    .filter((spec) => !isBuiltin(spec) && !declared.has(spec))
    .sort();

  assert.deepStrictEqual(
    undeclared,
    [],
    "these bare imports are reachable from api/** at runtime but are not Node builtins " +
      "and not declared in api/package.json's dependencies — Vercel's installCommand " +
      "(`npm install --prefix api`) will not install them, so any api/** function " +
      "importing them crashes at module load in production:\n" +
      undeclared.join("\n")
  );
});

test("api/package.json's declared dependencies are non-empty and sane", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(API_DIR, "package.json"), "utf8"));
  assert.ok(pkg.dependencies && Object.keys(pkg.dependencies).length > 0, "api/package.json has no dependencies declared");
  assert.ok("pg" in pkg.dependencies, "expected pg to remain declared (DB-mode episodes path)");
  assert.ok("fast-xml-parser" in pkg.dependencies, "expected fast-xml-parser to be declared (no-DB live-parse path)");
});
