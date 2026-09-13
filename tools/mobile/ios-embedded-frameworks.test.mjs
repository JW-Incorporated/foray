/* The embedded-framework plist rules — the patch, and the guard that would have
 * caught the upload failure in CI instead of at Apple.
 *
 * THE FIXTURE IS THE REAL ARTEFACT. `ORT_PLIST` below is a byte-for-byte copy of
 * `onnxruntime.xcframework/ios-arm64/onnxruntime.framework/Info.plist` out of
 * `pod-archive-onnxruntime-c-1.20.0.zip` (sha256 50891a8a…, the exact bytes the
 * `exact: "1.20.0"` pin resolves to and the checksum `Package.swift` verifies).
 * It is 613 bytes and it has no `MinimumOSVersion`. Writing a prettier fixture by
 * hand would have made the first test below — the one that PROVES the diagnosis
 * rather than restating it — a test of my own typing.
 *
 * Every test names the MUTATION that kills it.
 *
 * WHAT THIS SUITE CANNOT DO. It cannot upload anything, and it cannot read or
 * write a binary plist: those two operations shell out to `plutil`, which exists
 * only on the Mac both call sites already run on. `runVerify` and `runPatch` take
 * those as seams for exactly that reason, so every DECISION they make is covered
 * here and only the two `execFileSync` lines are not.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MIN_OS_KEY,
  MIN_OS_FLOOR,
  REQUIRED_FRAMEWORK_KEYS,
  rootValue,
  minimumOSVersion,
  parseVersion,
  compareVersions,
  injectMinimumOSVersion,
  assertMinimumOSVersion,
  frameworkProblems,
  findFrameworkPlists,
  isIosSlice,
  isBinaryPlist,
  runPatch,
  runVerify,
} from "./ios-embedded-frameworks.mjs";

/* The real thing. Tabs and all. */
const ORT_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleExecutable</key>
\t<string>onnxruntime</string>
\t<key>CFBundleName</key>
\t<string>onnxruntime</string>
\t<key>CFBundleIdentifier</key>
\t<string>com.microsoft.onnxruntime</string>
\t<key>CFBundleVersion</key>
\t<string>1.20.0</string>
\t<key>CFBundleShortVersionString</key>
\t<string>1.20.0</string>
\t<key>CFBundleSignature</key>
\t<string>????</string>
\t<key>CFBundlePackageType</key>
\t<string>FMWK</string>
</dict>
</plist>
`;

/** A minimal app Info.plist, for the verify fixtures. */
function appPlist(minOS) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<plist version="1.0">\n<dict>\n` +
    `\t<key>CFBundleIdentifier</key>\n\t<string>ai.jwlabs.foura</string>\n` +
    `\t<key>${MIN_OS_KEY}</key>\n\t<string>${minOS}</string>\n` +
    `</dict>\n</plist>\n`
  );
}

