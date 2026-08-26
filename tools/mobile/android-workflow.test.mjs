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
 *
 * ── IF YOU ARE ABOUT TO ASSERT THAT ONE THING COMES BEFORE ANOTHER, READ THIS
 *
 * USE `assertOrder`. Do not write `src.indexOf(a) < src.indexOf(b)`.
 *
 * `indexOf` RETURNS -1 FOR A MISSING NEEDLE, AND -1 IS LESS THAN EVERYTHING, so
 * that predicate is TRUE when `a` is absent. The assertion therefore passes most
 * loudly in the case it exists to forbid: `a` deleted entirely. It is not a
 * hypothetical — it shipped in this file for about twenty minutes. The test
 * "the password-length floor must run before any Gradle invocation" was written
 * to pin the fix for a credential-leak vector two reviewers had just found, and a
 * mutation that DELETED the floor left it green. The order was right; the
 * existence was never checked.
 *
 * The general rule this is one instance of: an assertion about a RELATIONSHIP
 * between two things must first assert that both things are there. Otherwise it
 * degrades to a claim about the empty set, which every implementation satisfies.
 * `assertOrder` does presence first, then position, and names which needle went
 * missing.
 *
 * AND NOTE WHAT CAUGHT IT: a mutation run, not a review. This is the sixth
 * guard-that-was-not-guarding found in this codebase in three days, and the
 * distinction between them is worth carrying — most were caught by mutating the
 * code and watching the suite stay green, but one (an R2 startup refusal that
 * could never fire) was not, because its tests were coupled to the code and the
 * CODE was wrong about the world. Mutation testing proves a test can see its
 * subject; it cannot tell you the subject is the right one.
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

/* THE SECOND ANDROID WORKFLOW, and the reason there is a second one.
   `android-build.yml` must keep reading NO SECRET and booting NO EMULATOR — the
   two properties this file has pinned since #245, and the two things a release
   pipeline needs. So `bundleRelease`, the signing config and the emulator smoke
   test live in `android-release.yml`, which is triggered far less often, and the
   assertions below keep BOTH sets of properties true at once: the build job
   stays credential-free, and the release job stays the only place a key or an
   emulator appears. */
const RELEASE_REL = ".github/workflows/android-release.yml";
const REL = fs.readFileSync(path.join(ROOT, RELEASE_REL), "utf8");
const RYML = code(REL);

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

/** The same, for `android-release.yml`. Same rule, same reason: that file argues
 *  in its comments for every property asserted here, so any assertion that reads
 *  the raw step is satisfiable by the argument rather than by the check. */
function releaseStepCode(nameFragment) {
  const s = step(REL, nameFragment);
  return s === null ? null : code(s);
}

/** How many of a step's checks can actually FAIL THE JOB.
 *
 *  A SECOND MUTATION ROUND — a reviewer's, not the author's — killed three more
 *  assertions that pinned a command's TEXT while saying they pinned its effect.
 *  Appending `|| true` to the `':foray-audio'` grep, or replacing the `javac`
 *  check's `|| { …; exit 1; }` with `|| true`, left every test green under a name
 *  that claimed the check was "ASSERTED". A grep whose result is discarded is a
 *  comment with a subprocess.
 *
 *  So the tests below count `exit 1` inside a step and compare it to the number of
 *  checks that step is supposed to have. Crude, and it is the property that
 *  matters: the count drops the moment a check stops being able to fail. */
function failureClauses(stepSrc) {
  return (stepSrc.match(/exit 1/g) ?? []).length;
}

/** Assert that `first` appears BEFORE `second` in a step, with BOTH present.
 *
 *  `indexOf(a) < indexOf(b)` IS TRUE WHEN `a` IS ABSENT, because a missing
 *  needle is -1 and -1 is less than everything. A round-2 mutation — moving the
 *  password-length floor back to after the build, which is the defect two
 *  reviewers had just found — SURVIVED for exactly that reason: the mutation
 *  removed the marker, `indexOf` answered -1, and the ordering assertion
 *  reported that the check it could no longer see came first. Ordering claims
 *  have to assert presence before they assert position. */
function assertOrder(stepSrc, first, second, why) {
  const a = stepSrc.indexOf(first);
  const b = stepSrc.indexOf(second);
  assert.notEqual(a, -1, `${why} — but ${JSON.stringify(first)} is not in the step at all`);
  assert.notEqual(b, -1, `${why} — but ${JSON.stringify(second)} is not in the step at all`);
  assert.ok(a < b, why);
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
  /* THE FAILURE CLAUSE, not the grep. Replacing `|| { …; exit 1; }` with `|| true`
     left this test green under the word "ASSERTED" in its own name. */
  const tc = stepCode("Toolchain versions");
  assert.ok(tc, "no toolchain step");
  assert.match(
    tc,
    /javac -version 2>&1 \| grep -qE '\^javac 21\\\.' \\\n\s*\|\| \{[^}]*exit 1; \}/,
    "the JDK major must be checked by the job AND fail it — a discarded grep is a comment"
  );
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
  /* THE INSTALL COMMAND, AND THE STEP IT LIVES IN. A first draft asserted only
     `/sdkmanager/` against the whole file — which the HEADER satisfies, since the
     header argues that `sdkmanager` is why no third-party action is needed. Deleting
     the install line, and even deleting the entire SDK step including the
     `ANDROID_HOME` export, left all 26 tests green. Declaring the two versions in
     `env:` and never installing them is the failure this test is named for. */
  const s = stepCode("The Android SDK");
  assert.ok(s, "no step installs the pinned SDK packages");
  assert.match(
    s,
    /"\$SDKMANAGER" --install "\$SDK_PLATFORM" "\$SDK_BUILD_TOOLS"/,
    "the two pinned env values must be what is actually installed"
  );
  assert.match(s, /--licenses/, "an unaccepted licence stops every Gradle build");
  assert.match(s, /ANDROID_HOME=\$SDK/, "the resolved SDK root must be exported for Gradle");
});

