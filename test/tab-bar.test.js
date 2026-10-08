/* The tab bar, as the Dock's bottom row. Originally U-02 (docs/ui-transition-plan.md): a four-tab bar
 * gated by a cp_ui_v2 flag; U-11 (founder override, 2026-09-06, kanban card t_a3f01c8a) retired the
 * flag. The pre-cutover flag/off-state tests are preserved in archive/legacy-ui-2026-09/.
 *
 * RULING THAT FELL (Redesign 2026, ambient, the Dock; test-classification.md section 0): "FOUR TABS
 * (Home, Search, Create, Library) + DRAWER". This suite is REWRITE-ON-PURPOSE and is rewritten here, in
 * the PR that adopts the overturning direction: THREE tabs - Today, Discover, Library - and no drawer
 * navigation. What it still guarantees, as the classification asks: every route resolves to a real page;
 * EXACTLY ONE nav item is current for every route, never zero or two; the Dock's height equals the space
 * reserved for it (no content under it, the safe area counted once); the mini player never overlaps the
 * tab bar - it is a row of the same surface.
 *
 * WHAT THIS PROVES, in order:
 *  1. The tab bar always renders (no on/off state left).
 *  2. It renders three destinations, in order: Today, Discover, Library - and no Create.
 *  3. Each routed hash maps to exactly one tab, and that tab (and only that tab) carries
 *     aria-current="page"; the folded routes (#/create, #/starred-shows, #/interests) read as where
 *     they were folded.
 *  4. Every route still resolves to a real page.
 *  5. The tabs' hrefs: Today #/, Discover #/shows, Library #/library.
 *  6. The Dock reserves exactly the room it occupies, at both insets and in every state.
 *  7. The mini player is a row of the Dock, above the tab row, never a second bar.
 *
 * Every test names the mutation that kills it, per CLAUDE.md. The Dock's own behaviour (recede,
 * rows, field, fade, cast, car posture) is test/dock.test.js's.
 *
 * HARNESS: a small real DOM tree (not the flat by-id stub the other suites
 * use) because renderTabBar() creates and appends a fresh element and later
 * re-queries it by id/class -- a stub with no parent/child tracking cannot
 * answer "does #tab-bar exist now" after app.js itself created it.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

/* ---------- a minimal real DOM: parent/child tracking + a tiny selector
   engine (#id, .class, tag, and simple descendant combos of those). Enough
   for what app.js actually does to the DOM -- createElement, append,
   querySelector(All), classList, dataset, setAttribute/getAttribute/
   removeAttribute, remove(). Not a browser; a model of the exact operations
   this file's render functions perform. */

function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: "", className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {},
    children: [], parent: null, _attrs: {},
    href: undefined,
    classList: {
      add(...cs) { el.className = [...new Set([...(el.className ? el.className.split(/\s+/) : []), ...cs])].join(" "); },
      remove(...cs) { el.className = el.className.split(/\s+/).filter((c) => c && !cs.includes(c)).join(" "); },
      toggle(c, on) {
        const has = el.className.split(/\s+/).includes(c);
        const want = on === undefined ? !has : !!on;
        if (want && !has) el.classList.add(c);
        if (!want && has) el.classList.remove(c);
      },
      contains: (c) => el.className.split(/\s+/).includes(c),
    },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { k.parent = el; el.children.push(k); return k; },
    append(...ks) { for (const k of ks) { k.parent = el; el.children.push(k); } },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    removeAttribute(k) { delete el._attrs[k]; },
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
    querySelector(sel) { return matchAll(el, sel)[0] || null; },
    querySelectorAll(sel) { return matchAll(el, sel); },
  };
  return el;
}

/** Every descendant (not including `root` itself) matching a simple
    selector: "#id", ".class", "tag", or "tag.class". Good enough for
    everything app.js calls this with. */
