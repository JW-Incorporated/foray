/* Share links that open the app: the site-association groundwork (#1071).
 *
 * WHAT IS PINNED, and why each piece is one silent failure away from "links
 * open the browser again" with every other check green:
 *   1. /.well-known/apple-app-site-association is the JSON iOS asks for: one
 *      applinks detail for <Team ID>.<bundle id>, the Team ID the one Apple
 *      issued (docs/apple-enrollment-website.md) and the bundle id the shell's
 *      (mobile/capacitor.config.json). A wrong letter in either is a file iOS
 *      reads and ignores.
 *   2. Its components send the app hash routes on the site root and NEVER
 *      /api/*. Simulated with Apple's own evaluation order (the first component
 *      that matches decides), not by looking for an entry, so a widened include
 *      placed above the exclude fails here.
 *   3. It is shipped: prepare-dist.mjs copies it into dist at the same path and
 *      refuses to build without it.
 *   4. It is served as application/json: Apple's CDN refuses an AASA with any
 *      other Content-Type, and a file with no extension is served as
 *      application/octet-stream unless vercel.json says otherwise.
 *   5. Android: an autoVerify https intent filter for the share host, path "/",
 *      reaches the app's MainActivity through the foray-audio library manifest
 *      (mobile/android/ is generated, never committed — see that manifest).
 *   6. One share host everywhere: the AASA, the intent filter and
 *      player/incoming-link.js's SHARE_ORIGIN cannot drift apart.
 *
 * MUTATIONS, each run and red:
 *   - change the AASA appID's Team ID to D9N628AFHT -> test 1 red.
 *   - widen the include's "/" from "/" to "*" -> test 2 red ("/api/session#/x"
 *     and "/privacy#/x" are sent to the app).
 *   - delete the exclude component -> test 2 red (no explicit /api/* exclude).
 *   (Swapping the two components today SURVIVES, correctly: the include names
 *   path "/" exactly, so it cannot match /api/* in either order. The order
 *   check is the simulation itself, which bites once an include is widened.)
 *   - drop `...WELL_KNOWN` from prepare-dist's copy loop -> test 3 red.
 *   - drop the missingWellKnown FATAL block -> test 3 red.
 *   - delete the vercel.json Content-Type rule -> test 4 red.
 *   - remove android:autoVerify="true" -> test 5 red.
 *   - rename the activity to .MainActivity (resolved against the LIBRARY's
 *     namespace, so it would merge into nothing) -> test 5 red.
 *   - change the intent filter's host to foray-web.vercel.app -> test 6 red.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const AASA_REL = ".well-known/apple-app-site-association";
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const MANIFEST_REL = "mobile/plugins/foray-audio/android/src/main/AndroidManifest.xml";
const incomingLink = import(pathToFileURL(path.join(ROOT, "player", "incoming-link.js")).href);

function aasa() {
  return JSON.parse(read(AASA_REL));
}

/** The Team ID Apple issued, from the doc that records it, so the AASA is
    checked against the record rather than against a second copy typed here. */
function issuedTeamId() {
  const m = /Team ID `([A-Z0-9]{10})`/.exec(read("docs/apple-enrollment-website.md"));
  assert.ok(m, "docs/apple-enrollment-website.md no longer records the Team ID");
  return m[1];
}

/** An AASA component pattern: `*` any run of characters, `?` exactly one. */
function patternMatches(pattern, value) {
  const re = "^" + String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(re).test(value);
}

/** Apple's evaluation: components in order, the first that matches decides.
    A component matches when every key it names matches (an absent "#" matches
    any fragment, a present one needs a fragment). Returns true (the app opens
    it), or false (excluded, or nothing matched: the browser opens it). */
function opensInApp(components, { path: p, fragment }) {
  for (const c of components) {
    if ("/" in c && !patternMatches(c["/"], p)) continue;
    if ("#" in c && (fragment === undefined || !patternMatches(c["#"], fragment))) continue;
    return c.exclude !== true;
  }
  return false;
}

/** The manifest with its XML comments removed, so a comment cannot satisfy a check. */
function manifestBody() {
  return read(MANIFEST_REL).replace(/<!--[\s\S]*?-->/g, "");
}

function shareActivity() {
  const activities = [...manifestBody().matchAll(/<activity\b[\s\S]*?<\/activity>/g)].map((m) => m[0]);
  assert.equal(activities.length, 1, "the library manifest should declare exactly one <activity>, the share-link one");
  return activities[0];
}

const attr = (el, name) => {
  const m = new RegExp(`android:${name}="([^"]*)"`).exec(el);
  return m ? m[1] : null;
};

test("1. the AASA names the app Apple issued: <Team ID>.<bundle id>", () => {
  assert.ok(!path.extname(AASA_REL), "the file has no extension, the name iOS asks for");
  const doc = aasa();
  const details = doc.applinks && doc.applinks.details;
  assert.ok(Array.isArray(details) && details.length === 1, "one applinks detail");
  const appId = JSON.parse(read("mobile/capacitor.config.json")).appId;
  assert.equal(appId, "ai.jwlabs.foura");
  assert.deepEqual(details[0].appIDs, [`${issuedTeamId()}.${appId}`]);
  assert.equal(issuedTeamId(), "D9N628AFHS");
});

