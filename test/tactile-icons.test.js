/* Redesign 2026, Phase 3, task "sprite": the Tactile icon sprite.
 *
 * What this pins (docs/redesign-2026/directions/tactile/BUILD-PLAN.md 1.5):
 *   - index.html carries ONE inline sprite with the 41 symbols of the
 *     prototype's exact set, each id once, and no other element in the page
 *     takes one of those ids (a `<use href="#band">` must reach the symbol, not
 *     whatever else is called `band`);
 *   - the sprite is inert: first thing in <body>, aria-hidden, focusable=false,
 *     0x0 and absolutely positioned (so adding it moves no pixel of any screen),
 *     no inline style, no script, no <image>, no external reference (strict CSP);
 *   - the families: 27 Phosphor Bold + 7 Phosphor Fill on the 256 grid, the 7
 *     custom marks on the 24 grid with round caps; the knob keeps its anatomy
 *     and nothing above its disc;
 *   - every `<use>` in the app (index.html outside the sprite, app.js, ui/*.js)
 *     points at an id in the set, and every `<svg class="i">` is decorative
 *     (`aria-hidden="true"`), the label living on the button;
 *   - the CSS that sizes and hides it.
 *
 * What it does NOT pin: any listener screen. The development-only component
 * gallery shows the family; listener screens swap their Unicode glyphs for it
 * in Phase 4. The use-scanner's teeth are also proven on wrong fixtures, so a
 * live app with only valid references cannot make the scanner vacuous.
 *
 * MUTATIONS (each run and seen red; the one-line edit is in each test's comment).
 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { appFiles } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const BOLD = [
  "ph-play", "ph-pause", "ph-sun-horizon", "ph-magnifying-glass", "ph-bookmarks", "ph-caret-down",
  "ph-arrow-left", "ph-dots-three", "ph-plus", "ph-check", "ph-check-circle", "ph-cloud-slash",
  "ph-bookmark-simple", "ph-list-plus", "ph-timer", "ph-share-network", "ph-x", "ph-arrow-up",
  "ph-arrow-down", "ph-trash", "ph-radio", "ph-speaker-high", "ph-moon", "ph-sun", "ph-list-bullets",
  "ph-shuffle", "ph-sparkle",
];
const FILL = [
  "ph-play-fill", "ph-pause-fill", "ph-sun-horizon-fill", "ph-magnifying-glass-fill",
  "ph-bookmarks-fill", "ph-bookmark-simple-fill", "ph-check-circle-fill",
];
const CUSTOM = ["skip-15", "skip-30", "band", "needle", "bridge", "narration", "knob"];
const IDS = [...BOLD, ...FILL, ...CUSTOM];

const html = read("index.html");

/** The sprite element's text, from its opening tag to the matching close. The
 *  sprite holds no nested <svg>, so the first </svg> after it is its own. */
function spriteOf(src) {
  const open = src.search(/<svg\b[^>]*\bclass="sprite"/);
  if (open < 0) return null;
  const close = src.indexOf("</svg>", open);
  return { start: open, end: close + "</svg>".length, text: src.slice(open, close + "</svg>".length) };
}
const SPRITE = spriteOf(html);

function symbolsOf(sprite) {
  const out = [];
  const re = /<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g;
  let m;
  while ((m = re.exec(sprite))) {
    const id = (/\bid="([^"]*)"/.exec(m[1]) || [])[1];
    out.push({ id, attrs: m[1], body: m[2], viewBox: (/\bviewBox="([^"]*)"/.exec(m[1]) || [])[1] });
  }
  return out;
}

/** Violations of the two <use> / <svg class="i"> rules in one source file.
 *  `dynamicOk` names the one file allowed to build an href from a variable (the
 *  primitives helper, which owns validating against the set at its call sites). */
