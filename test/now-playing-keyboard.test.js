/* The now-playing bar must not be on screen while a soft keyboard is up.
 *
 * FOUNDER REPORT, 2026-09-13, verbatim: "When I'm searching episodes on a show
 * page, the now playing bar is down at the bottom behind the keyboard (good).
 * When I start scrolling that now playing bar eventually moves up onto the top
 * of the keyboard (bad). When the keyboard is present the now playing bar
 * should not be visible."
 *
 * WHAT IS ACTUALLY TESTABLE HERE, stated plainly rather than papered over.
 * The bug itself is a WKWebView layout behaviour — `position: fixed` resolves
 * against the layout viewport until the page is scrolled, at which point
 * WebKit re-anchors fixed elements to the visual viewport and the bar jumps up
 * onto the keyboard. No unit test can reproduce that; it needs an iPhone. What
 * a unit test CAN do, and what this file does, is pin every part of the fix
 * that is ours:
 *
 *   - the decision function: what counts as "a keyboard is open", including
 *     the two ways it must answer "no" (nothing focused; no visualViewport);
 *   - the wiring: which events are subscribed, on which object;
 *   - the toggle: `body.kb-open` goes on and, crucially, comes OFF again —
 *     two independent ways, because a bar left permanently hidden would be a
 *     worse bug than the one being fixed;
 *   - teardown: every listener added is removed, and the class with them;
 *   - that the class is load-bearing: styles.css actually hides the bar.
 *
 * WHAT STILL NEEDS A DEVICE, and is deliberately NOT asserted here: that iOS's
 * reported `visualViewport.height` drop for the system keyboard clears the
 * 120px threshold (it is ~290-340pt on every current iPhone, so this is a wide
 * margin, but it is a measurement, not a guarantee); that the class lands
 * before the re-anchor repaint rather than one frame after it; and that
 * dismissing the keyboard by swipe-down — which blurs nothing on some
 * WebViews — still fires the `resize` this relies on. The `focusout` handler
 * exists as the second escape hatch precisely because that last one is the
 * case we cannot prove from here.
 *
 * Harness: the same node:vm evaluation of app.js the other show-page suites
 * use, but the window under test is a purpose-built fake passed straight to
 * installKeyboardChrome(win) — the function takes its window as an argument
 * exactly so this is possible without simulating a whole WebView.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const STYLES_SRC = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results",
];

/* app.js is evaluated once per test file, only so its top-level function
   declarations (installKeyboardChrome, keyboardIsOpen) are reachable. The
   context it boots in has no `visualViewport`, so the install() that init()
   itself performs is a no-op and cannot interfere with the fake windows
   below — which is itself the behaviour test 6 asserts. */
