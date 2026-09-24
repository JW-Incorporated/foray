/* `mobile/plugins/foray-vault/` — the device-only store for the auth token.
 *
 * Round-2 audit persist-6; founder ruling 2026-09-24, "Option A": keep ONLY the
 * auth token on the device and out of backups (iOS Keychain, this-device-only
 * class; Android no-backup storage), and let everything else stay backed up.
 *
 * WHAT THIS CAN AND CANNOT PROVE, said plainly. No Swift or Android toolchain
 * runs here. `ios-build.yml` and `android-build.yml` COMPILE this plugin into
 * the shell (every `file:` plugin in mobile/package.json is folded in by
 * `cap sync`); nothing in CI runs a Keychain or a backup. So this suite pins the
 * SOURCE facts the promise rests on — the accessibility class, the
 * no-synchronize flag, the no-backup directory, the reinstall wipe, the plugin
 * name and method set the web half calls — so that deleting or weakening any
 * one of them fails CI instead of quietly putting the token back in a backup.
 * What a phone must still confirm is listed in the PR that added this.
 *
 * Every pattern is matched against CODE with comments stripped: the files
 * explain themselves at length, and a comment naming a constant is not a call.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VAULT_PLUGIN, DEVICE_ONLY_KEYS } from "../../player/durable-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const PLUGIN = path.join(ROOT, "mobile", "plugins", "foray-vault");
const read = (...p) => fs.readFileSync(path.join(...p), "utf8");

/** Strip block and line comments. Safe for these files: no string literal in
    the Swift or Java sources contains `//` or `/*`. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const SWIFT_DIR = path.join(PLUGIN, "ios", "Sources", "ForayVaultPlugin");
const JAVA_DIR = path.join(PLUGIN, "android", "src", "main", "java", "ai", "jwlabs", "foura", "vault");
const swiftPlugin = () => code(read(SWIFT_DIR, "ForayVaultPlugin.swift"));
const swiftVault = () => code(read(SWIFT_DIR, "KeychainVault.swift"));
const javaPlugin = () => code(read(JAVA_DIR, "ForayVaultPlugin.java"));
const javaVault = () => code(read(JAVA_DIR, "DeviceOnlyVault.java"));

/* The calls `vaultTier()` makes through `nativePromise` (durable-store.js's
   nativeKvTier): the Preferences plugin's shapes, copied on purpose. */
const METHODS = ["get", "keys", "remove", "set"];

test("the web half and both native halves agree on the plugin name", () => {
  assert.equal(VAULT_PLUGIN, "ForayVault");
  assert.match(swiftPlugin(), /public let jsName = "ForayVault"/);
  assert.match(swiftPlugin(), /@objc\(ForayVaultPlugin\)\s*public class ForayVaultPlugin: CAPPlugin, CAPBridgedPlugin/);
  assert.match(javaPlugin(), /@CapacitorPlugin\(name = "ForayVault"\)/);
});

test("the vault is for the auth token alone", () => {
  /* The founder's ruling moves ONE row out of the backups. Widening this list
     changes what the privacy policy says is backed up, so it is pinned. */
  assert.deepEqual([...DEVICE_ONLY_KEYS], ["cp_sb_session"]);
});

