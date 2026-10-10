#!/usr/bin/env node
/* Give the generated iOS app the Associated Domains entitlement, so a shared
 * `https://foray-web-seven.vercel.app/#/show/...` link opens in 4a rather than
 * Safari: `com.apple.developer.associated-domains = ["applinks:<share host>"]`
 * in `App/App.entitlements`, and `CODE_SIGN_ENTITLEMENTS` pointing the App
 * target's build configurations at that file (HUMAN-ACTIONS.md #145, #1071).
 *
 * ── WHY IT IS BEHIND A COMMITTED OFF-SWITCH ─────────────────────────────────
 * The website half is live: `.well-known/apple-app-site-association` names
 * `D9N628AFHS.ai.jwlabs.foura`. The app half cannot simply be switched on,
 * because Apple REFUSES TO SIGN a build that claims an entitlement its App ID
 * and provisioning profile do not grant. Associated Domains is a capability
 * only the founder can tick on developer.apple.com (#145 steps 1-4, which also
 * re-issue the profile). An entitlement written before that would turn every
 * release archive red. So the switch is `mobile/ASSOCIATED_DOMAINS.json`,
 * committed as `{"enabled": false}`, and while it is false this script is a
 * VERIFIED no-op: it reads the project, writes no byte, and `--check` asserts
 * that nothing in the project claims the entitlement. The PR that answers #145's
 * `done` flips the flag (and wires this script into
 * .github/actions/ios-prepare/action.yml); nothing else has to change.
 *
 * ── ONLY THE RELEASE BUNDLE ID ──────────────────────────────────────────────
 * The AASA names one app, `ai.jwlabs.foura`, and only its App ID gets the
 * capability in #145. Any other bundle id (the "4a Lab" `ai.jwlabs.foura.lab`,
 * the template's `com.getcapacitor.App`) is left exactly as it is even with the
 * flag on: its profile would not grant the entitlement, and its links would not
 * be honoured anyway. The bundle id is read from the App target's own build
 * configurations (every one must agree), or taken from `--bundle-id` when the
 * caller overrides `PRODUCT_BUNDLE_IDENTIFIER` on the xcodebuild command line.
 *
 * ── ONE SHARE HOST ──────────────────────────────────────────────────────────
 * The domain is derived from `SHARE_ORIGIN` in player/incoming-link.js, the
 * constant the app's own share links and incoming-link router use, so a custom
 * domain later (HUMAN-ACTIONS.md #147) moves this entitlement with it rather
 * than leaving a second copy of the host typed here.
 *
 * ── HOW THE PROJECT IS EDITED ───────────────────────────────────────────────
 * The pbxproj is read with inject-privacy-manifest.mjs's offset-keeping
 * OpenStep parser (one parser for the project, not two) and edited by text
 * insertion at positions that parser found, so every other byte stays put.
 * The entitlements plist is read with inject-background-audio.mjs's tag walker.
 * Both edits are re-parsed and checked by the same function `--check` uses
 * before anything is written, and both are find-or-create, so a re-run changes
 * nothing. The entitlements file is NOT added to any build phase or group:
 * Xcode reads CODE_SIGN_ENTITLEMENTS as a path relative to the project
 * directory, and an entitlements file in Copy Bundle Resources would ship the
 * file inside App.app for no reason.
 *
 * USAGE
 *   node tools/mobile/inject-associated-domains.mjs <mobile/ios/App>                    write (when enabled)
 *   node tools/mobile/inject-associated-domains.mjs <mobile/ios/App> --check            read back
 *   node tools/mobile/inject-associated-domains.mjs <mobile/ios/App> --bundle-id <id>   the id xcodebuild will sign
 * `<mobile/ios/App>` is the directory holding `App/` and `App.xcodeproj/`. The
 * flag is always the committed `mobile/ASSOCIATED_DOMAINS.json`; there is no
 * override on the command line. Any other argument is an error, not an
 * ignored flag (same rule as the sibling injectors).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { tags, rootEntries, rootIndent, PlistError } from "./inject-background-audio.mjs";
import { parsePbxproj, PbxprojError } from "./inject-privacy-manifest.mjs";
import { SHARE_ORIGIN } from "../../player/incoming-link.js";

export { PlistError, PbxprojError };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The one bundle id the AASA names and #145 gives the capability to. */
export const RELEASE_BUNDLE_ID = "ai.jwlabs.foura";
export const ASSOCIATED_DOMAINS_KEY = "com.apple.developer.associated-domains";
/** CODE_SIGN_ENTITLEMENTS's value: relative to the project dir (mobile/ios/App). */
export const ENTITLEMENTS_SETTING = "App/App.entitlements";
export const FLAG_FILE = path.join(ROOT, "mobile", "ASSOCIATED_DOMAINS.json");