function loadApp() {
  const body = makeEl("body");
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, removeEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => {
        const s = String(sel);
        if (s.startsWith("#") && !s.includes(" ")) return byId.get(s.slice(1)) ?? null;
        return null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
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
  return ctx;
}

const APP = loadApp();

/* A window whose viewport we can move, whose listeners we can count, and
   whose focus we can place. `innerHeight` is the layout viewport and never
   changes — that is the whole point: on iOS the keyboard does not shrink it,
   which is why `visualViewport.height` is the signal. */
function fakeWindow({ innerHeight = 800, vvHeight = 800, withVisualViewport = true, activeElement = null } = {}) {
  const listeners = []; // { target, type, fn }
  const classes = new Set();
  const body = {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
  };
  const mk = (target, name) => ({
    addEventListener: (type, fn, opts) => { listeners.push({ target: name, type, fn, opts }); },
    removeEventListener: (type, fn, opts) => {
      const i = listeners.findIndex((l) => l.target === name && l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  });
  const doc = { body, activeElement, ...mk(null, "document") };
  const vv = withVisualViewport ? { height: vvHeight, offsetTop: 0, ...mk(null, "vv") } : undefined;
  const win = { innerHeight, document: doc, visualViewport: vv };
  return {
    win, doc, vv, listeners, classes,
    has: (c) => classes.has(c),
    fire: (target, type) => {
      for (const l of listeners.slice()) if (l.target === target && l.type === type) l.fn({});
    },
    count: (target, type) => listeners.filter((l) => l.target === target && (!type || l.type === type)).length,
  };
}

function editable() { return { tagName: "INPUT", isContentEditable: false }; }
function notEditable() { return { tagName: "DIV", isContentEditable: false }; }
const nextTick = () => new Promise((r) => setTimeout(r, 5));

test("a keyboard-sized viewport inset with a text field focused hides the now-playing bar", async () => {
  /* The founder's case. MUTATION: invert or drop the KEYBOARD_MIN_INSET
     comparison in keyboardIsOpen (e.g. return false unconditionally). This
     assertion fails because `kb-open` would never be applied. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 800, activeElement: editable() });
  const teardown = APP.installKeyboardChrome(f.win);
  assert.strictEqual(f.has("kb-open"), false, "no keyboard at install time: the bar stays visible");

  f.vv.height = 460; // ~340px of keyboard
  f.fire("vv", "resize");
  assert.strictEqual(f.has("kb-open"), true, "a >120px viewport inset with a field focused must hide the bar");
  teardown();
});

test("the bar comes back the moment the keyboard closes — the class must never stick", async () => {
  /* The failure mode that would be WORSE than the bug being fixed: a
     permanently hidden player. MUTATION: make installKeyboardChrome's apply()
     only ever add the class (`if (open) classList.add(...)`) instead of
     toggling on the computed value. This assertion fails because the class
     would survive the keyboard closing. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 460, activeElement: editable() });
  const teardown = APP.installKeyboardChrome(f.win);
  assert.strictEqual(f.has("kb-open"), true, "sanity: hidden while the keyboard is up");

  f.vv.height = 800;
  f.fire("vv", "resize");
  assert.strictEqual(f.has("kb-open"), false, "closing the keyboard must restore the bar");
  teardown();
});

test("focusout restores the bar even if no resize follows — the second escape hatch", async () => {
  /* Some WebViews dismiss the keyboard (swipe-down, an interactive dismiss)
     without a `resize` this code would see. MUTATION: drop the document
     `focusout` subscription. This assertion fails because, with the viewport
     left short and no resize fired, nothing would ever clear the class. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 460, activeElement: editable() });
  const teardown = APP.installKeyboardChrome(f.win);
  assert.strictEqual(f.has("kb-open"), true, "sanity: hidden while the field is focused");

  f.doc.activeElement = notEditable();
  f.fire("document", "focusout");
  await nextTick(); // the handler re-evaluates on the next turn, after focus has settled
  assert.strictEqual(f.has("kb-open"), false, "losing focus must restore the bar even with no resize");
  teardown();
});

test("a short visual viewport with nothing editable focused never hides the bar", async () => {
  /* The conjunct that keeps every other cause of a short viewport — a
     rotation mid-animation, a splash fade, a WebView mis-report — from
     blanking the player. MUTATION: drop `&& editableHasFocus(doc)` from
     apply(). This assertion fails because the inset alone would hide it. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 400, activeElement: notEditable() });
  const teardown = APP.installKeyboardChrome(f.win);
  f.fire("vv", "resize");
  assert.strictEqual(f.has("kb-open"), false, "a keyboard cannot be open with nothing focused; the bar must stay");
  teardown();
});

test("it subscribes to visualViewport resize AND scroll, and teardown removes every listener it added", async () => {
  /* `scroll` is not decorative: it is the exact event during which WebKit
     re-anchors fixed elements, which is the frame the founder watched the bar
     jump in. MUTATION: drop the `vv.addEventListener("scroll", apply)` line —
     the first assertion fails. MUTATION: drop any removeEventListener from the
     returned teardown — the last assertion fails. */
  const f = fakeWindow({ innerHeight: 800, vvHeight: 800, activeElement: editable() });
  const teardown = APP.installKeyboardChrome(f.win);

  const types = f.listeners.filter((l) => l.target === "vv").map((l) => l.type).sort();
  assert.deepStrictEqual(types, ["resize", "scroll"], `must listen for both viewport events, got: ${JSON.stringify(types)}`);
  assert.strictEqual(f.count("document", "focusout"), 1, "must listen for focusout on the document");

  f.vv.height = 460;
  f.fire("vv", "scroll");
  assert.strictEqual(f.has("kb-open"), true, "a scroll must re-evaluate, not just a resize");

  teardown();
  assert.strictEqual(f.listeners.length, 0, `teardown must remove every listener, ${f.listeners.length} left`);
  assert.strictEqual(f.has("kb-open"), false, "teardown must also clear the class it may have set");
});

test("no visualViewport (older WebView, desktop Safari, a test stub): installs nothing and never hides the bar", async () => {
  /* Fail-open, deliberately: where the keyboard cannot be detected, the bar
     keeps behaving exactly as it did before this change rather than guessing.
     MUTATION: drop the `if (!vv || ...) return () => {}` guard. This throws or
     hides the bar spuriously instead of returning a harmless no-op. */
  const f = fakeWindow({ withVisualViewport: false, activeElement: editable() });
  const teardown = APP.installKeyboardChrome(f.win);
  assert.strictEqual(typeof teardown, "function", "must still return a teardown function");
  assert.strictEqual(f.listeners.length, 0, "must subscribe to nothing it cannot use");
  assert.strictEqual(f.has("kb-open"), false, "and must never hide the bar it cannot reason about");
  teardown(); // must not throw
});

test("the class is load-bearing: styles.css actually takes #foray-player off the screen", async () => {
  /* app.js only sets a class; the hiding is CSS. Without this the whole fix
     could pass its own tests while changing nothing a listener sees.
     MUTATION: delete the `body.kb-open #foray-player` rule from styles.css.
     This assertion fails. */
  const rule = /body\.kb-open\s+#foray-player\s*\{[^}]*display:\s*none/;
  assert.match(STYLES_SRC, rule, "styles.css must hide #foray-player while body.kb-open is set");
});
