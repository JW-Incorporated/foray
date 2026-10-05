/* Generated playlists: what one leaf's list may hold (catalogue-personalization
 * PKG-04; #547 fix 3, #558 item 5, #560 item 3).
 *
 * Home's "Generated for you" cards (generatedPlaylists) and the detail page a
 * reload or a shared link resolves (generatedPlaylistById) each used to fill a
 * leaf with whatever the pool held newest on it. Two defects followed: one
 * prolific show could fill all six slots, and an episode of a broad show
 * (`label_scope: "general"` in the catalogue, PKG-02) sat on a leaf only
 * because its SHOW was labelled there. Both generators now go through one
 * helper, leafPlaylistItems: at most GENERATED_PER_SHOW_CAP (2) items per show,
 * an item whose topics were inherited (`topics_source: "show"`) from a general
 * show is refused, and GENERATED_PLAYLIST_MIN is checked on what survives.
 * snapshot() keeps `topics_source` so the pool item carries the provenance the
 * helper reads.
 *
 * Same dependency-free node:vm harness as test/explicit-badge.test.js (loadApp
 * copied from it). Every test names the mutation that kills it, per CLAUDE.md
 * "a green test is not evidence until you have broken it".
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const APP_PATH = path.join(__dirname, "..", "app.js");
const SRC = fs.readFileSync(APP_PATH, "utf8");

function loadApp() {
  const noop = () => {};
  function makeEl() {
    const node = {
      addEventListener: noop, removeEventListener: noop, appendChild: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => makeEl(), querySelectorAll: () => [],
    };
    return node;
  }
  const viewEl = makeEl();
  const store = new Map();
  const ctx = {
    console,
    fetch: () => new Promise(() => {}),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: makeEl(), documentElement: makeEl(),
      addEventListener: noop, createElement: makeEl,
      querySelector: (sel) => (sel === "#view" ? viewEl : makeEl()),
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    location: { hash: "#/", href: "https://example.test/" },
    history: { replaceState: noop, pushState: noop },
    CSS: { escape: (s) => String(s) },
    URL, Math, Date, JSON, Promise, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  ctx._view = viewEl;
  ctx._state = (code) => vm.runInContext(code, ctx);
  return ctx;
}

/* ---------- fixtures ---------- */

const LEAF = "science/physics";
const GENERAL_SHOW = "Broad Show";

/** One pool item on LEAF, in the discover.json shape. `day` orders it: a
    higher day is newer, so it sorts earlier. */
function item(show, n, day, over = {}) {
  return {
    id: `${show.toLowerCase().replace(/\s+/g, "-")}--ep-${n}`,
    show, title: `${show} episode ${n}`,
    release_date: `2026-05-${String(day).padStart(2, "0")}`,
    duration_min: 40, apple_collection_id: 1000 + n, explicit: false,
    topics: [LEAF], topics_source: "episode",
    ...over,
  };
}

/** A loaded app holding exactly `items` as its pool, one interest on LEAF, no
    card slots, and a catalogue in which GENERAL_SHOW is `label_scope:
    "general"` and every other show is not. */
function appWith(items) {
  const app = loadApp();
  const state = app._state("state");
  state.taxonomy = { nodes: [
    { id: "science", parent: null, label: "Science" },
    { id: LEAF, parent: "science", label: "Physics" },
  ] };
  state.catalog = { shows: [
    { show_id: "s-general", title: GENERAL_SHOW, label_scope: "general", taxonomy_node_ids: [LEAF] },
    ...[...new Set(items.map((it) => it.show))].filter((t) => t !== GENERAL_SHOW)
      .map((t, i) => ({ show_id: `s-${i}`, title: t, taxonomy_node_ids: [LEAF] })),
  ] };
  state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  state.discover = { items };
  state.interests = { [LEAF]: 1 };
  state.cardSlots = [];
  return app;
}

const homeIds = (app) => {
  const p = app.generatedPlaylists().find((x) => x.id === `gen-${LEAF}`);
  return p ? Array.from(p.items, (it) => it.id) : null;
};
const showCounts = (ids, items) => {
  const byId = new Map(items.map((it) => [it.id, it.show]));
  const c = {};
  for (const id of ids) c[byId.get(id)] = (c[byId.get(id)] || 0) + 1;
  return c;
};

/* ---------- tests ---------- */

test("snapshot keeps topics_source", () => {
  /* The pool is built from snapshot(), a whitelist projection: a field not
     named there never reaches the generator, so leafPlaylistItems could not
     tell an inherited label from an episode's own.

     MUTATION: remove the `topics_source:` line from snapshot(). Both
     provenance values come back undefined and this fails. */
  const app = loadApp();
  assert.strictEqual(app.snapshot("a", item("Show A", 1, 1, { topics_source: "show" })).topics_source, "show");
  assert.strictEqual(app.snapshot("b", item("Show A", 2, 2)).topics_source, "episode");
  const { topics_source: _drop, ...bare } = item("Show A", 3, 3);
  assert.strictEqual(app.snapshot("c", bare).topics_source, null,
    "a source without it (session.json's curated episodes) reads null, which the general filter keeps");
});

