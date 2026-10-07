/* Tactile Phase 3 deck, tab bar, and mini player. Each mutation below was run
 * and made this suite red before the final implementation was restored. */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { load, rule, ROOT, CSS_RULES } = require("./helpers/tactile-primitives.js");

const p = load();

test("the deck is fixed to the bottom, inset 16px, and floats 12px above the safe area", () => {
  /* BUILD-NOTES 3.11: `position: fixed`, left/right 16px, bottom
     calc(var(--safe-b) + 12px). An adoption-ready deck carries this itself;
     the gallery must not be the only thing that places it.
     MUTATION: delete `position: fixed;` from the .deck rule -> red.
     MUTATION 2: change its bottom to `var(--s-3)` (no safe-area offset) -> red. */
  const deck = rule(".deck");
  assert.match(deck, /(?:^|;)\s*position:\s*fixed\s*;/);
  assert.match(deck, /(?:^|;)\s*bottom:\s*calc\(var\(--safe-b\)\s*\+\s*var\(--s-3\)\)\s*;/);
  assert.match(deck, /(?:^|;)\s*left:\s*calc\(env\(safe-area-inset-left,\s*0px\)\s*\+\s*var\(--s-4\)\)\s*;/);
  assert.match(deck, /(?:^|;)\s*right:\s*calc\(env\(safe-area-inset-right,\s*0px\)\s*\+\s*var\(--s-4\)\)\s*;/);
  assert.match(deck, /(?:^|;)\s*z-index:\s*\d+\s*;/);
  assert.doesNotMatch(deck, /(?:^|;)\s*width:/, "left/right size the deck; a width would fight them");
});