function matchAll(root, sel) {
  const s = String(sel).trim();
  const test1 = (node) => {
    if (s.startsWith("#")) return node.id === s.slice(1);
    if (s.startsWith(".")) return node.className.split(/\s+/).includes(s.slice(1));
    const m = /^([a-z0-9]+)(\.[\w-]+)?$/i.exec(s);
    if (m) {
      const [, tag, cls] = m;
      if (node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      if (cls && !node.className.split(/\s+/).includes(cls.slice(1))) return false;
      return true;
    }
    return false;
  };
  const out = [];
  (function walk(node) {
    for (const c of node.children) {
      if (test1(c)) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
  "sh-form", "sh-input", "sh-note", "sh-results", "ep-search-results",
  "pl-form", "pl-input", "pl-note",
  "cr-form", "cr-input", "cr-note",
  "fy-sheet-note", "fy-scrim", "fy-sheet-cancel", "fy-sheet-go",
  "fy-play", "fy-next", "fy-prev", "fy-back", "fy-fwd", "fy-strip",
];

function mount({ seed = {}, native = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const body = makeEl("body");
  for (const id of PAGE_IDS) {
    const el = makeEl("div");
    el.id = id;
    body.appendChild(el);
  }
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}), // init() never completes; route() is driven by hand
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    Capacitor: native ? { isNativePlatform: () => true } : undefined,
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/", protocol: "https:" },
    history: { back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const evalIn = (src) => vm.runInContext(src, ctx);
  /* Same trick test/back-navigation.test.js uses: state.ready = true and
     stub the two page-painting calls so route()/renderCurrentPage() can be
     driven directly without a real init() fetch cycle. renderCurrentPage
     itself is NOT stubbed here -- it is exactly what calls renderTabBar(),
     which is the thing under test -- but the PAGE-BODY render functions it
     would call (renderHome et al) need state that a bare mount() doesn't
     have, so individual tests seed what each route needs or drive
     renderTabBar()/route() against routes that degrade safely. */
  evalIn("state.ready = true; openDrawer = () => {};");
  return {
    ctx, evalIn, body,
    go(hash) { ctx.location.hash = hash; evalIn("route()"); },
  };
}

/* ==================================================================== */
/* 1. THE BAR ALWAYS RENDERS (post-cutover: no on/off state left)        */
/* ==================================================================== */

test("the tab bar always exists after a render (cp_ui_v2 retired, U-11 cutover)", () => {
  /* MUTATION: reintroduce an off-branch in renderTabBar() that removes the
     bar under any condition. ui2On() always returns true post-cutover, so
     the bar must always exist. */
  const m = mount();
  m.evalIn('renderCurrentPage = () => { document.body.className = "view-home"; }; renderTabBar();');
  assert.ok(m.body.querySelector("#tab-bar"), "the tab bar must always exist post-cutover");
});

/* ==================================================================== */
/* 2. THREE TABS, IN ORDER, AND NO CREATE                                */
/* ==================================================================== */

const tabLabels = (m) => m.body.querySelector("#tab-bar").querySelectorAll(".tab-btn").map((a) => {
  const label = /<span class="tab-label">([^<]*)<\/span>/.exec(a.innerHTML);
  return label ? label[1] : null;
});

test("the tab bar renders THREE tabs in order - Today, Discover, Library - and there is no Create tab", () => {
  /* RULING THAT FELL: "four tabs + drawer". MUTATION: reorder TAB_ROUTES, drop an entry, or put the
     Create entry back (`{ key: "create", label: "Create", hash: "#/create" }`) - the label list below
     fails on each. innerHTML is how tabbar.js builds a tab (two glyphs + the label), so labels are read
     back out of it. */
  const m = mount();
  m.evalIn("renderTabBar();");
  assert.deepStrictEqual(tabLabels(m), ["Today", "Discover", "Library"]);
  const keys = m.body.querySelector("#tab-bar").querySelectorAll(".tab-btn").map((a) => a.dataset.tabKey);
  assert.deepStrictEqual(keys, ["today", "discover", "library"]);
});

test("every tab carries BOTH glyphs - Regular and Fill - from the sprite, so a tab change is a change of glyph", () => {
  /* The spec: "Active tab = Fill glyph + --text, inert = Regular + --text-2; a tab change is visible in
     greyscale." The crossfade between the two needs both in the DOM. MUTATION: build only the Regular
     glyph (drop the `tab-glyph-on` span) -> no Fill symbol is referenced and this goes red; point a tab at
     a symbol the sprite lacks -> agIcon returns "" and the href assertion goes red. */
  const m = mount();
  m.evalIn("renderTabBar();");
  const hrefs = m.body.querySelector("#tab-bar").querySelectorAll(".tab-btn")
    .map((a) => [...a.innerHTML.matchAll(/href="ui\/icons\.svg#(i-[\w-]+)"/g)].map((x) => x[1]));
  assert.deepStrictEqual(hrefs, [
    ["i-house", "i-house-fill"],
    ["i-compass", "i-compass-fill"],
    ["i-books", "i-books-fill"],
  ]);
});

/* ==================================================================== */
/* 3. EACH ROUTE MAPS TO EXACTLY ONE TAB, AND ONLY THAT TAB IS CURRENT    */
/* ==================================================================== */

test("every route highlights exactly one tab, and it is the right one", () => {
  /* MUTATION: change tabForHash's Discover branch to also match `#/library`
     (an overlapping regex). Both "discover" and "library" would then read
     current for a #/library hash and the "exactly one" assertion fails.
     MUTATION 2: restore `shows$` (no `($|\/)`), or `return null` as the
     fallback - the #/shows/q/ and #/bogus rows fail.
     MUTATION 3: delete an entry of ROUTE_ALIASES in app.js - the folded route reads as its OLD page
     (`#/create` falls to Today) and its row fails. */
  const m = mount();
  const cases = [
    ["#/", "today"],
    ["#/shows", "discover"],
    ["#/show/abc", "discover"],
    ["#/category/tech", "discover"],
    ["#/shows/q/Science", "discover"],
    ["#/episode/xyz", "discover"],
    ["#/subject/tech", "discover"],
    ["#/tuning", "today"],
    ["#", "today"],
    ["", "today"],
    ["#/bogus", "today"],
    ["#/library", "library"],
    ["#/queue", "library"],
    ["#/forays", "library"],
    ["#/foray/xyz", "library"],
    ["#/playlists", "library"],
    ["#/playlist/abc", "library"],
    /* THE THREE FOLDED ROUTES (ROUTE_ALIASES): each reads as where it was folded. */
    ["#/create", "discover"],        // the Create tab's field is Discover's
    ["#/starred-shows", "library"],  // Library lists every followed show
    ["#/interests", "today"],        // Interests is Tuning, behind Settings, which hangs off Today
  ];
  for (const [hash, want] of cases) {
    m.ctx.location.hash = hash;
    m.evalIn("renderTabBar();");
    const bar = m.body.querySelector("#tab-bar");
    const current = bar.querySelectorAll(".tab-btn").filter((a) => a.getAttribute("aria-current") === "page");
    assert.strictEqual(current.length, 1, `${hash}: exactly one tab must read as current, got ${current.length}`);
    assert.strictEqual(current[0].dataset.tabKey, want, `${hash}: expected the "${want}" tab current, got "${current[0].dataset.tabKey}"`);
  }
});

test("the three folded routes are rewritten in place, and only those three", () => {
  /* MUTATION: add `"#/playlists": "#/library"` to ROUTE_ALIASES -> the exact-set assertion goes red (a
     route nobody decided to fold); remove one -> it goes red the other way. */
  const m = mount();
  assert.deepStrictEqual(JSON.parse(m.evalIn("JSON.stringify(ROUTE_ALIASES)")), {
    "#/create": "#/shows",
    "#/starred-shows": "#/library",
    "#/interests": "#/tuning",
  });
  for (const [from, to] of [["#/create", "#/shows"], ["#/starred-shows", "#/library"], ["#/interests", "#/tuning"]]) {
    m.ctx.location.hash = from;
    assert.strictEqual(m.evalIn("currentHash()"), to, `${from} reads as ${to}`);
  }
  m.ctx.location.hash = "#/shows/q/created";
  assert.strictEqual(m.evalIn("currentHash()"), "#/shows/q/created", "a hash that merely contains one is untouched");
});

/* ==================================================================== */
/* 4. EVERY ROUTE STILL RESOLVES                                         */
/* ==================================================================== */

test("every routed page, and the three folded routes, still resolve to a real page", () => {
  /* MUTATION: have renderCurrentPage() return early for any route (e.g.
     accidentally gate page rendering behind a stale condition). Every one
     of these would then render nothing and the innerHTML assertion fails.
     13 -> 14 with U-06; 14 -> 15 with the Dock: #/tuning is the Interests page's new address, and
     #/create, #/starred-shows and #/interests are aliases that must land on a page, not on nothing. */
  const m = mount();
  m.evalIn(
    'state.catalog = { shows: [] }; state.discover = { items: [] }; ' +
    'state.taxonomy = { nodes: [] }; state.forays = []; ' +
    'state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] }; ' +
    'state.cardSlots = [];'
  );
  const routes = [
    "#/", "#/shows", "#/show/abc", "#/category/tech", "#/starred-shows",
    "#/episode/xyz", "#/playlists", "#/playlist/abc", "#/subject/tech",
    "#/create", "#/library", "#/queue", "#/forays", "#/foray/xyz", "#/tuning", "#/interests",
  ];
  assert.strictEqual(routes.length, 16, "sanity: this suite's own acceptance list names the 14 old routes, Tuning, and its alias");
  for (const hash of routes) {
    m.ctx.location.hash = hash;
    assert.doesNotThrow(() => m.evalIn("renderCurrentPage()"), `${hash} must render without throwing`);
    const view = m.body.querySelector("#view");
    assert.ok(view.innerHTML && view.innerHTML.length > 0, `${hash} must render real content`);
  }
});

/* ==================================================================== */
/* 5. THE TABS' HREFS                                                    */
/* ==================================================================== */

test("the tabs' hrefs are #/, #/shows and #/library", () => {
  /* MUTATION: point Discover's tab at "#/create" (the retired route) or Library's at "#/playlists" ->
     red. The tab IS the route: a tab whose href is an alias would light the right tab only after a
     redirect. */
  const m = mount();
  m.evalIn("renderTabBar();");
  const hrefs = Object.fromEntries(m.body.querySelector("#tab-bar").querySelectorAll(".tab-btn").map((a) => [a.dataset.tabKey, a.href]));
  assert.deepStrictEqual(hrefs, { today: "#/", discover: "#/shows", library: "#/library" });
});

/* ==================================================================== */
/* 6. THE DOCK AND THE PAGE NEVER OVERLAP CONTENT (ui/dock.css)           */
/* ==================================================================== */

/* docs/ui-transition-plan.md U-02's acceptance: "the bar and mini-player never overlap content
   (measured at inset 59px like test/home-layout.test.js does)" - now one surface. The arithmetic is
   resolved, not matched: test/helpers/dock-css.js reads the tokens and the Dock's own block and returns
   numbers, so a change to any token in the chain moves the answer. */

const dockCss = require("./helpers/dock-css.js");

/** Every state the Dock can be in, as the body classes that make it so. */
const DOCK_STATES = [
  [], ["fp-open"], ["sh-compose"], ["fp-open", "sh-compose"], ["dock-receded"], ["fp-open", "dock-receded"],
];

test("the page reserves, under its content, exactly the room the Dock occupies at rest - at both insets, in every state", () => {
  /* The Dock occupies: its rows (field + mini + tab row AT REST) + the float (--dock-inset, 12) + the
     home-indicator inset, counted ONCE. The page reserves that plus 24px of air under the last row.
     MUTATION: drop `var(--safe-bottom)` from `--dock-reserve` -> at inset 34 the reservation is 34 short
     and every state fails; add it twice -> 34 over. MUTATION 2: drop `var(--dock-mini-h)` -> the
     `fp-open` states fail by 64. Tested at inset 0 AND 34 because at 0 a missing inset term is invisible. */
  for (const classes of DOCK_STATES) {
    const label = classes.join(".") || "(rest)";
    const vars = dockCss.scope(classes);
    for (const inset of [0, 34, 59]) {
      const reserved = dockCss.resolve(dockCss.declOf("ui/dock.css", "body.ui-v2", "padding-bottom"), vars, inset);
      const occupied = dockCss.resolve("calc(var(--dock-rest-h) + var(--dock-inset) + var(--safe-bottom))", new Map([...vars, ["--safe-bottom", `${inset}px`]]), inset);
      assert.strictEqual(reserved - occupied, 24, `${label} at inset ${inset}: the page must reserve the Dock's room plus 24px of air (reserved ${reserved}, Dock ${occupied})`);
    }
  }
});

test("the Dock's rows add up to its height: field 48, mini 64, tab row 64 (44 receded), no gap", () => {
  /* The Veil budget (BUILD-NOTES 1.5): 64 / 128 at rest, 156 on Discover with a mini row (round 1's 148 had a 36px
     receded row; the prototype and the 44px floor say 44). MUTATION: change `--mini` or `--tab-bar` in
     tokens.css, `--dock-field-row` or `--dock-tab-receded` in ui/dock.css -> the row sums go red. */
  const sum = (classes, token) => { const v = dockCss.scope(classes); return dockCss.resolve(v.get(token), v, 0); };
  assert.strictEqual(sum([], "--dock-h"), 64, "tabs alone");
  assert.strictEqual(sum(["fp-open"], "--dock-h"), 128, "mini + tabs");
  assert.strictEqual(sum(["fp-open", "sh-compose"], "--dock-h"), 156, "Discover: field + mini + RECEDED tabs");
  assert.strictEqual(sum(["sh-compose"], "--dock-h"), 92, "Discover with nothing playing: field + receded tabs");
  assert.strictEqual(sum(["fp-open", "dock-receded"], "--dock-h"), 108, "a scrolled page: mini + receded tabs");
  assert.strictEqual(sum(["fp-open", "dock-receded"], "--dock-rest-h"), 128, "...and the page still reserves the tab row at rest");
});

test("the Dock floats 12px above the safe area, with the inset counted once (and rides the keyboard)", () => {
  /* MUTATION: `bottom: calc(var(--kb-inset, 0px) + var(--dock-inset))` (drop the safe area) -> red at inset
     34; add `var(--safe-bottom)` twice -> red the other way. */
  const vars = dockCss.scope([]);
  const bottom = dockCss.declOf("ui/dock.css", ".dock-layer .dock", "bottom");
  for (const inset of [0, 34]) {
    assert.strictEqual(dockCss.resolve(bottom, new Map([...vars, ["--safe-bottom", `${inset}px`]]), inset), inset + 12, `inset ${inset}`);
  }
  assert.strictEqual(dockCss.resolve(bottom, new Map([...vars, ["--kb-inset", "300px"]]), 0), 312, "300px of keyboard lifts it by 300");
});

/* ==================================================================== */
/* 7. THE MINI PLAYER IS A ROW OF THE DOCK                                */
/* ==================================================================== */

test("the Dock's rows are, top to bottom, the field, the mini player and the tab bar - one surface", () => {
  /* The mini player docks ABOVE the tab bar, and never as its own bar. MUTATION: append the mini row
     after #tab-bar, or move #tab-bar out of #dock -> the order assertion goes red; drop `veil` from the
     Dock's class -> the surface assertion does. */
  const m = mount();
  m.evalIn("renderTabBar();");
  const dock = m.body.querySelector("#dock");
  assert.ok(dock, "#dock exists");
  assert.deepStrictEqual(dock.children.map((c) => c.id), ["dock-field", "dock-mini", "tab-bar"]);
  assert.ok(dock.className.split(/\s+/).includes("veil"), "one Veil surface");
  assert.strictEqual(m.body.querySelectorAll("#tab-bar").length, 1, "and one tab bar");
});

test("the player hands its bar to the Dock's mini row, and the row follows fp-open", () => {
  /* MUTATION: have dockMountMini append to document.body (a second bar) -> the parent assertion goes red;
     drop the `mini.hidden = !playing` write from syncDock -> the row stays hidden (or shown) whatever
     plays. */
  const m = mount();
  m.evalIn("renderTabBar();");
  const progress = { tagName: "DIV" };
  const bar = { tagName: "DIV" };
  const mini = m.body.querySelector("#dock-mini");
  const took = m.evalIn("(p, b) => dockMountMini(p, b)")(progress, bar);
  assert.strictEqual(took, true, "the Dock took the bar");
  assert.deepStrictEqual(mini.children, [progress, bar], "the progress line and the bar are the mini row's children, in that order");
  assert.strictEqual(mini.hidden, true, "nothing is playing: the row is hidden");
  m.body.classList.add("fp-open");
  m.evalIn("syncDock()");
  assert.strictEqual(mini.hidden, false, "something is loaded: the row shows");
  m.body.classList.remove("fp-open");
  m.evalIn("syncDock()");
  assert.strictEqual(mini.hidden, true, "stopped: the row goes again");
});
