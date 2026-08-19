/* The Android workflow's own invariants (#245).
 *
 * BE HONEST ABOUT WHAT THIS FILE CAN AND CANNOT DO. It cannot run a workflow, so
 * it cannot tell you the build works — only a linked run can, and the PR body
 * says which one. What it CAN do is hold the properties that would otherwise rot
 * silently, every one of which is a decision rather than a detail:
 *
 *   - the job stays on LINUX (Android needs no Mac; macOS bills at 10x for
 *     nothing) and stays OFF the required-check list,
 *   - it stays infrequent: no push, no schedule, a narrow path filter,
 *   - it uses NO third-party actions and reads NO secrets, so it stays runnable
 *     on any fork with no credentials at all,
 *   - the JDK stays at 21, which is a build requirement rather than a preference,
 *   - the two checks that only a build can make — that `cap sync` still wires
 *     `foray-audio` in, and that its library manifest still merges — stay in it,
 *   - the release lint gate stays impossible to skip silently,
 *   - no emulator is ever added.
 *
 * THE READING HELPERS ARE SHARED with `ios-workflow.test.mjs`, in
 * `workflow-yaml.mjs`. See that module's header for why they parse rather than
 * grep and where that stops.
 *
 * EVERY TEST BELOW NAMES THE ONE-LINE MUTATION THAT BREAKS IT, per CLAUDE.md
 * § "A green test is not evidence until you have broken it". All of them were
 * run; a green suite on this file means the mutations were reverted, not that
 * they were skipped.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { topLevelKeys, block, prose, step, code, invocationsOf } from "./workflow-yaml.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_REL = ".github/workflows/android-build.yml";
const WF = fs.readFileSync(path.join(ROOT, WORKFLOW_REL), "utf8");
/* EVERY NEGATIVE ASSERTION BELOW READS `YML`, NOT `WF`, and that is not a
   nicety: this workflow's header argues at length against macOS runners,
   third-party actions, emulators and a hardcoded AGP intermediates path, so it
   NAMES all four. A whole-file regex for the forbidden thing finds the argument
   against it and reports the thing itself. `code()` strips the full-line
   comments so the assertion is about the YAML GitHub executes. */
const YML = code(WF);
const CI = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");

/** Every `./gradlew` COMMAND in the workflow, one joined line each. */
function gradlewInvocations(src) {
  return invocationsOf(src, "./gradlew");
}

/** One step, COMMENTS STRIPPED, by a fragment of its name.
 *
 *  THREE ASSERTIONS BELOW WERE VACUOUS UNTIL THIS EXISTED, and the mutation run
 *  is what found them — the failure CLAUDE.md § "A green test is not evidence
 *  until you have broken it" records five times, once more:
 *
 *    - deleting the `grep -q "':foray-audio'"` line left every test green,
 *      because the NEXT check's error message contains the string `':foray-audio'`.
 *      The assertion was matching an error message about the check, not the check.
 *    - deleting the `*SKIPPED*` case arm left every test green, because the step's
 *      comment shouts "A GREEN RELEASE BUILD THAT SKIPPED LINT".
 *    - deleting `if: always()` left every test green, because a shell comment
 *      inside the same step explains what `if: always()` means.
 *
 *  So every content assertion about a step reads the step's CODE. The comments in
 *  this workflow argue in detail about the very things these tests forbid and
 *  require, which makes the whole file the most forgiving possible fixture for
 *  itself. */
function stepCode(nameFragment) {
  const s = step(WF, nameFragment);
  return s === null ? null : code(s);
}

/* ────────────────────────── shape and trigger set ────────────────────────── */

test("the workflow exists and its top-level keys are the expected five", () => {
  /* MUTATION: delete the `permissions:` block -> fails (four keys, not five).
     The same five as ios-build.yml, deliberately: two workflows that build the
     two halves of the same shell should not have two different shapes. */
  assert.deepEqual(topLevelKeys(WF), ["name", "on", "concurrency", "permissions", "jobs"]);
});

