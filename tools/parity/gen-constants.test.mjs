/* tools/parity/gen-constants.mjs (NE-04, plan §6.7): the Swift engine's
   constants and closed vocabularies are GENERATED from the JS reference, and
   this suite is what makes "generated" mean "cannot drift". It runs on Windows:
   nothing here needs a Swift compiler — the Swift side of the claim (the files
   compile, and both drift tolerances are distinct values) is
   foray-engine-core's EngineConstantsTests, run by CI's ios-kit job.

   Synthetic modules for the error paths are written to a temp directory as
   .mjs (a temp dir has no package.json saying "type": "module"). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT, SOURCES, CONSTANTS_FILE, VOCABULARY_SWIFT_FILE, VOCABULARY_JSON_FILE, VOCABULARY_MODULE,
  JAVA_CONSTANTS_FILE, JAVA_VOCABULARY_FILE,
  generate, staleFiles, main, collect, collectVocabulary, loadSources, describeValue,
  memberName, typeName, caseName, swiftString, swiftNumber, renderConstants, renderVocabularySwift,
  javaString, javaNumber, javaEnumConstant, renderConstantsJava, renderVocabularyJava,
  DuplicateConstantError, UnsupportedConstantError,
} from "./gen-constants.mjs";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "gen-constants-"));
function writeModule(root, rel, src) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), src);
}
const src = (name, value, omit) => ({ module: `${name}.mjs`, namespace: name, omit: omit ?? {}, exports: value });

/** The body of `public enum <ns> {` in a generated file, to its closing brace
    at the same indent. */
function namespaceBlock(swift, ns) {
  const open = swift.indexOf(`    public enum ${ns} {\n`);
  assert.ok(open >= 0, `no namespace ${ns} in the generated file`);
  const close = swift.indexOf("\n    }\n", open);
  return swift.slice(open, close);
}

test("the committed EngineConstants.swift, Vocabulary.swift, vocabulary.json and the two JVM files are exactly what the JS generates", async () => {
  const files = await generate();
  assert.deepEqual(
    Object.keys(files).sort(),
    [CONSTANTS_FILE, VOCABULARY_SWIFT_FILE, VOCABULARY_JSON_FILE, JAVA_CONSTANTS_FILE, JAVA_VOCABULARY_FILE].sort()
  );
  assert.deepEqual(
    staleFiles(REPO_ROOT, files), [],
    "a JS constant or vocabulary token changed and the Swift or JVM side was not regenerated: run `node tools/parity/gen-constants.mjs --write`"
  );
});

test("changing SEAM_GAP_SEC without regenerating turns the check red, and names the constant", async () => {
  // The loaded exports are rewritten, not the file on disk: the working tree
  // is never edited by a test (the same rule record.mjs --mutate keeps).
  const files = await generate({
    transform: (loaded) => loaded.map((s) => (s.namespace === "SeamGap" ? { ...s, exports: { ...s.exports, SEAM_GAP_SEC: 2.5 } } : s)),
  });
  // Both engines' constants go stale together (A-23 added the JVM's).
  assert.deepEqual(staleFiles(REPO_ROOT, files), [CONSTANTS_FILE, JAVA_CONSTANTS_FILE]);
  assert.match(namespaceBlock(files[CONSTANTS_FILE], "SeamGap"), /public static let seamGapSec: Double = 2\.5\n/);
  assert.match(javaNamespaceBlock(files[JAVA_CONSTANTS_FILE], "SeamGap"), /public static final double SEAM_GAP_SEC = 2\.5;\n/);
  const committed = fs.readFileSync(path.join(REPO_ROOT, CONSTANTS_FILE), "utf8");
  assert.match(namespaceBlock(committed, "SeamGap"), /public static let seamGapSec: Double = 0\.5\n/);
});

