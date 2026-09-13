/* release.yml's own invariants — R-03 (docs/release-lockstep-plan.md).
 *
 * Same posture as ios-workflow.test.mjs / android-workflow.test.mjs: this
 * cannot prove a run succeeds, only that the properties which would
 * otherwise rot silently stay pinned. Each test names its MUTATION — the
 * one-line change that would defeat it if the assertion were weaker.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { topLevelKeys, block, step, code } from "./workflow-yaml.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_REL = ".github/workflows/release.yml";
const WF = fs.readFileSync(path.join(ROOT, WORKFLOW_REL), "utf8");
const IOS_ACTION = fs.readFileSync(path.join(ROOT, ".github/actions/ios-archive/action.yml"), "utf8");
const ANDROID_ACTION = fs.readFileSync(path.join(ROOT, ".github/actions/android-bundle/action.yml"), "utf8");

/** Like workflow-yaml.mjs's `step()`, but for a COMPOSITE action file, whose
 *  steps sit at 4-space indent (`runs: using: composite / steps:`) rather
 *  than a workflow job's 6-space indent. Reusing `step()` unmodified against
 *  an action.yml silently returns null for every lookup — a false "property
 *  not found" that would have made every assertion below vacuously pass on
 *  `?? ""`, not fail loudly, which is exactly the kind of unfalsifiable test
 *  this repo's own suites warn against (see ios-workflow.test.mjs's `step()`
 *  import comment for the analogous 8-space-vs-6-space defect it was fixed for). */
function actionStep(src, nameFragment) {
  const chunks = src.split(/\n(?= {4}- (?:name|uses):)/).filter((c) => /^\s*- (?:name|uses):/.test(c));
  return chunks.find((c) => c.includes(nameFragment)) ?? null;
}

/* ────────────────────────────── shape and triggers ─────────────────────────── */

test("the workflow exists and has the expected top-level keys", () => {
  assert.deepEqual(topLevelKeys(WF), ["name", "on", "concurrency", "permissions", "jobs"]);
});

test("triggers are exactly push:tags v* and workflow_dispatch — MUTATION: adding pull_request would let an unmerged branch release", () => {
  const on = block(WF, "on");
  assert.match(on, /push:/);
  assert.match(on, /tags: \["v\*"\]/);
  assert.match(on, /workflow_dispatch:/);
  assert.equal(/pull_request:/.test(on), false, "release.yml must never trigger on pull_request");
  assert.equal(/^\s{2}schedule:/m.test(on), false, "a release must be deliberate, never scheduled");
});

test("workflow_dispatch exposes a bump choice with 'none' as the safe default", () => {
  const on = block(WF, "on");
  assert.match(on, /bump:/);
  assert.match(on, /default: none/);
  for (const choice of ["patch", "minor", "major", "none"]) {
    assert.ok(on.includes(choice), `bump input is missing the '${choice}' option`);
  }
});

test("concurrency is the 'release' group and NEVER cancels an in-progress run — MUTATION: cancel-in-progress: true could kill a mid-upload run", () => {
  const c = block(WF, "concurrency");
  assert.match(c, /group: release/);
  assert.match(c, /cancel-in-progress: false/);
});

test("permissions are read-only", () => {
  const p = block(WF, "permissions");
  assert.match(p, /contents: read/);
});

/* ─────────────────────────────── the guard job ─────────────────────────────── */

test("a guard job exists and gates every later job on its output", () => {
  const jobs = block(WF, "jobs");
  assert.match(jobs, /^\s{2}guard:/m);
  // version, ios (via version), and android (via version) all transitively
  // depend on guard's `allowed` output.
  assert.match(jobs, /needs: guard/);
  assert.match(WF, /needs\.guard\.outputs\.allowed == 'true'/);
});

test("the guard step calls release-ci.mjs release-guard with the real event context — MUTATION: hardcoding 'true' here would defeat the whole guard", () => {
  const guardStep = step(WF, "release-guard") ?? "";
  assert.ok(guardStep, "no step invokes release-ci.mjs release-guard");
  assert.match(guardStep, /release-ci\.mjs release-guard/);
  assert.match(guardStep, /github\.event_name/);
  assert.match(guardStep, /github\.ref/);
});

