#!/usr/bin/env node
/* The decisions `.github/workflows/ios-build.yml` makes, as testable functions.
 *
 * WHY THEY ARE NOT IN THE YAML (issue #38, MP4)
 * Three things in that workflow are actual logic rather than plumbing: whether
 * signing is configured, which simulator to boot, and what the probe output
 * MEANS. Written as shell `if`s they would be untestable from this machine —
 * and this machine is the only one that can run anything before a founder
 * merges. Written here they are pure functions over data, so the branch
 * behaviour is covered by `ios-ci.test.mjs` on Windows, and the YAML is left
 * doing only what YAML is good at.
 *
 * The rule this file exists to enforce: NOTHING HERE MAY REPORT A PASS FROM
 * ABSENT DATA. Every verdict has an explicit "inconclusive" outcome, and an
 * empty or unparseable probe file lands there rather than in "fine". A probe
 * that silently reports success when it never ran is worse than no probe.
 *
 * USAGE (all subcommands read stdin or argv and write to stdout / $GITHUB_OUTPUT)
 *   node tools/mobile/ios-ci.mjs signing-gate
 *   node tools/mobile/ios-ci.mjs xcode-container mobile/ios
 *   node tools/mobile/ios-ci.mjs pick-simulator [simctl-devices.json]
 *   node tools/mobile/ios-ci.mjs decode-localstorage <rows.json...>
 *   node tools/mobile/ios-ci.mjs verdict <localstorage.json> [probe-console.txt]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ─────────────────────────────── signing gate ────────────────────────────── */

/** Everything an App Store Connect upload needs, and nothing it does not.
 *
 *  These are SECRET NAMES, not values, and no value for any of them exists in
 *  this repo or in this project's GitHub org — see `HUMAN-ACTIONS.md` #17. The
 *  list is here so the workflow can say precisely what is missing instead of
 *  "signing not configured", which is the message that makes someone go read a
 *  YAML file. */
export const SIGNING_SECRETS = [
  "IOS_DIST_CERT_P12_BASE64",
  "IOS_DIST_CERT_PASSWORD",
  "IOS_PROVISIONING_PROFILE_BASE64",
  "APPLE_TEAM_ID",
  "APP_STORE_CONNECT_KEY_ID",
  "APP_STORE_CONNECT_ISSUER_ID",
  "APP_STORE_CONNECT_PRIVATE_KEY_BASE64",
];

/**
 * Is TestFlight upload configured?
 *
 * Three outcomes, not two, and the third is the one that matters:
 *
 *   ready   — every secret present. Archive, export and upload.
 *   absent  — none present. SKIP the upload; the unsigned build still runs.
 *             This is the expected state today and it is not a failure.
 *   partial — some present. **FAIL THE JOB.** A half-configured signing setup
 *             that quietly skips the upload is the worst of the three: somebody
 *             set six secrets, the run went green, and no build reached
 *             TestFlight. Silence there costs a release cycle to notice.
 *
 * @param {Record<string,string|undefined>} env
 */
export function signingReadiness(env = {}) {
  const present = [];
  const missing = [];
  for (const key of SIGNING_SECRETS) {
    const v = env[key];
    if (typeof v === "string" && v.trim() !== "") present.push(key);
    else missing.push(key);
  }
  const state = missing.length === 0 ? "ready" : present.length === 0 ? "absent" : "partial";
  return {
    state,
    ready: state === "ready",
    present,
    missing,
    /** One line for the job summary, written so a founder can act on it. */
    message:
      state === "ready"
        ? "All 7 signing secrets present — archiving and uploading to TestFlight."
        : state === "absent"
          ? "No signing secrets set, so the TestFlight upload is skipped. The unsigned build " +
            "above still ran, and that is the designed behaviour — see HUMAN-ACTIONS.md #17."
          : `Signing is HALF configured: ${present.length} of ${SIGNING_SECRETS.length} secrets are ` +
            `set and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Failing ` +
            `rather than skipping, because a skipped upload on a green run is invisible.`,
  };
}

/* ─────────────────── which thing does xcodebuild get pointed at ───────────── */

/**
 * `-workspace` or `-project`, depending on what `cap add ios` actually generated.
 *
 * MEASURED, NOT ASSUMED — and the first run of this workflow is what settled it.
 * Every Capacitor iOS guide, and `HUMAN-ACTIONS.md` #14 as originally written,
 * assumes CocoaPods and therefore an `App.xcworkspace`. **Capacitor 8 does not
 * generate one.** Its iOS template uses Swift Package Manager: the first run
 * logged "All Capacitor plugins have a Package.swift file and will be included in
 * Package.swift", then "Writing Package.swift", then "ios platform added!" — no
 * `pod install`, no workspace. `xcodebuild -workspace` had nothing to point at.
 *
 * So this picks whichever container exists rather than hardcoding either, because
 * both are live possibilities: SPM is what 8.x does today, and a `cap` release or
 * a hand-added CocoaPods dependency could put a workspace back. Preferring the
 * workspace when both exist is the standard Xcode rule — a workspace exists
 * precisely to be built instead of the projects inside it.
 *
 * It THROWS when neither is there. A silent fallback would hand xcodebuild a
 * missing path and produce a build failure whose message is about the wrong thing.
 */
export function pickXcodeContainer({ workspace = null, project = null } = {}) {
  if (workspace) {
    return { flag: "-workspace", path: workspace, toolchain: "cocoapods-workspace" };
  }
  if (project) {
    return { flag: "-project", path: project, toolchain: "swiftpm-project" };
  }
  throw new Error(
    "`cap add ios` produced neither an .xcworkspace nor an .xcodeproj. Nothing can be built. " +
      "Read cap-add-ios.log and ios-tree.txt in the run artifact — the generated layout has " +
      "changed shape, which is a Capacitor-version change rather than a bug here."
  );
}

/* ──────────────────────────── which simulator ────────────────────────────── */

/**
 * Pick a simulator to boot from `xcrun simctl list devices available -j`.
 *
 * Newest iOS runtime, then the plainest iPhone in it — "iPhone 16" beats
 * "iPhone 16 Pro Max" because a smaller screenshot is easier to read and every
 * model runs the same WebKit. Throws rather than returning null: a run that
 * silently skips the simulator because the parse failed would report the two
 * measurements #38 exists for as "not attempted" with no reason.
 *
 * @param {string|object} listing simctl's JSON, parsed or not
 */
