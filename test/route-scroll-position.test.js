/* A new page starts at the top; going back returns you to where you were.
 *
 * Wyatt, live bug report, 2026-09-13: "Clicking on a show jumps to a random
 * point on the show page (I think it is retaining the screen position from
 * the previous page), it should start at the top".
 *
 * His diagnosis is right and the number is not random. Routing is hash-only,
 * a hash change is a same-document navigation, and nothing moves the viewport
 * for one — so the new page opens at the OLD page's offset, clamped to the new
 * document's height. Measured in Chrome against `main` before this change:
 * scrolled to 1500 on `#/shows`, tapping a show landed the show page at 457,
 * which is exactly that clamp.
 *
 * THE HALF THAT IS EASY TO GET WRONG, and which this suite exists for as much
 * as the reported bug: a back-step must NOT go to the top. Browsing four taps
 * deep into a list and tapping ‹ has to put the listener back in the list
 * where they left it. The browser does attempt this on its own, but it applies
 * the restore against whatever is on screen at that instant — before our
 * re-render — so it clamps to the outgoing page's height and is then
 * overwritten anyway. Measured: with a plain `scrollTo(0, 0)` on the forward
 * path and no restore of our own, that same back-step ended at 457 instead of
 * 4000. So the position is kept here and applied AFTER the render, and the
 * browser's own attempt is turned off (`history.scrollRestoration = "manual"`)
 * rather than left to race ours.
 *
 * HARNESS: the same node:vm DOM stub test/collapsing-header-scroll.test.js
 * uses, extended with a recording `window.scrollTo` and with
 * `renderCurrentPage`/`openDrawer` stubbed out — this suite is about the
 * router's viewport decisions, and rendering a real page under the stub would
 * only add a hundred ways to fail for reasons that are not this.
 *
 * Every test names the one-line mutation that turns it red.
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

/* A browser history — the same fake test/back-navigation.test.js uses, and for
   the same reason (2026-09-22): the router reads the kind of step from the
   entry's own `history.state`, so "going back" has to be a real traversal to an
   entry the router stamped, not "set the hash to the one two steps ago", which
   is also what a forward tap onto that page looks like. */
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
    arrive(hash) { entries[at].hash = hash; ctx.location.hash = hash; },
  };
}

function mount({ startHash = "#/" } = {}) {
  const view = makeEl("div");
  view.id = "view";
  const pageHead = makeEl("div");
  pageHead.offsetHeight = 60;
  const byId = new Map([["view", view]]);
  const body = makeEl("body");
  /* Every call the router makes that moves or reads the viewport, recorded in
     order — the ORDER is load-bearing: a restore applied before the render is
     clamped by the outgoing page's height, which is the bug being fixed. */
  const calls = [];
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
    location: { hash: startHash, search: "", pathname: "/", href: "https://x.test/" },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    scrollY: 0,
  };
  /* `maxScroll` is the document's scrollable height: a real `scrollTo` clamps to
     it, and an async page that has only painted "Loading…" is one screen tall.
     Unbounded by default, which is every page these tests do not shorten. */
  ctx.maxScroll = Infinity;
  ctx.scrollTo = (x, y) => { const to = Math.min(y, ctx.maxScroll); calls.push(["scrollTo", to]); ctx.scrollY = to; };
  const nav = fakeHistory(ctx);
  ctx.history = nav.history;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  /* The router's two collaborators, replaced by recorders. Function
     declarations in a vm script are writable global bindings, so this is a
     plain assignment and not a source edit. */
  ctx.renderCurrentPage = () => { calls.push(["render", ctx.location.hash]); };
  ctx.openDrawer = () => {};
  evalIn("state.ready = true;");
  const leave = (scrolledTo) => {
    if (scrolledTo !== null) {
      ctx.scrollY = scrolledTo;
      evalIn("rememberScrollPosition()");   // the throttled scroll tick
    }
    calls.length = 0;
  };
  let routed = false;
  return {
    ctx, evalIn, calls,
    /* One FORWARD navigation (a link or a tab): the listener is at
       `scrolledTo` on the current page, a new entry is pushed, and the router
       runs exactly as `hashchange` would. The first call is the arrival. */
    go(hash, { scrolledTo = null } = {}) {
      leave(scrolledTo);
      if (routed) nav.link(hash); else nav.arrive(hash);
      routed = true;
      evalIn("route()");
      return ctx.scrollY;
    },
    /* One BACK step: the back button, or a device back gesture — the browser
       returns to the previous entry, then the hashchange lands. */
    back({ scrolledTo = null } = {}) {
      leave(scrolledTo);
      nav.history.back();
      evalIn("route()");
      return ctx.scrollY;
    },
  };
}

/* ==================================================================== */
/* 1. THE REPORTED BUG                                                   */
/* ==================================================================== */

test("a forward navigation opens the new page at the top, not at the previous page's offset", () => {
  /* The founder's exact three taps: a long list, scrolled a long way down,
     then a show.
     MUTATION: delete the `scrollPageTo(0)` call from route(). This fails —
     scrollY stays at 4000, which is the shipped bug. */
  const m = mount({ startHash: "#/" });
  m.go("#/shows");
  const landed = m.go("#/show/business-wars", { scrolledTo: 4000 });
  assert.strictEqual(landed, 0, "a show opened from a scrolled list must start at the top");
});