let tmpSeq = 0;
function tmpdir() {
  const d = path.join(os.tmpdir(), `foray-fw-${process.pid}-${tmpSeq++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/* ───────────────── the diagnosis, held as evidence rather than prose ─────── */

test("the shipped ONNX Runtime 1.20.0 iOS slice really has no MinimumOSVersion — this is the defect, not our embed", () => {
  /* THE WHOLE POINT OF THE FIX, pinned. If ONNX Runtime ever ships the key, this
     test goes red and the patch step becomes a no-op that can be deleted — which
     is the outcome the header says to hope for.
     MUTATION: none needed — this asserts the fixture, and the fixture is the
     upstream artefact. It fails the day the fixture is quietly "corrected". */
  assert.equal(minimumOSVersion(ORT_PLIST), null);
});

test("that slice DOES carry the other four keys App Store Connect wants — so the patch is one key, not a rewrite", () => {
  /* MUTATION: adding a sixth entry to REQUIRED_FRAMEWORK_KEYS that ORT lacks —
     this test still passes, but "the patched plist has no problems" below fails,
     which is where an over-broad requirement gets caught. */
  for (const key of REQUIRED_FRAMEWORK_KEYS.filter((k) => k !== MIN_OS_KEY)) {
    const v = rootValue(ORT_PLIST, key);
    assert.ok(v, `${key} missing from the real ORT plist`);
    assert.equal(v.tag, "string");
    assert.notEqual(v.text.trim(), "");
  }
});

/* ──────────────────────────── reading root values ────────────────────────── */

test("rootValue returns the value's TAG as well as its text — MUTATION: returning the text alone loses the <true/>-vs-<string> distinction the problem list reports", () => {
  assert.deepEqual(rootValue(ORT_PLIST, "CFBundleIdentifier"), {
    tag: "string",
    text: "com.microsoft.onnxruntime",
  });
  assert.equal(rootValue(ORT_PLIST, "NoSuchKey"), null);
});

test("an EMPTY value reads as \"\" and not as null — MUTATION: collapsing empty to null makes 'present but blank' report as 'missing' and the in-place fill never run", () => {
  const empty = ORT_PLIST.replace(
    "</dict>",
    `\t<key>${MIN_OS_KEY}</key>\n\t<string></string>\n</dict>`
  );
  assert.equal(minimumOSVersion(empty), "");
  const selfClosing = ORT_PLIST.replace(
    "</dict>",
    `\t<key>${MIN_OS_KEY}</key>\n\t<string/>\n</dict>`
  );
  assert.equal(minimumOSVersion(selfClosing), "");
});

test("a duplicated root key throws instead of picking one — MUTATION: .find() instead of filter+throw; readers take the LAST and an edit to the first is invisible", () => {
  const dup = ORT_PLIST.replace(
    "</dict>",
    `\t<key>${MIN_OS_KEY}</key>\n\t<string>15.0</string>\n\t<key>${MIN_OS_KEY}</key>\n\t<string>16.0</string>\n</dict>`
  );
  assert.throws(() => minimumOSVersion(dup), /declares MinimumOSVersion 2 times/);
});

test("a MinimumOSVersion that is not a <string> throws rather than being coerced — MUTATION: reading v.text regardless of tag turns <real>15.0</real> into a silent pass", () => {
  const wrong = ORT_PLIST.replace(
    "</dict>",
    `\t<key>${MIN_OS_KEY}</key>\n\t<real>15.0</real>\n</dict>`
  );
  assert.throws(() => minimumOSVersion(wrong), /is a <real>, but Apple requires a <string>/);
});

/* ──────────────────────────────── versions ───────────────────────────────── */

test("parseVersion is strict — MUTATION: parseFloat, which reads '15.0b' as 15 and writes a version Apple cannot parse back into the plist", () => {
  assert.deepEqual(parseVersion("15.0"), [15, 0]);
  assert.deepEqual(parseVersion("15"), [15]);
  assert.deepEqual(parseVersion("15.1.2"), [15, 1, 2]);
  for (const bad of ["15.0b", "v15", "", " 15.0", "15..0", "15.0 ", "abc", null, 15]) {
    assert.equal(parseVersion(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test("compareVersions pads missing components, so 15 and 15.0 are equal — MUTATION: comparing array lengths first makes '15' < '15.0' and a correct patch report as wrong", () => {
  assert.equal(compareVersions("15", "15.0"), 0);
  assert.equal(compareVersions("15.0.0", "15"), 0);
});

test("compareVersions is numeric, not lexicographic — MUTATION: a < b on the strings, which makes 9.0 > 10.0 and hides a framework that outruns the app", () => {
  assert.equal(compareVersions("9.0", "10.0"), -1);
  assert.equal(compareVersions("10.0", "9.0"), 1);
  assert.equal(compareVersions("15.1", "15.0"), 1);
  assert.throws(() => compareVersions("15.0", "sixteen"), /not a version/);
});

/* ──────────────────────────────── injection ──────────────────────────────── */

test("injecting into the real ORT plist puts MinimumOSVersion in the root dict and re-reads it", () => {
  /* MUTATION: appending the block AFTER </plist> — the file still contains the
     string, and this test still fails, because it re-parses rather than greps. */
  const r = injectMinimumOSVersion(ORT_PLIST, "15.0");
  assert.equal(r.changed, true);
  assert.equal(minimumOSVersion(r.xml), "15.0");
  assert.match(r.reason, /added MinimumOSVersion = 15\.0/);
});

test("the edit changes nothing else in the file — MUTATION: round-tripping through a plist writer, which reformats 613 vendored bytes into a diff nobody can review", () => {
  const r = injectMinimumOSVersion(ORT_PLIST, "15.0");
  const removed = r.xml.replace(`\t<key>${MIN_OS_KEY}</key>\n\t<string>15.0</string>\n`, "");
  assert.equal(removed, ORT_PLIST);
});

test("the inserted block takes its indentation from the file it found — MUTATION: hardcoding two spaces, which is not what Microsoft's plist uses", () => {
  const r = injectMinimumOSVersion(ORT_PLIST, "15.0");
  assert.ok(r.xml.includes(`\t<key>${MIN_OS_KEY}</key>`), "expected a TAB-indented key");
  assert.equal(r.xml.includes(`  <key>${MIN_OS_KEY}</key>`), false);
});

test("it is idempotent — MUTATION: dropping the early return, which appends a SECOND MinimumOSVersion on a re-run and makes every later read throw", () => {
  const once = injectMinimumOSVersion(ORT_PLIST, "15.0").xml;
  const twice = injectMinimumOSVersion(once, "15.0");
  assert.equal(twice.changed, false);
  assert.equal(twice.xml, once);
  assert.match(twice.reason, /already declares MinimumOSVersion = 15\.0/);
});

test("a framework that declares its OWN different version is reported, never overwritten — MUTATION: writing ours anyway, which silently retargets a vendor's binary and makes the disagreement unobservable", () => {
  const declared = ORT_PLIST.replace(
    "</dict>",
    `\t<key>${MIN_OS_KEY}</key>\n\t<string>13.0</string>\n</dict>`
  );
  const r = injectMinimumOSVersion(declared, "15.0");
  assert.equal(r.changed, false);
  assert.equal(r.version, "13.0");
  assert.equal(minimumOSVersion(r.xml), "13.0");
});

test("an EMPTY existing value is filled in place — MUTATION: treating '' like a declared version, which leaves altool's error 90530 ('is \\'\\'') exactly where it was", () => {
  const empty = ORT_PLIST.replace(
    "</dict>",
    `\t<key>${MIN_OS_KEY}</key>\n\t<string></string>\n</dict>`
  );
  const r = injectMinimumOSVersion(empty, "15.0");
  assert.equal(r.changed, true);
  assert.equal(minimumOSVersion(r.xml), "15.0");
  assert.match(r.reason, /filled the empty/);
  /* Exactly one key, still. */
  assert.equal(r.xml.split(`<key>${MIN_OS_KEY}</key>`).length - 1, 1);
});

test(`it refuses a version below Apple's ${MIN_OS_FLOOR} floor — MUTATION: dropping the floor check, which writes a value that fails the very upload this exists to fix`, () => {
  assert.throws(() => injectMinimumOSVersion(ORT_PLIST, "7.0"), /requires 8\.0 or later/);
  assert.equal(injectMinimumOSVersion(ORT_PLIST, "8.0").changed, true);
});

