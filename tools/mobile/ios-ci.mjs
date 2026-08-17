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
 *   node tools/mobile/ios-ci.mjs redact-localstorage <rows.json>
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
 *  this repo or in this project's GitHub org — see `HUMAN-ACTIONS.md` #19. The
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
            "above still ran, and that is the designed behaviour — see HUMAN-ACTIONS.md #19."
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
 * Every Capacitor iOS guide, and `HUMAN-ACTIONS.md` #16 as originally written,
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

/** The only localStorage keys whose VALUES may leave the runner.
 *
 *  Everything the probes write, and nothing else. Deliberately a prefix
 *  allowlist rather than a denylist of secrets: a denylist is a promise about
 *  every key the app will ever write, and the app is not this file's to know.
 *  A key added to `app.js` next month is redacted here by default, which is the
 *  only direction of failure that is safe in a public artifact. */
export const ARTIFACT_VALUE_ALLOWLIST = [/^foray_probe_/];

/**
 * Strip every value the artifact has no business publishing.
 *
 * WHY THIS EXISTS. The `ios-shell-evidence` artifact was shipping the app's
 * WHOLE `localStorage`, hex-encoded, and this repo is public — so anyone could
 * download `ls-rows-2.json` and decode `cp_sb_session`, which is a live Supabase
 * `access_token` (ES256 JWT, anonymous `sub`, one-hour `exp`) plus the project
 * ref. Per `STATE.md`'s delete-my-data entry that token is **the only credential
 * that can reach that account's server rows**. The blast radius of the one
 * leaked token is small — a throwaway simulator account, expired within the
 * hour — but a step that dumps all of `localStorage` leaks whatever lands there
 * next, and that is the defect.
 *
 * The KEY NAMES are kept, with a byte count. That is the whole diagnostic value
 * of the non-probe rows — "did the app run and write anything at all" — and it
 * carries no secret. Losing the names would cost the one thing this dump is
 * useful for when a probe record is missing.
 *
 * @param {Array<{key: string, hexval: string|null}>} rows
 * @returns {{rows: Array<object>, redacted: string[]}}
 */
