/* `tools/mobile/wire-signing.mjs` — the thing that puts the signing config into
 * a project nobody commits.
 *
 * WHY THIS SUITE MATTERS MORE THAN ITS SIZE SUGGESTS. `mobile/android/` is
 * regenerated on every build, so the ONLY evidence that the release signing
 * config reaches Gradle is that this script ran and that its `--check` pass
 * agreed. If the script silently does nothing, `bundleRelease` produces an
 * UNSIGNED bundle and prints BUILD SUCCESSFUL — the workflow's signature step is
 * the backstop for that, and this is the layer above it.
 *
 * THE FIXTURE IS A REAL GENERATED `app/build.gradle`, not a hand-written stub.
 * `docs/` records five separate occasions where a fixture more forgiving than
 * the real thing made a test vacuous (CLAUDE.md § "A green test is not evidence
 * until you have broken it"), and the most forgiving possible fixture here would
 * be an empty file — into which appending a line always works. The text below is
 * Capacitor 8.5.0's template output, copied verbatim, including the trailing
 * `try { … google-services.json … }` block that the apply line has to land after.
 *
 * EVERY TEST NAMES THE ONE-LINE MUTATION THAT BREAKS IT, AND ALL WERE RUN.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPLY_LINE,
  GENERATED_MARKERS,
  SIGNING_GRADLE_NAME,
  SIGNING_GRADLE_SOURCE,
  WireSigningError,
  hasApplyLine,
  missingMarkers,
  wireSigning,
  withApplyLine,
} from "./wire-signing.mjs";

/** Capacitor 8.5.0's `android/app/build.gradle`, as generated. Trimmed of the
 *  dependency list, which nothing here reads, and otherwise verbatim. */
const TEMPLATE = `apply plugin: 'com.android.application'

android {
    namespace = "ai.jwlabs.foura"
    compileSdk = rootProject.ext.compileSdkVersion
    defaultConfig {
        applicationId "ai.jwlabs.foura"
        versionCode 1
        versionName "1.0"
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}

apply from: 'capacitor.build.gradle'

try {
    def servicesJSON = file('google-services.json')
    if (servicesJSON.text) {
        apply plugin: 'com.google.gms.google-services'
    }
} catch(Exception e) {
    logger.info("google-services.json not found, google-services plugin not applied. Push Notifications won't work")
}
`;

/** A throwaway directory shaped like a generated Capacitor Android project. */
function makeProject(t, { appGradle = TEMPLATE, omit = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-wire-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const marker of GENERATED_MARKERS) {
    if (omit.includes(marker)) continue;
    const p = path.join(dir, marker);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, marker === "app/build.gradle" ? appGradle : `// ${marker}\n`);
  }
  return dir;
}

/* ─────────────────────────── the pure transform ───────────────────────────── */

test("the apply line is added once, at the end, after the template's last block", () => {
  /* MUTATION: make `withApplyLine` return `text` unchanged -> fails.
     The line has to land at the END. Capacitor's template finishes with a
     `try { … }` around google-services, and `android { }` is a re-openable
     extension block, so an applied script at the bottom configures the same
     object — while an insert in the middle of that `try` would be a syntax
     error in a file nobody reviews because nobody commits it. */
  const out = withApplyLine(TEMPLATE);
  assert.ok(out.startsWith(TEMPLATE), "the template must be preserved byte-for-byte");
  assert.ok(out.trimEnd().endsWith(APPLY_LINE), "the apply line must be last");
  assert.equal(out.split(APPLY_LINE).length - 1, 1, "exactly one apply line");
});

test("it is idempotent — a second pass adds nothing", () => {
  /* MUTATION: delete the `if (hasApplyLine(text)) return text;` guard -> fails.
     `cap sync` can run more than once in a job, and a second apply line means a
     second `signingConfigs { forayRelease { … } }`, which is a duplicate-name
     failure in a NamedDomainObjectContainer rather than a harmless repeat. */
  const once = withApplyLine(TEMPLATE);
  assert.equal(withApplyLine(once), once);
  assert.equal(once.split(APPLY_LINE).length - 1, 1);
});

test("a MENTION of the include is not a wiring — the check reads whole lines", () => {
  /* MUTATION: change `hasApplyLine` to `text.includes("foray-signing.gradle")`
     -> fails.
     THE VACUITY THIS FILE EXISTS TO AVOID, and it is the exact shape
     `android-workflow.test.mjs` records three times: a substring search that
     finds the COMMENT ABOUT the thing instead of the thing. The comment this
     script itself writes above the apply line names `foray-signing.gradle`, so a
     substring test would report "already wired" against a build.gradle carrying
     only the comment — and then the release would be signed by nothing. */
  const commentedOut = `${TEMPLATE}\n// ${APPLY_LINE}\n`;
  assert.equal(hasApplyLine(commentedOut), false, "a commented-out apply line is not applied");
  const mentioned = `${TEMPLATE}\n// remember to wire foray-signing.gradle in\n`;
  assert.equal(hasApplyLine(mentioned), false, "a mention is not a wiring");
  assert.equal(hasApplyLine(withApplyLine(TEMPLATE)), true);
});

