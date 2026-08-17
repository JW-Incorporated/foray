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

/** Top-level (column-0) keys of a YAML document, in order. Comment lines and
 *  blanks are skipped; nothing nested is reported. */
function topLevelKeys(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z_][\w-]*:/.test(l))
    .map((l) => l.slice(0, l.indexOf(":")));
}

/** The lines of one block, by its owning key's indentation. */
function block(src, key, indent = 0) {
  const lines = src.split(/\r?\n/);
  const pad = " ".repeat(indent);
  const start = lines.findIndex((l) => l.startsWith(`${pad}${key}:`));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "" || lines[i].trimStart().startsWith("#")) { out.push(lines[i]); continue; }
    const lead = lines[i].length - lines[i].trimStart().length;
    if (lead <= indent) break;
    out.push(lines[i]);
  }
  return out.join("\n");
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

test("both a simulator and a device architecture are built", () => {
  /* They are not the same compile: the device build is arm64/Release, the
     configuration a TestFlight build would use, and it is the one that would
     catch an arch-specific or Release-only failure. The simulator build is the
     one the probes run in. */
  assert.match(WF, /-sdk iphonesimulator/);
  assert.match(WF, /-sdk iphoneos/);
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

test("no secret is echoed, written to a log, or committed", () => {
  /* CLAUDE.md decision-authority item 2. Base64 secrets are decoded straight into
     files; nothing prints one. */
  for (const line of WF.split(/\r?\n/)) {
    if (!/\$\{\{\s*secrets\./.test(line)) continue;
    assert.equal(
      /^\s*(echo|printf|cat)\b/.test(line.trim()),
      false,
      `a secret is being printed: ${line.trim()}`
    );
  }
  assert.equal(/secrets\.GITHUB_TOKEN/.test(WF), false, "this workflow needs no token");
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

test("the required checks in ci.yml are still exactly backend and data-and-site", () => {
  /* Read as: this change did not add a job to the required set. If a founder
     later adds one deliberately, this line is where they will notice. */
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
     and the 10x multiplier starts billing the day this repo stops being public. */
  assert.match(WF, /10x/);
  assert.match(WF, /minutes per run|minutes of wall clock per run/);
  assert.match(WF, /PUBLIC/);
});

test("the simulator caveat is in the workflow itself, not only in the report", () => {
  assert.match(WF, /SIMULATOR IS NOT A DEVICE/i);
  assert.match(WF, /weaker evidence than a FAILURE/i);
});
