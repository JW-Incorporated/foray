/* The search field sits at the BOTTOM of the search page, above the keyboard.
 *
 * FOUNDER, 2026-09-13, verbatim: "We should likely also move the search bar
 * down to the bottom - model it after most other text boxes, for example in
 * the Claude app or Apple Podcasts."
 *
 * This supersedes his own report of a few hours earlier ("when I start
 * scrolling up, the search bar should reappear. At the top of the screen"),
 * which had just been answered by rendering the field inside the collapsing
 * `.page-head`. A field pinned to the bottom edge is on screen at every
 * scroll position, so there is nothing left for a scroll-up to reveal; that
 * header slot, its `.page-head-stacked` layout modifier and
 * renderShowIndexPage's `headExtra` argument are all deleted rather than left
 * standing as a second mechanism. test/search-page-chrome.test.js pins that
 * negative. This file pins the positive.
 *
 * WHAT IS ACTUALLY TESTABLE HERE, stated plainly rather than papered over.
 * "The field sits above the keyboard on an iPhone" is a WKWebView layout
 * behaviour and needs a phone — the same honest limit
 * test/now-playing-keyboard.test.js records for the fix this one builds on.
 * What a unit test CAN pin, and what this file pins:
 *
 *   1. PLACEMENT — the field renders inside `#sh-compose`, which is a sibling
 *      of the page header rather than a child of it, is emitted first in the
 *      page so it leads the tab order, lives inside `#view` so the next
 *      render disposes of it, and never appears on the category page that
 *      shares the template.
 *   2. THE BODY CLASS — `body.sh-compose` is what reserves room at the bottom
 *      of the page for a fixed bar, and renderAllShows adds it AFTER the
 *      render that would otherwise wipe it.
 *   3. THE STACKING ORDER — 58, strictly between `.tab-bar` (55, which this
 *      bar docks on top of) and `#foray-player` (60, which is also the
 *      expanded Now Playing sheet and must not be punched through). Read out
 *      of styles.css so the three numbers are compared, not asserted in
 *      isolation.
 *   4. THE DOCKING ARITHMETIC — `--sh-dock` composes the tab bar, the player
 *      and the home-indicator inset the same way the existing content
 *      reservations do, and every one of those rules is scoped
 *      `body:not(.kb-open)` so that the keyboard-open case falls back to 0 by
 *      not matching rather than by an override that would lose on
 *      specificity.
 *   5. THE KEYBOARD MEASUREMENT — `keyboardInsetPx` and the `--kb-inset`
 *      custom property installKeyboardChrome now publishes alongside
 *      `body.kb-open`, including that it is zeroed when the keyboard shuts
 *      and on teardown.
 *   6. THE TWO DO NOT FIGHT — one detector, one evaluation: the class and the
 *      variable are written in the same `apply()`, and `#sh-compose` is not
 *      itself hidden by `kb-open` (it is the one thing that must stay).
 *
 * WHAT STILL NEEDS A DEVICE, and is deliberately NOT asserted here:
 *   - that `innerHeight - visualViewport.height - visualViewport.offsetTop`
 *     really is the shift that keeps the bar on the keyboard's top edge in
 *     BOTH of WebKit's fixed-position regimes. The formula is reasoned from
 *     the re-anchoring behaviour installKeyboardChrome's header diagnosed on
 *     a real phone; the second regime cannot be reproduced off one. This is
 *     the line in the change that most needs an iPhone.
 *   - that the bar, the keyboard and the home indicator do not overlap by a
 *     pixel or two on any specific device. That is `env()` in a real
 *     compositor.
 *   - the CHROME of the pill: exact radii, blur strength, shadow, colour.
 *     Those are tuned against the founder's photographs by eye, and pinning
 *     them here would mean rewriting this file every time one is nudged.
 *     Section 7 pins the STRUCTURAL claims those photographs settle, and
 *     stops there.
 *
 * SETTLED BY THE FOUNDER'S OWN DEVICE, not by anyone's recollection: both
 * apps he named put the field at the BOTTOM. "The text field on Apple
 * Podcasts search is definitely on the bottom. Let me share some pictures,
 * they seem to have nailed it." He sent two — idle, and focused with the
 * keyboard up — and section 7 is read off them.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md, "a
 * green test is not evidence until you have broken it").
 *
 * Harness: the node:vm DOM stub of test/search-page-chrome.test.js, extended
 * with a RECORDING classList (the body class is a claim here, and that file's
 * stub has a no-op one) — plus the purpose-built fake window of
 * test/now-playing-keyboard.test.js, extended with a documentElement whose
 * style records setProperty, since the inset is published as a CSS variable.
 * Duplicated rather than imported, per the convention those files set out.
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

function makeEl(tag) {
  const listeners = new Map();
  const classes = new Set();
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, children: [],
    offsetHeight: 0,
    /* Records, unlike the sibling suites' no-op stub: `body.sh-compose` is an
       assertion in this file, and `className =` has to clear the set the way
       the real property does or the class would survive a navigation here
       when it does not in a browser. */
    _classes: classes,
    get className() { return [...classes].join(" "); },
    set className(v) {
      classes.clear();
      for (const c of String(v).split(/\s+/)) if (c) classes.add(c);
    },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    style: {
      _props: new Map(),
      setProperty(k, v) { this._props.set(k, v); },
      removeProperty(k) { this._props.delete(k); },
      getPropertyValue(k) { return this._props.get(k) ?? ""; },
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
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

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "menu-btn", "refresh-btn", "banner-slot",
  "sh-form", "sh-input", "sh-note", "sh-results", "sh-browse", "sh-compose",
  "sh-dismiss", "ep-search-results", "pl-search-results",
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

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body, documentElement: root, readyState: "complete",
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
    ctx, byId, body, root, showIndex,
    input: byId.get("sh-input"),
    view: () => byId.get("view").innerHTML,
    bodyHas: (c) => body.classList.contains(c),
  };
  m.state = vm.runInContext("state", ctx);
  m.state.catalog = {
    shows: [
      { show_id: "a", title: "A Show", taxonomy_node_ids: [], editorial_note: "A real note." },
      { show_id: "b", title: "B Show", taxonomy_node_ids: ["science"] },
    ],
  };
  m.state.taxonomy = { nodes: [{ id: "science", label: "Science", parent: null }] };
  m.state.discover = { items: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  return m;
}

