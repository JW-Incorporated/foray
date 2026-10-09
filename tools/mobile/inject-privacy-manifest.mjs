#!/usr/bin/env node
/* Give the generated iOS app target a `PrivacyInfo.xcprivacy` — the privacy
 * manifest App Store Connect checks every upload against — and wire it into the
 * Xcode project's Copy Bundle Resources phase so it actually reaches `App.app`.
 *
 * ── THE FAILURE THIS EXISTS FOR (issue #948) ────────────────────────────────
 * Since 2024-05-01 App Store Connect scans every uploaded binary for the
 * "Required Reason" APIs (Apple: "Describing use of required reason API") and
 * rejects a submission whose bundle uses one without a manifest that declares
 * it, with an approved reason code: ITMS-91053 "Missing API declaration".
 * TestFlight only WARNS (an email after processing), so a build can go all the
 * way to testers and still be unsubmittable. Nothing in this repo wrote a
 * manifest: `cap add ios` generates none (the Capacitor 8.5.0 SwiftPM template,
 * `@capacitor/cli/assets/ios-spm-template.tar.gz`, has no PrivacyInfo.xcprivacy
 * and no reference to one in its project.pbxproj).
 *
 * ── WHAT THE APP ACTUALLY USES (measured 2026-10-04, not assumed) ───────────
 * Every row of `ACCESSED_API_TYPES` below names the call sites it rests on, and
 * `inject-privacy-manifest.test.mjs` re-greps the plugin Swift for each listed
 * API on every run, so a new `UserDefaults` or `systemUptime` call without a
 * declared category goes red here rather than in an email from Apple.
 *
 *   UserDefaults (CA92.1) — the native engine's own store (`EngineStore.swift`,
 *     `HoldPolicyStore.swift`; the keys are named in foray-engine-core's
 *     `Persist/EngineKeys.swift`), the volatile engine-mode flag
 *     (`EngineModeFlag.swift` in foray-audio and foray-tts), foray-vault's
 *     reinstall check, and `@capacitor/preferences`, which is pure
 *     `UserDefaults.standard` and SHIPS NO MANIFEST OF ITS OWN. All of it is
 *     data only this app reads: CA92.1, not an app-group reason.
 *   System boot time (35F9.1) — the monotonic
 *     `DispatchTime.now().uptimeNanoseconds` intervals in AVDeck,
 *     AudioSessionOwner and MainQueueTiming (the engine's clock, which the
 *     lock-screen entry's timing reads too). Elapsed time between in-app
 *     events only: 35F9.1. `NowPlayingPublisher.swift`'s
 *     `ProcessInfo.processInfo.systemUptime` was the other call site until
 *     CH3-16 removed the publisher's second clock (2026-10-09).
 *   File timestamp (C617.1) — NO LONGER DECLARED (CH-20, issue #1076). It was
 *     declared for the statically linked ONNX Runtime 1.20.0 that foray-tts
 *     pinned for the on-device Kokoro probe (`_stat`/`_fstat`, sizing the
 *     bundled model files). The probe, ORT and the weights left the app
 *     together, and no plugin Swift reads a file timestamp (the REAL REPO
 *     scan in the test proves it on every run).
 *
 * No disk-space or active-keyboard API appears anywhere. The other Capacitor
 * plugins (@capacitor/app, splash-screen, status-bar) use no Required Reason API;
 * @capacitor/ios's Capacitor and Cordova frameworks carry their own (empty)
 * manifests, and those are theirs to keep.
 *
 * ── WHAT IT COLLECTS ─────────────────────────────────────────────────────────
 * `COLLECTED_DATA_TYPES` is `docs/legal/data-safety.md` Part B (B2/B3) restated
 * in Apple's keys: User ID, Product Interaction and Other User Content; linked,
 * never tracking; App Functionality and Product Personalization only. The test
 * reads B2 back out of that document, so the two cannot drift silently.
 * `NSPrivacyTracking` is false and there are no tracking domains (B3: no ATT
 * prompt).
 *
 * ── WHY A pbxproj EDIT, AND WHY NOT A SwiftPM RESOURCE ──────────────────────
 * A file in `App/App/` that the project does not reference is never copied into
 * the bundle; Xcode only ships what the target's Resources phase lists. So this
 * writes the file AND adds its four pbxproj entries (file reference, App-group
 * child, build file, Resources-phase member). A `resources:` in a plugin's
 * Package.swift would be the other route, and it is closed: a resource makes
 * SwiftPM generate a resource-bundle target, and the signed archive fails on it
 * ("ForayAudio_ForayAudioPlugin does not support provisioning profiles", release
 * run 36535801479 — see inject-interlude.mjs). A manifest inside a plugin's
 * bundle would also be a plugin's manifest, not the app's.
 *
 * ── WHY THE pbxproj IS PARSED, NOT REGEXED ──────────────────────────────────
 * Same "fails green" argument as inject-background-audio.mjs: a pattern that
 * stops matching yields a project with no manifest in its Resources phase, a
 * build that succeeds, and an upload that is rejected. So the project is read
 * with a real (small) OpenStep-plist parser that records offsets; the edit is a
 * text insertion at positions that parser found, so everything else stays
 * byte-identical; and the result is re-parsed and checked by the same function
 * `--check` uses (`assertWired`). It is find-or-create, so a second run changes
 * nothing and a future template that already lists the file is completed rather
 * than duplicated.
 *
 * USAGE
 *   node tools/mobile/inject-privacy-manifest.mjs <mobile/ios/App>           write + wire
 *   node tools/mobile/inject-privacy-manifest.mjs <mobile/ios/App> --check   read both back
 *   node tools/mobile/inject-privacy-manifest.mjs --bundle <path/to/App.app> the BUILT bundle
 * `<mobile/ios/App>` is the directory holding `App/` and `App.xcodeproj/`. Any
 * other argument is an error, not an ignored flag (same rule as the siblings).
 *
 * Xcode's "Generate Privacy Report" (Organizer, on an archive) is the one check
 * that still needs a human on a Mac: it aggregates this manifest with every
 * embedded framework's. `--bundle` asserts our half on the built app.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isEntryScript } from "../ci/entry.mjs";
import { tags, PlistError } from "./inject-background-audio.mjs";
import { readPlistXml } from "./ios-embedded-frameworks.mjs";

export { PlistError };

export const MANIFEST_NAME = "PrivacyInfo.xcprivacy";

/** Thrown for anything wrong with the Xcode project (as opposed to a plist). */
export class PbxprojError extends Error {}