test("a generated playlist holds at most 2 items from one show", () => {
  /* Six newer episodes of one show and two older of another: before the cap
     the list was the six of Show A. Now two of each.

     MUTATION: GENERATED_PER_SHOW_CAP = 2 -> 6. The list fills with Show A's
     six and this fails on both the length and the per-show count. */
  const items = [
    ...[1, 2, 3, 4, 5, 6].map((n) => item("Show A", n, 20 + n)),
    item("Show B", 1, 2), item("Show B", 2, 1),
  ];
  const app = appWith(items);
  const ids = homeIds(app);
  assert.ok(ids, "the leaf still produces a playlist");
  assert.strictEqual(ids.length, 4);
  assert.deepStrictEqual(showCounts(ids, items), { "Show A": 2, "Show B": 2 });
  assert.deepStrictEqual(ids.slice(0, 2), ["show-a--ep-6", "show-a--ep-5"], "newest first within the cap");
});

test("an item whose only claim to the leaf is a general show's label is excluded", () => {
  /* The general show's two episodes are the NEWEST on the leaf, so nothing but
     the provenance filter keeps them out of the six.

     MUTATION: drop the general filter in leafPlaylistItems. Both episodes
     enter the list and this fails. */
  const inherited = [
    item(GENERAL_SHOW, 1, 30, { topics_source: "show" }),
    item(GENERAL_SHOW, 2, 29, { topics_source: "show" }),
  ];
  const items = [...inherited, item("Show A", 1, 3), item("Show B", 1, 2), item("Show C", 1, 1)];
  const ids = homeIds(appWith(items));
  assert.ok(ids, "the leaf still produces a playlist from its own episodes");
  for (const it of inherited) assert.ok(!ids.includes(it.id), `${it.id} is on the leaf only by its show's label`);
  assert.deepStrictEqual(ids, ["show-a--ep-1", "show-b--ep-1", "show-c--ep-1"]);
});

test("an item from a general show with a per-episode label is kept", () => {
  /* The filter is on provenance, not on the show: a general show's episode
     that was labelled for ITSELF (topics_source "episode") belongs here.

     MUTATION: filter on the show alone (drop `it.topics_source === "show" &&`).
     The general show's own-labelled episode is refused and this fails. */
  const own = item(GENERAL_SHOW, 1, 30, { topics_source: "episode" });
  const items = [own, item("Show A", 1, 3), item("Show B", 1, 2)];
  const ids = homeIds(appWith(items));
  assert.ok(ids, "three eligible items make a playlist");
  assert.strictEqual(ids[0], own.id, "the general show's per-episode label keeps it, newest first");
  assert.strictEqual(ids.length, 3);
});

test("a leaf under GENERATED_PLAYLIST_MIN after the cap produces no playlist", () => {
  /* Four episodes of one show is enough before the cap and two after it. A
     two-episode "playlist" is not one, on Home or on the detail page.

     MUTATION: check GENERATED_PLAYLIST_MIN on the candidates before the cap
     (in generatedPlaylists and generatedPlaylistById) instead of on what the
     helper returns. A two-item playlist is emitted and this fails. */
  const items = [1, 2, 3, 4].map((n) => item("Show A", n, n));
  const app = appWith(items);
  assert.strictEqual(homeIds(app), null, "Home must not show a leaf the cap leaves under MIN");
  assert.strictEqual(app.generatedPlaylistById(`gen-${LEAF}`), null, "and the route must not resolve it");
});

test("generatedPlaylistById returns the same ids as the Home card for the same leaf", () => {
  /* The detail page is what a tap on Home's card opens, and what a reload of
     it resolves: the two lists must be the same episodes in the same order.
     The fixture needs both rules: a capped show and a refused general item.

     MUTATION: apply leafPlaylistItems in one caller only (restore the old
     sort/slice in generatedPlaylistById). The page lists six of Show A and the
     general show's inherited episode, and this fails. */
  const items = [
    item(GENERAL_SHOW, 1, 31, { topics_source: "show" }),
    ...[1, 2, 3, 4, 5, 6].map((n) => item("Show A", n, 20 + n)),
    item("Show B", 1, 3), item("Show C", 1, 2), item("Show D", 1, 1),
  ];
  const app = appWith(items);
  const home = homeIds(app);
  const page = app.generatedPlaylistById(`gen-${LEAF}`);
  assert.ok(home && page, "both resolve the leaf");
  assert.deepStrictEqual(Array.from(page.items, (it) => it.id), home);
  assert.deepStrictEqual(home, ["show-a--ep-6", "show-a--ep-5", "show-b--ep-1", "show-c--ep-1", "show-d--ep-1"]);
});
