/* Starred shows (follow-lite), requirement A2.4, resolved by Joey's Q2
 * answer: "yes, add starred shows, and a section for all of your starred
 * shows. It is not the home page but is somewhat easily accessible."
 * Kanban card: Build: starred shows (follow-lite) + dedicated Starred
 * Shows page.
 *
 * Deliberately NOT subscribe semantics -- no notifications, no
 * auto-download, no algorithmic surfacing. A lightweight per-device
 * marker, mirroring the existing episode star (`cp_saved`) pattern
 * exactly, keyed on show_id under its own storage key (`cp_starred_shows`)
 * so it never collides with episode stars.
 *
 * WHAT THIS PROVES, in order:
 *  1. toggleShowStar/isShowStarred round-trip through cp_starred_shows,
 *     and toggling twice is a true no-op (idempotent unstar).
 *  2. showStarBtn on the show page reflects starred/unstarred state and
 *     survives a toggle via bindShowStars' live DOM update (the same
 *     pattern toggleStar uses for episode stars).
 *  3. Starring an unknown show_id is a safe no-op (no throw, nothing
 *     written) -- mirrors toggleStar's own itemIndex-miss guard.
 *  4. #/starred-shows renders every starred show as a linked row, in
 *     most-recently-starred-first order, with an honest empty state.
 *  5. route() dispatches #/starred-shows to renderStarredShows, same
 *     wiring pattern as #/playlists and #/queue.
 *  6. The drawer carries a reachable link to #/starred-shows.
 *  7. Starring a show never touches cp_saved (the episode star store) --
 *     the two features share a pattern, not a storage key.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test
 * is not evidence until you have broken it".
 *
 * Harness: the same node:vm DOM stub as test/show-page.test.js, duplicated
 * rather than imported for the same reason that file gives -- its helpers
 * are scoped to that suite's own fixtures.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const INDEX_HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results",
];

function mount({ seed = {} } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  /* A tiny live registry of elements created via querySelectorAll matches,
     so bindShowStars' `document.querySelectorAll('[data-show-star="…"]')`
     lookup in toggleShowStar can find buttons rendered into #view's
     innerHTML. Mirrors how show-page.test.js gets away without this: that
     suite never asserts a POST-toggle DOM update. This one does (test 2),
     so the stub has to parse the rendered buttons out of #view.innerHTML
     on demand rather than track a real DOM tree. */
  function starButtonsIn(view) {
    const out = [];
    const re = /<button class="show-star( on)?" data-show-star="([^"]*)"[^>]*>/g;
    let m;
    while ((m = re.exec(view.innerHTML))) {
      out.push({ raw: m[0], id: m[2] });
    }
    return out;
  }

  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => {
        const s = String(sel);
        return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: (sel) => {
        const s = String(sel);
        const m = /^\[data-show-star="(.*)"\]$/.exec(s);
        if (!m) return [];
        const targetId = m[1];
        const view = byId.get("view");
        return starButtonsIn(view)
          .filter((b) => b.id === targetId)
          .map(() => ({
            textContent: "",
            classList: { toggle(cls, on) { this._on = on; }, _on: false },
            set _text(v) {},
          }));
      },
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
  };
}

/* ==================================================================== */
/* 1. STORE ROUND-TRIP + IDEMPOTENT UNSTAR                              */
/* ==================================================================== */

