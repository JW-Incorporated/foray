/* The ‹ button goes back ONE step — and Home only when there is no step.
 *
 * Founder, TestFlight, 2026-09-03: "When I hit the back button in the top
 * left it should go back one step, not all the way to the home page."
 *
 * Every page head renders `<a class="back" href="#/">`. Routing is hash-only
 * (`hashchange` -> route()), so the browser's own history already has the
 * previous page in it; app.js now calls `history.back()` from a delegated
 * click handler whenever the in-app history it keeps (`navStack`) says that
 * entry is one of ours, and otherwise lets the `#/` href stand. That second
 * path is the cold-open case: a deep link opened fresh has no in-app step
 * behind it, and `history.back()` there leaves the app or does nothing.
 *
 * WHAT THIS PROVES
 *  1. cold open: no in-app step -> the href stands, history.back() untouched
 *  2. one step in: history.back() once, and the link's default is cancelled
 *  3. coming back where you were POPS the step, so the stack does not grow
 *     forever and a later ‹ from the first page still lands on Home
 *  4. a click anywhere else in #view is left alone
 *  5. the wiring: route() records the step; init() delegates from #view
 *  6. every page head keeps the `href="#/"` fallback the cold-open case needs
 *  7. "remove this playlist" goes BACK to the list when the list is the step
 *     behind it, so the removed playlist's entry is not left in front of it
 *  8. a playlist that is gone still renders a page head with a ‹ — the one
 *     history entry that could otherwise be a dead end
 *  9. a second tap on ‹ before the first step has landed does nothing
 *
 * Harness: the same node:vm DOM stub the other app.js suites use, duplicated
 * rather than imported (repo convention — see test/show-page.test.js). The
 * only thing it adds is a counting `history.back`. route() is driven with
 * `renderCurrentPage` and `openDrawer` stubbed out, because what is under
 * test is the step-keeping, not the page each step paints.
 *
 * Every test names the one-line mutation that kills it (CLAUDE.md, "a green
 * test is not evidence until you have broken it"). All six were run.
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
    tagName: String(tag).toUpperCase(), id: "", className: "", innerHTML: "", textContent: "",
    value: "", hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
];

function mount() {
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
  const calls = { back: 0 };
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),   // init() never completes; route() is driven by hand
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => { const s = String(sel); return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null; },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { back() { calls.back++; }, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  /* Top-level function declarations of a classic script are properties of
     the context's global, so the two page-painting calls route() makes can
     be replaced from outside. `state.ready` gates route() entirely. */
  evalIn("state.ready = true; renderCurrentPage = () => {}; openDrawer = () => {};");
  return {
    ctx, calls, evalIn,
    go(hash) { ctx.location.hash = hash; evalIn("route()"); },
    canGoBack: () => evalIn("canGoBackInApp()"),
    /* A click event as the delegated handler sees it. `onBack` says whether
       the click landed on an `a.back`; the fake's `closest` answers exactly
       that and nothing else. */
    click({ onBack = true } = {}) {
      const e = {
        target: { closest: (sel) => (onBack && sel === "a.back" ? { href: "#/" } : null) },
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      };
      ctx.onBackClick(e);
      return e;
    },
  };
}

/* 1 */
test("cold open of a deep link: ‹ keeps its href (Home) and never calls history.back()", () => {
  /* MUTATION: change canGoBackInApp to `navStack.length > 0`. One entry then
     counts as a step, the handler calls history.back() on a page with nothing
     behind it, and this fails on `calls.back`. */
  const m = mount();
  m.go("#/show/lex-fridman-podcast");
  assert.strictEqual(m.canGoBack(), false, "a first page has no in-app step behind it");
  const e = m.click();
  assert.strictEqual(m.calls.back, 0, "history.back() must not be called on a cold open");
  assert.strictEqual(e.defaultPrevented, false, "the href=\"#/\" fallback must be allowed to stand");
});

/* 2 */
test("one step in: ‹ goes back one history entry instead of Home", () => {
  /* MUTATION: delete the `history.back();` line in onBackClick. The default
     is still cancelled, nothing navigates, and `calls.back` stays 0. */
  const m = mount();
  m.go("#/");
  m.go("#/show/lex-fridman-podcast");
  assert.strictEqual(m.canGoBack(), true);
  const e = m.click();
  assert.strictEqual(m.calls.back, 1, "exactly one history.back()");
  assert.strictEqual(e.defaultPrevented, true, "the link must not ALSO navigate to #/");
});

/* 3 */
test("arriving back where you were pops the step, so the stack does not grow and ‹ from the first page still means Home", () => {
  /* MUTATION: delete the pop branch in noteNavigation (the
     `navStack[navStack.length - 2] === h` case), so a back-arrival is pushed
     like any other page. The stack reads [#/, #/shows, #/show/x, #/shows, #/]
     and canGoBackInApp() is still true at the end. */
  const m = mount();
  m.go("#/");
  m.go("#/shows");
  m.go("#/show/lex-fridman-podcast");
  assert.strictEqual(m.canGoBack(), true);
  m.go("#/shows");                         // what hashchange delivers after history.back()
  assert.strictEqual(m.canGoBack(), true, "one step left: Shows still has Home behind it");
  m.go("#/");                              // and again
  assert.strictEqual(m.canGoBack(), false, "back at the first page there is no step behind it");
  assert.strictEqual(m.evalIn("JSON.stringify(navStack)"), JSON.stringify(["#/"]), "the stack is back to its one entry");
});

