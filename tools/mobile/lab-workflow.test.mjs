/* The lab path through the two composite actions (Redesign 2026, phase 0e):
 * `.github/actions/ios-archive` and `.github/actions/android-bundle`, as called by
 * `.github/workflows/lab-build.yml` (which tools/ci/lab-build-workflow.test.mjs pins).
 *
 * TWO PROPERTIES, in order of how much they matter:
 *   1. WITH `lab` OFF THE ACTIONS ARE THE REAL BUILD'S, UNCHANGED. The real
 *      release path (release.yml) passes neither `lab` nor `app_id`, so every new
 *      input must default to the real app, every lab step must be skipped, and the
 *      steps that existed before must not have learned about the lab.
 *   2. WITH `lab` ON THE BUILD CANNOT BE THE REAL APP. A consistency step refuses a
 *      lab/app_id mismatch BEFORE anything is built (it is run here, under bash,
 *      not read), the identity is read back out of the GENERATED project, and the
 *      Play upload targets the package it was told to rather than a hard-coded one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { block, code } from "./workflow-yaml.mjs";

/** One step of a COMPOSITE ACTION by name fragment. (workflow-yaml's `step` splits on
 *  the six-space indent of a workflow job's steps; an action's steps sit at four.) */
function step(src, nameFragment) {
  const chunks = src.split(/\n(?= {4}- (?:name|uses):)/).filter((c) => /^\s*- (?:name|uses):/.test(c));
  return chunks.find((c) => c.includes(nameFragment)) ?? null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const IOS = read(".github/actions/ios-archive/action.yml");
const AND = read(".github/actions/android-bundle/action.yml");
const REAL_ICON_STEP_IOS = "Put the REAL app icon";
const CONSISTENCY = "Lab variant - which app is this?";

function runOf(chunk) {
  const lines = chunk.split("\n");
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.ok(at >= 0, "no run: | block");
  const lead = (l) => l.length - l.trimStart().length;
  const body = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "" && lead(lines[i]) <= lead(lines[at])) break;
    body.push(lines[i]);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map(lead));
  return body.map((l) => l.slice(indent)).join("\n");
}

