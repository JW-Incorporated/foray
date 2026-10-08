/* Tactile `library-shows` (Yours, Shows): the grid of followed shows.
 * Redesign 2026, docs/redesign-2026/directions/tactile/BUILD-PLAN.md 2.14,
 * BUILD-NOTES 4.5. Code: ui/library.js (the "THE SHOWS PANEL" block and the
 * renderLibrary entries that call it), styles.css ("Shows: every followed show
 * as a tile"), tools/ui-lab/lib/states.mjs (`yours-shows`, `yours-shows-actions`).
 *
 * WHAT THIS PROVES
 *   1. One tile per followed show, newest follow first, in a three-column list
 *      inside the Shows tabpanel; each tile is a link to its show with the artwork
 *      through safeUrl(artUrl()), a name, NO "Following" tag (every tile
 *      here is followed; iteration 2), a real 44px ⋯ button drawn as a small quiet chip, and an Unfollow
 *      button that is `hidden` (out of the accessibility tree) until asked for.
 *   2. The readout line is "{n} shows" and the knob keycap is in the head.
 *   3. ⋯ reveals Unfollow, moves focus to it, and closes again (⋯ again, Escape,
 *      another tile's ⋯, a chip press), putting focus back on the ⋯. One tile is
 *      open at a time.
 *   4. A long press (500ms, cancelled by lifting or moving) and the context menu
 *      reveal the same group, and the click a long press ends with is swallowed so
 *      it never also opens the show.
 *   5. Unfollow writes through the one writer (cp_starred_shows), the tile leaves
 *      without a re-render, the readout and the announcement say the new count,
 *      focus goes to a neighbour's ⋯, and the last follow leaves the panel's note
 *      (or, with nothing else saved anywhere, the whole-screen empty state).
 *   6. A title, an id and an artwork URL with markup in them reach the page inert.
 *   7. The sheet's own rules: three `minmax(0, 1fr)` columns 12 apart, `--r-sm`
 *      square art, the name 13/600 clamped to two lines, a hidden group stays
 *      hidden, and no transition or animation was added (the one reduced-motion
 *      block therefore needs no new name).
 *
 * WHAT IT CANNOT PROVE: how any of it looks or that three columns fit at 375
 * (tools/ui-lab/fidelity.mjs measures the grid, the tiles and the names against
 * the prototype in a real browser; gates.mjs checks overflow and the 44px
 * targets there), or a real finger's long press (the timer is driven by hand).
 *
 * HARNESS AUDIT (CLAUDE.md "a green test is not evidence until you have broken
 * it"). The real app.js and ui/*.js run in a node:vm over fake-dom's El, so the
 * panel is parsed from the markup renderLibrary wrote and every press goes
 * through the handlers the page bound. As in test/tactile-library.test.js,
 * `closest` walks parents (a delegated handler that matched the wrong element
 * must miss), `focus` moves document.activeElement (a repaint that loses focus
 * must show) and timers are HELD (the long press is read off the delay it was
 * armed with, not waited for). Each test names its mutation; all were run red.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { parseRules } = require("./helpers/dial-css.js");
const { El, matches } = require("./helpers/fake-dom.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const LIBRARY_SRC = fs.readFileSync(path.join(ROOT, "ui", "library.js"), "utf8");
const STATES_SRC = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs"), "utf8");
const SCREENS = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "redesign-2026", "directions", "tactile", "screens.json"), "utf8"));

process.on("unhandledRejection", () => {});

let activeDoc = null;
El.prototype.closest = function closest(sel) {
  for (let n = this; n; n = n.parent) if (matches(n, sel)) return n;
  return null;
};
El.prototype.contains = function contains(other) {
  for (let n = other; n; n = n.parent) if (n === this) return true;
  return false;
};
Object.defineProperty(El.prototype, "parentElement", { get() { return this.parent; }, configurable: true });
Object.defineProperty(El.prototype, "lastElementChild", { get() { return this.children[this.children.length - 1] || null; }, configurable: true });
El.prototype.focus = function focus() { if (activeDoc) activeDoc.activeElement = this; };

function flatEl(id) {
  return {
    tagName: "DIV", id, className: "", innerHTML: "", textContent: "", value: "", hidden: false, disabled: false,
    dataset: {}, style: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild(k) { this.children.push(k); return k; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

const PAGE_IDS = [
  "drawer", "drawer-overlay", "drawer-playlists", "family-toggle", "player-toggle", "autoadvance-toggle",
  "menu-btn", "refresh-btn", "banner-slot", "pl-form", "pl-input", "pl-note",
];

function mount({ seed = {} } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const view = new El("main");
  view.id = "view";
  const body = new El("body");
  const byId = new Map(PAGE_IDS.map((id) => [id, flatEl(id)]));
  const timers = [];
  const cleared = [];
  const doc = {
    body, documentElement: body, readyState: "complete", activeElement: body, hidden: false,
    addEventListener() {}, removeEventListener() {}, createElement: (t) => new El(t),
    querySelector: (sel) => {
      const s = String(sel).trim();
      if (s === "#view") return view;
      if (s.startsWith("#view ")) return view.querySelector(s.slice(6));
      const id = /^#([\w-]+)$/.exec(s);
      if (id && byId.has(id[1])) return byId.get(id[1]);
      return view.querySelector(s) || body.querySelector(s) || null;
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
    location: { hash: "#/library", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise,
    setTimeout: (fn, ms) => { const id = timers.length + 1; timers.push({ id, ms, fn }); return id; },
    clearTimeout: (id) => { cleared.push(id); },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    encodeURIComponent, decodeURIComponent, scrollY: 0, scrollTo() {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  byId.set("view", view);
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const evalIn = (src) => vm.runInContext(src, ctx);
  const state = evalIn("state");
  state.catalog = { shows: [] };
  state.discover = { items: [] };
  state.taxonomy = { nodes: [] };
  state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  return { ctx, evalIn, store, body, view, doc, timers, cleared, state, html: () => view.innerHTML };
}

const ART = "https://is1-ssl.mzstatic.com/image/thumb/Podcasts/v4/aa/bb/cc/source/600x600bb.jpg";
const NAMES = ["Lex Fridman Podcast", "Titans of Nuclear", "omega tau", "CleanTechies", "Catalyst", "Lab to Market Leadership"];

/** Six follows, newest first by the dates below (show-0 the newest). */
function followsSeed(n = 6, extra = {}) {
  const follows = {};
  for (let i = 0; i < n; i++) {
    follows["show-" + i] = { show_id: "show-" + i, title: NAMES[i % NAMES.length], artwork_url: ART, starred_at: `2026-09-${String(20 - i).padStart(2, "0")}T00:00:00Z` };
  }
  return { cp_starred_shows: JSON.stringify(follows), cp_history: JSON.stringify(["played-before"]), ...extra };
}

