/* The search page's own chrome — three founder reports from 2026-09-13, all
 * about the Shows page (#/shows), which is the page he calls "the search
 * page" because the search field is the reason anyone opens it.
 *
 *   1. "On the search page, delete '220 shows in 4a's…'"
 *   2. "The cards below the search box are kind of helpful initially, but
 *       should go away when I click on the search box to start typing"
 *   3. "In the search page, when I start scrolling up, the search bar should
 *       reappear. At the top of the screen."
 *
 * WHAT THIS PROVES, in order:
 *  1. The Shows page renders NO `<p class="sub">` — and the shared template
 *     did not lose the ability to render one, because renderCategory still
 *     does. Both directions, because deleting the parameter outright would
 *     silently strip the category page's only size indicator.
 *  2. The search form is rendered INSIDE `.page-head`, not below it. That
 *     nesting is the entirety of report 3's implementation: `.page-head` is
 *     the element app.js's onWindowScroll() already hides on scroll-down and
 *     re-shows on scroll-up (test/collapsing-header-scroll.test.js owns that
 *     mechanism and is not duplicated here) — so the search bar reappearing
 *     at the top of the screen is a consequence of WHERE the field lives,
 *     and that is the thing worth pinning.
 *  3. The browse furniture (pill row, starred shortcut, editorial row, and
 *     the A–Z index) hides on FOCUS, stays hidden while a query is live even
 *     across a blur, and comes back on a blur with an empty field or on
 *     Escape. Driven through the real listeners renderAllShows binds, not
 *     through a reimplementation of the rule.
 *  4. updateShowBrowseVisibility is inert on a page with none of that markup
 *     (the category page reuses the same template), rather than throwing.
 *
 * WHAT THIS SUITE CANNOT PROVE, said plainly rather than faked:
 *   - that the collapsed bar actually slides back to the top of a real
 *     viewport on an upward flick, at 60fps, under iOS rubber-banding. That
 *     is CSS `position: sticky` + a transform in a real compositor. It was
 *     checked by hand in Chrome (see the PR); it is not checkable here.
 *   - that hiding on focus rather than on the first keystroke FEELS right on
 *     a phone. That is a judgement, recorded in updateShowBrowseVisibility's
 *     own comment, not a property.
 *   - that the software keyboard does not cover the results. Device only.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md, "a
 * green test is not evidence until you have broken it"). Every one was run
 * red before being run green.
 *
 * Harness: the same node:vm DOM stub as test/category-browse.test.js,
 * duplicated rather than imported (see that file's header for why), extended
 * with two things it does not have — recorded event listeners, so focus /
 * blur / input / keydown can be dispatched at the handlers renderAllShows
 * actually binds, and a `#view .show-index` selector, because the A–Z list is
 * one of the two nodes the browse rule toggles.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
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
    offsetHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    /* Drives the real handler. Returns how many ran, so a test can assert it
       actually dispatched something rather than passing on a typo. */
    dispatch(type, evt = {}) {
      const fns = listeners.get(type) || [];
      for (const fn of fns) fn({ type, preventDefault() {}, target: this, ...evt });
      return fns.length;
    },
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    blur() { this.dispatch("blur"); },
    remove() {},
  };
}

/* Every id renderAllShows or its callees look up. `sh-browse` and the
   `.show-index` stand-in are the two this suite adds. */
const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "menu-btn", "refresh-btn", "banner-slot",
  "sh-form", "sh-input", "sh-note", "sh-results", "sh-browse",
  "ep-search-results", "pl-search-results",
];

