/* Tests for the built-bundle privacy-manifest report (#948, the aggregate half).
 *
 * EVERY TEST HERE RUNS ON WINDOWS. The fixture is a directory tree shaped like
 * the arm64/Release `App.app` ios-build.yml builds: the app target's manifest
 * (rendered by inject-privacy-manifest.mjs, so it is exactly what ships),
 * Capacitor's and Cordova's frameworks with the empty manifests @capacitor/ios
 * 8 carries, `capacitor.config.json` with the `packageClassList` cap writes, and
 * a `public/` web dir. What only a Mac can show — that the real bundle looks
 * like this — is the ios-build.yml step this suite pins at the bottom.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_REASON_PLUGINS,
  ReportError,
  findBundles,
  packageClassList,
  readDeclarations,
  report,
} from "./privacy-manifest-report.mjs";
import { ACCESSED_API_TYPES, MANIFEST_NAME, renderPrivacyManifest } from "./inject-privacy-manifest.mjs";
import { step, code } from "./workflow-yaml.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(HERE, "privacy-manifest-report.mjs");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** @capacitor/ios 8's own Capacitor/Capacitor/PrivacyInfo.xcprivacy, verbatim. */
const EMPTY_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyAccessedAPITypes</key>
	<array/>
	<key>NSPrivacyCollectedDataTypes</key>
	<array/>
	<key>NSPrivacyTrackingDomains</key>
	<array/>
	<key>NSPrivacyTracking</key>
	<false/>
</dict>
</plist>
`;

/** A manifest declaring exactly `apis` ({category: [reasons]}). */
function manifest(apis) {
  const entries = Object.entries(apis)
    .map(
      ([c, r]) =>
        `<dict><key>NSPrivacyAccessedAPIType</key><string>${c}</string><key>NSPrivacyAccessedAPITypeReasons</key><array>${r
          .map((x) => `<string>${x}</string>`)
          .join("")}</array></dict>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>NSPrivacyTracking</key><false/><key>NSPrivacyAccessedAPITypes</key><array>${entries}</array></dict></plist>\n`;
}

const CLASS_LIST = ["AppPlugin", "PreferencesPlugin", "SharePlugin", "SplashScreenPlugin", "StatusBarPlugin", "ForayAudioPlugin"];

/** The fixture App.app, in a fresh temp dir. `edit(dir)` runs before returning. */
function fixtureApp({ classes = CLASS_LIST, appManifest = renderPrivacyManifest(), edit } = {}) {
  const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pmr-")), "App.app");
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), text);
  };
  put("Info.plist", "<plist version=\"1.0\"><dict/></plist>\n");
  put("App", "binary");
  if (appManifest !== null) put(MANIFEST_NAME, appManifest);
  put("capacitor.config.json", JSON.stringify({ appId: "ai.jwlabs.foura", packageClassList: classes }, null, "\t"));
  put("Frameworks/Capacitor.framework/Info.plist", "<plist version=\"1.0\"><dict/></plist>\n");
  put(`Frameworks/Capacitor.framework/${MANIFEST_NAME}`, EMPTY_MANIFEST);
  put("Frameworks/Cordova.framework/Info.plist", "<plist version=\"1.0\"><dict/></plist>\n");
  put(`Frameworks/Cordova.framework/${MANIFEST_NAME}`, EMPTY_MANIFEST);
  put("public/index.html", "<!doctype html>\n");
  if (edit) edit(app, put);
  return app;
}

const PREFS = "@capacitor/preferences (PreferencesPlugin)";
const UD = "NSPrivacyAccessedAPICategoryUserDefaults";

/* ───────────────────────────────── the table ──────────────────────────────── */

test("the shipped shape passes, and the table lists the app and each framework's manifest", () => {
  const { lines, failures } = report(fixtureApp());
  assert.deepEqual(failures, []);
  const text = lines.join("\n");
  assert.match(lines[0], /^bundle\s+kind\s+PrivacyInfo\s+NSPrivacyAccessedAPITypes$/);
  assert.match(text, /^App\.app\s+app\s+yes\s+UserDefaults CA92\.1; SystemBootTime 35F9\.1$/m);
  assert.match(text, /^Frameworks\/Capacitor\.framework\s+framework\s+yes\s+\(none\)$/m);
  assert.match(text, /^Frameworks\/Cordova\.framework\s+framework\s+yes\s+\(none\)$/m);
  assert.match(text, new RegExp(`^${PREFS.replace(/[()/.@]/g, "\\$&")}: UserDefaults covered by the app target's manifest$`, "m"));
});