test("no stylesheet rule moves the deck out of fixed positioning (so no specimen can mask it)", () => {
  /* The gallery used to show the deck in normal flow, which hid that the
     primitive was not fixed at all. Now the specimen sits in .gallery-device,
     whose layout containment makes the frame the containing block of the real
     fixed deck: any rule that re-positions `.deck` is the masking again.
     MUTATION: add `.gallery-decks .deck { position: static; }` to styles.css -> red.
     MUTATION 2: drop `contain: layout;` from .gallery-device -> red. */
  const offenders = [];
  for (const m of CSS_RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const targetsDeck = m[1].split(",").some((sel) => /\.deck(?![\w-])\s*$/.test(sel.trim()));
    const pos = /(?:^|;)\s*position:\s*([a-z-]+)/.exec(m[2]);
    if (targetsDeck && pos && pos[1] !== "fixed") offenders.push(m[1].trim() + " -> " + pos[1]);
  }
  assert.deepStrictEqual(offenders, []);
  assert.match(rule(".gallery-device"), /(?:^|;)\s*contain:\s*layout\s*;/);
  const gallery = fs.readFileSync(path.join(ROOT, "ui", "gallery.js"), "utf8");
  const calls = gallery.match(/tactileTabBar\(/g) || [];
  const framed = gallery.match(/<div class="gallery-device[^"]*">' \+ tactileTabBar\(/g) || [];
  assert.ok(calls.length >= 2, "fixture premise: the gallery shows decks");
  assert.strictEqual(framed.length, calls.length, "every deck specimen sits in a .gallery-device frame");
});

test("the mini player carries the 3px progress line along its top edge: a foray's colours, or persimmon for one episode", () => {
  /* BUILD-NOTES 3.12: `.band--line` 3px along the top edge (foray colours, or
     --persimmon for an episode). Decorative (the region label names what is
     playing), no needle, bars the full 3px.
     MUTATION: drop `progressLine +` from tactileMiniPlayer -> red.
     MUTATION 2: drop the `episode` fallback in tactileBand -> the episode line has no bar and this fails. */
  const segments = [
    { showId: "origin", show: "Origin Stories", duration: 400 },
    { showId: "n", show: "4a narration", duration: 30, narration: true },
    { showId: "bbq", show: "BBQ Radio Network", duration: 300 },
  ];
  const foray = p.tactileMiniPlayer({ title: "Episode", show: "Show", segments, progress: 0.5 });
  const line = /^<section class="mini"[^>]*>(<svg class="band band--line"[^>]*>[\s\S]*?<\/svg>)<button type="button" class="mini__body"/.exec(foray);
  assert.ok(line, "the line is the mini's first child, before the body button");
  const svg = line[1];
  assert.match(svg, /^<svg class="band band--line" aria-hidden="true" focusable="false"/);
  assert.doesNotMatch(svg, /role=|class="needle"|t-band__code|data-draw/);
  const base = /<g class="t-band__base">([\s\S]*?)<\/g>/.exec(svg)[1];
  const rects = [...base.matchAll(/<rect class="([^"]+)"[^>]*y="0" width="[\d.]+" height="60"/g)].map((m) => m[1]);
  assert.strictEqual(rects.length, 3, "one full-height bar per segment");
  assert.match(rects[0], /t-band__bar--c\d/);
  assert.match(rects[1], /t-band__bar--tick/);
  assert.match(svg, /clip-path="url\(#[^)]+-progress\)"/);

  const episode = p.tactileMiniPlayer({ title: "Episode", show: "Show", progress: 0.25 });
  const epBase = /<svg class="band band--line"[\s\S]*?<g class="t-band__base">([\s\S]*?)<\/g>/.exec(episode)[1];
  assert.deepStrictEqual([...epBase.matchAll(/<rect class="([^"]+)"/g)].map((m) => m[1]), ["t-band__bar t-band__bar--episode"]);
  assert.match(epBase, /x="0.00" y="0" width="1000.00" height="60"/);

  assert.match(rule(".band--line"), /height:\s*calc\(var\(--s-1\)\s*\*\s*\.75\)/, "3px: --s-1 is 4px");
  const placed = rule(".mini > .band--line");
  assert.match(placed, /position:\s*absolute/);
  assert.match(placed, /(?:^|;)\s*top:\s*0\s*;/);
  assert.match(placed, /pointer-events:\s*none/);
  /* The <svg> is a replaced element: left + right with `width: auto` draws it
     at its intrinsic 50px (3px tall at 1000:60), which the first gallery
     render of this fix showed. MUTATION 3: set the width back to `auto` -> red. */
  assert.match(placed, /(?:^|;)\s*width:\s*calc\(100%\s*-\s*2\s*\*\s*\(var\(--s-5\)\s*\+\s*var\(--s-1\)\s*\/\s*2\)\)\s*;/);
  assert.match(rule(".t-band__bar--episode"), /fill:\s*var\(--persimmon\)/);
});

test("the deck has exactly Today, Find, and Yours with no drawer destination", () => {
  // MUTATION: add a fourth Create tab to the `tabs` array -> the role=tab count fails.
  const html = p.tactileTabBar({ active: "find" });
  assert.strictEqual((html.match(/role="tab"/g) || []).length, 3);
  assert.deepStrictEqual([...html.matchAll(/class="tab__label">([^<]+)/g)].map((m) => m[1]), ["Today", "Find", "Yours"]);
  assert.doesNotMatch(html, /Create|drawer/i);
  assert.strictEqual((html.match(/aria-selected="true"/g) || []).length, 1);
});

test("the Yours badge exists only when Up Next is non-empty", () => {
  // MUTATION: remove the `Number(d.count) > 0` guard -> an empty badge appears and this test fails.
  assert.doesNotMatch(p.tactileTabBar({ count: 0 }), /tab__count/);
  assert.match(p.tactileTabBar({ count: 4 }), /class="tab__count readout">4<\/span>/);
});

test("collapsed deck height is 48px through the shared key token", () => {
  // MUTATION: change the collapsed tabbar height to `--deck-h` -> this test fails.
  assert.match(p.tactileTabBar({ collapsed: true }), /deck deck--collapsed/);
  assert.match(rule(".deck--collapsed .tabbar"), /height:\s*var\(--key\)/);
  assert.match(rule(".deck--collapsed .tab__label"), /opacity:\s*0/);
});

test("mini player is one region and its two keycaps are siblings of the body button", () => {
  // MUTATION: move tactileKeycap() before the mini body's `</button>` -> nested buttons make this test fail.
  const html = p.tactileMiniPlayer({ title: "Episode", show: "Show" });
  assert.match(html, /^<section class="mini" role="region" aria-label="Now playing:/);
  const bodyEnd = html.indexOf("</button>");
  const firstKey = html.indexOf('<button type="button" class="keycap');
  assert.ok(bodyEnd > 0 && firstKey > bodyEnd, "keycaps follow the closed mini body button");
  assert.strictEqual((html.match(/class="keycap\b/g) || []).length, 2);
});

test("the guarded gallery and harness show normal and collapsed deck states", () => {
  // MUTATION: delete the second `tactileTabBar` call from galleryNavigation -> collapsed coverage fails.
  const gallery = fs.readFileSync(path.join(ROOT, "ui", "gallery.js"), "utf8");
  const states = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs"), "utf8");
  assert.match(gallery, /tactileTabBar\(\{ active: "today"/);
  assert.match(gallery, /tactileTabBar\(\{ active: "yours", count: 4, collapsed: true \}\)/);
  assert.match(states, /label: "cream-navigation"/);
  assert.match(states, /label: "bakelite-navigation"/);
});