test("it refuses a value that is not a version at all — MUTATION: accepting any string, so a shell variable that expanded to nothing writes an empty key", () => {
  for (const bad of ["", "latest", "15.0-beta", undefined]) {
    assert.throws(() => injectMinimumOSVersion(ORT_PLIST, bad), /invalid MinimumOSVersion/);
  }
});

test("it re-parses its own output before reporting success — MUTATION: `return version;` at the top of assertMinimumOSVersion", () => {
  /* Every failure mode above degrades to "returned the input unchanged and said
     it worked" without this, which is why it is a named, exported function. */
  assert.throws(() => assertMinimumOSVersion(ORT_PLIST, "15.0"), /the edit did not take/);
  assert.equal(assertMinimumOSVersion(injectMinimumOSVersion(ORT_PLIST, "15.0").xml, "15.0"), "15.0");
});

/* ───────────────────────────── the CI guard itself ───────────────────────── */

test("the unpatched ORT plist is reported as a problem, in the words Apple used", () => {
  /* MUTATION: dropping MIN_OS_KEY from REQUIRED_FRAMEWORK_KEYS — the exact one-line
     weakening that would let build 2026091315 through this gate again. */
  const problems = frameworkProblems(ORT_PLIST, "15.0");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /MinimumOSVersion is missing/);
});

