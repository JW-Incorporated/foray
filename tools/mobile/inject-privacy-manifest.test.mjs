/* Tests for the iOS privacy manifest (#948): the file, its wiring into the
 * generated Xcode project, the check on the built bundle, and the evidence the
 * declarations rest on.
 *
 * EVERY TEST HERE RUNS ON WINDOWS. The fixture is the real project.pbxproj the
 * Capacitor 8.5.0 CLI generates (`@capacitor/cli/assets/ios-spm-template.tar.gz`,
 * App/App.xcodeproj/project.pbxproj, unmodified), so the first test is evidence
 * that `cap add ios` ships no manifest, not a restatement. What only a Mac can
 * show — that Xcode copies the file into App.app — is ios-build.yml's
 * "Assert the privacy manifest really reached the BUILT bundle" step; read it as
 * unverified until a run is linked on #948.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ACCESSED_API_TYPES,
  COLLECTED_DATA_TYPES,
  MANIFEST_NAME,
  PbxprojError,
  assertWired,
  decodePlist,
  injectPbxproj,
  locate,
  manifestProblems,
  parsePbxproj,
  pbxId,
  renderPrivacyManifest,
  runBundle,
  runCheck,
  runInject,
  wiringProblems,
} from "./inject-privacy-manifest.mjs";
import { step, code } from "./workflow-yaml.mjs";
import { DENIED_PREFIXES } from "../ci/path-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(HERE, "inject-privacy-manifest.mjs");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* Normalised to LF: a Windows checkout may hand it over as CRLF, and the CRLF
   case has its own test below. */
const PBX = fs
  .readFileSync(path.join(HERE, "fixtures", "privacy-manifest", "capacitor-8.5.0-spm.pbxproj"), "utf8")
  .replace(/\r\n/g, "\n");

/** Lines in `b` that are not in `a`, walking both in order (insert-only diff).
 *  Fails if anything in `a` was changed or removed. */
function insertedLines(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  const added = [];
  let i = 0;
  for (const line of y) {
    if (i < x.length && line === x[i]) i++;
    else added.push(line);
  }
  assert.equal(i, x.length, "an original line was changed or removed");
  return added;
}

/* ─────────────────────────────── the project edit ─────────────────────────── */

test("the project `cap add ios` generates ships no privacy manifest", () => {
  const p = wiringProblems(PBX);
  assert.deepEqual(p, [`no PBXFileReference for ${MANIFEST_NAME}.`]);
  assert.equal(PBX.includes("xcprivacy"), false);
});

test("injection adds exactly the four entries and leaves every other byte alone", () => {
  const r = injectPbxproj(PBX);
  assert.equal(r.changed, true);
  const added = insertedLines(PBX, r.text);
  assert.equal(added.length, 4, added.join("\n"));
  assert.ok(added.some((l) => /^\t\t[0-9A-F]{24} \/\* PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference; lastKnownFileType = text\.xml; path = PrivacyInfo\.xcprivacy; sourceTree = "<group>"; \};$/.test(l)));
  assert.ok(added.some((l) => /^\t\t[0-9A-F]{24} \/\* PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile; fileRef = [0-9A-F]{24} \/\* PrivacyInfo\.xcprivacy \*\/; \};$/.test(l)));
  assert.ok(added.some((l) => /^\t\t\t\t[0-9A-F]{24} \/\* PrivacyInfo\.xcprivacy \*\/,$/.test(l)), "group child, in the group's own indentation");
  assert.ok(added.some((l) => /^\t\t\t\t[0-9A-F]{24} \/\* PrivacyInfo\.xcprivacy in Resources \*\/,$/.test(l)), "phase member");
});

test("the result is wired into the APPLICATION target's Resources phase, beside Info.plist", () => {
  const out = injectPbxproj(PBX).text;
  assert.deepEqual(wiringProblems(out), []);
  const at = locate(out);
  assert.equal(at.targetId, "504EC3031FED79650016851F", "the App target");
  assert.equal(at.resourcesId, "504EC3021FED79650016851F", "its Resources phase");
  assert.equal(at.groupId, "504EC3061FED79650016851F", "the App group, which holds Info.plist");
  assert.equal(at.inResources.length, 1);
  assert.equal(at.inSources, false);
});

