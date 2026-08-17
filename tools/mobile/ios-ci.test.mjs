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
  OVERSHOOT_BAD_SEC,
  OVERSHOOT_OK_SEC,
  SIGNING_SECRETS,
  SIMULATOR_CAVEAT,
  bridgeVerdict,
  decodeLocalStorageRows,
  medianMs,
  outPointVerdict,
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

test("window.Capacitor undefined is the decisive failure", () => {
  const v = bridgeVerdict({ capacitorType: "undefined", cspViolations: [{ directive: "script-src" }] });
  assert.equal(v.verdict, "bridge-blocked");
  assert.match(v.headline, /UNDEFINED/);
  assert.match(v.detail, /script-src violation/);
});

test("a service worker registered inside the shell is reported as broken", () => {
  /* Invariant 3's consequence, measured. Two registrations means the shell will
     serve its own stale cache after a store update. */
  const v = bridgeVerdict({ capacitorType: "object", isNativePlatform: true, swRegistrations: 1 });
  assert.equal(v.verdict, "bridge-present");
  assert.match(v.detail, /invariant 3 is BROKEN/);
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

test("a sub-second overshoot while backgrounded is the predicted good outcome", () => {
  const v = outPointVerdict({ ...base, stoppedAtSec: 25.24, overshootSec: 0.24 });
  assert.equal(v.verdict, "fires-in-background");
  assert.match(v.headline, /0\.240s past end_sec/);
  assert.match(v.detail, /Median timeupdate interval while hidden: 251 ms/);
  assert.equal(v.medianTimeupdateMs, 250.5);
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
  const md = renderReport({ bridge: null, outPoint: null, signing: {}, build: "simulator=success" });
  assert.match(md, /Capacitor's bridge vs our CSP/);
  assert.match(md, /out-point while backgrounded/);
  assert.match(md, /TestFlight upload/);
  assert.match(md, /does not model power management/);
  assert.match(md, /simulator=success/);
  /* And with nothing measured it must not read as a pass anywhere. */
  assert.equal(/`inconclusive`/.test(md), true);
});

test("the report renders the good outcomes too", () => {
  const md = renderReport({
    bridge: { capacitorType: "object", isNativePlatform: true, platform: "ios", pluginNames: [], swRegistrations: 0 },
    outPoint: { ...base, stoppedAtSec: 25.2, overshootSec: 0.2 },
    signing: {},
  });
  assert.match(md, /`bridge-present`/);
  assert.match(md, /`fires-in-background`/);
  assert.match(md, /`absent`/);
});