test("it runs on LINUX, because Android is the half that does not need a Mac", () => {
  /* MUTATION: `runs-on: macos-latest` -> fails.
     This is the whole cost argument for having both APK configurations here.
     macOS runners bill at 10x and add NOTHING to an Android build; ios-build.yml
     had to argue for each of its two builds because of that multiplier. If this
     line ever says macos, the job gets ten times more expensive and no better. */
  assert.match(WF, /^ {4}runs-on: ubuntu-latest$/m);
  assert.equal(
    /runs-on: macos/.test(YML),
    false,
    "an Android build on a macOS runner costs 10x and learns nothing extra"
  );
});

test("it is manually dispatchable and path-filtered, and never runs on a push", () => {
  /* MUTATION: add `push:\n    branches: [main]` inside `on:` -> fails.
     A push trigger would re-run, on every merge, a job that already ran on the
     PR — a second full Gradle build for zero new information. `schedule:` would
     add runs on days nothing changed. Free minutes are not a reason to spend
     them: the sister project spent a build freeze suspecting exhausted Actions
     minutes (#1641 there). */
  const on = block(WF, "on");
  assert.ok(on, "no `on:` block");
  assert.match(on, /workflow_dispatch:/);
  assert.match(on, /pull_request:/);
  assert.equal(/^\s{2}push:/m.test(on), false, "a push trigger would run this on every merge to main");
  assert.equal(/^\s{2}schedule:/m.test(on), false, "a schedule would run this on days nothing changed");
});

test("the trigger is `paths`, not `paths-ignore`", () => {
  /* MUTATION: change `paths:` to `paths-ignore:` -> fails.
     ONE WORD, AND IT DEFEATED THE iOS SUITE ONCE: every other assertion here is
     about the LIST, and the list is identical either way, while the trigger is
     inverted — a full Gradle build on every PR that does NOT touch the shell,
     which is every nightly content PR. */
  const on = block(WF, "on");
  assert.match(on, /^ {4}paths:$/m, "the pull_request trigger must filter with `paths:`");
  assert.equal(
    /paths-ignore/.test(YML),
    false,
    "`paths-ignore` INVERTS the filter — this job would run on every PR that does not touch the shell"
  );
});

test("the path filter covers what the shell is built from, and nothing broader", () => {
  /* MUTATION: delete the `"mobile/**"` line -> fails. Or add `"data/**"` -> fails.
     The same list as ios-build.yml, for the same reason: both jobs build the same
     webDir out of the same files. */
  const on = block(WF, "on");
  for (const p of ['"mobile/**"', '"tools/mobile/**"', '"index.html"', '"app.js"', '"player/**"']) {
    assert.ok(on.includes(p), `the path filter is missing ${p}`);
  }
  /* The workflow's own path is in the filter deliberately: a CI-only change can
     only be reviewed against real output, so the PR that edits this file must
     trigger it. #245's PR is the first instance of exactly that. */
  assert.ok(on.includes(`"${WORKFLOW_REL}"`), "the workflow must trigger on changes to itself");
  for (const wide of ['"data/**"', '"docs/**"', '"backend/**"', '"**"', '"test/**"']) {
    assert.equal(on.includes(wide), false, `${wide} in the path filter defeats the point of having one`);
  }
});

test("concurrency cancels superseded runs", () => {
  /* MUTATION: `cancel-in-progress: false` -> fails.
     Three pushes to a PR branch in five minutes would otherwise be three
     ~20-minute Gradle builds, two of them for code nobody will merge. */
  const c = block(WF, "concurrency");
  assert.ok(c);
  assert.match(c, /cancel-in-progress: true/);
});

test("it asks for no write permissions", () => {
  /* MUTATION: `contents: write` -> fails. A build job that can push is a build
     job that can rewrite the thing it was asked to check. */
  const p = block(WF, "permissions");
  assert.match(p, /contents: read/);
  for (const w of ["write", "write-all"]) {
    assert.equal(p.includes(w), false, `the Android build has no reason to hold ${w} permission`);
  }
});

test("the job is not named like a required check", () => {
  /* MUTATION: rename the job `data-and-site:` -> fails.
     `protect-main` requires `backend`, `data-and-site` and `path-policy`, matched
     BY NAME. A job called any of those in ANY workflow is reported against the
     same required context, so a 20-minute Gradle build would silently become a
     gate on every content PR. */
  const jobs = block(WF, "jobs");
  const names = jobs
    .split(/\r?\n/)
    .filter((l) => /^ {2}[a-z][\w-]*:/.test(l))
    .map((l) => l.trim().replace(":", ""));
  assert.deepEqual(names, ["android-shell"]);
  for (const required of ["backend", "data-and-site", "path-policy"]) {
    assert.equal(names.includes(required), false, `a job named ${required} collides with a required check`);
  }
});

