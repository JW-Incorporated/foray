#!/usr/bin/env node
/* The "4a Lab" variant of the mobile build (Redesign 2026, phase 0e;
 * docs/redesign-2026/PLAN.md).
 *
 * WHAT IT IS. A second app, installed BESIDE the real one, so a founder can try
 * a redesign on a phone without touching the shipping app: iOS bundle id and
 * Android applicationId `ai.jwlabs.foura.lab`, display name `4a Lab`, today's
 * icon with a LAB band across it, and `window.__FORAY_LAB__ = true` in the web
 * bundle (which makes app.js skip anonymous sign-up, token refresh and event
 * POSTs, so a lab build never writes to production).
 *
 * WHAT IT IS NOT. A fork. Every function here is a pure transform that the CI
 * lab path (`.github/workflows/lab-build.yml`, through the ios-archive and
 * android-bundle actions' `lab` input) applies to the CHECKED-OUT tree, and
 * with the variant off NOTHING in the real build changes: prepare-webdir.mjs
 * adds the flag only when asked (`FORAY_LAB=1` or `prepare({ lab: true })`),
 * and nothing in the real workflows calls this file. The tests pin both halves
 * (tools/mobile/lab-variant.test.mjs, prepare-webdir.test.mjs "lab").
 *
 * USAGE
 *   node tools/mobile/lab-variant.mjs apply-config [mobile/capacitor.config.json]
 *   node tools/mobile/lab-variant.mjs icon <out.png> [--source icon-1024.png]
 *
 * `apply-config` rewrites the checked-out config's appId and appName in place
 * (the CI checkout is throwaway; never run it in a working tree you keep).
 * `icon` writes the LAB-badged 1024 master; hand it to
 * `inject-app-icon.mjs --source` (iOS) and `inject-splash.mjs android --icon`.
 *
 * NO NEW ICON IS DESIGNED HERE. The band is drawn on today's master in code
 * (owner decision 4: the app icon is out of scope).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decode, encode } from "../brand/png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

export const LAB_APP_ID = "ai.jwlabs.foura.lab";
export const LAB_APP_NAME = "4a Lab";
/** What the real app is, so `labConfig` can refuse to run on something else. */
export const REAL_APP_ID = "ai.jwlabs.foura";

/** The global the web bundle carries and app.js reads (`isLabBuild()`). */
export const LAB_FLAG = "__FORAY_LAB__";
/** Where the flag script lands in the bundle root. */
export const LAB_FLAG_FILE = "foray-lab.js";
export const LAB_FLAG_SOURCE = `window.${LAB_FLAG} = true;\n`;
/** A CLASSIC (not module) script: module scripts are deferred and would run
 *  AFTER app.js, which reads the flag on its first sign-up. */
export const LAB_FLAG_TAG = `<script src="${LAB_FLAG_FILE}"></script>`;

export class LabError extends Error {}

/* ------------------------------------------------------------- the config */

/** `capacitor.config.json`'s source text with the lab identity, everything else
 *  byte-for-byte (the `//` comment keys and their order survive). */
export function labConfigText(src) {
  let doc;
  try {
    doc = JSON.parse(src);
  } catch (e) {
    throw new LabError(`capacitor.config.json is not valid JSON: ${e.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new LabError("capacitor.config.json is not a JSON object");
  }
  if (doc.appId === LAB_APP_ID) return src; // idempotent
  if (doc.appId !== REAL_APP_ID) {
    throw new LabError(
      `capacitor.config.json appId is ${JSON.stringify(doc.appId)}, not the real app's ` +
        `${REAL_APP_ID}. Refusing to guess which app this is.`
    );
  }
  doc.appId = LAB_APP_ID;
  doc.appName = LAB_APP_NAME;
  return JSON.stringify(doc, null, 2) + "\n";
}

export function applyLabConfig(file) {
  const src = fs.readFileSync(file, "utf8");
  const out = labConfigText(src);
  if (out !== src) fs.writeFileSync(file, out);
  const back = JSON.parse(fs.readFileSync(file, "utf8"));
  if (back.appId !== LAB_APP_ID || back.appName !== LAB_APP_NAME) {
    throw new LabError(`${file} does not carry the lab identity after the write`);
  }
  return { changed: out !== src, appId: back.appId, appName: back.appName };
}

/* ------------------------------------------------------------ the web flag */

/** Add the lab flag's `<script>` immediately before `</head>`, ahead of every
 *  script in the body. Idempotent. Throws rather than guess on a missing or
 *  duplicated anchor, like `injectShellScripts` in prepare-webdir.mjs. */
