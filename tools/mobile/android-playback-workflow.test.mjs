/* `.github/workflows/android-playback.yml` (A-04): the properties that would
 * otherwise rot silently.
 *
 * It cannot run the workflow; the PR names the run that did. What it holds:
 *   - the job stays advisory, reads no secret, never uploads to a store, and
 *     fires on the app's paths only (no push, no schedule),
 *   - its boot is `android-smoke.yml`'s, step for step with comments stripped,
 *     plus exactly one named addition (the click tracks), so a fix to the smoke's
 *     boot that is not made here is red,
 *   - every scenario the runner knows is its own step, gated only on the launch,
 *     and none of them can have its verdict discarded,
 *   - the runner and the workflow agree on where the click tracks live.
 *
 * The reading helpers are `workflow-yaml.mjs`'s; see `android-workflow.test.mjs`
 * for why every assertion about a step reads its CODE and not its comments.
 * EVERY TEST NAMES THE MUTATION THAT BREAKS IT, and each was run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { block, code, prose, step, topLevelKeys } from "./workflow-yaml.mjs";
import { CLIPS, EPISODE, FIXTURE_PATH, HELPER_ACTIVITY, HELPER_APK, HELPER_PKG, HELPER_TAG, NARRATION_LINES, NARRATION_PATH, SCENARIOS } from "./android-playback.mjs";
import { CLICK_TRACK_DIR } from "../audio/click-tracks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLAY_REL = ".github/workflows/android-playback.yml";
const PLY = fs.readFileSync(path.join(ROOT, PLAY_REL), "utf8");
const PYML = code(PLY);
const SMK = fs.readFileSync(path.join(ROOT, ".github/workflows/android-smoke.yml"), "utf8");

const playStep = (name) => {
  const s = step(PLY, name);
  return s === null ? null : code(s);
};
const smokeStep = (name) => {
  const s = step(SMK, name);
  return s === null ? null : code(s);
};
const failureClauses = (s) => (s.match(/exit 1/g) ?? []).length;

/* The boot, in order: every step up to and including the launch. */
const BOOT = [
  "uses: actions/checkout@v4",
  "uses: actions/setup-node@v4",
  "uses: actions/setup-java@v4",
  "name: Enable KVM, or the emulator falls back to software and never boots",
  "name: The Android SDK, plus the emulator and one system image",
  "name: Build the webDir, generate the project, and build the debug APK",
  "name: The debug build is still a fair stand-in for the release build",
  "name: Create the AVD, and prove it exists before launching anything",
  "name: Boot it",
  "name: Install the app and start it",
];

/** The one addition to the smoke's build step: the lines that bundle the
 *  click tracks (A-04, `a04/`) and the rendered-narration fixtures (A-05,
 *  `a05/`). Everything else in that step must be the smoke's. */
const isFixtureLine = (l) => /assets\/public\/a0[45]|ClickTracks\/click-/.test(l);

test("A-04: android-playback.yml has the house shape and one advisory job", () => {
  /* MUTATION: rename the job `backend:` -> fails (a required check's name).
     MUTATION: add `continue-on-error: true` -> fails (advisory means not
     required, not unable to fail). */
  assert.deepEqual(topLevelKeys(PLY), ["name", "on", "concurrency", "permissions", "jobs"]);
  assert.match(PLY, /^name: android-playback$/m);
  const names = block(PLY, "jobs")
    .split(/\r?\n/)
    .filter((l) => /^ {2}[a-z][\w-]*:/.test(l))
    .map((l) => l.trim().replace(":", ""));
  assert.deepEqual(names, ["android-playback"]);
  for (const required of ["backend", "data-and-site", "path-policy", "ios-kit", "android-smoke"]) {
    assert.equal(names.includes(required), false, `a job named ${required} collides with another check`);
  }
  assert.equal(/continue-on-error/.test(PYML), false);
  assert.match(PYML, /^ {4}runs-on: ubuntu-latest$/m);
  const t = /^ {4}timeout-minutes: (\d+)$/m.exec(PYML);
  /* MUTATION: raise it to 60 -> fails. A-04's budget was 12 minutes and A-05
     adds about 12 (five of them the card's own Doze), so 45 is the ceiling for
     a hung run, not a budget to grow into. */
  assert.ok(t && Number(t[1]) <= 45, "the job needs a ceiling: A-04's 12 minutes plus A-05's ~12");
});