function mount() {
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const showIndex = makeEl("div");           // stands in for the A–Z list
  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => {
        const s = String(sel);
        if (s === "#view .show-index") return showIndex;
        return s.startsWith("#") && !s.includes(" ") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/shows", search: "", pathname: "/", href: "https://x.test/" },
    history: { back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    scrollY: 0,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const m = {
    ctx, byId, showIndex,
    state: vm.runInContext("state", ctx),
    view: () => byId.get("view").innerHTML,
    input: byId.get("sh-input"),
    browse: byId.get("sh-browse"),
    browseHidden: () => ({ cards: byId.get("sh-browse").hidden, index: showIndex.hidden }),
  };
  m.state.catalog = {
    shows: [
      { show_id: "a", title: "A Show", taxonomy_node_ids: [], editorial_note: "A real note." },
      { show_id: "b", title: "B Show", taxonomy_node_ids: [] },
    ],
  };
  m.state.taxonomy = { nodes: [{ id: "science", label: "Science", parent: null }] };
  m.state.discover = { items: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  return m;
}

/* The markup of ONE element, from its opening tag through its own matching
   close — a depth counter over `<div`/`</div>`, because "is the form inside
   the header" is a nesting question and indexOf comparisons cannot answer
   one. Only `<div>`s are counted: the header contains no other container
   tag, and the form/input/anchor inside it are void or self-closing at this
   level, so they cannot unbalance the count. */
function elementHtml(html, openMarker) {
  const start = html.indexOf(openMarker);
  assert.ok(start !== -1, `expected to find ${openMarker} in the rendered page`);
  let depth = 0;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let mm;
  while ((mm = re.exec(html))) {
    depth += mm[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(start, re.lastIndex);
  }
  assert.fail(`unbalanced <div> nesting after ${openMarker}`);
}

/* ==================================================================== */
/* 1. REPORT 1 — THE CATALOGUE SUBTITLE IS GONE FROM THE SHOWS PAGE      */
/*    ...AND STILL RENDERS ON THE CATEGORY PAGE                          */
/* ==================================================================== */

test("the Shows page renders no '220 shows in 4a's catalogue' subtitle at all", () => {
  /* MUTATION: put the subtitle argument back —
     `renderShowIndexPage("Shows", `${shows.length} shows in 4a's catalogue, A–Z`, ...)`.
     Both assertions fail. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  const html = m.view();
  assert.ok(html.includes("<h2>Shows</h2>"), "fixture assumption: this is still the Shows page");
  assert.ok(!html.includes("in 4a&#39;s catalogue") && !html.includes("in 4a's catalogue"),
    "the catalogue-count subtitle must be gone");
  assert.ok(!html.includes('<p class="sub">'),
    "not even an empty <p class=\"sub\"> may remain — it would leave the heading sitting on a blank line");
});

test("the category page still renders its own subtitle — the parameter was kept, not deleted", () => {
  /* The category page's "N shows in 4a's catalogue" is the only thing that
     says how big the category is, and it is not a restatement of the heading
     the way the Shows page's was.
     MUTATION: delete `subtitle` from renderShowIndexPage's signature/template
     (the tempting "it has no callers now" cleanup). This fails. RUN: failed
     as named. */
  const m = mount();
  m.state.catalog.shows[0].taxonomy_node_ids = ["science"];
  m.ctx.renderCategory("science");
  const html = m.view();
  assert.ok(html.includes("<h2>Science</h2>"), "fixture assumption: the category rendered");
  assert.ok(html.includes('<p class="sub">1 show in 4a&#39;s catalogue</p>'),
    `the category page must keep its count subtitle, got: ${html.slice(0, 400)}`);
});

/* ==================================================================== */
/* 2. REPORT 3 — THE SEARCH FIELD LIVES INSIDE THE COLLAPSING HEADER     */
/* ==================================================================== */

test("the search form renders INSIDE .page-head, which is what makes it reappear on scroll-up", () => {
  /* The mechanism itself (hide past a dead zone on scroll-down, re-show on
     any upward movement) is app.js's onWindowScroll and is proven by
     test/collapsing-header-scroll.test.js. It acts on `#view .page-head`, so
     the only thing that decides whether the SEARCH BAR gets that behaviour is
     whether it is inside that element. Before this change it was ordinary
     page content below the header and scrolled away for good.

     MUTATION: move the `<form id="sh-form">` block out of renderShowIndexPage's
     `headExtra` argument and back into `above`. The form is then a sibling of
     the header, not a child, and the nesting assertion fails. RUN: failed as
     named. */
  const m = mount();
  m.ctx.renderAllShows();
  const head = elementHtml(m.view(), '<div class="page-head');
  assert.ok(head.includes('id="sh-form"'), "the search form must be inside the sticky page header");
  assert.ok(head.includes('id="sh-input"'), "and so must the field itself");
  assert.ok(head.includes("<h2>Shows</h2>"), "fixture assumption: that really is the page header");
});

test("the stacked header keeps the back/title row as its own line above the field", () => {
  /* `.page-head` is a horizontal flex row; a full-width search field as a
     third flex child next to the ‹ button and the heading would be crushed.
     `.page-head-stacked` + `.page-head-main` (styles.css) turn it into a
     column with the original row preserved inside it.
     MUTATION: drop the `page-head-stacked` class from the template. This
     fails, and in a browser the field renders as a squeezed third column.
     RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  const head = elementHtml(m.view(), '<div class="page-head');
  assert.ok(head.startsWith('<div class="page-head page-head-stacked">'),
    `the Shows page header must opt into the stacked layout, got: ${head.slice(0, 80)}`);
  const main = elementHtml(head, '<div class="page-head-main">');
  assert.ok(main.includes('class="back"') && main.includes("<h2>Shows</h2>"),
    "the back button and heading must share one row");
  assert.ok(!main.includes('id="sh-form"'), "the field belongs under that row, not in it");
});

test("the category page, which shares the template, gets no stacked header and no search field", () => {
  /* MUTATION: make `headExtra` non-optional / always emit the stacked
     wrapper. This fails: the category page would grow an empty second row
     inside its header. RUN: failed as named. */
  const m = mount();
  m.ctx.renderCategory("science");
  const head = elementHtml(m.view(), '<div class="page-head');
  assert.ok(head.startsWith('<div class="page-head">'), `got: ${head.slice(0, 80)}`);
  assert.ok(!head.includes("sh-form"), "no search field on the category page");
});

/* ==================================================================== */
/* 3. REPORT 2 — THE BROWSE FURNITURE HIDES WHILE SEARCHING              */
/* ==================================================================== */

test("the browse furniture is visible when the page opens, before anyone touches the field", () => {
  /* The founder's own "kind of helpful initially" — the fix must not amount
     to deleting the cards.
     MUTATION: drop the `id="sh-browse"` wrapper from renderAllShows's `above`
     block (leaving the pills/starred/vouch loose). The container assertion
     fails and the rule loses its handle on them. A second, independent
     mutation also kills it: make updateShowBrowseVisibility's predicate a
     constant `true`. RUN: both failed as named.

     (NOT a mutation: flipping the `showSearchFieldFocused` initialiser to
     `true`. renderAllShows resets it on every render, so that line is not
     load-bearing and this test stays green — checked, and recorded here so
     nobody re-adds it as a claim this suite does not make.) */
  const m = mount();
  m.ctx.renderAllShows();
  assert.deepStrictEqual(m.browseHidden(), { cards: false, index: false });
  assert.ok(m.view().includes('id="sh-browse"'), "the cards must be in a container the rule can toggle");
  assert.ok(m.view().includes('href="#/starred-shows"'), "…and that container holds the starred shortcut");
  assert.ok(m.view().includes("Shows we vouch for"), "…and the editorial row");
});

test("FOCUSING the search box hides the cards and the A-Z list — before a single keystroke", () => {
  /* The report: "should go away when I click on the search box to start
     typing". Focus, not first keystroke — see updateShowBrowseVisibility's
     comment for why that is the right trigger on a phone.
     MUTATION: bind the hide to the `input` listener only (drop the focus
     handler's `showSearchFieldFocused = true; updateShowBrowseVisibility();`).
     This fails — nothing is hidden until a character is typed. RUN: failed as
     named. */
  const m = mount();
  m.ctx.renderAllShows();
  assert.strictEqual(m.input.dispatch("focus"), 1, "renderAllShows must bind exactly one focus handler");
  assert.deepStrictEqual(m.browseHidden(), { cards: true, index: true });
});

test("the A-Z index hides too, not just the cards above it", () => {
  /* 220 rows of unrelated catalogue under a live result list is the same
     clutter complaint, one scroll further down.
     MUTATION: drop `$("#view .show-index")` from showBrowseSections(). The
     `index` half fails while the `cards` half keeps passing — which is
     exactly why both halves are asserted as one object. RUN: failed as
     named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");
  assert.strictEqual(m.showIndex.hidden, true);
});

test("typing keeps them hidden, and blurring with a live query LEAVES them hidden", () => {
  /* Dismissing the keyboard while results are on screen must not shove those
     results down the page to re-expose the catalogue.
     MUTATION: change the predicate to `showSearchFieldFocused` alone. The
     post-blur assertion fails. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");
  m.input.value = "radio";
  assert.strictEqual(m.input.dispatch("input"), 1, "renderAllShows must bind exactly one input handler");
  assert.deepStrictEqual(m.browseHidden(), { cards: true, index: true }, "still hidden while typing");
  m.input.dispatch("blur");
  assert.deepStrictEqual(m.browseHidden(), { cards: true, index: true },
    "a live query keeps the answer at the top of the page even with the keyboard dismissed");
});

test("blurring with an EMPTY field brings the browse furniture back", () => {
  /* The restorer that works on a phone, where there is no Escape key.
     MUTATION: delete the blur listener. This fails — the page stays stripped
     until the next navigation. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");
  m.input.value = "radio";
  m.input.dispatch("input");
  m.input.value = "";
  m.input.dispatch("input");
  assert.deepStrictEqual(m.browseHidden(), { cards: true, index: true },
    "deleting the query while still focused is still 'mid-search' — deliberately still hidden");
  assert.strictEqual(m.input.dispatch("blur"), 1, "renderAllShows must bind exactly one blur handler");
  assert.deepStrictEqual(m.browseHidden(), { cards: false, index: false });
});

test("a field holding only whitespace counts as empty for the restore rule", () => {
  /* `onShowSearchInput` already trims, so " " searches nothing; the browse
     rule must agree with it rather than treat a stray space as a live query.
     MUTATION: drop the `.trim()` from updateShowBrowseVisibility. This fails.
     RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");
  m.input.value = "   ";
  m.input.dispatch("input");
  m.input.dispatch("blur");
  assert.deepStrictEqual(m.browseHidden(), { cards: false, index: false });
});

test("Escape clears the field, drops the results and restores the browse furniture", () => {
  /* MUTATION: remove the keydown listener, or narrow it to `e.key === "Esc"`.
     This fails on the value assertion first. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");
  m.input.value = "radio";
  m.input.dispatch("input");
  m.byId.get("sh-results").hidden = false;
  m.byId.get("sh-results").innerHTML = "<div>a result</div>";

  assert.strictEqual(m.input.dispatch("keydown", { key: "Escape" }), 1, "one keydown handler");
  assert.strictEqual(m.input.value, "", "Escape must empty the field");
  assert.strictEqual(m.byId.get("sh-results").hidden, true, "…and clear the painted results");
  assert.deepStrictEqual(m.browseHidden(), { cards: false, index: false });
});

test("a keydown that is not Escape changes nothing", () => {
  /* MUTATION: drop the `if (e.key !== "Escape") return;` guard. This fails —
     every keystroke would wipe the field being typed into. RUN: failed as
     named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");
  m.input.value = "radi";
  m.input.dispatch("keydown", { key: "o" });
  assert.strictEqual(m.input.value, "radi");
  assert.deepStrictEqual(m.browseHidden(), { cards: true, index: true });
});

test("re-rendering the page resets to the resting state — it never opens pre-stripped", () => {
  /* `showSearchFieldFocused` is module-level, so a page left mid-search and
     returned to would otherwise render with its catalogue already hidden and
     no way back except focusing and blurring.
     MUTATION: delete the `showSearchFieldFocused = false;` line at the top of
     renderAllShows's binding block. This fails. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");
  assert.deepStrictEqual(m.browseHidden(), { cards: true, index: true });
  m.input.value = "";
  m.ctx.renderAllShows();   // navigated away and back
  assert.deepStrictEqual(m.browseHidden(), { cards: false, index: false });
});

/* ==================================================================== */
/* 4. THE RULE IS INERT WHERE THE MARKUP ISN'T                           */
/* ==================================================================== */

test("updateShowBrowseVisibility is inert on a page with no search markup", () => {
  /* renderCategory reuses the same template with none of these nodes, and
     showBrowseSections must not throw on the nulls.
     MUTATION: drop the `.filter(Boolean)` from showBrowseSections(). This
     throws on `el.hidden` instead of completing quietly. RUN: failed as
     named. */
  const m = mount();
  m.ctx.document.querySelector = () => null;
  assert.doesNotThrow(() => m.ctx.updateShowBrowseVisibility());
});
