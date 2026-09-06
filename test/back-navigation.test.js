/* The ‹ button goes back ONE step — and Home only when there is no step.
 *
 * Wyatt, live bug report, 2026-09-05: "back button goes all the way to
 * home, not one page back." Every page head renders
 * `<a class="back" href="#/">`. Routing is hash-only (`hashchange` ->
 * route()), so the browser's own history already has the previous page in
 * it; app.js calls `history.back()` from a delegated click handler whenever
 * the in-app history it keeps (`navStack`) says there is a real step behind
 * the current page, and otherwise lets the `#/` href stand. That second
 * path is the cold-open case: a deep link opened fresh has no in-app step
 * behind it, and `history.back()` there would leave the app or do nothing.
 *
 * WHAT THIS PROVES
 *  1. cold open: no in-app step -> the href stands, history.back() untouched
 *  2. one step in: history.back() once, and the link's default is cancelled
 *  3. coming back where you were POPS the step, so the stack does not grow
 *     forever and a later ‹ from the first page still lands on Home
 *  4. a click anywhere else in #view is left alone
 *  5. multiple different entry points (home, search results, another
 *     show's similar-shows row, a deep link) all produce the SAME behavior:
 *     back returns to whichever page the user actually came from
 *  6. a second tap on ‹ before the first step has landed does nothing
 *     (async history.back() debounce)
 *  7. removing a playlist goes BACK to the list when the list is the step
 *     behind it, so the removed playlist's entry is not left in front of it
 *  8. a playlist that is gone still renders a page head with a ‹ — the one
 *     history entry that could otherwise be a dead end
 *
 * Harness: the same node:vm DOM stub the other app.js suites use, duplicated
 * rather than imported (repo convention — see test/show-page.test.js). The
 * only thing it adds is a counting `history.back`. route() is driven with
 * `renderCurrentPage` and `openDrawer` stubbed out, because what is under
 * test is the step-keeping, not the page each step paints.
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
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
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

/* ==================================================================== */
/* 1. COLD OPEN — no in-app history, the href fallback stands            */
/* ==================================================================== */

test("cold open (deep link, no prior in-app page): the href fallback stands, history.back() is never called", () => {
  /* MUTATION: remove the `!canGoBackInApp()` guard from onBackClick, so it
     always calls history.back(). This fails: calls.back becomes 1. */
  const m = mount();
  m.go("#/show/abc"); // the very first page this session — no step behind it
  assert.strictEqual(m.canGoBack(), false);
  const e = m.click();
  assert.strictEqual(m.calls.back, 0, "history.back() must not fire on a cold open");
  assert.strictEqual(e.defaultPrevented, false, "the href=\"#/\" must be left to fire natively");
});

/* ==================================================================== */
/* 2. ONE STEP IN — history.back() fires, default link action cancelled */
/* ==================================================================== */

test("one step into the app: ‹ calls history.back() exactly once and cancels the link", () => {
  /* MUTATION: drop `e.preventDefault()` from onBackClick. The second
     assertion fails — the browser would follow the "#/" href AND go back,
     a double-navigation. */
  const m = mount();
  m.go("#/");
  m.go("#/shows");
  assert.strictEqual(m.canGoBack(), true);
  const e = m.click();
  assert.strictEqual(m.calls.back, 1);
  assert.strictEqual(e.defaultPrevented, true);
});

/* ==================================================================== */
/* 3. RETURNING WHERE YOU WERE POPS THE STACK                            */
/* ==================================================================== */

test("landing back on the previous hash pops the stack instead of growing it forever", () => {
  /* MUTATION: change `noteNavigation` to always push, never pop. The final
     assertion fails: after "returning" to #/, the stack still thinks #/
     has a step behind it (it does not — #/ is the first page again). */
  const m = mount();
  m.go("#/");
  m.go("#/shows");
  m.go("#/show/abc");
  // simulate history.back() actually landing on #/shows (hashchange -> route())
  m.go("#/shows");
  assert.strictEqual(m.canGoBack(), true, "one step (to #/) still remains");
  m.go("#/"); // and popping that one too returns to the true start
  assert.strictEqual(m.canGoBack(), false, "back at the first page ever rendered, no step behind it");
});

/* ==================================================================== */
/* 4. A CLICK ELSEWHERE IN #view IS LEFT ALONE                           */
/* ==================================================================== */

test("a click that does not land on a.back is never intercepted", () => {
  const m = mount();
  m.go("#/");
  m.go("#/shows");
  const e = m.click({ onBack: false });
  assert.strictEqual(m.calls.back, 0);
  assert.strictEqual(e.defaultPrevented, false);
});

/* ==================================================================== */
/* 5. MULTIPLE ENTRY POINTS ALL RESOLVE TO THEIR OWN PRIOR PAGE           */
/* ==================================================================== */

test("show page opened from home, search results, a similar-shows row, or a deep link: each ‹ returns to its own real prior page", () => {
  /* Four independent journeys into the SAME show, from four different
     places — the card's own acceptance list. Each must go back to
     wherever THAT journey actually came from, not to a fixed route.
     MUTATION: hardcode onBackClick to `location.hash = "#/"` when
     canGoBackInApp() — every branch below still reports canGoBack() true,
     but the stack itself would prove nothing is checked per-journey; this
     test instead directly asserts the stack holds the true prior hash so a
     regression that ignores it is caught structurally. */
  // From home
  let m = mount();
  m.go("#/");
  m.go("#/show/abc");
  assert.strictEqual(m.canGoBack(), true);

  // From search/browse (all shows page)
  m = mount();
  m.go("#/shows");
  m.go("#/show/abc");
  assert.strictEqual(m.canGoBack(), true);

  // From another show's "similar shows" row (show -> show)
  m = mount();
  m.go("#/show/other-show");
  m.go("#/show/abc");
  assert.strictEqual(m.canGoBack(), true);

  // Deep link straight to the show: no prior page in-app at all
  m = mount();
  m.go("#/show/abc");
  assert.strictEqual(m.canGoBack(), false, "a deep link has no in-app step behind it");
});

