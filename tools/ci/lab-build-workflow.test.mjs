/* `.github/workflows/lab-build.yml` — the 4a Lab build (Redesign 2026, phase 0e).
 *
 * WHAT IS AT STAKE. This workflow builds a branch with the founders' real Apple
 * and Google signing keys and uploads it to TestFlight and Play. Its one job is
 * to make a SEPARATE app (ai.jwlabs.foura.lab). The failure that matters is the
 * lab path ever building or uploading the REAL app (ai.jwlabs.foura), or running
 * with the secrets from anything but the reviewed copy of this file. So:
 *
 *   - the GUARD is tested by RUNNING it, not by reading it: the step's `run:`
 *     script is extracted from the YAML and executed under bash with a matrix of
 *     refs, so the refusal logic is the logic that ships;
 *   - each refusal is also pinned to hold with the allow-list REMOVED (defence in
 *     depth: main and v* are refused by name AND by not being redesign branches);
 *   - the structure that cannot be run here (triggers, secrets, the lab inputs
 *     reaching the composite actions) is asserted on the YAML with comments
 *     stripped, so prose that argues AGAINST a thing cannot satisfy a test FOR it.
 *
 * The composite actions' lab handling lives on the redesign branches, not on
 * main, so it is pinned in tools/mobile/lab-workflow.test.mjs, not here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { topLevelKeys, block, step, code } from "../mobile/workflow-yaml.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const WF = fs.readFileSync(path.join(ROOT, ".github", "workflows", "lab-build.yml"), "utf8").replace(/\r\n/g, "\n");
const YML = code(WF);

/* ───────────────────────────── running the guard ───────────────────────── */

/** The `run: |` script of the step whose name contains `fragment`, dedented. */
function runScript(fragment) {
  const chunk = step(WF, fragment);
  assert.ok(chunk, `no step named like "${fragment}"`);
  const lines = chunk.split("\n");
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.ok(at >= 0, `step "${fragment}" has no run: | block`);
  const body = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") { body.push(""); continue; }
    if (lines[i].length - lines[i].trimStart().length <= lines[at].length - lines[at].trimStart().length) break;
    body.push(lines[i]);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return body.map((l) => l.slice(indent)).join("\n");
}

