/* Copies the REAL sw.js into test/playwright/fixture/sw.js before each
 * Playwright run — never a re-implementation. The Playwright suite exists to
 * exercise the actual promotion/pin logic in a real browser, on top of the
 * node:vm coverage in test/sw-generation.test.js; a hand-copied sw.js would
 * silently stop testing anything the moment the two drifted.
 *
 * Run automatically via the "pretest" script in this package's package.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const SRC = path.join(REPO_ROOT, "sw.js");
const DEST = path.join(HERE, "fixture", "sw.js");

const src = readFileSync(SRC, "utf8");
writeFileSync(DEST, src);
console.log(`copied sw.js -> ${path.relative(REPO_ROOT, DEST)} (${src.length} bytes)`);