test("A-04: it fires on the app's paths and its own file, by hand, and never on push or schedule", () => {
  /* MUTATION: add `"data/**"` -> fails. MUTATION: add `push:` -> fails.
     MUTATION: delete `"player/**"` -> fails: the JS player IS what this job
     tests, and a player PR that skipped it would be the gap A-04 closes. */
  const on = block(PLY, "on");
  assert.match(on, /^ {2}workflow_dispatch:/m);
  assert.match(on, /^ {2}pull_request:/m);
  assert.equal(/^\s{2}(push|schedule|workflow_call):/m.test(on), false);
  assert.equal(/paths-ignore/.test(PYML), false);
  const paths = [...on.matchAll(/^ {6}- "([^"]+)"$/gm)].map((m) => m[1]);
  assert.deepEqual(
    [...paths].sort(),
    [".github/workflows/android-playback.yml", "app.js", "index.html", "mobile/**", "player/**", "search-engine.js", "styles.css", "tools/mobile/**"].sort()
  );
  const smokePaths = [...block(SMK, "on").matchAll(/^ {6}- "([^"]+)"$/gm)].map((m) => m[1]);
  for (const p of paths.filter((x) => x !== PLAY_REL)) {
    assert.ok(smokePaths.includes(p), `${p} is not one of the smoke's paths; the two jobs test the same app`);
  }
});

test("A-04: its concurrency is its own, and it asks for nothing", () => {
  /* MUTATION: share the smoke's group -> fails (one would cancel the other on
     every app PR). MUTATION: `contents: write` -> fails. */
  const c = block(PLY, "concurrency");
  assert.match(c, /group: android-playback-\$\{\{ github\.ref \}\}/);
  assert.match(c, /cancel-in-progress: true/);
  const perms = block(PLY, "permissions");
  assert.match(perms, /contents: read/);
  for (const w of ["write", "packages:", "id-token"]) assert.equal(perms.includes(w), false);
});

test("A-04: it reads no secret, uses only GitHub's own actions, and uploads only its evidence", () => {
  /* MUTATION: add `KEY: ${{ secrets.ANDROID_KEYSTORE_B64 }}` -> fails.
     MUTATION: `uses: reactivecircus/android-emulator-runner@v2` -> fails.
     MUTATION: upload `${{ runner.temp }}` -> fails. */
  assert.equal(/secrets[.:]/.test(PYML), false, "no secret, so it runs on any PR");
  for (const store of ["upload-google-play", "upload-testflight", "altool", "fastlane", "PLAY_SERVICE_ACCOUNT_JSON"]) {
    assert.equal(PYML.includes(store), false, `${store} would make this an upload path`);
  }
  const uses = [...PYML.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4);
  for (const u of uses) assert.match(u, /^actions\/[\w-]+@v\d+$/, `${u} is not one of GitHub's own actions pinned to a major`);
  const uploads = PYML.split(/\r?\n/).filter((l) => /uses: actions\/upload-artifact@/.test(l));
  assert.equal(uploads.length, 1);
  const up = step(PLY, "Upload the playback evidence");
  assert.match(up, /path: \$\{\{ runner\.temp \}\}\/android-playback\s*$/m);
  assert.match(up, /^ {8}if: always\(\)$/m);
  const p = prose(PLY);
  assert.match(p, /never uploads to a store/i);
  assert.match(p, /reads no secret/i);
});

test("A-04: the boot is android-smoke.yml's, step for step, plus the click tracks", () => {
  /* MUTATION: change `-memory 4096` in either file's boot -> fails.
     MUTATION: drop the `kill -0` check from this file's boot -> fails.
     MUTATION: add a line to the smoke's install step and not here -> fails.
     THE REUSE THE CARD ASKS FOR, ENFORCED. The two files share a boot so that
     the launch the smoke certifies is the launch these scenarios run on. The
     evidence directory's name is the one allowed difference in the SDK step,
     and the click-track lines the one in the build step. */
  const norm = (s) => s.replace(/android-playback/g, "android-smoke");
  for (const name of BOOT) {
    const mine = playStep(name);
    const theirs = smokeStep(name);
    assert.ok(mine, `this workflow has no step "${name}"`);
    assert.ok(theirs, `android-smoke.yml has no step "${name}"; re-read A-04 before following it`);
    const a = norm(mine).split(/\r?\n/).filter((l) => !isFixtureLine(l)).join("\n").trim();
    const b = theirs.trim();
    assert.equal(a, b, `"${name}" differs from android-smoke.yml's`);
  }
  /* And the order is the smoke's: each boot step appears after the one before. */
  let at = -1;
  for (const name of BOOT) {
    const i = PLY.indexOf(`- ${name}`);
    assert.notEqual(i, -1, `"${name}" is missing`);
    assert.ok(i > at, `"${name}" is out of the smoke's order`);
    at = i;
  }
  /* The env block is the smoke's too: same image, same SDK, same package. */
  for (const key of ["SDK_PLATFORM", "SDK_BUILD_TOOLS", "EMULATOR_IMAGE", "AVD_NAME", "PKG"]) {
    const re = new RegExp(`^ {6}${key}: (.+)$`, "m");
    assert.equal(re.exec(PLY)?.[1], re.exec(SMK)?.[1], `${key} differs from the smoke's`);
  }
});