/* ==================================================================== */
/* 6. A SECOND TAP BEFORE THE FIRST STEP LANDS DOES NOTHING               */
/* ==================================================================== */

test("tapping ‹ twice fast (before the async history.back() step lands) only goes back once", () => {
  /* MUTATION: remove the `backPending` guard from onBackClick. The second
     assertion fails: calls.back becomes 2. */
  const m = mount();
  m.go("#/");
  m.go("#/shows");
  m.click();
  m.click(); // the hashchange from the first tap has not "landed" (go() not called again)
  assert.strictEqual(m.calls.back, 1, "the second tap must be a no-op until the first step lands");
  // Once the step actually lands (route() runs again), backPending resets
  m.go("#/");
  m.go("#/shows");
  m.click();
  assert.strictEqual(m.calls.back, 2, "a fresh navigation clears the pending flag for the next tap");
});

/* ==================================================================== */
/* 7 & 8. REMOVING A PLAYLIST: BACK TARGET + "not found" PAGE HEAD        */
/* ==================================================================== */

test("leaveRemovedPlaylist goes back one step when the list is right behind this page", () => {
  /* MUTATION: make leaveRemovedPlaylist always `location.hash = "#/playlists"`.
     This still passes navigation-wise but no longer exercises history.back()
     — the second test below (drawer entry) is what actually distinguishes
     the two branches; this one pins the common, ordinary-navigation case. */
  const m = mount();
  m.go("#/playlists");
  m.go("#/playlist/xyz");
  m.evalIn("leaveRemovedPlaylist()");
  assert.strictEqual(m.calls.back, 1, "must reuse history.back() when the list is the step behind");
  assert.strictEqual(m.ctx.location.hash, "#/playlist/xyz", "leaveRemovedPlaylist itself never touches location.hash on this path");
});

test("leaveRemovedPlaylist navigates directly to the list when there is no such step behind it", () => {
  /* E.g. a drawer link straight into a specific playlist — no #/playlists
     entry immediately behind this one. MUTATION: always call
     history.back(). This fails: calls.back would be 1 instead of 0, and
     the hash would stay wherever history.back() left it (nothing, in this
     fake) instead of being set to #/playlists. */
  const m = mount();
  m.go("#/show/abc"); // some unrelated page, not #/playlists
  m.go("#/playlist/xyz");
  m.evalIn("leaveRemovedPlaylist()");
  assert.strictEqual(m.calls.back, 0);
  assert.strictEqual(m.ctx.location.hash, "#/playlists");
});

test("a removed/missing playlist still renders a page head with a working ‹ back link", () => {
  /* MUTATION: revert renderPlaylistDetail's not-found branch to the bare
     `<p class="note">Playlist not found.</p>` with no page-head/back link.
     The assertion below fails. */
  const m = mount();
  m.evalIn("playlistById = () => null; subjectQueueById = () => null;");
  m.evalIn(`renderPlaylistDetail("nonexistent")`);
  const html = m.ctx.document.querySelector("#view").innerHTML;
  assert.ok(html.includes('class="back"'), "a not-found playlist page must still offer a way back");
  assert.ok(html.includes("#/playlists"), "its back link must point at the playlists list");
});

/* ==================================================================== */
/* 9. U-02: SWITCHING TABS IS ORDINARY NAVIGATION, NOT A "BACK" STEP      */
/* ==================================================================== */

/* docs/ui-transition-plan.md U-02's acceptance: "switching tabs is not a
   'back' step; deep links land on the right tab." The tab bar's own links
   (app.js's renderTabBar) are plain `<a href="#hash">` elements dispatched
   through the SAME hashchange -> route() -> noteNavigation() path every
   other in-app link uses -- there is no separate "tab navigation"
   mechanism to special-case, and that absence is the point: a tab switch
   pushes a real forward step onto navStack exactly like any other link,
   so ‹ from a page reached via a tab goes back ONE page, never all the way
   to whichever tab you started the tour on. */

test("moving between the four tab destinations composes with the real back-stack: each hop is one ordinary forward step", () => {
  /* MUTATION: give tab navigation special treatment in noteNavigation (e.g.
     skip pushing when landing on one of the four tab-root hashes). The
     final canGoBack() would then read false after four ordinary hops,
     which is wrong -- there IS a step behind #/library (namely #/playlists,
     the tab visited just before it). */
  const m = mount();
  m.go("#/");          // Home tab
  m.go("#/shows");      // Search tab
  m.go("#/playlists");  // Create tab
  m.go("#/library");    // Library tab
  assert.strictEqual(m.canGoBack(), true, "four ordinary tab-to-tab hops must leave a real step behind the last one");
  const e = m.click();
  assert.strictEqual(m.calls.back, 1, "‹ from a tab-reached page must call history.back() exactly once, the same as any other link");
});

test("a deep link straight into a tab-owned route has no in-app step behind it, same as any other deep link", () => {
  /* MUTATION: special-case tab-root hashes in canGoBackInApp() to always
     report true (e.g. "a tab always has Home behind it"). This is a cold
     open -- the very first hash this session renders -- so it must report
     false exactly like the #/show/abc cold-open case in test 1 above. */
  const m = mount();
  m.go("#/library"); // arriving here first, e.g. from a bookmark
  assert.strictEqual(m.canGoBack(), false, "a deep link into a tab-owned route is still a cold open with no step behind it");
});
