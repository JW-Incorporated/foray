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
 * REPORT 3 WAS SUPERSEDED BY THE FOUNDER HIMSELF, hours later: "We should
 * likely also move the search bar down to the bottom - model it after most
 * other text boxes, for example in the Claude app or Apple Podcasts." A field
 * pinned to the bottom edge is on screen at every scroll position, so "scroll
 * up to bring it back" has nothing left to bring back. Section 2 below was
 * rewritten from that instruction and now pins the NEGATIVE — the field is
 * not in the header, and the header is back to one shape. The bottom
 * placement itself is owned by test/search-field-bottom.test.js; this file
 * deliberately does not restate it.
 *
 * WHAT THIS PROVES, in order:
 *  1. The Shows page renders NO `<p class="sub">` — and the shared template
 *     did not lose the ability to render one, because renderCategory still
 *     does. Both directions, because deleting the parameter outright would
 *     silently strip the category page's only size indicator.
 *  2. The search form is NOT inside `.page-head`, the header still carries
 *     the ‹ button and the title, the `.page-head-stacked` variant that
 *     briefly made room for the field is gone from both the markup and
 *     styles.css, and the category page has neither field nor compose bar.
 *  3. The browse furniture (pill row, starred shortcut, editorial row, and
 *     the A–Z index) hides on FOCUS, stays hidden while a query is live even
 *     across a blur, and comes back on a blur with an empty field or on
 *     Escape. Driven through the real listeners renderAllShows binds, not
 *     through a reimplementation of the rule.
 *  4. updateShowBrowseVisibility is inert on a page with none of that markup
 *     (the category page reuses the same template), rather than throwing.
 *
 * WHAT THIS SUITE CANNOT PROVE, said plainly rather than faked:
 *   - that the header itself still collapses acceptably on a real viewport
 *     under iOS rubber-banding. That is CSS `position: sticky` + a transform
 *     in a real compositor. It was checked by hand in Chrome (see the PR); it
 *     is not checkable here.
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
/* Read as text, for the one assertion that a class the markup no longer emits
   has no rule left behind it. Not a substitute for a browser — see the header. */
const STYLES = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

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
  /* The category page's count is the only thing that says how big the category
     is, and it is not a restatement of the heading the way the Shows page's
     was.
     MUTATION: delete `subtitle` from renderShowIndexPage's signature/template
     (the tempting "it has no callers now" cleanup). This fails. RUN: failed
     as named.

     IT NO LONGER NAMES THE CATALOGUE (issue #684; founder, 2026-09-13: "don't
     blame it on 4a"). "in 4a's catalogue" carried no information here — a
     category page can only ever list shows we hold — so it was pure
     self-explanation and went. The COUNT is untouched, because a count is not
     a blame; the episode counts in showEpisodeCountLabel keep the phrase for
     the opposite reason, that there it distinguishes a curated slice from the
     publisher's full list.
     MUTATION: restore "in 4a's catalogue" in renderCategory -> the second and
     third assertions go red. */
  const m = mount();
  m.state.catalog.shows[0].taxonomy_node_ids = ["science"];
  m.ctx.renderCategory("science");
  const html = m.view();
  assert.ok(html.includes("<h2>Science</h2>"), "fixture assumption: the category rendered");
  assert.ok(html.includes('<p class="sub">1 show</p>'),
    `the category page must keep its count subtitle, got: ${html.slice(0, 400)}`);
  assert.ok(!html.includes("4a"),
    `the subtitle must not name our own catalogue as the reason for anything: ${html.slice(0, 400)}`);
});

/* ==================================================================== */
/* 2. THE SEARCH FIELD IS NOT IN THE HEADER — IT IS AT THE BOTTOM        */
/*                                                                      */
/* REPORT 3 ("when I start scrolling up, the search bar should reappear. */
/* At the top of the screen") was answered by rendering the field inside */
/* `.page-head`, and was superseded the same day by the founder's next   */
/* instruction: "We should likely also move the search bar down to the   */
/* bottom - model it after most other text boxes, for example in the     */
/* Claude app or Apple Podcasts." A field pinned to the bottom is always */
/* on screen, so there is nothing for a scroll-up to reveal.             */
/*                                                                      */
/* The bottom placement itself, its docking arithmetic and its keyboard  */
/* tracking are owned by test/search-field-bottom.test.js. What stays    */
/* HERE is the negative these tests were originally written as: the      */
/* header does NOT carry the field, and the header still exists.         */
/* ==================================================================== */

test("the search form does NOT render inside .page-head any more", () => {
  /* The header's collapse (hide past a dead zone on scroll-down, re-show on
     any upward movement — app.js's onWindowScroll, proven by
     test/collapsing-header-scroll.test.js) acts on `#view .page-head`. While
     the field lived in there it collapsed with it. It must not any more: a
     compose bar that vanishes when you scroll down the list you are
     searching is the opposite of the thing being asked for.

     MUTATION: put the field back in the header — restore the `headExtra`
     argument on renderShowIndexPage and pass the `<form id="sh-form">` block
     through it. This fails. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  const head = elementHtml(m.view(), '<div class="page-head');
  assert.ok(head.includes("<h2>Shows</h2>"), "fixture assumption: that really is the page header");
  assert.ok(!head.includes("sh-form"), "the search form must not be inside the collapsing header");
  assert.ok(!head.includes("sh-input"), "nor the field itself");
  assert.ok(!head.includes("sh-compose"), "nor the bar that now holds it");
});

test("the page header keeps its job — the back button and the title — and only one shape of it survives", () => {
  /* The header was NOT deleted along with the field it briefly carried: the ‹
     button is how you leave this page and the title is how you know where you
     are, and both still collapse on scroll exactly as they have since
     2026-09-05. What is gone is the two-shape branch — `.page-head-stacked`
     and `.page-head-main` existed only to make room for the field.

     MUTATION: re-introduce the stacked variant, i.e. make renderShowIndexPage
     emit `<div class="page-head page-head-stacked">` again. The exact-open-tag
     assertion fails, and so does the styles.css one — a class no rule matches
     is dead markup. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  const head = elementHtml(m.view(), '<div class="page-head');
  assert.ok(head.startsWith('<div class="page-head">'),
    `one header shape for every page, got: ${head.slice(0, 80)}`);
  assert.ok(head.includes('class="back"'), "the ‹ button stays");
  assert.ok(head.includes("<h2>Shows</h2>"), "and the title stays");
  assert.ok(!head.includes("page-head-main"), "the stacked inner row is gone with the modifier");
  assert.ok(!STYLES.includes(".page-head-stacked {"),
    "the dead layout rule must be gone from styles.css, not left orphaned");
});

test("the category page, which shares the template, still has no search field of any kind", () => {
  /* The template is shared, and the search field has now been in two
     different places in one day without ever belonging on this page.
     MUTATION: move the `#sh-compose` block out of renderAllShows's `above`
     argument and into renderShowIndexPage's own template, where it would
     apply to every caller. This fails. RUN: failed as named. */
  const m = mount();
  m.ctx.renderCategory("science");
  const html = m.view();
  const head = elementHtml(html, '<div class="page-head');
  assert.ok(head.startsWith('<div class="page-head">'), `got: ${head.slice(0, 80)}`);
  assert.ok(!html.includes("sh-form"), "no search field on the category page");
  assert.ok(!html.includes("sh-compose"), "and no compose bar either");
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