/* ------------------------------------------------------- what is declared */

/**
 * The Required Reason API categories the app declares, each with the reason
 * code Apple approves for our use and the evidence it rests on. `evidence` is
 * read by the test: every `file` must exist and match `pattern`, so a call site
 * deleted or moved without this list being revisited goes red.
 */
export const ACCESSED_API_TYPES = Object.freeze([
  Object.freeze({
    category: "NSPrivacyAccessedAPICategoryUserDefaults",
    reasons: Object.freeze(["CA92.1"]),
    why: "Reads and writes values only this app can access (the engine's store, the engine-mode flag, the vault's reinstall check, @capacitor/preferences).",
    evidence: Object.freeze([
      { file: "mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/EngineStore.swift", pattern: /UserDefaults = \.standard/ },
      { file: "mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Persist/EngineKeys.swift", pattern: /UserDefaults/ },
      { file: "mobile/plugins/foray-vault/ios/Sources/ForayVaultPlugin/ForayVaultPlugin.swift", pattern: /UserDefaults\.standard/ },
      { file: "mobile/package.json", pattern: /"@capacitor\/preferences"/ },
    ]),
  }),
  Object.freeze({
    category: "NSPrivacyAccessedAPICategorySystemBootTime",
    reasons: Object.freeze(["35F9.1"]),
    why: "Measures time elapsed between events inside the app (lock-screen elapsed time, monotonic deck and session timing).",
    evidence: Object.freeze([
      { file: "mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/AVDeck.swift", pattern: /DispatchTime\.now\(\)\.uptimeNanoseconds/ },
      { file: "mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/MainQueueTiming.swift", pattern: /uptimeNanoseconds/ },
    ]),
  }),
]);

const PURPOSES = Object.freeze([
  "NSPrivacyCollectedDataTypePurposeAppFunctionality",
  "NSPrivacyCollectedDataTypePurposeProductPersonalization",
]);

/**
 * docs/legal/data-safety.md Part B in Apple's manifest keys. `b2Row` is the
 * first cell of that type's B2 row, which the test requires to read **Yes**.
 */
