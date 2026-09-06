#!/usr/bin/env node
/* Put the REAL splash screen (and, on Android, the REAL launcher icon) into the
 * generated native projects.
 *
 * WHY THIS EXISTS (2026-09-06)
 * `cap add ios` generates `Assets.xcassets/Splash.imageset` with Capacitor's own
 * artwork, and `cap add android` generates eleven `splash.png` files (one per
 * `drawable-…` density directory) and fifteen `mipmap-…` launcher icons with
 * the same artwork. Nothing in the
 * build ever replaced them, so every build to date — including 2026090603, the
 * first one uploaded to both stores — opens on Capacitor's logo. Wyatt reported
 * it on 2026-09-04 and again on 2026-09-06 ("Splash screen is still wrong on
 * 4a"). It is the same shape as the icon bug `inject-app-icon.mjs` fixed on
 * 2026-09-03, and this file follows that one's rules exactly:
 *
 *   - the generated project's OWN manifest says what to write (the imageset's
 *     `Contents.json`; the drawable and mipmap directories that exist), so a
 *     template rename cannot leave a placeholder in place with every check green;
 *   - `--check` compares BYTES, never existence, because the placeholder exists
 *     at the right filename and the right pixel size;
 *   - everything that decides what to write is a pure function tested on Windows
 *     (`inject-splash.test.mjs`); only the read/write shell touches disk.
 *
 * WHAT THE SPLASH IS
 * The 4a wordmark (`tools/brand/4a-logo.png`, the one master every icon is
 * built from) painted in the app's text colour on the app's ground —
 * `--text #F4F0E8` on `--bg #151119`, the ui-v2 tokens from `styles.css`. Dark
 * on purpose: the WebView's first paint is that same ground, so the splash
 * hands over to the page with no flash. The mark spans 36% of the shorter
 * side. That number is a crop budget, not taste: iOS shows the 2732x2732
 * universal image with `scaleAspectFill`, and the narrowest phone
 * (1179x2556) keeps only the central 46% of the square's width, so anything
 * wider than ~40% is cut on a real device even though it looks centred in the
 * asset. Android's `androidScaleType` is set to `CENTER_CROP` in
 * `capacitor.config.json` for the same reason, in place of the template's
 * FIT_XY, which stretches.
 *
 * ANDROID 12+ IGNORES THE PNG. Since API 31 the OS draws its own launch
 * screen — the app icon on `windowSplashScreenBackground` — and the compat
 * `Theme.SplashScreen` the template uses maps the same attribute on older
 * versions. So on Android the fix has three parts: the drawables (pre-12 and
 * the plugin's own post-launch splash), the launch theme's background colour,
 * and the launcher icon itself — which was ALSO the placeholder, because
 * `inject-app-icon.mjs` is iOS-only. The `mipmap-*` set is rendered from
 * `icon-1024.png`; the adaptive foreground puts the icon inside the central
 * 66% that launcher masks are guaranteed to keep.
 *
 * USAGE
 *   node tools/mobile/inject-splash.mjs ios     <Splash.imageset>            [--check]
 *   node tools/mobile/inject-splash.mjs android <app/src/main/res>          [--check]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, encode, header } from "../brand/png.mjs";
import { MASTER, background, inkBox, resizeArea } from "../brand/build-icons.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const DEFAULT_LOGO = MASTER;
export const DEFAULT_ICON = path.join(REPO_ROOT, "icon-1024.png");

/** ui-v2 tokens, `styles.css` `body.ui-v2` scope. Hex kept as strings for the
 *  Android theme; parsed once for pixels. */
export const GROUND_HEX = "#151119";
export const INK_HEX = "#F4F0E8";
/** Fraction of the shorter side the wordmark spans. See the header. */
export const MARK_SPAN = 0.36;
/** iOS universal splash edge, the size Capacitor's template declares. */
export const IOS_SPLASH_PX = 2732;

export class SplashError extends Error {}

function hexRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new SplashError(`not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const GROUND = hexRgb(GROUND_HEX);
export const INK = hexRgb(INK_HEX);

/* ------------------------------------------------------------ rendering */

/**
 * The wordmark as a coverage map: 0 where the master is its own ground, 255
 * where it is fully ink, in between on anti-aliased edges. Computed from
 * luminance against the ground the master actually has (read from its corners,
 * as `build-icons.mjs` does) so a redrawn master on a different cream still
 * works. Returned as an RGBA image so `resizeArea` can area-average it.
 */
export function coverageMap(master) {
  const { width: w, height: h, data: d } = master;
  const bg = background(master);
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const bgLum = lum(...bg);
  let inkLum = bgLum;
  for (let i = 0; i < d.length; i += 4) {
    const l = lum(d[i], d[i + 1], d[i + 2]);
    if (l < inkLum) inkLum = l;
  }
  if (bgLum - inkLum < 40) throw new SplashError("the logo master has no ink darker than its ground");
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    const c = Math.max(0, Math.min(1, (bgLum - lum(d[i], d[i + 1], d[i + 2])) / (bgLum - inkLum)));
    const v = Math.round(c * 255);
    out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/**
 * Where the mark lands on a `w`x`h` canvas: centred, spanning MARK_SPAN of the
 * shorter side, aspect preserved. Pure arithmetic, exported to be tested.
 */
export function markPlacement(w, h, box) {
  const mw = Math.max(1, Math.round(Math.min(w, h) * MARK_SPAN));
  const mh = Math.max(1, Math.round((mw * box.h) / box.w));
  return { x: Math.round((w - mw) / 2), y: Math.round((h - mh) / 2), w: mw, h: mh };
}

/**
 * Render one splash: ground everywhere, the mark composited by coverage.
 * `master` is the decoded logo; `cov` its coverage map (cached by callers).
 * Returns a decoded image (`{width,height,data}` RGBA).
 */
export function renderSplash(w, h, master, cov = coverageMap(master)) {
  if (!(w > 0 && h > 0)) throw new SplashError(`bad splash size ${w}x${h}`);
  const box = inkBox(master, background(master));
  const place = markPlacement(w, h, box);
  const mark = resizeArea(cov, box, place.w, place.h);
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = GROUND[0]; out[i + 1] = GROUND[1]; out[i + 2] = GROUND[2]; out[i + 3] = 255;
  }
  for (let y = 0; y < place.h; y++) {
    const oy = place.y + y;
    if (oy < 0 || oy >= h) continue;
    for (let x = 0; x < place.w; x++) {
      const ox = place.x + x;
      if (ox < 0 || ox >= w) continue;
      const c = mark.data[(y * place.w + x) * 4] / 255;
      if (c === 0) continue;
      const o = (oy * w + ox) * 4;
      for (let k = 0; k < 3; k++) out[o + k] = Math.round(GROUND[k] + (INK[k] - GROUND[k]) * c);
    }
  }
  return { width: w, height: h, data: out };
}

/** PNG bytes for a splash of the given size. Colour type 2 (no alpha), like
 *  every other image this repo ships to a store. */
export function renderSplashBytes(w, h, master, cov) {
  return encode(renderSplash(w, h, master, cov), { rgb: true });
}

/** An Android launcher icon of `px`: the square icon, area-resampled. */
export function renderLauncherBytes(px, icon) {
  if (px > icon.width) throw new SplashError(`launcher icon ${px}px would upscale the ${icon.width}px master`);
  return encode(resizeArea(icon, { x0: 0, y0: 0, w: icon.width, h: icon.height }, px, px), { rgb: true });
}

/**
 * The adaptive foreground: launcher masks keep only the central 66% of the
 * 108dp layer, so the icon is scaled into that and the rest is the icon's own
 * ground colour, so a round, squircle or square mask all show a seamless tile.
 */
export function renderForegroundBytes(px, icon) {
  const inner = Math.round(px * 0.66);
  const small = resizeArea(icon, { x0: 0, y0: 0, w: icon.width, h: icon.height }, inner, inner);
  const bg = background(icon);
  const out = Buffer.alloc(px * px * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = bg[0]; out[i + 1] = bg[1]; out[i + 2] = bg[2]; out[i + 3] = 255; }
  const off = Math.round((px - inner) / 2);
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const s = (y * inner + x) * 4, o = ((y + off) * px + (x + off)) * 4;
      out[o] = small.data[s]; out[o + 1] = small.data[s + 1]; out[o + 2] = small.data[s + 2];
    }
  }
  return encode({ width: px, height: px, data: out }, { rgb: true });
}

/* ------------------------------------------------------------------ iOS */

function safeName(filename, what) {
  if (typeof filename !== "string" || !filename) throw new SplashError(`${what}: filename is not a string`);
  if (filename.includes("/") || filename.includes("\\") || filename === "." || filename === "..") {
    throw new SplashError(`${what}: ${JSON.stringify(filename)} is a path, not a name. Refusing to write outside the set.`);
  }
  return filename;
}

/** Every image the imageset declares a file for. Same shape as
 *  `inject-app-icon.mjs`'s `declaredIcons`, minus sizes: a splash imageset
 *  declares none, the template ships 2732 squares for every scale, and so do we. */
export function declaredSplashImages(contentsSrc) {
  let doc;
  try { doc = JSON.parse(contentsSrc); } catch (e) { throw new SplashError(`Contents.json is not valid JSON: ${e.message}`); }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.images)) {
    throw new SplashError('Contents.json has no "images" array — this is not an imageset');
  }
  const names = [];
  for (const [i, img] of doc.images.entries()) {
    if (!img || typeof img !== "object") throw new SplashError(`images[${i}] is not an object`);
    if (img.filename === undefined || img.filename === null || img.filename === "") continue;
    const n = safeName(img.filename, `images[${i}]`);
    if (!names.includes(n)) names.push(n);
  }
  if (names.length === 0) throw new SplashError("the imageset declares no image files at all — nothing would be replaced");
  return names;
}

/** Pure: what to write into the imageset. Every declared file gets the same
 *  2732 square (the template's own convention for a universal splash). */
export function planIosSplash(contentsSrc, master) {
  const names = declaredSplashImages(contentsSrc);
  const bytes = renderSplashBytes(IOS_SPLASH_PX, IOS_SPLASH_PX, master);
  return names.map((filename) => ({ filename, bytes }));
}

/* -------------------------------------------------------------- Android */

/**
 * Pure: given the resource directory listing (`{ relPath: pngHeader }` for every
 * PNG under `drawable*` and `mipmap-*`), decide what each becomes. Sizes are
 * taken from the placeholder files themselves, so a template that changes its
 * density set is followed, not fought.
 */
export function planAndroidRes(listing, master, icon) {
  const cov = coverageMap(master);
  const out = [];
  const names = Object.keys(listing).sort();
  let splashes = 0, launchers = 0;
  for (const rel of names) {
    const { width, height } = listing[rel];
    const parts = rel.split("/");
    if (parts.length !== 2) continue;
    const [dir, file] = parts;
    if (/^drawable(-|$)/.test(dir) && file === "splash.png") {
      out.push({ rel, bytes: renderSplashBytes(width, height, master, cov) });
      splashes++;
    } else if (/^mipmap-/.test(dir) && /^ic_launcher(_round)?\.png$/.test(file)) {
      if (width !== height) throw new SplashError(`${rel} is not square (${width}x${height})`);
      out.push({ rel, bytes: renderLauncherBytes(width, icon) });
      launchers++;
    } else if (/^mipmap-/.test(dir) && file === "ic_launcher_foreground.png") {
      if (width !== height) throw new SplashError(`${rel} is not square (${width}x${height})`);
      out.push({ rel, bytes: renderForegroundBytes(width, icon) });
      launchers++;
    }
  }
  if (splashes === 0) throw new SplashError("no drawable*/splash.png found — is this app/src/main/res of a generated Capacitor project?");
  if (launchers === 0) throw new SplashError("no mipmap-*/ic_launcher*.png found — refusing to fix the splash and leave the placeholder icon");
  return out;
}

/** The launch theme item Android 12+ actually paints. Idempotent. */
export const LAUNCH_BG_ITEM = `<item name="windowSplashScreenBackground">${GROUND_HEX}</item>`;
export function patchStylesXml(src) {
  if (src.includes(LAUNCH_BG_ITEM)) return src;
  const re = /(<style name="AppTheme\.NoActionBarLaunch"[^>]*>)/;
  if (!re.test(src)) throw new SplashError('styles.xml has no <style name="AppTheme.NoActionBarLaunch"> — the launch theme moved; update this script');
  return src.replace(re, `$1\n        ${LAUNCH_BG_ITEM}`);
}

/* -------------------------------------------------------------- disk I/O */

function mustDir(dir, hint) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new SplashError(`${dir} is not a directory. ${hint}`);
  }
}
function readMaster(p, what) {
  if (!fs.existsSync(p)) throw new SplashError(`${what} ${p} does not exist`);
  return decode(fs.readFileSync(p));
}
function writeAll(base, plan) {
  const wrote = [];
  for (const { rel, bytes } of plan) {
    const at = path.join(base, rel);
    if (fs.existsSync(at) && Buffer.compare(fs.readFileSync(at), bytes) === 0) continue;
    fs.writeFileSync(at, bytes);
    wrote.push(rel);
  }
  return wrote;
}
/** THE ANTI-FAILS-GREEN CHECK — re-read from disk, byte compare, name the first miss. */
function assertLanded(base, plan) {
  for (const { rel, bytes } of plan) {
    const at = path.join(base, rel);
    if (!fs.existsSync(at)) throw new SplashError(`${rel} is missing from ${base}`);
    if (Buffer.compare(fs.readFileSync(at), bytes) !== 0) {
      throw new SplashError(`${rel} does not hold our splash/icon bytes — it is the placeholder or stale. Run without --check.`);
    }
  }
  return plan.map((p) => p.rel);
}

export function injectIos(dir, { logo = DEFAULT_LOGO, checkOnly = false } = {}) {
  mustDir(dir, "Run `npm run add:ios` in mobile/ first — this edits the GENERATED project.");
  const contents = path.join(dir, "Contents.json");
  if (!fs.existsSync(contents)) throw new SplashError(`${contents} does not exist, so this is not an imageset`);
  const plan = planIosSplash(fs.readFileSync(contents, "utf8"), readMaster(logo, "the logo master"))
    .map(({ filename, bytes }) => ({ rel: filename, bytes }));
  if (checkOnly) return { files: assertLanded(dir, plan), wrote: [] };
  const wrote = writeAll(dir, plan);
  return { files: assertLanded(dir, plan), wrote };
}

export function readResListing(res) {
  const listing = {};
  for (const dir of fs.readdirSync(res)) {
    if (!/^(drawable|mipmap)(-|$)/.test(dir)) continue;
    const full = path.join(res, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith(".png")) continue;
      listing[`${dir}/${f}`] = header(fs.readFileSync(path.join(full, f)));
    }
  }
  return listing;
}

export function injectAndroid(res, { logo = DEFAULT_LOGO, icon = DEFAULT_ICON, checkOnly = false } = {}) {
  mustDir(res, "Run `npm run add:android` in mobile/ first — this edits the GENERATED project.");
  const styles = path.join(res, "values", "styles.xml");
  if (!fs.existsSync(styles)) throw new SplashError(`${styles} does not exist — is this app/src/main/res?`);
  const plan = planAndroidRes(readResListing(res), readMaster(logo, "the logo master"), readMaster(icon, "the icon master"));
  const stylesSrc = fs.readFileSync(styles, "utf8");
  const patched = patchStylesXml(stylesSrc);
  if (checkOnly) {
    if (patched !== stylesSrc) throw new SplashError("values/styles.xml lacks the launch background item. Run without --check.");
    return { files: assertLanded(res, plan).concat("values/styles.xml"), wrote: [] };
  }
  const wrote = writeAll(res, plan);
  if (patched !== stylesSrc) { fs.writeFileSync(styles, patched); wrote.push("values/styles.xml"); }
  if (patchStylesXml(fs.readFileSync(styles, "utf8")) !== fs.readFileSync(styles, "utf8")) {
    throw new SplashError("values/styles.xml did not take the launch background item");
  }
  return { files: assertLanded(res, plan).concat("values/styles.xml"), wrote };
}

/* ----------------------------------------------------------------- main */
const USAGE =
  "Usage: node tools/mobile/inject-splash.mjs ios <Splash.imageset> [--check]\n" +
  "       node tools/mobile/inject-splash.mjs android <app/src/main/res> [--check]";
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  let platform = null, dir = null, checkOnly = false;
  for (const a of argv) {
    if (a === "--check") checkOnly = true;
    else if (a.startsWith("-")) { console.error(`Unknown argument: ${a}\n${USAGE}`); process.exit(2); }
    else if (platform === null) platform = a;
    else if (dir === null) dir = a;
    else { console.error(`Unexpected argument: ${a}\n${USAGE}`); process.exit(2); }
  }
  if (!platform || !dir || !["ios", "android"].includes(platform)) { console.error(USAGE); process.exit(2); }
  try {
    const r = platform === "ios" ? injectIos(dir, { checkOnly }) : injectAndroid(dir, { checkOnly });
    console.log(checkOnly
      ? `${dir}: ${r.files.length} files hold our splash${platform === "android" ? " and launcher icon" : ""}`
      : `${dir}: ${r.wrote.length ? `wrote ${r.wrote.join(", ")}` : `${r.files.length} files already matched`}`);
  } catch (e) {
    console.error(`inject-splash failed: ${e.message}`);
    process.exit(1);
  }
}
