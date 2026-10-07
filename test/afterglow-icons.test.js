/* Redesign 2026, ambient, phase 3 step 2: the icon sprite (ui/icons.svg), its helper
 * (ui/icons.js) and the `.icon` rules in ui/tokens.css.
 *
 * WHAT THIS HOLDS (BUILD-PLAN 1.2, BUILD-NOTES 2):
 *   - the sprite is exactly the thirty-seven symbols the plan lists, in that order, each a
 *     256 viewBox of filled paths painted by currentColor: no <text> (an external <use>
 *     does not see the page's @font-face), no stroke, no inline style, no fixed colour,
 *     nothing that is not a shape (strict CSP);
 *   - the file on disk is what tools/icons/build-sprite.mjs writes (the four custom glyphs
 *     cannot be hand-edited into drift);
 *   - the helper returns real markup for every name and "" for anything else, so a typo or a
 *     hostile string never reaches a `href` or a class;
 *   - every icon a screen asks for, by agIcon("...") or a literal `#i-...`, exists in the
 *     sprite (a rename that misses a call site fails here, not as a blank tab);
 *   - the sizes the plan names are classes that move one token to the plan's pixel value;
 *   - the shell ships the sprite (service-worker manifest, web dist, Capacitor webDir).
 *
 * HARNESS AUDIT. The call-site scan reads ui/*.js, and today NO screen calls agIcon yet
 * (screens adopt the system one at a time in Phase 4), so on today's data that scan is
 * vacuous by construction. It is kept on purpose: it is the only thing between a Phase 4
 * rename and a blank tab. To stop it being untested, the scanner (iconRefs) is its own
 * function and the "scanner" tests run it on synthetic source that DOES contain a bad
 * name; breaking the scanner fails those, breaking the sprite fails the real-files test.
 *
 * Each test names the one-line mutation that turns it red; all were run (PR description).
 * Suites: this file pins the sprite and helper; test/afterglow-tokens.test.js still owns
 * the token file's structure (its own block-count and colour-literal rules pass over the
 * `.icon` rules added here, which is the cross-check that they are token-only).
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/* The plan's list, spelled out here independently of ui/icons.js and the build script, so
   a change to either is a change to a number this file states. BUILD-PLAN 1.2. */
const PLAN_IDS = [
  "i-house", "i-house-fill", "i-compass", "i-compass-fill", "i-books", "i-books-fill",
  "i-play", "i-play-fill", "i-pause", "i-back15", "i-fwd30", "i-skip-next",
  "i-bookmark", "i-bookmark-fill", "i-check-circle", "i-check-circle-fill",
  "i-download", "i-download-fill", "i-queue", "i-dots",
  "i-chevron-left", "i-chevron-right", "i-chevron-down",
  "i-magnifier", "i-x", "i-share", "i-moon", "i-gauge", "i-sliders", "i-gear",
  "i-wifi-slash", "i-sparkle", "i-car", "i-arrow-up", "i-arrow-down", "i-plus", "i-trash",
];

const SPRITE = read("ui/icons.svg");

/** [{ id, viewBox, body }] in file order. */
function symbols(svg) {
  return [...svg.matchAll(/<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g)].map((m) => ({
    id: (/\bid="([^"]*)"/.exec(m[1]) || [])[1],
    viewBox: (/\bviewBox="([^"]*)"/.exec(m[1]) || [])[1],
    attrs: m[1],
    body: m[2],
  }));
}

/** Every call-site reference to an icon in a piece of source: agIcon("name") and a literal
 *  `#i-name` fragment. Returns [{ kind, id }] with ids in the sprite's `i-` form. */