export function redactLocalStorageRows(rows) {
  const kept = [];
  const redacted = [];
  for (const row of rows || []) {
    if (!row || typeof row.key !== "string") continue;
    const hex = row.hexval ?? row.HEX ?? row["hex(value)"];
    if (ARTIFACT_VALUE_ALLOWLIST.some((re) => re.test(row.key))) {
      kept.push(row);
      continue;
    }
    redacted.push(row.key);
    kept.push({
      key: row.key,
      hexval: null,
      redacted: true,
      /* Bytes, not characters: the value is a BLOB and may be UTF-16LE. Two hex
         digits per byte, and an odd-length string means a truncated read, which
         is worth seeing rather than rounding away. */
      value_bytes: typeof hex === "string" ? Math.floor(hex.length / 2) : 0,
    });
  }
  return { rows: kept, redacted };
}

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
      /* REPORTED, because which channel the seam verdict came from is the first
         thing a human needs when reading a `seam-stalls-in-background`: the console
         channel carries many mid-run snapshots of the same run, so `pickSeam` has
         more work to do there than over the single localStorage record. */
      seam: (fromDump.seams ?? []).length
        ? "localStorage"
        : fromConsole.seams.length
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
        "#16 step 6.2 still needs doing.",
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
      "about. HUMAN-ACTIONS.md #18 stays open.",
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
        "HUMAN-ACTIONS.md #11 and #16 step 6.4 still need a device.",
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
 * (`audibleActivityClearDelay` — MEASURED at 5 s in run 32036295743, not the 10 s
 *  this comment used to say; that is WebKit's foreground-assertion release) and then
 *  fails on the next one, once the
 * page has been silent long enough for the assertion to lapse — which is exactly
 * the risk `docs/research/mp1-background-audio.md` names and leaves unmeasured.
 */
export const MIN_HIDDEN_TRANSITIONS = 2;

/**
 * A beat observed below this did not happen.
 *
 * ADDED AFTER A REVIEW DEFEATED THIS SUITE IN ONE EDIT. Passing
 * `seamGapSec: 0.05` to the `PlayerQueueManager` in the probe collapsed the 2.0 s
 * beat — the throttled `setTimeout` that is the entire stated reason this phase
 * exists — to 50 ms, and every test stayed green while the verdict still printed
 * "the beat ran". That is the same shape as a guard suite in this repo that passed
 * with the stopping mechanism removed.
 *
 * A unit test can forbid that one spelling; only a floor on the OBSERVED number
 * makes the class of edit visible. It also catches a real bug with no edit at all:
 * if `seamGapSec()` decides a transition is not a seam (an unbounded item on either
 * side, a user-driven advance) the gap is 0 by design, and a 0 ms "beat" must not be
 * reported as the 2.0 s one surviving backgrounding.
 */
export const SEAM_MIN_PLAUSIBLE_MS = 500;

/**
 * The least backgrounded time either direction of this verdict needs.
 *
 * Sibling of `MIN_HIDDEN_PLAYBACK_SEC`, and it applies BOTH ways, which is the
 * part worth stating: a pass needs the first boundary to land at least this far
 * into the hidden window, and a STALL needs us to have waited at least this long,
 * hidden, with nothing audible. Without the second half a 0.3 s hidden window with
 * an open transition would be reported as the silence defect — the same overclaim
 * shape as the 0.446 s `fires-in-background` this repo already shipped once, just
 * pointing the other way.
 */
export const MIN_HIDDEN_WINDOW_SEC = 5;

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
  /* THE SCORE HAS TO BE MONOTONE IN PROGRESS, and the first version was not — a
     review caught it and it would have produced a confident FALSE
     `seam-stalls-in-background`.
     The seam probe saves a fresh snapshot every few seconds, so the console channel
     carries MANY copies of one run at different stages. A score that saturates as
     soon as the first transition is pushed ties every later snapshot, and
     `Array.sort` is stable, so the EARLIEST saturating snapshot won — which is
     exactly the one written just after a boundary, with the transition still open.
     A completed run then reads as a stall.
     `pickOutPoint` does not have this problem because its terms (`stoppedAtSec`,
     `stoppedWhileBackgrounded`) only appear at the END of a run. So this adds terms
     that keep rising: closed hidden transitions, then `lastSavedAtWall` as the
     tie-break. The backgrounded term still dominates everything, because a
     foreground run cannot answer the question however complete it looks — that part
     of `pickOutPoint`'s lesson stands. */
  const closedHidden = (r) =>
    (Array.isArray(r?.transitions) ? r.transitions : []).filter(
      (t) => t && t.hiddenAtBoundary === true && typeof t.nextPlayingAtWall === "number"
    ).length;
  const score = (r) =>
    (r?.backgroundedAtWall != null ? 1000 : 0) +
    (Array.isArray(r?.transitions) && r.transitions.length ? 100 : 0) +
    (Array.isArray(r?.items) && r.items.length > 1 ? 50 : 0) +
    closedHidden(r) * 10 +
    /* Penalties deliberately SMALLER than the progress terms can add up to (170).
       A confirmation pass caught the first version weighting these at -400/-200,
       which made an errored-but-complete record lose to an EMPTY clean one — both
       inconclusive, so no false pass, but the report then quotes "no seam was
       reached" instead of the error that explains why. */
    (r?.autoplayBlocked ? -40 : 0) +
    (r?.error ? -20 : 0);
  return [...records].sort(
    (a, b) => score(b) - score(a) || (num(b?.lastSavedAtWall) ?? 0) - (num(a?.lastSavedAtWall) ?? 0)
  )[0];
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
  const resumed = num(probe.resumedAtWall);
  const transitions = Array.isArray(probe.transitions) ? probe.transitions : [];
  const items = Array.isArray(probe.items) ? probe.items : [];

  /* HIDDEN THROUGHOUT, CHECKED TWO WAYS. The page's own `document.hidden` reading
     at each edge, AND the wall clock against the backgrounded/resumed stamps. Both,
     because the first is a signal from the process under suspicion and the second
     cannot see a brief visibility blip. A transition only counts if both agree —
     and if it carries an actual beat measurement, because a completed transition
     with no `observedGapMs` is a transition whose central number is missing. */
  const isHidden = (t) =>
    t &&
    t.hiddenAtBoundary === true &&
    t.hiddenAtNextPlaying === true &&
    num(t.boundaryAtWall) != null &&
    t.boundaryAtWall >= bg &&
    num(t.nextPlayingAtWall) != null &&
    num(t.observedGapMs) != null &&
    /* POSITIVELY `outPoint`, not merely "not something else". A confirmation pass
       pointed out that the explicit guard below fails OPEN on an absent field, which
       is the same shape as the finding it was added for: a record that does not
       SUPPORT the headline must not be counted toward it. */
    t.endReason === "outPoint" &&
    (resumed == null || t.nextPlayingAtWall < resumed);

  const attemptedHidden = transitions.filter(
    (t) => t && num(t.boundaryAtWall) != null && t.boundaryAtWall >= bg && t.hiddenAtBoundary === true
  );
  const completedHidden = transitions.filter(isHidden);
  const stalled = attemptedHidden.filter((t) => num(t.nextPlayingAtWall) == null);

  const lastSeenWall = num(probe.lastSavedAtWall) ?? num(probe.startedAtWall) ?? bg;
  const gaps = completedHidden.map((t) => num(t.observedGapMs)).filter((n) => n != null);
  const worstGap = gaps.length ? Math.max(...gaps) : null;
  const bestGap = gaps.length ? Math.min(...gaps) : null;
  const asked = num(probe.askedGapMs) ?? SEAM_ASKED_MS;
  const timerMedian = medianMs(probe.timerIntervalsMs);
  const firstHiddenBoundary = attemptedHidden.length ? num(attemptedHidden[0].boundaryAtWall) : null;

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

  /* ── FOUR THINGS THAT INVALIDATE THE RECORD AS EVIDENCE FOR A PASS. Each was a
     way the first version of this function returned `seam-crosses-in-background`
     from data contradicting the sentence it printed; a review found them by calling
     it. They are COLLECTED here rather than returned here — see the stall check
     below, and the regression note on it. ── */
  const caveats = [];

  /* 1. THE BOUNDARY MUST BE WHAT ENDED THE SEGMENT. `html-audio-backend.js` reports
        the same `onItemEnded` for a finished FILE as for a boundary, deliberately —
        the manager must not be able to tell them apart. Here they are opposite
        results: a tone that simply ran out produces a beautiful transition that
        measures the length of the tone. `outPointVerdict` has this exact check and
        its comment is the reason — "the tone against the window is a margin, not a
        check, so this is the check". */
  const wrongReason = attemptedHidden.find((t) => t.endReason !== "outPoint");
  if (wrongReason) {
    caveats.push(
      `a segment ended with reason ${JSON.stringify(wrongReason.endReason ?? null)} rather than at ` +
        `its out-point, so an audio file probably ran out first — lengthen the tones in ` +
        `tools/mobile/probe/install-probe.mjs`
    );
  }

  /* 2. THE ARM MUST HAVE HAPPENED WHILE HIDDEN. Anything but `true` means the probe's
        70 s fallback fired instead of the `visibilitychange` path — the app was not
        backgrounded in time and the boundary was set on wall clock, which is exactly
        the race that produced two contradictory verdicts from identical code.
        `!== true` rather than `=== false`, because a guard that fails open on a
        missing field is the same defect as not having it. */
  if (probe.armedWhileHidden !== true) {
    caveats.push(
      `the boundary was not recorded as armed while hidden (\`armedWhileHidden\` = ` +
        `${JSON.stringify(probe.armedWhileHidden ?? null)}), so it was set on wall clock rather than ` +
        `relative to the page going hidden — a race, not a measurement`
    );
  }

  /* 3. THE NEXT SEGMENT MUST ACTUALLY BE A DIFFERENT FILE, AND WE MUST KNOW WHICH.
        The pass headline claims "a different episode loaded", and nothing checked it.
        `html-audio-backend.js` turns a same-URL load into a seek with no refetch, so
        a queue that repeats a file measures a buffered seek and reports a load. Read
        off the recorded `src`, so the property is MEASURED rather than asserted by a
        unit test over the queue literal — which a review defeated in one edit. */
  const sameFile = [];
  const missingSrc = [];
  for (let i = 1; i < items.length; i++) {
    const prev = String(items[i - 1]?.src ?? "");
    const cur = String(items[i]?.src ?? "");
    if (!prev || !cur) missingSrc.push(items[i]?.id ?? `item-${i}`);
    else if (prev === cur) sameFile.push(`${items[i - 1].id} -> ${items[i].id} (${cur})`);
  }
  if (sameFile.length) {
    caveats.push(
      `a transition re-used the SAME audio file (${sameFile.join(", ")}), so no fresh media load ` +
        `was exercised — that is \`html-audio-backend.js\`'s same-source seek shortcut, the one path ` +
        `this measurement must not take`
    );
  }
  if (missingSrc.length) {
    caveats.push(
      `no source filename was recorded for ${missingSrc.join(", ")}, so "a different episode loaded" ` +
        `cannot be checked at all`
    );
  }

  /* 4. THE BEAT UNDER TEST MUST BE THE SHIPPED BEAT. `askedGapMs` is read off
        `manager.seamGapSec` by the probe, so this catches an override applied AFTER
        construction — which the unit test over the options literal cannot see. */
  if (asked !== SEAM_ASKED_MS) {
    caveats.push(
      `the beat under test was ${asked} ms, not the ${SEAM_ASKED_MS} ms \`player/seam-gap.js\` ` +
        `defines, so whatever this run measured is not the shipped seam`
    );
  }

  /* THE FAILURE, FIRST — AND IT IS REPORTED EVEN WHEN A CAVEAT APPLIES.
     A confirmation pass caught the first version of these guards sitting BEFORE this
     check and downgrading a genuine stall to `inconclusive`, whose detail then said
     "nothing is known about backgrounding from this run" — which is false: an advance
     failed while hidden, and that is the finding that changes what gets built. A
     caveat weakens a PASS; it cannot un-observe a segment that ended and was never
     followed. So the caveats ride along in the detail instead of replacing it.

     It still needs its own floor. See MIN_HIDDEN_WINDOW_SEC: a transition still open
     after 0.3 s of hidden waiting is not the silence defect, it is a run that ended
     too early, and reporting it as the defect is the same overclaim shape as the
     0.446 s pass this repo already shipped once. */
  const caveatNote = caveats.length
    ? ` CAVEATS ON THIS RUN: ${caveats.join("; ")}.`
    : "";
  if (stalled.length && (lastSeenWall - stalled[0].boundaryAtWall) / 1000 < MIN_HIDDEN_WINDOW_SEC) {
    const waited = (lastSeenWall - stalled[0].boundaryAtWall) / 1000;
    return {
      verdict: "hidden-window-too-short",
      headline:
        `A transition was still open when the record was last written — but only ` +
        `${waited.toFixed(1)}s after its boundary, which is not long enough to call it a stall.`,
      detail:
        `${base} Below the ${MIN_HIDDEN_WINDOW_SEC}s floor this workflow requires in either ` +
        `direction. The run probably ended (or the app was killed) mid-transition rather than the ` +
        `transition failing. Last stage reached: ${JSON.stringify(stalled[0].lastStage ?? "unreported")}.` +
        caveatNote,
      completedHiddenTransitions: completedHidden.length,
      worstGapMs: worstGap,
    };
  }
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
        `LOAD_SETTLE_TIMEOUT_MS. Something native would have to own the transition (#28).` +
        caveatNote,
      completedHiddenTransitions: completedHidden.length,
      worstGapMs: worstGap,
    };
  }
  /* NO STALL, so a caveat now decides: the record cannot support a pass, and saying
     which of the four things is wrong is more useful than any band it would land in. */
  if (caveats.length) {
    return {
      verdict: "inconclusive",
      headline: `This run cannot support a seam verdict: ${caveats[0]}.`,
      detail: `${base}${caveatNote}`,
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
  /* THE FIRST BOUNDARY HAS TO LAND INSIDE THE HIDDEN WINDOW, not on its edge. Same
     floor as the stall direction, and the same reason: a boundary crossed 0.4 s
     after the page went hidden measures the harness, not backgrounding. */
  if (firstHiddenBoundary != null && (firstHiddenBoundary - bg) / 1000 < MIN_HIDDEN_WINDOW_SEC) {
    return {
      verdict: "hidden-window-too-short",
      headline:
        `The first boundary fired only ${((firstHiddenBoundary - bg) / 1000).toFixed(1)}s after the ` +
        `app went into the background, which is not a measurement of backgrounding.`,
      detail:
        `${base} Below the ${MIN_HIDDEN_WINDOW_SEC}s floor this workflow requires. The probe arms ` +
        `15 s after the page goes hidden precisely so a healthy run clears it by 3x; landing here ` +
        `means the arm did not happen as designed.`,
      completedHiddenTransitions: completedHidden.length,
      worstGapMs: worstGap,
    };
  }
  /* A BEAT THAT DID NOT HAPPEN IS NOT A BEAT THAT SURVIVED. See
     SEAM_MIN_PLAUSIBLE_MS: this catches both a `seamGapSec` override in the probe
     (which defeated every test in this suite in one edit) and the real case where
     `seamGapSec()` legitimately returns 0 because the transition is not a seam. */
  if (bestGap != null && bestGap < SEAM_MIN_PLAUSIBLE_MS) {
    return {
      verdict: "inconclusive",
      headline:
        `A transition completed in ${Math.round(bestGap)} ms against a ${asked} ms beat — that is ` +
        `not the 2.0 s beat running, it is the beat not happening.`,
      detail:
        `${base} Either the manager was handed a shorter \`seamGapSec\` than ` +
        `\`player/seam-gap.js\` defines, or \`seamGapSec()\` ruled this transition not a seam at all ` +
        `(an unbounded item on one side, or a user-driven advance). Both make the number meaningless ` +
        `as an answer to "does the beat survive backgrounding".`,
      completedHiddenTransitions: completedHidden.length,
      worstGapMs: worstGap,
    };
  }
  /* AND THE ITEMS HAVE TO ADD UP. N completed transitions require N+1 items to have
     become audible; anything less means the record is describing transitions whose
     endpoints were never observed. Cheap, and it is the kind of internal
     contradiction a confident verdict should never print over. */
  if (items.length < completedHidden.length + 1) {
    return {
      verdict: "inconclusive",
      headline:
        `The record is internally inconsistent: ${completedHidden.length} completed transition(s) ` +
        `but only ${items.length} item(s) ever became audible.`,
      detail: `${base} N transitions need N+1 audible items. Read the probe's telemetry.`,
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

/* ───────────────────────────────────────────────────────────────────────────────
 * WHERE THE RECORD STOPS — AND WHETHER THE AUDIO STOPPED WITH IT
 *
 * THE QUESTION, AND WHY IT NEEDED A THIRD CHANNEL. Every seam run so far produces a
 * `foray_probe_seam` record that ends 25-28 s after the app went hidden with most of
 * the window unused, and two incompatible stories fit that artifact exactly:
 *
 *   (a) a CEILING — the platform suspends a hidden WebView after ~28 s whatever it
 *       is doing, in which case a Foray stops advancing half a minute after the
 *       screen locks and the shell is the wrong architecture;
 *   (b) ORDINARY BEHAVIOUR — the probe's own audio stopped (its first boundary, or a
 *       short fixture running out), WebKit released the assertions that follow from
 *       audio, and suspension came after as designed. Harmless, and the ~28 s is an
 *       artifact of the probe.
 *
 * `saveSeq` + `lastSavedAtWall` cannot separate them and `probe-seam.js` says so in
 * its own comment: both stamps ride in the same `setItem` blob, so a page cannot
 * record that its own later write failed to land. Two channels that do NOT depend on
 * the page's writes can, and this section reads both:
 *
 *   1. `saveTrail`, IN the record: one stamp per save carrying the WALL clock and
 *      the MEDIA clock together. Different machinery drives them — `Date.now()`
 *      needs the page scheduled, `currentTime` needs the audio pipeline running — so
 *      a gap between two stamps says the page was frozen AND RESUMED, and the media
 *      delta across that gap says whether the audio kept flowing through it.
 *   2. `simulator-log-seam.txt`, OUTSIDE the record: WebKit's own lifecycle lines and
 *      the media element's position, written by a different process to a different
 *      file. This is the only channel that can see anything after the last write
 *      reached disk, and on run 32064639785 it saw 35 s of it.
 *
 * WHAT THIS IS NOT. Parsing another project's debug log is inherently brittle — the
 * strings below are WebKit internals and a runner-image bump can rename any of them.
 * So every function here degrades to "no coverage" rather than to a confident wrong
 * number, the verdict states which channel carried it, and the in-record half stands
 * on its own when the log half finds nothing.
 * ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Twice the probe's 2 s save interval, so a gap has to be a real stall.
 *
 * Not tighter: a save is also triggered by every stage and telemetry line, so the
 * cadence is 2 s at its SLOWEST, and the interval timer is itself aligned to
 * ~1000 ms while hidden (measured, run 32026332637). 3 s would flag ordinary jitter
 * as a freeze, which is the failure mode this whole section exists to avoid.
 */
export const SAVE_TRAIL_GAP_MS = 4000;

/**
 * How much of a gap's wall time the media clock has to cover before the audio counts
 * as having flowed through it. 0.5 = half.
 *
 * A THRESHOLD RATHER THAN AN EQUALITY, because `currentTime` is sampled by the page
 * and the page is the thing that was frozen: the stamp after a freeze is taken
 * whenever the page next runs, so the media delta it reports is bounded by the gap
 * but not equal to it. Run 32064639785's own numbers are the calibration — the
 * element advanced 19.1 media seconds across 26.9 s of wall clock spanning a
 * suspension, i.e. 71%, which is neither "stopped" nor "unaffected".
 */
export const AUDIO_FLOWED_RATIO = 0.5;

/**
 * How close to the end of the observed window the last write has to land before the
 * record counts as covering it.
 *
 * 8 s: the probe saves every 2 s, the collection path waits 3 s for WebKit to flush,
 * and the hidden save interval is itself aligned to ~1000 ms. Four save intervals is
 * slack for all of that without being wide enough to absorb the 25-28 s shortfall
 * this section exists to explain.
 */
export const RECORD_TAIL_TOLERANCE_SEC = 8;

/**
 * The record's own account of when it stopped and what the audio was doing.
 *
 * Pure over the record — no log, no clock — so it works on every artifact ever
 * uploaded, including the three that predate `saveTrail` (they land in `stamps: 0`
 * with every derived field null, which is the honest answer for them).
 *
 * @param {object|null} seam the `foray_probe_seam` record
 */
export function saveTrailAnalysis(seam) {
  const trail = Array.isArray(seam?.saveTrail) ? seam.saveTrail : [];
  const stamps = trail.filter((s) => s && num(s.wall) != null && num(s.seq) != null);
  const bg = num(seam?.backgroundedAtWall);
  const out = {
    stamps: stamps.length,
    /** Seconds from the app going hidden to the last stamp, which is the number the
     *  ceiling reading is about. */
    lastStampHiddenSec: null,
    /** Was the element paused at the last stamp the page managed to write? */
    pausedAtLastStamp: null,
    mediaSecAtLastStamp: null,
    /** Every wall gap wider than `SAVE_TRAIL_GAP_MS`, with the media clock across
     *  it. A non-empty list is proof the page was frozen and CAME BACK. */
    gaps: [],
    /** The widest gap's seconds, or null. */
    worstGapSec: null,
    /** How much media time the element covered per second of hidden wall clock. ~1
     *  while playing, ~0 while paused, and a number in between when it was
     *  interrupted. */
    hiddenMediaRatio: null,
    /** The probe caps the trail (`SAVE_TRAIL_MAX`); `saveSeq` keeps counting.
     *
     *  REPORTED, because a capped trail and a stopped one look identical in the
     *  array and mean opposite things. Every number derived from the trail — the
     *  gaps, the ratio — then describes the EARLY part of the window only, and a
     *  reader who took the last stamp for the record's end would land on exactly the
     *  wrong conclusion. `recordEndsAtHiddenSec` deliberately comes from
     *  `lastSavedAtWall` rather than from this trail for the same reason. */
    truncated: false,
  };
  if (!stamps.length) return out;
  const seq = num(seam?.saveSeq);
  out.truncated = seq != null && stamps.length < seq;
  const last = stamps[stamps.length - 1];
  if (bg != null) out.lastStampHiddenSec = (last.wall - bg) / 1000;
  out.pausedAtLastStamp = typeof last.paused === "boolean" ? last.paused : null;
  out.mediaSecAtLastStamp = num(last.mediaSec);

  for (let i = 1; i < stamps.length; i++) {
    const a = stamps[i - 1];
    const b = stamps[i];
    const gapMs = b.wall - a.wall;
    if (gapMs < SAVE_TRAIL_GAP_MS) continue;
    const mediaA = num(a.mediaSec);
    const mediaB = num(b.mediaSec);
    /* A media delta is only meaningful if BOTH ends have one and the clock did not go
       BACKWARDS — a cross-file load resets `currentTime` to the next item's
       `start_sec`, which would read as a negative delta. A null here is reported as
       null, not as 0: "we cannot tell" and "the audio stopped" are different
       findings, and this section exists because they were conflated once. */
    const mediaAdvancedSec = mediaA == null || mediaB == null || mediaB < mediaA ? null : mediaB - mediaA;
    out.gaps.push({
      afterSeq: a.seq,
      atHiddenSec: bg == null ? null : (a.wall - bg) / 1000,
      gapSec: gapMs / 1000,
      mediaAdvancedSec,
      audioFlowed: mediaAdvancedSec == null ? null : mediaAdvancedSec >= (gapMs / 1000) * AUDIO_FLOWED_RATIO,
    });
  }
  if (out.gaps.length) out.worstGapSec = Math.max(...out.gaps.map((g) => g.gapSec));

  if (bg != null) {
    const hidden = stamps.filter((s) => s.wall >= bg && num(s.mediaSec) != null);
    if (hidden.length >= 2) {
      const wallSec = (hidden[hidden.length - 1].wall - hidden[0].wall) / 1000;
      /* Summed per step, NOT end to end: a cross-file load resets `currentTime`, so
         an end-to-end difference across a seam can be negative and would report a
         playing page as a stopped one. Negative steps are dropped rather than
         subtracted. */
      let mediaSec = 0;
      for (let i = 1; i < hidden.length; i++) {
        const d = hidden[i].mediaSec - hidden[i - 1].mediaSec;
        if (d > 0) mediaSec += d;
      }
      if (wallSec > 0) out.hiddenMediaRatio = mediaSec / wallSec;
    }
  }
  return out;
}

/** The lines this parser knows how to read, as `[kind, needle]`.
 *
 *  SUBSTRINGS, CHECKED WITH `includes`, NOT REGEXES OVER 20 MB. The first version of
 *  the reporting step spent >7 minutes on a counted-context `grep -o` over a system
 *  log (`docs/ios-ci.md` §4d); a per-line `includes` prefilter is the same lesson
 *  applied in JavaScript. Every needle below was copied out of a real
 *  `simulator-log-seam.txt` rather than from WebKit's source, so what is matched is
 *  what this runner image actually emits.
 *
 *  ONE LIMIT WORTH STATING RATHER THAN DISCOVERING. `didChangeThrottleState(Suspended)`
 *  carries a `[PID=…]` for the process it is about, and WebKit runs three (WebContent,
 *  Networking, GPU). This parser does not resolve which PID is the WebContent process —
 *  nothing in the log names it as such — so in principle a GPU-process suspension could
 *  be read as the page being descheduled. In every run so far these lines have all been
 *  the WebContent process's and `applicationIsAboutToSuspend`, which is app-wide and
 *  unambiguous, has followed within a second. If a future run reports a suspension that
 *  the record and the media clock both contradict, this is the first thing to check. */
const LIFECYCLE_NEEDLES = [
  ["suspended", "didChangeThrottleState(Suspended)"],
  ["about-to-suspend", "applicationIsAboutToSuspend"],
  ["background", "didChangeThrottleState(Background)"],
  ["foreground", "didChangeThrottleState(Foreground)"],
  ["assertion-expiring", "uiAssertionWillExpireImminently"],
  ["resumed", "processDidResume"],
  ["audible-clear-armed", "Starting timer to clear audible activity"],
  ["audible-activity-cleared", "clearAudibleActivity"],
  ["foreground-release-armed", "starting timer to release a foreground assertion"],
  ["media-assertion-denied", "Failed to acquire RBS assertion 'WebKit Media Playback'"],
  ["media-playback-assertion-taken", "Taking MediaPlayback assertion"],
];

/** `2026-08-17 20:24:22.451 Df App[...]` -> epoch ms, or null.
 *
 *  UTC, WHICH IS AN ASSUMPTION AND IS TREATED AS ONE. `log stream` prints the
 *  simulator's local time with no zone, and a GitHub runner is UTC — so these line up
 *  with the record's `Date.now()` today, and would be hours out on a runner that was
 *  not. `parseSimulatorLifecycle` therefore reports the span it parsed and
 *  `suspensionVerdict` refuses to use it unless it OVERLAPS the record's own hidden
 *  window. A silently wrong offset is the one failure that could turn this channel
 *  into a confident lie. */
function parseLogWall(line) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/.exec(line);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  return Number.isFinite(t) ? t : null;
}

/**
 * The out-of-band channel: WebKit's lifecycle events and the media element's own
 * position, read out of a captured simulator log.
 *
 * @param {string|null} text the contents of `simulator-log-seam.txt`
 */
export function parseSimulatorLifecycle(text) {
  const out = { lines: 0, timestamped: 0, firstWall: null, lastWall: null, events: [], media: [] };
  if (typeof text !== "string" || !text) return out;
  const lines = text.split("\n");
  out.lines = lines.length;
  for (const line of lines) {
    const wall = parseLogWall(line);
    if (wall == null) continue;
    out.timestamped++;
    if (out.firstWall == null) out.firstWall = wall;
    out.lastWall = wall;
    if (line.includes("updateNowPlayingInfo")) {
      /* The media clock, from a process that is not ours, into a file the page cannot
         write. `isPlaying` and `now` are the two fields that matter; `duration`
         identifies WHICH tone, since the probe's three files differ in length. */
      const m = /isPlaying = (true|false), duration = ([0-9.]+), now = ([0-9.]+)/.exec(line);
      if (m) {
        out.media.push({
          wall,
          isPlaying: m[1] === "true",
          durationSec: Number(m[2]),
          positionSec: Number(m[3]),
        });
        continue;
      }
    }
    for (const [kind, needle] of LIFECYCLE_NEEDLES) {
      if (line.includes(needle)) {
        out.events.push({ wall, kind });
        break;
      }
    }
  }
  return out;
}

/**
 * (a) or (b): why does the record stop, and was audio still flowing when it did?
 *
 * ── HOW EACH VERDICT IS EARNED ───────────────────────────────────────────────
 *
 * `record-covers-window`      the last save lands within `RECORD_TAIL_TOLERANCE_SEC`
 *                             of the last thing observed at all, with no suspension.
 *                             Whatever the ~28 s figure was, it was not a ceiling on
 *                             hidden time on THIS run.
 * `suspended-while-audible`   a suspension inside the hidden window with the audio
 *                             still playing at that moment. This is reading (a), the
 *                             one that would change the architecture — so it needs
 *                             POSITIVE evidence of audio from a channel, never merely
 *                             the absence of a pause.
 * `suspended-after-audio-stopped`
 *                             a suspension whose preceding audio had already stopped.
 *                             Reading (b), with the lead time reported.
 * `suspended-audio-unknown`   a suspension neither channel can pair with an audio
 *                             state. Refused rather than resolved.
 * `record-ends-early-no-log`  the record stops early and no log covered the window,
 *                             which is exactly where the first three runs sat. The
 *                             in-record numbers are still reported.
 * `record-ends-early-no-suspension`
 *                             the process outlived the last write with no suspension
 *                             anywhere: the write path is the suspect, which is a
 *                             harness defect rather than a product one.
 * `inconclusive`              no record, or the app never went hidden.
 *
 * THE ONE THING IT WILL NOT DO is prefer a tidy answer. If the log's timestamps do
 * not overlap the record's hidden window the log is discarded entirely, because an
 * unaligned clock would place a suspension inside a window it was never in.
 *
 * @param {{seam: object|null, lifecycle: object|null}} input
 */
export function suspensionVerdict({ seam, lifecycle } = {}) {
  const trail = saveTrailAnalysis(seam ?? null);
  const bg = num(seam?.backgroundedAtWall);
  const lastSaved = num(seam?.lastSavedAtWall);
  const base = {
    trail,
    recordEndsAtHiddenSec: null,
    audioAdvancedAfterRecordSec: null,
    /** Only a suspension can have one, but the KEY exists on every return so a caller
     *  reading it gets `null` rather than `undefined` and cannot tell "no timer" apart
     *  from "no suspension" by accident. */
    releaseArmedBeforeSuspensionSec: null,
    channels: [],
  };
  if (!seam || typeof seam !== "object" || bg == null || lastSaved == null) {
    return {
      ...base,
      verdict: "inconclusive",
      headline: "No hidden window was recorded, so there is nothing to say about where the record stops.",
      detail:
        "This needs a `foray_probe_seam` record carrying `backgroundedAtWall` and `lastSavedAtWall`. " +
        "Read the seam verdict above first — it says why the run produced no such record.",
    };
  }
  const recordEndsAtHiddenSec = (lastSaved - bg) / 1000;
  base.recordEndsAtHiddenSec = recordEndsAtHiddenSec;
  base.channels.push("record");

  /* THE LOG IS ONLY ADMITTED IF IT OVERLAPS THE HIDDEN WINDOW. See `parseLogWall`. */
  const lf = lifecycle && Array.isArray(lifecycle.events) ? lifecycle : null;
  const aligned =
    lf != null &&
    num(lf.firstWall) != null &&
    num(lf.lastWall) != null &&
    lf.lastWall >= bg &&
    lf.firstWall <= lastSaved + 60_000;
  const events = aligned ? lf.events.filter((e) => e.wall >= bg) : [];
  const media = aligned ? lf.media.filter((m) => m.wall >= bg) : [];
  if (aligned) base.channels.push("simulator-log");

  /* WAS AUDIO STILL FLOWING AFTER THE RECORD ENDED? The strongest single number here,
     because it is measured entirely outside the page: how far the element's own
     position moved after the last write the page managed to persist. Summed per step
     and only upwards, for the same reason `saveTrailAnalysis` does it — a load resets
     the clock. */
  const after = media.filter((m) => m.wall > lastSaved + 250);
  if (after.length) {
    const beforeEnd = media.filter((m) => m.wall <= lastSaved + 250);
    let prev = (beforeEnd.length ? beforeEnd[beforeEnd.length - 1] : after[0]).positionSec;
    let advance = 0;
    for (const m of after) {
      if (m.positionSec > prev) advance += m.positionSec - prev;
      prev = m.positionSec;
    }
    base.audioAdvancedAfterRecordSec = advance;
  }

  const suspensions = events.filter((e) => e.kind === "suspended" || e.kind === "about-to-suspend");
  const lastObservedWall = Math.max(
    lastSaved,
    aligned ? lf.lastWall : lastSaved,
    media.length ? media[media.length - 1].wall : lastSaved
  );
  const windowObservedSec = (lastObservedWall - bg) / 1000;

  const numbers =
    `The record's last durable write lands ${recordEndsAtHiddenSec.toFixed(2)}s into the hidden window ` +
    `(save #${num(seam.saveSeq) ?? "?"}` +
    (trail.stamps ? `, ${trail.stamps} trail stamps` : ", no save trail — a record from before it existed") +
    `). ` +
    (trail.truncated
      ? `THE TRAIL IS CAPPED at ${trail.stamps} of ${num(seam.saveSeq)} saves, so every trail-derived ` +
        `number below describes the EARLY part of the window only and a gap after the cap is invisible. ` +
        `The stop time above is not affected — it comes from \`lastSavedAtWall\`. `
      : "") +
    (trail.pausedAtLastStamp == null
      ? ""
      : `At that last stamp the element was ${trail.pausedAtLastStamp ? "PAUSED" : "PLAYING"}` +
        (trail.mediaSecAtLastStamp == null ? "" : ` at ${trail.mediaSecAtLastStamp.toFixed(2)}s of its file`) +
        `. `) +
    (trail.hiddenMediaRatio == null
      ? ""
      : `Media time covered ${(trail.hiddenMediaRatio * 100).toFixed(0)}% of hidden wall clock across ` +
        `the trail. `) +
    (trail.gaps.length
      ? `The trail has ${trail.gaps.length} gap(s) wider than ${SAVE_TRAIL_GAP_MS / 1000}s — so the page ` +
        `was frozen AND RESUMED at least that many times — worst ${trail.worstGapSec.toFixed(1)}s: ` +
        trail.gaps
          .map(
            (g) =>
              `after save #${g.afterSeq}` +
              (g.atHiddenSec == null ? "" : ` at +${g.atHiddenSec.toFixed(1)}s`) +
              `, ${g.gapSec.toFixed(1)}s with ` +
              (g.mediaAdvancedSec == null
                ? "no comparable media clock"
                : `${g.mediaAdvancedSec.toFixed(1)}s of media (audio ` +
                  `${g.audioFlowed ? "KEPT FLOWING" : "stalled too"})`)
          )
          .join("; ") +
        ". "
      : "") +
    (base.audioAdvancedAfterRecordSec == null
      ? ""
      : `AFTER the record ends, the simulator log's own media clock advances ` +
        `${base.audioAdvancedAfterRecordSec.toFixed(1)}s — audio the page never got to write down. `) +
    (aligned
      ? `Log channel: ${lf.timestamped} timestamped line(s), ${events.length} lifecycle event(s) inside ` +
        `the hidden window, ${media.length} media-clock sample(s), covering ` +
        `${windowObservedSec.toFixed(1)}s of it.`
      : `No usable log channel: ${
          lf == null ? "no log was parsed" : "its timestamps do not overlap the record's hidden window"
        }, so nothing outside the page corroborates any of the above.`);

  if (!aligned) {
    return {
      ...base,
      verdict: "record-ends-early-no-log",
      headline:
        `The record stops ${recordEndsAtHiddenSec.toFixed(1)}s into the hidden window and no log covered ` +
        `that window, so WHY it stops is unknown.`,
      detail:
        `${numbers} This is exactly where runs 32036295743, 32057395270 and 32064639785 sat. The two ` +
        `readings — the page was suspended, or its writes stopped landing — have opposite consequences, ` +
        `and only a channel outside the page can choose between them.`,
    };
  }

  if (suspensions.length) {
    const s = suspensions[0];
    const mediaBefore = media.filter((m) => m.wall <= s.wall);
    const lastBefore = mediaBefore.length ? mediaBefore[mediaBefore.length - 1] : null;
    const trailStamp = (Array.isArray(seam.saveTrail) ? seam.saveTrail : [])
      .filter((x) => x && num(x.wall) != null && x.wall <= s.wall)
      .pop();
    /* POSITIVE EVIDENCE ONLY, from either channel: the log's own `isPlaying`, or the
       record's own `paused: false`. The absence of a pause is not evidence of play,
       and this is the verdict that would end the WebView shell. */
    const audibleByLog = lastBefore ? lastBefore.isPlaying === true : null;
    const audibleByRecord =
      trailStamp && typeof trailStamp.paused === "boolean" ? trailStamp.paused === false : null;
    /* WHEN THE TWO CHANNELS DISAGREE, THE LOG WINS, and the disagreement is printed.
       `paused` is the page's view of the element and `isPlaying` is the media
       session's view of whether sound is being produced — and the page is the process
       under suspicion here, so a page that believes it is playing while the session
       says otherwise is the case where the page is wrong. Preferring the record would
       be preferring the suspect's own account, in the direction of the verdict that
       changes the architecture. */
    const contested = audibleByLog === false && audibleByRecord === true;
    const audible = audibleByLog === false ? false : audibleByLog === true || audibleByRecord === true;
    /* NEITHER CHANNEL SPOKE. Not "the audio had stopped" — there is a real difference
       between an observed silence and an unobserved one, and the second must not be
       able to wear the first one's headline. */
    const audioUnknown = audibleByLog == null && audibleByRecord == null;
    const atSec = (s.wall - bg) / 1000;
    /* WAS THIS SUSPENSION ALREADY IN MOTION BEFORE THE AUDIO CAME BACK?
       The difference between "suspended regardless of audio" and "suspended by a
       timer armed during an earlier silence, which restarting the audio failed to
       cancel", and the two have different consequences. WebKit arms both timers when
       audio stops (`Starting timer to clear audible activity in 5 seconds`,
       `starting timer to release a foreground assertion in 10 seconds`), and on run
       32064639785 one of them fired 12 s after a 5.1 s beat — WITH the next segment
       audible — because re-acquiring the media-playback assertion is DENIED on a
       Simulator. So a lead time here means the audible-at-suspension observation is
       weaker than it reads, and the discriminating run is one whose audio never
       stopped at all before the suspension. */
    const armed = events
      .filter(
        (e) =>
          (e.kind === "foreground-release-armed" || e.kind === "audible-clear-armed") && e.wall <= s.wall
      )
      .pop();
    const armedLeadSec = armed ? (s.wall - armed.wall) / 1000 : null;
    const denials = events.filter((e) => e.kind === "media-assertion-denied" && e.wall <= s.wall).length;
    base.releaseArmedBeforeSuspensionSec = armedLeadSec;
    const armedNote =
      armedLeadSec == null
        ? ` NO assertion-release timer was armed beforehand in this window, so nothing about our own ` +
          `audio was already counting down when the suspension landed.`
        : ` WEAKER THAN IT READS, AND SAY SO: WebKit armed an assertion-release timer ` +
          `${armedLeadSec.toFixed(1)}s earlier (\`${armed.kind}\`), which it does when audio STOPS — so ` +
          `this suspension was plausibly set in motion by an earlier silence and not cancelled when the ` +
          `audio came back. On this Simulator it cannot be cancelled: re-acquiring 'WebKit Media ` +
          `Playback' was denied ${denials} time(s) in this window for want of an entitlement a real ` +
          `signed app holds. A run whose audio never stops before the suspension is what separates ` +
          `"suspended regardless of audio" from "suspended because of our own beat".`;
    const why =
      `Suspension observed ${atSec.toFixed(2)}s into the hidden window (\`${s.kind}\`).` +
      (audibleByLog == null ? "" : ` The log's last media sample before it says isPlaying=${audibleByLog}.`) +
      (audibleByRecord == null
        ? ""
        : ` The record's last stamp before it says paused=${!audibleByRecord}.`) +
      (contested
        ? ` THOSE TWO DISAGREE, and the log is taken: the page thought it was playing while the media ` +
          `session said it was not, and the page is the process under suspicion.`
        : "");
    if (audible) {
      return {
        ...base,
        verdict: "suspended-while-audible",
        headline:
          `The page was SUSPENDED ${atSec.toFixed(1)}s into the hidden window WITH AUDIO STILL PLAYING — ` +
          `the reading that changes the architecture.`,
        detail:
          `${why}${armedNote} ${numbers} Audio playing and the page suspended anyway means neither the ` +
          `probe's fixtures nor its own boundaries explain it. THE NEXT STEP IS HARDWARE, not more CI: a ` +
          `Simulator app launched by \`simctl\` cannot hold the 'WebKit Media Playback' RBS assertion at ` +
          `all (\`originator doesn't have entitlement com.apple.runningboard.assertions.webkit\`, in this ` +
          `same log), and that assertion is the mechanism \`UIBackgroundModes: audio\` exists to satisfy ` +
          `on a device. HUMAN-ACTIONS.md #11 settles it in twenty minutes with no build.`,
      };
    }
    if (audioUnknown) {
      return {
        ...base,
        verdict: "suspended-audio-unknown",
        headline:
          `The page was suspended ${atSec.toFixed(1)}s into the hidden window, and NOTHING in this run ` +
          `says whether audio was still playing at that moment.`,
        detail:
          `${why}${armedNote} ${numbers} Both channels are silent on the audio: no media-clock sample ` +
          `before the suspension, and no \`paused\` stamp in the record. That is the one combination this ` +
          `verdict refuses to resolve — an unobserved silence must not wear an observed one's headline, ` +
          `because the two readings differ in whether the WebView shell can play a Foray at all.`,
      };
    }
    return {
      ...base,
      verdict: "suspended-after-audio-stopped",
      headline:
        `The page was suspended ${atSec.toFixed(1)}s into the hidden window, AFTER its audio had already ` +
        `stopped — ordinary behaviour, not a ceiling on hidden time.`,
      detail:
        `${why} ${numbers} So the suspension followed OUR silence rather than the clock, and any "the ` +
        `page dies N seconds after going hidden" reading of this run is really "N seconds after the probe ` +
        `stopped making sound". A product Foray is only silent for the beat.`,
    };
  }

  if (windowObservedSec - recordEndsAtHiddenSec < RECORD_TAIL_TOLERANCE_SEC) {
    return {
      ...base,
      verdict: "record-covers-window",
      headline:
        `The record covers the hidden window it was given — last write at ` +
        `${recordEndsAtHiddenSec.toFixed(1)}s of ${windowObservedSec.toFixed(1)}s observed, and no ` +
        `suspension in the log.`,
      detail:
        `${numbers} On this run there was no ceiling on hidden time to find: the page was still being ` +
        `scheduled when the window closed.`,
    };
  }
  return {
    ...base,
    verdict: "record-ends-early-no-suspension",
    headline:
      `The record stops ${recordEndsAtHiddenSec.toFixed(1)}s into a window observed for ` +
      `${windowObservedSec.toFixed(1)}s, and the log shows NO suspension.`,
    detail:
      `${numbers} With the process alive past the last write, the write path is the suspect rather than ` +
      `the scheduler — the opposite conclusion from a suspension, and a harness defect rather than a ` +
      `product one.`,
  };
}

/** THE LIMIT OF THIS MEASUREMENT, carried with every verdict that quotes it.
 *
 *  The next segment's audio is a LOCAL file in the app bundle, so what this
 *  settles is the BEAT'S TIMER and a fresh cross-file media load while hidden. A
 *  cold HTTPS fetch from a podcast host while hidden — DNS, TLS, a range request
 *  into the middle of a 90 MB file — is NOT measured here, and it is the part
 *  `docs/research/mp1-background-audio.md` warns could push the silent window past
 *  WebKit's 10 s audibility grace.
 *
 *  BE PRECISE ABOUT WHY, BECAUSE TWO OF THE THREE REASONS ARE SOFT AND THE THIRD
 *  IS PERMANENT. This wording was sharpened once already, after a review pointed
 *  out that the first draft rested its whole case on the two soft ones:
 *
 *    - `media-src 'self'` on the probe page is a ONE-LINE, ZERO-RISK obstacle. The
 *      probe pages carry their own `<meta>` CSP and `install-probe.mjs` copies them
 *      verbatim, so widening it would touch nothing shipped. Do not cite it as the
 *      reason; it is a fact about our own test fixture.
 *    - Product principle #3's LETTER is satisfied by streaming from the original
 *      enclosure URL. The real objection is load and politeness, which this repo
 *      already ruled on once and wrote down: `tools/foray/verify-source-audio.mjs`
 *      is "MANUAL, NEVER CI ... CI must not go red because a podcast CDN had a bad
 *      afternoon." That is a defensible CHOICE, not a prohibition.
 *    - THE PERMANENT ONE: a `macos-latest` runner is a datacenter IP on a
 *      datacenter link — the fastest network this app will ever see. The risk being
 *      chased is a SLOW cold fetch. So a green cross-origin number from CI would be
 *      a FLOOR, and a floor cannot retire a tail-latency risk. Exactly the
 *      asymmetry `SIMULATOR_CAVEAT` names for power management, and it survives
 *      widening the CSP and proving the runner has egress.
 *
 *  Which is why the fix is not a CI change: instrument `load-started -> canplay`
 *  in the SHIPPED seam path and read a distribution off real networks. See
 *  `docs/ios-ci.md` § "Can this ever measure a cross-origin fetch?". */
export const LOCAL_MEDIA_CAVEAT =
  "The seam's next segment is a LOCAL bundled file, not a podcast CDN fetch, so a cold cross-origin " +
  "fetch while hidden is still unmeasured. This is a PERMANENT limit of measuring here, not a gap to " +
  "close: a CI runner is a datacenter link, which is the fastest network this app will ever see, so " +
  "a green number from it would be a floor and the risk is a SLOW fetch. Only the shipped player on " +
  "real networks can answer it.";

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
  "HUMAN-ACTIONS.md #11/#16 still want one real phone.";

/**
 * The whole report, as markdown for `$GITHUB_STEP_SUMMARY`.
 *
 * `signingState` is passed IN, from the gate step's own output. It used to be
 * recomputed here from `process.env` — but the reporting step is not given the
 * secrets (and must not be), so section 3 read "no signing secrets set" no matter
 * what. It was right only by accident, and would have started lying the day
 * HUMAN-ACTIONS.md #19 was done: the same run would have said `state=ready` at
 * the gate and "not configured" in the summary. A report that cannot observe what
 * it asserts should not assert it.
 */
export function renderReport({ bridge, outPoint, seam, signingState, build, lifecycle }) {
  const b = bridgeVerdict(bridge);
  const o = outPointVerdict(outPoint);
  const s = seamTransitionVerdict(seam ?? null);
  const sus = suspensionVerdict({ seam: seam ?? null, lifecycle: lifecycle ?? null });
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
  /* SECTION 3b, ABOVE THE SIMULATOR CAVEAT AND BELOW THE SEAM, because it BOUNDS the
     seam verdict rather than adding to it: every hidden number in section 3 was taken
     inside a window that three runs ended 25-28 s into, and a `too-few-transitions`
     verdict means something different if the app was not alive to reach transition 2.
     Reported unconditionally, including `inconclusive`, because the silent version of
     this section is what let the shortfall read as a footnote about save cadence. */
  lines.push(
    `### 3b. Where the record STOPS, and whether audio stopped with it — \`${sus.verdict}\``,
    "",
    sus.headline,
    "",
    sus.detail,
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
    "is the designed behaviour — see HUMAN-ACTIONS.md #19.",
  partial:
    "Signing is only half configured, so the job failed on purpose rather than skipping the upload " +
    "on a green run. See HUMAN-ACTIONS.md #19: set all seven secrets or none.",
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
    } else if (cmd === "redact-localstorage") {
      /* In-place, and it must run BEFORE the file reaches the artifact
         directory. Writes the redacted array back over the same path so the
         workflow cannot accidentally upload the pre-redaction copy. */
      if (!rest[0]) throw new Error("redact-localstorage needs a rows.json");
      /* STRICT, and deliberately NOT via `readMaybe`. `readMaybe` swallows a parse
         error and returns null, which would have made this command write `[]`,
         exit 0, and let the workflow publish an empty rows file -- no rows, three
         `inconclusive` verdicts, a GREEN job. That is the exact silent-nothing
         failure the whole collection step is built to avoid, and it would have been
         indistinguishable from a genuinely empty store. A redaction step that
         cannot read its input must fail, not shrug. */
      const text = fs.readFileSync(rest[0], "utf8");
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(
          `redact-localstorage: ${rest[0]} is not valid JSON (${e.message}). ` +
            `sqlite3 wrote ${text.length} byte(s). Refusing to publish a rows file ` +
            `this command could not read.`
        );
      }
      if (!Array.isArray(parsed)) {
        throw new Error(
          `redact-localstorage: ${rest[0]} is ${parsed === null ? "null" : typeof parsed}, ` +
            `not the array \`sqlite3 -json\` produces.`
        );
      }
      if (parsed.length === 0) {
        throw new Error(
          `redact-localstorage: ${rest[0]} holds zero rows. A local-storage database ` +
            `the app has written to is never empty, so this is a failed read, not an ` +
            `empty store -- and publishing it would report "measured nothing" on a green job.`
        );
      }
      const { rows, redacted } = redactLocalStorageRows(parsed);
      fs.writeFileSync(rest[0], JSON.stringify(rows, null, 2) + "\n");
      console.error(
        `redacted ${redacted.length} value(s) from ${rest[0]}` +
          (redacted.length ? `: ${redacted.join(", ")}` : "")
      );
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
      /* THE SEAM PASS'S SYSTEM LOG, THE ONLY CHANNEL THAT OUTLIVES THE RECORD.
         Defaulted from the localStorage dump's own directory rather than demanded as
         an argument, deliberately: `.github/workflows/ios-build.yml` is a GOVERNED
         file, so a reporter that needed a new argv would need a founder label to
         land, and this analysis is worth more than that ceremony. An explicit third
         argument still wins if someone passes one. */
      const seamLogPath =
        rest[2] || (rest[0] ? path.join(path.dirname(path.resolve(rest[0])), "simulator-log-seam.txt") : null);
      const lifecycle =
        seamLogPath && fs.existsSync(seamLogPath)
          ? parseSimulatorLifecycle(fs.readFileSync(seamLogPath, "utf8"))
          : null;
      const { bridge, outPoint, outPoints, seam, seams, sources } = collectProbes({ dump, consoleText });
      console.error(
        `read ${Object.keys(dump).length} localStorage key(s) and ${consoleText.length} bytes of ` +
          `console log; bridge record ${bridge ? `from ${sources.bridge}` : "ABSENT"}; ` +
          `${outPoints.length} out-point record(s) from ${sources.outPoint}; ` +
          `${seams.length} seam record(s) from ${sources.seam}; seam log ` +
          (lifecycle
            ? `${seamLogPath} (${lifecycle.timestamped} timestamped line(s), ${lifecycle.events.length} ` +
              `lifecycle event(s), ${lifecycle.media.length} media sample(s))`
            : `ABSENT at ${seamLogPath ?? "(no path)"}`)
      );
      const report = renderReport({
        bridge,
        outPoint,
        seam,
        lifecycle,
        signingState: process.env.SIGNING_STATE || null,
        build: process.env.IOS_BUILD_STATUS || null,
      });
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
      console.log(report);
      const b = bridgeVerdict(bridge);
      const o = outPointVerdict(outPoint);
      const s = seamTransitionVerdict(seam);
      const sus = suspensionVerdict({ seam, lifecycle });
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
          process.env.GITHUB_OUTPUT,
          `bridge=${b.verdict}\noutpoint=${o.verdict}\nseam=${s.verdict}\nsuspension=${sus.verdict}\n`
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
