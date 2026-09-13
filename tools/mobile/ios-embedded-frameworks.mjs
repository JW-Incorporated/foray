#!/usr/bin/env node
/* The Info.plist keys App Store Connect requires of every EMBEDDED framework —
 * written into a prebuilt dependency that ships without them, and then asserted
 * on the bundle that is actually about to be uploaded.
 *
 * ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────
 * Release run 34739630705 (build 2026091315, the first build carrying the
 * bundled Kokoro voice) compiled, linked, passed `swift test`, ARCHIVED and
 * EXPORTED. It died in `xcrun altool --upload-app`, with two errors:
 *
 *   Missing Info.plist value. A value for the key 'MinimumOSVersion' in bundle
 *   App.app/Frameworks/onnxruntime.framework is required. (90360)
 *
 *   Invalid MinimumOSVersion. Apps that only support 64-bit devices must specify
 *   a deployment target of 8.0 or later. MinimumOSVersion in
 *   'App.app/Frameworks/onnxruntime.framework' is ''. (90530)
 *
 * The second error is the first one restated — altool reads an ABSENT key as
 * `''` — so there is one defect, not two, and it is upstream's.
 *
 * ── WHICH ARTEFACT ACTUALLY LACKS THE KEY ───────────────────────────────────
 * Not the embed. The slice AS DOWNLOADED. `pod-archive-onnxruntime-c-1.20.0.zip`
 * (sha256 50891a8a…, the exact bytes the `exact: "1.20.0"` pin in
 * `mobile/plugins/foray-tts/Package.swift` resolves to) carries, at
 * `onnxruntime.xcframework/ios-arm64/onnxruntime.framework/Info.plist`, a
 * 613-byte plist with eight keys and no `MinimumOSVersion`:
 *
 *   CFBundleExecutable, CFBundleName, CFBundleIdentifier, CFBundleVersion,
 *   CFBundleShortVersionString, CFBundleSignature, CFBundlePackageType
 *
 * Xcode copies that file into `App.app/Frameworks/` verbatim, so every app that
 * embeds this xcframework has to patch it. Microsoft ships the same plist in the
 * simulator slice. Nothing in our build removed the key; there was never one.
 *
 * ── WHY THE FRAMEWORK IS EMBEDDED AT ALL, WHICH IS THE REAL CURE ────────────
 * `onnxruntime.framework/onnxruntime` is a Mach-O universal wrapper around a
 * STATIC ar archive, and the SPM product is declared `type: .static`. Its code is
 * already linked into `App.app/App`; the copy under `Frameworks/` is 34 MB of
 * dead weight that Xcode embeds anyway for SwiftPM binary targets. Deleting it
 * instead of patching it would be the better fix on every axis — size included —
 * and it is NOT what this file does, because removing a directory from an
 * already-signed `.app` breaks the bundle seal and neither of those things can be
 * tried from the Windows machine this repo is developed on. Revisit it with a Mac
 * in hand; until then this is a WORKAROUND on a binary dependency's metadata and
 * should be read as one.
 *
 * WHAT WOULD REMOVE THIS FILE, in the order it is likely to happen:
 *   1. ONNX Runtime ships a slice whose Info.plist has `MinimumOSVersion`.
 *      Then `patch` reports "already declares …" on every slice and changes
 *      nothing, and only `verify` is still earning its place.
 *   2. The embed is dropped (see above), and there is no framework to patch.
 * Neither is something to assume: `verify` stays either way, because the thing
 * that actually hurt was not the missing key — it was finding out at `altool`.
 *
 * ── WHY NOT DECLARE THE DEPENDENCY DIFFERENTLY ──────────────────────────────
 * There is no spelling of `.package(…)` that fixes this. SPM resolves a
 * `binaryTarget` to a checksummed zip and unpacks it; the plist inside is
 * whatever Microsoft built, and neither `platforms:` in our Package.swift nor
 * `IPHONEOS_DEPLOYMENT_TARGET` in the app reaches it. The alternative to patching
 * is vendoring a rebuilt xcframework, which trades a metadata edit for owning an
 * 82 MB binary — strictly worse, and it would retire the sha256 pin #675 exists
 * to hold.
 *
 * ── WHERE THIS RUNS ─────────────────────────────────────────────────────────
 * `patch` runs against the RESOLVED SwiftPM artifact directory, before any
 * xcodebuild compiles anything, on every path that produces an `App.app`:
 * `.github/workflows/ios-build.yml` (PR-time, unsigned) and
 * `.github/actions/ios-archive` (the release composite that makes the founder's
 * TestFlight artifact). Patching the SOURCE rather than the built bundle is the
 * whole reason this is safe: at that moment nothing is signed, so Xcode embeds an
 * already-correct plist and signs it itself. Patching after the archive would
 * break the framework's seal and the app's with it, and hope `-exportArchive`
 * re-signs.
 *
 * THE RELEASE PATH IS A THIRD BUILD PATH, and that is exactly how this shipped:
 * #675 verified `ios-kit` and `ios-shell` and neither of them archives or
 * uploads. A step that only runs on those two would have let this same build fail
 * at `altool` again.
 *
 * `verify` runs after the build, on the `App.app` that is about to be exported,
 * and is the half that makes the failure impossible to ship again: the next
 * embedded binary with a thin plist goes red in CI instead of at Apple.
 *
 * ── macOS ONLY, FOR THE CLI; THE LOGIC IS NOT ───────────────────────────────
 * A BUILT `Info.plist` is a BINARY plist — Xcode converts the app's own, and a
 * vendored one may already be. So the CLI reads every plist through
 * `plutil -convert xml1`, which means the CLI needs a Mac, which is where both
 * call sites already are. Everything below `readPlistXml()` is pure text in and
 * text out, has no opinion about where the text came from, and is tested on the
 * real 613-byte ORT plist from a machine with no Xcode on it.
 *
 * USAGE
 *   node tools/mobile/ios-embedded-frameworks.mjs patch <spm-dir> --min-os 15.0
 *   node tools/mobile/ios-embedded-frameworks.mjs verify <path/to/App.app>
 * Any other argument is an error, not an ignored flag (same rule as
 * inject-background-audio.mjs beside it).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rootEntries, rootIndent, PlistError } from "./inject-background-audio.mjs";

/** The key Apple rejected the build for. Named so the reason travels with it. */
export const MIN_OS_KEY = "MinimumOSVersion";

