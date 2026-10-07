/* Build ui/icons.svg, the Afterglow (ambient) icon sprite.
 *
 *   node tools/icons/build-sprite.mjs            write ui/icons.svg
 *   node tools/icons/build-sprite.mjs --check    exit 1 if ui/icons.svg is not what this would write
 *
 * Thirty-seven symbols, no more (BUILD-PLAN 1.2): thirty-three are Phosphor (MIT) paths
 * taken as they stand from the prototype's sprite, four are the custom transport glyphs
 * drawn here (BUILD-NOTES section 2): play, pause, back-15, forward-30.
 *
 * WHY THE CUSTOM FOUR ARE REBUILT HERE AND NOT COPIED FROM THE PROTOTYPE. The prototype
 * drew them with strokes and a `<text>` numeral. Both are wrong for the app:
 *   - `<text>` in a sprite reached through an external `<use>` does not see the page's
 *     @font-face, so "15" would render in a fallback face. The numerals are DM Sans 600
 *     outlines (tools/icons/dm-sans-600-numerals.json, from extract-numerals.py).
 *   - BUILD-NOTES says "stroke: none, filled paths at every weight". The arc, its round
 *     caps, the arrowhead and the play triangle's rounded corners are all expanded to
 *     fills here, so `fill: currentColor` is the only paint and a forced-colours or
 *     high-contrast mode recolours every one of them.
 * Every custom shape is a separate <path>: two overlapping subpaths in one path with
 * opposite winding would cancel under nonzero fill, separate paths simply union.
 *
 * Geometry (256 grid, same 24px-grid optical size as Phosphor Regular, whose artwork sits
 * in about 24..232):
 *   play    equilateral triangle, circumradius 104, corners rounded 12, optical centre
 *           shifted +8 right (centroid at x=136): the triangle's visual weight is on its
 *           left, so geometry centred on 128 reads as sitting left.
 *   pause   two bars 40 wide, gap 32, corners 12, 152 tall.
 *   skip    a 270 degree arc, radius 84, stroke 22 (expanded), round caps, open at the top;
 *           arrowhead at the open end (anticlockwise for back, clockwise for forward, the
 *           mirror image); the numeral is font-size 84 (the figure is 59 units tall), centred
 *           on the arc's centre.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROTOTYPE_SPRITE = path.join(ROOT, "docs/redesign-2026/directions/ambient/prototype/icons.svg");
const NUMERALS = path.join(ROOT, "tools/icons/dm-sans-600-numerals.json");
export const SPRITE_PATH = path.join(ROOT, "ui/icons.svg");

/* The sprite's contents and order. `custom` ids are drawn below; every other id is taken
   from the prototype sprite. */
export const SYMBOL_IDS = [
  "i-house", "i-house-fill", "i-compass", "i-compass-fill", "i-books", "i-books-fill",
  "i-play", "i-play-fill", "i-pause", "i-back15", "i-fwd30", "i-skip-next",
  "i-bookmark", "i-bookmark-fill", "i-check-circle", "i-check-circle-fill",
  "i-download", "i-download-fill", "i-queue", "i-dots",
  "i-chevron-left", "i-chevron-right", "i-chevron-down",
  "i-magnifier", "i-x", "i-share", "i-moon", "i-gauge", "i-sliders", "i-gear",
  "i-wifi-slash", "i-sparkle", "i-car", "i-arrow-up", "i-arrow-down", "i-plus", "i-trash",
];
export const CUSTOM_IDS = ["i-play", "i-pause", "i-back15", "i-fwd30"];

const f = (n) => String(Math.round(n * 100) / 100).replace(/^-0$/, "0");
const pt = (p) => `${f(p[0])} ${f(p[1])}`;

/** A convex polygon with every corner rounded to radius r, as one closed path. Vertices in
 *  any consistent order; the arc sweep is derived from the winding. */
export function roundedPolygon(points, r) {
  const n = points.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sweep = area > 0 ? 1 : 0; // screen coordinates (y down): positive area = clockwise
  const unit = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); return [dx / l, dy / l]; };
  let d = "";
  for (let i = 0; i < n; i++) {
    const p = points[i], prev = points[(i + n - 1) % n], next = points[(i + 1) % n];
    const u = unit(p, prev), v = unit(p, next);
    const theta = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
    const t = r / Math.tan(theta / 2);
    const a = [p[0] + u[0] * t, p[1] + u[1] * t], b = [p[0] + v[0] * t, p[1] + v[1] * t];
    d += `${i === 0 ? "M" : "L"}${pt(a)}A${f(r)} ${f(r)} 0 0 ${sweep} ${pt(b)}`;
  }
  return d + "Z";
}

