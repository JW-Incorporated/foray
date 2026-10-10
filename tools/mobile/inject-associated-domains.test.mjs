/* Tests for the iOS Associated Domains entitlement behind its committed
 * off-switch (HUMAN-ACTIONS.md #145, #1071). Every test runs on Windows: the
 * project fixture is the real Capacitor 8.5.0 SwiftPM template pbxproj that
 * inject-privacy-manifest.test.mjs uses (its PRODUCT_BUNDLE_IDENTIFIER is the
 * template's com.getcapacitor.App; `cap add ios` writes our appId over it, so
 * the release case swaps it in). What only a Mac and Apple can show -- that a
 * build with the entitlement signs once #145 is done -- is the flag-flip PR's
 * release run.
 *
 * MUTATIONS, each run and red:
 *   - applinksDomains uses `u.origin` instead of `u.host` -> "the domain is
 *     SHARE_ORIGIN's host" red.
 *   - RELEASE_BUNDLE_ID = "ai.jwlabs.foura.lab" -> "the AASA appID is the
 *     release bundle id and team" red.
 *   - mobile/ASSOCIATED_DOMAINS.json "enabled": true -> "the committed switch
 *     is off" red.
 *   - decide() without its `if (!enabled)` branch -> "a false flag changes no
 *     byte" red.
 *   - decide() without its bundle-id branch -> "a non-release bundle id changes
 *     no byte" red.
 *   - claimsWhileOff returns [] -> "off is a VERIFIED no-op" red.
 *   - injectPbxproj's `if (c.entitlements === ENTITLEMENTS_SETTING) continue;`
 *     deleted -> "a re-run is idempotent" red (a second line, then the
 *     parser's duplicate-key refusal).
 *   - `return;` as assertEntitled's / assertWired's first line -> "an
 *     insertion that does not land is refused" red.
 *   - parseFlag accepts any truthy `enabled` -> "the switch is parsed strictly" red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ASSOCIATED_DOMAINS_KEY,
  ENTITLEMENTS_SETTING,
  FLAG_FILE,
  RELEASE_BUNDLE_ID,
  applinksDomains,
  appConfigurations,
  assertEntitled,
  assertWired,
  associatedDomainsValue,
  decide,
  injectEntitlements,
  injectPbxproj,
  parseFlag,
  projectBundleId,
  renderEntitlements,
  runCheck,
  runInject,
  wiringProblems,
} from "./inject-associated-domains.mjs";
import { SHARE_ORIGIN } from "../../player/incoming-link.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(HERE, "inject-associated-domains.mjs");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const TEMPLATE = fs
  .readFileSync(path.join(HERE, "fixtures", "privacy-manifest", "capacitor-8.5.0-spm.pbxproj"), "utf8")
  .replace(/\r\n/g, "\n");
const RELEASE = TEMPLATE.replaceAll("PRODUCT_BUNDLE_IDENTIFIER = com.getcapacitor.App;", `PRODUCT_BUNDLE_IDENTIFIER = ${RELEASE_BUNDLE_ID};`);

function tempIosApp(pbx = RELEASE, enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "associated-domains-"));
  fs.mkdirSync(path.join(dir, "App"));
  fs.mkdirSync(path.join(dir, "App.xcodeproj"));
  fs.writeFileSync(path.join(dir, "App.xcodeproj", "project.pbxproj"), pbx);
  const flagFile = path.join(dir, "flag.json");
  fs.writeFileSync(flagFile, JSON.stringify({ enabled }));
  return { dir, flagFile, pbxFile: path.join(dir, "App.xcodeproj", "project.pbxproj"), ent: path.join(dir, ENTITLEMENTS_SETTING) };
}

/** Every file under `dir`, path -> bytes, for "changes no byte". */
function snapshot(dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) {
      const f = path.join(e.parentPath ?? e.path, e.name);
      out[path.relative(dir, f)] = fs.readFileSync(f).toString("base64");
    }
  }
  return out;
}

/** Lines in `b` that are not in `a`, walking both in order (insert-only diff). */
function insertedLines(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  const added = [];
  let i = 0;
  for (const line of y) {
    if (i < x.length && x[i] === line) i++;
    else added.push(line);
  }
  assert.equal(i, x.length, "an original line was changed or removed");
  return added;
}

test("the domain is applinks: plus SHARE_ORIGIN's host, and nothing else", () => {
  assert.deepEqual(applinksDomains(), [`applinks:${new URL(SHARE_ORIGIN).host}`]);
  assert.deepEqual(applinksDomains(), ["applinks:foray-web-seven.vercel.app"]);
  assert.match(renderEntitlements(), /<string>applinks:foray-web-seven\.vercel\.app<\/string>/);
  assert.throws(() => applinksDomains("http://example.com"), /not https/);
});

