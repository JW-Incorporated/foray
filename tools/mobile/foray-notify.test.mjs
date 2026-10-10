/* `mobile/plugins/foray-notify/` — the iOS half of new-episode alerts.
 *
 * Issue #761; docs/roadmap/player-features.md PQ-28, "Exact change" (1) and
 * (3). A background app refresh reads the page's `cp_starred_shows` row,
 * applies player/show-alerts.js's rules, writes the row back and posts one
 * local notification per show with a new episode; a tap emits `alertOpened
 * { showId }`, which player/alert-open.js routes to the show.
 *
 * WHAT THIS CAN AND CANNOT PROVE, said plainly. No Swift toolchain runs here,
 * and the plugin is NOT declared in mobile/package.json yet (PQ-30), so no
 * shell compiles it. The rules and one whole refresh pass are run by the
 * XCTests in `AlertsRefreshTests.swift`, in ci.yml's ios-kit job (the last test
 * below pins that step). So this suite pins the SOURCE facts the contract with
 * the page rests on — the plugin name, method set and event alert-open.js
 * uses, the task identifier PQ-30's plist key must repeat, the one place that
 * asks for permission, the literals the page's rules use (row key, origin,
 * interval, cap), the stale-page guard's key — and that the plugin stays
 * undeclared and inert until PQ-30, so that deleting or weakening any of them
 * fails on every run, with no toolchain.
 *
 * Every pattern is matched against CODE with comments stripped: the files
 * explain themselves at length, and a comment naming an API is not a call.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ALERT_PLUGIN, ALERT_EVENT, routeForAlert } from "../../player/alert-open.js";
import { CHECK_INTERVAL_MS } from "../../player/show-alerts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const PLUGIN = path.join(ROOT, "mobile", "plugins", "foray-notify");
const SWIFT_DIR = path.join(PLUGIN, "ios", "Sources", "ForayNotifyPlugin");
const read = (...p) => fs.readFileSync(path.join(...p), "utf8");

/** Strip block and line comments. Safe for these files: the only string
    literals containing `//` are URLs, and no pattern below reads past one. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const plugin = () => code(read(SWIFT_DIR, "ForayNotifyPlugin.swift"));
const rules = () => code(read(SWIFT_DIR, "AlertsRefresh.swift"));
const xctests = () => read(PLUGIN, "ios", "Tests", "ForayNotifyPluginTests", "AlertsRefreshTests.swift");

/** A Swift `static let <name> = <literal>` in AlertRules, as source text. */
function constant(src, name) {
  return new RegExp(`public static let ${name}(?:: [A-Za-z]+)? = ([^\\n]+)`).exec(src)?.[1]?.trim() ?? null;
}

/** The body of `func <name>(` up to its closing brace at the same indent. */
function body(src, name, indent = "    ") {
  return new RegExp(`func ${name}\\([\\s\\S]*?\\n${indent}\\}`).exec(src)?.[0] ?? "";
}

test("the web half and the iOS plugin agree on the plugin name and the tap event", () => {
  /* MUTATION: jsName = "ForayNotifications" -> alert-open.js's listener and
     the page's requestPermission land on no plugin. RUN.
     MUTATION: eventAlertOpened = "alertTapped" -> the tap never routes. RUN. */
  assert.equal(ALERT_PLUGIN, "ForayNotify");
  assert.match(plugin(), /public let jsName = "ForayNotify"/);
  assert.match(plugin(), /@objc\(ForayNotifyPlugin\)\s*public class ForayNotifyPlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol/);
  assert.equal(ALERT_EVENT, "alertOpened");
  assert.equal(constant(rules(), "eventAlertOpened"), `"${ALERT_EVENT}"`);
});