export function pickSimulator(listing) {
  const data = typeof listing === "string" ? safeJson(listing) : listing;
  if (!data || typeof data !== "object" || !data.devices) {
    throw new Error("simctl JSON has no `devices` key — cannot choose a simulator");
  }
  const candidates = [];
  for (const [runtime, devices] of Object.entries(data.devices)) {
    const version = iosVersion(runtime);
    if (version == null) continue; // tvOS, watchOS, visionOS
    for (const d of devices || []) {
      if (d.isAvailable === false) continue;
      if (!/^iPhone/.test(d.name || "")) continue;
      if (!d.udid) continue;
      candidates.push({ udid: d.udid, name: d.name, runtime, version, plainness: plainness(d.name) });
    }
  }
  if (!candidates.length) {
    throw new Error(
      "no available iPhone simulator in any iOS runtime. `xcrun simctl list devices available` " +
        "found none, so the runner's Xcode has no iOS platform installed."
    );
  }
  candidates.sort(
    (a, b) =>
      cmpVersion(b.version, a.version) || a.plainness - b.plainness || a.name.localeCompare(b.name)
  );
  return candidates[0];
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-18-2` -> [18, 2]; non-iOS -> null. */
function iosVersion(runtime) {
  const m = /iOS[-_ ](\d+)(?:[-_.](\d+))?(?:[-_.](\d+))?/i.exec(runtime);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/** Lower is plainer. "iPhone 16" (0) < "iPhone 16 Plus" (1) < "iPhone 16 Pro Max" (2). */
function plainness(name = "") {
  let n = 0;
  for (const suffix of [/\bPlus\b/i, /\bPro\b/i, /\bMax\b/i, /\bmini\b/i, /\bSE\b/i, /\bAir\b/i]) {
    if (suffix.test(name)) n++;
  }
  return n;
}

/* ──────────────────── getting the numbers off the simulator ───────────────── */

/**
 * Decode `sqlite3 -json "select key, hex(value) from ItemTable"` into a plain
 * `{key: string}` map.
 *
 * WHY HEX. WebKit stores localStorage values as BLOBs, and historically as
 * UTF-16LE — `cast(value as text)` on one of those yields a string with a NUL
 * after every character, which then fails `JSON.parse` and would have been read
 * as "the probe reported nothing". Newer WebKit writes UTF-8. Both encodings are
 * in the wild across simulator runtimes and neither is announced, so this sniffs:
 * a buffer with interleaved NULs is UTF-16LE, anything else is UTF-8.
 *
 * @param {Array<{key: string, hexval: string|null}>} rows
 */
export function decodeLocalStorageRows(rows) {
  const out = {};
  for (const row of rows || []) {
    if (!row || typeof row.key !== "string") continue;
    const hex = row.hexval ?? row.HEX ?? row["hex(value)"];
    if (typeof hex !== "string" || hex.length === 0) continue;
    const buf = Buffer.from(hex, "hex");
    out[row.key] = looksUtf16le(buf) ? buf.toString("utf16le") : buf.toString("utf8");
  }
  return out;
}

function looksUtf16le(buf) {
  if (buf.length < 2 || buf.length % 2 !== 0) return false;
  let nulOdd = 0;
  const sample = Math.min(buf.length, 64);
  for (let i = 1; i < sample; i += 2) if (buf[i] === 0) nulOdd++;
  return nulOdd > sample / 4;
}

/** Every probe record in a decoded localStorage map. `probe-outpoint.js` writes
 *  to a numbered slot rather than one fixed key — a `simctl launch` on a running
 *  app can restart it, and a fresh record must never overwrite a finished one —
 *  so there can be several. */
export function parseDump(dump) {
  const get = (k) => {
    const raw = dump?.[k];
    if (typeof raw !== "string") return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const bridge = get("foray_probe_bridge");
  const outPoints = Object.keys(dump || {})
    .filter((k) => /^foray_probe_outpoint(_\d+)?$/.test(k))
    .sort()
    .map(get)
    .filter(Boolean);
  /* The seam phase's record. Numbered like the out-point's, and for the same
     reason: `simctl launch` on a running app can restart it, and a fresh empty
     record must never overwrite a finished one. */
  const seams = Object.keys(dump || {})
    .filter((k) => /^foray_probe_seam(_\d+)?$/.test(k))
    .sort()
    .map(get)
    .filter(Boolean);
  return {
    bridge,
    outPoints,
    outPoint: pickOutPoint(outPoints),
    seams,
    seam: pickSeam(seams),
  };
}

/**
 * The most informative out-point record.
 *
 * Ranked, rather than "the last one", because a restart writes a fresh empty
 * record and "last" would systematically prefer the run that measured nothing —
 * the failure this repo keeps meeting: a green report built from absent data.
 */
export function pickOutPoint(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  /* BACKGROUNDING OUTRANKS STOPPING, and an adversarial pass is why. The first
     version scored `stoppedAtSec` above `backgroundedAtWall`, so a restarted run
     that played in the FOREGROUND and stopped cleanly beat the real backgrounded
     run in which the out-point NEVER FIRED — and `never-fired` is the one result
     MP1 §8 said would force a native iOS backend (#28). Ranking a foreground pass
     above the decisive negative is the exact failure this function's header
     claims to prevent. A record that never left the foreground cannot answer
     #38's question at all, so it sorts last however tidy it looks. */
  const score = (r) =>
    (r?.backgroundedAtWall != null ? 8 : 0) +
    (r?.stoppedAtSec != null ? 4 : 0) +
    (r?.stoppedWhileBackgrounded === true ? 2 : 0) +
    (Array.isArray(r?.timeupdateIntervalsMs) && r.timeupdateIntervalsMs.length ? 1 : 0) +
    (r?.autoplayBlocked ? -1 : 0);
  return [...records].sort((a, b) => score(b) - score(a))[0];
}

/**
 * The same records, recovered from the simulator's system log.
 *
 * THE SECOND CHANNEL, AND IT IS NOT REDUNDANT DECORATION. The primary channel is
 * WebKit's local-storage database, found by filename in the app container — a
 * filename WebKit has changed before and can change again with a runner image
 * bump. If that `find` stops matching, every verdict reads `inconclusive` and the
 * job is GREEN: #38 would produce nothing, forever, with no error anywhere. Both
 * probes also `console.log` their record, Capacitor's iOS bridge forwards console
 * output to `print()`, and `print()` lands in the system log the workflow already
 * captures. So the data is usually sitting in the artifact even when the database
 * read fails, and an earlier version of this file captured it and never looked.
 *
 * Note the dependency, honestly: this channel works only if the bridge is alive,
 * which is one of the things being measured. It rescues an out-point run; it
 * cannot rescue a `bridge-blocked` run. That is why it is the second channel and
 * not the first.
 */
export function parseConsoleProbes(text) {
  const bridge = [];
  const outPoints = [];
  const seams = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /FORAY_PROBE_(BRIDGE|OUTPOINT|SEAM)\s+(\{.*\})/.exec(line);
    if (!m) continue;
    let rec = null;
    try {
      rec = JSON.parse(m[2]);
    } catch {
      /* Log lines get truncated. Retry against the longest prefix that closes. */
      const cut = m[2].lastIndexOf("}");
      if (cut > 0) { try { rec = JSON.parse(m[2].slice(0, cut + 1)); } catch { rec = null; } }
    }
    if (!rec || typeof rec !== "object") continue;
    if (m[1] === "BRIDGE") bridge.push(rec);
    else if (m[1] === "SEAM") seams.push(rec);
    else outPoints.push(rec);
  }
  return { bridge, outPoints, seams };
}

/** Everything both channels found, and which channel each answer came from. */
export function collectProbes({ dump, consoleText } = {}) {
  const fromDump = parseDump(dump);
  const fromConsole = parseConsoleProbes(consoleText);
  /* The bridge probe rewrites one record as it learns more (an immediate
     snapshot, then a re-check at 3 s with the service-worker count), so the LAST
     console copy is the most complete. localStorage already holds only the final
     one, and is preferred because it does not depend on the bridge. */
  const bridge = fromDump.bridge ?? fromConsole.bridge[fromConsole.bridge.length - 1] ?? null;
  const outPoints = [...fromDump.outPoints, ...fromConsole.outPoints];
  const seams = [...(fromDump.seams ?? []), ...fromConsole.seams];
  return {
    bridge,
    outPoints,
    outPoint: pickOutPoint(outPoints),
    seams,
    seam: pickSeam(seams),
    sources: {
      bridge: fromDump.bridge ? "localStorage" : fromConsole.bridge.length ? "console" : "none",
      outPoint: fromDump.outPoints.length
        ? "localStorage"
        : fromConsole.outPoints.length
          ? "console"
          : "none",
    },
  };
}

/* ─────────────────────────────── the verdicts ────────────────────────────── */

/**
 * Did Capacitor's injected bridge survive our CSP on iOS?
 *
 * THE QUESTION (`docs/mobile-shell.md` § the top open risk). Capacitor builds
 * `native-bridge.js`, the app config and every plugin shim into a string and
 * injects it. Our CSP is `script-src 'self'` with no `'unsafe-inline'`,
 * permanently. If a `<meta>` CSP applies to that injection there is no
 * `window.Capacitor`, four plugins are dead, and `shouldRegisterServiceWorker`
 * loses one of its two signals. #209 reasons that iOS is fine because WKWebView
 * injects via `WKUserScript`, which runs outside the document's CSP — and says
 * plainly that nobody has run it.
 *
 * `swRegistrations` is measured in the same pass because it is the consequence,
 * not a separate question: the shell must have ZERO registrations whatever the
 * bridge did.
 *
 * @param {object|null} probe the `foray_probe_bridge` record, or null if none
 *   reached the host
 */
export function bridgeVerdict(probe) {
  if (!probe || typeof probe !== "object" || probe.capacitorType === undefined) {
    return {
      verdict: "inconclusive",
      headline: "No probe data came back — the bridge question is UNCHANGED.",
      detail:
        "The probe never reported, so this run says nothing about window.Capacitor. Do not " +
        "read it as a pass: docs/mobile-shell.md's open risk stays open and HUMAN-ACTIONS.md " +
        "#14 step 6.2 still needs doing.",
    };
  }
  const csp = Array.isArray(probe.cspViolations) ? probe.cspViolations : [];
  const scriptBlocked = csp.filter((v) => /script-src/.test(v?.directive || ""));
  /* `swRegistrations: 0` is only evidence if the API existed to be asked. Where
     `navigator.serviceWorker` is absent, 0 is true by construction and reporting
     it as "invariant 3 holding" would be a pass drawn from an absence. */
  const sw =
    typeof probe.swRegistrations === "number" && probe.hasServiceWorkerApi !== false
      ? probe.swRegistrations
      : null;
  const swNote =
    sw === null
      ? probe.hasServiceWorkerApi === false
        ? " Service workers are not available on this origin at all, so the registration count " +
          "says nothing either way."
        : " Service-worker registration count was not reported."
      : sw === 0
        ? " Service worker: 0 registrations inside the shell, which is invariant 3 holding."
        : ` SERVICE WORKER: ${sw} registration(s) inside the shell — invariant 3 is BROKEN here.`;

  if (probe.capacitorType === "undefined") {
    /* DO NOT NAME THE CSP AS THE CAUSE WITHOUT A VIOLATION TO POINT AT. An
       adversarial pass caught this asserting "the CSP blocked the bridge" from a
       missing `window.Capacitor` alone — and on iOS the CSP is the LEAST likely
       explanation: docs/mobile-shell.md §5 reasons that WKWebView injects via
       `WKUserScript`, outside the document's CSP. A failed `cap add`, a broken
       config, or a probe that ran before injection are all likelier. Turning a
       harness failure into a decisive architectural finding is how a false claim
       ends up in a doc. */
    const cause = scriptBlocked.length
      ? `The page reported ${scriptBlocked.length} script-src violation(s), so the CSP is the ` +
        `likely cause and this settles docs/mobile-shell.md §5 for iOS. Its "why the fix may not ` +
        `be one token" paragraph has the two options, both of which change the shell's shape.`
      : `NO script-src violation was observed, so the CAUSE IS UNKNOWN — and on iOS the CSP is ` +
        `the least likely one: docs/mobile-shell.md §5 reasons that WKWebView injects via ` +
        `WKUserScript, outside the document's CSP. Check cap-add-ios.log, csp-messages.txt and ` +
        `the simulator log before concluding anything about the CSP.`;
    return {
      verdict: "bridge-blocked",
      headline: "window.Capacitor is UNDEFINED in the iOS shell — the bridge did not reach the page.",
      detail:
        `All four installed plugins would be dead, and the shell loses the native signal it uses ` +
        `to keep the service worker off. ${cause}` +
        swNote,
      swRegistrations: sw,
      cspAttributable: scriptBlocked.length > 0,
    };
  }
  if (probe.capacitorType !== "object") {
    return {
      verdict: "inconclusive",
      headline: `window.Capacitor is a ${probe.capacitorType}, which is not a shape this repo predicted.`,
      detail: `Reported: ${JSON.stringify(probe).slice(0, 400)}`,
      swRegistrations: sw,
    };
  }
  if (probe.isNativePlatform !== true) {
    return {
      verdict: "bridge-present-not-native",
      headline:
        "window.Capacitor exists but isNativePlatform() did not return true — the bridge loaded " +
        "in its WEB mode inside a native app.",
      detail:
        `isNativePlatform() reported ${JSON.stringify(probe.isNativePlatform)}, platform ` +
        `${JSON.stringify(probe.platform)}. app.js's guard treats this as the web, so the service ` +
        `worker WOULD register.` + swNote,
      swRegistrations: sw,
    };
  }
  return {
    verdict: "bridge-present",
    headline: "window.Capacitor EXISTS on iOS — the CSP does not block Capacitor's injected bridge.",
    detail:
      `platform=${JSON.stringify(probe.platform)}, ` +
      `plugins=${JSON.stringify(probe.pluginNames || [])}, ` +
      `${csp.length} CSP violation(s) observed by the page.` +
      swNote +
      " So on iOS, `script-src 'self'` does not block Capacitor's bridge injection — which is " +
      "what docs/mobile-shell.md §5 REASONED (WKWebView injects via WKUserScript, outside the " +
      "document's CSP) and nobody had run. It says NOTHING about Android: that bridge is an " +
      "inline <script> in the served HTML, a different mechanism, and it is what §5 is actually " +
      "about. HUMAN-ACTIONS.md #16 stays open.",
    swRegistrations: sw,
  };
}

