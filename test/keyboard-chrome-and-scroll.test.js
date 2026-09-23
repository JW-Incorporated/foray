/* The chrome that has to get out of the soft keyboard's way, and the runtime
 * state that says so — three founder reports from 2026-09-14, all on the
 * search page, on build 2026091419.
 *
 *   1. "When the search bar is up, this home ribbon should go away."
 *      (the four-tab bar, screenshotted wedged between the search pill and
 *      the keyboard, which is exactly where Apple Podcasts shows nothing)
 *   2. "When I scroll, the search text box moves a bunch and tries to stay
 *      above the keyboard but seems to need to update every time the page
 *      moves."
 *   3. "When I scroll, the keyboard should naturally collapse."
 *
 * WHY ONE SUITE. All three are the same question asked three ways — what does
 * the bottom edge of the screen do while a keyboard is up — and all three are
 * answered by state that has to survive things it did not previously survive.
 * Splitting them would put `setBodyClass`'s allowlist in a file about the tab
 * bar, or the scroll dismissal in a file about the collapsing header, and in
 * both cases the reader would lose the reason the code looks the way it does.
 * The neighbouring files keep their own subjects: test/search-field-bottom.js
 * owns where the pill sits, test/now-playing-keyboard.test.js owns the
 * keyboard DETECTOR, test/collapsing-header-scroll.test.js owns the header.
 *
 * WHAT THIS PROVES, in order:
 *  1. setBodyClass preserves the runtime classes and still discards the
 *     page-scoped ones — the wholesale `body.className =` write that dropped
 *     `kb-open` on every render while `--kb-inset`, which lives on <html>,
 *     survived. That split is report 2's structural half and it also repairs
 *     two bugs the founder has not reported yet (a now-playing bar that loses
 *     its bottom reservation after navigating, and a pill that docks a tab
 *     bar plus a mini bar too low).
 *  2. The per-frame half of report 2, AS A COUNT: N visualViewport scroll
 *     events inside one frame produce ONE evaluation, where they used to
 *     produce N; and an evaluation that reaches the same inset writes no CSS
 *     variable at all. Resize stays unthrottled, deliberately.
 *  3. The tab bar leaves on focus and comes back on blur, through the one
 *     predicate that already decides the rest of the page's search chrome,
 *     and `styles.css` is what actually hides it (a `hidden` attribute cannot
 *     — see renderTabBar's own header on that cascade trap).
 *  4. A deliberate downward scroll blurs the field; the keyboard's own
 *     arrival does not, because of the settle window; scrolling up never
 *     does; and the rule does not depend on the page having a `.page-head`.
 *
 * WHAT IS DEVICE-ONLY, and is NOT claimed here. Every one of the three has a
 * component only an iPhone can answer, and this file asserts the mechanism
 * rather than the feel:
 *   - that one evaluation per animation frame is enough to make the pill look
 *     welded to the keyboard under iOS momentum scrolling and rubber-banding.
 *     The count is proven; the smoothness is not.
 *   - that 350ms covers the iOS keyboard animation on a cold first open of a
 *     session. Apple's own animation is ~250ms, but the first open also
 *     builds the keyboard. The guard's EXISTENCE and its two directions are
 *     proven; the constant is a measurement nobody has taken off a phone.
 *   - that the tab bar leaving does not cause a visible reflow of the list
 *     behind it. The arithmetic is pinned (in search-field-bottom.test.js);
 *     the repaint is not.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md, "a
 * green test is not evidence until you have broken it"). Every one was run
 * red before being run green.
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
const STYLES = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

process.on("unhandledRejection", () => {});

/* A classList that actually holds classes, backed by the element's own
   `className` string — because the whole subject of section 1 is a
   `className =` assignment racing `classList` writes, and a no-op stub (what
   the neighbouring suites use, correctly, for their own subjects) would make
   every assertion in it vacuously true. */
