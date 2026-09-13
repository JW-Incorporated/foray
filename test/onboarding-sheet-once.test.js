/* The onboarding sheet mounts once per visit, however many times Home renders.
 *
 * THE BUG THIS PINS, found 2026-09-13 by test/playwright/drawer-and-close.spec.js
 * failing in CI inside its own `openApp()` helper:
 *
 *     strict mode violation: locator('#first-time-sheet-skip')
 *     resolved to 2 elements
 *
 * and, before that, a three-minute `locator.click` timeout in which the second
 * sheet intercepted every click aimed at the first. Two `#first-time-sheet`
 * nodes, duplicate ids, stacked — and the app unusable behind them.
 *
 * WHY IT HAPPENS. `showFirstTimeExplainerOnce()` guarded only on PERSISTED
 * state: "is this a genuinely first-time profile" and "has `cp_intro_dismissed`
 * been written". Neither flips until the listener dismisses the sheet, so any
 * second render of Home before that mounts a second sheet. Home does re-render
 * on its own — `refreshForayDirectory("boot")` is fired unawaited by `init()`
 * and repaints every Foray surface when a newer directory is adopted, and
 * `isForaySurface("#/")` is true. So it is a race between that fetch landing
 * and a thumb, which is why it is invisible on a fast machine and reliable on a
 * loaded one (reproduced locally only under `CI=1`: two workers, all specs in
 * parallel; a single-spec run never showed it).
 *
 * NOT A REGRESSION FROM THE SHEET WORK. `git log -S` puts the unguarded early
 * return in #373 (2026-08-30) and the repaint call site in #610 (2026-09-10).
 * It is pinned here because it was found here.
 *
 * WHY A UNIT TEST AS WELL AS THE PLAYWRIGHT SPEC. The spec only catches this
 * when the machine is slow enough to lose the race — it went green on a quiet
 * box and red under load, which is the definition of a test you cannot rely on
 * to tell you the bug is back. These assertions call the function twice on
 * purpose and do not care about timing at all.
 *
 * Harness: the same node:vm DOM stub test/collapsing-header-scroll.test.js and
 * test/route-scroll-position.test.js use, extended with a real
 * getElementById/querySelector over a live element registry, because "is one
 * already in the document" is precisely the question under test.
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

/** A DOM stub with real parent/child links, because the guard under test reads
    the document rather than a variable. `mounted` is every element currently
    reachable from <body>, which is what `$("#id")` has to answer from. */
function makeDom() {
  const mounted = new Set();
  function makeEl(tag) {
    const classes = new Set();
    const el = {
      tagName: String(tag).toUpperCase(), id: "", className: "", innerHTML: "",
      textContent: "", value: "", hidden: false, disabled: false, checked: false,
      dataset: {}, style: { setProperty() {} }, children: [], parent: null,
      offsetHeight: 0,
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c),
        toggle(c, force) {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) classes.add(c); else classes.delete(c);
          return on;
        },
        contains: (c) => classes.has(c),
      },
      addEventListener() {}, removeEventListener() {},
      appendChild(k) { k.parent = el; el.children.push(k); mark(k, true); return k; },
      append(...ks) { ks.forEach((k) => el.appendChild(k)); },
      insertBefore(k) { return el.appendChild(k); },
      setAttribute() {}, getAttribute: () => null, removeAttribute() {},
      querySelector: () => null, querySelectorAll: () => [],
      closest: () => null, focus() {}, select() {}, click() {},
      remove() {
        if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
        el.parent = null;
        mark(el, false);
      },
    };
    return el;
  }
  function mark(el, on) {
    if (on) mounted.add(el); else mounted.delete(el);
    (el.children || []).forEach((c) => mark(c, on));
  }
  const body = makeEl("body");
  mounted.add(body);
  const byId = (id) => [...mounted].find((e) => e.id === id) || null;
  return { makeEl, body, byId, mounted };
}

