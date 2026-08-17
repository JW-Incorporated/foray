/* The iOS workflow's decisions, tested on a machine with no Mac (#38, MP4).
 *
 * WHAT THESE TESTS ARE AND ARE NOT. They cover the branch behaviour of
 * `tools/mobile/ios-ci.mjs`: whether signing is configured, which simulator gets
 * booted, how a WebKit local-storage blob is decoded, and what the probe records
 * MEAN. They assert nothing whatsoever about a build, a simulator or a device —
 * #38's instruction was explicit that a test which can only pass on macOS must
 * not be written here and then reported as passing.
 *
 * THE PROPERTY WORTH THE MOST. Every verdict function must land on
 * "inconclusive" when the data is absent, empty or malformed — never on the good
 * outcome. This repo has twice shipped a conclusion drawn from a measurement
 * that did not happen (`corpus eval`'s Recall@5 that was really hit rate; MP1's
 * emulator run that produced nothing), so the absent-data direction is tested
 * harder here than the happy path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawnSync } from "node:child_process";

/** This suite reads two SOURCE files to pin constants that cannot be imported
 *  across the CI/browser boundary — see the SEAM_ASKED_MS tests. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

import {
  MP1_ALIGNED_TIMER_PREDICTION_SEC,
  MIN_HIDDEN_PLAYBACK_SEC,
  MP1_TIMEUPDATE_PREDICTION_SEC,
  OVERSHOOT_BAD_SEC,
  OVERSHOOT_OK_SEC,
  ARTIFACT_VALUE_ALLOWLIST,
  SIGNING_SECRETS,
  SIMULATOR_CAVEAT,
  bridgeVerdict,
  collectProbes,
  decodeLocalStorageRows,
  medianMs,
  outPointVerdict,
  parseConsoleProbes,
  parseDump,
  pickOutPoint,
  pickSeam,
  pickXcodeContainer,
  pickSimulator,
  redactLocalStorageRows,
  renderReport,
  signingReadiness,
  LOCAL_MEDIA_CAVEAT,
  MIN_HIDDEN_TRANSITIONS,
  MIN_HIDDEN_WINDOW_SEC,
  SEAM_ASKED_MS,
  SEAM_MIN_PLAUSIBLE_MS,
  SEAM_BAD_MS,
  SEAM_OK_MS,
  seamTransitionVerdict,
  saveTrailAnalysis,
  parseSimulatorLifecycle,
  suspensionVerdict,
  SAVE_TRAIL_GAP_MS,
  AUDIO_FLOWED_RATIO,
  RECORD_TAIL_TOLERANCE_SEC,
} from "./ios-ci.mjs";

const allSecrets = () => Object.fromEntries(SIGNING_SECRETS.map((k) => [k, "x"]));

/* ─────────────────────────────── signing gate ────────────────────────────── */

test("with every secret set, signing is ready", () => {
  const r = signingReadiness(allSecrets());
  assert.equal(r.state, "ready");
  assert.equal(r.ready, true);
  assert.deepEqual(r.missing, []);
});

test("with no secrets set, the upload is skipped and that is NOT a failure", () => {
  /* Today's state, and #38's whole point: an unsigned build that always runs is
     worth more than a signing job that never does. */
  const r = signingReadiness({});
  assert.equal(r.state, "absent");
  assert.equal(r.ready, false);
  assert.equal(r.missing.length, SIGNING_SECRETS.length);
  assert.match(r.message, /HUMAN-ACTIONS\.md #19/);
});

test("a HALF-configured signing setup is an error, not a skip", () => {
  /* THE ONE THAT MATTERS. Somebody sets six of the seven secrets; the run goes
     green; no build reaches TestFlight; nobody finds out until a release is
     expected. Failing loud here costs one red X and saves a release cycle. */
  const env = allSecrets();
  delete env.APP_STORE_CONNECT_ISSUER_ID;
  const r = signingReadiness(env);
  assert.equal(r.state, "partial");
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing, ["APP_STORE_CONNECT_ISSUER_ID"]);
  assert.match(r.message, /HALF configured/);
  assert.match(r.message, /APP_STORE_CONNECT_ISSUER_ID/);
});

test("an empty or whitespace secret counts as missing", () => {
  /* GitHub substitutes an unset secret as the empty string, so `if: secrets.X !=
     ''` and a naive `key in env` disagree — and the naive one reads a run with
     seven blank secrets as fully configured, then fails deep inside xcodebuild. */
  for (const blank of ["", "   ", "\n", "\t"]) {
    const env = { ...allSecrets(), APPLE_TEAM_ID: blank };
    assert.equal(signingReadiness(env).state, "partial", `accepted ${JSON.stringify(blank)}`);
  }
});

test("unrelated environment variables cannot make signing look ready", () => {
  /* The CLI passes the whole `process.env`, which on a runner is ~80 variables. */
  const r = signingReadiness({ HOME: "/Users/runner", CI: "true", GITHUB_TOKEN: "ghs_x" });
  assert.equal(r.state, "absent");
});

test("the secret list has no duplicates and names no value", () => {
  assert.equal(new Set(SIGNING_SECRETS).size, SIGNING_SECRETS.length);
  for (const name of SIGNING_SECRETS) {
    assert.match(name, /^[A-Z0-9_]+$/, `${name} does not look like a secret NAME`);
  }
});

/* ──────────────────── what xcodebuild gets pointed at ─────────────────────── */

test("a SwiftPM-only project is built with -project", () => {
  /* MEASURED BY THE FIRST REAL RUN, not assumed. Capacitor 8's iOS template is
     Swift Package Manager: the run logged "All Capacitor plugins have a
     Package.swift file", then "Writing Package.swift", then "ios platform added!"
     — no `pod install` and no `App.xcworkspace`. Every Capacitor guide, and
     HUMAN-ACTIONS.md #16 as first written, assumes a CocoaPods workspace, and
     hardcoding `-workspace` handed xcodebuild a path that did not exist. */
  const c = pickXcodeContainer({ project: "mobile/ios/App/App.xcodeproj" });
  assert.equal(c.flag, "-project");
  assert.equal(c.path, "mobile/ios/App/App.xcodeproj");
  assert.equal(c.toolchain, "swiftpm-project");
});

test("a workspace wins when both exist, which is Xcode's own rule", () => {
  /* Both are live possibilities: SPM is 8.x today, and a `cap` release or a
     hand-added CocoaPods dependency could put a workspace back. A workspace exists
     precisely to be built instead of the projects inside it. */
  const c = pickXcodeContainer({
    workspace: "mobile/ios/App/App.xcworkspace",
    project: "mobile/ios/App/App.xcodeproj",
  });
  assert.equal(c.flag, "-workspace");
  assert.equal(c.toolchain, "cocoapods-workspace");
});

test("neither container present THROWS rather than guessing a path", () => {
  /* A silent fallback would hand xcodebuild a missing path, and the build failure
     would be about the wrong thing entirely. */
  assert.throws(() => pickXcodeContainer({}), /neither an \.xcworkspace nor an \.xcodeproj/);
  assert.throws(() => pickXcodeContainer(), /neither an \.xcworkspace nor an \.xcodeproj/);
  assert.throws(() => pickXcodeContainer({ workspace: null, project: null }), /Nothing can be built/);
});

/* ─────────────────────────── choosing a simulator ────────────────────────── */

const SIMCTL = {
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
      { name: "iPhone 15 Pro", udid: "OLD-PRO", isAvailable: true },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
      { name: "iPhone 16 Pro Max", udid: "NEW-MAX", isAvailable: true },
      { name: "iPhone 16", udid: "NEW-PLAIN", isAvailable: true },
      { name: "iPhone 16 Plus", udid: "NEW-PLUS", isAvailable: true },
    ],
    "com.apple.CoreSimulator.SimRuntime.tvOS-18-2": [
      { name: "Apple TV", udid: "TV", isAvailable: true },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-11-2": [
      { name: "Apple Watch Series 10 (46mm)", udid: "WATCH", isAvailable: true },
    ],
  },
};

test("the newest iOS runtime's plainest iPhone is chosen", () => {
  const sim = pickSimulator(SIMCTL);
  assert.equal(sim.udid, "NEW-PLAIN");
  assert.equal(sim.name, "iPhone 16");
});

test("tvOS, watchOS and iPads are not iPhones", () => {
  const listing = {
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
        { name: 'iPad Pro 13-inch (M4)', udid: "IPAD", isAvailable: true },
        { name: "iPhone 16", udid: "PHONE", isAvailable: true },
      ],
      "com.apple.CoreSimulator.SimRuntime.xrOS-2-2": [
        { name: "Apple Vision Pro", udid: "VISION", isAvailable: true },
      ],
    },
  };
  assert.equal(pickSimulator(listing).udid, "PHONE");
});

test("an unavailable device is never chosen", () => {
  const listing = {
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
        { name: "iPhone 16", udid: "BROKEN", isAvailable: false },
        { name: "iPhone 16 Pro", udid: "OK", isAvailable: true },
      ],
    },
  };
  assert.equal(pickSimulator(listing).udid, "OK");
});

test("runtime versions sort numerically, not as strings", () => {
  /* `"iOS-9-0" > "iOS-18-0"` as strings. Xcode ships two or three runtimes on a
     macos-latest image and the versions cross ten regularly. */
  const listing = {
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-9-3": [{ name: "iPhone 16", udid: "ANCIENT", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ name: "iPhone 16", udid: "MODERN", isAvailable: true }],
    },
  };
  assert.equal(pickSimulator(listing).udid, "MODERN");
});

test("JSON is accepted as a string as well as an object", () => {
  assert.equal(pickSimulator(JSON.stringify(SIMCTL)).udid, "NEW-PLAIN");
});

test("no iPhone, or unparseable JSON, THROWS rather than returning nothing", () => {
  /* A silent null here would skip the simulator steps, and the run would report
     #38's two measurements as "not attempted" with no reason given — the shape
     this whole file exists to prevent. */
  assert.throws(() => pickSimulator("{not json"), /no `devices` key/);
  assert.throws(() => pickSimulator({}), /no `devices` key/);
  assert.throws(() => pickSimulator({ devices: {} }), /no available iPhone/);
  assert.throws(
    () => pickSimulator({ devices: { "com.apple.CoreSimulator.SimRuntime.tvOS-18-2": [{ name: "Apple TV", udid: "T" }] } }),
    /no available iPhone/
  );
});