export const COLLECTED_DATA_TYPES = Object.freeze([
  Object.freeze({ type: "NSPrivacyCollectedDataTypeUserID", b2Row: "Identifiers — User ID", linked: true, tracking: false, purposes: PURPOSES }),
  Object.freeze({ type: "NSPrivacyCollectedDataTypeProductInteraction", b2Row: "Usage Data — Product Interaction", linked: true, tracking: false, purposes: PURPOSES }),
  Object.freeze({ type: "NSPrivacyCollectedDataTypeOtherUserContent", b2Row: "User Content — Other User Content", linked: true, tracking: false, purposes: PURPOSES }),
]);

/* ------------------------------------------------------ rendering the file */

/** The manifest's exact bytes: an XML plist, tab-indented, LF, newline at end.
 *  Deterministic, so `--check` can compare bytes and a diff means something. */
export function renderPrivacyManifest() {
  const t = (n) => "\t".repeat(n);
  const bool = (b) => (b ? "<true/>" : "<false/>");
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `${t(1)}<key>NSPrivacyTracking</key>`,
    `${t(1)}${bool(false)}`,
    `${t(1)}<key>NSPrivacyTrackingDomains</key>`,
    `${t(1)}<array/>`,
    `${t(1)}<key>NSPrivacyCollectedDataTypes</key>`,
    `${t(1)}<array>`,
  ];
  for (const c of COLLECTED_DATA_TYPES) {
    lines.push(
      `${t(2)}<dict>`,
      `${t(3)}<key>NSPrivacyCollectedDataType</key>`,
      `${t(3)}<string>${c.type}</string>`,
      `${t(3)}<key>NSPrivacyCollectedDataTypeLinked</key>`,
      `${t(3)}${bool(c.linked)}`,
      `${t(3)}<key>NSPrivacyCollectedDataTypeTracking</key>`,
      `${t(3)}${bool(c.tracking)}`,
      `${t(3)}<key>NSPrivacyCollectedDataTypePurposes</key>`,
      `${t(3)}<array>`,
      ...c.purposes.map((p) => `${t(4)}<string>${p}</string>`),
      `${t(3)}</array>`,
      `${t(2)}</dict>`
    );
  }
  lines.push(`${t(1)}</array>`, `${t(1)}<key>NSPrivacyAccessedAPITypes</key>`, `${t(1)}<array>`);
  for (const a of ACCESSED_API_TYPES) {
    lines.push(
      `${t(2)}<dict>`,
      `${t(3)}<key>NSPrivacyAccessedAPIType</key>`,
      `${t(3)}<string>${a.category}</string>`,
      `${t(3)}<key>NSPrivacyAccessedAPITypeReasons</key>`,
      `${t(3)}<array>`,
      ...a.reasons.map((r) => `${t(4)}<string>${r}</string>`),
      `${t(3)}</array>`,
      `${t(2)}</dict>`
    );
  }
  lines.push(`${t(1)}</array>`, `</dict>`, `</plist>`, ``);
  return lines.join("\n");
}

/* --------------------------------------------- reading a manifest's meaning */

const ENTITIES = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };

/** An XML plist decoded to plain values (dict -> object, array -> array,
 *  string, boolean, number). Independent of `renderPrivacyManifest`: it reads
 *  whatever Xcode copied into the bundle, so a manifest that was reformatted on
 *  the way (binary, re-indented) is still judged on what it SAYS. Duplicate dict
 *  keys throw — plist readers take the last one. */
export function decodePlist(xml) {
  const toks = [...tags(xml)];
  let i = toks.findIndex((t) => t.name === "plist" && !t.closing);
  if (i < 0) throw new PlistError("no <plist> element");
  i++;
  const text = (open, close) =>
    xml.slice(open.end, close.start).replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENTITIES[m]);
  const expectClose = (name) => {
    const c = toks[i];
    if (!c || !c.closing || c.name !== name) throw new PlistError(`<${name}> is not closed where expected`);
    i++;
    return c;
  };
  const value = () => {
    const t = toks[i];
    if (!t || t.closing) throw new PlistError("expected a plist value");
    i++;
    if (t.name === "true" || t.name === "false") {
      if (!t.selfClosing) expectClose(t.name);
      return t.name === "true";
    }
    if (t.name === "dict") {
      const out = {};
      if (t.selfClosing) return out;
      while (!(toks[i] && toks[i].closing && toks[i].name === "dict")) {
        const k = toks[i];
        if (!k || k.name !== "key" || k.closing || k.selfClosing) throw new PlistError("expected <key> in a <dict>");
        i++;
        const name = text(k, expectClose("key")).trim();
        if (Object.prototype.hasOwnProperty.call(out, name)) {
          throw new PlistError(`duplicate key ${name}: plist readers take the last one`);
        }
        out[name] = value();
      }
      i++;
      return out;
    }
    if (t.name === "array") {
      const out = [];
      if (t.selfClosing) return out;
      while (!(toks[i] && toks[i].closing && toks[i].name === "array")) out.push(value());
      i++;
      return out;
    }
    if (t.name === "string" || t.name === "integer" || t.name === "real") {
      if (t.selfClosing) return t.name === "string" ? "" : 0;
      const raw = text(t, expectClose(t.name));
      return t.name === "string" ? raw : Number(raw.trim());
    }
    throw new PlistError(`unsupported plist element <${t.name}>`);
  };
  const root = value();
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new PlistError("the manifest's root is not a <dict>");
  }
  return root;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * Everything a manifest says that differs from what this file declares, as
 * sentences; empty means it says exactly what we mean. Used on the BUILT bundle
 * by `--bundle`, where the bytes may legitimately differ from ours.
 */
