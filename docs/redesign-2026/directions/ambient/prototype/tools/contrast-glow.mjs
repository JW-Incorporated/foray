// Worst-case contrast of text on every Glow-tinted surface in Afterglow (round 2).
// critique-r1 items 2, 8 and 9 raised the mixes (Veil 28%, playing row 18%, Today wash 40%, Room base 15%)
// and the Dusk Glow lightness (0.66); BUILD-NOTES 1.2 asks for the worst case to be re-measured and printed.
// This is the prototype-side companion of ../../contrast-check.mjs (which covers the flat palette pairs).
// Run: node docs/redesign-2026/directions/ambient/prototype/tools/contrast-glow.mjs
// Method: sweep hue 0..350 at the clamped chroma (0.14 max), mix in OKLab exactly like CSS color-mix(in oklab),
// gamut-clip to sRGB, take WCAG 2.x contrast, report the minimum over hues for each text colour.

const hex = (h) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16) / 255);
const toLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const clip = (v) => Math.min(1, Math.max(0, v));
function srgbToOklab([r, g, b]) {
  const [R, G, B] = [r, g, b].map(toLin);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
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
const oklch = (L, C, h) => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
const mix = (a, b, pa) => a.map((v, i) => v * pa + b[i] * (1 - pa)); // OKLab mix, pa = share of a
const lum = ([r, g, b]) => 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
const cr = (fg, bg) => { const x = lum(hex2(fg)), y = lum(bg); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hex2 = (f) => (Array.isArray(f) ? f : hex(f));
const over = (top, a, bottom) => top.map((v, i) => v * a + bottom[i] * (1 - a)); // sRGB alpha composite

const DUSK = { bg0: '#14110F', bg1: '#1D1916', text: '#F5EEE4', t2: '#B9AFA3', t3: '#9A9188', lamp: '#F3E7D3', roomT: '#F5EEE4', roomT2: '#C9BFB3' };
const DAWN = { bg0: '#F7F2EB', bg1: '#FDFAF5', text: '#1E1A17', t2: '#5E564E', t3: '#6B635A' };
const results = [];
function sweep(name, L, C, build, fgs) {
  const worst = {};
  for (let h = 0; h < 360; h += 10) {
    const glow = srgbToOklab(oklabToSrgb(oklch(L, C, h))); // gamut-clipped, as a browser would show it
    const bg = build(glow);
    for (const [fn, fv] of Object.entries(fgs)) {
      const r = cr(fv, bg);
      if (!worst[fn] || r < worst[fn][0]) worst[fn] = [r, h];
    }
  }
  for (const [fn, [r, h]] of Object.entries(worst)) results.push([name, fn, r, h]);
}
const C = 0.14;
const D0 = srgbToOklab(hex(DUSK.bg0)), D1 = srgbToOklab(hex(DUSK.bg1));
const W0 = srgbToOklab(hex(DAWN.bg0)), W1 = srgbToOklab(hex(DAWN.bg1));
const LAMP_OVERLAY = [243 / 255, 231 / 255, 211 / 255];

// Dusk
sweep('Dusk Veil 72/28 (Dock)', 0.66, C, (g) => oklabToSrgb(mix(D0, g, 0.72)), { text: DUSK.text, 'text-2': DUSK.t2 });
sweep('Dusk playing row 82/18 + 6% lamp', 0.66, C, (g) => over(LAMP_OVERLAY, 0.06, oklabToSrgb(mix(D1, g, 0.82))), { text: DUSK.text, 'text-2': DUSK.t2 });
// text-3 is never placed on the wash (it measured 3.20 at 60/40): the greeting and hero captions use text-2 or text
sweep('Dusk Today wash 60/40', 0.66, C, (g) => oklabToSrgb(mix(D0, g, 0.60)), { text: DUSK.text, 'text-2': DUSK.t2, lamp: DUSK.lamp });
// the Room: the brightest possible artwork (white) under the lower scrim, whose colour carries 24% Glow
for (const [label, a] of [['lower scrim (55%)', 0.863], ['bottom scrim (100%)', 0.94]]) {
  sweep('Dusk Room ' + label + ' over white art', 0.66, C, (g) => {
    const dark = oklabToSrgb(mix(srgbToOklab([20 / 255, 17 / 255, 15 / 255]), g, 0.76));
    return over(dark, a, [1, 1, 1]);
  }, { text: DUSK.roomT, 'text-2': DUSK.roomT2 });
}
// Dawn
// Dawn Veil is 76/24, not 72/28: ink-2 measured 4.48 at 72/28 on the worst hue (a saturated pink)
sweep('Dawn Veil 76/24 (Dock)', 0.56, C, (g) => oklabToSrgb(mix(W0, g, 0.76)), { ink: DAWN.text, 'ink-2': DAWN.t2 });
sweep('Dawn playing row 82/18', 0.56, C, (g) => oklabToSrgb(mix(W1, g, 0.82)), { ink: DAWN.text, 'ink-2': DAWN.t2 });
// on the Dawn wash secondary captions take ink (ink-2 measured 3.78, ink-3 3.10 at 60/40)
sweep('Dawn Today wash 60/40', 0.56, C, (g) => oklabToSrgb(mix(W0, g, 0.60)), { ink: DAWN.text });

// ---------------------------------------------------------------- round 3 rows (critique-r2 items 1, 3, 6)
// CSS color-mix(in oklab, rgb(R G B / a) p%, glow (1-p)%) interpolates PREMULTIPLIED: alpha = p*a + (1-p),
// colour = (p*a*A + (1-p)*G) / alpha. Then the browser composites that over whatever is behind it, in sRGB.
function scrimOver(rgb, a, p, glowLab, backdrop) {
  const A = srgbToOklab(rgb.map((v) => v / 255));
  const alpha = p * a + (1 - p);
  const lab = A.map((v, i) => (p * a * v + (1 - p) * glowLab[i]) / alpha);
  return over(oklabToSrgb(lab), alpha, backdrop);
}
const WHITE = [1, 1, 1], BLACK = [0, 0, 0];
const DUSK_SCRIM = [20, 17, 15], DAWN_SCRIM = [247, 242, 235];
const DUSK_MID_A = Number(process.env.MID_A || 0.86);    // raised from 0.82 (round 3 item 1)
const DUSK_HEAD_A = Number(process.env.HEAD_A || 0.52);
const DAWN_MID_A = Number(process.env.DAWN_MID_A || 0.92), DAWN_HEAD_A = Number(process.env.DAWN_HEAD_A || 0.55);
const OWS = process.env.OWS || '#E2D9CD';   // --on-wash-2 candidate  // the head icons need 3:1 on ANY art; see the white-art row
// Dusk Room at the eyebrow's y: scrim-mid over (a) the Glow colour itself and (b) pure white art, the brightest possible
for (const [label, back] of [['Glow', null], ['white art', WHITE]]) {
  sweep(`Dusk Room at the eyebrow's y over ${label}`, 0.66, C, (g) => scrimOver(DUSK_SCRIM, DUSK_MID_A, 0.76, g, back || oklabToSrgb(g)), { lamp: DUSK.lamp, 'text-2': DUSK.roomT2 });
}
// Dusk Room head (the chevron and dots, 3:1 floor): black at DUSK_HEAD_A over Glow, and over pure white art
const headOver = (a, back) => over([20 / 255, 17 / 255, 15 / 255], a, back);
sweep('Dusk Room head over Glow (floor 3:1)', 0.66, C, (g) => headOver(DUSK_HEAD_A, oklabToSrgb(g)), { text: DUSK.roomT });
results.push(['Dusk Room head over white art (floor 3:1)', 'text', cr(DUSK.roomT, headOver(DUSK_HEAD_A, WHITE)), 0]);
// Dawn Room at the eyebrow's y: the paper scrim (86% paper, 80/20 with Glow L 0.56) over the Glow colour and over BLACK art (worst for a light scrim)
// the Dawn artwork layer is 55% opaque over the paper-and-Glow base, so "black art" is the layer composited, not pure black
const dawnBase = (g) => oklabToSrgb(mix(W0, g, 0.80));
for (const [label, back] of [['Glow', null], ['black art', 'layer']]) {
  sweep(`Dawn Room at the eyebrow's y over ${label}`, 0.56, C, (g) => scrimOver(DAWN_SCRIM, DAWN_MID_A, 0.80, g, back === 'layer' ? over(BLACK, 0.55, dawnBase(g)) : oklabToSrgb(g)), { ink: DAWN.text, 'ink-2': DAWN.t2, 'lamp-text': '#55391A' });
}
// Dawn Room head: paper at 0.55 over Glow and black art, ink icons at 3:1
for (const [label, back] of [['Glow', null], ['black art', 'layer']]) {
  sweep(`Dawn Room head over ${label} (floor 3:1)`, 0.56, C, (g) => over([247 / 255, 242 / 255, 235 / 255], DAWN_HEAD_A, back === 'layer' ? over(BLACK, 0.55, dawnBase(g)) : oklabToSrgb(g)), { ink: DAWN.text });
}
// Today hot spot 48/52: the tight radial centred on the collage, text-2 and Lamp at the hot spot's full strength (a conservative
// bound: the real text sits at its falloff), and at the measured eyebrow position (about 15% hot over the 40% wash)
const HOT = Number(process.env.HOT || 0.52);
sweep(`Dusk Today hot spot ${Math.round(100 - HOT * 100)}/${Math.round(HOT * 100)}`, 0.66, C, (g) => oklabToSrgb(mix(D0, g, 1 - HOT)), { 'text-2': DUSK.t2, 'on-wash-2': OWS, lamp: DUSK.lamp });
sweep('Dusk Today wash + hot spot, at the eyebrow (measured falloff)', 0.66, C, (g) => oklabToSrgb(mix(D0, g, 1 - (0.40 + HOT * 0.29 * 0.60))), { 'text-2': DUSK.t2, 'on-wash-2': OWS, lamp: DUSK.lamp });
sweep(`Dawn Today hot spot ${Math.round(100 - HOT * 100)}/${Math.round(HOT * 100)}`, 0.56, C, (g) => oklabToSrgb(mix(W0, g, 1 - HOT)), { ink: DAWN.text });

// ---------------------------------------------------------------- round 4 row (critique-r3 item 2): the Dock casts upward
// .page-glow is Glow at 14% (Dusk) / 9% (Dawn) over bg0 at its brightest point, the Dock's top edge; page text sits on it.
sweep('Dusk Dock cast 14% over bg0 (page text)', 0.66, C, (g) => oklabToSrgb(mix(D0, g, 0.86)), { text: DUSK.text, 'text-2': DUSK.t2, 'text-3': DUSK.t3 });
sweep('Dawn Dock cast 9% over bg0 (page text)', 0.56, C, (g) => oklabToSrgb(mix(W0, g, 0.91)), { ink: DAWN.text, 'ink-2': DAWN.t2, 'ink-3': DAWN.t3 });

let fail = 0;
for (const [surface, fn, r, h] of results) {
  const need = /head/.test(surface) ? 3 : 4.5;
  const ok = r >= need;
  if (!ok) fail++;
  console.log(`${ok ? 'AA  ' : 'FAIL'} ${r.toFixed(2).padStart(6)}  ${fn.padEnd(7)} on ${surface}  (worst hue ${h})`);
}
console.log(fail ? `${fail} pair(s) below 4.5` : 'all Glow-tinted pairs >= 4.5 at the worst hue');