/** Yours opened on the Shows chip. */
function openShows(seed) {
  const m = mount({ seed });
  m.ctx.renderLibrary("shows");
  return m;
}

const q = (m, sel) => m.view.querySelectorAll(sel);
const one = (m, sel) => m.view.querySelector(sel);
const tiles = (m) => q(m, ".shows-tile");
const tileOf = (m, id) => tiles(m).find((t) => t.getAttribute("data-show-tile") === id);
const moreOf = (t) => t.querySelector(".shows-tile__more");
const groupOf = (t) => t.querySelector(".shows-tile__actions");
const storedFollows = (m) => JSON.parse(m.store.get("cp_starred_shows") || "{}");

/** An event the way the browser delivers it: on the element, to the handlers the
    page bound on the panel. Returns whether preventDefault was called. */
function fire(m, type, target, extra = {}) {
  const panel = one(m, "#yours-panel-shows");
  const fns = (panel._on.get(type) || []);
  assert.ok(fns.length, `the Shows panel has a ${type} handler`);
  let prevented = false;
  fns.forEach((fn) => fn({ target, preventDefault() { prevented = true; }, stopPropagation() {}, ...extra }));
  return prevented;
}
function pressMore(m, id, { focuses = true } = {}) {
  const more = moreOf(tileOf(m, id));
  /* Chrome and Android focus a button on click; Safari does not. A test that
     wants to know the page puts focus back itself presses without it. */
  if (focuses) m.doc.activeElement = more;
  fire(m, "click", more);
}

/* ==================================================================== */
/* 1. THE TILES                                                          */
/* ==================================================================== */