/** A convex polygon grown outward by `by` with mitred corners (the polygon the stroke of
 *  width 2*by would trace). Rounding the result with radius `by` gives exactly the
 *  Minkowski sum of the original with a disc: the old corners become arcs of radius `by`. */
export function offsetPolygon(points, by) {
  const n = points.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const outward = area > 0 ? 1 : -1; // y-down screen: positive shoelace area = clockwise, whose outward edge normal is (dy, -dx)
  return points.map((p, i) => {
    const prev = points[(i + n - 1) % n], next = points[(i + 1) % n];
    const e1 = [p[0] - prev[0], p[1] - prev[1]], e2 = [next[0] - p[0], next[1] - p[1]];
    const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
    const n1 = [(e1[1] / l1) * outward, (-e1[0] / l1) * outward];
    const n2 = [(e2[1] / l2) * outward, (-e2[0] / l2) * outward];
    const bis = [n1[0] + n2[0], n1[1] + n2[1]];
    const bl = Math.hypot(...bis);
    const k = by / ((bis[0] / bl) * n1[0] + (bis[1] / bl) * n1[1]); // miter length along the bisector
    return [p[0] + (bis[0] / bl) * k, p[1] + (bis[1] / bl) * k];
  });
}

/** Parse an absolute-command path (M L H V Q C Z, what fontTools' SVGPathPen writes) and
 *  return it scaled by `s`, flipped on y (font units are y-up) and moved by (dx, dy). */
export function transformGlyphPath(d, s, dx, dy) {
  const tokens = d.match(/[MLHVQCZ]|-?\d*\.?\d+/g);
  let i = 0, cx = 0, cy = 0, out = "";
  const num = () => parseFloat(tokens[i++]);
  const X = (x) => x * s + dx, Y = (y) => -y * s + dy;
  while (i < tokens.length) {
    const c = tokens[i++];
    if (c === "Z") { out += "Z"; continue; }
    if (c === "M" || c === "L") { cx = num(); cy = num(); out += `${c}${f(X(cx))} ${f(Y(cy))}`; }
    else if (c === "H") { cx = num(); out += `L${f(X(cx))} ${f(Y(cy))}`; }
    else if (c === "V") { cy = num(); out += `L${f(X(cx))} ${f(Y(cy))}`; }
    else if (c === "Q") { const x1 = num(), y1 = num(); cx = num(); cy = num(); out += `Q${f(X(x1))} ${f(Y(y1))} ${f(X(cx))} ${f(Y(cy))}`; }
    else if (c === "C") { const x1 = num(), y1 = num(), x2 = num(), y2 = num(); cx = num(); cy = num(); out += `C${f(X(x1))} ${f(Y(y1))} ${f(X(x2))} ${f(Y(y2))} ${f(X(cx))} ${f(Y(cy))}`; }
    else throw new Error(`unsupported path command ${c}`);
  }
  return out;
}

function playSymbol() {
  const R = 104, cx = 136, cy = 128; // centroid shifted +8: optical centre
  const tri = [[cx + R, cy], [cx - R / 2, cy + (R * Math.sqrt(3)) / 2], [cx - R / 2, cy - (R * Math.sqrt(3)) / 2]];
  return `<path d="${roundedPolygon(tri, 12)}"/>`;
}

function pauseSymbol() {
  const bar = (x) => roundedRect(x, 52, 40, 152, 12);
  return `<path d="${bar(72)}"/><path d="${bar(144)}"/>`;
}

function roundedRect(x, y, w, h, r) {
  return `M${f(x + r)} ${f(y)}H${f(x + w - r)}A${r} ${r} 0 0 1 ${f(x + w)} ${f(y + r)}V${f(y + h - r)}` +
    `A${r} ${r} 0 0 1 ${f(x + w - r)} ${f(y + h)}H${f(x + r)}A${r} ${r} 0 0 1 ${f(x)} ${f(y + h - r)}` +
    `V${f(y + r)}A${r} ${r} 0 0 1 ${f(x + r)} ${f(y)}Z`;
}