test("the file and build-file sections stay in their sections", () => {
  const out = injectPbxproj(PBX).text;
  const section = (isa) => out.slice(out.indexOf(`/* Begin ${isa} section */`), out.indexOf(`/* End ${isa} section */`));
  assert.match(section("PBXFileReference"), /PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference/);
  assert.match(section("PBXBuildFile"), /PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile/);
});

test("running it twice changes nothing the second time", () => {
  const once = injectPbxproj(PBX).text;
  const twice = injectPbxproj(once);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once);
});

test("object ids are Xcode-shaped, reproducible, and never collide with the project's", () => {
  const a = injectPbxproj(PBX).text;
  const b = injectPbxproj(PBX).text;
  assert.equal(a, b, "same input, same output");
  const ids = [...parsePbxproj(a).objects.keys()];
  assert.equal(new Set(ids).size, ids.length);
  const first = pbxId("x", new Set());
  assert.match(first, /^[0-9A-F]{24}$/);
  assert.notEqual(pbxId("x", new Set([first])), first, "a taken id is stepped past");
});

test("an insertion that does not land is refused", () => {
  /* MUTATION: `return;` as the first line of assertWired() -> this fails (no
     throw), and the injector would write a project that does not ship the file.
     RUN. */
  assert.throws(() => assertWired(PBX), /the edit did not take[\s\S]*no PBXFileReference/);
  assert.doesNotThrow(() => assertWired(injectPbxproj(PBX).text));
});

test("a partial wiring is completed, not duplicated", () => {
  /* File reference and group child present, no build file: only the two
     missing entries are added. */
  const full = injectPbxproj(PBX).text;
  const partial = full
    .split("\n")
    .filter((l) => !l.includes("PrivacyInfo.xcprivacy in Resources"))
    .join("\n");
  assert.deepEqual(wiringProblems(partial), [`${MANIFEST_NAME} is in the app target's Resources phase 0 times, not once.`]);
  const r = injectPbxproj(partial);
  assert.equal(r.reason, "added build file, Resources-phase member");
  assert.equal(insertedLines(partial, r.text).length, 2);
  assert.deepEqual(wiringProblems(r.text), []);
});

test("two references to the manifest are refused rather than guessed between", () => {
  const full = injectPbxproj(PBX).text;
  const line = full.split("\n").find((l) => l.includes("isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo"));
  const dup = full.replace(line, `${line}\n${line.replace(/^\t\t[0-9A-F]{24}/, "\t\tABCDEFABCDEFABCDEFABCDEF")}`);
  assert.throws(() => injectPbxproj(dup), /2 file references/);
});

