/* The iOS workflow's own invariants (#38, MP4).
 *
 * BE HONEST ABOUT WHAT THIS FILE CAN AND CANNOT DO. It cannot run a workflow, so
 * it cannot tell you the build works — only a linked run can, and the PR body
 * says which one. What it CAN do is hold the properties that would otherwise rot
 * silently, every one of which is a decision rather than a detail:
 *
 *   - the job stays on macOS and stays OFF the required-check list,
 *   - it stays infrequent (no push, no schedule, a narrow path filter),
 *   - the build stays UNSIGNED and therefore stays runnable with no credentials,
 *   - the TestFlight upload stays gated on secrets that do not exist yet,
 *   - `ci.yml`'s `ios-kit` job — the repo's only compiled Swift — keeps running.
 *
 * WHY IT PARSES RATHER THAN GREPS, AND WHERE IT STOPS. The repo root is
 * dependency-free by design (#209 §2.4), so there is no YAML library available
 * to a root-group suite. Structure that can be read reliably without one — the
 * top-level keys, which are the ones this file makes claims about — is read by
 * indentation; everything else is a targeted assertion on the text with a
 * message that says what it is protecting. A YAML parser would be better and is
 * not worth a root dependency.
 *
 * THE READING HELPERS NOW LIVE IN `workflow-yaml.mjs`, moved there by #245 when
 * `android-workflow.test.mjs` needed the same four functions. Each of them was
 * fixed for a real defect and the comments recording those defects moved with
 * them; a hand-copied second version would have lost them. Nothing about what
 * this suite asserts changed in that move.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { topLevelKeys, block, prose, step, invocationsOf } from "./workflow-yaml.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_REL = ".github/workflows/ios-build.yml";
const WF = fs.readFileSync(path.join(ROOT, WORKFLOW_REL), "utf8");
const CI = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");

/** Every `xcodebuild` COMMAND in the workflow, as one line each. The generic
 *  half — and the comment about the log-filename defect that shaped it — is
 *  `invocationsOf` in `workflow-yaml.mjs`. */
function xcodebuildInvocations(src) {
  return invocationsOf(src, "xcodebuild");
}

/* ────────────────────────── shape and trigger set ────────────────────────── */

test("the workflow exists and its top-level keys are the expected five", () => {
  assert.deepEqual(topLevelKeys(WF), ["name", "on", "concurrency", "permissions", "jobs"]);
});

test("it runs on macOS, because that is the entire point", () => {
  /* Windows can GENERATE the Capacitor project; only a Mac can build it. If this
     line ever says ubuntu, the job becomes a very slow way to prove nothing. */
  assert.match(WF, /runs-on: macos-latest/);
});

test("it is manually dispatchable and path-filtered, and never runs on a push", () => {
  /* macOS runners bill at 10x. `push: branches: [main]` would add a run to every
     merge, and `schedule:` would add runs to days when nothing changed —
     #1641 in the sister project suspected Actions-minutes exhaustion behind a
     build freeze, so infrequency is a design constraint, not tidiness. */
  const on = block(WF, "on");
  assert.ok(on, "no `on:` block");
  assert.match(on, /workflow_dispatch:/);
  assert.match(on, /pull_request:/);
  assert.equal(/^\s{2}push:/m.test(on), false, "a push trigger would run this on every merge to main");
  assert.equal(/^\s{2}schedule:/m.test(on), false, "a schedule would run this on days nothing changed");
});

test("the trigger is `paths`, not `paths-ignore`", () => {
  /* AN ADVERSARIAL PASS DEFEATED THIS SUITE WITH ONE WORD. Changing `paths:` to
     `paths-ignore:` left all 20 tests green — every assertion below is about the
     LIST, and the list is identical — while inverting the trigger: a 15-minute
     macOS job on every PR that does NOT touch mobile/**, which is every nightly
     content PR. The cost design this file exists to hold, undone in nine
     characters. */
  const on = block(WF, "on");
  assert.match(on, /^ {4}paths:$/m, "the pull_request trigger must filter with `paths:`");
  assert.equal(
    /paths-ignore/.test(WF),
    false,
    "`paths-ignore` INVERTS the filter — this job would run on every PR that does not touch the shell"
  );
});

test("the path filter covers what the shell is built from, and nothing broader", () => {
  const on = block(WF, "on");
  for (const p of ['"mobile/**"', '"tools/mobile/**"', '"index.html"', '"app.js"', '"player/**"']) {
    assert.ok(on.includes(p), `the path filter is missing ${p}`);
  }
  /* The workflow's own path is in the filter deliberately: a CI-only change can
     only be reviewed against real output, so the PR that edits this file must
     trigger it. */
  assert.ok(on.includes(`"${WORKFLOW_REL}"`), "the workflow must trigger on changes to itself");
  /* And the filter must NOT cover the trees that produce most of this repo's
     PRs, or every nightly content PR waits on an iOS build. */
  for (const wide of ['"data/**"', '"docs/**"', '"backend/**"', '"**"', '"test/**"']) {
    assert.equal(on.includes(wide), false, `${wide} in the path filter defeats the point of having one`);
  }
});

test("concurrency cancels superseded runs", () => {
  /* Three pushes to a PR branch in five minutes would otherwise be three
     15-minute macOS jobs, two of them for code nobody will merge. */
  const c = block(WF, "concurrency");
  assert.ok(c);
  assert.match(c, /cancel-in-progress: true/);
});