function iconRefs(src) {
  const refs = [];
  for (const m of src.matchAll(/\bagIcon\(\s*["']([^"']*)["']/g)) refs.push({ kind: "agIcon", id: "i-" + m[1] });
  for (const m of src.matchAll(/#(i-[A-Za-z0-9-]+)/g)) refs.push({ kind: "fragment", id: m[1] });
  return refs;
}

/** The end points of every segment in a path's `d` (M L H V Q C A Z), for bounding boxes. */
function pathPoints(d) {
  const ARITY = { M: 2, L: 2, H: 1, V: 1, Q: 4, C: 6, A: 7, Z: 0 };
  const pts = [];
  let x = 0, y = 0;
  for (const m of d.matchAll(/([MLHVQCAZ])([^MLHVQCAZ]*)/g)) {
    const nums = (m[2].match(/-?\d*\.?\d+/g) || []).map(Number);
    const n = ARITY[m[1]];
    assert.ok(nums.length === n || (n && nums.length % n === 0), `${m[1]} takes ${n} numbers: ${m[2]}`);
    for (let i = 0; n && i < nums.length; i += n) {
      const a = nums.slice(i, i + n);
      if (m[1] === "H") x = a[0];
      else if (m[1] === "V") y = a[0];
      else { x = a[n - 2]; y = a[n - 1]; }
      pts.push([x, y]);
    }
  }
  return pts;
}
const bbox = (pts) => ({
  x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])),
  y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])),
});
const pathsOf = (body) => [...body.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)].map((m) => m[1]);

/* ------------------------------------------------------------------ the sprite */

test("the sprite is exactly the thirty-seven plan symbols, in the plan's order, each once", () => {
  /* MUTATION: rename `i-gear` to `i-gearr` in ui/icons.svg, delete one <symbol>, or add a thirty-eighth
     -> red, naming the difference. */
  const ids = symbols(SPRITE).map((s) => s.id);
  assert.deepStrictEqual(ids, PLAN_IDS);
  assert.strictEqual(new Set(ids).size, 37);
});

