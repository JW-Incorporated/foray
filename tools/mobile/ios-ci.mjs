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
  return { bridge, outPoints, outPoint: pickOutPoint(outPoints) };
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
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /FORAY_PROBE_(BRIDGE|OUTPOINT)\s+(\{.*\})/.exec(line);
    if (!m) continue;
    let rec = null;
    try {
      rec = JSON.parse(m[2]);
    } catch {
      /* Log lines get truncated. Retry against the longest prefix that closes. */
      const cut = m[2].lastIndexOf("}");
      if (cut > 0) { try { rec = JSON.parse(m[2].slice(0, cut + 1)); } catch { rec = null; } }
    }
    if (rec && typeof rec === "object") (m[1] === "BRIDGE" ? bridge : outPoints).push(rec);
  }
  return { bridge, outPoints };
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
  return {
    bridge,
    outPoints,
    outPoint: pickOutPoint(outPoints),
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
  const base =
    `Stopped at ${probe.stoppedAtSec.toFixed(3)}s against end_sec=${probe.endSec}s: ` +
    `overshoot ${overshoot.toFixed(3)}s, ${where}.` +
    (median == null ? "" : ` Median timeupdate interval while hidden: ${median.toFixed(0)} ms.`);

  if (!probe.stoppedWhileBackgrounded) {
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
export function renderReport({ bridge, outPoint, signingState, build }) {
  const b = bridgeVerdict(bridge);
  const o = outPointVerdict(outPoint);
  const lines = [];
  lines.push("## iOS shell — what this run actually established", "");
  if (build) lines.push(`**Build:** ${build}`, "");
  lines.push(`### 1. Capacitor's bridge vs our CSP — \`${b.verdict}\``, "", b.headline, "", b.detail, "");
  lines.push(`### 2. The out-point while backgrounded — \`${o.verdict}\``, "", o.headline, "", o.detail, "");
  lines.push(`> ${SIMULATOR_CAVEAT}`, "");
  lines.push(
    `### 3. TestFlight upload — \`${signingState || "not reported"}\``,
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
      const { bridge, outPoint, outPoints, sources } = collectProbes({ dump, consoleText });
      console.error(
        `read ${Object.keys(dump).length} localStorage key(s) and ${consoleText.length} bytes of ` +
          `console log; bridge record ${bridge ? `from ${sources.bridge}` : "ABSENT"}; ` +
          `${outPoints.length} out-point record(s) from ${sources.outPoint}`
      );
      const report = renderReport({
        bridge,
        outPoint,
        signingState: process.env.SIGNING_STATE || null,
        build: process.env.IOS_BUILD_STATUS || null,
      });
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
      console.log(report);
      const b = bridgeVerdict(bridge);
      const o = outPointVerdict(outPoint);
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
          process.env.GITHUB_OUTPUT,
          `bridge=${b.verdict}\noutpoint=${o.verdict}\n`
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
