/* `tools/mobile/lab-variant.mjs` — the "4a Lab" build variant (Redesign 2026,
 * phase 0e; docs/redesign-2026/PLAN.md).
 *
 * WHAT IS AT STAKE. A lab build is a SECOND app on a founder's phone. Three ways
 * it goes wrong, each pinned below: it lands on the REAL app's identity and
 * overwrites it (config), it is indistinguishable from the real app on the home
 * screen (icon), or its flag arrives after app.js has already signed a user up
 * in production (the head script is classic, not a module). And the mirror image:
 * with the variant OFF, the real config, icon and bundle are untouched.
 *
 * Wiring of the flag into prepare() is pinned in prepare-webdir.test.mjs ("lab:"
 * tests); app.js's three gates are pinned in test/lab-flag.test.js; the workflow
 * in tools/mobile/lab-workflow.test.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { decode, header } from "../brand/png.mjs";
import {
  REPO_ROOT, LAB_APP_ID, LAB_APP_NAME, REAL_APP_ID, LAB_FLAG_TAG, LAB_FLAG_SOURCE,
  labConfigText, applyLabConfig, injectLabFlag, assertLabFlagPresent,
  badgeImage, labIconBytes, BAND_TOP, BAND_BOTTOM, BAND_RGB, LabError,
} from "./lab-variant.mjs";
import { assertAppStoreLegalSource, planAppIcon } from "./inject-app-icon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_CONFIG = path.join(REPO_ROOT, "mobile", "capacitor.config.json");
const ICON = path.join(REPO_ROOT, "icon-1024.png");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lab-variant-"));

/* ──────────────────────────────── the config ───────────────────────────── */

test("the real config is the real app, and the lab names are what the plan says", () => {
  /* Pins the PREMISE of labConfigText: if the real appId ever changes, the lab
     transform must be re-thought rather than silently keep working. */
  const real = JSON.parse(fs.readFileSync(REAL_CONFIG, "utf8"));
  assert.equal(real.appId, REAL_APP_ID);
  assert.equal(real.appId, "ai.jwlabs.foura");
  assert.equal(LAB_APP_ID, "ai.jwlabs.foura.lab");
  assert.equal(LAB_APP_NAME, "4a Lab");
});

test("labConfigText overrides appId and appName and keeps every other key", () => {
  /* MUTATION: drop `doc.appName = LAB_APP_NAME` -> the lab app is still called
     "4a" on the home screen (red here); drop `doc.appId = LAB_APP_ID` -> it
     installs OVER the real app (red). */
  const src = fs.readFileSync(REAL_CONFIG, "utf8");
  const real = JSON.parse(src);
  const lab = JSON.parse(labConfigText(src));
  assert.equal(lab.appId, "ai.jwlabs.foura.lab");
  assert.equal(lab.appName, "4a Lab");
  const { appId: _a, appName: _n, ...restReal } = real;
  const { appId: _a2, appName: _n2, ...restLab } = lab;
  assert.deepEqual(restLab, restReal, "the transform changed something besides the identity");
  assert.equal(lab.zoomEnabled, false, "the founders' no-zoom ruling must survive the lab config");
});

test("labConfigText is idempotent and refuses a config that is not the real app's", () => {
  const once = labConfigText(fs.readFileSync(REAL_CONFIG, "utf8"));
  assert.equal(labConfigText(once), once);
  assert.throws(() => labConfigText(JSON.stringify({ appId: "com.example.other", appName: "x" })), LabError);
  assert.throws(() => labConfigText("{not json"), /not valid JSON/);
  assert.throws(() => labConfigText("[]"), /not a JSON object/);
});

test("applyLabConfig rewrites a COPY on disk and reads it back; the repo's config is untouched", () => {
  const dir = tmp();
  const copy = path.join(dir, "capacitor.config.json");
  fs.copyFileSync(REAL_CONFIG, copy);
  const before = fs.readFileSync(REAL_CONFIG);
  const r = applyLabConfig(copy);
  assert.equal(r.changed, true);
  assert.equal(JSON.parse(fs.readFileSync(copy, "utf8")).appId, LAB_APP_ID);
  assert.equal(applyLabConfig(copy).changed, false);
  assert.ok(fs.readFileSync(REAL_CONFIG).equals(before), "the repo's real config was modified");
});

