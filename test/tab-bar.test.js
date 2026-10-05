/* U-02 (docs/ui-transition-plan.md): the four-tab bar. Originally gated by a
 * cp_ui_v2 flag; U-11 (founder override, 2026-09-06, kanban card
 * t_a3f01c8a) retired the flag — ui2On() now always returns true and the
 * bar is unconditional. The pre-cutover flag/off-state tests are preserved
 * in archive/legacy-ui-2026-09/ (see that directory's README).
 *
 * WHAT THIS PROVES, in order:
 *  1. The tab bar always renders (no on/off state left).
 *  2. It renders all four destinations, in the mockup's order: Home,
 *     Search, Create, Library.
 *  3. Each of the app's 14 routes maps to exactly one tab, and that tab
 *     (and only that tab) carries aria-current="page" -- so switching tabs
 *     always highlights a real destination, never a stale or double one.
 *  4. All 14 routes still resolve to a real page.
 *  5. Library's tab points at #/library (the U-10/library-screen precedent
 *     this card is explicitly asked to compose with).
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
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

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
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
  "fy-play", "fy-next", "fy-prev", "fy-strip",
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
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
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
/* 2. ALL FOUR TABS, IN ORDER                                            */
/* ==================================================================== */

test("the tab bar renders all four tabs in the mockup's order: Home, Search, Create, Library", () => {
  /* MUTATION: reorder TAB_ROUTES, or drop one entry. The labels array
     comparison below fails on either. */
  const m = mount();
  m.evalIn("renderTabBar();");
  const bar = m.body.querySelector("#tab-bar");
  assert.ok(bar, "the tab bar must exist");
  const labels = bar.querySelectorAll(".tab-btn").map((a) => {
    const span = a.children.find((c) => c.tagName === "SPAN");
    return span ? span.textContent : null;
  });
  // innerHTML is used to build each tab's content in app.js (icon + <span>text</span>),
  // not real child nodes -- so read labels back out of innerHTML instead.
  const htmlLabels = bar.querySelectorAll(".tab-btn").map((a) => {
    const m2 = /<span>([^<]*)<\/span>/.exec(a.innerHTML);
    return m2 ? m2[1] : null;
  });
  assert.deepStrictEqual(htmlLabels, ["Home", "Search", "Create", "Library"]);
  void labels;
});

/* Sections 3 and 4 (turning the flag off; native-shell default vs explicit
   choice) were retired with the cp_ui_v2 flag itself in U-11 (founder
   override, 2026-09-06). There is no off state left to test — see the
   header comment and archive/legacy-ui-2026-09/ for the pre-cutover
   coverage. */

/* ==================================================================== */
/* 5. EACH ROUTE MAPS TO EXACTLY ONE TAB, AND ONLY THAT TAB IS CURRENT    */
/* ==================================================================== */

