/* The collapsing page header reappears on scroll-up, not only at the top.
 *
 * Wyatt, live bug report, 2026-09-05: "collapsed header never reappears on
 * scroll-up." `.page-head` collapses out of view while scrolling DOWN
 * (`position: sticky` leaving the viewport under `.page-head-hidden`'s
 * translateY, styles.css) — that half was already fine and Wyatt says it
 * "feels nice." The missing half: nothing brought it back except scrolling
 * the whole list back to literal position 0, which on a show with hundreds
 * of episodes is a real dead end.
 *
 * app.js's onWindowScroll() fixes this: any UPWARD movement re-shows the
 * header immediately, at any scroll position, not only at the top; a small
 * downward dead zone (SCROLL_HIDE_DELTA) absorbs jitter/rubber-band bounce
 * so ordinary reading doesn't flicker the bar.
 *
 * WHAT THIS PROVES
 *  1. scrolling down past the dead zone hides the header
 *  2. reversing direction ANYWHERE mid-list re-shows it immediately — the
 *     bug's exact repro, not just the scroll-position-zero case CSS gives
 *     for free
 *  3. small jitter under the dead zone does not toggle anything
 *  4. near the very top of the page the header always shows, even while
 *     technically still "scrolling down" by a few px
 *  5. a fresh page render resets the header to visible with a clean
 *     baseline, so a page a user hasn't scrolled on yet never opens
 *     pre-collapsed from the previous page's scroll position
 *  6. a page with no `.page-head` at all (home) is inert — no error, no
 *     class ever toggled
 *
 * Harness: same node:vm DOM stub as test/back-navigation.test.js, extended
 * with a `.page-head` DOM stub and real `window.scrollY`/`classList.toggle`
 * tracking (only the pieces onWindowScroll and setPageHeadHidden touch).
 *
 * Every test names the one-line mutation that kills it (CLAUDE.md, "a green
 * test is not evidence until you have broken it").
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
  const classes = new Set();
  return {
    tagName: String(tag).toUpperCase(), id: "", className: "", innerHTML: "", textContent: "",
    value: "", hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    offsetHeight: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle(c, force) {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

function mount({ withPageHead = true, headHeight = 60 } = {}) {
  const view = makeEl("div");
  view.id = "view";
  const pageHead = withPageHead ? makeEl("div") : null;
  if (pageHead) pageHead.offsetHeight = headHeight;
  const byId = new Map([["view", view]]);
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
        if (s === "#view .page-head") return pageHead;
        return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/show/abc", search: "", pathname: "/", href: "https://x.test/" },
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
  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, pageHead,
    scrollTo(y) { ctx.scrollY = y; evalIn("onWindowScroll()"); },
    isHidden: () => !!(pageHead && pageHead.classList.contains("page-head-hidden")),
    reset: () => evalIn("resetPageHeadScrollState()"),
  };
}

/* ==================================================================== */
/* 1. SCROLLING DOWN PAST THE DEAD ZONE HIDES THE HEADER                 */
/* ==================================================================== */

test("scrolling down past the dead zone hides the header", () => {
  /* MUTATION: change `delta > SCROLL_HIDE_DELTA` to `delta > 0`. This test
     still passes (it scrolls well past any small dead zone) — see the next
     test for the one that actually pins the dead zone's existence. */
  const m = mount();
  m.scrollTo(0);
  assert.strictEqual(m.isHidden(), false);
  m.scrollTo(500); // well past the header's own height and the hide dead zone
  assert.strictEqual(m.isHidden(), true);
});

/* ==================================================================== */
/* 2. REVERSING DIRECTION MID-LIST RE-SHOWS IT IMMEDIATELY — THE BUG     */
/* ==================================================================== */