test("the job has a timeout", () => {
  /* MUTATION: delete `timeout-minutes:` -> fails.
     A Gradle build that hangs on a dependency download holds a runner for
     GitHub's 6-hour default. Both APK configurations took ~30 minutes combined on
     a saturated Windows machine, so the bound is generous, not tight. */
  assert.match(WF, /^ {4}timeout-minutes: \d+$/m);
});

/* ─────────────────────────── the toolchain, pinned ────────────────────────── */

test("the JDK is 21, and the major is ASSERTED in the job rather than only requested", () => {
  /* MUTATION: change `java-version: 21` to `17` -> fails (both halves).
     JDK 21 IS A BUILD REQUIREMENT, NOT A PREFERENCE. Capacitor 8 on JDK 17 dies
     at `:capacitor-android:compileDebugJavaWithJavac` with
     `invalid source release: 21` (docs/android-shell-build.md §1.2), 200 lines
     into a Gradle log. So the job checks `javac -version` itself and fails early
     with a message that names the cause — asking `setup-java` for 21 and trusting
     the answer is how a changed runner image becomes a mystery Gradle failure. */
  const setupJava = step(WF, "actions/setup-java");
  assert.ok(setupJava, "no actions/setup-java step");
  assert.match(setupJava, /java-version: 21\b/);
  assert.match(WF, /javac -version.*\n.*javac 21\\\./s, "the job must verify the JDK major itself");
  assert.equal(
    /java-version: (?!21\b)/.test(YML),
    false,
    "Capacitor 8 requires JDK 21 — 17 fails at compileDebugJavaWithJavac"
  );
});

test("the SDK platform and build-tools are pinned, not left to the runner image", () => {
  /* MUTATION: delete the `SDK_PLATFORM` env line -> fails.
     The runner image ships AN Android SDK; it does not promise WHICH platform and
     build-tools are in it, and `compileSdkVersion`/`targetSdkVersion` are 36
     (Capacitor's own variables.gradle). An image that drops android-36 must fail
     at the install step with a clear message, not deep inside Gradle. */
  assert.match(WF, /SDK_PLATFORM: platforms;android-36/);
  assert.match(WF, /SDK_BUILD_TOOLS: build-tools;36\.0\.0/);
  assert.match(WF, /sdkmanager/, "the pinned packages must actually be installed");
});

test("every action is GitHub's own, pinned to a major", () => {
  /* MUTATION: add `- uses: android-actions/setup-android@v3` -> fails.
     docs/android-shell-build.md §3 sketched this job WITH that action; it is
     deliberately not used. A third-party action runs arbitrary code with the
     job's token on every run, and all it buys is a wrapper around three
     `sdkmanager` lines. This test is the thing that keeps that decision from
     being undone by a convenience commit. */
  const uses = WF.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(- )?uses:/.test(l))
    .map((l) => l.replace(/^(- )?uses:\s*/, ""));
  assert.ok(uses.length >= 4, `expected at least four actions, found ${uses.length}`);
  for (const u of uses) {
    assert.match(u, /^actions\/[\w-]+@v\d+$/, `${u} is not a major-pinned first-party actions/* action`);
  }
});

test("nothing in the job reads a secret, so it runs on any fork", () => {
  /* MUTATION: add `env: FOO: ${{ secrets.GITHUB_TOKEN }}` to any step -> fails.
     THE ANDROID SIDE IS THE HALF WITH NO CREDENTIAL PROBLEM, and that is worth
     protecting. ios-build.yml needs a whole gated signing section because a
     device build needs Apple credentials that do not exist; an unsigned Android
     release APK is the correct final artefact here (no keystore, no Play
     account), so the moment this job needs a secret, someone has quietly made
     signing a CI concern instead of a founder action. */
  assert.equal(
    /secrets\./.test(YML),
    false,
    "an unsigned Android build needs no secret — signing is a founder action (HUMAN-ACTIONS.md)"
  );
});