function findBash() {
  for (const c of ["bash", "C:/Program Files/Git/bin/bash.exe", "/usr/bin/bash"]) {
    const r = spawnSync(c, ["-c", "echo $((40+2))"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "42") return c;
  }
  return null;
}
const BASH = findBash();
const needBash = { skip: BASH ? false : "no usable bash here; CI (ubuntu) runs this" };

/** A throwaway checkout holding just what the consistency step touches. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-action-"));
  for (const rel of ["tools/mobile/lab-variant.mjs", "tools/brand/png.mjs", "mobile/capacitor.config.json"]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  fs.writeFileSync(path.join(dir, "GITHUB_ENV"), "");
  return dir;
}

function runConsistency(action, { lab, appId, appName = "4a Lab" }) {
  const dir = scratch();
  const script = path.join(dir, "step.sh");
  fs.writeFileSync(script, runOf(step(action, CONSISTENCY)));
  const r = spawnSync(BASH, ["step.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, LAB: lab, APP_ID_IN: appId, APP_NAME_IN: appName, GITHUB_ENV: path.join(dir, "GITHUB_ENV").replace(/\\/g, "/") },
  });
  return {
    status: r.status,
    out: (r.stdout || "") + (r.stderr || ""),
    env: fs.readFileSync(path.join(dir, "GITHUB_ENV"), "utf8"),
    config: JSON.parse(fs.readFileSync(path.join(dir, "mobile/capacitor.config.json"), "utf8")),
  };
}

for (const [label, action, labSteps] of [["ios-archive", IOS, 3], ["android-bundle", AND, 5]]) {
  test(`${label}: new inputs default to the REAL app, so release.yml's call is unchanged`, () => {
    /* MUTATION: `default: "false"` -> `default: "true"` on `lab` (or the app_id default
       -> the lab id) -> the real release path would build the lab app (red). */
    const inputs = block(code(action), "inputs", 0);
    assert.match(inputs, /^ {2}lab:[\s\S]*?default: "false"/m);
    assert.match(inputs, /^ {2}app_id:[\s\S]*?default: "ai\.jwlabs\.foura"/m);
    /* MUTATION: app_name default "4a Lab" -> "4a Tactile" -> an old caller that passes no name gets Tactile (red). */
    assert.match(inputs, /^ {2}app_name:[\s\S]*?default: "4a Lab"/m);
    const rel = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
    assert.ok(!/\blab:|app_id:/.test(code(rel)), "release.yml passes a lab input; the real build must not know about the lab");
  });

  test(`${label}: every lab step is skipped unless inputs.lab == 'true' (except the consistency check, which guards both values)`, () => {
    /* MUTATION: drop `if: inputs.lab == 'true'` from any "Lab variant -" step -> red. */
    const chunks = action.split(/\n(?= {4}- (?:name|uses):)/).filter((c) => /^\s*- name: Lab variant -/.test(c));
    assert.equal(chunks.length, labSteps, `expected ${labSteps} lab steps, found ${chunks.length}: a lab step that is not named "Lab variant -" escapes this check`);
    for (const c of chunks) {
      const name = /- name: (.*)/.exec(c)[1];
      if (name.startsWith(CONSISTENCY)) {
        assert.ok(!/\n\s+if:/.test(c), "the consistency check must run for BOTH values of lab");
      } else {
        assert.match(c, /\n\s+if: inputs\.lab == 'true'\n/, `${name} is not conditional on lab`);
      }
    }
  });

  test(`${label}: the consistency step REFUSES a lab/app_id mismatch and runs before anything is built`, needBash, () => {
    /* MUTATION: delete either `!=` comparison in the step -> the matching row below goes red. */
    const real = "ai.jwlabs.foura", lab = "ai.jwlabs.foura.lab";
    const tactile = "ai.jwlabs.foura.lab.tactile";
    /* MUTATION (names): delete the `lab=false takes no app_name` check -> the
       ["false", real, "4a Tactile"] row is accepted; replace the lab-id `case`
       with `*) ;;` -> the ".lab.other" row is accepted. */
    for (const [l, id, nm] of [["true", real], ["false", lab], ["true", ""], ["maybe", lab], ["", real],
      ["true", `${lab}.other`], ["true", lab, "4a"], ["true", tactile, ""], ["true", lab, "Real App"], ["false", real, "4a Tactile"]]) {
      const r = runConsistency(action, { lab: l, appId: id, appName: nm });
      assert.notEqual(r.status, 0, `lab=${JSON.stringify(l)} app_id=${JSON.stringify(id)} app_name=${JSON.stringify(nm)} was accepted`);
      assert.equal(r.config.appId, real, "a refused run still edited the config");
      assert.equal(r.env, "", "a refused run still set FORAY_LAB");
    }
    const build = action.indexOf(label === "ios-archive" ? "Build the webDir and generate the iOS project" : "Build the webDir and generate the Android project");
    assert.ok(action.indexOf(CONSISTENCY) > 0 && action.indexOf(CONSISTENCY) < build, "the consistency step must precede the project generation");
  });

  test(`${label}: lab=true rewrites the checked-out config and sets FORAY_LAB=1; lab=false touches nothing`, needBash, () => {
    /* MUTATION: drop `echo "FORAY_LAB=1" >> "$GITHUB_ENV"` -> the lab bundle ships
       WITHOUT the flag and writes to production (red). */
    const on = runConsistency(action, { lab: "true", appId: "ai.jwlabs.foura.lab" });
    assert.equal(on.status, 0, on.out);
    assert.equal(on.config.appId, "ai.jwlabs.foura.lab");
    assert.equal(on.config.appName, "4a Lab");
    assert.match(on.env, /^FORAY_LAB=1$/m);
    /* The per-direction apps: Tactile gets its own id, Ambient keeps the lab id under its own name.
       MUTATION: drop `--app-id "$APP_ID_IN" --app-name "$APP_NAME_IN"` from the apply-config call
       -> Tactile and Ambient both build as plain "4a Lab" (red). */
    const tac = runConsistency(action, { lab: "true", appId: "ai.jwlabs.foura.lab.tactile", appName: "4a Tactile" });
    assert.equal(tac.status, 0, tac.out);
    assert.equal(tac.config.appId, "ai.jwlabs.foura.lab.tactile");
    assert.equal(tac.config.appName, "4a Tactile");
    const amb = runConsistency(action, { lab: "true", appId: "ai.jwlabs.foura.lab", appName: "4a Ambient" });
    assert.equal(amb.status, 0, amb.out);
    assert.equal(amb.config.appId, "ai.jwlabs.foura.lab");
    assert.equal(amb.config.appName, "4a Ambient");
    const off = runConsistency(action, { lab: "false", appId: "ai.jwlabs.foura" });
    assert.equal(off.status, 0, off.out);
    assert.equal(off.config.appId, "ai.jwlabs.foura");
    assert.equal(off.config.appName, "4a");
    assert.equal(off.env, "");
  });
}