/* ───────────────── getting the numbers off the simulator ─────────────────── */

const hex = (s, enc) => Buffer.from(s, enc).toString("hex");

test("a UTF-16LE localStorage blob is decoded, not read as mojibake", () => {
  /* WebKit has stored localStorage values as UTF-16LE BLOBs for most of its
     history. `cast(value as text)` on one yields NUL-interleaved bytes that fail
     JSON.parse — which would have been reported as "the probe said nothing",
     from a run in which the probe said everything. */
  const rows = [{ key: "foray_probe_bridge", hexval: hex('{"capacitorType":"object"}', "utf16le") }];
  assert.deepEqual(decodeLocalStorageRows(rows), {
    foray_probe_bridge: '{"capacitorType":"object"}',
  });
});

test("a UTF-8 localStorage blob is decoded too", () => {
  const rows = [{ key: "k", hexval: hex('{"a":1}', "utf8") }];
  assert.deepEqual(decodeLocalStorageRows(rows), { k: '{"a":1}' });
});

test("decoding survives empty, null and malformed rows", () => {
  const rows = [null, {}, { key: "a" }, { key: "b", hexval: "" }, { key: "c", hexval: null }];
  assert.deepEqual(decodeLocalStorageRows(rows), {});
  assert.deepEqual(decodeLocalStorageRows([]), {});
  assert.deepEqual(decodeLocalStorageRows(undefined), {});
});

test("the most informative out-point record wins, not the last one", () => {
  /* `simctl launch` on a running app can restart it, and a restart writes a
     fresh EMPTY record. "Take the last" would systematically prefer the run that
     measured nothing. */
  const empty = { endSec: 25, stoppedAtSec: null, backgroundedAtWall: null };
  const finished = { endSec: 25, stoppedAtSec: 25.2, backgroundedAtWall: 1000, timeupdateIntervalsMs: [250] };
  assert.equal(pickOutPoint([finished, empty]), finished);
  assert.equal(pickOutPoint([empty, finished]), finished);
  assert.equal(pickOutPoint([empty]), empty);
  assert.equal(pickOutPoint([]), null);
  assert.equal(pickOutPoint(null), null);
});

test("a backgrounded record that NEVER FIRED beats a tidy foreground one", () => {
  /* AN ADVERSARIAL PASS FOUND THIS RANKED THE WRONG WAY ROUND, and it discarded
     the single most valuable result this workflow can produce. `stoppedAtSec` used
     to outscore `backgroundedAtWall`, so a restarted run that played in the
     FOREGROUND and stopped cleanly beat the real backgrounded run in which the
     out-point never fired — and `never-fired` is the outcome MP1 §8 said would
     force a native iOS backend (#28). A record that never left the foreground
     cannot answer #38's question at all, however tidy it looks. */
  const foregroundPass = { endSec: 25, stoppedAtSec: 25.01, backgroundedAtWall: null };
  const backgroundedFailure = { endSec: 25, stoppedAtSec: null, backgroundedAtWall: 1000 };
  assert.equal(pickOutPoint([foregroundPass, backgroundedFailure]), backgroundedFailure);
  assert.equal(outPointVerdict(pickOutPoint([foregroundPass, backgroundedFailure])).verdict, "never-fired");
});

test("the console log is a second channel, not decoration", () => {
  /* The primary channel is WebKit's local-storage database, located by FILENAME —
     a name WebKit has changed before. If that find stops matching, every verdict
     reads `inconclusive` and the job is GREEN: #38 producing nothing, forever,
     with no error anywhere. An earlier version captured these console lines into
     the artifact and never read them. */
  const log = [
    "2026-08-17 12:00:00.000 Df App[123:456] ⚡️  [log] - FORAY_PROBE_BRIDGE {\"capacitorType\":\"object\",\"isNativePlatform\":true}",
    "some unrelated line",
    'FORAY_PROBE_OUTPOINT {"endSec":25,"stoppedAtSec":25.3,"backgroundedAtWall":9,"stoppedWhileBackgrounded":true}',
  ].join("\n");
  const c = parseConsoleProbes(log);
  assert.equal(c.bridge.length, 1);
  assert.equal(c.outPoints.length, 1);

  const both = collectProbes({ dump: {}, consoleText: log });
  assert.equal(both.sources.bridge, "console");
  assert.equal(both.sources.outPoint, "console");
  assert.equal(bridgeVerdict(both.bridge).verdict, "bridge-present");
  assert.equal(outPointVerdict(both.outPoint).verdict, "fires-in-background");
});

test("localStorage wins over the console when both have an answer", () => {
  /* The database does not depend on the bridge being alive; the console channel
     does (Capacitor forwards console output to print()). So the console can rescue
     an out-point run and can never rescue a `bridge-blocked` one — which is why it
     is second. */
  const dump = { foray_probe_bridge: '{"capacitorType":"undefined"}' };
  const log = 'FORAY_PROBE_BRIDGE {"capacitorType":"object","isNativePlatform":true}';
  const c = collectProbes({ dump, consoleText: log });
  assert.equal(c.sources.bridge, "localStorage");
  assert.equal(bridgeVerdict(c.bridge).verdict, "bridge-blocked");
});

test("collectProbes and parseConsoleProbes survive junk and truncation", () => {
  const none = { bridge: [], outPoints: [], seams: [] };
  assert.deepEqual(parseConsoleProbes(""), none);
  assert.deepEqual(parseConsoleProbes(null), none);
  assert.deepEqual(parseConsoleProbes("FORAY_PROBE_BRIDGE not json at all"), none);
  /* The seam phase logs on the same channel, and it must be routed to its own
     bucket: a seam record parsed as an out-point record would be scored by
     `pickOutPoint` and could displace the real one. */
  const seamLine = 'FORAY_PROBE_SEAM {"phase":"seam","transitions":[]}';
  assert.equal(parseConsoleProbes(seamLine).seams.length, 1);
  assert.equal(parseConsoleProbes(seamLine).outPoints.length, 0);
  /* Log lines get truncated mid-record; the recoverable prefix is used. */
  const truncated = 'FORAY_PROBE_BRIDGE {"capacitorType":"object","isNativePlatform":true} tail junk {';
  assert.equal(parseConsoleProbes(truncated).bridge.length, 1);
  const empty = collectProbes({});
  assert.equal(empty.bridge, null);
  assert.equal(empty.outPoint, null);
  assert.equal(empty.sources.bridge, "none");
});

test("parseDump finds the bridge record and every numbered out-point slot", () => {
  const dump = {
    foray_probe_bridge: '{"capacitorType":"object","isNativePlatform":true}',
    foray_probe_outpoint: '{"endSec":25,"stoppedAtSec":null}',
    foray_probe_outpoint_1: '{"endSec":25,"stoppedAtSec":25.4,"backgroundedAtWall":5}',
    cp_something_else: "not ours",
    foray_probe_outpoint_bogus: "{}",
  };
  const p = parseDump(dump);
  assert.equal(p.bridge.isNativePlatform, true);
  assert.equal(p.outPoints.length, 2, "the `_bogus` key is not a numbered slot");
  assert.equal(p.outPoint.stoppedAtSec, 25.4);
});

test("parseDump does not throw on junk", () => {
  const empty = { bridge: null, outPoints: [], outPoint: null, seams: [], seam: null };
  assert.deepEqual(parseDump({}), empty);
  assert.deepEqual(parseDump(undefined), empty);
  assert.equal(parseDump({ foray_probe_bridge: "{not json" }).bridge, null);
});

test("parseDump reads the seam phase's numbered slots too", () => {
  /* Same slot scheme as the out-point's, and for the same reason: `simctl launch` on
     a running app can restart it, and a restart's empty record must not overwrite a
     finished one. */
  const p = parseDump({
    foray_probe_seam: JSON.stringify({ phase: "seam", items: [], transitions: [] }),
    foray_probe_seam_1: JSON.stringify({
      phase: "seam",
      items: [{ id: "seg-a" }],
      transitions: [{ boundaryAtWall: 5 }],
      backgroundedAtWall: 1,
    }),
    foray_probe_seam_bogus: "{}",
  });
  assert.equal(p.seams.length, 2, "the `_bogus` key is not a numbered slot");
  assert.equal(p.seam.backgroundedAtWall, 1, "pickSeam must prefer the record that was backgrounded");
});

/* ──────────────────────── the bridge / CSP verdict ───────────────────────── */

test("no probe data is INCONCLUSIVE, and says the risk is unchanged", () => {
  for (const nothing of [null, undefined, {}, "", 7, { unrelated: true }]) {
    const v = bridgeVerdict(nothing);
    assert.equal(v.verdict, "inconclusive", `${JSON.stringify(nothing)} was not inconclusive`);
    assert.match(v.detail, /Do not\s+read it as a pass|Do not read it as a pass/);
  }
});

test("window.Capacitor present and native is the good outcome, scoped to iOS", () => {
  const v = bridgeVerdict({
    capacitorType: "object",
    isNativePlatform: true,
    platform: "ios",
    pluginNames: ["App", "Preferences", "SplashScreen", "StatusBar"],
    cspViolations: [],
    swRegistrations: 0,
  });
  assert.equal(v.verdict, "bridge-present");
  assert.match(v.headline, /EXISTS on iOS/);
  /* The claim must not creep. Android's bridge is injected by a different
     mechanism and stays unproven — HUMAN-ACTIONS.md #18. */
  assert.match(v.detail, /NOTHING about Android/);
  assert.match(v.detail, /0 registrations/);
});

test("a missing bridge WITH a script-src violation names the CSP as the cause", () => {
  const v = bridgeVerdict({ capacitorType: "undefined", cspViolations: [{ directive: "script-src" }] });
  assert.equal(v.verdict, "bridge-blocked");
  assert.match(v.headline, /UNDEFINED/);
  assert.equal(v.cspAttributable, true);
  assert.match(v.detail, /the CSP is the \s*likely cause|CSP is the likely cause/);
});