test("it asks for no write permissions", () => {
  const p = block(WF, "permissions");
  assert.match(p, /contents: read/);
  for (const w of ["write", "write-all"]) {
    assert.equal(p.includes(w), false, `the iOS build has no reason to hold ${w} permission`);
  }
});

test("the job is not named like a required check", () => {
  /* `protect-main` requires `backend` and `data-and-site`, matched BY NAME. A job
     called either of those in any workflow would be reported against the same
     required context, and a 15-minute macOS build would become a gate on every
     content PR. */
  const jobs = block(WF, "jobs");
  const names = jobs
    .split(/\r?\n/)
    .filter((l) => /^ {2}[a-z][\w-]*:/.test(l))
    .map((l) => l.trim().replace(":", ""));
  assert.deepEqual(names, ["ios-shell"]);
  for (const required of ["backend", "data-and-site", "path-policy"]) {
    assert.equal(names.includes(required), false, `a job named ${required} collides with a required check`);
  }
});

test("the simulator log capture is bounded, in both directions", () => {
  /* MEASURED COST, NOT A STYLE POINT. The first run captured
     `log stream --level debug` with no predicate — a whole-device firehose — and
     the reporting step's `grep -a -i -o '.\{0,120\}…'` over the result ran for more
     than SEVEN MINUTES on a runner that bills at 10x, for two greps whose output
     nobody reads past a few hundred lines. On a 60-minute timeout that is also a
     way to lose a run that had already succeeded.

     Both ends are pinned: the capture is predicate-filtered and byte-capped, and
     the reads are whole-line with a bounded count. */
  /* COMMANDS ONLY. The comments in these steps quote the defect they fixed
     (`--level debug`, `grep -o`), so a whole-step scan fails on its own
     explanation — which is how a test ends up rewarding silence about a bug. */
  const commands = (s) =>
    s
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");

  const probe = commands(step(WF, "Run the probes") ?? "");
  assert.ok(probe);
  assert.match(probe, /log stream/);
  assert.match(probe, /--predicate/, "the log capture must be predicate-filtered, not whole-device");
  assert.equal(/--level debug/.test(probe), false, "debug level is a firehose on a shared runner");
  assert.match(probe, /head -c \d+/, "the capture must be byte-capped");

  const report = commands(step(WF, "Report what the probes established") ?? "");
  assert.ok(report);
  for (const g of report.split("\n").filter((l) => /^\s*grep\b/.test(l.trim()))) {
    assert.equal(
      /-o\b/.test(g),
      false,
      `grep -o with a counted context over a large log is the pathological case: ${g.trim()}`
    );
  }
  assert.match(report, /tail -\d+|head -\d+/, "the log reads must be bounded");
});

test("the job has a timeout", () => {
  /* A hung simulator boot on a 10x runner is the expensive failure. MP1 already
     burned ~75 minutes on three Android emulators that never booted. */
  const m = /timeout-minutes: (\d+)/.exec(WF);
  assert.ok(m, "no timeout-minutes");
  assert.ok(Number(m[1]) <= 60, `timeout is ${m[1]} minutes; keep it at or under 60`);
});

/* ───────────────────── the build stays runnable with no Apple account ────── */

test("every xcodebuild build disables code signing", () => {
  /* THE PROPERTY THAT MAKES THIS JOB USEFUL AT ALL. #38: "An unsigned build that
     always runs is worth far more than a signing job that never does." Signing
     needs credentials nobody has, so every `build` invocation must be able to
     run without them. The `archive` invocation in the gated upload step is the
     one exception and is only reached when the secrets exist. */
  const invocations = xcodebuildInvocations(WF);
  const plainBuilds = invocations.filter((c) => /\sbuild(\s|$)/.test(c) && !/-exportArchive|-archivePath/.test(c));
  assert.ok(
    plainBuilds.length >= 2,
    `expected at least two plain \`build\` invocations (simulator + device arch), found ` +
      `${plainBuilds.length} of ${invocations.length} xcodebuild invocations`
  );
  for (const c of plainBuilds) {
    assert.match(c, /CODE_SIGNING_ALLOWED=NO/, c);
    assert.match(c, /CODE_SIGNING_REQUIRED=NO/, c);
  }
});

test("both a simulator and a device architecture are BUILT, not merely mentioned", () => {
  /* They are not the same compile: the device build is arm64/Release, the
     configuration a TestFlight build would use, and it is the one that would
     catch an arch-specific or Release-only failure.

     ANCHORED TO A BUILD INVOCATION, because a whole-file `assert.match(WF,
     /-sdk iphoneos/)` was defeated by changing the device build to
     Debug/iphonesimulator: `-sdk iphoneos` still appeared, inside the gated
     archive step that has never executed. The claim is about what this job
     compiles, so it has to be read off the compile commands. */
  const builds = xcodebuildInvocations(WF).filter(
    (c) => /\sbuild(\s|$)/.test(c) && !/-exportArchive|-archivePath/.test(c)
  );
  const sdks = builds.map((c) => (/-sdk (\S+)/.exec(c) || [])[1]);
  assert.ok(sdks.includes("iphonesimulator"), `no simulator build; sdks built: ${sdks.join(", ")}`);
  assert.ok(sdks.includes("iphoneos"), `no device-architecture build; sdks built: ${sdks.join(", ")}`);
  const release = builds.find((c) => /-sdk iphoneos/.test(c));
  assert.match(release, /-configuration Release/, "the device build must use the shipping configuration");
});