export function manifestProblems(xml) {
  let m;
  try {
    m = decodePlist(xml);
  } catch (e) {
    return [`not a readable plist: ${e.message}`];
  }
  const problems = [];
  if (m.NSPrivacyTracking !== false) problems.push(`NSPrivacyTracking is ${JSON.stringify(m.NSPrivacyTracking)}, not false.`);
  if (!Array.isArray(m.NSPrivacyTrackingDomains) || m.NSPrivacyTrackingDomains.length) {
    problems.push(`NSPrivacyTrackingDomains is ${JSON.stringify(m.NSPrivacyTrackingDomains)}, not an empty array.`);
  }
  const apis = Array.isArray(m.NSPrivacyAccessedAPITypes) ? m.NSPrivacyAccessedAPITypes : null;
  if (!apis) problems.push("NSPrivacyAccessedAPITypes is missing or not an array.");
  else {
    for (const want of ACCESSED_API_TYPES) {
      const hits = apis.filter((a) => a && a.NSPrivacyAccessedAPIType === want.category);
      if (hits.length !== 1) {
        problems.push(`${want.category} is declared ${hits.length} times, not once.`);
        continue;
      }
      const got = hits[0].NSPrivacyAccessedAPITypeReasons;
      if (!Array.isArray(got) || !sameSet(got, want.reasons)) {
        problems.push(`${want.category} gives reasons ${JSON.stringify(got)}, not ${JSON.stringify(want.reasons)}.`);
      }
    }
    const known = new Set(ACCESSED_API_TYPES.map((a) => a.category));
    for (const a of apis) {
      if (!a || !known.has(a.NSPrivacyAccessedAPIType)) {
        problems.push(`declares ${JSON.stringify(a && a.NSPrivacyAccessedAPIType)}, which this file does not.`);
      }
    }
  }
  const collected = Array.isArray(m.NSPrivacyCollectedDataTypes) ? m.NSPrivacyCollectedDataTypes : null;
  if (!collected) problems.push("NSPrivacyCollectedDataTypes is missing or not an array.");
  else {
    for (const want of COLLECTED_DATA_TYPES) {
      const hits = collected.filter((c) => c && c.NSPrivacyCollectedDataType === want.type);
      if (hits.length !== 1) {
        problems.push(`${want.type} is declared ${hits.length} times, not once.`);
        continue;
      }
      const c = hits[0];
      if (c.NSPrivacyCollectedDataTypeLinked !== want.linked) problems.push(`${want.type}: Linked is ${c.NSPrivacyCollectedDataTypeLinked}, not ${want.linked}.`);
      if (c.NSPrivacyCollectedDataTypeTracking !== want.tracking) problems.push(`${want.type}: Tracking is ${c.NSPrivacyCollectedDataTypeTracking}, not ${want.tracking}.`);
      if (!Array.isArray(c.NSPrivacyCollectedDataTypePurposes) || !sameSet(c.NSPrivacyCollectedDataTypePurposes, want.purposes)) {
        problems.push(`${want.type}: purposes ${JSON.stringify(c.NSPrivacyCollectedDataTypePurposes)}, not ${JSON.stringify(want.purposes)}.`);
      }
    }
    if (collected.length !== COLLECTED_DATA_TYPES.length) {
      problems.push(`declares ${collected.length} collected data types; docs/legal/data-safety.md B2 has ${COLLECTED_DATA_TYPES.length}.`);
    }
  }
  return problems;
}