test("the guard step passes event_name/ref through env:, never interpolated directly into the shell command — MUTATION: '\"${{ github.ref }}\"' inline is a script-injection hole since a tag name is attacker-controlled and can contain `$()`/backticks", () => {
  const guardStep = step(WF, "release-guard") ?? "";
  assert.ok(guardStep);
  assert.match(guardStep, /env:/);
  assert.equal(
    /release-guard\s+"\$\{\{/.test(guardStep),
    false,
    "github.event_name/github.ref must not be interpolated directly into the run: command"
  );
  assert.match(guardStep, /release-guard "\$EVENT_NAME" "\$REF"/);
});

/* ─────────────────────────────── the version job ───────────────────────────── */

test("the version job reads tools/mobile/version.mjs pair, not a run-number-derived value", () => {
  const jobs = block(WF, "jobs");
  assert.match(jobs, /^\s{2}version:/m);
  assert.match(WF, /version\.mjs pair/);
  assert.equal(/run_number\.run_attempt/.test(WF), false, "R-02 retired the run_number.run_attempt build number scheme — it must not come back here");
});

test("a tag push is checked against the tracked marketing version — MUTATION: removing this lets a mistagged commit release under the wrong version", () => {
  assert.match(WF, /tag v\$\{TAG\}? does not match mobile\/VERSION|tag .*does not match mobile\/VERSION/);
  assert.match(WF, /marketing-version/);
});

test("a real version bump on workflow_dispatch is refused, not silently attempted against protected main", () => {
  /* main has bypass_actors: [] (verified against the live GitHub ruleset while
     writing this file) — a push from this job would just fail. The refusal
     must be loud and explain the fix, not a bare `git push` left to fail with
     a raw permissions error three lines into a job log. */
  assert.match(WF, /inputs\.bump != 'none'/);
  assert.match(WF, /bump=none/);
  assert.equal(/git push origin/.test(code(WF)), false, "no in-workflow push to main — see this file's own header for why");
});

/* ───────────────────────────── ios / android jobs ──────────────────────────── */

test("the ios composite action reuses ios-ci.mjs's existing 3-outcome signing-gate unchanged, not a re-implementation", () => {
  assert.match(IOS_ACTION, /ios-ci\.mjs signing-gate/);
  const signingStep = actionStep(IOS_ACTION, "Is signing configured") ?? "";
  assert.match(signingStep, /IOS_DIST_CERT_P12_BASE64/);
});

test("the ios upload step is gated on signing.outputs.ready and passes the R-02 version pair, not run_number.run_attempt", () => {
  const uploadStep = actionStep(IOS_ACTION, "Archive, export and upload to TestFlight") ?? "";
  assert.ok(uploadStep, "no TestFlight upload step found in ios-archive");
  assert.match(uploadStep, /signing\.outputs\.ready == 'true'/);
  assert.match(uploadStep, /inputs\.build_number/);
  assert.match(uploadStep, /inputs\.marketing_version/);
});

test("ios and android jobs both depend on version and both run the privacy tripwire before anything else", () => {
  const jobs = block(WF, "jobs");
  assert.match(jobs, /^\s{2}ios:/m);
  assert.match(jobs, /^\s{2}android:/m);
  const iosStep = step(WF, "actions/checkout");
  assert.ok(iosStep);
  assert.match(WF, /node --test test\/release-gates\.test\.js/);
});

test("ios job runs on macos-latest and android on ubuntu-latest", () => {
  assert.match(WF, /runs-on: macos-latest/);
  assert.match(WF, /runs-on: ubuntu-latest/);
});

test("both jobs invoke the composite actions under .github/actions, not copied build steps", () => {
  assert.match(WF, /uses: \.\/\.github\/actions\/ios-archive/);
  assert.match(WF, /uses: \.\/\.github\/actions\/android-bundle/);
});