test("iOS exposes exactly the four calls the web half makes", () => {
  const names = [...swiftPlugin().matchAll(/CAPPluginMethod\(name: "([a-zA-Z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, METHODS);
  for (const m of METHODS) {
    assert.match(swiftPlugin(), new RegExp(`@objc func ${m}\\(_ call: CAPPluginCall\\)`), m);
  }
});

test("Android exposes exactly the four calls the web half makes", () => {
  const names = [...javaPlugin().matchAll(/@PluginMethod\s+public void ([a-zA-Z]+)\(PluginCall call\)/g)]
    .map((m) => m[1]).sort();
  assert.deepEqual(names, METHODS);
});

test("iOS: every item is written this-device-only, and no other accessibility class appears", () => {
  /* MUTATION: kSecAttrAccessibleAfterFirstUnlock (no ThisDeviceOnly) -> the
     item migrates with an encrypted backup onto a new phone. */
  const src = swiftVault();
  assert.match(src, /kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
  const classes = [...src.matchAll(/kSecAttrAccessible[A-Za-z]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(classes)], ["kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly"]);
});

test("iOS: items are never synchronizable (no iCloud Keychain)", () => {
  const src = swiftVault();
  assert.match(src, /add\[kSecAttrSynchronizable as String\] = kCFBooleanFalse/);
  assert.doesNotMatch(src, /kSecAttrSynchronizable[^\n]*(kCFBooleanTrue|true|kSecAttrSynchronizableAny)/);
});

test("iOS: the update path re-asserts the accessibility class, so an older item cannot keep a weaker one", () => {
  const src = swiftVault();
  const set = /public func set\([\s\S]*?\n    }\n/.exec(src);
  assert.ok(set, "KeychainVault.set not found");
  assert.match(set[0], /SecItemUpdate\(itemQuery\(key\) as CFDictionary, attributes as CFDictionary\)/);
  assert.match(set[0], /SecItemAdd\(add as CFDictionary, nil\)/);
});

test("iOS: a fresh install empties the vault once, because iOS keeps Keychain items across an uninstall", () => {
  /* MUTATION: drop the call in load() -> deleting and reinstalling 4a
     re-attaches the old account, which the app never did before. */
  assert.match(swiftPlugin(), /override public func load\(\) \{\s*vault\.forgetIfReinstalled\(defaults: UserDefaults\.standard\)/);
  const src = swiftVault();
  assert.match(src, /if defaults\.bool\(forKey: KeychainVault\.installedMarker\) \{ return \}/);
  assert.match(src, /try\? removeAll\(\)\s*defaults\.set\(true, forKey: KeychainVault\.installedMarker\)/);
});

test("iOS: a Keychain error rejects the call rather than answering 'no account'", () => {
  /* The store treats a rejected read as "could not look" and moves nothing;
     resolving `{ keys: [] }` on an error would read as "there is none". */
  const src = swiftPlugin();
  const rejects = (src.match(/call\.reject\(String\(describing: error\)\)/g) || []).length;
  assert.equal(rejects, 4, "each of the four calls must reject on a Keychain error");
  assert.match(swiftVault(), /if status == errSecItemNotFound \{ return \[\] \}/);
});

test("Android: the file lives in getNoBackupFilesDir(), and nowhere backups reach", () => {
  /* MUTATION: getFilesDir() or getSharedPreferences(...) -> Auto Backup copies
     the token to the listener's Google account, the defect this fixes. */
  const plugin = javaPlugin();
  assert.match(plugin, /new DeviceOnlyVault\(new File\(getContext\(\)\.getNoBackupFilesDir\(\), FILE_NAME\)\)/);
  for (const src of [plugin, javaVault()]) {
    assert.doesNotMatch(src, /getSharedPreferences|getFilesDir\(|getExternal|getDataDir\(|getCacheDir\(/);
  }
});

test("Android: writes are atomic and a storage error rejects the call", () => {
  const vault = javaVault();
  assert.match(vault, /file\.startWrite\(\)/);
  assert.match(vault, /file\.finishWrite\(out\)/);
  assert.match(vault, /file\.failWrite\(out\)/);
  const plugin = javaPlugin();
  const rejects = (plugin.match(/call\.reject\(failure\("(keys|get|set|remove)", e\)\);/g) || []).length;
  assert.equal(rejects, 4);
  assert.match(plugin, /return "ForayVault\." \+ method \+ " failed: " \+ e\.getClass\(\)\.getSimpleName\(\);/);
});

test("Android: a storage error's MESSAGE never leaves the plugin (it can quote the token file)", () => {
  /* org.json's JSONException ends with " at character N of <entire input>",
     and the input is foray-vault.json. The web half keeps a rejection's text in
     cp_storage_health (backed up) and logs it. MUTATION: reject with
     `"..." + e.getMessage()`, or pass `e` to reject (Capacitor logs it) -> the
     token can reach a backup or logcat. Review, 2026-09-24. */
  const plugin = javaPlugin();
  assert.doesNotMatch(plugin, /getMessage\(\)|getLocalizedMessage\(\)|toString\(\)|printStackTrace/);
  /* Every rejection is a fixed literal or `failure(method, e)`: nothing else
     reaches `reject`, so neither the message nor the exception can. */
  const calls = [...plugin.matchAll(/call\.reject\(([^;]*)\);/g)].map((m) => m[1]);
  assert.equal(calls.length, 7, "four storage errors and three missing-argument refusals");
  for (const args of calls) {
    assert.match(args, /^(failure\("(keys|get|set|remove)", e\)|"[^"+]*")$/, `reject(${args}) can carry the exception`);
  }
  assert.doesNotMatch(javaVault(), /getMessage\(\)|Log\.[a-z]\(/);
});

test("Android: the module depends on capacitor-android and nothing else", () => {
  const gradle = code(read(PLUGIN, "android", "build.gradle"));
  const deps = [...gradle.matchAll(/^\s*(implementation|api|compileOnly|runtimeOnly)\s+(.+)$/gm)].map((m) => m[2].trim());
  assert.deepEqual(deps, ["project(':capacitor-android')"]);
});

test("the Swift package is named for cap sync, with no dependency beyond Capacitor", () => {
  const pkg = read(PLUGIN, "Package.swift");
  assert.match(pkg, /name: "ForayVault"/);
  assert.match(pkg, /\.library\(\s*name: "ForayVault",\s*targets: \["ForayVaultPlugin"\]\)/);
  assert.match(pkg, /path: "ios\/Sources\/ForayVaultPlugin"/);
  const urls = [...pkg.matchAll(/\.package\(url: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(urls, ["https://github.com/ionic-team/capacitor-swift-pm.git"]);
});

test("the shell declares the plugin, so cap sync links it on both platforms", () => {
  /* MUTATION: drop the dependency -> the plugin is never compiled in, vaultTier()
     answers null in the app, and the token goes back into the backed-up tiers. */
  const mobile = JSON.parse(read(ROOT, "mobile", "package.json"));
  assert.equal(mobile.dependencies["foray-vault"], "file:plugins/foray-vault");
  const lock = JSON.parse(read(ROOT, "mobile", "package-lock.json"));
  assert.equal(lock.packages[""].dependencies["foray-vault"], "file:plugins/foray-vault");
  assert.deepEqual(lock.packages["node_modules/foray-vault"], { resolved: "plugins/foray-vault", link: true });
  const own = JSON.parse(read(PLUGIN, "package.json"));
  assert.equal(own.name, "foray-vault");
  assert.deepEqual(own.capacitor, { ios: { src: "ios" }, android: { src: "android" } });
});
