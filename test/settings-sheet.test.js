/* The gear's Sheet, Settings, About and the appearance setting (Redesign 2026, ambient, BUILD-PLAN screen 9) — and
 * the ownership rules for Sheets that used to be pinned by the drawer-ownership suite.
 *
 * THE RULING THAT FELL: "4 tabs + drawer" (DIRECTION.md "Information architecture"; test-classification.md section 0).
 * This file replaces the drawer-ownership suite, the founder's 2026-09-23 reports about the drawer ("the menu should
 * automatically collapse") and the audit-round-2 drawer modal contract (nav-5): with no drawer there is nothing to
 * collapse, lock, trap or return from. What did NOT fall, and is ported below unchanged in substance: a tap on a
 * sheet's scrim closes that sheet only (stacked sheets close top-first), a sheet returns focus to the control that
 * opened it, a link to the page already on screen closes the sheets and scrolls to the top (nav-8), hardware back
 * dismisses the top-most thing (nav-2, nav-10, A-07), and init() really wires all of it.
 *
 * WHAT THIS PROVES, in order:
 *   A. THE SHEET. One gear opens ONE Sheet: a dialog named "4a menu" listing Settings, Tuning, About and "What 4a
 *      does", in that order, with the veil header (56) and grabber and a 44px close; focus moves in, is trapped, and is
 *      returned to the gear; a row to another page is a plain link the router closes the Sheet for; a row to the page
 *      already on screen closes it; "What 4a does" opens its own Sheet only after the first has gone; and no drawer
 *      remains in the DOM, in index.html, or in the code.
 *   B. SETTINGS. The appearance control is a radiogroup (Dusk, Dawn, Follow system); a choice writes `cp_theme`
 *      through the shim and applies `data-theme` live, Follow system removes it; the stored choice is applied at
 *      boot and again after Delete my data; the controls are mounted into the page and parked again when it leaves;
 *      the Downloads section never shows a dead switch.
 *   C. ABOUT. The version line says what the build can say (version and build, web build, or nothing it cannot
 *      know); the licences are there (fonts OFL, Phosphor MIT).
 *   D. EVERY PAIR AA in both schemes, every control 44px, every word inside the copy rules.
 *   E. THE PORTED OWNERSHIP RULES (above), and the booted page wires the gear and the back button.
 *
 * THE HARNESS. The real app.js in node:vm over a DOM that has what these questions need and the other harnesses
 * lack: an innerHTML that PARSES (the Sheet and the pages are built as markup, so the controls can be found, clicked
 * and measured as the page wrote them), EVENT PROPAGATION — capture down, target, bubble up — real parent links,
 * `hidden`, `inert` honoured by dispatch (a tap on an inert subtree reaches nothing, as in a browser's hit-test),
 * `closest`/`matches` over simple selectors and a `document.activeElement` that `focus()` moves. Not shared with
 * test/modal-and-focus.test.js on purpose: two suites coupled through one harness is how one of them stops
 * covering anything.
 *
 * WHAT IT CANNOT PROVE, said plainly: that a WebView's hit-testing agrees with this dispatch about which of two
 * overlapping fixed layers a finger reaches; the slide's feel; the Veil's blur. Those are the lab build's
 * (the unit's is-it-better pair is shot by tools/ui-lab, steps `gear-sheet`, `settings`, `about`, `interests`).
 *
 * Every test names the mutation that turns it red.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const ok = require("./helpers/oklab.js");
const rules = require("../backend/src/copy/rules.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const APP_SRC = readAppSource();
const INDEX_HTML = read("index.html");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ");
const SETTINGS_CSS = stripComments(read("ui/settings.css"));
const PRIMITIVES_CSS = stripComments(read("ui/primitives.css"));
const TOKENS_CSS = stripComments(read("ui/tokens.css"));

process.on("unhandledRejection", () => {});

/* ---------- a DOM with a tree, markup, propagation, inert, focus ---------- */