test("every symbol is a 256 viewBox of filled paths painted by currentColor and nothing else", () => {
  /* MUTATION: add `fill="#fff"` to any <path>, a `stroke="currentColor"`, a `<text>` numeral, a
     `style="..."`, or change one viewBox to "0 0 24 24" -> red, naming the symbol. */
  const bad = [];
  for (const s of symbols(SPRITE)) {
    if (s.viewBox !== "0 0 256 256") bad.push(`${s.id}: viewBox ${s.viewBox}`);
    if (/\s(?:fill|stroke)\s*=/.test(s.attrs)) bad.push(`${s.id}: paint on the <symbol>`);
    const shapes = [...s.body.matchAll(/<(\/?)([A-Za-z][\w:-]*)/g)].filter((m) => !m[1]).map((m) => m[2]);
    if (!shapes.length) bad.push(`${s.id}: empty`);
    for (const tag of shapes) if (tag !== "path") bad.push(`${s.id}: <${tag}> (only <path>)`);
    for (const m of s.body.matchAll(/\s([A-Za-z:-]+)=/g)) if (m[1] !== "d") bad.push(`${s.id}: attribute ${m[1]} on a path (only d: paint comes from currentColor)`);
    if (/#[0-9a-f]{3,8}\b|rgb|hsl|url\(|style/i.test(s.body)) bad.push(`${s.id}: a fixed colour, a url() or a style`);
  }
  assert.deepStrictEqual(bad, []);
});

test("the root carries no script, no handler, no external reference, and is hidden from assistive tech", () => {
  /* MUTATION: add `<script>` or `onload="x()"` or `xlink:href="https://x"` or `<image href=...>` to the root
     -> red; remove aria-hidden="true" from the root -> red. */
  assert.match(SPRITE, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="0" height="0" aria-hidden="true">/);
  const noComments = SPRITE.replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(noComments, /<script|<style|<image|<foreignObject|<use\b|\son[a-z]+\s*=|href\s*=|javascript:/i);
});

test("the licence line for Phosphor (MIT) and DM Sans (OFL) travels with the sprite", () => {
  /* MUTATION: delete the header comment from ui/icons.svg (or from build-sprite.mjs's output) -> red. */
  const head = SPRITE.slice(0, SPRITE.indexOf("<svg"));
  assert.match(head, /Phosphor Icons/);
  assert.match(head, /MIT License/);
  assert.match(head, /SIL OFL/);
});

test("the file on disk is what tools/icons/build-sprite.mjs writes", async () => {
  /* MUTATION: change one coordinate inside any <path> of ui/icons.svg by hand -> red (the diff is not the
     build's). Or change `R = 104` in build-sprite.mjs without re-running it -> red, naming the staleness. */
  const mod = await import(pathToFileURL(path.join(ROOT, "tools", "icons", "build-sprite.mjs")).href);
  assert.strictEqual(SPRITE, mod.buildSprite().replace(/\r\n/g, "\n"), "run: node tools/icons/build-sprite.mjs");
  assert.deepStrictEqual(mod.SYMBOL_IDS, PLAN_IDS, "the build script's list is the plan's list");
});

/* ---------------------------------------------------------------- custom glyphs */

test("the four custom glyphs are outlines: the numerals are paths, not <text>, and sit inside the ring", () => {
  /* MUTATION: in build-sprite.mjs emit `<text>` for the numeral again, or drop one digit from `label`
     -> red. Changing the ring radius R (e.g. R = 50) -> red (outer/inner edge radii are pinned); enlarging the numeral past the ring -> red (ink escapes). */
  for (const [id, parts] of [["i-back15", 4], ["i-fwd30", 4]]) {
    const s = symbols(SPRITE).find((x) => x.id === id);
    assert.doesNotMatch(s.body, /<text/);
    const paths = pathsOf(s.body);
    assert.strictEqual(paths.length, parts, `${id}: ring, head and two digits`);
    const digits = paths.slice(2);
    /* the ring: outer radius 84 + 11, inner 84 - 11, round caps of radius 11 (stroke 22 expanded to a fill) */
    assert.match(paths[0], /A95 95 0 1 [01] /, `${id}: outer edge radius 95`);
    assert.match(paths[0], /A73 73 0 1 [01] /, `${id}: inner edge radius 73`);
    assert.strictEqual((paths[0].match(/A11 11 0 0 /g) || []).length, 2, `${id}: two round caps`);
    for (const d of digits) {
      for (const [x, y] of pathPoints(d)) {
        /* the ring's inside radius is 84 - 11 = 73; every outline point stays 6 units clear of it */
        assert.ok(Math.hypot(x - 128, y - 128) < 67, `${id}: numeral point (${x}, ${y}) is inside the ring`);
      }
    }
    const all = bbox(digits.flatMap((d) => pathPoints(d)));
    assert.ok(Math.abs((all.x0 + all.x1) / 2 - 128) < 6, `${id}: numerals centred on 128 (${(all.x0 + all.x1) / 2})`);
    assert.ok(Math.abs((all.y0 + all.y1) / 2 - 128) < 3, `${id}: numerals centred vertically (${(all.y0 + all.y1) / 2})`);
  }
});

test("forward-30 is the mirror image of back-15's arc and arrowhead, not a copy", () => {
  /* MUTATION: drop `mirror ? 256 - x : x` in build-sprite.mjs's `at()` (so both glyphs turn the same way),
     or flip `tx = -tx` for the head -> red. */
  const back = pathsOf(symbols(SPRITE).find((x) => x.id === "i-back15").body);
  const fwd = pathsOf(symbols(SPRITE).find((x) => x.id === "i-fwd30").body);
  for (const k of [0, 1]) {
    const a = bbox(pathPoints(back[k])), b = bbox(pathPoints(fwd[k]));
    assert.ok(Math.abs(a.x0 - (256 - b.x1)) < 0.2 && Math.abs(a.x1 - (256 - b.x0)) < 0.2, `part ${k}: x range mirrored (${a.x0}..${a.x1} vs ${b.x0}..${b.x1})`);
    assert.ok(Math.abs(a.y0 - b.y0) < 0.2 && Math.abs(a.y1 - b.y1) < 0.2, `part ${k}: y range equal`);
  }
  /* the head sits at the open end at the top, on opposite sides */
  const hb = bbox(pathPoints(back[1])), hf = bbox(pathPoints(fwd[1]));
  assert.ok(hb.x0 > 128 && hf.x1 < 128, "back's head is right of centre, forward's left");
});

test("play is an equilateral triangle shifted +8 right of centre; pause is two 40-wide bars 32 apart", () => {
  /* MUTATION: set `cx = 128` in playSymbol() (no optical shift) -> red; change a bar x (72 or 144) so the gap
     is not 32 -> red; change the 12 corner radius to 4 -> red (the rounded-corner arc radius is pinned). */
  const play = pathsOf(symbols(SPRITE).find((x) => x.id === "i-play").body);
  assert.strictEqual(play.length, 1);
  assert.match(play[0], /A12 12 0 0 1/g, "rounded 12");
  assert.strictEqual((play[0].match(/A12 12/g) || []).length, 3, "three corners, each radius 12");
  const b = bbox(pathPoints(play[0]));
  /* tangent points of an equilateral triangle, circumradius 104 centred on x=136, y=128 */
  assert.ok(Math.abs((b.y0 + b.y1) / 2 - 128) < 0.3, `vertically centred (${(b.y0 + b.y1) / 2})`);
  const tip = b.x1, back = b.x0;
  assert.ok(Math.abs(back - 84) < 8 && tip > 220 && tip < 232, `the triangle spans ${back}..${tip}`);
  /* the centroid of the three corner arcs' tangent points, i.e. of the triangle: 136 */
  const pts = pathPoints(play[0]).filter((_, i) => i % 1 === 0);
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  assert.ok(Math.abs(cx - 136) < 3, `centroid ${cx.toFixed(1)} is the circumcentre 136, i.e. 128 + 8`);
  const pause = pathsOf(symbols(SPRITE).find((x) => x.id === "i-pause").body);
  assert.strictEqual(pause.length, 2);
  const [l, r] = pause.map((d) => bbox(pathPoints(d)));
  assert.strictEqual(l.x1 - l.x0, 40); assert.strictEqual(r.x1 - r.x0, 40);
  assert.strictEqual(r.x0 - l.x1, 32);
  assert.ok(Math.abs((l.x0 + r.x1) / 2 - 128) < 0.01, "the pair is centred on 128");
});

test("roundedPolygon and offsetPolygon: the geometry helpers the custom glyphs stand on", async () => {
  /* MUTATION: flip `area > 0 ? 1 : 0` in roundedPolygon -> the arc sweep flips and the first assertion fails;
     flip the sign of `outward` in offsetPolygon -> the square shrinks instead of growing and the second fails. */
  const mod = await import(pathToFileURL(path.join(ROOT, "tools", "icons", "build-sprite.mjs")).href);
  /* a clockwise (screen) 10x10 square with r=2 */
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.strictEqual(mod.roundedPolygon(sq, 2), "M0 2A2 2 0 0 1 2 0L8 0A2 2 0 0 1 10 2L10 8A2 2 0 0 1 8 10L2 10A2 2 0 0 1 0 8Z");
  assert.deepStrictEqual(mod.offsetPolygon(sq, 1).map((p) => p.map((n) => Math.round(n * 1000) / 1000)), [[-1, -1], [11, -1], [11, 11], [-1, 11]]);
  const ccw = [...sq].reverse();
  assert.deepStrictEqual(mod.offsetPolygon(ccw, 1).map((p) => p.map((n) => Math.round(n * 1000) / 1000)), [[-1, 11], [11, 11], [11, -1], [-1, -1]], "either winding grows outward");
});

/* ---------------------------------------------------------------------- helper */

function loadHelper() {
  const esc = /function esc\(s\) \{[\s\S]*?\n\}/.exec(read("app.js"));
  assert.ok(esc, "esc() is lifted from app.js, the real one");
  const src = esc[0] + "\n" + read("ui/icons.js") + "\n;({ agIcon, agIconGallery, AG_ICON_NAMES, AG_ICON_SIZES, AG_ICON_SPRITE })";
  return vm.runInNewContext(src, {}, { filename: "ui/icons.js" });
}

test("the helper's names are the sprite's ids, in the same order, and its sprite path is the file", () => {
  /* MUTATION: remove "trash" from AG_ICON_NAMES, or change AG_ICON_SPRITE to "icons.svg" -> red. */
  const h = loadHelper();
  assert.deepStrictEqual(Array.from(h.AG_ICON_NAMES, (n) => "i-" + n), PLAN_IDS); /* Array.from: the vm context has its own Array */
  assert.strictEqual(h.AG_ICON_SPRITE, "ui/icons.svg");
  assert.ok(fs.existsSync(path.join(ROOT, h.AG_ICON_SPRITE)), "the path the helper writes is a file in the repo");
});

test("agIcon writes a use-reference to the sprite, aria-hidden, with the size as a class", () => {
  /* MUTATION: drop aria-hidden="true", write a style="width:.." instead of the class, or point the href at
     "icons.svg#" -> red on the exact string. */
  const h = loadHelper();
  assert.strictEqual(h.agIcon("house"), '<svg class="icon" aria-hidden="true" focusable="false"><use href="ui/icons.svg#i-house"></use></svg>');
  assert.strictEqual(h.agIcon("house", 28), '<svg class="icon icon-28" aria-hidden="true" focusable="false"><use href="ui/icons.svg#i-house"></use></svg>');
  assert.strictEqual(h.agIcon("play", 24), h.agIcon("play"));
  for (const n of h.AG_ICON_NAMES) for (const s of h.AG_ICON_SIZES) {
    const out = h.agIcon(n, s);
    assert.ok(out.includes(`#i-${n}"`), `${n} at ${s}`);
    assert.doesNotMatch(out, /style=|on\w+=|<script/i);
  }
});

test("agIcon returns nothing for a name or size it does not know, so no caller string reaches the markup", () => {
  /* MUTATION: delete the `AG_ICON_NAMES.includes(name)` guard -> the injection strings below render; delete the
     size guard -> `agIcon("house", 99)` renders a class nobody styles. */
  const h = loadHelper();
  for (const bad of ['house"><script>alert(1)</script>', "house#i-trash", "../x", "", "I-HOUSE", "i-house", undefined, null, 7, {}, ["house"], "constructor", "__proto__", "toString"]) {
    assert.strictEqual(h.agIcon(bad), "", `name ${String(bad)}`);
  }
  for (const bad of [0, 19, 25, 99, -24, NaN, "28", null, 28.5, '28" onload="x', {}, [28]]) {
    assert.strictEqual(h.agIcon("house", bad), "", `size ${String(bad)}`);
  }
});

test("the gallery section draws every symbol once at 24 and the transport and tab glyphs at every size", () => {
  /* MUTATION: skip one name in the first list, or drop `.join("")` of the sizes row -> red on the counts. */
  const h = loadHelper();
  const html = h.agIconGallery();
  const [grid, sizes] = html.split('<h3 class="ag-icons-title">Sizes</h3>');
  for (const n of h.AG_ICON_NAMES) assert.strictEqual((grid.match(new RegExp(`#i-${n}"`, "g")) || []).length, 1, `${n} once in the grid`);
  assert.strictEqual((grid.match(/<use /g) || []).length, 37);
  assert.strictEqual((sizes.match(/<use /g) || []).length, 5 * h.AG_ICON_SIZES.length);
  for (const s of h.AG_ICON_SIZES.filter((x) => x !== 24)) assert.ok(sizes.includes(`icon-${s}"`), `size ${s} appears`);
  assert.doesNotMatch(html, /style=|<script|on\w+=/i);
});

/* ----------------------------------------------------------------- call sites */

test("scanner: iconRefs finds a bad agIcon name and a bad fragment, and passes good ones", () => {
  /* MUTATION: change the agIcon regex to require double quotes only, or drop the fragment loop -> red.
     (This is the harness audit for the next test: it runs the scanner on source that IS wrong.) */
  const known = new Set(PLAN_IDS);
  const wrong = (src) => iconRefs(src).filter((r) => !known.has(r.id)).map((r) => r.id);
  assert.deepStrictEqual(wrong('el.innerHTML = agIcon("house") + agIcon( \'play\', 36 );'), []);
  assert.deepStrictEqual(wrong('agIcon("hose")'), ["i-hose"]);
  assert.deepStrictEqual(wrong("agIcon('compas', 28)"), ["i-compas"]);
  assert.deepStrictEqual(wrong('<use href="ui/icons.svg#i-nope"></use>'), ["i-nope"]);
  assert.deepStrictEqual(wrong('<use href="ui/icons.svg#i-house"></use>'), []);
});

test("every icon a screen asks for by name exists in the sprite (vacuous today; the net for Phase 4)", () => {
  /* MUTATION: add `agIcon("not-a-symbol")` to any ui/*.js (or rename a sprite symbol a screen already uses)
     -> red, naming file and id. Today no screen calls it, so this cannot fail on today's data: it is
     written deliberately (CLAUDE.md "A green test is not evidence" item 5) and the scanner test above
     is what proves the scanner works. */
  const known = new Set(symbols(SPRITE).map((s) => s.id));
  const files = ["app.js", ...fs.readdirSync(path.join(ROOT, "ui")).filter((f) => f.endsWith(".js") && f !== "icons.js" && !f.endsWith(".test.js")).map((f) => `ui/${f}`)];
  const bad = [];
  for (const f of files) for (const r of iconRefs(read(f))) if (!known.has(r.id)) bad.push(`${f}: ${r.kind} ${r.id}`);
  assert.deepStrictEqual(bad, []);
});

/* ------------------------------------------------------------------------ CSS */

function tokensCss() {
  return read("ui/tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");
}

test("the plan's five sizes are tokens, and each non-default size is a class that moves one token", () => {
  /* MUTATION: change `--icon-tab: 28px` to 26px, delete the `.icon-32` rule, or point `.icon-36` at --icon-lg
     -> red. Add 40 to AG_ICON_SIZES in ui/icons.js without a class -> red. */
  const css = tokensCss();
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  const tok = (n) => (new RegExp(`${n}:\\s*([^;]+);`).exec(root) || [])[1];
  assert.deepStrictEqual(
    ["--icon-sm", "--icon", "--icon-tab", "--icon-lg", "--icon-play"].map(tok),
    ["20px", "24px", "28px", "32px", "36px"],
  );
  const cls = { 20: "--icon-sm", 28: "--icon-tab", 32: "--icon-lg", 36: "--icon-play" };
  for (const [px, token] of Object.entries(cls)) {
    assert.ok(css.includes(`.ag .icon-${px}, .room .icon-${px} { --icon-size: var(${token}); }`), `.icon-${px} -> ${token}`);
  }
  const h = loadHelper();
  for (const s of h.AG_ICON_SIZES.filter((x) => x !== 24)) assert.ok(cls[s], `the helper's size ${s} has a class`);
});

test("`.icon` is currentColor, unstroked, fixed-size, and scoped to .ag / .room so no legacy screen changes", () => {
  /* MUTATION: change `fill: currentColor` to a colour, drop `stroke: none`, declare `.icon` unscoped, or drop
     `flex: none` -> red. */
  const css = tokensCss();
  const m = /\.ag \.icon, \.room \.icon \{([^}]*)\}/.exec(css);
  assert.ok(m, "the scoped .icon rule exists");
  const decl = Object.fromEntries(m[1].split(";").map((x) => x.trim()).filter(Boolean).map((x) => x.split(/:\s*/)));
  assert.strictEqual(decl.fill, "currentColor");
  assert.strictEqual(decl.stroke, "none");
  assert.strictEqual(decl.width, "var(--icon-size, var(--icon))");
  assert.strictEqual(decl.height, "var(--icon-size, var(--icon))");
  assert.strictEqual(decl.flex, "none", "a glyph never shrinks inside a flex row");
  assert.strictEqual(decl["pointer-events"], "none", "the control owns the tap");
  const unscoped = [...css.matchAll(/(^|\})\s*([^{}@]*\.icon[^{},]*)[,{]/g)].map((x) => x[2].trim()).filter((s) => !/^\.(?:ag|room) /.test(s));
  assert.deepStrictEqual(unscoped, [], "no `.icon` selector outside .ag / .room");
  assert.doesNotMatch(read("styles.css"), /(^|[\s,}])\.icon(-\d+)?\s*[,{]/, "styles.css declares no .icon, so the names are free");
});