test("a missing bridge with NO violation must not blame the CSP", () => {
  /* AN ADVERSARIAL PASS CAUGHT THIS ASSERTING A CAUSE IT HAD NO EVIDENCE FOR. On
     iOS the CSP is the LEAST likely explanation — docs/mobile-shell.md §5 reasons
     that WKWebView injects via WKUserScript, outside the document's CSP — so a
     failed `cap add`, a broken config or a probe that ran before injection are all
     likelier. Turning a harness failure into a decisive architectural finding is
     precisely how a false claim ends up in a doc, which is what this repo has been
     burned by twice. */
  const v = bridgeVerdict({ capacitorType: "undefined", cspViolations: [] });
  assert.equal(v.verdict, "bridge-blocked");
  assert.equal(v.cspAttributable, false);
  assert.match(v.detail, /CAUSE IS UNKNOWN/);
  assert.equal(/the CSP is the likely cause/.test(v.detail), false);
  assert.equal(/the CSP blocked the bridge/.test(v.headline), false);
});

test("a service worker registered inside the shell is reported as broken", () => {
  /* Invariant 3's consequence, measured. One registration means the shell will
     serve its own stale cache after a store update. */
  const v = bridgeVerdict({
    capacitorType: "object",
    isNativePlatform: true,
    hasServiceWorkerApi: true,
    swRegistrations: 1,
  });
  assert.equal(v.verdict, "bridge-present");
  assert.match(v.detail, /invariant 3 is BROKEN/);
});

test("zero registrations is only evidence if the API existed to be asked", () => {
  /* `swRegistrations: 0` with no `navigator.serviceWorker` is true by
     construction, and reporting it as "invariant 3 holding" would be a pass drawn
     from an absence — the failure this whole file is written to refuse. */
  const measured = bridgeVerdict({
    capacitorType: "object", isNativePlatform: true, hasServiceWorkerApi: true, swRegistrations: 0,
  });
  assert.match(measured.detail, /0 registrations inside the shell, which is invariant 3 holding/);
  assert.equal(measured.swRegistrations, 0);

  const unmeasurable = bridgeVerdict({
    capacitorType: "object", isNativePlatform: true, hasServiceWorkerApi: false, swRegistrations: 0,
  });
  assert.equal(unmeasurable.swRegistrations, null);
  assert.match(unmeasurable.detail, /says nothing either way/);
  assert.equal(/invariant 3 holding/.test(unmeasurable.detail), false);
});

test("a bridge that reports the WEB platform inside the app is its own verdict", () => {
  /* Not the good outcome and not the blocked outcome: app.js's guard would treat
     it as the web and register the service worker. */
  const v = bridgeVerdict({ capacitorType: "object", isNativePlatform: false, platform: "web" });
  assert.equal(v.verdict, "bridge-present-not-native");
  assert.match(v.detail, /service worker WOULD register/);
});

test("a bridge whose isNativePlatform() threw is not read as native", () => {
  const v = bridgeVerdict({ capacitorType: "object", isNativePlatform: "threw: bridge not ready" });
  assert.equal(v.verdict, "bridge-present-not-native");
});

test("an unexpected typeof is inconclusive rather than forced into a bucket", () => {
  const v = bridgeVerdict({ capacitorType: "function" });
  assert.equal(v.verdict, "inconclusive");
});

/* ─────────────────────── the backgrounded out-point ──────────────────────── */

const base = {
  endSec: 25,
  backgroundedAtWall: 1000,
  stoppedWhileBackgrounded: true,
  /* 15 s, because the probe arms the boundary 15 s after the page goes hidden.
     A fixture below MIN_HIDDEN_PLAYBACK_SEC is a `hidden-window-too-short` run,
     which is its own verdict — see the test for it. */
  hiddenPlaybackSec: 15.2,
  hiddenTimeupdates: 60,
  armedWhileHidden: true,
  timeupdateIntervalsMs: [250, 251, 249, 252],
};

test("no out-point data leaves MP1's inference untouched", () => {
  for (const nothing of [null, {}, { endSec: "25" }]) {
    const v = outPointVerdict(nothing);
    assert.equal(v.verdict, "inconclusive");
    assert.match(v.headline, /UNCHANGED/);
  }
});

test("a sub-second overshoot while backgrounded is the good outcome", () => {
  const v = outPointVerdict({ ...base, stoppedAtSec: 25.24, overshootSec: 0.24 });
  assert.equal(v.verdict, "fires-in-background");
  assert.match(v.headline, /0\.240s past end_sec/);
  assert.match(v.detail, /Hidden playback observed: 15\.200s/);
  assert.match(v.detail, /Median timeupdate interval while hidden: 251 ms/);
  assert.equal(v.medianTimeupdateMs, 250.5);
});

test("the 1.5s tolerance is OURS, and MP1's two predictions are reported as MP1's", () => {
  /* AN ADVERSARIAL PASS CAUGHT THIS FILE ATTRIBUTING ITS OWN THRESHOLD TO THE
     SOURCE: the headline said "inside MP1 §8's predicted 1.5s band", and 1.5 does
     not appear anywhere in that document. Its predictions are ~0.25 s if
     `timeupdate` survives and ~1 s if only the aligned DOM timer does. Worse, those
     two are DIFFERENT VERDICTS about the inference — and both used to render as one
     sentence, hiding the actual finding. */
  assert.equal(OVERSHOOT_OK_SEC, 1.5);
  assert.equal(MP1_TIMEUPDATE_PREDICTION_SEC, 0.25);
  assert.equal(MP1_ALIGNED_TIMER_PREDICTION_SEC, 1);

  const held = outPointVerdict({ ...base, stoppedAtSec: 25.24, overshootSec: 0.24 });
  assert.match(held.headline, /this workflow's 1\.5s tolerance/);
  assert.match(held.detail, /inference HELD/);

  /* Same overshoot band, ~1 s timers: the inference did NOT hold, and the report
     has to say which mechanism carried it. */
  const timerOnly = outPointVerdict({
    ...base,
    timeupdateIntervalsMs: [1000, 1001, 999, 1002],
    stoppedAtSec: 26.1,
    overshootSec: 1.1,
  });
  assert.equal(timerOnly.verdict, "fires-in-background");
  assert.match(timerOnly.detail, /did \s*NOT hold|did NOT hold/);
  assert.match(timerOnly.detail, /aligned DOM timer covered for it/);

  /* And with no samples at all it must not guess which one it was. */
  const unknown = outPointVerdict({ ...base, timeupdateIntervalsMs: [], stoppedAtSec: 25.2, overshootSec: 0.2 });
  assert.match(unknown.detail, /which of MP1 §8's two mechanisms carried this is unknown/);
});

test("a 0.4-second hidden window is NOT a measurement of backgrounding", () => {
  /* THE OVERCLAIM THE FIRST REAL RUN SHIPPED, now a named verdict. That run
     reported `fires-in-background`, a 4 ms overshoot and "MP1 §8's inference
     HELD" — from a hidden window of 0.446 s and TWO hidden timeupdate samples.
     The page had been VISIBLE for 24.5 of the 25 s, because `simctl launch
     com.apple.Preferences` returns before Settings reaches the foreground.
     Every sentence in that verdict was true and none of it was evidence. */
  const v = outPointVerdict({
    ...base,
    hiddenPlaybackSec: 0.446,
    hiddenTimeupdates: 2,
    stoppedAtSec: 25.008,
    overshootSec: 0.004,
  });
  assert.equal(v.verdict, "hidden-window-too-short");
  assert.match(v.headline, /only for 0\.446s, which is not a measurement of backgrounding/);
  assert.match(v.detail, /2 hidden timeupdate samples/);
  assert.equal(v.hiddenPlaybackSec, 0.446);
  /* And it must not read as the good outcome anywhere in the sentence. */
  assert.equal(/inference HELD/.test(v.detail), false);
});

test("the hidden-window floor is pinned, and a healthy run clears it 3x", () => {
  assert.equal(MIN_HIDDEN_PLAYBACK_SEC, 5);
  /* The probe arms 15 s after going hidden, so the designed margin is 3x. Just
     under and just over the floor are different verdicts. */
  assert.equal(
    outPointVerdict({ ...base, hiddenPlaybackSec: 4.99, stoppedAtSec: 25.2, overshootSec: 0.2 }).verdict,
    "hidden-window-too-short"
  );
  assert.equal(
    outPointVerdict({ ...base, hiddenPlaybackSec: 5.01, stoppedAtSec: 25.2, overshootSec: 0.2 }).verdict,
    "fires-in-background"
  );
});

test("a record with no hidden-window figure is not silently treated as clearing the floor", () => {
  /* An older probe build, or a truncated console record, has no
     `hiddenPlaybackSec`. It must not therefore skip the floor unnoticed — the
     detail has to say the figure is missing. */
  const v = outPointVerdict({ ...base, hiddenPlaybackSec: undefined, stoppedAtSec: 25.2, overshootSec: 0.2 });
  assert.match(v.detail, /length of the hidden window was not recorded/);
});

test("an unarmed record is inconclusive, not malformed", () => {
  /* `endSec: null` is the normal not-yet-armed state now that the boundary is
     armed relative to going hidden. */
  const v = outPointVerdict({ phase: "outpoint", endSec: null, armedWhileHidden: null });
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.headline, /never armed/);
  const blocked = outPointVerdict({
    phase: "outpoint", endSec: null, armedWhileHidden: null,
    autoplayBlocked: true, autoplayError: "NotAllowedError",
  });
  assert.match(blocked.detail, /NotAllowedError/);
});

test("a natural file end is NOT read as the out-point firing", () => {
  /* THE FALSE-PASS THIS SUITE MOST NEEDED. `html-audio-backend.js` reports the
     same `onItemEnded` for a finished FILE ("natural") as for a boundary
     ("outPoint") — deliberately, so the manager cannot tell them apart. Here they
     are opposite results: if the tone ran out first, the overshoot would look
     perfect and mean nothing at all. The 150 s tone is a margin; this is the check. */
  const natural = outPointVerdict({ ...base, stoppedAtSec: 25.4, overshootSec: 0.4, endReason: "natural" });
  assert.equal(natural.verdict, "inconclusive");
  assert.match(natural.headline, /"natural", not at the out-point/);
  assert.match(natural.detail, /TONE_SECONDS/);

  const weird = outPointVerdict({ ...base, stoppedAtSec: 25.4, endReason: "somethingElse" });
  assert.equal(weird.verdict, "inconclusive");

  /* The real one still passes. "outPoint" is END_OUT_POINT in player/queue-state.js. */
  const real = outPointVerdict({ ...base, stoppedAtSec: 25.4, overshootSec: 0.4, endReason: "outPoint" });
  assert.equal(real.verdict, "fires-in-background");
});

test("an out-point that only fires on resume, LATE, is the failure mode", () => {
  /* THE SHAPE MP1 §8 WARNED ABOUT. The audio kept playing and nothing stopped it
     until the app was foregrounded, so the overshoot is bounded by the length of
     the commute rather than by anything in the code. */
  const v = outPointVerdict({
    ...base,
    stoppedWhileBackgrounded: false,
    stoppedAtSec: 78.6,
    overshootSec: 53.6,
  });
  assert.equal(v.verdict, "fired-on-resume");
  assert.match(v.headline, /ONLY ON RESUME/);
  assert.match(v.detail, /the whole commute/);
});

test("a 3-MILLISECOND overshoot is not `fired-on-resume`, however the flag reads", () => {
  /* A FALSE ALARM THE SECOND REAL RUN ACTUALLY EMITTED. It reported
     `fired-on-resume` — "MP1 §8's failure mode" — with an overshoot of 0.003 s. The
     two cannot both be true: an out-point that had genuinely stopped firing while
     backgrounded would overshoot by however long the app stayed backgrounded, not
     by milliseconds. 3 ms means the boundary was crossed while the page was
     VISIBLE, i.e. the harness failed to background in time. Left alone, this is a
     harness artifact wearing the label of an architectural failure — and #28 is a
     decision someone could make on it. */
  const v = outPointVerdict({
    ...base,
    stoppedWhileBackgrounded: false,
    stoppedAtSec: 25.006,
    overshootSec: 0.003,
  });
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.headline, /crossed while the page was VISIBLE/);
  assert.match(v.detail, /NOT MP1 §8's failure mode/);
  /* The scary phrase must be absent, not merely qualified. */
  assert.equal(/the whole commute/.test(v.detail), false);
});

test("an out-point that never fired at all names the 936.5 s cost", () => {
  const v = outPointVerdict({ ...base, stoppedAtSec: null });
  assert.equal(v.verdict, "never-fired");
  assert.match(v.detail, /936\.5 s median/);
  assert.match(v.detail, /native audio backend/);
});

test("the three overshoot bands are pinned, because they are the judgement", () => {
  /* Pinned literally: these thresholds are the difference between "ship the
     shell with a caveat" and "iOS needs a native backend", and moving one should
     require editing a test and saying why. */
  assert.equal(OVERSHOOT_OK_SEC, 1.5);
  assert.equal(OVERSHOOT_BAD_SEC, 10);
  assert.equal(outPointVerdict({ ...base, stoppedAtSec: 26.4, overshootSec: 1.4 }).verdict, "fires-in-background");
  assert.equal(outPointVerdict({ ...base, stoppedAtSec: 28, overshootSec: 3 }).verdict, "fires-late");
  assert.equal(outPointVerdict({ ...base, stoppedAtSec: 60, overshootSec: 35 }).verdict, "fires-far-too-late");
});

test("overshoot is derived when the backend did not report one", () => {
  const v = outPointVerdict({ ...base, stoppedAtSec: 25.8 });
  assert.equal(Math.round(v.overshootSec * 1000), 800);
});

test("blocked autoplay is a finding about the harness, not about backgrounding", () => {
  const v = outPointVerdict({ ...base, autoplayBlocked: true, autoplayError: "NotAllowedError" });
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.detail, /NotAllowedError/);
  assert.match(v.detail, /MP1 §7\.3/);
});