/** Overshoot at or under this counts as "the out-point still works".
 *
 *  MP1 §8's two predictions are **~0.25 s** if `timeupdate` survives
 *  backgrounding and **~1 s** if only the 1 s-aligned DOM timer does. 1.5 s is
 *  OUR tolerance — a margin above the worse of the two — and not a number MP1
 *  contains. That distinction was a real defect: an earlier version of this file
 *  printed "inside MP1 §8's predicted 1.5s band", attributing its own threshold
 *  to the source document, in a repo whose research doc carries a
 *  measured-versus-documented table precisely to stop that. */
export const OVERSHOOT_OK_SEC = 1.5;
/** MP1 §8's prediction if the `timeupdate` inference HOLDS. */
export const MP1_TIMEUPDATE_PREDICTION_SEC = 0.25;
/** MP1 §8's prediction if it does not, and only the aligned DOM timer survives. */
export const MP1_ALIGNED_TIMER_PREDICTION_SEC = 1;

/**
 * The least HIDDEN playback a run must observe before "the out-point fires while
 * backgrounded" means anything.
 *
 * THIS FLOOR EXISTS BECAUSE ITS ABSENCE PRODUCED AN OVERCLAIM ON THE FIRST REAL
 * RUN. That run reported `fires-in-background`, a 4 ms overshoot and "the
 * inference HELD" — from a hidden window of **0.446 s** and exactly TWO hidden
 * `timeupdate` samples. The page had been VISIBLE for 24.5 of the 25 s, because
 * `simctl launch com.apple.Preferences` returns before Settings actually reaches
 * the foreground and the wall-clock timeline assumed otherwise. Everything the
 * verdict said was true and none of it was evidence.
 *
 * 5 s is not a statistical threshold, it is the point below which the claim stops
 * being about backgrounding: ~20 `timeupdate` intervals, and long enough that a
 * throttle which takes a moment to engage would show. The probe now arms the
 * boundary 15 s after the page goes hidden, so a healthy run clears this by 3x.
 */