const VOID = new Set(["img", "input", "br", "hr", "meta", "link", "source", "wbr"]);
const decode = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

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
    for (const m of s.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)) {
      const v = el.getAttribute(m[1]);
      if (v == null) return false;
      const want = m[2] ?? m[3] ?? m[4];
      if (want !== undefined && v !== want) return false;
    }
    for (const n of nots) if (matchCompound(el, n)) return false;
    return true;
  }
  /* Descendant chains ("#st-menu [data-st-menu]"): the last compound must match the element and each earlier one an
     ancestor, in order. A space inside brackets or parentheses is part of a compound, not a combinator. */
  const tokens = (s) => {
    const out = [];
    let cur = "", depth = 0;
    for (const ch of s.trim()) {
      if (ch === "[" || ch === "(") depth++;
      if (ch === "]" || ch === ")") depth--;
      if (/\s/.test(ch) && depth === 0) { if (cur) { out.push(cur); cur = ""; } } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };
  const matchChain = (el, toks) => {
    if (!matchCompound(el, toks[toks.length - 1])) return false;
    let i = toks.length - 2;
    for (let n = el.parentElement; i >= 0 && n; n = n.parentElement) if (matchCompound(n, toks[i])) i--;
    return i < 0;
  };
  const matches = (el, sel) => String(sel).split(",").some((p) => matchChain(el, tokens(p)));

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
      this._html = "";
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
    get firstElementChild() { return this.children[0] || null; }
    setAttribute(k, v) {
      this._attrs.set(k, String(v));
      if (k === "class") this.className = v;
      if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = String(v);
    }
    getAttribute(k) {
      if (k === "class") return this.className || null;
      if (k.startsWith("data-")) {
        const key = k.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
        if (key in this.dataset) return String(this.dataset[key]);
      }
      return this._attrs.has(k) ? this._attrs.get(k) : null;
    }
    hasAttribute(k) { return this.getAttribute(k) !== null; }
    removeAttribute(k) {
      this._attrs.delete(k);
      if (k.startsWith("data-")) delete this.dataset[k.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())];
    }
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
    get innerHTML() { return this._html; }
    /** Parses markup into a tree: tags, attributes, text. The text of an element is what a screen reader would
        read from it (textContent), so a label can be asserted as the page wrote it. */
    set innerHTML(html) {
      this.children.forEach((c) => { c.parentElement = null; });
      this.children = [];
      this._html = String(html);
      const stack = [{ el: this, parts: [] }];
      const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g;
      let m;
      while ((m = re.exec(this._html))) {
        if (m[4] !== undefined) { stack[stack.length - 1].parts.push(decode(m[4])); continue; }
        if (m[2] === undefined) continue;   // a comment
        const [, closing, tag, rest] = m;
        if (closing) {
          if (stack.length > 1) { const top = stack.pop(); top.el.textContent = top.parts.join(""); stack[stack.length - 1].parts.push(top.el.textContent); }
          continue;
        }
        const kid = new El(tag);
        for (const a of rest.matchAll(/([a-zA-Z_:][\w:.-]*)(?:="([^"]*)")?/g)) kid.setAttribute(a[1], decode(a[2] ?? ""));
        stack[stack.length - 1].el.appendChild(kid);
        if (!VOID.has(tag.toLowerCase()) && !/\/\s*$/.test(rest)) stack.push({ el: kid, parts: [] });
      }
      while (stack.length > 1) { const top = stack.pop(); top.el.textContent = top.parts.join(""); stack[stack.length - 1].parts.push(top.el.textContent); }
      this.textContent = stack[0].parts.join("");
    }
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
    /** A browser-shaped dispatch: a tap on an inert subtree reaches nothing (hit-testing skips inert), otherwise
        capture from <body> down, the target, then bubble up. `stopPropagation` and `preventDefault` work. */
    dispatch(type, extra = {}) {
      for (let n = this; n; n = n.parentElement) if (n.hasAttribute("inert")) return { reached: false };
      const chain = [];
      for (let n = this; n; n = n.parentElement) chain.push(n);
      const ev = {
        type, target: this, currentTarget: null, _stopped: false, defaultPrevented: false, ...extra,
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
    const ev = { key, preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false, ...extra };
    (doc._listeners.get("keydown") || []).forEach((fn) => fn(ev));
    return ev;
  };
  return { doc, El };
}

/**
 * Mount app.js over the chrome index.html gives it: the top bar with the gear and ↻, a <meta name=theme-color>, and
 * #view. `boot: true` lets the REAL init() wire everything, serving the committed data/*.json off disk; otherwise the
 * harness calls the binders init would, which is faster and is what most tests use. Reduce Motion is reported, so a
 * Sheet's slide is skipped and a close is synchronous (the animated path is the lab's).
 */
function mount({ boot = false, capacitor = null, seed = {}, reduce = true } = {}) {
  const { doc } = makeDocument();
  const add = (tag, id, cls, into = doc.body) => {
    const el = doc.createElement(tag);
    if (id) el.id = id;
    if (cls) el.className = cls;
    into.appendChild(el);
    return el;
  };
  const meta = add("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", "#151119");
  const topbar = add("header", null, "topbar");
  const menu = add("button", "menu-btn", null, topbar);
  menu.setAttribute("aria-label", "Settings");
  add("button", "refresh-btn", null, topbar);
  const view = add("main", "view");
  for (const id of ["banner-slot", "pl-form", "pl-input", "pl-note", "tab-topics", "tab-shows",
    "sh-form", "sh-input", "sh-note", "sh-results", "browse-all-link", "pl-remove", "banner-done"]) {
    add("div", id, null, view);
  }

  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => {
      if (!boot) return new Promise(() => {});
      const file = path.join(ROOT, String(url));
      const exists = fs.existsSync(file);
      return Promise.resolve({
        ok: exists, status: exists ? 200 : 404,
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
    matchMedia: (q) => ({ matches: reduce && /reduce/.test(String(q)) }),
    addEventListener(t, fn) { (ctx._winListeners[t] ||= []).push(fn); }, removeEventListener() {},
    _winListeners: {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { scrollRestoration: "auto", back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, Event,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    encodeURIComponent, decodeURIComponent,
    scrollY: 0, scrollTo() {}, scrollBy() {},
    dispatchEvent(ev) { for (const fn of ctx._winListeners[ev.type] || []) fn(ev); return true; },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  /* The shell's bridge, when a test stands in for the native app: only the App plugin's back button is modelled. */
  if (capacitor) ctx.Capacitor = capacitor;
  vm.createContext(ctx);
  runAppSource(APP_SRC, ctx);
  ctx.window.forayDiagnosticReport = () => "4a playback diagnostics — v1";
  ctx.window.forayDiagnosticClear = () => true;
  if (boot) {
    ctx.window.ForayPlayer = {
      listForays: () => [], forayResumeList: () => [], forayResume: () => null,
      forayDriftIsClean: () => true, canPlay: () => false,
      fmtClock: (n) => String(Math.round(n)), fmtSpan: (n) => `${Math.round(n)}s`, resolve: () => null,
    };
  } else {
    ctx.bindSettingsChrome();
    ctx.bindSettingSwitches();
    ctx.bindDeveloperToggles();
    ctx.bindDiagnosticsControl();
    ctx.bindDeleteControl();
    /* init() also runs here — the document is "complete" — but its boot fetch never answers in this mode, so it
       stops before the line that binds the chrome and leaves the gear and ↻ disabled (nav-9,
       test/boot-path.test.js). The binders above ARE that line's work, so its last step is taken too. */
    ctx.setBootChrome(true);
  }
  const $ = (s) => doc.body.querySelector(s);
  const $$ = (s) => doc.body.querySelectorAll(s);
  return { ctx, doc, $, $$, menu, topbar, view, store, meta, evalIn: (src) => vm.runInContext(src, ctx) };
}

async function mountBooted(opts = {}) {
  const m = mount({ boot: true, ...opts });
  for (let i = 0; i < 200 && !m.evalIn("state.ready"); i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(m.evalIn("state.ready"), "the real init() never finished against the committed data files");
  /* A booted first-time page opens its explainer, a real dialog that takes the page out of reach
     (test/modal-and-focus.test.js pins that). Dismiss it the way a listener would. */
  m.ctx.closeAllSheets();
  return m;
}

const isInert = (el) => el.hasAttribute("inert");
/** The words a screen reader reads from `el`, one string per leaf, so sentences stay apart. */
const wordsOf = (el) => el.tree().filter((e) => e.children.length === 0).map((e) => e.textContent).filter(Boolean);
const rowKeys = (m) => m.$$("#st-menu [data-st-menu]").map((r) => r.getAttribute("data-st-menu"));

/* ==================================================================== */
/* A. THE GEAR'S SHEET                                                   */
/* ==================================================================== */

test("the gear opens ONE Sheet: a dialog named '4a menu' listing Settings, Tuning, About and What 4a does, in that order", () => {
  /* MUTATION 1: reorder ST_MENU, or drop a row -> the list assertion is red. MUTATION 2: drop `role="dialog"` or the
     aria-label from stSheetHtml -> the name assertions are red. MUTATION 3: open the Sheet twice (drop the
     `settingsMenuIsOpen()` early return) -> two `#st-menu` appear. */
  const m = mount();
  m.menu.focus();
  m.menu.click();
  const sheet = m.$("#st-menu");
  assert.ok(sheet, "the gear built the Sheet");
  assert.strictEqual(sheet.hidden, false);
  const panel = sheet.querySelector('[role="dialog"]');
  assert.ok(panel, "it is a dialog");
  assert.strictEqual(panel.getAttribute("aria-modal"), "true");
  assert.strictEqual(panel.getAttribute("aria-label"), "4a menu");
  assert.deepStrictEqual(rowKeys(m), ["settings", "tuning", "about", "what"]);
  assert.deepStrictEqual(m.$$("#st-menu a[data-st-menu]").map((a) => a.getAttribute("href")), ["#/settings", "#/interests", "#/about"],
    "the three pages are links, Tuning on the route it already had");
  assert.strictEqual(m.$("#st-menu [data-st-menu=\"what\"]").tagName, "BUTTON", "and the fourth opens a Sheet, so it is a button");
  assert.deepStrictEqual(m.$$("#st-menu [data-st-menu]").map((r) => r.querySelector(".st-row-label").textContent),
    ["Settings", "Tuning", "About", "What 4a does"]);
  m.ctx.openSettingsMenu(m.menu);
  m.ctx.openSettingsMenu(m.menu);
  assert.strictEqual(m.$$("#st-menu").length, 1, "one gear, one Sheet: asking twice never stacks two");
  assert.ok(isInert(m.topbar), "(and the gear is behind the Sheet's scrim, so a second tap cannot even reach it)");
});

test("the Sheet's header is the veil at 56 with a grabber and a 44px close (i-x); the panel pulls down", () => {
  /* The direction's words: "veil header 56 with grabber, i-x 44". MUTATION: drop `veil` or the grabber from
     stSheetHtml, make the close a text glyph, or drop `data-sheet-drag` (the grabber would promise a pull down the
     panel does not answer). */
  const m = mount();
  m.menu.click();
  const head = m.$("#st-menu .ag-sheet-head");
  assert.ok(head.classList.contains("veil"), "the header is the Veil, the only glass");
  assert.ok(head.querySelector(".ag-grabber"), "with the grabber");
  const close = head.querySelector("[data-st-close]");
  assert.strictEqual(close.getAttribute("aria-label"), "Close");
  assert.ok(close.classList.contains("ag-btn-size-44") && close.classList.contains("ag-btn-icon"), "a 44px icon button");
  assert.match(close.innerHTML === "" ? close._html : close.innerHTML, /^$/, "built from markup, not text");
  assert.ok(close.querySelector("svg"), "the glyph is the sprite's i-x (an svg), not a text cross");
  assert.match(close.querySelector("use").getAttribute("href"), /icons\.svg#i-x$/);
  assert.ok(!/[✕×✖]/.test(m.$("#st-menu").textContent), "no text glyph stands in for the icon");
  const px = (rule) => {
    const body = new RegExp(`${rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(PRIMITIVES_CSS)[1];
    return body;
  };
  assert.match(px(".ag .ag-sheet-head"), /min-height:\s*calc\(var\(--tap\) \+ var\(--s-3\)\)/, "44 + 12 = 56");
  assert.match(px(".ag .ag-btn-icon"), /width:\s*var\(--tap\);\s*height:\s*var\(--tap\)/, "the icon button is 44 x 44");
  assert.ok(m.$("#st-menu .st-panel").hasAttribute("data-sheet-drag"), "the panel opts in to the pull down");
});

test("focus moves into the Sheet, is trapped there, and is returned to the gear; the page behind goes inert", () => {
  /* MUTATION 1: drop `focusQuietly(panel)` from openSheet -> focus stays on the gear. MUTATION 2: drop the Tab
     branch from onSheetKeydown -> Tab walks out. MUTATION 3: drop `returnFocus` from stOpenSheet (or the opener
     record) -> focus lands on <body> after close. */
  const m = mount();
  const page = m.doc.createElement("button");
  m.view.appendChild(page);
  m.menu.focus();
  m.menu.click();
  const panel = m.$("#st-menu .st-panel");
  assert.strictEqual(m.doc.activeElement, panel, "focus is in the dialog, which carries its name");
  assert.ok(isInert(m.view) && isInert(m.topbar), "the page and the top bar are out of reach");
  assert.ok(!isInert(m.$("#st-menu")), "the Sheet is not");
  assert.ok(m.doc.body.classList.contains("fy-sheet-open"), "and the page scroll is locked");
  const focusables = [...panel.querySelectorAll("a[href], button:not([disabled])")];
  assert.strictEqual(focusables.length, 5, "the close and the four rows");
  focusables[focusables.length - 1].focus();
  m.doc.key("Tab");
  assert.strictEqual(m.doc.activeElement, focusables[0], "Tab from the last control wraps to the first");
  m.doc.key("Tab", { shiftKey: true });
  assert.strictEqual(m.doc.activeElement, focusables[focusables.length - 1], "Shift+Tab from the first wraps to the last");
  const esc = m.doc.key("Escape");
  assert.strictEqual(esc.defaultPrevented, true);
  assert.strictEqual(m.$$("#st-menu").length, 0, "Escape closes it, and the Sheet leaves the DOM");
  assert.strictEqual(m.doc.activeElement, m.menu, "focus is back on the gear");
  assert.ok(!isInert(m.view) && !isInert(m.topbar) && !m.doc.body.classList.contains("fy-sheet-open"), "and everything it took is returned");
});

test("the close button and the scrim close the Sheet, and each hands focus back to the gear", () => {
  /* MUTATION: drop the scrim or the close listener in stOpenSheet -> the matching assertion is red. */
  const m = mount();
  for (const which of ["close", "scrim"]) {
    m.menu.focus();
    m.menu.click();
    const target = which === "close" ? m.$("#st-menu [data-st-close]") : m.$("#st-menu [data-st-scrim]");
    assert.strictEqual(target.dispatch("click").reached, true, `${which} is reachable`);
    assert.strictEqual(m.$$("#st-menu").length, 0, `${which} closed the Sheet`);
    assert.strictEqual(m.doc.activeElement, m.menu, `${which}: focus is back on the gear`);
    assert.strictEqual(m.menu.getAttribute("aria-expanded"), "false");
  }
});

test("NO DRAWER remains: not in index.html, not in the DOM after the page is wired, not in the code", async () => {
  /* The acceptance line: "no drawer remains in the DOM". MUTATION: put `<nav id="drawer">` (or its overlay) back in
     index.html, restore `ui/drawer.js` to the script list, or let any ui/*.js create an element with that id -> red. */
  assert.ok(!/id="drawer|drawer-overlay|class="drawer-|ui\/drawer/.test(INDEX_HTML), "index.html carries no drawer markup and loads no drawer script");
  assert.ok(!fs.existsSync(path.join(ROOT, "ui", "drawer.js")) && !fs.existsSync(path.join(ROOT, "ui", "drawer-dev.js")), "and the files are gone");
  const m = await mountBooted();
  m.menu.click();
  m.ctx.parkSettingsHost();
  assert.deepStrictEqual(m.$$("#drawer, #drawer-overlay, .drawer-item, .drawer-section, .drawer-dev").map((e) => e.id || e.className), [],
    "nothing drawer-shaped in the booted page, with the Sheet open");
  const code = stripComments(APP_SRC);
  for (const dead of ["openDrawer", "drawerIsOpen", "onDrawerAction", "bindDrawerChrome", "renderDrawer", "drawer-open", '"#drawer"', "#drawer-overlay"]) {
    assert.ok(!code.includes(dead), `${dead} is back in the client`);
  }
  assert.strictEqual(m.evalIn('typeof openDrawer'), "undefined");
});

test("a row to another page is a plain link: the router closes the Sheet, and focus lands on the new page's heading", () => {
  /* The three page rows are links, so the browser's own navigation runs and route() closes every Sheet when the hash
     changes. The Sheet is mid-slide when route() lands focus, and the link it landed on leaves with the Sheet:
     `stCloseSheet` lands focus on the heading once the Sheet is gone. MUTATION 1: make a row's click handler call
     preventDefault -> the "left to the router" assertion is red. MUTATION 2: drop the `landOnPage` fallback from
     stCloseSheet -> focus is left on nothing; red. */
  const m = mount();
  vm.runInContext("state.ready = true;", m.ctx);
  m.ctx.renderCurrentPage = () => {
    m.view.children.forEach((c) => { c.parentElement = null; });
    m.view.children = [];
    const head = m.doc.createElement("div");
    head.className = "st-head";
    const h1 = m.doc.createElement("h1");
    h1.textContent = "Settings";
    head.appendChild(h1);
    m.view.appendChild(head);
  };
  m.menu.focus();
  m.menu.click();
  const link = m.$('#st-menu a[data-st-menu="settings"]');
  link.focus();
  const { ev } = link.dispatch("click");
  assert.strictEqual(ev.defaultPrevented, false, "a different page: left to the router");
  assert.strictEqual(m.$$("#st-menu").length, 1, "which has not run yet, so the Sheet is still up");
  m.ctx.location.hash = "#/settings";
  m.ctx.route();
  assert.strictEqual(m.$$("#st-menu").length, 0, "route() closed the Sheet on the hashchange");
  assert.strictEqual(m.doc.activeElement, m.view.querySelector(".st-head").querySelector("h1"), "focus is on the page's heading, not stranded on the removed link");
});

test("a row to the page already on screen closes the Sheet and navigates nowhere", () => {
  /* The same hash fires no hashchange, so the Sheet would stay. MUTATION: drop the same-hash branch from
     onSettingsMenuClick -> the Sheet stays up over the page it was asked to show; red. */
  const m = mount();
  m.ctx.location.hash = "#/settings";
  m.menu.click();
  const { ev } = m.$('#st-menu a[data-st-menu="settings"]').dispatch("click");
  assert.strictEqual(ev.defaultPrevented, true, "handled here, since the router will not see it");
  assert.strictEqual(m.$$("#st-menu").length, 0, "and the Sheet is gone");
});

test("What 4a does opens its own Sheet, only after the gear's has gone, and Escape closes it back to the gear", () => {
  /* The owner closes every sheet ABOVE the one it is closing, so a second Sheet opened while the first is still
     leaving would be closed with it. MUTATION: open the second without waiting for `after` (call openWhatSheet
     straight from the click) -> with a slide in progress it vanishes; here the sheet-count assertion goes red. */
  const m = mount({ reduce: false });
  m.menu.focus();
  m.menu.click();
  m.$('#st-menu [data-st-menu="what"]').click();
  assert.strictEqual(m.$$("#st-what").length, 0, "not yet: the gear's Sheet is still sliding out");
  assert.strictEqual(m.ctx.openSheetCount(), 1, "one Sheet at a time");
  return new Promise((resolve) => setTimeout(() => {
    assert.strictEqual(m.$$("#st-menu").length, 0, "the gear's Sheet is gone");
    const what = m.$("#st-what");
    assert.ok(what, "and its own Sheet is up");
    assert.strictEqual(m.ctx.openSheetCount(), 1);
    assert.strictEqual(what.querySelector(".ag-sheet-head h2").textContent, "What 4a does");
    const body = what.querySelector(".st-sheet-body").textContent;
    assert.match(body, /4a picks a few podcasts a day and says why each one is there\./);
    assert.match(body, /About a third of each day sits outside your usual subjects\./);
    assert.match(body, /Forays\./);
    m.doc.key("Escape");
    setTimeout(() => {
      assert.strictEqual(m.$$("#st-what").length, 0, "Escape closes it");
      assert.strictEqual(m.doc.activeElement, m.menu, "and focus is back on the gear, not on <body>");
      resolve();
    }, 400);
  }, 400));
});

test("the gear is bound once, announces what it opens, and is the same control Today draws", () => {
  /* MUTATION: drop `aria-haspopup` / `aria-expanded` from bindSettingsGear, or let it bind twice (a second listener
     would open then close the Sheet in one tap, and the count below would be 0). */
  const m = mount();
  assert.strictEqual(m.menu.getAttribute("aria-haspopup"), "dialog");
  assert.strictEqual(m.menu.getAttribute("aria-expanded"), "false");
  m.ctx.bindSettingsGear(m.menu);
  m.ctx.bindSettingsGear(m.menu);
  m.menu.click();
  assert.strictEqual(m.menu.getAttribute("aria-expanded"), "true");
  assert.strictEqual(m.$$("#st-menu").length, 1, "one tap, one Sheet, however many times it was bound");
  const todayGear = m.doc.createElement("button");
  todayGear.setAttribute("data-today-gear", "");
  m.ctx.closeAllSheets();
  m.view.innerHTML = "";                 // the boot skeleton init() painted has a (disabled) gear of its own
  m.view.appendChild(todayGear);
  m.ctx.bindTodayPlay(m.view);
  todayGear.click();
  assert.strictEqual(m.$$("#st-menu").length, 1, "Today's own gear opens the very same Sheet");
  assert.match(APP_SRC.replace(/\/\*[\s\S]*?\*\//g, " "), /bindSettingsGear\(gear\)/, "ui/home.js binds it through the one helper");
});

test("the Sheets' words obey the copy rules: no we/us/our, subject not topic, no banned words, every sentence under 18 words", () => {
  /* MUTATION: put "We pick podcasts" (or "topic", or "deep dive") in ST_MENU or whatSheetBodyHtml -> red. */
  const m = mount();
  m.menu.click();
  const hub = wordsOf(m.$("#st-menu"));
  m.ctx.closeAllSheets();
  m.ctx.openWhatSheet(m.menu);
  const what = wordsOf(m.$("#st-what"));
  assert.ok(hub.length >= 8 && what.length >= 4, "fixture assumption: the Sheets have words");
  for (const part of [...hub, ...what]) {
    assert.ok(!/\b(we|us|our)\b/i.test(part), `we/us/our in: ${part}`);
    assert.ok(!/\btopics?\b/i.test(part), `"subject", not "topic": ${part}`);
    for (const banned of rules.BANNED) assert.ok(!banned.test(part), `${banned} in: ${part}`);
    for (const sentence of part.split(/(?<=[.!?])\s+/)) assert.ok(rules.wordCount(sentence) <= rules.MAX_WHY_LINE_WORDS, `over 18 words: ${sentence}`);
  }
});

/* ==================================================================== */
/* B. SETTINGS: appearance, the host, downloads                          */
/* ==================================================================== */

const chip = (m, value) => m.$(`[data-st-theme] [data-st-value="${value}"]`);

test("Appearance is a radiogroup of Dusk / Dawn / Follow system; Dawn writes cp_theme and applies data-theme live", () => {
  /* The unit's line: "appearance Dusk / Dawn / Follow system (writes cp_theme, applies data-theme live)". MUTATION 1:
     write the key under a name without the prefix, or not at all -> the store assertions are red. MUTATION 2:
     applyTheme sets the attribute on <body> instead of <html> -> tokens.css reads it on :root, so the room would not
     change; red. MUTATION 3: leave data-theme set for "system" -> the last assertion is red (Follow system would
     pin whatever was chosen last). */
  const m = mount();
  m.ctx.location.hash = "#/settings";
  m.ctx.renderSettings();
  const group = m.$("[data-st-theme]");
  assert.ok(group && group.getAttribute("role") === "radiogroup", "a radiogroup");
  assert.deepStrictEqual(m.$$("[data-st-theme] [data-st-value]").map((c) => c.textContent), ["Dusk", "Dawn", "Follow system"]);
  assert.strictEqual(m.$$("[data-st-theme] [aria-checked=\"true\"]").length, 1, "exactly one is checked");
  assert.strictEqual(chip(m, "system").getAttribute("aria-checked"), "true", "Follow system is the default");
  assert.strictEqual(m.doc.documentElement.getAttribute("data-theme"), null, "and nothing is pinned");

  chip(m, "dawn").click();
  assert.strictEqual(m.ctx.themePref(), "dawn");
  assert.strictEqual(JSON.parse(m.store.get("cp_theme")), "dawn", "written through the shim under cp_theme");
  assert.strictEqual(m.doc.documentElement.getAttribute("data-theme"), "dawn", "applied on <html>, live, with no reload");
  assert.strictEqual(m.meta.getAttribute("content"), "#F7F2EB", "and the status bar follows the room");
  assert.strictEqual(chip(m, "dawn").getAttribute("aria-checked"), "true");
  assert.strictEqual(chip(m, "system").getAttribute("aria-checked"), "false");
  assert.ok(chip(m, "dawn").classList.contains("is-selected") && !chip(m, "system").classList.contains("is-selected"), "the picture follows the state");
  assert.strictEqual(chip(m, "dawn").getAttribute("tabindex"), "0", "the roving Tab stop moved with it");
  assert.strictEqual(chip(m, "system").getAttribute("tabindex"), "-1");

  chip(m, "dusk").click();
  assert.strictEqual(m.doc.documentElement.getAttribute("data-theme"), "dusk", "Dusk pins Dusk even on a phone set to light");
  assert.strictEqual(m.meta.getAttribute("content"), "#14110F");
  chip(m, "system").click();
  assert.strictEqual(m.doc.documentElement.getAttribute("data-theme"), null, "Follow system removes the pin, so the media query decides");
  assert.strictEqual(JSON.parse(m.store.get("cp_theme")), "system");
});

test("a scheme change is a cut: the page's transitions are off while the colours change, and back on after", () => {
  /* Under Reduce Motion the one reduced block turns every colour change into a 200ms crossfade of everything, which a
     whole-page scheme change should not be (and ui-lab's reduced-motion gate counts it as motion). MUTATION 1: drop
     `stCutTransitions` from onSettingsClick -> the attribute is written with the class off; red. MUTATION 2: drop the
     `finally` that removes the class -> the page keeps transitions off for good; red. MUTATION 3: drop the CSS rule or
     its `!important` (tokens.css's block is !important too) -> the rule assertion is red. */
  const m = mount();
  m.ctx.location.hash = "#/settings";
  m.ctx.renderSettings();
  const page = m.$(".st-page");
  const root = m.doc.documentElement;
  const seen = [];
  const set = root.setAttribute.bind(root);
  root.setAttribute = (k, v) => { if (k === "data-theme") seen.push(page.classList.contains("st-swap")); set(k, v); };
  chip(m, "dawn").click();
  assert.deepStrictEqual(seen, [true], "data-theme was written while the page's transitions were off");
  assert.strictEqual(page.classList.contains("st-swap"), false, "and they are back on once the colours have settled");
  assert.match(SETTINGS_CSS, /\.ag\.st-swap, \.ag\.st-swap \*, \.ag\.st-swap \*::before, \.ag\.st-swap \*::after \{ transition: none !important; \}/,
    "the rule that does it, as strong as the reduced-motion block it outranks");
});

test("the arrow keys move the appearance choice, as native radios do", () => {
  /* MUTATION: drop the keydown listener from renderSettings (or the ArrowRight branch of stSegKey) -> red. */
  const m = mount();
  m.ctx.location.hash = "#/settings";
  m.ctx.renderSettings();
  const page = m.$(".st-page");
  chip(m, "system").focus();
  const ev = { key: "ArrowLeft", target: chip(m, "system"), preventDefault() { this.defaultPrevented = true; } };
  page.dispatch("keydown", { key: "ArrowLeft" });                        // a key on the page itself is not a radio's
  assert.strictEqual(m.ctx.themePref(), "system");
  chip(m, "system").dispatch("keydown", { key: "ArrowLeft" });
  assert.strictEqual(m.ctx.themePref(), "dawn", "the arrow moved the choice one place");
  assert.strictEqual(m.doc.activeElement, chip(m, "dawn"), "and the focus with it");
  chip(m, "dawn").dispatch("keydown", { key: "ArrowRight" });
  assert.strictEqual(m.ctx.themePref(), "system", "and back");
  assert.ok(ev, "(the unused literal keeps the shape of a real KeyboardEvent in view)");
});

test("the stored choice is applied at boot, a bad value reads as Follow system, and Delete my data puts the room back", async () => {
  /* MUTATION 1: drop `applyStoredTheme()` after `await waitForStorage()` in init() -> the booted page never wears
     the stored scheme. MUTATION 2: drop it from clearLocalData's caller (deleteMyData) -> the room stays Dawn after
     the key is gone. MUTATION 3: have themePref() return the raw stored value -> "plum" would pin nothing but
     still read as chosen. */
  const m = await mountBooted({ seed: { cp_theme: JSON.stringify("dawn") } });
  assert.strictEqual(m.doc.documentElement.getAttribute("data-theme"), "dawn", "init() applied the stored scheme before the first route");

  const bad = mount({ seed: { cp_theme: JSON.stringify("plum") } });
  assert.strictEqual(bad.ctx.themePref(), "system", "an unrecognised value is the default");
  bad.ctx.applyStoredTheme();
  assert.strictEqual(bad.doc.documentElement.getAttribute("data-theme"), null);

  /* Delete my data: the purge removes every cp_ key (cp_theme included), then the page reloads its profile. */
  await m.ctx.clearStoredKeys();
  assert.ok(!m.store.has("cp_theme"), "the purge took the key");
  assert.match(m.ctx.deleteMyData.toString(), /applyStoredTheme\(\)/, "and deleteMyData repaints the room from it");
  m.ctx.applyStoredTheme();
  assert.strictEqual(m.doc.documentElement.getAttribute("data-theme"), null, "the room follows the phone again");
});

test("Settings mounts the controls into its page and parks them again when the page leaves", async () => {
  /* The host is moved, never rebuilt: its listeners and running state survive a visit. MUTATION 1: drop
     `mountSettingsHost(slot)` from renderSettings -> the controls are not on the page. MUTATION 2: drop
     `parkSettingsHost()` from renderCurrentPage -> the next page's innerHTML takes the host with it (in a browser it
     is detached and every lookup the builders make fails); here the host is no longer a child of <body>. */
  const m = await mountBooted();
  const host = m.$("#settings-host");
  assert.ok(host.parentElement === m.doc.body && host.hidden, "parked in <body>, hidden, before the visit");
  m.ctx.location.hash = "#/settings";
  m.ctx.route();
  const slot = m.view.querySelector("[data-st-slot]");
  assert.ok(slot && host.parentElement === slot, "the page's slot holds the host");
  assert.strictEqual(host.hidden, false);
  const sections = host.children.map((c) => c.getAttribute("data-st-section"));
  assert.deepStrictEqual(sections, ["listening", "downloads", "developer", "data"]);
  const ids = host.tree().map((e) => e.id).filter(Boolean);
  for (const id of ["family-toggle", "autoadvance-toggle", "interlude-toggle", "voice-open", "diag-open", "delete-data"]) {
    assert.ok(ids.includes(id), `${id} is on the Settings page`);
  }
  assert.strictEqual(m.$("#family-toggle").textContent, "Family mode: off", "painted from live state on mount");
  assert.strictEqual(m.$("#autoadvance-toggle").getAttribute("aria-checked"), "true");
  const familyButton = m.$("#family-toggle");
  m.ctx.location.hash = "#/library";
  m.ctx.route();
  assert.ok(host.parentElement === m.doc.body && host.hidden, "parked again on the next page");
  assert.ok(m.$("#family-toggle") === familyButton, "the very same button (its listener and state intact)");
  m.ctx.location.hash = "#/settings";
  m.ctx.route();
  assert.ok(m.view.querySelector("[data-st-slot]").children.includes(host), "and mounted again on the next visit");
});

test("Settings: the head is the shared one (Back, then the title), Appearance comes first, Delete my data last", async () => {
  /* MUTATION: put the Appearance section after the host, or add a control below the "Your data" section -> red. */
  const m = await mountBooted();
  m.ctx.location.hash = "#/settings";
  m.ctx.route();
  const page = m.$(".st-page");
  assert.strictEqual(page.getAttribute("data-st-page"), "settings");
  const back = page.querySelector("a.back");
  assert.ok(back && back.getAttribute("href") === "#/" && back.getAttribute("aria-label") === "Back", "the history-aware ‹, with the cold-open fallback");
  assert.strictEqual(page.querySelector(".st-head h1").textContent, "Settings");
  assert.strictEqual(page.querySelectorAll("h1").length, 1, "the page's one h1 (the top bar's steps aside on these pages)");
  const heads = page.querySelectorAll("h3").map((h) => h.textContent);
  assert.deepStrictEqual(heads, ["Appearance", "Listening", "Downloads", "Your data"]);
  const leaves = page.tree().filter((e) => e.id && e.tagName === "BUTTON").map((e) => e.id);
  assert.strictEqual(leaves[leaves.length - 1], "delete-data", "the one control that cannot be undone is the last");
  assert.strictEqual(m.doc.body.classList.contains("view-settings"), true, "and the page wears its body class (the legacy top bar steps aside)");
});

test("Downloads: off the shell the section says so in one line, on the shell it carries the cellular switch, never a dead one", async () => {
  /* The founder default (downloads.js): NO BRIDGE, NO CONTROL. MUTATION 1: draw the cellular switch without
     `state.downloadBridge` -> the web shows a switch that governs nothing. MUTATION 2: drop syncDownloadsNote -> the
     section is a heading over nothing. */
  const web = await mountBooted();
  web.ctx.location.hash = "#/settings";
  web.ctx.route();
  const list = web.$('[data-st-section="downloads"]');
  assert.ok(!list.tree().some((e) => e.id === "downloads-cellular-toggle"), "no switch off the shell");
  assert.strictEqual(list.querySelector("[data-st-no-downloads]").textContent, "Downloads are in the 4a apps for iPhone and Android.");

  const shell = mount();
  shell.evalIn("state.downloadBridge = { stub: true };");
  shell.ctx.bindSettingSwitches();
  shell.ctx.paintSettings();
  const section = shell.$('[data-st-section="downloads"]');
  const sw = section.tree().find((e) => e.id === "downloads-cellular-toggle");
  assert.ok(sw, "the switch is in the Downloads section on the shell");
  assert.strictEqual(sw.textContent, "Download over cellular: off");
  assert.ok(!section.querySelector("[data-st-no-downloads]"), "and the no-downloads line is not");
});

/* ==================================================================== */
/* C. ABOUT                                                              */
/* ==================================================================== */

test("About says the version it can know, and the licences: fonts OFL, Phosphor MIT", () => {
  /* MUTATION 1: drop the Phosphor row, or the font row, from ST_LICENCES -> red. MUTATION 2: print the build number
     where the version belongs, or the web id in full -> the text assertions are red. */
  const m = mount();
  m.ctx.location.hash = "#/about";
  m.ctx.renderAbout();
  assert.strictEqual(m.$(".st-page").getAttribute("data-st-page"), "about");
  assert.strictEqual(m.$(".st-head h1").textContent, "About");
  assert.strictEqual(m.$("[data-st-version]").textContent, "Web version", "with no stamp, only what is true");

  m.ctx.window.forayBuildStamp = { shell: true, web: "abcdef0123456789", native: "2026100501", version: "1.4.0" };
  assert.strictEqual(m.ctx.aboutVersionText(), "Version 1.4.0 (2026100501)", "the shell: marketing version and build number");
  m.ctx.window.forayBuildStamp = { shell: false, web: "abcdef0123456789", native: null, version: null };
  assert.strictEqual(m.ctx.aboutVersionText(), "Web build abcdef01", "the web: the first eight characters of the deploy id");
  m.ctx.window.forayBuildStamp = { shell: true, web: null, native: "2026100501", version: null };
  assert.strictEqual(m.ctx.aboutVersionText(), "Build 2026100501");

  const text = m.$(".st-page").textContent;
  assert.match(text, /Fraunces and DM Sans\s*SIL Open Font License 1\.1/);
  assert.match(text, /Phosphor Icons\s*MIT License/);
  assert.match(text, /A daily podcast picker\./);
  assert.match(text, /Artwork and audio belong to each show's publisher\. 4a plays from their own feeds\./);
});

test("About repaints its version line when the build stamp arrives after the page", () => {
  /* The shell answers getInfo a beat after boot. MUTATION: drop the `foray:build-stamp` listener, or the dispatch in
     player/client.js -> the page keeps saying "Web version" inside the app. */
  const m = mount();
  m.ctx.location.hash = "#/about";
  m.ctx.renderAbout();
  assert.strictEqual(m.$("[data-st-version]").textContent, "Web version");
  m.ctx.window.forayBuildStamp = { version: "1.4.0", native: "2026100501" };
  m.ctx.dispatchEvent(new Event("foray:build-stamp"));
  assert.strictEqual(m.$("[data-st-version]").textContent, "Version 1.4.0 (2026100501)");
  assert.match(fs.readFileSync(path.join(ROOT, "player", "client.js"), "utf8"), /window\.forayBuildStamp = stamp;\s*window\.dispatchEvent\(new Event\("foray:build-stamp"\)\)/,
    "player/client.js hands the stamp over and announces it");
});

test("About's What 4a does opens the explainer Sheet over the page, and the Sheet hands focus back to that row", () => {
  /* MUTATION: drop the click wiring in renderAbout -> the row does nothing. */
  const m = mount();
  m.ctx.location.hash = "#/about";
  m.ctx.renderAbout();
  const row = m.$("[data-st-what]");
  row.focus();
  row.click();
  assert.ok(m.$("#st-what"), "the explainer is up");
  m.doc.key("Escape");
  assert.strictEqual(m.$$("#st-what").length, 0);
  assert.strictEqual(m.doc.activeElement, row, "focus returns to the row that asked");
});

/* ==================================================================== */
/* D. EVERY PAIR AA, EVERY CONTROL 44, EVERY WORD IN THE RULES            */
/* ==================================================================== */

/** The declarations of one scheme block of ui/tokens.css, as { name: value }. */
function scheme(selectorRe) {
  const body = new RegExp(`(?:^|\\n)${selectorRe} \\{([^}]*)\\}`).exec(TOKENS_CSS)[1];
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()]));
}
const DUSK = scheme(":root, \\[data-theme=\"dusk\"\\]");
const DAWN = scheme("\\[data-theme=\"dawn\"\\]");

function colour(map, token) {
  const v = map[token];
  assert.ok(v, `${token} is declared`);
  const hex = /^#([0-9a-fA-F]{6})$/.exec(v);
  if (hex) return { rgb: ok.hexToRgb(v), a: 1 };
  const fn = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\)$/.exec(v);
  assert.ok(fn, `${token}: a colour this test can read, got "${v}"`);
  return { rgb: [fn[1], fn[2], fn[3]].map((n) => Number(n) / 255), a: fn[4] === undefined ? 1 : Number(fn[4]) };
}
const solid = (map, token, under) => {
  const c = colour(map, token);
  return c.a === 1 ? c.rgb : ok.over(c.rgb, c.a, under);
};

test("every text pair on the Settings, Tuning and About pages is AA in Dusk and in Dawn; every non-text mark clears 3:1", () => {
  /* The unit's line: "every pair AA in both schemes". The pairs are the ones ui/settings.css and the markup actually
     use: body text on the page and on a raised row (the row is the overlay over bg1), the caption and note text-2 on
     both, the segmented control's unselected text-2 on its bg1 track, the selected Chip's lamp-ink on the Lamp fill;
     and the non-text marks: the switch knob on its track (both states), the chevrons (text-3), the focus ring
     (lamp-text) on the page. MUTATION: set `.st-note { color: var(--text-3) }` is still AA, so the mutation that kills
     this is in tokens.css: lower Dusk's --text-2 to #6A625A -> red here, naming the pair. */
  const rows = [];
  for (const [name, map] of [["Dusk", DUSK], ["Dawn", DAWN]]) {
    const bg0 = colour(map, "--bg0").rgb;
    const bg1 = colour(map, "--bg1").rgb;
    const raised = solid(map, "--overlay", bg1);                     // the raised row: overlay over bg1
    const text = colour(map, "--ag-text").rgb;
    const text2 = colour(map, "--text-2").rgb;
    const text3 = colour(map, "--text-3").rgb;
    const lamp = colour(map, "--lamp").rgb, lampInk = colour(map, "--lamp-ink").rgb, lampText = colour(map, "--lamp-text").rgb;
    const ember = colour(map, "--ember").rgb, emberInk = colour(map, "--ember-ink").rgb;
    const track = solid(map, "--track", raised);
    const add = (label, fg, bg, floor) => rows.push({ name, label, ratio: ok.contrast(fg, bg), floor });
    add("text on the page", text, bg0, 4.5);
    add("text on a raised row", text, raised, 4.5);
    add("text-2 on the page (the lede, the notes)", text2, bg0, 4.5);
    add("text-2 on a raised row (a row's note, a licence's terms)", text2, raised, 4.5);
    add("text-2 on the segmented track (an unselected chip)", text2, bg1, 4.5);
    add("text-3 on the page (a caption)", text3, bg0, 4.5);
    add("lamp-ink on the Lamp fill (the selected chip)", lampInk, lamp, 4.5);
    add("text-3 chevron on a raised row (non-text)", text3, raised, 3);
    add("the switch knob, off, on its track (non-text)", text2, track, 3);
    add("the switch knob, on, on the Ember track (non-text)", emberInk, ember, 3);
    add("the Ember track on a raised row (non-text)", ember, raised, 3);
    add("the focus ring (lamp-text) on the page (non-text)", lampText, bg0, 3);
    add("the focus ring (lamp-text) on a raised row (non-text)", lampText, raised, 3);
  }
  assert.ok(rows.length >= 24, `fixture assumption: both schemes, every pair (${rows.length})`);
  const bad = rows.filter((r) => r.ratio < r.floor).map((r) => `${r.name}: ${r.label} is ${r.ratio.toFixed(2)}:1 (needs ${r.floor}:1)`);
  assert.deepStrictEqual(bad, [], "a pair below its floor");
});

test("every control is 44px: the chips by the Chip primitive, the rows and the Back chevron by their own declarations", () => {
  /* MUTATION: set `.ag .st-item` min-height to `calc(var(--s-6) + var(--s-6))` (48 is fine; 24 is not) or give
     `.st-seg .ag-chip` a height; or drop the 44 size class from the Back chevron / the Sheet's close -> red. */
  const tap = 44, s1 = 4;
  const num = (css, sel, prop) => {
    const body = new RegExp(`(?:^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css);
    assert.ok(body, `a rule for ${sel}`);
    return new RegExp(`${prop}:\\s*([^;]+);`).exec(body[1])?.[1].trim();
  };
  assert.strictEqual(num(SETTINGS_CSS, ".ag .st-item, .ag .st-row", "min-height"), "calc(var(--tap) + var(--s-1))", `a row is ${tap + s1} tall`);
  assert.strictEqual(num(SETTINGS_CSS, ".ag .st-row", "min-height"), "calc(var(--tap) + var(--s-3))", "and the Sheet's rows 56");
  assert.strictEqual(num(PRIMITIVES_CSS, ".ag .ag-chip", "min-height"), "var(--tap)", "a Chip is the 44px tap");
  assert.strictEqual(num(PRIMITIVES_CSS, ".ag .ag-btn-icon", "width"), "var(--tap)", "the icon button (Back, the Sheet's close) is 44 wide");
  assert.strictEqual(num(PRIMITIVES_CSS, ".ag .ag-btn-icon", "height"), "var(--tap)", "and 44 tall");
  const m = mount();
  m.ctx.location.hash = "#/settings";
  m.ctx.renderSettings();
  assert.ok(m.$(".st-back").classList.contains("ag-btn-size-44"), "the Back chevron is the 44px icon button");
  assert.strictEqual(m.ctx.agIcon("chevron-left").includes("chevron-left"), true, "drawn from the sprite");
  const tokenTap = /--tap:\s*(\d+)px/.exec(TOKENS_CSS)[1];
  assert.strictEqual(Number(tokenTap), tap, "--tap is 44");
});

test("the Settings, Tuning and About pages' own words obey the copy rules", async () => {
  /* MUTATION: put "we", "our", "topic", "fascinating" or a 19-word sentence into appearanceHtml, the downloads note,
     ST_LICENCES or renderAbout's copy -> red. */
  const m = await mountBooted();
  const parts = [];
  for (const hash of ["#/settings", "#/about", "#/interests"]) {
    m.ctx.location.hash = hash;
    m.ctx.route();
    parts.push(...wordsOf(m.$(".st-page")));
  }
  assert.ok(parts.length >= 60, `fixture assumption: the three pages have words (${parts.length})`);
  for (const text of parts) {
    assert.ok(!/\b(we|us|our)\b/i.test(text), `we/us/our in: ${text}`);
    assert.ok(!/\btopics?\b/i.test(text), `"subject", not "topic": ${text}`);
    for (const banned of rules.BANNED) assert.ok(!banned.test(text), `${banned} in: ${text}`);
    for (const sentence of text.split(/(?<=[.!?])\s+/)) assert.ok(rules.wordCount(sentence) <= rules.MAX_WHY_LINE_WORDS, `over 18 words: ${sentence}`);
  }
  for (const line of [
    "Dusk is the warm dark room, Dawn the paper-light one. Follow system uses your phone's setting.",
    "Downloads are in the 4a apps for iPhone and Android.",
    "Artwork and audio belong to each show's publisher. 4a plays from their own feeds.",
    "Choose less or more of a subject. 4a's pick is where it starts.",
  ]) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) assert.ok(rules.wordCount(sentence) <= rules.MAX_WHY_LINE_WORDS, `over 18 words: ${sentence}`);
    assert.ok(parts.some((t) => t.includes(line)), `the page says it: ${line}`);
  }
});

test("ui/settings.css: every rule is scoped under .ag, every class is new, no inline style, one reduced-motion owner, no literal colour but the scrim", () => {
  /* MUTATION 1: add a bare `button { ... }` or `.back { ... }` rule -> red (it would restyle legacy pages).
     MUTATION 2: add an `@media (prefers-reduced-motion)` block here -> red (tokens.css owns the one).
     MUTATION 3: write `color: #fff` in a rule -> red. MUTATION 4: put `style="..."` in settings.js's markup -> red. */
  const raw = read("ui/settings.css");
  assert.ok(!/prefers-reduced-motion/.test(stripComments(raw)), "no second reduced-motion owner");
  const css = stripComments(raw);
  const selectors = [...css.matchAll(/(?:^|\})\s*([^{}@]+)\{/g)].map((x) => x[1].trim()).filter((s) => s && !/^(from|to|\d+%)$/.test(s));
  const bad = [];
  const splitTop = (s) => {
    const out = [];
    let depth = 0, cur = "";
    for (const ch of s) {
      if (ch === "(" || ch === "[") depth++;
      if (ch === ")" || ch === "]") depth--;
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
    }
    return [...out, cur];
  };
  for (const group of selectors) {
    for (const sel of splitTop(group).map((s) => s.trim())) {
      if (/^body\.view-settings\b/.test(sel)) continue;                     // the page's own body class
      if (!/^\.ag(?:[.\s:\[]|$)/.test(sel)) bad.push(sel);
    }
  }
  assert.deepStrictEqual(bad, [], "every selector starts at .ag (or the page's body class)");
  const legacy = new Set([...read("styles.css").matchAll(/\.([A-Za-z][\w-]*)/g)].map((x) => x[1]));
  const mine = new Set([...css.matchAll(/\.(st-[\w-]+)/g)].map((x) => x[1]));
  assert.ok(mine.size >= 15, `fixture assumption: the file defines its classes (${mine.size})`);
  for (const c of mine) assert.ok(!legacy.has(c), `.${c} is already a styles.css class`);
  const literals = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g)].map((x) => x[0]);
  assert.deepStrictEqual(literals, ["rgb(20 17 15 / 0.56)"], "the one literal colour is the Sheet's scrim, named as --st-scrim");
  const emitted = read("ui/settings.js") + read("ui/interests.js");
  assert.ok(!/\bstyle\s*=\s*["'`]/.test(emitted), "no inline style attribute (CSSOM only)");
  assert.ok(!/javascript:/i.test(emitted), "no javascript: URL");
});

/* ==================================================================== */
/* E. THE OWNERSHIP RULES, PORTED                                        */
/* ==================================================================== */

/** A `.fy-sheet` with a dialog panel, opened the way Now Playing opens: the top bar kept reachable. */
function openedSheet(m, id) {
  const wrap = m.doc.createElement("div");
  wrap.className = "fy-sheet";
  if (id) wrap.id = id;
  const panel = m.doc.createElement("div");
  panel.className = "fy-panel";
  panel.setAttribute("role", "dialog");
  wrap.appendChild(panel);
  m.ctx.openSheet(wrap, { keepReachable: [".topbar"] });
  return wrap;
}

test("a tap on a sheet's scrim closes that sheet only — stacked sheets close top-first", () => {
  /* Two sheets, the second over the first: the top scrim closes the top sheet; the lower one is untouched and its scrim
     then closes it. (Ported from the drawer's ownership suite; the drawer clause went with the drawer.) */
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
});

test("a sheet opened from the page returns focus to its opener", () => {
  /* MUTATION: drop the opener record from openSheet, or the `held` rule in closeSheet -> focus lands on <body>. */
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

test("nav-8: a link to the page already on screen closes the sheets and scrolls to the top; the wordmark follows the same rule", () => {
  /* The same hash fires no hashchange, so route() never ran and the tap did nothing; under Now Playing it left the
     sheet covering the page asked for. MUTATION 1: drop the `currentHash(href) !== currentHash()` guard in sameHashTap
     -> every link would close the sheets and scroll before the router ran; the second block is red. MUTATION 2:
     drop the wordmark binding from bindSettingsChrome -> the source assertion is red. */
  const m = mount();
  const scrolled = [];
  m.ctx.scrollTo = (_x, y) => scrolled.push(y);
  const wrap = openedSheet(m);
  const home = m.doc.createElement("a");
  home.setAttribute("href", "#/");
  const { ev } = (m.view.appendChild(home), { ev: { preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false } });
  assert.strictEqual(m.ctx.sameHashTap(home, ev), true, "the page already on screen");
  assert.strictEqual(ev.defaultPrevented, true, "handled here, since the router will not see it");
  assert.strictEqual(wrap.hidden, true, "the sheet covering the page the listener asked for is gone");
  assert.deepStrictEqual(scrolled, [0], "and the page is at its top");

  const wrap2 = openedSheet(m);
  m.ctx.location.hash = "#/library";
  const ev2 = { preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false };
  assert.strictEqual(m.ctx.sameHashTap(home, ev2), false, "a different page: left to the router");
  assert.strictEqual(wrap2.hidden, false, "which closes the sheets itself on the hashchange");
  assert.match(APP_SRC, /const mark = \$\("\.wordmark"\);\s*if \(mark && typeof mark\.addEventListener === "function"\) mark\.addEventListener\("click", \(e\) => sameHashTap\(mark, e\)\);/,
    "bindSettingsChrome binds the wordmark to the same rule");
});

test("nav-2: hardware back dismisses the top-most thing: the sheet, then a step back, then the app", () => {
  /* MUTATION 1: drop the sheet branch from handleBack -> back with a sheet open steps the page under it; red.
     MUTATION 2: drop the `canGoBackInApp()` branch -> a page with history exits the app; red. MUTATION 3: drop the
     `backPending` guard -> two presses inside one beat step twice; the last assertion is red. */
  const m = mount();
  const backs = [];
  m.ctx.history.back = () => backs.push(1);
  m.menu.click();                                        // the gear's Sheet is the top-most thing
  assert.strictEqual(m.ctx.handleBack(), "sheet", "back closes the Sheet");
  assert.strictEqual(m.$$("#st-menu").length, 0);
  assert.deepStrictEqual(backs, [], "no page step under an overlay");
  assert.strictEqual(m.ctx.handleBack(), "exit", "nothing open and nothing behind: leave the app");
  vm.runInContext("navIndex = 1;", m.ctx);
  assert.strictEqual(m.ctx.handleBack(), "history");
  assert.deepStrictEqual(backs, [1]);
  assert.strictEqual(m.ctx.handleBack(), "history");
  assert.deepStrictEqual(backs, [1], "one step per press until the step has landed");
});

test("nav-10: hardware back on a relaunched page with nothing behind it goes Home, and leaves the app only from Home", () => {
  /* A native cold relaunch reopens the page the listener left with navIndex 0, so back returned "exit" on a show
     page — before nav-10 every cold launch started on Home. MUTATION: drop the `!isHomeRoute()` branch -> "exit"; red. */
  const m = mount();
  m.ctx.location.hash = "#/show/lex-fridman-podcast";
  vm.runInContext("navIndex = 0;", m.ctx);
  assert.strictEqual(m.ctx.handleBack(), "home", "back does what the ‹ fallback does");
  assert.strictEqual(m.ctx.location.hash, "#/", "…Home");
  assert.strictEqual(m.ctx.handleBack(), "exit", "and from Home, with nothing behind, it leaves");
});

test("nav-2: the shell's back button is wired to that order and leaves the app only from the bottom", () => {
  /* MUTATION: drop the `exitApp` call from the listener -> Android's back on a first page does nothing at all; red. */
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
  assert.strictEqual(m.$$("#st-menu").length, 0, "back closed the Sheet");
  assert.strictEqual(app.exits, 0, "and did not leave");
  app.listeners.backButton({ canGoBack: false });
  assert.strictEqual(app.exits, 1, "with nothing open and nothing behind, back leaves the app");
});

/* A-07 (docs/plans/android-assessment.md): back on Home while something is loaded minimizes instead of exiting. On
   Android `exitApp` finishes the activity and the audio plugin's `handleOnDestroy` stops the playback service with
   it, so the old unconditional exit killed the audio. */
function shellApp() {
  return {
    listeners: {}, exits: 0, minimizes: 0,
    addListener(name, fn) { this.listeners[name] = fn; return Promise.resolve({ remove() {} }); },
    exitApp() { this.exits++; },
    minimizeApp() { this.minimizes++; return Promise.resolve(); },
  };
}
const shellWin = (app, player) => ({ Capacitor: { Plugins: { App: app } }, ...(player ? { ForayPlayer: player } : {}) });

test("A-07: back on Home MINIMIZES while an episode or Foray is playing, so the audio lives on", () => {
  /* MUTATION: put back the unconditional `app.exitApp()` in the listener -> exits 1, minimizes 0; red. */
  const m = mount();
  const app = shellApp();
  assert.strictEqual(m.ctx.bindHardwareBack(shellWin(app, { hasLoadedItem: () => true, isPlaying: () => true })), true);
  app.listeners.backButton({ canGoBack: false });
  assert.strictEqual(app.minimizes, 1, "playing: the app goes to the background");
  assert.strictEqual(app.exits, 0, "and is not finished");
});

test("A-07: back on Home MINIMIZES while something is loaded but paused", () => {
  /* MUTATION: ask the player `isPlaying` instead of `hasLoadedItem` -> a paused episode exits and the ribbon, the
     service and the lock-screen card go with it; red. */
  const m = mount();
  const app = shellApp();
  m.ctx.bindHardwareBack(shellWin(app, { hasLoadedItem: () => true, isPlaying: () => false }));
  app.listeners.backButton({ canGoBack: false });
  assert.strictEqual(app.minimizes, 1, "paused: still minimized");
  assert.strictEqual(app.exits, 0);
});

test("A-07: back on Home with nothing loaded still EXITS — no player, a player with nothing, a player that throws", () => {
  /* MUTATION: minimize unconditionally -> back on an empty Home never leaves; red. MUTATION: drop the try around
     `hasLoadedItem` -> the throwing player breaks the listener; red. */
  for (const [label, player] of [
    ["no player on the page", null],
    ["nothing loaded", { hasLoadedItem: () => false }],
    ["an older player without the question", {}],
    ["a player that throws", { hasLoadedItem() { throw new Error("boom"); } }],
  ]) {
    const m = mount();
    const app = shellApp();
    m.ctx.bindHardwareBack(shellWin(app, player));
    app.listeners.backButton({ canGoBack: false });
    assert.strictEqual(app.exits, 1, `${label}: back leaves the app`);
    assert.strictEqual(app.minimizes, 0, `${label}: and does not minimize`);
  }
});

test("A-07: only the BOTTOM of the back order minimizes; a shell without minimizeApp keeps the exit", () => {
  /* MUTATION: minimize before `handleBack()` -> back with the Sheet open backgrounds the app instead of closing the
     Sheet; red. */
  const m = mount();
  const app = shellApp();
  m.ctx.bindHardwareBack(shellWin(app, { hasLoadedItem: () => true }));
  m.menu.click();
  app.listeners.backButton({ canGoBack: true });
  assert.strictEqual(m.$$("#st-menu").length, 0, "back closed the Sheet");
  assert.strictEqual(app.minimizes + app.exits, 0, "and did nothing else");

  const m2 = mount();
  const old = shellApp();
  delete old.minimizeApp;
  m2.ctx.bindHardwareBack(shellWin(old, { hasLoadedItem: () => true }));
  old.listeners.backButton({ canGoBack: false });
  assert.strictEqual(old.exits, 1, "no minimizeApp in the shell: the old exit, not a dead button");

  const m3 = mount();
  const refusing = shellApp();
  refusing.minimizeApp = function () { this.minimizes++; return Promise.reject(new Error("UNIMPLEMENTED")); };
  m3.ctx.bindHardwareBack(shellWin(refusing, { hasLoadedItem: () => true }));
  refusing.listeners.backButton({ canGoBack: false });
  assert.strictEqual(refusing.minimizes, 1);
  assert.strictEqual(refusing.exits, 0, "a refused minimize never becomes a kill of the audio");
});

test("THE REAL init() registers the back handler with the shell, and binds the gear", async () => {
  /* Every other test calls the binders itself, so deleting `bindHardwareBack()` or `bindSettingsChrome()` from init()
     would leave them all green — the "passed with the mechanism removed" shape test/diagnostics-surface.test.js
     records. One booted test. MUTATION 1: remove `bindHardwareBack()` from init(). MUTATION 2: remove
     `bindSettingsChrome()` from init(). Each is red. */
  const app = { listeners: {}, addListener(name, fn) { this.listeners[name] = fn; return Promise.resolve({ remove() {} }); }, exitApp() {} };
  const m = await mountBooted({ capacitor: { Plugins: { App: app } } });
  assert.strictEqual(typeof app.listeners.backButton, "function", "init() wired the shell's back button");
  m.menu.click();
  assert.ok(m.$("#st-menu"), "init() wired the gear: a tap opens the Sheet");
  assert.strictEqual(m.menu.disabled, false, "and the top bar's buttons are no longer dimmed");
});