/** Apple's own floor, quoted from error 90530: "Apps that only support 64-bit
 *  devices must specify a deployment target of 8.0 or later." */
export const MIN_OS_FLOOR = "8.0";

/**
 * The keys `verify` insists every embedded framework declares.
 *
 * BE HONEST ABOUT THE EVIDENCE FOR EACH. `MinimumOSVersion` is the one this repo
 * has a rejection slip for (90360/90530, quoted in the header). The other four
 * are the identity keys `altool` reads out of a framework bundle, and ONNX
 * Runtime's plist already carries all four — so asserting them costs nothing
 * today and is the difference between "the next thin plist fails in CI" and "the
 * next thin plist fails at Apple, but only if it is thin in the one way we have
 * already been burned by". They are NOT guesses about keys Apple might want:
 * anything beyond these five stays out until something rejects a build for it.
 */
export const REQUIRED_FRAMEWORK_KEYS = [
  "CFBundleIdentifier",
  "CFBundleExecutable",
  "CFBundleVersion",
  "CFBundleShortVersionString",
  MIN_OS_KEY,
];

/* ------------------------------------------------------------ reading values */

/**
 * The root dict's ONE entry for `key`, as `{ tag, text }`, or null if absent.
 *
 * `tag` is the value element's own tag name (`string`, `true`, `array`, …) and
 * `text` is its raw inner text, untrimmed — the caller decides what is
 * acceptable, because "absent", "present but not a string" and "present but
 * empty" are three different defects and collapsing them into null would make
 * the third one report as the first.
 *
 * DUPLICATE KEYS THROW, for the reason `inject-background-audio.mjs` records
 * against the same hazard: plist readers take the LAST of a repeated root key,
 * so an edit to any other one is invisible while every check agrees it landed.
 */
export function rootValue(xml, key) {
  const { entries } = rootEntries(xml);
  const hits = entries.filter((e) => e.key === key);
  if (hits.length > 1) {
    throw new PlistError(
      `the root dict declares ${key} ${hits.length} times. Plist readers take the last one, ` +
        `so an edit to any other is invisible. Delete the duplicates by hand first.`
    );
  }
  if (!hits.length) return null;
  const v = hits[0].value;
  return { tag: v.name, text: v.empty ? "" : xml.slice(v.openEnd, v.closeStart) };
}