test("an app that never left the foreground measures nothing new", () => {
  /* An out-point firing in a VISIBLE page is what player/html-audio-backend.test.js
     already covers. Reporting it as a background pass would be the exact
     overclaim #38 warned about. */
  const v = outPointVerdict({ endSec: 25, stoppedAtSec: 25.01, backgroundedAtWall: null });
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.headline, /never observed to leave the foreground/);
});

test("medianMs handles absent, dirty and even-length input", () => {
  assert.equal(medianMs([]), null);
  assert.equal(medianMs(null), null);
  assert.equal(medianMs(["x", NaN, Infinity, -1]), null);
  assert.equal(medianMs([1000, 250, 250]), 250);
  assert.equal(medianMs([200, 300]), 250);
});

/* ────────────────────────────── the report ───────────────────────────────── */

/* ───────────────────── the seam transition (#28's iOS half) ──────────────── */

/** A healthy backgrounded run: backgrounded at t=1000, never resumed, two
 *  transitions that both begin and end while hidden with ~2.1 s beats. */
function seamRecord(overrides = {}) {
  return {
    phase: "seam",
    startedAtWall: 0,
    lastSavedAtWall: 60000,
    plannedItems: 3,
    askedGapMs: SEAM_ASKED_MS,
    backgroundedAtWall: 1000,
    resumedAtWall: null,
    armedBoundaryAtSec: 30,
    armedWhileHidden: true,
    autoplayBlocked: false,
    items: [
      { id: "seg-a", src: "probe-tone.wav", expectedSrc: "probe-tone.wav" },
      { id: "seg-b", src: "probe-tone-b.wav", expectedSrc: "probe-tone-b.wav" },
      { id: "seg-c", src: "probe-tone-c.wav", expectedSrc: "probe-tone-c.wav" },
    ],
    transitions: [
      {
        fromId: "seg-a", toId: "seg-b", endReason: "outPoint",
        boundaryAtWall: 16000, hiddenAtBoundary: true,
        nextPlayingAtWall: 18100, hiddenAtNextPlaying: true, observedGapMs: 2100, lastStage: "playing",
      },
      {
        fromId: "seg-b", toId: "seg-c", endReason: "outPoint",
        boundaryAtWall: 26000, hiddenAtBoundary: true,
        nextPlayingAtWall: 28200, hiddenAtNextPlaying: true, observedGapMs: 2200, lastStage: "playing",
      },
    ],
    timerIntervalsMs: [1000, 1000, 998],
    telemetry: [],
    error: null,
    ...overrides,
  };
}

test("absent seam data is inconclusive, and does not borrow the out-point's result", () => {
  /* THE SPECIFIC OVERCLAIM THIS GUARDS. Run 32026332637 proved the STOP survives
     backgrounding, and it is tempting to read that as the seam being fine. It is a
     different mechanism on a different clock — the same run measured hidden DOM
     timers at a 1000 ms median — so an absent seam record must say the transition is
     UNKNOWN, in those words, rather than inheriting the good news. */
  for (const nothing of [null, undefined, {}, 7, "seam", { transitions: [] }]) {
    const v = seamTransitionVerdict(nothing);
    assert.equal(v.verdict, "inconclusive", `${JSON.stringify(nothing)} was not inconclusive`);
    assert.match(v.headline + v.detail, /UNKNOWN|nothing|not covered|does not cover/i);
  }
});

test("a run that never left the foreground says nothing about backgrounding", () => {
  const v = seamTransitionVerdict(seamRecord({ backgroundedAtWall: null }));
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.detail, /foray-playback\.test\.js/, "it should point at the suite that already covers this");
});

test("autoplay refusal is a harness finding, not a seam failure", () => {
  const v = seamTransitionVerdict(seamRecord({ autoplayBlocked: true, autoplayError: "NotAllowedError" }));
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.detail, /harness/);
});

test("two clean hidden transitions is the pass, and it names what that settles", () => {
  const v = seamTransitionVerdict(seamRecord());
  assert.equal(v.verdict, "seam-crosses-in-background");
  assert.equal(v.completedHiddenTransitions, 2);
  assert.equal(v.worstGapMs, 2200);
  assert.match(v.headline, /COMPLETED while the app was backgrounded/);
  assert.match(v.detail, /never resumed/i);
});

