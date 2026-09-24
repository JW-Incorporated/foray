/* The drawer leaves when it is used (founder, 2026-09-23).
 *
 * THE TWO REPORTS, verbatim:
 *   3. "When I select Playback Diagnostics from the menu, the menu should
 *      automatically collapse but it does not."
 *   4. "When I click outside the menu on the playback diagnostics, the menu
 *      does not collapse when it should. If I click above the playback
 *      diagnostics, where I can see a corner of the Home Screen, it will
 *      collapse both the menu and the playback diagnostics."
 *
 * WHAT WAS WRONG. The drawer closed for links only; every BUTTON in it opened
 * its sheet under a drawer that stayed, and the sheet then inerted the drawer
 * — a panel painted over everything that took no taps. Report 4 is report 3's
 * consequence. The fix is one rule in one place (`onDrawerAction`, app.js):
 * any control with a destination closes the drawer, in the capture phase,
 * before it acts; a control that stays declares it (`data-drawer-stay`, the
 * Developer <summary>). This file pins the rule, the two declared stays, what
 * the overlay and a scrim each close, where focus goes, and the founder's
 * exact tap sequence.
 *
 * THE HARNESS. The real app.js in node:vm over a DOM that has what these
 * questions need and the other harnesses lack: EVENT PROPAGATION — capture
 * down, target, bubble up — because the rule is a capture-phase listener on
 * the drawer and "before the item acts" is an ordering claim; plus real
 * parent links, `hidden`, `inert` honoured by dispatch (a tap on an inert
 * subtree reaches nothing, as in a browser's hit-test), `closest`/`matches`
 * over simple selectors and a `document.activeElement` that `focus()` moves.
 * Not shared with test/modal-and-focus.test.js on purpose: two suites coupled
 * through one harness is how one of them stops covering anything.
 *
 * WHAT IT CANNOT PROVE, said plainly: that WKWebView's hit-testing agrees with
 * this dispatch about which of two overlapping fixed layers a finger reaches.
 * That is the founder's next build; this proves the app no longer puts two
 * overlapping layers there.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

process.on("unhandledRejection", () => {});

/* ---------- a DOM with a tree, propagation, inert, focus ---------- */