test("both DRIFT_TOLERANCE_SEC values appear, under distinct namespaces, with their JS values", async () => {
  const committed = fs.readFileSync(path.join(REPO_ROOT, CONSTANTS_FILE), "utf8");
  const seek = await import(pathToFileURL(path.join(REPO_ROOT, "player/seek-policy.js")).href);
  const progress = await import(pathToFileURL(path.join(REPO_ROOT, "player/foray-progress.js")).href);
  assert.notEqual(seek.DRIFT_TOLERANCE_SEC, progress.DRIFT_TOLERANCE_SEC, "the two rules share a name, not a value");
  assert.match(namespaceBlock(committed, "SeekPolicy"), new RegExp(`driftToleranceSec: Double = ${seek.DRIFT_TOLERANCE_SEC}\\n`));
  assert.match(namespaceBlock(committed, "ForayProgress"), new RegExp(`driftToleranceSec: Double = ${progress.DRIFT_TOLERANCE_SEC}\\n`));
  // And the header says why the file is namespaced at all.
  assert.match(committed, /\/\/ {3}DRIFT_TOLERANCE_SEC: ForayProgress, SeekPolicy\n/);
});

test("a duplicate export name is a hard error: two modules in one namespace, or two names that camel-case alike", async () => {
  // The realistic mistake: a new module mapped onto a namespace already in
  // use. seek-policy.js and foray-progress.js both export DRIFT_TOLERANCE_SEC.
  const loaded = await loadSources(REPO_ROOT, [
    { module: "player/seek-policy.js", namespace: "Drift" },
    { module: "player/foray-progress.js", namespace: "Drift" },
  ]);
  assert.throws(() => collect(loaded), (e) => e instanceof DuplicateConstantError
    && /duplicate export name: player\/seek-policy\.js#DRIFT_TOLERANCE_SEC and player\/foray-progress\.js#DRIFT_TOLERANCE_SEC would both be EngineConstants\.Drift\.driftToleranceSec/.test(e.message));
  // Two modules in one namespace are refused even when nothing clashes yet.
  assert.throws(() => collect([src("A", { X_SEC: 1 }), { ...src("A", { Y_SEC: 2 }), module: "b.mjs" }]),
    (e) => e instanceof DuplicateConstantError && /namespace A is claimed by A\.mjs and b\.mjs/.test(e.message));
  // Within one module, FOO_BAR and FOO__BAR are both fooBar.
  assert.throws(() => collect([src("A", { FOO_BAR: 1, FOO__BAR: 2 })]),
    (e) => e instanceof DuplicateConstantError && /FOO_BAR and A\.mjs#FOO__BAR would both be EngineConstants\.A\.fooBar/.test(e.message));
  // Within an object export too.
  assert.throws(() => collect([src("A", { MODE: { A_B: "x", A__B: "y" } })]), DuplicateConstantError);
  // Different namespaces with the same export name are exactly what namespacing is for.
  assert.doesNotThrow(() => collect([src("A", { DRIFT_TOLERANCE_SEC: 30 }), src("B", { DRIFT_TOLERANCE_SEC: 1 })]));
});

test("every constant every source module exports is in the generated file, or omitted with a reason", async () => {
  const committed = fs.readFileSync(path.join(REPO_ROOT, CONSTANTS_FILE), "utf8");
  let emitted = 0;
  for (const s of SOURCES) {
    const mod = await import(pathToFileURL(path.join(REPO_ROOT, s.module)).href);
    const block = namespaceBlock(committed, s.namespace);
    assert.ok(block.startsWith(`    public enum ${s.namespace} {`) && committed.includes(`    /// \`${s.module}\`\n    public enum ${s.namespace} {`),
      `${s.namespace} is not labelled with its module ${s.module}`);
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === "function") continue;
      if (s.omit && name in s.omit) {
        assert.ok(typeof s.omit[name] === "string" && s.omit[name].length > 20, `${s.module}#${name} is omitted without a reason`);
        continue;
      }
      assert.ok(block.includes(`        /// \`${name}\`\n`), `${s.module}#${name} is missing from EngineConstants.${s.namespace}`);
      emitted++;
    }
  }
  // Not a count to maintain: a floor so an empty SOURCES cannot pass vacuously.
  assert.ok(emitted >= 60, `only ${emitted} constants emitted`);
  // The constants the card names, by their Swift spelling.
  for (const needle of [
    "enum Transport {", "restartWindowSec: Double = 4", "seekInsideEndSec: Double = 0.25",
    "positionIntervalMs: Double = 15000", "rates: [Double] = [0.75, 1, 1.25, 1.5, 1.75, 2]",
    "seamGapSec: Double = 0.5", "interludeCeilingSec: Double = 4.5", "jingleDurationSec: Double = 3",
    "adPadCeilingSec: Double = 120", "seekBackwardSec: Double = 15", "seekForwardSec: Double = 30",
  ]) assert.ok(committed.includes(needle), `EngineConstants.swift lacks ${needle}`);
});