test("a bundle without a manifest is listed as `no`, and resource bundles are found inside frameworks", () => {
  const app = fixtureApp({
    edit: (_a, put) => {
      put("Frameworks/Thin.framework/Info.plist", "<plist version=\"1.0\"><dict/></plist>\n");
      put("Frameworks/Capacitor.framework/Capacitor.bundle/" + MANIFEST_NAME, EMPTY_MANIFEST);
      put("Some.bundle/Info.plist", "<plist version=\"1.0\"><dict/></plist>\n");
    },
  });
  const rows = findBundles(app).map((b) => `${b.rel}|${b.kind}|${b.manifest ? "yes" : "no"}`);
  assert.deepEqual(rows, [
    ".|app|yes",
    "Frameworks/Capacitor.framework|framework|yes",
    "Frameworks/Capacitor.framework/Capacitor.bundle|bundle|yes",
    "Frameworks/Cordova.framework|framework|yes",
    "Frameworks/Thin.framework|framework|no",
    "Some.bundle|bundle|no",
  ]);
  assert.match(report(app).lines.join("\n"), /^Frameworks\/Thin\.framework\s+framework\s+no\s+-$/m);
});

test("public/ is not walked, and a manifest outside a bundle root is reported as stray", () => {
  /* MUTATION: drop the SKIP_AT_APP_ROOT check -> public/'s manifest shows up
     as a stray row and the deepEqual fails. RUN. */
  const app = fixtureApp({
    edit: (_a, put) => {
      put(`public/${MANIFEST_NAME}`, EMPTY_MANIFEST);
      put(`Frameworks/Capacitor.framework/Resources/${MANIFEST_NAME}`, EMPTY_MANIFEST);
    },
  });
  const rows = findBundles(app).map((b) => `${b.rel}|${b.kind}`);
  assert.deepEqual(rows, [
    ".|app",
    "Frameworks/Capacitor.framework|framework",
    `Frameworks/Capacitor.framework/Resources/${MANIFEST_NAME}|stray`,
    "Frameworks/Cordova.framework|framework",
  ]);
});

test("readDeclarations: a category with no reason code is not a declaration", () => {
  /* MUTATION: drop the `if (!reasons.length) continue;` -> the empty-reasons
     entry counts and this fails. RUN. */
  const d = readDeclarations(manifest({ [UD]: [], NSPrivacyAccessedAPICategorySystemBootTime: ["35F9.1"] }));
  assert.equal(d.ok, true);
  assert.deepEqual([...d.declared.keys()], ["NSPrivacyAccessedAPICategorySystemBootTime"]);
  assert.equal(readDeclarations(EMPTY_MANIFEST).hasKey, true);
  assert.equal(readDeclarations(EMPTY_MANIFEST).declared.size, 0);
  assert.equal(readDeclarations("<plist version=\"1.0\"><dict/></plist>").hasKey, false);
  assert.equal(readDeclarations("not a plist").ok, false);
});

/* ───────────────────────────────── the rule ───────────────────────────────── */

test("FAILS when the bundled preferences plugin's UserDefaults is in no manifest", () => {
  /* MUTATION: delete the `failures.push(...)` in the NOT COVERED branch of
     report() -> failures is empty and this fails. RUN. */
  const app = fixtureApp({ appManifest: manifest({ NSPrivacyAccessedAPICategorySystemBootTime: ["35F9.1"] }) });
  const { lines, failures } = report(app);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /@capacitor\/preferences \(PreferencesPlugin\) is bundled and uses NSPrivacyAccessedAPICategoryUserDefaults/);
  assert.match(failures[0], /ITMS-91053/);
  assert.match(lines.join("\n"), /UserDefaults NOT COVERED/);
});

