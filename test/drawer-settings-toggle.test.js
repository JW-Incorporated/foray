/* Settings-drawer toggles must not close the drawer (Joey, 2026-08-31,
 * kanban card t_0c09d83a).
 *
 * WHAT HAPPENED: `#family-toggle`/`#player-toggle`'s click handlers flipped
 * the setting, then called `route()` to re-render the page behind the
 * drawer. `route()` unconditionally opens with `openDrawer(false)` (that
 * line exists for REAL navigation — a drawer link, or a hashchange), so a
 * setting change was closing the drawer as a side effect nobody wanted.
 *
 * THE FIX: `route()`'s "render the current page" behaviour was split out
 * into `renderCurrentPage()`, which does not touch the drawer. The three
 * toggle handlers now call `renderCurrentPage()` instead of `route()`, so
 * they still refresh whatever page is open behind the drawer (family mode
 * changes card eligibility) without closing it. `route()` itself is
 * unchanged for real navigation.
 *
 * Harness: the same node:vm DOM stub as test/up-next-queue.test.js, with
 * working addEventListener/click on the toggle/drawer elements specifically
 * (the shared stub's are no-ops) so init()'s real click wiring runs.
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
  const listeners = new Map();
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    _fire(type, evt) {
      for (const fn of listeners.get(type) || []) fn(evt || { target: { closest: () => null } });
    },
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {},
    click() { this._fire("click"); },
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results", "browse-all-link",
];

function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => {
      if (!boot) return new Promise(() => {});
      const file = path.join(ROOT, String(url));
      const ok = String(url).startsWith("data/") && fs.existsSync(file);
      return Promise.resolve({
        ok, status: ok ? 200 : 404,
        json: async () => JSON.parse(fs.readFileSync(file, "utf8")),
      });
    },
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
      querySelectorAll: () => [],
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
    ctx, evalIn, store, body, byId,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
  };
}

async function mountBooted(seed) {
  const m = mount({ seed, boot: true });
  for (let i = 0; i < 200 && !m.state.ready; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.ok(m.state.ready, "init() never finished against the committed data files");
  return m;
}

/* ==================================================================== */
/* SETTINGS TOGGLES LEAVE THE DRAWER OPEN                                */
/* ==================================================================== */

test("#family-toggle updates family mode AND leaves the drawer open", async () => {
  /* MUTATION: restore `route()` in the family-toggle handler instead of
     `renderCurrentPage()`. `route()` unconditionally calls
     `openDrawer(false)` at its top, so `#drawer.hidden` would flip to
     true and this assertion fails. */
  const m = await mountBooted();
  m.byId.get("drawer").hidden = false;
  const before = m.ctx.familyMode();
  m.byId.get("family-toggle")._fire("click");
  assert.strictEqual(m.ctx.familyMode(), !before, "family mode must flip");
  assert.strictEqual(m.byId.get("drawer").hidden, false, "the drawer must stay open after toggling family mode");
});

test("#player-toggle updates the player preference AND leaves the drawer open", async () => {
  /* MUTATION: restore `route()` in the player-toggle handler instead of
     `renderCurrentPage()`. Same drawer-closing regression as family-toggle. */
  const m = await mountBooted();
  m.byId.get("drawer").hidden = false;
  const before = m.ctx.playerPref();
  m.byId.get("player-toggle")._fire("click");
  assert.notStrictEqual(m.ctx.playerPref(), before, "player preference must flip");
  assert.strictEqual(m.byId.get("drawer").hidden, false, "the drawer must stay open after toggling player preference");
});

test("#autoadvance-toggle updates auto-advance AND leaves the drawer open", async () => {
  /* Pins the already-correct behaviour (this handler never called route())
     so a future edit that adds a route()/openDrawer(false) call here gets
     caught too.
     MUTATION: add `route()` (or `openDrawer(false)`) to the autoadvance
     handler. The drawer assertion fails. */
  const m = await mountBooted();
  m.byId.get("drawer").hidden = false;
  const before = m.ctx.autoAdvanceOn();
  m.byId.get("autoadvance-toggle")._fire("click");
  assert.strictEqual(m.ctx.autoAdvanceOn(), !before, "auto-advance must flip");
  assert.strictEqual(m.byId.get("drawer").hidden, false, "the drawer must stay open after toggling auto-advance");
});

test("family-toggle's re-render still reaches the page behind the drawer (renderCurrentPage runs)", async () => {
  /* Proves the split didn't just delete the re-render — family mode changes
     which cards are eligible, so the home page behind the drawer must
     still be refreshed, just without closing the drawer.
     MUTATION: remove the `renderCurrentPage()` call entirely (call nothing
     after renderDrawer()). #view's innerHTML would keep whatever renderHome
     wrote before init()'s own route() call, so a spy overwrite would go
     undetected the same way `route()` would go uncalled. */
  const m = await mountBooted();
  let calls = 0;
  const original = m.ctx.renderCurrentPage;
  m.ctx.renderCurrentPage = (...args) => { calls++; return original(...args); };
  /* re-bind: the click handler captured the ORIGINAL renderCurrentPage by
     reference at init() time, so assert against the real signal instead —
     #view's content changes when family mode flips. */
  m.byId.get("view").innerHTML = "sentinel-before-toggle";
  m.byId.get("family-toggle")._fire("click");
  assert.notStrictEqual(m.view(), "sentinel-before-toggle", "the page behind the drawer must be re-rendered when family mode changes");
});

/* ==================================================================== */
/* REAL NAVIGATION STILL CLOSES THE DRAWER (no regression)               */
/* ==================================================================== */

test("clicking a link inside the drawer still closes it (route() unchanged for real navigation)", async () => {
  /* MUTATION: remove `openDrawer(false)` from route(), or from the
     drawer's own click-delegate handler. The drawer would stay open after
     a real navigation, regressing the pre-existing (correct) behaviour. */
  const m = await mountBooted();
  m.byId.get("drawer").hidden = false;
  const fakeLink = { closest: (sel) => (sel === "a" ? {} : null) };
  m.byId.get("drawer")._fire("click", { target: fakeLink });
  assert.strictEqual(m.byId.get("drawer").hidden, true, "a real navigation (drawer link) must still close the drawer");
});

test("route() still closes the drawer on a hashchange-driven call", async () => {
  /* MUTATION: drop `openDrawer(false)` from route() itself. A real
     hashchange-triggered route() call would leave the drawer open. */
  const m = await mountBooted();
  m.byId.get("drawer").hidden = false;
  m.ctx.location.hash = "#/queue";
  m.ctx.route();
  assert.strictEqual(m.byId.get("drawer").hidden, true, "route() must still close the drawer for real navigation");
});