test("every route highlights exactly one tab, and it is the right one", () => {
  /* MUTATION: change tabForHash's Search branch to also match `#/library`
     (an overlapping regex). Both "search" and "library" would then read
     current for a #/library hash and the "exactly one" assertion fails. */
  const m = mount();
  const cases = [
    ["#/", "home"],
    ["#/shows", "search"],
    ["#/show/abc", "search"],
    ["#/category/tech", "search"],
    ["#/starred-shows", "search"],
    ["#/episode/xyz", "search"],
    ["#/playlists", "create"],
    ["#/playlist/abc", "create"],
    ["#/subject/tech", "create"],
    ["#/create", "create"],
    ["#/library", "library"],
    ["#/queue", "library"],
    ["#/forays", "library"],
    ["#/foray/xyz", "library"],
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

/* ==================================================================== */
/* 6. ALL 14 ROUTES STILL RESOLVE WITH THE FLAG ON                       */
/* ==================================================================== */

test("all 14 existing routes still resolve to a real page", () => {
  /* MUTATION: have renderCurrentPage() return early for any route (e.g.
     accidentally gate page rendering behind a stale condition). Every one
     of these would then render nothing and the innerHTML assertion fails.
     13 -> 14 with U-06 (docs/ui-transition-plan.md): #/create is a new
     route, Create's own screen rather than an alias for #/playlists. */
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
    "#/create", "#/library", "#/queue", "#/forays", "#/foray/xyz",
  ];
  assert.strictEqual(routes.length, 14, "sanity: this suite's own acceptance list must name all 14 routes");
  for (const hash of routes) {
    m.ctx.location.hash = hash;
    assert.doesNotThrow(() => m.evalIn("renderCurrentPage()"), `${hash} must render without throwing when cp_ui_v2 is on`);
    const view = m.body.querySelector("#view");
    assert.ok(view.innerHTML && view.innerHTML.length > 0, `${hash} must render real content with cp_ui_v2 on`);
  }
});

/* ==================================================================== */
/* 7. LIBRARY TAB POINTS AT #/library                                    */
/* ==================================================================== */

test("the Library tab's href is #/library", () => {
  const m = mount();
  m.evalIn("renderTabBar();");
  const bar = m.body.querySelector("#tab-bar");
  const lib = bar.querySelectorAll(".tab-btn").find((a) => a.dataset.tabKey === "library");
  assert.ok(lib, "a library tab must exist");
  assert.strictEqual(lib.href, "#/library");
});

/* ==================================================================== */
/* 7b. CREATE TAB POINTS AT #/create (U-06)                              */
/* ==================================================================== */

test("the Create tab's href is #/create, not #/playlists", () => {
  /* MUTATION: revert TAB_ROUTES's create entry's hash back to "#/playlists".
     U-06 gives Create its own screen (the Foray|Playlist toggle, honest
     copy) rather than routing straight at the old Playlists page. */
  const m = mount();
  m.evalIn("renderTabBar();");
  const bar = m.body.querySelector("#tab-bar");
  const create = bar.querySelectorAll(".tab-btn").find((a) => a.dataset.tabKey === "create");
  assert.ok(create, "a create tab must exist");
  assert.strictEqual(create.href, "#/create");
});

/* ==================================================================== */
/* 8. THE BAR AND THE MINI-PLAYER NEVER OVERLAP CONTENT (styles.css)      */
/* ==================================================================== */

/* docs/ui-transition-plan.md U-02's acceptance: "the bar and mini-player
   never overlap content (measured at inset 59px like
   test/home-layout.test.js does)." A minimal CSS box-model check,
   deliberately narrower than that suite's full evaluator: it resolves
   just the handful of var()/env()/calc() expressions this card's own
   rules introduce, over the same two inset conditions. */

const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

function cssDecl(selector, prop) {
  // Every unconditional (non-@media) rule with this exact selector, in
  // source order -- body.ui-v2 in particular has more than one such block
  // (U-01's token scope, and this card's own), and the winning declaration
  // is whichever named block actually declares `prop`, last-one-wins like
  // the real cascade.
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(
    `(?:^|\\})\\s*${selector.replace(/[.#]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "gm"
  );
  const declRe = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+);`, "m");
  let found = null;
  let m2;
  while ((m2 = re.exec(stripped))) {
    const d = declRe.exec(m2[1]);
    if (d) found = d[1].trim();
  }
  assert.ok(found, `no unconditional \`${selector} { ${prop}: ... }\` declaration found in styles.css`);
  return found;
}

function resolvePx(expr, insetBottom) {
  let out = expr;
  for (let i = 0; i < 10 && /var\(|env\(/.test(out); i++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_m, name) => {
      const re = new RegExp(`${name}:\\s*([^;]+);`);
      // --tab-bar-h and --topbar-h etc. are declared across MULTIPLE :root
      // blocks (styles.css opens more than one), so scan all of them and
      // take the last match, same last-one-wins rule as the real cascade.
      let found = null;
      for (const rootMatch of CSS.matchAll(/:root\s*\{([^}]*)\}/g)) {
        const d = re.exec(rootMatch[1]);
        if (d) found = d[1].trim();
      }
      assert.ok(found, `\`${name}\` is not declared on any :root block`);
      return found;
    });
    out = out.replace(/env\(\s*safe-area-inset-bottom\s*(?:,[^()]*)?\)/g, `${insetBottom}px`);
  }
  const num = /^calc\((.+)\)$/.exec(out.trim());
  const flat = num ? num[1] : out;
  // Only `+` of plain px terms appears in these rules -- good enough here.
  const total = flat.split("+").reduce((sum, term) => {
    const t = term.trim();
    const px2 = /^(-?\d*\.?\d+)px$/.exec(t);
    assert.ok(px2, `unexpected term "${t}" in "${expr}" -- this test's tiny resolver only handles a sum of px terms`);
    return sum + Number(px2[1]);
  }, 0);
  return total;
}

test("the tab bar's own height and body.ui-v2's content reservation for it agree, at both insets", () => {
  /* MUTATION: change `.tab-bar`'s height calc to a different constant than
     `body.ui-v2`'s padding-bottom (the classic "one got fixed, the other
     didn't" drift .topbar's own four reservations already guard against
     for the top edge). Either inset catches a mismatch. */
  for (const insetBottom of [0, 34]) { // 0 = desktop, 34 = iPhone home-indicator inset
    const barHeight = resolvePx(cssDecl(".tab-bar", "height"), insetBottom);
    const reserved = resolvePx(cssDecl("body.ui-v2", "padding-bottom"), insetBottom);
    assert.strictEqual(
      reserved, barHeight,
      `inset ${insetBottom}px: body.ui-v2's padding-bottom (${reserved}px) must equal ` +
      `the tab bar's own height (${barHeight}px), or content is hidden behind (or a gap ` +
      `is left under) the bar`
    );
  }
});

test("the mini-player docks ABOVE the tab bar: #foray-player's bottom offset equals the bar's height while both are open", () => {
  /* MUTATION: hardcode `body.ui-v2.fp-open #foray-player { bottom: 0 }`
     (i.e. let the mini-player sit behind/under the tab bar instead of
     docking above it). This fails because bottom would be 0, not the
     bar's height. */
  for (const insetBottom of [0, 34]) {
    const barHeight = resolvePx(cssDecl(".tab-bar", "height"), insetBottom);
    const playerBottom = resolvePx(cssDecl("body.ui-v2.fp-open #foray-player", "bottom"), insetBottom);
    assert.strictEqual(
      playerBottom, barHeight,
      `inset ${insetBottom}px: the mini-player's bottom offset (${playerBottom}px) must equal ` +
      `the tab bar's height (${barHeight}px) so it docks above the bar, not behind it`
    );
  }
});