test("the AASA appID is the release bundle id and team, and the shell and the archive sign that id", () => {
  const m = /Team ID `([A-Z0-9]{10})`/.exec(read("docs/apple-enrollment-website.md"));
  assert.ok(m, "docs/apple-enrollment-website.md no longer records the Team ID");
  const aasa = JSON.parse(read(".well-known/apple-app-site-association"));
  const appIDs = aasa.applinks.details.flatMap((d) => d.appIDs);
  assert.deepEqual(appIDs, [`${m[1]}.${RELEASE_BUNDLE_ID}`]);
  assert.equal(JSON.parse(read("mobile/capacitor.config.json")).appId, RELEASE_BUNDLE_ID);
  assert.match(read(".github/actions/ios-archive/action.yml"), new RegExp(`APP_ID: ${RELEASE_BUNDLE_ID.replace(/\./g, "\\.")}\\s`));
});

test("the committed switch is off until HUMAN-ACTIONS.md #145 is done", () => {
  assert.equal(FLAG_FILE, path.join(ROOT, "mobile", "ASSOCIATED_DOMAINS.json"));
  assert.deepEqual(parseFlag(fs.readFileSync(FLAG_FILE, "utf8")), { enabled: false });
});

test("the switch is parsed strictly", () => {
  assert.deepEqual(parseFlag('{"enabled": true}'), { enabled: true });
  assert.deepEqual(parseFlag('{"//": "why", "enabled": false}'), { enabled: false });
  for (const bad of ['{"enabled": "false"}', '{"enabled": 1}', "{}", '{"enabled": false, "enable": true}', "[]", "nope"]) {
    assert.throws(() => parseFlag(bad), Error, bad);
  }
});

test("a false flag changes no byte, with the release bundle id", () => {
  const t = tempIosApp(RELEASE, false);
  const before = snapshot(t.dir);
  const lines = runInject(t.dir, { flagFile: t.flagFile });
  assert.match(lines.join("\n"), /is off/);
  assert.deepEqual(snapshot(t.dir), before);
  assert.equal(fs.existsSync(t.ent), false);
  assert.match(runCheck(t.dir, { flagFile: t.flagFile }).join("\n"), /off for ai\.jwlabs\.foura, and nothing claims/);
  assert.deepEqual(decide({ enabled: false, bundleId: RELEASE_BUNDLE_ID }).act, false);
});

test("a non-release bundle id changes no byte, even with the flag on", () => {
  /* The template's own id, as `cap add` leaves it before our appId lands. */
  const t = tempIosApp(TEMPLATE, true);
  let before = snapshot(t.dir);
  assert.match(runInject(t.dir, { flagFile: t.flagFile }).join("\n"), /com\.getcapacitor\.App is not ai\.jwlabs\.foura/);
  assert.deepEqual(snapshot(t.dir), before);
  /* The lab build: a release project signed under another id on the command line. */
  const lab = tempIosApp(RELEASE, true);
  before = snapshot(lab.dir);
  runInject(lab.dir, { flagFile: lab.flagFile, bundleId: "ai.jwlabs.foura.lab" });
  assert.deepEqual(snapshot(lab.dir), before);
  runCheck(lab.dir, { flagFile: lab.flagFile, bundleId: "ai.jwlabs.foura.lab" });
  assert.equal(decide({ enabled: true, bundleId: "ai.jwlabs.foura.lab" }).act, false);
});

test("off is a VERIFIED no-op: an entitlement already in the project fails the run and --check", () => {
  const t = tempIosApp(RELEASE, true);
  runInject(t.dir, { flagFile: t.flagFile });
  fs.writeFileSync(t.flagFile, JSON.stringify({ enabled: false }));
  assert.throws(() => runInject(t.dir, { flagFile: t.flagFile }), /already claim com\.apple\.developer\.associated-domains/);
  assert.throws(() => runCheck(t.dir, { flagFile: t.flagFile }), /while it should be off/);
  /* A file CODE_SIGN_ENTITLEMENTS names, not only ours, counts. */
  const u = tempIosApp(RELEASE.replace("CODE_SIGN_STYLE = Automatic;", "CODE_SIGN_ENTITLEMENTS = App/Other.entitlements;\n\t\t\t\tCODE_SIGN_STYLE = Automatic;"), false);
  fs.writeFileSync(path.join(u.dir, "App", "Other.entitlements"), renderEntitlements());
  assert.throws(() => runCheck(u.dir, { flagFile: u.flagFile }), /Other\.entitlements claim/);
});