test("the apply line uses $rootDir rather than a relative hop", () => {
  /* MUTATION: change APPLY_LINE to `apply from: '../foray-signing.gradle'` -> fails.
     A relative path is resolved against the APPLYING PROJECT's directory, which
     is `android/app` today. It works today and stops working the moment the
     include is applied from a module at another depth — and the failure is
     "file not found" during configuration, which reads like a missing file
     rather than a wrong assumption. */
  assert.match(APPLY_LINE, /\$rootDir\//);
  assert.equal(/\.\.\//.test(APPLY_LINE), false, "no relative hops");
  assert.ok(APPLY_LINE.includes(SIGNING_GRADLE_NAME));
});

/* ─────────────────────────── against a real tree ──────────────────────────── */

test("it wires a generated project, and --check then agrees", (t) => {
  /* MUTATION: delete the `fs.copyFileSync(...)` line -> fails (the copied
     include is missing, and --check says so). */
  const dir = makeProject(t);
  const first = wireSigning(dir);
  assert.equal(first.applied, true);
  assert.equal(hasApplyLine(fs.readFileSync(path.join(dir, "app/build.gradle"), "utf8")), true);
  assert.equal(fs.existsSync(path.join(dir, SIGNING_GRADLE_NAME)), true);
  /* THE COPY IS THE TRACKED FILE, BYTE FOR BYTE. A copy that silently truncated
     would leave an apply line pointing at a file Gradle can parse and that
     configures nothing. */
  assert.equal(
    fs.readFileSync(path.join(dir, SIGNING_GRADLE_NAME), "utf8"),
    fs.readFileSync(SIGNING_GRADLE_SOURCE, "utf8")
  );
  const second = wireSigning(dir);
  assert.equal(second.applied, false, "the second run must not append again");
  assert.doesNotThrow(() => wireSigning(dir, { check: true }));
});

test("--check FAILS on a project that was never wired", (t) => {
  /* MUTATION: make `wireSigning(dir, {check:true})` return instead of throwing
     when `alreadyWired` is false -> fails.
     THIS IS THE ASSERTION THE WORKFLOW LEANS ON. The release job runs the script
     and then runs it again with `--check`, and the whole value of the second run
     is that it can say no. A `--check` that cannot fail is a slower echo. */
  const dir = makeProject(t);
  assert.throws(() => wireSigning(dir, { check: true }), WireSigningError);
});

test("--check FAILS when the apply line is there and the include is not", (t) => {
  /* MUTATION: drop the `copied` half of the `--check` condition -> fails.
     A HALF-WIRED PROJECT IS THE WORST OF THE THREE STATES: Gradle hits
     `apply from:` pointing at a missing file and the build dies with a message
     about a path, in a generated tree nobody has ever read. Deleting the copied
     include while leaving the apply line is one `rm` — or one `cap sync` that
     cleans the project root — away. */
  const dir = makeProject(t);
  wireSigning(dir);
  fs.rmSync(path.join(dir, SIGNING_GRADLE_NAME));
  assert.throws(() => wireSigning(dir, { check: true }), /MISSING/);
});

test("it refuses a directory that is not a generated Capacitor project", (t) => {
  /* MUTATION: delete the `missingMarkers` guard from `wireSigning` -> fails.
     THE ARGUMENT FOR A SCRIPT THAT EDITS BUILD FILES IS THAT IT ONLY EDITS BUILD
     OUTPUT — the same guard `tools/mobile/probe/install-probe.mjs` carries and
     for the same reason. Pointed at a checkout, this would append to a tracked
     file and the diff would land in a PR nobody expected it in. */
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "foray-bare-"));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  assert.throws(() => wireSigning(bare), /not a generated Capacitor Android project/);
  /* `capacitor.settings.gradle` is the marker no hand-made directory has: it is
     written by `cap sync`, and `android-build.yml`'s highest-value assertion
     reads it. A project missing only that one must still be refused. */
  const almost = makeProject(t, { omit: ["capacitor.settings.gradle"] });
  assert.throws(() => wireSigning(almost), /capacitor\.settings\.gradle/);
  assert.deepEqual(missingMarkers(almost), ["capacitor.settings.gradle"]);
});

test("all four markers are required, and the error names every missing one at once", (t) => {
  /* MUTATION: return early from `missingMarkers` after the first miss -> fails.
     A script that reports one missing file per run is three runs to learn what
     is wrong, on a job that takes twenty-five minutes to get here. */
  const dir = makeProject(t, { omit: ["settings.gradle", "gradlew"] });
  assert.deepEqual(missingMarkers(dir), ["settings.gradle", "gradlew"]);
  assert.throws(() => wireSigning(dir), /settings\.gradle, gradlew/);
});

test("the tracked include exists and is what gets copied", () => {
  /* MUTATION: rename `mobile/gradle/foray-signing.gradle` -> fails.
     CANNOT FAIL ON TODAY'S TREE, and it is written deliberately (CLAUDE.md's
     rule 5 about tests that guard a future move): the include lives under
     `mobile/`, which is UNLISTED in `tools/ci/path-policy.mjs` and therefore
     never auto-merges. If a later change files it under `tools/` for tidiness it
     becomes one green tick from landing unreviewed, and this is what notices the
     move. */
  assert.equal(fs.existsSync(SIGNING_GRADLE_SOURCE), true, "the tracked signing include is missing");
  assert.match(SIGNING_GRADLE_SOURCE.replace(/\\/g, "/"), /\/mobile\/gradle\/foray-signing\.gradle$/);
});
