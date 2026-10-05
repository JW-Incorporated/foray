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