/* 4 */
test("a click anywhere else in #view is not the back button's business", () => {
  /* MUTATION: drop the `!a ||` from onBackClick's guard. With a step behind
     the page, ANY click in #view would then call history.back(). */
  const m = mount();
  m.go("#/");
  m.go("#/show/lex-fridman-podcast");
  const e = m.click({ onBack: false });
  assert.strictEqual(m.calls.back, 0);
  assert.strictEqual(e.defaultPrevented, false);
});

/* 5 */
test("route() records the step and init() delegates the click from #view — the two lines that wire the rest up", () => {
  /* Wiring pins, deliberately: the four tests above call the functions
     directly, so without these a future edit could unhook either end and
     leave them green. MUTATION: delete `noteNavigation(location.hash);` from
     route(), or the `$("#view").addEventListener("click", onBackClick);`
     line in init(). Each kills one assertion. */
  assert.match(APP_SRC, /function route\(\) \{\s*if \(!state\.ready\) return;\s*noteNavigation\(location\.hash\);/,
    "route() must note the hash it is about to render, before anything else");
  assert.ok(APP_SRC.includes('$("#view").addEventListener("click", onBackClick);'),
    "init() must delegate the back click from #view (pages rewrite #view's innerHTML, so nothing else survives a render)");
});

/* 6 */
test("every page head's back link still carries an in-app href as its cold-open fallback", () => {
  /* The cold-open case (test 1) works BECAUSE the link's own href is a real
     page — Home for most, a page's natural parent for a few (a show page
     falls back to #/shows). A back control written as `href="#"`, or as a
     <button>, would fall through to nothing on a deep link. MUTATION: change
     one `<a class="back" href="#/">` in app.js to `href="#"`. */
  const backLinks = APP_SRC.match(/<a class="back"[^>]*>/g) || [];
  assert.ok(backLinks.length >= 7, `expected the page heads' back links, found ${backLinks.length}`);
  for (const a of backLinks) {
    assert.match(a, /href="#\/[^"]*"/, `a back link without an in-app fallback: ${a}`);
  }
});

/* 7 */
test("removing a playlist goes BACK to the list it was opened from, so the removed entry is behind the list, not in front of it", () => {
  /* Review finding on this branch: `location.hash = "#/playlists"` after a
     remove PUSHED the list in front of the removed playlist's entry, so the
     very next ‹ went back one step onto "Playlist not found".
     MUTATION: make leaveRemovedPlaylist always `location.hash = "#/playlists"`.
     `calls.back` stays 0 and the hash assertion fails. */
  const m = mount();
  m.go("#/");
  m.go("#/playlists");
  m.go("#/playlist/p-1");
  m.evalIn("leaveRemovedPlaylist()");
  assert.strictEqual(m.calls.back, 1, "the list is the step behind: go back to it");
  assert.strictEqual(m.ctx.location.hash, "#/playlist/p-1", "and nothing was pushed in front");
  // opened from the drawer instead: the list is NOT behind this page, so navigate to it
  const d = mount();
  d.go("#/");
  d.go("#/playlist/p-1");
  d.evalIn("leaveRemovedPlaylist()");
  assert.strictEqual(d.calls.back, 0);
  assert.strictEqual(d.ctx.location.hash, "#/playlists");
});

/* 8 */
test("a playlist that is gone still renders a page head with a ‹, so that history entry is never a dead end", () => {
  /* MUTATION: revert renderPlaylistDetail's not-found branch to the bare
     `<div class="page"><p class="note">Playlist not found.</p></div>`. */
  const notFound = /if \(!p\) \{[\s\S]{0,600}?Playlist not found\.[\s\S]{0,60}?return;/.exec(APP_SRC);
  assert.ok(notFound, "renderPlaylistDetail's not-found branch could not be located");
  assert.ok(/<a class="back" href="#\/playlists">/.test(notFound[0]), "the not-found page must carry a ‹ back to the list");
});

/* 9 */
test("a second tap on ‹ before the first step has landed does nothing — one history.back() per landed step", () => {
  /* MUTATION: delete the `if (backPending) return;` line (or the
     `backPending = false` at the top of noteNavigation, which makes the
     third assertion fail instead). */
  const m = mount();
  m.go("#/");
  m.go("#/shows");
  m.go("#/show/x");
  m.click(); m.click();
  assert.strictEqual(m.calls.back, 1, "the second tap must wait for the first step to land");
  m.go("#/shows");                         // the step lands
  m.click();
  assert.strictEqual(m.calls.back, 2, "once landed, ‹ works again");
});