test("an export the generator cannot express is refused unless omitted, and a stale omit is refused", () => {
  const bad = {
    "a Symbol": Symbol("x"), "a Set": new Set(["a"]), NaN: NaN, Infinity: Infinity, "a RegExp": /x/,
    "null": null, "a mixed array": [1, "a"], "an empty array": [], "an empty object": {},
    "an object of functions": { MAKE: () => 1 }, "a nested object": { A: { B: 1 } },
  };
  for (const [label, value] of Object.entries(bad)) {
    assert.throws(() => describeValue(value, label), UnsupportedConstantError, label);
  }
  assert.equal(describeValue(() => 1, "fn"), null, "a function is behaviour, skipped");
  assert.equal(describeValue(class X {}, "cls"), null, "a class is behaviour, skipped");
  // The reducer's constructor objects are the real case of an omit.
  assert.throws(() => collect([src("A", { S: Object.freeze({ idle: () => ({}) }) })]), UnsupportedConstantError);
  assert.doesNotThrow(() => collect([src("A", { S: Object.freeze({ idle: () => ({}) }) }, { S: "constructors" })]));
  assert.throws(() => collect([src("A", { X_SEC: 1 }, { GONE: "no longer exported" })]),
    (e) => e instanceof UnsupportedConstantError && /omits GONE, which it no longer exports/.test(e.message));
  assert.throws(() => collect([src("A", { camelCase: 1 })]), UnsupportedConstantError, "only SCREAMING_SNAKE names");
  assert.throws(() => collect([src("A", { default: 1 })]), UnsupportedConstantError, "no default export");
  assert.throws(() => collect([src("lower", { X_SEC: 1 })]), UnsupportedConstantError, "namespace must be UpperCamel");
});

