/* The Dock's behaviour (Redesign 2026, direction "ambient", Phase 4 screen "dock"; ui/tabbar.js).
 *
 * test/tab-bar.test.js holds what the Dock must keep guaranteeing from the old tab bar (one tab current
 * for every route, no content under it, one surface). This file holds what is NEW in it, each with the
 * one-line mutation that turns it red:
 *
 *   1. THE RECEDE RULE - the tab row goes 64 -> 36 after 80px of DOWNWARD scroll and comes back on ANY
 *      upward scroll (BUILD-NOTES section 6). The class is on <body> (dock-receded) because the page's
 *      reservation, the cast and the fade all read it from CSS.
 *   2. THE CLASS SURVIVES A REPAINT AND DIES WITH THE PAGE - setBodyClass() rewrites <body>'s class on every
 *      render; renderTabBar() writes the receded state back, and drops it when the hash changed.
 *   3. THE FIELD ROW - Discover's own #sh-compose is ADOPTED into the Dock's top row after the render, a
 *      fresh render's replaces the old one, and leaving Discover empties and hides the row.
 *   4. `#/create` OWES THE FIELD FOCUS - and pays it once, only after the field is in the Dock (a moved node
 *      loses focus, so focusing it earlier would be undone by the move).
 *   5. THE DECORATIONS - the fade and the cast exist, are aria-hidden, and the cast follows the mini row.
 *   6. `?posture=car` - the harness's way into car posture.
 *
 * What a DOM-less node suite cannot see - that the rows really share an edge, that no text sits in the band
 * below the Dock, that a receded tab is still 44px to hit - is tools/ui-lab/dock-check.mjs's, run in a
 * browser (tools/ui-lab/README.md), with its evaluators unit-tested in tools/ui-lab/dock-check.test.mjs.
 *
 * HARNESS: the real-DOM-with-parent/child-tracking stub of test/tab-bar.test.js, duplicated rather than
 * imported (the convention those files set out), plus replaceChildren, focus spies and a movable scroll.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: "", className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {},
    children: [], parent: null, _attrs: {}, focusCalls: [],
    href: undefined,
    classList: {
      add(...cs) { el.className = [...new Set([...(el.className ? el.className.split(/\s+/) : []), ...cs])].join(" "); },
      remove(...cs) { el.className = el.className.split(/\s+/).filter((c) => c && !cs.includes(c)).join(" "); },
      toggle(c, on) {
        const has = el.className.split(/\s+/).includes(c);
        const want = on === undefined ? !has : !!on;
        if (want && !has) el.classList.add(c);
        if (!want && has) el.classList.remove(c);
      },
      contains: (c) => el.className.split(/\s+/).includes(c),
    },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { k.parent = el; el.children.push(k); return k; },
    append(...ks) { for (const k of ks) { if (k.parent) k.parent.children = k.parent.children.filter((c) => c !== k); k.parent = el; el.children.push(k); } },
    /* The real thing, which moves a node out of its old parent: the Dock relies on that. */
    replaceChildren(...ks) {
      for (const c of el.children) c.parent = null;
      el.children = [];
      el.append(...ks);
    },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    removeAttribute(k) { delete el._attrs[k]; },
    closest: () => null, select() {}, click() {},
    focus(opts) { el.focusCalls.push(opts); },
    remove() {
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
    querySelector(sel) { return matchAll(el, sel)[0] || null; },
    querySelectorAll(sel) { return matchAll(el, sel); },
  };
  return el;
}