test("a boundary that fired with nothing after it is the DEFECT, reported first", () => {
  /* The failure the whole phase exists to find: the stop works, the advance does
     not, and a locked-screen listener hears one segment then silence. It must outrank
     every other reading of the same record — including the one completed transition
     sitting next to it. */
  const rec = seamRecord();
  rec.transitions[1].nextPlayingAtWall = null;
  rec.transitions[1].hiddenAtNextPlaying = null;
  rec.transitions[1].observedGapMs = null;
  rec.transitions[1].lastStage = "beat-armed";
  const v = seamTransitionVerdict(rec);
  assert.equal(v.verdict, "seam-stalls-in-background");
  assert.match(v.headline, /NEVER STARTED/);
  /* And it must say HOW FAR it got, because "the beat's timer never fired" and "the
     load never settled" are different bugs with different fixes. */
  assert.match(v.detail, /beat-armed/);
  assert.match(v.detail, /#28/);
});

test("a transition that completed only AFTER the app came back does not count", () => {
  /* THE CONFOUND, and it is the same one that made the original `fired-on-resume`
     reading wrong: a chain that finishes because the app was resumed proves nothing
     about a backgrounded chain. Both transitions here land after the resume stamp, so
     neither may be counted — and the run must not be reported as a pass. */
  const v = seamTransitionVerdict(seamRecord({ resumedAtWall: 17000 }));
  assert.notEqual(v.verdict, "seam-crosses-in-background");
  assert.ok(
    ["too-few-transitions", "seam-stalls-in-background"].includes(v.verdict),
    `unexpected verdict ${v.verdict}`
  );
});

test("`document.hidden` alone cannot buy a pass — the wall clock has to agree", () => {
  /* Two channels on purpose. `hiddenAtBoundary` is a reading taken inside the
     process under suspicion; the wall-clock comparison against `backgroundedAtWall`
     cannot see a brief visibility blip. A record where they disagree is not evidence,
     whichever way it leans. */
  const flagsLie = seamRecord();
  flagsLie.transitions.forEach((t) => { t.hiddenAtBoundary = false; });
  assert.notEqual(seamTransitionVerdict(flagsLie).verdict, "seam-crosses-in-background");

  const clockLies = seamRecord({ backgroundedAtWall: 30000 });
  assert.notEqual(seamTransitionVerdict(clockLies).verdict, "seam-crosses-in-background");
});

test("one transition is not enough, and the reason is the audibility grace window", () => {
  /* One can succeed inside WebKit's `audibleActivityClearDelay` (MEASURED 5 s, not
     the 10 s once assumed here) and the next
     still fail once the page has been silent long enough for the assertion to lapse
     — which is the risk MP1 names and leaves unmeasured. So a single success is
     reported as inconclusive rather than as the mechanism working. */
  const rec = seamRecord();
  rec.transitions = [rec.transitions[0]];
  const v = seamTransitionVerdict(rec);
  assert.equal(v.verdict, "too-few-transitions");
  assert.match(v.detail, /audibleActivityClearDelay/);
  assert.ok(MIN_HIDDEN_TRANSITIONS >= 2);
});

test("a late beat is a different verdict from a stalled one", () => {
  /* Playback continuing 8 s after a boundary is audible dead air; playback never
     resuming is the silence defect. Collapsing them would hide which one happened,
     and only one of them needs anything native. */
  const late = seamRecord();
  late.transitions[1].observedGapMs = SEAM_OK_MS + 3000;
  assert.equal(seamTransitionVerdict(late).verdict, "seam-late-in-background");

  const stalled = seamRecord();
  stalled.transitions[1].observedGapMs = SEAM_BAD_MS + 1000;
  assert.equal(seamTransitionVerdict(stalled).verdict, "seam-stalls-in-background");
});

test("the seam tolerance is derived from a measurement and admits it is ours", () => {
  /* SEAM_OK_MS allows for the 1000 ms hidden-timer alignment run 32026332637
     measured, on top of the 2000 ms the player asks for. The number is OURS, not one
     any source document contains — the same distinction `OVERSHOOT_OK_SEC` carries a
     paragraph about, after an earlier version of this file attributed its own
     threshold to MP1. */
  assert.equal(SEAM_ASKED_MS, 2000);
  assert.ok(SEAM_OK_MS > SEAM_ASKED_MS + 1000, "the tolerance must clear the measured timer alignment");
  assert.ok(SEAM_BAD_MS > SEAM_OK_MS);
  const src = fs.readFileSync(path.join(HERE, "ios-ci.mjs"), "utf8");
  assert.match(src, /OUR tolerance, not a number any\s*\*? ?source document contains|OUR tolerance/);
});

test("SEAM_ASKED_MS agrees with the player's own SEAM_GAP_SEC", () => {
  /* This module cannot import `player/seam-gap.js` — it is a CI tool and that is
     browser code — so the only thing keeping the two from drifting is this
     assertion. A beat measured against the wrong asked-for value would report a
     healthy seam as late, or a late one as healthy. */
  const seamGap = fs.readFileSync(path.join(HERE, "..", "..", "player", "seam-gap.js"), "utf8");
  const m = /export const SEAM_GAP_SEC = ([\d.]+)/.exec(seamGap);
  assert.ok(m, "could not read SEAM_GAP_SEC out of player/seam-gap.js");
  assert.equal(Number(m[1]) * 1000, SEAM_ASKED_MS);
});

test("pickSeam ranks the decisive negative above a tidy foreground run", () => {
  /* The same lesson `pickOutPoint` records paying for. A restarted run that
     completed its transitions in the FOREGROUND must not outrank a backgrounded run
     that stalled, because the stall is the finding. */
  const foregroundOk = seamRecord({ backgroundedAtWall: null });
  const backgroundedStall = seamRecord();
  backgroundedStall.transitions = [
    { boundaryAtWall: 16000, hiddenAtBoundary: true, nextPlayingAtWall: null, lastStage: "beat-armed" },
  ];
  assert.equal(pickSeam([foregroundOk, backgroundedStall]), backgroundedStall);
  assert.equal(pickSeam([backgroundedStall, foregroundOk]), backgroundedStall);
  assert.equal(pickSeam([]), null);
  assert.equal(pickSeam(null), null);
});

/* ── the five ways a review got a PASS out of contradictory data. All five now
   return something other than `seam-crosses-in-background`, and each is here
   because the first version of `seamTransitionVerdict` printed "the beat ran, a
   different episode loaded, it seeked and it played" over data that said otherwise.
   ── */

test("a beat observed at ~0 ms is not a beat that survived", () => {
  /* The one-edit defeat: `seamGapSec: 0.05` in the probe collapses the 2.0 s beat to
     50 ms, which is the entire mechanism this phase measures. A unit test can forbid
     that spelling; only a floor on the OBSERVED number catches the class. It also
     catches a real bug with no edit at all — `seamGapSec()` returning 0 because the
     transition is not a seam. */
  for (const gap of [0, 1, SEAM_MIN_PLAUSIBLE_MS - 1]) {
    const rec = seamRecord();
    rec.transitions.forEach((t) => { t.observedGapMs = gap; });
    const v = seamTransitionVerdict(rec);
    assert.notEqual(v.verdict, "seam-crosses-in-background", `a ${gap} ms beat was accepted`);
    assert.match(v.headline, /not the 2\.0 s beat running|not a beat/);
  }
  assert.ok(SEAM_MIN_PLAUSIBLE_MS > 0 && SEAM_MIN_PLAUSIBLE_MS < SEAM_ASKED_MS);
});

test("a transition with no beat measurement at all does not count as completed", () => {
  const rec = seamRecord();
  rec.transitions.forEach((t) => { delete t.observedGapMs; });
  const v = seamTransitionVerdict(rec);
  assert.notEqual(v.verdict, "seam-crosses-in-background");
  /* And it must not silently read "worst beat n/a" as a pass. */
  assert.equal(/worst beat n\/a/.test(v.headline), false);
});

test("a file that ran out is not an out-point, and the run is refused", () => {
  /* `html-audio-backend.js` reports the same callback for a finished file and a
     boundary, deliberately. Here they are opposite results: a tone that ran out
     produces a beautiful transition measuring the length of the tone. `outPointVerdict`
     has had this check since its own first review; the seam verdict had only the
     margin, and a margin is not a check. */
  const rec = seamRecord();
  rec.transitions[0].endReason = "natural";
  const v = seamTransitionVerdict(rec);
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.headline, /rather than at\s+its out-point|rather than at its out-point/);
  /* Absent is refused too. A guard that fails open on a missing field is the same
     defect as not having the guard — the record must SUPPORT the headline. */
  const noReason = seamRecord();
  noReason.transitions.forEach((t) => { delete t.endReason; });
  assert.notEqual(seamTransitionVerdict(noReason).verdict, "seam-crosses-in-background");
});

test("a boundary armed by the fallback timer is refused, because that is the race", () => {
  /* `armedWhileHidden: false` means the 70 s fallback fired instead of the
     `visibilitychange` path — the app was not backgrounded in time, so the boundary
     was set on wall clock. That is exactly the race that produced two contradictory
     verdicts from identical code, and the probe recorded the field all along while
     the verdict ignored it. */
  const v = seamTransitionVerdict(seamRecord({ armedWhileHidden: false }));
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.headline, /armed while hidden/);
  /* `!== true`, not `=== false`: absent must not pass either. */
  for (const value of [null, undefined, 0, "true"]) {
    assert.notEqual(
      seamTransitionVerdict(seamRecord({ armedWhileHidden: value })).verdict,
      "seam-crosses-in-background",
      `armedWhileHidden ${JSON.stringify(value)} was accepted`
    );
  }
});

test("a transition that re-used the same audio file is refused", () => {
  /* MEASURED, not asserted over the queue literal. The pass headline claims "a
     different episode loaded"; if two consecutive items report the same `src` then
     `html-audio-backend.js` took its same-source seek shortcut and no fresh load
     happened. A review defeated the unit-test-only version of this property in one
     edit, so it is now checked against what the run actually recorded. */
  const rec = seamRecord();
  rec.items[2].src = rec.items[1].src;
  const v = seamTransitionVerdict(rec);
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.headline, /SAME audio file/);
  /* And an item with NO recorded src cannot buy a pass either: "a different episode
     loaded" is then simply uncheckable. */
  const blind = seamRecord();
  delete blind.items[2].src;
  assert.notEqual(seamTransitionVerdict(blind).verdict, "seam-crosses-in-background");
});

test("a genuine stall is NEVER downgraded to inconclusive by a caveat", () => {
  /* A CONFIRMATION PASS CAUGHT THIS AS A REGRESSION IN THE FIX ITSELF. The four
     caveat checks originally sat BEFORE the stall check and returned from it, so a
     run where a segment ended while hidden and nothing followed reported
     `inconclusive` — with a detail saying "nothing is known about backgrounding from
     this run", which was false. A caveat weakens a PASS; it cannot un-observe an
     advance that failed. The caveats now ride in the detail. */
  for (const mutate of [
    (r) => { r.transitions[0].endReason = "natural"; },
    (r) => { r.armedWhileHidden = false; },
    (r) => { r.items[1].src = r.items[0].src; },
    (r) => { r.askedGapMs = 50; },
  ]) {
    const rec = seamRecord({ lastSavedAtWall: 60000 });
    rec.transitions[1].nextPlayingAtWall = null;
    rec.transitions[1].hiddenAtNextPlaying = null;
    rec.transitions[1].observedGapMs = null;
    rec.transitions[1].lastStage = "beat-armed";
    mutate(rec);
    const v = seamTransitionVerdict(rec);
    assert.equal(v.verdict, "seam-stalls-in-background", `a caveat masked the stall: ${v.headline}`);
    /* And the caveat is still reported, not dropped. */
    assert.match(v.detail, /CAVEATS ON THIS RUN/);
  }
});

test("a beat that is not the SHIPPED beat cannot pass, however it was overridden", () => {
  /* `askedGapMs` is read off `manager.seamGapSec` by the probe, so this catches an
     override applied AFTER construction — which the unit test over the options
     literal cannot see. Only a comparison against the module's own value can. */
  const v = seamTransitionVerdict(seamRecord({ askedGapMs: 50 }));
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.headline, /not the 2000 ms/);
  assert.equal(seamTransitionVerdict(seamRecord({ askedGapMs: SEAM_ASKED_MS })).verdict,
    "seam-crosses-in-background");
});

test("the hidden window is floored in BOTH directions", () => {
  /* A pass needs the first boundary to land at least MIN_HIDDEN_WINDOW_SEC into the
     background. A STALL needs us to have waited that long, hidden, with nothing
     audible — without which a run that simply ended mid-transition is reported as the
     silence defect, which is the 0.446 s overclaim pointing the other way. */
  const early = seamRecord({ backgroundedAtWall: 15000 });
  assert.equal(seamTransitionVerdict(early).verdict, "hidden-window-too-short");

  const briefStall = seamRecord({ lastSavedAtWall: 26500 });
  briefStall.transitions[1].nextPlayingAtWall = null;
  briefStall.transitions[1].hiddenAtNextPlaying = null;
  briefStall.transitions[1].observedGapMs = null;
  assert.equal(seamTransitionVerdict(briefStall).verdict, "hidden-window-too-short");

  /* And a genuine long wait IS the stall. */
  const realStall = seamRecord({ lastSavedAtWall: 60000 });
  realStall.transitions[1].nextPlayingAtWall = null;
  realStall.transitions[1].hiddenAtNextPlaying = null;
  realStall.transitions[1].observedGapMs = null;
  assert.equal(seamTransitionVerdict(realStall).verdict, "seam-stalls-in-background");
  assert.ok(MIN_HIDDEN_WINDOW_SEC >= 5);
});