test("FAILS when the app target ships no manifest at all", () => {
  const { lines, failures } = report(fixtureApp({ appManifest: null }));
  assert.equal(failures.length, 1);
  assert.match(lines.join("\n"), /^App\.app\s+app\s+no\s+-$/m);
});

test("a declaration with an empty reason list does not cover the plugin", () => {
  assert.equal(report(fixtureApp({ appManifest: manifest({ [UD]: [] }) })).failures.length, 1);
});

test("the plugin's OWN manifest covers it when the app's does not", () => {
  /* MUTATION: make `own` always [] in report() -> this reports NOT COVERED and
     fails. RUN. */
  const app = fixtureApp({
    appManifest: manifest({}),
    edit: (_a, put) => put(`CapacitorPreferences_PreferencesPlugin.bundle/${MANIFEST_NAME}`, manifest({ [UD]: ["CA92.1"] })),
  });
  const { lines, failures } = report(app);
  assert.deepEqual(failures, []);
  assert.match(lines.join("\n"), /UserDefaults covered by its own manifest \(CapacitorPreferences_PreferencesPlugin\.bundle\)/);
});

test("an own manifest that is present but declares nothing is not coverage", () => {
  /* MUTATION: replace `declares(b, category)` with `!!b.manifest` for the own
     bundle -> this passes the gap and fails. RUN. */
  const app = fixtureApp({
    appManifest: manifest({}),
    edit: (_a, put) => put(`CapacitorPreferences_PreferencesPlugin.bundle/${MANIFEST_NAME}`, EMPTY_MANIFEST),
  });
  const { failures } = report(app);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /neither its own manifest \(CapacitorPreferences_PreferencesPlugin\.bundle\)/);
});

test("a stray manifest named like the plugin's is not coverage either", () => {
  const app = fixtureApp({
    appManifest: manifest({}),
    edit: (_a, put) => put(`Stuff/CapacitorPreferences.bundle.d/${MANIFEST_NAME}`, manifest({ [UD]: ["CA92.1"] })),
  });
  assert.equal(report(app).failures.length, 1);
});

test("an unbundled plugin is reported as such and does not fail the run", () => {
  /* MUTATION: drop the `if (!classes.includes(p.pluginClass))` branch -> the
     unbundled plugin is judged, found uncovered, and this fails. RUN. */
  const app = fixtureApp({ classes: CLASS_LIST.filter((c) => c !== "PreferencesPlugin"), appManifest: manifest({}) });
  const { lines, failures } = report(app);
  assert.deepEqual(failures, []);
  assert.match(lines.join("\n"), /@capacitor\/preferences \(PreferencesPlugin\): not bundled/);
});

test("--mobile: a dependency missing from packageClassList fails, because a renamed class would pass green", () => {
  /* MUTATION: delete the `deps && deps.has(p.npm)` failure -> this reports
     "not bundled" and passes the run; the test fails. RUN. */
  const app = fixtureApp({ classes: ["AppPlugin"] });
  const mobile = fs.mkdtempSync(path.join(os.tmpdir(), "pmr-mobile-"));
  fs.writeFileSync(path.join(mobile, "package.json"), JSON.stringify({ dependencies: { "@capacitor/preferences": "^8.0.0" } }));
  const { failures } = report(app, { mobileDir: mobile });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /depends on it but packageClassList does not list PreferencesPlugin/);
  fs.writeFileSync(path.join(mobile, "package.json"), JSON.stringify({ dependencies: {} }));
  assert.deepEqual(report(app, { mobileDir: mobile }).failures, []);
  assert.throws(() => report(app, { mobileDir: path.join(mobile, "nope") }), /--mobile: cannot read/);
});

