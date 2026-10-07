/* Tactile Phase 3 deck, tab bar, and mini player. Each mutation below was run
 * and made this suite red before the final implementation was restored. */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { load, rule, ROOT } = require("./helpers/tactile-primitives.js");

const p = load();

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