test("iOS exposes exactly requestPermission, status, scheduleRefresh and notifyNow, each with its @objc handler", () => {
  /* MUTATION: drop the `status` CAPPluginMethod line -> the set differs. RUN. */
  const names = [...plugin().matchAll(/CAPPluginMethod\(name: "([a-zA-Z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, ["notifyNow", "requestPermission", "scheduleRefresh", "status"]);
  for (const m of names) assert.match(plugin(), new RegExp(`@objc func ${m}\\(_ call: CAPPluginCall\\)`), m);
});

test("a tap emits alertOpened { showId }, retained until the page listens, and alert-open.js routes that payload", () => {
  /* MUTATION: drop `emitAlertOpened(showId)` from didReceive -> a tapped alert
     opens the app where it was. RUN.
     MUTATION: `retainUntilConsumed: false` -> a cold start from a tap loses it
     before alert-open.js attaches. RUN.
     MUTATION: the payload key `"showId"` -> `"show"` -> routeForAlert gets null. RUN. */
  const src = plugin();
  const didReceive = body(src, "didReceive");
  assert.match(didReceive, /AlertRules\.showId\(fromUserInfo: response\.notification\.request\.content\.userInfo\)/);
  assert.match(didReceive, /emitAlertOpened\(showId\)/);
  const emit = body(src, "emitAlertOpened");
  assert.match(emit, /let event = AlertRules\.eventAlertOpened/);
  assert.match(emit, /notifyListeners\(event, data: \["showId": showId\], retainUntilConsumed: true\)/);
  assert.match(emit, /if !hasListeners\(event\) \{\s*retainedEventArguments\?\.removeObject\(forKey: event\)/,
    "only the last unheard tap is kept");
  const key = /data: \["([a-zA-Z]+)": showId\]/.exec(emit)?.[1];
  assert.equal(routeForAlert({ [key]: "lex-fridman" }), "#/show/lex-fridman");
});

test("the plugin takes local notifications through Capacitor's router and never replaces the center's delegate", () => {
  /* MUTATION: `UNUserNotificationCenter.current().delegate = self` in load() ->
     the bridge's NotificationRouter is cut out for every plugin. RUN. */
  const src = [plugin(), rules()].join("\n");
  assert.match(body(plugin(), "load"), /bridge\?\.notificationRouter\.localNotificationHandler = self/);
  assert.doesNotMatch(src, /\.delegate\s*=/);
  assert.match(body(plugin(), "willPresent"), /AlertRules\.showId\(fromUserInfo:/, "only OUR alerts are shown in the foreground");
});

test("requestAuthorization is called once, inside requestPermission, for alert and sound only", () => {
  /* MUTATION: call requestAuthorization from load() -> the prompt fires at
     launch instead of when the listener turns a show's alerts on. RUN. */
  const all = [plugin(), rules()].join("\n");
  assert.equal([...all.matchAll(/requestAuthorization\(/g)].length, 1);
  assert.match(body(plugin(), "requestPermission"),
    /requestAuthorization\(options: \[\.alert, \.sound\]\) \{ granted, _ in\s*call\.resolve\(\["granted": granted\]\)/);
});

test("the background task identifier is ai.jwlabs.foura.alerts, used by both the register and the request, six hours out", () => {
  /* MUTATION: taskIdentifier = "ai.jwlabs.foura.alert" -> PQ-30's
     BGTaskSchedulerPermittedIdentifiers no longer names it and submit throws. RUN. */
  assert.equal(constant(rules(), "taskIdentifier"), '"ai.jwlabs.foura.alerts"');
  const src = plugin();
  assert.match(body(src, "registerBackgroundRefresh"), /BGTaskScheduler\.shared\.register\(forTaskWithIdentifier: AlertRules\.taskIdentifier, using: nil\)/);
  const submit = body(src, "submitRefresh");
  assert.match(submit, /BGAppRefreshTaskRequest\(identifier: AlertRules\.taskIdentifier\)/);
  assert.match(submit, /Date\(timeIntervalSinceNow: AlertRules\.checkIntervalSec\)/);
  assert.doesNotMatch(body(src, "load"), /registerBackgroundRefresh|BGTaskScheduler/,
    "iOS requires the launch handler before didFinishLaunching returns: the AppDelegate registers it (PQ-30), not the bridge");
});

test("the refresh uses the page's literals: the row, the origin, the six-hour interval, the cap of six", () => {
  /* MUTATION: checkIntervalSec = 3 * 3600 -> native checks twice as often as
     the page's dueForCheck says. RUN.
     MUTATION: apiOrigin = "https://foray.app" -> the refresh asks a host the
     page does not. RUN. */
  const src = rules();
  const app = read(ROOT, "app.js");
  assert.equal(constant(src, "apiOrigin"), /const API_ORIGIN = ("[^"]+");/.exec(app)?.[1]);
  assert.equal(constant(src, "checkIntervalSec"), "6 * 3600");
  assert.equal(6 * 3600 * 1000, CHECK_INTERVAL_MS);
  assert.equal(constant(src, "maxShowsPerRun"), /const FOLLOWED_CHECK_CAP = (\d+);/.exec(app)?.[1]);
  assert.equal(constant(src, "starredShowsKey"), '"cp_starred_shows"');
  const core = read(ROOT, "mobile", "plugins", "foray-audio", "foray-engine-core", "Sources", "ForayEngineCore", "EngineHandshake.swift");
  assert.equal(constant(src, "preferencesKeyPrefix"), /public static let preferencesKeyPrefix = ("[^"]+")/.exec(core)?.[1],
    "the same prefix CapacitorStoragePrefixTests pins against the real Preferences plugin");
  assert.match(src, /"\\\(apiOrigin\)\/api\/shows\/\\\(id\)\/episodes"/);
  assert.match(constant(src, "fetchTimeoutSec"), /^10$/);
});

test("the stale-page guard: a native ledger outside CapacitorStorage., consulted before every post", () => {
  /* MUTATION: ledgerDefaultsKey = "CapacitorStorage.foray_notify_ledger" -> a
     stale page can write the guard itself. RUN.
     MUTATION: drop `AlertRules.shouldNotify(...)` from apply's guard -> a
     record rolled back by the page posts the same alert twice. RUN. */
  const src = rules();
  const key = JSON.parse(constant(src, "ledgerDefaultsKey"));
  const prefix = JSON.parse(constant(src, "preferencesKeyPrefix"));
  assert.ok(!key.startsWith(prefix), `${key} must not be a row the page writes`);
  const apply = body(src, "apply");
  assert.match(apply, /AlertRules\.shouldNotify\(newest: stamp, lastNotified: ledger\[id\]\)/);
  assert.match(apply, /ledger\[id\] = stamp/);
  assert.match(apply, /AlertsRefresh\.writeLedger\(ledger, defaults, keeping: shows\)/);
  assert.match(body(plugin(), "load"), /AlertsRefresh\.pruneLedger\(\.standard\)/);
  assert.match(xctests(), /func testARecordRolledBackByThePageDoesNotNotifyTwice\(\)/);
});

test("the XCTests mirror show-alerts.test.js's nine cases and run the whole pass", () => {
  /* MUTATION: delete testARowAtExactlyTheWatermarkIsNotNew -> named here. RUN. */
  const src = xctests();
  for (const name of [
    "testAlertsAreOnByDefault", "testAShowWithAlertsOffIsNotChecked", "testDueWhenNeverCheckedAndAtExactlySixHours",
    "testAFreshFollowSeedsTheWatermarkAndReportsNothingNew", "testARowAfterTheWatermarkIsCounted",
    "testARowAtExactlyTheWatermarkIsNotNew", "testMarkSeenZeroesTheCountAndCatchesTheWatermarkUp",
    "testAlertTextIsTheShowOverTheNewestEpisode", "testARowWithoutPublishedAtIsIgnored",
    "testANewEpisodePostsOneAlertAndTheRowIsWrittenBack", "testARecordRolledBackByThePageDoesNotNotifyTwice",
    "testAFailedRequestLeavesTheRecordUntouched", "testAnUnfollowDuringTheCheckIsNotUndone"
  ]) {
    assert.match(src, new RegExp(`func ${name}\\(\\)`), name);
  }
  assert.match(src, /@testable import ForayNotifyPlugin/);
});

test("undeclared and inert until PQ-30: no shell dependency, no injector line, no resources, iOS only", () => {
  /* MUTATION: add "foray-notify": "file:plugins/foray-notify" to
     mobile/package.json -> cap sync folds an undeclared-by-plan plugin into
     the shell with no plist key for its task. RUN. */
  const mobile = JSON.parse(read(ROOT, "mobile", "package.json"));
  assert.equal(mobile.dependencies?.["foray-notify"], undefined);
  assert.doesNotMatch(read(ROOT, "mobile", "package-lock.json"), /foray-notify/);
  assert.doesNotMatch(read(ROOT, "tools", "mobile", "inject-background-audio.mjs"), /ForayNotify|foray-notify|ai\.jwlabs\.foura\.alerts/);
  const own = JSON.parse(read(PLUGIN, "package.json"));
  assert.equal(own.name, "foray-notify");
  assert.equal(own.private, true);
  assert.deepEqual(own.capacitor, { ios: { src: "ios" } }, "the Android half is PQ-29's");
  assert.equal(own.main, undefined, "no JS entry: the web half is player/alert-open.js");
  const manifest = code(read(PLUGIN, "Package.swift"));
  assert.equal(/name: "([^"]+)"/.exec(manifest)?.[1], "ForayNotify");
  assert.doesNotMatch(manifest, /\bresources\s*:/);
});

/* ─────────── CI RUNS the XCTests ───────────
 *
 * The XCTests pinned above by NAME prove only that the tests exist. What runs
 * them is ci.yml's ios-kit job (an `xcodebuild test` against an iOS Simulator,
 * because the package links Capacitor, which ships iOS slices only). Delete
 * the step and the stale-page guard can be broken with CI green. YAML comment
 * lines are stripped first: a comment naming a step is not a step. */

const yamlCode = (src) => src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

/** One top-level job of a workflow: from `  <name>:` to the next job key. */
function workflowJob(src, name) {
  const start = src.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  if (start < 0) return "";
  const rest = src.slice(start + 1);
  const next = rest.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

test("CI runs the XCTests: ios-kit tests ForayNotify on a Simulator and fails a run that executed none", () => {
  /* MUTATION: delete ci.yml's `swift test (foray-notify, iOS Simulator)` step
     -> AlertsRefreshTests.swift runs nowhere. RUN.
     MUTATION: `-scheme ForayNotifications` -> xcodebuild finds no such scheme. RUN. */
  const ci = yamlCode(read(ROOT, ".github", "workflows", "ci.yml"));
  const iosKit = workflowJob(ci, "ios-kit");
  assert.ok(iosKit, "ci.yml keeps its ios-kit job");
  const step = /- name: swift test \(foray-notify, iOS Simulator\)\n([\s\S]*?)(?=\n      - |$)/.exec(iosKit)?.[1] ?? "";
  assert.ok(step, "ios-kit has a `swift test (foray-notify, iOS Simulator)` step");
  assert.match(step, /working-directory: mobile\/plugins\/foray-notify\n/);
  const pkgName = /name: "([^"]+)"/.exec(code(read(PLUGIN, "Package.swift")))?.[1];
  assert.match(step, new RegExp(`xcodebuild test \\\\\\n\\s+-scheme ${pkgName} \\\\\\n\\s+-destination "platform=iOS Simulator,`),
    "the step tests the package's own scheme on a Simulator");
  assert.match(step, /Executed \[1-9\]/, "the step fails a run that executed no test");
  assert.match(step, /grep -q "skipped"/, "and one that skipped a test");
});