test("the patched plist has no problems — MUTATION: requiring a key ORT does not ship (CFBundleSupportedPlatforms, say), which turns every build red for a key nothing rejected us for", () => {
  const patched = injectMinimumOSVersion(ORT_PLIST, "15.0").xml;
  assert.deepEqual(frameworkProblems(patched, "15.0"), []);
});

test("a missing identity key is named individually — MUTATION: returning after the first problem, so a bundle with three faults costs three CI runs", () => {
  const thin = ORT_PLIST.replace(/\t<key>CFBundleExecutable<\/key>\n\t<string>onnxruntime<\/string>\n/, "")
    .replace(/\t<key>CFBundleVersion<\/key>\n\t<string>1\.20\.0<\/string>\n/, "");
  const problems = frameworkProblems(thin, "15.0");
  assert.equal(problems.length, 3, problems.join(" | "));
  assert.ok(problems.some((p) => p.startsWith("CFBundleExecutable is missing")));
  assert.ok(problems.some((p) => p.startsWith("CFBundleVersion is missing")));
  assert.ok(problems.some((p) => p.startsWith("MinimumOSVersion is missing")));
});

test("an EMPTY key is reported as empty rather than missing — MUTATION: one branch for both, which loses the distinction altool itself blurs and we do not have to", () => {
  const blank = ORT_PLIST.replace("<string>com.microsoft.onnxruntime</string>", "<string> </string>");
  const problems = frameworkProblems(blank, "15.0");
  assert.ok(problems.some((p) => /CFBundleIdentifier is empty/.test(p)), problems.join(" | "));
});

test("a framework that requires a NEWER system than the app is a problem — MUTATION: dropping the appMinOS comparison, which is what would hide a wrong --min-os", () => {
  const tooNew = injectMinimumOSVersion(ORT_PLIST, "16.0").xml;
  const problems = frameworkProblems(tooNew, "15.0");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /above the app's own 15\.0/);
});

test("a framework that supports OLDER systems than the app is fine — MUTATION: asserting equality, which fails every normally-built framework in the bundle", () => {
  const older = injectMinimumOSVersion(ORT_PLIST, "13.0").xml;
  assert.deepEqual(frameworkProblems(older, "15.0"), []);
  assert.deepEqual(frameworkProblems(older, "13.0"), []);
});

test(`a version below ${MIN_OS_FLOOR} is a problem even when the app allows it — MUTATION: checking only against the app, which would pass a 64-bit-only build Apple rejects with 90530`, () => {
  const ancient = ORT_PLIST.replace("</dict>", `\t<key>${MIN_OS_KEY}</key>\n\t<string>7.0</string>\n</dict>`);
  const problems = frameworkProblems(ancient, "7.0");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /requires 8\.0 or later/);
});