test("it is every route, not just show pages", () => {
  /* The report named shows; nothing about the defect was show-specific.
     MUTATION: gate the scroll on `h.startsWith("#/show/")`. This fails on the
     second and third assertions. */
  const m = mount({ startHash: "#/" });
  for (const hash of ["#/shows", "#/episode/abc", "#/playlist/p1", "#/library"]) {
    const landed = m.go(hash, { scrolledTo: 2500 });
    assert.strictEqual(landed, 0, `${hash} must open at the top`);
  }
});

test("the scroll happens BEFORE the render, so the new page lays out where it will sit", () => {
  /* Painting a page and then yanking the viewport is a visible flash on a
     phone. MUTATION: move `scrollPageTo(0)` below `renderCurrentPage()`. This
     fails on the ordering assertion. */
  const m = mount({ startHash: "#/" });
  m.go("#/shows");
  m.go("#/show/x", { scrolledTo: 900 });
  const scrollAt = m.calls.findIndex((c) => c[0] === "scrollTo");
  const renderAt = m.calls.findIndex((c) => c[0] === "render");
  assert.ok(scrollAt >= 0 && renderAt >= 0, "both a scroll and a render must happen");
  assert.ok(scrollAt < renderAt, "the viewport must be moved before the page is rendered");
});

/* ==================================================================== */
/* 2. THE EXCEPTION: GOING BACK RETURNS YOU TO THE LIST                  */
/* ==================================================================== */

test("a back-step restores the position the list was left at, not the top", () => {
  /* Browse into a list, open something, tap ‹. This is the behaviour a
     blanket scroll-to-top would destroy.
     MUTATION: change `step === "back"` to `false` in route(). This fails —
     the list reopens at the top and a deep browse is unusable. */
  const m = mount({ startHash: "#/" });
  m.go("#/shows");
  m.go("#/show/business-wars", { scrolledTo: 4000 });   // leaves #/shows at 4000
  const back = m.back({ scrolledTo: 120 });             // ‹ from the show page
  assert.strictEqual(back, 4000, "the list must reopen where the listener left it");
});

test("the restore lands AFTER the render, or it is clamped by the outgoing page", () => {
  /* This is the measured failure mode, not a hypothetical: a restore applied
     while the short show page is still on screen gets clamped to that page's
     maximum scroll. MUTATION: move the `if (target > 0) scrollPageTo(target)`
     line above `renderCurrentPage()`. This fails. */
  const m = mount({ startHash: "#/" });
  m.go("#/shows");
  m.go("#/show/x", { scrolledTo: 4000 });
  m.back({ scrolledTo: 100 });
  const renderAt = m.calls.findIndex((c) => c[0] === "render");
  const restoreAt = m.calls.findIndex((c, i) => c[0] === "scrollTo" && c[1] === 4000);
  assert.ok(restoreAt >= 0, "the remembered position must actually be written");
  assert.ok(restoreAt > renderAt, "the restore must come after the page has rendered");
});

test("a back-step to a page that was never scrolled lands at the top", () => {
  /* No memory is not a reason to guess. MUTATION: change the fallback
     `navScrollY.get(h) || 0` to `navScrollY.get(h) || 500`. This fails. */
  const m = mount({ startHash: "#/" });
  m.go("#/shows");                                  // never scrolled
  m.go("#/show/x", { scrolledTo: 0 });
  assert.strictEqual(m.back(), 0);
});

test("the memory is per page — scrolling one page does not move another page's restore point", () => {
  /* The obvious simpler implementation is one remembered number rather than
     one per route, and it is wrong in exactly this way.
     MUTATION: replace `const navScrollY = new Map()` with a single shared
     value (`{ set(k, v) { this._v = v; }, get() { return this._v; } }`). This
     fails — the show page's own 300 comes back as the list's restore point. */
  const m = mount({ startHash: "#/" });
  m.go("#/shows");
  m.go("#/show/x", { scrolledTo: 4000 });
  m.ctx.scrollY = 300;
  m.evalIn("rememberScrollPosition()");             // scrolling the SHOW page
  assert.strictEqual(m.back(), 4000, "the list's own position must survive");
});

test("nothing is remembered before the first page has been routed", () => {
  /* MUTATION: drop the `renderedHash === null` guard from
     rememberScrollPosition(). This throws or files a position under `null`,
     and the guard is what makes a scroll event arriving during boot harmless. */
  const m = mount({ startHash: "#/" });
  m.ctx.scrollY = 700;
  assert.doesNotThrow(() => m.evalIn("rememberScrollPosition()"));
  assert.strictEqual(m.evalIn("navScrollY.size"), 0);
});

/* ==================================================================== */
/* 3. THE STEP CLASSIFIER THE WHOLE THING RESTS ON                       */
/* ==================================================================== */