test("N completed transitions need N+1 audible items, or the record is refused", () => {
  const rec = seamRecord({ items: [{ id: "seg-a", src: "a.wav" }] });
  const v = seamTransitionVerdict(rec);
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.headline, /internally inconsistent/);
});

test("pickSeam is monotone in progress, so a mid-run snapshot cannot win", () => {
  /* A REVIEW FOUND THIS PRODUCING A CONFIDENT FALSE STALL. The seam probe saves a
     snapshot every couple of seconds, so the console channel carries many copies of
     one run. The first scoring function saturated as soon as the first transition was
     pushed; every later snapshot tied, `Array.sort` is stable, and the EARLIEST
     saturating snapshot won — which is the one written just after a boundary, with
     the transition still open. A finished run then read as `seam-stalls-in-background`.
     Note the fix is NOT "prefer the newest": that re-introduces the bug pickOutPoint's
     header records paying for. */
  const complete = seamRecord({ lastSavedAtWall: 40000 });
  const midRun = seamRecord({ lastSavedAtWall: 26100 });
  midRun.transitions[1].nextPlayingAtWall = null;
  midRun.transitions[1].hiddenAtNextPlaying = null;
  midRun.transitions[1].observedGapMs = null;
  /* Both orders, because the bug was an ordering-plus-stable-sort interaction. */
  assert.equal(pickSeam([midRun, complete]), complete);
  assert.equal(pickSeam([complete, midRun]), complete);
  assert.equal(seamTransitionVerdict(pickSeam([midRun, complete])).verdict, "seam-crosses-in-background");
});

test("the seam's reporting channel is named, like the other two", () => {
  /* Given the snapshot problem above, whether the record came from localStorage (one
     final copy) or from the console (many mid-run copies) is the first thing a human
     needs when reading a stall. */
  const rec = seamRecord();
  const fromDump = collectProbes({ dump: { foray_probe_seam: JSON.stringify(rec) } });
  assert.equal(fromDump.sources.seam, "localStorage");
  const fromConsole = collectProbes({ consoleText: `FORAY_PROBE_SEAM ${JSON.stringify(rec)}` });
  assert.equal(fromConsole.sources.seam, "console");
  assert.equal(collectProbes({}).sources.seam, "none");
});

test("the local-media limitation ships with the seam verdict, not only in a comment", () => {
  /* The next segment is a bundled file, so a cold cross-origin fetch while hidden is
     NOT measured. Saying that out loud is the difference between an honest partial
     result and a claim this run cannot support — and MP1's own §1 table exists
     because that line got crossed once already. */
  assert.match(LOCAL_MEDIA_CAVEAT, /LOCAL bundled file/);
  assert.match(LOCAL_MEDIA_CAVEAT, /cross-origin fetch while hidden is still unmeasured/);
  const md = renderReport({ seam: seamRecord(), signingState: "absent" });
  assert.match(md, /LOCAL bundled file/);
});

test("the report carries the seam section, and reads as inconclusive with nothing measured", () => {
  const md = renderReport({ bridge: null, outPoint: null, seam: null, signingState: "absent" });
  assert.match(md, /SEAM TRANSITION while backgrounded/);
  assert.match(md, /`inconclusive`/);
  const good = renderReport({ seam: seamRecord(), signingState: "absent" });
  assert.match(good, /`seam-crosses-in-background`/);
});

test("the simulator caveat is stated, and states the asymmetry", () => {
  /* #38 was explicit: a pass in a simulator is weaker evidence than a failure,
     because a simulator models neither power management nor true suspension. If
     that sentence goes missing, a weak pass gets quoted as a strong one — which
     is how MP1's own §1 table came to exist. */
  assert.match(SIMULATOR_CAVEAT, /does not model power management/);
  assert.match(SIMULATOR_CAVEAT, /WEAKER evidence than a failure/);
});

test("the report always carries all three sections and the caveat", () => {
  const md = renderReport({ bridge: null, outPoint: null, signingState: "absent", build: "simulator=success" });
  assert.match(md, /Capacitor's bridge vs our CSP/);
  assert.match(md, /out-point while backgrounded/);
  assert.match(md, /TestFlight upload/);
  assert.match(md, /does not model power management/);
  assert.match(md, /simulator=success/);
  /* And with nothing measured it must not read as a pass anywhere. */
  assert.equal(/`inconclusive`/.test(md), true);
});

test("the signing section reports what the GATE said, not what this process can see", () => {
  /* AN ADVERSARIAL PASS FOUND THIS STRUCTURALLY UNABLE TO BE RIGHT. It used to
     recompute the state from `process.env` — but the reporting step is deliberately
     not given the secrets, so it said "no signing secrets set" unconditionally. It
     was right only by accident, and would have begun contradicting the gate step
     inside the same run on the day HUMAN-ACTIONS.md #19 was done. */
  assert.match(renderReport({ signingState: "ready" }), /`ready`/);
  assert.match(renderReport({ signingState: "ready" }), /never executed before/);
  assert.match(renderReport({ signingState: "partial" }), /failed on purpose/);
  assert.match(renderReport({ signingState: "absent" }), /HUMAN-ACTIONS\.md #19/);
  /* And with no gate output it must say so rather than guessing "absent". */
  const silent = renderReport({ signingState: null });
  assert.match(silent, /`not reported`/);
  assert.match(silent, /did not report/);
  /* The env must not be able to influence it. */
  const before = process.env.APPLE_TEAM_ID;
  process.env.APPLE_TEAM_ID = "ABCDE12345";
  try {
    assert.match(renderReport({ signingState: "absent" }), /No signing secrets are set/);
  } finally {
    if (before === undefined) delete process.env.APPLE_TEAM_ID;
    else process.env.APPLE_TEAM_ID = before;
  }
});

test("the report renders the good outcomes too", () => {
  const md = renderReport({
    bridge: {
      capacitorType: "object", isNativePlatform: true, platform: "ios",
      pluginNames: [], hasServiceWorkerApi: true, swRegistrations: 0,
    },
    outPoint: { ...base, stoppedAtSec: 25.2, overshootSec: 0.2 },
    signingState: "absent",
  });
  assert.match(md, /`bridge-present`/);
  assert.match(md, /`fires-in-background`/);
  assert.match(md, /`absent`/);
});

/* ───────────── redaction: the artifact is public, localStorage is not ───────── */

/** The shape `sqlite3 -json "select key, hex(value) as hexval from ItemTable"`
 *  produced in run 32036295743, with the token's bytes stood in for. */
const REAL_WORLD_ROWS = [
  { key: "foray_probe_seam_1", hexval: Buffer.from('{"lastStage":"playing"}', "utf8").toString("hex") },
  { key: "foray_probe_bridge", hexval: Buffer.from('{"capacitor":"object"}', "utf8").toString("hex") },
  { key: "cp_sb_session", hexval: Buffer.from('{"access_token":"eyJhbGciOiJFUzI1NiIs"}', "utf8").toString("hex") },
  { key: "cp_profile_id", hexval: Buffer.from("abc-123", "utf8").toString("hex") },
  { key: "cp_interests", hexval: Buffer.from('["history"]', "utf8").toString("hex") },
];

test("the Supabase session token is not published, and neither is any other cp_ value", () => {
  const { rows, redacted } = redactLocalStorageRows(REAL_WORLD_ROWS);
  const serialised = JSON.stringify(rows);
  /* The actual defect, stated as the actual defect: no byte of the token
     survives, in hex or in clear. */
  assert.equal(serialised.includes("access_token"), false);
  assert.equal(
    serialised.includes(Buffer.from('{"access_token":"eyJhbGciOiJFUzI1NiIs"}', "utf8").toString("hex")),
    false,
    "the token's hex is still in the artifact rows"
  );
  assert.deepEqual(redacted, ["cp_sb_session", "cp_profile_id", "cp_interests"]);
});

test("the probe records survive redaction verbatim, or the artifact measures nothing", () => {
  const { rows } = redactLocalStorageRows(REAL_WORLD_ROWS);
  const dump = decodeLocalStorageRows(rows);
  assert.deepEqual(dump, {
    foray_probe_seam_1: '{"lastStage":"playing"}',
    foray_probe_bridge: '{"capacitor":"object"}',
  });
  /* And the end-to-end consequence: the verdict still reads its record. */
  assert.equal(parseDump(dump).bridge.capacitor, "object");
});

test("a redacted row keeps its key and its size, because that is the diagnostic", () => {
  const { rows } = redactLocalStorageRows(REAL_WORLD_ROWS);
  const row = rows.find((r) => r.key === "cp_profile_id");
  assert.equal(row.redacted, true);
  assert.equal(row.hexval, null);
  assert.equal(row.value_bytes, 7, '"abc-123" is 7 bytes');
  /* THE EXACT KEY SET, not just these three fields. A review defeated the looser
     version with one added line -- `value_preview: hex.slice(0, 64)` -- which keeps
     every other assertion green (it is hex, so no "access_token" substring, and it
     is truncated, so no full-token match) while publishing the first 32 bytes of
     every value: `{"access_token":"eyJhbGciOiJFUzI1...`. A redacted row may carry
     metadata about a value and must never carry any part OF one. */
  assert.deepEqual(
    Object.keys(row).sort(),
    ["hexval", "key", "redacted", "value_bytes"],
    "a redacted row grew a field — if it holds any slice of the value, that is the leak again"
  );
});

test("redaction is an ALLOWLIST, so a key nobody has written yet is redacted by default", () => {
  /* The reason this is not a `cp_sb_*` denylist. A denylist is a promise about
     every key the app will ever write; this file cannot make that promise, and
     the failure mode of guessing wrong is a published credential. */
  const { redacted } = redactLocalStorageRows([
    { key: "cp_sb_refresh_token_v2", hexval: "00" },
    { key: "some_future_oauth_blob", hexval: "00" },
    { key: "foray_probe_outpoint", hexval: "00" },
  ]);
  assert.deepEqual(redacted, ["cp_sb_refresh_token_v2", "some_future_oauth_blob"]);
  assert.deepEqual(ARTIFACT_VALUE_ALLOWLIST.map(String), ["/^foray_probe_/"]);
});

test("redaction tolerates the rows a broken read produces", () => {
  const { rows, redacted } = redactLocalStorageRows([
    null,
    { key: 42, hexval: "00" },
    { key: "cp_x" },
    { key: "cp_y", hexval: null },
  ]);
  assert.deepEqual(redacted, ["cp_x", "cp_y"]);
  assert.deepEqual(
    rows.map((r) => r.value_bytes),
    [0, 0]
  );
});

/* ── the redact CLI itself, not just the pure function ────────────────────────
   The five tests above cover `redactLocalStorageRows`. None covered the command
   the workflow actually runs, and a review found the gap was load-bearing: the
   first version read its input through `readMaybe`, which swallows a JSON parse
   error and returns null. Empty or truncated `sqlite3` output therefore produced
   `[]`, exit 0, and a published rows file with nothing in it -- no rows, three
   `inconclusive` verdicts, a GREEN job, indistinguishable from a genuinely empty
   store. That is the silent-nothing failure the whole collection step exists to
   avoid, so the command must fail instead. */

function runRedact(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-redact-"));
  const file = path.join(dir, "rows.json");
  fs.writeFileSync(file, contents);
  const r = spawnSync(process.execPath, [path.join(HERE, "ios-ci.mjs"), "redact-localstorage", file], {
    encoding: "utf8",
  });
  return { ...r, file, after: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null };
}

test("redact-localstorage refuses truncated JSON instead of publishing an empty file", () => {
  const truncated = '[{"key":"cp_sb_session","hexval":"00';
  const r = runRedact(truncated);
  assert.notEqual(r.status, 0, "a JSON parse failure must be a non-zero exit");
  assert.match(r.stderr, /not valid JSON/);
  /* And it must NOT have rewritten the file at all — in particular not into the
     valid-looking `[]` that would sail through the workflow's `mv` and report
     "measured nothing" on a green job. Left byte-for-byte as found, so the failure
     is diagnosable from the artifact. */
  assert.equal(r.after, truncated, "the unreadable file must be left exactly as found");
});

test("redact-localstorage refuses a zero-row read, which is a failed read not an empty store", () => {
  const r = runRedact("[]");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /zero rows/);
});

test("redact-localstorage refuses a non-array, e.g. sqlite3 writing an error object", () => {
  const r = runRedact('{"error":"database is locked"}');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not the array/);
});