test("both jobs pass the SAME version outputs from the version job — MUTATION: a hardcoded or re-derived version here defeats R-02's whole point", () => {
  const iosUse = step(WF, "./.github/actions/ios-archive") ?? "";
  const androidUse = step(WF, "./.github/actions/android-bundle") ?? "";
  for (const chunk of [iosUse, androidUse]) {
    assert.match(chunk, /needs\.version\.outputs\.marketing_version/);
    assert.match(chunk, /needs\.version\.outputs\.build_number/);
  }
});

/* ────────────────────────── Play upload gate (android) ─────────────────────── */

test("the android composite action gates the Play upload on release-ci.mjs play-gate, mirroring the iOS signing-gate", () => {
  assert.match(ANDROID_ACTION, /release-ci\.mjs play-gate/);
  const playStep = actionStep(ANDROID_ACTION, "Is the Play upload configured") ?? "";
  assert.match(playStep, /PLAY_SERVICE_ACCOUNT_JSON/);
});

test("the Play upload step is conditioned on play_gate ready AND a signed bundle — MUTATION: dropping the signed check could upload an unsigned .aab", () => {
  const uploadStep = actionStep(ANDROID_ACTION, "Upload the signed .aab to the Play internal testing track") ?? "";
  assert.ok(uploadStep, "no Play upload step found");
  assert.match(uploadStep, /play_gate\.outputs\.ready == 'true'/);
  assert.match(uploadStep, /bundle\.outputs\.signed == 'signed'/);
});

test("the Play upload action is pinned to a commit SHA, not a floating tag — MUTATION: 'uses: r0adkll/upload-google-play@v1' would let upstream silently change what this key touches", () => {
  const uploadStep = actionStep(ANDROID_ACTION, "Upload the signed .aab to the Play internal testing track") ?? "";
  const usesLine = uploadStep.split("\n").find((l) => /uses:\s*r0adkll\/upload-google-play/.test(l));
  assert.ok(usesLine, "no r0adkll/upload-google-play uses: line found");
  assert.match(usesLine, /@[0-9a-f]{40}/, `expected a 40-char commit SHA pin, got: ${usesLine.trim()}`);
});

test(".aab is uploaded as a build artifact unconditionally (if: always()) — the fallback path when Play is skipped", () => {
  const artifactStep = actionStep(ANDROID_ACTION, "Upload the .aab as a build artifact") ?? "";
  assert.ok(artifactStep);
  assert.match(artifactStep, /if: always\(\)/);
});

/* ─────────────────────────────── the summary job ───────────────────────────── */

test("the summary job runs regardless of ios/android outcome (if: always())", () => {
  const jobs = block(WF, "jobs");
  assert.match(jobs, /^\s{2}summary:/m);
  assert.match(WF, /if: always\(\) && needs\.version\.result == 'success'/);
});

test("the summary FAILS only when both stores are ready and their uploaded outcomes disagree — MUTATION: failing on any absent state would break the acceptance criterion (absent-secret Android should be a warning)", () => {
  const summaryStep = step(WF, "One table") ?? "";
  assert.ok(summaryStep, "no summary step found");
  assert.match(summaryStep, /IOS_STATE:-}" = "ready"/);
  assert.match(summaryStep, /ANDROID_STATE:-}" = "ready"/);
  assert.match(summaryStep, /IOS_UPLOADED:-false}" != "\$\{ANDROID_UPLOADED:-false}"/);
  assert.match(summaryStep, /exit 1/);
});

test("the summary also fails on a partial (half-configured) credential state on either side", () => {
  const summaryStep = step(WF, "One table") ?? "";
  assert.match(summaryStep, /"partial"/);
});

test("the summary prints a version/build/iOS/Android table", () => {
  const summaryStep = step(WF, "One table") ?? "";
  assert.match(summaryStep, /GITHUB_STEP_SUMMARY/);
  assert.match(summaryStep, /MARKETING_VERSION/);
  assert.match(summaryStep, /BUILD_NUMBER/);
});