function mount() {
  const dom = makeDom();
  const view = dom.makeEl("div");
  view.id = "view";
  dom.body.appendChild(view);
  const store = new Map();
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: {
      body: dom.body, documentElement: dom.body, readyState: "complete",
      addEventListener() {}, createElement: (t) => dom.makeEl(t),
      getElementById: dom.byId,
      querySelector: (sel) => {
        const s = String(sel);
        return s.startsWith("#") && !s.includes(" ") ? dom.byId(s.slice(1)) : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { scrollRestoration: "auto", back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    scrollY: 0, scrollTo() {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, dom,
    countById: (id) => [...dom.mounted].filter((e) => e.id === id).length,
  };
}

/* ==================================================================== */
/* THE DUPLICATE MOUNT                                                   */
/* ==================================================================== */

test("a second Home render does not mount a second first-time sheet", () => {
  /* THE REPORTED FAILURE, reduced to the two calls that cause it. The second
     call stands in for `refreshForayDirectory`'s repaint arriving before the
     listener has dismissed anything — which is exactly the state the guards
     could not see, because neither `cp_intro_dismissed` nor the first-time
     check changes until dismissal.

     MUTATION: delete `if ($("#first-time-sheet")) return true;` from
     showFirstTimeExplainerOnce(). This fails with a count of 2, and the
     Playwright suite's `openApp()` starts timing out on a loaded machine. */
  const m = mount();
  const first = m.evalIn("showFirstTimeExplainerOnce()");
  assert.strictEqual(first, true, "fixture assumption: a fresh profile gets the explainer");
  assert.strictEqual(m.countById("first-time-sheet"), 1);

  m.evalIn("showFirstTimeExplainerOnce()");
  assert.strictEqual(
    m.countById("first-time-sheet"), 1,
    "a repaint before dismissal must not mount a second sheet with duplicate ids"
  );
});

test("the second call reports that the explainer still owns the visit", () => {
  /* The return value is read as `if (!showFirstTimeExplainerOnce())
     showIntroPopupOnce()`. Answering `false` while a sheet is on screen opens
     the OLDER popup on top of the newer one — the same bug, different id.
     MUTATION: change the early return to `return false;`. This fails, and so
     does the intro-popup assertion below. */
  const m = mount();
  m.evalIn("showFirstTimeExplainerOnce()");
  assert.strictEqual(m.evalIn("showFirstTimeExplainerOnce()"), true);
});

test("the caller's own sequence never stacks the explainer and the older popup", () => {
  /* The real call site, run twice: `if (!showFirstTimeExplainerOnce())
     showIntroPopupOnce();`. Exactly one dialog, of one kind, after two renders.
     MUTATION: either early return removed — this fails on one of the two
     counts. */
  const m = mount();
  const render = "if (!showFirstTimeExplainerOnce()) showIntroPopupOnce();";
  m.evalIn(render);
  m.evalIn(render);
  assert.strictEqual(m.countById("first-time-sheet"), 1, "one explainer");
  assert.strictEqual(m.countById("intro-sheet"), 0, "and no popup stacked behind it");
});

test("the older intro popup is idempotent on its own account too", () => {
  /* Reachable by RETURNING users, who never satisfy isGenuineFirstTimeUser(),
     so this function has only ever had one persisted flag between it and a
     duplicate mount — the same exposure, on a path the first-time check does
     not cover.
     MUTATION: delete `if ($("#intro-sheet")) return;` from
     showIntroPopupOnce(). This fails with a count of 2. */
  const m = mount();
  m.evalIn("showIntroPopupOnce()");
  assert.strictEqual(m.countById("intro-sheet"), 1, "fixture assumption: the popup mounts");
  m.evalIn("showIntroPopupOnce()");
  assert.strictEqual(m.countById("intro-sheet"), 1);
});

test("dismissing still works, and a later render does not bring it back", () => {
  /* The guard must not become a way for a dismissed sheet to resurrect: once
     `cp_intro_dismissed` is written, the persisted gate is what answers, and
     the idempotency check has nothing left to see.
     MUTATION: delete the `cp_intro_dismissed` early return. This fails. */
  const m = mount();
  m.evalIn("showFirstTimeExplainerOnce()");
  m.evalIn('document.getElementById("first-time-sheet").remove()');
  m.evalIn('lsSet("cp_intro_dismissed", true)');
  assert.strictEqual(m.evalIn("showFirstTimeExplainerOnce()"), false);
  assert.strictEqual(m.countById("first-time-sheet"), 0, "a dismissed explainer stays dismissed");
});

test("the idempotency check is LAST — it never answers a question about who the listener is", () => {
  /* A stale DOM node must not be able to report that an EXISTING user is
     seeing the first-time screen. A first draft of this fix put the check
     first and turned two tests in test/first-time-onboarding.test.js red in
     CI, because that suite's DOM stub answers `querySelector` with a fresh
     truthy element for every selector — so the check short-circuited and an
     existing user came back as `true`. The stub is crude; the ordering was
     genuinely wrong, and this pins the order rather than the stub.

     Both halves are asserted WITH a sheet already mounted, because that is
     the only state in which the ordering is observable at all.

     MUTATION: move `if ($("#first-time-sheet")) return true;` above the
     `isGenuineFirstTimeUser()` / `cp_intro_dismissed` gates. Both assertions
     below fail, and so do those two first-time-onboarding tests. */
  const existing = mount();
  existing.evalIn("showFirstTimeExplainerOnce()");
  existing.evalIn('lsSet("cp_history", ["ep-1"])');
  assert.strictEqual(existing.evalIn("isGenuineFirstTimeUser()"), false, "fixture: now an existing user");
  assert.strictEqual(
    existing.evalIn("showFirstTimeExplainerOnce()"), false,
    "an existing user must be reported as not seeing the explainer, sheet on screen or not"
  );

  const dismissed = mount();
  dismissed.evalIn("showFirstTimeExplainerOnce()");
  dismissed.evalIn('lsSet("cp_intro_dismissed", true)');
  assert.strictEqual(
    dismissed.evalIn("showFirstTimeExplainerOnce()"), false,
    "a dismissed intro must be reported as dismissed, even with a sheet still in the DOM"
  );
});