/* ──────────────────────────────── the web flag ─────────────────────────── */

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script src="app.js"></script></body></html>`;

test("the flag is one line of JavaScript and a CLASSIC script, not a module", () => {
  /* MUTATION: `<script type="module" src=...>` -> deferred past app.js, so the
     first sign-up in a lab build reads an undefined flag and POSTs to production. */
  assert.equal(LAB_FLAG_SOURCE, "window.__FORAY_LAB__ = true;\n");
  assert.equal(LAB_FLAG_TAG, '<script src="foray-lab.js"></script>');
  assert.ok(!/\btype=|\bdefer\b|\basync\b/.test(LAB_FLAG_TAG), "a deferred/async/module tag runs after app.js");
});

test("injectLabFlag puts the tag at the end of the head, once", () => {
  const r = injectLabFlag(HTML);
  assert.equal(r.changed, true);
  assert.ok(r.html.indexOf(LAB_FLAG_TAG) < r.html.indexOf("</head>"));
  assert.ok(r.html.indexOf(LAB_FLAG_TAG) < r.html.indexOf('src="app.js"'), "the flag must precede app.js");
  const again = injectLabFlag(r.html);
  assert.equal(again.changed, false);
  assert.equal(again.html, r.html);
  assert.doesNotThrow(() => assertLabFlagPresent(r.html));
});

test("injectLabFlag refuses to guess, and assertLabFlagPresent fails on a bundle without it", () => {
  assert.throws(() => injectLabFlag("<html><body></body></html>"), /no <\/head>/);
  assert.throws(() => injectLabFlag("<head></head><!-- </head> -->"), /more than once/);
  assert.throws(() => injectLabFlag(""), /empty/);
  assert.throws(() => assertLabFlagPresent(HTML), /does not carry/);
  /* in the body is too late */
  assert.throws(() => assertLabFlagPresent(HTML.replace("<body>", `<body>${LAB_FLAG_TAG}`)), /inside the head/);
});

/* ───────────────────────────────── the icon ────────────────────────────── */

test("the LAB icon is today's icon with a band, and nothing above the band changed", () => {
  /* MUTATION: return the input image unchanged from badgeImage -> the band is
     gone and a lab build is indistinguishable from the real app (red on the
     band-colour assertion). */
  const src = fs.readFileSync(ICON);
  const orig = decode(src);
  const lab = decode(labIconBytes(src));
  assert.equal(lab.width, orig.width);
  const y0 = Math.round(orig.height * BAND_TOP);
  const y1 = Math.round(orig.height * BAND_BOTTOM);
  const at = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
  assert.deepEqual(at(lab, 3, y0 + 3), BAND_RGB, "the band's colour is not on the band");
  /* every pixel outside the band rows is the real icon's, byte for byte */
  const stride = orig.width * 4;
  assert.ok(Buffer.from(lab.data.subarray(0, y0 * stride)).equals(Buffer.from(orig.data.subarray(0, y0 * stride))), "pixels above the band changed");
  assert.ok(Buffer.from(lab.data.subarray(y1 * stride)).equals(Buffer.from(orig.data.subarray(y1 * stride))), "pixels below the band changed");
  /* and the band carries ink (the letters), not just a flat bar */
  let ink = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < lab.width; x++) {
    const p = at(lab, x, y);
    if (p[0] < 0x40) ink++;
  }
  assert.ok(ink > 2000, `only ${ink} ink pixels in the band; the letters are missing`);
});

test("the LAB icon is App-Store-legal and flows through inject-app-icon's planner at every size", () => {
  /* The iOS path hands this to `inject-app-icon.mjs --source`, which refuses
     an alpha channel or a wrong size. MUTATION: encode without `{ rgb: true }`
     -> colour type 6 -> assertAppStoreLegalSource throws (red). */
  const bytes = labIconBytes(fs.readFileSync(ICON));
  assert.doesNotThrow(() => assertAppStoreLegalSource(bytes));
  const h = header(bytes);
  assert.equal(h.colour, 2);
  assert.equal(h.width, 1024);
  const contents = JSON.stringify({ images: [{ filename: "a.png", size: "1024x1024", scale: "1x" }, { filename: "b.png", size: "60x60", scale: "3x" }] });
  const plan = planAppIcon(contents, bytes);
  assert.deepEqual(plan.map((p) => p.px), [1024, 180]);
});

test("badgeImage refuses a non-square master and does not mutate its input", () => {
  assert.throws(() => badgeImage({ width: 4, height: 8, data: Buffer.alloc(4 * 8 * 4) }), LabError);
  const img = decode(fs.readFileSync(ICON));
  const copy = Buffer.from(img.data);
  badgeImage(img);
  assert.ok(Buffer.from(img.data).equals(copy));
});

/* ─────────────────────────────────── the CLI ───────────────────────────── */

test("CLI: apply-config and icon work end to end on temp copies", () => {
  const dir = tmp();
  const cfg = path.join(dir, "capacitor.config.json");
  fs.copyFileSync(REAL_CONFIG, cfg);
  const a = spawnSync(process.execPath, [path.join(HERE, "lab-variant.mjs"), "apply-config", cfg], { encoding: "utf8" });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(JSON.parse(fs.readFileSync(cfg, "utf8")).appId, LAB_APP_ID);
  const out = path.join(dir, "icon.png");
  const i = spawnSync(process.execPath, [path.join(HERE, "lab-variant.mjs"), "icon", out], { encoding: "utf8" });
  assert.equal(i.status, 0, i.stderr);
  assert.doesNotThrow(() => assertAppStoreLegalSource(fs.readFileSync(out)));
  const bad = spawnSync(process.execPath, [path.join(HERE, "lab-variant.mjs"), "nope"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});

test("inject-splash android takes --icon, so the launcher icon can be the LAB one", () => {
  /* MUTATION: drop the `--icon` branch in inject-splash.mjs's CLI -> "Unknown
     argument", and the lab Android build would ship the real icon. */
  const src = fs.readFileSync(path.join(HERE, "inject-splash.mjs"), "utf8");
  assert.match(src, /a === "--icon"/);
  assert.match(src, /injectAndroid\(dir, \{ checkOnly, icon \}\)/);
});
