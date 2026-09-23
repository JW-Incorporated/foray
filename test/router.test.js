/* The router's own rules — audit 2026-09-22 (themes K and the router half of C).
 *
 * WHAT THIS PROVES
 *  1. Every param route decodes, and decodes SAFELY: a lone `%` in a truncated
 *     or hand-typed link lands on a page instead of throwing out of the router
 *     (qa 118). `#/show/`, `#/category/` and `forayRouteId` used a bare
 *     `decodeURIComponent` while a comment beside them claimed the protection.
 *  2. `#/playlist/` and `#/subject/` decode their id, and every producer spells
 *     the route through ONE helper that encodes (qa 119) — a generated
 *     playlist's id carries a `/`.
 *  3. A first route that throws cannot take init()'s wiring with it: the
 *     hashchange listener is still bound (qa 118's escalation). Boots the REAL
 *     init(), because the defect was the order of lines inside it.
 *  4. A bare URL is rewritten to `#/` in place at boot, so the first Home-tab
 *     tap is not a dead history entry (qa 132).
 *  5. A `?foray=` link enters its Foray once per tab, not on every reload of
 *     Home (qa 129) — while the param, which is the draft unlock, stays.
 *  6. Tapping the tab you are on scrolls to the top (qa 131).
 *  7. A show page's terminal paint re-applies a back-step restore the loading
 *     paint clamped (qa 115; the Foray page's call is the same line at the end
 *     of renderForay).
 *
 * Every test names the one-line mutation that kills it.
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
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    prepend(...k) { this.children.unshift(...k); },
    insertBefore(k) { this.children.push(k); return k; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

/**
 * @param {object} o
 * @param {string} [o.hash]
 * @param {string} [o.search]
 * @param {boolean} [o.serveFiles]  answer fetches from the repo on disk, so the
 *   REAL init() can run to completion; otherwise fetch never settles.
 */
