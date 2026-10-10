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

test("undeclared and inert until PQ-30: no shell dependency, no injector line, no resources, both halves named for cap sync", () => {
  /* MUTATION: add "foray-notify": "file:plugins/foray-notify" to
     mobile/package.json -> cap sync folds an undeclared-by-plan plugin into
     the shell with no plist key for its task. RUN.
     MUTATION (PQ-29): name ForayNotify/AlertsWorker in any tools/mobile
     injector -> fails. RUN. */
  const mobile = JSON.parse(read(ROOT, "mobile", "package.json"));
  assert.equal(mobile.dependencies?.["foray-notify"], undefined);
  assert.doesNotMatch(read(ROOT, "mobile", "package-lock.json"), /foray-notify/);
  const injectors = fs.readdirSync(path.join(ROOT, "tools", "mobile")).filter((f) => /^inject-.*\.mjs$/.test(f) && !f.endsWith(".test.mjs"));
  assert.ok(injectors.includes("inject-background-audio.mjs"), "the injectors are found");
  for (const f of injectors) {
    assert.doesNotMatch(read(ROOT, "tools", "mobile", f), /ForayNotify|foray-notify|ai\.jwlabs\.foura\.alerts|AlertsWorker|foray_alerts/, f);
  }
  const own = JSON.parse(read(PLUGIN, "package.json"));
  assert.equal(own.name, "foray-notify");
  assert.equal(own.private, true);
  assert.deepEqual(own.capacitor, { ios: { src: "ios" }, android: { src: "android" } },
    "PQ-29: the Android half is in place for PQ-30's declaration to pick up");
  for (const f of ["ios/Sources/", "Package.swift", "android/src/main/", "android/build.gradle"]) {
    assert.ok(own.files.includes(f), `package.json files lists ${f}`);
  }
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

/* ─────────── PQ-29: the ANDROID half ───────────
 *
 * Issue #761; docs/roadmap/player-features.md PQ-29. The twin of the iOS
 * plugin above: a WorkManager periodic worker (every 6 h, on a connected
 * network) runs one AlertsRefresh pass over the same `cp_starred_shows` row,
 * which @capacitor/preferences keeps on Android in the SharedPreferences file
 * named after its group, "CapacitorStorage" (verified in @capacitor/preferences
 * 8.0.1: PreferencesConfiguration.DEFAULTS.group, getSharedPreferences(group));
 * it posts on channel `foray_alerts`, past a ledger in a file of its own, and a
 * tap emits the same `alertOpened { showId }`.
 *
 * As on iOS, the plugin is undeclared, so no shell builds it: the rules,
 * whole passes, the worker's request and the tap are RUN by the JUnit tests
 * under android/src/test/ in android-build.yml's foray-notify step (pinned
 * last). These pins hold the SOURCE facts the contract rests on. */

const JAVA_DIR = path.join(PLUGIN, "android", "src", "main", "java", "ai", "jwlabs", "foura", "notify");
const JAVA_TEST_DIR = path.join(PLUGIN, "android", "src", "test", "java", "ai", "jwlabs", "foura", "notify");
const java = (name) => code(read(JAVA_DIR, name + ".java"));
const javaAll = () => fs.readdirSync(JAVA_DIR).filter((f) => f.endsWith(".java")).map((f) => code(read(JAVA_DIR, f))).join("\n");

/** A Java `public static final <type> <NAME> = <literal>;` as source text. */
function javaConstant(src, name) {
  return new RegExp(`public static final [A-Za-z]+ ${name} = ([^;\\n]+);`).exec(src)?.[1]?.trim() ?? null;
}

/** The body of a Java method `<name>(...) {` up to its closing brace at four spaces. */
function javaBody(src, name) {
  return new RegExp(`[ \\t][A-Za-z<>\\[\\]]+ ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n    \\}`).exec(src)?.[0] ?? "";
}

test("Android: the same plugin name, the same four calls and the same tap event as iOS and alert-open.js", () => {
  /* MUTATION: @CapacitorPlugin(name = "ForayNotifications") -> alert-open.js's
     listener lands on no plugin. RUN.
     MUTATION: drop @PluginMethod from `status` -> the method set differs. RUN.
     MUTATION: EVENT_ALERT_OPENED = "alertTapped" -> the tap never routes. RUN. */
  const src = java("ForayNotifyPlugin");
  assert.match(src, /@CapacitorPlugin\(\s*name = "ForayNotify",/);
  assert.equal(/@CapacitorPlugin\(\s*name = "([^"]+)"/.exec(src)?.[1], ALERT_PLUGIN);
  const methods = [...src.matchAll(/@PluginMethod(?:\([^)]*\))?\s*public void ([a-zA-Z]+)\(PluginCall call\)/g)].map((m) => m[1]).sort();
  const ios = [...plugin().matchAll(/CAPPluginMethod\(name: "([a-zA-Z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(methods.filter((m) => m !== "addListener"), ios, "the iOS call set, exactly");
  assert.ok(methods.includes("addListener"), "the held cold-start tap is released by the addListener override");
  assert.equal(javaConstant(java("AlertRules"), "EVENT_ALERT_OPENED"), `"${ALERT_EVENT}"`);
});

test("Android: the channel is foray_alerts (\"New episodes\"), the only channel, and every alert posts on it", () => {
  /* MUTATION: CHANNEL_ID = "foray_playback" -> alerts land on the playback
     channel the listener may have silenced. RUN.
     MUTATION: `new NotificationCompat.Builder(context, "misc")` -> the post uses a
     channel nothing creates and Android drops it. RUN. */
  const src = java("AlertRules");
  assert.equal(javaConstant(src, "CHANNEL_ID"), '"foray_alerts"');
  assert.equal(javaConstant(src, "CHANNEL_NAME"), '"New episodes"');
  const poster = java("AlertPoster");
  assert.match(javaBody(poster, "ensureChannel"), /new NotificationChannel\(\s*AlertRules\.CHANNEL_ID, AlertRules\.CHANNEL_NAME,/);
  assert.match(javaBody(poster, "post"), /new NotificationCompat\.Builder\(context, AlertRules\.CHANNEL_ID\)/);
  assert.match(javaBody(poster, "post"), /ensureChannel\(context\)/);
  assert.equal([...javaAll().matchAll(/new NotificationChannel\(/g)].length, 1, "one channel");
  assert.equal([...javaAll().matchAll(/NotificationCompat\.Builder\(/g)].length, 1, "one notification shape");
});

test("Android: the worker is registered ONCE, as unique periodic work under the iOS task id, every six hours, on a connected network", () => {
  /* MUTATION: ExistingPeriodicWorkPolicy.KEEP -> CANCEL_AND_REENQUEUE -> every
     launch restarts the six-hour clock. RUN.
     MUTATION: `WorkManager.getInstance(context).enqueue(request())` -> a second
     chain per call. RUN.
     MUTATION: NetworkType.NOT_REQUIRED -> a check that can only fail. RUN.
     MUTATION: WORK_NAME = "alerts" -> no longer iOS's identifier. RUN. */
  const all = javaAll();
  assert.equal(javaConstant(java("AlertRules"), "WORK_NAME"), constant(rules(), "taskIdentifier"));
  assert.equal([...all.matchAll(/enqueueUniquePeriodicWork\(/g)].length, 1, "one enqueue, in one place");
  assert.doesNotMatch(all, /\.enqueue\(/, "never a non-unique enqueue");
  const worker = java("AlertsWorker");
  assert.match(javaBody(worker, "schedule"),
    /enqueueUniquePeriodicWork\(AlertRules\.WORK_NAME, ExistingPeriodicWorkPolicy\.KEEP, request\(\)\)/);
  const request = javaBody(worker, "request");
  assert.match(request, /setRequiredNetworkType\(NetworkType\.CONNECTED\)/);
  assert.match(request, /new PeriodicWorkRequest\.Builder\(AlertsWorker\.class, AlertRules\.CHECK_INTERVAL_MS, TimeUnit\.MILLISECONDS\)/);
  assert.match(worker, /public final class AlertsWorker extends Worker/);
  assert.match(javaBody(worker, "doWork"), /AlertsRefresh\.forContext\(getApplicationContext\(\)\)\.run\(\)/);
  assert.equal([...all.matchAll(/AlertsWorker\.schedule\(/g)].length, 1, "scheduled only from the plugin's scheduleRefresh");
  const pluginSrc = java("ForayNotifyPlugin");
  assert.match(javaBody(pluginSrc, "scheduleRefresh"), /AlertsWorker\.schedule\(getContext\(\)\)/);
  assert.doesNotMatch(javaBody(pluginSrc, "load"), /schedule/i, "nothing is scheduled at launch");
  const gradle = code(read(PLUGIN, "android", "build.gradle"));
  assert.match(gradle, /implementation "androidx\.work:work-runtime:2\.9\.\d+"/, "PQ-29's work-runtime 2.9.x");
});

test("Android: POST_NOTIFICATIONS under ForayAudio's own alias, asked only inside requestPermission, declared in the library manifest", () => {
  /* MUTATION: NOTIFICATIONS = "alerts" -> a second alias for one permission. RUN.
     MUTATION: call requestPermissionForAlias from load() -> the prompt fires at
     launch instead of when the listener turns a show's alerts on. RUN.
     MUTATION: drop the manifest's POST_NOTIFICATIONS -> Capacitor refuses the
     request on Android 13+. RUN. */
  const src = java("ForayNotifyPlugin");
  const audio = code(read(ROOT, "mobile", "plugins", "foray-audio", "android", "src", "main", "java", "ai", "jwlabs", "foura", "audio", "ForayAudioPlugin.java"));
  const alias = (s) => /static final String NOTIFICATIONS = ("[^"]+");/.exec(s)?.[1];
  assert.ok(alias(audio), "ForayAudioPlugin's alias is found");
  assert.equal(alias(src), alias(audio), "the permission alias foray-audio already uses");
  assert.match(src, /@Permission\(alias = ForayNotifyPlugin\.NOTIFICATIONS, strings = \{ Manifest\.permission\.POST_NOTIFICATIONS \}\)/);
  assert.equal([...javaAll().matchAll(/requestPermissionForAlias\(/g)].length, 1);
  assert.match(javaBody(src, "requestPermission"), /requestPermissionForAlias\(NOTIFICATIONS, call, "permissionResult"\)/);
  assert.match(src, /@PermissionCallback\s*private void permissionResult\(PluginCall call\)/);
  const manifest = read(PLUGIN, "android", "src", "main", "AndroidManifest.xml").replace(/<!--[\s\S]*?-->/g, "");
  assert.match(manifest, /<uses-permission android:name="android\.permission\.POST_NOTIFICATIONS" \/>/);
  assert.doesNotMatch(manifest, /<(service|receiver|provider|activity)\b/, "the library declares no component of its own");
});

test("Android: a tap emits alertOpened { showId } warm (handleOnNewIntent) and cold (load), held until a listener attaches", () => {
  /* MUTATION: drop consumeAlertIntent from handleOnNewIntent -> a tapped alert
     opens the app where it was. RUN.
     MUTATION: drop the cold-start read in load() -> a tap that launches the app
     is lost. RUN.
     MUTATION: payload key "showId" -> "show" -> routeForAlert gets null. RUN.
     MUTATION: drop the held-tap notifyListeners from addListener -> a cold tap
     is held forever and never reaches the page. RUN. */
  const src = java("ForayNotifyPlugin");
  assert.match(javaBody(src, "handleOnNewIntent"), /consumeAlertIntent\(intent\)/);
  assert.match(javaBody(src, "load"), /consumeAlertIntent\(activity\.getIntent\(\)\)/);
  const consume = javaBody(src, "consumeAlertIntent");
  assert.match(consume, /AlertRules\.showIdFromExtras\(/);
  assert.match(consume, /removeExtra\(AlertRules\.EXTRA_MARKER\)/);
  assert.match(consume, /emitAlertOpened\(showId\)/);
  const emit = javaBody(src, "emitAlertOpened");
  assert.match(emit, /notifyListeners\(AlertRules\.EVENT_ALERT_OPENED, payload\(showId\)\)/);
  assert.match(emit, /heldShowId = showId;/, "the last unheard tap is held");
  assert.match(javaBody(src, "addListener"), /super\.addListener\(call\);/);
  assert.match(javaBody(src, "addListener"), /heldShowId = null;\s*notifyListeners\(AlertRules\.EVENT_ALERT_OPENED, payload\(showId\)\);/,
    "the held tap is released to the listener that attaches");
  const key = /data\.put\("([a-zA-Z]+)", showId\)/.exec(src)?.[1];
  assert.equal(routeForAlert({ [key]: "lex-fridman" }), "#/show/lex-fridman");
  const poster = java("AlertPoster");
  assert.match(javaBody(poster, "tapIntent"), /putExtra\(AlertRules\.EXTRA_SHOW_ID, showId\)/);
  assert.doesNotMatch(javaBody(poster, "tapIntent"), /setData\(/, "no data URI: @capacitor/app would report it as appUrlOpen");
  const rulesSrc = java("AlertRules");
  assert.equal(javaConstant(rulesSrc, "EXTRA_MARKER"), constant(rules(), "userInfoMarker"));
  assert.equal(javaConstant(rulesSrc, "EXTRA_MARKER_VALUE"), constant(rules(), "userInfoMarkerValue"));
});

test("Android: the refresh uses the page's literals and keeps its ledger out of the page's file", () => {
  /* MUTATION: CHECK_INTERVAL_MS = 3L * 3600 * 1000 -> twice as often as the page. RUN.
     MUTATION: API_ORIGIN = "https://foray.app" -> a host the page does not ask. RUN.
     MUTATION: LEDGER_FILE = "CapacitorStorage" -> a stale page can write the guard. RUN.
     MUTATION: drop AlertRules.shouldNotify(...) from apply -> a rolled-back record posts twice. RUN. */
  const src = java("AlertRules");
  const app = read(ROOT, "app.js");
  assert.equal(javaConstant(src, "API_ORIGIN"), /const API_ORIGIN = ("[^"]+");/.exec(app)?.[1]);
  assert.equal(javaConstant(src, "API_ORIGIN"), constant(rules(), "apiOrigin"));
  assert.equal(javaConstant(src, "CHECK_INTERVAL_MS"), "6L * 3600 * 1000");
  assert.equal(6 * 3600 * 1000, CHECK_INTERVAL_MS);
  assert.equal(javaConstant(src, "MAX_SHOWS_PER_RUN"), /const FOLLOWED_CHECK_CAP = (\d+);/.exec(app)?.[1]);
  assert.equal(javaConstant(src, "FETCH_TIMEOUT_MS"), "10_000");
  assert.equal(javaConstant(src, "STARRED_SHOWS_KEY"), constant(rules(), "starredShowsKey"));
  const prefsFile = JSON.parse(javaConstant(src, "PREFERENCES_FILE"));
  assert.equal(prefsFile + ".", JSON.parse(constant(rules(), "preferencesKeyPrefix")),
    "the Preferences group: iOS spells it as a key prefix, Android as the file name");
  assert.notEqual(JSON.parse(javaConstant(src, "LEDGER_FILE")), prefsFile, "the ledger is not in the page's file");
  assert.match(javaBody(src, "episodesUrl"), /API_ORIGIN \+ "\/api\/shows\/" \+ encodeUriComponent\(showId\) \+ "\/episodes"/);
  const refresh = java("AlertsRefresh");
  const apply = javaBody(refresh, "apply");
  assert.match(apply, /AlertRules\.shouldNotify\(stamp, ledger\.get\(id\)\)/);
  assert.match(apply, /ledger\.put\(id, stamp\);/);
  assert.match(apply, /writeLedger\(ledgerStore, ledger, shows\)/);
  assert.match(javaBody(refresh, "ledgerStore"), /getSharedPreferences\(AlertRules\.LEDGER_FILE, Context\.MODE_PRIVATE\)/);
  assert.match(javaBody(refresh, "pageStore"), /getSharedPreferences\(AlertRules\.PREFERENCES_FILE, Context\.MODE_PRIVATE\)/);
  assert.match(javaBody(java("ForayNotifyPlugin"), "load"), /AlertsRefresh\.pruneLedger\(context\)/);
});

test("Android: the JUnit tests mirror show-alerts.test.js's nine cases, run whole passes, the worker and the tap", () => {
  /* MUTATION: delete aRecordRolledBackByThePageDoesNotNotifyTwice -> named here. RUN. */
  const all = fs.readdirSync(JAVA_TEST_DIR).filter((f) => f.endsWith(".java")).map((f) => read(JAVA_TEST_DIR, f)).join("\n");
  for (const name of [
    "alertsAreOnByDefault", "aShowWithAlertsOffIsNotChecked", "dueWhenNeverCheckedAndAtExactlySixHours",
    "aFreshFollowSeedsTheWatermarkAndReportsNothingNew", "aRowAfterTheWatermarkIsCounted",
    "aRowAtExactlyTheWatermarkIsNotNew", "markSeenZeroesTheCountAndCatchesTheWatermarkUp",
    "alertTextIsTheShowOverTheNewestEpisode", "aRowWithoutPublishedAtIsIgnored",
    "aNewEpisodePostsOneAlertAndTheRowIsWrittenBack", "aRecordRolledBackByThePageDoesNotNotifyTwice",
    "aFailedRequestLeavesTheRecordUntouched", "anUnfollowDuringTheCheckIsNotUndone",
    "theChainIsEnqueuedOnceHoweverOftenItIsScheduled", "theRequestIsSixHourlyOnAConnectedNetwork",
    "aColdTapIsHeldUntilAListenerAttachesAndTheLastOneWins", "notifyNowPostsOnTheAlertsChannelAndItsTapCarriesTheShow"
  ]) {
    assert.match(all, new RegExp(`@Test\\s+public void ${name}\\(\\)`), name);
  }
  assert.doesNotMatch(all, /@Ignore\b/, "a skipped test proves nothing");
});

test("Android: gradle, manifest and package agree, and the module is a library", () => {
  /* MUTATION: namespace = "ai.jwlabs.foura.alerts" -> the Java package and the
     namespace part ways. RUN. */
  const gradle = code(read(PLUGIN, "android", "build.gradle"));
  assert.match(gradle, /apply plugin: 'com\.android\.library'/);
  const ns = /namespace = "([^"]+)"/.exec(gradle)?.[1];
  for (const f of fs.readdirSync(JAVA_DIR)) {
    assert.equal(/^package ([a-z.]+);/m.exec(read(JAVA_DIR, f))?.[1], ns, f);
  }
  assert.match(gradle, /implementation project\(':capacitor-android'\)/);
  assert.match(gradle, /testImplementation "org\.robolectric:robolectric:/);
  const own = JSON.parse(read(PLUGIN, "package.json"));
  assert.ok(fs.existsSync(path.join(PLUGIN, own.capacitor.android.src, "build.gradle")));
  assert.ok(fs.existsSync(path.join(PLUGIN, own.capacitor.android.src, "src", "main", "AndroidManifest.xml")));
});

test("CI runs the JUnit tests: android-build.yml includes :foray-notify for its own step only, runs and counts them, and restores the settings", () => {
  /* MUTATION: delete the `foray-notify JUnit` step -> the Java runs nowhere. RUN.
     MUTATION: drop the `trap ... settings.gradle` restore -> the APKs below are
     built with an undeclared module included. RUN.
     MUTATION: drop the `test "$n" -gt 0` line -> a lost src/test reports
     NO-SOURCE and stays green. RUN.
     MUTATION: add :foray-notify:testDebugUnitTest to the declared modules'
     gradlew line -> fails: cap sync never includes it there. RUN. */
  const android = yamlCode(read(ROOT, ".github", "workflows", "android-build.yml"));
  const step = /- name: foray-notify JUnit[^\n]*\n([\s\S]*?)(?=\n      - |$)/.exec(android)?.[1] ?? "";
  assert.ok(step, "android-build.yml has a `foray-notify JUnit` step");
  assert.match(step, /working-directory: mobile\/android\n/);
  assert.match(step, /cp settings\.gradle "\$RUNNER_TEMP\/settings\.gradle\.orig"\n\s+trap 'cp "\$RUNNER_TEMP\/settings\.gradle\.orig" settings\.gradle' EXIT/);
  assert.match(step, /"':foray-notify'" "':foray-notify'" "'\.\.\/plugins\/foray-notify\/android'" >> settings\.gradle/);
  assert.match(step, /\.\/gradlew :foray-notify:testDebugUnitTest /);
  assert.match(step, /d="\.\.\/plugins\/foray-notify\/android\/build\/test-results\/testDebugUnitTest"/);
  assert.match(step, /test "\$n" -gt 0 \|\| \{/);
  assert.match(step, /test "\$k" -eq 0 \|\| \{/);
  const declaredLine = /\.\/gradlew((?:[^\n]*\\\n)*[^\n]*)/.exec(android.slice(android.indexOf(":foray-vault:testDebugUnitTest") - 200))?.[1] ?? "";
  assert.match(declaredLine, /:foray-vault:testDebugUnitTest/);
  assert.doesNotMatch(declaredLine, /foray-notify/, "the declared modules' call cannot name an undeclared module");
  const at = (frag) => android.indexOf("- name: " + frag);
  assert.ok(at("foray-notify JUnit") > 0 && at("foray-notify JUnit") < at("assembleDebug"), "before the APKs, with the settings restored");
});