function makeClassList(el) {
  const set = () => new Set(String(el.className || "").split(/\s+/).filter(Boolean));
  const write = (s) => { el.className = [...s].join(" "); };
  return {
    add(c) { const s = set(); s.add(c); write(s); },
    remove(c) { const s = set(); s.delete(c); write(s); },
    contains(c) { return set().has(c); },
    toggle(c, on) { const s = set(); if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); write(s); },
  };
}

function makeEl(tag) {
  const listeners = new Map();
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    offsetHeight: 0, blurCount: 0,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type, evt = {}) {
      const fns = listeners.get(type) || [];
      for (const fn of fns) fn({ type, preventDefault() {}, target: el, ...evt });
      return fns.length;
    },
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() { el.dispatch("focus"); }, select() {}, click() {},
    /* Counted, because "a scroll blurs the field" is the assertion and a blur
       that fires zero times looks identical to one that fires once if you
       only inspect the resulting state. */
    blur() { el.blurCount += 1; el.dispatch("blur"); },
    remove() {},
  };
  el.classList = makeClassList(el);
  return el;
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "menu-btn", "refresh-btn", "banner-slot",
  "sh-form", "sh-input", "sh-note", "sh-results", "sh-browse", "sh-dismiss",
  "ep-search-results", "pl-search-results", "tab-bar",
];

