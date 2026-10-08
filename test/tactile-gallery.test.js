/* Tactile Phase 3 component gallery. Each test names the one-line mutation
 * used to prove it can fail; all four mutations were executed before push. */
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
  // MUTATION: delete the `bakelite-sheet-open` step -> the expected label set fails.
  assert.match(gallerySource, /function galleryEnabled\(\)[\s\S]*isLabBuild\(\)[\s\S]*get\("gallery"\) === "1"/);
  assert.match(statesSource, /id: "gallery"[\s\S]*route: "\?gallery=1#\/gallery"/);
  for (const label of [
    "cream-type-and-contrast", "cream-controls", "cream-surfaces", "cream-band-states", "cream-skeletons", "cream-rows", "cream-navigation", "cream-playing-mini", "cream-sheet-open",
    "bakelite-type-and-contrast", "bakelite-controls", "bakelite-surfaces", "bakelite-band-states", "bakelite-skeletons", "bakelite-rows", "bakelite-navigation", "bakelite-playing-mini", "bakelite-sheet-open",
    "icons-bold", "icons-fill", "icons-custom",
  ]) assert.match(statesSource, new RegExp(`label: "${label}"`), `${label} is a gallery baseline shot`);
  assert.match(statesSource, /#gallery-\$\{value\}-navigation \.sheet--preview/, "the real sheet opener moves into the captured scheme");
  assert.match(statesSource, /label: "cream-sheet-open"[\s\S]*openGallerySheet\(page, "light"\)/);
  assert.match(statesSource, /label: "bakelite-sheet-open"[\s\S]*openGallerySheet\(page, "dark"\)/);
});

test("both authored schemes show all ten type roles and every contrast-table pair", () => {
  // MUTATION: rename the `on-rubber` pair -> both 12-row table assertions fail.
  const gallery = loadGallery();
  const expectedRoles = ["display-xl", "display", "title", "heading", "body-lg", "body", "label", "micro", "readout-lg", "readout"];
  const expectedPairs = ["ink-paper", "ink-card", "ink-2-paper", "ink-3-paper", "on-persimmon", "on-ultramarine", "on-rubber", "persimmon-paper", "ultramarine-paper", "good-paper", "warn-paper", "segment-enamels"];
  const schemes = [
    ["light", "Cream · primary", ["15.26", "17.01", "6.56", "5.14", "4.99", "7.53", "13.40", "4.41", "6.65", "4.74", "4.79", "3.14"]],
    ["dark", "Bakelite · optional", ["15.76", "14.06", "8.85", "5.38", "6.07", "7.10", "10.60", "6.49", "7.59", "8.56", "8.24", "5.47"]],
  ];
  for (const [scheme, label, ratios] of schemes) {
    const html = gallery.galleryTypeAndContrast(scheme, label);
    assert.deepStrictEqual([...html.matchAll(/data-type-role="([^"]+)"/g)].map((match) => match[1]), expectedRoles);
    assert.deepStrictEqual([...html.matchAll(/data-pair="([^"]+)"/g)].map((match) => match[1]), expectedPairs);
    assert.deepStrictEqual([...html.matchAll(/(?:≥ )?([0-9]+\.[0-9]+):1<\/strong>/g)].map((match) => match[1]), ratios);
    assert.match(html, /Today/);
    assert.match(html, /Podcasts, lined up around you\./);
    assert.match(html, /Barbecue: eight stories from a much longer history/);
    assert.strictEqual((html.match(/:1<\/strong>/g) || []).length, 12);
  }
});

test("the gallery covers every primitive and state without adopting them on listener screens", () => {
  // MUTATION: change `tactileSkeleton("card")` to `tactileSkeleton("row")` -> the playlist-card marker fails.
  const gallery = loadGallery();
  for (const [scheme, label] of [["light", "Cream · primary"], ["dark", "Bakelite · optional"]]) {
    const html = gallery.galleryScheme(scheme, label);
    for (const marker of [
      "keycap", "textbtn", "chip", "tag", "art-frame", "card", "well", "band--line", "band--mini", "band--detail", "band--scrub", "band--buffering",
      "gauge", "bridge", "toast", "skel--row", "skel--hero", "skel--card", "empty", "row-show", "row-episode", "row-queue", "tile--s",
      "tile--m", "tile--l", "deck", "mini", "rotary", "sheet--preview",
    ]) assert.match(html, new RegExp(`class="[^"]*${marker}`), `${scheme} ${marker} has a specimen`);
    for (const state of ['data-pressed="true"', " is-focus", " disabled", 'aria-busy="true"', "keycap--blocked", "is-current", "is-visible", "deck--collapsed", 'aria-label="Pause"']) {
      assert.ok(html.includes(state), `${scheme} ${state} is visible in the gallery`);
    }
  }
  const adopters = fs.readdirSync(path.join(ROOT, "ui")).filter((name) => name.endsWith(".js") && !["gallery.js", "primitives.js"].includes(name)).filter((name) => /\btactile[A-Z]/.test(fs.readFileSync(path.join(ROOT, "ui", name), "utf8")));
  /* Phase 4 adopts the primitives one screen at a time, and this list is the
     register of who has: Today's screen (ui/home.js) and the deck's icons
     (ui/tabbar.js, drawn only on Today). A screen that adopts them without
     landing here is the foundation leaking onto a listener screen early.
     MUTATION: use a tactile* renderer in ui/search.js -> red, naming it. */
  assert.deepStrictEqual(adopters, ["home.js", "tabbar.js"], "only the screens whose Phase 4 branch has landed adopt primitives");
});

test("the gallery's rendered copy obeys the listener copy rules, however the source spells it", () => {
  /* Review blocker (2026-10-07): the display specimen once rebuilt
     "Podcasts, stit" + "ched around you." from fragments, so listener-copy's
     literal scan never saw the banned word. This judges the rendered output,
     which no concatenation can hide from: the visible text plus every
     aria-label, in both schemes.
     MUTATION: restore `["Podcasts,", "stit" + "ched", "around you."].join(" ")`
     as the display specimen -> the stitching rule fails here. */
  const gallery = loadGallery();
  const banned = [
    ["stitching", /stitch/i],
    ["fascinating", /fascinating/i],
    ["deep dive", /deep[ -]dive/i],
    ["delve", /\bdelve/i],
    ["explores", /\bexplores\b/i],
    ["we/us/our", /\b(?:we|us|our)\b/i],
    ["topic, not subject", /\btopics?\b/i],
  ];
  const failures = [];
  for (const [scheme, label] of [["light", "Cream · primary"], ["dark", "Bakelite · optional"]]) {
    const html = gallery.galleryTypeAndContrast(scheme, label) + gallery.galleryScheme(scheme, label);
    const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1]);
    const copy = html.replace(/<[^>]+>/g, " ") + " " + labels.join(" ");
    for (const [what, re] of banned) if (re.test(copy)) failures.push(`${scheme}: ${what}`);
    // Fixture premise (checked after the rules, so the mutation fails on its rule): the display specimen is in the scanned copy.
    if (!/Podcasts, (?:lined up|stitched) around you\./.test(copy)) failures.push(`${scheme}: display specimen missing from the scanned copy`);
  }
  assert.deepStrictEqual(failures, []);
  assert.doesNotMatch(gallerySource, /copy-literal scans/, "no comment explaining how to slip past the copy scan");
});