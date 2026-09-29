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
import { CLIPS, EPISODE, FIXTURE_PATH, SCENARIOS } from "./android-playback.mjs";
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

/** A-04's one addition to the smoke's build step: the lines that bundle the
 *  click tracks. Everything else in that step must be the smoke's. */
const isFixtureLine = (l) => /assets\/public\/a04|ClickTracks\/click-/.test(l);

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
  assert.ok(t && Number(t[1]) <= 30, "the job needs a ceiling, and the card's budget is 12 minutes");
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
  for (const [a, b] of [["play", "background"], ["background", "transport"], ["transport", "notification"]]) {
    assert.ok(PLY.indexOf(`android-playback.mjs ${a} `) < PLY.indexOf(`android-playback.mjs ${b} `), `${a} before ${b}`);
  }
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
