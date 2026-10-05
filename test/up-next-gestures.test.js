/* Up Next drag to reorder: app.js's WIRING around the gesture rules (PQ-04,
 * #762; docs/roadmap/player-features.md §3 PQ-04).
 *
 * The ARITHMETIC — the 6 px lock, which slot the finger is over, whether a
 * release commits — is player/queue-drag.js (PQ-03) and is pinned by
 * player/queue-drag.test.js. The ORDER a move writes is player/queue-order.js
 * `moveTo` (PQ-01), pinned by player/queue-order.test.js. This suite pins what
 * app.js does with them, which is where the founder's gesture is kept or lost:
 *
 *  1. every Up Next row carries a ⋮⋮ handle described by ONE hint, and the
 *     page binds the drag when it renders;
 *  2. under the lock nothing moves; past it the row follows the finger;
 *  3. the move is written on `pointerup` (DECISIONS 2026-09-23, lane L2: "a
 *     gesture commits on `pointerup`, never on the click that may follow"),
 *     through `saveQueueIds`, in `moveTo`'s order;
 *  4. a press that never became a drag writes nothing and leaves no paint;
 *  5. a gesture the system cancels writes nothing and leaves no paint;
 *  6. a row carried past the screen's edge lands where the finger is in the
 *     LIST (the scroll offset goes with every sample and the slot is asked for
 *     again after each autoscroll nudge — integration review 2026-10-04), and
 *     the arrows' after-step announces the new position.
 *
 * Every test names the mutation that kills it (CLAUDE.md: "a green test is not
 * evidence until you have broken it"); each was run and went red.
 *
 * Harness: the node:vm page of test/engine-continuation.test.js, duplicated
 * rather than imported for the reason that suite gives. Its elements remember
 * their listeners. The REAL player/queue-drag.js and player/queue-order.js are
 * published on `window` exactly as player/client.js publishes them — a fake
 * rules object here would be the "fixture more forgiving than the thing it
 * stands for" failure CLAUDE.md lists five times. The drag tests hand
 * `bindUpNextDrag` a scope of rows whose `getBoundingClientRect().top` is
 * 56*i (the design row height), with a class list that really records.
 */

const { test, before } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

let QUEUE_DRAG = null;
let QUEUE_ORDER = null;
before(async () => {
  QUEUE_DRAG = await import("../player/queue-drag.js");
  QUEUE_ORDER = await import("../player/queue-order.js");
});

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {},
    click() { for (const fn of this.listeners.click || []) fn({ preventDefault() {}, stopPropagation() {} }); },
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn",
  "banner-slot", "pl-form", "pl-input", "pl-note",
];

function mount({ ids = ["a", "b", "c"], hash = "#/queue" } = {}) {
  const store = new Map([["cp_queue", JSON.stringify(ids)]]);
  const writes = [];
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { writes.push(k); store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => {
        const s = String(sel);
        return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash, search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    forayEventLog: { append() {} },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  /* As player/client.js publishes them, at module evaluation. */
  ctx.forayQueueDrag = QUEUE_DRAG;
  ctx.forayQueueOrder = QUEUE_ORDER;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const state = vm.runInContext("state", ctx);
  state.session = { session_id: "s", episodes: {}, cards: [] };
  state.poolIds = new Set();
  for (const id of ids) state.itemIndex[id] = { id, title: `Episode ${id}`, show: "S", audio_url: `https://x.test/${id}.mp3`, topics: [] };
  return {
    ctx, store, state, byId, body,
    view: () => byId.get("view").innerHTML,
    queueRaw: () => JSON.parse(store.get("cp_queue") || "null"),
    queueWrites: () => writes.filter((k) => k === "cp_queue").length,
    said: () => body.children.map((c) => c.textContent).filter(Boolean).pop() || "",
  };
}

/** A class list that really records, so a paint or an unpaint is visible. */
function classes() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, on) => { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); },
    contains: (c) => set.has(c),
  };
}

/** The rendered Up Next rows as the drag binder sees them: row i's top edge at
    56*i, each holding a ⋮⋮ handle that remembers its listeners. */
function dragScope(ids) {
  const rows = ids.map((id, i) => ({
    classList: classes(), style: {},
    getBoundingClientRect: () => ({ top: 56 * i }),
  }));
  const handles = ids.map((id, i) => {
    const h = {
      dataset: { dragHandle: id }, disabled: false, listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      closest: (sel) => (sel === ".up-next-row" ? rows[i] : null),
      setPointerCapture() {},
      getBoundingClientRect: () => ({ top: 56 * i + 8 }),
      focus() {},
    };
    return h;
  });
  const scope = {
    querySelectorAll: (sel) => (sel === "[data-drag-handle]" ? handles : sel === ".up-next-row" ? rows : []),
  };
  return { scope, rows, handles };
}