test("one tile per follow, newest first, in the Shows tabpanel: link, artwork, name, no Following tag, 44px ⋯, hidden Unfollow", () => {
  /* MUTATION 1: sort ascending (swap `b.at.localeCompare(a.at)`) - the order
     assertion fails.
     MUTATION 2: re-add the `tag tag--following` span to yoursShowTileHtml (iteration 2
     removed it: six identical labels over the artwork) - the no-tag assertion fails.
     MUTATION 3: render the actions group without `hidden` - the hidden assertion
     fails (Unfollow would be in the accessibility tree on every tile).
     MUTATION 4: pass the artwork URL without safeUrl() - the src assertion fails
     only on test 6's hostile URL, which is why that one exists. */
  const m = openShows(followsSeed());
  const panel = one(m, "#yours-panel-shows");
  assert.strictEqual(panel.getAttribute("role"), "tabpanel");
  assert.ok(!panel.hidden, "the Shows panel is the one shown");
  const grid = one(m, "#yours-panel-shows ul.shows-grid");
  assert.ok(grid, "the tiles are a list in the panel");
  assert.deepStrictEqual(tiles(m).map((t) => t.getAttribute("data-show-tile")), ["show-0", "show-1", "show-2", "show-3", "show-4", "show-5"], "newest follow first");
  assert.strictEqual(tiles(m).length, 6, "every follow, not a capped summary");
  for (const t of tiles(m)) {
    const id = t.getAttribute("data-show-tile");
    const link = t.querySelector("a.shows-tile__link");
    assert.strictEqual(link.getAttribute("href"), `#/show/${id}`, "the tile opens its show");
    const img = link.querySelector("img");
    assert.match(img.getAttribute("src"), /^https:\/\/is1-ssl\.mzstatic\.com\/.*\/324x324bb\.jpg$/, "artwork at 3x of the 108px tile, through the CDN's size path");
    assert.strictEqual(img.getAttribute("alt"), "", "decorative: the name beside it says it");
    assert.ok(t.querySelector(".shows-tile__name").textContent.length > 0, "a name");
    assert.strictEqual(t.querySelector(".tag--following"), null, "no tag: every tile here is followed, the artwork is bare");
    assert.ok(!/Following/.test(t.innerHTML.replace(/aria-label="[^"]*"/g, "")), "and no visible 'Following' word on the tile");
    const more = moreOf(t);
    assert.strictEqual(more.tagName.toLowerCase(), "button");
    assert.ok(/\biconbtn\b/.test(more.className), "the ⋯ is the 44px icon button");
    assert.strictEqual(more.getAttribute("aria-expanded"), "false");
    assert.match(more.getAttribute("aria-label"), /^More for /);
    assert.strictEqual(more.getAttribute("aria-controls"), groupOf(t).id, "and says what it controls");
    assert.strictEqual(groupOf(t).hidden, true, "Unfollow starts hidden");
    const unfollow = groupOf(t).querySelector("button");
    assert.strictEqual(unfollow.tagName.toLowerCase(), "button", "a real button");
    assert.strictEqual(unfollow.textContent.trim(), "Unfollow");
    assert.match(unfollow.getAttribute("aria-label"), /^Unfollow /, "named for its show");
  }
});

test("the readout is '{n} shows' ('1 show' for one), the knob keycap is in the head, and the Shows chip is the one chosen", () => {
  /* MUTATION 1: print the count with a different noun (yoursReadoutText's
     `shows` case) - the readout assertions fail.
     MUTATION 2: drop the knob from renderLibrary's head - the knob assertion
     fails. */
  const m = openShows(followsSeed(6));
  assert.strictEqual(one(m, "#yours-readout").textContent, "6 shows");
  assert.ok(one(m, ".yours-head #yours-knob"), "the knob keycap is in the head, beside the title");
  assert.ok(/\bkeycap\b/.test(one(m, "#yours-knob").className));
  assert.strictEqual(one(m, '[aria-selected="true"]').getAttribute("data-yours-chip"), "shows");
  const single = openShows(followsSeed(1));
  assert.strictEqual(one(single, "#yours-readout").textContent, "1 show");
});

/* ==================================================================== */
/* 2. ⋯ AND UNFOLLOW                                                     */
/* ==================================================================== */

test("⋯ reveals Unfollow and moves focus to it; ⋯ again and Escape close it and return focus; one tile is open at a time", () => {
  /* MUTATION 1: drop `focusQuietly(parts.actions.querySelector("button"))` in
     yoursOpenShowActions - the focus-in assertion fails.
     MUTATION 2: drop the `yoursCloseShowActions()` at the top of
     yoursOpenShowActions - the one-open assertion fails.
     MUTATION 3: drop `restoreFocus: true` from the toggle's close - the
     focus-back assertion fails.
     MUTATION 4: delete the Escape branch of the keydown handler - the Escape
     assertion fails.
     MUTATION 5: drop the `inert` set (or its removal) in yoursOpenShowActions
     (yoursCloseShowActions) - the inert assertions fail; the 44px gate would
     report the covered link as new debt. */
  const m = openShows(followsSeed());
  const a = tileOf(m, "show-0");
  const b = tileOf(m, "show-1");
  pressMore(m, "show-0");
  assert.strictEqual(groupOf(a).hidden, false, "Unfollow is revealed");
  assert.strictEqual(moreOf(a).getAttribute("aria-expanded"), "true");
  assert.strictEqual(m.doc.activeElement, groupOf(a).querySelector("button"), "focus moves to Unfollow");
  assert.ok(a.querySelector(".shows-tile__link").hasAttribute("inert"), "the link the group covers is inert while it is open");
  pressMore(m, "show-1");
  assert.ok(!a.querySelector(".shows-tile__link").hasAttribute("inert"), "and is back once it closes");
  assert.strictEqual(groupOf(a).hidden, true, "opening another tile closes the first");
  assert.strictEqual(moreOf(a).getAttribute("aria-expanded"), "false");
  assert.strictEqual(groupOf(b).hidden, false);
  assert.deepStrictEqual(tiles(m).filter((t) => !groupOf(t).hidden).map((t) => t.getAttribute("data-show-tile")), ["show-1"], "exactly one open");
  pressMore(m, "show-1", { focuses: false });
  assert.strictEqual(groupOf(b).hidden, true, "⋯ again closes it");
  assert.strictEqual(m.doc.activeElement, moreOf(b), "and focus is back on the ⋯, whether or not the press focused it");
  pressMore(m, "show-0");
  let prevented = false;
  fire(m, "keydown", groupOf(a).querySelector("button"), { key: "Escape", preventDefault() { prevented = true; } });
  assert.strictEqual(groupOf(a).hidden, true, "Escape closes it");
  assert.ok(prevented, "and keeps the key from doing anything else");
  assert.strictEqual(m.doc.activeElement, moreOf(a), "with focus back on the ⋯");
  fire(m, "keydown", moreOf(a), { key: "Escape" });
  assert.strictEqual(m.doc.activeElement, moreOf(a), "Escape with nothing open is left alone");
});

test("a chip press closes an open Unfollow, so it is not open again on the way back", () => {
  /* MUTATION: drop the `yoursCloseShowActions()` line in selectYoursChip - the
     closed assertion fails. */
  const m = openShows(followsSeed());
  pressMore(m, "show-2");
  assert.strictEqual(groupOf(tileOf(m, "show-2")).hidden, false);
  m.ctx.selectYoursChip("saved");
  assert.strictEqual(groupOf(tileOf(m, "show-2")).hidden, true);
  assert.strictEqual(moreOf(tileOf(m, "show-2")).getAttribute("aria-expanded"), "false");
});

test("a long press (500ms) and the context menu reveal Unfollow; lifting or moving cancels; the click that ends a long press never opens the show", () => {
  /* MUTATION 1: arm the timer at a different delay (YOURS_LONG_PRESS_MS) - the
     500 assertion fails.
     MUTATION 2: drop `swallowClick = true` in the press timer - the swallowed-click
     assertion fails (a long press would open the show it was only asking about).
     MUTATION 2b (the bug this test was rewritten for): scope the swallow to the
     link (`if (swallowClick && e.target.closest(".shows-tile__link"))` in the
     click handler, which is what the old per-link flag amounted to) - the
     tile-targeted release click is not swallowed and the first swallow
     assertion fails.
     MUTATION 2c: set `swallowClick = true` BEFORE `yoursOpenShowActions(...)` in
     the timer (opening closes the open group, which clears the flag) - the same
     first swallow assertion fails.
     MUTATION 2d: delete `swallowClick = false` from the pointerdown handler -
     the "release that made no click" assertion fails (the next tap is eaten).
     MUTATION 2e: delete `swallowClick = false` from the click handler's swallow
     branch (never used up) - the swallow outlives its click and the next
     click, the ⋯ that closes the group, is eaten: the "⋯ closes the group"
     assertion fails.
     MUTATION 3: drop `stopPress` from the pointerup list - the cancel
     assertion fails (a tap would open Unfollow half a second late).
     MUTATION 4: delete the contextmenu handler - the last assertion fails.
     MUTATION 5: widen the move threshold (`> 10` to `> 1000`) - the drag
     assertion fails. */
  const m = openShows(followsSeed());
  const t = tileOf(m, "show-3");
  const link = t.querySelector(".shows-tile__link");
  m.timers.length = 0;
  fire(m, "pointerdown", link, { clientX: 100, clientY: 300 });
  assert.strictEqual(m.timers.length, 1, "a press arms one timer");
  assert.strictEqual(m.timers[0].ms, 500, "of half a second");
  const armed = m.timers[0];
  m.timers.length = 0;
  armed.fn();
  assert.strictEqual(groupOf(t).hidden, false, "the long press reveals Unfollow");
  assert.strictEqual(m.doc.activeElement, groupOf(t).querySelector("button"), "and focus goes to it");
  /* The release click the way Chromium delivers it. The group is open over the
     artwork and the link is inert, so the click's target is the nearest common
     ancestor of the press (the link) and the release (the group): the TILE
     (<li>), never the link. The earlier version of this test fired it at the
     link, which cannot happen in a browser, and passed while the real app ate
     the next tap (the flag lived on the link and nothing used it up). */
  assert.ok(link.hasAttribute("inert"), "the link is inert by then, so no click can target it");
  assert.strictEqual(fire(m, "click", t), true, "the click the release makes (target: the tile) is swallowed");
  fire(m, "keydown", groupOf(t).querySelector("button"), { key: "Escape" });
  assert.strictEqual(groupOf(t).hidden, true, "Escape closes the group");
  assert.ok(!link.hasAttribute("inert"), "and the link is live again");
  fire(m, "pointerdown", link, { clientX: 100, clientY: 300 });
  m.timers.pop();
  fire(m, "pointerup", link);
  assert.strictEqual(fire(m, "click", link), false, "the next ordinary tap on that tile is NOT swallowed: it follows the link");

  /* Again, the release landing on the group itself, then closing by the tile's
     own ⋯ rather than Escape. */
  fire(m, "pointerdown", link, { clientX: 100, clientY: 300 });
  m.timers.pop().fn();
  assert.strictEqual(groupOf(t).hidden, false);
  assert.strictEqual(fire(m, "click", groupOf(t)), true, "a release that lands on the group is swallowed too");
  fire(m, "click", moreOf(t));
  assert.strictEqual(groupOf(t).hidden, true, "the ⋯ closes the group");
  assert.strictEqual(fire(m, "click", link), false, "and the tap after that follows the link");

  /* A long press whose release makes no click at all (the finger slid off the
     tile): the flag must not outlive the gesture. The next gesture starts with a
     pointerdown, and its tap is not swallowed. */
  fire(m, "pointerdown", link, { clientX: 100, clientY: 300 });
  m.timers.pop().fn();
  fire(m, "pointerup", link);   // no click follows
  /* the group is still open: only the next pointerdown can clear the flag here */
  fire(m, "pointerdown", link, { clientX: 100, clientY: 300 });
  m.timers.pop();
  fire(m, "pointerup", link);
  assert.strictEqual(fire(m, "click", link), false, "a release that made no click does not leave a swallow behind");

  fire(m, "pointerdown", tileOf(m, "show-4").querySelector(".shows-tile__link"), { clientX: 10, clientY: 10 });
  const tap = m.timers.pop();
  m.cleared.length = 0;   // timer ids restart at 1 after the pops above: read only what THIS event cancels
  fire(m, "pointerup", tileOf(m, "show-4").querySelector(".shows-tile__link"));
  assert.ok(m.cleared.includes(tap.id), "lifting before the half second cancels it");

  fire(m, "pointerdown", tileOf(m, "show-5").querySelector(".shows-tile__link"), { clientX: 10, clientY: 10 });
  const drag = m.timers.pop();
  m.cleared.length = 0;
  fire(m, "pointermove", tileOf(m, "show-5").querySelector(".shows-tile__link"), { clientX: 10, clientY: 40 });
  assert.ok(m.cleared.includes(drag.id), "a drag (a scroll) cancels it");

  const target = tileOf(m, "show-1");
  const prevented = fire(m, "contextmenu", target.querySelector(".shows-tile__link"));
  assert.ok(prevented, "the context menu is the long press, and the browser's menu is kept away");
  assert.strictEqual(groupOf(target).hidden, false);
});

test("Unfollow writes through the one writer, takes the tile out without a re-render, says the new count, and focus goes to a neighbour's ⋯", () => {
  /* MUTATION 1: drop the `toggleShowStar(id)` call in yoursUnfollow - the
     storage assertion fails (the tile would leave and come back on reload).
     MUTATION 2: drop `tile.remove()` - the tile assertion fails.
     MUTATION 3: drop the `yoursReadouts.shows = ...` line - the chip-round-trip
     assertion fails (the readout would say 6 again on the way back).
     MUTATION 4: drop the `announce(...)` call - the announcement assertion
     fails.
     MUTATION 5: drop the final focusQuietly - the focus assertion fails and
     focus is left on a detached button. */
  const m = openShows(followsSeed());
  const said = [];
  m.ctx.announce = (t) => said.push(t);
  const panelBefore = one(m, "#yours-panel-shows");
  const gridBefore = one(m, "#yours-shows");
  pressMore(m, "show-1");
  m.doc.activeElement = groupOf(tileOf(m, "show-1")).querySelector("button");
  fire(m, "click", groupOf(tileOf(m, "show-1")).querySelector("button"));
  assert.ok(!("show-1" in storedFollows(m)), "cp_starred_shows no longer holds it");
  assert.strictEqual(Object.keys(storedFollows(m)).length, 5, "and keeps the other five");
  assert.strictEqual(tileOf(m, "show-1"), undefined, "the tile is gone");
  assert.strictEqual(tiles(m).length, 5);
  assert.strictEqual(one(m, "#yours-panel-shows"), panelBefore, "the panel was not rebuilt");
  assert.strictEqual(one(m, "#yours-shows"), gridBefore, "nor the grid");
  assert.strictEqual(one(m, "#yours-readout").textContent, "5 shows", "the readout ticks down");
  assert.ok(said.some((t) => /^Unfollowed Titans of Nuclear\. 5 shows followed\.$/.test(t)), `announced: ${said.join(" | ")}`);
  assert.strictEqual(m.doc.activeElement, moreOf(tileOf(m, "show-2")), "focus goes to the ⋯ of the tile that took its place");
  m.ctx.selectYoursChip("saved");
  m.ctx.selectYoursChip("shows");
  assert.strictEqual(one(m, "#yours-readout").textContent, "5 shows", "the chip's readout is current after a round trip");
  /* the last tile: focus goes to the one before it */
  fire(m, "click", moreOf(tileOf(m, "show-5")));
  fire(m, "click", groupOf(tileOf(m, "show-5")).querySelector("button"));
  assert.strictEqual(m.doc.activeElement, moreOf(tileOf(m, "show-4")), "the last tile hands focus to the one before");
});

test("the last follow: the panel's note with other things saved, the whole-screen empty state with nothing else; never a bare grid", () => {
  /* MUTATION 1: drop the `panel.innerHTML = note` line - the note assertion
     fails and an empty list is left behind.
     MUTATION 2: drop the yoursNothingYet branch (always take the note) - the
     empty-state assertion fails. */
  const withHistory = openShows(followsSeed(1));
  fire(withHistory, "click", moreOf(tileOf(withHistory, "show-0")));
  fire(withHistory, "click", groupOf(tileOf(withHistory, "show-0")).querySelector("button"));
  assert.strictEqual(tiles(withHistory).length, 0);
  assert.match(one(withHistory, "#yours-panel-shows").textContent, /No followed shows yet/);
  assert.strictEqual(one(withHistory, "#yours-readout").textContent, "0 shows");
  assert.ok(one(withHistory, "#yours-chips"), "the strip stays: other panels still have things in them");

  const alone = openShows({ cp_starred_shows: JSON.stringify({ "show-0": { show_id: "show-0", title: "Only One", artwork_url: null, starred_at: "2026-09-01T00:00:00Z" } }) });
  fire(alone, "click", moreOf(tileOf(alone, "show-0")));
  fire(alone, "click", groupOf(tileOf(alone, "show-0")).querySelector("button"));
  assert.ok(one(alone, "#yours-panel-empty"), "nothing left anywhere: the first-run screen");
  assert.ok(!one(alone, "#yours-chips"), "with no strip over nothing");
});

/* ==================================================================== */
/* 3. ESCAPING                                                           */
/* ==================================================================== */

test("a title, an id and an artwork URL with markup in them reach the page inert", () => {
  /* MUTATION 1: drop esc() around the name in yoursShowTileHtml - the raw
     `<img` assertion fails.
     MUTATION 2: drop encodeURIComponent on the id in the href - the href
     assertion fails (the id would break out of the path).
     MUTATION 3: drop safeUrl() around the artwork - the javascript: assertion
     fails.
     MUTATION 4: drop esc() on `data-show-tile` - the attribute assertion
     fails. */
  const id = 'a"><script>alert(1)</script>';
  const follows = {
    [id]: { show_id: id, title: "<img src=x onerror=alert(1)> Pod", artwork_url: "javascript:alert(1)", starred_at: "2026-09-01T00:00:00Z" },
  };
  const m = openShows({ cp_starred_shows: JSON.stringify(follows) });
  const html = m.html();
  assert.ok(!html.includes("<img src=x"), "the title's markup is text");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;") || html.includes("&lt;img"), "escaped, not dropped");
  assert.ok(!html.includes("<script>alert(1)"), "the id's markup is text");
  assert.ok(!html.includes('data-show-tile="a"><script'), "and cannot close the attribute");
  const link = one(m, ".shows-tile__link");
  assert.strictEqual(link.getAttribute("href"), "#/show/" + encodeURIComponent(id), "the id is one encoded path segment");
  const img = link.querySelector("img");
  assert.ok(!/javascript:/i.test(img.getAttribute("src")), "a javascript: artwork URL does not reach src");
  assert.strictEqual(img.getAttribute("src"), "#", "safeUrl answers #");
});

test("a follow with no stored artwork or title still draws a tile: initials in the station enamel, 'Show' for a name", () => {
  /* MUTATION: drop the `|| "Show"` fallback in yoursFollowedShows - the name
     assertion fails (a tile with an empty name is a link with no label). */
  const m = openShows({ cp_starred_shows: JSON.stringify({ "bare": { show_id: "bare", starred_at: "2026-09-01T00:00:00Z" } }) });
  const t = tileOf(m, "bare");
  assert.ok(t, "a tile");
  assert.strictEqual(t.querySelector(".shows-tile__name").textContent, "Show");
  assert.strictEqual(t.querySelector(".shows-tile__link").getAttribute("title"), "Show", "and the link's own title is not empty either (the display-name rule would hide the gap in the name)");
  assert.ok(!t.querySelector("img"), "no image to fail to load");
  assert.ok(/^\w+$/.test(t.querySelector(".find-art").getAttribute("data-i")) || t.querySelector(".find-art").getAttribute("data-i").length > 0, "the station code stands in");
});

/* ==================================================================== */
/* 4. THE SHEET'S OWN RULES                                              */
/* ==================================================================== */

const RULES = parseRules(CSS);
function decl(selector, prop) {
  let out;
  for (const r of RULES) {
    if (r.atRules.length || !r.selectors.includes(selector)) continue;
    for (const d of r.decls) if (d.prop === prop) out = d.value;
  }
  return out;
}
const TOKENS = { "--s-1": 4, "--s-2": 8, "--s-3": 12, "--s-4": 16, "--tap": 44 };
const px = (v) => {
  const m = v == null ? null : /^var\((--[\w-]+)\)$/.exec(v.trim());
  return m ? TOKENS[m[1]] ?? null : null;
};

test("the grid is three minmax(0, 1fr) columns 12 apart; the art is a --r-sm square; the name is 13/600 on two lines", () => {
  /* MUTATION 1: `.shows-grid { grid-template-columns: repeat(2, ...) }` - the
     three-columns assertion fails.
     MUTATION 2: `repeat(3, 1fr)` (drop the minmax(0, ...)) - the overflow
     assertion fails: a long unbroken name would stretch its column past 375.
     MUTATION 3: `.shows-grid { gap: var(--s-2) }` - the 12 assertion fails.
     MUTATION 4: `.shows-grid .find-art--tile { border-radius: 0 }` - the radius
     assertion fails.
     MUTATION 5: `-webkit-line-clamp: 3` - the two-line assertion fails.
     MUTATION 6: `font: var(--w-label) ...` on the name - the 600 assertion fails. */
  assert.strictEqual(decl(".shows-grid", "display"), "grid");
  assert.match(decl(".shows-grid", "grid-template-columns"), /^repeat\(3, minmax\(0, 1fr\)\)$/, "three columns, each allowed to shrink below its content");
  assert.strictEqual(px(decl(".shows-grid", "gap")), 12);
  assert.strictEqual(decl(".shows-grid .find-art--tile", "aspect-ratio"), "1");
  assert.strictEqual(decl(".shows-grid .find-art--tile", "width"), "100%");
  assert.strictEqual(decl(".shows-grid .find-art--tile", "border-radius"), "var(--r-sm)");
  assert.match(CSS, /--r-sm:\s*8px/, "--r-sm is the 8px small radius");
  assert.strictEqual(decl(".shows-tile__name", "-webkit-line-clamp"), "2");
  assert.strictEqual(decl(".shows-tile__name", "line-clamp"), "2");
  assert.strictEqual(decl(".shows-tile__name", "overflow-wrap"), "anywhere", "an unbreakable token wraps instead of widening the column");
  assert.match(decl(".shows-tile__name", "font"), /^var\(--w-micro\) var\(--t-label\)\/var\(--lh-label\)/, "weight 600 (micro), size 13 (label)");
  assert.match(CSS, /--t-label:\s*0\.8125rem/, "13px");
  assert.match(CSS, /--w-micro:\s*600/, "600");
  assert.match(decl(".shows-tile__link", "gap"), /var\(--s-1\) \+ var\(--s-1\) \/ 2/, "6px between the art and the name");
});

test("the ⋯ keeps the 44px tap target; a hidden Unfollow stays hidden; the layer is the art's own square and takes no pointer events itself", () => {
  /* MUTATION 1: `.shows-tile__more { width: 32px; height: 32px }` - the 44
     assertion fails.
     MUTATION 2: put `display: flex` on `.shows-tile__actions` itself (instead
     of `:not([hidden])`) - the hidden assertion fails: a `display` on the base
     rule beats the `hidden` attribute, and Unfollow would show on every tile.
     MUTATION 3: drop `pointer-events: none` from the layer - the first
     assertion fails and the layer eats the taps meant for the link.
     MUTATION 4: drop `aspect-ratio: 1` from the layer - the second assertion
     fails and the ⋯ floats at the top of the name column, not the art.
     MUTATION 5 (iteration 2): give `.shows-tile__more` a background (the old 44px
     disc) - the quiet-opener assertion fails. MUTATION 6: set `.shows-tile__more .i`
     back to a 44px box (or any size but `--s-5`) - the chip-size assertion fails. */
  assert.strictEqual(px(decl(".iconbtn", "width")), 44);
  assert.strictEqual(px(decl(".iconbtn", "height")), 44);
  assert.strictEqual(decl(".shows-tile__more", "background"), "transparent", "the 44px target is not painted: no disc over the artwork");
  assert.match(decl(".shows-tile__more .i", "width"), /^var\(--s-5\)$/, "the drawn mark is a 20px chip, not the 44px target");
  assert.strictEqual(RULES.some((r) => r.selectors.some((x) => /tag--following/.test(x))), false, "the Following tag's rules are gone (no green check, no six identical labels)");
  /* ITERATION 3: the ⋯ is not chrome on the artwork. A 0x0 box at rest (nothing drawn,
     nothing for a pointer to land on, so a tap on the art's corner opens the show; the
     gate skips it, and it is still focusable and named), its 44px target for keyboard
     focus and while open.
     MUTATION 7: drop `width: 0` from `.shows-tile__more` (the 44px disc is back on every
     tile) - the first assertion fails. MUTATION 8: drop `height: 0` - the second fails.
     MUTATION 9: delete the `:focus-visible` / `.is-open` reveal rule - the third and
     fourth fail and a keyboard user tabs onto a button they cannot see. MUTATION 10:
     set `display: none` on the base rule - the fifth fails (out of the tab order). */
  assert.strictEqual(decl(".shows-tile__more", "width"), "0", "no disc over the artwork at rest");
  assert.strictEqual(decl(".shows-tile__more", "height"), "0", "and no box a thumb can land on: the corner of the art is the show's link");
  assert.strictEqual(decl(".shows-tile__more:focus-visible", "width"), "var(--tap)", "44px for keyboard focus");
  assert.strictEqual(decl(".shows-tile__more:focus-visible", "height"), "var(--tap)");
  assert.strictEqual(decl(".shows-tile.is-open .shows-tile__more", "width"), "var(--tap)", "and while the tile's Unfollow is open, so it can be closed");
  assert.strictEqual(decl(".shows-tile__more", "display"), undefined, "never display:none: it must stay in the tab order and the accessibility tree");
  assert.strictEqual(decl(".shows-tile__layer", "pointer-events"), "none");
  assert.strictEqual(decl(".shows-tile__layer > *", "pointer-events"), "auto");
  assert.strictEqual(decl(".shows-tile__layer", "aspect-ratio"), "1");
  assert.strictEqual(decl(".shows-tile__layer", "width"), "100%");
  assert.strictEqual(decl(".shows-tile__actions", "display"), undefined, "no display on the base rule: [hidden] must win");
  assert.strictEqual(decl(".shows-tile__actions:not([hidden])", "display"), "flex");
});

test("no transition and no animation was added for the tiles, so the one reduced-motion block needs no new name", () => {
  /* MUTATION: `.shows-tile__actions { transition: opacity .2s }` (or any
     animation on a shows rule) - the assertion fails, and the gate's reduced-
     motion check would count it as new debt. */
  const rules = RULES.filter((r) => !r.atRules.length && r.selectors.some((s) => /shows-tile|shows-grid|find-art--tile/.test(s)));
  assert.ok(rules.length >= 10, "the shows rules were found");
  for (const r of rules) {
    for (const d of r.decls) {
      assert.ok(!/^(transition|animation)/.test(d.prop), `${r.selectors.join(", ")} has ${d.prop}`);
    }
  }
});

/* ==================================================================== */
/* 5. THE SOURCE, THE HARNESS, THE MAP                                   */
/* ==================================================================== */

test("the Shows panel's source has no inline style, no raw innerHTML of data, and every URL goes through safeUrl", () => {
  /* MUTATION 1: add `style="..."` to a tile - the inline assertion fails.
     MUTATION 2: change the art `src="${esc(safeUrl(...` to `src="${esc(...` -
     the safeUrl assertion fails. */
  const a = LIBRARY_SRC.indexOf("THE SHOWS PANEL");
  const b = LIBRARY_SRC.indexOf("function bindYoursShows");
  assert.ok(a > 0 && b > a, "found the block");
  const block = LIBRARY_SRC.slice(a, b);
  assert.ok(!/\sstyle=/.test(block), "strict CSP: no inline style");
  assert.ok(!/javascript:/i.test(block));
  assert.ok(/src="\$\{esc\(safeUrl\(artUrl\(s\.art, 324\)\)\)\}"/.test(block), "the artwork src is esc(safeUrl(artUrl()))");
  assert.ok(/href="\$\{esc\(safeUrl\("#\/show\/" \+ encodeURIComponent\(s\.id\)\)\)\}"/.test(block), "the show href is a literal #/show/ and an encoded id");
  assert.ok(!/localStorage|cp_[a-z_]+/.test(block.replace(/cp_starred_shows/g, "")), "no new storage key");
});

test("the harness reaches the screen (`yours-shows`, `yours-shows-actions`) and screens.json points at it", () => {
  /* MUTATION 1: delete the `yours-shows` step from states.mjs - the first
     assertion fails (fidelity exits 2 on a map naming a step that is not there).
     MUTATION 2: point screens.json back at `starred-shows` - the second fails. */
  assert.match(STATES_SRC, /\{ label: "yours-shows", route: "#\/library", run: \(page\) => openYoursShows\(page\) \}/);
  assert.match(STATES_SRC, /\{ label: "yours-shows-actions", route: "#\/library", run: \(page\) => openYoursShowActions\(page\) \}/);
  const s = SCREENS.screens["library-shows"];
  assert.deepStrictEqual(s.app, { state: "returning", step: "yours-shows" });
  assert.deepStrictEqual(Object.keys(s.regions).sort(), ["chips", "grid", "header", "names", "primary", "tabBar", "tiles"]);
  assert.strictEqual(s.regions.grid.app, ".shows-grid");
  assert.strictEqual(s.regions.tiles.app, ".shows-tile");
});