test("the dependency install is `npm ci`, against the committed lockfile", () => {
  /* MUTATION: change `npm ci` back to `npm install` -> fails.
     ADDED BY A REVIEW, AND IT CAUGHT A REAL DEFECT. The first draft of this job ran
     `npm install` under a comment asserting there was no committed lockfile —
     copied from `ios-build.yml`, where that was true when written. But
     `mobile/package-lock.json` IS committed, and `docs/android-shell-build.md` §1.3
     says it was committed *for this exact purpose*: #213's iOS job named the missing
     lockfile as "the first thing that would make this job non-reproducible".
     §1.2a's proof build ran `npm ci`. A job whose entire argument is that the build
     does not depend on one machine, floating its dependency versions while that
     machine pins them, is measuring something other than what it claims. Nothing
     pinned the fix until this test, so it could have drifted straight back. */
  const s = stepCode("Install the shell's dependencies");
  assert.ok(s, "no dependency install step");
  assert.match(s, /npm ci /, "the committed lockfile must be honoured");
  assert.equal(
    /npm install/.test(YML),
    false,
    "`npm install` floats versions the local build pins — the lockfile is committed (docs §1.3)"
  );
  assert.match(s, /npm ls --depth=0/, "the resolved tree must still be recorded");
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
  /* AND THE OTHER HALF OF THE SAME DECISION, added when `android-release.yml`
     landed. An emulator now exists in this repo; it is in the OTHER workflow, on
     a trigger that fires when the release pipeline changes rather than on every
     shell PR. Asserting it is there stops the pair from drifting into "no
     emulator anywhere", which is how the launch check would be lost while this
     test stayed green and looked like the reason. */
  assert.match(RYML, /avdmanager create avd/, "the emulator smoke test must exist somewhere — android-release.yml is where");
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
  /* THREE CHECKS, THREE FAILURE CLAUSES. Appending `|| true` to the settings grep
     — the check this file calls its highest-value assertion — left the suite green
     when the test only required two `exit 1`s. Counting them against the three
     checks the step is documented to make is what notices. */
  assert.equal(
    failureClauses(s),
    3,
    "all three checks (settings include, app dependency, sources on disk) must be able to fail the job"
  );
  assert.match(
    s,
    /test -d \.\.\/plugins\/foray-audio\/android\/src\/main\/java/,
    "the plugin's Java sources must be asserted present in the checkout"
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
  /* QUOTED, BECAUSE ONE OF THESE IS A PREFIX OF ANOTHER. `FOREGROUND_SERVICE` is a
     substring of `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, so an unquoted `includes`
     check for the base permission was satisfied by its neighbour: deleting the base
     permission from the workflow left all 26 tests green while the job stopped
     checking a permission whose absence is a runtime crash. The workflow lists each
     needle in single quotes, so quoting the expectation makes the four distinct. */
  const needles = [
    "'ai.jwlabs.foura.audio.PlaybackKeepAliveService'",
    "'android:foregroundServiceType=\"mediaPlayback\"'",
    "'android.permission.FOREGROUND_SERVICE'",
    "'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK'",
  ];
  for (const needle of needles) {
    assert.ok(s.includes(needle), `the merged-manifest check does not look for ${needle}`);
  }
  /* And the list stays exactly four entries long, so a fifth cannot be smuggled in
     and a deletion cannot be masked by a rewording. */
  const listed = (s.match(/^\s+'[^']+' \\$/gm) ?? []).length;
  assert.equal(listed, needles.length - 1, `expected ${needles.length - 1} continued needle lines, saw ${listed}`);
  /* And the two halves inside the APK itself, the same pair §4.2 read by hand. */
  assert.match(s, /grep -qF 'assets\/public\/foray-audio-shell\.js'/);
  assert.match(s, /grep -qF 'ai\.jwlabs\.foura\.audio\.ForayAudioPlugin'/);
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
  /* THE REASON, NOT THE WORD. `/emulator/i` alone survived deleting the sentence
     that carries the argument, because the word appears in three other places in
     this file. The load-bearing fact is the MEASUREMENT: MP1 §6.2 spent ~75 minutes
     across three cold API-36 boots without reaching a usable framework, which is
     why "just add an emulator" is not the answer to what this job cannot prove. A
     future session that deletes that citation will reach for one. */
  assert.match(
    p,
    /~75 minutes/,
    "the header must carry MP1 §6.2's measured cost, not just the word `emulator`"
  );
  assert.match(p, /A DEVICE IS WHAT SETTLES|A device is what settles/);
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

/* ═════════════════════ android-release.yml — the Play path ═════════════════
 *
 * A SECOND WORKFLOW, ASSERTED IN THE SAME FILE, because the two are one
 * decision: `android-build.yml` stays credential-free and emulator-free, and
 * everything a release needs lives next door. Splitting these assertions into a
 * second suite would let one half be deleted while the other stayed green and
 * looked like it covered the topic.
 *
 * EVERY TEST BELOW NAMES ITS ONE-LINE MUTATION AND EVERY ONE WAS RUN. The
 * mutation round on this section found two live vacuities, both recorded in the
 * tests they belong to: an assertion that the keystore is written outside the
 * uploaded directory that passed with the keystore written INSIDE it, and a
 * "both signing branches can fail" assertion that passed with one branch's
 * `exit 1` deleted.
 */

test("android-release.yml exists and has the same five top-level keys", () => {
  /* MUTATION: delete the `permissions:` block -> fails.
     Same shape as the other two shell workflows on purpose: three files that
     build the same product should not have three different skeletons. */
  assert.deepEqual(topLevelKeys(REL), ["name", "on", "concurrency", "permissions", "jobs"]);
  assert.match(REL, /^name: android-release$/m);
});

test("it declares exactly two jobs, and neither is named like a required check", () => {
  /* MUTATION: rename `android-smoke:` to `data-and-site:` -> fails.
     `protect-main` matches required contexts BY NAME, so a job called `backend`,
     `data-and-site` or `path-policy` in ANY workflow reports against the real
     required check. A 40-minute emulator boot answering for `data-and-site`
     would gate every content PR in the repo on a cold AVD. */
  const jobs = block(REL, "jobs");
  const names = jobs
    .split(/\r?\n/)
    .filter((l) => /^ {2}[a-z][\w-]*:/.test(l))
    .map((l) => l.trim().replace(":", ""));
  assert.deepEqual(names, ["android-bundle", "android-smoke"]);
  for (const required of ["backend", "data-and-site", "path-policy", "ios-kit"]) {
    assert.equal(names.includes(required), false, `a job named ${required} collides with a required check`);
  }
});

test("the emulator job cannot gate the artefact — the two jobs are independent", () => {
  /* MUTATION: add `needs: android-bundle` to the `android-smoke:` job -> fails.
     THE WHOLE COST ARGUMENT FOR THE SPLIT. A cold emulator boot is the one
     genuinely flaky thing in this repo (docs/research/mp1-background-audio.md
     §6.2 measured a cold API-36 boot NOT completing in ~35 minutes), and the
     .aab is on the critical path to a Play submission. If the two jobs are ever
     chained in either direction, a flaked AVD stops the founder getting a
     bundle — which is the "a flaky required check is worse than no check"
     failure one level down from `required`. */
  assert.equal(
    /^\s*needs:/m.test(RYML),
    false,
    "neither job may depend on the other: a flaky emulator must never block the release bundle"
  );
});

test("both jobs run on Linux and both have a timeout", () => {
  /* MUTATION: delete `timeout-minutes:` from `android-smoke` -> fails (one, not two).
     An emulator that never boots holds a runner for GitHub's 6-hour default, and
     the boot poll below has its own 15-minute bound precisely because "hangs
     forever" is this job's characteristic failure. */
  const runners = (REL.match(/^ {4}runs-on: ubuntu-latest$/gm) ?? []).length;
  assert.equal(runners, 2, "both jobs must be on ubuntu-latest");
  assert.equal(/runs-on: macos/.test(RYML), false, "an Android build on macOS costs 10x and learns nothing");
  assert.equal((REL.match(/^ {4}timeout-minutes: \d+$/gm) ?? []).length, 2, "both jobs need a timeout");
});

test("it never runs on a push or a schedule, and its path filter is the pipeline itself", () => {
  /* MUTATION: add `- "mobile/**"` to the `paths:` list -> fails.
     THE COST DECISION, AND IT IS NOT THE SAME ONE `android-build.yml` MADE.
     That file watches `mobile/**` because it is the build check. This one runs a
     release compile AND a cold emulator, ~65 minutes between them, and
     `android-build.yml` already covers ordinary shell changes — so it fires only
     when the release pipeline itself changes. Widening this filter turns every
     `mobile/**` PR into a second Gradle build plus an AVD boot. */
  const on = block(REL, "on");
  assert.ok(on, "no `on:` block");
  assert.match(on, /workflow_dispatch:/);
  assert.match(on, /pull_request:/);
  assert.equal(/^\s{2}push:/m.test(on), false, "a push trigger re-runs on merge what already ran on the PR");
  assert.equal(/^\s{2}schedule:/m.test(on), false, "a weekly emulator boot on days nothing changed buys nothing");
  assert.match(on, /^ {4}paths:$/m, "the pull_request trigger must filter with `paths:`");
  assert.equal(/paths-ignore/.test(RYML), false, "`paths-ignore` INVERTS the filter");
  /* The workflow's own path is in the filter deliberately: `workflow_dispatch`
     cannot be triggered on a branch until the file is on the default branch, so
     a `pull_request` trigger is the ONLY way this pipeline can be exercised
     against real output before it merges. */
  assert.ok(on.includes(`"${RELEASE_REL}"`), "the workflow must trigger on changes to itself");
  for (const p of ['"mobile/gradle/**"', '"tools/mobile/wire-signing.mjs"', '"tools/mobile/webview-probe.mjs"']) {
    assert.ok(on.includes(p), `the path filter is missing ${p} — a change to it would ship untested`);
  }
  for (const wide of ['"mobile/**"', '"data/**"', '"docs/**"', '"**"', '"app.js"']) {
    assert.equal(on.includes(wide), false, `${wide} in this filter makes a 65-minute pipeline run on ordinary PRs`);
  }
});

test("concurrency cancels superseded runs and it asks for no write permission", () => {
  /* MUTATION: `contents: write` -> fails. A job that holds the signing key must
     be the LEAST privileged job in the repo, not the most. */
  assert.match(block(REL, "concurrency"), /cancel-in-progress: true/);
  const p = block(REL, "permissions");
  assert.match(p, /contents: read/);
  for (const w of ["write", "write-all", "packages:", "id-token"]) {
    assert.equal(p.includes(w), false, `the release job has no reason to hold ${w}`);
  }
});

test("every action is GitHub's own — including for the emulator, where it is tempting not to be", () => {
  /* MUTATION: add `- uses: reactivecircus/android-emulator-runner@v2` -> fails.
     That action is the standard way to do this and it is deliberately not used.
     A third-party action runs arbitrary code with the job's token on every run,
     and THIS is the one workflow in the repo a signing key passes through — the
     argument that kept `android-actions/setup-android` out of `android-build.yml`
     is strictly stronger here. */
  const uses = REL.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(- )?uses:/.test(l))
    .map((l) => l.replace(/^(- )?uses:\s*/, ""));
  assert.ok(uses.length >= 6, `expected at least six actions across two jobs, found ${uses.length}`);
  for (const u of uses) {
    assert.match(u, /^actions\/[\w-]+@v\d+$/, `${u} is not a major-pinned first-party actions/* action`);
  }
});

/* ───────────────────── the bundle, which is the whole point ────────────────── */

test("`bundleRelease` is INVOKED — not assembleRelease, and not merely mentioned", () => {
  /* MUTATION: change `bundleRelease` to `assembleRelease` -> fails.
     PLAY DOES NOT ACCEPT AN APK. `android-build.yml` has built
     `app-release-unsigned.apk` since #245 and it has never been submittable; the
     bundle task is a different task with a different output directory. Asserted
     against real `./gradlew` invocations rather than file text, so the word in a
     comment cannot satisfy it. */
  const calls = gradlewInvocations(REL);
  assert.ok(
    calls.some((c) => /gradlew bundleRelease\b/.test(c)),
    `no bundleRelease invocation; found: ${JSON.stringify(calls)}`
  );
  for (const c of calls) {
    assert.match(c, /--console=plain/, `${c} must use --console=plain: the log's task lines are parsed`);
    assert.equal(
      /(-x|--exclude-task)\s/.test(c),
      false,
      `${c} excludes a task — the release lint gate is the one that must not be excluded`
    );
  }
});

test("the release lint gate cannot be skipped silently here either", () => {
  /* MUTATION: delete the `*SKIPPED*` case arm -> fails.
     `bundleRelease` depends on `lintVitalRelease` exactly as `assembleRelease`
     does, and all three bypasses `android-build.yml` documents apply unchanged:
     excluded on the command line, switched off by a `lint { checkReleaseBuilds
     false }` a future template adds, or renamed by AGP — and the build prints
     BUILD SUCCESSFUL in all three. */
  const s = releaseStepCode("bundleRelease — the .aab");
  assert.ok(s, "no bundleRelease step");
  assert.match(
    s,
    /LINTLINE=\$\(grep -E '\^> Task :app:lintVitalRelease/,
    "the lint verdict must be READ FROM the log, not merely mentioned near it"
  );
  assert.match(s, /\*SKIPPED\*\|\*NO-SOURCE\*/, "a registered-but-not-run lint task must fail the job");
});

test("the gradle exit code is captured directly, never read from `$?` after a pipe", () => {
  /* MUTATION: replace the `GRADLE_STATUS=$?` capture with
     `if ! ./gradlew bundleRelease … | tee …` -> fails.
     `$?` AFTER A PIPE IS THE EXIT CODE OF `tee`, which succeeds while the build
     fails. This repo has produced false-green reports in both directions from
     exactly that. The build here writes to a file and the status is taken from
     the command itself. */
  const s = releaseStepCode("bundleRelease — the .aab");
  assert.match(s, /GRADLE_STATUS=\$\?/, "the build's status must be captured immediately");
  assert.match(s, /if \[ "\$GRADLE_STATUS" -ne 0 \]/, "and it must be what decides the step");
  assert.equal(
    /gradlew bundleRelease[^\n]*\|\s*tee/.test(RYML),
    false,
    "piping the build into tee makes $? the exit code of tee"
  );
});

test("the .aab is opened and read, not trusted because a task printed success", () => {
  /* MUTATION: delete the `'BundleConfig.pb'` needle -> fails.
     Second MUTATION: delete the `'resources.arsc'` forbidden entry -> fails.
     AN .aab AND AN .apk ARE BOTH ZIPS IN THE SAME OUTPUT TREE. A wrong `cp`, or
     a future AGP that renames a task, produces a file with the right extension
     and the wrong contents, and nothing before Play's upload form would notice.
     They differ by LAYOUT and by nothing else, so both directions are asserted:
     the bundle entries must be present AND the APK-only entries must be absent. */
  const s = releaseStepCode("It is really a BUNDLE");
  assert.ok(s, "no step verifies the bundle's structure");
  for (const needle of [
    "'BundleConfig.pb'",
    "'base/manifest/AndroidManifest.xml'",
    "'base/dex/classes.dex'",
    "'base/resources.pb'",
    "'base/assets/public/index.html'",
    "'base/assets/capacitor.plugins.json'",
  ]) {
    assert.ok(s.includes(needle), `the bundle check does not look for ${needle}`);
  }
  for (const forbidden of ["'AndroidManifest.xml'", "'resources.arsc'"]) {
    assert.ok(s.includes(forbidden), `the bundle check does not reject a root ${forbidden} — an APK would pass`);
  }
  /* AND OUR OWN NATIVE CODE, INSIDE THE RELEASE BUNDLE. `android-build.yml`
     reads the merged manifest and the DEBUG APK; until this step nothing had
     ever read the thing that actually gets uploaded. `mediaPlayback` is the
     service type with no runtime prerequisite and NO TIMEOUT, which a 45-to-90
     minute Foray depends on (mp1-background-audio.md §5.3). */
  for (const needle of [
    "'ai.jwlabs.foura.audio.PlaybackKeepAliveService'",
    "'mediaPlayback'",
    "'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK'",
  ]) {
    assert.ok(s.includes(needle), `the bundle's manifest is not checked for ${needle}`);
  }
  assert.match(s, /grep -qF 'ai\.jwlabs\.foura\.audio\.ForayAudioPlugin'/);
});

test("the bundle artifact is uploaded, from exactly the report directory", () => {
  /* MUTATION: change the path to `${{ runner.temp }}` -> fails, and this one is
     not a tidiness point — see the keystore test below, which is the same
     assertion from the other side. RUNNER_TEMP holds whatever every other step
     left there, and on this job that includes a decoded signing key. */
  const upload = step(REL, "Upload the bundle and everything this run learned");
  assert.ok(upload, "the .aab is built and never uploaded — nobody can download it");
  assert.match(upload, /path: \$\{\{ runner\.temp \}\}\/android-release\s*$/m);
  assert.match(upload, /^ {8}if: always\(\)$/m, "a failed run's Gradle log is the most useful thing in it");
  assert.match(upload, /retention-days: 30/, "the artefact is downloaded and submitted by a human on his own schedule");
});

/* ─────────────────────────── the key, and the blast radius ─────────────────── */

test("the decoded keystore is written OUTSIDE the directory that gets uploaded", () => {
  /* MUTATION: change `KEYDIR=$RUNNER_TEMP/android-keys` to
     `KEYDIR=$RUNNER_TEMP/android-release/keys` -> fails.
     THE WORST FAILURE THIS FILE CAN HAVE, and it would look completely routine:
     the artifact upload publishes `$RUNNER_TEMP/android-release` to anyone who
     can see the repo, so a keystore written one directory deeper is the
     founder's signing key on the internet — and a leaked upload key means every
     future update to the app can be signed by whoever has it.
     THE FIRST VERSION OF THIS TEST WAS VACUOUS: it asserted the two paths were
     "different strings", which is true of `…/android-release` and
     `…/android-release/keys`. It now requires the key directory not to be a
     child of the uploaded one, which is the property that matters. */
  const s = releaseStepCode("Toolchain versions");
  assert.ok(s, "no toolchain step");
  const art = /ART=\$RUNNER_TEMP\/([\w-]+)/.exec(s);
  const key = /KEYDIR=\$RUNNER_TEMP\/([\w-]+)/.exec(s);
  assert.ok(art, "the report directory is not set from $RUNNER_TEMP in the first step");
  assert.ok(key, "the key directory is not set from $RUNNER_TEMP in the first step");
  assert.equal(
    key[1] === art[1] || key[1].startsWith(art[1] + "/"),
    false,
    `the keystore directory ${key[1]} is inside the uploaded directory ${art[1]} — the key would be published`
  );
  const upload = step(REL, "Upload the bundle and everything this run learned");
  assert.ok(
    upload.includes(`/${art[1]}`),
    "the upload path and the report directory must be the same one, or this test is checking nothing"
  );
});

test("the key is shredded in a step that runs even when the build failed", () => {
  /* MUTATION: delete `if: always()` from the shred step -> fails.
     A cleanup that only runs on success cleans up on exactly the runs where
     nothing went wrong. GitHub-hosted runners are destroyed after the job, so
     this is defence in depth — until the day someone adds a self-hosted runner,
     which is not the day to find out the key was left in a reused workspace. */
  const s = step(REL, "Shred the upload key");
  assert.ok(s, "nothing removes the decoded keystore");
  assert.match(s, /^ {8}if: always\(\)$/m, "the shred must run on failure too");
  assert.match(code(s), /shred -u|rm -rf/, "the shred step must actually delete something");
  assert.match(code(s), /test ! -e "\$KEYDIR"/, "and it must verify the directory is gone rather than assume it");
});

test("exactly three secrets, by the names the founder is populating", () => {
  /* MUTATION: add `FORAY_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}` to the
     bundleRelease step's env -> fails.
     THE STORE IS PKCS12 AND HAS ONE PASSWORD. keytool refuses to give a PKCS12
     entry a key password different from the store password, so a fourth secret
     would be a value that can disagree with a value it is not allowed to
     disagree with — and the symptom is `keystore password was incorrect`, which
     points at the wrong one of the two. The names are pinned because the founder
     sets them with `gh secret set` from a separate machine; a rename here and
     not there produces an unsigned bundle from a green run. */
  const used = [...RYML.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(used)].sort(),
    ["ANDROID_KEYSTORE_B64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS"].sort()
  );
  assert.equal(
    /ANDROID_KEY_PASSWORD/.test(RYML),
    false,
    "a PKCS12 key password cannot differ from the store password — a fourth secret is a second source of truth"
  );
});

test("no secret ever reaches a Gradle command line", () => {
  /* MUTATION: add `-PforayKeystorePassword=$FORAY_KEYSTORE_PASSWORD` to the
     bundleRelease invocation -> fails.
     A GRADLE PROPERTY IS IN THE PROCESS'S argv. That puts it in `ps`, in the
     daemon's own record of the invocation, and in any trace that echoes the
     command — none of which GitHub's log masking touches, because none of them
     is the workflow log. The values are read by `System.getenv` in
     `mobile/gradle/foray-signing.gradle` instead. */
  for (const c of gradlewInvocations(REL)) {
    assert.equal(/\s-P/.test(c), false, `${c} passes a Gradle property — secrets must arrive by environment only`);
  }
  assert.equal(
    /signingReport/.test(RYML),
    false,
    "`signingReport` prints signing configuration by design — it must not run in a job that holds a key"
  );
});

test("a Gradle log that contains the password is destroyed rather than uploaded", () => {
  /* MUTATION: delete the `rm -f "$ART/gradle-bundleRelease.log"` line from the
     scrub -> fails.
     GITHUB MASKS SECRETS IN LOGS AND NOT IN ARTIFACTS. The build log is uploaded
     and is downloadable by anyone who can see the repo, so `***` in the web view
     protects nothing about the copy in the zip. AGP does not print the password
     today; a `--stacktrace` added in a hurry, or a keystore error that echoes
     its inputs, is one commit away. */
  const s = releaseStepCode("bundleRelease — the .aab");
  assert.match(s, /grep -qF "\$FORAY_KEYSTORE_PASSWORD" "\$LOG"/, "the log must be searched for the password");
  assert.match(s, /rm -f "\$LOG"/, "and destroyed if it is in there");
  /* ORDER, NOT JUST PRESENCE. Scrubbing after the failure branch has already
     tailed the file would be a check that runs too late to matter. */
  assertOrder(
    s,
    'grep -qF "$FORAY_KEYSTORE_PASSWORD"',
    "bundleRelease tail",
    "the scrub must happen before anything reads the log back out"
  );
});

test("an unscanned build log cannot reach the uploaded directory by ANY path", () => {
  /* MUTATION: change `LOG="$RUNNER_TEMP/gradle-bundleRelease.log"` to
     `LOG="$ART/gradle-bundleRelease.log"` -> fails.
     ORDERING THE SCRUB WAS NOT ENOUGH, AND TWO REVIEWERS FOUND THE SAME HOLE
     INDEPENDENTLY. When the build wrote straight into $ART, every exit between
     the build and the scrub left an unscanned log for the `if: always()` upload
     to publish: the `timeout-minutes`, a cancelled concurrency group, and — as
     shipped for about an hour — a password-length check that had been added
     after the build and returned before the scrub, so the one input that makes
     the scan unusable was also the one that skipped it.
     A CHECK THAT PROTECTS ONE CODE PATH AGAINST AN UNCONDITIONAL UPLOAD IS A
     CHECK WITH A GAP IN IT. The log now lives outside the uploaded directory
     until it has been read, which is the same structural argument that puts
     $KEYDIR beside $ART rather than inside it — and this test is the pair of the
     keystore one above. */
  const s = releaseStepCode("bundleRelease — the .aab");
  assert.match(s, /LOG="\$RUNNER_TEMP\/gradle-bundleRelease\.log"/, "the build log must be written outside $ART");
  assert.match(s, /gradlew bundleRelease [^\n]*> "\$LOG" 2>&1/, "and the build must write to it");
  assert.match(s, /cp "\$LOG" "\$ART\/gradle-bundleRelease\.log"/, "it enters $ART by an explicit copy");
  assertOrder(
    s,
    'grep -qF "$FORAY_KEYSTORE_PASSWORD"',
    'cp "$LOG"',
    "the copy into $ART must come AFTER the scan, or the scan is decoration"
  );
  /* THE LENGTH FLOOR IS BEFORE THE FIRST BUILD, which is what makes its own
     message ("Refusing to build") true as well as what removes the gap. */
  assertOrder(
    s,
    "${#FORAY_KEYSTORE_PASSWORD}",
    "./gradlew",
    "the password-length floor must run before any Gradle invocation"
  );
});

test("Gradle's own view of whether it was keyed is READ, not merely recorded", () => {
  /* MUTATION: delete the `grep -q 'FORAY_SIGNING_STATUS=keyed'` line -> fails.
     `foraySigningStatus` was captured to a file that nothing opened — evidence
     for a human and a check for nobody. The two halves can disagree: the
     workflow decides `keyed` from the secret, the Gradle include decides
     `signingRequested` from the environment it was handed, and a renamed
     variable or an include that stops being applied separates them. The
     signature step catches that after the build; this catches it before, which
     on a 25-minute compile is the difference between a diagnosis and a wait. */
  const s = releaseStepCode("bundleRelease — the .aab");
  assert.match(s, /grep -q 'FORAY_SIGNING_STATUS=keyed' "\$ART\/signing-status\.txt"/);
  assertOrder(
    s,
    "FORAY_SIGNING_STATUS=keyed",
    "gradlew bundleRelease",
    "the disagreement must be caught before the release compile, not after it"
  );
});

test("every pipeline whose failure has a diagnostic can actually reach it", () => {
  /* MUTATION: delete `|| true` from the `adb install` pipeline -> fails.
     THE SAME DEFECT THREE TIMES, and a reviewer found all three: under
     `set -o pipefail` a failing `adb install`, a failing `am start` (adb shell
     forwards the remote status) or a failing `base64 --decode` aborts the step
     BEFORE the `grep`/`if` written to explain it. The message is then dead code
     and the operator gets the tool's own error instead — which is exactly the
     shape android-build.yml's `find … || true` comment already records for the
     merged-manifest diagnostic. */
  const launch = releaseStepCode("Install the app and start it");
  assert.match(launch, /adb install -r -g "\$APK"[^\n]*\|\| true/, "adb install exits non-zero on failure");
  assert.match(launch, /am start -W -n "\$PKG\/\.MainActivity"[^\n]*\|\| true/, "adb shell forwards am's status");
  const key = releaseStepCode("Materialise the upload key");
  assert.match(key, /if ! printf '%s' "\$KEYSTORE_B64" \| base64 --decode/, "invalid base64 must reach its own message");
  /* And the crash report, where SIGPIPE from `head` would otherwise abort the
     step with the log group left open and the verdict line unprinted. */
  const alive = releaseStepCode("Still alive, and nothing crashed");
  assert.match(alive, /\{ grep -A 30 [^\n]*\|\| true; \} \| head -80/, "grep into head must survive SIGPIPE");
});

test("both signing outcomes are VERIFIED, and neither is assumed", () => {
  /* MUTATION: delete the `exit 1` from the unsigned branch's `SIGBLOCKS -ne 0`
     check -> fails.
     THE QUIET FAILURE IS THE KEYED ONE: a key is installed, something in the
     wiring stops applying it, the run stays green and emits an unsigned bundle
     that Play rejects a fortnight later. So the keyed branch requires a
     signature block AND a jarsigner verdict AND the pinned certificate; the
     unkeyed branch requires the ABSENCE of a signature block, which is what
     makes an inverted condition fail on whichever branch it takes rather than
     on neither.
     THE FIRST VERSION OF THIS TEST ONLY MATCHED THE `jarsigner -verify` TEXT and
     stayed green with the entire unsigned branch reduced to an `echo`. Counting
     the clauses that can fail the job is what notices. */
  const s = releaseStepCode("Signed, or verifiably not signed");
  assert.ok(s, "no step reads the signature");
  assert.match(s, /jarsigner -verify/, "a bundle carries a JAR signature, so jarsigner is the right tool");
  assert.equal(
    /apksigner/.test(RYML),
    false,
    "apksigner reads APK signature schemes — on an .aab it answers the wrong question"
  );
  /* EXACTLY ONE, not "at least one" — a reviewer's point and a real hole. Two
     signature blocks means two signers, and the fingerprint check below is a
     substring search over a certificate dump that would then contain both, so a
     bundle signed by the upload key AND something else passed every check. */
  assert.match(s, /"\$SIGBLOCKS" -ne 1/, "the keyed branch must require exactly one signature block");
  assert.match(s, /"\$SIGBLOCKS" -ne 0/, "the unkeyed branch must require the ABSENCE of one");
  assert.equal(
    failureClauses(s),
    6,
    "six clauses — wrong block count when keyed, jarsigner's exit, jarsigner's verdict, keytool's exit, a wrong fingerprint, and a block when NOT keyed — must each be able to fail the job"
  );
});

test("the signer is pinned to the upload key's certificate, not merely to `signed`", () => {
  /* MUTATION: delete the `EXPECTED_SIGNER_SHA256` comparison -> fails.
     A bundle signed by the WRONG key verifies perfectly. Play answers "Your
     Android App Bundle is signed with the wrong key", and for an app already
     listed that is not a re-run, it is Google's key-reset process. The
     fingerprint is a public value — Play displays the same one — so pinning it
     costs nothing and closes the last silent way to ship an unusable artefact.
     Read out of the ARTEFACT with `-jarfile`, so it is a property of the file
     being uploaded rather than of the keystore we believe we used. */
  const s = releaseStepCode("Signed, or verifiably not signed");
  assert.match(s, /keytool -printcert -jarfile/, "the certificate must be read out of the .aab itself");
  assert.match(s, /EXPECTED_SIGNER_SHA256/, "and compared against a pinned fingerprint");
  /* THE COMPARISON, NOT ITS INGREDIENTS — AND THIS TEST WAS VACUOUS WITHOUT IT.
     The mutation round replaced `if ! printf '%s' "$NORM" | grep -qF "$WANT"`
     with `if false`, leaving the keytool call, the pinned constant and all five
     `exit 1`s exactly where they were, and every assertion above stayed green
     while the bundle stopped being checked against the key at all. The two
     derivations and the branch that reads them are what has to be pinned. */
  assert.match(s, /NORM=\$\(tr -d ':' < "\$ART\/signer-cert\.txt"/, "the compared value must come from the certificate dump");
  assert.match(s, /WANT=\$\(printf '%s' "\$EXPECTED_SIGNER_SHA256"/, "and the expectation from the pinned constant");
  assert.match(
    s,
    /if ! printf '%s' "\$NORM" \| grep -qF "\$WANT"; then/,
    "the two must actually be compared, in the branch that fails the job"
  );
  const pinned = /EXPECTED_SIGNER_SHA256: "([0-9A-Fa-f:]+)"/.exec(REL);
  assert.ok(pinned, "the pinned fingerprint must be a literal in the workflow, so a diff shows it changing");
  assert.equal(
    pinned[1].replace(/:/g, "").length,
    64,
    "a SHA-256 fingerprint is 32 bytes — a short value here would match a prefix of anything"
  );
});

test("nothing keylike is committed anywhere in the signing config", () => {
  /* MUTATION: change `storePassword keystorePassword` to `storePassword "hunter2"`
     in mobile/gradle/foray-signing.gradle -> fails.
     NOT EVEN AS AN EXAMPLE. A placeholder password in a tracked file is the
     thing a future session copies into a real config, and a keystore in git is
     unrecoverable — history rewrites do not un-clone. Every signing value must
     trace back to `System.getenv`. */
  const gradle = fs.readFileSync(path.join(ROOT, "mobile/gradle/foray-signing.gradle"), "utf8");
  for (const setting of ["storePassword", "keyPassword", "keyAlias", "storeFile"]) {
    const assignments = gradle
      .split(/\r?\n/)
      .filter((l) => new RegExp(`^\\s*${setting}\\s`).test(l));
    assert.ok(assignments.length > 0, `${setting} is not configured at all`);
    for (const a of assignments) {
      const value = a.trim().replace(/^\w+\s+/, "");
      assert.equal(
        /^["']/.test(value),
        false,
        `${a.trim()} assigns a literal — every signing value must come from the environment`
      );
    }
  }
  assert.match(gradle, /System\.getenv\("FORAY_KEYSTORE_PASSWORD"\)/);
  assert.equal(/-----BEGIN/.test(gradle), false, "no key material in a tracked file");
  /* AND NO PATH TO A REAL STORE. A bare `.p12`/`.jks` search was the first
     spelling of this and it matched the file's own COMMENTS, which name both
     extensions to explain why `storeType` is declared rather than guessed — the
     comment-satisfies-the-assertion failure this suite already records three
     times. What must never appear is a store as a VALUE: a quoted filename, or
     an absolute path on somebody's machine. */
  assert.equal(
    /["'][^"']*\.(p12|jks|keystore)["']|[A-Za-z]:\\\\|\/home\/|\/Users\//.test(gradle),
    false,
    "no keystore path as a value — the path arrives in FORAY_KEYSTORE_PATH at build time"
  );
});

test("the signing include fails loudly on every way it can be half-configured", () => {
  /* MUTATION: delete the `isInteger()` guard from
     `mobile/gradle/foray-signing.gradle` -> fails.
     ABSENT-SAFE IS NOT THE SAME AS BROKEN-SAFE, and that distinction is the whole
     design of that file: no `FORAY_KEYSTORE_PATH` is an ordinary state that
     yields an unsigned bundle, while a path that is set and unusable must throw.
     Four ways to be half-configured, four `GradleException`s — and the fourth was
     found by a reviewer and had NO TEST until a round-2 mutation survived: a
     founder who types the version NAME (`1.0.0`) into the version_code box gets
     `NumberFormatException: For input string` out of a generated project,
     twenty-five minutes in, naming neither the variable nor the box.
     THE GRADLE FILE HAS NO OTHER COVERAGE AT ALL. Gradle cannot run in this
     repo's test environment, so this suite reading its text is the only thing
     standing between these guards and a silent deletion. */
  const gradle = fs.readFileSync(path.join(ROOT, "mobile/gradle/foray-signing.gradle"), "utf8");
  const throws = (gradle.match(/throw new GradleException/g) ?? []).length;
  assert.equal(throws, 5, `expected five GradleException guards, found ${throws}`);
  for (const [needle, why] of [
    [/if \(!keystoreFile\.isFile\(\)\)/, "a keystore path pointing at nothing must throw, not build unsigned"],
    [/if \(!isSet\(keystorePassword\)\)/, "a keystore with no password must throw"],
    [/if \(!isSet\(keystoreAlias\)\)/, "a keystore with no alias must throw"],
    [/!versionCodeEnv\.trim\(\)\.isInteger\(\)/, "a non-integer versionCode must be named, not thrown as a NumberFormatException"],
    [/versionCodeOverride <= 0/, "Play requires a positive versionCode, so 0 must not reach the build"],
  ]) {
    assert.match(gradle, needle, why);
  }
  /* AND THE PKCS12 DECLARATION, which is not a guard but is the same class of
     one-line-from-broken: AGP guesses the store type from the file when this is
     absent, and a wrong guess fails as `Invalid keystore format`. */
  assert.match(gradle, /storeType "PKCS12"/, "the store type must be declared, not inferred from the extension");
});

/* ───────────────────────────── the launch itself ───────────────────────────── */

test("the emulator is created, booted, and waited for on the property that matters", () => {
  /* MUTATION: delete the `getprop sys.boot_completed` poll, leaving only
     `adb wait-for-device` -> fails.
     `adb wait-for-device` RETURNS TOO EARLY AND MP1 §6.2 IS THE RECEIPT: that
     run reached `state: device` with `ro.build.version.sdk=36` while the package
     service still answered "Can't find service: package" and `pm install` never
     succeeded. The device being visible and the framework being usable are
     different events, and installing between them fails in a way that reads like
     a broken APK. */
  const s = releaseStepCode("Boot an emulator");
  assert.ok(s, "no step boots an emulator");
  assert.match(s, /avdmanager create avd/, "the AVD must be created");
  assert.match(s, /adb wait-for-device/);
  assert.match(s, /getprop sys\.boot_completed/, "the boot must be waited for on sys.boot_completed");
  assert.match(s, /DEADLINE=/, "an emulator that never boots must time out rather than hold the runner");
});

test("the emulator image is NOT API 36, because that cost is measured", () => {
  /* MUTATION: change `system-images;android-34;…` to `system-images;android-36;…`
     -> fails.
     docs/research/mp1-background-audio.md §6.2: a cold API-36 x86_64 image did
     not reach a usable framework in ~35 minutes under WHPX, across three
     attempts, and §6.3's "practical note for #38 (the CI-runner work)" says in
     so many words to pin an older API level. targetSdk is 36; the emulator's API
     level is not what this job tests, and paying §6.2's bill again to make it
     match a number would be paying it for nothing. */
  assert.match(REL, /EMULATOR_IMAGE: system-images;android-34;google_apis;x86_64/);
  assert.equal(
    /system-images;android-3[56]/.test(RYML),
    false,
    "MP1 §6.2 measured an API-36 cold boot not completing in ~35 minutes"
  );
  assert.match(prose(REL), /§6\.2/, "the header must carry the citation, so the next session does not re-pay for it");
});

test("KVM is enabled and ASSERTED, not hoped for", () => {
  /* MUTATION: delete the `test -w /dev/kvm` line -> fails.
     Without the udev rule the runner user cannot open /dev/kvm and the emulator
     falls back to interpretation — which is the regime §6.2 measured at "not
     booted after 35 minutes". The difference between a ~2 minute boot and a
     timeout is one file in /etc/udev/rules.d, so its effect is checked rather
     than assumed: a silently unaccelerated emulator does not fail here, it fails
     fifteen minutes later in the boot poll with a message about booting. */
  const s = releaseStepCode("Enable KVM");
  assert.ok(s, "nothing enables KVM");
  assert.match(s, /99-kvm4all\.rules/);
  assert.match(s, /test -w \/dev\/kvm/, "the rule's EFFECT must be checked, not just written");
  assert.equal(failureClauses(s), 1, "the /dev/kvm check must be able to fail the job");
});

test("the app is installed and started, and `am start` must report ok", () => {
  /* MUTATION: delete the `grep -q '^Status: ok'` line -> fails.
     `adb shell am start` EXITS 0 WHEN IT FAILS. A missing activity, a
     non-exported one, or a package name that does not match all produce
     `Error type 3` on stdout and a zero exit status, so without reading the
     Status line the "launch" step is an echo. `-W` is what makes the Status line
     exist. `adb install` has the same shape and gets the same treatment. */
  const s = releaseStepCode("Install the app and start it");
  assert.ok(s, "no step installs and launches the app");
  assert.match(s, /adb install -r -g "\$APK"/);
  assert.match(s, /grep -q '\^Success'/, "adb install also prints failures to stdout and exits 0");
  assert.match(s, /am start -W -n "\$PKG\/\.MainActivity"/, "-W is what produces a Status line to read");
  assert.match(s, /grep -q '\^Status: ok'/);
  assert.equal(failureClauses(s), 2, "both the install and the start must be able to fail the job");
});

test("the WebView is interrogated over DevTools, and the probe's verdict is the job's", () => {
  /* MUTATION: append `|| true` to the `node tools/mobile/webview-probe.mjs` line
     -> fails.
     A PROBE WHOSE EXIT CODE IS DISCARDED IS A COMMENT WITH A SUBPROCESS — the
     exact failure a reviewer's mutation round found three times in
     `android-build.yml`. This is the only thing in the repo that can see the app
     RUNNING: `mobile/android/` is not committed, so no unit test can read it,
     and the APK checks next door prove classes were REGISTERED, not that any of
     them work. */
  const s = releaseStepCode("The WebView is running OUR app");
  assert.ok(s, "no step reads the running WebView");
  assert.match(s, /node tools\/mobile\/webview-probe\.mjs/);
  assert.equal(
    /webview-probe\.mjs[\s\S]{0,240}\|\| true/.test(s),
    false,
    "the probe's exit code is the job's verdict and must not be discarded"
  );
  /* THE SOCKET IS FOUND, NOT NAME-ASSUMED, for the same reason the merged
     manifest is found rather than path-assumed next door:
     `webview_devtools_remote_<pid>` is a WebView implementation detail. */
  assert.match(s, /\/proc\/net\/unix/, "the devtools socket must be discovered");
  assert.match(s, /adb forward tcp:9222/);
});

test("the process is re-checked after the probe, by pid and not merely by presence", () => {
  /* MUTATION: delete the `[ "$STILL" = "$PID" ]` comparison -> fails.
     A CRASHED APP CAN LOOK ALIVE. `MainActivity` has `launchMode="singleTask"`
     and Android restarts a crashed foreground app readily, so "a process with
     this package name exists" is satisfied by the replacement. The pid is what
     distinguishes "still running" from "running again". */
  const s = releaseStepCode("Still alive, and nothing crashed");
  assert.ok(s, "nothing re-checks the process after the probe");
  assert.match(s, /pidof "\$PKG"/);
  assert.match(s, /\[ "\$STILL" = "\$PID" \]/, "a restarted process is a crashed process");
  assert.match(s, /FATAL EXCEPTION/, "the log must be read for a crash the process survived");
  assert.equal(failureClauses(s), 3, "gone, restarted, and fatal-in-log must each be able to fail the job");
});

test("the debug-APK stand-in is checked rather than assumed", () => {
  /* MUTATION: delete the `minifyEnabled … true` branch -> fails.
     THE ASSUMPTION THE WHOLE SMOKE JOB RESTS ON. DevTools is reachable only on a
     debuggable build (Capacitor's CapConfig defaults `webContentsDebuggingEnabled`
     to FLAG_DEBUGGABLE), so this job installs the DEBUG APK — which is worth
     something only while the two configurations compile the same code.
     Capacitor's template sets `minifyEnabled false`, so today they do. If a
     future template turns R8 on, that stops being true SILENTLY, and R8 breaking
     reflection-based plugin registration is precisely a crash only the release
     build has. */
  const s = releaseStepCode("still a fair stand-in");
  assert.ok(s, "nothing checks that the debug build still stands in for the release build");
  assert.match(s, /minifyEnabled\[\[:space:\]\]\+true/, "minification turning on must fail this job");
  assert.match(s, /minifyEnabled\[\[:space:\]\]\+false/, "and the line disappearing entirely must fail it too");
  assert.equal(failureClauses(s), 2, "both the on case and the gone case must be able to fail the job");
});

test("the run's own summary says what a launch does NOT prove", () => {
  /* MUTATION: delete the "What it does not prove" paragraph from the smoke
     summary step -> fails.
     THE HAZARD THIS REPO KEEPS PAYING FOR, with a green tick attached. A passing
     launch check is exactly the artefact that will be read as "backgrounded
     playback works", and §6.4 is a whole section on why an emulator cannot show
     that: Doze never engages, the cached-app freezer has no reason to fire, OEM
     battery managers are untestable by construction, and Bluetooth routing is
     not reachable at all. MP1 §5.4 once claimed "confirmed live" for a spike
     that never ran; the caveat goes where the tick is. */
  const summary = releaseStepCode("What the launch established");
  assert.ok(summary, "the smoke job has no summary step");
  assert.match(summary, /What it does not prove/);
  assert.match(summary, /GITHUB_STEP_SUMMARY/);
  assert.match(summary, /§6\.4/, "the summary must cite the section that says why, not merely hedge");
  const p = prose(REL);
  assert.match(p, /WHAT THIS STILL DOES NOT PROVE/);
  assert.match(p, /an emulator is not a phone/i);
});

test("the bundle summary tells a human where the artefact is and whether it is submittable", () => {
  /* MUTATION: delete the `SIGN_STATE = unsigned` branch from the summary -> fails.
     An unsigned .aab is indistinguishable from a signed one at a glance and Play
     rejects it at the upload form. A run that produced one must say so on its own
     face, next to the green tick, rather than in a step somebody has to expand. */
  const s = releaseStepCode("What this run established");
  assert.ok(s, "the bundle job has no summary step");
  assert.match(s, /This bundle cannot be submitted/);
  assert.match(s, /Ready to upload/);
  assert.match(s, /foray-android-release/, "the summary must name the artifact to download");
});
