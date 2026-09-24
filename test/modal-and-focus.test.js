/* One owner for "a modal is open", and focus that survives a rebuild
 * (audit 2026-09-22, theme E and the a11y findings that share its cause).
 *
 * THE DEFECTS. Eight sheets declared `role="dialog"` + `aria-modal="true"` and
 * implemented none of it: focus stayed behind the scrim, Tab walked the covered
 * page, Escape did nothing. Each wrote `body.fy-sheet-open` with its own
 * add/remove pair, so the Foray speed menu could stack two copies, and a back
 * gesture over the feedback sheet (which lives inside #view) left the page
 * scroll-locked with no sheet on screen. The full-screen Now Playing sheet had
 * no dialog semantics at all. And two lists — Up Next and the narration-voice
 * picker — rebuilt themselves on every press, destroying the button that had
 * just been pressed, so focus fell to <body> after each action.
 *
 * WHAT THIS SUITE DOES. Mounts the real app.js in node:vm over a small DOM
 * that has what these questions need and the other harnesses lack: real
 * parent links (so `inert` can be walked up the tree and `isConnected` is
 * true or false for a reason), `document.activeElement` that `focus()` moves,
 * `matches`/`closest`/`querySelectorAll` over simple selectors, and keydown
 * dispatch. Then it drives the owner (`openSheet`/`closeSheet`/...), the real
 * sheets that use it, and the real Up Next / strip handlers.
 *
 * WHAT IT CANNOT PROVE, said rather than faked: that a real screen reader
 * announces the dialog, that WebKit honours `inert` in the shipping WebView,
 * and how the live region is voiced. Those need VoiceOver on a device.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, "player", "client.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

/* ---------- a DOM with a tree, focus and simple selectors ---------- */

function makeDocument() {
  const doc = { activeElement: null, _keydown: [] };

  /** One compound selector (`button.reorder`, `[data-voice-id]`,
      `a[href]`, `button:not([disabled])`, `[tabindex]:not([tabindex="-1"])`,
      `#id`, `.cls`). Enough for every selector the owner and these handlers
      use; anything else simply does not match. */
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
      this.top = 0; // what getBoundingClientRect reports
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
    get tabIndex() { return Number(this._attrs.get("tabindex") ?? -1); }
    set tabIndex(v) { this._attrs.set("tabindex", String(v)); }
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
    set innerHTML(v) { if (v === "") this.children.forEach((c) => { c.parentElement = null; }), this.children = []; }
    get innerHTML() { return ""; }
    focus() { doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    getBoundingClientRect() { return { top: this.top, left: 0, width: 40, height: 40 }; }
    addEventListener(t, fn) { if (!this._on.has(t)) this._on.set(t, []); this._on.get(t).push(fn); }
    removeEventListener() {}
    fire(type, props = {}) {
      const ev = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...props };
      return (this._on.get(type) || []).map((fn) => fn(ev));
    }
    click() { return this.fire("click"); }
    setPointerCapture() {}
    releasePointerCapture() {}
  }

  doc.body = new El("body");
  doc.documentElement = new El("html");
  doc.documentElement.appendChild(doc.body);
  doc.createElement = (t) => new El(t);
  doc.querySelector = (s) => doc.body.querySelector(s);
  doc.querySelectorAll = (s) => doc.body.querySelectorAll(s);
  doc.getElementById = (id) => doc.body.querySelectorAll(`#${id}`)[0] || null;
  doc.addEventListener = (t, fn) => { if (t === "keydown") doc._keydown.push(fn); };
  doc.removeEventListener = () => {};
  doc.readyState = "complete";
  doc.key = (key, extra = {}) => {
    let prevented = false;
    const ev = { key, preventDefault() { prevented = true; }, ...extra };
    doc._keydown.forEach((fn) => fn(ev));
    return prevented;
  };
  return { doc, El };
}