test("a manifest referenced from some other group is refused", () => {
  const full = injectPbxproj(PBX).text;
  const ref = /\t\t\t\t([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy \*\/,/.exec(full)[0];
  const moved = full
    .replace(`${ref}\n`, "")
    .replace("\t\t\t\t504EC3041FED79650016851F /* App.app */,\n", `\t\t\t\t504EC3041FED79650016851F /* App.app */,\n${ref}\n`);
  assert.throws(() => injectPbxproj(moved), /group other than Info\.plist's/);
});

test("two application targets are refused", () => {
  const twin = PBX.replace(
    "/* End PBXNativeTarget section */",
    "\t\tABCDEF0123456789ABCDEF01 /* Twin */ = {isa = PBXNativeTarget; buildPhases = (); productType = \"com.apple.product-type.application\"; };\n/* End PBXNativeTarget section */"
  );
  assert.throws(() => injectPbxproj(twin), /exactly one application target, found 2/);
});

test("a project with no section markers is refused, not appended to blindly", () => {
  const bare = PBX.replace("/* End PBXBuildFile section */", "");
  assert.throws(() => injectPbxproj(bare), /End PBXBuildFile section/);
});

test("a CRLF project gets CRLF lines", () => {
  const crlf = PBX.replace(/\n/g, "\r\n");
  const out = injectPbxproj(crlf).text;
  assert.equal(/[^\r]\n/.test(out), false, "a bare LF was written into a CRLF file");
  assert.deepEqual(wiringProblems(out), []);
});

test("the parser: comments, quoted escapes, duplicate keys and trailing junk", () => {
  const ok = parsePbxproj('// !$*UTF8*$!\n{ /* c */ objects = { A = { isa = X; name = "a \\"b\\" c"; list = ( 1, 2, ); }; }; }\n');
  const a = ok.objects.get("A");
  assert.equal(a.entries.get("name").value, 'a "b" c');
  assert.equal(a.entries.get("list").items.length, 2);
  assert.throws(() => parsePbxproj("{ objects = { A = 1; A = 2; }; }"), /duplicate key A/);
  assert.throws(() => parsePbxproj("{ objects = { }; } }"), /trailing content/);
  assert.throws(() => parsePbxproj("{ objects = { A = { ; }; }; }"), PbxprojError);
});

/* ───────────────────────────────── the manifest ───────────────────────────── */

test("the rendered manifest says exactly what this module declares", () => {
  const xml = renderPrivacyManifest();
  assert.deepEqual(manifestProblems(xml), []);
  const m = decodePlist(xml);
  assert.equal(m.NSPrivacyTracking, false);
  assert.deepEqual(m.NSPrivacyTrackingDomains, []);
  assert.deepEqual(
    m.NSPrivacyAccessedAPITypes.map((a) => [a.NSPrivacyAccessedAPIType, a.NSPrivacyAccessedAPITypeReasons]),
    [
      ["NSPrivacyAccessedAPICategoryUserDefaults", ["CA92.1"]],
      ["NSPrivacyAccessedAPICategorySystemBootTime", ["35F9.1"]],
      ["NSPrivacyAccessedAPICategoryFileTimestamp", ["C617.1"]],
    ]
  );
  assert.deepEqual(
    m.NSPrivacyCollectedDataTypes.map((c) => c.NSPrivacyCollectedDataType),
    ["NSPrivacyCollectedDataTypeUserID", "NSPrivacyCollectedDataTypeProductInteraction", "NSPrivacyCollectedDataTypeOtherUserContent"]
  );
  for (const c of m.NSPrivacyCollectedDataTypes) {
    assert.equal(c.NSPrivacyCollectedDataTypeLinked, true);
    assert.equal(c.NSPrivacyCollectedDataTypeTracking, false);
  }
});

test("the manifest's bytes are stable: LF, tabs, one trailing newline", () => {
  const xml = renderPrivacyManifest();
  assert.equal(xml, renderPrivacyManifest());
  assert.equal(xml.includes("\r"), false);
  assert.ok(xml.endsWith("</plist>\n"));
  assert.match(xml, /^\t<key>NSPrivacyTracking<\/key>$/m);
});

test("manifestProblems names each way a manifest can be wrong", () => {
  const xml = renderPrivacyManifest();
  const mutate = (from, to) => {
    assert.ok(xml.includes(from), from);
    return manifestProblems(xml.replace(from, to));
  };
  assert.match(mutate("<key>NSPrivacyTracking</key>\n\t<false/>", "<key>NSPrivacyTracking</key>\n\t<true/>").join(), /NSPrivacyTracking is true/);
  assert.match(mutate("<string>CA92.1</string>", "<string>1C8F.1</string>").join(), /UserDefaults gives reasons \["1C8F\.1"\]/);
  assert.match(mutate("NSPrivacyAccessedAPICategorySystemBootTime", "NSPrivacyAccessedAPICategoryDiskSpace").join(), /SystemBootTime is declared 0 times[\s\S]*DiskSpace/);
  assert.match(mutate("<key>NSPrivacyCollectedDataTypeLinked</key>\n\t\t\t<true/>", "<key>NSPrivacyCollectedDataTypeLinked</key>\n\t\t\t<false/>").join(), /UserID: Linked is false/);
  assert.match(mutate("NSPrivacyCollectedDataTypeOtherUserContent", "NSPrivacyCollectedDataTypeEmailAddress").join(), /OtherUserContent is declared 0 times/);
  assert.match(manifestProblems("not a plist").join(), /not a readable plist/);
});

test("the built bundle's copy is judged on meaning, so a reformatted copy still passes", () => {
  /* Xcode may copy the manifest as a binary plist; `--bundle` reads it through
     plutil and then decodes. Re-indented with spaces and a key order of its own
     stands in for that here. */
  const reformatted = renderPrivacyManifest()
    .replace(/\t/g, "  ")
    .replace("<key>NSPrivacyTracking</key>\n  <false/>\n", "")
    .replace("</array>\n</dict>", "</array>\n  <key>NSPrivacyTracking</key>\n  <false/>\n</dict>");
  assert.notEqual(reformatted, renderPrivacyManifest());
  assert.deepEqual(manifestProblems(reformatted), []);
  assert.throws(() => decodePlist("<plist><dict><key>a</key><true/><key>a</key><false/></dict></plist>"), /duplicate key a/);
});

/* ───────────────────────────── the CLI and the bundle ─────────────────────── */

function tempIosApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-manifest-"));
  fs.mkdirSync(path.join(dir, "App"));
  fs.mkdirSync(path.join(dir, "App.xcodeproj"));
  fs.writeFileSync(path.join(dir, "App", "Info.plist"), "<plist><dict/></plist>\n");
  fs.writeFileSync(path.join(dir, "App.xcodeproj", "project.pbxproj"), PBX);
  return dir;
}

test("the CLI writes the manifest and the wiring, and --check reads both back", () => {
  const dir = tempIosApp();
  let r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, "App", MANIFEST_NAME), "utf8"), renderPrivacyManifest());
  assert.deepEqual(wiringProblems(fs.readFileSync(path.join(dir, "App.xcodeproj", "project.pbxproj"), "utf8")), []);
  r = spawnSync(process.execPath, [SCRIPT, dir, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /current, and in the app target's Resources phase/);
});

test("--check fails on a stale manifest and on an unwired project", () => {
  const dir = tempIosApp();
  runInject(dir);
  fs.writeFileSync(path.join(dir, "App", MANIFEST_NAME), renderPrivacyManifest().replace("CA92.1", "C56D.1"));
  assert.throws(() => runCheck(dir), /is not the manifest this script writes/);
  runInject(dir);
  fs.writeFileSync(path.join(dir, "App.xcodeproj", "project.pbxproj"), PBX);
  assert.throws(() => runCheck(dir), /no PBXFileReference/);
  const r = spawnSync(process.execPath, [SCRIPT, dir, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 1);
});

test("a project it refuses leaves the manifest unwritten", () => {
  const dir = tempIosApp();
  fs.writeFileSync(path.join(dir, "App.xcodeproj", "project.pbxproj"), PBX.replace("/* End PBXBuildFile section */", ""));
  assert.throws(() => runInject(dir), /End PBXBuildFile section/);
  assert.equal(fs.existsSync(path.join(dir, "App", MANIFEST_NAME)), false);
});

test("unknown arguments are an error, not ignored", () => {
  for (const args of [["x", "--frobnicate"], [], ["x", "--check", "--bundle"]]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
  }
});

test("--bundle passes a built app carrying the manifest and fails one without it", () => {
  /* MUTATION: drop the `fs.existsSync(file)` refusal in runBundle -> the
     missing-file case throws ENOENT instead of naming ITMS-91053, and this
     fails. RUN. */
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "App.app-"));
  const plainRead = (f) => fs.readFileSync(f, "utf8");
  assert.throws(() => runBundle(app, plainRead), /PrivacyInfo\.xcprivacy is missing[\s\S]*ITMS-91053/);
  fs.writeFileSync(path.join(app, MANIFEST_NAME), renderPrivacyManifest().replace("35F9.1", "3D61.1"));
  assert.throws(() => runBundle(app, plainRead), /SystemBootTime gives reasons/);
  fs.writeFileSync(path.join(app, MANIFEST_NAME), renderPrivacyManifest());
  assert.match(runBundle(app, plainRead)[0], /present; NSPrivacyAccessedAPICategoryUserDefaults CA92\.1/);
});