test("2. hash routes on / open the app; /api/* and everything else never do", () => {
  const { components } = aasa().applinks.details[0];
  assert.ok(Array.isArray(components) && components.length > 0);
  const inApp = [
    { path: "/", fragment: "/show/abc123" },
    { path: "/", fragment: "/foray/grilling-history-2" },
    { path: "/", fragment: "/" },
  ];
  const browser = [
    { path: "/api/session" },
    { path: "/api/session", fragment: "/show/x" },
    { path: "/api/", fragment: "/" },
    { path: "/privacy", fragment: "/show/x" },
    { path: "/" }, // the bare root, no route: the web page
    { path: "/", fragment: "top" }, // an anchor, not a route
  ];
  for (const u of inApp) assert.equal(opensInApp(components, u), true, `${u.path}#${u.fragment} should open in 4a`);
  for (const u of browser) {
    assert.equal(opensInApp(components, u), false, `${u.path}${u.fragment === undefined ? "" : "#" + u.fragment} must stay in the browser`);
  }
  const apiExclude = components.findIndex((c) => c.exclude === true && patternMatches(c["/"], "/api/x"));
  assert.ok(apiExclude >= 0, "an explicit exclude for /api/*");
});

test("3. prepare-dist ships the AASA at the same path and refuses to build without it", () => {
  const src = read("tools/web/prepare-dist.mjs");
  const list = /const WELL_KNOWN = \[([^\]]*)\];/.exec(src);
  assert.ok(list, "prepare-dist.mjs declares WELL_KNOWN");
  assert.match(list[1], /"\.well-known\/apple-app-site-association"/);
  const loop = /for \(const rel of \[([^\]]*)\]\)/.exec(src);
  assert.ok(loop, "prepare-dist.mjs still has its copy loop");
  assert.match(loop[1], /\.\.\.WELL_KNOWN\b/, "the copy loop copies WELL_KNOWN");
  assert.match(src, /missingWellKnown[\s\S]{0,200}process\.exit\(1\)/, "a missing site-association file is FATAL");
  assert.ok(fs.existsSync(path.join(ROOT, AASA_REL)), "premise: the source file exists to copy");
});

test("4. vercel.json serves the AASA as application/json, and nothing overrides it", () => {
  const rules = JSON.parse(read("vercel.json")).headers;
  const pathname = `/${AASA_REL}`;
  const types = rules
    .filter((r) => new RegExp(`^${r.source}$`).test(pathname))
    .flatMap((r) => (r.headers || []).filter((h) => String(h.key).toLowerCase() === "content-type"))
    .map((h) => h.value);
  assert.deepEqual(types, ["application/json"]);
  // The rule is scoped to the one file: no other shipped path is retyped.
  for (const other of ["/index.html", "/app.js", "/data/forays.json", "/.well-known/assetlinks.json"]) {
    const retyped = rules.filter((r) => new RegExp(`^${r.source}$`).test(other) &&
      (r.headers || []).some((h) => String(h.key).toLowerCase() === "content-type"));
    assert.deepEqual(retyped, [], `${other} must keep Vercel's own Content-Type`);
  }
});

test("5. Android: an autoVerify https intent filter for the share host reaches MainActivity", () => {
  const act = shareActivity();
  const appId = JSON.parse(read("mobile/capacitor.config.json")).appId;
  assert.equal(attr(act, "name"), `${appId}.MainActivity`, "the FULL name: a library resolves a relative one against its own namespace");
  assert.equal(attr(act, "exported"), "true");
  const filters = [...act.matchAll(/<intent-filter\b[\s\S]*?<\/intent-filter>/g)].map((m) => m[0]);
  assert.equal(filters.length, 1);
  const f = filters[0];
  assert.match(f, /<intent-filter\b[^>]*android:autoVerify="true"/);
  assert.match(f, /<action android:name="android\.intent\.action\.VIEW"\s*\/>/);
  assert.match(f, /<category android:name="android\.intent\.category\.DEFAULT"\s*\/>/);
  assert.match(f, /<category android:name="android\.intent\.category\.BROWSABLE"\s*\/>/);
  const data = [...f.matchAll(/<data\b[\s\S]*?\/>/g)].map((m) => m[0]);
  assert.equal(data.length, 1, "one <data>: a second would widen what the filter claims");
  assert.equal(attr(data[0], "scheme"), "https");
  assert.equal(attr(data[0], "path"), "/", "path / only, so /api/* is never claimed");
  assert.equal(attr(data[0], "pathPrefix"), null);
  assert.equal(attr(data[0], "pathPattern"), null);
});

test("6. one share host: incoming-link.js, the intent filter and the AASA's origin agree", async () => {
  const { SHARE_ORIGIN, inAppRouteFor } = await incomingLink;
  const host = new URL(SHARE_ORIGIN).host;
  assert.equal(host, "foray-web-seven.vercel.app");
  const data = /<data\b[\s\S]*?\/>/.exec(shareActivity())[0];
  assert.equal(attr(data, "host"), host);
  // The API origin app.js already talks to is the same deployment that serves the AASA.
  assert.match(read("app.js"), new RegExp(`const API_ORIGIN = "${SHARE_ORIGIN.replace(/\./g, "\\.")}";`));
  // And the router accepts what the filter claims.
  assert.equal(inAppRouteFor(`https://${host}/#/show/abc`), "#/show/abc");
});