function mount() {
  const { doc } = makeDocument();
  const add = (tag, id, cls) => {
    const el = doc.createElement(tag);
    if (id) el.id = id;
    if (cls) el.className = cls;
    doc.body.appendChild(el);
    return el;
  };
  const topbar = add("header", null, "topbar");
  const menu = doc.createElement("button");
  menu.id = "menu-btn";
  topbar.appendChild(menu);
  const drawer = add("nav", "drawer");
  /* CLOSED, as index.html ships it (`<nav id="drawer" hidden>`). The drawer
     is a modal since round 2 and takes the keys while it is open, so a
     harness whose drawer was silently open would test nothing about sheets. */
  drawer.hidden = true;
  const view = add("main", "view");
  const tabBar = add("nav", null, "tab-bar");

  const store = new Map();
  const scrolls = [];
  const frames = [];
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
    document: doc,
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { scrollRestoration: "auto", back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    encodeURIComponent, decodeURIComponent,
    scrollY: 0, scrollTo() {}, scrollBy: (x, y) => scrolls.push(y),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  /* init() is parked on its first fetch here, and since round 2 (nav-9) it
     leaves ☰ and ↻ disabled until it has bound them. These tests are about a
     booted page's focus, so the chrome is put in its booted state. */
  ctx.setBootChrome(true);
  const flushFrames = () => { while (frames.length) frames.shift()(); };
  return { ctx, doc, topbar, menu, drawer, view, tabBar, store, scrolls, flushFrames };
}

/** A `.fy-sheet` > `.fy-panel[role=dialog]` with two buttons, detached. */
function sheet(m, id) {
  const wrap = m.doc.createElement("div");
  wrap.className = "fy-sheet";
  if (id) wrap.id = id;
  const panel = m.doc.createElement("div");
  panel.className = "fy-panel";
  panel.setAttribute("role", "dialog");
  const a = m.doc.createElement("button");
  const b = m.doc.createElement("button");
  panel.append(a, b);
  wrap.appendChild(panel);
  return { wrap, panel, a, b };
}

const inert = (el) => el.hasAttribute("inert");

/* ==================================================================== */
/* 1. THE OWNER                                                          */
/* ==================================================================== */

test("opening a sheet moves focus into it and takes the page out of reach; closing undoes exactly that", () => {
  /* MUTATION: delete `focusQuietly(panel)` from openSheet -> focus stays on
     the ☰ behind the scrim; red. MUTATION: delete `releaseInert(entry)` from
     closeSheet -> the page stays inert after the sheet is gone; red. */
  const m = mount();
  m.menu.focus();
  const s = sheet(m);
  m.ctx.openSheet(s.wrap);
  assert.strictEqual(m.doc.activeElement, s.panel, "focus goes to the dialog, which carries its name");
  assert.strictEqual(s.panel.getAttribute("tabindex"), "-1", "the panel is made focusable for that");
  for (const el of [m.view, m.topbar, m.tabBar, m.drawer]) assert.ok(inert(el), "everything behind the sheet is inert");
  assert.ok(!inert(s.wrap), "the sheet itself is not");
  assert.ok(m.doc.body.classList.contains("fy-sheet-open"));

  m.ctx.closeSheet(s.wrap);
  for (const el of [m.view, m.topbar, m.tabBar, m.drawer]) assert.ok(!inert(el), "and nothing stays inert after it closes");
  assert.strictEqual(m.doc.activeElement, m.menu, "focus goes back to what opened it");
  assert.ok(!m.doc.body.classList.contains("fy-sheet-open"));
  assert.strictEqual(s.wrap.hidden, true);
});

test("a sheet can leave named chrome reachable (the Now Playing sheet keeps the ☰)", () => {
  /* MUTATION: ignore `keepReachable` in inertOutside -> the topbar goes inert; red. */
  const m = mount();
  const s = sheet(m);
  m.ctx.openSheet(s.wrap, { keepReachable: [".topbar", "#drawer"] });
  assert.ok(!inert(m.topbar) && !inert(m.drawer));
  assert.ok(inert(m.view) && inert(m.tabBar));
});

test("an element that was already inert is left inert by a close (only what open changed is undone)", () => {
  const m = mount();
  m.tabBar.setAttribute("inert", "");
  const s = sheet(m);
  m.ctx.openSheet(s.wrap);
  m.ctx.closeSheet(s.wrap);
  assert.ok(inert(m.tabBar), "someone else's inert is not ours to lift");
});

test("REVIEW: a sheet opened over Now Playing is live, even though Now Playing had inerted it", () => {
  /* The voice/diagnostics/delete roots are hidden <body> children built at
     startup; expanding Now Playing (topbar and drawer kept reachable) inerts
     them, and the drawer then opens one. openSheet only un-hid it, so the new
     sheet came up inert over a drawer and topbar it had just inerted — stuck.
     MUTATION: drop `entry.lifted = liftInertFrom(wrap)` from openSheet. */
  const m = mount();
  const voice = sheet(m, "voice-sheet");
  voice.wrap.hidden = true;
  m.doc.body.appendChild(voice.wrap);             // built at startup, hidden
  const np = sheet(m, "np");
  m.ctx.openSheet(np.wrap, { keepReachable: [".topbar", "#drawer"] });
  assert.ok(inert(voice.wrap), "precondition: Now Playing inerted the hidden sheet root");
  m.ctx.openSheet(voice.wrap);                    // the drawer's "Narration voice"
  assert.ok(!inert(voice.wrap), "the sheet the listener opened is not inert");
  assert.strictEqual(m.doc.activeElement, voice.panel, "and focus is inside it");
  assert.ok(inert(np.wrap), "the sheet below is what is out of reach now");
  m.ctx.closeSheet(voice.wrap);
  assert.ok(inert(voice.wrap), "closing hands the inert back to Now Playing, which is still open");
  assert.ok(!inert(m.topbar) && !inert(m.drawer), "and Now Playing's reachable chrome is reachable again");
  m.ctx.closeSheet(np.wrap);
  assert.ok(!inert(voice.wrap), "and nothing is left inert once both are closed");
});

test("REVIEW: a tab bar created while the first-run explainer is open is out of reach too", () => {
  /* The explainer opens from Home's render, before renderTabBar creates the bar
     on a first visit, so inertOutside never saw it. MUTATION: drop the
     inertUnderOpenSheet(bar) call from renderTabBar. */
  const m = mount();
  m.tabBar.remove();                               // a first visit: no bar yet
  assert.strictEqual(m.ctx.showFirstTimeExplainerOnce(), true, "fixture: a fresh profile gets the explainer");
  m.ctx.renderTabBar();
  const bar = m.doc.body.querySelector("#tab-bar");
  assert.ok(bar, "fixture: the bar was created");
  assert.ok(inert(bar), "the new bar is behind the dialog like everything else");
  m.doc.key("Escape");
  assert.ok(!inert(bar), "and is released with the rest when the explainer closes");
});

test("Escape asks the TOP sheet to close through its own handler", () => {
  /* MUTATION: delete the Escape branch in onSheetKeydown -> red. */
  const m = mount();
  const s = sheet(m);
  let asked = 0;
  m.ctx.openSheet(s.wrap, { onRequestClose: () => { asked++; m.ctx.closeSheet(s.wrap); } });
  assert.strictEqual(m.doc.key("Escape"), true, "Escape is consumed while a sheet is open");
  assert.strictEqual(asked, 1);
  assert.strictEqual(m.ctx.openSheetCount(), 0);
  assert.strictEqual(m.doc.key("Escape"), false, "and ignored when none is");
});

test("Tab and Shift+Tab stay inside the dialog", () => {
  /* The trap is the fallback behind `inert` for a WebView without it.
     MUTATION: delete the Tab branch -> red. */
  const m = mount();
  const s = sheet(m);
  m.ctx.openSheet(s.wrap);
  s.b.focus();
  m.doc.key("Tab");
  assert.strictEqual(m.doc.activeElement, s.a, "Tab from the last control wraps to the first");
  m.doc.key("Tab", { shiftKey: true });
  assert.strictEqual(m.doc.activeElement, s.b, "Shift+Tab from the first wraps to the last");
  m.menu.focus(); // somehow outside
  m.doc.key("Tab");
  assert.strictEqual(m.doc.activeElement, s.a, "focus found outside is pulled back in");
});

test("REVIEW: with the ☰ kept reachable, Tab reaches it — and an open drawer — and comes back", () => {
  /* The trap only knew the panel: Tab from the sheet's last control wrapped to
     its first and never reached the ☰, and a Tab from the pointer-opened drawer
     was yanked back into the covered sheet. MUTATION: drop the kept-chrome
     branch from onSheetKeydown (cycle = the panel's items only). */
  const m = mount();
  const s = sheet(m);
  m.ctx.openSheet(s.wrap, { keepReachable: [".topbar", "#drawer"] });
  m.drawer.hidden = true;                          // the drawer is closed
  s.b.focus();
  m.doc.key("Tab");
  assert.strictEqual(m.doc.activeElement, m.menu, "Tab from the sheet's last control reaches the ☰");
  m.doc.key("Tab");
  assert.strictEqual(m.doc.activeElement, s.a, "and the next Tab comes back into the sheet");
  m.doc.key("Tab", { shiftKey: true });
  assert.strictEqual(m.doc.activeElement, m.menu, "Shift+Tab from the first control goes back to the ☰");

  const link = m.doc.createElement("a");
  link.setAttribute("href", "#/library");
  m.drawer.appendChild(link);
  m.drawer.hidden = false;                         // opened by pointer
  m.menu.focus();
  m.doc.key("Tab");
  assert.strictEqual(m.doc.activeElement, link, "from the ☰, Tab walks into the open drawer, not back into the sheet");
});

test("the modal lock is derived from what is open: kept across a render, dropped when the sheet's DOM is gone", () => {
  /* THE BACK-GESTURE BUG. The feedback sheet lives inside #view; a navigation
     replaced #view and `fy-sheet-open` was carried forward because it was
     there. MUTATION: put `fy-sheet-open` back on PERSISTENT_BODY_CLASSES and
     drop the derived classes from setBodyClass -> the second assertion fails. */
  const m = mount();
  const s = sheet(m);
  m.view.appendChild(s.wrap);            // lives inside #view, like #fy-sheet
  m.ctx.openSheet(s.wrap);
  m.ctx.setBodyClass("view-page");
  assert.ok(m.doc.body.classList.contains("fy-sheet-open"), "a render under an OPEN sheet keeps the lock");

  s.wrap.remove();                       // the render replaced #view
  m.ctx.setBodyClass("view-page");
  assert.ok(!m.doc.body.classList.contains("fy-sheet-open"), "a sheet that left the document leaves no lock behind");
  assert.ok(!inert(m.topbar) && !inert(m.tabBar), "nor any inert it had put on the page");
});

test("a render closes the sheets that live inside #view before their DOM goes", () => {
  /* MUTATION: delete `closeSheetsWithin($("#view"))` from renderCurrentPage.
     Covered here through the helper renderCurrentPage calls. */
  const m = mount();
  const s = sheet(m);
  m.view.appendChild(s.wrap);
  let asked = 0;
  m.ctx.openSheet(s.wrap, { onRequestClose: () => { asked++; } }); // a sheet that does nothing on request
  m.ctx.closeSheetsWithin(m.view);
  assert.strictEqual(asked, 1, "the sheet is asked first, so its own cleanup runs");
  assert.strictEqual(m.ctx.openSheetCount(), 0, "and it is closed regardless — its DOM is about to go");
  assert.match(APP_SRC, /fbTarget = null;[\s\S]{0,400}closeSheetsWithin\(\$\("#view"\)\);/,
    "renderCurrentPage must call it beside the other per-page resets");
});

test("navigation asks every sheet to close, and a sheet may refuse (Delete my data mid-delete)", () => {
  /* MUTATION: make closeAllSheets force-close -> the refusing sheet vanishes; red. */
  const m = mount();
  const keep = sheet(m, "busy");
  const go = sheet(m, "idle");
  m.ctx.openSheet(keep.wrap, { onRequestClose: () => {} });
  m.ctx.openSheet(go.wrap);
  m.ctx.closeAllSheets();
  assert.strictEqual(m.ctx.openSheetCount(), 1);
  assert.strictEqual(keep.wrap.hidden, false, "the refusing sheet is still up");
  assert.match(APP_SRC, /if \(h !== previousHash\) closeAllSheets\(\);/,
    "route() closes sheets on a real navigation only — not on a same-hash re-render under an open sheet");
});

test("the Foray speed menu is one instance however often it is opened", () => {
  /* A repeated Enter / key-repeat mounted a second #rate-sheet over the first,
     and one Cancel took the lock off with a sheet still up.
     MUTATION: drop the same-id replacement from openSheet -> two sheets; red. */
  const m = mount();
  const player = {
    rateStops: () => [1, 1.5],
    playbackRate: () => 1,
    rateLabel: (r) => `${r}×`,
    setPlaybackRate: (r) => r,
  };
  m.ctx.openRateMenu(player, () => {});
  m.ctx.openRateMenu(player, () => {});
  const sheets = m.doc.body.querySelectorAll("#rate-sheet");
  assert.strictEqual(sheets.length, 1, "exactly one #rate-sheet in the document");
  sheets[0].querySelector(".fy-sheet-cancel").click();
  assert.strictEqual(m.doc.body.querySelectorAll("#rate-sheet").length, 0);
  assert.ok(!m.doc.body.classList.contains("fy-sheet-open"), "Cancel leaves no lock and no sheet");
  assert.ok(!inert(m.view), "and no inert page");
});

test("the first-run explainer is a real dialog: focus moves in, and Escape parks it for the visit — only Skip ends onboarding", () => {
  /* MUTATION: open it without the owner (the old appendChild + classList.add)
     -> focus never moves; red. ROUND 2 (p-first-4): Escape used to write the
     never-again flag, the same as Skip; it is now "not now, this visit".
     MUTATION: route `onRequestClose` back to `dismiss` -> the flag assertion
     is red. */
  const m = mount();
  assert.strictEqual(m.ctx.showFirstTimeExplainerOnce(), true, "fixture assumption: a fresh profile gets the explainer");
  const wrap = m.doc.body.querySelector("#first-time-sheet");
  assert.ok(wrap && m.doc.activeElement === wrap.querySelector(".fy-panel"));
  m.doc.key("Escape");
  assert.strictEqual(m.doc.body.querySelector("#first-time-sheet"), null, "Escape closed it");
  assert.strictEqual(m.store.get("cp_intro_dismissed"), undefined, "without ending onboarding");
  const fresh = mount();
  assert.strictEqual(fresh.ctx.showFirstTimeExplainerOnce(), true);
  fresh.doc.body.querySelector("#first-time-sheet-skip").fire("click");
  assert.strictEqual(fresh.store.get("cp_intro_dismissed"), "true", "Skip is the considered press that does");
});

test("no sheet writes the modal lock itself any more — they all go through the owner", () => {
  /* THE STRUCTURAL PIN: the lock was eight add/remove pairs, and the pairs are
     what drifted. MUTATION: restore any one sheet's
     `document.body.classList.add("fy-sheet-open")` -> red. The one survivor is
     player/client.js's fallback for a page with no owner at all. */
  const count = (src, s) => src.split(s).length - 1;
  assert.strictEqual(count(APP_SRC, 'classList.add("fy-sheet-open")'), 0);
  assert.strictEqual(count(APP_SRC, 'classList.remove("fy-sheet-open")'), 0);
  assert.strictEqual(count(CLIENT_SRC, 'classList.add("fy-sheet-open")'), 1, "client.js: only the owner-less fallback");
  for (const fn of ["showFirstTimeExplainerOnce", "showIntroPopupOnce", "openFeedbackSheet",
    "openRateMenu", "openDeleteSheet", "openVoiceSheet", "openDiagSheet"]) {
    const body = new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(APP_SRC);
    assert.ok(body, `${fn} exists`);
    assert.match(body[0], /openSheet\(/, `${fn} must open through openSheet()`);
  }
});

test("every sheet panel rides on the soft keyboard instead of sitting behind it", () => {
  /* `--kb-inset` had exactly one reader (the search compose bar); a sheet's
     own text field and buttons were stranded behind the keyboard.
     MUTATION: `.fy-panel { bottom: 0 }` -> red. */
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  const rule = /(^|\})\s*\.fy-panel \{([^}]*)\}/.exec(css);
  assert.ok(rule);
  assert.match(rule[2], /bottom:\s*var\(--kb-inset, 0px\)/);
  assert.match(rule[2], /max-height:\s*calc\(88vh - var\(--kb-inset, 0px\)\)/);
});