/** The root dict's `MinimumOSVersion` as a string, or null when the key is
 *  absent. An empty or whitespace-only `<string>` reads as `""`, NOT as null:
 *  that is the state altool reported, and it needs to be distinguishable. */
export function minimumOSVersion(xml) {
  const v = rootValue(xml, MIN_OS_KEY);
  if (!v) return null;
  if (v.tag !== "string") {
    throw new PlistError(
      `${MIN_OS_KEY} is a <${v.tag}>, but Apple requires a <string>. Fix the plist by hand — ` +
        `this script will not rewrite a value it did not write.`
    );
  }
  return v.text.trim();
}

/* --------------------------------------------------------------- versions */

/** `"15.0"` -> `[15, 0]`, and anything that is not a dotted run of digits ->
 *  null. STRICT: `"15.0b"`, `"v15"`, `""` and `"15..0"` are all null, because a
 *  version Apple cannot parse is the failure being fixed, and a lenient parse
 *  here would write one back into the plist and call it done. */
export function parseVersion(raw) {
  if (typeof raw !== "string") return null;
  if (!/^\d+(\.\d+)*$/.test(raw)) return null;
  return raw.split(".").map(Number);
}

/** -1 / 0 / 1, comparing component by component with a missing component read
 *  as 0, so `"15"` and `"15.0"` compare equal. Throws on anything
 *  `parseVersion` refuses. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x) throw new PlistError(`not a version: ${JSON.stringify(a)}`);
  if (!y) throw new PlistError(`not a version: ${JSON.stringify(b)}`);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/* -------------------------------------------------------------- injection */

/**
 * Assert that `xml` really declares `version`, and throw if it does not.
 *
 * A NAMED FUNCTION rather than an inline `if` at the end of the injector, for
 * the reason `assertModePresent` is one: an inline final check is a line an
 * adversarial edit can delete with every test still green, and without it every
 * failure mode below degrades to "returned the input unchanged and said it
 * worked".
 *
 * MUTATION: `return version;` at the top — the "re-parses its own output" test
 * in `ios-embedded-frameworks.test.mjs` fails.
 */
export function assertMinimumOSVersion(xml, version) {
  const got = minimumOSVersion(xml);
  if (got !== version) {
    throw new PlistError(
      `the edit did not take: ${MIN_OS_KEY} reads ${JSON.stringify(got)} after injection, ` +
        `not ${JSON.stringify(version)}. This is a bug in ios-embedded-frameworks.mjs, ` +
        `not in the plist.`
    );
  }
  return got;
}

/**
 * Add `MinimumOSVersion` to a framework Info.plist's root dict.
 *
 * IDEMPOTENT, and non-destructive in the one direction that matters: a plist
 * that ALREADY declares a non-empty version is left exactly as it is and
 * reported, never overwritten. A framework's deployment floor is a statement its
 * publisher made about their binary; if it disagrees with ours, `verify` is the
 * thing that should say so — loudly, on the real bundle — not a silent rewrite
 * here that makes the disagreement unobservable.
 *
 * An EMPTY value (`<string></string>` or `<string/>`) is replaced, because it is
 * not a statement, it is the defect.
 *
 * @returns {{xml: string, changed: boolean, reason: string, version: string}}
 */