/** `["applinks:<host>"]` for the share origin. The host, not the origin: Apple
 *  takes `applinks:` plus a bare host (no scheme, no path). */
export function applinksDomains(origin = SHARE_ORIGIN) {
  const u = new URL(origin);
  if (u.protocol !== "https:") throw new Error(`the share origin ${origin} is not https; Apple only checks an AASA over https`);
  return [`applinks:${u.host}`];
}

/* ---------------------------------------------------------------- the flag */

/**
 * Parse the committed switch. STRICT: `enabled` must be a JSON boolean (a
 * string "false" is truthy in JavaScript, and that typo would sign a build
 * Apple refuses), and any key that is not `enabled` or a `//` comment is an
 * error rather than a setting someone thinks they changed.
 */
export function parseFlag(text, where = "mobile/ASSOCIATED_DOMAINS.json") {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${where} is not JSON: ${e.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${where} must be a JSON object`);
  for (const k of Object.keys(doc)) {
    if (k !== "enabled" && !k.startsWith("//")) throw new Error(`${where}: unknown key ${JSON.stringify(k)}`);
  }
  if (typeof doc.enabled !== "boolean") {
    throw new Error(`${where}: "enabled" must be true or false (a JSON boolean), got ${JSON.stringify(doc.enabled)}`);
  }
  return { enabled: doc.enabled };
}

/** Whether this run writes the entitlement, and why. Both conditions, always. */
export function decide({ enabled, bundleId }) {
  if (!enabled) {
    return { act: false, reason: "mobile/ASSOCIATED_DOMAINS.json is off (HUMAN-ACTIONS.md #145 not done); nothing written" };
  }
  if (bundleId !== RELEASE_BUNDLE_ID) {
    return { act: false, reason: `bundle id ${bundleId} is not ${RELEASE_BUNDLE_ID}; only the release App ID has the capability, nothing written` };
  }
  return { act: true, reason: `enabled for ${bundleId}` };
}

/* ------------------------------------------------------- the entitlements plist */

/** The file's exact bytes when this script creates it: tab-indented, LF. */
export function renderEntitlements(domains = applinksDomains()) {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>${ASSOCIATED_DOMAINS_KEY}</key>`,
    `\t<array>`,
    ...domains.map((d) => `\t\t<string>${d}</string>`),
    `\t</array>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** `<plist><dict/></plist>`: what Xcode writes for an entitlements file with
 *  nothing in it. rootEntries refuses a self-closing root (an Info.plist is
 *  never empty), so it is recognised here first. */
function isEmptyRootDict(xml) {
  const open = [...tags(xml)].filter((t) => !t.closing);
  return open.length === 2 && open[0].name === "plist" && open[1].name === "dict" && open[1].selfClosing;
}

/** The root dict's associated-domains entry: null when absent, else the source
 *  of its value with whitespace between tags removed (for an exact compare). */
export function associatedDomainsValue(xml) {
  if (isEmptyRootDict(xml)) return null;
  const { entries } = rootEntries(xml);
  const hits = entries.filter((e) => e.key === ASSOCIATED_DOMAINS_KEY);
  if (hits.length > 1) {
    throw new PlistError(`the entitlements declare ${ASSOCIATED_DOMAINS_KEY} ${hits.length} times; delete the duplicates by hand first.`);
  }
  if (!hits.length) return null;
  return xml.slice(hits[0].value.start, hits[0].value.end).replace(/>\s+</g, "><");
}

const wantValue = (domains) => `<array>${domains.map((d) => `<string>${d}</string>`).join("")}</array>`;

/** Throw unless `xml` declares exactly `domains`. Named, not inline, so an edit
 *  that deletes it shows up in a test (the `assertModePresent` argument).
 *
 *  MUTATION: `return;` as its first line -- the "an insertion that does not
 *  land is refused" test in inject-associated-domains.test.mjs fails. */
export function assertEntitled(xml, domains = applinksDomains()) {
  const got = associatedDomainsValue(xml);
  if (got !== wantValue(domains)) {
    throw new PlistError(
      `the entitlements read ${JSON.stringify(got)} for ${ASSOCIATED_DOMAINS_KEY}, not ${wantValue(domains)}. ` +
        `This is a bug in inject-associated-domains.mjs, not in the file.`
    );
  }
}

/**
 * Create or update the entitlements. `xml` null means the file does not exist.
 * An existing associated-domains value that is not ours is REFUSED, never
 * rewritten: somebody wrote it on purpose, and a silent replacement would
 * change which links open the app.
 *
 * @returns {{xml: string, changed: boolean, reason: string}}
 */
export function injectEntitlements(xml, domains = applinksDomains()) {
  if (xml === null || isEmptyRootDict(xml)) {
    const out = renderEntitlements(domains);
    assertEntitled(out, domains);
    return { xml: out, changed: true, reason: `${xml === null ? "written" : "filled the empty file"} with ${domains.join(", ")}` };
  }
  const got = associatedDomainsValue(xml);
  if (got === wantValue(domains)) return { xml, changed: false, reason: `${ASSOCIATED_DOMAINS_KEY} already ${domains.join(", ")}` };
  if (got !== null) {
    throw new PlistError(
      `${ASSOCIATED_DOMAINS_KEY} is already ${got}, which this script did not write. Change it by hand, deliberately.`
    );
  }
  const { rootDict, entries } = rootEntries(xml);
  const indent = rootIndent(xml, entries);
  const eol = xml.includes("\r\n") ? "\r\n" : "\n";
  const block =
    `${indent}<key>${ASSOCIATED_DOMAINS_KEY}</key>${eol}${indent}<array>${eol}` +
    domains.map((d) => `${indent}${indent}<string>${d}</string>${eol}`).join("") +
    `${indent}</array>${eol}`;
  let at = rootDict.closeStart;
  while (at > 0 && (xml[at - 1] === " " || xml[at - 1] === "\t")) at--;
  const out = xml.slice(0, at) + block + xml.slice(at);
  assertEntitled(out, domains);
  return { xml: out, changed: true, reason: `added ${ASSOCIATED_DOMAINS_KEY} = ${domains.join(", ")}` };
}

/* ------------------------------------------------------------- the pbxproj */

const str = (node, key) => {
  const v = node && node.type === "dict" ? node.entries.get(key) : undefined;
  return v && v.type === "string" ? v.value : undefined;
};
const idsOf = (node) => (node && node.type === "array" ? node.items.filter((n) => n.type === "string").map((n) => n.value) : []);

/**
 * The application target's build configurations, each with its buildSettings
 * dict node. Throws on any shape it cannot be sure of (not exactly one app
 * target, a missing configuration list, a configuration with no buildSettings)
 * because guessing there is how a setting lands on a target nothing signs.
 */
export function appConfigurations(text) {
  const { objects } = parsePbxproj(text);
  const apps = [...objects].filter(
    ([, o]) => str(o, "isa") === "PBXNativeTarget" && str(o, "productType") === "com.apple.product-type.application"
  );
  if (apps.length !== 1) {
    throw new PbxprojError(`expected exactly one application target, found ${apps.length}. Refusing to guess which one ships.`);
  }
  const listId = str(apps[0][1], "buildConfigurationList");
  const list = listId && objects.get(listId);
  if (str(list, "isa") !== "XCConfigurationList") throw new PbxprojError("the application target has no XCConfigurationList.");
  const ids = idsOf(list.entries.get("buildConfigurations"));
  if (!ids.length) throw new PbxprojError("the application target has no build configurations.");
  return ids.map((id) => {
    const c = objects.get(id);
    if (str(c, "isa") !== "XCBuildConfiguration") throw new PbxprojError(`${id} is not an XCBuildConfiguration.`);
    const settings = c.entries.get("buildSettings");
    if (!settings || settings.type !== "dict") throw new PbxprojError(`build configuration ${str(c, "name") ?? id} has no buildSettings dict.`);
    return {
      id,
      name: str(c, "name") ?? id,
      settings,
      bundleId: str(settings, "PRODUCT_BUNDLE_IDENTIFIER"),
      entitlements: str(settings, "CODE_SIGN_ENTITLEMENTS"),
    };
  });
}

/** The App target's PRODUCT_BUNDLE_IDENTIFIER. Every configuration must name
 *  the same one: Debug and Release disagreeing means the caller has to say
 *  which build it is (`--bundle-id`), not this script. */
export function projectBundleId(text) {
  const ids = [...new Set(appConfigurations(text).map((c) => c.bundleId))];
  if (ids.length !== 1 || !ids[0]) {
    throw new PbxprojError(`the application target's configurations name ${JSON.stringify(ids)} as PRODUCT_BUNDLE_IDENTIFIER, not one id. Pass --bundle-id.`);
  }
  return ids[0];
}