test("scrolling back up even slightly, mid-list, reappears the header immediately — not only at the top", () => {
  /* This is the exact reported bug: before this fix there was no scroll-up
     handling at all, so the header stayed hidden until scrollY returned to
     (near) 0. MUTATION: delete the `delta < 0` branch entirely. The final
     assertion fails — isHidden() stays true after scrolling up. */
  const m = mount();
  m.scrollTo(0);
  m.scrollTo(2000); // deep in a long episode list
  assert.strictEqual(m.isHidden(), true, "fixture assumption: scrolling down first hides it");
  m.scrollTo(1990); // scrolled UP by only 10px, nowhere near the top
  assert.strictEqual(m.isHidden(), false, "any upward movement must reappear the header immediately");
});

/* ==================================================================== */
/* 3. SMALL JITTER UNDER THE DEAD ZONE DOES NOT TOGGLE ANYTHING          */
/* ==================================================================== */

test("small downward jitter under the hide dead zone does not collapse the header", () => {
  /* Rubber-band bounce / sub-pixel jitter must not flicker the bar.
     MUTATION: change `delta > SCROLL_HIDE_DELTA` to `delta > 0`. This test
     fails — a 3px nudge would hide the header. */
  const m = mount();
  m.scrollTo(500); // establish a resting position, well past the header height
  m.reset();       // back to a known "visible" baseline at this scroll position
  assert.strictEqual(m.isHidden(), false);
  m.scrollTo(503); // 3px of downward jitter, under SCROLL_HIDE_DELTA (10)
  assert.strictEqual(m.isHidden(), false, "jitter under the dead zone must not hide the header");
});

/* ==================================================================== */
/* 4. NEAR THE VERY TOP, THE HEADER ALWAYS SHOWS                         */
/* ==================================================================== */

test("near the very top of the page the header always shows, even while moving down", () => {
  /* MUTATION: delete the `y <= head.offsetHeight` early-return branch. This
     fails — moving from 0 to 40 (both within a 60px-tall header) would
     otherwise be read as ordinary downward movement once summed with a
     later scroll and could hide the header before the user has scrolled
     past their own header's height. */
  const m = mount({ headHeight: 60 });
  m.scrollTo(0);
  m.scrollTo(40); // still within the header's own height
  assert.strictEqual(m.isHidden(), false, "must not hide while still within the header's own height from the top");
});

/* ==================================================================== */
/* 5. A FRESH PAGE RENDER RESETS TO VISIBLE WITH A CLEAN BASELINE        */
/* ==================================================================== */

test("a fresh page render resets the header to visible, so a new page never opens pre-collapsed", () => {
  /* MUTATION: make resetPageHeadScrollState() a no-op. The final assertion
     fails: the new page (a fresh renderShow, for instance) would inherit
     the PREVIOUS page's hidden state and stay collapsed the moment
     onWindowScroll first runs at whatever scrollY the browser happens to
     restore. */
  const m = mount();
  m.scrollTo(2000); // hides the header on "page 1"
  assert.strictEqual(m.isHidden(), true);
  m.reset(); // simulates renderCurrentPage()'s call on every new render
  assert.strictEqual(m.isHidden(), false, "reset must force the header visible again");
  // and the scroll baseline is clean too: a small downward move from here
  // must not immediately re-hide it as if it were a continuation
  m.ctx.scrollY = 2000; // browser kept the same scroll position across the render
  m.evalIn("onWindowScroll()");
  assert.strictEqual(m.isHidden(), false, "no spurious hide from a stale scroll delta right after reset");
});

/* ==================================================================== */
/* 6. A PAGE WITH NO .page-head IS INERT                                 */
/* ==================================================================== */

test("a page with no .page-head (e.g. home) is inert — no error, nothing toggled", () => {
  /* MUTATION: remove the `if (!head) { ...; return; }` guard from
     onWindowScroll. This throws (head.offsetHeight on null) instead of
     completing quietly. */
  const m = mount({ withPageHead: false });
  assert.doesNotThrow(() => { m.scrollTo(0); m.scrollTo(500); m.scrollTo(0); });
});

