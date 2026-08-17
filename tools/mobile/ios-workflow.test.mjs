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
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_REL = ".github/workflows/ios-build.yml";
const WF = fs.readFileSync(path.join(ROOT, WORKFLOW_REL), "utf8");
const CI = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");

/** Top-level (column-0) keys of a YAML document, in order. Safe because a block
 *  scalar's content must be indented deeper than its key, so nothing inside a
 *  `run: |` can sit at column 0. */
function topLevelKeys(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z_][\w-]*:/.test(l))
    .map((l) => l.slice(0, l.indexOf(":")));
}

/** The lines of one block, by its owning key's indentation.
 *
 *  COMMENTS AND BLANKS ARE SKIPPED RATHER THAN RETURNED, and that was a real
 *  defect: an earlier version pushed them, so a *comment* inside `on:` that
 *  happened to mention `"mobile/**"` satisfied the path-filter assertion below —
 *  and that block does carry comments explaining the filter. A test that a
 *  comment can satisfy is not a test. Scanning still continues through them, so a
 *  blank line does not end the block. */
function block(src, key, indent = 0) {
  const lines = src.split(/\r?\n/);
  const pad = " ".repeat(indent);
  const start = lines.findIndex((l) => l.startsWith(`${pad}${key}:`));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "" || lines[i].trimStart().startsWith("#")) continue;
    const lead = lines[i].length - lines[i].trimStart().length;
    if (lead <= indent) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** Every comment line in the file, unwrapped into one string.
 *
 *  Assertions about the header's PROSE have to read it this way: a claim like
 *  "minutes of wall clock per run" is wrapped across two `#` lines at 80 columns,
 *  so a naive regex over the raw file fails the moment someone reflows a
 *  paragraph — which is a documentation edit, not a behaviour change, and should
 *  not turn a suite red. */
function prose(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => l.trimStart().startsWith("#"))
    .map((l) => l.trimStart().replace(/^#+\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/** One step's YAML, by its `name:`. Used to assert per-step properties that a
 *  whole-file regex cannot see (a `continue-on-error` on the wrong step, say). */
function step(src, nameFragment) {
  const chunks = src.split(/\n(?= {6}- (?:name|uses):)/);
  return chunks.find((c) => c.includes(nameFragment)) ?? null;
}

/** Every `xcodebuild` COMMAND in the workflow, as one line each.
 *
 *  Backslash continuations are joined first, and the match is anchored on
 *  `xcodebuild` as a command rather than as a substring — the first version of
 *  this helper matched the filename `xcodebuild-simulator.log` and then asserted
 *  that a log path disabled code signing. */
function xcodebuildInvocations(src) {
  return src
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /(^|[;&|]\s*|^if\s+!\s+)xcodebuild\s/.test(l));
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
     probe-seam needs 15 s plus two ~2 s beats plus an 8 s and a 6 s segment (~33 s)
     INSIDE a window that also has to absorb however long `simctl launch
     com.apple.Preferences` takes to actually foreground Settings (39 s, measured).
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
  /* The seam pass needs the longer of the two. */
  assert.ok(
    Math.max(...sleeps) >= 75,
    `the longest observation window is ${Math.max(...sleeps)} s; the seam chain needs ~33 s inside ` +
      `a window that also absorbs a ~39 s foregrounding delay`
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
