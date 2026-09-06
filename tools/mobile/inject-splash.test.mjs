/* Tests for wiring 4a's splash screen and Android launcher icon into the
 * generated native projects (2026-09-06).
 *
 * EVERY TEST HERE RUNS ON WINDOWS, like `inject-app-icon.test.mjs` beside it:
 * `cap add` needs a Mac or the Android SDK, but "which files does the generated
 * project declare, and are those bytes ours" is a pure question about a manifest,
 * a directory listing and some PNGs.
 *
 * WHAT WENT WRONG. Every build to 2026-09-06 opened on Capacitor's placeholder
 * splash — `cap add` generates it and nothing replaced it — and on Android the
 * launcher icon was the placeholder too. Every check was green because nothing
 * looked. So, as in the icon suite, the load-bearing tests are the ones that
 * assert an ABSENCE of forgiveness: `--check` compares bytes, a listing with no
 * launcher icons is refused rather than half-fixed, and a template rename that
 * declares no files is an error rather than a no-op.
 *
 * MUTATION notes name the one-line edit that turns each test red; RUN them when
 * touching the injector.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decode, encode, header } from "../brand/png.mjs";
import {
  GROUND, INK, MARK_SPAN, IOS_SPLASH_PX, LAUNCH_BG_ITEM, SplashError, DEFAULT_LOGO, DEFAULT_ICON,
  coverageMap, markPlacement, renderSplash, renderSplashBytes, renderLauncherBytes, renderForegroundBytes,
  declaredSplashImages, planIosSplash, planAndroidRes, patchStylesXml, readResListing, injectIos, injectAndroid,
} from "./inject-splash.mjs";

/* ------------------------------------------------------------- fixtures */

/** A synthetic wordmark master: cream ground, one black bar in the middle. */
function syntheticMaster(w = 60, h = 30) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const ink = x >= 10 && x < 50 && y >= 10 && y < 20;
    data[i] = ink ? 10 : 252; data[i + 1] = ink ? 10 : 251; data[i + 2] = ink ? 10 : 246; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}
/** A synthetic square icon: cream with a dark centre square. */
function syntheticIcon(px = 256) {
  const data = Buffer.alloc(px * px * 4);
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const i = (y * px + x) * 4;
    const ink = x >= 64 && x < 192 && y >= 64 && y < 192;
    data[i] = ink ? 20 : 252; data[i + 1] = ink ? 30 : 251; data[i + 2] = ink ? 40 : 246; data[i + 3] = 255;
  }
  return { width: px, height: px, data };
}
function flat(w, h, rgb) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255; }
  return encode({ width: w, height: h, data }, { rgb: true });
}
function px(img, x, y) { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; }

/** Capacitor 8.5.1's `ios-spm-template` Splash.imageset/Contents.json, verbatim. */
const TEMPLATE_CONTENTS = JSON.stringify({
  images: [
    { idiom: "universal", filename: "splash-2732x2732-2.png", scale: "1x" },
    { idiom: "universal", filename: "splash-2732x2732-1.png", scale: "2x" },
    { idiom: "universal", filename: "splash-2732x2732.png", scale: "3x" },
  ],
  info: { version: 1, author: "xcode" },
});
/** Capacitor 8.5.1's android-template styles.xml launch style, verbatim. */
const TEMPLATE_STYLES = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="windowActionBar">false</item>
    </style>
    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/splash</item>
    </style>