/** Everything wrong with the CODE_SIGN_ENTITLEMENTS wiring, as sentences. */
export function wiringProblems(text) {
  let configs;
  try {
    configs = appConfigurations(text);
  } catch (e) {
    return [e.message];
  }
  return configs
    .filter((c) => c.entitlements !== ENTITLEMENTS_SETTING)
    .map((c) => `${c.name}: CODE_SIGN_ENTITLEMENTS is ${JSON.stringify(c.entitlements ?? null)}, not ${ENTITLEMENTS_SETTING}.`);
}

/** Throw unless every App configuration signs with our entitlements file.
 *  MUTATION: `return;` as its first line -- the pbxproj "insertion that does
 *  not land" test fails. */
export function assertWired(text) {
  const p = wiringProblems(text);
  if (p.length) {
    throw new PbxprojError(`the edit did not take:\n  ${p.join("\n  ")}\nThis is a bug in inject-associated-domains.mjs, not in the project.`);
  }
}

/**
 * Set CODE_SIGN_ENTITLEMENTS on every App configuration that lacks it, in
 * Xcode's own key order (it sorts buildSettings), with the indentation of the
 * line it lands beside. A configuration that already names a DIFFERENT file is
 * refused: that file is someone's, and the entitlement would go in the wrong one.
 *
 * @returns {{text: string, changed: boolean, reason: string}}
 */