/* ------------------------------------------------- the OpenStep pbxproj parser */

/**
 * Parse a project.pbxproj (an old-style OpenStep plist) into nodes that keep
 * their source offsets:
 *   dict   { type, start, end, entries: Map<key, node> }
 *   array  { type, start, end, close, items: node[] }   close = offset of ")"
 *   string { type, start, end, value }
 * Comments (`/* *\/`, `//`) are skipped. Duplicate keys in one dict THROW: the
 * same last-one-wins hazard as a plist, and an object id seen twice means the
 * file is not what we think it is.
 */
export function parsePbxproj(text) {
  if (typeof text !== "string" || !text.trim()) throw new PbxprojError("empty project.pbxproj");
  let i = 0;
  const lineAt = (at) => text.slice(0, at).split("\n").length;
  const fail = (msg) => {
    throw new PbxprojError(`project.pbxproj line ${lineAt(i)}: ${msg}`);
  };
  const ws = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith("/*", i)) {
        const e = text.indexOf("*/", i + 2);
        if (e < 0) fail("unterminated comment");
        i = e + 2;
      } else if (text.startsWith("//", i)) {
        const e = text.indexOf("\n", i);
        i = e < 0 ? text.length : e + 1;
      } else return;
    }
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{") return dict();
    if (c === "(") return array();
    if (c === '"') return quoted();
    return bare();
  };
  const dict = () => {
    const start = i++;
    const entries = new Map();
    for (;;) {
      ws();
      if (i >= text.length) fail("unterminated {");
      if (text[i] === "}") {
        i++;
        return { type: "dict", start, end: i, entries };
      }
      const k = value();
      if (k.type !== "string") fail("a dict key must be a string");
      ws();
      if (text[i] !== "=") fail(`expected = after ${k.value}`);
      i++;
      const v = value();
      ws();
      if (text[i] !== ";") fail(`expected ; after the value of ${k.value}`);
      i++;
      if (entries.has(k.value)) fail(`duplicate key ${k.value}`);
      entries.set(k.value, v);
    }
  };
  const array = () => {
    const start = i++;
    const items = [];
    for (;;) {
      ws();
      if (i >= text.length) fail("unterminated (");
      if (text[i] === ")") {
        const close = i++;
        return { type: "array", start, end: i, close, items };
      }
      items.push(value());
      ws();
      if (text[i] === ",") i++;
      else if (text[i] !== ")") fail("expected , or ) in an array");
    }
  };
  const quoted = () => {
    const start = i++;
    let out = "";
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        const n = text[i + 1];
        out += n === "n" ? "\n" : n === "t" ? "\t" : n;
        i += 2;
      } else out += text[i++];
    }
    if (i >= text.length) fail("unterminated string");
    i++;
    return { type: "string", start, end: i, value: out };
  };
  const bare = () => {
    const m = /^[A-Za-z0-9_$\/:.\-+]+/.exec(text.slice(i, i + 4096));
    if (!m) fail(`unexpected ${JSON.stringify(text[i] ?? "end of file")}`);
    const start = i;
    i += m[0].length;
    return { type: "string", start, end: i, value: m[0] };
  };
  const root = value();
  if (root.type !== "dict") fail("the root is not a dict");
  ws();
  if (i !== text.length) fail("trailing content after the root dict");
  const objects = root.entries.get("objects");
  if (!objects || objects.type !== "dict") throw new PbxprojError("project.pbxproj has no objects dict");
  return { root, objects: objects.entries };
}

const str = (node, key) => {
  const v = node && node.type === "dict" ? node.entries.get(key) : undefined;
  return v && v.type === "string" ? v.value : undefined;
};
const arr = (node, key) => {
  const v = node && node.type === "dict" ? node.entries.get(key) : undefined;
  return v && v.type === "array" ? v : null;
};
const idsOf = (arrayNode) => (arrayNode ? arrayNode.items.filter((n) => n.type === "string").map((n) => n.value) : []);

/**
 * The places the manifest has to be wired, located by MEANING rather than by
 * id, plus whatever wiring already exists. Throws on any shape it cannot be
 * sure about — two app targets, two Resources phases, no Info.plist group —
 * because guessing there is how a manifest ends up in a phase nothing builds.
 */