function matchAll(root, sel) {
  const s = String(sel).trim();
  const test1 = (node) => {
    if (s.startsWith("#")) return node.id === s.slice(1);
    if (s.startsWith(".")) return node.className.split(/\s+/).includes(s.slice(1));
    const m = /^([a-z0-9]+)(\.[\w-]+)?$/i.exec(s);
    if (m) {
      const [, tag, cls] = m;
      if (node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      if (cls && !node.className.split(/\s+/).includes(cls.slice(1))) return false;
      return true;
    }
    return false;
  };
  const out = [];
  (function walk(node) {
    for (const c of node.children) {
      if (test1(c)) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}

const PAGE_IDS = ["view", "drawer", "drawer-overlay", "family-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn"];

function mount({ search = "" } = {}) {
  const store = new Map();
  const body = makeEl("body");
  const html = makeEl("html");
  for (const id of PAGE_IDS) {
    const el = makeEl("div");
    el.id = id;
    body.appendChild(el);
  }
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
      body, documentElement: html, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search, pathname: "/", href: "https://x.test/", protocol: "https:" },
    history: { back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    scrollY: 0,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const evalIn = (src) => vm.runInContext(src, ctx);
  evalIn("state.ready = true; openDrawer = () => {};");
  return {
    ctx, evalIn, body, html,
    view: body.querySelector("#view"),
    /** Scroll the page to `y` and let the Dock hear it, as the browser's scroll event does. */
    scrollTo(y) { ctx.scrollY = y; evalIn("onDockScroll()"); },
    receded() { return body.classList.contains("dock-receded"); },
    dockPart(id) { return body.querySelector(`#${id}`); },
  };
}

/* ==================================================================== */
/* 1. THE RECEDE RULE                                                    */
/* ==================================================================== */

test("the tab row recedes after 80px of DOWNWARD scroll, and not before", () => {
  /* BUILD-NOTES section 6: "after 80px of downward scroll". MUTATION: change DOCK_RECEDE_AFTER_PX to 20 ->
     the 79px assertion goes red; to 200 -> the 81px one does. 80 itself is the boundary: `y > 80`, so the
     row has not receded AT 80, which is "after 80px", not "at". */
  const m = mount();
  m.evalIn("renderTabBar()");
  assert.strictEqual(m.receded(), false, "at rest the tab row is tall");
  m.scrollTo(40);
  m.scrollTo(79);
  assert.strictEqual(m.receded(), false, "79px down: not yet");
  m.scrollTo(80);
  assert.strictEqual(m.receded(), false, "80px down is not past 80");
  m.scrollTo(81);
  assert.strictEqual(m.receded(), true, "81px down: receded");
  assert.strictEqual(m.evalIn("DOCK_RECEDE_AFTER_PX"), 80, "and the constant is the ruling's number");
});

test("ANY upward scroll restores it, a still page changes nothing, and a jump back to the top restores", () => {
  /* "restores on any upward scroll". MUTATION: require a longer upward travel (`dy < -10`) -> the 1px case
     fails; make a scroll event with no movement toggle it (`dy >= 0` for the recede branch) -> the still-page
     assertion fails; restore only on `y <= 0` instead of `dy < 0` -> the 1px case fails the other way. */
  const m = mount();
  m.evalIn("renderTabBar()");
  m.scrollTo(300);
  assert.strictEqual(m.receded(), true, "precondition");
  m.scrollTo(300);
  assert.strictEqual(m.receded(), true, "a scroll event that did not move leaves it receded");
  m.scrollTo(299);
  assert.strictEqual(m.receded(), false, "one pixel back up restores it: ANY upward scroll");
  m.scrollTo(299);
  assert.strictEqual(m.receded(), false, "and a still page leaves it restored");
  m.scrollTo(500);
  assert.strictEqual(m.receded(), true, "down again");
  m.scrollTo(0);
  assert.strictEqual(m.receded(), false, "back at the top it is tall");
  m.scrollTo(50);
  m.scrollTo(120);
  assert.strictEqual(m.receded(), true, "and a fresh 80px of descent recedes it again");
});

/* ==================================================================== */
/* 2. IT SURVIVES A REPAINT AND DIES WITH THE PAGE                       */
/* ==================================================================== */

test("a repaint of the same page keeps the receded row; a new page starts tall", () => {
  /* setBodyClass() assigns <body>'s class wholesale on every render, so the class is written back by
     renderTabBar(). MUTATION: delete the closing `document.body.classList.toggle("dock-receded", ...)` in
     renderTabBar -> the repaint assertion fails; delete the `h !== dockHash` reset -> the navigation one does
     (the new page would open with a short tab row and a long page). */
  const m = mount();
  m.evalIn("renderTabBar()");
  m.scrollTo(400);
  assert.strictEqual(m.receded(), true, "precondition");
  m.body.className = "view-page ui-v2";            // what setBodyClass() does on a render
  assert.strictEqual(m.receded(), false, "precondition: the render dropped the class");
  m.evalIn("renderTabBar()");
  assert.strictEqual(m.receded(), true, "the same page, repainted (a settings switch, the late player): still receded");
  m.ctx.location.hash = "#/library";
  m.body.className = "view-page ui-v2";
  m.evalIn("renderTabBar()");
  assert.strictEqual(m.receded(), false, "another page starts at the top with the tall row");
});

/* ==================================================================== */
/* 3. THE FIELD ROW                                                      */
/* ==================================================================== */

/** A Search page's compose bar as renderAllShows writes it into #view: the row, with the field inside. */
function writeCompose(m) {
  const compose = makeEl("div");
  compose.id = "sh-compose";
  const input = makeEl("input");
  input.id = "sh-input";
  compose.append(input);
  m.view.append(compose);
  return { compose, input };
}

test("Discover's #sh-compose is adopted into the Dock's field row, and a fresh render's replaces the old one", () => {
  /* MUTATION: drop the adoption (`field.replaceChildren(compose)`) -> the row stays empty and hidden and the
     field stays a floating element of #view; drop `dockFieldNode = compose` -> the second render finds the
     old node still current and never swaps. Moving the node (not copying it) is what keeps the page's own
     handlers - they were bound to it - alive. */
  const m = mount();
  m.evalIn("renderTabBar()");
  const field = m.dockPart("dock-field");
  assert.strictEqual(field.hidden, true, "not Discover: the field row is hidden");
  m.body.classList.add("sh-compose");
  const first = writeCompose(m);
  m.evalIn("renderTabBar()");
  assert.deepStrictEqual(field.children, [first.compose], "the page's own field row is the Dock's field row's child");
  assert.strictEqual(first.compose.parent, field, "moved, not copied");
  assert.strictEqual(field.hidden, false, "and the row shows");
  /* The next render of Discover (a repaint) writes a NEW #sh-compose into #view. */
  const second = writeCompose(m);
  m.evalIn("renderTabBar()");
  assert.deepStrictEqual(field.children, [second.compose], "the fresh field replaced the old one: one field, never two");
  m.evalIn("syncDock()");
  assert.deepStrictEqual(field.children, [second.compose], "and an idle sync (the player starting) leaves it be");
});

test("leaving Discover empties and hides the field row", () => {
  /* The class (`sh-compose`) is what says "this page has a field": setBodyClass() drops it on the next
     page. MUTATION: delete the `else if (dockFieldNode)` branch in syncDock -> the field stays in the Dock
     on Library, a search box with nothing to search; delete `field.hidden = !dockFieldNode` -> the empty row
     keeps its 48px. */
  const m = mount();
  m.evalIn("renderTabBar()");
  m.body.classList.add("sh-compose");
  const { compose } = writeCompose(m);
  m.evalIn("renderTabBar()");
  const field = m.dockPart("dock-field");
  assert.strictEqual(compose.parent, field, "precondition");
  m.ctx.location.hash = "#/library";
  m.body.className = "view-page ui-v2";            // the next page's setBodyClass()
  m.evalIn("renderTabBar()");
  assert.deepStrictEqual(field.children, [], "the field row is empty");
  assert.strictEqual(field.hidden, true, "and hidden, so tokens.css draws no rim line for it");
});

/* ==================================================================== */
/* 4. #/create OWES THE FIELD FOCUS                                       */
/* ==================================================================== */

test("`#/create` focuses Discover's field once it is in the Dock - once, and not before it is there", () => {
  /* A node that moves loses focus, so focusing the field where the render wrote it (in #view) would be
     undone by the adoption that follows. MUTATION: focus in route() instead of syncDock -> the field is
     focused in #view and the move drops it (first assertion: no focus call lands on the adopted node);
     never clear `dockFocusField` -> the second sync focuses again; drop the `dockFieldNode` guard -> a
     sync on a page without the field would try to focus nothing and throw. */
  const m = mount();
  m.evalIn("renderTabBar()");
  m.evalIn("dockFocusFieldNext()");
  m.body.classList.add("sh-compose");
  m.evalIn("renderTabBar()");
  const { input } = writeCompose(m);
  assert.deepStrictEqual(input.focusCalls, [], "nothing is focused while the field is still in #view");
  m.evalIn("renderTabBar()");
  assert.strictEqual(JSON.stringify(input.focusCalls), '[{"preventScroll":true}]', "focused once the Dock holds it, without scrolling the page");
  m.evalIn("syncDock()");
  m.evalIn("renderTabBar()");
  assert.strictEqual(input.focusCalls.length, 1, "and not again on a later sync");
});

/* ==================================================================== */
/* 5. THE DECORATIONS                                                    */
/* ==================================================================== */

test("the fade and the cast exist, are aria-hidden and take no tap, and the cast follows the mini row", () => {
  /* MUTATION: drop `aria-hidden` from either -> a screen reader walks two empty regions; drop the
     `cast.dataset.state = ...` write in syncDock -> the cast lights an idle Dock (it would glow over a
     page with nothing playing). */
  const m = mount();
  m.evalIn("renderTabBar()");
  const fade = m.body.querySelector(".dock-fade");
  const cast = m.dockPart("dock-cast");
  assert.ok(fade && cast, "both are built");
  assert.strictEqual(fade.getAttribute("aria-hidden"), "true");
  assert.strictEqual(cast.getAttribute("aria-hidden"), "true");
  assert.strictEqual(cast.dataset.state, "idle", "nothing plays: nothing to cast");
  m.body.classList.add("fp-open");
  m.evalIn("syncDock()");
  assert.strictEqual(cast.dataset.state, "playing", "something loaded: the cast is lit");
  m.body.classList.remove("fp-open");
  m.evalIn("syncDock()");
  assert.strictEqual(cast.dataset.state, "idle");
  assert.ok(cast.parent === m.body && fade.parent === m.dockPart("dock-layer"), "the cast sits behind the page (a body child), the fade over it (in the layer)");
});

/* ==================================================================== */
/* 6. ?posture=car                                                        */
/* ==================================================================== */

test("`?posture=car` puts the page in car posture; without it the attribute is never written", () => {
  /* The harness's way into car posture (BUILD-PLAN 0.4); the real way in is the mini bar's 600ms hold.
     MUTATION: drop the `try { ... posture=car ... }` block in ensureDock -> the first assertion fails;
     write the attribute unconditionally -> the second does. */
  const car = mount({ search: "?gallery=1&posture=car" });
  car.evalIn("renderTabBar()");
  assert.strictEqual(car.html.getAttribute("data-posture"), "car");
  const plain = mount({ search: "?posture=cart" });
  plain.evalIn("renderTabBar()");
  assert.strictEqual(plain.html.getAttribute("data-posture"), null, "a lookalike parameter is not the hook");
});

/* ==================================================================== */
/* 7. ROUND 2: THE FIELD'S WORDS, THE FADE THAT COVERS THE DOCK, AND THE   */
/*    LEGACY CONTROLS THE GATES CAUGHT                                    */
/* ==================================================================== */

const dockCss = require("./helpers/dock-css.js");

test("the adopted field says 'Search, or name a subject', placeholder and accessible name alike", () => {
  /* The Search page writes "Search shows and episodes..."; in the Dock the field is also where Create folded in,
     and fidelity saw the app drop that half of the intent. The Dock owns the copy, applied at adoption.
     MUTATION: delete the two `fieldInput.setAttribute(...)` lines in syncDock -> every assertion fails; change
     DOCK_FIELD_COPY to the page's own words -> the first two fail; set only the placeholder -> the second
     does (a visible name that the accessible name does not contain fails WCAG label-in-name). */
  const m = mount();
  m.evalIn("renderTabBar()");
  m.body.classList.add("sh-compose");
  const { input } = writeCompose(m);
  input.setAttribute("placeholder", "Search shows and episodes…");
  input.setAttribute("aria-label", "Search shows and episodes");
  m.evalIn("renderTabBar()");
  assert.strictEqual(input.getAttribute("placeholder"), "Search, or name a subject");
  assert.strictEqual(input.getAttribute("aria-label"), "Search, or name a subject");
  /* a repaint's fresh field gets the same words (the page rewrites them on every render) */
  const second = writeCompose(m);
  second.input.setAttribute("placeholder", "Search shows and episodes…");
  m.evalIn("renderTabBar()");
  assert.strictEqual(second.input.getAttribute("placeholder"), "Search, or name a subject", "a fresh render of Discover is re-worded too");
});

test("the fade covers the whole Dock: its top is 32px above the Dock's top edge in every state, at both insets", () => {
  /* DIRECTION: "content runs under the Dock and fades to bg behind it; it is never sliced by the Dock's edge".
     Round 1's fade was `safe + 12 + 44` (56px), which began 72px BELOW the top of a 128px Dock, so a card wider
     than the Dock showed its rounded outline framing the Dock on three sides. The height is resolved here, not
     matched as a string: it must equal the Dock's occupied height (rows + float + safe area) plus the ramp.
     MUTATION: put `height` back to `calc(var(--safe-bottom) + var(--dock-inset) + 44px)` -> every state fails;
     drop `var(--dock-h)` from it -> the states with a mini row or the field fail; change `--dock-fade-rise`
     without the gradient's own stop -> the gradient assertion fails. */
  const heightExpr = dockCss.declOf("ui/dock.css", ".dock-layer .dock-fade", "height");
  assert.ok(heightExpr, "the fade sets its height");
  for (const classes of [[], ["fp-open"], ["sh-compose"], ["fp-open", "sh-compose"], ["dock-receded"], ["fp-open", "dock-receded"]]) {
    const vars = dockCss.scope(classes);
    for (const inset of [0, 34]) {
      const withInset = new Map([...vars, ["--safe-bottom", `${inset}px`]]);
      const fade = dockCss.resolve(heightExpr, withInset, inset);
      const occupied = dockCss.resolve("calc(var(--dock-h) + var(--dock-inset) + var(--safe-bottom))", withInset, inset);
      assert.strictEqual(fade - occupied, 32, `${classes.join(".") || "(rest)"} at inset ${inset}: the fade must reach 32px above the Dock's top edge (fade ${fade}, Dock ${occupied})`);
    }
  }
  assert.strictEqual(dockCss.declOf("ui/dock.css", ":root", "--dock-fade-rise"), "32px");
  assert.strictEqual(dockCss.declOf("ui/dock.css", ".dock-layer .dock-fade", "background"), "linear-gradient(transparent 0, var(--dock-page-bg) var(--dock-fade-rise))",
    "transparent at its top, the page colour from the ramp's end: solid from the Dock's top edge down");
});

test("the fade carries a masked copy of the cast, so the page colour never paints over the light it rises from", () => {
  /* The cast sits behind the content and under the fade; a fade that covers the Dock would paint bg over the
     brightest edge of the light. `::before` repeats the cast's radial in front, masked by the fade's own ramp
     (the real cast shows through the ramp and the copy covers below it: one radial at every height), and is
     hidden with the cast when nothing plays.
     MUTATION: delete the `.dock-fade::before` rule -> the first assertion fails (the light goes dark at the Dock's
     edge); delete its mask -> the mask assertions fail (the light doubles over the ramp); change its radial's
     centre away from `--cast-centre` or its radius from 260px -> the same-gradient assertion fails; delete the
     `:not(.fp-open)` hide -> the display assertion fails (a lit edge over a page with nothing playing);
     re-declare `--cast-centre` on #dock-cast -> the last fails (the two would fork). */
  const sel = ".dock-layer .dock-fade::before";
  const bg = dockCss.declOf("ui/dock.css", sel, "background");
  assert.ok(bg, "the fade has a ::before that paints");
  const castBg = dockCss.declOf("ui/dock.css", "#dock-cast", "background");
  assert.ok(castBg && castBg.includes(bg.replace(/^background:\s*/, "")), `the copy is the very same radial as #dock-cast's, so the two cannot drift: ${bg}`);
  assert.ok(/radial-gradient\(90% 260px at 50% calc\(100% - var\(--cast-centre\)\)/.test(bg), "260px, centred at --cast-centre from the bottom");
  assert.strictEqual(dockCss.declOf("ui/dock.css", sel, "mask-image"), "linear-gradient(transparent 0, #000 var(--dock-fade-rise))", "masked by the fade's own ramp");
  assert.strictEqual(dockCss.declOf("ui/dock.css", sel, "-webkit-mask-image"), "linear-gradient(transparent 0, #000 var(--dock-fade-rise))", "and for WebKit");
  assert.strictEqual(dockCss.declOf("ui/dock.css", "body.ui-v2:not(.fp-open) .dock-layer .dock-fade::before", "display"), "none", "hidden with the cast when nothing plays");
  assert.ok(dockCss.declOf("ui/dock.css", "body.ui-v2", "--cast-centre"), "--cast-centre is declared once, on <body>, where the cast and the fade both inherit it");
  assert.strictEqual(dockCss.declOf("ui/dock.css", "#dock-cast", "--cast-centre"), null, "and not again on the cast, which would fork the two");
});

test("the legacy controls the gates caught under the dock/* ids are real 44px targets and legible: chip, wordmark, play capsule", () => {
  /* Round 1 carried 24 new violations as known debt (22 tap targets: the wordmark at 24x24 and the Discover
     chip wall at 32px; 2 contrast: Home's white-on-violet play capsule, 2.72 and 2.48). The Dock's unit clears
     them in ui/dock.css 6b rather than adding to gates-known-debt.json.
     MUTATION: drop `min-height: var(--tap)` from `.fy-chip` or the wordmark rule -> the matching assertion fails
     (and `gates.mjs` reports the 32px and 24px boxes again); set `.hv2-play` back to white or to --ember-ink
     (white in Dawn) -> the colour assertions fail. */
  assert.strictEqual(dockCss.declOf("ui/dock.css", "body.ui-v2 .fy-chip", "min-height"), "var(--tap)");
  assert.strictEqual(dockCss.declOf("ui/dock.css", "body.ui-v2 .topbar h1 a.wordmark", "min-height"), "var(--tap)");
  assert.strictEqual(dockCss.declOf("ui/dock.css", "body.ui-v2 .topbar h1 a.wordmark", "min-width"), "var(--tap)");
  const colour = dockCss.declOf("ui/dock.css", "body.ui-v2 .hv2-play", "color");
  assert.ok(colour && /^var\(--bg\)/.test(colour), `the capsule's ink is the legacy page colour, dark in both schemes: ${colour}`);
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  const bgHex = /^\s*--bg:\s*(#[0-9a-f]{6})/im.exec(css);
  assert.ok(bgHex, "styles.css declares --bg");
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const mix = (fg, bg, a) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * a + parseInt(bg.slice(i, i + 2), 16) * (1 - a)).toString(16).padStart(2, "0")).join("");
  const violet = "#a78bfa";
  assert.ok(ratio(bgHex[1], violet) >= 4.5, `ink on the violet capsule: ${ratio(bgHex[1], violet).toFixed(2)}:1`);
  /* the capsule's title is drawn at .9 opacity, the worse case */
  assert.ok(ratio(mix(bgHex[1], violet, 0.9), violet) >= 4.5, `the capsule's title at 0.9 opacity: ${ratio(mix(bgHex[1], violet, 0.9), violet).toFixed(2)}:1`);
});

test("round 3: a Dusk page under the Dock takes the warm neutrals, has no hairline rules, and Discover has no header bar", () => {
  /* The Dock casts the artwork's light onto the page behind it; on the legacy cool #151119 page the warm Dock
     read as a second room, and the header bar and page-title hairlines drew the borders DIRECTION forbids.
     MUTATION: point `--bg` at `var(--bg1)` (or delete the line) in the `:root[data-theme="dusk"]` rule -> the
     neutral assertions fail; drop `border-bottom: 0` from `.topbar` -> the hairline assertion fails; drop
     `display: none` from `body.ui-v2.sh-compose .topbar` -> the header assertion fails. The `@media` mirror is
     checked as text because declOf reads unconditional rules only. */
  const dusk = ':root[data-theme="dusk"] body.ui-v2:not(.gallery-page)';
  for (const [name, want] of [["--bg", "var(--bg0)"], ["--surface", "var(--bg1)"], ["--surface2", "var(--bg2)"], ["--text", "var(--ag-text)"], ["--muted", "var(--text-2)"], ["--faint", "var(--text-3)"], ["--line", "var(--rim)"]]) {
    assert.strictEqual(dockCss.declOf("ui/dock.css", dusk, name), want, `${name} on a Dusk legacy page`);
  }
  const css = fs.readFileSync(path.join(ROOT, "ui/dock.css"), "utf8").replace(/\r\n/g, "\n");
  const media = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="dawn"\]\) body\.ui-v2:not\(\.gallery-page\) \{([^}]*)\}/.exec(css);
  assert.ok(media, "the dark-OS mirror of the Dusk neutrals exists");
  for (const [name, want] of [["--bg", "var(--bg0)"], ["--surface2", "var(--bg2)"], ["--line", "var(--rim)"]]) {
    assert.ok(new RegExp(`${name}:\\s*${want.replace(/[()]/g, "\\$&")}`).test(media[1]), `${name} in the dark-OS mirror`);
  }
  assert.strictEqual(dockCss.declOf("ui/dock.css", ".topbar", "border-bottom"), "0", "no hairline under the header bar");
  assert.strictEqual(dockCss.declOf("ui/dock.css", "body.ui-v2 .page-head", "border-bottom"), "0", "no hairline under a page title");
  assert.strictEqual(dockCss.declOf("ui/dock.css", "body.ui-v2.sh-compose .topbar", "display"), "none", "Discover has no header bar");
  assert.strictEqual(dockCss.declOf("ui/dock.css", "body.ui-v2.sh-compose", "--topbar-h"), "0px", "and what the bar reserved goes back to every rule that read it");
});

test("QA fix: the Dock's search field paints no UA background, so Dawn's ink never sits on Chrome's dark form fill", () => {
  /* The Dock is not an .ag subtree, so it keeps index.html's `color-scheme: dark`; an <input> with no
     background of its own is painted with the dark form-control fill (#3b3b3b), and Dawn's near-black
     ink on it is 1.54:1 (axe color-contrast on #sh-input, 17 screens). The pill (#sh-form) already
     carries the surface, so the input must be transparent over it.
     MUTATION: delete `background: transparent` from `.dock-layer #sh-compose #sh-input` in ui/dock.css
     -> this fails. tools/ui-lab/a11y.mjs --scheme light measures the same thing in a browser. */
  const sel = ".dock-layer #sh-compose #sh-input";
  assert.strictEqual(dockCss.declOf("ui/dock.css", sel, "background"), "transparent", "the field has no fill of its own");
  assert.strictEqual(dockCss.declOf("ui/dock.css", sel, "color"), "var(--text)", "and its ink is the page's text token");
});
