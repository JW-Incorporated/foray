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

test("the first-run explainer is a real dialog: focus moves in, and Escape is the same 'not now' as Skip", () => {
  /* MUTATION: open it without the owner (the old appendChild + classList.add)
     -> focus never moves; red. */
  const m = mount();
  assert.strictEqual(m.ctx.showFirstTimeExplainerOnce(), true, "fixture assumption: a fresh profile gets the explainer");
  const wrap = m.doc.body.querySelector("#first-time-sheet");
  assert.ok(wrap && m.doc.activeElement === wrap.querySelector(".fy-panel"));
  m.doc.key("Escape");
  assert.strictEqual(m.doc.body.querySelector("#first-time-sheet"), null, "Escape dismissed it");
  assert.strictEqual(m.store.get("cp_intro_dismissed"), "true", "exactly as Skip would");
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
  /* MUTATION: drop `afterQueueMove(id, -1, top);` from the ↑ binder -> red. */
  const binder = /function bindUpNextReorder\(scope\) \{[\s\S]*?\n\}/.exec(APP_SRC)[0];
  assert.match(binder, /renderQueue\(\);\s*afterQueueMove\(id, -1, top\);/);
  assert.match(binder, /renderQueue\(\);\s*afterQueueMove\(id, 1, top\);/);
  assert.match(binder, /renderQueue\(\);\s*afterQueueRemove\(/);
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