/* ==================================================================== */
/* 7. WHAT STICKS BENEATH A SHOWING HEADER IS NOT COVERED BY IT          */
/* ==================================================================== */

/* Audit 2026-09-22: the Foray page's `.fy-transport` and `.page-head` both
   stuck at the topbar's offset, so the header's reappear-on-scroll-up (this
   file's whole subject) slid ON TOP of the transport — the resume line and
   the top of the strip vanished under it the moment the listener scrolled
   back up to use them. The header now publishes its measured height on its
   page, and styles.css pins a showing header's later siblings beneath it. */

function withPage(m) {
  const props = new Map();
  m.pageHead.parentElement = { style: { setProperty: (k, v) => props.set(k, v) } };
  return props;
}

test("a header that reappears publishes its own height for the transport beneath it", () => {
  /* MUTATION: delete `publishPageHeadHeight(head);` from setPageHeadHidden()
     AND resetPageHeadScrollState(). Both assertions fail (nothing written). */
  const m = mount({ headHeight: 73 });
  const props = withPage(m);
  m.reset();
  assert.strictEqual(props.get("--page-head-h"), "73px", "a fresh render must publish the header's height");
  props.clear();
  m.scrollTo(2000);            // hide
  m.scrollTo(1900);            // reappear, mid-list
  assert.strictEqual(m.isHidden(), false);
  assert.strictEqual(props.get("--page-head-h"), "73px",
    "the reappearing header must (re)publish its height — the title can rewrap after a rotation");
});

test("REVIEW: the page just rendered publishes its header's height, in the order the app really runs", () => {
  /* The reset runs BEFORE #view is replaced, so it measured the outgoing page
     (here: none) and the new Foray page had no --page-head-h until its header
     first hid; a slow scroll slid the transport under the showing header.
     The old test mounted the head before reset(), an order the app never uses.
     MUTATION: drop `publishRenderedPageHead()` from renderCurrentPage — the
     first assertion fails; from pageDidPaint — the second does. */
  const m = mount({ headHeight: 88 });
  const props = withPage(m);
  const realQuery = m.ctx.document.querySelector;
  let mounted = false;
  m.ctx.document.querySelector = (sel) => (String(sel) === "#view .page-head" && !mounted ? null : realQuery(sel));
  m.evalIn("state.ready = true");
  m.ctx.location.hash = "#/create";
  m.ctx.renderTabBar = () => {};
  m.ctx.renderCreate = () => { mounted = true; };   // the new page, with its header, lands in #view
  m.evalIn("renderCurrentPage()");
  assert.strictEqual(props.get("--page-head-h"), "88px", "the synchronous render publishes the NEW page's header");

  props.clear();
  mounted = false;
  m.reset();                                         // an async page's first ("Loading…") render
  mounted = true;                                    // ...and its real header, a tick later
  m.evalIn("pageDidPaint()");
  assert.strictEqual(props.get("--page-head-h"), "88px", "an async page's terminal paint publishes it too");
});

test("styles.css pins the Foray transport beneath a SHOWING header, and at the topbar beneath a hidden one", () => {
  /* MUTATION: delete the `.page-head:not(.page-head-hidden) ~ .fy-transport`
     rule. This fails: the transport's only `top` is the header's own. */
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  const rule = /\.page-head:not\(\.page-head-hidden\)\s*~\s*\.fy-transport\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "no rule offsets .fy-transport while the page header is showing");
  assert.match(rule[1], /top:\s*calc\([^;]*var\(--page-head-h/,
    "the showing-header offset must add the published --page-head-h to the topbar offset");
  const base = /(^|\})\s*\.fy-transport\s*\{([^}]*)\}/.exec(css);
  assert.ok(base && !/--page-head-h/.test(base[2]),
    "the base .fy-transport rule must NOT reserve the header — a hidden header reserves nothing");
});
