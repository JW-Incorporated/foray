// Regression test for the "data file not bundled with deployed function"
// production bug (kanban t_7d1a82d2, generalized by issue #560 item 1).
//
// WHY THIS EXISTS
// Several `api/**` handlers read files under `data/` off disk at runtime via
// a repo-root-relative `readFileSync`/`path.join()` call (`findRepoRoot()` +
// `loadShowIndex()` in `api/shows/[show_id]/episodes.ts`; `loadShowMeta()` in
// `api/episodes/search.ts`; `loadCatalogFallback()`/`tryLoadReleaseIdMap()` in
// `api/episodes/showIdMap.ts`; `readJson()` in
// `backend/src/catalog/breadthCatalog.ts`, reached transitively from
// `api/shows/search.ts`). Vercel's bundler does NOT include a file that's
// only reached via a dynamic `readFileSync`/`join()` call at runtime — it
// needs either a statically analyzable literal path, or an explicit
// `vercel.json` `functions.<glob>.includeFiles` entry.
//
// The suite this replaced hardcoded a `TARGETS` list of exactly two files
// (`api/shows/[show_id]/episodes.ts`, `api/shows/search.ts`) and passed —
// which is why it never caught that `api/episodes/**` (added later) reads
// the same catalog files and `data/shows-index-pointer.json` besides, none
// of it covered by vercel.json's `functions["api/shows/**/*.ts"]` key at
// all. That's issue #560 item 1: the id-map ends up empty in production,
// every Apple search hit gets silently dropped, and the endpoint still
// returns 200 with an innocuous-looking empty result — "fails green".
//
// This suite can't spin up an actual Vercel build (no deploy access from a
// CI runner), so it asserts the next best thing, and it does so by
// DISCOVERING the handlers and their reads rather than naming them:
//
//   1. Walk every `api/**/*.ts` file (excluding this test directory) and
//      identify the ones that are actual Vercel function entry points (a
//      top-level `export default function`/`export default async function`).
//   2. For each handler, walk its full same-repo relative-import closure
//      (the handler itself plus every local module it transitively imports —
//      e.g. `api/shows/search.ts` -> `backend/src/catalog/searchBreadthShows`
//      -> `backend/src/catalog/breadthCatalog`).
//   3. Statically extract every `data/<file>` path referenced in that
//      closure, via the two shapes actually used in this repo: a quoted
//      string literal (`"data/catalog.json"`, whether passed directly to
//      `readFileSync`/`readJson` or sitting in an array of filenames looped
//      over), and the split `join(ROOT, "data", "file.json")` call form.
//   4. For each handler, find the `vercel.json` `functions` key(s) whose glob
//      actually matches that handler's own path, and assert every data file
//      it reads is matched by at least one of those keys' `includeFiles`
//      glob.
//
// No hardcoded target list: a new `api/**` handler, or an existing one
// growing a new `data/` read, is picked up automatically the next time this
// suite runs — nothing here needs editing when that happens.
//
// MUTATION NOTE (what makes this red): dropping `functions["api/**/*.ts"]`
// from vercel.json, narrowing its `includeFiles` glob so it stops matching
// one of the files a handler's closure actually reads (e.g. reverting to the
// old `"data/catalog*.json"`, which stops matching
// `data/shows-index-pointer.json`), or narrowing the function-key glob so it
// no longer covers `api/episodes/**` or `api/shows/**` — any of those turn
// this suite red. So does deleting a handler's `data/` read without updating
// `includeFiles` in the other direction (nothing to catch — this suite only
// ever asserts coverage exists, over-inclusion is silently fine), and so
// does breaking the discovery/closure walk itself (guarded by the "found at
// least one handler with at least one data read" sanity assertions below).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const API_DIR = path.join(ROOT, "api");
const SELF = path.join(HERE, "vercel-bundle.test.mjs");

// ---------------------------------------------------------------------------
// Glob matching. Two different glob flavors are in play here and they are
// NOT interchangeable: vercel.json `functions` KEYS are path globs (`**`
// means "zero or more path segments", per Vercel's own docs), while
// `includeFiles` values in this repo are flat filename globs (`*` within one
// path segment, plus an optional single top-level `{a,b,c}` alternation —
// the only two forms this repo actually uses). Conflating them silently
// passed a broken test before (a flat `*` -> `.*` substitution wrongly
// required a literal `/` to exist even when `**` should match zero
// segments) — kept as two named functions so that mistake can't recur.
// ---------------------------------------------------------------------------