test("Swift literals: numbers round-trip as Doubles, strings escape the Swift way, keywords are backticked", () => {
  assert.equal(swiftNumber(2, "x"), "2");
  assert.equal(swiftNumber(0.25, "x"), "0.25");
  assert.equal(swiftNumber(0.1 + 0.2, "x"), "0.30000000000000004", "the shortest round-trip form, never rounded");
  assert.equal(swiftNumber(1e21, "x"), "1e21");
  assert.equal(swiftNumber(-0, "x"), "-0.0");
  assert.equal(swiftNumber(-1.5, "x"), "-1.5");
  assert.throws(() => swiftNumber(NaN, "x"), UnsupportedConstantError);
  assert.equal(swiftString('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(swiftString("line\nnext\ttab\rret"), '"line\\nnext\\ttab\\rret"');
  assert.equal(swiftString("\b\f\u0001\u007f"), '"\\u{8}\\u{C}\\u{1}\\u{7F}"', "JSON's \\b, \\f and \\uXXXX are not Swift escapes");
  assert.equal(swiftString("\\(interp)"), '"\\\\(interp)"', "a backslash-paren never becomes Swift interpolation");
  assert.equal(swiftString("Foray · clip 1 — 4a"), '"Foray · clip 1 — 4a"');
  assert.equal(memberName("SEAM_GAP_SEC"), "seamGapSec");
  assert.equal(memberName("KEY"), "key");
  assert.equal(memberName("MAX_AGE_H"), "maxAgeH");
  assert.equal(typeName("REMOTE_STOP"), "RemoteStop");
  const swift = renderConstants(collect([src("K", { DEFAULT: "d", CASE: 1, MODE: { SWITCH: "s", PLAIN: "p" } })]));
  assert.match(swift, /public static let `case`: Double = 1\n/);
  assert.match(swift, /public static let `default`: String = "d"\n/);
  assert.match(swift, /public enum Mode \{\n {12}\/\/\/ `MODE\.SWITCH`\n {12}public static let `switch`: String = "s"\n/);
  assert.throws(() => renderConstants(collect([src("K", { SELF: 1 })])), UnsupportedConstantError, "self cannot be escaped");
});

test("vocabulary tokens: closed shape, no two tokens that are one Swift case, keywords backticked", async () => {
  for (const ok of ["grace-expired", "appWasSuspended", "ready", "media-services-reset", "not-built"]) {
    assert.doesNotThrow(() => caseName(ok), ok);
  }
  for (const bad of ["Grace-expired", "grace_expired", "the car", "-x", "x-", "x--y", "", "https://x", 1, null]) {
    assert.throws(() => caseName(bad), UnsupportedConstantError, JSON.stringify(bad));
  }
  assert.equal(caseName("media-services-reset"), "mediaServicesReset");
  assert.throws(() => collectVocabulary({ VOCABULARY: { stopCause: ["grace-expired", "graceExpired"] } }),
    (e) => e instanceof DuplicateConstantError && /one Swift case \(graceExpired\)/.test(e.message));
  assert.throws(() => collectVocabulary({ VOCABULARY: { StopCause: ["x"] } }), UnsupportedConstantError, "set names are lowerCamel");
  assert.throws(() => collectVocabulary({ VOCABULARY: { stopCause: [] } }), UnsupportedConstantError, "no empty set");
  assert.throws(() => collectVocabulary({}), UnsupportedConstantError, "a module with no VOCABULARY");

  const vocab = await import(pathToFileURL(path.join(REPO_ROOT, VOCABULARY_MODULE)).href);
  const swift = renderVocabularySwift(collectVocabulary(vocab));
  assert.match(swift, /case `default` = "default"\n/, "Apple's .default is a Swift keyword");
  assert.match(swift, /case `override` = "override"\n/);
  assert.match(swift, /case graceExpired = "grace-expired"\n/);
  // Every token of every set is a case of that set's enum.
  for (const [set, tokens] of Object.entries(vocab.VOCABULARY)) {
    const type = set[0].toUpperCase() + set.slice(1);
    const at = swift.indexOf(`    public enum ${type}: String, CaseIterable, Sendable {\n`);
    assert.ok(at >= 0, `no enum ${type}`);
    const body = swift.slice(at, swift.indexOf("\n    }\n", at));
    assert.equal((body.match(/\n {8}case /g) ?? []).length, tokens.length, `${type} has one case per token`);
  }
  const json = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, VOCABULARY_JSON_FILE), "utf8"));
  assert.deepEqual(json.sets, JSON.parse(JSON.stringify(vocab.VOCABULARY)));
});

/* ---------- the JVM half (A-23, docs/plans/android-assessment.md §5.4) ---------- */

/** The body of `public static final class <ns> {` in a generated Java file, to its closing brace at the same indent. */
function javaNamespaceBlock(java, ns) {
  const open = java.indexOf(`    public static final class ${ns} {\n`);
  assert.ok(open >= 0, `no class ${ns} in the generated Java file`);
  return java.slice(open, java.indexOf("\n    }\n", open));
}