function mount() {
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const showIndex = makeEl("div");
  const body = makeEl("body");
  const root = makeEl("html");
  /* Every setProperty the run makes, in order — the measurement instrument
     for section 2. `--kb-inset` writes are the thing being counted. */
  const varWrites = [];
  root.style = {
    setProperty(name, value) { varWrites.push({ name, value }); this[name] = value; },
  };

  /* A hand-cranked animation frame: callbacks queue here and run only when
     the test says a frame happened. A real rAF (setTimeout) would make "how
     many evaluations happened inside ONE frame" untestable, which is the
     exact quantity report 2 is about. */
  const frameQueue = [];
  const runFrame = () => { const q = frameQueue.splice(0); for (const fn of q) fn(); };

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body, documentElement: root, readyState: "complete",
      addEventListener() {}, removeEventListener() {}, createElement: (t) => makeEl(t),
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
    requestAnimationFrame: (fn) => { frameQueue.push(fn); return frameQueue.length; },
    encodeURIComponent, decodeURIComponent,
    scrollY: 0,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const m = {
    ctx, byId, body, root, varWrites, runFrame,
    state: vm.runInContext("state", ctx),
    read: (expr) => vm.runInContext(expr, ctx),
    input: byId.get("sh-input"),
    tabBarHidden: () => body.classList.contains("sh-searching"),
    scrollTo: (y) => { ctx.scrollY = y; ctx.onWindowScroll(); },
  };
  m.state.catalog = {
    shows: [
      { show_id: "a", title: "A Show", taxonomy_node_ids: [] },
      { show_id: "b", title: "B Show", taxonomy_node_ids: [] },
    ],
  };
  m.state.taxonomy = { nodes: [{ id: "science", label: "Science", parent: null }] };
  m.state.discover = { items: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  return m;
}

/* One evaluation of app.js for the whole file, only so its top-level
   declarations (setBodyClass, renderAllShows, onWindowScroll,
   installKeyboardChrome) are reachable. Section 2 hands installKeyboardChrome
   its OWN fake window, so this context's lack of a `visualViewport` means the
   install that init() performs here is a no-op and cannot interfere — the
   same arrangement test/now-playing-keyboard.test.js uses and documents. */
const APP = mount().ctx;

/* A window whose viewport we can move and whose frames we can crank — the
   fake of test/now-playing-keyboard.test.js, plus a <html> that records
   setProperty and a requestAnimationFrame the test drives by hand. */
function fakeWindow({ innerHeight = 800, vvHeight = 800, activeElement = { tagName: "INPUT" } } = {}) {
  const listeners = [];
  const classes = new Set();
  const varWrites = [];
  const frameQueue = [];
  const body = {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
  };
  const documentElement = {
    style: { setProperty(name, value) { varWrites.push({ name, value }); this[name] = value; } },
  };
  const mk = (name) => ({
    addEventListener: (type, fn, opts) => { listeners.push({ target: name, type, fn, opts }); },
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.target === name && l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  });
  const doc = { body, documentElement, activeElement, ...mk("document") };
  const vv = { height: vvHeight, offsetTop: 0, ...mk("vv") };
  const win = {
    innerHeight, document: doc, visualViewport: vv,
    requestAnimationFrame: (fn) => { frameQueue.push(fn); return frameQueue.length; },
  };
  return {
    win, doc, vv, varWrites,
    has: (c) => classes.has(c),
    fire: (target, type) => { for (const l of listeners.slice()) if (l.target === target && l.type === type) l.fn({}); },
    runFrame: () => { const q = frameQueue.splice(0); for (const fn of q) fn(); },
    insetWrites: () => varWrites.filter((w) => w.name === "--kb-inset"),
  };
}

/* ==================================================================== */
/* 1. THE CLASSES THAT MUST OUTLIVE A RENDER                             */
/* ==================================================================== */

test("setBodyClass preserves every runtime class instead of clobbering it", () => {
  /* THE STRUCTURAL HALF OF REPORT 2, and the direct cause of two bugs the
     founder has not reported yet. `kb-open` is written to <body> and
     `--kb-inset` to <html> from one evaluation, and installKeyboardChrome's
     own comment claimed "the two can never disagree" — they could, because
     only one of the two lived on the element this function overwrote.

     MUTATION: restore `document.body.className = `${base} ui-v2``. Every
     class below is lost, and on a phone the search pill composes a
     keyboard-open inset with the keyboard-SHUT dock. RUN: failed as named. */
  /* `fy-sheet-open` is not in this list any more (audit 2026-09-22): it is
     derived from the sheets the owner holds, not carried because it was there
     — test/modal-and-focus.test.js ("the modal lock is derived from what is
     open: kept across a render, dropped when the sheet's DOM is gone") pins
     both halves of that. */
  const m = mount();
  for (const c of ["kb-open", "fp-open", "fp-expanded"]) {
    m.body.classList.add(c);
  }
  m.ctx.setBodyClass("view-page");

  for (const c of ["kb-open", "fp-open", "fp-expanded"]) {
    assert.ok(m.body.classList.contains(c), `\`${c}\` describes something still true after the page changed — it must survive`);
  }
  assert.ok(m.body.classList.contains("ui-v2"), "ui-v2 is what styles.css hangs the v2 sheet on");
  assert.ok(m.body.classList.contains("view-page"), "the base class must still be applied");
});

test("setBodyClass still discards the page-scoped classes — the allowlist is not 'keep everything'", () => {
  /* The opposite failure, and the reason this is an allowlist rather than a
     merge. `sh-compose` reserves room at the bottom of the SEARCH page for a
     bar that exists only there, and being wiped on navigation is precisely
     how it is cleaned up (renderAllShows re-adds it after its own render for
     exactly that reason). A "preserve what's there" fix would leave that
     reservation on every screen in the app.

     MUTATION: change setBodyClass to merge all existing classes instead of
     filtering by PERSISTENT_BODY_CLASSES. This fails. RUN: failed as
     named. */
  const m = mount();
  m.body.classList.add("sh-compose");
  m.body.classList.add("sh-searching");
  m.body.classList.add("view-home");
  m.ctx.setBodyClass("view-page");

  assert.ok(!m.body.classList.contains("sh-compose"), "the search page's own content reservation must not follow the listener off the page");
  assert.ok(!m.body.classList.contains("sh-searching"), "nor may the tab bar stay hidden after navigating away mid-search");
  assert.ok(!m.body.classList.contains("view-home"), "the previous page's base class must be replaced, not accumulated");
});

test("every render function routes through setBodyClass — no direct body.className writes survive", () => {
  /* An allowlist is only as good as its coverage: one render function still
     assigning `document.body.className` directly bypasses it completely, and
     renderInterests was doing exactly that (dropping `ui-v2` itself, not
     just the runtime classes, so the Interests page rendered off the
     pre-cutover sheet).

     MUTATION: revert renderInterests to `document.body.className =
     "view-page"`. This fails. RUN: failed as named. */
  const assignments = APP_SRC.match(/document\.body\.className\s*=/g) || [];
  assert.strictEqual(assignments.length, 1,
    `only setBodyClass may assign document.body.className; found ${assignments.length} assignments`);
});

/* ==================================================================== */
/* 2. THE PER-FRAME WRITE — REPORT 2, MEASURED                           */
/* ==================================================================== */

test("many viewport scroll events inside one frame produce exactly one evaluation", () => {
  /* THE MEASUREMENT. `visualViewport` fires `scroll` at the rate the
     compositor moves the viewport — many times per frame under momentum and
     rubber-banding — and every one of them used to run a full
     measure-and-write: three layout reads feeding a setProperty that a fixed
     element's `bottom` depends on. `offsetTop` genuinely moves while the
     viewport does, so the writes were not even redundant; each one really
     repositioned the pill. That is "moves a bunch".

     BEFORE: 60 scroll events -> 60 evaluations, and (because offsetTop is
     changing) up to 60 distinct `--kb-inset` writes in one frame.
     AFTER: 60 scroll events -> 1 evaluation, 1 write.

     MUTATION: subscribe `apply` directly to vv `scroll` again instead of the
     throttled wrapper. This fails with 60 writes where 1 is expected. RUN:
     failed as named (observed 60). */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 460 });
  const teardown = APP.installKeyboardChrome(f.win);
  const before = f.insetWrites().length;

  for (let i = 0; i < 60; i++) {
    f.vv.offsetTop = i;           // the viewport really is moving, frame by frame
    f.fire("vv", "scroll");
  }
  assert.strictEqual(f.insetWrites().length, before,
    "nothing may be written before the frame runs — the events are supposed to coalesce");

  f.runFrame();
  assert.strictEqual(f.insetWrites().length, before + 1,
    `one frame of scrolling must cost exactly one write, got ${f.insetWrites().length - before}`);
  teardown();
});