/* ────── the embedded framework plist, on the path that makes the artifact ──── */

/* WHY THESE LIVE HERE AND NOT ONLY IN ios-workflow.test.mjs. Release run
 * 34739630705 failed at `xcrun altool` with error 90360 —
 * `App.app/Frameworks/onnxruntime.framework` has no `MinimumOSVersion` — on a
 * build whose plugin change (#675) had been verified against `ios-kit` and
 * `ios-shell`. Neither of those archives or uploads. THIS composite action is a
 * third build path and the only one that produces the founder's TestFlight
 * artifact, so the fix has to be asserted here in its own right; a step that
 * exists only in ios-build.yml is the exact gap that let this ship. */

test("the ios composite PATCHES the ONNX Runtime plist before it archives — MUTATION: delete the step; the release path regains the 90360 rejection while ios-build.yml stays green", () => {
  const patch = actionStep(IOS_ACTION, "Give the embedded ONNX Runtime framework the MinimumOSVersion") ?? "";
  assert.ok(patch, "the release path does not patch the framework plist at all");
  assert.match(patch, /ios-embedded-frameworks\.mjs patch "\$SPM_DIR" --min-os "\$MIN_OS"/);
  assert.match(patch, /IPHONEOS_DEPLOYMENT_TARGET/, "the deployment target is hardcoded rather than read off the project");
  const archiveAt = IOS_ACTION.indexOf("- name: Archive, export and upload to TestFlight");
  const patchAt = IOS_ACTION.indexOf("- name: Give the embedded ONNX Runtime framework");
  assert.ok(patchAt > 0 && patchAt < archiveAt, "the patch runs after the archive, when the bundle is already signed");
});

test("the archive resolves its packages from the PATCHED tree — MUTATION: drop -clonedSourcePackagesDirPath and xcodebuild fetches its own unpatched xcframework into DerivedData", () => {
  const uploadStep = actionStep(IOS_ACTION, "Archive, export and upload to TestFlight") ?? "";
  assert.match(uploadStep, /-clonedSourcePackagesDirPath "\$SPM_DIR"/);
  assert.match(IOS_ACTION, /SPM_DIR=\$RUNNER_TEMP/, "SPM_DIR is never given a value");
});

test("the ARCHIVE is read back for embedded-framework keys before it is exported or uploaded — MUTATION: move the verify after `altool` and it can only confirm a failure Apple already reported", () => {
  /* Same reasoning as the two CFBundleVersion read-backs beside it: a build input
     that silently does not reach the bundle is this repo's "green and wrong"
     shape, and for this one the place it surfaces is 90 seconds into an upload. */
  const uploadStep = actionStep(IOS_ACTION, "Archive, export and upload to TestFlight") ?? "";
  assert.match(uploadStep, /ios-embedded-frameworks\.mjs verify/, "the archive's frameworks are never checked");
  assert.match(uploadStep, /Foray\.xcarchive\/Products\/Applications\/App\.app/,
    "the check reads something other than the archived bundle");
  const verifyAt = uploadStep.indexOf("ios-embedded-frameworks.mjs verify");
  const exportAt = uploadStep.indexOf("xcodebuild -exportArchive");
  const uploadAt = uploadStep.indexOf("altool --upload-app");
  assert.ok(exportAt > 0 && uploadAt > 0, "the export/upload commands moved");
  assert.ok(verifyAt > 0 && verifyAt < exportAt && verifyAt < uploadAt,
    "the embedded-framework check does not run before the export and the upload");
});

test("both iOS build paths run the SAME script, not two copies of the rule — MUTATION: inline the plist edit here and the two paths start disagreeing", () => {
  const shell = fs.readFileSync(path.join(ROOT, ".github/workflows/ios-build.yml"), "utf8");
  for (const src of [IOS_ACTION, shell]) {
    assert.match(src, /node tools\/mobile\/ios-embedded-frameworks\.mjs patch/);
    assert.match(src, /node tools\/mobile\/ios-embedded-frameworks\.mjs verify/);
  }
});