/* ==================================================================== */
/* 2. UP NEXT: FOCUS, POSITION AND THE THUMB SURVIVE THE REBUILD          */
/* ==================================================================== */

/** #view as renderQueue would leave it: one row of buttons per id. */
function queueView(m, ids, tops) {
  m.view.children = [];
  ids.forEach((id, i) => {
    const up = m.doc.createElement("button");
    up.setAttribute("data-reorder-up", id);
    up.disabled = i === 0;
    up.top = tops[i];
    const down = m.doc.createElement("button");
    down.setAttribute("data-reorder-down", id);
    down.disabled = i === ids.length - 1;
    down.top = tops[i];
    const rm = m.doc.createElement("button");
    rm.setAttribute("data-dequeue", id);
    m.view.append(up, down, rm);
  });
}

test("after ↑, focus is on the same episode's ↑ in its new row, the page follows the thumb, and the position is said", () => {
  /* MUTATION: delete `focusQuietly(target)` from afterQueueMove -> red.
     MUTATION: delete the scrollBy -> red (the next tap hits a different
     episode). MUTATION: delete the announce -> red. */
  const m = mount();
  m.store.set("cp_queue", JSON.stringify(["a", "c", "b"]));  // after moving c up from position 3
  queueView(m, ["a", "c", "b"], [100, 180, 260]);
  m.ctx.afterQueueMove("c", -1, 260);                         // its ↑ WAS at 260
  const up = m.view.querySelectorAll("[data-reorder-up]").find((b) => b.getAttribute("data-reorder-up") === "c");
  assert.strictEqual(m.doc.activeElement, up);
  assert.deepStrictEqual(m.scrolls, [180 - 260], "scroll by exactly how far the button moved");
  m.flushFrames();
  assert.strictEqual(m.doc.body.querySelector("#a11y-status").textContent, "Moved to position 2 of 3.");
});