test("an evaluation that reaches the same inset writes no CSS variable at all", () => {
  /* The second half of the same cost. `--kb-inset` is read by
     `#sh-compose`'s `bottom` calc, so every setProperty invalidates style and
     forces a layout of a fixed element. Doing that on a frame where the
     number did not change is pure cost — and on a settled keyboard that is
     every frame.

     MUTATION: drop the `if (px !== lastInset)` guard and always call
     setKeyboardInsetVar. This fails: the second frame writes again. RUN:
     failed as named. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 460 });
  const teardown = APP.installKeyboardChrome(f.win);
  const after = f.insetWrites().length;

  f.fire("vv", "scroll");   // same viewport, same answer
  f.runFrame();
  assert.strictEqual(f.insetWrites().length, after,
    "a re-evaluation reaching the same number must write nothing");

  f.vv.offsetTop = 40;      // now it really changed
  f.fire("vv", "scroll");
  f.runFrame();
  assert.strictEqual(f.insetWrites().length, after + 1,
    "…but a real change must still be published, or the pill detaches from the keyboard");
  teardown();
});

test("resize is NOT throttled — the keyboard opening must land before the next paint", () => {
  /* The two subscriptions want different things from the same evaluation, so
     they get different scheduling. `resize` is the keyboard actually opening
     or closing: it fires a handful of times, and it is the event `kb-open`
     has to be on for BEFORE the next paint — deferring it by a frame is how
     the mini-player gets one frame sitting on top of the keyboard, which is
     the founder report installKeyboardChrome was written for in the first
     place.

     MUTATION: route `resize` through the throttled wrapper too. This fails,
     because the class is still off until a frame is cranked. RUN: failed as
     named. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 800 });
  const teardown = APP.installKeyboardChrome(f.win);
  assert.strictEqual(f.has("kb-open"), false, "sanity: no keyboard yet");

  f.vv.height = 460;
  f.fire("vv", "resize");
  assert.strictEqual(f.has("kb-open"), true,
    "the class must be on synchronously, with no frame cranked");
  teardown();
});

/* ==================================================================== */
/* 3. THE TAB BAR YIELDS TO THE KEYBOARD — REPORT 1                      */
/* ==================================================================== */

test("focusing the search field hides the tab bar; blurring brings it back", () => {
  /* Founder: "when the search bar is up, this home ribbon should go away."
     Driven through the real listeners renderAllShows binds, not through a
     reimplementation of the rule.

     MUTATION: delete the `document.body.classList.toggle("sh-searching",
     ...)` line from updateShowBrowseVisibility. This fails. RUN: failed as
     named. */
  const m = mount();
  m.ctx.renderAllShows();
  assert.strictEqual(m.tabBarHidden(), false, "idle: the tab bar is the app's navigation and stays");

  assert.strictEqual(m.input.dispatch("focus"), 1, "sanity: the focus handler is bound");
  assert.strictEqual(m.tabBarHidden(), true, "focused: the strip belongs to the keyboard");

  m.input.dispatch("blur");
  assert.strictEqual(m.tabBarHidden(), false, "blurred: navigation comes back");
});

test("the tab bar stays while results are being read with the field blurred", () => {
  /* THE DELIBERATE NARROWING, and the reason this hangs off
     `showSearchFieldFocused` rather than off the `hide` predicate beside it.
     `hide` means "there is a search in progress" and stays true across a blur
     with a live query — the state where the listener is READING RESULTS with
     the keyboard gone. Taking the app's only navigation away there traps
     them: no way off the search page but to empty the field. Apple keeps the
     bar in that state too.

     MUTATION: toggle `sh-searching` on `hide` instead of on
     `showSearchFieldFocused` — the tempting one-liner, since `hide` is right
     there. This fails. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");
  m.input.value = "radiolab";
  m.input.dispatch("input");
  assert.strictEqual(m.tabBarHidden(), true, "sanity: hidden while typing");

  m.input.dispatch("blur");
  assert.strictEqual(m.tabBarHidden(), false,
    "reading results with the keyboard down must not cost the listener their navigation");
  assert.strictEqual(m.byId.get("sh-browse").hidden, true,
    "…while the browse furniture correctly STAYS hidden — the two rules are different questions");
});

test("the dismiss button restores the tab bar through the same one path", () => {
  /* Escape and the ✕ both run dismissShowSearch, which is what makes the two
     unable to answer differently. A tab bar restored on one and not the
     other would be a listener stuck with no navigation.

     MUTATION: make dismissShowSearch neither blur nor re-evaluate — i.e.
     delete `input.blur(); updateShowBrowseVisibility();`. This fails, and the
     listener is left with the field cleared and no navigation. RUN: failed as
     named.

     A NEGATIVE RESULT WORTH RECORDING, because the obvious mutation is NOT a
     killing one: deleting dismissShowSearch's `updateShowBrowseVisibility()`
     call ALONE leaves this test green. The blur it performs one line earlier
     fires the field's own blur listener, which re-evaluates anyway. That is
     the two-triggers-one-path design doing its job rather than a hole in the
     test — but it means this test pins the OUTCOME of dismissing, not that
     one particular line exists, and a reader should not expect otherwise. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");
  m.input.value = "radiolab";
  m.input.dispatch("input");
  assert.strictEqual(m.tabBarHidden(), true, "sanity");

  m.input.dispatch("keydown", { key: "Escape" });
  assert.strictEqual(m.tabBarHidden(), false, "Escape must put the navigation back");
  assert.strictEqual(m.input.value, "", "sanity: Escape is the full 'never mind'");
});

test("styles.css is what hides the bar — a `hidden` attribute provably cannot", () => {
  /* `.tab-bar` carries `display: flex`, and an author `display` declaration
     beats the UA stylesheet's `[hidden] { display: none }` at ANY
     specificity. That is the cascade trap renderTabBar's own header
     documents and test/home-layout.test.js's BUG 3 exists to catch, and it
     is why this is a class rule rather than the `el.hidden` idiom the rest of
     this page uses.

     MUTATION: delete `body.sh-searching .tab-bar { display: none; }` from
     styles.css. This fails — and on a phone the class would go on and the bar
     would keep rendering, with no error anywhere. RUN: failed as named. */
  assert.match(STYLES, /body\.sh-searching\s+\.tab-bar\s*\{[^}]*display:\s*none/,
    "the class must be backed by an author `display: none`, not by `hidden`");
  assert.match(STYLES, /\.tab-bar\s*\{[^}]*display:\s*flex/,
    "sanity: the bar really does carry an author display, which is what makes `hidden` useless here");
  const hideAt = STYLES.search(/body\.sh-searching\s+\.tab-bar/);
  const barAt = STYLES.search(/^\.tab-bar\s*\{/m);
  assert.ok(hideAt > barAt,
    "the hiding rule must come AFTER the bar's own rule — same-weight selectors are resolved by source order");
});

test("styles.css parses to the end — a stray comment marker silently kills the rest of it", () => {
  /* WRITTEN BECAUSE THIS CHANGE MADE THE BUG. While rewriting the dock block
     above, a paragraph of prose was added WITHOUT its opening `/*`. Every
     brace still balanced, the file still looked right, `grep` still found the
     rule, and the node suites — which read styles.css as TEXT — all stayed
     green. What actually happened in a browser: the unopened prose became a
     selector, the quoted founder report inside it opened a CSS string, and
     Chromium's parser discarded everything from that point to the end of the
     file. 164 rules survived out of roughly a thousand. `#sh-compose` had no
     styling at all, and the Playwright spec that measures the pill's position
     PASSED ANYWAY, because a pill nothing positions does not move.

     That is the whole lesson and it is why this is a test rather than a
     resolved incident: a CSS syntax error has no error. Nothing logs, nothing
     throws, the page just quietly loses half its stylesheet, and a suite that
     asserts on the file's text cannot tell.

     The check is a comment-aware scan for the three ways this file can be
     silently truncated: a comment CLOSER with no opener (what happened), an
     unterminated comment, and unbalanced braces. Comment-aware because a
     naive brace count is exactly what missed it — the stray closer was inside
     what the naive scan believed was prose.

     MUTATION: delete the `/*` from the start of any comment block in
     styles.css. This fails. RUN: failed as named — and it is the mutation
     that was live in this working tree for an hour. */
  let i = 0, line = 1, depth = 0, inComment = false;
  const strays = [];
  while (i < STYLES.length) {
    if (STYLES[i] === "\n") { line++; i++; continue; }
    if (!inComment && STYLES[i] === "/" && STYLES[i + 1] === "*") { inComment = true; i += 2; continue; }
    if (inComment) {
      if (STYLES[i] === "*" && STYLES[i + 1] === "/") { inComment = false; i += 2; continue; }
      i++; continue;
    }
    if (STYLES[i] === "*" && STYLES[i + 1] === "/") { strays.push(line); i += 2; continue; }
    if (STYLES[i] === "{") depth++;
    if (STYLES[i] === "}") depth--;
    i++;
  }
  assert.deepStrictEqual(strays, [],
    `a comment closer with no opener truncates the stylesheet from that point; line(s): ${strays.join(", ")}`);
  assert.strictEqual(inComment, false, "an unterminated comment swallows the rest of the file");
  assert.strictEqual(depth, 0, `unbalanced braces in styles.css (depth ${depth} at EOF)`);
});

/* ==================================================================== */
/* 4. SCROLLING DISMISSES THE KEYBOARD — REPORT 3                        */
/* ==================================================================== */

test("a deliberate downward scroll blurs the field", () => {
  /* Founder: "when I scroll, the keyboard should naturally collapse."
     Standard iOS list behaviour, and what Apple Podcasts does here.

     MUTATION: delete the maybeDismissKeyboardOnScroll() call from
     onWindowScroll. This fails. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");
  m.read("showSearchFocusedAt = 0");   // the keyboard has long since settled

  m.scrollTo(200);
  assert.strictEqual(m.input.blurCount, 1, "scrolling down past the dead zone must put the keyboard away");
});

test("the keyboard's own arrival does not dismiss it — the settle window", () => {
  /* THE GUARD THAT MAKES A NAIVE VERSION OF THIS FEATURE UNUSABLE WITHOUT IT.
     On iOS the keyboard's appearance moves the viewport and the page fires
     scroll as it does, so at the moment of focus "the user scrolled down" and
     "the keyboard just opened" are indistinguishable from inside this
     handler. With no guard the first frame after focus dismisses the keyboard
     the user just asked for, every time, and the field reads as broken.

     MUTATION: delete the `Date.now() - showSearchFocusedAt < KB_SETTLE_MS`
     check. This fails — the blur fires on the scroll the keyboard itself
     caused. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");        // timestamp is NOW; no clock advance

  m.scrollTo(400);                  // the keyboard shoving the page up
  assert.strictEqual(m.input.blurCount, 0,
    "movement during the keyboard's own animation must not be read as the user scrolling");

  m.read("showSearchFocusedAt = 0");
  m.scrollTo(600);
  assert.strictEqual(m.input.blurCount, 1, "…and a real scroll after it still works");
});

test("scrolling up never dismisses, and neither does jitter inside the dead zone", () => {
  /* The same asymmetry the collapsing header already has: down is "show me
     more of the page", up is "I am coming back" — and pulling the keyboard
     out from under someone scrolling back toward the field they are typing in
     is the opposite of natural. The dead zone is `SCROLL_HIDE_DELTA`, reused
     rather than re-picked, so the header and the keyboard cannot respond to
     different flicks of one thumb.

     MUTATION: change the guard to `if (Math.abs(delta) <= SCROLL_HIDE_DELTA)
     return;`, which makes upward scrolling dismiss too. This fails. A second,
     independent mutation also kills it: `delta <= 0`, which makes a 1px
     tremor dismiss. RUN: both failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");
  m.read("showSearchFocusedAt = 0");

  m.scrollTo(500);
  assert.strictEqual(m.input.blurCount, 1, "sanity: down dismisses");

  m.input.dispatch("focus");
  m.read("showSearchFocusedAt = 0");
  m.scrollTo(200);                  // a large upward move
  assert.strictEqual(m.input.blurCount, 1, "scrolling up must never dismiss");

  m.scrollTo(205);                  // 5px of tremor, inside the dead zone
  assert.strictEqual(m.input.blurCount, 1, "reading jitter must not dismiss");
});

test("the rule does not depend on the page having a collapsing header", () => {
  /* The keyboard rule is about the window, not about this page's header, so
     it is evaluated BEFORE onWindowScroll's `if (!head) return`. #/shows has
     a `.page-head` today; depending on that is how this would quietly stop
     working the day the search page's chrome changed again — which, on this
     page, in this week, is not hypothetical.

     This fixture deliberately has no `.page-head` at all.

     MUTATION: move the maybeDismissKeyboardOnScroll() call below the
     `if (!head) { lastScrollY = y; return; }` line. This fails. RUN: failed
     as named. */
  const m = mount();
  m.ctx.renderAllShows();
  assert.strictEqual(m.ctx.document.querySelector("#view .page-head"), null,
    "sanity: this fixture has no page head, which is the point");

  m.input.dispatch("focus");
  m.read("showSearchFocusedAt = 0");
  m.scrollTo(300);
  assert.strictEqual(m.input.blurCount, 1, "a page with no header must still dismiss the keyboard on scroll");
});

test("nothing is blurred when the field never had focus", () => {
  /* The cheapest possible way for this feature to become a bug: a scroll
     handler that blurs whatever happens to be focused. Scrolling a show page
     while typing in its EPISODE search box must not reach into the shows
     page's field — and more importantly, an unfocused page must not be doing
     DOM lookups and blur calls on every frame of every scroll.

     MUTATION: delete the `if (!showSearchFieldFocused) return;` guard. This
     fails. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.read("showSearchFocusedAt = 0");   // as if a focus had long since happened

  m.scrollTo(400);
  assert.strictEqual(m.input.blurCount, 0, "no focus, no blur");
});