test("ios-archive: the lab reads the bundle id, display name and flag back out of the generated project", () => {
  const s = step(IOS, "Lab variant - read the identity back");
  assert.ok(s);
  /* MUTATION: hard-code `ai.jwlabs.foura.lab` back into the grep -> a Tactile build is
     "verified" against the wrong id and fails (or, worse, an Ambient id passes Tactile). */
  assert.match(s, /PRODUCT_BUNDLE_IDENTIFIER = \$APP_ID_IN;/);
  assert.match(s, /PRODUCT_BUNDLE_IDENTIFIER = ai\.jwlabs\.foura;/, "the real id must be asserted ABSENT");
  assert.match(s, /CFBundleDisplayName/);
  assert.match(s, /"\$DISPLAY_NAME" = "\$APP_NAME_IN"/);
  assert.match(s, /APP_ID_IN: \$\{\{ inputs\.app_id \}\}/);
  assert.match(s, /APP_NAME_IN: \$\{\{ inputs\.app_name \}\}/);
  assert.match(s, /foray-lab\.js/);
  assert.ok(IOS.indexOf("Lab variant - read the identity back") > IOS.indexOf("Build the webDir and generate the iOS project"));
});

/** A generated Android project as `npx cap add android` leaves it: ONE build file
 *  (Groovy build.gradle today), strings.xml, and the copied web bundle. */