/* The declaration block of one CSS rule, by its exact selector text — so a
   test compares what the rule SAYS, not merely that the selector occurs
   somewhere in the file. Returns null when the selector is absent, which is
   itself an assertable outcome. */
function cssRule(selector) {
  const i = STYLES.indexOf(`${selector} {`);
  if (i === -1) return null;
  const open = STYLES.indexOf("{", i);
  const close = STYLES.indexOf("}", open);
  return STYLES.slice(open + 1, close).trim();
}

/* The z-index a rule declares, as a number, so the ladder can be compared
   rather than string-matched. */
function zIndexOf(selector) {
  const body = cssRule(selector);
  assert.ok(body, `expected a rule for \`${selector}\` in styles.css`);
  const mm = /z-index:\s*(\d+)/.exec(body);
  assert.ok(mm, `expected \`${selector}\` to declare a numeric z-index, got: ${body}`);
  return Number(mm[1]);
}

/* ==================================================================== */
/* 1. PLACEMENT                                                          */
/* ==================================================================== */

test("the search field renders inside #sh-compose, a sibling of the page header", () => {
  /* The bar is `position: fixed`, so its place in the markup decides tab
     order and lifetime, not where it is painted — see renderAllShows's
     comment. What must be true is that it exists, that it holds the real
     form, and that it is not nested in the collapsing header any more.
     MUTATION: drop the `<div id="sh-compose">` wrapper and emit the bare
     `<form id="sh-form">` again. Every assertion below fails, and in a
     browser the field returns to being an ordinary block at the top of the
     page. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  const html = m.view();
  assert.ok(html.includes('<div id="sh-compose">'), "the compose bar must be rendered");
  const bar = html.slice(html.indexOf('<div id="sh-compose">'), html.indexOf("</div>", html.indexOf('id="sh-form"')));
  assert.ok(bar.includes('id="sh-form"'), "…and it must hold the form");
  assert.ok(bar.includes('id="sh-input"'), "…and the field itself");
  /* Was `type="submit"`, the Go button, until the founder deleted it on
     2026-09-14. What the bar must hold is the form and the field; the
     trailing slot's emptiness is its own test further down. */
});