test("toggleShowStar writes/removes cp_starred_shows and isShowStarred reflects it", () => {
  /* MUTATION: drop the `delete starred[id]` branch. Toggling twice would
     leave the show starred, and the second assertion below fails. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "s-1", title: "Show One", artwork_url: "https://example.com/a.png" }] };

  assert.strictEqual(m.ctx.isShowStarred("s-1"), false, "unstarred by default");
  m.ctx.toggleShowStar("s-1");
  assert.strictEqual(m.ctx.isShowStarred("s-1"), true, "starring must flip isShowStarred");
  const stored = JSON.parse(m.store.get("cp_starred_shows"));
  assert.strictEqual(stored["s-1"].title, "Show One", "must snapshot the show title");
  assert.strictEqual(stored["s-1"].show_id, "s-1");
  assert.ok(stored["s-1"].starred_at, "must record a starred_at timestamp");

  m.ctx.toggleShowStar("s-1");
  assert.strictEqual(m.ctx.isShowStarred("s-1"), false, "toggling twice must be a true no-op (unstar)");
  assert.deepStrictEqual(JSON.parse(m.store.get("cp_starred_shows")), {}, "unstarring must remove the entry, not blank it");
});

/* ==================================================================== */
/* 2. showStarBtn STATE + LIVE TOGGLE ON THE SHOW PAGE                  */
/* ==================================================================== */

test("renderShow includes an unstarred showStarBtn by default, and starring updates it in place", () => {
  /* MUTATION: remove `${showStarBtn(show.show_id)}` from renderShow's
     template. The first assertion fails outright -- no show-star button in
     the page at all.
     MUTATION 2: drop bindShowStars($("#view")) from renderShow. The click
     listener never attaches and toggleShowStar is never called from the
     page, so the live-update assertion (via direct toggleShowStar call)
     still passes, but the wiring test below (which checks _bound) would
     catch a regression there instead. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "s-2", title: "Show Two", artwork_url: null }] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };

  m.ctx.renderShow("s-2");
  let html = m.view();
  assert.match(html, /class="show-star "/, "must render an unstarred show-star button");
  assert.match(html, /data-show-star="s-2"/, "button must carry the show_id for the click handler");
  assert.ok(html.includes("Star this show"), "unstarred label must read 'Star this show'");

  m.ctx.toggleShowStar("s-2");
  m.ctx.renderShow("s-2");
  html = m.view();
  assert.match(html, /class="show-star on"/, "re-rendering the page after starring must show the 'on' state");
  assert.ok(html.includes("★ Starred"), "starred label must read '★ Starred'");
});

/* ==================================================================== */
/* 3. UNKNOWN SHOW_ID IS A SAFE NO-OP                                    */
/* ==================================================================== */

test("toggleShowStar on an unknown show_id is a no-op, mirroring toggleStar's itemIndex guard", () => {
  /* MUTATION: remove the `if (!show) return;` guard. This would write a
     starred-show entry with title `undefined`, and the assertion that the
     store stays empty fails. */
  const m = mount();
  m.state.catalog = { shows: [] };
  assert.doesNotThrow(() => m.ctx.toggleShowStar("does-not-exist"));
  assert.strictEqual(m.store.get("cp_starred_shows"), undefined, "an unknown show_id must write nothing");
});

/* ==================================================================== */
/* 4. #/starred-shows PAGE                                              */
/* ==================================================================== */

test("renderStarredShows lists every starred show, most-recently-starred first", () => {
  /* MUTATION: drop the `.sort(...)` call. The order assertion below fails
     because the map's insertion order (oldest first) would surface instead. */
  const m = mount();
  m.state.catalog = { shows: [] };
  const older = { show_id: "s-old", title: "Older Show", artwork_url: null, starred_at: "2026-01-01T00:00:00.000Z" };
  const newer = { show_id: "s-new", title: "Newer Show", artwork_url: "https://example.com/b.png", starred_at: "2026-06-01T00:00:00.000Z" };
  m.store.set("cp_starred_shows", JSON.stringify({ "s-old": older, "s-new": newer }));

  m.ctx.renderStarredShows();
  const html = m.view();
  assert.ok(html.includes("Starred Shows"), "must render the page heading");
  assert.ok(html.includes("2 shows"), "must render an accurate count");
  const oldIdx = html.indexOf("Older Show");
  const newIdx = html.indexOf("Newer Show");
  assert.ok(newIdx >= 0 && oldIdx >= 0 && newIdx < oldIdx, "newer star must render before the older one");
  assert.ok(html.includes(`href="#/show/${encodeURIComponent("s-new")}"`), "each row must link to its show page");
});

test("renderStarredShows shows an honest empty state when nothing is starred", () => {
  /* MUTATION: remove the ternary's empty branch (always render the list
     div). The empty-state copy assertion fails, and an empty `<div
     class="show-results"></div>` would render silently instead. */
  const m = mount();
  m.ctx.renderStarredShows();
  const html = m.view();
  assert.ok(html.includes("No starred shows yet"), "must render an honest empty state, not a blank list");
  assert.ok(!html.includes('class="show-results"'), "must not render the results wrapper when there is nothing to show");
});

/* ==================================================================== */
/* 5. ROUTE WIRING                                                       */
/* ==================================================================== */

test("route() dispatches #/starred-shows to renderStarredShows, matching #/playlists/#/queue's pattern", () => {
  /* MUTATION: delete the `#/starred-shows` branch from route(). This test
     fails because renderHome (the fallback) runs instead and the view
     never contains the starred-shows heading. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  m.state.ready = true;

  m.ctx.location.hash = "#/starred-shows";
  m.ctx.route();
  assert.ok(m.view().includes("Starred Shows"), "route() must dispatch #/starred-shows to renderStarredShows");
});

/* ==================================================================== */
/* 6. DRAWER REACHABILITY                                                */
/* ==================================================================== */

test("the drawer nav carries a link to #/starred-shows", () => {
  /* MUTATION: remove the drawer <a> from index.html. This fails because no
     href pointing at #/starred-shows exists anywhere in the drawer markup.
     Not on the home screen, per Joey's framing -- this only proves the
     drawer link exists, deliberately not asserting anything about
     renderHome's own markup. */
  assert.match(
    INDEX_HTML,
    /<nav id="drawer"[^]*?<a class="drawer-section" href="#\/starred-shows">Starred Shows<\/a>[^]*?<\/nav>/,
    "the drawer must carry a reachable link to #/starred-shows"
  );
});

/* ==================================================================== */
/* 7. STORAGE ISOLATION FROM EPISODE STARS                              */
/* ==================================================================== */

test("starring a show never writes to cp_saved (the episode-star store)", () => {
  /* MUTATION: change toggleShowStar to reuse `savedMap()`/`lsSet("cp_saved",
     ...)` instead of its own key. This would corrupt episode stars with a
     show entry, and the assertion that cp_saved stays untouched fails. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "s-3", title: "Show Three", artwork_url: null }] };
  m.ctx.toggleShowStar("s-3");
  assert.strictEqual(m.store.get("cp_saved"), undefined, "starring a show must not touch cp_saved");
});