export function locate(text) {
  const { objects } = parsePbxproj(text);
  const byIsa = (isa) => [...objects].filter(([, o]) => str(o, "isa") === isa);

  const apps = byIsa("PBXNativeTarget").filter(([, o]) => str(o, "productType") === "com.apple.product-type.application");
  if (apps.length !== 1) {
    throw new PbxprojError(`expected exactly one application target, found ${apps.length}. Refusing to guess which one ships.`);
  }
  const [targetId, target] = apps[0];
  const phases = idsOf(arr(target, "buildPhases")).filter((id) => str(objects.get(id), "isa") === "PBXResourcesBuildPhase");
  if (phases.length !== 1) {
    throw new PbxprojError(`the application target has ${phases.length} Resources phases, not one.`);
  }
  const resourcesId = phases[0];
  const resources = objects.get(resourcesId);
  if (!arr(resources, "files")) throw new PbxprojError("the Resources phase has no files array.");

  /* The manifest sits beside Info.plist, in the group that holds it. */
  const plistRefs = byIsa("PBXFileReference").filter(([, o]) => str(o, "path") === "Info.plist");
  const groups = byIsa("PBXGroup").filter(([, g]) => idsOf(arr(g, "children")).some((c) => plistRefs.some(([id]) => id === c)));
  if (groups.length !== 1) {
    throw new PbxprojError(`expected exactly one group holding Info.plist, found ${groups.length}.`);
  }
  const [groupId, group] = groups[0];
  if (!arr(group, "children")) throw new PbxprojError("the Info.plist group has no children array.");

  const manifestRefs = byIsa("PBXFileReference").filter(
    ([, o]) => str(o, "path") === MANIFEST_NAME || str(o, "name") === MANIFEST_NAME
  );
  if (manifestRefs.length > 1) {
    throw new PbxprojError(`${MANIFEST_NAME} has ${manifestRefs.length} file references. Delete the extras by hand first.`);
  }
  const fileRefId = manifestRefs.length ? manifestRefs[0][0] : null;
  if (fileRefId) {
    const ref = manifestRefs[0][1];
    if (str(ref, "path") !== MANIFEST_NAME || (str(ref, "sourceTree") ?? "<group>") !== "<group>") {
      throw new PbxprojError(`the existing ${MANIFEST_NAME} reference is not a plain group-relative file; refusing to rewire it.`);
    }
  }
  const owners = fileRefId
    ? byIsa("PBXGroup").filter(([, g]) => idsOf(arr(g, "children")).includes(fileRefId)).map(([id]) => id)
    : [];
  if (owners.some((id) => id !== groupId)) {
    throw new PbxprojError(`${MANIFEST_NAME} is referenced from a group other than Info.plist's, so it would not be the file beside Info.plist.`);
  }
  const buildFiles = fileRefId ? byIsa("PBXBuildFile").filter(([, o]) => str(o, "fileRef") === fileRefId).map(([id]) => id) : [];
  const resourceFiles = idsOf(arr(resources, "files"));
  const sourcesPhases = idsOf(arr(target, "buildPhases")).filter((id) => str(objects.get(id), "isa") === "PBXSourcesBuildPhase");
  const inSources = sourcesPhases.some((id) => idsOf(arr(objects.get(id), "files")).some((f) => buildFiles.includes(f)));

  return {
    objects,
    targetId,
    resourcesId,
    resources,
    groupId,
    group,
    fileRefId,
    inGroup: owners.includes(groupId),
    buildFiles,
    inResources: buildFiles.filter((b) => resourceFiles.includes(b)),
    inSources,
  };
}

/** Everything wrong with the project's wiring of the manifest, as sentences.
 *  Empty means the app target copies `App/PrivacyInfo.xcprivacy` into the bundle. */
export function wiringProblems(text) {
  let at;
  try {
    at = locate(text);
  } catch (e) {
    return [e.message];
  }
  const p = [];
  if (!at.fileRefId) return [`no PBXFileReference for ${MANIFEST_NAME}.`];
  if (!at.inGroup) p.push(`${MANIFEST_NAME} is not a child of the group that holds Info.plist.`);
  if (at.inResources.length !== 1) {
    p.push(`${MANIFEST_NAME} is in the app target's Resources phase ${at.inResources.length} times, not once.`);
  }
  if (at.inSources) p.push(`${MANIFEST_NAME} is in a Sources phase; it is a resource.`);
  return p;
}

/**
 * Throw unless the project is fully wired. A NAMED function for the reason
 * `assertModePresent` is one: an inline final check is a line an edit can delete
 * with every test still green, and without it a broken insertion would return
 * "changed" and be written.
 *
 * MUTATION: `return;` as its first line — the "an insertion that does not land
 * is refused" test in inject-privacy-manifest.test.mjs fails.
 */
