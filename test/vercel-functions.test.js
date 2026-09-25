/* Only real handlers sit where Vercel deploys functions (round-3 audit,
 * search-api-css-5).
 *
 * Vercel's zero-config `api/` convention builds EVERY js/mjs/cjs/ts/tsx file
 * under api/ into its own serverless function, skipping only paths with a
 * segment that starts with `_` or `.`, node_modules, and `.d.ts`. Four helper
 * modules (appleBucket, searchCache, showIdMap, appleShowSearch) and the eleven
 * api/test/*.test.mjs suites used to sit on deployable paths: 19 functions
 * instead of 4, each a public route; a GET to a test file would load node:test
 * and run the suite inside the function. The helpers now live in api/_lib/ and
 * the suites in api/_test/.
 *
 * This walks api/ with Vercel's rule and requires every deployable file to be
 * a handler (a top-level `export default [async] function`). It cannot see a
 * live deployment's Functions tab; the PR still checks that list on a preview.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const API = path.join(ROOT, "api");

/** Repo-relative POSIX paths Vercel would build as functions. */
function deployableFunctions(dir = API, rel = "api") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const relPath = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...deployableFunctions(full, relPath));
    else if (/\.(?:js|mjs|cjs|ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(relPath);
  }
  return out.sort();
}

const isHandler = (rel) => /export\s+default\s+(?:async\s+)?function/.test(fs.readFileSync(path.join(ROOT, rel), "utf8"));

test("every file Vercel would deploy as a function under api/ is a handler", () => {
  /* MUTATION: move api/_lib/searchCache.ts back to api/episodes/ (or
     api/_test/ back to api/test/) — it is listed here as a non-handler. */
  const deployable = deployableFunctions();
  assert.ok(deployable.length > 0, "premise: the walk found the handlers");
  const helpers = deployable.filter((rel) => !isHandler(rel));
  assert.deepEqual(helpers, [], `these would deploy as public functions with no default export:\n${helpers.join("\n")}`);
});

test("the deployable set is exactly today's four endpoints", () => {
  /* A new endpoint is a deliberate change to this list, and a reviewer sees it. */
  assert.deepEqual(deployableFunctions(), [
    "api/episodes/search.ts",
    "api/shows/[show_id]/episodes.ts",
    "api/shows/index/[...path].ts",
    "api/shows/search.ts",
  ]);
});

test("api/package.json's test script runs the suites where they now live", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(API, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /_test\//, "the api test script must name api/_test/");
  assert.ok(fs.existsSync(path.join(API, "_test")), "premise: api/_test/ exists");
  assert.ok(!fs.existsSync(path.join(API, "test")), "api/test/ is back on a deployable path");
});