test("neither build step can be made unable to fail", () => {
  /* ANOTHER ONE-EDIT DEFEAT. `continue-on-error: true` on the simulator build
     left all 20 tests green and made "PROVE THE SHELL BUILDS" — the workflow's
     primary value, and the one claim #38 can actually establish — decorative. The
     probe steps carry that flag deliberately; the build steps must never. */
  for (const fragment of ["Build for the iOS Simulator", "Build for a real device"]) {
    const s = step(WF, fragment);
    assert.ok(s, `step not found: ${fragment}`);
    assert.equal(
      /continue-on-error/.test(s),
      false,
      `"${fragment}" carries continue-on-error, so a failed build would not fail the job`
    );
  }
});

test("xcodebuild is pointed at a DETECTED container, not a hardcoded workspace", () => {
  /* THE FIRST REAL RUN OF THIS WORKFLOW FAILED HERE, and it is the most useful
     thing #38 has produced so far: Capacitor 8's iOS template is Swift Package
     Manager, so `cap add ios` writes `Package.swift` and NO `App.xcworkspace`.
     Every Capacitor guide, and HUMAN-ACTIONS.md #16 as originally written, assumes
     a CocoaPods workspace. Hardcoding `-workspace` gave xcodebuild a path that did
     not exist. */
  assert.match(WF, /node tools\/mobile\/ios-ci\.mjs xcode-container/);
  /* `-version` prints, and `-exportArchive` reads an archive rather than a
     container — neither takes one. Everything that COMPILES must. */
  const needsContainer = xcodebuildInvocations(WF).filter(
    (c) => !/-version|-exportArchive/.test(c)
  );
  assert.ok(needsContainer.length >= 3, `expected 3 container-taking invocations, found ${needsContainer.length}`);
  for (const c of needsContainer) {
    assert.match(
      c,
      /"\$XC_FLAG" "\$XC_PATH"/,
      `an xcodebuild invocation hardcodes its container instead of using the detected one: ${c}`
    );
  }
  assert.equal(
    /-workspace\s+"?mobile\//.test(WF),
    false,
    "a hardcoded -workspace path is back; Capacitor 8 generates no .xcworkspace"
  );
});

test("BOTH probe phases are installed and run, and in the right order", () => {
  /* DELETING PASS 2 WOULD OTHERWISE BE FREE. Every assertion in this file about the
     probe step is shaped around one pass, so removing the seam pass entirely would
     leave the suite green while dropping the only measurement of whether a Foray's
     31 transitions survive a locked screen. The phases are named explicitly because
     `install-probe.mjs` defaults to `outpoint`: a pass 2 that lost its `--phase seam`
     would silently re-run pass 1 and the report would say the seam measured nothing. */
  const probe = step(WF, "Run the probes") ?? "";
  assert.ok(probe, "the probe step is gone");
  const install = step(WF, "Install the probed app") ?? "";
  assert.match(install, /install-probe\.mjs "\$PROBED\/public" --phase outpoint/, "pass 1 does not name its phase");
  assert.match(probe, /--phase seam/, "pass 2 (the seam transition) is never installed");
  /* Pass 2 must REPLACE the bundle on the device, or it runs pass 1's assets. */
  assert.match(probe, /simctl terminate/, "pass 2 does not terminate the app before reinstalling");
  assert.match(probe, /simctl install/, "pass 2 never reinstalls the probed app");
  /* Two launches and two backgroundings — one per pass. */
  assert.ok(
    (probe.match(/simctl launch "\$UDID" "\$APP_ID"/g) || []).length >= 2,
    "the app is launched fewer than twice, so one pass never ran"
  );
  assert.ok(
    (probe.match(/background_it/g) || []).length >= 3,
    "backgrounding is not invoked once per pass (one definition + two calls)"
  );
  assert.ok(
    probe.indexOf("--phase seam") > probe.indexOf('simctl launch "$UDID" "$APP_ID"'),
    "the seam phase is installed before pass 1 ever ran"
  );
});

test("the backgrounded observation windows are long enough to measure anything", () => {
  /* NOTHING PINNED THE SLEEPS, and `ios-ci.mjs verdict` exits 0 for every verdict by
     design — so `sleep 90` -> `sleep 5` was a one-edit change that turned the seam
     phase into a permanent silent `inconclusive` on a green job. The floors here are
     derived, not taste: probe-outpoint arms 15 s after the page goes hidden, and
     probe-seam needs its own arm plus a beat per transition plus every middle segment
     INSIDE a window that also has to absorb however long `simctl launch
     com.apple.Preferences` takes to actually foreground Settings (39 s, measured).
     THE SEAM PASS'S ACTUAL FLOOR IS THE NEXT TEST, which derives it from
     `probe-seam.js` rather than restating it here — this one only holds the shape (two
     post-backgrounding windows exist at all). The numbers that used to be quoted in
     this paragraph — "15 s plus two ~2 s beats plus an 8 s and a 6 s segment" — were
     stale within a day, which is why the real check reads the source.
     `ios-ci.mjs` refuses a pass below 5 s of hidden playback either way, so a short
     sleep cannot produce a false pass — it can only produce a run that measured
     nothing, quietly, forever. */
  const probe = step(WF, "Run the probes") ?? "";
  const sleeps = [...probe.matchAll(/^\s*sleep (\d+)/gm)].map((m) => Number(m[1]));
  assert.ok(sleeps.length >= 4, `expected at least 4 sleeps across two passes, found ${sleeps.length}`);
  const post = sleeps.filter((s) => s >= 40);
  assert.ok(
    post.length >= 2,
    `expected two post-backgrounding windows of >= 40 s (one per pass), found ${JSON.stringify(sleeps)}`
  );
  /* The seam pass needs the longer of the two, and its floor is DERIVED from the
     probe's own constants rather than typed here — see the test below. */
  assert.ok(
    Math.max(...sleeps) >= 85,
    `the longest observation window is ${Math.max(...sleeps)} s; at the MEASURED 9.2 s beat the ` +
      `seam chain needs ~45 s (15 + 9.2 + 8 + 9.2) inside a window that also absorbs a ~39 s ` +
      `foregrounding delay`
  );
});