/* --------------------------------------------------------------------- wiring */

test("the shell ships the sprite: manifest, web dist and Capacitor webDir, with the same no-cache header as ui/", async () => {
  /* MUTATION: remove "ui/icons.svg" from SHELL in tools/ci/generate-manifest.mjs or tools/web/prepare-dist.mjs, or
     from SHELL_FILES in tools/mobile/prepare-webdir.mjs, or drop the <script src="ui/icons.js"> tag -> red. */
  const shell = (rel, re) => {
    const m = re.exec(read(rel));
    assert.ok(m, `${rel}: list found`);
    return m[1];
  };
  assert.match(shell("tools/ci/generate-manifest.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/icons\.svg"/, "generate-manifest SHELL");
  assert.match(shell("tools/web/prepare-dist.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/icons\.svg"/, "prepare-dist SHELL");
  const pw = await import(pathToFileURL(path.join(ROOT, "tools", "mobile", "prepare-webdir.mjs")).href);
  assert.ok(pw.SHELL_FILES.includes("ui/icons.svg"), "prepare-webdir SHELL_FILES");
  assert.match(read("index.html"), /<script src="ui\/icons\.js"><\/script>/);
  const vercel = JSON.parse(read("vercel.json"));
  assert.ok(vercel.headers.some((h) => h.source === "/ui/(.*)" && /must-revalidate/.test(JSON.stringify(h.headers))), "ui/* revalidates, the sprite included");
  /* the sprite is same-origin and the CSP already allows it: nothing about it asks for a looser policy */
  const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(read("index.html"))[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
});