/* ────────────────────────── REAL REPO: the evidence ───────────────────────── */

/** Every non-test Swift file shipped in the app by our own plugins. */
function pluginSwift() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "Tests" || e.name === "node_modules" || e.name === ".build" || e.name === "android") continue;
        walk(full);
      } else if (e.name.endsWith(".swift") && e.name !== "Package.swift") out.push(full);
    }
  };
  walk(path.join(ROOT, "mobile", "plugins"));
  return out;
}

/** Apple's Required Reason API list, as call-site patterns. */
const CATEGORY_PATTERNS = {
  NSPrivacyAccessedAPICategoryUserDefaults: /\bUserDefaults\b|NSUserDefaults/,
  NSPrivacyAccessedAPICategorySystemBootTime: /\bsystemUptime\b|\bmach_absolute_time\b/,
  NSPrivacyAccessedAPICategoryFileTimestamp:
    /\bcreationDate\b|\bmodificationDate\b|contentModificationDateKey|creationDateKey|NSFileCreationDate|NSFileModificationDate|\bfileModificationDate\b|attributesOfItem|\bgetattrlist\b|\b[fl]?stat\s*\(|\bfstatat\b/,
  NSPrivacyAccessedAPICategoryDiskSpace:
    /volumeAvailableCapacity|NSFileSystemFreeSize|NSFileSystemSize|\bsystemFreeSize\b|\bstatv?fs\b|\bfstatv?fs\b/,
  NSPrivacyAccessedAPICategoryActiveKeyboards: /\bactiveInputModes\b/,
};

/** Swift with comments removed, so a doc comment explaining an API is not a use. */
const swiftCode = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("REAL REPO: no plugin Swift uses a Required Reason API the manifest does not declare", () => {
  /* The tripwire this file exists for: a new `UserDefaults`, `systemUptime` or
     file-timestamp read lands in a plugin, and the manifest has not been
     revisited. MUTATION: delete the SystemBootTime row from ACCESSED_API_TYPES
     -> NowPlayingPublisher.swift is named here. RUN. */
  const declared = new Set(ACCESSED_API_TYPES.map((a) => a.category));
  const files = pluginSwift();
  assert.ok(files.length > 20, `found only ${files.length} plugin Swift files; the walk is wrong`);
  const undeclared = [];
  const used = new Set();
  for (const f of files) {
    const src = swiftCode(fs.readFileSync(f, "utf8"));
    for (const [cat, re] of Object.entries(CATEGORY_PATTERNS)) {
      if (!re.test(src)) continue;
      used.add(cat);
      if (!declared.has(cat)) undeclared.push(`${path.relative(ROOT, f)}: ${cat}`);
    }
  }
  assert.deepEqual(undeclared, []);
  assert.ok(used.has("NSPrivacyAccessedAPICategoryUserDefaults"), "UserDefaults use not found: the scan is broken");
  assert.ok(used.has("NSPrivacyAccessedAPICategorySystemBootTime"), "systemUptime use not found: the scan is broken");
});

test("REAL REPO: every declared category's evidence is still where the module says", () => {
  for (const a of ACCESSED_API_TYPES) {
    assert.ok(a.evidence.length, `${a.category} cites no evidence`);
    for (const e of a.evidence) {
      const full = path.join(ROOT, e.file);
      assert.ok(fs.existsSync(full), `${a.category}: ${e.file} is gone`);
      assert.match(fs.readFileSync(full, "utf8"), e.pattern, `${a.category}: ${e.file} no longer shows ${e.pattern}`);
    }
  }
});

test("REAL REPO: the collected types are exactly data-safety.md B2's **Yes** rows", () => {
  /* The manifest's NSPrivacyCollectedDataTypes and App Store Connect's App
     Privacy answers must say the same thing. MUTATION: drop the
     OtherUserContent row from COLLECTED_DATA_TYPES -> fails. RUN. */
  const doc = read("docs/legal/data-safety.md");
  const b2 = doc.slice(doc.indexOf("## B2. Data types"), doc.indexOf("## B3."));
  const yes = [...b2.matchAll(/^\| \*\*([^|]+?)\*\*[^|]*\| \*\*Yes\*\* \|/gm)].map((m) => m[1].trim());
  const rows = [...b2.matchAll(/^\| \*\*([^*]+)\*\*(?: — ([^|]+?))? \| \*\*Yes\*\* \|/gm)].map((m) =>
    m[2] ? `${m[1].trim()} — ${m[2].trim()}` : m[1].trim()
  );
  assert.equal(yes.length, 3, `B2 has ${yes.length} Yes rows: ${yes.join(", ")}`);
  assert.deepEqual(rows.sort(), COLLECTED_DATA_TYPES.map((c) => c.b2Row).sort());
});

test("REAL REPO: data-safety.md B4 names each declared category and reason code", () => {
  const doc = read("docs/legal/data-safety.md");
  const b4 = doc.slice(doc.indexOf("## B4."), doc.indexOf("# Part C"));
  for (const a of ACCESSED_API_TYPES) {
    assert.ok(b4.includes(a.category), `B4 does not name ${a.category}`);
    for (const r of a.reasons) assert.ok(b4.includes(`**${r}**`), `B4 does not give ${a.category}'s reason ${r}`);
  }
  assert.match(b4, /Generate Privacy/, "the human Mac step is not recorded");
  assert.doesNotMatch(b4, /uses none of the categories Apple\s+requires/, "the old 'no Required Reason APIs' claim is back");
});

/* ──────────────────────── REAL REPO: the two build paths ──────────────────── */

const WF = read(".github/workflows/ios-build.yml");
const ACTION = read(".github/actions/ios-archive/action.yml");

/** One composite-action step (4-space list indent, not the workflow's 6). */
function actionStep(src, fragment) {
  return src.split(/\n(?= {4}- (?:name|uses):)/).filter((c) => /^\s*- (?:name|uses):/.test(c)).find((c) => c.includes(fragment)) ?? null;
}

test("ios-build.yml writes and checks the manifest after the project exists and before any build", () => {
  /* MUTATION: delete the `--check` line from the step -> fails. Move the step
     below "Build for the iOS Simulator" -> fails. RUN (the first). */
  const s = code(step(WF, "Add the privacy manifest") ?? "");
  assert.ok(s, "ios-build.yml has no privacy-manifest step");
  assert.match(s, /^\s*node tools\/mobile\/inject-privacy-manifest\.mjs "\$IOS_DIR\/App"\s*$/m, "the write is gone");
  assert.match(s, /^\s*node tools\/mobile\/inject-privacy-manifest\.mjs "\$IOS_DIR\/App" --check\s*$/m, "the read-back is gone");
  assert.match(s, /plutil -lint "\$IOS_DIR\/App\/App\.xcodeproj\/project\.pbxproj"/, "Apple's parser never reads the edited project");
  const at = (f) => WF.indexOf(`- name: ${f}`);
  assert.ok(at("Add the privacy manifest") > at("Build the webDir and generate the iOS project"));
  assert.ok(at("Add the privacy manifest") < at("Build for the iOS Simulator"));
  assert.equal(/continue-on-error/.test(s), false);
});

test("ios-build.yml checks the BUILT Release bundle and keeps the copy as evidence", () => {
  const s = code(step(WF, "Assert the privacy manifest really reached the BUILT bundle") ?? "");
  assert.ok(s, "nothing checks the built bundle for the manifest");
  assert.match(s, /APP="\$DD_DEV\/Build\/Products\/Release-iphoneos\/App\.app"/);
  assert.match(s, /inject-privacy-manifest\.mjs --bundle "\$APP"/);
  assert.match(s, /cp "\$APP\/PrivacyInfo\.xcprivacy" "\$ART\//, "the built copy is not kept in the evidence artifact");
  assert.ok(WF.indexOf("- name: Assert the privacy manifest really reached") > WF.indexOf("- name: Build for a real device's architecture"));
});

test("the ios-archive action (the App Store path) writes, checks, and reads it back out of the archive", () => {
  /* The release composite is a third build path; #675 shipped a rejection
     because a fix reached only the PR-time workflow. MUTATION: delete the
     action's privacy-manifest step -> fails. RUN. */
  const s = code(actionStep(ACTION, "Add the privacy manifest") ?? "");
  assert.ok(s, "the ios-archive action has no privacy-manifest step");
  assert.match(s, /^\s*node tools\/mobile\/inject-privacy-manifest\.mjs mobile\/ios\/App\s*$/m);
  assert.match(s, /^\s*node tools\/mobile\/inject-privacy-manifest\.mjs mobile\/ios\/App --check\s*$/m);
  assert.ok(ACTION.indexOf("- name: Add the privacy manifest") < ACTION.indexOf("- name: Archive and sign"));
  const back = code(actionStep(ACTION, "Read the privacy manifest back out of the archive") ?? "");
  assert.match(back, /inject-privacy-manifest\.mjs --bundle \\\n\s*"\$RUNNER_TEMP\/Foray\.xcarchive\/Products\/Applications\/App\.app"/);
  assert.ok(ACTION.indexOf("- name: Read the privacy manifest back") > ACTION.indexOf("- name: Archive and sign"));
  assert.ok(ACTION.indexOf("- name: Read the privacy manifest back") < ACTION.indexOf("- name: Export and upload"));
});

test("the injector is DENIED in path-policy, like its siblings in the release job", () => {
  assert.ok(DENIED_PREFIXES.includes("tools/mobile/inject-privacy-manifest.mjs"));
});
