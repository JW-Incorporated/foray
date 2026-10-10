#!/usr/bin/env node
/* Every privacy manifest in a BUILT `App.app`, as a table, and a red exit when a
 * bundled plugin that uses a Required Reason API is covered by no manifest at all.
 *
 * ── WHY THIS EXISTS (issue #948, its 2026-10-05 comment) ────────────────────
 * #1014 gave the app target its own `PrivacyInfo.xcprivacy`, and
 * `inject-privacy-manifest.mjs --bundle` asserts that manifest reached the built
 * bundle and says what we declare. What #948 still owes is the other half of
 * Xcode's "Generate Privacy Report": the AGGREGATE — which manifests every
 * embedded framework and resource bundle brings with it, and whether each
 * plugin that calls a Required Reason API is covered by one. That report is a
 * Mac-and-Organizer step nobody can run from this repo's Windows machine. This
 * is the part of it CI can do: walk the bundle, list what is there, and fail on
 * the one gap that is knowable without Xcode.
 *
 * It is NOT a replacement for the Xcode report, and #948 stays open for that.
 * Apple's aggregation also reads manifests out of statically linked SDKs'
 * metadata, which no file walk sees.
 *
 * ── WHAT IT PRINTS ──────────────────────────────────────────────────────────
 * One row per bundle — the app itself, each `*.framework`, `*.bundle` and
 * `*.appex` under it — with whether a `PrivacyInfo.xcprivacy` sits at that
 * bundle's root and which `NSPrivacyAccessedAPITypes` it declares (with reason
 * codes). A manifest found anywhere that is NOT a bundle root gets a row of its
 * own marked "stray": Xcode does not read it there. `public/` (the web app,
 * thousands of files and no bundles) and `_CodeSignature/` are not walked.
 * Rows are sorted, so two runs' artifacts diff cleanly.
 *
 * ── WHAT FAILS IT ───────────────────────────────────────────────────────────
 * `REQUIRED_REASON_PLUGINS` below: third-party plugins KNOWN to call a Required
 * Reason API. Today that is @capacitor/preferences — pure
 * `UserDefaults.standard` (8.0.x `Preferences.swift` and `PreferencesPlugin.swift`,
 * read 2026-10-07 from the npm tarball) with no `PrivacyInfo.xcprivacy` in its
 * package and no `resources:` in its Package.swift. For each one that is
 * BUNDLED, every category it uses must be declared, with at least one reason
 * code, by either
 *   - its own manifest (in a bundle named in `ownBundles` — where SwiftPM or a
 *     dynamic framework would put one if a future release ships it), or
 *   - the app target's manifest at the root of `App.app`.
 * Neither is ITMS-91053 "Missing API declaration" at submission, after
 * TestFlight has already taken the build.
 *
 * Our own plugins (foray-audio, foray-vault, foray-tts) are not listed: their
 * Required Reason calls are the evidence `inject-privacy-manifest.mjs` declares
 * from, and its suite re-greps their Swift on every run.
 *
 * ── HOW "BUNDLED" IS KNOWN, AND WHY IT CANNOT PASS BY NOT LOOKING ───────────
 * A SwiftPM plugin is a static library: it leaves no directory in `App.app`. What
 * it does leave is its class name in `capacitor.config.json`'s
 * `packageClassList`, which `cap sync`/`cap add ios` write
 * (`@capacitor/cli` dist/util/iosplugin.js, `generateIOSPackageJSON`: the first
 * `@objc(Name)` of each plugin Swift file) and which the app reads at launch to
 * register plugins. No `capacitor.config.json`, or no `packageClassList` in it,
 * is an ERROR, not "nothing bundled".
 *
 * A renamed plugin class would make the plugin look unbundled and the check pass
 * green. `--mobile <dir>` closes that: every listed plugin that `<dir>/package.json`
 * depends on must appear in `packageClassList`, or the run fails saying this
 * file's class name is stale. ios-build.yml passes `--mobile mobile`.
 *
 * USAGE
 *   node tools/mobile/privacy-manifest-report.mjs <path/to/App.app> [--mobile <mobile>]
 * Exit 0: table printed, every bundled listed plugin covered. Exit 1: a gap (or a
 * bundle that cannot be judged). Exit 2: bad arguments.
 *
 * Manifests are read as text when they are XML and through `plutil` (macOS only)
 * when they are binary plists, so the suite runs on Windows over XML fixtures.
 */