export const MIN_HIDDEN_PLAYBACK_SEC = 5;
/** Above this the out-point did not meaningfully fire. MP1 §3 measured the cost
 *  of a missed out-point at a 936.5 s median — 15.6 minutes of the wrong
 *  episode — so anything in the middle band is still a real defect. */
export const OVERSHOOT_BAD_SEC = 10;

/**
 * Did our out-point still fire while the app was not in the foreground?
 *
 * @param {object|null} probe the `foray_probe_outpoint` record
 */
export function outPointVerdict(probe) {
  /* `endSec: null` is now the NORMAL not-yet-armed state — the boundary is armed
     relative to going hidden — so an unarmed record is inconclusive rather than
     malformed, and says which of the two it is. */
  if (probe && typeof probe === "object" && probe.endSec === null && probe.armedWhileHidden === null) {
    return {
      verdict: "inconclusive",
      headline: "The out-point was never armed, so nothing was measured.",
      detail:
        probe.autoplayBlocked
          ? `Playback never started: ${String(probe.autoplayError || "play() rejected")}.`
          : "The probe recorded neither a hidden transition nor its 40 s fallback arm, so it did " +
            "not run long enough to arm anything. Check the run's screenshots.",
    };
  }
  if (!probe || typeof probe !== "object" || typeof probe.endSec !== "number") {
    return {
      verdict: "inconclusive",
      headline: "No out-point data came back — MP1 §8's load-bearing inference is UNCHANGED.",
      detail:
        "Nothing was measured, so `timeupdate` surviving backgrounding remains an inference. " +
        "HUMAN-ACTIONS.md #11 and #14 step 6.4 still need a device.",
    };
  }
  if (probe.autoplayBlocked) {
    return {
      verdict: "inconclusive",
      headline: "Playback never started (autoplay was refused), so nothing was measured.",
      detail:
        `The probe reported: ${String(probe.autoplayError || "play() rejected")}. Capacitor sets ` +
        `mediaTypesRequiringUserActionForPlayback = [] (MP1 §7.3), so this is unexpected and is a ` +
        `finding about the harness, not about backgrounding.`,
    };
  }
  if (probe.backgroundedAtWall == null) {
    return {
      verdict: "inconclusive",
      headline: "The app was never observed to leave the foreground, so this measures nothing new.",
      detail:
        "`visibilitychange` never reported hidden. An out-point firing in a FOREGROUNDED page is " +
        "what player/html-audio-backend.test.js already covers.",
    };
  }
  /* THE OUT-POINT MUST BE WHAT STOPPED IT. `html-audio-backend.js` reports the
     same `onItemEnded` for a finished FILE (`END_NATURAL` = "natural") as for a
     boundary (`END_OUT_POINT` = "outPoint"), by design — the manager must not be
     able to tell them apart. Here they are opposite results: if the tone ran out
     first, the "overshoot" would look perfect and mean nothing. The 150 s tone
     against a ~70 s window is a margin, not a check, so this is the check. */
  if (probe.endReason != null && probe.endReason !== "outPoint") {
    return {
      verdict: "inconclusive",
      headline: `Playback ended with reason "${probe.endReason}", not at the out-point.`,
      detail:
        probe.endReason === "natural"
          ? "The audio file ended before the boundary did, so the stop measures the length of the " +
            "tone rather than the out-point. Lengthen TONE_SECONDS in " +
            "tools/mobile/probe/install-probe.mjs; nothing is known about backgrounding from this run."
          : "An unexpected end reason. Nothing is known about backgrounding from this run.",
      overshootSec: null,
    };
  }
  if (probe.stoppedAtSec == null) {
    return {
      verdict: "never-fired",
      headline:
        `The out-point NEVER FIRED. Playback ran past end_sec=${probe.endSec}s for the whole ` +
        `observation window and was still going when it ended.`,
      detail:
        "This is the decisive negative result, and it is the one MP1 §8 said would mean iOS needs " +
        "a native audio backend too (#28). MP1 §3 measured the cost of a missed out-point at a " +
        "936.5 s median — 15.6 minutes of the wrong episode.",
      overshootSec: null,
    };
  }

  const overshoot =
    typeof probe.overshootSec === "number"
      ? probe.overshootSec
      : Math.max(0, probe.stoppedAtSec - probe.endSec);
  const median = medianMs(probe.timeupdateIntervalsMs);
  const where = probe.stoppedWhileBackgrounded
    ? "while the app was backgrounded"
    : "only after the app came back to the foreground";
  const hiddenSec =
    typeof probe.hiddenPlaybackSec === "number" ? probe.hiddenPlaybackSec : null;
  const hiddenNote =
    hiddenSec == null
      ? " The length of the hidden window was not recorded."
      : ` Hidden playback observed: ${hiddenSec.toFixed(3)}s` +
        (typeof probe.hiddenTimeupdates === "number"
          ? ` (${probe.hiddenTimeupdates} hidden timeupdate samples).`
          : ".");
  const base =
    `Stopped at ${probe.stoppedAtSec.toFixed(3)}s against end_sec=${probe.endSec.toFixed(3)}s: ` +
    `overshoot ${overshoot.toFixed(3)}s, ${where}.` +
    hiddenNote +
    (median == null ? "" : ` Median timeupdate interval while hidden: ${median.toFixed(0)} ms.`);

  /* THE FLOOR. See MIN_HIDDEN_PLAYBACK_SEC — this exact case shipped a
     `fires-in-background` verdict from 0.446 s of hidden playback on the first
     real run, and every sentence in it was true. */
  if (probe.stoppedWhileBackgrounded && hiddenSec != null && hiddenSec < MIN_HIDDEN_PLAYBACK_SEC) {
    return {
      verdict: "hidden-window-too-short",
      headline:
        `The out-point fired ${overshoot.toFixed(3)}s past end_sec and the page WAS hidden — but ` +
        `only for ${hiddenSec.toFixed(3)}s, which is not a measurement of backgrounding.`,
      detail:
        base +
        ` Below the ${MIN_HIDDEN_PLAYBACK_SEC}s floor this workflow requires, so it is reported as ` +
        `inconclusive rather than as a pass. The probe arms the boundary 15 s after the page goes ` +
        `hidden precisely so a healthy run clears that floor; a run landing here means the app was ` +
        `backgrounded far later than intended — check the screenshots and hiddenTransitions.`,
      overshootSec: overshoot,
      medianTimeupdateMs: median,
      hiddenPlaybackSec: hiddenSec,
    };
  }

  if (!probe.stoppedWhileBackgrounded) {
    /* TWO VERY DIFFERENT THINGS LOOK THE SAME HERE, and conflating them produced a
       false alarm on the second real run: it reported `fired-on-resume` — "MP1 §8's
       failure mode", the scary one — with an overshoot of **3 milliseconds**. Those
       two facts cannot both be about a real failure. If nothing had stopped the
       audio for the whole time the app was backgrounded, the overshoot would be
       measured in tens of seconds; 3 ms means the boundary was simply crossed while
       the page was VISIBLE, i.e. the harness failed to background the app in time.
       A harness artifact wearing the label of an architectural failure is how a
       decision gets made on nothing. */
    if (overshoot <= OVERSHOOT_OK_SEC) {
      return {
        verdict: "inconclusive",
        headline:
          `The boundary was crossed while the page was VISIBLE (overshoot ` +
          `${overshoot.toFixed(3)}s), so this run says nothing about backgrounding.`,
        detail:
          base +
          " This is NOT MP1 §8's failure mode: an out-point that had genuinely stopped firing in " +
          "the background would overshoot by however long the app stayed backgrounded, not by " +
          "milliseconds. The app was backgrounded too late, or came back too early, relative to " +
          "the boundary. The probe arms 15 s after the page goes hidden to make that impossible; " +
          "a run landing here means the arm did not happen as designed.",
        overshootSec: overshoot,
        medianTimeupdateMs: median,
        hiddenPlaybackSec: hiddenSec,
      };
    }
    return {
      verdict: "fired-on-resume",
      headline:
        `The out-point fired ONLY ON RESUME, ${overshoot.toFixed(1)}s past end_sec — while ` +
        `backgrounded, nothing stopped the audio.`,
      detail:
        base +
        " That is MP1 §8's failure mode: the overshoot is bounded only by how long the app stays " +
        "backgrounded, which on a commute is the whole commute.",
      overshootSec: overshoot,
      medianTimeupdateMs: median,
      hiddenPlaybackSec: hiddenSec,
    };
  }
  if (overshoot <= OVERSHOOT_OK_SEC) {
    /* WHICH of MP1 §8's two predictions came true is a separate question from
       whether the out-point works, and it is the more interesting one. ~0.25 s
       means `timeupdate` survived — the load-bearing inference held. ~1 s means
       it did NOT, and the 1 s-aligned DOM timer covered for it. The median
       timeupdate interval tells them apart directly; the overshoot alone does
       not, which is why an earlier version collapsing both into "inside the
       predicted band" was hiding the finding. */
    const inference =
      median == null
        ? "No timeupdate intervals were sampled while hidden, so which of MP1 §8's two mechanisms " +
          "carried this is unknown."
        : median <= 500
          ? `timeupdate kept firing at ~${median.toFixed(0)} ms while hidden, so MP1 §8's ` +
            `load-bearing inference HELD (it predicted ~${MP1_TIMEUPDATE_PREDICTION_SEC}s of overshoot ` +
            `in that case).`
          : `timeupdate slowed to ~${median.toFixed(0)} ms while hidden, so MP1 §8's inference did ` +
            `NOT hold — the ~1 s-aligned DOM timer covered for it, which is the ` +
            `~${MP1_ALIGNED_TIMER_PREDICTION_SEC}s case that document also predicted. The out-point ` +
            `still works; its precision in the background does not come from where MP1 thought.`;
    return {
      verdict: "fires-in-background",
      headline:
        `The out-point FIRED while backgrounded, ${overshoot.toFixed(3)}s past end_sec — within ` +
        `this workflow's ${OVERSHOOT_OK_SEC}s tolerance, against MP1 §8's predictions of ` +
        `~${MP1_TIMEUPDATE_PREDICTION_SEC}s / ~${MP1_ALIGNED_TIMER_PREDICTION_SEC}s.`,
      detail: `${base} ${inference}`,
      overshootSec: overshoot,
      medianTimeupdateMs: median,
    };
  }
  if (overshoot < OVERSHOOT_BAD_SEC) {
    return {
      verdict: "fires-late",
      headline:
        `The out-point fired while backgrounded but ${overshoot.toFixed(2)}s late — worse than ` +
        `MP1 §8 predicts and audible.`,
      detail: base + " A real regression, not the 15.6-minute disaster.",
      overshootSec: overshoot,
      medianTimeupdateMs: median,
    };
  }
  return {
    verdict: "fires-far-too-late",
    headline: `The out-point overshot by ${overshoot.toFixed(1)}s — far outside anything tolerable.`,
    detail: base + " Treat this as the negative result: iOS would need a native backend (#28).",
    overshootSec: overshoot,
    medianTimeupdateMs: median,
  };
}