export function injectLabFlag(html) {
  if (typeof html !== "string" || html.trim() === "") throw new LabError("empty index.html source");
  const first = html.indexOf("</head>");
  if (first < 0) throw new LabError("index.html has no </head>, so there is nowhere to put the lab flag");
  if (html.indexOf("</head>", first + 7) >= 0) throw new LabError("index.html contains </head> more than once");
  if (html.includes(LAB_FLAG_TAG)) return { html, changed: false };
  return { html: html.slice(0, first) + LAB_FLAG_TAG + "\n" + html.slice(first), changed: true };
}

/** The tag must sit in the head and precede the first body script (app.js). */
export function assertLabFlagPresent(html) {
  const head = html.indexOf("</head>");
  const at = html.indexOf(LAB_FLAG_TAG);
  if (head < 0 || at < 0 || at > head) {
    throw new LabError(`the lab bundle's index.html does not carry ${LAB_FLAG_TAG} inside the head`);
  }
}

/* ------------------------------------------------------------ the LAB icon */

/* 5x7 glyphs; only the three letters the badge needs. */
const GLYPHS = {
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
};
export const BADGE_TEXT = "LAB";
export const BAND_RGB = [0xf5, 0xb9, 0x42]; // amber, unmistakable beside the dark icon
export const INK_RGB = [0x15, 0x11, 0x19]; // the app's ground colour
/** Band geometry as fractions of the icon edge. Inside the central 66% that an
 *  Android adaptive mask keeps, and clear of an iOS squircle's corners. */
export const BAND_TOP = 0.7;
export const BAND_BOTTOM = 0.88;

/** Draw the LAB band onto a decoded RGBA image (a copy; the input is untouched). */
export function badgeImage(img) {
  const { width: w, height: h } = img;
  if (w !== h) throw new LabError(`the icon master must be square (got ${w}x${h})`);
  const data = Buffer.from(img.data);
  const y0 = Math.round(h * BAND_TOP);
  const y1 = Math.round(h * BAND_BOTTOM);
  const put = (x, y, rgb) => {
    const o = (y * w + x) * 4;
    data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
  };
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) put(x, y, BAND_RGB);

  const cells = BADGE_TEXT.length * 5 + (BADGE_TEXT.length - 1); // glyphs + 1-cell gaps
  const scale = Math.max(1, Math.floor(((y1 - y0) * 0.6) / 7));
  const tw = cells * scale;
  const tx = Math.round((w - tw) / 2);
  const ty = y0 + Math.round(((y1 - y0) - 7 * scale) / 2);
  [...BADGE_TEXT].forEach((ch, gi) => {
    const rows = GLYPHS[ch];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (rows[r][c] !== "1") continue;
        const px = tx + (gi * 6 + c) * scale;
        const py = ty + r * scale;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(px + dx, py + dy, INK_RGB);
      }
    }
  });
  return { width: w, height: h, data };
}

/** The badged master as PNG bytes: opaque 8-bit RGB (colour type 2), because the
 *  App Store rejects an icon with an alpha channel and inject-app-icon.mjs
 *  refuses one. */
export function labIconBytes(sourceBuf) {
  return encode(badgeImage(decode(sourceBuf)), { rgb: true });
}

export function writeLabIcon(out, source = path.join(REPO_ROOT, "icon-1024.png")) {
  const bytes = labIconBytes(fs.readFileSync(source));
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, bytes);
  return { out, bytes: bytes.length };
}

/* -------------------------------------------------------------------- CLI */

const USAGE =
  "Usage: node tools/mobile/lab-variant.mjs apply-config [capacitor.config.json]\n" +
  "       node tools/mobile/lab-variant.mjs icon <out.png> [--source icon-1024.png]";

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "apply-config") {
      const file = rest[0] || path.join(REPO_ROOT, "mobile", "capacitor.config.json");
      const r = applyLabConfig(file);
      console.log(`${file}: appId ${r.appId}, appName ${JSON.stringify(r.appName)}${r.changed ? "" : " (already)"}`);
    } else if (cmd === "icon") {
      let out = null, source;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--source") source = rest[++i];
        else if (!rest[i].startsWith("-") && out === null) out = rest[i];
        else { console.error(`Unknown argument: ${rest[i]}\n${USAGE}`); process.exit(2); }
      }
      if (!out) { console.error(USAGE); process.exit(2); }
      const r = writeLabIcon(out, source);
      console.log(`${r.out}: ${r.bytes} bytes`);
    } else {
      console.error(USAGE);
      process.exit(2);
    }
  } catch (e) {
    console.error(`lab-variant failed: ${e.message}`);
    process.exit(1);
  }
}