function findBash() {
  for (const candidate of ["bash", "C:/Program Files/Git/bin/bash.exe", "/usr/bin/bash"]) {
    const r = spawnSync(candidate, ["-c", "echo $((40+2))"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "42") return candidate;
  }
  return null;
}
const BASH = findBash();

/** Run a guard script; resolves to {allowed, status, out}. */
function runGuard(script, { workflowRef = "refs/heads/main", ref, platforms = "both" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-guard-"));
  const outFile = path.join(dir, "output.txt");
  fs.writeFileSync(outFile, "");
  const scriptFile = path.join(dir, "guard.sh");
  fs.writeFileSync(scriptFile, script);
  const r = spawnSync(BASH, [scriptFile.replace(/\\/g, "/")], {
    encoding: "utf8",
    env: {
      ...process.env,
      WORKFLOW_REF: workflowRef,
      INPUT_REF: ref,
      PLATFORMS: platforms,
      GITHUB_OUTPUT: outFile.replace(/\\/g, "/"),
    },
  });
  const outputs = fs.readFileSync(outFile, "utf8");
  const map = Object.fromEntries(outputs.split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { status: r.status, map, allowed: /allowed=true/.test(outputs), refused: /allowed=false/.test(outputs), out: (r.stdout || "") + (r.stderr || "") };
}

const GUARD = BASH ? runScript("Refuse anything that could ship the real app") : "";
const needBash = { skip: BASH ? false : "no usable bash on this machine; CI (ubuntu) runs this" };

const ALLOWED = [
  "redesign/p0-lab",
  "redesign/p2-direction-aurora",
  "refs/heads/redesign/p0-lab",
  "feature/redesign-2026",
  "feature/redesign-2026-aurora",
];
const REFUSED = [
  ["main", "the real app's branch"],
  ["refs/heads/main", "the real app's branch, fully qualified"],
  ["master", "master"],
  ["HEAD", "HEAD"],
  ["v1.2.0", "a release tag name"],
  ["refs/tags/v1.2.0", "a release tag, fully qualified"],
  ["refs/tags/redesign/x", "a tag that merely looks like a redesign branch"],
  ["v2", "v* branch"],
  ["feature/other", "not a redesign branch"],
  ["fix/audit-copy", "not a redesign branch"],
  ["0123456789abcdef0123456789abcdef01234567", "a bare SHA could be main's commit"],
  ["", "empty"],
  ["redesign/x y", "whitespace"],
  ["redesign/../main", "path traversal"],
  ["redesign/x~1", "revision syntax"],
  ["redesign/x:main", "refspec syntax"],
  ["redesign/*", "glob"],
];

/* ref -> [direction, app id, home-screen name]. The ONE mapping the ios, android and
   summary jobs all read from the guard's outputs. */
const LAB = ["lab", "ai.jwlabs.foura.lab", "4a Lab"];
const TACTILE = ["tactile", "ai.jwlabs.foura.lab.tactile", "4a Tactile"];
const AMBIENT = ["ambient", "ai.jwlabs.foura.lab", "4a Ambient"];
const MAPPING = [
  ["feature/redesign-2026-tactile", TACTILE],
  ["refs/heads/feature/redesign-2026-tactile", TACTILE],
  ["redesign/tactile-p3", TACTILE],
  ["redesign/tactile-", TACTILE],
  ["feature/redesign-2026-ambient", AMBIENT],
  ["redesign/ambient-p4", AMBIENT],
  ["feature/redesign-2026", LAB],
  ["feature/redesign-2026-aurora", LAB],
  ["redesign/p0-lab", LAB],
  ["redesign/tactile", LAB], // only `tactile-*` is the Tactile app: a near miss stays plain lab
  ["redesign/p2-tactile-x", LAB],
  ["redesign/ambient", LAB],
  ["feature/redesign-2026-tactilex", LAB],
];

test("the guard maps each ref to ONE app: id, home-screen name and direction", needBash, () => {
  /* MUTATION A: change the tactile arm's `APP_ID=ai.jwlabs.foura.lab.tactile` to
     `ai.jwlabs.foura.lab` -> Tactile installs over the other direction (red).
     MUTATION B: delete the ambient arm -> Ambient builds as "4a Lab" (red).
     MUTATION C: widen `redesign/tactile-*` to `redesign/*tactile*` -> the
     `redesign/p2-tactile-x` row turns into Tactile (red). */
  for (const [ref, [direction, appId, appName]] of MAPPING) {
    const r = runGuard(GUARD, { ref });
    assert.equal(r.status, 0, `${ref} was refused: ${r.out}`);
    assert.deepEqual([r.map.direction, r.map.app_id, r.map.app_name], [direction, appId, appName], `${ref} maps to the wrong app`);
  }
});

test("a refused ref publishes no app identity, and no mapping ever yields the real app id or name", needBash, () => {
  /* MUTATION: move the `echo app_id=` block above the ref checks -> a refused ref
     leaves an app_id behind (red). */
  for (const [ref] of REFUSED) {
    const r = runGuard(GUARD, { ref });
    assert.equal(r.map.app_id, undefined, `${JSON.stringify(ref)} left an app_id output`);
  }
  for (const [ref] of [...MAPPING, ...ALLOWED.map((x) => [x])]) {
    const { map } = runGuard(GUARD, { ref });
    assert.ok(["ai.jwlabs.foura.lab", "ai.jwlabs.foura.lab.tactile"].includes(map.app_id), `${ref} -> ${map.app_id}`);
    assert.match(map.app_name, /^4a [A-Z][a-z]+$/, `${ref} -> ${map.app_name}`);
  }
});

test("the app-id backstop in the guard refuses a mapping table that went wrong", needBash, () => {
  /* The backstop is the second `case "$APP_ID"` arm. Break the table (the real id)
     and the backstop alone must still refuse. MUTATION: delete the backstop `case`
     -> this goes red. */
  const broken = GUARD.replace("DIRECTION=lab; APP_ID=ai.jwlabs.foura.lab;", "DIRECTION=lab; APP_ID=ai.jwlabs.foura;");
  assert.notEqual(broken, GUARD, "could not break the table");
  const r = runGuard(broken, { ref: "redesign/p0-lab" });
  assert.ok(!r.allowed && r.status !== 0 && r.refused, "a real app id got through the backstop");
});

test("the guard ALLOWS redesign branches and the trunk, dispatched from main", needBash, () => {
  for (const ref of ALLOWED) {
    const r = runGuard(GUARD, { ref });
    assert.equal(r.status, 0, `${ref} was refused: ${r.out}`);
    assert.ok(r.allowed, `${ref} did not set allowed=true`);
  }
});

test("the guard REFUSES main, master, v*, tags, SHAs and anything that is not a redesign branch", needBash, () => {
  /* MUTATION: change the allow-list line `redesign/*|feature/redesign-2026|...) ;;`
     to `*) ;;` -> feature/other, fix/audit-copy and the bare SHA are accepted (red
     here); delete the `main|master|HEAD)` line -> still red only together with the
     allow-list, which is the point of the next test. */
  for (const [ref, why] of REFUSED) {
    const r = runGuard(GUARD, { ref });
    assert.notEqual(r.status, 0, `${JSON.stringify(ref)} (${why}) was NOT refused`);
    assert.ok(!r.allowed, `${JSON.stringify(ref)} (${why}) set allowed=true`);
    assert.ok(r.refused, `${JSON.stringify(ref)} (${why}) did not record allowed=false`);
  }
});

test("main, master, v* and tags are refused BY NAME too, with the allow-list removed (defence in depth)", needBash, () => {
  /* The allow-list alone would refuse these, so a mutation of the named refusals
     would stay green. Take the allow-list away and they must still be refused.
     MUTATION: delete the `main|master|HEAD)` or the `v*)` or the `refs/tags/*)`
     arm -> the matching ref below is accepted (red). */
  const noAllowList = GUARD.replace(/^\s*redesign\/\*\|[^\n]*\) ;;$/m, "  *) ;;");
  assert.notEqual(noAllowList, GUARD, "could not locate the allow-list arm to remove");
  for (const ref of ["main", "refs/heads/main", "master", "HEAD", "v1.2.0", "v2", "refs/tags/v1.2.0", "refs/tags/anything"]) {
    const r = runGuard(noAllowList, { ref });
    assert.ok(!r.allowed && r.status !== 0, `${ref} got through with the allow-list removed`);
  }
});

test("the guard refuses a dispatch from any workflow ref but main, and an unknown platform", needBash, () => {
  /* MUTATION: delete the WORKFLOW_REF check -> a branch's edited copy of this file
     could be dispatched and would run with the signing secrets (red). */
  for (const workflowRef of ["refs/heads/redesign/p0-lab", "refs/heads/feature/x", "refs/tags/v1.0.0"]) {
    const r = runGuard(GUARD, { workflowRef, ref: "redesign/p0-lab" });
    assert.ok(!r.allowed && r.status !== 0, `dispatch from ${workflowRef} was allowed`);
  }
  for (const platforms of ["", "all", "ios,android", "both; rm -rf /"]) {
    const r = runGuard(GUARD, { ref: "redesign/p0-lab", platforms });
    assert.ok(!r.allowed && r.status !== 0, `platforms ${JSON.stringify(platforms)} was allowed`);
  }
  for (const platforms of ["ios", "android", "both"]) {
    assert.ok(runGuard(GUARD, { ref: "redesign/p0-lab", platforms }).allowed, `${platforms} refused`);
  }
});

/* ───────────────────────────── the structure ───────────────────────────── */

test("the ONLY trigger is workflow_dispatch: no push, no schedule, no pull_request", () => {
  /* MUTATION: add `push:` (or `schedule:`) under `on:` -> red. A push trigger
     would run a signing build on every branch push; the lab is a button. */
  const on = block(YML, "on", 0);
  assert.ok(on, "no on: block");
  const keys = [...on.matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ["workflow_dispatch"]);
  assert.ok(!/^\s*(push|pull_request|pull_request_target|schedule|workflow_run|release|repository_dispatch|workflow_call):/m.test(YML), "a forbidden trigger key appears in the workflow");
});

test("the dispatch inputs are ref (required) and platforms (both|ios|android)", () => {
  const inputs = block(YML, "inputs", 4);
  assert.ok(inputs);
  assert.match(inputs, /^\s{6}ref:/m);
  assert.match(inputs, /ref:[\s\S]*?required: true/);
  assert.match(inputs, /^\s{6}platforms:/m);
  assert.match(inputs, /options: \[both, ios, android\]/);
  assert.deepEqual([...inputs.matchAll(/^ {6}([a-z]+):/gm)].map((m) => m[1]), ["ref", "platforms"], "an unexpected input appeared");
});

test("read-only token, one concurrency group that never cancels, a timeout on every job", () => {
  assert.deepEqual(topLevelKeys(WF), ["name", "on", "concurrency", "permissions", "jobs"]);
  assert.match(block(YML, "permissions", 0), /contents: read/);
  assert.ok(!/(contents|actions|id-token|packages|pull-requests|checks): write/.test(YML), "a write permission appeared");
  assert.match(block(YML, "concurrency", 0), /group: lab-build/);
  assert.match(block(YML, "concurrency", 0), /cancel-in-progress: false/);
  const jobs = [...YML.matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)].map((m) => m[1]).filter((j) => j !== "workflow_dispatch");
  assert.deepEqual(jobs, ["guard", "version", "ios", "android", "summary"]);
  for (const j of jobs) {
    const b = block(YML, j, 2);
    assert.match(b, /timeout-minutes: \d+/, `${j} has no timeout-minutes`);
  }
});

test("every job that builds or versions waits on the guard and is skipped unless it allowed", () => {
  /* MUTATION: drop `needs.guard.outputs.allowed == 'true'` from the ios job's `if:`
     -> a refused ref would still archive and sign (red). */
  for (const j of ["version", "ios", "android"]) {
    const b = block(YML, j, 2);
    assert.match(b, /needs: (\[guard(, version)?\]|guard)/, `${j} does not need guard`);
    assert.match(b, /if: needs\.guard\.outputs\.allowed == 'true'/, `${j} is not gated on the guard's verdict`);
  }
  assert.match(block(YML, "ios", 2), /inputs\.platforms == 'ios' \|\| inputs\.platforms == 'both'/);
  assert.match(block(YML, "android", 2), /inputs\.platforms == 'android' \|\| inputs\.platforms == 'both'/);
});

test("every checkout builds inputs.ref, never main or a tag, and inputs reach scripts only through env/with", () => {
  /* MUTATION: `ref: main` on any checkout -> the REAL app's code is built under
     the lab's name (red). `${{ inputs.ref }}` interpolated into a `run:` script is
     shell injection from a dispatch input (red). */
  const checkouts = [...YML.matchAll(/uses: actions\/checkout@v4\n {8}with:\n((?: {10}[^\n]*\n?)*)/g)].map((m) => m[1]);
  assert.equal(checkouts.length, 3, "version, ios and android each check out the ref");
  for (const c of checkouts) assert.match(c, /ref: \$\{\{ inputs\.ref \}\}/);
  for (const line of YML.split("\n")) {
    if (!/\$\{\{\s*inputs\./.test(line)) continue;
    assert.match(line, /^\s+(ref|INPUT_REF|PLATFORMS|REF):\s|^\s+if:\s/, `an input is interpolated somewhere other than with:/env:/if: -> ${line.trim()}`);
  }
  assert.ok(!/\bref: (main|master|refs\/)/.test(YML));
});

test("the iOS job builds the LAB app with the LAB profile, never the real one", () => {
  /* MUTATION: `IOS_LAB_PROVISIONING_PROFILE_BASE64` -> `IOS_PROVISIONING_PROFILE_BASE64`
     (red) -- the real app's profile; `app_id: ai.jwlabs.foura.lab` -> `ai.jwlabs.foura` (red). */
  const b = block(YML, "ios", 2);
  assert.match(b, /uses: \.\/\.github\/actions\/ios-archive/);
  assert.match(b, /lab: "true"/);
  /* MUTATION: `app_id: ${{ needs.guard.outputs.app_id }}` -> `app_id: ai.jwlabs.foura.lab`
     -> the Tactile app is archived under the plain lab id (red). */
  assert.match(b, /app_id: \$\{\{ needs\.guard\.outputs\.app_id \}\}\s*$/m);
  assert.match(b, /app_name: \$\{\{ needs\.guard\.outputs\.app_name \}\}\s*$/m);
  /* THE SECRET CHOICE. Tactile -> its own profile; everything else -> the plain lab
     profile. MUTATION A: swap the two secrets in the expression -> the Tactile app
     is signed with the plain lab profile (red). MUTATION B: `== 'tactile'` ->
     `!= 'tactile'` (red). MUTATION C: drop the "needs its own provisioning profile"
     step -> an unset secret silently falls back to the plain lab profile (red). */
  assert.match(b, /ios_provisioning_profile_base64: \$\{\{ needs\.guard\.outputs\.direction == 'tactile' && secrets\.IOS_LAB_TACTILE_PROVISIONING_PROFILE_BASE64 \|\| secrets\.IOS_LAB_PROVISIONING_PROFILE_BASE64 \}\}/);
  const need = step(b, "needs its own provisioning profile");
  assert.ok(need, "the Tactile-secret presence step is gone");
  assert.match(need, /if: needs\.guard\.outputs\.direction == 'tactile'/);
  assert.match(need, /TACTILE_PROFILE: \$\{\{ secrets\.IOS_LAB_TACTILE_PROVISIONING_PROFILE_BASE64 \}\}/);
  assert.match(need, /\[ -n "\$TACTILE_PROFILE" \] \|\| \{[^}]*exit 1/);
  assert.ok(b.indexOf("needs its own provisioning profile") < b.indexOf("uses: ./.github/actions/ios-archive"), "the presence check must precede the archive");
  const profileSecrets = [...YML.matchAll(/secrets\.(IOS_[A-Z_]*PROVISIONING_PROFILE_BASE64)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(profileSecrets)].sort(), ["IOS_LAB_PROVISIONING_PROFILE_BASE64", "IOS_LAB_TACTILE_PROVISIONING_PROFILE_BASE64"], "a provisioning-profile secret other than the two lab ones is referenced");
  assert.ok(!/secrets\.IOS_PROVISIONING_PROFILE_BASE64/.test(YML), "the real app's provisioning profile is referenced");
  assert.match(b, /secrets\.IOS_DIST_CERT_P12_BASE64/);
  assert.match(b, /secrets\.APP_STORE_CONNECT_PRIVATE_KEY_BASE64/);
});

test("the Android job builds the LAB package, uploads under a lab artifact name, and uses the existing keys", () => {
  const b = block(YML, "android", 2);
  assert.match(b, /uses: \.\/\.github\/actions\/android-bundle/);
  assert.match(b, /lab: "true"/);
  assert.match(b, /app_id: \$\{\{ needs\.guard\.outputs\.app_id \}\}\s*$/m);
  assert.match(b, /app_name: \$\{\{ needs\.guard\.outputs\.app_name \}\}\s*$/m);
  assert.match(b, /artifact_name: foray-lab-android-release/);
  for (const s of ["ANDROID_KEYSTORE_B64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "PLAY_SERVICE_ACCOUNT_JSON"]) {
    assert.match(b, new RegExp(`secrets\\.${s}`), `${s} is not passed`);
  }
});

test("each build job refuses a ref whose actions cannot build the lab, BEFORE running the action", () => {
  /* An older branch whose composite action ignores `lab` would build and upload the
     REAL package (android-bundle hard-codes packageName on main). MUTATION: delete
     the `grep -q "inputs.lab"` check in the android job -> red. */
  for (const [job, action] of [["ios", "ios-archive"], ["android", "android-bundle"]]) {
    const b = block(YML, job, 2);
    const gate = b.indexOf("must carry the lab build path");
    const use = b.indexOf(`uses: ./.github/actions/${action}`);
    assert.ok(gate > 0 && use > 0 && gate < use, `${job}: the lab-path check must precede the action`);
    assert.match(b, new RegExp(`grep -q "inputs\\.lab" \\.github/actions/${action}/action\\.yml`));
    assert.match(b, /test -f tools\/mobile\/lab-variant\.mjs/);
    /* MUTATION: delete the `grep -q "inputs.app_name"` line -> an old ref whose action
       cannot take a name builds "4a Lab" under an Ambient/Tactile dispatch (red). */
    assert.match(b, new RegExp(`grep -q "inputs\\.app_name" \\.github/actions/${action}/action\\.yml \\|\\| \\{[^}]*exit 1`));
  }
});

test("the summary table shows the ACTUAL app id and name from the guard, and the Play/TestFlight targets follow app_id", () => {
  /* MUTATION: put a literal `ai.jwlabs.foura.lab` back in a summary row -> a Tactile
     run reports the wrong app (red). */
  const b = block(YML, "summary", 2);
  assert.match(b, /needs: \[guard, version, ios, android\]/);
  assert.match(b, /APP_ID: \$\{\{ needs\.guard\.outputs\.app_id \}\}/);
  assert.match(b, /APP_NAME: \$\{\{ needs\.guard\.outputs\.app_name \}\}/);
  assert.match(b, /iOS \/ TestFlight \(\$\{APP_ID\}\)/);
  assert.match(b, /Android \/ Play internal \(\$\{APP_ID\}\)/);
  assert.ok(!/ai\.jwlabs\.foura\./.test(b), "the summary hard-codes an app id");
});

test("a re-run is refused (it would replay attempt 1's build number)", () => {
  for (const job of ["ios", "android"]) assert.match(block(YML, job, 2), /if: github\.run_attempt != '1'/);
});

test("the workflow never tags, releases, pushes, or touches the real app's workflows", () => {
  assert.ok(!/git push|git tag|gh release|gh workflow run|release\.yml|pages\.yml|android-release\.yml/.test(YML), "the lab workflow reaches the release machinery");
  assert.ok(!/packageName:\s*ai\.jwlabs\.foura\s*$/m.test(YML));
  assert.ok(!/\bai\.jwlabs\.foura(?![.\w])/.test(YML.replace(/\bai\.jwlabs\.foura\.lab\b/g, "")), "the real application id appears in the workflow's code");
});