test("A-23: every constant is in EngineConstants.java under its module's class, by its JS name, with the JS value", async () => {
  /* The Android engine's JVM core ports the same policies, so it must read the same
     numbers: a JVM port holding its own 2.0 is the silent fork NE-04 exists to
     prevent. Java keeps the JS names (already Java's constant spelling, never a
     keyword). MUTATION: skip a member in renderConstantsJava, or print 15 as an int
     literal -> fails. */
  const committed = fs.readFileSync(path.join(REPO_ROOT, JAVA_CONSTANTS_FILE), "utf8");
  assert.match(committed, /^\/\/ GENERATED FILE - DO NOT EDIT\.\n/);
  assert.match(committed, /\npackage ai\.jwlabs\.foura\.engine;\n/);
  assert.ok(!committed.includes("List.of("), "main code keeps to the API 24 library surface: no List.of");
  let emitted = 0;
  for (const s of SOURCES) {
    const mod = await import(pathToFileURL(path.join(REPO_ROOT, s.module)).href);
    assert.ok(committed.includes(`    /** {@code ${s.module}} */\n    public static final class ${s.namespace} {`),
      `${s.namespace} is not labelled with its module ${s.module}`);
    const block = javaNamespaceBlock(committed, s.namespace);
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === "function" || (s.omit && name in s.omit)) continue;
      assert.ok(block.includes(`        /** {@code ${name}} */\n`), `${s.module}#${name} is missing from EngineConstants.${s.namespace} (Java)`);
      emitted++;
    }
  }
  assert.ok(emitted >= 60, `only ${emitted} constants emitted`);
  for (const needle of [
    "public static final double RESTART_WINDOW_SEC = 4.0;", "public static final double SEEK_INSIDE_END_SEC = 0.25;",
    "public static final double POSITION_INTERVAL_MS = 15000.0;",
    "public static final List<Double> RATES = Collections.unmodifiableList(Arrays.asList(0.75, 1.0, 1.25, 1.5, 1.75, 2.0));",
    "public static final double SEEK_BACKWARD_SEC = 15.0;", "public static final double SEEK_FORWARD_SEC = 30.0;",
    'public static final String PLAY_RESTORED = "play-restored";',
    'public static final List<String> OWNED_PREFIXES = Collections.unmodifiableList(Arrays.asList("cp_pos:", "cp_foray:", "cp_last_episode"));',
  ]) assert.ok(committed.includes(needle), `EngineConstants.java lacks ${needle}`);
});