test("passing null for the app's version skips ONLY that comparison — MUTATION: skipping every check when it is null", () => {
  assert.deepEqual(frameworkProblems(injectMinimumOSVersion(ORT_PLIST, "16.0").xml, null), []);
  assert.equal(frameworkProblems(ORT_PLIST, null).length, 1);
});

/* ────────────────────────────── finding frameworks ───────────────────────── */

test("iOS slices are patched and other platforms are not — MUTATION: /^ios/, which skips a plain .framework that has no slice directory at all", () => {
  assert.equal(isIosSlice("ios-arm64"), true);
  assert.equal(isIosSlice("ios-arm64_x86_64-simulator"), true);
  assert.equal(isIosSlice("Frameworks"), true);
  for (const other of ["macos-arm64_x86_64", "tvos-arm64", "watchos-arm64_arm64_32", "xros-arm64"]) {
    assert.equal(isIosSlice(other), false, other);
  }
});

test("findFrameworkPlists finds slices, skips a versioned macOS bundle, and does not descend into a framework", () => {
  /* MUTATION: recursing into `.framework` — the macOS bundle's
     Versions/A/Resources/Info.plist is then found as a second hit and gets an
     iOS deployment target written into it. */
  const root = tmpdir();
  const mk = (rel, body) => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  mk("x.xcframework/ios-arm64/onnxruntime.framework/Info.plist", ORT_PLIST);
  mk("x.xcframework/ios-arm64_x86_64-simulator/onnxruntime.framework/Info.plist", ORT_PLIST);
  mk("x.xcframework/macos-arm64_x86_64/onnxruntime.framework/Versions/A/Resources/Info.plist", ORT_PLIST);
  mk("x.xcframework/ios-arm64/onnxruntime.framework/Headers/onnxruntime_c_api.h", "// not a plist");

  const found = findFrameworkPlists(root);
  assert.equal(found.length, 2, found.map((f) => f.plist).join("\n"));
  assert.deepEqual(
    found.map((f) => f.slice),
    ["ios-arm64", "ios-arm64_x86_64-simulator"]
  );
});

/* ───────────────────────────────── runPatch ──────────────────────────────── */

test("runPatch refuses a tree with no iOS frameworks in it — MUTATION: `return []`, which patches nothing, prints nothing, exits 0 and ships the same rejection", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, "checkouts", "capacitor-swift-pm"), { recursive: true });
  assert.throws(() => runPatch(root, "15.0"), /found no iOS framework bundles/);
  assert.throws(() => runPatch(path.join(root, "nope"), "15.0"), /no such directory/);
});

test("runPatch writes the key into every iOS slice and leaves the macOS one alone", () => {
  /* MUTATION: dropping the isIosSlice filter — the macOS framework (whose plist
     sits directly in the bundle in this fixture, as a flat macOS framework can)
     gets an iOS deployment target it has no use for. */
  const root = tmpdir();
  const mk = (rel) => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), ORT_PLIST);
    return path.join(root, rel);
  };
  const iosSlice = mk("artifacts/ort/onnxruntime/onnxruntime.xcframework/ios-arm64/onnxruntime.framework/Info.plist");
  const simSlice = mk("artifacts/ort/onnxruntime/onnxruntime.xcframework/ios-arm64_x86_64-simulator/onnxruntime.framework/Info.plist");
  const macSlice = mk("artifacts/ort/onnxruntime/onnxruntime.xcframework/macos-arm64_x86_64/onnxruntime.framework/Info.plist");

  const lines = runPatch(root, "15.0");
  assert.equal(minimumOSVersion(fs.readFileSync(iosSlice, "utf8")), "15.0");
  assert.equal(minimumOSVersion(fs.readFileSync(simSlice, "utf8")), "15.0");
  assert.equal(minimumOSVersion(fs.readFileSync(macSlice, "utf8")), null);
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => /macos-arm64_x86_64 is not an iOS slice/.test(l)), lines.join("\n"));
});

/* ──────────────────────────────── runVerify ──────────────────────────────── */

