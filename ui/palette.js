/* ui/palette.js — Afterglow's Glow colour: the artwork is the light source (Redesign 2026, ambient).
   A CLASSIC script like app.js, loaded by index.html after app.js: declarations only, nothing
   runs at the top level, so it changes no screen until a screen calls it.

   WHERE A SHOW'S COLOUR COMES FROM, in order (BUILD-NOTES 1.2, BUILD-PLAN 0.2):
     1. AG_PALETTES, one [hue, chroma] pair per show in OKLCH, computed ONCE from the artwork by
        docs/redesign-2026/directions/ambient/prototype/tools/palettes.mjs and committed as NUMBERS
        (no imagery). Publisher art usually lacks CORS headers, which taints a canvas, so the
        chrome's colour must never depend on reading pixels at runtime. Runtime canvas extraction
        is deliberately not built. The table is keyed by fnv1a(show name), not by the name: a show's
        title is somebody else's text, and this file is scanned as listener copy. test/ambient-today.test.js
        pins the table to the prototype's palettes.json (every name there hashes to the key and the pair
        it carries), so the two cannot drift.
     2. A show not in the table gets a hash hue: fnv1a(name) % 360 at chroma 0.10.
   The pair is then clamped for mood, not for contrast (text never sits on raw Glow): lightness
   0.66 in Dusk and 0.56 in Dawn (read from the live --glow-l token), chroma 0.07 to 0.14. */

const AG_PALETTES = {
  965434512: [15, 0.155],
  2803447328: [233, 0.133],
  3203839748: [46, 0.09],
  3386910673: [202, 0.059],
  898542721: [265, 0.087],
  291370474: [326, 0.265],
  3408480144: [62, 0.156],
  3410988747: [142, 0.076],
  2429674530: [273, 0.129],
  1832371350: [106, 0.199],
  1275450377: [99, 0.177],
  1016746122: [28, 0.189],
  3398402998: [30, 0.215],
  2512235234: [255, 0.141],
  1652208663: [13, 0.172],
  3410706641: [247, 0.133],
  2638211049: [37, 0.133],
  53008582: [7, 0.135],
  3035917754: [24, 0.178],
  3132165569: [8, 0.226],
  730745204: [92, 0.159],
  2897024030: [285, 0.155],
  2596150017: [54, 0.158],
  3918211964: [27, 0.186],
  383403859: [76, 0.055],
  349033122: [169, 0.126],
  3448902681: [33, 0.181],
  1597181859: [124, 0.124],
  1104095088: [119, 0.195],
  1577452414: [256, 0.101],
  3229068595: [106, 0.186],
  3354338337: [233, 0.103],
  2250220382: [235, 0.141],
  2652636281: [247, 0.165],
  2277968187: [42, 0.176],
  3090981098: [95, 0.151],
  1615980535: [73, 0.053],
  3784802819: [40, 0.19],
  2194886679: [249, 0.126],
  1548333565: [280, 0.229],
};

/* The Glow before anything plays and for a show with no name: a warm neutral. */
const AG_NEUTRAL_GLOW = "oklch(0.66 0.05 70)";

function agFnv1a(text) {
  let x = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
  return x >>> 0;
}

/** [hue, chroma] for a show, or null for an empty name. Own-property lookup only, so a numeric key can
    never read an inherited value. */
function agPaletteFor(show) {
  const name = String(show == null ? "" : show).trim();
  if (!name) return null;
  const key = agFnv1a(name);
  if (Object.prototype.hasOwnProperty.call(AG_PALETTES, key)) return AG_PALETTES[key];
  return [key % 360, 0.1];
}

/** The scheme's clamped Glow lightness: the live --glow-l token (0.66 Dusk, 0.56 Dawn), 0.66 where unreadable. */
function agGlowLightness() {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--glow-l");
    const n = parseFloat(raw);
    if (n > 0 && n < 1) return n;
  } catch (_) { /* a stub document: Dusk */ }
  return 0.66;
}

/** The Glow for a show, as an oklch() colour string safe to hand to style.setProperty("--glow", …).
    Built only from numbers, never from the show's name. */
function agGlowFor(show) {
  const hc = agPaletteFor(show);
  if (!hc) return AG_NEUTRAL_GLOW;
  const chroma = Math.min(0.14, Math.max(0.07, Number(hc[1]) || 0.1));
  const hue = ((Number(hc[0]) % 360) + 360) % 360;
  return "oklch(" + agGlowLightness() + " " + chroma.toFixed(3) + " " + hue.toFixed(0) + ")";
}

/** Write a Glow onto an element through the CSSOM (the CSP forbids an inline style attribute, not this). */
function agSetGlow(el, show, prop = "--glow") {
  if (!el || !el.style || typeof el.style.setProperty !== "function") return;
  el.style.setProperty(prop, agGlowFor(show));
}