export function assertWired(text) {
  const p = wiringProblems(text);
  if (p.length) {
    throw new PbxprojError(
      `the edit did not take:\n  ${p.join("\n  ")}\nThis is a bug in inject-privacy-manifest.mjs, not in the project.`
    );
  }
}

/** A 24-hex-digit object id, the shape Xcode writes, derived from `seed` so a
 *  run is reproducible, and stepped past any id the project already uses. */
export function pbxId(seed, taken) {
  for (let n = 0; ; n++) {
    const id = crypto.createHash("sha256").update(`foray:${seed}:${n}`).digest("hex").slice(0, 24).toUpperCase();
    if (!taken.has(id)) return id;
  }
}

const indentOf = (text, at) => {
  const ls = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(ls))[0];
};

/** The insertion that appends `line` (`ID /* c *\/`) to an array node, in the
 *  array's own indentation. A one-line `( )` is opened up. */
function appendToArray(text, a, line, eol) {
  const closeIndent = indentOf(text, a.close);
  if (a.items.length && text.slice(a.start, a.close).includes("\n")) {
    const itemIndent = indentOf(text, a.items[a.items.length - 1].start);
    let at = a.close;
    while (at > 0 && (text[at - 1] === " " || text[at - 1] === "\t")) at--;
    return { at, insert: `${itemIndent}${line},${eol}` };
  }
  if (!a.items.length && text.slice(a.start, a.close).includes("\n")) {
    let at = a.close;
    while (at > 0 && (text[at - 1] === " " || text[at - 1] === "\t")) at--;
    return { at, insert: `${closeIndent}\t${line},${eol}` };
  }
  throw new PbxprojError("a one-line array in the project; Xcode never writes these for groups or phases. Refusing to guess its layout.");
}

/** The insertion that adds one object line at the end of its isa's section. */
function appendToSection(text, isa, line, eol) {
  const marker = `/* End ${isa} section */`;
  const m = text.indexOf(marker);
  if (m < 0) throw new PbxprojError(`no "${marker}" in the project; refusing to guess where ${isa} objects go.`);
  const ls = text.lastIndexOf("\n", m - 1) + 1;
  return { at: ls, insert: `\t\t${line}${eol}` };
}

/**
 * Wire `App/PrivacyInfo.xcprivacy` into the application target. Find-or-create
 * for each of the four entries, so it is idempotent and completes a partial
 * wiring rather than duplicating it.
 *
 * @returns {{text: string, changed: boolean, reason: string}}
 */