test("the seam window is long enough for the chain probe-seam.js actually asks for", () => {
  /* A DERIVED FLOOR, BECAUSE THE TWO NUMBERS LIVE IN DIFFERENT FILES AND ONE OF THEM
     IS GOVERNED.
     `probe-seam.js` is ungoverned and `ios-build.yml` needs a founder label, so the
     tempting order of events is to raise `ARM_AFTER_HIDDEN_SEC` in the probe, ship it
     because it auto-merges, and leave the sleep at 90 s — which does not fail
     anything. It produces a run whose first boundary is armed 60 s into a window that
     closes at ~50 s, so the record contains NO transition at all, and
     `seamTransitionVerdict` reports `inconclusive` on a GREEN job. Every seam number
     in `docs/ios-ci.md` would then be measuring a window that no longer fits its own
     probe.
     So this reads the probe's constants and the workflow's sleep and asserts the
     second covers the first. Break either and the message says which. */
  const probe = fs.readFileSync(path.join(ROOT, "tools/mobile/probe/probe-seam.js"), "utf8");
  const armSec = Number(/ARM_AFTER_HIDDEN_SEC\s*=\s*(\d+)/.exec(probe)?.[1]);
  assert.ok(Number.isFinite(armSec), "ARM_AFTER_HIDDEN_SEC is no longer a plain number in probe-seam.js");
  /* THE QUEUE LITERAL ONLY, ANCHORED ON ITS OWN DECLARATION — not "every
     `{ id, start_sec, end_sec }` object in the file". A review pointed out that a
     second such literal anywhere in `probe-seam.js` (a doc example, a future second
     queue) would silently shift which bounds count as "middle", and the shape of this
     arithmetic depends entirely on WHICH segment each bound belongs to: `seg-a`'s is
     overridden at runtime and must not be counted, and the LAST segment's length does
     not matter either, since the final transition completes the moment it becomes
     audible. An earlier version summed every match positionally, picked up `seg-c`'s
     bound as if it were `seg-b`'s, and could not see `seg-b` being lengthened past the
     window. */
  const queueSrc = /const QUEUE = \[([\s\S]*?)\];/.exec(probe)?.[1];
  assert.ok(queueSrc, "probe-seam.js no longer declares `const QUEUE = [...]`, so this test cannot read it");
  const queue = [...queueSrc.matchAll(/\{\s*id:\s*"([^"]+)"[^}]*?start_sec:\s*(\d+),\s*end_sec:\s*([^,}\s]+)/g)].map(
    (m) => ({ id: m[1], start: Number(m[2]), end: Number(m[3]) })
  );
  assert.ok(queue.length >= 3, `expected at least three queued segments in probe-seam.js, found ${queue.length}`);
  const middle = queue.slice(1, -1);
  assert.ok(
    middle.every((q) => Number.isFinite(q.end)),
    `a middle segment has a non-numeric end_sec: ${JSON.stringify(middle)}`
  );
  const middleSec = middle.reduce((n, q) => n + (q.end - q.start), 0);
  /* MEASURED, run 32036295743: the beat is max(gap, load) and the load dominated at
     9.2 s. Using 2.0 s here — the number `seam-gap.js` defines — would under-budget
     every window by 7 s per seam, which is the error the workflow's own comment was
     corrected for. */
  const MEASURED_BEAT_SEC = 9.2;
  /* One beat per transition, plus every middle segment. The LAST transition completing
     is the last thing `MIN_HIDDEN_TRANSITIONS` needs, so the final segment playing out
     is deliberately not in the floor. */
  const chainSec = armSec + MEASURED_BEAT_SEC * (queue.length - 1) + middleSec;
  /* MEASURED, run 32025079276: `simctl launch com.apple.Preferences` returned
     immediately and Settings took 39 s to actually foreground. The window starts when
     the sleep does, not when the app goes hidden. */
  const FOREGROUNDING_DELAY_SEC = 39;
  /* THE SEAM PASS'S OWN SLEEP, not the longest sleep in the step. A review found this
     taking `Math.max` over all five sleeps — two of which belong to pass 1 and one to
     the collection wait — so raising pass 1's `sleep 60` to 200 and dropping the seam
     window back to 90 would have passed this test while its failure message claimed
     "the seam window sleeps 200 s". That is the exact silent drift this test exists to
     prevent, one pass over. */
  const probeStep = step(WF, "Run the probes") ?? "";
  const passTwo = probeStep.split("--- pass 2:")[1];
  assert.ok(
    passTwo,
    "the probe step no longer contains a `--- pass 2:` marker, so the seam window cannot be located"
  );
  const seamSleeps = [...passTwo.matchAll(/^\s*sleep (\d+)/gm)].map((m) => Number(m[1]));
  assert.ok(seamSleeps.length, "pass 2 contains no `sleep` at all, so nothing waits for the seam chain");
  const longest = Math.max(...seamSleeps);
  assert.ok(
    longest >= chainSec + FOREGROUNDING_DELAY_SEC,
    `the seam window sleeps ${longest} s, but probe-seam.js asks for ${chainSec.toFixed(1)} s of hidden ` +
      `chain (arm ${armSec} s + ${queue.length - 1} beats of ${MEASURED_BEAT_SEC} s + ${middleSec} s of ` +
      `middle segment(s): ${middle.map((q) => `${q.id} ${q.start}-${q.end}`).join(", ")}) inside a window ` +
      `that must also absorb the measured ${FOREGROUNDING_DELAY_SEC} s foregrounding delay. Raise the ` +
      `sleep (governed file, founder label) or lower the arm.`
  );
});