test("redact-localstorage rewrites a real rows file in place, redacted, and exits 0", () => {
  const r = runRedact(JSON.stringify(REAL_WORLD_ROWS));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.after);
  assert.equal(out.length, REAL_WORLD_ROWS.length, "no row is dropped — the key names are the diagnostic");
  assert.equal(r.after.includes("access_token"), false);
  assert.match(r.stderr, /redacted 3 value\(s\)/);
  /* The probe records must still decode out of the file it wrote. */
  assert.equal(parseDump(decodeLocalStorageRows(out)).bridge.capacitor, "object");
});

/* ── WHERE THE RECORD STOPS: the suspension-ceiling channel (§4.1b) ──────────
 *
 * WHAT THESE ARE FOR. Three seam runs ended their record 25-28 s into the hidden
 * window and the two available readings — a platform ceiling on hidden time, or
 * ordinary suspension after the probe's own audio stopped — have opposite
 * consequences for whether a WebView shell can play a Foray with the screen off.
 * `suspensionVerdict` is what decides between them from a run's own artifact, so
 * the property tested hardest below is the one that would be expensive to get
 * wrong: `suspended-while-audible` must need POSITIVE evidence that audio was
 * flowing, and must never be reachable from "no pause was recorded".
 */

/** A synthetic seam log, in the shape run 32064639785's really has. Times are
 *  `HH:MM:SS.mmm` on 2026-08-17 and the parser reads them as UTC, which is what a
 *  GitHub runner is. */
function logLine(hhmmssmmm, rest) {
  return `2026-08-17 ${hhmmssmmm} Df App[18721:e31c] ${rest}`;
}
function nowPlaying(hhmmssmmm, { isPlaying = true, duration = 60, now = 12 } = {}) {
  return logLine(
    hhmmssmmm,
    `[com.apple.WebKit:Media] WebContent[18723] MediaSessionManageriOS::updateNowPlayingInfo(0) ` +
      `title = "title", isPlaying = ${isPlaying}, duration = ${duration}, now = ${now}`
  );
}
const SUSPENDED_LINE =
  `[com.apple.WebKit:ProcessSuspension] 0x11010c0c0 - [PID=18723] ` +
  `WebProcessProxy::didChangeThrottleState(Suspended) Release all assertions for network process`;

/** Epoch ms for a time on 2026-08-17 UTC, so a record's stamps and a log's lines
 *  can be written against the same clock in these tests. */
function wallAt(h, m, s, ms = 0) {
  return Date.UTC(2026, 7, 17, h, m, s, ms);
}

/** A seam record whose hidden window starts at 20:23:54.000, with a save trail on
 *  a 2 s cadence for `seconds` of hidden time. */
function trailedSeam({ seconds = 30, gapAt = null, gapSec = 0, mediaMovesInGap = 0, ...overrides } = {}) {
  const bg = wallAt(20, 23, 54);
  const saveTrail = [];
  let wall = bg;
  let mediaSec = 0;
  for (let i = 0; i < seconds / 2; i++) {
    saveTrail.push({ seq: i + 1, wall, mediaSec, paused: false, hidden: true });
    const isGap = gapAt != null && Math.abs((wall - bg) / 1000 - gapAt) < 0.001;
    if (isGap) {
      wall += gapSec * 1000;
      mediaSec += mediaMovesInGap;
    } else {
      wall += 2000;
      mediaSec += 2;
    }
  }
  return seamRecord({
    backgroundedAtWall: bg,
    lastSavedAtWall: saveTrail[saveTrail.length - 1].wall,
    saveSeq: saveTrail.length,
    firstSavedAtWall: bg,
    saveTrail,
    ...overrides,
  });
}

test("a record with no hidden window says so, rather than reporting a ceiling", () => {
  for (const seam of [null, undefined, {}, { backgroundedAtWall: null, lastSavedAtWall: 5 }, "nope", 7]) {
    const v = suspensionVerdict({ seam, lifecycle: null });
    assert.equal(v.verdict, "inconclusive", `${JSON.stringify(seam)} should be inconclusive`);
  }
  /* And it must not invent numbers on the way. */
  const v = suspensionVerdict({ seam: null, lifecycle: null });
  assert.equal(v.recordEndsAtHiddenSec, null);
  assert.equal(v.trail.stamps, 0);
});

test("the pre-saveTrail runs still get an answer, and it names the missing channel", () => {
  /* Runs 32036295743, 32057395270 and 32064639785 have no `saveTrail`. Their
     records must not be silently unreadable by the thing built to explain them. */
  const seam = seamRecord({ backgroundedAtWall: wallAt(20, 23, 54), lastSavedAtWall: wallAt(20, 24, 22) });
  const v = suspensionVerdict({ seam, lifecycle: null });
  assert.equal(v.verdict, "record-ends-early-no-log");
  assert.equal(Math.round(v.recordEndsAtHiddenSec), 28);
  assert.match(v.detail, /no save trail/);
  assert.match(v.detail, /32064639785/);
});