test("no emulator is created, booted or installed", () => {
  /* MUTATION: add `avdmanager create avd -n ci -k "system-images;android-36;..."` -> fails.
     docs/research/mp1-background-audio.md §6.2 already paid ~75 minutes to
     establish that an emulator produces nothing here, and #245's toolchain copy
     deliberately left `emulator` (1.1 GB) and `system-images` (8.5 GB) behind for
     the same reason. An emulator is also the most likely way to blow the timeout
     while proving nothing a device would not prove in five minutes. */
  for (const forbidden of ["avdmanager", "system-images;", "emulator -avd", "reactivecircus/android-emulator"]) {
    assert.equal(YML.includes(forbidden), false, `${forbidden} adds an emulator this job argues against`);
  }
});

/* ───────────── the two checks that ONLY a build can make ──────────────────── */

test("the job asserts our own native code survived the regeneration", () => {
  /* MUTATION: delete the `grep -q "':foray-audio'"` line -> fails.
     THE HIGHEST-VALUE ASSERTION IN THE JOB, and the only place in this repo where
     the mechanism is checked at all. `mobile/android/` is not committed, so
     `cap sync` re-derives `foray-audio`'s include and implementation lines from
     `mobile/package.json` on every generation. If that stops happening, the
     mediaPlayback foreground service and the Media3 lock-screen session leave the
     APK and BOTH BUILDS BELOW STILL GO GREEN — a feature deleted by a green run,
     with no committed file for a unit test to read. Both halves are checked
     because they are separate files with separate failure modes: an included
     module that is not an app dependency compiles and ships nothing. */
  const s = stepCode("native code survived the regeneration");
  assert.ok(s, "no step checks that cap sync still wires the plugin in");
  /* THE GREP COMMANDS, not the strings: deleting the settings-file check left the
     string `':foray-audio'` behind in the NEXT check's error message, and an
     assertion on the string alone stayed green. */
  assert.match(
    s,
    /grep -q "':foray-audio'" capacitor\.settings\.gradle/,
    "the settings include line must be asserted by a grep that fails the job"
  );
  assert.match(
    s,
    /grep -q "foray-audio" app\/capacitor\.build\.gradle/,
    "the app dependency line must be asserted too — an included module that is not a dependency ships nothing"
  );
  assert.equal(
    (s.match(/exit 1/g) ?? []).length >= 2,
    true,
    "each check must FAIL the job, not merely print"
  );
});

test("the merged manifest is checked for the service, its type and both permissions", () => {
  /* MUTATION: delete the `android:foregroundServiceType="mediaPlayback"` needle
     -> fails.
     docs/android-native-code.md §4.2: a library manifest that fails to merge
     BUILDS SILENTLY and throws at runtime. The four needles are four separate
     runtime failures, not one — and `mediaPlayback` specifically is the only
     service type with no runtime prerequisite and NO TIMEOUT, which a 45-to-90
     minute Foray depends on (docs/research/mp1-background-audio.md §5.3). */
  const s = stepCode("library manifest merged");
  assert.ok(s, "no step reads the merged manifest");
  for (const needle of [
    "com.jwincorporated.foray.audio.PlaybackKeepAliveService",
    'android:foregroundServiceType="mediaPlayback"',
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
  ]) {
    assert.ok(s.includes(needle), `the merged-manifest check does not look for ${needle}`);
  }
  /* And the two halves inside the APK itself, the same pair §4.2 read by hand. */
  assert.match(s, /grep -qF 'assets\/public\/foray-audio-shell\.js'/);
  assert.match(s, /grep -qF 'com\.jwincorporated\.foray\.audio\.ForayAudioPlugin'/);
});

test("the merged manifest is FOUND, not path-assumed", () => {
  /* MUTATION: replace the `find` with a literal
     `app/build/intermediates/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml`
     -> fails.
     That path is an AGP internal and has moved between AGP versions. Hardcoding
     it would make an AGP bump — which this job deliberately does NOT treat as a
     failure elsewhere — look like a manifest merge failure, which is the one
     thing this step exists to detect. */
  const s = stepCode("library manifest merged");
  assert.match(s, /find app\/build\/intermediates\/merged_manifest -name AndroidManifest\.xml/);
  assert.equal(
    /processDebugMainManifest/.test(YML),
    false,
    "the AGP intermediates layout must not be hardcoded"
  );
});