test("at the top of the list, focus goes to the other arrow (its own is disabled)", () => {
  const m = mount();
  m.store.set("cp_queue", JSON.stringify(["c", "a", "b"]));
  queueView(m, ["c", "a", "b"], [100, 180, 260]);
  m.ctx.afterQueueMove("c", -1, 180);
  assert.strictEqual(m.doc.activeElement.getAttribute("data-reorder-down"), "c");
});

test("after ✕, focus is on the ✕ of the row that took its place, and the removal is said", () => {
  const m = mount();
  m.store.set("cp_queue", JSON.stringify(["a", "c"]));
  queueView(m, ["a", "c"], [100, 180]);
  m.ctx.afterQueueRemove(1);                                  // removed the old #2
  assert.strictEqual(m.doc.activeElement.getAttribute("data-dequeue"), "c");
  m.flushFrames();
  assert.strictEqual(m.doc.body.querySelector("#a11y-status").textContent, "Removed from Up Next.");
});

test("the Up Next binders run the after-steps (the helpers are not orphans)", () => {
  /* MUTATION: drop `afterQueueMove(id, -1, top);` from the ↑ binder -> red.
     The repaint sits in `saveQueueIds` since audit round 2 (the page is a live
     view of the list), so the binders write and then run the after-step. */
  const binder = /function bindUpNextReorder\(scope\) \{[\s\S]*?\n\}/.exec(APP_SRC)[0];
  assert.match(binder, /moveQueueItem\(id, -1\);\s*afterQueueMove\(id, -1, top\);/);
  assert.match(binder, /moveQueueItem\(id, 1\);\s*afterQueueMove\(id, 1, top\);/);
  assert.match(binder, /removeFromQueue\(btn\.dataset\.dequeue\);\s*afterQueueRemove\(/);
  assert.doesNotMatch(binder, /renderQueue\(\)/, "the binders do not paint a second time");
});

/* ==================================================================== */
/* 3. THE FORAY STRIP: A VERTICAL FLICK IS NOT A SEEK                     */
/* ==================================================================== */

test("a vertical flick that starts on the strip arms the click suppression; the next press disarms it", async () => {
  /* The strip is sticky in the path of every scroll flick, and the click a
     release delivers used to seek. MUTATION: delete the `gesture.scrolled`
     branch in bindStripZoomScrub -> red. MUTATION: delete the reset at
     pointerdown -> the second assertion fails (a flag cleared only by a click
     would eat the next genuine tap after a touch scroll, which has no click). */
  const gest = await import(pathToFileURL(path.join(ROOT, "player", "strip-scrub-gesture.js")).href);
  const m = mount();
  const strip = m.doc.createElement("div");
  strip.id = "fy-strip";
  m.view.appendChild(strip);
  const player = {
    scrubGesture: {
      HOLD_MS: gest.HOLD_MS, ZOOM_SCALE: gest.ZOOM_SCALE,
      start: gest.startGesture, move: gest.moveGesture, holdTimeout: gest.holdTimeoutGesture,
      end: gest.endGesture, originPercent: gest.zoomOriginPercent,
      BUBBLE_SCALE: gest.BUBBLE_SCALE, BUBBLE_WIDTH: gest.BUBBLE_WIDTH,
      bubblePosition: gest.bubblePosition, bubbleContentOffset: gest.bubbleContentOffset,
    },
  };
  m.ctx.bindStripZoomScrub({}, player);
  strip.fire("pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
  strip.fire("pointermove", { pointerId: 1, clientX: 103, clientY: 140 });
  assert.strictEqual(strip._scrollGesture, true, "a mostly-vertical move before any scrub is a scroll");
  strip.fire("pointerdown", { pointerId: 2, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
  assert.strictEqual(strip._scrollGesture, false, "a new press starts clean");
  strip.fire("pointerup", { pointerId: 2 });
  assert.match(APP_SRC, /\$\("#fy-strip"\)\.addEventListener\("click", async \(e\) => \{[\s\S]{0,400}?_scrollGesture\) \{[\s\S]{0,120}?return;/,
    "the strip's click handler must return early on a scroll gesture");
});

test("REVIEW: while the strip is zoomed, a touchmove is cancelled so the page cannot take the scrub", async () => {
  /* `touch-action: pan-y` lets the browser pan vertically even mid-zoom; its
     pointercancel then ended the scrub with no seek. MUTATION: drop the
     non-passive touchmove listener from bindStripZoomScrub. */
  const gest = await import(pathToFileURL(path.join(ROOT, "player", "strip-scrub-gesture.js")).href);
  const m = mount();
  const strip = m.doc.createElement("div");
  strip.id = "fy-strip";
  m.view.appendChild(strip);
  const player = {
    scrubGesture: {
      HOLD_MS: gest.HOLD_MS, ZOOM_SCALE: gest.ZOOM_SCALE,
      start: gest.startGesture, move: gest.moveGesture, holdTimeout: gest.holdTimeoutGesture,
      end: gest.endGesture, originPercent: gest.zoomOriginPercent,
      BUBBLE_SCALE: gest.BUBBLE_SCALE, BUBBLE_WIDTH: gest.BUBBLE_WIDTH,
      bubblePosition: gest.bubblePosition, bubbleContentOffset: gest.bubbleContentOffset,
    },
  };
  /* The zoom opens the magnifier bubble, which clones the strip: the three DOM
     calls it makes that this harness's El does not otherwise need. */
  const proto = Object.getPrototypeOf(strip);
  if (!proto.replaceChildren) proto.replaceChildren = function (...ks) { for (const k of [...this.children]) k.remove(); this.append(...ks); };
  if (!proto.cloneNode) proto.cloneNode = function () { const c = m.doc.createElement(this.tagName); c.className = this.className; return c; };
  if (!("firstElementChild" in proto)) Object.defineProperty(proto, "firstElementChild", { get() { return this.children[0] || null; } });
  m.ctx.bindStripZoomScrub({}, player);
  const touchmove = () => {
    let cancelled = false;
    strip.fire("touchmove", { cancelable: true, preventDefault() { cancelled = true; } });
    return cancelled;
  };
  strip.fire("pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
  assert.strictEqual(touchmove(), false, "a pending press may still become a scroll");
  strip.fire("pointermove", { pointerId: 1, clientX: 100 + gest.MOVE_TOLERANCE_PX + 20, clientY: 102 });
  assert.ok(strip.classList.contains("is-zooming"), "precondition: a sideways drag entered zoom");
  assert.strictEqual(touchmove(), true, "once zoomed, the page may not pan under the finger");
  strip.fire("pointerup", { pointerId: 1 });
  assert.strictEqual(touchmove(), false, "and after release nothing is held");
});

/* ==================================================================== */
/* 5. WHERE A ROUTE LANDS FOCUS (audit sweep 2026-09-23, qa row 80)      */
/* ==================================================================== */

/* route() is driven for real; only the page render is replaced, by one that
   builds what the named page's head would be — a `.page-head` with its h2, or
   (Home) nothing but sections. */
function routed(m) {
  vm.runInContext("state.ready = true;", m.ctx);
  const overlay = m.doc.createElement("div");
  overlay.id = "drawer-overlay";
  m.doc.body.appendChild(overlay);
  const pages = { "#/": null, "#/library": "Library", "#/forays": "Forays" };
  m.ctx.renderCurrentPage = () => {
    m.view.children.forEach((c) => { c.parentElement = null; });
    m.view.children = [];
    const name = pages[m.ctx.location.hash];
    if (!name) { m.view.appendChild(m.doc.createElement("section")); return; }
    const head = m.doc.createElement("div");
    head.className = "page-head";
    const h2 = m.doc.createElement("h2");
    h2.textContent = name;
    head.appendChild(h2);
    m.view.appendChild(head);
  };
  const go = (hash) => { m.ctx.location.hash = hash; m.ctx.route(); };
  go("#/");                                     // the boot route: nothing to move
  return go;
}
const heading = (m) => m.view.querySelector(".page-head").querySelector("h2");

test("a drawer link's navigation lands focus on the new page's heading, and the document is named after it", () => {
  /* The drawer hides under the focused link. MUTATION: delete the
     `landOnPage(...)` call from route() -> focus stays on the hidden link and
     the title stays "4a"; red. */
  const m = mount();
  const go = routed(m);
  const link = m.doc.createElement("a");
  link.setAttribute("href", "#/library");
  m.drawer.appendChild(link);
  link.focus();
  go("#/library");
  assert.strictEqual(m.doc.activeElement, heading(m), "focus is on the Library heading");
  assert.strictEqual(heading(m).getAttribute("tabindex"), "-1", "as a programmatic target, not a tab stop");
  assert.strictEqual(m.doc.title, "Library · 4a");
});

test("a navigation from a link the render removed lands focus too; Home is plain '4a' and lands on #view", () => {
  /* MUTATION: drop `active.isConnected === false` from landOnPage's `lost` -> red. */
  const m = mount();
  const go = routed(m);
  go("#/library");
  const inPage = m.doc.createElement("a");
  m.view.appendChild(inPage);
  inPage.focus();
  go("#/forays");
  assert.strictEqual(m.doc.activeElement, heading(m));
  assert.strictEqual(m.doc.title, "Forays · 4a");
  m.view.children[0].appendChild(inPage);
  inPage.focus();
  go("#/");
  assert.strictEqual(m.doc.activeElement, m.view, "Home has no page heading, so the region itself");
  assert.strictEqual(m.doc.title, "4a");
});

test("focus that survived the navigation (a tab-bar link) stays put, and the page's name is said instead", () => {
  /* MUTATION: make landOnPage move focus unconditionally -> the tab bar loses
     the listener's place; red. MUTATION: delete `announce(name)` -> nothing is
     said; red. */
  const m = mount();
  const go = routed(m);
  const tab = m.doc.createElement("a");
  m.tabBar.appendChild(tab);
  tab.focus();
  go("#/library");
  m.flushFrames();
  assert.strictEqual(m.doc.activeElement, tab);
  assert.strictEqual(m.doc.querySelector("#a11y-status").textContent, "Library");
});

test("a re-render of the SAME page neither moves surviving focus nor says anything", () => {
  /* A settings toggle re-renders through route(). MUTATION: pass
     `navigated: true` unconditionally -> the page's name is announced on
     every toggle; red. */
  const m = mount();
  const go = routed(m);
  go("#/library");
  const tab = m.doc.createElement("a");
  m.tabBar.appendChild(tab);
  tab.focus();
  m.flushFrames();
  const region = m.doc.querySelector("#a11y-status");
  if (region) region.textContent = "";
  m.ctx.route();
  m.flushFrames();
  assert.strictEqual(m.doc.activeElement, tab);
  assert.strictEqual((m.doc.querySelector("#a11y-status") || { textContent: "" }).textContent, "");
});

test("an async page's real paint renames the document (pageDidPaint)", () => {
  /* MUTATION: delete `landOnPage({ navigated: false })` from pageDidPaint ->
     the title keeps the loading paint's name; red. */
  const m = mount();
  routed(m);
  const head = m.doc.createElement("div");
  head.className = "page-head";
  const h2 = m.doc.createElement("h2");
  h2.textContent = "A Foray";
  head.appendChild(h2);
  m.view.children.forEach((c) => { c.parentElement = null; });
  m.view.children = [];
  m.view.appendChild(head);
  m.ctx.location.hash = "#/foray/x";
  m.ctx.pageDidPaint();
  assert.strictEqual(m.doc.title, "A Foray · 4a");
});

/* ==================================================================== */
/* 6. AUDIT ROUND 2 (2026-09-23): gestures commit on release, the        */
/*    first-run sheet parks, Stop lands focus, every panel drags         */
/* ==================================================================== */

const scrubModule = () => import(pathToFileURL(path.join(ROOT, "player", "strip-scrub-gesture.js")).href);
const dragModule = () => import(pathToFileURL(path.join(ROOT, "player", "sheet-drag-dismiss.js")).href);

/** The bridge client.js publishes for the strip, built from the real module. */
function scrubBridge(gest) {
  return {
    scrubGesture: {
      HOLD_MS: gest.HOLD_MS, ZOOM_SCALE: gest.ZOOM_SCALE,
      start: gest.startGesture, move: gest.moveGesture, holdTimeout: gest.holdTimeoutGesture,
      end: gest.endGesture, originPercent: gest.zoomOriginPercent, unzoomedX: gest.unzoomedStripX,
      BUBBLE_SCALE: gest.BUBBLE_SCALE, BUBBLE_WIDTH: gest.BUBBLE_WIDTH,
      bubblePosition: gest.bubblePosition, bubbleContentOffset: gest.bubbleContentOffset,
    },
  };
}

/** A strip whose box is 40px wide before the zoom and 100px once `.is-zooming`
    is on — what a real strip reports mid-gesture (`transform: scale()` changes
    the client rect), and the difference that tells a release reading the
    PRE-zoom box from one reading whatever the browser reports at that instant. */
function zoomableStrip(m) {
  const strip = m.doc.createElement("div");
  strip.id = "fy-strip";
  m.view.appendChild(strip);
  strip.getBoundingClientRect = () => ({ top: 0, left: 0, width: strip.classList.contains("is-zooming") ? 100 : 40, height: 40 });
  const proto = Object.getPrototypeOf(strip);
  if (!proto.replaceChildren) proto.replaceChildren = function (...ks) { for (const k of [...this.children]) k.remove(); this.append(...ks); };
  if (!proto.cloneNode) proto.cloneNode = function () { const c = m.doc.createElement(this.tagName); c.className = this.className; return c; };
  if (!("firstElementChild" in proto)) Object.defineProperty(proto, "firstElementChild", { get() { return this.children[0] || null; } });
  return strip;
}

test("ROUND 2 touch-1: a zoomed gesture's release SEEKS, read from the pre-zoom box; a plain tap leaves the seek to its click", async () => {
  /* The headline gesture committed through a `click` no mobile browser sends
     after a moved touch. MUTATION 1: drop the `commit(at)` from the pointerup
     handler -> nothing is committed; red. MUTATION 2: compute the release from
     `strip.getBoundingClientRect()` at release instead of `preZoomRect` -> the
     box is 100px wide by then and the seek lands elsewhere; red. MUTATION 3:
     drop `strip._seekCommitted = true` -> the trailing mouse click would seek
     a second time; the flag assertion is red. */
  const gest = await scrubModule();
  const m = mount();
  const strip = zoomableStrip(m);
  const committed = [];
  const r = { totalSec: 1000, playable: [] };
  m.ctx.bindStripZoomScrub(r, scrubBridge(gest), (at) => committed.push(at));
  strip.fire("pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 20 });
  strip.fire("pointermove", { pointerId: 1, clientX: 30, clientY: 21 });
  assert.ok(strip.classList.contains("is-zooming"), "precondition: the sideways drag entered zoom");
  strip.fire("pointerup", { pointerId: 1, clientX: 30, clientY: 21 });
  assert.deepStrictEqual(committed, [750], "30px into a 40px strip is 75% of the hour, against the box measured BEFORE the zoom");
  assert.strictEqual(strip._seekCommitted, true, "and the click a mouse still sends is told it has been answered");
  assert.ok(!strip.classList.contains("is-zooming"), "the zoom is cleared on release");
  strip.fire("pointerdown", { pointerId: 2, pointerType: "touch", button: 0, clientX: 10, clientY: 20 });
  assert.strictEqual(strip._seekCommitted, false, "a new press starts clean");
  strip.fire("pointerup", { pointerId: 2, clientX: 10, clientY: 20 });
  assert.deepStrictEqual(committed, [750], "a tap that never zoomed commits nothing here: its click does, as before");
  assert.match(APP_SRC, /_seekCommitted\) \{\s*e\.currentTarget\._seekCommitted = false;\s*return;/, "the click handler swallows the answered click");
  assert.match(APP_SRC, /bindStripZoomScrub\(r, player, commitStripSeek\)/, "the release commits through the same path a tap's click takes");
  assert.match(APP_SRC, /const at = stripElapsedAt\(e, r\);\s*if \(at != null\) return commitStripSeek\(at\);/);
});

test("ROUND 2 a11y-5: 'Get started' lands focus on the new step's title, so the step is spoken", () => {
  /* The button that was pressed is destroyed by the body swap and focus fell
     to <body> inside an open dialog. MUTATION: drop `landOnStep()` from the
     "Get started" handler -> red. */
  const m = mount();
  assert.strictEqual(m.ctx.showFirstTimeExplainerOnce(), true);
  const wrap = m.doc.body.querySelector("#first-time-sheet");
  assert.strictEqual(m.doc.activeElement, wrap.querySelector(".fy-panel"), "the first render: the dialog itself is what is announced");
  wrap.querySelector("#first-time-sheet-go").fire("click");
  const title = wrap.querySelector("#first-time-sheet-title");
  assert.ok(title && /What are you into/.test(title.textContent), "precondition: step 2 rendered");
  assert.strictEqual(m.doc.activeElement, title, "focus is on the new step's title, not on <body>");
  assert.strictEqual(title.getAttribute("tabindex"), "-1", "as a programmatic target");
});

test("ROUND 2 p-first-4: a scrim tap PARKS the first-run sheet for the visit: it neither ends onboarding nor pops back up", () => {
  /* MUTATION 1: bind the scrim to `dismiss` -> the flag assertion is red.
     MUTATION 2: drop `|| firstRunParked` from the on-screen check -> the sheet
     re-mounts on Home's next render; red. */
  const m = mount();
  assert.strictEqual(m.ctx.showFirstTimeExplainerOnce(), true);
  m.doc.body.querySelector("#first-time-sheet").querySelector(".fy-scrim").fire("click");
  assert.strictEqual(m.doc.body.querySelector("#first-time-sheet"), null, "the scrim closes it");
  assert.strictEqual(m.store.get("cp_intro_dismissed"), undefined, "without the never-again flag");
  /* Home's gate, as renderHomeV2 writes it: the popup runs only when the
     explainer says it did not render — and "parked" answers true for exactly
     that reason. */
  if (!m.ctx.showFirstTimeExplainerOnce()) m.ctx.showIntroPopupOnce();
  assert.strictEqual(m.doc.body.querySelector("#first-time-sheet"), null, "Home's next render this visit does not bring it back");
  assert.strictEqual(m.doc.body.querySelector("#intro-sheet"), null, "and the returning-user popup does not take its place");
});

test("ROUND 2 p-first-5: the first-run sheet leaves the player reachable, so a shared Foray keeps its controls under it", () => {
  /* MUTATION: drop `keepReachable: ONBOARDING_KEEPS_REACHABLE` -> #foray-player
     goes inert with the page; red. */
  const m = mount();
  const player = m.doc.createElement("div");
  player.id = "foray-player";
  m.doc.body.appendChild(player);
  assert.strictEqual(m.ctx.showFirstTimeExplainerOnce(), true);
  assert.ok(inert(m.view), "the page is out of reach");
  assert.ok(!inert(player), "the mini bar's play and back-15 are not");
  m.doc.key("Escape");
  assert.ok(!inert(m.view) && !inert(player));
});

test("ROUND 2 review (p-first-5): an onboarding sheet lifts the player OVER its scrim and does not trap VoiceOver with aria-modal", () => {
  /* Out of `inert` was not reachable: the z-70 scrim covered the z-60 bar, so
     a tap on ❚❚ parked the sheet and the audio played on, and aria-modal kept
     VoiceOver inside the dialog. MUTATIONS: drop SHEET_KEEPS_PLAYER_CLASS from
     sheetBodyClasses; set aria-modal back to "true"; delete the styles.css
     lift rule. */
  const m = mount();
  const player = m.doc.createElement("div");
  player.id = "foray-player";
  m.doc.body.appendChild(player);
  assert.strictEqual(m.ctx.showFirstTimeExplainerOnce(), true);
  assert.ok(m.doc.body.classList.contains("fy-sheet-keeps-player"), "the body says the player is lifted");
  const panel = m.doc.body.querySelector("#first-time-sheet").querySelector(".fy-panel");
  assert.notStrictEqual(panel.getAttribute("aria-modal"), "true", "VoiceOver can leave the dialog for the player");
  m.doc.key("Escape");
  assert.ok(!m.doc.body.classList.contains("fy-sheet-keeps-player"), "and it drops when the sheet goes");
  const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
  const lift = /body\.fy-sheet-keeps-player #foray-player\s*\{[^}]*z-index:\s*(\d+)/.exec(css);
  const sheetZ = /\.fy-sheet \{[^}]*z-index:\s*(\d+)/.exec(css);
  assert.ok(lift && sheetZ && Number(lift[1]) > Number(sheetZ[1]), "the lifted player stacks above the sheet");
});

test("ROUND 2 a11y-6: with the player hidden BEFORE the owner lets go, Stop leaves focus on the page, not on a hidden button", () => {
  /* The owner's half of client.js's `stopAndClose` order (its source order is
     pinned in player/now-playing-sheet.test.js): a return target inside a
     hidden subtree is skipped, and `landOnPage` then puts focus on the page.
     MUTATION: drop `!inHiddenSubtree(el)` from closeSheet's candidate filter
     -> focus lands on the hidden title button; red. */
  const m = mount();
  const root = m.doc.createElement("div");
  root.id = "foray-player";
  const bar = m.doc.createElement("div");
  const info = m.doc.createElement("button");
  bar.appendChild(info);
  const sheet = m.doc.createElement("div");
  sheet.className = "fp-sheet";
  sheet.setAttribute("role", "dialog");
  const stop = m.doc.createElement("button");
  sheet.appendChild(stop);
  root.append(bar, sheet);
  m.doc.body.appendChild(root);
  info.focus();
  m.ctx.openSheet(sheet, { panel: sheet, returnFocus: info });
  stop.focus();
  root.hidden = true;                 // client.js: the root first,
  sheet.hidden = true;
  m.doc.activeElement.blur();         // focus on Stop is let go,
  m.ctx.closeSheet(sheet);            // and only then the owner
  assert.notStrictEqual(m.doc.activeElement, info, "the owner skips a return target inside the hidden root");
  m.ctx.landOnPage({ navigated: false });
  const active = m.doc.activeElement;
  assert.ok(active && active !== m.doc.body && active.isConnected && !root.contains(active), "focus lands on the page");
  assert.ok(!inert(m.view), "and the page is released");
});

test("ROUND 2 touch-4: a panel the owner opens can be pulled down, finishes its slide, and closes through the sheet's own close", async () => {
  /* Eight sheets painted the handle and none answered it. MUTATION 1: drop
     `bindPanelDrag(entry)` from openSheet -> the pull does nothing; red.
     MUTATION 2: call `entry.requestClose()` straight from pointerup instead
     of after `slideOut` -> "still open until the slide has settled" is red.
     MUTATION 3: drop the `closest("button, ...")` guard -> a pull that starts
     on a button dismisses the sheet under the finger; red. */
  const drag = await dragModule();
  const m = mount();
  m.ctx.ForayPlayer = { sheetDrag: { start: drag.startDrag, move: drag.moveDrag, end: drag.endDrag, offset: drag.dragOffset, claimsTouch: drag.claimsTouch } };
  const s = sheet(m);
  let asked = 0;
  m.ctx.openSheet(s.wrap, { panel: s.panel, onRequestClose: () => { asked++; m.ctx.closeSheet(s.wrap); } });
  s.panel.fire("pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientY: 100, timeStamp: 0 });
  s.panel.fire("pointermove", { pointerId: 1, clientY: 300, timeStamp: 40 });
  let cancelled = false;
  s.panel.fire("touchmove", { cancelable: true, preventDefault() { cancelled = true; } });
  assert.strictEqual(cancelled, true, "the panel claims the finger, so its own scroller cannot rubber-band");
  s.panel.fire("pointerup", { pointerId: 1, clientY: 300, timeStamp: 60 });
  assert.strictEqual(asked, 0, "still open until the slide has settled");
  assert.strictEqual(s.wrap.hidden, false);
  s.panel.fire("transitionend");
  assert.strictEqual(asked, 1, "then the sheet's own close is asked, as Escape would");
  assert.strictEqual(s.wrap.hidden, true);
  /* A press on a control is that control's. */
  m.ctx.openSheet(s.wrap, { panel: s.panel, onRequestClose: () => { asked++; m.ctx.closeSheet(s.wrap); } });
  s.panel.fire("pointerdown", { pointerId: 2, pointerType: "touch", button: 0, clientY: 100, timeStamp: 0, target: s.a });
  s.panel.fire("pointermove", { pointerId: 2, clientY: 300, timeStamp: 40 });
  s.panel.fire("pointerup", { pointerId: 2, clientY: 300, timeStamp: 60 });
  assert.strictEqual(asked, 1, "a pull that started on a button is not a dismiss");
  assert.strictEqual(s.wrap.hidden, false);
});

test("ROUND 2 touch-8: slideOut settles once, on transitionend or the timer, and reduced motion means no motion at all", () => {
  /* MUTATION 1: drop the `settled` guard in slideOut's finish -> `done` runs
     twice (transitionend, then the timer); red. MUTATION 2: drop the
     `reducedMotion()` check from canSlide -> a listener who asked for no
     motion gets a slide, and a caller waits on a transition styles.css has
     switched off; red. */
  const m = mount();
  const el = m.doc.createElement("div");
  m.doc.body.appendChild(el);
  let done = 0;
  assert.strictEqual(m.ctx.slideOut(el, "--x", 40, () => done++), true);
  assert.strictEqual(done, 0, "not before the transition ends");
  el.fire("transitionend");
  el.fire("transitionend");
  assert.strictEqual(done, 1, "once");
  assert.strictEqual(m.ctx.slideIn(el, "--x", 40, "dragging"), true);
  assert.strictEqual(m.ctx.slideOut(el, "--x", 0, () => done++), false, "nothing to move: the caller closes at once");
  m.ctx.matchMedia = () => ({ matches: true });
  assert.strictEqual(m.ctx.slideOut(el, "--x", 40, () => done++), false, "reduced motion: no slide");
  assert.strictEqual(m.ctx.slideIn(el, "--x", 40, "dragging"), false);
  assert.strictEqual(done, 1);
});

test("ROUND 2 touch-8: a close that settles late leaves focus alone when it has already moved on", () => {
  /* A navigation under Now Playing lands focus on the new page's heading
     while the sheet is still sliding out; the owner's late return must not
     take it back to the mini bar. MUTATION: drop the `held` guard in
     closeSheet (return focus unconditionally) -> red. */
  const m = mount();
  const opener = m.doc.createElement("button");
  m.view.appendChild(opener);
  opener.focus();
  const s = sheet(m);
  m.ctx.openSheet(s.wrap);
  const heading = m.doc.createElement("h2");
  m.view.appendChild(heading);
  heading.focus();                       // landOnPage, in the beat before the slide settles
  m.ctx.closeSheet(s.wrap);
  assert.strictEqual(m.doc.activeElement, heading, "focus that moved on is left where it is");
  opener.focus();                        // the ordinary case: opened from the button…
  const again = sheet(m);
  m.ctx.openSheet(again.wrap);
  again.a.focus();                       // …focus is inside the sheet when it closes
  m.ctx.closeSheet(again.wrap);
  assert.strictEqual(m.doc.activeElement, opener, "focus the sheet still held goes back to the opener");
});

/* ==================================================================== */
/* 7. WHAT A PAGE IS CALLED, AND WHEN IT IS SAID (audit round 2)         */
/* ==================================================================== */

/* A router whose pages this test describes: `null` paints a loading page (no
   heading), a string paints a `.page-head` h2, `{ explicit }` adds the badge
   the show and episode pages put straight after the title, and `home` paints
   the greeting. */
function routedPages(m, pages) {
  vm.runInContext("state.ready = true;", m.ctx);
  const overlay = m.doc.createElement("div");
  overlay.id = "drawer-overlay";
  m.doc.body.appendChild(overlay);
  const paint = (spec) => {
    m.view.children.forEach((c) => { c.parentElement = null; });
    m.view.children = [];
    if (spec === "home") {
      const g = m.doc.createElement("div");
      g.className = "hv2-greeting";
      m.view.appendChild(g);
      return;
    }
    if (!spec) { m.view.appendChild(m.doc.createElement("p")); return; }
    const name = typeof spec === "string" ? spec : spec.name;
    const head = m.doc.createElement("div");
    head.className = "page-head";
    const h2 = m.doc.createElement("h2");
    h2.textContent = name + (spec.explicit ? "E" : "");   // textContent reads the badge's "E" too
    if (spec.explicit) {
      const badge = m.doc.createElement("span");
      badge.className = "explicit-badge";
      badge.textContent = "E";
      h2.appendChild(badge);
    }
    head.appendChild(h2);
    m.view.appendChild(head);
  };
  m.ctx.renderCurrentPage = () => paint(pages[m.ctx.location.hash]);
  const go = (hash) => { m.ctx.location.hash = hash; m.ctx.route(); };
  go("#/library");
  return { go, paint };
}
const said = (m) => { m.flushFrames(); return (m.doc.querySelector("#a11y-status") || { textContent: "" }).textContent; };
function tabFocus(m) {
  const tab = m.doc.createElement("a");
  m.tabBar.appendChild(tab);
  tab.focus();
  return tab;
}

test("an explicit page is named without its badge's 'E', in the title and in what is said (nav-7)", () => {
  /* MUTATION: read `head.textContent` directly in landOnPage again -> "Some
     EpisodeE · 4a"; red. */
  const m = mount();
  const { go } = routedPages(m, { "#/library": "Library", "#/episode/x": { name: "Some Episode", explicit: true } });
  tabFocus(m);
  go("#/episode/x");
  assert.strictEqual(m.doc.title, "Some Episode · 4a");
  assert.strictEqual(said(m), "Some Episode");
});

test("a page that paints 'Loading…' first is announced once, when its real paint brings a name (races-6)", () => {
  /* The Foray page. MUTATION: drop the `announceOwedFor` branch from
     landOnPage -> the late paint (navigated:false) says nothing; red.
     MUTATION 2: never clear it -> a later re-render says the name again; red. */
  const m = mount();
  const { go, paint } = routedPages(m, { "#/library": "Library", "#/foray/x": null });
  tabFocus(m);
  go("#/foray/x");
  assert.strictEqual(said(m), "", "the loading paint has no name to say");
  assert.strictEqual(m.doc.title, "4a");
  paint("A Foray");
  m.ctx.pageDidPaint();
  assert.strictEqual(said(m), "A Foray");
  assert.strictEqual(m.doc.title, "A Foray · 4a");
  m.doc.querySelector("#a11y-status").textContent = "";
  m.ctx.pageDidPaint();                           // a later background repaint
  assert.strictEqual(said(m), "", "said once, not on every repaint");
});

test("a late paint for a page the listener already left says nothing (races-6)", () => {
  /* MUTATION: let every late paint announce (`const owed = true` in
     landOnPage) -> the page the listener moved on to is said a second time by
     a paint that was never a navigation; red. */
  const m = mount();
  const { go, paint } = routedPages(m, { "#/library": "Library", "#/forays": "Forays", "#/foray/x": null });
  tabFocus(m);
  go("#/foray/x");
  go("#/forays");
  said(m);
  m.doc.querySelector("#a11y-status").textContent = "";
  paint("Forays");
  m.ctx.pageDidPaint();
  assert.strictEqual(said(m), "");
});

test("Home names itself: 'Home' is said when focus survived, and a lost focus lands on the greeting (a11y-10)", () => {
  /* MUTATION: drop the `home ? "Home"` name -> a tab-bar Home says nothing;
     red. MUTATION 2: drop the `.hv2-greeting` target -> focus lands on bare
     #view; red. */
  const m = mount();
  const { go } = routedPages(m, { "#/library": "Library", "#/": "home" });
  tabFocus(m);
  go("#/");
  assert.strictEqual(said(m), "Home");
  assert.strictEqual(m.doc.title, "4a", "the document stays plain 4a");

  go("#/library");
  const inPage = m.doc.createElement("a");
  m.view.appendChild(inPage);
  inPage.focus();
  go("#/");
  const greeting = m.view.querySelector(".hv2-greeting");
  assert.strictEqual(m.doc.activeElement, greeting, "focus lands on the greeting, not the bare region");
  assert.strictEqual(greeting.getAttribute("tabindex"), "-1");
});