/* ─────────── the seam transition: does the ADVANCE survive backgrounding ───── */

/**
 * The beat the player asks for at an unbridged seam, in ms. Mirrors
 * `SEAM_GAP_SEC` in `player/seam-gap.js` — not imported, because this module is a
 * CI tool and `player/` is browser code, but pinned by `ios-ci.test.mjs` against
 * that file so the two cannot drift.
 */
export const SEAM_ASKED_MS = 2000;

/**
 * How long an observed beat may run before it counts as audible dead air.
 *
 * DERIVED FROM A MEASUREMENT, NOT PICKED. Run 32026332637 measured hidden-page
 * DOM timers on iOS aligned to a median of **1000 ms** (`timerIntervalsMs`:
 * 253, 925, 1000, 1000, 1001, 998, …, 25 samples), which settles MP1 §7.5's
 * previously-unverified 1 s claim. A `setTimeout(2000)` on a 1 s-aligned clock can
 * therefore land anywhere up to ~3000 ms, and the cross-file load runs inside the
 * beat. 5000 ms leaves headroom above that without waving through a stall — and it
 * is close to MP1 §4's Chromium observation that the same beat stretched to
 * 2.8–4.6 s in a hidden page.
 *
 * Note which way the uncertainty runs: this is OUR tolerance, not a number any
 * source document contains. Saying otherwise is the specific mistake
 * `OVERSHOOT_OK_SEC` above carries a paragraph about.
 */