test("a suspension while the audio is PLAYING is reading (a), and it needs the log to say so", () => {
  const seam = trailedSeam({ seconds: 28 });
  const text = [
    nowPlaying("20:24:20.000", { isPlaying: true, now: 26 }),
    logLine("20:24:22.000", SUSPENDED_LINE),
  ].join("\n");
  const v = suspensionVerdict({ seam, lifecycle: parseSimulatorLifecycle(text) });
  assert.equal(v.verdict, "suspended-while-audible");
  assert.match(v.headline, /AUDIO STILL PLAYING/);
  /* No release timer was armed in this window, so the verdict must NOT hedge — that
     hedge is the whole difference between the two readings and it has to be earned. */
  assert.equal(v.releaseArmedBeforeSuspensionSec, null);
  assert.match(v.detail, /NO assertion-release timer was armed/);
  assert.match(v.detail, /HUMAN-ACTIONS\.md #11/);
});

test("a suspension after the audio ALREADY STOPPED is reading (b), and says whose silence it was", () => {
  /* The media session says the element stopped 12 s before the suspension. The
     record's own stamps still read `paused: false`, which is the page's stale view of
     itself — and the log has to win, or the suspect gets to testify. */
  const seam = trailedSeam({ seconds: 28 });
  const text = [
    nowPlaying("20:24:10.000", { isPlaying: false, now: 31.2 }),
    logLine("20:24:22.000", SUSPENDED_LINE),
  ].join("\n");
  const v = suspensionVerdict({ seam, lifecycle: parseSimulatorLifecycle(text) });
  assert.equal(v.verdict, "suspended-after-audio-stopped");
  assert.match(v.headline, /not a ceiling on hidden time/);
  assert.match(v.detail, /followed OUR silence/);
  assert.match(v.detail, /THOSE TWO DISAGREE/);
});

test("`suspended-while-audible` is NOT reachable from the absence of a pause", () => {
  /* THE OVERCLAIM THIS EXISTS TO STOP, and the shape of every guard in this file: a
     record that does not SUPPORT the headline must not be counted toward it. Here the
     log's media samples are gone and the trail carries no `paused` field, so nothing
     anywhere says audio was flowing — and the architecture-changing verdict must not
     be the default. Nor may the OPPOSITE headline be: an unobserved silence is not an
     observed one. */
  const seam = trailedSeam({ seconds: 28 });
  seam.saveTrail = seam.saveTrail.map((s) => ({ seq: s.seq, wall: s.wall, mediaSec: s.mediaSec, hidden: true }));
  const v = suspensionVerdict({
    seam,
    lifecycle: parseSimulatorLifecycle(logLine("20:24:22.000", SUSPENDED_LINE)),
  });
  assert.equal(v.verdict, "suspended-audio-unknown");
  assert.match(v.detail, /refuses to resolve/);
});

test("an audible suspension with an assertion-release timer already armed is reported as WEAKER", () => {
  /* Run 32064639785 exactly: a 5.1 s beat armed WebKit's ~10 s foreground-assertion
     release, the next segment became audible, the re-acquire was DENIED for want of
     an entitlement no Simulator app holds, and the release fired 11.7 s later with
     audio playing. That is not "suspended regardless of audio" and the report must
     not let it read as one. */
  const text = [
    logLine(
      "20:24:10.755",
      `[com.apple.WebKit:ProcessSuspension] WebPageProxy::updateThrottleState: UIProcess starting timer ` +
        `to release a foreground assertion in 10 seconds if audio doesn't start to play`
    ),
    logLine(
      "20:24:22.321",
      `[com.apple.WebKit:ProcessSuspension] ProcessAssertion::acquireSync Failed to acquire RBS ` +
        `assertion 'WebKit Media Playback' for process with PID=18723, error: ...`
    ),
    nowPlaying("20:24:22.347", { isPlaying: true, now: 12 }),
    logLine("20:24:22.451", SUSPENDED_LINE),
  ].join("\n");
  const v = suspensionVerdict({ seam: trailedSeam({ seconds: 28 }), lifecycle: parseSimulatorLifecycle(text) });
  assert.equal(v.verdict, "suspended-while-audible");
  assert.equal(Math.round(v.releaseArmedBeforeSuspensionSec * 10) / 10, 11.7);
  assert.match(v.detail, /WEAKER THAN IT READS/);
  assert.match(v.detail, /denied 1 time/);
});

test("a record that covers its window with no suspension is the answer the ceiling reading forbids", () => {
  const seam = trailedSeam({ seconds: 120 });
  const text = [nowPlaying("20:25:50.000", { isPlaying: true, now: 40 })].join("\n");
  const v = suspensionVerdict({ seam, lifecycle: parseSimulatorLifecycle(text) });
  assert.equal(v.verdict, "record-covers-window");
  assert.ok(v.recordEndsAtHiddenSec > 110, `covered only ${v.recordEndsAtHiddenSec}s`);
});

test("a record that stops early while the process stays ALIVE blames the write path, not the scheduler", () => {
  /* The other branch of `docs/ios-ci.md` §4c's open question, and it must be
     reachable — a verdict function that can only ever report the interesting reading
     is not measuring anything. */
  const seam = trailedSeam({ seconds: 28 });
  const text = [
    nowPlaying("20:24:22.000", { isPlaying: true, now: 26 }),
    nowPlaying("20:25:40.000", { isPlaying: true, now: 39 }),
  ].join("\n");
  const v = suspensionVerdict({ seam, lifecycle: parseSimulatorLifecycle(text) });
  assert.equal(v.verdict, "record-ends-early-no-suspension");
  assert.match(v.detail, /write path is the suspect/);
  /* And the out-of-band media advance is the evidence for it. */
  assert.ok(v.audioAdvancedAfterRecordSec > 10, `advance was ${v.audioAdvancedAfterRecordSec}`);
});

test("a log whose clock does not overlap the record is DISCARDED, not offset-corrected", () => {
  /* `log stream` prints local time with no zone. A runner that was not UTC would
     hand this a log hours away from the record, and placing a suspension inside a
     window it was never in is the one failure that turns this channel into a
     confident lie. */
  const seam = trailedSeam({ seconds: 28 });
  const text = [
    logLine("03:10:00.000", SUSPENDED_LINE),
    nowPlaying("03:10:01.000", { isPlaying: true, now: 5 }),
  ].join("\n");
  const v = suspensionVerdict({ seam, lifecycle: parseSimulatorLifecycle(text) });
  assert.equal(v.verdict, "record-ends-early-no-log");
  assert.match(v.detail, /do not overlap/);
  assert.deepEqual(v.channels, ["record"]);
});

test("the save trail turns a gap into a FROZEN-AND-RESUMED finding, with the audio's own answer", () => {
  /* The single thing `saveSeq` + `lastSavedAtWall` cannot do. A 13 s hole in a 2 s
     cadence is a page that stopped running and started again; whether the audio went
     with it is a different question, and the media clock in the same stamps answers
     it. */
  const flowed = saveTrailAnalysis(trailedSeam({ seconds: 40, gapAt: 20, gapSec: 13, mediaMovesInGap: 12 }));
  assert.equal(flowed.gaps.length, 1);
  assert.equal(flowed.gaps[0].gapSec, 13);
  assert.equal(flowed.gaps[0].audioFlowed, true);
  assert.equal(flowed.gaps[0].atHiddenSec, 20);

  const stalled = saveTrailAnalysis(trailedSeam({ seconds: 40, gapAt: 20, gapSec: 13, mediaMovesInGap: 0.5 }));
  assert.equal(stalled.gaps[0].audioFlowed, false);
  assert.equal(stalled.gaps[0].mediaAdvancedSec, 0.5);

  /* An ordinary cadence has no gaps at all — a detector that fires on 2 s jitter
     would report every healthy run as a freeze. */
  assert.deepEqual(saveTrailAnalysis(trailedSeam({ seconds: 40 })).gaps, []);
});

test("a media clock that went BACKWARDS across a gap is null, not a negative or a zero", () => {
  /* `html-audio-backend.js` resets `currentTime` to the next item's `start_sec` on a
     cross-file load, so a gap spanning a seam legitimately reads backwards. Calling
     that "the audio stopped" would report a working transition as a stall. */
  const seam = trailedSeam({ seconds: 20, gapAt: 10, gapSec: 12, mediaMovesInGap: 0 });
  seam.saveTrail = seam.saveTrail.map((s, i) => (i > 5 ? { ...s, mediaSec: 0.5 } : s));
  const a = saveTrailAnalysis(seam);
  assert.equal(a.gaps.length, 1);
  assert.equal(a.gaps[0].mediaAdvancedSec, null);
  assert.equal(a.gaps[0].audioFlowed, null, "an unknown must not collapse into the negative");
});

test("hiddenMediaRatio sums per step, so one seam cannot make a playing page look stopped", () => {
  /* End-to-end arithmetic over a trail that crosses a load would go NEGATIVE. Summed
     upward per step, a page that played throughout reads ~1. */
  const seam = trailedSeam({ seconds: 40 });
  seam.saveTrail = seam.saveTrail.map((s, i) => (i >= 10 ? { ...s, mediaSec: s.mediaSec - 18 } : s));
  const a = saveTrailAnalysis(seam);
  assert.ok(a.hiddenMediaRatio > 0.8, `ratio was ${a.hiddenMediaRatio}`);
  assert.ok(a.hiddenMediaRatio <= 1.05, `ratio was ${a.hiddenMediaRatio}`);
});

test("the lifecycle parser reads nothing out of nothing, and never throws on rubbish", () => {
  for (const input of [null, undefined, "", 42, {}, "not a log at all\nno timestamps here"]) {
    const lf = parseSimulatorLifecycle(input);
    assert.deepEqual(lf.events, [], `events from ${JSON.stringify(input)}`);
    assert.deepEqual(lf.media, []);
    assert.equal(lf.firstWall, null);
  }
  /* A timestamped line with none of the needles is counted but says nothing. */
  const lf = parseSimulatorLifecycle(logLine("20:24:22.000", "something entirely unrelated"));
  assert.equal(lf.timestamped, 1);
  assert.deepEqual(lf.events, []);
});

test("the media-clock line is parsed with its position and its isPlaying, both", () => {
  /* Copied from run 32064639785's log verbatim. If a runner image changes this
     string the parser must stop finding samples — which is why the verdict degrades
     to `no-log` rather than to a pass. */
  const real =
    `2026-08-17 20:24:36.922 Df App[18721:e37a] [com.apple.WebKit:Media] WebContent[18723] ` +
    `MediaSessionManageriOS::updateNowPlayingInfo(0) title = "title", isPlaying = true, duration = 60, ` +
    `now = 25.80569554166661`;
  const lf = parseSimulatorLifecycle(real);
  assert.equal(lf.media.length, 1);
  assert.equal(lf.media[0].isPlaying, true);
  assert.equal(lf.media[0].durationSec, 60);
  assert.equal(Math.round(lf.media[0].positionSec * 100) / 100, 25.81);
  assert.equal(lf.media[0].wall, Date.UTC(2026, 7, 17, 20, 24, 36, 922));
});

test("the report always carries section 3b, including when it has nothing to say", () => {
  /* A section that disappears when the data is thin is how a 25 s shortfall reads as
     a footnote about save cadence for three runs running. */
  const empty = renderReport({ seam: null, signingState: "absent" });
  assert.match(empty, /3b\. Where the record STOPS/);
  assert.match(empty, /`inconclusive`/);
  const real = renderReport({
    seam: trailedSeam({ seconds: 28 }),
    lifecycle: parseSimulatorLifecycle(
      [nowPlaying("20:24:20.000", { isPlaying: true, now: 26 }), logLine("20:24:22.000", SUSPENDED_LINE)].join("\n")
    ),
    signingState: "absent",
  });
  assert.match(real, /3b\. Where the record STOPS.*`suspended-while-audible`/);
});

test("a CAPPED save trail is reported as capped, not read as the record ending there", () => {
  /* `SAVE_TRAIL_MAX` bounds the trail while `saveSeq` keeps counting, so a capped
     trail and a stopped one are the same array. Reading the last stamp as the
     record's end would then put the stop time tens of seconds early — in the
     direction of the ceiling reading, which is the expensive direction. */
  const seam = trailedSeam({ seconds: 20 });
  seam.saveSeq = seam.saveTrail.length + 40;
  seam.lastSavedAtWall = seam.saveTrail[seam.saveTrail.length - 1].wall + 80_000;
  const a = saveTrailAnalysis(seam);
  assert.equal(a.truncated, true);
  const v = suspensionVerdict({ seam, lifecycle: null });
  assert.match(v.detail, /THE TRAIL IS CAPPED/);
  /* The stop time comes from `lastSavedAtWall`, so the cap must not move it. */
  assert.equal(Math.round(v.recordEndsAtHiddenSec), Math.round((seam.lastSavedAtWall - seam.backgroundedAtWall) / 1000));
  /* An uncapped trail must not claim to be capped. */
  assert.equal(saveTrailAnalysis(trailedSeam({ seconds: 20 })).truncated, false);
});
