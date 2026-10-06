/* CH-15 (docs/roadmap/code-health.md, X1-04): the Swift engine's asset URLs
 * equal the JS constants that spell them.
 *
 * The seam jingle's URL and the live site root are spelled in three JS files:
 * `player/foray-queue.js` (`JINGLE_ASSET_URL`, a literal, because it cannot
 * import interlude.js without a cycle), `player/interlude.js`
 * (`INTERLUDE_ASSET_URL`, derived from `SITE_ROOT`) and
 * `player/download-bridge.js` (`SITE_URL`, the page a download's User-Agent
 * points at). The iOS native lane plays the jingle from
 * `EngineConstants.swift` (`Policy/Interlude.swift` reads
 * `EngineConstants.Interlude.interludeAssetUrl`), so a path renamed on one
 * side only would leave the native lane's seam jingle 404ing silently while
 * the JS lane plays.
 *
 * `tools/parity/gen-constants.test.mjs` already keeps each generated Swift
 * value equal to the export of ITS OWN module. What it does not do is say
 * that the three spellings are one URL: a rename of the asset in interlude.js
 * alone regenerates cleanly while foray-queue.js and download-bridge.js keep
 * the old one. This suite reads the Swift file as text (no Swift locally; it
 * compiles only in CI) and pins every Swift URL to every JS spelling of it.
 *
 * MUTATIONS (each run once, each turns this suite red):
 *   - change the path in `JINGLE_ASSET_URL` (player/foray-queue.js) only;
 *   - change `jingleAssetUrl` in EngineConstants.swift only;
 *   - change the host in `SITE_URL` (player/download-bridge.js) only.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const SWIFT_FILE =
  "mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/EngineConstants.swift";

const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

/** The string value of `public static let <name>: String = "..."` inside
    `public enum <namespace> { ... }` of EngineConstants.swift. Exactly one
    such line must exist, so a rename on the Swift side fails here by name
    rather than by matching some other namespace's constant. */
function swiftString(namespace, name) {
  const src = fs.readFileSync(path.join(ROOT, SWIFT_FILE), "utf8");
  const open = src.indexOf(`public enum ${namespace} {`);
  assert.ok(open > -1, `EngineConstants.swift has no enum ${namespace}`);
  /* The namespace's body ends at the next top-level namespace (4-space
     indent), which is how the generator lays the file out. */
  const rest = src.slice(open + 1);
  const next = rest.search(/\n {4}public enum /);
  const body = next === -1 ? rest : rest.slice(0, next);
  const hits = [...body.matchAll(new RegExp(`public static let ${name}: String = "([^"]*)"`, "g"))];
  assert.equal(hits.length, 1, `EngineConstants.${namespace}.${name} should be declared exactly once`);
  return hits[0][1];
}

test("Swift ForayQueue.jingleAssetUrl equals JINGLE_ASSET_URL and INTERLUDE_ASSET_URL", async () => {
  /* MUTATION: rename the asset in foray-queue.js's JINGLE_ASSET_URL only. */
  const { JINGLE_ASSET_URL } = await import(url("player/foray-queue.js"));
  const { INTERLUDE_ASSET_URL } = await import(url("player/interlude.js"));
  const swift = swiftString("ForayQueue", "jingleAssetUrl");
  assert.equal(swift, JINGLE_ASSET_URL, "the native jingle item plays the URL the JS queue names");
  assert.equal(swift, INTERLUDE_ASSET_URL, "the jingle item and the seam interlude are one asset (F-90)");
});

test("Swift Interlude.interludeAssetUrl equals INTERLUDE_ASSET_URL and JINGLE_ASSET_URL", async () => {
  /* MUTATION: change interludeAssetUrl in EngineConstants.swift only. */
  const { INTERLUDE_ASSET_URL } = await import(url("player/interlude.js"));
  const { JINGLE_ASSET_URL } = await import(url("player/foray-queue.js"));
  const swift = swiftString("Interlude", "interludeAssetUrl");
  assert.equal(swift, INTERLUDE_ASSET_URL, "Policy/Interlude.swift plays the URL the JS interlude plays");
  assert.equal(swift, JINGLE_ASSET_URL);
});

test("Swift Interlude.siteRoot equals interlude.js SITE_ROOT and download-bridge.js SITE_URL", async () => {
  /* MUTATION: change the host in download-bridge.js's SITE_URL only. */
  const { SITE_ROOT, INTERLUDE_ASSET_PATH } = await import(url("player/interlude.js"));
  const { SITE_URL } = await import(url("player/download-bridge.js"));
  const swift = swiftString("Interlude", "siteRoot");
  assert.equal(swift, SITE_ROOT);
  assert.equal(swift, SITE_URL, "the download User-Agent points at the same site the engine fetches from");
  assert.equal(
    swiftString("Interlude", "interludeAssetUrl"),
    swift + INTERLUDE_ASSET_PATH,
    "the asset URL is the site root plus the repo-relative path"
  );
});