test("noteNavigation reads the step from the history entry: forward, back, same", () => {
  /* The classifier both consumers rest on: route()'s restore and the ‹
     button's `canGoBackInApp()`. MUTATION: return "forward" unconditionally.
     The back assertions fail here AND the restore tests above fail, which is
     the point of checking both — one function, two consumers. */
  const m = mount({ startHash: "#/" });
  m.go("#/");
  assert.strictEqual(m.evalIn('noteNavigation("#/")'), "same", "a re-render of the entry on screen");
  m.go("#/shows");
  assert.strictEqual(m.evalIn("canGoBackInApp()"), true);
  m.ctx.history.back();
  assert.strictEqual(m.evalIn('noteNavigation("#/")'), "back");
  assert.strictEqual(m.evalIn("canGoBackInApp()"), false);
});

test("a forward tap onto the page two steps back starts at the TOP", () => {
  /* Audit 2026-09-22, qa 130: scroll deep into #/shows, open a show, tap the
     Search tab. The stack-shape rule read that as a back-step and dropped the
     listener mid-list. MUTATION: restore the stack-shape inference in
     noteNavigation (a new entry whose hash equals the one two back is "back"). */
  const m = mount({ startHash: "#/" });
  m.go("#/shows");
  m.go("#/show/x", { scrolledTo: 4000 });
  assert.strictEqual(m.go("#/shows", { scrolledTo: 300 }), 0, "a tab tap is a forward navigation");
});

/* ==================================================================== */
/* 3b. AN ASYNC PAGE'S RESTORE LANDS WHEN THE PAGE HAS PAINTED            */
/* ==================================================================== */

test("a back-step to an async page is restored at its terminal paint, not clamped to the loading paint", () => {
  /* Audit 2026-09-22, qa 115. A Foray page and an uncached show page paint
     "Loading…" first; route()'s restore was clamped to that one-screen page
     and lost. MUTATION: drop the `pendingRestore = …` line from route() — the
     pageDidPaint() below has nothing to re-apply and the listener stays at the
     clamped offset. */
  const m = mount({ startHash: "#/" });
  m.go("#/foray/f1");
  m.go("#/episode/e1", { scrolledTo: 3000 });   // left the Foray page at 3000
  m.ctx.maxScroll = 200;                          // the Foray page is "Loading…" again
  assert.strictEqual(m.back(), 200, "the loading paint clamps the first attempt");
  m.ctx.maxScroll = Infinity;                     // the real page is up
  m.evalIn("pageDidPaint()");
  assert.strictEqual(m.ctx.scrollY, 3000, "the restore lands once the page has its height");
});

test("the clamped position is not filed as the page's memory while the restore is owed", () => {
  /* The second half of qa 115: the throttled scroll tick after the clamp
     recorded the clamped offset, so even the SECOND ‹ was broken. MUTATION:
     drop `|| pendingRestore` from rememberScrollPosition's guard. */
  const m = mount({ startHash: "#/" });
  m.go("#/foray/f1");
  m.go("#/episode/e1", { scrolledTo: 3000 });
  m.ctx.maxScroll = 200;
  m.back();
  m.evalIn("rememberScrollPosition()");           // a scroll tick lands before the paint
  assert.strictEqual(m.evalIn('navScrollY.get("#/foray/f1")'), 3000);
});

/* ==================================================================== */
/* 4. THE COLLAPSING HEADER IS RE-BASELINED, NOT LEFT LYING              */
/* ==================================================================== */

test("a restored page does not open with its header collapsed by a stale scroll delta", () => {
  /* Landing at 4000 on a restored list would read as a 4000px downward scroll
     on the next scroll event and hide the ‹ header the listener never
     scrolled. MUTATION: delete the `resetPageHeadScrollState()` call from
     scrollPageTo(). This fails. */
  const m = mount({ startHash: "#/" });
  m.go("#/shows");
  m.go("#/show/x", { scrolledTo: 4000 });
  m.back({ scrolledTo: 100 });
  /* A one-pixel nudge from the restored position: with a clean baseline this
     is jitter under the dead zone and nothing happens; with a stale baseline
     of 0 it is a 4001px scroll and the header collapses. */
  m.ctx.scrollY = 4001;
  m.evalIn("onWindowScroll()");
  assert.strictEqual(
    m.evalIn("pageHeadHiddenNow"), false,
    "the header must not collapse from a delta the listener never produced"
  );
});

/* ==================================================================== */
/* 5. THE BROWSER IS TOLD TO STOP COMPETING                              */
/* ==================================================================== */

test("app.js switches history.scrollRestoration to manual", () => {
  /* Asserted against the source rather than by running init() (which awaits
     eight fetches): what matters is that the line exists and is guarded, and
     a source assertion is honest about being a source assertion. MUTATION:
     delete the line — this fails, and the browser's own clamped restore lands
     after ours and overwrites it, which is the 457-instead-of-4000 measured
     above. */
  const code = APP_SRC.replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.match(
    code,
    /if \("scrollRestoration" in history\) history\.scrollRestoration = "manual";/,
    "the router owns the viewport, so the browser's own restoration must be turned off"
  );
});