test("on, for the release id: the entitlements file and CODE_SIGN_ENTITLEMENTS on every App configuration, insert-only", () => {
  const t = tempIosApp(RELEASE, true);
  runInject(t.dir, { flagFile: t.flagFile });
  assert.equal(fs.readFileSync(t.ent, "utf8"), renderEntitlements());
  const pbx = fs.readFileSync(t.pbxFile, "utf8");
  assert.deepEqual(insertedLines(RELEASE, pbx), [
    `\t\t\t\tCODE_SIGN_ENTITLEMENTS = ${ENTITLEMENTS_SETTING};`,
    `\t\t\t\tCODE_SIGN_ENTITLEMENTS = ${ENTITLEMENTS_SETTING};`,
  ]);
  /* In Xcode's key order, right before CODE_SIGN_STYLE, on the App target only. */
  assert.equal(pbx.split(`CODE_SIGN_ENTITLEMENTS = ${ENTITLEMENTS_SETTING};\n\t\t\t\tCODE_SIGN_STYLE = Automatic;`).length, 3);
  assert.deepEqual(appConfigurations(pbx).map((c) => [c.name, c.entitlements]), [["Debug", ENTITLEMENTS_SETTING], ["Release", ENTITLEMENTS_SETTING]]);
  assert.match(runCheck(t.dir, { flagFile: t.flagFile }).join("\n"), /signed by every App configuration/);
});

test("a re-run is idempotent", () => {
  const t = tempIosApp(RELEASE, true);
  runInject(t.dir, { flagFile: t.flagFile });
  const once = snapshot(t.dir);
  const lines = runInject(t.dir, { flagFile: t.flagFile });
  assert.deepEqual(snapshot(t.dir), once);
  assert.match(lines.join("\n"), /already/);
  const pbx = fs.readFileSync(t.pbxFile, "utf8");
  assert.equal(injectPbxproj(pbx).changed, false);
  assert.equal(injectEntitlements(renderEntitlements()).changed, false);
});

test("an insertion that does not land is refused", () => {
  assert.throws(() => assertEntitled(renderEntitlements(["applinks:example.com"])), /bug in inject-associated-domains/);
  assert.throws(() => assertEntitled("<plist><dict/></plist>"), /bug in inject-associated-domains/);
  assert.throws(() => assertWired(RELEASE), /the edit did not take/);
  assert.equal(wiringProblems(RELEASE).length, 2);
});

test("existing entitlements: an empty file is filled, another key is kept, a foreign domain list is refused", () => {
  assert.equal(injectEntitlements("<?xml version=\"1.0\"?>\n<plist version=\"1.0\">\n<dict/>\n</plist>\n").xml, renderEntitlements());
  const other = `<?xml version="1.0" encoding="UTF-8"?>\r\n<plist version="1.0">\r\n<dict>\r\n\t<key>aps-environment</key>\r\n\t<string>production</string>\r\n</dict>\r\n</plist>\r\n`;
  const r = injectEntitlements(other);
  assert.equal(r.changed, true);
  assert.ok(r.xml.startsWith(other.slice(0, other.indexOf("</dict>"))), "the existing key is kept in place");
  assert.ok(!/[^\r]\n/.test(r.xml), "CRLF stays CRLF");
  assert.equal(associatedDomainsValue(r.xml), "<array><string>applinks:foray-web-seven.vercel.app</string></array>");
  assert.throws(() => injectEntitlements(renderEntitlements(["applinks:example.com"])), /did not write/);
});

test("the pbxproj: a different CODE_SIGN_ENTITLEMENTS is refused, CRLF is kept, disagreeing bundle ids need --bundle-id", () => {
  const foreign = RELEASE.replace("CODE_SIGN_STYLE = Automatic;", "CODE_SIGN_ENTITLEMENTS = App/Other.entitlements;\n\t\t\t\tCODE_SIGN_STYLE = Automatic;");
  assert.throws(() => injectPbxproj(foreign), /refusing to repoint/);
  const crlf = RELEASE.replace(/\n/g, "\r\n");
  const out = injectPbxproj(crlf).text;
  assert.ok(!/[^\r]\n/.test(out), "CRLF stays CRLF");
  assert.deepEqual(wiringProblems(out), []);
  assert.equal(projectBundleId(RELEASE), RELEASE_BUNDLE_ID);
  const mixed = RELEASE.replace(`PRODUCT_BUNDLE_IDENTIFIER = ${RELEASE_BUNDLE_ID};`, "PRODUCT_BUNDLE_IDENTIFIER = ai.jwlabs.foura.lab;");
  assert.throws(() => projectBundleId(mixed), /Pass --bundle-id/);
});

test("the CLI: the committed (off) switch writes nothing, and bad arguments are an error", () => {
  const t = tempIosApp(RELEASE, true);
  const before = snapshot(t.dir);
  let r = spawnSync(process.execPath, [SCRIPT, t.dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is off/);
  assert.deepEqual(snapshot(t.dir), before);
  r = spawnSync(process.execPath, [SCRIPT, t.dir, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const args of [[t.dir, "--frobnicate"], [], [t.dir, "--bundle-id", "--check"], [t.dir, "--bundle-id"]]) {
    r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
  }
});

test(`${ASSOCIATED_DOMAINS_KEY} is the key Apple reads`, () => {
  assert.equal(ASSOCIATED_DOMAINS_KEY, "com.apple.developer.associated-domains");
  assert.equal(ENTITLEMENTS_SETTING, "App/App.entitlements");
});