import fs from "node:fs";
import path from "node:path";
import { isEntryScript } from "../ci/entry.mjs";
import { MANIFEST_NAME, decodePlist } from "./inject-privacy-manifest.mjs";
import { isBinaryPlist, readPlistXml } from "./ios-embedded-frameworks.mjs";

/** Thrown when the bundle cannot be judged at all (as opposed to judged and found wanting). */
export class ReportError extends Error {}

const USER_DEFAULTS = "NSPrivacyAccessedAPICategoryUserDefaults";

/**
 * Third-party plugins known to call a Required Reason API. `pluginClass` is the
 * name `packageClassList` carries (the plugin's `@objc(...)`); `ownBundles` are
 * the bundle directory names its own manifest would arrive in.
 */
export const REQUIRED_REASON_PLUGINS = Object.freeze([
  Object.freeze({
    npm: "@capacitor/preferences",
    pluginClass: "PreferencesPlugin",
    categories: Object.freeze([USER_DEFAULTS]),
    ownBundles: Object.freeze([
      "CapacitorPreferences_PreferencesPlugin.bundle",
      "CapacitorPreferences.framework",
      "PreferencesPlugin.framework",
      "CapacitorPreferences.bundle",
    ]),
  }),
]);

const BUNDLE_EXT = /\.(app|framework|bundle|appex)$/;
const SKIP_AT_APP_ROOT = new Set(["public", "_CodeSignature"]);

/** A manifest's text as XML: XML plists are read directly, binary ones through
 *  `plutil` (which only a Mac has). */
export function readManifest(file) {
  const buf = fs.readFileSync(file);
  return isBinaryPlist(buf) ? readPlistXml(file) : buf.toString("utf8");
}

/**
 * What a manifest says about Required Reason APIs.
 * @returns {{ok: true, declared: Map<string, string[]>, hasKey: boolean} | {ok: false, error: string}}
 *   `declared` holds only categories given at least one reason code.
 */
export function readDeclarations(xml) {
  let m;
  try {
    m = decodePlist(xml);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const apis = m.NSPrivacyAccessedAPITypes;
  const declared = new Map();
  if (Array.isArray(apis)) {
    for (const a of apis) {
      if (!a || typeof a.NSPrivacyAccessedAPIType !== "string") continue;
      const reasons = Array.isArray(a.NSPrivacyAccessedAPITypeReasons)
        ? a.NSPrivacyAccessedAPITypeReasons.filter((r) => typeof r === "string" && r.trim())
        : [];
      if (!reasons.length) continue;
      declared.set(a.NSPrivacyAccessedAPIType, [...(declared.get(a.NSPrivacyAccessedAPIType) ?? []), ...reasons]);
    }
  }
  return { ok: true, declared, hasKey: Array.isArray(apis) };
}

/**
 * Every bundle in `appDir` (the app itself first) plus every stray manifest.
 * @returns {{rel: string, kind: string, manifest: string|null}[]}
 */
export function findBundles(appDir) {
  const rows = [];
  const walk = (dir, rel, isBundleRoot, kind) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (isBundleRoot) {
      const m = path.join(dir, MANIFEST_NAME);
      rows.push({ rel, kind, manifest: fs.existsSync(m) ? m : null });
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const childRel = rel === "." ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (rel === "." && SKIP_AT_APP_ROOT.has(e.name)) continue;
        const ext = BUNDLE_EXT.exec(e.name);
        walk(full, childRel, !!ext, ext ? ext[1] : null);
      } else if (e.name === MANIFEST_NAME && !isBundleRoot) {
        rows.push({ rel: childRel, kind: "stray", manifest: full });
      }
    }
  };
  walk(appDir, ".", true, "app");
  const [app, ...rest] = rows;
  return [app, ...rest.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))];
}

/** The class names `cap` wrote into the bundle's `capacitor.config.json`. */
export function packageClassList(appDir) {
  const file = path.join(appDir, "capacitor.config.json");
  if (!fs.existsSync(file)) {
    throw new ReportError(
      `${file} is missing, so there is no way to tell which plugins are bundled. A check that cannot see its subject must not pass.`
    );
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ReportError(`${file} is not JSON: ${e.message}`);
  }
  const list = json && json.packageClassList;
  if (!Array.isArray(list) || !list.every((c) => typeof c === "string")) {
    throw new ReportError(`${file} has no packageClassList array (cap sync writes one); refusing to guess which plugins are bundled.`);
  }
  return list;
}

const short = (category) => category.replace("NSPrivacyAccessedAPICategory", "");

