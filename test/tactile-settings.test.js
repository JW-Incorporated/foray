/* Tactile `settings` (the knob's Settings sheet): Appearance, Dials, the floor.
 * Redesign 2026, docs/redesign-2026/directions/tactile/BUILD-PLAN.md 2.19,
 * BUILD-NOTES 4. Code: ui/settings.js, styles.css "SETTINGS (Tactile group G".
 *
 * WHAT THIS PROVES
 *   1. A dial is eleven positions with 4a's setting at the centre whatever the
 *      subject's weight is: the detent writes EXACTLY 4a's weight, the whole
 *      0..1 range stays reachable either side, the readout is "+2" / "−1" and
 *      empty at the detent.
 *   2. The sheet is the app's own modal: a dialog with aria-modal, the page
 *      behind it inert, focus on the container (never a button), Escape, the
 *      scrim, the grabber and Done all close it, and focus goes back to the knob.
 *   3. Appearance is System / Cream / Bakelite in a well, a radiogroup with one
 *      tab stop. Choosing writes `cp_theme` through the shim and flips
 *      html[data-theme] with no reload; System removes the attribute; boot
 *      paints the stored choice. Bakelite's --paper is #17130F (Cream's #F7F0E4).
 *   4. Dials write the interest the dial stands for through setInterest /
 *      saveInterests, fire the selection haptic on ARRIVING at the detent only,
 *      and the markup carries no inline style (CSP) and escapes the label.
 *   5. THE EXPLORATION FLOOR IS A SENTENCE: no input, no .knobtrack for it.
 *   6. The stylesheet's dial: a 44px well, a persimmon fill from the left, the
 *      detent drawn ABOVE the fill and recoloured where the fill runs under it,
 *      the needle's 2px stem and 8px cap, no transition or animation.
 *   7. The harness reaches it (`returning` / `settings-sheet`) and screens.json
 *      measures header and rows only.
 *
 * WHAT IT CANNOT PROVE: how it looks (fidelity.mjs: header and rows within 4px
 * of #/settings) or that the computed colour changes in a browser (checked by a
 * Playwright pass when the unit was built: select Bakelite, getComputedStyle
 * --paper is #17130F). Here the CSS half is read from the stylesheet and the
 * attribute half from the DOM, which together are that claim.
 *
 * HARNESS AUDIT. The real app.js and ui/*.js run in a node:vm over fake-dom's
 * El. Four things the stub would answer too kindly are patched like a browser:
 * `closest` walks parents, `focus` moves document.activeElement, `style` keeps
 * the custom properties written to it (the fill and needle are driven by --g),
 * and the drawer starts HIDDEN (a stub element is unhidden, which reads as an
 * open drawer and would send Escape to the drawer instead of the sheet). Each
 * test names its mutation; all were run red.
 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { parseRules } = require("./helpers/dial-css.js");
const { El } = require("./helpers/fake-dom.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\r\n/g, "\n");
const SETTINGS_SRC = fs.readFileSync(path.join(ROOT, "ui", "settings.js"), "utf8").replace(/\r\n/g, "\n");
const STATES_SRC = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs"), "utf8").replace(/\r\n/g, "\n");
const SCREENS = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "redesign-2026", "directions", "tactile", "screens.json"), "utf8"));
const TAXONOMY = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "taxonomy.json"), "utf8"));
const RULES = parseRules(CSS);

process.on("unhandledRejection", () => {});

/* ---- the stub made honest ---- */
let activeDoc = null;
El.prototype.closest = function closest(sel) {
  const { matches } = require("./helpers/fake-dom.js");
  for (let n = this; n; n = n.parent) if (matches(n, sel)) return n;
  return null;
};
El.prototype.contains = function contains(other) {
  for (let n = other; n; n = n.parent) if (n === this) return true;
  return false;
};
Object.defineProperty(El.prototype, "parentElement", { get() { return this.parent; }, configurable: true });
Object.defineProperty(El.prototype, "lastElementChild", { get() { return this.children[this.children.length - 1] || null; }, configurable: true });
Object.defineProperty(El.prototype, "style", {
  get() { if (!this._style) this._style = { props: {}, setProperty(k, v) { this.props[k] = String(v); } }; return this._style; },
  set() { /* the constructor's own assignment */ },
  configurable: true,
});
El.prototype.matches = function matchesSel(sel) { return require("./helpers/fake-dom.js").matches(this, sel); };
/* A range input's .value is its value attribute until it is moved (fake-dom starts it at ""). */
Object.defineProperty(El.prototype, "value", {
  get() { return this._v !== undefined && this._v !== "" ? this._v : (this.attrs.value !== undefined ? this.attrs.value : ""); },
  set(v) { this._v = v; },
  configurable: true,
});
El.prototype.focus = function focus() { if (activeDoc) activeDoc.activeElement = this; };