test("the seam measurement is never collected by resuming the app", () => {
  /* THE CONFOUND THAT MADE THE ORIGINAL READING WRONG. A boundary that fires only on
     resume looks exactly like a working one if the collection path resumes the app.
     `simctl terminate` kills the outgoing app rather than foregrounding it, and the
     container read touches files on disk — so nothing between the last backgrounding
     and the read brings our app back to the front. The only `simctl launch` of
     $APP_ID after the final `background_it` would be that mistake. */
  const probe = step(WF, "Run the probes") ?? "";
  const lastBackground = probe.lastIndexOf("background_it");
  assert.ok(lastBackground > 0);
  const after = probe.slice(lastBackground);
  assert.equal(
    /simctl launch "\$UDID" "\$APP_ID"/.test(after),
    false,
    "our app is relaunched after the final backgrounding, which would resume it before the read"
  );
  assert.match(after, /get_app_container/, "the container is never read");
});

test("the two measurements are actually invoked", () => {
  /* Deleting the simulator and probe steps outright left all 20 tests green, and
     with them both things #38 exists to settle. Nothing asserted they were
     present — only that IF present they were shaped correctly. */
  assert.match(WF, /node tools\/mobile\/probe\/install-probe\.mjs/, "the bridge/out-point probe is never installed");
  assert.match(WF, /xcrun simctl bootstatus/, "no simulator is ever booted");
  assert.match(WF, /xcrun simctl launch "\$UDID" "\$APP_ID"/, "the app is never launched");
  assert.match(WF, /node tools\/mobile\/ios-ci\.mjs verdict/, "no verdict is ever reported");
  /* And the backgrounding, which is the whole out-point measurement: without it
     the probe would report a foreground run, which player/html-audio-backend.test.js
     already covers. */
  assert.match(WF, /simctl launch "\$UDID" com\.apple\./, "the app is never backgrounded");
});

test("`APP_ID` IS THE APP ID — the workflow's copy agrees with capacitor.config.json", () => {
  /* ADDED BY THE 2026-08-25 `ai.jwlabs` MOVE, the THIRD rename of this string
     (docs/DECISIONS.md), because all three had to keep these two files in sync BY
     HAND and nothing in the repo would have noticed a miss. `APP_ID` is functional,
     not documentation: `simctl launch`, `simctl terminate` and
     `simctl get_app_container` are all given it, and `cap add ios` derives the
     generated project's `PRODUCT_BUNDLE_IDENTIFIER` from `capacitor.config.json`'s
     `appId`. Diverge them and every one of those three commands addresses a bundle
     id no simulator has installed.

     THE FAILURE IS NOT A RED BUILD, WHICH IS WHY THIS IS WORTH A TEST. `simctl
     launch` on an unknown bundle id fails, the probe collects nothing, and what the
     job reports is a missing measurement — a result that reads as "the out-point
     probe regressed" rather than "a string is stale". Two renames in and
     `HUMAN-ACTIONS.md` #15 still told a founder the id lived in "exactly two
     places"; it lives in three, and this is the third.

     DERIVED from the config, not a second literal, so this cannot be satisfied by
     editing this file — the same reason the Gradle-namespace check in
     `shell-invariants.test.mjs` reads the Java's own `package` line.

     MUTATION: change `APP_ID:` in the workflow to `dev.jwlabs.foura` (its value
     before this move, i.e. exactly the miss a partial rename produces) -> fails on
     the named assertion. Deleting the line, adding a second `APP_ID:` assignment, and
     adding one that hides behind a trailing `# comment` each fail too, on their own
     message. Changing `appId` in `mobile/capacitor.config.json` instead
     fails here AND on the app-id pin in `shell-invariants.test.mjs`, which is the
     correct asymmetry: the config is the decision, this is a copy of it. */
  const appId = JSON.parse(fs.readFileSync(path.join(ROOT, "mobile/capacitor.config.json"), "utf8")).appId;
  assert.ok(appId, "mobile/capacitor.config.json declares no appId");
  /* ALL assignments, not the first. A second `APP_ID:` at step or job scope would
     SHADOW the one this test checked and the check would still pass — the same class
     of hole as reading only the new package directory in `shell-invariants.test.mjs`.
     Quotes optional, so `APP_ID: "…"` compares as the id rather than as `"…"`.

     A TRAILING YAML COMMENT IS PART OF THE LINE, and the first draft of this test was
     blind to one: with `#` excluded from the value class and `\s*$` demanding the end
     of the line, `APP_ID: dev.jwlabs.foura # oops` matched NOTHING and so was neither
     counted nor compared — a shadowing declaration could hide behind a comment in
     exactly the check written to catch shadowing. `(?:#.*)?` closes that, and it also
     stops a comment on the LEGITIMATE line from dropping the count to zero and
     reporting "the workflow no longer sets APP_ID" at a line that plainly sets it. */
  const declarations = [...WF.matchAll(/^\s*APP_ID:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm)];
  const values = declarations.map((m) => m[1]);
  assert.ok(declarations.length > 0, "the workflow no longer sets APP_ID, but simctl is still given $APP_ID");
  assert.equal(
    declarations.length,
    1,
    "APP_ID is assigned " + declarations.length + " times (" + values.join(", ") +
      "); the narrower scope silently wins and pinning one of them proves nothing"
  );
  /* EVERY declaration, not just the one the count above allows to exist. Asserted
     separately so that if a future job legitimately sets the same id twice and the
     count assertion is relaxed to permit it, the thing that actually matters — that no
     assignment anywhere names a bundle id the simulator has not installed — is still
     pinned rather than relaxed along with it. */
  for (const [i, value] of values.entries()) {
    assert.equal(
      value,
      appId,
      "the iOS workflow's APP_ID (assignment " + (i + 1) + " of " + values.length + ") is " + value +
        " but capacitor.config.json's appId is " + appId +
        "; simctl launch/terminate/get_app_container would address a bundle id the simulator has not installed"
    );
  }
});