function iconViolations(src, file, ids, dynamicOk) {
  const bad = [];
  const useRe = /<use\b[^>]*>/g;
  let m;
  while ((m = useRe.exec(src))) {
    const tag = m[0];
    const href = /\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/.exec(tag);
    if (!href) { bad.push(`${file}: <use> with no href: ${tag}`); continue; }
    const v = href[2];
    if (/\$\{|["']\s*\+|\+\s*["']/.test(v) || /\bhref\s*=\s*["']#["']\s*\+/.test(tag)) {
      if (!dynamicOk.includes(file)) bad.push(`${file}: dynamic <use> href outside ${dynamicOk.join(", ")}: ${tag}`);
      continue;
    }
    if (!v.startsWith("#")) { bad.push(`${file}: <use> reaches outside the document (CSP-safe sprite is inline): ${tag}`); continue; }
    if (!ids.includes(v.slice(1))) bad.push(`${file}: <use> points at "${v}", not in the sprite: ${tag}`);
  }
  const svgRe = /<svg\b[^>]*\bclass="[^"]*\bi\b[^"]*"[^>]*>/g;
  while ((m = svgRe.exec(src))) {
    if (!/\baria-hidden="true"/.test(m[0])) bad.push(`${file}: icon <svg class="i"> is not aria-hidden="true" (the label lives on the button): ${m[0]}`);
  }
  return bad;
}

test("the sprite carries exactly the 41 prototype ids, each once", () => {
  // MUTATION: rename `knob` to `dial` in index.html's sprite (id="knob" -> id="dial"): the set no longer matches.
  // MUTATION: copy any one <symbol> line a second time: "each once" fails.
  assert.ok(SPRITE, "index.html has no <svg class=\"sprite\">");
  assert.strictEqual((html.match(/class="sprite"/g) || []).length, 1, "exactly one sprite");
  const syms = symbolsOf(SPRITE.text);
  const ids = syms.map((s) => s.id);
  assert.strictEqual(IDS.length, 41, "the expected list itself is 41 (27 + 7 + 7)");
  assert.strictEqual(new Set(IDS).size, 41, "the expected list has no repeats");
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepStrictEqual(dupes, [], "an id appears twice: " + dupes.join(", "));
  assert.deepStrictEqual([...ids].sort(), [...IDS].sort());
  assert.strictEqual(syms.length, (SPRITE.text.match(/<symbol\b/g) || []).length, "every <symbol> parsed (none unclosed)");
});

test("safeUrl's fragment allow-list (app.js SPRITE_IDS) is exactly the sprite, and a rendered icon's href survives it", () => {
  /* Every icon <use href> goes through safeUrl, which passes "#" + an id in
     SPRITE_IDS and answers "#" otherwise. A list that drifts from the sprite
     either draws empty icons (an id missing) or widens the gate (an id the
     sprite does not have).
     MUTATION: delete "knob" from SPRITE_IDS in app.js -> the set comparison
     fails, and tactileIcon("knob") renders href="#ph-radio".
     MUTATION 2: delete the SPRITE_IDS line in safeUrl -> the rendered href is
     "#" and the last assertions fail. */
  const m = /^const SPRITE_IDS = new Set\(\[([\s\S]*?)\]\);$/m.exec(read("app.js"));
  assert.ok(m, "app.js declares SPRITE_IDS at top level");
  const listed = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.strictEqual(new Set(listed).size, listed.length, "SPRITE_IDS repeats an id");
  assert.deepStrictEqual([...listed].sort(), [...IDS].sort());
  const { load } = require("./helpers/tactile-primitives.js");
  const p = load();
  assert.match(p.tactileIcon("knob"), /<use href="#knob"><\/use>/);
  assert.match(p.tactileIcon("ph-play-fill", "lg"), /<use href="#ph-play-fill"><\/use>/);
  assert.match(p.tactileIcon('x" onload="alert(1)'), /<use href="#ph-radio"><\/use>/, "an unknown id falls back to a drawn glyph");
});

test("no other element in the page takes a sprite id, and no script emits one", () => {
  // MUTATION: add `<div id="band"></div>` to index.html, or `id="needle"` to a template in ui/*.js.
  const rest = html.slice(0, SPRITE.start) + html.slice(SPRITE.end);
  const taken = [];
  for (const id of IDS) {
    if (new RegExp(`\\bid\\s*=\\s*["']${id}["']`).test(rest)) taken.push(`index.html:${id}`);
    for (const f of appFiles()) {
      const src = read(f);
      if (new RegExp(`\\bid\\s*=\\s*\\\\?["']${id}\\\\?["']|\\.id\\s*=\\s*["']${id}["']|getElementById\\(\\s*["']${id}["']`).test(src)) taken.push(`${f}:${id}`);
    }
  }
  assert.deepStrictEqual(taken, []);
});

test("the sprite is inert and moves nothing: first in body, hidden, 0x0, absolute, no script / style / image / external href", () => {
  // MUTATION: delete aria-hidden="true" from the sprite tag; or add width="24" to it; or put an <image href="https://..."/> inside it.
  const open = SPRITE.text.slice(0, SPRITE.text.indexOf(">") + 1);
  assert.match(open, /\baria-hidden="true"/);
  assert.match(open, /\bfocusable="false"/);
  assert.match(open, /\bwidth="0"/);
  assert.match(open, /\bheight="0"/);
  assert.doesNotMatch(open, /\bstyle=/);
  const body = html.slice(html.search(/<body\b[^>]*>/));
  const afterBody = body.slice(body.indexOf(">") + 1).replace(/<!--[\s\S]*?-->/g, "").trimStart();
  assert.ok(afterBody.startsWith(open), "the sprite is the first element in <body>, ahead of every screen");
  for (const bad of [/<script\b/i, /<style\b/i, /<image\b/i, /<foreignObject\b/i, /\sstyle\s*=/i, /\son[a-z]+\s*=/i, /javascript:/i, /\bhref\s*=\s*["'](?!#)/i, /url\(\s*["']?(?!#)/i]) {
    assert.doesNotMatch(SPRITE.text, bad, "forbidden in the sprite: " + bad);
  }
  const css = read("styles.css");
  const rule = /\.sprite\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "styles.css has no .sprite rule");
  for (const d of ["position: absolute", "width: 0", "height: 0", "overflow: hidden"]) assert.ok(rule[1].includes(d), `.sprite lacks ${d}`);
});

test("families: Phosphor on the 256 grid, custom marks on the 24 grid with round caps", () => {
  // MUTATION: change one Phosphor symbol's viewBox to "0 0 24 24"; or set stroke-linecap="butt" on the `band` symbol.
  const syms = symbolsOf(SPRITE.text);
  const byId = Object.fromEntries(syms.map((s) => [s.id, s]));
  for (const id of [...BOLD.filter((i) => i !== "ph-sparkle"), ...FILL]) {
    assert.strictEqual(byId[id].viewBox, "0 0 256 256", id + " is a Phosphor symbol on the 256 grid");
    assert.match(byId[id].body, /<path\b/, id + " draws a path");
  }
  // ph-sparkle is the one Bold glyph drawn on the 24 grid with the custom marks' stroke recipe (the prototype's set, verbatim).
  for (const id of ["ph-sparkle", ...CUSTOM]) assert.strictEqual(byId[id].viewBox, "0 0 24 24", id + " is on the 24 grid");
  for (const id of ["ph-sparkle", ...CUSTOM.filter((i) => i !== "knob")]) {
    const strokes = byId[id].body.match(/stroke-width="[^"]*"/g) || [];
    if (strokes.length) assert.match(byId[id].body, /stroke-linecap="round"/, id + " uses round caps");
  }
  for (const id of ["skip-15", "skip-30"]) {
    assert.match(byId[id].body, /<text\b[^>]*>(15|30)<\/text>/, id + " carries its numeral");
    assert.ok(byId[id].body.includes(id === "skip-15" ? ">15<" : ">30<"));
    assert.match(byId[id].body, /font-size="8"/);
    assert.match(byId[id].body, /font-weight="700"/);
  }
});

test("the vendored Phosphor glyphs carry the complete upstream MIT notice", () => {
  // MUTATION: delete `Copyright (c) 2023 Phosphor Icons` from Phosphor-Icons-LICENSE; this test must fail.
  const license = read("docs/legal/licenses/Phosphor-Icons-LICENSE").trim();
  const upstream = [
    "MIT License",
    "",
    "Copyright (c) 2023 Phosphor Icons",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    'of this software and associated documentation files (the "Software"), to deal',
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE.",
  ].join("\n");
  assert.strictEqual(license, upstream, "the committed licence must match phosphor-icons/core LICENSE");

  const notices = read("docs/legal/third-party-notices.md");
  assert.match(notices, /## Phosphor Icons — application icon glyphs/);
  assert.match(notices, /\*\*Licence:\*\* MIT/);
  assert.match(notices, /Copyright \(c\) 2023 Phosphor Icons/);
  assert.match(notices, /docs\/legal\/licenses\/Phosphor-Icons-LICENSE/);
});

test("knob keeps its anatomy and nothing sits above the disc", () => {
  // MUTATION: add <circle cx="12" cy="2" r="1"/> (a pointer dot above the disc) to the knob symbol; or move the disc to cy="12".
  const knob = symbolsOf(SPRITE.text).find((s) => s.id === "knob");
  assert.ok(knob);
  const shapes = knob.body.match(/<(circle|path|rect|line|ellipse|polygon|polyline|text)\b[^>]*>/g) || [];
  assert.strictEqual(shapes.length, 4, "disc, groove, two end-stop dots: " + shapes.join(" "));
  assert.ok(shapes.some((s) => /<circle\b[^>]*\bcx="12"[^>]*\bcy="11"[^>]*\br="8"/.test(s)), "disc cx 12 cy 11 r 8");
  assert.ok(shapes.some((s) => /<path\b[^>]*class="knob-groove"[^>]*\bd="M12 11L7\.4 6\.4"[^>]*stroke-width="2\.5"[^>]*stroke-linecap="round"/.test(s) || /<path\b[^>]*\bd="M12 11L7\.4 6\.4"[^>]*class="knob-groove"/.test(s)), "groove (12,11) to (7.4,6.4), 2.5px, round");
  for (const [cx, cy] of [[4, 20.5], [20, 20.5]]) {
    assert.ok(shapes.some((s) => s.includes(`cx="${cx}"`) && s.includes(`cy="${cy}"`) && /\br="1\.4"/.test(s)), `end-stop dot r1.4 at (${cx},${cy})`);
  }
  // Nothing above the disc: no circle's top edge (cy - r) is higher than the disc's (11 - 8 = 3), and no path starts above it.
  const tops = shapes.filter((s) => s.startsWith("<circle")).map((s) => Number(/cy="([\d.]+)"/.exec(s)[1]) - Number(/\br="([\d.]+)"/.exec(s)[1]));
  assert.ok(Math.min(...tops) >= 3, "a mark above the disc: top edges " + tops.join(","));
});

test("every <use> in the app points into the set; every icon <svg> is decorative (scanner, on live files and on fixtures)", () => {
  // MUTATION (live): add `<svg class="i"><use href="#ph-nope"/></svg>` to a ui/*.js template: fails here.
  // MUTATION (scanner): make iconViolations ignore the id check (drop the `ids.includes` line): the fixtures below stop failing.
  const dynamicOk = ["ui/primitives.js"];
  const live = [];
  const pageOutsideSprite = (html.slice(0, SPRITE.start) + html.slice(SPRITE.end)).replace(/<!--[\s\S]*?-->/g, ""); // prose in a comment is not markup
  live.push(...iconViolations(pageOutsideSprite, "index.html", IDS, dynamicOk));
  for (const f of appFiles()) live.push(...iconViolations(read(f), f, IDS, dynamicOk));
  assert.deepStrictEqual(live, []);

  // The live app has no <use> yet, so prove the scanner can fail. These are fixtures of the wrong thing, and each must be caught.
  const must = (src, file, needle) => {
    const v = iconViolations(src, file || "ui/x.js", IDS, dynamicOk);
    assert.ok(v.some((s) => s.includes(needle)), `scanner missed (${needle}): ${src} -> ${JSON.stringify(v)}`);
  };
  must('<svg class="i" aria-hidden="true"><use href="#ph-nope"/></svg>', null, "not in the sprite");
  must('<svg class="i" aria-hidden="true"><use href="#dial"/></svg>', null, "not in the sprite"); // a renamed knob
  must('<svg class="i" aria-hidden="true"><use href="icons.svg#ph-play"/></svg>', null, "outside the document");
  must('<svg class="i" aria-hidden="true"><use href="https://x.test/s.svg#ph-play"/></svg>', null, "outside the document");
  must('<svg class="i"><use href="#ph-play"/></svg>', null, "not aria-hidden");
  must('<svg class="i i--lg"><use href="#ph-play"/></svg>', null, "not aria-hidden");
  must("<svg class=\"i\" aria-hidden=\"true\"><use href=\"#ph-' + name + '\"/></svg>", "ui/home.js", "dynamic <use> href");
  must('<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>', "ui/home.js", "dynamic <use> href");
  must('<svg class="i" aria-hidden="true"><use/></svg>', null, "no href");
  // And the good shapes pass, so the scanner is not simply failing everything.
  assert.deepStrictEqual(iconViolations('<svg class="i" aria-hidden="true"><use href="#ph-play"/></svg>', "ui/x.js", IDS, dynamicOk), []);
  assert.deepStrictEqual(iconViolations('<svg class="i i--sm" aria-hidden="true" focusable="false"><use href="#knob"/></svg>', "ui/x.js", IDS, dynamicOk), []);
  assert.deepStrictEqual(iconViolations('<svg class="i" aria-hidden="true"><use href="#${esc(id)}"/></svg>', "ui/primitives.js", IDS, dynamicOk), []);
});

test("the guarded gallery displays every sprite symbol exactly once", () => {
  // MUTATION: delete the `<use href="#knob">` gallery item: the gallery id set no longer matches the sprite.
  const gallery = read("ui/gallery.js");
  const uses = [...gallery.matchAll(/<use\b[^>]*\bhref="#([^"]+)"[^>]*>/g)].map((m) => m[1]);
  assert.deepStrictEqual([...uses].sort(), [...IDS].sort());
  assert.strictEqual(new Set(uses).size, IDS.length, "the gallery repeats an icon instead of showing the full family");
  assert.match(read("app.js"), /h === "#\/gallery" && galleryEnabled\(\)/, "the router must guard the gallery");
  assert.match(read("tools/ui-lab/lib/states.mjs"), /id: "gallery"[\s\S]*route: "\?gallery=1#\/gallery"/, "the UI lab must be able to shoot the guarded route");
  for (const label of ["icons-bold", "icons-fill", "icons-custom"]) {
    assert.match(read("tools/ui-lab/lib/states.mjs"), new RegExp(`label: "${label}"`), `the baseline must cover ${label}`);
  }
});

test("only a boolean Lab flag or the explicit gallery query enables the route", () => {
  // MUTATION: change `window.__FORAY_LAB__ === true` in app.js to `Boolean(window.__FORAY_LAB__)`: the stray-string case turns red.
  // MUTATION: change the gallery query comparison from `=== "1"` to truthiness: `?gallery=0` turns red.
  const app = read("app.js");
  const gallery = read("ui/gallery.js");
  const isLab = /function isLabBuild\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  const enabled = /function galleryEnabled\(\) \{[\s\S]*?\n\}/.exec(gallery)[0];
  const run = (lab, search) => vm.runInNewContext(`${isLab}\n${enabled}\ngalleryEnabled()`, {
    window: lab === undefined ? {} : { __FORAY_LAB__: lab },
    location: { search },
    URLSearchParams,
  });
  assert.strictEqual(run(true, ""), true);
  assert.strictEqual(run(false, "?gallery=1"), true);
  assert.strictEqual(run(undefined, "?gallery=1"), true);
  assert.strictEqual(run(false, ""), false);
  assert.strictEqual(run("true", ""), false);
  assert.strictEqual(run(false, "?gallery=0"), false);
});

test("the CSS: one icon size, colour from the text, the knob groove cut in the keycap fill", () => {
  // MUTATION: change `.i { width: 24px }` to 22px; drop `fill: currentColor`; change the groove stroke to a literal colour.
  const css = read("styles.css");
  const grab = (sel) => {
    const m = new RegExp("(?:^|\\n)" + sel.replace(/[.\-]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(css);
    assert.ok(m, `no ${sel} rule`);
    return m[1];
  };
  const i = grab(".i");
  assert.match(i, /width:\s*24px/);
  assert.match(i, /height:\s*24px/);
  assert.match(i, /fill:\s*currentColor/);
  assert.match(i, /flex:\s*none/);
  assert.match(grab(".i--sm"), /width:\s*20px;\s*height:\s*20px/);
  assert.match(grab(".i--lg"), /width:\s*32px;\s*height:\s*32px/);
  assert.match(grab(".knob-groove"), /stroke:\s*var\(--k-fill,\s*var\(--card\)\)/);
  // No transition or animation of its own: a later one must join the single reduced-motion block.
  for (const sel of [".sprite", ".i", ".i--sm", ".i--lg", ".knob-groove"]) assert.doesNotMatch(grab(sel), /transition|animation/, sel);
});