/** Build an `App.app` fixture. `read` below is the seam the real CLI fills with
 *  `plutil`; here it is a plain read, because these plists are already XML. */
function appBundle({ appMinOS = "15.0", frameworks = {} }) {
  const root = tmpdir();
  const app = path.join(root, "App.app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "Info.plist"), appPlist(appMinOS));
  for (const [name, body] of Object.entries(frameworks)) {
    const dir = path.join(app, "Frameworks", `${name}.framework`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Info.plist"), body);
  }
  return app;
}
const readXml = (f) => fs.readFileSync(f, "utf8");

test("runVerify FAILS on the bundle build 2026091315 actually produced — the regression test for the whole fix", () => {
  /* MUTATION: any weakening of frameworkProblems; this is the end-to-end shape of
     the failure, asserted on a bundle assembled the way the archive assembles one. */
  const app = appBundle({ frameworks: { onnxruntime: ORT_PLIST } });
  assert.throws(
    () => runVerify(app, readXml),
    /App Store Connect would reject this bundle[\s\S]*onnxruntime\.framework: MinimumOSVersion is missing/
  );
});

test("runVerify PASSES once the slice has been patched — MUTATION: none; the negative test above is worthless without this one", () => {
  const app = appBundle({ frameworks: { onnxruntime: injectMinimumOSVersion(ORT_PLIST, "15.0").xml } });
  const lines = runVerify(app, readXml);
  assert.match(lines[0], /MinimumOSVersion = 15\.0, 1 embedded framework/);
  assert.match(lines[1], /onnxruntime\.framework: ok/);
});

test("runVerify refuses a bundle it finds no frameworks in — MUTATION: `if (!frameworks.length) return lines`, a check that passes when it cannot find its subject", () => {
  const app = appBundle({ frameworks: {} });
  assert.throws(() => runVerify(app, readXml), /embeds no frameworks with an Info\.plist/);
  assert.throws(() => runVerify(path.join(app, "nope"), readXml), /no such bundle/);
});

test("runVerify compares against the APP's own MinimumOSVersion, read out of the bundle — MUTATION: a hardcoded constant, which stops tracking the deployment target the day it moves", () => {
  const fw = injectMinimumOSVersion(ORT_PLIST, "15.0").xml;
  assert.doesNotThrow(() => runVerify(appBundle({ appMinOS: "15.0", frameworks: { a: fw } }), readXml));
  assert.throws(
    () => runVerify(appBundle({ appMinOS: "14.0", frameworks: { a: fw } }), readXml),
    /above the app's own 14\.0/
  );
});

test("runVerify stops if the APP's own MinimumOSVersion is unreadable — MUTATION: defaulting to null, which quietly downgrades every comparison below it to 'skipped'", () => {
  const app = appBundle({ appMinOS: "", frameworks: { a: ORT_PLIST } });
  assert.throws(() => runVerify(app, readXml), /the app's own MinimumOSVersion is ""/);
});

test("runVerify reports EVERY bad framework at once — MUTATION: throwing inside the loop, which hides the second fault behind the first", () => {
  const app = appBundle({ frameworks: { onnxruntime: ORT_PLIST, other: ORT_PLIST } });
  assert.throws(() => runVerify(app, readXml), (e) => {
    assert.match(e.message, /onnxruntime\.framework: MinimumOSVersion is missing/);
    assert.match(e.message, /other\.framework: MinimumOSVersion is missing/);
    return true;
  });
});

test("a framework that already declares its deployment target is left completely alone", () => {
  /* THE FIRST CI RUN OF THIS STEP FOUND THIS, and it is why the patcher is
     selective. The resolved SwiftPM tree holds every binary dependency, not just
     ONNX Runtime: `Capacitor.xcframework` and `Cordova.xcframework` are in there
     too, correctly built, already carrying a deployment target — and stored as
     BINARY plists, which the first draft of this script refused outright and
     failed the whole step on.
     MUTATION: patch every framework found rather than only the ones missing the
     key -> two correctly-built vendored bundles get rewritten to fix a third. */
  const root = tmpdir();
  const mk = (rel, body) => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
    return path.join(root, rel);
  };
  const ort = mk("artifacts/ort/onnxruntime.xcframework/ios-arm64/onnxruntime.framework/Info.plist", ORT_PLIST);
  const cap = mk(
    "artifacts/cap/Capacitor.xcframework/ios-arm64/Capacitor.framework/Info.plist",
    injectMinimumOSVersion(ORT_PLIST, "14.0").xml
  );
  const capBefore = fs.readFileSync(cap, "utf8");

  const lines = runPatch(root, "15.0");
  assert.equal(minimumOSVersion(fs.readFileSync(ort, "utf8")), "15.0");
  assert.equal(fs.readFileSync(cap, "utf8"), capBefore, "a framework that needed nothing was rewritten");
  assert.ok(lines.some((l) => /Capacitor[\s\S]*already declares MinimumOSVersion = 14\.0/.test(l)), lines.join("\n"));
});

test("a BINARY plist is read and written through plutil, never re-encoded here — MUTATION: parsing the bytes as text, which is the exact failure the first CI run hit on Capacitor.xcframework", () => {
  const root = tmpdir();
  const rel = "artifacts/x/B.xcframework/ios-arm64/B.framework/Info.plist";
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  const file = path.join(root, rel);
  /* Not a real binary plist — the magic is all `isBinaryPlist` reads, and the
     point of this test is that the TEXT PARSER never touches these bytes. */
  fs.writeFileSync(file, Buffer.concat([Buffer.from("bplist00"), Buffer.from([0xd1, 0x00, 0xff])]));
  assert.equal(isBinaryPlist(fs.readFileSync(file)), true);

  const reads = [];
  let inserted = null;
  const read = (f) => {
    reads.push(f);
    /* Before the insert: no key. After it: the key. */
    return inserted ? injectMinimumOSVersion(ORT_PLIST, inserted).xml : ORT_PLIST;
  };
  const insert = (f, key, value) => {
    assert.equal(f, file);
    assert.equal(key, MIN_OS_KEY);
    inserted = value;
  };

  const lines = runPatch(root, "15.0", { read, insert });
  assert.equal(inserted, "15.0", "plutil -insert was never called for the binary plist");
  assert.equal(fs.readFileSync(file).length, 11, "the binary plist was rewritten by this script");
  assert.ok(lines.some((l) => /binary plist, via plutil/.test(l)), lines.join("\n"));
  assert.ok(reads.length >= 2, "the delegated edit was never re-read to prove it landed");
});

test("the binary path re-reads and refuses an insert that did not land — MUTATION: trusting plutil's exit code, which is the same 'said it worked' hole assertMinimumOSVersion closes on the XML path", () => {
  const root = tmpdir();
  const rel = "artifacts/x/B.xcframework/ios-arm64/B.framework/Info.plist";
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), Buffer.from("bplist00\x00"));
  assert.throws(
    () => runPatch(root, "15.0", { read: () => ORT_PLIST, insert: () => {} }),
    /the edit did not take[\s\S]*after plutil -insert/
  );
});

test("runPatch validates --min-os before it touches anything — MUTATION: leaving the check to the injector, which the binary path bypasses entirely", () => {
  const root = tmpdir();
  const rel = "artifacts/x/B.xcframework/ios-arm64/B.framework/Info.plist";
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  const file = path.join(root, rel);
  fs.writeFileSync(file, ORT_PLIST);
  for (const bad of ["", "latest", "7.0"]) {
    assert.throws(() => runPatch(root, bad), /invalid MinimumOSVersion/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(fs.readFileSync(file, "utf8"), ORT_PLIST, "a refused run still wrote to the tree");
});
