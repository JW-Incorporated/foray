/* `mobile/plugins/foray-downloads/` — the iOS half of offline downloads.
 *
 * Issue #29; docs/roadmap/player-features.md PQ-20. A background URLSession
 * fetches an episode's audio into `Application Support/foray-downloads/`,
 * kept out of backups, with a JSON index beside the files.
 *
 * WHAT THIS CAN AND CANNOT PROVE, said plainly. No Swift toolchain runs here,
 * and until PQ-21 declares the plugin in mobile/package.json no CI job compiles
 * it either (`ios-build.yml` folds in only declared `file:` plugins; `ios-kit`
 * runs only the packages it names). The rules are in `DownloadPolicy.swift`,
 * pure, with XCTests in `DownloadPolicyTests.swift` that run once ios-kit gains
 * a foray-downloads step. So this suite pins the SOURCE facts the contract
 * rests on — the plugin name, method set and events the web half
 * (`player/download-bridge.js`) calls, the directory, the backup exclusion,
 * the cellular switch, the GET probe, the redirect cap, the 403 mapping — so
 * that deleting or weakening one of them fails CI today, uncompiled.
 *
 * Every pattern is matched against CODE with comments stripped: the files
 * explain themselves at length, and a comment naming an API is not a call.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DOWNLOADS_PLUGIN, DOWNLOAD_EVENTS, createDownloadBridge } from "../../player/download-bridge.js";
import { reportFromEvent, playSource } from "../../player/download-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const PLUGIN = path.join(ROOT, "mobile", "plugins", "foray-downloads");
const SWIFT_DIR = path.join(PLUGIN, "ios", "Sources", "ForayDownloadsPlugin");
const read = (...p) => fs.readFileSync(path.join(...p), "utf8");

/** Strip block and line comments. Safe for these files: the only string
    literals containing `//` are URLs, and no pattern below reads past one. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const plugin = () => code(read(SWIFT_DIR, "ForayDownloadsPlugin.swift"));
const store = () => code(read(SWIFT_DIR, "DownloadStore.swift"));
const policy = () => code(read(SWIFT_DIR, "DownloadPolicy.swift"));
const allSource = () => [plugin(), store(), policy()].join("\n");
const xctests = () => read(PLUGIN, "ios", "Tests", "ForayDownloadsPluginTests", "DownloadPolicyTests.swift");

/** The method set the web half exposes: every function on a bridge built
    over a fake Capacitor, the `handles` array aside. */
function bridgeMethods() {
  const fake = { nativePromise: async () => ({}), addListener: () => ({ remove() {} }) };
  const bridge = createDownloadBridge({ bridge: fake, onEvent: () => {} });
  return Object.keys(bridge).filter((k) => typeof bridge[k] === "function").sort();
}

test("the web half and the iOS plugin agree on the plugin name", () => {
  /* MUTATION: jsName = "ForayDownload" -> every nativePromise call from
     download-bridge.js lands on no plugin and times out. RUN. */
  assert.equal(DOWNLOADS_PLUGIN, "ForayDownloads");
  assert.match(plugin(), /public let jsName = "ForayDownloads"/);
  assert.match(plugin(), /@objc\(ForayDownloadsPlugin\)\s*public class ForayDownloadsPlugin: CAPPlugin, CAPBridgedPlugin/);
  assert.match(policy(), /public static let pluginName = "ForayDownloads"/);
});