test("A-04: the click tracks the runner plays are the ones the build copies, and the APK is checked for them", () => {
  /* MUTATION: copy only click-cbr.mp3 -> fails. MUTATION: change FIXTURE_PATH
     to `/fixtures/` in the runner -> fails. MUTATION: `|| true` on the APK
     check -> fails.
     The runner asks for `https://localhost/a04/<file>`; Capacitor serves
     `assets/public/` at the root; so the build must copy each file the runner
     names into `assets/public/a04/`, from the directory the click-track guard
     owns. */
  assert.equal(FIXTURE_PATH, "/a04/");
  const build = playStep("name: Build the webDir");
  const fixtureLines = build.split(/\r?\n/).filter(isFixtureLine).join("\n");
  assert.match(fixtureLines, /mkdir -p android\/app\/src\/main\/assets\/public\/a04/);
  const relDir = CLICK_TRACK_DIR.replace(/^mobile\//, "");
  for (const f of new Set([...CLIPS.map((c) => c.file), EPISODE.file])) {
    assert.ok(fixtureLines.includes(`${relDir}/${f}`), `the build does not copy ${f} from ${relDir}`);
  }
  const check = playStep("The click tracks are in the APK");
  assert.ok(check, "nothing checks the APK for the click tracks");
  assert.match(check, /unzip -l "\$APK"/);
  assert.match(check, /assets\/public\/a04\/click-\(cbr\|vbr-xing\|vbr-notoc\)/);
  assert.equal(failureClauses(check), 1);
  assert.equal(/\[ "\$FOUND" = "3" \][^\n]*\|\| true/.test(check), false);
  const order = PLY.indexOf("The click tracks are in the APK");
  assert.ok(order > PLY.indexOf("- name: Build the webDir") && order < PLY.indexOf("- name: Install the app and start it"));
});

test("A-04: every scenario is its own step, runs after a launch whatever came before, and cannot be silenced", () => {
  /* MUTATION: append `|| true` to the (b) step -> fails. MUTATION: drop
     `!cancelled()` from (c) -> fails (a failed (b) would then hide (c)'s
     verdict). MUTATION: remove the (d) step -> fails. MUTATION: gate (a) on
     `steps.first-launch.outcome` -> fails: one scenario's failure must not
     stop the others from printing theirs. */
  const scenarioSteps = PLY.split(/\n(?= {6}- (?:name|uses):)/).filter((c) => /node tools\/mobile\/android-playback\.mjs (?!collect|summary)/.test(c));
  const ids = SCENARIOS.map(([id]) => id);
  assert.equal(scenarioSteps.length, ids.length, "one step per scenario");
  for (const id of ids) {
    const s = scenarioSteps.find((c) => new RegExp(`android-playback\\.mjs ${id} `).test(c));
    assert.ok(s, `no step runs the ${id} scenario`);
    const c = code(s);
    assert.match(c, new RegExp(`^ {8}id: ${id}$`, "m"), `the ${id} step needs its own id`);
    assert.match(c, /^ {8}if: \$\{\{ !cancelled\(\) && steps\.launch\.outcome == 'success' \}\}$/m, `${id} runs after a launch, whatever the scenario before it did`);
    const run = /^ {8}run: (.+)$/m.exec(c)?.[1];
    assert.equal(run, `node tools/mobile/android-playback.mjs ${id} --art "$ART"`, `${id}'s verdict must be its step's`);
  }
  /* (e) is the first-launch screen, so it runs first, before anything plays. */
  const first = PLY.indexOf("android-playback.mjs first-launch");
  const play = PLY.indexOf("android-playback.mjs play");
  assert.ok(first > PLY.indexOf("- name: Install the app and start it") && first < play);
  const order = ["play", "background", "transport", "notification", "seams", "doze", "focus", "call", "kill", "airplane", "back-home"];
  for (let i = 1; i < order.length; i += 1) {
    const [a, b] = [order[i - 1], order[i]];
    assert.ok(PLY.indexOf(`android-playback.mjs ${a} `) < PLY.indexOf(`android-playback.mjs ${b} `), `${a} before ${b}`);
  }
  /* A-05's scenarios after A-04's, and the collect step after all of them, so
     the evidence it gathers includes theirs. */
  assert.ok(PLY.indexOf("android-playback.mjs back-home ") < PLY.indexOf("android-playback.mjs collect "));
});

test("A-04: the evidence is collected whenever there was a device, and the summary runs always", () => {
  /* MUTATION: gate the collect step on `steps.launch.outcome == 'success'`
     only -> fails: a failed install is the run whose logcat matters most.
     MUTATION: delete the "What it does not prove" line -> fails. */
  const collect = playStep("Collect the logcat");
  assert.ok(collect);
  assert.match(collect, /if: \$\{\{ !cancelled\(\) && \(steps\.launch\.outcome == 'success' \|\| steps\.launch\.outcome == 'failure'\) \}\}/);
  assert.match(collect, /android-playback\.mjs collect --art "\$ART"/);
  const summary = playStep("What the scenarios established");
  assert.match(summary, /^ {8}if: always\(\)$/m);
  assert.match(summary, /android-playback\.mjs summary --art "\$ART"/);
  assert.match(summary, /GITHUB_STEP_SUMMARY/);
  assert.match(summary, /What it does not prove/);
  assert.match(summary, /§6\.4/);
  const p = prose(PLY);
  assert.match(p, /D-A3/, "the header says why this is the only Android testing");
  assert.match(p, /adb reverse/, "the header says why the fixtures are bundled rather than reversed");
});

test("A-04: Play services' first-boot restart is waited out before the install, boundedly and without failing", () => {
  /* MUTATION: move the step after the install -> fails. MUTATION: drop the
     120 s bound -> fails (a gms that never restarts would hold the runner).
     MUTATION: add `exit 1` to the no-restart branch -> fails: the wait is a
     precaution against an emulator event, not a gate on the app.
     Run 36547348476: gms.persistent restarted ~55 s after boot and
     ActivityManager killed the app for holding its FontsProvider, 30 s into
     (b). */
  const s = playStep("Let Play services finish its first-boot restart");
  assert.ok(s, "no step waits for gms.persistent's first-boot restart");
  assert.match(s, /pidof "\$GMS"/);
  assert.match(s, /GMS=com\.google\.android\.gms\.persistent/);
  assert.match(s, /-lt 120 \]/, "bounded");
  assert.equal(failureClauses(s), 0, "it never fails the job");
  const at = PLY.indexOf("- name: Let Play services finish its first-boot restart");
  assert.ok(at > PLY.indexOf("- name: Boot it") && at < PLY.indexOf("- name: Install the app and start it"));
  assert.match(prose(step(PLY, "Let Play services")), /FontsProvider/, "the step says what it saw");
});