test("A-23: Java literals are double literals and octal-escaped strings, and every vocabulary token is an enum constant carrying it", async () => {
  assert.equal(javaNumber(2, "x"), "2.0", "a bare integer would be an int (an Integer inside Arrays.asList)");
  assert.equal(javaNumber(0.25, "x"), "0.25");
  assert.equal(javaNumber(1e21, "x"), "1e21");
  assert.equal(javaNumber(-0, "x"), "-0.0");
  assert.equal(javaNumber(0.1 + 0.2, "x"), "0.30000000000000004");
  assert.throws(() => javaNumber(Infinity, "x"), UnsupportedConstantError);
  assert.equal(javaString('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(javaString("line\nnext\ttab\rret"), '"line\\nnext\\ttab\\rret"');
  // javac reads a unicode escape BEFORE it lexes a literal, so a control character is
  // octal and a backslash-u in the JS text is a doubled backslash, never an escape.
  assert.equal(javaString("\b\f\u0001\u007f"), '"\\010\\014\\001\\177"');
  assert.equal(javaString("\\u000a"), '"\\\\u000a"');
  assert.equal(javaString("Foray · clip 1 — 4a 🎧"), '"Foray · clip 1 — 4a 🎧"');
  assert.throws(() => javaString("x\ud800"), UnsupportedConstantError, "a lone surrogate has no UTF-8 spelling");
  assert.equal(javaEnumConstant("grace-expired"), "GRACE_EXPIRED");
  assert.equal(javaEnumConstant("appWasSuspended"), "APP_WAS_SUSPENDED");
  assert.equal(javaEnumConstant("default"), "DEFAULT");
  const java = renderConstantsJava(collect([src("K", { CASE: 1, MODE: { SWITCH: "s" }, NAMES: ["a", "b"] })]));
  assert.match(java, /public static final double CASE = 1\.0;\n/);
  assert.match(java, /public static final class Mode \{\n {12}private Mode\(\) \{\}\n\n {12}\/\*\* \{@code MODE\.SWITCH\} \*\/\n {12}public static final String SWITCH = "s";\n/);
  assert.match(java, /public static final List<String> NAMES = Collections\.unmodifiableList\(Arrays\.asList\("a", "b"\)\);\n/);
  assert.throws(() => renderConstantsJava(collect([src("Mode", { MODE: { A: "a" } })])), DuplicateConstantError,
    "a nested class named like its enclosing class does not compile");

  const vocab = await import(pathToFileURL(path.join(REPO_ROOT, VOCABULARY_MODULE)).href);
  const committed = fs.readFileSync(path.join(REPO_ROOT, JAVA_VOCABULARY_FILE), "utf8");
  assert.equal(committed, renderVocabularyJava(collectVocabulary(vocab)));
  for (const [set, tokens] of Object.entries(vocab.VOCABULARY)) {
    const type = set[0].toUpperCase() + set.slice(1);
    const at = committed.indexOf(`    public enum ${type} {\n`);
    assert.ok(at >= 0, `no enum ${type}`);
    const body = committed.slice(at, committed.indexOf("\n    }\n", at));
    for (const token of tokens) {
      assert.ok(body.includes(`        ${javaEnumConstant(token)}(${JSON.stringify(token)})`), `${type} lacks ${token}`);
    }
  }
});

test("the CLI: --check is red on a stale tree and names the file, --write fixes it, and bad usage exits 2", async () => {
  const root = tmpRoot();
  try {
    writeModule(root, "m/seam.mjs", "export const SEAM_GAP_SEC = 2.0;\nexport function f() {}\n");
    writeModule(root, "m/vocab.mjs", 'export const VOCABULARY = Object.freeze({ stopCause: ["grace-expired"] });\n');
    const opts = { root, sources: [{ module: "m/seam.mjs", namespace: "SeamGap" }], vocabularyModule: "m/vocab.mjs", log: () => {} };
    const errs = [];
    const err = (m) => errs.push(m);
    assert.equal(await main(["--check"], { ...opts, err }), 1, "nothing generated yet");
    assert.equal(await main(["--write"], opts), 0);
    assert.equal(await main(["--check"], { ...opts, err }), 0);
    const swift = fs.readFileSync(path.join(root, CONSTANTS_FILE), "utf8");
    assert.match(swift, /^\/\/ GENERATED FILE - DO NOT EDIT\.\n/);
    assert.match(swift, /public static let seamGapSec: Double = 2\n/);
    assert.ok(!swift.includes("\r"), "LF only");
    assert.ok(fs.existsSync(path.join(root, VOCABULARY_SWIFT_FILE)) && fs.existsSync(path.join(root, VOCABULARY_JSON_FILE)));
    const java = fs.readFileSync(path.join(root, JAVA_CONSTANTS_FILE), "utf8");
    assert.match(java, /public static final double SEAM_GAP_SEC = 2\.0;\n/);
    assert.ok(!java.includes("\r") && fs.existsSync(path.join(root, JAVA_VOCABULARY_FILE)), "the JVM files too, LF only");

    // The acceptance's own mutation, on a real (temp) file this time: the JS
    // changes, nobody regenerates, --check goes red.
    writeModule(root, "m/seam.mjs", "export const SEAM_GAP_SEC = 2.5;\n");
    errs.length = 0;
    assert.equal(await main(["--check"], { ...opts, err }), 1);
    assert.match(errs.join("\n"), /stale, regenerate with `node tools\/parity\/gen-constants\.mjs --write`/);
    assert.match(errs.join("\n"), /EngineConstants\.swift/);
    assert.match(errs.join("\n"), /EngineConstants\.java/, "the JVM file goes stale with the Swift one");
    assert.equal(await main(["--write"], opts), 0);
    assert.equal(await main(["--check"], { ...opts, err }), 0);

    // A duplicate is refused by the CLI, not written.
    writeModule(root, "m/seam.mjs", "export const SEAM_GAP_SEC = 2.0;\nexport const SEAM__GAP_SEC = 3;\n");
    errs.length = 0;
    assert.equal(await main(["--write"], { ...opts, err }), 1);
    assert.match(errs.join("\n"), /duplicate export name/);
    assert.match(fs.readFileSync(path.join(root, CONSTANTS_FILE), "utf8"), /seamGapSec: Double = 2\.5\n/, "nothing was written");

    assert.equal(await main([], { ...opts, err }), 2);
    assert.equal(await main(["--write", "--check"], { ...opts, err }), 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