test("the compose bar is emitted FIRST, ahead of the results and the browse furniture", () => {
  /* Visually it is last; in the markup it leads, because it is this page's
     primary control and a keyboard or VoiceOver user must reach it without
     walking 220 catalogue rows. The two orders disagree on purpose.
     MUTATION: move the `#sh-compose` block to the end of renderAllShows's
     `above` argument. The ordering assertions fail. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  const html = m.view();
  const compose = html.indexOf('id="sh-compose"');
  assert.ok(compose !== -1, "fixture assumption: the bar rendered");
  assert.ok(compose < html.indexOf('id="sh-results"'), "the field comes before the results it fills");
  assert.ok(compose < html.indexOf('id="sh-browse"'), "…and before the browse furniture");
  assert.ok(compose < html.indexOf("show-index"), "…and before the A–Z list");
});

test("the bar lives inside #view, so the next page render disposes of it", () => {
  /* A fixed element parked on <body> would outlive the page that owns it and
     float over whatever came next. Nothing tears this down by hand; being
     inside the element renderShowIndexPage overwrites IS the teardown.
     MUTATION: append the bar to document.body in renderAllShows instead of
     emitting it into the template. `#view`'s HTML then no longer contains it
     and this fails. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  assert.ok(m.view().includes('id="sh-compose"'), "rendered into #view");
  m.ctx.renderCategory("science");
  assert.ok(!m.view().includes("sh-compose"), "and gone the moment another page renders into #view");
});

/* ==================================================================== */
/* 2. THE BODY CLASS THAT RESERVES THE ROOM                              */
/* ==================================================================== */

test("renderAllShows sets body.sh-compose, and sets it AFTER the render that would wipe it", () => {
  /* setBodyClass() assigns document.body.className wholesale, so a class
     added before renderShowIndexPage runs would be erased by it. The
     reservation rule `body.sh-compose #view { padding-bottom: ... }` is the
     only thing keeping the last A–Z row out from under a fixed bar.
     MUTATION: move the `document.body.classList.add("sh-compose")` line above
     the renderShowIndexPage call. setBodyClass then clears it and this fails
     — which is the entire reason the line sits where it does. RUN: failed as
     named. */
  const m = mount();
  m.ctx.renderAllShows();
  assert.strictEqual(m.bodyHas("sh-compose"), true);
  assert.strictEqual(m.bodyHas("ui-v2"), true, "fixture assumption: setBodyClass really did run");
});

test("navigating to a page with no compose bar drops the class again", () => {
  /* No explicit cleanup exists, by design: the next page's own setBodyClass()
     is the cleanup. If that ever stops being true the reservation would
     survive as dead padding at the bottom of every page.
     MUTATION: make setBodyClass preserve existing classes (e.g.
     `document.body.classList.add(base)` instead of assigning className).
     This fails. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  assert.strictEqual(m.bodyHas("sh-compose"), true);
  m.ctx.renderCategory("science");
  assert.strictEqual(m.bodyHas("sh-compose"), false, "the category page must not pay for a bar it does not have");
});

test("the reservation rule exists and is scoped to that class", () => {
  /* MUTATION: delete `body.sh-compose #view { padding-bottom: ... }` from
     styles.css. This fails, and in a browser the last show in the A–Z list
     sits under the search bar with no way to scroll it clear. RUN: failed as
     named. */
  const rule = cssRule("body.sh-compose #view");
  assert.ok(rule, "the page must reserve room for a bar that occupies none of its own height");
  assert.match(rule, /padding-bottom:\s*var\(--sh-compose-h\)/,
    `the reservation must be the bar's own height token, got: ${rule}`);
  assert.match(STYLES, /--sh-compose-h:\s*\d+px/, "…and that token must be defined");
});

/* ==================================================================== */
/* 3. THE STACKING ORDER                                                 */
/* ==================================================================== */

test("the compose bar stacks ABOVE the tab bar it docks on and BELOW the player/sheet", () => {
  /* The whole argument, as three numbers rather than one: above `.tab-bar`
     (55) because it docks on top of it exactly as the mini-player does; below
     `#foray-player` (60) because that id is the mini bar AND the expanded Now
     Playing sheet, and a search box floating over an open modal sheet is a
     worse bug than any it could fix. They never actually overlap — see the
     docking tests below — so yielding costs nothing.
     MUTATION: raise `#sh-compose`'s z-index to 61 (the tempting "make sure
     the field is never covered"). The upper bound fails. Lowering it to 54
     fails the lower bound. RUN: both failed as named. */
  const compose = zIndexOf("#sh-compose");
  const tabBar = zIndexOf(".tab-bar");
  const player = zIndexOf("#foray-player");
  assert.ok(tabBar < compose, `the bar must sit above the tab bar (${tabBar}), got ${compose}`);
  assert.ok(compose < player, `…and below the player/sheet (${player}), got ${compose}`);
});

test("the z-index ladder comment names the new layer — the file's own rule for adding one", () => {
  /* styles.css keeps every fixed/sticky layer in one list precisely so the
     next person does not have to grep for the numbers, and says so: "Anything
     new that must cover the drawer needs a number above these, and a line in
     this list."
     MUTATION: add the rule without adding the ledger line. This fails. RUN:
     failed as named. */
  assert.match(STYLES, /^\s+58\s+#sh-compose\b/m,
    "the ladder comment must carry a 58 #sh-compose line");
});

/* ==================================================================== */
/* 4. THE DOCKING ARITHMETIC                                             */
/* ==================================================================== */

test("the row is fixed, inset from both edges, and rises by --kb-inset", () => {
  /* Inset left AND right is the floating-row half of the reference: a bar
     welded to the window would be `left: 0; right: 0`.
     MUTATION: replace `bottom: calc(var(--kb-inset, 0px) + var(--sh-dock))`
     with `bottom: var(--sh-dock)`. This fails, and on a phone the field goes
     back behind the keyboard. A second, independent mutation also kills it:
     `left: 0; right: 0`, which is the welded bar this replaced. RUN: both
     failed as named. */
  const rule = cssRule("#sh-compose");
  assert.ok(rule, "#sh-compose must have a rule");
  assert.match(rule, /position:\s*fixed/, "it floats over the page, it is not page content");
  assert.match(rule, /bottom:\s*calc\(var\(--kb-inset,\s*0px\)\s*\+\s*var\(--sh-dock\)\)/,
    `the lift must compose the keyboard inset with the dock, got: ${rule}`);
  assert.match(rule, /left:\s*var\(--sh-gap\);\s*right:\s*var\(--sh-gap\)/,
    `the row must be inset from BOTH screen edges, not full-bleed, got: ${rule}`);
  /* REWRITTEN 2026-09-14 with the block itself: the dock stopped being one
     value enumerated per combination and became a SUM OF PER-OBJECT TERMS,
     when the tab bar became the third thing that can be absent (founder:
     "when the search bar is up, this home ribbon should go away"). The
     property being pinned is unchanged — with nothing on screen the dock is
     the bare gap — it is just now expressed as "every term defaults to 0". */
  assert.match(rule, /--sh-dock:\s*calc\(var\(--sh-gap\)\s*\+\s*var\(--sh-tab\)\s*\+\s*var\(--sh-fp\)\s*\+\s*var\(--sh-safe\)\)/,
    `the dock must be the sum of the gap and one term per optional object, got: ${rule}`);
  for (const term of ["--sh-tab", "--sh-fp", "--sh-safe"]) {
    assert.match(rule, new RegExp(`${term}:\\s*0px`),
      `\`${term}\` must default to 0 — the keyboard-open case, which matches no term rule`);
  }
});

test("--sh-dock composes the tab bar, the player and the safe-area inset, counting each once", () => {
  /* The same "reserve, don't overlap; add the home-indicator inset exactly
     once" rule `body.fp-open`'s own reservations follow — now enforced by
     construction rather than by four rules each remembering to.

     MUTATION: give a term a SECOND rule — e.g. add
     `body:not(.kb-open).view-page #sh-compose { --sh-fp: var(--fp-bar-h); }`
     beside the existing one, which is how "the mini bar needs covering on
     this page too" would naturally be written. The exactly-one-rule
     assertion below fails, and on a phone the pill would float a mini
     player's height too high. RUN: failed as named. A second, independent
     mutation kills it from the other side: delete the `--sh-safe` rule
     entirely, and on a notched phone the pill sits on the home indicator.
     RUN: failed as named. */
  const termRules = {
    /* The tab bar's height leaves the dock through the SAME selector that
       takes the bar off the screen — `.sh-searching` — which is the only
       reason the pill does not jump at the moment the bar goes. */
    "--sh-tab": { selector: "body:not(.kb-open).ui-v2:not(.sh-searching) #sh-compose", token: "var(--tab-bar-h)" },
    "--sh-fp": { selector: "body:not(.kb-open).fp-open #sh-compose", token: "var(--fp-bar-h)" },
    "--sh-safe": { selector: "body:not(.kb-open) #sh-compose", token: "env(safe-area-inset-bottom" },
  };
  for (const [term, { selector, token }] of Object.entries(termRules)) {
    const rule = cssRule(selector);
    assert.ok(rule, `missing the term rule for \`${selector}\``);
    assert.ok(rule.includes(`${term}:`), `\`${selector}\` must set ${term}, got: ${rule}`);
    assert.ok(rule.includes(token), `\`${selector}\` must account for ${token}, got: ${rule}`);
    /* EXACTLY ONE RULE PER TERM IS THE WHOLE POINT of the rewrite: a term
       that two selectors can set is a term that can be counted twice, which
       is the bug the old four-rule enumeration had to be careful about by
       hand. Counted over the whole sheet, not just this block, and the
       defaults-to-zero declaration is excluded by value rather than by
       position — `--sh-tab: 0px` is the floor, not a setter. */
    const declarations = STYLES.match(new RegExp(`${term}:\\s*[^;]+;`, "g")) || [];
    const setters = declarations.filter((d) => !/:\s*0px;$/.test(d));
    assert.strictEqual(setters.length, 1,
      `exactly one rule may turn \`${term}\` on, found ${setters.length}: ${JSON.stringify(setters)}`);
    assert.strictEqual(declarations.length - setters.length, 1,
      `\`${term}\` must have exactly one 0px default, or the keyboard-open case has no floor`);
  }
});

test("every dock term rule is scoped :not(.kb-open) — an override would lose on specificity", () => {
  /* While the keyboard is up there is nothing left to dock above: the player
     is display:none, and the tab bar and the home indicator are behind the
     keyboard. So every term must fall back to 0. Writing that as a
     `body.kb-open #sh-compose` override would NOT work — `body.ui-v2.fp-open
     #sh-compose` is the more specific selector and keeps winning. Scoping the
     term rules is what makes the fallback happen by not matching.
     MUTATION: delete `:not(.kb-open)` from any one of the term selectors.
     This fails, and on a phone the field would float a tab bar's height above
     the keyboard. RUN: failed as named. */
  const termRules = STYLES.match(/^[^\n{]*#sh-compose\s*\{[^}]*--sh-(?:tab|fp|safe):[^}]*\}/gm) || [];
  assert.ok(termRules.length >= 4,
    `expected the default plus one rule per term, found ${termRules.length}`);
  for (const rule of termRules) {
    const selector = rule.slice(0, rule.indexOf("{")).trim();
    if (selector === "#sh-compose") continue;   // the defaults-to-zero declaration itself
    assert.ok(selector.includes(":not(.kb-open)"),
      `\`${selector}\` must not apply while a keyboard is up`);
  }
});

/* ==================================================================== */
/* 5. THE KEYBOARD MEASUREMENT                                           */
/* ==================================================================== */

/* A window whose viewport we can move and whose focus we can place — the fake
   of test/now-playing-keyboard.test.js, plus a documentElement, because the
   inset is published as a CSS custom property on <html>. `innerHeight` is the
   layout viewport and never changes: on iOS the keyboard does not shrink it,
   which is the whole reason `visualViewport.height` is the signal. */
function fakeWindow({ innerHeight = 800, vvHeight = 800, offsetTop = 0, withVisualViewport = true, activeElement = null } = {}) {
  const listeners = [];
  const classes = new Set();
  const props = new Map();
  const body = {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
  };
  const documentElement = {
    style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
      getPropertyValue: (k) => props.get(k) ?? "",
    },
  };
  const mk = (name) => ({
    addEventListener: (type, fn, opts) => { listeners.push({ target: name, type, fn, opts }); },
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.target === name && l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  });
  const doc = { body, documentElement, activeElement, ...mk("document") };
  const vv = withVisualViewport ? { height: vvHeight, offsetTop, ...mk("vv") } : undefined;
  const win = { innerHeight, document: doc, visualViewport: vv };
  return {
    win, doc, vv, listeners, props,
    has: (c) => classes.has(c),
    inset: () => props.get("--kb-inset"),
    fire: (target, type) => {
      for (const l of listeners.slice()) if (l.target === target && l.type === type) l.fn({});
    },
  };
}

function editable() { return { tagName: "INPUT", isContentEditable: false }; }

const APP = (() => {
  const m = mount();
  return m.ctx;
})();

test("keyboardInsetPx is the visible viewport's distance from the bottom of the layout viewport", () => {
  /* The plain case: keyboard up, page not yet scrolled, WebKit still
     resolving `position: fixed` against the layout viewport. The bar must
     rise by the whole keyboard.
     MUTATION: return `win.innerHeight - vv.height` without subtracting
     offsetTop. This case still passes (offsetTop is 0 here) — which is why
     the next test exists and why both are needed. Dropping the subtraction
     entirely, i.e. returning 0, fails here. RUN: failed as named. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 480, offsetTop: 0 });
  assert.strictEqual(APP.keyboardInsetPx(f.win), 320);
});

test("once WebKit has re-anchored fixed elements, offsetTop absorbs the shift and the lift falls to 0", () => {
  /* The second regime installKeyboardChrome's header describes: after a
     scroll, fixed elements resolve against the VISUAL viewport, which has
     itself moved down by the keyboard's height. A bar already sitting on the
     keyboard's edge must not rise again — that double-shift is the bug this
     term prevents.
     MUTATION: drop `- offsetTop` from keyboardInsetPx. This returns 320 and
     fails; the field would jump a keyboard's height up the screen the moment
     the list was scrolled. RUN: failed as named.
     DEVICE-ONLY, and not claimed by this test: that iOS reports offsetTop
     this way. The arithmetic is pinned here; the platform behaviour is not. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 480, offsetTop: 320 });
  assert.strictEqual(APP.keyboardInsetPx(f.win), 0);
});

test("the lift is clamped at zero and never negative", () => {
  /* A negative `bottom` would push the bar off the bottom of the screen —
     strictly worse than not moving it at all. Pinch-zoom can make these
     numbers disagree in either direction.
     MUTATION: drop the `Math.max(0, ...)`. This fails. RUN: failed as
     named. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 900, offsetTop: 0 });
  assert.strictEqual(APP.keyboardInsetPx(f.win), 0);
});

test("no visualViewport means no lift, rather than NaN in a CSS variable", () => {
  /* Desktop Safari <13, an old WebView, a test stub. `bottom: NaNpx` is an
     invalid declaration the browser drops, which happens to be survivable —
     but only by luck, and it would take the whole `bottom` with it.
     MUTATION: remove the guard and let the arithmetic run on `undefined`.
     This fails with NaN. RUN: failed as named. */
  assert.strictEqual(APP.keyboardInsetPx(fakeWindow({ withVisualViewport: false }).win), 0);
  assert.strictEqual(APP.keyboardInsetPx(null), 0);
});

test("installKeyboardChrome publishes --kb-inset on <html> alongside body.kb-open", () => {
  /* The class and the variable are written by the SAME evaluation, so they
     can never disagree — a kb-open body carrying a stale inset would put the
     bar somewhere the keyboard is not. One detector, two answers.
     MUTATION: delete the `setKeyboardInsetVar(...)` call from `apply()`. The
     class still goes on and the inset assertion fails — which is exactly the
     split this test exists to forbid. RUN: failed as named. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 480, activeElement: editable() });
  const teardown = APP.installKeyboardChrome(f.win);
  assert.strictEqual(f.has("kb-open"), true, "fixture assumption: the keyboard reads as open");
  assert.strictEqual(f.inset(), "320px");
  teardown();
});

test("closing the keyboard zeroes the inset, it does not merely stop updating it", () => {
  /* A variable left at 320px with the keyboard gone would hold the compose
     bar a third of the way up an empty screen. The class coming off is not
     enough on its own: nothing in the CSS reads the class to place the bar.
     MUTATION: delete the `setKeyboardInsetVar` call from `apply()` so the
     variable is only ever written on the way in. This fails. RUN: failed as
     named. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 480, activeElement: editable() });
  const teardown = APP.installKeyboardChrome(f.win);
  assert.strictEqual(f.inset(), "320px");
  f.vv.height = 800;
  f.fire("vv", "resize");
  assert.strictEqual(f.has("kb-open"), false);
  assert.strictEqual(f.inset(), "0px", "the bar must settle back onto the dock, not hang in mid-air");
  teardown();
});

test("the inset follows the CLASS's predicate, not the raw measurement", () => {
  /* The case that separates the two, and the reason the call reads
     `open ? keyboardInsetPx(w) : 0`: a WebView that closes the keyboard by
     blurring the field WITHOUT firing a viewport resize — the exact gap
     installKeyboardChrome's `focusout` escape hatch exists for. The raw
     measurement still reports a 320px inset there, because the visual
     viewport has not been told anything yet. The class correctly comes off,
     and the bar must come down with it rather than stay lifted over a
     keyboard that is gone.
     MUTATION: write `setKeyboardInsetVar(doc, keyboardInsetPx(w))`
     unconditionally. The class assertion still passes and the inset
     assertion fails — which is precisely the disagreement between the two
     signals this whole change is supposed to make impossible. RUN: failed as
     named. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 480, activeElement: editable() });
  const teardown = APP.installKeyboardChrome(f.win);
  assert.strictEqual(f.inset(), "320px", "fixture assumption: it starts lifted");
  f.doc.activeElement = null;            // blurred; the viewport has NOT resized
  f.fire("vv", "scroll");
  assert.strictEqual(f.has("kb-open"), false, "nothing editable is focused, so no keyboard");
  assert.strictEqual(f.inset(), "0px",
    "…and the bar must come down with the class, not stay lifted on a stale measurement");
  teardown();
});

test("teardown undoes the measurement as well as the class", () => {
  /* With the listeners gone there is nothing left running to correct a
     stranded inset.
     MUTATION: delete the `setKeyboardInsetVar(doc, 0)` line from the returned
     teardown. This fails. RUN: failed as named. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 480, activeElement: editable() });
  APP.installKeyboardChrome(f.win)();
  assert.strictEqual(f.has("kb-open"), false);
  assert.strictEqual(f.inset(), "0px");
});

test("a document with no documentElement style is survived, not thrown on", () => {
  /* The fake windows in test/now-playing-keyboard.test.js hand
     installKeyboardChrome a document with a body and nothing else, and a
     WebView that reports no style object is not worth throwing over — the bar
     simply stays at `bottom: 0`, where it sat before this variable existed.
     MUTATION: drop the guard in setKeyboardInsetVar and dereference
     `doc.documentElement.style` directly. This throws. RUN: failed as
     named. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 480, activeElement: editable() });
  delete f.doc.documentElement;
  assert.doesNotThrow(() => APP.installKeyboardChrome(f.win)());
});

/* ==================================================================== */
/* 6. THE TWO BOTTOM-EDGE RULES DO NOT FIGHT                             */
/* ==================================================================== */

test("kb-open takes the now-playing bar off the screen and leaves the compose bar on it", () => {
  /* Two things read the same signal for opposite purposes, which is the point
     of reusing it rather than adding a second detector: the player must go
     (founder, 2026-09-13: "When the keyboard is present the now playing bar
     should not be visible"), and the field must stay — it is what the
     keyboard is open FOR.
     MUTATION: add `body.kb-open #sh-compose { display: none; }` — the
     copy-paste of the rule above it. This fails. RUN: failed as named. */
  assert.match(STYLES, /body\.kb-open\s+#foray-player\s*\{\s*display:\s*none/,
    "the player rule this change builds on must still be there");
  assert.ok(!/body\.kb-open\s+#sh-compose\s*\{[^}]*display:\s*none/.test(STYLES),
    "the compose bar must never be hidden by the keyboard it is tracking");
});

/* ==================================================================== */
/* 7. THE SHAPE THE SCREENSHOTS SETTLED                                  */
/*                                                                      */
/* The founder photographed Apple Podcasts' search screen — idle, and    */
/* focused with the keyboard up — and said "they seem to have nailed    */
/* it". These pin the structural claims read off those images. They      */
/* deliberately do NOT pin the chrome (radii, blur strength, shadow,     */
/* colour): that is ours to tune against the pictures without rewriting  */
/* this file.                                                           */
/* ==================================================================== */

test("the field is a translucent pill, not an opaque bar welded to the screen edge", () => {
  /* The single most characteristic thing in the screenshots: the category
     grid reads THROUGH the search pill. An opaque fill cuts the page off at a
     hard line instead, which is what this replaced.
     MUTATION: drop the `color-mix(...)` background from `#sh-compose #sh-form`
     so only the opaque `var(--surface)` fallback remains. This fails. RUN:
     failed as named. */
  const pill = cssRule("#sh-compose #sh-form");
  assert.ok(pill, "the pill must have a rule of its own inside the floating row");
  assert.match(pill, /border-radius:\s*999px/, "rounded to a capsule, as in the reference");
  /* `[^;]*` rather than `[^)]*`: the value nests a `var(--surface)`, so a
     class excluding `)` stops inside it and never reaches `transparent`. */
  assert.match(pill, /background:\s*color-mix\(in srgb[^;]*transparent\)/,
    `the pill must be translucent so content reads through it, got: ${pill}`);
  assert.match(pill, /background:\s*var\(--surface\);/,
    "…with an opaque fallback first, for browsers without color-mix");
  assert.match(STYLES, /backdrop-filter:\s*blur\(/, "and blurred where the platform supports it");
});

test("the pill's stronger translucency is gated on backdrop-filter actually working", () => {
  /* An unblurred 55%-transparent pill over dense podcast artwork is
     unreadable. The heavier transparency must be conditional on the blur
     being real, not applied unconditionally and hoped for.
     MUTATION: change the base rule's 72% to 55%, i.e. apply the gated value
     unconditionally. This fails. RUN: failed as named. */
  const base = cssRule("#sh-compose #sh-form");
  assert.ok(!/55%/.test(base), "the heavier transparency must not be in the ungated rule");
  const i = STYLES.indexOf("@supports (backdrop-filter: blur(20px))");
  assert.ok(i !== -1, "the support gate must exist");
  assert.ok(STYLES.slice(i, i + 600).includes("55%"), "…and must be where the 55% lives");
});

test("the field gives up its own box so the pill is the only box", () => {
  /* `#sh-input` carries a border, a surface fill and a shadow from its
     page-content days. Left in place inside the pill, that is a box in a box.
     MUTATION: delete the `#sh-compose #sh-input` rule. This fails. RUN:
     failed as named. */
  const field = cssRule("#sh-compose #sh-input");
  assert.ok(field, "the field must be restyled inside the pill");
  assert.match(field, /border:\s*0/, "no second border");
  assert.match(field, /background:\s*none/, "no second fill");
  assert.match(field, /box-shadow:\s*none/, "no second shadow");
});

test("there is a leading magnifier and NO microphone", () => {
  /* Apple's pill has a magnifier at the leading edge and a microphone at the
     trailing one. We copy the first and refuse the second: we have no
     dictation, and a glyph wired to nothing is worse than an empty slot.
     MUTATION: add a `<svg class="sh-mic">` beside the input. This fails on
     the microphone assertion. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  const html = m.view();
  assert.ok(html.includes('class="sh-glyph"'), "the leading magnifier must be in the pill");
  assert.ok(html.indexOf('class="sh-glyph"') < html.indexOf('id="sh-input"'),
    "…leading it, not trailing it");
  assert.ok(!/mic/i.test(html), "no microphone: we have no dictation to wire one to");
  assert.ok(cssRule("#sh-compose .sh-glyph"), "and the glyph must be styled, not a raw 24px SVG");
});

test("the trailing slot is empty — the Go button is gone", () => {
  /* Founder, 2026-09-14: "since the search results are live, the 'go' button
     is useless, delete it." He is right, and the reason is in this repo's own
     history: G2's "keep the button, keep Enter, make neither required" was
     decided when the button was the only way to run a search at all, and S-02
     then made the results filter live on every keystroke. By the time a thumb
     reached the button, the results it would have produced were already on
     screen. Its only remaining effect was skipping a 250ms debounce on work
     that had finished.

     MUTATION: put `<button type="submit">Go</button>` back inside #sh-form.
     This fails. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  const html = m.view();
  const form = html.slice(html.indexOf('id="sh-form"'), html.indexOf("</form>"));
  assert.ok(!/<button/.test(form), `the pill holds the field and nothing else, got: ${form}`);
  assert.ok(!/>Go</.test(html), "no Go button anywhere on the search page");
});

test("removing the button did not remove the submit path — return still searches", () => {
  /* THE HALF THAT HAD TO SURVIVE. `submit` is what a phone keyboard's return
     key fires, and firing it is how the keyboard is dismissed from inside the
     field; it is also still the way to skip the debounce. A `<form>` with no
     submit control still submits on Enter, so deleting the button costs
     neither. Driven through the real listener renderAllShows binds.

     MUTATION: delete the `$("#sh-form").addEventListener("submit", …)`
     binding along with the button — the tempting "remove the control and its
     handler" reading. This fails: submitting does nothing, and on a phone the
     return key would stop dismissing the keyboard. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  const form = m.byId.get("sh-form");
  assert.ok(form, "sanity: the form element is still there");
  m.byId.get("sh-input").value = "radiolab";
  assert.strictEqual(form.dispatch("submit"), 1,
    "the form must still carry a submit handler with no button to press it");
});

test("no orphan CSS is left behind the deleted button", () => {
  /* `#sh-form` is the only form those rules ever selected and it now contains
     no button, so both the base rule and its `body.ui-v2` override select
     nothing at all. Dead rules are how a later reader concludes the control
     still exists.
     MUTATION: restore either `#sh-form button { … }` or
     `body.ui-v2 #sh-form button { … }`. This fails. RUN: failed as named,
     for each. */
  assert.ok(!/^#sh-form button\s*\{/m.test(STYLES), "the Go button's base rule must go with it");
  assert.ok(!/^body\.ui-v2 #sh-form button\s*\{/m.test(STYLES), "…and so must its v2 override");
  assert.ok(!/#sh-compose #sh-form button\[type="submit"\]\s*\{/.test(STYLES),
    "…and the compose-bar sizing rule that had nothing left to size");
});

test("the companion button is absent when idle and present once the field is live", () => {
  /* Apple swaps an idle Home button for a circular ✕ on focus. We do not copy
     the Home half — `.tab-bar` already carries Home two rows below, and the
     same destination twice is not a design. So the slot is EMPTY when idle,
     which also lets the pill span the whole row.
     MUTATION: change the dismiss line to `dismiss.hidden = false`. The button
     then shows on an untouched page and the first assertion fails. RUN:
     failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  const dismiss = m.byId.get("sh-dismiss");
  assert.strictEqual(dismiss.hidden, true, "nothing to dismiss on a resting page");
  m.input.dispatch("focus");
  assert.strictEqual(dismiss.hidden, false, "…and it arrives with the keyboard");
  m.input.dispatch("blur");
  assert.strictEqual(dismiss.hidden, true, "…and leaves again on a blur with an empty field");
});

test("the companion button follows the SAME predicate as the browse furniture, inverted", () => {
  /* "There is a search in progress" is one fact about this page. The browse
     furniture leaving and the ✕ arriving are that fact seen from two sides, so
     they are computed together rather than by two rules that could drift —
     including the case that separates them from a naive `focused` test: a
     blur with a live query, where the results stay up and so must the way out
     of them.
     MUTATION: `dismiss.hidden = !showSearchFieldFocused`. The blur-with-a-
     query case fails. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  const dismiss = m.byId.get("sh-dismiss");
  m.input.dispatch("focus");
  m.input.value = "radio";
  m.input.dispatch("input");
  m.input.dispatch("blur");
  assert.deepStrictEqual(
    { browse: m.byId.get("sh-browse").hidden, dismiss: !dismiss.hidden },
    { browse: true, dismiss: true },
    "a live query keeps the results up, so it must keep the way OUT of them up too");
});

test("pressing the companion button clears the query, the results and the focus", () => {
  /* It is the phone's Escape key — the gap the Escape handler's own comment
     names ("desktop only; a phone keyboard has no Escape").
     MUTATION: bind the button to `click` instead of `mousedown`. On a desktop
     the press blurs the field first, updateShowBrowseVisibility hides the
     button, and the click never lands — this test dispatches `mousedown` and
     fails outright on the handler count. RUN: failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  const dismiss = m.byId.get("sh-dismiss");
  m.input.dispatch("focus");
  m.input.value = "radio";
  m.input.dispatch("input");
  m.byId.get("sh-results").hidden = false;

  assert.strictEqual(dismiss.dispatch("mousedown"), 1, "exactly one mousedown handler");
  assert.strictEqual(m.input.value, "", "the field is emptied");
  assert.strictEqual(m.byId.get("sh-results").hidden, true, "the painted results are dropped");
  assert.deepStrictEqual(
    { browse: m.byId.get("sh-browse").hidden, index: m.showIndex.hidden },
    { browse: false, index: false },
    "and the catalogue comes back");
  assert.strictEqual(dismiss.hidden, true, "…taking the button with it");
});

test("Escape and the button are one path, not two implementations", () => {
  /* MUTATION: inline the four statements back into the Escape handler, so
     `dismissShowSearch` is called only by the button. The behavioural halves
     still pass — which is exactly why the source assertion is here too. RUN:
     failed as named. */
  const m = mount();
  m.ctx.renderAllShows();
  m.input.dispatch("focus");
  m.input.value = "radio";
  m.input.dispatch("input");
  m.input.dispatch("keydown", { key: "Escape" });
  const afterEscape = { v: m.input.value, browse: m.byId.get("sh-browse").hidden };

  const m2 = mount();
  m2.ctx.renderAllShows();
  m2.input.dispatch("focus");
  m2.input.value = "radio";
  m2.input.dispatch("input");
  m2.byId.get("sh-dismiss").dispatch("mousedown");
  const afterButton = { v: m2.input.value, browse: m2.byId.get("sh-browse").hidden };

  assert.deepStrictEqual(afterEscape, afterButton, "the two triggers must land identically");
  /* CALL sites only — the trailing `;` excludes the `function
     dismissShowSearch(input) {` declaration, which is not a caller. */
  const calls = APP_SRC.match(/dismissShowSearch\(input\);/g) || [];
  assert.strictEqual(calls.length, 2, `one function, two callers, got ${calls.length}`);
  assert.strictEqual((APP_SRC.match(/function dismissShowSearch\(/g) || []).length, 1,
    "…and exactly one definition of it");
});

test("the page still reserves the row's height, so the last show stays reachable", () => {
  /* Content scrolling BEHIND the pill is the look. Content permanently
     UNREACHABLE behind it is not — and that distinction is why this
     reservation survives the move from an opaque bar to a floating row.
     MUTATION: delete `body.sh-compose #view`'s padding-bottom. This fails,
     and in a browser the last of the 220 rows cannot be scrolled clear of the
     pill. RUN: failed as named. */
  const rule = cssRule("body.sh-compose #view");
  assert.ok(rule && /padding-bottom/.test(rule), "the reservation must survive the restyle");
  assert.match(STYLES, /--sh-compose-h:\s*\d+px/, "and be expressed as the row's own height");
});

test("there is still exactly one keyboard detector in the app", () => {
  /* The brief for this change, and the right rule: the inset is a
     MEASUREMENT derived from installKeyboardChrome's own evaluation, not a
     second listener racing it.
     MUTATION: add a second `visualViewport.addEventListener("resize", ...)`
     anywhere in app.js — the obvious way to implement the lift without
     touching the existing module. This fails. RUN: failed as named. */
  /* CALLS only — `typeof vv.addEventListener !== "function"` is the capability
     guard on the same object, not a subscription. */
  const subs = APP_SRC.match(/(?:visualViewport|vv)\.addEventListener\(\s*"/g) || [];
  assert.strictEqual(subs.length, 2,
    `expected exactly the resize+scroll pair installKeyboardChrome binds, found ${subs.length}`);
  assert.match(APP_SRC, /vv\.addEventListener\("resize"/, "…the resize half");
  assert.match(APP_SRC, /vv\.addEventListener\("scroll"/, "…and the scroll half, which is the re-anchor frame");
});

/* ---------- focusing the field lands the page at the top -------------------

   FOUNDER, 2026-09-17, verbatim: "When I click search, it jumps down to the
   bottom, so then I need to scroll up to find the top search result for shows."

   This is the cost of the very thing this file pins. The pill is fixed to the
   bottom edge and needs no scrolling to reach — but the document under it is
   the whole A-Z show list, measured at 17,712px in a 390px harness on
   2026-09-17. iOS scrolls a focused field into view against the LAYOUT viewport
   as the keyboard rises, and on a document that tall the correction lands
   thousands of pixels down. Results paint at the TOP, above where the listener
   now stands, and the only way back to the best match is a long scroll up.

   THE LIMIT, stated rather than papered over: desktop Chrome cannot reproduce
   it. Typing hides the browse list, the document collapses to one viewport, and
   the browser clamps scrollY to 0 by itself — measured in the same harness:
   jump to 6000, type, land at 0, first result at y=125. That clamp is the
   browser being helpful, not a contract, and it is absent on iOS with a
   keyboard up. So what is pinned here is that the app states the position
   itself rather than inheriting whatever the browser chose. */

test("focusing the show-search field scrolls the page to the top", () => {
  /* MUTATION: delete the `scrollPageTo(0)` line from the focus handler. This
     goes red. RUN: failed as named. */
  const focusHandler = /input\.addEventListener\("focus",\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s{4}\}\);/.exec(APP_SRC);
  assert.ok(focusHandler, "the show-search field must still have a focus handler");
  assert.match(focusHandler[1], /scrollPageTo\(0\)/,
    "focus must put the page at the top, where the results paint");
});

test("the scroll-dismiss baseline is re-read AFTER the scroll, not before it", () => {
  /* Not cosmetic, and the ORDER is the invariant — not the value.
     `maybeDismissKeyboardOnScroll` measures a DELTA against `lastScrollY`. Read
     it before `scrollPageTo(0)` and the next frame compares the new position
     against the old one, sees a large fake downward delta, and blurs the field
     the instant the listener starts typing.

     The first draft of this fix asserted `lastScrollY = 0` instead, reasoning
     that we had just scrolled there. That was wrong, and
     test/keyboard-chrome-and-scroll.test.js caught it: `scrollPageTo` is
     deliberately a no-op where there is no viewport to move (its own guard, for
     the node:vm suites), so pinning the literal made this handler assert a
     position the viewport had never taken — and an up-scroll after a re-focus
     then read as a 200px scroll DOWN and dismissed the keyboard.

     MUTATION: move the `lastScrollY` line above `scrollPageTo(0)`. This goes
     red, and so does that other suite — which is the part worth having. */
  const focusHandler = /input\.addEventListener\("focus",\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s{4}\}\);/.exec(APP_SRC);
  const body = focusHandler[1];
  assert.match(body, /lastScrollY\s*=\s*window\.scrollY/, "the baseline is read from the viewport");
  assert.ok(
    body.indexOf("scrollPageTo(0)") < body.indexOf("lastScrollY ="),
    "…and read after the scroll it is meant to describe"
  );
});