function runAndroidReadBack({ appId = "ai.jwlabs.foura.lab", name = "4a Lab", kts = false, flag = true, wantId = "ai.jwlabs.foura.lab", wantName = "4a Lab" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-readback-"));
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  put(`mobile/android/app/build.gradle${kts ? ".kts" : ""}`, kts ? `android {\n    defaultConfig {\n        applicationId = "${appId}"\n    }\n}\n` : `android {\n    defaultConfig {\n        applicationId "${appId}"\n    }\n}\n`);
  put("mobile/android/app/src/main/res/values/strings.xml", `<resources>\n    <string name="app_name">${name}</string>\n</resources>\n`);
  put("mobile/android/app/src/main/assets/public/foray-lab.js", flag ? "window.__FORAY_LAB__ = true;\n" : "\n");
  put("mobile/android/app/src/main/assets/public/index.html", '<script src="foray-lab.js"></script>\n');
  fs.writeFileSync(path.join(dir, "step.sh"), runOf(step(AND, "Lab variant - read the identity back")));
  const r = spawnSync(BASH, ["step.sh"], { cwd: dir, encoding: "utf8", env: { ...process.env, APP_ID_IN: wantId, APP_NAME_IN: wantName } });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

test("android-bundle: the identity read-back RUNS clean on a generated project and refuses a wrong one", needBash, () => {
  /* The text-only test above passed while this step died on its first real runner:
     `GRADLE=$(ls build.gradle build.gradle.kts 2>/dev/null | head -1)` exits 2 under
     pipefail because only one of the two files exists.
     MUTATION: restore that `ls ... | head -1` line -> the first assertion goes red (status 2). */
  const ok = runAndroidReadBack();
  assert.equal(ok.status, 0, ok.out);
  const okKts = runAndroidReadBack({ kts: true });
  assert.equal(okKts.status, 0, okKts.out);
  /* MUTATION: delete the "still declares the REAL applicationId" if-block AND the
     lab-id grep -> the real-id row is accepted (red). */
  /* MUTATION: hard-code `ai.jwlabs.foura.lab` / '4a Lab' back into the two greps -> the
     tactile row below is refused (red), and the "id of the other direction" row is accepted. */
  const tac = runAndroidReadBack({ appId: "ai.jwlabs.foura.lab.tactile", name: "4a Tactile", wantId: "ai.jwlabs.foura.lab.tactile", wantName: "4a Tactile" });
  assert.equal(tac.status, 0, tac.out);
  const amb = runAndroidReadBack({ name: "4a Ambient", wantName: "4a Ambient" });
  assert.equal(amb.status, 0, amb.out);
  for (const [label, opts] of [["real application id", { appId: "ai.jwlabs.foura" }], ["real app name", { name: "4a" }], ["no lab flag", { flag: false }],
    ["project has the plain lab id but Tactile was asked", { wantId: "ai.jwlabs.foura.lab.tactile", wantName: "4a Tactile", name: "4a Tactile" }],
    ["project has the Tactile id but plain lab was asked", { appId: "ai.jwlabs.foura.lab.tactile" }],
    ["project name is Lab but Ambient was asked", { wantName: "4a Ambient" }]]) {
    const r = runAndroidReadBack(opts);
    assert.equal(r.status, 1, `${label} was accepted: ${r.out}`);
    assert.match(r.out, /::error::/, `${label} failed without saying why`);
  }
});

test("ios-archive: the archive and ExportOptions are keyed on the input, the lab icon follows the real one with --source", () => {
  /* MUTATION: `APP_ID: ${{ inputs.app_id }}` -> `APP_ID: ai.jwlabs.foura` -> the lab
     profile is mapped to the REAL bundle id in ExportOptions and signing fails (red). */
  assert.match(code(IOS), /^\s+APP_ID: \$\{\{ inputs\.app_id \}\}$/m);
  assert.ok(!/APP_ID: ai\.jwlabs\.foura\s*$/m.test(code(IOS)));
  const real = step(IOS, REAL_ICON_STEP_IOS);
  assert.ok(!/lab|--source/i.test(real), "the real icon step learned about the lab");
  const lab = step(IOS, "Lab variant - replace the icon");
  assert.match(lab, /lab-variant\.mjs icon "\$RUNNER_TEMP\/lab-icon-1024\.png"/);
  assert.match(lab, /inject-app-icon\.mjs [^\n]*--source "\$RUNNER_TEMP\/lab-icon-1024\.png"/);
  assert.match(lab, /--check --source/);
  assert.ok(IOS.indexOf("Lab variant - replace the icon") > IOS.indexOf(REAL_ICON_STEP_IOS));
});

test("android-bundle: the lab reads applicationId, name and flag back; the icon uses --icon; the Play upload targets app_id", () => {
  /* MUTATION: `packageName: ${{ inputs.app_id }}` -> `packageName: ai.jwlabs.foura`
     -> the lab's AAB goes to the REAL app's Play listing (red). */
  const s = step(AND, "Lab variant - read the identity back");
  assert.ok(s);
  assert.match(s, /applicationId\[ =\]\+\\"\$\{APP_ID_IN\/\/\.\/\\\\\.\}\\"/);
  assert.match(s, /still declares the REAL applicationId/);
  assert.match(s, /app_name\\">\$APP_NAME_IN</);
  assert.match(s, /APP_ID_IN: \$\{\{ inputs\.app_id \}\}/);
  assert.match(s, /foray-lab\.js/);
  const icon = step(AND, "Lab variant - replace the launcher icon");
  assert.match(icon, /inject-splash\.mjs android [^\n]*--icon "\$RUNNER_TEMP\/lab-icon-1024\.png"/);
  assert.match(icon, /--check --icon/);
  const c = code(AND);
  assert.match(c, /^\s+packageName: \$\{\{ inputs\.app_id \}\}$/m);
  assert.ok(!/packageName: ai\.jwlabs\.foura\s*$/m.test(c));
  assert.match(c, /name: \$\{\{ inputs\.artifact_name \}\}/);
  assert.match(AND, /default: "foray-android-release"/);
});

test("android-bundle: the lab also builds a debug APK and keeps it as a run artifact", () => {
  const apk = step(AND, "Lab variant - also build a debug APK");
  assert.match(apk, /gradlew assembleDebug/);
  assert.match(apk, /app\/build\/outputs\/apk\/debug\/app-debug\.apk/);
  const keep = step(AND, "Lab variant - keep the APK");
  assert.match(keep, /name: foray-lab-android-apk/);
  assert.match(keep, /if-no-files-found: error/);
  assert.ok(AND.indexOf("Lab variant - also build a debug APK") > AND.indexOf("Shred the upload key"), "the APK step must come after the key is shredded");
});

test("the lab never reads the keystore in its APK step", () => {
  const apk = step(AND, "Lab variant - also build a debug APK");
  assert.ok(!/KEYSTORE|FORAY_KEY|secrets\./.test(apk), "the debug APK step touches signing material");
});