/* ──────────────────────────── the builds themselves ───────────────────────── */

test("both configurations are BUILT, not merely mentioned", () => {
  /* MUTATION: delete the `assembleRelease` step -> fails.
     `assembleDebug` is the installable artefact; `assembleRelease` is a different
     compile (R8, resource shrinking) and is the ONLY way `lintVitalRelease` runs.
     Asserted against real gradlew INVOCATIONS rather than against the file text,
     so a mention in a comment cannot satisfy it. */
  const calls = gradlewInvocations(WF);
  assert.ok(
    calls.some((c) => /gradlew assembleDebug\b/.test(c)),
    `no assembleDebug invocation; found: ${JSON.stringify(calls)}`
  );
  assert.ok(
    calls.some((c) => /gradlew assembleRelease\b/.test(c)),
    `no assembleRelease invocation; found: ${JSON.stringify(calls)}`
  );
  for (const c of calls) {
    assert.match(c, /--console=plain/, `${c} must use --console=plain: the log's task lines are parsed`);
  }
});

test("the release lint gate cannot be skipped silently", () => {
  /* MUTATION: add `-x lintVitalRelease` to the assembleRelease command -> fails
     (the exclusion assertion). Second MUTATION: delete the `*SKIPPED*` case arm
     -> fails (the executed assertion).
     A GREEN RELEASE BUILD THAT SKIPPED LINT PROVES LESS THAN IT LOOKS.
     `lintVitalRelease` can be excluded on the command line, switched off by a
     `lint { checkReleaseBuilds false }` block a future Capacitor template adds,
     or renamed by AGP — and `assembleRelease` prints BUILD SUCCESSFUL in all
     three cases. So the job asserts the task both APPEARED and EXECUTED. */
  const s = stepCode("lintVitalRelease gets run");
  assert.ok(s, "no assembleRelease step");
  /* THE ASSIGNMENT, not the grep. A mutation that left the grep text in place as a
     discarded sub-shell (`LINTLINE=ok; : $(grep -E ...)`) survived an assertion on
     the grep alone. Matching `LINTLINE=$(grep ...)` requires the log search to be
     what the verdict is READ FROM. This is the honest limit of a text-based test:
     it can pin that the value comes from the search, and it cannot execute the
     shell to prove the branch below is reached. */
  assert.match(
    s,
    /LINTLINE=\$\(grep -E '\^> Task :app:lintVitalRelease/,
    "the lint verdict must be READ FROM the log, not merely mentioned near it"
  );
  assert.match(s, /\*SKIPPED\*\|\*NO-SOURCE\*/, "a registered-but-not-run lint task must fail the job");
  for (const c of gradlewInvocations(WF)) {
    assert.equal(
      /(-x|--exclude-task)\s/.test(c),
      false,
      `${c} excludes a task — the release lint gate is the one that must not be excluded`
    );
  }
});

test("neither build step can be made unable to fail", () => {
  /* MUTATION: add `continue-on-error: true` to the assembleDebug step -> fails.
     ios-build.yml uses that flag legitimately, on its simulator steps: a
     simulator that will not boot is a MEASUREMENT failure, and turning a good
     build red for it conflates the two. THIS JOB HAS NO MEASUREMENT STEPS AT ALL
     — every step is a verdict — so the flag has no legitimate use here and its
     presence anywhere would mean a broken build reporting green. */
  assert.equal(
    /continue-on-error/.test(YML),
    false,
    "every step in this job is a build verdict; none of them may be allowed to fail quietly"
  );
});

test("a failed run still reports and still uploads", () => {
  /* MUTATION: delete `if: always()` from the report step -> fails.
     The log of a FAILED build is the most useful thing in the run, and a run with
     no summary at all reads as "fine". */
  /* ANCHORED AS STEP-LEVEL YAML AT EIGHT SPACES, not as the substring
     `if: always()`. Deleting the real key left the suite green, because a shell
     comment inside the same step explains what `if: always()` is for. */
  for (const name of ["What this run established", "Upload everything this run learned"]) {
    const s = step(WF, name);
    assert.ok(s, `no ${name} step`);
    assert.match(s, /^ {8}if: always\(\)$/m, `${name} must run even when the build failed`);
  }
});

test("the artifact upload path is exactly the report directory, not all of RUNNER_TEMP", () => {
  /* MUTATION: change the path to `${{ runner.temp }}` -> fails.
     RUNNER_TEMP holds whatever every other action left there — Gradle temp files,
     npm caches, and anything a future step writes. Uploading the whole of it is
     how something unintended gets published from a build that looked routine. */
  const upload = step(WF, "Upload everything this run learned");
  assert.match(upload, /path: \$\{\{ runner\.temp \}\}\/android-ci\s*$/m);
});

/* ───────────────────── honesty, and the boundaries of it ──────────────────── */

test("the workflow says, in the RUN's own summary, that a build is not a launch", () => {
  /* MUTATION: delete the "A build is not a launch." line from the summary step
     -> fails.
     THIS IS THE ONE MOST LIKELY TO BE READ AS DECORATION AND IT IS NOT.
     docs/android-shell-build.md §2 concludes our strict CSP does not block
     Capacitor's Android bridge, and §3 says plainly that the conclusion is
     INFERRED FROM SOURCE with nothing ever executed in a WebView. §4 says the
     same about `navigator.mediaSession`. A green Android build in CI is exactly
     the artefact that will be mistaken for having settled them — this repo has
     been burned by inferences presented as measurements, including in MP1 §5.4,
     which claimed "confirmed live" for a spike that never ran. So the caveat goes
     where the green tick is, not only in a comment nobody opens. */
  const report = stepCode("What this run established");
  assert.match(report, /A build is not a launch/);
  assert.match(report, /GITHUB_STEP_SUMMARY/);
  const p = prose(WF);
  assert.match(p, /A BUILD IS NOT A LAUNCH/);
});

test("the header says what the job cannot prove, not only what it can", () => {
  /* MUTATION: delete the "WHAT IT CANNOT PROVE" header section -> fails.
     docs/android-shell-build.md §0 keeps a whole table separating executed claims
     from inferred ones, because "a spike that reports measured when it means
     read is the failure mode this repo keeps paying for". A CI job is the same
     hazard with a green tick attached. */
  const p = prose(WF);
  assert.match(p, /WHAT IT CANNOT PROVE/);
  assert.match(p, /emulator/i, "the header must say why an emulator is not the answer");
});

test("the runner context is not used where GitHub does not provide it", () => {
  /* MUTATION: add `ART: ${{ runner.temp }}/android-ci` to the job-level `env:`
     -> fails.
     NOT A STYLE POINT. The `runner` context is unavailable in a job-level `env:`
     block, and an unavailable context is a workflow-COMPILE error rather than an
     empty string: the job would never start, and the error names the expression
     rather than the block it is illegal in. ios-build.yml carries the same note
     because the same mistake was nearly made there. */
  const jobEnv = block(WF, "env", 4);
  assert.ok(jobEnv, "no job-level env block");
  assert.equal(
    /runner\./.test(jobEnv),
    false,
    "`runner.*` in a job-level env block is a workflow-compile error, not an empty string"
  );
  assert.match(WF, /RUNNER_TEMP/, "$RUNNER_TEMP in a step is the way to get it");
});

test("ci.yml still declares exactly its three jobs, and #245 added none", () => {
  /* MUTATION: add a fourth job to ci.yml -> fails.
     THE POINT IS WHERE THIS JOB IS *NOT*. `ci.yml` is what runs on every push and
     every PR, and two of its jobs (`backend`, `data-and-site`) are required
     contexts. An Android build added there would gate every content PR on a
     20-minute Gradle run. It lives in its own path-filtered workflow instead, and
     this assertion is what notices if it ever migrates. */
  const jobs = block(CI, "jobs");
  const names = jobs
    .split(/\r?\n/)
    .filter((l) => /^ {2}[a-z][\w-]*:/.test(l))
    .map((l) => l.trim().replace(":", ""));
  assert.deepEqual(names, ["backend", "ios-kit", "data-and-site"]);
  assert.equal(
    /android/i.test(code(CI)),
    false,
    "the Android build must not migrate into the workflow that gates every PR"
  );
});