/** Flat filename glob (e.g. `data/catalog*.json`, or a `{a,b,c}` alternation). */
function includeFilesGlobToRegExp(glob) {
  const braceMatch = glob.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, alts, suffix] = braceMatch;
    const alternatives = alts.split(",").map((a) => `${prefix}${a}${suffix}`);
    return new RegExp(`^(?:${alternatives.map((a) => includeFilesGlobToRegExp(a).source.slice(1, -1)).join("|")})$`);
  }
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Path-style glob for vercel.json `functions` object KEYS (`**` = zero or more segments). */
function functionKeyToRegExp(glob) {
  const escaped = glob
    .replace(/\*\*\//g, "@@DOUBLESTAR_SLASH@@")
    .replace(/\*\*/g, "@@DOUBLESTAR@@")
    .replace(/\*/g, "@@STAR@@")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/@@DOUBLESTAR_SLASH@@/g, "(?:.*/)?")
    .replace(/@@DOUBLESTAR@@/g, ".*")
    .replace(/@@STAR@@/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function loadVercelConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// Handler discovery.
// ---------------------------------------------------------------------------

/** Every `.ts` file under `dir`, recursively, skipping `test/` and dotdirs/node_modules. */
function walkTsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "test" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** A "handler" is a file with a top-level `export default function`/`export default async function` —
 * i.e. an actual Vercel serverless function entry point, not a helper module like `_lib/cors.ts`. */
function isHandlerFile(absPath) {
  const src = fs.readFileSync(absPath, "utf8");
  return /export\s+default\s+(async\s+)?function/.test(src);
}

// ---------------------------------------------------------------------------
// Import-closure walk (relative imports only — same approach as
// api/test/import-closure.test.mjs, kept independent/duplicated deliberately
// so this suite doesn't depend on that one's internals).
// ---------------------------------------------------------------------------

function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function extractImportSpecifiers(source) {
  const specs = [];
  const patterns = [
    /import\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g,
    /export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) specs.push(m[1]);
  }
  return specs;
}

/** The handler file plus every same-repo file transitively reachable via relative imports. */
function importClosure(entryFile) {
  const visited = new Set();
  const queue = [entryFile];
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of extractImportSpecifiers(source)) {
      const resolved = resolveRelativeImport(file, spec);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

// ---------------------------------------------------------------------------
// Static data-file-read extraction, over one file's source text.
// ---------------------------------------------------------------------------

/** Strips `//` and `/* *​/` comments so a data/ path mentioned in prose (this
 * file's own header, for instance) is never mistaken for a real read. Good
 * enough for this repo's source, not a general-purpose lexer: a `//` inside a
 * string is only skipped when immediately preceded by `:` (i.e. `https://`),
 * which is the one case that actually appears in these files. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Shape 1: a quoted `data/<file>` literal, however it's used — passed
// directly to a read call, sitting in a looped-over array literal, or passed
// to a small local helper like breadthCatalog.ts's `readJson(relPath)`.
const QUOTED_DATA_PATH_RE = /["'`](data\/[\w.\-]+\.(?:json|gz))["'`]/g;

// Shape 2: the split-argument `join(ROOT, "data", "file.json")` form (showIdMap.ts).
const SPLIT_JOIN_RE = /\bjoin\(\s*[^,()]+,\s*["'`]data["'`]\s*,\s*["'`]([\w.\-]+\.(?:json|gz))["'`]/g;

function extractDataReads(source) {
  const stripped = stripComments(source);
  const found = new Set();
  let m;
  QUOTED_DATA_PATH_RE.lastIndex = 0;
  while ((m = QUOTED_DATA_PATH_RE.exec(stripped))) found.add(m[1]);
  SPLIT_JOIN_RE.lastIndex = 0;
  while ((m = SPLIT_JOIN_RE.exec(stripped))) found.add(`data/${m[1]}`);
  return found;
}

function dataReadsForHandler(handlerFile) {
  const reads = new Set();
  for (const file of importClosure(handlerFile)) {
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const read of extractDataReads(source)) reads.add(read);
  }
  return reads;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test("vercel.json declares an includeFiles glob for api/**", () => {
  const config = loadVercelConfig();
  assert.ok(
    config.functions,
    "vercel.json has no `functions` config at all — no api/** handler's runtime data/ reads will be bundled."
  );
  const keysWithIncludeFiles = Object.keys(config.functions).filter(
    (key) => typeof config.functions[key]?.includeFiles === "string" && config.functions[key].includeFiles.length > 0
  );
  assert.ok(
    keysWithIncludeFiles.length > 0,
    "no vercel.json functions key declares a non-empty includeFiles glob."
  );
});

test("every api/**/*.ts handler's statically-discovered data/ reads are covered by a matching vercel.json includeFiles glob", () => {
  const config = loadVercelConfig();
  const functionKeys = Object.keys(config.functions ?? {});

  const allTsFiles = walkTsFiles(API_DIR).filter((f) => f !== SELF);
  const handlers = allTsFiles.filter(isHandlerFile);
  assert.ok(
    handlers.length > 0,
    "discovered zero api/**/*.ts handler files — the discovery walk (walkTsFiles/isHandlerFile) is broken, " +
      "not that there are none: api/episodes/search.ts, api/shows/search.ts and " +
      "api/shows/[show_id]/episodes.ts all export a default handler today."
  );

  let handlersWithDataReads = 0;

  for (const handler of handlers) {
    const relHandler = path.relative(ROOT, handler).split(path.sep).join("/");

    const coveringKeys = functionKeys.filter((key) => functionKeyToRegExp(key).test(relHandler));
    const dataReads = dataReadsForHandler(handler);
    if (dataReads.size === 0) continue; // this handler reads no data/ file — nothing to cover
    handlersWithDataReads++;

    assert.ok(
      coveringKeys.length > 0,
      `"${relHandler}" reads ${[...dataReads].join(", ")} at runtime, but no vercel.json functions key's glob ` +
        `matches its path — it will 404/degrade in production exactly like #560 item 1 describes.`
    );

    for (const dataFile of dataReads) {
      const isCovered = coveringKeys.some((key) => {
        const includeFiles = config.functions[key]?.includeFiles;
        return typeof includeFiles === "string" && includeFilesGlobToRegExp(includeFiles).test(dataFile);
      });
      assert.ok(
        isCovered,
        `"${relHandler}" reads "${dataFile}" at runtime via a dynamic readFileSync/join() call, but no ` +
          `includeFiles glob on a vercel.json functions key covering its path matches "${dataFile}" — this file ` +
          "will be missing from the deployed function bundle."
      );
    }
  }

  assert.ok(
    handlersWithDataReads > 0,
    "discovered zero handlers with any data/ read at all — the static extraction (extractDataReads/importClosure) " +
      "is broken, not that no handler reads data/: api/shows/search.ts alone reaches data/catalog.json and " +
      "data/catalog-breadth.json transitively via backend/src/catalog/breadthCatalog.ts."
  );
});