function fire(el, type, init = {}) {
  const e = { pointerId: 1, button: 0, timeStamp: 0, cancelable: true, preventDefault() {}, stopPropagation() {}, ...init };
  for (const fn of el.listeners[type] || []) fn(e);
  return e;
}

/* ==================================================================== */

test("every Up Next row has a drag handle, the hint exists once, and the page binds the drag (PQ-04, #762)", () => {
  /* MUTATION (run, red): delete the drag-handle <button> from upNextRow -> 0
     handles for 3 rows. MUTATION 2 (run, red): delete `bindUpNextDrag($("#view"));`
     from renderQueue -> the page renders handles nothing listens to; `bound`
     stays 0. */
  const m = mount();
  let bound = 0;
  const real = m.ctx.bindUpNextDrag;
  m.ctx.bindUpNextDrag = (scope) => { bound++; return real(scope); };
  m.ctx.renderQueue();
  const html = m.view();
  const handles = [...html.matchAll(/<button type="button" class="reorder drag-handle" data-drag-handle="([^"]+)" aria-label="Drag to reorder" aria-describedby="up-next-drag-hint">/g)].map((x) => x[1]);
  assert.deepStrictEqual(handles, ["a", "b", "c"], "one handle per row, in list order");
  assert.strictEqual((html.match(/id="up-next-drag-hint"/g) || []).length, 1, "the hint every handle points at exists exactly once");
  assert.ok(html.indexOf('data-drag-handle="a"') < html.indexOf('data-reorder-up="a"'), "the handle opens the arrows' group; the arrows remain");
  assert.strictEqual(bound, 1, "renderQueue binds the drag once per render");

  const empty = mount({ ids: [] });
  empty.ctx.renderQueue();
  assert.ok(!empty.view().includes("up-next-drag-hint"), "no rows, no handles, no hint");
});

test("a press moves nothing under the 6 px lock; at 6 px the drag claims and the row follows the finger (PQ-04, #762)", () => {
  /* MUTATION (run, red): drop `!g.claimsTouch(drag)` from paint's guard -> the
     row is translated at 5 px, while the press may still be a tap.
     MUTATION 2 (run, red): delete `row.classList.add("is-dragging")` from the
     pointerdown handler -> the pressed row is never lifted.
     MUTATION 3 (run, red): drop `g.claimsTouch(drag) &&` from the handle's
     touchmove listener -> a press under the lock cancels the page's scroll. */
  const m = mount();
  const { scope, rows, handles } = dragScope(["a", "b", "c"]);
  m.ctx.bindUpNextDrag(scope);
  fire(handles[0], "pointerdown", { clientY: 20 });
  assert.ok(rows[0].classList.contains("is-dragging"), "the pressed row is lifted at the press");
  fire(handles[0], "pointermove", { clientY: 25 });
  assert.ok(!rows[0].style.transform, `5 px is still a tap: nothing moves (${rows[0].style.transform})`);
  let cancelled = false;
  fire(handles[0], "touchmove", { preventDefault() { cancelled = true; } });
  assert.strictEqual(cancelled, false, "under the lock the page keeps the finger (it may be a scroll)");
  fire(handles[0], "pointermove", { clientY: 26 });
  assert.strictEqual(rows[0].style.transform, "translateY(6px)", "at 6 px the row follows the finger");
  fire(handles[0], "touchmove", { preventDefault() { cancelled = true; } });
  assert.strictEqual(cancelled, true, "once claimed, the page under the finger must not pan");
  assert.strictEqual(m.queueWrites(), 0, "moving is not committing: nothing is written mid-drag");
});

test("release at y=141 from row 0 commits on pointerup: cp_queue becomes [b, c, a] (PQ-04, #762)", () => {
  /* MUTATION (run, red): bind the commit to "click" instead of "pointerup" ->
     the release writes nothing and cp_queue stays [a, b, c] (lane L2: the
     move belongs to the release, never to the click that may follow it).
     MUTATION 2 (run, red): pass `r.from` instead of `r.to` to moveTo ->
     moveTo hands back the same list and nothing moves. */
  const m = mount();
  const { scope, rows, handles } = dragScope(["a", "b", "c"]);
  m.ctx.bindUpNextDrag(scope);
  fire(handles[0], "pointerdown", { clientY: 20 });
  fire(handles[0], "pointermove", { clientY: 141 });
  assert.ok(rows[2].classList.contains("drop-after"), "the row it would land below is marked on its lower edge");
  assert.deepStrictEqual(m.queueRaw(), ["a", "b", "c"], "nothing is written before the release");
  fire(handles[0], "pointerup", { clientY: 141 });
  assert.deepStrictEqual(m.queueRaw(), ["b", "c", "a"], "the row lands in the slot the finger was over");
  assert.strictEqual(m.queueWrites(), 1, "one write, through saveQueueIds");
  const order = [...m.view().matchAll(/data-drag-handle="([^"]+)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(order, ["b", "c", "a"], "the page is a live view of cp_queue: it repainted in the new order");
});

