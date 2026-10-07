/* Tactile Phase 3 component gallery. Each test names the one-line mutation
 * used to prove it can fail; all three mutations were executed before push. */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { load, ROOT } = require("./helpers/tactile-primitives.js");

const gallerySource = fs.readFileSync(path.join(ROOT, "ui", "gallery.js"), "utf8").replace(/\r\n/g, "\n");
const statesSource = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs"), "utf8").replace(/\r\n/g, "\n");

function loadGallery() {
  const context = load();
  vm.runInContext(gallerySource, context, { filename: "ui/gallery.js" });
  return context;
}

test("the guarded gallery state shoots every Cream and Bakelite section", () => {
  // MUTATION: delete the `bakelite-type-and-contrast` step -> the expected label set fails.
  assert.match(gallerySource, /function galleryEnabled\(\)[\s\S]*isLabBuild\(\)[\s\S]*get\("gallery"\) === "1"/);
  assert.match(statesSource, /id: "gallery"[\s\S]*route: "\?gallery=1#\/gallery"/);
  for (const label of [
    "cream-type-and-contrast", "cream-controls", "cream-surfaces", "cream-rows", "cream-navigation", "cream-sheet-open",
    "bakelite-type-and-contrast", "bakelite-controls", "bakelite-surfaces", "bakelite-rows", "bakelite-navigation",
    "icons-bold", "icons-fill", "icons-custom",
  ]) assert.match(statesSource, new RegExp(`label: "${label}"`), `${label} is a gallery baseline shot`);
});

test("both authored schemes show all ten type roles and every contrast-table pair", () => {
  // MUTATION: remove the `segment-enamels` pair -> both 11-row table assertions fail.
  const gallery = loadGallery();
  const expectedRoles = ["display-xl", "display", "title", "heading", "body-lg", "body", "label", "micro", "readout-lg", "readout"];
  const expectedPairs = ["ink-paper", "ink-card", "ink-2-paper", "ink-3-paper", "on-persimmon", "on-ultramarine", "persimmon-paper", "ultramarine-paper", "good-paper", "warn-paper", "segment-enamels"];
  const schemes = [
    ["light", "Cream · primary", ["15.26", "17.01", "6.56", "5.14", "4.99", "7.53", "4.41", "6.65", "4.74", "4.79", "3.14"]],
    ["dark", "Bakelite · optional", ["15.76", "14.06", "8.85", "5.38", "6.07", "7.10", "6.49", "7.59", "8.56", "8.24", "5.47"]],
  ];
  for (const [scheme, label, ratios] of schemes) {
    const html = gallery.galleryTypeAndContrast(scheme, label);
    assert.deepStrictEqual([...html.matchAll(/data-type-role="([^"]+)"/g)].map((match) => match[1]), expectedRoles);
    assert.deepStrictEqual([...html.matchAll(/data-pair="([^"]+)"/g)].map((match) => match[1]), expectedPairs);
    assert.deepStrictEqual([...html.matchAll(/(?:≥ )?([0-9]+\.[0-9]+):1<\/strong>/g)].map((match) => match[1]), ratios);
    assert.match(html, /Today/);
    assert.match(html, /Podcasts, stitched around you\./);
    assert.match(html, /Barbecue: eight stories from a much longer history/);
    assert.strictEqual((html.match(/:1<\/strong>/g) || []).length, 11);
  }
});

test("the gallery covers every primitive and state without adopting them on listener screens", () => {
  // MUTATION: change the pressed specimen to `pressed: false` -> the state marker assertion fails.
  const gallery = loadGallery();
  const html = gallery.galleryScheme("light", "Cream · primary");
  for (const marker of [
    "keycap", "textbtn", "chip", "tag", "art-frame", "card", "well", "band--mini", "band--detail", "band--scrub",
    "gauge", "bridge", "toast", "skel--row", "skel--hero", "empty", "row-show", "row-episode", "row-queue", "tile--s",
    "tile--m", "tile--l", "deck", "mini", "rotary", "sheet--preview",
  ]) assert.match(html, new RegExp(`class="[^"]*${marker}`), `${marker} has a specimen`);
  for (const state of ['data-pressed="true"', " is-focus", " disabled", 'aria-busy="true"', "keycap--blocked", "is-current", "is-visible", "deck--collapsed"]) {
    assert.ok(html.includes(state), `${state} is visible in the gallery`);
  }
  const adopters = fs.readdirSync(path.join(ROOT, "ui")).filter((name) => name.endsWith(".js") && !["gallery.js", "primitives.js"].includes(name)).filter((name) => /\btactile[A-Z]/.test(fs.readFileSync(path.join(ROOT, "ui", name), "utf8")));
  assert.deepStrictEqual(adopters, [], "Phase 4, not the foundation, adopts primitives on listener screens");
});