</resources>`;

const master = syntheticMaster();
const icon = syntheticIcon();

/* ------------------------------------------------------------ rendering */

test("coverage is 0 on the master's ground and 255 on its ink", () => {
  const cov = coverageMap(master);
  assert.deepEqual(px(cov, 1, 1), [0, 0, 0]);
  assert.deepEqual(px(cov, 30, 15), [255, 255, 255]);
});

test("a master with no ink is refused rather than rendered as an empty splash", () => {
  const blank = { width: 8, height: 8, data: Buffer.alloc(256, 250) };
  assert.throws(() => coverageMap(blank), SplashError);
});

test("the mark is centred and spans MARK_SPAN of the shorter side, aspect preserved", () => {
  /* MUTATION: change MARK_SPAN's use to Math.max(w, h) -> the portrait case fails. */
  const box = { x0: 0, y0: 0, w: 40, h: 10 };
  const p = markPlacement(1000, 2000, box);
  assert.equal(p.w, Math.round(1000 * MARK_SPAN));
  assert.equal(p.h, Math.round(p.w / 4));
  assert.equal(p.x + Math.round(p.w / 2), 500);
  assert.equal(p.y + Math.round(p.h / 2), 1000);
});

test("a rendered splash is the ground at every corner and the ink at the mark's centre", () => {
  const img = renderSplash(300, 200, master);
  assert.equal(img.width, 300); assert.equal(img.height, 200);
  for (const [x, y] of [[0, 0], [299, 0], [0, 199], [299, 199]]) assert.deepEqual(px(img, x, y), GROUND);
  assert.deepEqual(px(img, 150, 100), INK);
});

test("rendering is deterministic: the same inputs give byte-identical PNGs", () => {
  /* This is what makes `--check` meaningful across two machines and two runs. */
  assert.equal(Buffer.compare(renderSplashBytes(120, 80, master), renderSplashBytes(120, 80, master)), 0);
});

test("splash PNGs carry no alpha channel", () => {
  assert.equal(header(renderSplashBytes(50, 50, master)).colour, 2);
});

test("a launcher icon is the square master resampled, never upscaled", () => {
  const h = header(renderLauncherBytes(32, icon));
  assert.equal(h.width, 32); assert.equal(h.height, 32);
  assert.throws(() => renderLauncherBytes(512, icon), /upscale/);
});

test("the adaptive foreground keeps the icon inside the central 66% on the icon's own ground", () => {
  /* MUTATION: set `inner` to px -> the corner is icon content, not ground -> red. */
  const img = decode(renderForegroundBytes(100, icon));
  assert.deepEqual(px(img, 1, 1), [252, 251, 246]);
  assert.deepEqual(px(img, 50, 50), [20, 30, 40]);
});

/* ------------------------------------------------------------------ iOS */

test("the imageset's own manifest says which files to write", () => {
  assert.deepEqual(declaredSplashImages(TEMPLATE_CONTENTS),
    ["splash-2732x2732-2.png", "splash-2732x2732-1.png", "splash-2732x2732.png"]);
});

test("a manifest that declares no files is an error, not a no-op", () => {
  /* The failure that shipped the placeholder: a rename nobody noticed. */
  assert.throws(() => declaredSplashImages(JSON.stringify({ images: [{ idiom: "universal" }] })), /declares no image files/);
  assert.throws(() => declaredSplashImages("{not json"), SplashError);
  assert.throws(() => declaredSplashImages(JSON.stringify({ info: {} })), SplashError);
});

test("a filename that is a path is refused so a generated file cannot choose where we write", () => {
  assert.throws(() => declaredSplashImages(JSON.stringify({ images: [{ filename: "../Info.plist" }] })), /path, not a name/);
});

test("the iOS plan writes the same 2732 square to every declared file", () => {
  const plan = planIosSplash(TEMPLATE_CONTENTS, master);
  assert.equal(plan.length, 3);
  const h = header(plan[0].bytes);
  assert.equal(h.width, IOS_SPLASH_PX); assert.equal(h.height, IOS_SPLASH_PX);
  assert.equal(Buffer.compare(plan[0].bytes, plan[2].bytes), 0);
});

test("injectIos writes into a real imageset and --check then passes; --check on the placeholder fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splash-ios-"));
  fs.writeFileSync(path.join(dir, "Contents.json"), TEMPLATE_CONTENTS);
  for (const f of declaredSplashImages(TEMPLATE_CONTENTS)) fs.writeFileSync(path.join(dir, f), flat(IOS_SPLASH_PX, IOS_SPLASH_PX, [255, 255, 255]));
  /* The placeholder is the right size at the right name: existence would pass. */
  assert.throws(() => injectIos(dir, { logo: DEFAULT_LOGO, checkOnly: true }), /does not hold our splash/);
  const r = injectIos(dir, { logo: DEFAULT_LOGO });
  assert.equal(r.wrote.length, 3);
  assert.equal(injectIos(dir, { logo: DEFAULT_LOGO, checkOnly: true }).files.length, 3);
  assert.equal(injectIos(dir, { logo: DEFAULT_LOGO }).wrote.length, 0, "second run is a no-op");
});

/* -------------------------------------------------------------- Android */

const LISTING = {
  "drawable/splash.png": { width: 480, height: 320 },
  "drawable-port-hdpi/splash.png": { width: 480, height: 800 },
  "drawable-land-xhdpi/splash.png": { width: 1280, height: 720 },
  "mipmap-hdpi/ic_launcher.png": { width: 72, height: 72 },
  "mipmap-hdpi/ic_launcher_round.png": { width: 72, height: 72 },
  "mipmap-hdpi/ic_launcher_foreground.png": { width: 162, height: 162 },
  "drawable/ic_something_else.png": { width: 10, height: 10 },
};

test("the Android plan renders every splash at the placeholder's own size and every launcher icon", () => {
  const plan = planAndroidRes(LISTING, master, icon);
  const by = Object.fromEntries(plan.map((p) => [p.rel, header(p.bytes)]));
  assert.deepEqual(Object.keys(by).sort(), [
    "drawable-land-xhdpi/splash.png", "drawable-port-hdpi/splash.png", "drawable/splash.png",
    "mipmap-hdpi/ic_launcher.png", "mipmap-hdpi/ic_launcher_foreground.png", "mipmap-hdpi/ic_launcher_round.png",
  ]);
  assert.equal(by["drawable-port-hdpi/splash.png"].width, 480);
  assert.equal(by["drawable-port-hdpi/splash.png"].height, 800);
  assert.equal(by["mipmap-hdpi/ic_launcher_foreground.png"].width, 162);
  assert.ok(!("drawable/ic_something_else.png" in by), "unrelated drawables are left alone");
});

test("a listing with splashes but no launcher icons is refused — half a fix would ship the placeholder icon", () => {
  /* MUTATION: delete the `launchers === 0` throw -> red. */
  const only = Object.fromEntries(Object.entries(LISTING).filter(([k]) => k.includes("splash")));
  assert.throws(() => planAndroidRes(only, master, icon), /no mipmap/);
  const none = Object.fromEntries(Object.entries(LISTING).filter(([k]) => k.includes("mipmap")));
  assert.throws(() => planAndroidRes(none, master, icon), /no drawable/);
});

test("a non-square launcher slot is an error, not a stretched icon", () => {
  assert.throws(() => planAndroidRes({ ...LISTING, "mipmap-hdpi/ic_launcher.png": { width: 72, height: 60 } }, master, icon), /not square/);
});

test("the launch theme gains the Android 12+ background exactly once, and a moved style is an error", () => {
  const once = patchStylesXml(TEMPLATE_STYLES);
  assert.equal(once.split(LAUNCH_BG_ITEM).length - 1, 1);
  assert.equal(patchStylesXml(once), once, "idempotent");
  assert.ok(once.includes(`<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">\n        ${LAUNCH_BG_ITEM}`));
  assert.throws(() => patchStylesXml("<resources></resources>"), /launch theme moved/);
});