function makeDocument() {
  const doc = { activeElement: null, _listeners: new Map() };

  function matchCompound(el, sel) {
    let s = sel.trim();
    const nots = [];
    s = s.replace(/:not\(([^)]*)\)/g, (_m, inner) => { nots.push(inner); return ""; });
    const tag = /^[a-z][\w-]*/i.exec(s);
    if (tag && el.tagName !== tag[0].toUpperCase()) return false;
    for (const m of s.matchAll(/#([\w-]+)/g)) if (el.id !== m[1]) return false;
    for (const m of s.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(m[1])) return false;
    for (const m of s.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      const v = el.getAttribute(m[1]);
      if (v == null) return false;
      if (m[2] !== undefined && v !== m[2]) return false;
    }
    for (const n of nots) if (matchCompound(el, n)) return false;
    return true;
  }
  const matches = (el, sel) => String(sel).split(",").some((p) => matchCompound(el, p));

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentElement = null;
      this._attrs = new Map();
      this._cls = new Set();
      this._on = new Map();
      this.dataset = {};
      this.style = { setProperty() {}, removeProperty() {} };
      this.textContent = "";
      this.value = "";
      this.type = "";
      const self = this;
      this.classList = {
        add: (...c) => c.forEach((x) => self._cls.add(x)),
        remove: (...c) => c.forEach((x) => self._cls.delete(x)),
        contains: (c) => self._cls.has(c),
        toggle(c, force) {
          const on = force === undefined ? !self._cls.has(c) : !!force;
          if (on) self._cls.add(c); else self._cls.delete(c);
          return on;
        },
      };
    }
    get className() { return [...this._cls].join(" "); }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get id() { return this._attrs.get("id") || ""; }
    set id(v) { this._attrs.set("id", String(v)); }
    get hidden() { return this._attrs.has("hidden"); }
    set hidden(v) { if (v) this._attrs.set("hidden", ""); else this._attrs.delete("hidden"); }
    get disabled() { return this._attrs.has("disabled"); }
    set disabled(v) { if (v) this._attrs.set("disabled", ""); else this._attrs.delete("disabled"); }
    get isConnected() {
      let n = this;
      while (n) { if (n === doc.body) return true; n = n.parentElement; }
      return false;
    }
    setAttribute(k, v) { this._attrs.set(k, String(v)); }
    getAttribute(k) {
      if (k.startsWith("data-")) {
        const key = k.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
        if (key in this.dataset) return String(this.dataset[key]);
      }
      return this._attrs.has(k) ? this._attrs.get(k) : null;
    }
    hasAttribute(k) { return this.getAttribute(k) !== null; }
    removeAttribute(k) { this._attrs.delete(k); }
    appendChild(k) { if (k.parentElement) k.remove(); k.parentElement = this; this.children.push(k); return k; }
    append(...ks) { ks.forEach((k) => this.appendChild(k)); }
    insertBefore(k, ref) {
      if (k.parentElement) k.remove();
      k.parentElement = this;
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(k); else this.children.splice(i, 0, k);
      return k;
    }
    get nextSibling() {
      const p = this.parentElement;
      if (!p) return null;
      return p.children[p.children.indexOf(this) + 1] || null;
    }
    get parentNode() { return this.parentElement; }
    get firstChild() { return this.children[0] || null; }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
      this.parentElement = null;
    }
    contains(o) { for (let n = o; n; n = n.parentElement) if (n === this) return true; return false; }
    matches(sel) { return matches(this, sel); }
    closest(sel) { for (let n = this; n; n = n.parentElement) if (matches(n, sel)) return n; return null; }
    tree() { return this.children.flatMap((c) => [c, ...c.tree()]); }
    querySelectorAll(sel) { return this.tree().filter((e) => matches(e, sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    set innerHTML(v) { this.children.forEach((c) => { c.parentElement = null; }); this.children = []; this._html = String(v); }
    get innerHTML() { return this._html || ""; }
    focus() { doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    select() {}
    getBoundingClientRect() { return { top: 0, left: 0, width: 40, height: 40 }; }
    addEventListener(t, fn, opts) {
      const capture = opts === true || !!(opts && opts.capture === true);
      if (!this._on.has(t)) this._on.set(t, []);
      this._on.get(t).push({ fn, capture });
    }
    removeEventListener(t, fn) {
      if (!this._on.has(t)) return;
      this._on.set(t, this._on.get(t).filter((l) => l.fn !== fn));
    }
    /** A browser-shaped dispatch: a tap on an inert subtree reaches nothing
        (hit-testing skips inert), otherwise capture from <body> down, the
        target, then bubble up. `stopPropagation` and `preventDefault` work. */
    dispatch(type) {
      for (let n = this; n; n = n.parentElement) if (n.hasAttribute("inert")) return { reached: false };
      const chain = [];
      for (let n = this; n; n = n.parentElement) chain.push(n);
      const ev = {
        type, target: this, currentTarget: null, _stopped: false, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this._stopped = true; },
      };
      const run = (node, capture) => {
        for (const { fn, capture: c } of [...(node._on.get(type) || [])]) {
          if (c !== capture) continue;
          ev.currentTarget = node;
          fn(ev);
          if (ev._stopped) return false;
        }
        return true;
      };
      for (const node of [...chain].reverse()) if (node !== this && !run(node, true)) return { reached: true, ev };
      if (!run(this, true) || !run(this, false)) return { reached: true, ev };
      for (const node of chain) if (node !== this && !run(node, false)) return { reached: true, ev };
      return { reached: true, ev };
    }
    click() { return this.dispatch("click"); }
  }

  doc.body = new El("body");
  doc.documentElement = new El("html");
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  doc.createElement = (t) => new El(t);
  doc.querySelector = (s) => doc.body.querySelector(s);
  doc.querySelectorAll = (s) => doc.body.querySelectorAll(s);
  doc.getElementById = (id) => doc.body.querySelectorAll(`#${id}`)[0] || null;
  doc.addEventListener = (t, fn) => { if (!doc._listeners.has(t)) doc._listeners.set(t, []); doc._listeners.get(t).push(fn); };
  doc.removeEventListener = () => {};
  doc.readyState = "complete";
  doc.key = (key, extra = {}) => {
    const ev = { key, preventDefault() {}, ...extra };
    (doc._listeners.get("keydown") || []).forEach((fn) => fn(ev));
  };
  return { doc, El };
}

/**
 * Mount app.js over the chrome index.html gives it: the ☰ in a topbar, the
 * drawer with its two markup-borne toggles and a Settings label, the overlay,
 * and #view. `boot: true` lets the REAL init() wire everything, serving the
 * committed data/*.json off disk; otherwise the harness calls the binders init
 * would, which is faster and is what every test but one uses.
 */
function mount({ boot = false, capacitor = null } = {}) {
  const { doc } = makeDocument();
  const add = (tag, id, cls, into = doc.body) => {
    const el = doc.createElement(tag);
    if (id) el.id = id;
    if (cls) el.className = cls;
    into.appendChild(el);
    return el;
  };
  const topbar = add("header", null, "topbar");
  const menu = add("button", "menu-btn", null, topbar);
  add("button", "refresh-btn", null, topbar);
  const overlay = add("div", "drawer-overlay");
  overlay.hidden = true;
  const drawer = add("nav", "drawer");
  drawer.hidden = true;
  const home = add("a", null, "drawer-section", drawer);
  home.setAttribute("href", "#/");
  add("div", "drawer-playlists", null, drawer);
  add("div", null, "drawer-section-label", drawer);
  add("button", "family-toggle", "drawer-item as-btn", drawer);
  add("button", "autoadvance-toggle", "drawer-item as-btn", drawer);
  add("button", "player-toggle", "drawer-item as-btn", drawer);
  const view = add("main", "view");
  for (const id of ["banner-slot", "pl-form", "pl-input", "pl-note", "tab-topics", "tab-shows",
    "sh-form", "sh-input", "sh-note", "sh-results", "browse-all-link", "pl-remove", "banner-done"]) {
    add("div", id, null, view);
  }

  const store = new Map();
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => {
      if (!boot) return new Promise(() => {});
      const file = path.join(ROOT, String(url));
      const ok = fs.existsSync(file);
      return Promise.resolve({
        ok, status: ok ? 200 : 404,
        json: async () => JSON.parse(fs.readFileSync(file, "utf8")),
      });
    },
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: doc,
    navigator: { userAgent: "node", clipboard: { writeText: async () => {} } },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { scrollRestoration: "auto", back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    encodeURIComponent, decodeURIComponent,
    scrollY: 0, scrollTo() {}, scrollBy() {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  /* The shell's bridge, when a test stands in for the native app: only the
     App plugin's back button is modelled. */
  if (capacitor) ctx.Capacitor = capacitor;
  vm.createContext(ctx);
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  ctx.window.forayDiagnosticReport = () => "4a playback diagnostics — v1";
  ctx.window.forayDiagnosticClear = () => true;
  if (boot) {
    ctx.window.ForayPlayer = {
      listForays: () => [], forayResumeList: () => [], forayResume: () => null,
      forayDriftIsClean: () => true, canPlay: () => false,
      fmtClock: (n) => String(Math.round(n)), fmtSpan: (n) => `${Math.round(n)}s`, resolve: () => null,
    };
  } else {
    ctx.bindDrawerChrome();
    ctx.bindDrawerToggles();
    ctx.bindDeveloperToggles();
    ctx.bindDiagnosticsControl();
    ctx.bindDeleteControl();
    /* init() also runs here — the document is "complete" — but its boot fetch
       never answers in this mode, so it stops before the line that binds the
       chrome and leaves ☰/↻ disabled (nav-9, test/boot-path.test.js). The
       binders above ARE that line's work, so its last step is taken too. */
    ctx.setBootChrome(true);
  }
  const $ = (s) => doc.body.querySelector(s);
  return { ctx, doc, $, menu, drawer, overlay, view, store };
}

async function mountBooted(opts = {}) {
  const m = mount({ boot: true, ...opts });
  for (let i = 0; i < 60 && !m.$("#diag-open"); i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(m.$("#diag-open"), "the real init() never wired the drawer");
  return m;
}

const isInert = (el) => el.hasAttribute("inert");

/* ==================================================================== */
/* 1. the founder's item 3: a destination closes the drawer              */
/* ==================================================================== */

test("selecting Playback diagnostics from the drawer closes the drawer and opens the sheet", () => {
  /* MUTATION: drop `onDrawerAction`'s `openDrawer(false)` (or the whole capture
     listener in bindDrawerChrome). The drawer stays open; red. */
  const m = mount();
  m.menu.click();
  assert.strictEqual(m.drawer.hidden, false, "the ☰ opens the drawer");
  m.$("#diag-open").click();
  assert.strictEqual(m.drawer.hidden, true, "the drawer must collapse when an item is selected");
  assert.strictEqual(m.overlay.hidden, true, "…and its overlay with it");
  assert.strictEqual(m.$("#diag-sheet").hidden, false, "the sheet the item opens is up");
  assert.strictEqual(m.ctx.openSheetCount(), 1);
});

test("the drawer closes BEFORE the item acts: the sheet never inerts a drawer that is still showing", () => {
  /* The order is the mechanism. If the drawer closed AFTER the sheet opened
     (a bubble-phase listener, or a close inside each sheet's own opener), the
     sheet's `inertOutside` would have run against a visible drawer — which is
     exactly the "painted on top, takes no taps" state of report 4. The
     capture-phase close is observable from inside the item's handler: by the
     time it runs, the drawer is already hidden.
     MUTATION: change the `true` (capture) in bindDrawerChrome to `false`. Red. */
  const m = mount();
  m.menu.click();
  let hiddenWhenTheItemRan = null;
  m.$("#diag-open").addEventListener("click", () => { hiddenWhenTheItemRan = m.drawer.hidden; });
  m.$("#diag-open").click();
  assert.strictEqual(hiddenWhenTheItemRan, true, "the drawer must already be closed when the item's own handler runs");
});

test("EVERY destination leaves the drawer — Delete my data, the Home link — not the one item reported", () => {
  /* The fix is a rule, not a patch: a button that opens a sheet and a link
     that navigates both close the drawer through the same listener.
     MUTATION: narrow `closest("a, button, summary")` to `"a"` — the old
     behaviour. The buttons stop closing it; red. */
  const m = mount();
  for (const sel of ["#delete-data", ".drawer-section"]) {
    m.menu.click();
    assert.strictEqual(m.drawer.hidden, false);
    const item = m.$(sel);
    assert.ok(item, `${sel} is in the drawer`);
    item.click();
    assert.strictEqual(m.drawer.hidden, true, `${sel} must close the drawer`);
    m.ctx.closeAllSheets();
  }
});

test("a settings switch keeps the drawer open (Joey, 2026-08-31, survives the new rule)", () => {
  /* The rule closes for destinations; a toggle has none and declares it
     with `data-drawer-stay`. This is the one thing the 2026-08-31 fix pinned
     that the new rule could silently undo.
     MUTATION: remove `btn.dataset.drawerStay = "1"` from drawerToggle. Red. */
  const m = mount();
  m.menu.click();
  /* The switches that repaint the page (`repaint: true`) need the catalogue
     loaded; the un-booted harness has none, so the three that flip in place
     stand for all of them — every switch is built by the one `drawerToggle`. */
  for (const id of ["#autoadvance-toggle", "#interlude-toggle", "#voice-probe-toggle"]) {
    const btn = m.$(id);
    assert.ok(btn, `${id} exists`);
    btn.click();
    assert.strictEqual(m.drawer.hidden, false, `${id} flips in place; the drawer stays`);
  }
});

test("the Developer disclosure's summary keeps the drawer open too", () => {
  /* Expanding a <details> is not going anywhere. MUTATION: drop `summary`
     from DRAWER_STAYS_OPEN_FOR. Red. */
  const m = mount();
  m.menu.click();
  const summary = m.$("#drawer-dev summary");
  assert.ok(summary, "the Developer group has a summary");
  summary.click();
  assert.strictEqual(m.drawer.hidden, false);
});

/* ==================================================================== */
/* 2. the founder's item 4: what a tap outside closes                    */
/* ==================================================================== */

test("the founder's exact sequence: drawer -> Playback diagnostics -> tap the panel, then the scrim", () => {
  /* Report 4, step by step, against the fixed app: with the drawer gone, a
     tap on the diagnostics PANEL closes nothing (it is inside the sheet), a
     tap on the sheet's SCRIM closes the sheet, and afterwards nothing is
     left inert — no stranded overlay to trap the next tap. */
  const m = mount();
  m.menu.click();
  m.$("#diag-open").click();
  const sheet = m.$("#diag-sheet");
  const panel = sheet.querySelector(".fy-panel");
  const scrim = sheet.querySelector(".fy-scrim");
  assert.strictEqual(panel.dispatch("click").reached, true);
  assert.strictEqual(sheet.hidden, false, "a tap on the sheet itself closes nothing");
  assert.strictEqual(m.drawer.hidden, true);
  assert.strictEqual(scrim.dispatch("click").reached, true, "the scrim is reachable — nothing sits over it");
  assert.strictEqual(sheet.hidden, true, "a tap outside the sheet closes the sheet");
  assert.strictEqual(m.ctx.openSheetCount(), 0);
  for (const el of [m.drawer, m.overlay, m.view, m.menu.parentElement]) {
    assert.ok(!isInert(el), `${el.id || el.className} must not be left inert`);
  }
});

test("a tap on the drawer's overlay closes the drawer and nothing else, whatever is under it", () => {
  /* The Now Playing sheet keeps the ☰ and the drawer reachable (F17), so
     "drawer over a sheet" is a real state. The overlay must close ONLY the
     drawer: the sheet under it stays.
     MUTATION: make the overlay's listener call closeAllSheets() too. Red. */
  const m = mount();
  const wrap = m.doc.createElement("div");
  wrap.className = "fy-sheet";
  const panel = m.doc.createElement("div");
  panel.className = "fy-panel";
  panel.setAttribute("role", "dialog");
  wrap.appendChild(panel);
  m.ctx.openSheet(wrap, { keepReachable: [".topbar", "#drawer", "#drawer-overlay"] });
  m.menu.click();
  assert.strictEqual(m.drawer.hidden, false, "the drawer opens over the sheet");
  assert.ok(!isInert(m.overlay), "the overlay is reachable over a sheet that keeps it so");
  assert.strictEqual(m.overlay.dispatch("click").reached, true);
  assert.strictEqual(m.drawer.hidden, true, "the overlay closes the drawer");
  assert.strictEqual(wrap.hidden, false, "…and only the drawer");
  assert.strictEqual(m.ctx.openSheetCount(), 1);
});

test("a tap on a sheet's scrim closes that sheet only — stacked sheets close top-first", () => {
  /* Two sheets, the second over the first: the top scrim closes the top
     sheet; the lower one is untouched and its scrim then closes it. The
     drawer, closed throughout, stays closed. */
  const m = mount();
  const build = (id) => {
    const wrap = m.doc.createElement("div");
    wrap.className = "fy-sheet"; wrap.id = id;
    const scrim = m.doc.createElement("div"); scrim.className = "fy-scrim";
    const panel = m.doc.createElement("div"); panel.className = "fy-panel"; panel.setAttribute("role", "dialog");
    wrap.append(scrim, panel);
    scrim.addEventListener("click", () => m.ctx.closeSheet(wrap));
    return { wrap, scrim };
  };
  const lower = build("lower");
  const upper = build("upper");
  m.ctx.openSheet(lower.wrap);
  m.ctx.openSheet(upper.wrap);
  assert.strictEqual(lower.scrim.dispatch("click").reached, false, "the lower sheet is under the upper one and out of reach");
  assert.strictEqual(upper.scrim.dispatch("click").reached, true);
  assert.strictEqual(upper.wrap.hidden, true, "the top sheet closed");
  assert.strictEqual(lower.wrap.hidden, false, "the one under it did not");
  assert.strictEqual(lower.scrim.dispatch("click").reached, true, "…and is reachable again");
  assert.strictEqual(lower.wrap.hidden, true);
  assert.strictEqual(m.drawer.hidden, true);
});

/* ==================================================================== */
/* 3. where focus goes                                                   */
/* ==================================================================== */

test("closing a sheet opened from the drawer hands focus to the ☰, not to a button in a hidden drawer", () => {
  /* The sheet's opener was the drawer item; the drawer is hidden by the time
     the sheet closes, and focus on a hidden element is a silent no-op that
     lands on <body>. `openSheet` records the ☰ as the return point when the
     opener is in the drawer, and `closeSheet` skips an opener in a hidden
     subtree.
     MUTATION 1: drop the `fromDrawer` default in openSheet. MUTATION 2: drop
     `!inHiddenSubtree(el)` from closeSheet's candidate filter. Each is red. */
  const m = mount();
  m.menu.click();
  const item = m.$("#diag-open");
  item.focus();
  item.click();
  assert.strictEqual(m.drawer.hidden, true);
  m.ctx.closeSheet(m.$("#diag-sheet"));
  assert.strictEqual(m.doc.activeElement, m.menu, "focus returns to the control that opens the drawer");
});

test("a sheet opened from the page still returns focus to its opener (the drawer rule changes nothing there)", () => {
  const m = mount();
  const opener = m.doc.createElement("button");
  m.view.appendChild(opener);
  opener.focus();
  const wrap = m.doc.createElement("div");
  wrap.className = "fy-sheet";
  m.ctx.openSheet(wrap);
  m.ctx.closeSheet(wrap);
  assert.strictEqual(m.doc.activeElement, opener);
});

/* ==================================================================== */
/* 4. the real init() wires it                                           */
/* ==================================================================== */

test("THE REAL init() binds the rule (a booted page closes the drawer on Playback diagnostics)", async () => {
  /* Every other test calls `bindDrawerChrome()` itself, so deleting that call
     from `init()` would leave them all green — the "passed with the mechanism
     removed" shape test/diagnostics-surface.test.js records. One booted test.
     MUTATION: remove `bindDrawerChrome()` from init(). Red. */
  const m = await mountBooted();
  /* A booted first-time page opens its explainer, a real dialog that takes the
     ☰ out of reach (test/modal-and-focus.test.js pins that). Dismiss it the way
     a listener would before reaching for the menu. */
  m.ctx.closeAllSheets();
  m.menu.click();
  assert.strictEqual(m.drawer.hidden, false, "init() wired the ☰");
  m.$("#diag-open").click();
  assert.strictEqual(m.drawer.hidden, true, "init() wired the leave rule");
  assert.strictEqual(m.$("#diag-sheet").hidden, false);
});

/* ==================================================================== */
/* 5. AUDIT ROUND 2 (2026-09-23): the drawer is a modal, the same link   */
/*    again, and hardware back                                           */
/* ==================================================================== */

/** A `.fy-sheet` with a dialog panel, opened the way Now Playing opens: the
    topbar and the drawer kept reachable (F17), so "drawer over a sheet" is
    the state under test. */
function sheetUnderDrawer(m) {
  const wrap = m.doc.createElement("div");
  wrap.className = "fy-sheet";
  const panel = m.doc.createElement("div");
  panel.className = "fy-panel";
  panel.setAttribute("role", "dialog");
  wrap.appendChild(panel);
  m.ctx.openSheet(wrap, { keepReachable: [".topbar", "#drawer", "#drawer-overlay"] });
  return wrap;
}

test("ROUND 2 nav-5: opening the drawer locks the page, takes it out of reach, names itself on the menu button and moves focus to the first link", () => {
  /* MUTATION 1: drop `document.body.classList.toggle("drawer-open", ...)` ->
     the lock assertion is red (styles.css hangs `overflow: hidden` on it).
     MUTATION 2: drop `inertOutside(drawer, ...)` -> the page stays reachable
     under the scrim; red. MUTATION 3: drop `focusQuietly(first || drawer)` ->
     focus stays on the menu button; red. */
  const m = mount();
  const player = m.doc.createElement("div");
  player.id = "foray-player";
  m.doc.body.appendChild(player);
  m.menu.click();
  assert.ok(m.doc.body.classList.contains("drawer-open"), "body.drawer-open is the page's scroll lock");
  assert.ok(isInert(m.view) && isInert(player), "the page and the player are out of reach");
  assert.ok(!isInert(m.menu.parentElement) && !isInert(m.overlay) && !isInert(m.drawer), "the topbar, the scrim and the drawer are not");
  assert.strictEqual(m.doc.activeElement, m.$(".drawer-section"), "focus is on the first link");
  assert.strictEqual(m.menu.getAttribute("aria-expanded"), "true");
  assert.strictEqual(m.menu.getAttribute("aria-controls"), "drawer");
  m.overlay.click();
  assert.ok(!m.doc.body.classList.contains("drawer-open"), "closing drops the lock");
  assert.ok(!isInert(m.view) && !isInert(player), "and releases exactly what opening took");
  assert.strictEqual(m.menu.getAttribute("aria-expanded"), "false");
  assert.strictEqual(m.doc.activeElement, m.menu, "a dismissal hands focus back to the menu button");
});

test("ROUND 2 nav-5: Escape closes the drawer, and only the drawer when it is open over a sheet; the next Escape reaches the sheet", () => {
  /* MUTATION 1: drop the Escape branch from onDrawerKeydown -> red.
     MUTATION 2: drop the `if (drawerIsOpen()) { onDrawerKeydown(e); return; }`
     dispatch from onSheetKeydown -> Escape collapses the SHEET under a drawer
     that stays; the "not the sheet" assertion is red. */
  const m = mount();
  const wrap = sheetUnderDrawer(m);
  m.menu.click();
  assert.strictEqual(m.drawer.hidden, false);
  m.doc.key("Escape");
  assert.strictEqual(m.drawer.hidden, true, "Escape closes the drawer");
  assert.strictEqual(wrap.hidden, false, "and not the sheet under it");
  assert.strictEqual(m.doc.activeElement, m.menu, "focus returns to the menu button");
  m.doc.key("Escape");
  assert.strictEqual(wrap.hidden, true, "the next Escape is the sheet's");
});

test("ROUND 2 nav-5: while the drawer is open, Tab cycles the topbar and the drawer and nothing behind them", () => {
  /* The belt behind `inert` for a WebView without it, and what makes a Tab
     from the menu button walk INTO the open drawer rather than back into a
     covered sheet. MUTATION: drop the Tab branch from onDrawerKeydown -> Tab
     does nothing here and the cycle assertions are red. */
  const m = mount();
  sheetUnderDrawer(m);
  m.menu.click();
  const first = m.$(".drawer-section");
  assert.strictEqual(m.doc.activeElement, first);
  m.doc.key("Tab", { shiftKey: true });
  assert.ok(m.menu.parentElement.contains(m.doc.activeElement), "Shift+Tab from the first link goes up into the topbar");
  m.menu.focus();
  m.doc.key("Tab", { shiftKey: true });
  assert.ok(m.drawer.contains(m.doc.activeElement), "Shift+Tab from the menu button wraps to the drawer's last control");
  m.menu.focus();
  m.doc.key("Tab");
  m.doc.key("Tab");
  assert.strictEqual(m.doc.activeElement, first, "from the menu button, Tab walks through the topbar into the open drawer");
});

test("ROUND 2 nav-8: a drawer link to the page already on screen closes the sheets and scrolls to the top", () => {
  /* The same hash fires no hashchange, so route() never ran and the tap did
     nothing; under Now Playing it left the sheet covering the page asked for.
     MUTATION: drop `sameHashTap(item, e)` from onDrawerAction -> red. */
  const m = mount();
  const scrolled = [];
  m.ctx.scrollTo = (_x, y) => scrolled.push(y);
  const wrap = sheetUnderDrawer(m);
  m.menu.click();
  const home = m.$(".drawer-section");   // href="#/", and the page is "#/"
  const { ev } = home.dispatch("click");
  assert.strictEqual(ev.defaultPrevented, true, "handled here, since the router will not see it");
  assert.strictEqual(m.drawer.hidden, true, "the drawer leaves, as for any destination");
  assert.strictEqual(wrap.hidden, true, "the sheet covering the page the listener asked for is gone");
  assert.deepStrictEqual(scrolled, [0], "and the page is at its top");
});

test("ROUND 2 review (nav-8): a same-page drawer link with NO sheet open does not leave focus inside the hidden drawer", () => {
  /* onDrawerAction closes the drawer without returning focus, and the same
     hash runs no route(), so nothing landed it. MUTATION: drop the
     `landOnPage` call from sameHashTap -> focus stays on the hidden link; red. */
  const m = mount();
  m.ctx.scrollTo = () => {};
  m.menu.click();
  const home = m.$(".drawer-section");   // href="#/", and the page is "#/"
  assert.strictEqual(m.doc.activeElement, home, "precondition: focus is on the drawer link");
  home.dispatch("click");
  assert.strictEqual(m.drawer.hidden, true);
  const active = m.doc.activeElement;
  assert.ok(active && !m.drawer.contains(active), "focus has left the hidden drawer");
});

test("ROUND 2 nav-8: a drawer link to a DIFFERENT page is ordinary navigation, and the wordmark follows the same-hash rule", () => {
  /* MUTATION: drop the `currentHash(href) !== currentHash()` guard in
     sameHashTap -> every drawer link would close the sheets and scroll before
     the router ran; the first assertion is red. */
  const m = mount();
  const wrap = sheetUnderDrawer(m);
  m.ctx.location.hash = "#/library";
  m.menu.click();
  const { ev } = m.$(".drawer-section").dispatch("click");
  assert.strictEqual(ev.defaultPrevented, false, "a different page: left to the router");
  assert.strictEqual(wrap.hidden, false, "which closes the sheets itself on the hashchange");
  m.ctx.location.hash = "#/";
  const mark = m.doc.createElement("a");
  mark.className = "wordmark";
  mark.setAttribute("href", "#/");
  assert.strictEqual(m.ctx.sameHashTap(mark, { preventDefault() {} }), true, "the wordmark to Home, on Home");
  assert.strictEqual(wrap.hidden, true);
  assert.match(APP_SRC, /const mark = \$\("\.wordmark"\);\s*if \(mark\) mark\.addEventListener\("click", \(e\) => sameHashTap\(mark, e\)\);/,
    "bindDrawerChrome binds the wordmark to the same rule");
});

test("ROUND 2 nav-2: hardware back dismisses the top-most thing: the drawer, then the sheet, then a step back, then the app", () => {
  /* MUTATION 1: swap the drawer and sheet branches -> back with both open
     collapses the sheet under a drawer that stays; red. MUTATION 2: drop the
     `canGoBackInApp()` branch -> a page with history exits the app; red.
     MUTATION 3: drop the `backPending` guard -> two presses inside one beat
     step twice; the last assertion is red. */
  const m = mount();
  const backs = [];
  m.ctx.history.back = () => backs.push(1);
  const wrap = sheetUnderDrawer(m);
  m.menu.click();
  assert.strictEqual(m.ctx.handleBack(), "drawer");
  assert.strictEqual(m.drawer.hidden, true);
  assert.strictEqual(wrap.hidden, false, "the drawer only");
  assert.strictEqual(m.ctx.handleBack(), "sheet");
  assert.strictEqual(wrap.hidden, true);
  assert.deepStrictEqual(backs, [], "no page step under an overlay");
  assert.strictEqual(m.ctx.handleBack(), "exit", "nothing open and nothing behind: leave the app");
  vm.runInContext("navIndex = 1;", m.ctx);
  assert.strictEqual(m.ctx.handleBack(), "history");
  assert.deepStrictEqual(backs, [1]);
  assert.strictEqual(m.ctx.handleBack(), "history");
  assert.deepStrictEqual(backs, [1], "one step per press until the step has landed");
});

test("ROUND 2 nav-2: the shell's back button is wired to that order and leaves the app only from the bottom", () => {
  /* MUTATION: drop the `exitApp` call from the listener -> Android's back on a
     first page does nothing at all; red. */
  const m = mount();
  const app = {
    listeners: {}, exits: 0,
    addListener(name, fn) { this.listeners[name] = fn; return Promise.resolve({ remove() {} }); },
    exitApp() { this.exits++; },
  };
  assert.strictEqual(m.ctx.bindHardwareBack({ Capacitor: { Plugins: { App: app } } }), true);
  assert.strictEqual(m.ctx.bindHardwareBack({}), false, "no shell, no listener: the browser's own back stands");
  assert.strictEqual(typeof app.listeners.backButton, "function");
  m.menu.click();
  app.listeners.backButton({ canGoBack: true });
  assert.strictEqual(m.drawer.hidden, true, "back closed the drawer");
  assert.strictEqual(app.exits, 0, "and did not leave");
  app.listeners.backButton({ canGoBack: false });
  assert.strictEqual(app.exits, 1, "with nothing open and nothing behind, back leaves the app");
});

test("THE REAL init() registers the back handler with the shell", async () => {
  /* MUTATION: remove `bindHardwareBack()` from init(). Red. */
  const app = { listeners: {}, addListener(name, fn) { this.listeners[name] = fn; return Promise.resolve({ remove() {} }); }, exitApp() {} };
  await mountBooted({ capacitor: { Plugins: { App: app } } });
  assert.strictEqual(typeof app.listeners.backButton, "function", "init() wired the shell's back button");
});