test("A-05: the narration fixtures are made at the render profile's encode, named as the runner plays them, and checked in the APK", () => {
  /* MUTATION: `-b:a 128k` -> fails (not the profile's encode). MUTATION:
     rename a05-line-2.m4a in the step only -> fails (the runner would 404).
     MUTATION: move the render step after the build -> fails (the APK would
     be built without them). MUTATION: `|| true` on the APK check -> fails.
     (f) and (k) are about RENDERED narration, which ships as .m4a files
     (DECISIONS 2026-09-28); a fixture at another encode would measure a file
     the product never plays. */
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/narration/render-profile.json"), "utf8")).render.encode;
  const s = playStep("Render the A-05 narration fixtures");
  assert.ok(s, "no step renders the narration fixtures");
  assert.match(s, new RegExp(`-c:a ${profile.codec}\\b`));
  assert.match(s, new RegExp(`-b:a ${profile.bitrate_kbps}k\\b`));
  assert.match(s, new RegExp(`-ac ${profile.channels}\\b`));
  assert.match(s, new RegExp(`-ar ${profile.sample_rate}\\b`));
  assert.equal(profile.faststart, true);
  assert.match(s, /-movflags \+faststart/);
  assert.equal(profile.container, "m4a");
  const made = [...s.matchAll(/^ {10}line (\S+) (\d+) (\d+)$/gm)].map((m) => ({ file: m[1], hz: Number(m[2]), sec: Number(m[3]) }));
  assert.deepEqual(made, NARRATION_LINES.map(({ file, hz, sec }) => ({ file, hz, sec })));
  assert.equal(failureClauses(s), 1, "the step fails when ffmpeg made fewer than three");
  assert.ok(PLY.indexOf("- name: Render the A-05 narration fixtures") < PLY.indexOf("- name: Build the webDir"));
  /* The build copies them to the path the runner asks for. */
  assert.equal(NARRATION_PATH, "/a05/");
  const build = playStep("name: Build the webDir");
  assert.match(build, /cp "\$RUNNER_TEMP"\/a05-narration\/a05-line-\*\.m4a android\/app\/src\/main\/assets\/public\/a05\//);
  const check = playStep("The narration fixtures are in the APK");
  assert.ok(check, "nothing checks the APK for the narration fixtures");
  assert.match(check, /assets\/public\/a05\/a05-line-\[123\]/);
  assert.equal(failureClauses(check), 1);
  assert.ok(PLY.indexOf("- name: The narration fixtures are in the APK") > PLY.indexOf("- name: The click tracks are in the APK"),
    "it reads the listing the click-track check writes");
});

test("A-05: the focus helper is built from its committed source without Gradle, and lands where (h) installs it from", () => {
  /* MUTATION: `./gradlew` in the step -> fails (the job's one Gradle build is
     the app's). MUTATION: write the APK to $RUNNER_TEMP -> fails ((h) looks in
     the evidence directory). MUTATION: rename the activity in the manifest ->
     fails (the runner starts HELPER_ACTIVITY). */
  const s = playStep("Build the A-05 focus helper");
  assert.ok(s, "no step builds the focus helper");
  assert.equal(/gradlew|gradle (build|assemble)/.test(s), false);
  for (const tool of ["javac", "/d8", "/aapt2", "/zipalign", "/apksigner"]) assert.ok(s.includes(tool), `the step does not run ${tool}`);
  assert.match(s, /H=tools\/mobile\/a05-focus-helper/);
  assert.ok(s.includes(`--out "$ART/${HELPER_APK}"`), "the signed helper goes to the evidence directory as HELPER_APK");
  assert.match(s, /apksigner" verify/);
  assert.match(s, /\$\{SDK_BUILD_TOOLS#build-tools;\}/, "the build-tools the job installed, not a hard-coded version");
  assert.match(s, /\$\{SDK_PLATFORM#platforms;\}/);
  const manifest = fs.readFileSync(path.join(ROOT, "tools/mobile/a05-focus-helper/AndroidManifest.xml"), "utf8");
  assert.match(manifest, new RegExp(`package="${HELPER_PKG.replace(/\./g, "\\.")}"`));
  const activity = HELPER_ACTIVITY.split("/")[1];
  assert.match(manifest, new RegExp(`android:name="${activity.replace(/\./g, "\\.")}"`));
  assert.match(manifest, /android:exported="true"/);
  assert.equal(/uses-permission/.test(manifest), false, "the helper asks for no permission");
  const java = fs.readFileSync(path.join(ROOT, "tools/mobile/a05-focus-helper/src/ai/jwlabs/a05focus/FocusActivity.java"), "utf8");
  assert.match(java, /^package ai\.jwlabs\.a05focus;$/m);
  assert.ok(java.includes(`TAG = "${HELPER_TAG}"`), "the runner reads the helper's log by this tag");
  for (const mode of ["transient", "abandon"]) assert.ok(java.includes(`"${mode}"`), `the helper does not handle mode ${mode}`);
  assert.match(java, /AUDIOFOCUS_GAIN\b/);
  assert.match(java, /AUDIOFOCUS_GAIN_TRANSIENT/);
  assert.match(java, /"mode=" \+ mode \+ " result=" \+ r/, "the runner reads `mode=<m> result=1` as granted");
  const at = PLY.indexOf("- name: Build the A-05 focus helper");
  assert.ok(at > PLY.indexOf("- name: The SDK") || at > PLY.indexOf("- name: The Android SDK"));
  assert.ok(at < PLY.indexOf("- name: Install the app and start it"));
});