test("the plist injection goes through the tested script, not through sed or PlistBuddy alone", () => {
  /* A `sed -i` or a bare PlistBuddy write would be untestable from this machine,
     and a silent no-op there produces an app that builds, installs, and stops
     playing the moment the screen locks. */
  assert.match(WF, /node tools\/mobile\/inject-background-audio\.mjs "\$INFO_PLIST"/);
  assert.equal(/sed -i[^\n]*Info\.plist/.test(WF), false, "the plist must not be edited with sed");
  /* PlistBuddy is present, but only to READ — Apple's own parser as a second
     opinion on our output. */
  assert.match(WF, /PlistBuddy -c "Print :UIBackgroundModes"/);
  assert.match(WF, /plutil -lint "\$INFO_PLIST"/);
});

test("the generated project is checked against the SwiftUI scaffold's directory", () => {
  /* #209's invariant 2, verified against reality rather than against config: on a
     runner the `cap add` has actually happened, so the collision can be checked
     rather than reasoned about. */
  assert.match(WF, /ios\/App\/App\.xcodeproj/);
  assert.match(WF, /ios\/ForayKit\/Package\.swift/);
});

/* ─────────────────── signing and TestFlight stay gated ───────────────────── */

test("every upload/archive step is gated on the signing gate's own output", () => {
  const guarded = WF.split(/\n(?=      - name:)/).filter((s) =>
    /altool|-exportArchive|archivePath|security import/.test(s)
  );
  assert.ok(guarded.length >= 1, "no signing/upload step found");
  for (const step of guarded) {
    assert.match(
      step,
      /if: steps\.signing\.outputs\.ready == 'true'/,
      "a signing/upload step is not gated on steps.signing.outputs.ready"
    );
  }
});

test("the gate is the tested function, not an inline expression over secrets", () => {
  /* `if: secrets.X != ''` cannot express the three-outcome rule — and the third
     outcome (SOME secrets set -> fail) is the one that saves a release cycle. */
  assert.match(WF, /node tools\/mobile\/ios-ci\.mjs signing-gate/);
});

test("no secret is echoed to the log, by either spelling", () => {
  /* CLAUDE.md decision-authority item 2. Two spellings, and the first version of
     this test only caught one: `${{ secrets.X }}` inline, and `$X` after the
     secret has been mapped into `env:` — which is how every line in the upload
     step refers to them. `echo "$IOS_DIST_CERT_P12_BASE64" | base64 --decode >
     file` is fine (a redirect, and GitHub masks the value anyway); an `echo` that
     ENDS at the console is not. */
  const names = SIGNING_SECRET_NAMES();
  for (const raw of WF.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^(echo|printf|cat)\b/.test(line)) continue;
    const mentionsSecret =
      /\$\{\{\s*secrets\./.test(line) || names.some((n) => line.includes(`$${n}`) || line.includes(`${n}}`));
    if (!mentionsSecret) continue;
    assert.ok(
      />\s*\S/.test(line) || /\|\s*base64/.test(line),
      `a secret reaches the console rather than a file: ${line}`
    );
  }
  assert.equal(/secrets\.GITHUB_TOKEN/.test(WF), false, "this workflow needs no token");
});

/** The secret names the gate declares, read from the module rather than retyped —
 *  a hardcoded list here would drift from the one the workflow actually uses. */
function SIGNING_SECRET_NAMES() {
  const src = fs.readFileSync(path.join(ROOT, "tools/mobile/ios-ci.mjs"), "utf8");
  const m = /SIGNING_SECRETS = \[([^\]]+)\]/.exec(src);
  assert.ok(m, "could not read SIGNING_SECRETS out of tools/mobile/ios-ci.mjs");
  return [...m[1].matchAll(/"([A-Z0-9_]+)"/g)].map((x) => x[1]);
}