/**
 * The report. Never throws for a gap — gaps are `failures` — only for a bundle
 * that cannot be judged at all.
 * @param {string} appDir
 * @param {{read?: (file: string) => string, mobileDir?: string|null, plugins?: typeof REQUIRED_REASON_PLUGINS}} [opts]
 * @returns {{lines: string[], failures: string[]}}
 */
export function report(appDir, { read = readManifest, mobileDir = null, plugins = REQUIRED_REASON_PLUGINS } = {}) {
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) throw new ReportError(`no such bundle: ${appDir}`);
  const classes = packageClassList(appDir);
  const bundles = findBundles(appDir).map((b) => {
    if (!b.manifest) return { ...b, decl: null };
    let xml;
    try {
      xml = read(b.manifest);
    } catch (e) {
      return { ...b, decl: { ok: false, error: e.message } };
    }
    return { ...b, decl: readDeclarations(xml) };
  });

  const apiCell = (b) => {
    if (!b.decl) return "-";
    if (!b.decl.ok) return `UNREADABLE (${b.decl.error})`;
    if (!b.decl.hasKey) return "not declared";
    if (!b.decl.declared.size) return "(none)";
    return [...b.decl.declared].map(([c, r]) => `${short(c)} ${r.join(",")}`).join("; ");
  };
  const header = ["bundle", "kind", "PrivacyInfo", "NSPrivacyAccessedAPITypes"];
  const table = bundles.map((b) => [b.rel === "." ? "App.app" : b.rel, b.kind, b.manifest ? "yes" : "no", apiCell(b)]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  const lines = [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...table.map(fmt)];

  const failures = [];
  const declares = (b, category) => !!(b && b.kind !== "stray" && b.decl && b.decl.ok && b.decl.declared.has(category));
  const app = bundles[0];
  const deps = mobileDir ? dependenciesOf(mobileDir) : null;
  lines.push("");
  for (const p of plugins) {
    const label = `${p.npm} (${p.pluginClass})`;
    if (!classes.includes(p.pluginClass)) {
      if (deps && deps.has(p.npm)) {
        failures.push(
          `${label}: ${path.join(mobileDir, "package.json")} depends on it but packageClassList does not list ${p.pluginClass}. ` +
            `Either the class was renamed (update REQUIRED_REASON_PLUGINS in privacy-manifest-report.mjs) or cap sync did not run; ` +
            `either way this check would pass by not looking.`
        );
        lines.push(`${label}: declared in package.json but NOT in packageClassList`);
      } else {
        lines.push(`${label}: not bundled`);
      }
      continue;
    }
    const own = bundles.filter((b) => b.kind !== "stray" && p.ownBundles.includes(path.basename(b.rel)));
    for (const category of p.categories) {
      const ownHit = own.find((b) => declares(b, category));
      if (ownHit) lines.push(`${label}: ${short(category)} covered by its own manifest (${ownHit.rel})`);
      else if (declares(app, category)) lines.push(`${label}: ${short(category)} covered by the app target's manifest`);
      else {
        lines.push(`${label}: ${short(category)} NOT COVERED`);
        failures.push(
          `${label} is bundled and uses ${category}, but neither its own manifest ` +
            `(${own.length ? own.map((b) => b.rel).join(", ") : `none of ${p.ownBundles.join(", ")} is in the bundle`}) ` +
            `nor the app target's ${MANIFEST_NAME} declares it with a reason code. App Store Connect rejects this at submission (ITMS-91053).`
        );
      }
    }
  }
  return { lines, failures };
}

/** The dependency names in `<mobileDir>/package.json`. */
export function dependenciesOf(mobileDir) {
  const file = path.join(mobileDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ReportError(`--mobile: cannot read ${file}: ${e.message}`);
  }
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
}

const isMain = isEntryScript(import.meta.url);

const USAGE = "Usage: node tools/mobile/privacy-manifest-report.mjs <path/to/App.app> [--mobile <mobile>]";

if (isMain) {
  const argv = process.argv.slice(2);
  let target = null;
  let mobileDir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mobile") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-") || mobileDir !== null) {
        console.error(USAGE);
        process.exit(2);
      }
      mobileDir = v;
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
    const { lines, failures } = report(target, { mobileDir });
    for (const l of lines) console.log(l);
    if (failures.length) {
      console.error(`privacy-manifest-report: ${failures.length} gap(s):\n  ${failures.join("\n  ")}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`privacy-manifest-report failed: ${e.message}`);
    process.exit(1);
  }
}