function flatEl(id, hidden = false) {
  return {
    tagName: "DIV", id, className: "", innerHTML: "", textContent: "", value: "", hidden, disabled: false,
    dataset: {}, style: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild(k) { this.children.push(k); return k; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

/** `taxonomy` replaces the committed nodes (for the escaping test). */
function mount({ seed = {}, taxonomy = TAXONOMY } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const body = new El("body");
  const html = new El("html");
  const view = new El("main");
  view.id = "view";
  body.appendChild(view);
  const knob = new El("button");
  knob.id = "today-knob";
  view.appendChild(knob);
  const tabs = new El("nav");
  tabs.id = "tab-bar";
  body.appendChild(tabs);
  const byId = new Map(["drawer-playlists", "family-toggle", "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn"].map((id) => [id, flatEl(id)]));
  byId.set("drawer", flatEl("drawer", true));
  byId.set("drawer-overlay", flatEl("drawer-overlay", true));
  const listeners = new Map();
  const doc = {
    body, documentElement: html, readyState: "complete", activeElement: body, hidden: false,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener() {}, createElement: (t) => new El(t),
    querySelector: (sel) => {
      const s = String(sel).trim();
      const id = /^#([\w-]+)$/.exec(s);
      if (id && byId.has(id[1])) return byId.get(id[1]);
      return body.querySelector(s) || null;
    },
    querySelectorAll: () => [],
  };
  activeDoc = doc;
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
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise,
    setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    matchMedia: () => ({ matches: false }),
    encodeURIComponent, decodeURIComponent, scrollY: 0, scrollTo() {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const evalIn = (src) => vm.runInContext(src, ctx);
  const state = evalIn("state");
  state.taxonomy = taxonomy;
  evalIn("loadInterests()");
  const haptics = [];
  ctx.deckHaptic = (kind) => haptics.push(kind);
  const keydown = (key) => {
    let prevented = false;
    for (const fn of listeners.get("keydown") || []) fn({ key, shiftKey: false, preventDefault() { prevented = true; } });
    return prevented;
  };
  return { ctx, evalIn, store, body, html, view, knob, tabs, doc, state, haptics, keydown, drawer: byId.get("drawer") };
}

const q = (m, sel) => m.body.querySelector(sel);
const qa = (m, sel) => m.body.querySelectorAll(sel);
const open = (m) => { m.ctx.openSettingsSheet(m.knob); return q(m, "#settings-sheet"); };
const px = (v) => Number(String(v).replace("px", ""));
const decl = (rule, prop) => (rule.decls.find((d) => d.prop === prop) || {}).value;
const base = (sel) => RULES.filter((r) => r.atRules.length === 0 && r.selectors.includes(sel));
/** The unconditional rule for `sel` that declares the paper (a scheme block, not a component). */
const rootRule = (sel) => RULES.find((r) => r.selectors.includes(sel) && r.atRules.length === 0 && decl(r, "--paper"));

/** The three dials' subjects, the way settingsDialNodes picks them for a fresh profile. */
const topRoots = () => TAXONOMY.nodes.filter((n) => n.parent === null).sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label)).slice(0, 3);

/* ==================================================================== */
/* 1. THE DIAL'S ARITHMETIC                                              */
/* ==================================================================== */

test("a dial is eleven positions with 4a's setting at 5, whatever the weight: exact detent, full range either side, offset readout", () => {
  /* MUTATION 1: `if (!d) return ""` -> `if (d === 99) return ""` in settingsDialReadout - the empty-at-detent assertion fails.
     MUTATION 2: `p === SETTINGS_DIAL_DETENT) return anchor` -> `return anchor + 0.01` - the exact-detent assertion fails.
     MUTATION 3: in settingsDialValue, the upper branch `anchor + (1 - anchor) * ...` -> `anchor + 0.1 * ...` - the "10 is full" assertion fails.
     MUTATION 4: the minus sign "−" -> "-" - the true-minus assertion fails. */
  const m = mount();
  const { settingsDialPosition: pos, settingsDialValue: val, settingsDialReadout: read, settingsDialValueText: text } = m.ctx;
  for (const anchor of [0.9, 0.6, 0.5, 0.25, 0.05]) {
    assert.strictEqual(val(5, anchor), anchor, `the detent is exactly 4a's ${anchor}`);
    assert.strictEqual(pos(anchor, anchor), 5);
    assert.strictEqual(val(0, anchor), 0, "position 0 is nothing");
    assert.strictEqual(val(10, anchor), 1, "position 10 is everything");
    let prev = -1;
    for (let p = 0; p <= 10; p++) {
      const v = val(p, anchor);
      assert.ok(v >= prev, `monotonic at ${p}`);
      assert.strictEqual(pos(v, anchor), p, `anchor ${anchor}: position ${p} round-trips through ${v}`);
      prev = v;
    }
  }
  /* The ends of the range: an anchor of 0 or 1 leaves one side with nowhere to go. */
  assert.strictEqual(pos(0, 0), 5, "anchor 0: the only value at or below the detent is the detent");
  assert.strictEqual(val(2, 0), 0);
  assert.strictEqual(val(10, 0), 1);
  assert.strictEqual(val(8, 1), 1);
  assert.strictEqual(pos(1, 1), 5);
  assert.strictEqual(pos(undefined, 0.6), 5, "a subject nothing has set sits at the detent");
  assert.strictEqual(pos(0.601, 0.6), 5, "within half a hundredth is the detent");
  assert.strictEqual(read(5), "", "empty at the detent");
  assert.strictEqual(read(7), "+2");
  assert.strictEqual(read(4), "−1", "a true minus sign, not a hyphen");
  assert.strictEqual(read(0), "−5");
  assert.strictEqual(read(10), "+5");
  assert.strictEqual(text(5), "4a's setting");
  assert.strictEqual(text(7), "plus 2");
  assert.strictEqual(text(3), "minus 2");
});

/* ==================================================================== */
/* 2. THE SHEET IS A MODAL                                               */
/* ==================================================================== */

test("the sheet is a modal dialog: aria-modal, labelled, the page inert, focus on the container and not a button", () => {
  /* MUTATION 1: drop aria-modal="true" from settingsSheetHtml - the dialog assertion fails.
     MUTATION 2: open it with a plain `sheet.hidden = false` instead of openSheet() - the inert assertion fails.
     MUTATION 3: focus the Done button after openSheet - the container-focus assertion fails.
     MUTATION 4: hand-focus the Done button after openSheet (focusQuietly(sheet.querySelector("#settings-done"))) - the container-focus assertion fails. (Deleting tabindex="-1" from the markup is NOT a mutation here: openSheet adds it itself.) */
  const m = open_(mount());
  const sheet = q(m, "#settings-sheet");
  assert.ok(sheet, "the sheet is in the page");
  assert.strictEqual(sheet.getAttribute("role"), "dialog");
  assert.strictEqual(sheet.getAttribute("aria-modal"), "true");
  assert.strictEqual(sheet.getAttribute("tabindex"), "-1");
  assert.strictEqual(sheet.getAttribute("aria-labelledby"), "settings-sheet-title");
  assert.strictEqual(q(m, "#settings-sheet-title").textContent, "Settings");
  assert.strictEqual(sheet.hidden, false, "shown");
  assert.strictEqual(m.doc.activeElement, sheet, "focus is on the container");
  assert.notStrictEqual(m.doc.activeElement.tagName, "BUTTON", "never the first button");
  assert.ok(m.view.hasAttribute("inert") && m.tabs.hasAttribute("inert"), "the page and the deck are out of reach");
  assert.ok(!q(m, "#settings-scrim").hasAttribute("inert"), "the scrim stays live: a tap on it closes the sheet");
  assert.strictEqual(m.knob.getAttribute("aria-expanded"), "true");
  assert.ok(m.body.classList.contains("fy-sheet-open"), "the page scroll is locked");
});
function open_(m) { open(m); return m; }

test("Escape, the scrim, the grabber and Done each close it, and focus goes back to the knob", () => {
  /* MUTATION 1: leave the `grab.addEventListener("click", shut)` line out - the grabber case fails.
     MUTATION 2: drop `returnFocus: knob` from the openSheet call AND the `focusQuietly(knobNow())` fallback in shut - a tap that left focus on <body> returns nowhere and the knob-focus assertion fails.
     MUTATION 3: drop `keepReachable: ["#settings-scrim"]` - the scrim is inert, so its click handler is unreachable in a browser; the keepReachable assertion fails.
     MUTATION 4: forget `setExpanded(false)` - the aria-expanded assertion fails. */
  const ways = {
    Escape: (m) => assert.ok(m.keydown("Escape"), "Escape is claimed"),
    scrim: (m) => click(q(m, "#settings-scrim")),
    grabber: (m) => click(q(m, ".settings-grab")),
    Done: (m) => click(q(m, "#settings-done")),
  };
  for (const [name, close] of Object.entries(ways)) {
    const m = mount();
    m.doc.activeElement = m.body;           // a tap on a button does not focus it in every WebView
    open(m);
    close(m);
    assert.strictEqual(q(m, "#settings-sheet"), null, `${name}: the sheet is gone`);
    assert.strictEqual(q(m, "#settings-scrim"), null, `${name}: and its scrim`);
    assert.strictEqual(m.doc.activeElement, m.knob, `${name}: focus is back on the knob`);
    assert.ok(!m.view.hasAttribute("inert") && !m.tabs.hasAttribute("inert"), `${name}: the page is live again`);
    assert.strictEqual(m.knob.getAttribute("aria-expanded"), "false", `${name}: the knob says it is closed`);
    assert.ok(!m.body.classList.contains("fy-sheet-open"), `${name}: the scroll lock is released`);
  }
  assert.match(SETTINGS_SRC, /keepReachable: \["#settings-scrim"\]/, "the scrim is kept out of inert so its tap reaches it");
});
/** A click the way the browser delivers it: on the element, then up through its ancestors' listeners. */
function click(el) {
  assert.ok(el, "a control to click");
  for (let n = el; n; n = n.parent) for (const fn of (n._on && n._on.get("click")) || []) fn({ target: el, preventDefault() {} });
}

test("a second press while it is open opens nothing, and More settings hands over to the drawer", () => {
  /* MUTATION 1: delete the `if ($("#settings-sheet")) return;` guard - two sheets stack and the count assertion fails.
     MUTATION 2: remove `openDrawer(true)` from the More settings handler - the drawer assertion fails (the drawer’s switches would have no way in from Today and Yours). */
  const m = mount();
  const drawers = [];
  m.ctx.openDrawer = (v) => drawers.push(v);
  open(m);
  open(m);
  assert.strictEqual(qa(m, "#settings-sheet").length, 1, "one sheet");
  assert.strictEqual(qa(m, "#settings-scrim").length, 1, "and one scrim: a second press must not leave an orphan behind");
  click(q(m, "#settings-more"));
  assert.strictEqual(q(m, "#settings-sheet"), null, "the sheet leaves first");
  assert.deepStrictEqual(drawers, [true], "then the drawer opens");
});

/* ==================================================================== */
/* 3. APPEARANCE                                                         */
/* ==================================================================== */

test("Appearance is System / Cream / Bakelite in a well, a radiogroup with one tab stop on the chosen option", () => {
  /* MUTATION 1: reorder SETTINGS_THEMES - the order assertion fails.
     MUTATION 2: tabindex is "0" on every option - the roving-tabindex assertion fails.
     MUTATION 3: drop role="radiogroup" - the group assertion fails.
     MUTATION 4: the group is a div without the .well class - the well assertion fails. */
  const m = mount();
  open(m);
  const group = q(m, ".settings-seg");
  assert.ok(group.classList.contains("well"), "in a well");
  assert.strictEqual(group.getAttribute("role"), "radiogroup");
  assert.strictEqual(group.getAttribute("aria-labelledby"), "settings-appearance-label");
  assert.strictEqual(q(m, "#settings-appearance-label").textContent, "Appearance");
  const opts = qa(m, "[data-theme-choice]");
  assert.deepStrictEqual(opts.map((o) => o.textContent), ["System", "Cream", "Bakelite"]);
  assert.deepStrictEqual(opts.map((o) => o.getAttribute("data-theme-choice")), ["system", "light", "dark"]);
  assert.ok(opts.every((o) => o.getAttribute("role") === "radio" && o.tagName === "BUTTON"));
  assert.deepStrictEqual(opts.map((o) => o.getAttribute("aria-checked")), ["true", "false", "false"], "System is the default");
  assert.deepStrictEqual(opts.map((o) => o.getAttribute("tabindex")), ["0", "-1", "-1"], "one tab stop");
});

test("choosing Bakelite writes cp_theme through the shim and flips html[data-theme] with no reload; System removes it", () => {
  /* MUTATION 1: `lsSet("cp_theme", next)` removed from settingsThemeSet - the stored-key assertion fails.
     MUTATION 2: apply to document.body instead of documentElement - the attribute assertion fails.
     MUTATION 3: "system" sets data-theme="system" instead of removing it - the removal assertion fails
     (the token layer only knows light and dark, so "system" would pin Cream under a dark OS).
     MUTATION 4: do not update aria-checked after a choice - the state assertion fails. */
  const m = mount();
  open(m);
  const by = (v) => qa(m, "[data-theme-choice]").find((o) => o.getAttribute("data-theme-choice") === v);
  click(by("dark"));
  assert.strictEqual(m.html.getAttribute("data-theme"), "dark", "Bakelite is on <html>");
  assert.strictEqual(m.store.get("cp_theme"), '"dark"', "stored through lsSet, in the cp_ namespace");
  assert.deepStrictEqual(qa(m, "[data-theme-choice]").map((o) => o.getAttribute("aria-checked")), ["false", "false", "true"]);
  assert.deepStrictEqual(qa(m, "[data-theme-choice]").map((o) => o.getAttribute("tabindex")), ["-1", "-1", "0"]);
  click(by("light"));
  assert.strictEqual(m.html.getAttribute("data-theme"), "light");
  assert.strictEqual(m.store.get("cp_theme"), '"light"');
  click(by("system"));
  assert.strictEqual(m.html.getAttribute("data-theme"), null, "System removes the attribute: the OS decides");
  assert.strictEqual(m.store.get("cp_theme"), '"system"');
  /* The CSS half of "--paper computes to #17130F": the attribute selects a block that declares it. */
  const bakelite = rootRule(':root[data-theme="dark"]');
  const cream = rootRule(":root");
  assert.ok(bakelite, "styles.css has the Bakelite override block");
  assert.strictEqual(decl(bakelite, "--paper").toUpperCase(), "#17130F");
  assert.strictEqual(decl(cream, "--paper").toUpperCase(), "#F7F0E4");
});

test("the arrow keys move the choice and the focus along the radiogroup, wrapping", () => {
  /* MUTATION 1: ArrowRight steps by 0 - the move assertion fails.
     MUTATION 2: drop the `+ list.length) % list.length` wrap - ArrowLeft from System goes nowhere and fails.
     MUTATION 3: skip focusQuietly after the choice - the focus assertion fails. */
  const m = mount();
  open(m);
  const opts = qa(m, "[data-theme-choice]");
  const group = q(m, ".settings-seg");
  const key = (el, k) => { for (const fn of group._on.get("keydown") || []) fn({ key: k, target: el, preventDefault() {} }); };
  key(opts[0], "ArrowRight");
  assert.strictEqual(m.html.getAttribute("data-theme"), "light", "Cream");
  assert.strictEqual(m.doc.activeElement, opts[1], "focus follows");
  key(opts[1], "ArrowLeft");
  key(opts[0], "ArrowLeft");
  assert.strictEqual(m.html.getAttribute("data-theme"), "dark", "wrapped from System to Bakelite");
  assert.strictEqual(m.doc.activeElement, opts[2]);
  key(opts[2], "Home");   // not an arrow: nothing moves
  assert.strictEqual(m.html.getAttribute("data-theme"), "dark");
});

test("boot paints the stored choice, before the first await and again once storage has landed", () => {
  /* MUTATION 1: delete the first applyStoredTheme() in init() - the early-paint assertion fails.
     MUTATION 2: delete the one after `await storageP` - the post-hydration assertion fails.
     MUTATION 3: settingsThemeRead returns "system" for "dark" - the read assertion fails. */
  const m = mount({ seed: { cp_theme: '"dark"' } });
  m.ctx.applyStoredTheme();
  assert.strictEqual(m.html.getAttribute("data-theme"), "dark");
  const m2 = mount({ seed: { cp_theme: '"nonsense"' } });
  m2.ctx.applyStoredTheme();
  assert.strictEqual(m2.html.getAttribute("data-theme"), null, "anything else is System");
  const init = /^async function init\(\) \{[\s\S]*?\n\}/m.exec(APP_SRC)[0];
  const first = init.indexOf("applyStoredTheme()");
  const storage = init.indexOf("const storageP = storageReady();");
  const after = init.indexOf("await storageP;");
  assert.ok(first > 0 && first < storage, "painted before storage is even awaited (and so before the first await)");
  assert.match(init.slice(after), /^await storageP;\s*if \(typeof applyStoredTheme === "function"\) applyStoredTheme\(\);/, "and again right after hydration");
  assert.ok(/afterStorageSettles\(\(\) => \{[^}]*applyStoredTheme\(\)/.test(init), "and when hydration overran its bound");
});

/* ==================================================================== */
/* 4. DIALS                                                              */
/* ==================================================================== */

test("a fresh profile gets three dials on the roots 4a leans on hardest; a moved subject takes a dial first", () => {
  /* MUTATION 1: slice(0, 4) - the count assertion fails.
     MUTATION 2: sort the untouched ones ascending - the order assertion fails.
     MUTATION 3: drop the `touched` list - the moved-first assertion fails. */
  const m = mount();
  open(m);
  const ids = qa(m, ".knobtrack").map((t) => t.getAttribute("data-dial-id"));
  assert.deepStrictEqual(ids, topRoots().map((n) => n.id));
  assert.strictEqual(ids.length, 3);
  const m2 = mount({ seed: { cp_interests: JSON.stringify({ music: 0.05, cities: 0.95 }) } });
  open(m2);
  const ids2 = qa(m2, ".knobtrack").map((t) => t.getAttribute("data-dial-id"));
  assert.deepStrictEqual(ids2.slice(0, 2), ["music", "cities"], "the two the listener moved, most moved first (0.45 each: by name)");
  assert.strictEqual(ids2.length, 3);
});

test("a dial: a hidden 0..10 range input with step 1, labelled by its subject, an empty readout at the detent", () => {
  /* MUTATION 1: step="1" -> step="any" - the snap assertion fails.
     MUTATION 2: settingsDialReadout returns "0" at the detent (`if (d === 99) return ""`) - the empty assertion fails.
     MUTATION 3: drop aria-labelledby - the name assertion fails.
     MUTATION 4: the readout loses aria-hidden - it would be read twice (the valuetext already says it) and the assertion fails. */
  const m = mount();
  open(m);
  const dials = qa(m, ".settings-dial");
  assert.strictEqual(dials.length, 3);
  const first = dials[0];
  const input = first.querySelector("input");
  assert.strictEqual(input.getAttribute("type"), "range");
  assert.strictEqual(input.getAttribute("min"), "0");
  assert.strictEqual(input.getAttribute("max"), "10");
  assert.strictEqual(input.getAttribute("step"), "1", "the step snaps to the detent");
  assert.strictEqual(input.getAttribute("value"), "5", "an untouched subject rests at 4a's setting");
  assert.strictEqual(input.getAttribute("aria-valuetext"), "4a's setting");
  const name = first.querySelector(".settings-dial__name");
  assert.strictEqual(input.getAttribute("aria-labelledby"), name.id);
  assert.strictEqual(name.textContent, topRoots()[0].label);
  const readout = first.querySelector("[data-dial-read]");
  assert.strictEqual(readout.textContent, "", "empty at the detent");
  assert.strictEqual(readout.getAttribute("aria-hidden"), "true");
  assert.ok(readout.classList.contains("readout"), "mono 13 is the readout role");
  const track = first.querySelector(".knobtrack");
  assert.ok(track.classList.contains("well"));
  assert.strictEqual(track.style.props["--g"], "0.50", "the fill and the needle start at the middle");
  assert.strictEqual(track.getAttribute("data-over"), "false");
  /* The three pieces, in paint order: fill, then the detent ABOVE it, then the needle. */
  const kids = track.children.map((c) => c.className);
  assert.deepStrictEqual(kids, ["knobtrack__input", "knobtrack__fill", "knobtrack__detent", "knobtrack__needle"]);
  const label = q(m, ".settings-group__top .settings-note");
  assert.strictEqual(label.textContent, "4a's setting is the centre detent");
});

test("turning a dial writes the weight the position stands for, repaints fill, readout and valuetext, and clicks once on arriving at the detent", () => {
  /* MUTATION 1: setInterest(node.id, pos / 10) - the weight assertion fails (the detent would not be 4a's).
     MUTATION 2: drop saveInterests() - the stored assertion fails.
     MUTATION 3: haptic on every input - the one-click-on-arrival assertion fails.
     MUTATION 4: drop the `last !== SETTINGS_DIAL_DETENT` guard - the second input at the detent clicks again and fails.
     MUTATION 5: data-over true at pos >= 5 - the over assertion fails at the detent. */
  const m = mount();
  open(m);
  const track = qa(m, ".knobtrack")[0];
  const input = track.querySelector("input");
  const node = TAXONOMY.nodes.find((n) => n.id === track.getAttribute("data-dial-id"));
  const turn = (v) => { input.value = String(v); for (const fn of input._on.get("input") || []) fn({ target: input }); };
  const read = () => track.parentElement.querySelector("[data-dial-read]").textContent;
  turn(7);
  assert.strictEqual(m.state.interests[node.id], m.ctx.settingsDialValue(7, node.weight), "the weight for +2");
  assert.ok(m.state.interests[node.id] > node.weight, "more of it");
  assert.strictEqual(read(), "+2");
  assert.strictEqual(track.style.props["--g"], "0.70");
  assert.strictEqual(track.getAttribute("data-over"), "true", "the fill runs under the detent: it takes the on-persimmon colour");
  assert.strictEqual(input.getAttribute("aria-valuetext"), "plus 2");
  assert.strictEqual(JSON.parse(m.store.get("cp_interests"))[node.id], m.state.interests[node.id], "saved");
  assert.deepStrictEqual(m.haptics, [], "moving across the dial is not a click");
  turn(4);
  assert.strictEqual(read(), "−1");
  assert.strictEqual(track.getAttribute("data-over"), "false");
  assert.ok(m.state.interests[node.id] < node.weight, "less of it");
  turn(5);
  assert.strictEqual(m.state.interests[node.id], node.weight, "the detent is exactly 4a's setting");
  assert.strictEqual(read(), "", "empty again");
  assert.strictEqual(track.getAttribute("data-over"), "false", "at the detent the fill only reaches it: ink-3 on the well");
  assert.deepStrictEqual(m.haptics, ["selection"], "one selection click, on arriving");
  turn(5);
  assert.deepStrictEqual(m.haptics, ["selection"], "not again for staying");
  assert.ok(m.state._interestsGen > 0, "the repeated-query cache key moved");
});

test("a dial opens where the listener left it: a moved subject shows its offset, not the detent", () => {
  /* MUTATION: settingsDialHtml reads node.weight instead of state.interests[node.id] - the offset assertion fails. */
  const first = topRoots()[0];
  const m = mount({ seed: { cp_interests: JSON.stringify({ [first.id]: 0.2 }) } });
  open(m);
  const track = qa(m, ".knobtrack").find((t) => t.getAttribute("data-dial-id") === first.id);
  const pos = m.ctx.settingsDialPosition(0.2, first.weight);
  assert.ok(pos < 5);
  assert.strictEqual(track.querySelector("input").getAttribute("value"), String(pos));
  assert.strictEqual(track.parentElement.querySelector("[data-dial-read]").textContent, m.ctx.settingsDialReadout(pos));
  assert.strictEqual(track.style.props["--g"], (pos / 10).toFixed(2));
  /* Opening it changes nothing in the profile: no write on open. */
  assert.strictEqual(m.store.has("cp_interests"), true);
  assert.strictEqual(JSON.parse(m.store.get("cp_interests"))[first.id], 0.2);
});

test("THE EXPLORATION FLOOR IS A SENTENCE: one paragraph, no input, no .knobtrack for it", () => {
  /* MUTATION 1: render the floor as a dial - add a `<div class="well knobtrack">` (with or without an input) to settingsDialsHtml's floor line - the track-count and the paragraph-has-no-control assertions fail.
     MUTATION 2: change the sentence - the exact-text assertion fails.
     MUTATION 3: wrap the sentence in a <label> - the no-control assertion fails. */
  const m = mount();
  open(m);
  const sentence = "The exploration floor stays at about a third. It is not a dial.";
  const floor = q(m, ".settings-floor");
  assert.strictEqual(floor.tagName, "P");
  assert.strictEqual(floor.textContent, sentence);
  assert.strictEqual(floor.descendants().length, 0, "plain text, nothing inside it");
  assert.strictEqual(qa(m, ".knobtrack").length, 3, "one track per DIAL; the floor has none");
  assert.strictEqual(qa(m, "input").length, 3, "three inputs on the sheet: the dials");
  assert.ok(qa(m, ".knobtrack").every((t) => t.getAttribute("data-dial-id")), "every track belongs to a taxonomy subject");
  for (const t of qa(m, ".knobtrack")) assert.ok(!t.textContent.includes("floor"));
  assert.ok(!/\bfloor\b/i.test(qa(m, "input").map((i) => i.getAttribute("aria-labelledby")).join(" ")), "no control is named for it");
  /* And the source says it the same way: the copy constant appears once, as text. */
  assert.strictEqual(SETTINGS_SRC.split("The exploration floor stays at about a third. It is not a dial.").length - 1, 1);
});

test("every interpolation is escaped and nothing carries an inline style or its own storage call", () => {
  /* MUTATION 1: `${esc(node.label)}` -> `${node.label}` in settingsDialHtml - the hostile label reaches the page as markup and fails.
     MUTATION 2: `${esc(node.id)}` -> `${node.id}` on data-dial-id - the attribute-breakout assertion fails.
     MUTATION 3: add style="..." anywhere in the sheet markup - the CSP assertion fails.
     MUTATION 4: read localStorage directly in settings.js - the shim assertion fails. */
  const hostile = JSON.parse(JSON.stringify(TAXONOMY));
  const root = hostile.nodes.filter((n) => n.parent === null).sort((a, b) => b.weight - a.weight)[0];
  root.label = '<img src=x onerror="boom()">';
  root.id = 'x" data-evil="1';
  const m = mount({ taxonomy: hostile });
  open(m);
  const html = q(m, "#settings-sheet").descendants().map((e) => e.tagName).join(",");
  assert.ok(!/\bIMG\b/.test(html), "the label did not become an element");
  const name = qa(m, ".settings-dial__name")[0];
  assert.strictEqual(name.textContent, '<img src=x onerror="boom()">', "it is text");
  assert.ok(!qa(m, ".knobtrack").some((t) => "data-evil" in t.attrs), "the id did not break out of its attribute");
  const markupFns = SETTINGS_SRC.slice(SETTINGS_SRC.indexOf("function settingsThemeHtml"), SETTINGS_SRC.indexOf("function settingsBindTheme"))
    + SETTINGS_SRC.slice(SETTINGS_SRC.indexOf("function settingsDialHtml"), SETTINGS_SRC.indexOf("/** Fill, needle"))
    + SETTINGS_SRC.slice(SETTINGS_SRC.indexOf("function settingsSheetHtml"), SETTINGS_SRC.indexOf("/** Open the sheet"));
  assert.ok(!/\sstyle=/.test(markupFns), "no inline style attribute (strict CSP)");
  assert.ok(!/javascript:|<script|onclick=/i.test(markupFns));
  const code = SETTINGS_SRC.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\blocalStorage\b|\bsessionStorage\b|indexedDB/.test(code), "storage only through lsGet / lsSet");
  assert.match(code, /lsGet\("cp_theme"/);
  assert.match(code, /lsSet\("cp_theme"/);
  /* Every ${...} in the three template builders is esc()'d, a number, or another builder's output. */
  const bare = [...markupFns.matchAll(/\$\{([^}]+)\}/g)].map((x) => x[1].trim())
    .filter((e) => !/^esc\(/.test(e) && !/^SETTINGS_DIAL_MAX$|^pos$|^index$|^nameId$|^buttons$|^on \? "(true|0)" : "(false|-1)"$|^settings\w+\(|\.map\(settingsDialHtml\)\.join|^settingsDialNodes|^settingsThemeRead/.test(e));
  assert.deepStrictEqual(bare, [], "an interpolation that is neither escaped nor known-safe");
});

/* ==================================================================== */
/* 5. THE STYLESHEET                                                     */
/* ==================================================================== */

test("the dial: a 44px well, a 16px persimmon fill from the left, and the needle's 2px stem with an 8px cap", () => {
  /* MUTATION 1: .knobtrack height var(--tap) -> var(--key) - the 44 assertion fails.
     MUTATION 2: the fill background var(--persimmon) -> var(--ultramarine) - the colour assertion fails (ultramarine is what 4a authored; the listener’s own setting is persimmon).
     MUTATION 3: the needle width calc(var(--s-1) / 2) -> var(--s-1) - the 2px assertion fails.
     MUTATION 4: the cap width var(--s-2) -> var(--s-3) - the 8px assertion fails. */
  const track = base(".knobtrack")[0];
  assert.strictEqual(decl(track, "height"), "var(--tap)");
  assert.strictEqual(decl(track, "overflow"), "visible", "the needle's cap sits above the well");
  const fill = base(".knobtrack__fill")[0];
  assert.strictEqual(decl(fill, "background"), "var(--persimmon)");
  assert.strictEqual(decl(fill, "left"), "var(--s-1)", "from the left, 4px in");
  assert.strictEqual(decl(fill, "height"), "var(--s-4)", "16px tall");
  assert.match(decl(fill, "width"), /var\(--g, \.5\) \* \(100% - var\(--s-2\)\)/, "the travel of an 8px thumb");
  const needle = base(".knobtrack__needle")[0];
  assert.strictEqual(decl(needle, "width"), "calc(var(--s-1) / 2)", "2px");
  assert.strictEqual(decl(needle, "background"), "var(--ink)");
  assert.strictEqual(decl(needle, "top"), "calc(-1 * (var(--s-3) + var(--s-1) / 2))", "14px above: an 8px cap and 6px of stem");
  assert.match(decl(needle, "left"), /var\(--g, \.5\) \* \(100% - var\(--s-2\)\) \+ var\(--s-1\)/, "the same travel as the fill, 4px in");
  const cap = base(".knobtrack__needle::before")[0];
  assert.strictEqual(decl(cap, "width"), "var(--s-2)", "8px");
  assert.strictEqual(decl(cap, "height"), "var(--s-2)");
  assert.strictEqual(decl(cap, "border-radius"), "50%");
  assert.strictEqual(decl(cap, "top"), "0");
  const input = base(".knobtrack__input")[0];
  assert.strictEqual(decl(input, "opacity"), "0", "the range input is hidden, not removed");
  assert.ok(base(".knobtrack__input::-webkit-slider-thumb").length === 1 && decl(base(".knobtrack__input::-webkit-slider-thumb")[0], "width") === "var(--s-2)", "an 8px thumb, so the needle sits under the finger");
});

test("the centre detent is 2x16, drawn ABOVE the fill, --ink-3 on the well and --on-persimmon at 70% where the fill runs under it", () => {
  /* MUTATION 1: give the detent z-index 0 (r3: behind the fill, so every dial above centre lost it) - the above-the-fill assertion fails.
     MUTATION 2: move the detent <i> before the fill <i> in settingsDialHtml - the paint-order assertion in the markup test fails.
     MUTATION 3: drop the [data-over="true"] rule - the overlap-colour assertion fails.
     MUTATION 4: 70% -> 100% - the mix assertion fails. */
  const detent = base(".knobtrack__detent")[0];
  const fill = base(".knobtrack__fill")[0];
  assert.strictEqual(decl(detent, "width"), "calc(var(--s-1) / 2)", "2px");
  assert.strictEqual(decl(detent, "height"), "var(--s-4)", "16px");
  assert.strictEqual(decl(detent, "left"), "50%");
  assert.strictEqual(decl(detent, "background"), "var(--ink-3)", "on the well");
  assert.ok(Number(decl(detent, "z-index")) > Number(decl(fill, "z-index")), "above the fill, at every value");
  const over = base('.knobtrack[data-over="true"] .knobtrack__detent')[0];
  assert.ok(over, "a rule for the detent over the fill");
  assert.strictEqual(decl(over, "background"), "color-mix(in srgb, var(--on-persimmon) 70%, transparent)");
  assert.ok(Number(decl(base(".knobtrack__needle")[0], "z-index")) > Number(decl(detent, "z-index")), "the needle is on top of both");
});

test("nothing in the Settings rules transitions or animates, so the one reduced-motion block has nothing to add", () => {
  /* MUTATION: add `transition: left 60ms linear` to .knobtrack__needle (the prototype’s) - the assertion fails, and so does ui-tokens (a transition missing from the reduced-motion block). */
  const mine = RULES.filter((r) => r.atRules.length === 0 && r.selectors.some((s) => /(^|[\s.])(settings-|knobtrack)/.test(s)));
  assert.ok(mine.length >= 15, `the walker sees the Settings rules (${mine.length})`);
  for (const r of mine) {
    for (const d of r.decls) {
      assert.ok(!/^(transition|animation)/.test(d.prop), `${r.selectors.join(", ")} declares ${d.prop}`);
    }
  }
  assert.strictEqual(CSS.match(/@media \(prefers-reduced-motion: reduce\)/g).length, 1, "still exactly one reduced-motion block");
});

test("the sheet floats 8px in from the edges on the shared deck material, which goes opaque under reduced transparency", () => {
  /* MUTATION 1: left/right var(--s-2) -> var(--s-4) - the inset assertion fails.
     MUTATION 2: give .settings-sheet its own `background` - the shared-material assertion fails (the blur and its opaque fallback live in --deck-tint / --deck-blur).
     MUTATION 3: delete the `@media (prefers-reduced-transparency: reduce)` --deck-tint line - the opaque assertion fails. */
  const sheet = base(".sheet.settings-sheet")[0];
  assert.match(decl(sheet, "left"), /var\(--s-2\)\)$/);
  assert.match(decl(sheet, "right"), /var\(--s-2\)\)$/);
  assert.strictEqual(decl(sheet, "border-radius"), "var(--r-lg)");
  assert.strictEqual(decl(sheet, "background"), undefined, "the material is the shared .sheet's");
  const shared = base(".sheet")[0];
  assert.strictEqual(decl(shared, "background"), "var(--deck-tint)");
  assert.strictEqual(decl(shared, "backdrop-filter"), "var(--deck-blur)");
  const opaque = RULES.find((r) => r.atRules.some((a) => /prefers-reduced-transparency: reduce/.test(a)) && r.selectors.includes(":root") && decl(r, "--deck-tint") === "var(--card)");
  assert.ok(opaque, "reduced transparency swaps the deck tint for the solid card");
  assert.strictEqual(decl(opaque, "--deck-blur"), "none");
  const note = base(".settings-note")[0];
  assert.match(decl(note, "font"), /^var\(--w-body\) var\(--t-label\)\/var\(--lh-label\)/, "label 13 at 500, not micro");
  assert.strictEqual(decl(note, "color"), "var(--ink-2)");
});

test("the segmented options are 44px targets and the radiogroup is a well", () => {
  /* MUTATION: .settings-seg__opt min-height var(--tap) -> 36px - the 44 assertion fails (and test/tap-targets.test.js). */
  const opt = base(".settings-seg__opt")[0];
  assert.strictEqual(decl(opt, "min-height"), "var(--tap)");
  assert.strictEqual(decl(opt, "min-width"), "var(--tap)");
  const on = base('.settings-seg__opt[aria-checked="true"]')[0];
  assert.strictEqual(decl(on, "background"), "var(--card)");
  assert.strictEqual(decl(on, "box-shadow"), "var(--shadow-card)");
});

/* ==================================================================== */
/* 6. THE HARNESS AND THE SCREEN MAP                                     */
/* ==================================================================== */

test("the harness reaches the sheet by pressing the knob on Today, and screens.json measures header and rows", () => {
  /* MUTATION 1: delete the settings-sheet step from the `returning` state - the step assertion fails.
     MUTATION 2: point screens.json at a step that does not exist - the map assertion fails (and fidelity.mjs exits 2).
     MUTATION 3: put the hero region back with app: ".today-hero" - the "regions the prototype sheet does not have" assertion fails. */
  const returning = /id: "returning",[\s\S]*?\n    \},\n/.exec(STATES_SRC)[0];
  assert.match(returning, /\{ label: "settings-sheet", route: "#\/", run: \(page\) => openSettingsFromKnob\(page\) \}/);
  const helper = /async function openSettingsFromKnob\(page\) \{[\s\S]*?\n\}/.exec(STATES_SRC)[0];
  assert.match(helper, /page\.locator\("#today-knob"\)\.click\(\)/, "the knob keycap is pressed");
  assert.match(helper, /waitForSelector\("#settings-sheet:not\(\[hidden\]\)"/, "and the sheet waited for");
  const s = SCREENS.screens.settings;
  assert.deepStrictEqual(s.app, { state: "returning", step: "settings-sheet" });
  assert.deepStrictEqual(Object.keys(s.regions).sort(), ["header", "rows"], "hero, primary and tabBar are not in the prototype's sheet");
  assert.deepStrictEqual(s.regions.header, { prototype: ".top", app: ".today-top" });
  assert.deepStrictEqual(s.regions.rows, { prototype: ".row", app: ".today .row-episode", mode: "all" });
  assert.strictEqual(s.prototype.route, "#/settings");
});

test("the knob on Today and Yours opens THIS sheet and names it; the boot-skeleton press is answered with it", () => {
  /* MUTATION 1: bindTodayKnob back to openDrawer - the source assertion fails (also test/today-screen.test.js).
     MUTATION 2: bindYoursKnob keeps aria-controls="drawer" - the Yours assertion fails.
     MUTATION 3: settleBootKnob back to openDrawer(true) - the boot assertion fails. */
  const today = /function bindTodayKnob\(scope\) \{[\s\S]*?\n\}/.exec(APP_SRC)[0];
  assert.match(today, /aria-controls", "settings-sheet"/);
  assert.match(today, /addEventListener\("click", \(\) => openSettingsSheet\(knob\)\)/);
  const yours = /function bindYoursKnob\(knob\) \{[\s\S]*?\n\}/.exec(APP_SRC)[0];
  assert.match(yours, /aria-controls", "settings-sheet"/);
  assert.match(yours, /addEventListener\("click", \(\) => openSettingsSheet\(knob\)\)/);
  const boot = /function settleBootKnob\(\) \{[\s\S]*?\n\}/.exec(APP_SRC)[0];
  assert.match(boot, /openSettingsSheet\(\$\("#today-knob"\)\)/);
});
