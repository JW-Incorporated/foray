/* The tab bar. U-02 built it with four tabs (Home, Search, Create, Library)
 * and a drawer; U-11 (2026-09-06) retired its cp_ui_v2 flag, so it is
 * unconditional.
 *
 * REWRITTEN ON PURPOSE (Redesign 2026, Tactile Phase 4 group A `mini`): the
 * ruling that fell is D3, "4 tabs + drawer" (docs/redesign-2026/
 * test-classification.md; the owner picked Tactile on 2026-10-06, whose
 * DIRECTION.md overturns it). The deck carries THREE tabs: Today, Find,
 * Yours. Create's page and the subject queues light Find (naming a subject is
 * Find's second job); playlists light Yours. What the rewrite still
 * guarantees, per the classification: every route resolves to a real page;
 * exactly one nav item is current for every route, never zero or two; the
 * content reservation clears the bar (safe area counted once); the mini
 * player never overlaps the bar.
 *
 * WHAT THIS PROVES, in order:
 *  1. The tab bar always renders (no on/off state left).
 *  2. It renders the three destinations in the direction's order: Today,
 *     Find, Yours.
 *  3. Each of the app's 14 routes maps to exactly one tab, and that tab
 *     (and only that tab) carries aria-current="page"; the indicator's slot
 *     follows it.
 *  4. All 14 routes still resolve to a real page.
 *  5. Yours points at #/library, Find at #/shows, Today at #/.
 *  6. The Yours tab says how many are queued, and only when any are.
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
/* 2. ALL FOUR TABS, IN ORDER                                            */
/* ==================================================================== */