test("iOS exposes exactly the seven calls download-bridge.js makes, each with its @objc handler", () => {
  /* MUTATION: drop the `fileSrc` CAPPluginMethod line -> the set differs. RUN. */
  const web = bridgeMethods();
  assert.deepEqual(web, ["cancel", "enqueue", "fileSrc", "list", "remove", "removeAll", "usage"]);
  const names = [...plugin().matchAll(/CAPPluginMethod\(name: "([a-zA-Z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, web);
  for (const m of web) {
    assert.match(plugin(), new RegExp(`@objc func ${m}\\(_ call: CAPPluginCall\\)`), m);
  }
});

test("the three events are the ones download-bridge.js subscribes to, and the store emits each", () => {
  /* MUTATION: eventDone = "downloadComplete" -> the page never hears a
     download finish. RUN. */
  assert.deepEqual([...DOWNLOAD_EVENTS], ["downloadProgress", "downloadDone", "downloadFailed"]);
  const src = policy();
  const declared = ["eventProgress", "eventDone", "eventFailed"].map((k) => {
    const m = new RegExp(`public static let ${k} = "([a-zA-Z]+)"`).exec(src);
    assert.ok(m, `${k} not declared`);
    return m[1];
  });
  assert.deepEqual(declared, [...DOWNLOAD_EVENTS]);
  for (const k of ["eventProgress", "eventDone", "eventFailed"]) {
    assert.match(store(), new RegExp(`emit\\?\\(DownloadPolicy\\.${k},`), `the store never emits ${k}`);
  }
  assert.match(plugin(), /self\?\.notifyListeners\(name, data: payload\)/);
});

test("the event payloads carry the fields download-store.js's reportFromEvent reads", () => {
  /* MUTATION: rename `"bytes"` to `"written"` in progressPayload -> fails. */
  const src = policy();
  const body = (fn) => new RegExp(`func ${fn}\\([^)]*\\) -> \\[String: Any\\] \\{([^}]*)\\}`).exec(src)?.[1] ?? "";
  const keys = (fn) => [...body(fn).matchAll(/"([a-z]+)":/g)].map((m) => m[1]);
  assert.deepEqual(keys("progressPayload"), ["id", "bytes", "total"]);
  assert.deepEqual(keys("donePayload"), ["id", "path", "bytes"]);
  assert.deepEqual(keys("failedPayload"), ["id", "reason", "status"]);
});

test("files live under Application Support/foray-downloads, never Caches or Documents", () => {
  /* MUTATION: `.cachesDirectory` -> iOS purges the listener's downloads under
     storage pressure. RUN. */
  const src = allSource();
  assert.match(store(), /FileManager\.default\.urls\(for: \.applicationSupportDirectory, in: \.userDomainMask\)/);
  assert.match(policy(), /public static let directoryName = "foray-downloads"/);
  assert.doesNotMatch(src, /cachesDirectory/);
  assert.doesNotMatch(src, /documentDirectory/);
  assert.match(policy(), /public static let indexFileName = "index\.json"/);
  assert.match(store(), /DownloadStore\.directory\(\)\.appendingPathComponent\(DownloadPolicy\.indexFileName/);
});

test("the directory, the index and every stored file are excluded from backup", () => {
  /* MUTATION: delete `values.isExcludedFromBackup = true` -> fails. */
  const src = store();
  assert.match(src, /values\.isExcludedFromBackup = true/);
  assert.match(src, /try excludeFromBackup\(dir\)/);
  assert.match(src, /try\? excludeFromBackup\(indexURL\)/);
  assert.match(src, /try\? excludeFromBackup\(dest\)/);
});

test("allowsCellularAccess comes from the call and defaults off", () => {
  /* MUTATION: `call.getBool("allowCellular") ?? true` -> a Wi-Fi-only
     listener's download runs on LTE. RUN. */
  assert.match(plugin(), /allowCellular: call\.getBool\("allowCellular"\) \?\? false/);
  assert.match(policy(), /request\.allowsCellularAccess = allowCellular/);
  assert.match(policy(), /next\.allowsCellularAccess = allowCellular/);
  assert.doesNotMatch(allSource(), /allowsCellularAccess = true/);
});

test("the probe is a one-byte GET with the page's User-Agent; no HEAD anywhere", () => {
  /* MUTATION: `request.httpMethod = "HEAD"` in probeRequest -> fails here
     (and DownloadPolicyTests.testTheProbeIsAOneByteGet on CI). RUN. */
  const src = policy();
  assert.doesNotMatch(allSource(), /"HEAD"/);
  const probe = /func probeRequest\([\s\S]*?\n    \}/.exec(src)?.[0] ?? "";
  assert.match(probe, /request\.httpMethod = "GET"/);
  assert.match(probe, /request\.setValue\(probeRange, forHTTPHeaderField: "Range"\)/);
  assert.match(src, /public static let probeRange = "bytes=0-0"/);
  assert.match(src, /request\.setValue\(ua, forHTTPHeaderField: "User-Agent"\)/);
  assert.match(plugin(), /userAgent: call\.getString\("userAgent"\)/);
});

test("the redirect cap is eight, enforced in the probe's own session", () => {
  /* MUTATION: maxRedirects = 9 -> fails. A background session never asks its
     delegate about redirects, so the cap must live in the ephemeral probe. */
  const src = policy();
  assert.match(src, /public static let maxRedirects = 8\b/);
  assert.match(src, /if count > maxRedirects \{ return \.refuse\(reason: reasonTooManyRedirects\) \}/);
  assert.match(src, /public static let reasonTooManyRedirects = "too-many-redirects"/);
  assert.match(store(), /URLSessionConfiguration\.ephemeral/);
  assert.match(store(), /willPerformHTTPRedirection[\s\S]*?DownloadPolicy\.redirect\(count: redirects, to: request\.url\)/);
});

test("a 403 is unplayable-here, and download-store.js reads the payload that way", () => {
  /* MUTATION: `if status == 403 { return .refuse(reason: "http 403") }` ->
     fails, and the page would offer a retry that can never work. RUN. */
  const src = policy();
  assert.match(src, /public static let reasonUnplayableHere = "unplayable-here"/);
  const verdicts = src.match(/if status == 403 \{ return \.refuse\(reason: reasonUnplayableHere\) \}/g) ?? [];
  assert.equal(verdicts.length, 2, "both the probe and the completion verdict map 403");
  const report = reportFromEvent("downloadFailed", { id: "e1", reason: "unplayable-here", status: 403 }, { now: 1 });
  assert.equal(report.status, "unplayable-here");
});

test("the background session has the one identifier, and the transfer is tagged with the episode id", () => {
  /* MUTATION: a second identifier, or no taskDescription -> a relaunch's
     events cannot be matched to a download. */
  assert.match(policy(), /public static let sessionIdentifier = "ai\.jwlabs\.foura\.downloads"/);
  assert.match(store(), /URLSessionConfiguration\.background\(withIdentifier: DownloadPolicy\.sessionIdentifier\)/);
  assert.equal((allSource().match(/URLSessionConfiguration\.background\(/g) ?? []).length, 1);
  assert.match(store(), /task\.taskDescription = id/);
});

test("file names are SHA-256 of the episode id plus .bin, and paths reach the page raw for download-store.js to encode", () => {
  /* MUTATION: answer `fileURL(r.file).absoluteString` -> the page receives a
     file: URL already encoded, and fileUrl() passes it through. */
  assert.match(policy(), /SHA256\.hash\(data: Data\(id\.utf8\)\)/);
  assert.match(policy(), /joined\(\) \+ "\.bin"/);
  assert.match(store(), /row\["path"\] = r\.status == "done" \? fileURL\(r\.file\)\.path as Any/);
  assert.match(store(), /DownloadPolicy\.donePayload\(id: id, path: dest\.path, bytes: bytes\)/);
  const path = "/var/mobile/Containers/Data/Application/X/Library/Application Support/foray-downloads/ab.bin";
  const src = playSource({ audio_url: "https://e/x.mp3" }, { status: "done", path }, { platform: "ios" });
  assert.equal(src.audio_url, "file:///var/mobile/Containers/Data/Application/X/Library/Application%20Support/foray-downloads/ab.bin");
});

test("no Required Reason API the app manifest does not declare: usage comes from the index", () => {
  /* #1014: DiskSpace is not declared, so no volume query; and the size of a
     finished file is the task's own count, not a file attribute.
     MUTATION: compute usage with `volumeAvailableCapacity` -> fails. RUN. */
  const src = allSource();
  assert.doesNotMatch(src, /volumeAvailableCapacity|NSFileSystemFreeSize|NSFileSystemSize|systemFreeSize|\bstatv?fs\b|\bfstatv?fs\b/);
  assert.doesNotMatch(src, /attributesOfItem|creationDate|modificationDate|\bUserDefaults\b|systemUptime/);
  assert.match(store(), /let u = index\.usage\(\)/);
  assert.match(store(), /let bytes = downloadTask\.countOfBytesReceived/);
  assert.match(policy(), /for record in items\.values where record\.status == "done"/);
});

test("removeAll deletes the whole directory, and remove drops the row before cancelling", () => {
  /* MUTATION: removeAll empties the index but keeps the files -> "Delete my
     data" leaves gigabytes of audio behind. */
  const src = store();
  const removeAll = /func removeAll\(\) throws \{[\s\S]*?\n    \}/.exec(src)?.[0] ?? "";
  assert.match(removeAll, /let dir = DownloadStore\.directory\(\)/);
  assert.match(removeAll, /try FileManager\.default\.removeItem\(at: dir\)/);
  assert.match(removeAll, /cancelTasks \{ _ in true \}/);
  const remove = /func remove\(id rawId: String\?\) throws -> Bool \{[\s\S]*?\n    \}/.exec(src)?.[0] ?? "";
  /* MUTATION: `index.items.removeValue(forKey: id)?.file` -> `index.items[id]?.file`
     in remove() -> the deleted download comes back in list() as "missing". */
  assert.ok(remove, "remove(id:) keeps its signature");
  const dropped = remove.indexOf("index.items.removeValue(forKey: id)");
  const cancelled = remove.indexOf("cancelTasks");
  assert.ok(dropped >= 0, "remove drops the index row");
  assert.ok(cancelled >= 0, "remove cancels the task");
  assert.ok(dropped < cancelled, "the row goes before the task is cancelled");
});

test("the package is a self-contained SwiftPM plugin with XCTests for each policy rule", () => {
  /* MUTATION: delete testTheNinthRedirectIsRefused -> fails. */
  const pkg = code(read(PLUGIN, "Package.swift"));
  assert.match(pkg, /name: "ForayDownloads"/);
  assert.match(pkg, /path: "ios\/Sources\/ForayDownloadsPlugin"/);
  assert.match(pkg, /\.testTarget\(\s*name: "ForayDownloadsPluginTests"/);
  assert.doesNotMatch(pkg, /\bresources\s*:/);
  const json = JSON.parse(read(PLUGIN, "package.json"));
  assert.equal(json.name, "foray-downloads");
  assert.equal(json.capacitor?.ios?.src, "ios");
  assert.equal(json.main, undefined, "no JS entry: download-bridge.js is the web half");
  const tests = xctests();
  for (const name of ["testOnlyHttpAndHttpsSourcesAreAccepted", "testTheProbeIsAOneByteGet", "testCellularAccessFollowsTheCall",
    "testTheNinthRedirectIsRefused", "testA403IsUnplayableHere", "testTheFileNameIsTheIdsSha256", "testUsageCountsDoneRowsOnly"]) {
    assert.match(tests, new RegExp(`func ${name}\\(\\)`), name);
  }
});

/* ─────────── PQ-22 (#29): the Android half — DownloadManager ───────────
 *
 * Same honesty as above, one platform over. No JDK runs in this suite, and
 * until PQ-21 declares the plugin in mobile/package.json `cap sync` never
 * includes `:foray-downloads`, so android-build.yml does not compile this Java
 * either. These pins hold the SOURCE facts: the name, the seven methods and
 * three events against download-bridge.js, the Gradle/manifest/package
 * agreement, the destination (never internal storage handed to
 * DownloadManager; the finished file in the no-backup directory), the exported
 * completion receiver, the cellular switch, the 403 mapping, the 2 s poll,
 * and the redirect cap's Android truth (five, fixed, documented). */

const ANDROID = path.join(PLUGIN, "android");
const JAVA_DIR = path.join(ANDROID, "src", "main", "java", "ai", "jwlabs", "foura", "downloads");
const jPlugin = () => code(read(JAVA_DIR, "ForayDownloadsPlugin.java"));
const jStore = () => code(read(JAVA_DIR, "DownloadStore.java"));
const jRules = () => code(read(JAVA_DIR, "DownloadRules.java"));
const allJava = () => [jPlugin(), jStore(), jRules()].join("\n");

test("Android: the plugin is ForayDownloads with exactly download-bridge.js's seven calls", () => {
  /* MUTATION: `@CapacitorPlugin(name = "ForayDownload")` -> every call from the
     page lands on no plugin on Android. RUN.
     MUTATION: delete the `@PluginMethod` above `fileSrc` -> the set differs. RUN. */
  assert.match(jPlugin(), /@CapacitorPlugin\(name = "ForayDownloads"\)\s*public class ForayDownloadsPlugin extends Plugin/);
  assert.match(jRules(), /static final String PLUGIN_NAME = "ForayDownloads";/);
  const names = [...jPlugin().matchAll(/@PluginMethod\s+public void (\w+)\(PluginCall call\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, bridgeMethods());
});

test("Android: the three events are download-bridge.js's, each emitted through notifyListeners", () => {
  /* MUTATION: EVENT_DONE = "downloadComplete" -> the page never hears an
     Android download finish. RUN. */
  const src = jRules();
  const declared = ["EVENT_PROGRESS", "EVENT_DONE", "EVENT_FAILED"].map((k) => {
    const m = new RegExp(`static final String ${k} = "([a-zA-Z]+)";`).exec(src);
    assert.ok(m, `${k} not declared`);
    return m[1];
  });
  assert.deepEqual(declared, [...DOWNLOAD_EVENTS]);
  for (const k of ["EVENT_PROGRESS", "EVENT_DONE", "EVENT_FAILED"]) {
    assert.match(jStore(), new RegExp(`emit\\(DownloadRules\\.${k},`), `the store never emits ${k}`);
  }
  assert.match(jPlugin(), /store\.setEmitter\(\(name, payload\) -> notifyListeners\(name, payload\)\)/);
  /* The payload keys download-store.js's reportFromEvent reads. */
  assert.match(jStore(), /p\.put\("id", id\);\s*p\.put\("bytes", [^;]+\);\s*p\.put\("total", /);
  assert.match(jStore(), /p\.put\("id", id\);\s*p\.put\("path", dest\.getAbsolutePath\(\)\);\s*p\.put\("bytes", bytes\);/);
  assert.match(jStore(), /p\.put\("id", id\);\s*p\.put\("reason", reason\);\s*p\.put\("status", /);
});

test("Android: package.json, build.gradle, the manifest and the Java package all name the module", () => {
  /* MUTATION: `namespace = "ai.jwlabs.foura.download"` -> R and the manifest
     resolve into a package the Java is not in. RUN. */
  const json = JSON.parse(read(PLUGIN, "package.json"));
  assert.equal(json.capacitor?.android?.src, "android", "cap sync discovers the Android module through this");
  assert.ok(json.files.includes("android/src/main/") && json.files.includes("android/build.gradle"));
  assert.doesNotMatch(json.description, /not yet here/, "the description no longer says the Android half is missing");
  const gradle = read(ANDROID, "build.gradle");
  const ns = /^\s*namespace\s*=?\s*["']([\w.]+)["']/m.exec(gradle)?.[1];
  assert.equal(ns, "ai.jwlabs.foura.downloads");
  for (const f of ["ForayDownloadsPlugin.java", "DownloadStore.java", "DownloadRules.java"]) {
    assert.equal(/^package\s+([\w.]+)\s*;/m.exec(read(JAVA_DIR, f))?.[1], ns, f);
  }
  assert.equal(path.relative(path.join(ANDROID, "src", "main", "java"), JAVA_DIR).split(path.sep).join("."), ns);
  const manifest = read(ANDROID, "src", "main", "AndroidManifest.xml");
  assert.match(manifest, /<manifest xmlns:android="http:\/\/schemas\.android\.com\/apk\/res\/android">/);
  assert.doesNotMatch(manifest, /<uses-permission|<receiver|<service/, "the plugin declares nothing");
  assert.match(code(gradle), /implementation project\(':capacitor-android'\)/);
});

test("Android: DownloadManager lands in the external files dir, never internal storage, and the file moves to no-backup", () => {
  /* MUTATION: `request.setDestinationUri(Uri.fromFile(new File(context.getFilesDir(), ...)))`
     -> DownloadProvider throws SecurityException "Unsupported path" on enqueue. RUN.
     MUTATION: drop `moveInto(landed, dest)` and keep the landed file -> it sits in
     Auto Backup's default set. RUN. */
  const src = allJava();
  assert.doesNotMatch(src, /setDestinationUri\s*\(/);
  assert.doesNotMatch(src, /getFilesDir\s*\(/);
  assert.match(jStore(), /request\.setDestinationInExternalFilesDir\(context, null, DownloadRules\.DIRECTORY_NAME \+ "\/" \+ file\)/);
  assert.match(jStore(), /new File\(context\.getNoBackupFilesDir\(\), DownloadRules\.DIRECTORY_NAME\)/);
  assert.match(jStore(), /File base = context\.getExternalFilesDir\(null\);/);
  const complete = /private void complete\([\s\S]*?\n    \}/.exec(jStore())?.[0] ?? "";
  assert.match(complete, /bytes = moveInto\(landed, dest\);/);
  assert.match(complete, /File dest = storedFile\(file\);/);
  assert.match(jRules(), /static final String DIRECTORY_NAME = "foray-downloads";/);
  assert.match(jRules(), /static final String INDEX_FILE_NAME = "index\.json";/);
  assert.match(jStore(), /new AtomicFile\(new File\(storeDir\(\), DownloadRules\.INDEX_FILE_NAME\)\)/);
});

test("Android: the completion receiver is registered through ContextCompat, exported, for ACTION_DOWNLOAD_COMPLETE", () => {
  /* MUTATION: ContextCompat.RECEIVER_NOT_EXPORTED -> the download provider (another
     app) cannot reach the receiver on API 34, so completion waits for the poll. RUN. */
  assert.match(jStore(), /ContextCompat\.registerReceiver\(context, receiver,\s*new IntentFilter\(DownloadManager\.ACTION_DOWNLOAD_COMPLETE\), ContextCompat\.RECEIVER_EXPORTED\)/);
  assert.doesNotMatch(allJava(), /RECEIVER_NOT_EXPORTED/);
  assert.match(code(read(ANDROID, "build.gradle")), /implementation "androidx\.core:core:/);
});

test("Android: allowCellular reaches setAllowedOverMetered and setAllowedOverRoaming, and defaults off", () => {
  /* MUTATION: `call.getBoolean("allowCellular", true)` -> a Wi-Fi-only listener's
     download runs on LTE. RUN. */
  assert.match(jPlugin(), /call\.getBoolean\("allowCellular", false\)/);
  assert.match(jStore(), /request\.setAllowedOverMetered\(allowCellular\);/);
  assert.match(jStore(), /request\.setAllowedOverRoaming\(allowCellular\);/);
  assert.doesNotMatch(allJava(), /setAllowedOver(Metered|Roaming)\(true\)/);
  assert.match(jStore(), /request\.addRequestHeader\("User-Agent", ua\)/);
  assert.match(jPlugin(), /call\.getString\("userAgent"\)/);
});

test("Android: a 403 in COLUMN_REASON is unplayable-here, and the failure reasons are iOS's strings", () => {
  /* MUTATION: `if (reason == 403) return "http 403";` -> fails, and the page
     would offer a retry that can never work. RUN. */
  const src = jRules();
  assert.match(src, /if \(reason == 403\) return REASON_UNPLAYABLE_HERE;/);
  assert.match(src, /case DownloadManager\.ERROR_TOO_MANY_REDIRECTS:\s*return REASON_TOO_MANY_REDIRECTS;/);
  assert.match(jStore(), /int reason = c\.getInt\(colReason\);\s*fail\(id, transfer, DownloadRules\.failureReason\(reason\), DownloadRules\.httpStatus\(reason\)\);/);
  assert.match(jStore(), /c\.getColumnIndexOrThrow\(DownloadManager\.COLUMN_REASON\)/);
  /* Every reason both platforms name is the same string on both. */
  const swift = Object.fromEntries([...policy().matchAll(/public static let reason(\w+) = "([^"]+)"/g)]
    .map((m) => [m[1].replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase(), m[2]]));
  const java = Object.fromEntries([...src.matchAll(/static final String REASON_(\w+) = "([^"]+)";/g)].map((m) => [m[1], m[2]]));
  for (const k of ["TOO_MANY_REDIRECTS", "UNPLAYABLE_HERE", "BAD_URL", "CANCELLED", "NOT_SAVED", "INTERRUPTED"]) {
    assert.ok(java[k], `REASON_${k} missing on Android`);
    assert.equal(java[k], swift[k], `REASON_${k} differs between the platforms`);
  }
});

test("Android: progress is polled every 2 s while a download runs, and the poll stops when none does", () => {
  /* MUTATION: PROGRESS_POLL_MS = 200L -> a ten-row queue queries DownloadManager
     fifty times a second. RUN. */
  assert.match(jRules(), /static final long PROGRESS_POLL_MS = 2000L;/);
  assert.match(jStore(), /worker\.scheduleWithFixedDelay\(this::tick, DownloadRules\.PROGRESS_POLL_MS,\s*DownloadRules\.PROGRESS_POLL_MS, TimeUnit\.MILLISECONDS\)/);
  const tick = /private void tick\(\) \{[\s\S]*?\n    \}/.exec(jStore())?.[0] ?? "";
  assert.match(tick, /if \(hasInFlight\(\)\) return;/);
  assert.match(tick, /poller\.cancel\(false\)/);
  assert.match(jStore(), /status == DownloadManager\.STATUS_RUNNING\) \{\s*progress\(/);
});

test("Android: no HEAD request, file names are the id's SHA-256, and the 5-redirect cap is documented as fixed", () => {
  /* MUTATION: DOWNLOAD_MANAGER_MAX_REDIRECTS = 8 -> fails: the provider's cap is
     five and cannot be raised, so claiming eight on Android is false. RUN. */
  assert.doesNotMatch(allJava(), /"HEAD"/);
  assert.match(jRules(), /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(jRules(), /return sb\.append\("\.bin"\)\.toString\(\);/);
  assert.match(jRules(), /static final int DOWNLOAD_MANAGER_MAX_REDIRECTS = 5;/);
  const raw = read(JAVA_DIR, "DownloadRules.java");
  assert.match(raw, /THE REDIRECT CAP IS iOS-ONLY/);
  assert.match(raw, /FIXED cap of five/);
});

test("Android: removeAll deletes both directories and every transfer; remove drops the row first; JUnit covers the rules", () => {
  /* MUTATION: removeAll clears the index but skips `deleteTree(storeDir())` ->
     "Delete my data" leaves the audio on the phone. RUN. */
  const src = jStore();
  const removeAll = /void removeAll\(\) throws IOException \{[\s\S]*?\n    \}/.exec(src)?.[0] ?? "";
  assert.match(removeAll, /items\.clear\(\);/);
  assert.match(removeAll, /manager\.remove\(ids\);/);
  assert.match(removeAll, /deleteTree\(landing\)/);
  assert.match(removeAll, /deleteTree\(storeDir\(\)\)/);
  const remove = /boolean remove\(String id\) \{[\s\S]*?\n    \}/.exec(src)?.[0] ?? "";
  const dropped = remove.indexOf("items.remove(id)");
  const stopped = remove.indexOf("manager.remove(transfer)");
  assert.ok(dropped >= 0 && stopped >= 0 && dropped < stopped, "the row goes before the transfer is stopped");
  const junit = read(ANDROID, "src", "test", "java", "ai", "jwlabs", "foura", "downloads", "DownloadRulesTest.java");
  for (const name of ["onlyHttpAndHttpsSourcesAreAccepted", "theFileNameIsTheIdsSha256", "a403IsUnplayableHere",
    "tooManyRedirectsIsTheSameReasonIosUses", "theUserAgentIsOnePrintableLine"]) {
    assert.match(junit, new RegExp(`@Test\\s+public void ${name}\\(\\)`), name);
  }
  assert.match(code(read(ANDROID, "build.gradle")), /testImplementation "junit:junit:4\.13\.2"/);
});

test("PQ-21: the shell declares the plugin, and the lockfile npm ci reads agrees, so cap sync links it on both platforms", () => {
  /* MUTATION: drop "foray-downloads" from mobile/package.json's dependencies ->
     cap sync never folds the plugin in, createDownloadBridge's calls time out in
     the app, and no CI job compiles the Swift or the Java. RUN.
     MUTATION: declare it without updating mobile/package-lock.json -> every
     `npm ci` in ios-build / android-build refuses the out-of-sync lock. RUN. */
  const mobile = JSON.parse(read(ROOT, "mobile", "package.json"));
  assert.equal(mobile.dependencies["foray-downloads"], "file:plugins/foray-downloads");
  assert.match(mobile["//foray-downloads"] ?? "", /NOT a third-party dependency/);
  const lock = JSON.parse(read(ROOT, "mobile", "package-lock.json"));
  assert.equal(lock.packages[""].dependencies["foray-downloads"], "file:plugins/foray-downloads");
  assert.deepEqual(lock.packages["node_modules/foray-downloads"], { resolved: "plugins/foray-downloads", link: true });
  assert.ok(lock.packages["plugins/foray-downloads"], "the lock records the linked package itself");
  const own = JSON.parse(read(PLUGIN, "package.json"));
  assert.equal(own.name, "foray-downloads");
  assert.deepEqual(own.capacitor, { ios: { src: "ios" }, android: { src: "android" } });
});