export function injectMinimumOSVersion(xml, version) {
  if (typeof xml !== "string" || xml.trim() === "") {
    throw new PlistError("empty plist source");
  }
  if (!parseVersion(version)) {
    throw new PlistError(
      `invalid ${MIN_OS_KEY} ${JSON.stringify(version)} — expected a dotted version like "15.0".`
    );
  }
  if (compareVersions(version, MIN_OS_FLOOR) < 0) {
    throw new PlistError(
      `refusing to write ${MIN_OS_KEY} = ${version}: Apple's error 90530 requires ${MIN_OS_FLOOR} ` +
        `or later, so this value would fail the upload it is meant to fix.`
    );
  }

  const existing = minimumOSVersion(xml);
  if (existing !== null && existing !== "") {
    return {
      xml,
      changed: false,
      reason: `already declares ${MIN_OS_KEY} = ${existing}`,
      version: existing,
    };
  }

  const { rootDict, entries } = rootEntries(xml);
  const indent = rootIndent(xml, entries);
  let out;
  if (existing === "") {
    /* The key is there with nothing in it. Replace the VALUE element in place so
       the rest of the file stays byte-identical. */
    const hit = entries.find((e) => e.key === MIN_OS_KEY);
    out = xml.slice(0, hit.value.start) + `<string>${version}</string>` + xml.slice(hit.value.end);
  } else {
    const block = `${indent}<key>${MIN_OS_KEY}</key>\n${indent}<string>${version}</string>\n`;
    /* Insert immediately before `</dict>`, after backing over the indentation on
       that line so the closing tag keeps its own position. */
    let at = rootDict.closeStart;
    while (at > 0 && (xml[at - 1] === " " || xml[at - 1] === "\t")) at--;
    out = xml.slice(0, at) + block + xml.slice(at);
  }

  assertMinimumOSVersion(out, version);
  return {
    xml: out,
    changed: true,
    reason: existing === "" ? `filled the empty ${MIN_OS_KEY}` : `added ${MIN_OS_KEY} = ${version}`,
    version,
  };
}

/* ------------------------------------------------------------ verification */

/**
 * Everything wrong with one embedded framework's Info.plist, as a list of
 * sentences. Empty means it would survive `altool`.
 *
 * `appMinOS` is the APP's own `MinimumOSVersion`. A framework may declare a
 * LOWER floor than the app — that is normal and common — but never a higher one:
 * an app that claims to run on iOS 15 while a framework inside it requires 16 is
 * a build Apple rejects, and it is also the exact shape a wrong `--min-os` would
 * produce, so this is the assertion that catches the patcher being handed the
 * wrong number. Pass null to skip only that one comparison.
 *
 * RETURNS PROBLEMS RATHER THAN THROWING because a bundle with three bad
 * frameworks should print three lines, not the first one.
 */
export function frameworkProblems(xml, appMinOS = null) {
  const problems = [];
  for (const key of REQUIRED_FRAMEWORK_KEYS) {
    let v;
    try {
      v = rootValue(xml, key);
    } catch (e) {
      problems.push(`${key}: ${e.message}`);
      continue;
    }
    if (!v) {
      problems.push(`${key} is missing — App Store Connect requires it of an embedded framework.`);
      continue;
    }
    if (v.tag !== "string") {
      problems.push(`${key} is a <${v.tag}>, not a <string>.`);
      continue;
    }
    if (v.text.trim() === "") {
      problems.push(`${key} is empty, which altool reports exactly as a missing key.`);
    }
  }
  if (problems.length) return problems;

  const min = minimumOSVersion(xml);
  if (!parseVersion(min)) {
    problems.push(`${MIN_OS_KEY} is ${JSON.stringify(min)}, which is not a dotted version.`);
    return problems;
  }
  if (compareVersions(min, MIN_OS_FLOOR) < 0) {
    problems.push(
      `${MIN_OS_KEY} is ${min}; Apple's error 90530 requires ${MIN_OS_FLOOR} or later.`
    );
  }
  if (appMinOS !== null && compareVersions(min, appMinOS) > 0) {
    problems.push(
      `${MIN_OS_KEY} is ${min}, above the app's own ${appMinOS}. A framework may support older ` +
        `systems than the app that embeds it, never newer ones.`
    );
  }
  return problems;
}

/* ------------------------------------------------------------- finding them */

/** Every `<name>.framework` directory under `root` that holds an `Info.plist`
 *  DIRECTLY (so a versioned macOS bundle, whose plist lives at
 *  `Versions/A/Resources/Info.plist`, is not one). Sorted, so output is stable
 *  and a diff of two runs means something. */
export function findFrameworkPlists(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name.endsWith(".framework")) {
        const plist = path.join(full, "Info.plist");
        if (fs.existsSync(plist)) out.push({ framework: full, plist, slice: path.basename(dir) });
        /* Do not descend: a framework's own Headers/Modules never hold another
           framework, and descending would find the macOS versioned copy twice. */
        continue;
      }
      walk(full);
    }
  };
  walk(root);
  return out.sort((a, b) => (a.plist < b.plist ? -1 : a.plist > b.plist ? 1 : 0));
}