test("injectAndroid writes a generated res tree, --check passes, and a reverted styles.xml fails --check", () => {
  const res = fs.mkdtempSync(path.join(os.tmpdir(), "splash-android-"));
  for (const [rel, { width, height }] of Object.entries(LISTING)) {
    fs.mkdirSync(path.join(res, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(res, rel), flat(width, height, [255, 255, 255]));
  }
  fs.mkdirSync(path.join(res, "values"));
  fs.writeFileSync(path.join(res, "values", "styles.xml"), TEMPLATE_STYLES);
  assert.deepEqual(Object.keys(readResListing(res)).sort(), Object.keys(LISTING).sort());
  assert.throws(() => injectAndroid(res, { checkOnly: true }), SplashError);
  const r = injectAndroid(res);
  assert.equal(r.wrote.length, 7, "six PNGs and styles.xml");
  assert.equal(injectAndroid(res, { checkOnly: true }).files.length, 7);
  fs.writeFileSync(path.join(res, "values", "styles.xml"), TEMPLATE_STYLES);
  assert.throws(() => injectAndroid(res, { checkOnly: true }), /launch background/);
});

/* ------------------------------------------------------------ real repo */

test("REAL REPO: the committed logo master renders a splash with ink in it", () => {
  /* Cannot fail on today's file — CLAUDE.md point 5 — and it is what catches a
     redrawn master whose ground and ink stop being distinguishable. */
  const real = decode(fs.readFileSync(DEFAULT_LOGO));
  const img = renderSplash(273, 273, real);
  assert.deepEqual(px(img, 0, 0), GROUND);
  let inked = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] > 100) inked++;
  assert.ok(inked > 200, `only ${inked} ink pixels in a 273px render`);
  assert.ok(fs.existsSync(DEFAULT_ICON), "icon-1024.png is the Android launcher master");
});