export function injectPbxproj(text) {
  const configs = appConfigurations(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const edits = [];
  for (const c of configs) {
    if (c.entitlements === ENTITLEMENTS_SETTING) continue;
    if (c.entitlements !== undefined) {
      throw new PbxprojError(`${c.name} already signs with CODE_SIGN_ENTITLEMENTS = ${c.entitlements}; refusing to repoint it.`);
    }
    const keys = [...c.settings.entries.keys()];
    const after = keys.find((k) => k > "CODE_SIGN_ENTITLEMENTS");
    let at;
    if (after !== undefined) {
      /* A key and its value share a line in every pbxproj Xcode writes, so the
         line holding the value is the line the key starts. */
      at = text.lastIndexOf("\n", c.settings.entries.get(after).start - 1) + 1;
    } else {
      at = c.settings.end - 1; // the "}"
      while (at > 0 && (text[at - 1] === " " || text[at - 1] === "\t")) at--;
    }
    const lineIndent = /^[ \t]*/.exec(text.slice(at))[0];
    const closeIndent = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", c.settings.end - 2) + 1))[0];
    const indent = after !== undefined ? lineIndent : `${closeIndent}\t`;
    edits.push({ at, insert: `${indent}CODE_SIGN_ENTITLEMENTS = ${ENTITLEMENTS_SETTING};${eol}`, name: c.name });
  }
  if (!edits.length) {
    assertWired(text);
    return { text, changed: false, reason: `CODE_SIGN_ENTITLEMENTS already ${ENTITLEMENTS_SETTING} on ${configs.map((c) => c.name).join(", ")}` };
  }
  let out = text;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.insert + out.slice(e.at);
  assertWired(out);
  return { text: out, changed: true, reason: `set CODE_SIGN_ENTITLEMENTS = ${ENTITLEMENTS_SETTING} on ${edits.map((e) => e.name).join(", ")}` };
}

/* ------------------------------------------------------------------ the CLI */

/** The two files `<iosApp>` (mobile/ios/App) holds that this edits. */
export function pathsFor(iosApp) {
  return {
    entitlements: path.join(iosApp, ENTITLEMENTS_SETTING),
    pbxproj: path.join(iosApp, "App.xcodeproj", "project.pbxproj"),
  };
}

function readFlag(flagFile) {
  return parseFlag(fs.readFileSync(flagFile, "utf8"), path.relative(ROOT, flagFile) || flagFile);
}

function bundleIdFor(pbx, bundleId) {
  return bundleId ?? projectBundleId(pbx);
}

/** Every entitlements file the App target could sign with that claims the
 *  entitlement: ours, plus whatever CODE_SIGN_ENTITLEMENTS names. Used when
 *  the switch is off, where any claim at all is a build Apple will refuse. */
function claimsWhileOff(iosApp, pbx) {
  const files = new Set([ENTITLEMENTS_SETTING]);
  for (const c of appConfigurations(pbx)) if (c.entitlements) files.add(c.entitlements);
  const out = [];
  for (const rel of files) {
    const f = path.join(iosApp, rel);
    if (fs.existsSync(f) && associatedDomainsValue(fs.readFileSync(f, "utf8")) !== null) out.push(f);
  }
  return out;
}

/** Write (when the switch and the bundle id both say so). Reads and checks
 *  everything before writing anything, so a project it refuses is untouched. */
export function runInject(iosApp, { flagFile = FLAG_FILE, bundleId } = {}) {
  const flag = readFlag(flagFile);
  const p = pathsFor(iosApp);
  if (!fs.existsSync(p.pbxproj)) throw new PbxprojError(`${p.pbxproj} does not exist: run after cap add ios`);
  const pbx = fs.readFileSync(p.pbxproj, "utf8");
  const id = bundleIdFor(pbx, bundleId);
  const d = decide({ enabled: flag.enabled, bundleId: id });
  if (!d.act) {
    /* The no-op is VERIFIED, not assumed: an entitlement that is already
       there (a hand edit, a future template) would still make Apple refuse
       to sign, so it fails here rather than at the archive. */
    const claims = claimsWhileOff(iosApp, pbx);
    if (claims.length) {
      throw new PlistError(`${claims.join(", ")} already claim ${ASSOCIATED_DOMAINS_KEY}, but ${d.reason.replace(/; nothing written$/, "")}.`);
    }
    return [`${p.entitlements}: ${d.reason}`];
  }
  const had = fs.existsSync(p.entitlements) ? fs.readFileSync(p.entitlements, "utf8") : null;
  const e = injectEntitlements(had);
  const r = injectPbxproj(pbx);
  if (e.changed) fs.writeFileSync(p.entitlements, e.xml);
  if (r.changed) fs.writeFileSync(p.pbxproj, r.text);
  return [`${p.entitlements}: ${e.reason}`, `${p.pbxproj}: ${r.reason}`];
}

/** `--check`: when on, the entitlement and its wiring are there; when off (or
 *  not the release id), nothing claims it. */
export function runCheck(iosApp, { flagFile = FLAG_FILE, bundleId } = {}) {
  const flag = readFlag(flagFile);
  const p = pathsFor(iosApp);
  if (!fs.existsSync(p.pbxproj)) throw new PbxprojError(`${p.pbxproj} does not exist.`);
  const pbx = fs.readFileSync(p.pbxproj, "utf8");
  const id = bundleIdFor(pbx, bundleId);
  const d = decide({ enabled: flag.enabled, bundleId: id });
  if (!d.act) {
    const claims = claimsWhileOff(iosApp, pbx);
    if (claims.length) throw new PlistError(`${claims.join(", ")} claim ${ASSOCIATED_DOMAINS_KEY} while it should be off (${id}).`);
    return [`${p.entitlements}: off for ${id}, and nothing claims ${ASSOCIATED_DOMAINS_KEY}`];
  }
  const problems = [];
  if (!fs.existsSync(p.entitlements)) problems.push(`${p.entitlements} does not exist.`);
  else {
    try {
      assertEntitled(fs.readFileSync(p.entitlements, "utf8"));
    } catch (e) {
      problems.push(`${p.entitlements}: ${e.message}`);
    }
  }
  problems.push(...wiringProblems(pbx).map((s) => `${p.pbxproj}: ${s}`));
  if (problems.length) throw new PbxprojError(problems.join("\n"));
  return [`${p.entitlements}: ${ASSOCIATED_DOMAINS_KEY} = ${applinksDomains().join(", ")}, signed by every App configuration`];
}

const isMain = isEntryScript(import.meta.url);

const USAGE = "Usage: node tools/mobile/inject-associated-domains.mjs <mobile/ios/App> [--check] [--bundle-id <id>]";

if (isMain) {
  const argv = process.argv.slice(2);
  let target = null;
  let check = false;
  let bundleId;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") check = true;
    else if (a === "--bundle-id") {
      bundleId = argv[++i];
      /* A flag is never a value: `--bundle-id --check` must not sign as "--check". */
      if (!bundleId || bundleId.startsWith("-")) {
        console.error(`--bundle-id needs a value, got ${bundleId === undefined ? "nothing" : bundleId}`);
        process.exit(2);
      }
    } else if (!a.startsWith("-") && target === null) target = a;
    else {
      console.error(`Unknown argument: ${a}`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  if (!target) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const lines = check ? runCheck(target, { bundleId }) : runInject(target, { bundleId });
    for (const l of lines) console.log(l);
  } catch (e) {
    console.error(`inject-associated-domains failed: ${e.message}`);
    process.exit(1);
  }
}