test("the tab bar renders the three Tactile tabs in order: Today, Find, Yours, each with both icon weights", () => {
  /* MUTATION: reorder TAB_ROUTES, or drop one entry (or restore Create). The
     labels array comparison below fails on any of them.
     MUTATION 2: drop the `-fill` icon from tabMarkup -> the Fill assertion fails. */
  const m = mount();
  m.evalIn("renderTabBar();");
  const bar = m.body.querySelector("#tab-bar");
  assert.ok(bar, "the tab bar must exist");
  // innerHTML builds each tab's content (icons + label span), not real child
  // nodes -- so read labels back out of innerHTML.
  const tabs = bar.querySelectorAll(".tab-btn");
  const htmlLabels = tabs.map((a) => {
    const m2 = /<span class="tab__label">([^<]*)<\/span>/.exec(a.innerHTML);
    return m2 ? m2[1] : null;
  });
  assert.deepStrictEqual(htmlLabels, ["Today", "Find", "Yours"]);
  const icons = [["ph-sun-horizon"], ["ph-magnifying-glass"], ["ph-bookmarks"]];
  tabs.forEach((a, i) => {
    assert.match(a.innerHTML, new RegExp(`class="i i--bold"[^>]*><use href="#${icons[i][0]}"`), "Bold when idle");
    assert.match(a.innerHTML, new RegExp(`class="i i--fill"[^>]*><use href="#${icons[i][0]}-fill"`), "Fill when current");
  });
  assert.strictEqual(bar.getAttribute("aria-label"), "Main");
  assert.ok(bar.querySelector(".tab-bar__ind"), "one indicator, slid by CSS");
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
     current for a #/library hash and the "exactly one" assertion fails.
     MUTATION 2: restore `shows$` (no `($|\/)`), or `return null` as the
     fallback — the new #/shows/q/ and #/bogus rows fail.
     MUTATION 3: drop `playlists$|playlist\/` from the library branch -> the
     playlist rows light Today and fail.
     MUTATION 4: set `data-active` from a constant 0 -> the indicator rows fail. */
  const m = mount();
  const cases = [
    ["#/", "home"],
    ["#/shows", "search"],
    ["#/show/abc", "search"],
    ["#/category/tech", "search"],
    /* Followed shows moved into Library (R6, 2026-09-22), and every route
       lights a tab: a browse pill's #/shows/q/, Interests, and anything the
       router renders as Home (audit 2026-09-22). */
    ["#/starred-shows", "library"],
    ["#/shows/q/Science", "search"],
    ["#/interests", "library"],
    ["#", "home"],
    ["", "home"],
    ["#/bogus", "home"],
    ["#/episode/xyz", "search"],
    ["#/playlists", "library"],
    ["#/playlist/abc", "library"],
    ["#/subject/tech", "search"],
    ["#/create", "search"],
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
    assert.strictEqual(bar.getAttribute("data-active"), String(["home", "search", "library"].indexOf(want)), `${hash}: the indicator sits under the current tab`);
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

test("the Yours tab's href is #/library", () => {
  /* MUTATION: point TAB_ROUTES's library entry at "#/queue" -> red. */
  const m = mount();
  m.evalIn("renderTabBar();");
  const bar = m.body.querySelector("#tab-bar");
  const lib = bar.querySelectorAll(".tab-btn").find((a) => a.dataset.tabKey === "library");
  assert.ok(lib, "a library tab must exist");
  assert.strictEqual(lib.href, "#/library");
});

/* ==================================================================== */
/* 7b. TODAY AND FIND, AND NO CREATE TAB (D3 fell with Tactile)          */
/* ==================================================================== */

test("Today points at #/, Find at #/shows, and there is no Create tab", () => {
  /* MUTATION: re-add a `create` entry to TAB_ROUTES -> the count and the
     no-create assertion fail. Create's page still resolves (section 6) and
     lights Find (section 5). */
  const m = mount();
  m.evalIn("renderTabBar();");
  const tabs = m.body.querySelector("#tab-bar").querySelectorAll(".tab-btn");
  assert.strictEqual(tabs.length, 3);
  assert.strictEqual(tabs.find((a) => a.dataset.tabKey === "home").href, "#/");
  assert.strictEqual(tabs.find((a) => a.dataset.tabKey === "search").href, "#/shows");
  assert.strictEqual(tabs.find((a) => a.dataset.tabKey === "create"), undefined);
});

test("the Yours tab names the Up Next count, and only when something is queued", () => {
  /* BUILD-NOTES 3.11: the badge shows only when Up Next is non-empty. The
     badge itself lives in the aria-hidden icon wrapper, so the tab's name
     carries the count (the badge node is pinned in test/tactile-mini.test.js).
     MUTATION: in paintTabBadge change `if (n > 0)` to `if (n >= 0)` -> the
     empty queue still says "0 queued" and this fails. */
  const m = mount({ seed: { cp_queue: JSON.stringify(["ep-1", "ep-2"]) } });
  m.evalIn("renderTabBar();");
  const yours = () => m.body.querySelector("#tab-bar").querySelectorAll(".tab-btn").find((a) => a.dataset.tabKey === "library");
  assert.strictEqual(yours().getAttribute("aria-label"), "Yours, 2 queued");
  assert.match(yours().innerHTML, /<span class="tab__badge" hidden><\/span>/, "the badge starts hidden and is filled by paintTabBadge");
  m.evalIn('saveQueueIds([]);');
  assert.strictEqual(yours().getAttribute("aria-label"), null, "an empty Up Next names no count");
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
      // The deck's live tab-row height is declared on body.ui-v2 (not the Dial :root,
      // whose token set is pinned), so those blocks are scanned too, after :root.
      for (const rootMatch of [...CSS.matchAll(/:root\s*\{([^}]*)\}/g), ...CSS.matchAll(/(?:^|\})\s*body\.ui-v2\s*\{([^}]*)\}/gm)]) {
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

test("body.ui-v2's content reservation clears the floating tab row, safe area counted once, at both insets", () => {
  /* The deck floats: its top edge is its bottom offset (safe area + 12) plus
     its height, and the reservation must reach past that, by the formula
     BUILD-NOTES 3.11 gives (deck-h + safe-b + 24 with no mini).
     MUTATION: change `body.ui-v2`'s padding-bottom to `calc(var(--deck-h) +
     var(--safe-b))` -> the last row sits under the deck and this fails.
     MUTATION 2: add the inset twice (`+ var(--safe-b) + var(--safe-b)`) -> the
     34px row overshoots the 24px gap and fails. */
  for (const insetBottom of [0, 34]) { // 0 = desktop, 34 = iPhone home-indicator inset
    const top = resolvePx(cssDecl("body.ui-v2 .tab-bar", "bottom"), insetBottom) + resolvePx(cssDecl("body.ui-v2 .tab-bar", "height"), insetBottom);
    const reserved = resolvePx(cssDecl("body.ui-v2", "padding-bottom"), insetBottom);
    assert.strictEqual(reserved - top, 12, `inset ${insetBottom}px: the reservation (${reserved}px) clears the deck's top (${top}px) by 12px`);
  }
});

test("the mini-player docks ABOVE the tab row: its bottom offset is the row's top edge plus the 1px separator", () => {
  /* MUTATION: hardcode `body.ui-v2 #foray-player.dial-mini { bottom: 0 }`
     (the mini behind the tab row). This fails because bottom would be 0. */
  for (const insetBottom of [0, 34]) {
    const top = resolvePx(cssDecl("body.ui-v2 .tab-bar", "bottom"), insetBottom) + resolvePx(cssDecl("body.ui-v2 .tab-bar", "height"), insetBottom);
    const playerBottom = resolvePx(cssDecl("body.ui-v2 #foray-player.dial-mini", "bottom"), insetBottom);
    assert.strictEqual(
      playerBottom, top + 1,
      `inset ${insetBottom}px: the mini's bottom offset (${playerBottom}px) must sit on the tab row's ` +
      `top edge (${top}px) plus the separator, so it docks above the row, not behind it`
    );
  }
});