test("a release without movement writes nothing and leaves the row unpainted (PQ-04, #762)", () => {
  /* MUTATION (run, red): delete `reset();` from the pointerup handler -> the
     tapped row keeps `is-dragging` and the next press on any handle is
     refused (`pointer` still held). */
  const m = mount();
  const { scope, rows, handles } = dragScope(["a", "b", "c"]);
  m.ctx.bindUpNextDrag(scope);
  fire(handles[1], "pointerdown", { clientY: 80 });
  fire(handles[1], "pointerup", { clientY: 80 });
  assert.deepStrictEqual(m.queueRaw(), ["a", "b", "c"]);
  assert.strictEqual(m.queueWrites(), 0, "a tap on the handle is not a reorder");
  assert.ok(!rows[1].classList.contains("is-dragging"), "the lift is undone at the release");
  assert.strictEqual(m.said(), "", "nothing moved, so nothing is announced");
  /* The next press is a fresh gesture, not refused by a stale one. */
  fire(handles[0], "pointerdown", { clientY: 20, pointerId: 2 });
  assert.ok(rows[0].classList.contains("is-dragging"), "the binder is free for the next press");
});

test("pointercancel writes nothing and clears the paint (PQ-04, #762)", () => {
  /* MUTATION (run, red): delete `btn.addEventListener("pointercancel", cancel);`
     -> the carried row stays lifted, translated and marked after the system
     took the finger. MUTATION 2 (run, red): bind pointercancel to the
     pointerup handler -> a cancelled gesture reorders the list. */
  const m = mount();
  const { scope, rows, handles } = dragScope(["a", "b", "c"]);
  m.ctx.bindUpNextDrag(scope);
  fire(handles[0], "pointerdown", { clientY: 20 });
  fire(handles[0], "pointermove", { clientY: 141 });
  assert.ok(rows[0].style.transform && rows[2].classList.contains("drop-after"), "precondition: a claimed drag over slot 3");
  fire(handles[0], "pointercancel");
  assert.deepStrictEqual(m.queueRaw(), ["a", "b", "c"], "a cancelled gesture writes nothing");
  assert.strictEqual(m.queueWrites(), 0);
  assert.ok(!rows[0].classList.contains("is-dragging"), "the lift is cleared");
  assert.ok(!rows[0].style.transform, "the row is back in its place");
  assert.ok(!rows[2].classList.contains("drop-after"), "the landing mark is cleared");
  fire(handles[0], "pointerup", { clientY: 141 });
  assert.strictEqual(m.queueWrites(), 0, "a release after the cancel finds no gesture to commit");
});

test("a row carried past the screen's edge lands where the finger is in the list; 'Moved to position 3 of 3.' (PQ-04, #762)", () => {
  /* The finger parks at y=138 on a 180 px screen: inside the bottom 48 px, so
     the list scrolls 8 px under it. In LIST coordinates the finger is then at
     146, past row 3's midpoint (140), so the row lands in slot 3; on the glass
     it is still at 138, short of that midpoint, which would land it in slot 2.
     MUTATION (run, red): delete the `moveRowDrag` re-run after `scrollBy` ->
     the slot is the pre-scroll one, cp_queue is [b, a, c] and the announcement
     says "position 2 of 3". MUTATION 2 (run, red): pass 0 instead of
     `scrollOffset()` to moveRowDrag -> the same. MUTATION 3 (run, red): delete
     `afterQueueMove(...)` from the pointerup handler -> nothing is announced. */
  const m = mount();
  m.ctx.innerHeight = 180;
  m.ctx.scrollY = 0;
  const nudges = [];
  m.ctx.scrollBy = (_x, dy) => { nudges.push(dy); m.ctx.scrollY += dy; };
  const { scope, handles } = dragScope(["a", "b", "c"]);
  m.ctx.bindUpNextDrag(scope);
  fire(handles[0], "pointerdown", { clientY: 20 });
  fire(handles[0], "pointermove", { clientY: 100 });
  assert.deepStrictEqual(nudges, [], "mid-screen: no autoscroll");
  fire(handles[0], "pointermove", { clientY: 138 });
  assert.deepStrictEqual(nudges, [8], "near the bottom edge the list scrolls under the finger");
  fire(handles[0], "pointerup", { clientY: 138 });
  assert.deepStrictEqual(m.queueRaw(), ["b", "c", "a"], "the slot follows the list, not the glass");
  assert.strictEqual(m.said(), "Moved to position 3 of 3.", "the arrows' after-step announces where it landed");
});