export function injectPbxproj(text) {
  const at = locate(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const taken = new Set(at.objects.keys());
  const edits = [];
  const did = [];
  let fileRefId = at.fileRefId;
  if (!fileRefId) {
    fileRefId = pbxId("PrivacyInfo.fileRef", taken);
    taken.add(fileRefId);
    edits.push(appendToSection(text, "PBXFileReference",
      `${fileRefId} /* ${MANIFEST_NAME} */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = ${MANIFEST_NAME}; sourceTree = "<group>"; };`, eol));
    did.push("file reference");
  }
  if (!at.inGroup) {
    edits.push(appendToArray(text, at.group.entries.get("children"), `${fileRefId} /* ${MANIFEST_NAME} */`, eol));
    did.push("group child");
  }
  if (at.inResources.length > 1) {
    throw new PbxprojError(`${MANIFEST_NAME} is already in the Resources phase ${at.inResources.length} times. Remove the extras by hand first.`);
  }
  if (!at.inResources.length) {
    const buildId = pbxId("PrivacyInfo.buildFile", taken);
    taken.add(buildId);
    edits.push(appendToSection(text, "PBXBuildFile",
      `${buildId} /* ${MANIFEST_NAME} in Resources */ = {isa = PBXBuildFile; fileRef = ${fileRefId} /* ${MANIFEST_NAME} */; };`, eol));
    edits.push(appendToArray(text, at.resources.entries.get("files"), `${buildId} /* ${MANIFEST_NAME} in Resources */`, eol));
    did.push("build file", "Resources-phase member");
  }
  if (!edits.length) {
    assertWired(text);
    return { text, changed: false, reason: `${MANIFEST_NAME} is already in the app target's Resources phase` };
  }
  let out = text;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.insert + out.slice(e.at);
  assertWired(out);
  return { text: out, changed: true, reason: `added ${did.join(", ")}` };
}

/* ------------------------------------------------------------------ the CLI */

/** The two files `<iosApp>` (mobile/ios/App) holds that this edits. */
export function pathsFor(iosApp) {
  return {
    manifest: path.join(iosApp, "App", MANIFEST_NAME),
    infoPlist: path.join(iosApp, "App", "Info.plist"),
    pbxproj: path.join(iosApp, "App.xcodeproj", "project.pbxproj"),
  };
}

/** Write the manifest and wire it. Reads everything before writing anything, so
 *  a project it refuses leaves both files untouched. */
export function runInject(iosApp) {
  const p = pathsFor(iosApp);
  if (!fs.existsSync(p.infoPlist)) throw new PbxprojError(`${p.infoPlist} does not exist: run after cap add ios`);
  if (!fs.existsSync(p.pbxproj)) throw new PbxprojError(`${p.pbxproj} does not exist: run after cap add ios`);
  const src = fs.readFileSync(p.pbxproj, "utf8");
  const r = injectPbxproj(src);
  const want = renderPrivacyManifest();
  const had = fs.existsSync(p.manifest) ? fs.readFileSync(p.manifest, "utf8") : null;
  if (had !== want) fs.writeFileSync(p.manifest, want);
  if (r.changed) fs.writeFileSync(p.pbxproj, r.text);
  return [
    `${p.manifest}: ${had === want ? "already current" : had === null ? "written" : "replaced"} (${ACCESSED_API_TYPES.map((a) => `${a.category.replace("NSPrivacyAccessedAPICategory", "")}=${a.reasons.join("+")}`).join(" ")})`,
    `${p.pbxproj}: ${r.reason}`,
  ];
}

/** `--check`: the manifest's bytes are ours and the project ships it. */
export function runCheck(iosApp) {
  const p = pathsFor(iosApp);
  const problems = [];
  if (!fs.existsSync(p.manifest)) problems.push(`${p.manifest} does not exist.`);
  else if (fs.readFileSync(p.manifest, "utf8") !== renderPrivacyManifest()) {
    problems.push(`${p.manifest} is not the manifest this script writes (re-run it without --check).`);
  }
  if (!fs.existsSync(p.pbxproj)) problems.push(`${p.pbxproj} does not exist.`);
  else problems.push(...wiringProblems(fs.readFileSync(p.pbxproj, "utf8")).map((s) => `${p.pbxproj}: ${s}`));
  if (problems.length) throw new PbxprojError(problems.join("\n"));
  return [`${p.manifest}: current, and in the app target's Resources phase`];
}

/** `--bundle`: the BUILT app carries the manifest at its root and it says what
 *  we declare. `read` is a seam: the default goes through `plutil` (Xcode may
 *  copy the file as a binary plist), the suite passes a plain file read. */
export function runBundle(appDir, read = readPlistXml) {
  const file = path.join(appDir, MANIFEST_NAME);
  if (!fs.existsSync(appDir)) throw new PbxprojError(`no such bundle: ${appDir}`);
  if (!fs.existsSync(file)) {
    throw new PbxprojError(`${file} is missing: the Resources phase did not copy it, and App Store Connect would reject this build (ITMS-91053).`);
  }
  const problems = manifestProblems(read(file));
  if (problems.length) throw new PbxprojError(`${file}:\n  ${problems.join("\n  ")}`);
  return [`${file}: present; ${ACCESSED_API_TYPES.map((a) => `${a.category} ${a.reasons.join(",")}`).join("; ")}`];
}

const isMain = isEntryScript(import.meta.url);

const USAGE =
  "Usage: node tools/mobile/inject-privacy-manifest.mjs <mobile/ios/App> [--check]\n" +
  "       node tools/mobile/inject-privacy-manifest.mjs --bundle <path/to/App.app>";

if (isMain) {
  const argv = process.argv.slice(2);
  let target = null;
  let check = false;
  let bundle = false;
  for (const a of argv) {
    if (a === "--check") check = true;
    else if (a === "--bundle") bundle = true;
    else if (!a.startsWith("-") && target === null) target = a;
    else {
      console.error(`Unknown argument: ${a}`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  if (!target || (check && bundle)) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const lines = bundle ? runBundle(target) : check ? runCheck(target) : runInject(target);
    for (const l of lines) console.log(l);
  } catch (e) {
    console.error(`inject-privacy-manifest failed: ${e.message}`);
    process.exit(1);
  }
}