/** True when an xcframework slice directory targets iOS.
 *
 *  WHY FILTER AT ALL: the same xcframework carries a `macos-arm64_x86_64` slice,
 *  and `MinimumOSVersion` is meaningless there (macOS uses
 *  `LSMinimumSystemVersion`). Writing an iOS deployment target into a macOS
 *  bundle would be noise that a later reader has to disprove. A framework that is
 *  not inside an `.xcframework` has no slice to judge and is accepted. */
export function isIosSlice(sliceName) {
  return !/^(macos|maccatalyst|tvos|watchos|xros|visionos)($|-)/.test(sliceName);
}

/* --------------------------------------------------------------- plist I/O */

/** Read a plist as XML text, whatever format it is stored in.
 *
 *  `plutil` IS APPLE'S OWN PARSER and the only thing here that needs a Mac: a
 *  BUILT `Info.plist` is a binary plist, so `verify` cannot read the bundle it
 *  exists to check without it. The error says so rather than letting a parse
 *  failure read as a malformed plist. */
export function readPlistXml(file) {
  try {
    return execFileSync("plutil", ["-convert", "xml1", "-o", "-", file], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    if (e && e.code === "ENOENT") {
      throw new PlistError(
        `plutil is not on this machine, so ${file} cannot be read. This subcommand needs macOS; ` +
          `the plist logic it wraps is pure text and is tested in ios-embedded-frameworks.test.mjs.`
      );
    }
    throw new PlistError(`plutil could not read ${file}: ${e.message}`);
  }
}

/** Read a plist that is about to be EDITED, as its own bytes.
 *
 *  Not via `plutil` — `patch` rewrites the file, and round-tripping it through a
 *  converter would reformat every line of a vendored file we have no business
 *  reformatting, turning a one-key diff into a whole-file one. A binary plist is
 *  refused rather than silently converted, because converting one is a change of
 *  format, not of value, and nobody asked for it. */
export function readPlistSource(file) {
  const buf = fs.readFileSync(file);
  if (buf.slice(0, 8).toString("latin1") === "bplist00") {
    throw new PlistError(
      `${file} is a BINARY plist. This script edits XML plists in place and will not rewrite one ` +
        `in a different format. Convert it deliberately (plutil -convert xml1) if that is what you mean.`
    );
  }
  return buf.toString("utf8");
}

/* --------------------------------------------------------------------- main */

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

const USAGE =
  "Usage: node tools/mobile/ios-embedded-frameworks.mjs patch <spm-dir> --min-os <X.Y>\n" +
  "       node tools/mobile/ios-embedded-frameworks.mjs verify <path/to/App.app>";

/** `patch`: write `minOS` into every iOS framework slice under `root` that has
 *  no version of its own.
 *
 *  REFUSES A ROOT WITH NO FRAMEWORKS IN IT, and that refusal is the point. The
 *  directory this is pointed at is a RESOLVED SwiftPM artifact tree whose exact
 *  layout is Xcode's business, not ours; if a future Xcode puts it somewhere
 *  else, the honest outcome is a red step saying "nothing to patch", not a green
 *  one that patched nothing and let the build sail on to altool. */
export function runPatch(root, minOS) {
  if (!fs.existsSync(root)) throw new PlistError(`no such directory: ${root}`);
  const found = findFrameworkPlists(root);
  const ios = found.filter((f) => isIosSlice(f.slice));
  if (!ios.length) {
    throw new PlistError(
      `found no iOS framework bundles under ${root} (${found.length} framework(s) in total). ` +
        `That directory is meant to be a RESOLVED SwiftPM artifact tree — if package resolution ` +
        `has not run, or Xcode now puts artifacts elsewhere, patching nothing and reporting ` +
        `success would put the same MinimumOSVersion rejection back on the next TestFlight upload.`
    );
  }
  const lines = [];
  for (const f of ios) {
    const src = readPlistSource(f.plist);
    const r = injectMinimumOSVersion(src, minOS);
    if (r.changed) fs.writeFileSync(f.plist, r.xml);
    lines.push(`${f.plist}: ${r.reason}`);
  }
  for (const f of found.filter((x) => !isIosSlice(x.slice))) {
    lines.push(`${f.plist}: skipped, ${f.slice} is not an iOS slice`);
  }
  return lines;
}

/** `verify`: assert every framework embedded in `appDir` carries the keys App
 *  Store Connect requires.
 *
 *  REFUSES A BUNDLE WITH NO EMBEDDED FRAMEWORKS, same reasoning as above: this
 *  app has embedded `onnxruntime.framework` since #675, so "found none" means the
 *  path is wrong, and a check that passes when it cannot find its subject is not
 *  a check. The day the embed is deliberately dropped, this line is the one to
 *  edit, in a diff that says why.
 *
 *  `read` IS A SEAM, not a convenience: the default reads through `plutil`, which
 *  exists only on a Mac, and a guard nobody can test from this repo's own
 *  development machine is a guard that rots. The suite passes a plain
 *  `fs.readFileSync` over a fixture bundle of XML plists, so everything this
 *  function DECIDES is covered where the code is written; what stays untested
 *  here, and is stated rather than hidden, is the binary-plist read itself. */
export function runVerify(appDir, read = readPlistXml) {
  if (!fs.existsSync(appDir)) throw new PlistError(`no such bundle: ${appDir}`);
  const appPlist = path.join(appDir, "Info.plist");
  if (!fs.existsSync(appPlist)) throw new PlistError(`${appDir} has no Info.plist`);
  const appMinOS = minimumOSVersion(read(appPlist));
  if (!parseVersion(appMinOS)) {
    throw new PlistError(
      `the app's own ${MIN_OS_KEY} is ${JSON.stringify(appMinOS)}. Every comparison below is ` +
        `against it, so there is nothing to check until that is a version.`
    );
  }

  const frameworks = findFrameworkPlists(path.join(appDir, "Frameworks"));
  if (!frameworks.length) {
    throw new PlistError(
      `${appDir} embeds no frameworks with an Info.plist. This app has embedded ` +
        `onnxruntime.framework since #675, so this is far more likely a wrong path than a ` +
        `changed build — and a check that cannot find its subject must not pass.`
    );
  }

  const lines = [`${appDir}: ${MIN_OS_KEY} = ${appMinOS}, ${frameworks.length} embedded framework(s)`];
  const failures = [];
  for (const f of frameworks) {
    const xml = read(f.plist);
    const problems = frameworkProblems(xml, appMinOS);
    const name = path.basename(f.framework);
    if (!problems.length) lines.push(`  ${name}: ok (${MIN_OS_KEY} = ${minimumOSVersion(xml)})`);
    else for (const p of problems) failures.push(`${name}: ${p}`);
  }
  if (failures.length) {
    throw new PlistError(
      `App Store Connect would reject this bundle (error 90360/90530 is what that looks like ` +
        `at upload time):\n` +
        failures.map((l) => `  ${l}`).join("\n")
    );
  }
  return lines;
}

if (isMain) {
  const argv = process.argv.slice(2);
  const command = argv[0];
  let target = null;
  let minOS = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--min-os") {
      const raw = argv[++i];
      /* A flag is never a value — the same rule, and the same reason, as
         `--mode --check` in inject-background-audio.mjs. */
      if (raw === undefined || raw.startsWith("-")) {
        console.error(`--min-os needs a value, got ${raw === undefined ? "nothing" : raw}`);
        process.exit(2);
      }
      minOS = raw;
    } else if (!argv[i].startsWith("-") && target === null) {
      target = argv[i];
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      console.error(USAGE);
      process.exit(2);
    }
  }

  if ((command !== "patch" && command !== "verify") || !target) {
    console.error(USAGE);
    process.exit(2);
  }
  if (command === "patch" && !minOS) {
    console.error("patch needs --min-os <X.Y> — read it off IPHONEOS_DEPLOYMENT_TARGET, never guess it.");
    process.exit(2);
  }
  if (command === "verify" && minOS) {
    console.error("verify takes no --min-os: it reads the app's own MinimumOSVersion out of the bundle.");
    process.exit(2);
  }

  try {
    const lines = command === "patch" ? runPatch(target, minOS) : runVerify(target);
    for (const l of lines) console.log(l);
  } catch (e) {
    console.error(`ios-embedded-frameworks ${command} failed: ${e.message}`);
    process.exit(1);
  }
}