function skipSymbol(label, mirror) {
  const R = 84, W = 11, rad = Math.PI / 180;
  const at = (deg, r = R) => { const x = 128 + r * Math.cos(deg * rad); return [mirror ? 256 - x : x, 128 + r * Math.sin(deg * rad)]; };
  // Open at the top: the arc runs from -60 degrees clockwise (screen) to 210 (= -150), 270 degrees.
  // Mirrored for forward, where "clockwise" flips, so the sweep flags flip with it.
  const sweepOuter = mirror ? 0 : 1, sweepInner = mirror ? 1 : 0;
  const o0 = at(-60, R + W), o1 = at(-150, R + W), i1 = at(-150, R - W), i0 = at(-60, R - W);
  const ring =
    `M${pt(o0)}A${R + W} ${R + W} 0 1 ${sweepOuter} ${pt(o1)}` + // outer edge
    `A${W} ${W} 0 0 ${sweepOuter} ${pt(i1)}` +                    // round cap at the far end
    `A${R - W} ${R - W} 0 1 ${sweepInner} ${pt(i0)}` +            // inner edge back
    `A${W} ${W} 0 0 ${sweepOuter} ${pt(o0)}Z`;                    // round cap at the arrowhead end
  // Arrowhead: tangent at the start, pointing across the gap.
  const s = at(-60);
  let tx = Math.sin(-60 * rad), ty = -Math.cos(-60 * rad);
  if (mirror) tx = -tx;
  const nx = -ty, ny = tx;
  const head = [
    [s[0] + tx * 24, s[1] + ty * 24],
    [s[0] - tx * 6 + nx * 20, s[1] - ty * 6 + ny * 20],
    [s[0] - tx * 6 - nx * 20, s[1] - ty * 6 - ny * 20],
  ];
  const headPath = roundedPolygon(offsetPolygon(head, 4), 4);

  const numerals = JSON.parse(fs.readFileSync(NUMERALS, "utf8"));
  const scale = 84 / numerals.upm; // font-size 84
  const adv = [...label].reduce((a, ch) => a + numerals.glyphs[ch].adv, 0) * scale;
  const figureHeight = 700 * scale; // DM Sans figure height at this instance
  let x = 128 - adv / 2;
  const baseline = 128 + figureHeight / 2;
  const digits = [...label].map((ch) => {
    const g = numerals.glyphs[ch];
    const d = transformGlyphPath(g.d, scale, x, baseline);
    x += g.adv * scale;
    return `<path d="${d}"/>`;
  }).join("");
  return `<path d="${ring}"/><path d="${headPath}"/>${digits}`;
}

const CUSTOM = {
  "i-play": playSymbol,
  "i-pause": pauseSymbol,
  "i-back15": () => skipSymbol("15", false),
  "i-fwd30": () => skipSymbol("30", true),
};

function phosphorSymbols() {
  const src = fs.readFileSync(PROTOTYPE_SPRITE, "utf8").replace(/\r\n/g, "\n");
  const out = new Map();
  for (const m of src.matchAll(/<symbol id="([^"]+)" viewBox="0 0 256 256">([\s\S]*?)<\/symbol>/g)) out.set(m[1], m[2]);
  return out;
}

export function buildSprite() {
  const phosphor = phosphorSymbols();
  const lines = SYMBOL_IDS.map((id) => {
    const inner = CUSTOM[id] ? CUSTOM[id]() : phosphor.get(id);
    if (!inner) throw new Error(`symbol ${id} is neither custom nor in the prototype sprite`);
    return `<symbol id="${id}" viewBox="0 0 256 256">${inner}</symbol>`;
  });
  return (
    `<!-- Afterglow icon sprite. GENERATED by tools/icons/build-sprite.mjs; edit that, not this.\n` +
    `     Phosphor Icons (https://phosphoricons.com), MIT License, Copyright (c) 2020 Phosphor Icons.\n` +
    `     The four transport glyphs (i-play, i-pause, i-back15, i-fwd30) are drawn in the build\n` +
    `     script; their numerals are outlines of DM Sans (SIL OFL 1.1). Filled paths only, painted\n` +
    `     by currentColor. Complete notices ship beside this file in ui/icons-LICENSES.txt.\n` +
    `     Referenced as <svg class="icon"><use href="ui/icons.svg#i-house"/></svg>. -->\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">\n` +
    lines.join("\n") + "\n</svg>\n"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = buildSprite();
  if (process.argv.includes("--check")) {
    const cur = fs.existsSync(SPRITE_PATH) ? fs.readFileSync(SPRITE_PATH, "utf8").replace(/\r\n/g, "\n") : "";
    if (cur !== next) { console.error("ui/icons.svg is stale: run node tools/icons/build-sprite.mjs"); process.exit(1); }
    console.log("ui/icons.svg is current");
  } else {
    fs.writeFileSync(SPRITE_PATH, next);
    console.log(`wrote ${path.relative(ROOT, SPRITE_PATH)} (${SYMBOL_IDS.length} symbols, ${next.length} bytes)`);
  }
}
