/* OKLab colour maths for the Afterglow token tests (Redesign 2026, ambient).
 *
 * The same arithmetic as docs/redesign-2026/directions/ambient/prototype/tools/
 * contrast-glow.mjs, in a helper the token suite can import: CSS
 * `color-mix(in oklab, ...)` is evaluated here exactly as a browser does it
 * (premultiplied alpha, OKLab interpolation, sRGB gamut clip), so a mix
 * percentage changed in ui/tokens.css moves a number a test reads.
 *
 * Plain CommonJS, no dependencies, no I/O. Colours are [r, g, b] in 0..1 sRGB;
 * "lab" is [L, a, b]. */
"use strict";

const toLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const clip = (v) => Math.min(1, Math.max(0, v));

function hexToRgb(hex) {
  const c = String(hex).replace("#", "");
  return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
}
function rgbToHex(rgb) {
  return "#" + rgb.map((v) => Math.round(clip(v) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}
function srgbToOklab([r, g, b]) {
  const [R, G, B] = [r, g, b].map(toLin);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function oklabToSrgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [R, G, B].map((v) => clip(toSrgb(clip(v))));
}
/** oklch(L C h) as OKLab, then gamut-clipped through sRGB the way a browser paints it. */
function oklchToLab(L, C, hDeg) {
  const lab = [L, C * Math.cos((hDeg * Math.PI) / 180), C * Math.sin((hDeg * Math.PI) / 180)];
  return srgbToOklab(oklabToSrgb(lab));
}
/** `color-mix(in oklab, a pa%, b)` for opaque colours: share `pa` (0..1) of lab `a`, the rest lab `b`. */
const mixLab = (a, b, pa) => a.map((v, i) => v * pa + b[i] * (1 - pa));
/** sRGB alpha composite of `top` at `alpha` over `bottom`. */
const over = (top, alpha, bottom) => top.map((v, i) => v * alpha + bottom[i] * (1 - alpha));

/** `color-mix(in oklab, rgb(R G B / a) pShare%, glow)`: CSS interpolates PREMULTIPLIED, so the result
 *  carries alpha = p*a + (1-p) and a colour that is the premultiplied average. Returns { lab, alpha }. */
function mixScrim(rgb255, a, pShare, glowLab) {
  const A = srgbToOklab(rgb255.map((v) => v / 255));
  const alpha = pShare * a + (1 - pShare);
  const lab = A.map((v, i) => (pShare * a * v + (1 - pShare) * glowLab[i]) / alpha);
  return { lab, alpha };
}

const luminance = ([r, g, b]) => 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
function contrast(fg, bg) {
  const x = luminance(fg), y = luminance(bg);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

module.exports = {
  hexToRgb, rgbToHex, srgbToOklab, oklabToSrgb, oklchToLab, mixLab, over, mixScrim, luminance, contrast,
};