export const SEAM_OK_MS = 5000;

/** Beyond this the beat is not a beat. A listener with a locked screen hears
 *  silence and reaches for their phone, which is the whole defect. */
export const SEAM_BAD_MS = 15000;

/**
 * The least number of COMPLETED hidden transitions a run needs before it is
 * allowed to say the seam works.
 *
 * One would be a result; two is a mechanism. The specific worry two catches is a
 * transition that succeeds inside WebKit's audibility grace window
 * (`audibleActivityClearDelay`, 10 s) and then fails on the next one, once the
 * page has been silent long enough for the assertion to lapse — which is exactly
 * the risk `docs/research/mp1-background-audio.md` names and leaves unmeasured.
 */
export const MIN_HIDDEN_TRANSITIONS = 2;

/**
 * The most informative seam record.
 *
 * Ranked, and the ranking deliberately puts the DECISIVE NEGATIVE first, which is
 * the lesson `pickOutPoint` above records paying for: a restarted run that
 * completed its transitions in the FOREGROUND must not outrank a backgrounded run
 * in which playback stalled, because the stall is the whole finding. A record that
 * never left the foreground cannot answer this question at all, however tidy it
 * looks.
 */
export function pickSeam(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const score = (r) =>
    (r?.backgroundedAtWall != null ? 8 : 0) +
    (Array.isArray(r?.transitions) && r.transitions.length ? 4 : 0) +
    (Array.isArray(r?.items) && r.items.length > 1 ? 2 : 0) +
    (r?.autoplayBlocked ? -4 : 0) +
    (r?.error ? -2 : 0);
  return [...records].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Did the SEAM TRANSITION survive backgrounding?
 *
 * ── THE QUESTION, AND WHY IT IS NOT THE ONE ALREADY ANSWERED ─────────────────
 *
 * Run 32026332637 settled the STOP: the out-point fired 4 ms past `end_sec` over a
 * 15.056 s hidden window, with `resumedAtWall: null` — the app was never brought
 * back. MP1 §8's load-bearing inference held.
 *
 * That says nothing about the ADVANCE, and the advance is a different mechanism on
 * a different clock. Each of Foray #1's 31 seams is: stop at `end_sec`, wait a
 * JavaScript-scheduled 2.0 s beat (`player/seam-gap.js`), load a DIFFERENT
 * episode, seek to its `start_sec`, play. The beat is a `setTimeout`, and the same
 * probe that proved the stop also measured hidden-page DOM timers aligned to a
 * median of 1000 ms — so the beat runs on the one clock that IS throttled, and the
 * load is a fresh media fetch in a page WebKit may have stopped considering
 * audible.
 *
 * If that chain breaks, a listener with a locked screen hears one segment and then
 * silence for the rest of the commute. That is a different defect from playing the
 * wrong episode, and it is not fixed by anything that fixes the stop.
 *
 * ── WHAT COUNTS AS AN ANSWER ─────────────────────────────────────────────────
 *
 * Two completed transitions, both begun and finished with the app backgrounded and
 * before any resume. One is a result; two is a mechanism — see
 * `MIN_HIDDEN_TRANSITIONS` for the specific failure the second one catches.
 *
 * @param {object|null} probe the `foray_probe_seam` record
 */
export function seamTransitionVerdict(probe) {
  if (!probe || typeof probe !== "object" || !Array.isArray(probe.items)) {
    return {
      verdict: "inconclusive",
      headline: "No seam data came back — whether the TRANSITION survives backgrounding is UNKNOWN.",
      detail:
        "Nothing was measured, so the 2.0 s beat and the cross-episode load remain untested while " +
        "hidden. The out-point result from run 32026332637 does not cover them: it proves one " +
        "segment STOPS on time, not that the next one starts.",
    };
  }
  if (probe.autoplayBlocked) {
    return {
      verdict: "inconclusive",
      headline: "Playback never started (autoplay was refused), so no seam was reached.",
      detail:
        `The probe reported: ${String(probe.autoplayError || "play() rejected")}. Capacitor sets ` +
        `mediaTypesRequiringUserActionForPlayback = [] (MP1 §7.3), so this is a finding about the ` +
        `harness rather than about backgrounding.`,
    };
  }
  if (probe.error) {
    return {
      verdict: "inconclusive",
      headline: "The seam probe reported an error before it could measure anything.",
      detail: `It said: ${String(probe.error)}`,
    };
  }
  if (probe.backgroundedAtWall == null) {
    return {
      verdict: "inconclusive",
      headline: "The app was never observed to leave the foreground, so this measures nothing new.",
      detail:
        "`visibilitychange` never reported hidden. A seam completing in a FOREGROUNDED page is what " +
        "player/foray-playback.test.js already covers, for all 31 of Foray #1's transitions.",
    };
  }

  const bg = probe.backgroundedAtWall;
  const resumed = typeof probe.resumedAtWall === "number" ? probe.resumedAtWall : null;
  const transitions = Array.isArray(probe.transitions) ? probe.transitions : [];

  /* HIDDEN THROUGHOUT, CHECKED TWO WAYS. The page's own `document.hidden` reading
     at each edge, AND the wall clock against the backgrounded/resumed stamps. Both,
     because the first is a signal from the process under suspicion and the second
     cannot see a brief visibility blip. A transition only counts if both agree. */
  const isHidden = (t) =>
    t &&
    t.hiddenAtBoundary === true &&
    t.hiddenAtNextPlaying === true &&
    typeof t.boundaryAtWall === "number" &&
    t.boundaryAtWall >= bg &&
    typeof t.nextPlayingAtWall === "number" &&
    (resumed == null || t.nextPlayingAtWall < resumed);

  const attemptedHidden = transitions.filter(
    (t) => t && typeof t.boundaryAtWall === "number" && t.boundaryAtWall >= bg && t.hiddenAtBoundary === true
  );
  const completedHidden = transitions.filter(isHidden);
  const stalled = attemptedHidden.filter((t) => typeof t.nextPlayingAtWall !== "number");

  const lastSeenWall =
    typeof probe.lastSavedAtWall === "number" ? probe.lastSavedAtWall : probe.startedAtWall ?? bg;
  const gaps = completedHidden.map((t) => t.observedGapMs).filter((n) => typeof n === "number");
  const worstGap = gaps.length ? Math.max(...gaps) : null;
  const asked = typeof probe.askedGapMs === "number" ? probe.askedGapMs : SEAM_ASKED_MS;
  const timerMedian = medianMs(probe.timerIntervalsMs);

  const base =
    `${transitions.length} transition(s) recorded, ${attemptedHidden.length} begun while hidden, ` +
    `${completedHidden.length} completed while hidden.` +
    (worstGap == null
      ? ""
      : ` Beat asked for ${asked} ms; observed ${gaps.map((g) => Math.round(g)).join(", ")} ms.`) +
    (timerMedian == null
      ? ""
      : ` Median hidden DOM-timer interval this run: ${timerMedian.toFixed(0)} ms.`) +
    (resumed == null
      ? " The app was NEVER resumed during this run."
      : ` The app returned to the foreground ${((resumed - bg) / 1000).toFixed(1)}s after backgrounding.`);

  /* THE FAILURE, FIRST, because it is the one that changes what gets built next. */
  if (stalled.length) {
    const t = stalled[0];
    const waited = (lastSeenWall - t.boundaryAtWall) / 1000;
    return {
      verdict: "seam-stalls-in-background",
      headline:
        `A segment ENDED while backgrounded and the next one NEVER STARTED — nothing became ` +
        `audible for the remaining ${waited.toFixed(1)}s of the run.`,
      detail:
        `${base} This is the defect the out-point result cannot rule out: the stop works and the ` +
        `advance does not, so a listener with a locked screen hears one segment and then silence. ` +
        `The last thing the page recorded was ${JSON.stringify(t.lastStage ?? "unreported")}, which ` +
        `is where to look: a throttled beat timer, or a media load that never settled inside ` +
        `LOAD_SETTLE_TIMEOUT_MS. Something native would have to own the transition (#28).`,
      completedHiddenTransitions: completedHidden.length,
      worstGapMs: worstGap,
    };
  }
  if (!attemptedHidden.length) {
    return {
      verdict: "inconclusive",
      headline: "No seam was reached while the app was backgrounded, so this run says nothing.",
      detail:
        `${base} The first boundary was expected ~15 s after the page went hidden. If it never ` +
        `fired at all that contradicts run 32026332637 and is the more interesting finding — check ` +
        `the probe's telemetry and screenshots before reading this as a timing problem.`,
    };
  }
  if (completedHidden.length < MIN_HIDDEN_TRANSITIONS) {
    return {
      verdict: "too-few-transitions",
      headline:
        `${completedHidden.length} hidden transition(s) completed, below the ` +
        `${MIN_HIDDEN_TRANSITIONS} this workflow requires before calling the seam sound.`,
      detail:
        `${base} Reported as inconclusive rather than as a pass: one transition can succeed inside ` +
        `WebKit's ${"`audibleActivityClearDelay`"} grace window and the next still fail once the page ` +
        `has been silent long enough for the audibility assertion to lapse. The probe plans ` +
        `${probe.plannedItems ?? "several"} items precisely so that case shows up.`,
      completedHiddenTransitions: completedHidden.length,
      worstGapMs: worstGap,
    };
  }
  if (worstGap != null && worstGap > SEAM_BAD_MS) {
    return {
      verdict: "seam-stalls-in-background",
      headline:
        `The seam completed but took ${(worstGap / 1000).toFixed(1)}s against a ${asked} ms beat — ` +
        `that is a stall a listener would react to, not a beat.`,
      detail: `${base} Treat it as the negative result.`,
      completedHiddenTransitions: completedHidden.length,
      worstGapMs: worstGap,
    };
  }
  if (worstGap != null && worstGap > SEAM_OK_MS) {
    return {
      verdict: "seam-late-in-background",
      headline:
        `Every hidden transition completed, but the worst beat ran ${Math.round(worstGap)} ms ` +
        `against ${asked} ms asked — outside this workflow's ${SEAM_OK_MS} ms tolerance.`,
      detail:
        `${base} Playback continues, so this is not the silence defect; it is audible dead air at a ` +
        `seam, and ${SEAM_OK_MS} ms was chosen to allow for the 1000 ms hidden-timer alignment this ` +
        `run measured. Worth a look at whether the load, rather than the timer, is the slow part.`,
      completedHiddenTransitions: completedHidden.length,
      worstGapMs: worstGap,
    };
  }
  return {
    verdict: "seam-crosses-in-background",
    headline:
      `${completedHidden.length} seam transitions COMPLETED while the app was backgrounded — the ` +
      `beat ran, a different episode loaded, it seeked and it played, worst beat ` +
      `${worstGap == null ? "n/a" : Math.round(worstGap) + " ms"} against ${asked} ms asked.`,
    detail:
      `${base} So the 2.0 s beat's ${"`setTimeout`"} and the cross-episode media load both survive ` +
      `backgrounding on iOS, which together with run 32026332637's out-point result means the whole ` +
      `segment-to-segment chain runs with the app in the background and never resumed. #28's iOS ` +
      `half needs nothing native for this.`,
    completedHiddenTransitions: completedHidden.length,
    worstGapMs: worstGap,
  };
}

/** THE LIMIT OF THIS MEASUREMENT, carried with every verdict that quotes it.
 *
 *  The next segment's audio is a LOCAL file in the app bundle. That is not a
 *  choice about rigour, it is forced twice over: product principle #3 forbids
 *  reusing episode audio and a CI job hammering a podcast CDN is exactly what that
 *  principle is about, and the probe page's own CSP is `media-src 'self'`. So what
 *  this settles is the BEAT'S TIMER and a fresh cross-file media load while
 *  hidden. A cold HTTPS fetch from a podcast host while hidden — DNS, TLS, a range
 *  request into the middle of a 90 MB file — is NOT measured here, and it is the
 *  part `docs/research/mp1-background-audio.md` warns could push the silent window
 *  past WebKit's 10 s audibility grace. */
export const LOCAL_MEDIA_CAVEAT =
  "The seam's next segment is a LOCAL bundled file, not a podcast CDN fetch (product principle #3, " +
  "and the probe page's own media-src 'self'). This measures the beat's timer and a fresh media " +
  "load while hidden; a cold cross-origin fetch while hidden is still unmeasured.";

/** A finite number, or null. Journals arrive as JSON with explicit nulls. */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function medianMs(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return null;
  const nums = intervals.filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = nums.length >> 1;
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/** A SIMULATOR IS NOT A DEVICE, and this sentence ships with every verdict.
 *  The simulator runs on the host's CPU with the host's power policy: it does
 *  not model true suspension, the freezer, or RunningBoard's assertions. So a
 *  PASS here is weak evidence and a FAILURE is strong — which is exactly the
 *  asymmetry that makes it worth running at all. */
export const SIMULATOR_CAVEAT =
  "Measured in the iOS Simulator, which does not model power management or true app " +
  "suspension. A pass here is WEAKER evidence than a failure would be: it cannot promise a " +
  "device will behave the same way, while a failure would have been decisive. " +
  "HUMAN-ACTIONS.md #11/#14 still want one real phone.";

/**
 * The whole report, as markdown for `$GITHUB_STEP_SUMMARY`.
 *
 * `signingState` is passed IN, from the gate step's own output. It used to be
 * recomputed here from `process.env` — but the reporting step is not given the
 * secrets (and must not be), so section 3 read "no signing secrets set" no matter
 * what. It was right only by accident, and would have started lying the day
 * HUMAN-ACTIONS.md #17 was done: the same run would have said `state=ready` at
 * the gate and "not configured" in the summary. A report that cannot observe what
 * it asserts should not assert it.
 */
export function renderReport({ bridge, outPoint, seam, signingState, build }) {
  const b = bridgeVerdict(bridge);
  const o = outPointVerdict(outPoint);
  const s = seamTransitionVerdict(seam ?? null);
  const lines = [];
  lines.push("## iOS shell — what this run actually established", "");
  if (build) lines.push(`**Build:** ${build}`, "");
  lines.push(`### 1. Capacitor's bridge vs our CSP — \`${b.verdict}\``, "", b.headline, "", b.detail, "");
  lines.push(`### 2. The out-point while backgrounded — \`${o.verdict}\``, "", o.headline, "", o.detail, "");
  lines.push(
    `### 3. The SEAM TRANSITION while backgrounded — \`${s.verdict}\``,
    "",
    s.headline,
    "",
    s.detail,
    "",
    `> ${LOCAL_MEDIA_CAVEAT}`,
    ""
  );
  lines.push(`> ${SIMULATOR_CAVEAT}`, "");
  lines.push(
    `### 4. TestFlight upload — \`${signingState || "not reported"}\``,
    "",
    signingState
      ? SIGNING_STATE_NOTES[signingState] || `The signing gate reported \`${signingState}\`.`
      : "The signing gate did not report — read its own step, not this line.",
    ""
  );
  return lines.join("\n");
}

const SIGNING_STATE_NOTES = {
  ready: "All signing secrets are present, so the archive and TestFlight upload ran. That path has " +
    "never executed before — read its log rather than assuming it worked.",
  absent:
    "No signing secrets are set, so the upload was skipped. The unsigned build still ran, and that " +
    "is the designed behaviour — see HUMAN-ACTIONS.md #17.",
  partial:
    "Signing is only half configured, so the job failed on purpose rather than skipping the upload " +
    "on a green run. See HUMAN-ACTIONS.md #17: set all seven secrets or none.",
};

/* --------------------------------------------------------------------- main */

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const appendOutput = (line) => {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line + "\n");
    console.log(line);
  };
  const readMaybe = (p) => {
    if (!p || !fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
  };

  try {
    if (cmd === "signing-gate") {
      const r = signingReadiness(process.env);
      appendOutput(`state=${r.state}`);
      appendOutput(`ready=${r.ready}`);
      appendOutput(`missing=${r.missing.join(",")}`);
      console.error(r.message);
      /* `partial` is the one that fails. See signingReadiness(). */
      process.exit(r.state === "partial" ? 1 : 0);
    } else if (cmd === "xcode-container") {
      const iosDir = rest[0];
      if (!iosDir) throw new Error("xcode-container needs the generated ios/ directory");
      const ws = path.join(iosDir, "App", "App.xcworkspace");
      const proj = path.join(iosDir, "App", "App.xcodeproj");
      const c = pickXcodeContainer({
        workspace: fs.existsSync(ws) ? ws : null,
        project: fs.existsSync(proj) ? proj : null,
      });
      appendOutput(`xc_flag=${c.flag}`);
      appendOutput(`xc_path=${c.path}`);
      appendOutput(`xc_toolchain=${c.toolchain}`);
      console.error(`Building with ${c.flag} ${c.path} (${c.toolchain})`);
    } else if (cmd === "pick-simulator") {
      const raw = rest[0] ? fs.readFileSync(rest[0], "utf8") : fs.readFileSync(0, "utf8");
      const sim = pickSimulator(raw);
      appendOutput(`udid=${sim.udid}`);
      appendOutput(`name=${sim.name}`);
      appendOutput(`runtime=${sim.runtime}`);
      console.error(`Chose ${sim.name} (${sim.runtime})`);
    } else if (cmd === "decode-localstorage") {
      if (!rest.length) throw new Error("decode-localstorage needs at least one rows.json");
      const rows = [];
      for (const f of rest) {
        const parsed = readMaybe(f);
        if (Array.isArray(parsed)) rows.push(...parsed);
      }
      console.log(JSON.stringify(decodeLocalStorageRows(rows), null, 2));
    } else if (cmd === "verdict") {
      const dump = readMaybe(rest[0]) || {};
      const consoleText =
        rest[1] && fs.existsSync(rest[1]) ? fs.readFileSync(rest[1], "utf8") : "";
      const { bridge, outPoint, outPoints, seam, seams, sources } = collectProbes({ dump, consoleText });
      console.error(
        `read ${Object.keys(dump).length} localStorage key(s) and ${consoleText.length} bytes of ` +
          `console log; bridge record ${bridge ? `from ${sources.bridge}` : "ABSENT"}; ` +
          `${outPoints.length} out-point record(s) from ${sources.outPoint}; ` +
          `${seams.length} seam record(s)`
      );
      const report = renderReport({
        bridge,
        outPoint,
        seam,
        signingState: process.env.SIGNING_STATE || null,
        build: process.env.IOS_BUILD_STATUS || null,
      });
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
      console.log(report);
      const b = bridgeVerdict(bridge);
      const o = outPointVerdict(outPoint);
      const s = seamTransitionVerdict(seam);
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
          process.env.GITHUB_OUTPUT,
          `bridge=${b.verdict}\noutpoint=${o.verdict}\nseam=${s.verdict}\n`
        );
      }
      /* Deliberately exit 0 for every verdict, INCLUDING the bad ones. This step
         reports a measurement; it is not a gate. A red X here would read as "the
         iOS build is broken" when what happened is that we learned something —
         and #38's own instruction is that the build must keep running.
         WHERE TO READ THE RESULT: the run's job summary and the `ios-shell-evidence`
         artifact. Nothing here writes to a PR — this workflow holds
         `contents: read` and no token, deliberately — so if a verdict belongs in a
         PR body, a human or a session puts it there. */
    } else {
      console.error("Usage: node tools/mobile/ios-ci.mjs <signing-gate|pick-simulator|verdict> [args]");
      process.exit(2);
    }
  } catch (e) {
    console.error(`ios-ci ${cmd} failed: ${e.message}`);
    process.exit(1);
  }
}