test("every secret the gate checks is actually passed to the gate step", () => {
  /* The gate reports a secret as MISSING when it is simply not wired into the
     step's `env:` — indistinguishable, from the log, from a secret nobody set. So
     the two lists have to agree, and neither is allowed to drift alone. */
  const gateStep = step(WF, "Is signing configured?");
  assert.ok(gateStep);
  for (const name of SIGNING_SECRET_NAMES()) {
    assert.match(
      gateStep,
      new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`),
      `${name} is checked by signingReadiness() but never passed to the gate step`
    );
  }
});

test("no credential value is hardcoded anywhere in the workflow", () => {
  /* Cheap, and the kind of thing that lands by copy/paste from a tutorial. */
  assert.equal(/-----BEGIN/.test(WF), false, "a PEM block is in the workflow");
  assert.equal(/\bTEAM_ID\s*[:=]\s*["']?[A-Z0-9]{10}\b/.test(WF), false, "a literal Apple Team ID is present");
});

/* ────────────────── the existing macOS check keeps working ───────────────── */

test("ci.yml's ios-kit job is untouched and still compiles ForayKit", () => {
  /* #38 must not disturb it: `ios/ForayKit` is the only Swift in this repo CI
     compiles, it holds `IntentGrammar.swift` (no JS equivalent anywhere), and
     #209 deliberately left `ios/` in place as a separate target. */
  assert.match(CI, /^ {2}ios-kit:/m);
  assert.match(CI, /swift test --package-path ios\/ForayKit/);
  assert.match(CI, /runs-on: macos-latest/);
});

test("ci.yml still declares exactly its three jobs, and #38 added none", () => {
  /* NOT a check on the `protect-main` ruleset — that lives in GitHub's settings
     and nothing in this repo can read it. What this asserts is narrower and still
     worth having: `ci.yml` has the same three jobs it had before #38, so the two
     REQUIRED contexts (`backend`, `data-and-site`) are still produced by the job
     names they were produced by, and #38 did not quietly add a fourth. */
  const jobs = block(CI, "jobs")
    .split(/\r?\n/)
    .filter((l) => /^ {2}[a-z][\w-]*:/.test(l))
    .map((l) => l.trim().replace(":", ""));
  assert.deepEqual(jobs.sort(), ["backend", "data-and-site", "ios-kit"]);
});

/* ───────────────────────────── the cost claim ────────────────────────────── */

test("the workflow states its own cost, in both the public and private case", () => {
  /* #38 asked for the expected minutes per run to be stated. It is in the header
     because a cost that lives only in a PR body is a cost nobody can find later —
     and the 10x multiplier starts billing the day this repo stops being public.
     The figure is an ESTIMATE and the header must say so: nothing had run when it
     was written, and this repo's own research doc keeps a measured-versus-documented
     table precisely because estimates get quoted as measurements. */
  const text = prose(WF);
  assert.match(text, /10x/);
  assert.match(text, /(minutes|min \d+ s) of wall clock per run/);
  assert.match(text, /billable minutes/);
  assert.match(text, /PUBLIC/);
  assert.match(text, /estimate/i);
});

test("the runner context is not used where GitHub does not provide it", () => {
  /* A job-level `env:` can see github/needs/strategy/matrix/vars/secrets/inputs
     and NOT `runner`. Using it there is a workflow-compile error, so the job never
     starts at all — a failure mode with no log and no partial output. It was
     exactly this, caught by review rather than by a run. */
  const jobEnv = block(WF, "env", 4);
  assert.ok(jobEnv, "no job-level env block");
  assert.equal(
    /\$\{\{\s*runner\./.test(jobEnv),
    false,
    "the `runner` context is unavailable in a job-level env: block — set the path from " +
      "$RUNNER_TEMP in a step instead"
  );
});

test("the simulator caveat is in the workflow itself, not only in the report", () => {
  const text = prose(WF);
  assert.match(text, /SIMULATOR IS NOT A DEVICE/i);
  assert.match(text, /does not model power management/i);
  assert.match(text, /weaker evidence than a FAILURE/i);
});

/* ─────────── the evidence artifact must not publish a credential ──────────── */

test("the raw localStorage databases never enter the artifact directory", () => {
  /* This repo is PUBLIC and the upload step is `if: always()`, so every path
     under $ART is world-readable the moment the run finishes. A `.localstorage`
     file carries every value the app wrote, `cp_sb_session` included — which is
     the only credential that can reach that account's server rows. The copies
     therefore go to a work dir and are read there.

     Asserted as an absence, which is the only way to assert it: a future session
     adding `cp "$db" "$ART/ls/..."` back for debugging convenience is exactly
     the regression, and it would leave every other test green. */
  /* ASSERTED OVER EVERY COPYING VERB, not over one exact spelling. A review
     defeated the first version of this test with four one-line edits that all left
     it green: `cp -p "$db" "$ART/db-1.sqlite"` (the flag breaks `cp\s+"\$db"`),
     `cp -r "$WORK" "$ART/"`, `cp "$WORK/db-1.sqlite" "$ART/"`, and
     `tar -czf "$ART/ls.tgz" -C "$RUNNER_TEMP" ios-ci-ls-work`. So the rule is
     structural: no line that copies anything may mention both a raw-database
     source and $ART. */
  const COPY_VERBS = /^\s*(cp|mv|tar|rsync|install|ditto|zip)\b/;
  /* The ONE legitimate crossing from $WORK into $ART is the REDACTED rows file.
     Anything else touching a database, or the work directory as a whole, is the
     leak. Named as a single allowed filename rather than a denylist of spellings,
     so a newly added copying line is an offender until it is named here. */
  const ALLOWED_CROSSING = /"\$WORK\/ls-rows-\$i\.json"\s+"\$ART\/ls-rows-\$i\.json"/;
  const offenders = WF.split(/\r?\n/).filter((l) => {
    if (!COPY_VERBS.test(l)) return false;
    if (!/\$ART/.test(l)) return false;
    if (ALLOWED_CROSSING.test(l)) return false;
    return /\$db|\$WORK|\.sqlite|localstorage|ios-ci-ls-work/i.test(l);
  });
  assert.deepEqual(
    offenders,
    [],
    "these lines copy a raw local-storage database (or the whole work dir) into " +
      "$ART, which is a PUBLIC artifact holding cp_sb_session:\n  " + offenders.join("\n  ")
  );
  assert.equal(
    /\$ART\/ls\//.test(WF),
    false,
    "$ART/ls/ is the old raw-database directory inside the artifact; it must stay gone"
  );
  assert.match(
    WF,
    /WORK="\$RUNNER_TEMP\/ios-ci-ls-work"/,
    "the work dir the databases are read in must be outside $ART"
  );
});

test("every rows file is redacted before it is moved into the artifact", () => {
  /* The ORDER is the whole property. Redacting in place at the artifact path
     would leave an unredacted file there for as long as node takes to run, and
     `if: always()` publishes whatever is there when the job dies. */
  assert.match(
    WF,
    /redact-localstorage "\$WORK\/ls-rows-\$i\.json"/,
    "redaction must run on the work-dir copy"
  );
  assert.match(
    WF,
    /mv "\$WORK\/ls-rows-\$i\.json" "\$ART\/ls-rows-\$i\.json"/,
    "the rows file must be MOVED into $ART after redaction, not written there and edited"
  );
  /* AND THE ORDER, because the order IS the property. Asserting the two lines
     exist independently passes even if they are swapped, which would publish the
     unredacted array. Stronger still: the `mv` must sit INSIDE the `if node ...
     redact-localstorage ...; then` block, so it cannot run when redaction failed. */
  const redactIdx = WF.indexOf('redact-localstorage "$WORK/ls-rows-$i.json"');
  const mvIdx = WF.indexOf('mv "$WORK/ls-rows-$i.json" "$ART/ls-rows-$i.json"');
  assert.ok(redactIdx > 0 && mvIdx > 0);
  assert.ok(
    redactIdx < mvIdx,
    "the redaction must run BEFORE the move into $ART, not after it"
  );
  const between = WF.slice(redactIdx, mvIdx);
  assert.match(
    between,
    /;\s*then/,
    "the mv into $ART must be guarded by the redaction's own exit status (`if node " +
      "... ; then mv ...`), or a failed redaction still publishes the rows"
  );
  /* sqlite3 must not write its output straight into the artifact. */
  assert.equal(
    /> "\$ART\/ls-rows-\$i\.json"/.test(WF),
    false,
    "sqlite3 is writing unredacted rows directly into $ART"
  );
});

test("a failed redaction fails the job instead of quietly publishing nothing", () => {
  assert.match(WF, /REDACT_FAILED=1/);
  assert.match(
    WF,
    /::error::localStorage redaction failed/,
    "a redaction failure must be loud: the quiet version is two inconclusive " +
      "verdicts and a green job"
  );
  /* SCOPED TO THE BLOCK. A bare `assert.match(WF, /exit 1/)` was vacuous: the
     workflow contains four `exit 1`s, so turning THIS one into `exit 0` left the
     test green and a redaction failure back to a green job with no rows. */
  const guard = WF.slice(WF.indexOf('if [ -n "${REDACT_FAILED:-}" ]'));
  assert.ok(guard.startsWith('if [ -n "${REDACT_FAILED:-}"'), "the guard block is gone");
  const block = guard.slice(0, guard.indexOf("\n          fi"));
  assert.match(block, /::error::/);
  assert.match(block, /^\s*exit 1\s*$/m, "the REDACT_FAILED guard must exit non-zero");
});

test("the artifact upload path is exactly the report directory, not all of RUNNER_TEMP", () => {
  /* THE LAST LINE OF DEFENCE FOR $WORK, and nothing pinned it. $ART is
     $RUNNER_TEMP/ios-ci and the raw databases live in $RUNNER_TEMP/ios-ci-ls-work;
     the only thing keeping them unpublished is that the upload names the first
     directory exactly. Widening it to `${{ runner.temp }}` or adding a `*` would
     publish the databases -- and, from the gated signing steps, the keychain, the
     .p12 and ExportOptions.plist too. */
  const upload = WF.slice(WF.indexOf("actions/upload-artifact"));
  const pathLine = upload.split(/\r?\n/).find((l) => /^\s*path:/.test(l)) ?? "";
  assert.match(pathLine, /path:\s*\$\{\{\s*runner\.temp\s*\}\}\/ios-ci\s*$/, `upload path is ${pathLine.trim()}`);
  assert.equal(/\*/.test(pathLine), false, "no glob in the upload path — it would sweep in $WORK");
});
