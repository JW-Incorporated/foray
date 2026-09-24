/* What the router remembers beyond the page's height (audit round 2).
 *
 * WHY THIS EXISTS. Round 1 (qa 115) taught the router to put a listener back at
 * the height they left a list at. Three things it still forgot:
 *
 *  1. nav-3 — the Search page never reported its REAL paint. Its show, directory,
 *     shard and episode passes land after route() has restored the scroll, so a
 *     ‹ back to the results was clamped by the first, shorter paint, and nothing
 *     re-applied it: the show and Foray pages call pageDidPaint(), Search did not.
 *  2. perf-8 — Home's shelves (Jump back in, Forays for you, Playlists for you)
 *     are horizontal scroll containers, rebuilt at card one on every render: a ‹
 *     back to Home, a settings switch, the late now-playing ribbon.
 *  3. nav-10 — inside the native shell, a cold relaunch after the OS tore the
 *     WebView down opened on Home: the route lived only in the URL hash. Founder
 *     question 11's default: the shell reopens where the listener left; the web
 *     keeps "a bare URL means Home" (qa 132).
 *
 * Harness: app.js in node:vm, with the page painters (renderHome, renderLibrary)
 * replaced by ones that build exactly the shelves a test names — what is under
 * test is the router's memory, not the pages. Duplicated rather than shared, per
 * the repo convention (see test/back-navigation.test.js's header).
 *
 * Every test names the mutation that kills it.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(), id: "", className: "", innerHTML: "", textContent: "",
    value: "", hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

/* The browser's history, as test/back-navigation.test.js fakes it. */
function fakeHistory(ctx) {
  const entries = [{ hash: ctx.location.hash, state: null }];
  let at = 0;
  return {
    history: {
      scrollRestoration: "auto",
      get state() { return entries[at].state; },
      replaceState(state, _t, url) {
        entries[at].state = state;
        if (url !== undefined && url !== null) {
          const i = String(url).indexOf("#");
          entries[at].hash = i >= 0 ? String(url).slice(i) : "";
          ctx.location.hash = entries[at].hash;
        }
      },
      pushState() { throw new Error("the router never pushes; links do"); },
      back() { if (at > 0) { at--; ctx.location.hash = entries[at].hash; } },
    },
    link(hash) { entries.length = at + 1; entries.push({ hash, state: null }); at++; ctx.location.hash = hash; },
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results",
];

function mount({ fetchImpl = () => new Promise(() => {}), native = false, seed = {} } = {}) {
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const view = byId.get("view");
  view.rails = [];
  view.querySelectorAll = (sel) => (sel === ".hv2-hscroll" ? view.rails : []);
  const store = new Map(Object.entries(seed));
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: fetchImpl,
    localStorage: {
      get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
    document: {
      body: makeEl("body"), readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => (String(sel).startsWith("#") ? byId.get(String(sel).slice(1)) ?? null : null),
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/", protocol: native ? "capacitor:" : "https:" },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    performance: { now: () => Date.now() },
    scrollY: 0, scrollTo() {},
  };
  const nav = fakeHistory(ctx);
  ctx.history = nav.history;
  ctx.document.documentElement = ctx.document.body;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  return { ctx, evalIn, nav, view, byId, store, state: evalIn("state") };
}

/* ==================================================================== */
/* 1. nav-3 — the Search page reports its terminal paint                 */
/* ==================================================================== */

function jsonResponse(body) { return { ok: true, status: 200, json: async () => body }; }
function answeringFetch(url) {
  const u = String(url);
  if (u.includes("api/shows/index/")) return Promise.resolve({ ok: false, status: 404, json: async () => ({ available: false }) });
  if (u.includes("api/")) return Promise.resolve(jsonResponse({ shows: [], episodes: [], degraded: false }));
  return new Promise(() => {});
}
async function drain(n = 6) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }
function seedSearch(m) {
  m.state.catalog = { shows: [{ show_id: "lex-fridman-podcast", title: "Lex Fridman Podcast", artwork_url: null }] };
  m.state.discover = { items: [] };
  m.state.cardSlots = [];
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.evalIn("var __paints = 0; pageDidPaint = () => { __paints++; };");
}

test("the Search page calls pageDidPaint once, when every pass of its query has answered (nav-3)", async () => {
  /* MUTATION: delete `if (onScreen()) pageDidPaint();` from runShowSearchCostly's
     settle -> a ‹ back to the results never re-applies its clamped restore;
     this count stays 0. */
  const m = mount({ fetchImpl: answeringFetch });
  seedSearch(m);
  m.ctx.renderAllShows("fridman");
  assert.strictEqual(m.evalIn("__paints"), 0, "not before the passes answer");
  await drain();
  assert.strictEqual(m.evalIn("__paints"), 1);
});

test("a search that settles after the listener left the page reports nothing (nav-3)", async () => {
  /* MUTATION: call pageDidPaint() without the render-token guard -> the late
     search re-applies a restore and renames the document on some other page. */
  const m = mount({ fetchImpl: answeringFetch });
  seedSearch(m);
  m.ctx.renderAllShows("fridman");
  m.evalIn("renderEpoch++");            // another page rendered
  await drain();
  assert.strictEqual(m.evalIn("__paints"), 0);
});

test("a retried catalogue is the page's real paint too (nav-3)", async () => {
  /* MUTATION: drop the pageDidPaint() call from retryCatalog. */
  const m = mount({ fetchImpl: (u) => (String(u).includes("catalog-client.json") ? Promise.resolve(jsonResponse({ shows: [] })) : new Promise(() => {})) });
  seedSearch(m);
  m.evalIn("renderCurrentPage = () => {};");
  await m.ctx.retryCatalog();
  assert.strictEqual(m.evalIn("__paints"), 1);
});

/* ==================================================================== */
/* 2. perf-8 — a shelf keeps its place                                   */
/* ==================================================================== */

/* Home paints three shelves, each in its own section, at card one — exactly
   what renderHomeV2's innerHTML rebuild gives the real page. */
function shelvesRouter(m) {
  m.evalIn("state.ready = true;");
  const paintHome = () => {
    m.view.rails = ["hv2-jbi", "hv2-forays", "hv2-playlists"].map((cls) => {
      const section = { className: `hv2-section ${cls}` };
      return { scrollLeft: 0, closest: (sel) => (sel === "section" ? section : null) };
    });
  };
  m.ctx.renderHome = paintHome;
  m.ctx.renderLibrary = () => { m.view.rails = []; };
  m.evalIn("publishRenderedPageHead = () => {}; renderTabBar = () => {}; openDrawer = () => {}; landOnPage = () => {};");
  let first = true;
  return {
    go(hash) { if (first) m.ctx.location.hash = hash; else m.nav.link(hash); first = false; m.evalIn("route()"); },
    back() { m.nav.history.back(); m.evalIn("route()"); },
    rail: (cls) => m.view.rails.find((r) => r.closest("section").className.includes(cls)),
  };
}

test("‹ back to Home puts each shelf where it was left, by section (perf-8)", () => {
  /* MUTATION: delete the `applyRailOffsets(navRailX.get(h))` line in route() ->
     the Forays shelf is back at card one; red. MUTATION 2: key by index instead
     of section and let Jump back in appear -> the offset lands on the wrong
     shelf. */
  const m = mount();
  const r = shelvesRouter(m);
  r.go("#/");
  r.rail("hv2-forays").scrollLeft = 480;
  r.go("#/library");
  r.back();
  assert.strictEqual(r.rail("hv2-forays").scrollLeft, 480, "the shelf the listener swiped");
  assert.strictEqual(r.rail("hv2-playlists").scrollLeft, 0, "a shelf left at its start stays there");
});

test("a FORWARD tap onto Home starts every shelf at card one (perf-8)", () => {
  /* MUTATION: apply the remembered offsets on every step, not only a back-step. */
  const m = mount();
  const r = shelvesRouter(m);
  r.go("#/");
  r.rail("hv2-forays").scrollLeft = 480;
  r.go("#/library");
  r.go("#/");
  assert.strictEqual(r.rail("hv2-forays").scrollLeft, 0);
});

test("an in-place repaint of Home (a settings switch, the late ribbon) keeps the shelves (perf-8)", () => {
  /* MUTATION: delete `applyRailOffsets(keepRails)` at the end of
     renderCurrentPage -> the switch under the drawer resets every shelf; red. */
  const m = mount();
  const r = shelvesRouter(m);
  r.go("#/");
  r.rail("hv2-playlists").scrollLeft = 300;
  m.evalIn("renderCurrentPage()");
  assert.strictEqual(r.rail("hv2-playlists").scrollLeft, 300);
});

/* ==================================================================== */
/* 3. nav-10 — the native shell reopens where the listener left          */
/* ==================================================================== */

function routeTo(m, hash) {
  m.evalIn("state.ready = true; renderCurrentPage = () => {}; openDrawer = () => {}; landOnPage = () => {};");
  m.ctx.location.hash = hash;
  m.evalIn("route()");
}

test("inside the native shell every route is filed, and a bare relaunch reopens it (nav-10)", () => {
  /* MUTATION: drop `rememberRouteForRelaunch(h)` from route() -> the relaunch
     route is Home; red. */
  const m = mount({ native: true });
  routeTo(m, "#/show/lex-fridman-podcast");
  assert.strictEqual(m.ctx.relaunchRoute(), "#/show/lex-fridman-podcast");
  /* A new page-life: the WebView was torn down, the store survived. */
  const again = mount({ native: true, seed: { cp_last_route: m.store.get("cp_last_route") } });
  assert.strictEqual(again.ctx.relaunchRoute(), "#/show/lex-fridman-podcast");
});

test("on the web nothing is filed and a bare URL is still Home (nav-10, qa 132)", () => {
  /* MUTATION: drop the `isNativeShell()` guard from rememberRouteForRelaunch or
     relaunchRoute -> the web reopens a stale page for a bare URL; red. */
  const m = mount({ native: false, seed: { cp_last_route: JSON.stringify("#/show/x") } });
  routeTo(m, "#/library");
  assert.strictEqual(m.store.get("cp_last_route"), JSON.stringify("#/show/x"), "the web writes nothing");
  assert.strictEqual(m.ctx.relaunchRoute(), "#/");
});

test("a stored route that is not one of 4a's own hash routes reopens Home (nav-10)", () => {
  /* MUTATION: return the stored value unchecked. */
  for (const bad of ["javascript:alert(1)", "https://evil.test/#/", "#/ x", 42]) {
    const m = mount({ native: true, seed: { cp_last_route: JSON.stringify(bad) } });
    assert.strictEqual(m.ctx.relaunchRoute(), "#/", String(bad));
  }
});

test("init rewrites only a BARE arrival, and to the relaunch route (nav-10)", () => {
  /* MUTATION: restore `replaceHash("#/")` for a bare arrival. */
  assert.match(APP_SRC, /if \(location\.hash === "" \|\| location\.hash === "#"\) replaceHash\(relaunchRoute\(\)\);/);
});
