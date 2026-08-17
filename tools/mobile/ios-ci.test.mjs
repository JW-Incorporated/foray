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

import {
  MP1_ALIGNED_TIMER_PREDICTION_SEC,
  MP1_TIMEUPDATE_PREDICTION_SEC,
  OVERSHOOT_BAD_SEC,
  OVERSHOOT_OK_SEC,
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
  pickSimulator,
  renderReport,
  signingReadiness,
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
  assert.match(r.message, /HUMAN-ACTIONS\.md #17/);
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
  assert.deepEqual(parseConsoleProbes(""), { bridge: [], outPoints: [] });
  assert.deepEqual(parseConsoleProbes(null), { bridge: [], outPoints: [] });
  assert.deepEqual(parseConsoleProbes("FORAY_PROBE_BRIDGE not json at all"), { bridge: [], outPoints: [] });
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
  assert.deepEqual(parseDump({}), { bridge: null, outPoints: [], outPoint: null });
  assert.deepEqual(parseDump(undefined), { bridge: null, outPoints: [], outPoint: null });
  assert.equal(parseDump({ foray_probe_bridge: "{not json" }).bridge, null);
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
     mechanism and stays unproven — HUMAN-ACTIONS.md #16. */
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

test("an out-point that only fires on resume is the failure mode, whatever the overshoot", () => {
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
     inside the same run on the day HUMAN-ACTIONS.md #17 was done. */
  assert.match(renderReport({ signingState: "ready" }), /`ready`/);
  assert.match(renderReport({ signingState: "ready" }), /never executed before/);
  assert.match(renderReport({ signingState: "partial" }), /failed on purpose/);
  assert.match(renderReport({ signingState: "absent" }), /HUMAN-ACTIONS\.md #17/);
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