function mount({ hash = "#/", search = "", serveFiles = false } = {}) {
  /* Every `#id` lookup answers with an element, created on first ask — init()
     wires a dozen controls and this suite is about what happens AROUND them. */
  const byId = new Map();
  const el = (id) => { if (!byId.has(id)) { const e = makeEl("div"); e.id = id; byId.set(id, e); } return byId.get(id); };
  const body = makeEl("body");
  const listeners = [];
  const scrolls = [];
  const session = new Map();
  const ctx = {
    console: { ...console, warn() {}, error() {}, info() {} },
    fetch: (url) => {
      if (!serveFiles) return new Promise(() => {});
      const file = path.join(ROOT, String(url).split("?")[0]);
      const ok = fs.existsSync(file) && fs.statSync(file).isFile();
      return Promise.resolve({
        ok, status: ok ? 200 : 404,
        json: async () => JSON.parse(fs.readFileSync(file, "utf8")),
        text: async () => fs.readFileSync(file, "utf8"),
      });
    },
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => { session.set(k, String(v)); },
    },
    document: {
      body, documentElement: body, readyState: "complete", hidden: false,
      addEventListener() {}, createElement: (t) => makeEl(t),
      /* `#view [data-…]` is how a show page finds its own regions again. */
      querySelector: (sel) => {
        const s = String(sel);
        if (/^#[\w-]+$/.test(s)) return el(s.slice(1));
        return s.startsWith("#view [") ? el(s) : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener(type) { listeners.push(type); },
    removeEventListener() {},
    location: { hash, search, pathname: "/", href: "https://x.test/" + search + hash },
    history: {
      state: null,
      replaceState(state, _t, url) {
        this.state = state;
        if (url !== undefined && url !== null) {
          const i = String(url).indexOf("#");
          ctx.location.hash = i >= 0 ? String(url).slice(i) : "";
        }
      },
      back() {},
    },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    scrollY: 0,
    innerHeight: 800,
  };
  ctx.scrollTo = (x, y) => { scrolls.push(y); ctx.scrollY = y; };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  return { ctx, evalIn, listeners, scrolls, session, el, view: () => el("view").innerHTML };
}

/* ==================================================================== */
/* 1 & 2. EVERY PARAM ROUTE DECODES, SAFELY                               */
/* ==================================================================== */

test("a malformed percent-escape on ANY param route lands on a page instead of throwing", () => {
  /* MUTATION: restore `decodeURIComponent(m[1])` on the #/show/ line of
     renderCurrentPage (or in forayRouteId). That hash throws a URIError. */
  const m = mount();
  m.evalIn("state.ready = true; state.session = { session_id: 's', episodes: {}, cards: [], commute: {} }; state.discover = { items: [] }; state.catalog = { shows: [] }; state.taxonomy = { nodes: [] };");
  for (const hash of ["#/show/pi%3", "#/category/100%", "#/foray/x%", "#/playlist/p%", "#/subject/s%", "#/episode/e%", "#/shows/q/%"]) {
    m.ctx.location.hash = hash;
    assert.doesNotThrow(() => m.evalIn("renderCurrentPage()"), `${hash} must not throw out of the router`);
  }
});

test("#/playlist/ and #/subject/ hand the DECODED id to the page", () => {
  /* MUTATION: drop `safeDecode` from the #/playlist/ line — the page receives
     `gen-history%2Ftechnology` and a generated playlist is "not found". */
  const m = mount();
  const seen = [];
  m.evalIn("state.ready = true;");
  m.ctx.renderPlaylistDetail = (id) => { seen.push(id); };
  m.ctx.renderTabBar = () => {};
  m.ctx.location.hash = "#/playlist/gen-history%2Ftechnology";
  m.evalIn("renderCurrentPage()");
  m.ctx.location.hash = "#/subject/history%2Fwar";
  m.evalIn("renderCurrentPage()");
  assert.deepStrictEqual(seen, ["gen-history/technology", "subject-history/war"]);
});

test("every playlist link is spelled by playlistRoute, which encodes, and round-trips through the router", () => {
  /* One spelling. MUTATION: drop encodeURIComponent from playlistRoute — the
     `/` in a generated id is then a path separator in the hash. The census
     half: MUTATION 2: hand-write a `#/playlist/${esc(p.id)}` link again. */
  const m = mount();
  assert.strictEqual(m.evalIn('playlistRoute({ id: "gen-a/b" })'), "playlist/gen-a%2Fb");
  assert.strictEqual(m.evalIn('playlistRoute({ isSubject: true, branch: "x y" })'), "subject/x%20y");
  const code = APP_SRC.replace(/\/\*[\s\S]*?\*\//g, " ");
  const handWritten = code.match(/#\/(playlist|subject)\/\$\{/g) || [];
  assert.deepStrictEqual(handWritten, [], "a playlist/subject link built without playlistRoute()");
});

/* ==================================================================== */
/* 3 & 4. BOOT                                                          */
/* ==================================================================== */

async function bootAndWait(m) {
  for (let i = 0; i < 200 && !m.listeners.includes("hashchange"); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

test("a first route that throws still leaves the app wired: the hashchange listener is bound", async () => {
  /* The escalation in qa 118: route() ran BEFORE init() bound hashchange, the
     menu and the drawer, so one throw left a page no tap could recover. The
     page renderer is made to throw on purpose — the guard, not the decoder, is
     under test here. MUTATION: remove the try/catch around init()'s route(). */
  const m = mount({ hash: "#/show/anything", serveFiles: true });
  m.ctx.renderShow = () => { throw new Error("a page that throws"); };
  await bootAndWait(m);
  assert.ok(m.listeners.includes("hashchange"), `init() stopped before wiring the router: ${m.listeners.join(", ")}`);
});

test("a bare URL is rewritten to #/ in place at boot", async () => {
  /* qa 132: on a bare URL the Home tab's `#/` was a real hash change, so the
     first Home tap of every session pushed an entry and cost a dead back press.
     MUTATION: drop the `replaceHash("#/")` line from init(). */
  const m = mount({ hash: "", serveFiles: true });
  await bootAndWait(m);
  assert.strictEqual(m.ctx.location.hash, "#/");
});

/* ==================================================================== */
/* 5. ?foray= ENTERS ONCE PER TAB                                         */
/* ==================================================================== */

test("a ?foray= link enters its Foray once; reloading on Home stays on Home", () => {
  /* qa 129. MUTATION: drop the sessionStorage mark from enterForayFromQuery —
     the second call rewrites the hash to the Foray again. */
  const m = mount({ hash: "#/", search: "?foray=capital-types-1" });
  m.evalIn("enterForayFromQuery()");
  assert.strictEqual(m.ctx.location.hash, "#/foray/capital-types-1", "the first arrival enters the Foray");
  m.ctx.location.hash = "#/";                    // back to Home, then reload
  m.evalIn("enterForayFromQuery()");
  assert.strictEqual(m.ctx.location.hash, "#/", "a reload on Home must not bounce back to the Foray");
  assert.strictEqual(m.evalIn("forayParam()"), "capital-types-1", "the unlock (the param) is untouched");
});

/* ==================================================================== */
/* 6. THE TAB YOU ARE ON TAKES YOU TO THE TOP                             */
/* ==================================================================== */

test("tapping the tab you are already on scrolls to the top", () => {
  /* qa 131. MUTATION: drop the `bar.addEventListener("click", onTabBarClick)`
     line, or return early from onTabBarClick unconditionally. */
  const m = mount({ hash: "#/library" });
  m.ctx.scrollY = 2400;
  let prevented = false;
  const tab = { getAttribute: (a) => (a === "href" ? "#/library" : null) };
  m.ctx.onTabBarClick({ target: { closest: () => tab }, preventDefault() { prevented = true; } });
  assert.strictEqual(m.ctx.scrollY, 0);
  assert.strictEqual(prevented, true, "and it is not also a navigation");

  const other = { getAttribute: (a) => (a === "href" ? "#/shows" : null) };
  prevented = false;
  m.ctx.scrollY = 2400;
  m.ctx.onTabBarClick({ target: { closest: () => other }, preventDefault() { prevented = true; } });
  assert.strictEqual(prevented, false, "a different tab is ordinary navigation");

  /* And the bar the app builds is wired to it. */
  const made = [];
  m.ctx.document.querySelector = () => null;       // no bar yet: renderTabBar builds one
  m.ctx.document.createElement = (t) => {
    const e = makeEl(t);
    e.heard = [];
    e.addEventListener = (type, fn) => e.heard.push([type, fn]);
    made.push(e);
    return e;
  };
  m.evalIn("renderTabBar()");
  const bar = made.find((e) => e.tagName === "NAV");
  assert.ok(bar && bar.heard.some(([type, fn]) => type === "click" && fn === m.ctx.onTabBarClick),
    "renderTabBar must bind onTabBarClick on the bar it builds");
});

/* ==================================================================== */
/* 7. THE SHOW PAGE REPORTS ITS TERMINAL PAINT                            */
/* ==================================================================== */

test("an uncached show page re-applies a pending back-step restore when its episodes land", async () => {
  /* MUTATION: drop the `pageDidPaint()` call from paintEpisodeOutcome. */
  const m = mount({ hash: "#/show/s1" });
  m.evalIn(`state.ready = true;
    state.session = { session_id: 's', episodes: {}, cards: [], commute: {} };
    state.discover = { items: [] }; state.taxonomy = { nodes: [] };
    state.catalog = { shows: [{ show_id: "s1", title: "S1", taxonomy_node_ids: [] }] };`);
  let resolve;
  m.ctx.fetchShowEpisodes = () => new Promise((r) => { resolve = r; });
  m.ctx.cachedShowEpisodes = () => null;
  m.evalIn('renderedHash = "#/show/s1"; pendingRestore = { hash: "#/show/s1", y: 1800 };');
  m.evalIn('renderShow("s1")');
  assert.ok(!m.scrolls.includes(1800), "the loading paint is not terminal");
  resolve({ episodes: [{ guid: "g1", title: "E1", audio_url: "https://a.test/1.mp3" }], nextCursor: null });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(m.scrolls.includes(1800), `the restore must land on the loaded paint: ${m.scrolls}`);
});