test("no capacitor.config.json, or no packageClassList in it, cannot be judged and throws", () => {
  /* MUTATION: return [] from packageClassList when the file is missing -> the
     plugin reads as unbundled, nothing throws, and this fails. RUN. */
  const app = fixtureApp();
  fs.writeFileSync(path.join(app, "capacitor.config.json"), JSON.stringify({ appId: "x" }));
  assert.throws(() => packageClassList(app), ReportError);
  assert.throws(() => report(app), /no packageClassList array/);
  fs.rmSync(path.join(app, "capacitor.config.json"));
  assert.throws(() => report(app), /capacitor\.config\.json is missing/);
  assert.throws(() => report(path.join(app, "missing.app")), /no such bundle/);
});

test("an unreadable app manifest is shown as such and is not coverage", () => {
  const app = fixtureApp({ appManifest: "<plist version=\"1.0\"><dict><key>a</key></dict></plist>" });
  const { lines, failures } = report(app);
  assert.match(lines.join("\n"), /^App\.app\s+app\s+yes\s+UNREADABLE/m);
  assert.equal(failures.length, 1);
});

test("the read seam is used for every manifest (binary plists go through plutil on the Mac)", () => {
  const seen = [];
  report(fixtureApp(), { read: (f) => (seen.push(path.basename(path.dirname(f))), fs.readFileSync(f, "utf8")) });
  assert.deepEqual(seen.sort(), ["App.app", "Capacitor.framework", "Cordova.framework"]);
});

/* ─────────────────────────────────── the CLI ──────────────────────────────── */

test("the CLI exits 0 on the shipped shape, 1 on a gap, 2 on bad arguments", () => {
  const ok = spawnSync(process.execPath, [SCRIPT, fixtureApp()], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Frameworks\/Capacitor\.framework/);
  const gap = spawnSync(process.execPath, [SCRIPT, fixtureApp({ appManifest: manifest({}) })], { encoding: "utf8" });
  assert.equal(gap.status, 1);
  assert.match(gap.stdout, /NOT COVERED/);
  assert.match(gap.stderr, /1 gap\(s\)/);
  for (const args of [[], ["x", "--frobnicate"], ["x", "--mobile"], ["x", "--mobile", "--other"], ["x", "y"]]) {
    assert.equal(spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" }).status, 2, args.join(" "));
  }
});

/* ──────────────────────────────── REAL REPO ───────────────────────────────── */

test("REAL REPO: every listed plugin is still a mobile/ dependency, and its categories are ones the app manifest declares", () => {
  const deps = JSON.parse(read("mobile/package.json")).dependencies;
  const appCategories = new Set(ACCESSED_API_TYPES.map((a) => a.category));
  assert.ok(REQUIRED_REASON_PLUGINS.length >= 1);
  for (const p of REQUIRED_REASON_PLUGINS) {
    assert.ok(deps[p.npm], `${p.npm} is no longer in mobile/package.json; drop it from REQUIRED_REASON_PLUGINS`);
    for (const c of p.categories) assert.ok(appCategories.has(c), `${p.npm} uses ${c}, which the app target's manifest does not declare`);
  }
});

const WF = read(".github/workflows/ios-build.yml");

test("ios-build.yml runs the report on the BUILT Release bundle, with --mobile, and keeps it as evidence", () => {
  /* MUTATION: delete the workflow step -> fails. RUN. */
  const s = code(step(WF, "List every privacy manifest in the BUILT bundle") ?? "");
  assert.ok(s, "ios-build.yml never runs privacy-manifest-report.mjs");
  const call = s.replace(/\s*\\\n\s*/g, " ");
  assert.match(call, /node tools\/mobile\/privacy-manifest-report\.mjs "\$DD_DEV\/Build\/Products\/Release-iphoneos\/App\.app" --mobile mobile \| tee "\$ART\/privacy-manifest-report\.txt"/);
  assert.match(s, /set -euo pipefail/, "without pipefail, tee would swallow the report's exit code");
  assert.equal(/continue-on-error/.test(s), false, "a gap must turn the job red");
  assert.ok(WF.indexOf("- name: List every privacy manifest") > WF.indexOf("- name: Build for a real device's architecture"));
});
