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
 * And swipe left to remove (PQ-06, #762; player-features.md §3 PQ-06), whose
 * arithmetic is player/queue-swipe.js (PQ-05, pinned by its own suite):
 *
 *  7. a 100 px leftward pull on a row's text block removes the row on
 *     `pointerup` (lane L2 again), through `removeFromQueue`;
 *  8. a gesture that moves vertically first is the list scrolling: nothing is
 *     painted, the page keeps the finger, nothing is written;
 *  9. a rightward drag never paints and never removes;
 * 10. after a swipe removal the ✕'s after-step runs: "Removed from Up Next."
 *     and focus on the ✕ that took the row's place;
 * 11. the ✕ still removes, beside the swipe (the alternative a pointer-only
 *     gesture owes keyboard and switch users, WCAG 2.5.1).
 *
 * PORTED (Redesign 2026, ambient; the Up Next page unit): the page's row is Library's QueueRow (ui/library.js
 * `libQueueRowHtml` with the `page` flag), so the gestures are bound to it: the drag is a HOLD on the row's cover
 * (`[data-drag-handle]` is the cover button; iteration 2 removed the `.qp-handle` glyph button, the direction gives the
 * row one trailing control), the swipe listens on the same cover (`.qp-row > .lb-cover`, what a finger lands on), the arrows and the ✕ are the row's
 * menu (Move up, Move down, Remove: pinned by test/ambient-up-next.test.js), and a removal by swipe has the same Toast
 * and Undo as the menu's. What each gesture does to the list is unchanged, and so are the rules' tests.
 *
 * Every test names the mutation that kills it (CLAUDE.md: "a green test is not
 * evidence until you have broken it"); each was run and went red.
 *
 * Harness: the node:vm page of test/engine-continuation.test.js, duplicated
 * rather than imported for the reason that suite gives. Its elements remember
 * their listeners. The REAL player/queue-drag.js and player/queue-order.js are
 * published on `window` exactly as player/client.js publishes them (and,
 * for the swipe, the REAL player/queue-swipe.js) — a fake
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
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

let QUEUE_DRAG = null;
let QUEUE_ORDER = null;
let QUEUE_SWIPE = null;
before(async () => {
  QUEUE_DRAG = await import("../player/queue-drag.js");
  QUEUE_ORDER = await import("../player/queue-order.js");
  QUEUE_SWIPE = await import("../player/queue-swipe.js");
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

/** The page repaints its section IN PLACE (app.js repaintQueuePage -> repaintLibraryUpNext): `#view` answers the one
    selector that asks with a section whose innerHTML reads and writes the slice of the page between its tags, and whose
    `querySelectorAll` is the view's own (so the rows a repaint draws are bound, as a real DOM would). */
function sectionAware(el) {
  const open = '<section class="lb-section qp-section" data-lb-section="upnext" data-lb-page="queue">';
  el.querySelector = (sel) => {
    if (!String(sel).includes('data-lb-section="upnext"') || !el.innerHTML.includes(open)) return null;
    const bounds = () => { const a = el.innerHTML.indexOf(open) + open.length; return [a, el.innerHTML.indexOf("</section>", a)]; };
    return {
      dataset: { lbPage: "queue" }, contains: () => false, querySelector: () => null,
      querySelectorAll: (q) => el.querySelectorAll(q), getBoundingClientRect: () => ({ top: 0 }),
      get innerHTML() { const [a, b] = bounds(); return el.innerHTML.slice(a, b); },
      set innerHTML(v) { const [a, b] = bounds(); el.innerHTML = el.innerHTML.slice(0, a) + v + el.innerHTML.slice(b); },
    };
  };
}

function mount({ ids = ["a", "b", "c"], hash = "#/queue" } = {}) {
  const store = new Map([["cp_queue", JSON.stringify(ids)]]);
  const writes = [];
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");
  sectionAware(byId.get("view"));
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
    /* The drag's hold (QP_HOLD_MS) is driven by the test, not the clock: a hold timer is parked in `holds` and `releaseHold()`
       completes it (`dropHold` clears it, as a real clearTimeout would). Every other timer is real. */
    setTimeout: (fn, ms) => {
      if (ms === holdMs()) { const h = { fn, live: true }; holds.push(h); return h; }
      const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t;
    },
    clearTimeout: (t) => { if (t && typeof t === "object" && "live" in t) t.live = false; else clearTimeout(t); },
    encodeURIComponent, decodeURIComponent,
    forayEventLog: { append() {} },
  };
  const holds = [];
  const holdMs = () => { try { return vm.runInContext("QP_HOLD_MS", ctx); } catch (_) { return -1; } };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  /* As player/client.js publishes them, at module evaluation. */
  ctx.forayQueueDrag = QUEUE_DRAG;
  ctx.forayQueueOrder = QUEUE_ORDER;
  ctx.forayQueueSwipe = QUEUE_SWIPE;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
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
    pendingHolds: () => holds.filter((h) => h.live).length,
    /* The hold completes: every live hold timer fires once. */
    releaseHold: () => { for (const h of holds.splice(0)) if (h.live) { h.live = false; h.fn(); } },
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
    56*i, each holding a drag handle that remembers its listeners. */
function dragScope(ids) {
  const rows = ids.map((id, i) => ({
    classList: classes(), style: {}, dataset: { lbQ: id },
    getBoundingClientRect: () => ({ top: 56 * i }),
  }));
  const handles = ids.map((id, i) => {
    const h = {
      dataset: { dragHandle: id }, disabled: false, listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      closest: (sel) => (sel === ".qp-row" ? rows[i] : null),
      setPointerCapture() {},
      getBoundingClientRect: () => ({ top: 56 * i + 8 }),
      focus() {},
    };
    return h;
  });
  const scope = {
    querySelectorAll: (sel) => (sel === "[data-drag-handle]" ? handles : sel === ".qp-row" ? rows : []),
  };
  return { scope, rows, handles };
}

/** A press on a cover, held until the row is lifted (the hold timer completes). */
function press(m, el, init = {}) {
  const e = fire(el, "pointerdown", init);
  m.releaseHold();
  return e;
}

function fire(el, type, init = {}) {
  const e = { pointerId: 1, button: 0, timeStamp: 0, cancelable: true, preventDefault() {}, stopPropagation() {}, ...init };
  for (const fn of el.listeners[type] || []) fn(e);
  return e;
}

/* ==================================================================== */

test("every Up Next row with a menu is dragged by a hold on its cover, the hint exists once, and the page binds the drag (PQ-04, #762)", () => {
  /* MUTATION (run, red): delete the \`data-drag-handle\` attribute from the cover in libQueueRowHtml -> 0 draggable
     covers for 3 rows. MUTATION 2 (run, red): delete \`bindUpNextDrag($("#view"));\` from renderQueue -> the page
     renders covers nothing listens to; \`bound\` stays 0. MUTATION 3 (run, red): restore the \`qp-handle\` button
     beside the menu -> the no-glyph assertion is red (iteration 2: the row has one trailing control). */
  const m = mount();
  let bound = 0;
  const real = m.ctx.bindUpNextDrag;
  m.ctx.bindUpNextDrag = (scope) => { bound++; return real(scope); };
  m.ctx.renderQueue();
  const html = m.view();
  const covers = [...html.matchAll(/<button type="button" class="lb-cover" data-lb-play="([^"]+)" data-swipe-id="[^"]+" data-drag-handle="([^"]+)" aria-describedby="up-next-drag-hint" data-ctx="upnext" data-title="Episode [^"]+" aria-label="(?:Play|Pause) Episode [^"]+"><\/button>/g)].map((x) => [x[1], x[2]]);
  assert.deepStrictEqual(covers, [["a", "a"], ["b", "b"], ["c", "c"]], "one draggable cover per row, in list order");
  assert.ok(!/qp-handle/.test(html), "no handle glyph: the menu is the row's one trailing control");
  assert.strictEqual((html.match(/id="up-next-drag-hint"/g) || []).length, 1, "the hint every cover points at exists exactly once");
  assert.match(html, /id="up-next-drag-hint">Hold, then drag, to move this episode\. Its menu has Move up and Move down\.</, "it says how");
  assert.ok(html.indexOf('data-drag-handle="a"') < html.indexOf('data-lb-menu="a"'), "the cover sits before the menu; the menu (Move up, Move down) remains for keyboard and switch users");
  assert.strictEqual(bound, 1, "renderQueue binds the drag once per render");

  const empty = mount({ ids: [] });
  empty.ctx.renderQueue();
  assert.ok(!empty.view().includes("up-next-drag-hint"), "no rows, no covers, no hint");
});

test("a hold lifts the row; under the 6 px lock nothing moves, at 6 px the drag claims and the row follows the finger (PQ-04, #762)", () => {
  /* MUTATION (run, red): drop \`!g.claimsTouch(drag)\` from paint's guard -> the row is translated at 5 px, while the press
     may still be a tap. MUTATION 2 (run, red): delete \`row.classList.add("is-dragging")\` from lift -> the held row is
     never lifted. MUTATION 3 (run, red): change the touchmove guard from \`drag &&\` to \`drag && drag.claimed &&\`
     -> a held row that has not yet moved lets the page pan under the finger. MUTATION 4 (run, red): lift on pointerdown
     (call \`lift()\` there) -> the "not lifted before the hold" assertion is red. */
  const m = mount();
  const { scope, rows, handles } = dragScope(["a", "b", "c"]);
  m.ctx.bindUpNextDrag(scope);
  fire(handles[0], "pointerdown", { clientY: 20 });
  assert.ok(!rows[0].classList.contains("is-dragging"), "a press is not a lift: nothing happens before the hold completes");
  assert.strictEqual(m.pendingHolds(), 1, "the hold is running");
  let cancelled = false;
  fire(handles[0], "touchmove", { preventDefault() { cancelled = true; } });
  assert.strictEqual(cancelled, false, "before the hold the page keeps the finger (it may be a scroll)");
  m.releaseHold();
  assert.ok(rows[0].classList.contains("is-dragging"), "the held row is lifted");
  assert.strictEqual(m.said(), "Picked up.", "and it says so");
  fire(handles[0], "pointermove", { clientY: 25 });
  assert.ok(!rows[0].style.transform, `5 px is still under the lock: nothing moves (${rows[0].style.transform})`);
  fire(handles[0], "touchmove", { preventDefault() { cancelled = true; } });
  assert.strictEqual(cancelled, true, "once lifted the page under the finger must not pan, even under the lock");
  fire(handles[0], "pointermove", { clientY: 26 });
  assert.strictEqual(rows[0].style.transform, "translateY(6px)", "at 6 px the row follows the finger");
  assert.strictEqual(m.queueWrites(), 0, "moving is not committing: nothing is written mid-drag");
});

test("a finger that travels before the hold completes is a scroll or a swipe: no lift, the hold is dropped (PQ-04, #762)", () => {
  /* MUTATION (run, red): delete the slop check in pointermove (\`Math.hypot(...) >= QP_HOLD_SLOP\`) -> the hold
     completes under a scrolling finger and lifts the row. MUTATION 2 (run, red): raise QP_HOLD_SLOP to 40 -> 9 px of
     travel no longer drops the hold. Both a vertical (scroll) and a horizontal (swipe) start are covered. */
  for (const [dx, dy] of [[0, 9], [-9, 0]]) {
    const m = mount();
    const { scope, rows, handles } = dragScope(["a", "b", "c"]);
    m.ctx.bindUpNextDrag(scope);
    fire(handles[0], "pointerdown", { clientX: 200, clientY: 20 });
    fire(handles[0], "pointermove", { clientX: 200 + dx, clientY: 20 + dy });
    assert.strictEqual(m.pendingHolds(), 0, `travel (${dx}, ${dy}) drops the hold`);
    m.releaseHold();
    assert.ok(!rows[0].classList.contains("is-dragging"), `travel (${dx}, ${dy}): the row is never lifted`);
    fire(handles[0], "pointerup", { clientX: 200 + dx, clientY: 20 + dy });
    assert.strictEqual(m.queueWrites(), 0);
  }
  /* A small drift (inside the 8 px slop) keeps the hold, and the lift starts from where the finger is now. */
  const m = mount();
  const { scope, rows, handles } = dragScope(["a", "b", "c"]);
  m.ctx.bindUpNextDrag(scope);
  fire(handles[0], "pointerdown", { clientX: 200, clientY: 20 });
  fire(handles[0], "pointermove", { clientX: 202, clientY: 24 });
  m.releaseHold();
  assert.ok(rows[0].classList.contains("is-dragging"), "4 px of drift is still a hold");
  fire(handles[0], "pointermove", { clientX: 202, clientY: 29 });
  assert.ok(!rows[0].style.transform, "the drag's origin is the finger at the lift (24), so 5 px on is still under the lock");
  fire(handles[0], "pointermove", { clientX: 202, clientY: 30 });
  assert.strictEqual(rows[0].style.transform, "translateY(6px)");
});

test("released before the hold, a press is a tap: nothing is lifted, nothing swallowed, the click plays the row (PQ-04, #762)", () => {
  /* MUTATION (run, red): delete \`dropHold()\` from reset -> the abandoned hold completes later and lifts a row nobody
     is holding (\`pendingHolds\` stays 1 and the late lift is painted). MUTATION 2 (run, red): set \`btn._lbSwallow = true\`
     unconditionally in pointerup -> a tap's click is swallowed and the row never plays. */
  const m = mount();
  const { scope, rows, handles } = dragScope(["a", "b", "c"]);
  m.ctx.bindUpNextDrag(scope);
  fire(handles[1], "pointerdown", { clientY: 80 });
  fire(handles[1], "pointerup", { clientY: 80 });
  assert.strictEqual(m.pendingHolds(), 0, "the hold is dropped at the release");
  m.releaseHold();
  assert.ok(!rows[1].classList.contains("is-dragging"), "no late lift");
  assert.ok(!handles[1]._lbSwallow, "the click that follows a tap is a tap to play");
  assert.strictEqual(m.queueWrites(), 0);
});

test("release at y=141 from row 0 commits on pointerup: cp_queue becomes [b, c, a] (PQ-04, #762)", () => {
  /* MUTATION (run, red): bind the commit to "click" instead of "pointerup" ->
     the release writes nothing and cp_queue stays [a, b, c] (lane L2: the
     move belongs to the release, never to the click that may follow it).
     MUTATION 2 (run, red): pass `r.from` instead of `r.to` to moveTo ->
     moveTo hands back the same list and nothing moves. */
  const m = mount();
  m.ctx.renderQueue(); // the page the repaint below is of: it repaints its section in place, it does not draw a page
  const { scope, rows, handles } = dragScope(["a", "b", "c"]);
  m.ctx.bindUpNextDrag(scope);
  press(m, handles[0], { clientY: 20 });
  fire(handles[0], "pointermove", { clientY: 141 });
  assert.ok(rows[2].classList.contains("drop-after"), "the row it would land below is marked on its lower edge");
  assert.deepStrictEqual(m.queueRaw(), ["a", "b", "c"], "nothing is written before the release");
  fire(handles[0], "pointerup", { clientY: 141 });
  assert.deepStrictEqual(m.queueRaw(), ["b", "c", "a"], "the row lands in the slot the finger was over");
  assert.strictEqual(m.queueWrites(), 1, "one write, through saveQueueIds");
  const order = [...m.view().matchAll(/data-drag-handle="([^"]+)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(order, ["b", "c", "a"], "the page is a live view of cp_queue: it repainted in the new order");
});

test("a drag never carries a row above the playing one, and an unqueued playing row is not written into cp_queue (PQ-04, #762)", () => {
  /* The playing row is drawn first (Library's Up Next model) and stays first, as Move up on the second row is disabled.
     The drawn list is the list the finger is over; cp_queue holds the playing row only if it was queued.
     MUTATION 1 (run, red): drop \`Math.max(pinned ? 1 : 0, r.to)\` (use r.to) -> c lands above z: [z] is not first.
     MUTATION 2 (run, red): drop the \`.filter((x) => x !== pinned)\` -> the unqueued z is written into cp_queue.
     MUTATION 3 (run, red): move on \`queueIds()\` instead of the drawn rows (\`shown\`) -> the index is off by one when
     z is not queued. */
  const drive = (queued) => {
    const m = mount({ ids: queued });
    m.state.itemIndex.z = { id: "z", title: "Episode z", show: "S", audio_url: "https://x.test/z.mp3", topics: [] };
    m.ctx.window.ForayPlayer = { currentEpisodeId: () => "z", isCurrent: (id) => id === "z", isPlaying: () => true };
    const { scope, handles } = dragScope(["z", "a", "b", "c"]);
    m.ctx.bindUpNextDrag(scope);
    press(m, handles[3], { clientY: 3 * 56 + 8 });
    fire(handles[3], "pointermove", { clientY: 5 });
    fire(handles[3], "pointerup", { clientY: 5 });
    return m.queueRaw();
  };
  assert.deepStrictEqual(drive(["a", "b", "c"]), ["c", "a", "b"], "z is playing but not queued: c goes to the top of the queue, z stays out of it");
  assert.deepStrictEqual(drive(["z", "a", "b", "c"]), ["z", "c", "a", "b"], "z is queued and playing: it stays first, c lands right after it");
});

test("a lifted row released without movement writes nothing, leaves the row unpainted, and swallows the click (PQ-04, #762)", () => {
  /* MUTATION (run, red): delete \`reset();\` from the pointerup handler -> the held row keeps \`is-dragging\` and the
     next press on any cover is refused (\`pointer\` still held). MUTATION 2 (run, red): delete the \`btn._lbSwallow = true\`
     line -> the click that follows the release plays the row the listener only meant to hold. */
  const m = mount();
  const { scope, rows, handles } = dragScope(["a", "b", "c"]);
  m.ctx.bindUpNextDrag(scope);
  press(m, handles[1], { clientY: 80 });
  assert.ok(rows[1].classList.contains("is-dragging"), "precondition: lifted");
  fire(handles[1], "pointerup", { clientY: 80 });
  assert.deepStrictEqual(m.queueRaw(), ["a", "b", "c"]);
  assert.strictEqual(m.queueWrites(), 0, "a hold with no travel is not a reorder");
  assert.ok(!rows[1].classList.contains("is-dragging"), "the lift is undone at the release");
  assert.strictEqual(handles[1]._lbSwallow, true, "the click after a lifted release is the gesture's end, not a tap to play");
  /* The next press is a fresh gesture, not refused by a stale one. */
  press(m, handles[0], { clientY: 20, pointerId: 2 });
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
  press(m, handles[0], { clientY: 20 });
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
  press(m, handles[0], { clientY: 20 });
  fire(handles[0], "pointermove", { clientY: 100 });
  assert.deepStrictEqual(nudges, [], "mid-screen: no autoscroll");
  fire(handles[0], "pointermove", { clientY: 138 });
  assert.deepStrictEqual(nudges, [8], "near the bottom edge the list scrolls under the finger");
  fire(handles[0], "pointerup", { clientY: 138 });
  assert.deepStrictEqual(m.queueRaw(), ["b", "c", "a"], "the slot follows the list, not the glass");
  assert.strictEqual(m.said(), "Moved to position 3 of 3.", "the arrows' after-step announces where it landed");
});

/* ==================================================================== */
/* Swipe left to remove (PQ-06, #762)                                    */

/** #view as the swipe and the ✕ see it: `querySelectorAll` answers from the
    CURRENT innerHTML, so every repaint (`saveQueueIds` -> the section's in-place
    repaint) hands out fresh elements, as a real live view does. Each row's cover
    remembers its listeners and leads to a row whose class list really records; each
    menu button remembers its listeners and records focus. `focused` is the last
    element given focus, as `{ attr, id }`. */
function liveView(m) {
  const view = m.byId.get("view");
  const seen = { html: null, infos: [], removes: [] };
  const out = { focused: null };
  const listenable = () => ({
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  });
  const build = () => {
    if (seen.html === view.innerHTML) return seen;
    seen.html = view.innerHTML;
    seen.infos = [...seen.html.matchAll(/data-swipe-id="([^"]+)"/g)].map((x) => {
      const row = { classList: classes(), style: {} };
      return Object.assign(listenable(), {
        dataset: { swipeId: x[1] }, row,
        closest: (sel) => (sel === ".qp-row" ? row : null),
        setPointerCapture() {},
      });
    });
    seen.removes = [...seen.html.matchAll(/data-lb-menu="([^"]+)"/g)].map((x) => Object.assign(listenable(), {
      dataset: { lbMenu: x[1] }, disabled: false,
      getAttribute: (a) => (a === "data-lb-menu" ? x[1] : null),
      focus() { out.focused = { attr: "data-lb-menu", id: x[1] }; },
    }));
    return seen;
  };
  view.querySelectorAll = (sel) => {
    const v = build();
    if (sel === ".qp-row > .lb-cover") return v.infos;
    if (sel === "[data-lb-menu]") return v.removes;
    return [];
  };
  out.info = (id) => build().infos.find((i) => i.dataset.swipeId === id);
  out.menu = (id) => build().removes.find((b) => b.dataset.lbMenu === id);
  return out;
}

/** A pointer gesture on `el`, one sample every 16 ms: the [x, y] pairs after
    the press at (x0, y0), then — unless `hold` — the release. Returns whether
    ANY touchmove was cancelled (did the swipe take the finger from the page). */
function swipe(el, x0, y0, moves, { hold = false } = {}) {
  let t = 0;
  fire(el, "pointerdown", { clientX: x0, clientY: y0, timeStamp: t });
  let cancelled = false;
  for (const [x, y] of moves) {
    t += 16;
    fire(el, "pointermove", { clientX: x, clientY: y, timeStamp: t });
    fire(el, "touchmove", { preventDefault() { cancelled = true; } });
  }
  const last = moves.length ? moves[moves.length - 1] : [x0, y0];
  if (!hold) fire(el, "pointerup", { clientX: last[0], clientY: last[1], timeStamp: t + 16 });
  return cancelled;
}

test("a 100 px leftward pull on a row removes it on pointerup, with the menu's Toast and Undo (PQ-06, #762)", () => {
  /* MUTATION (run, red): bind the swipe's removal handler to "click" instead
     of "pointerup" -> the release writes nothing and cp_queue keeps b (lane
     L2: the removal belongs to the release, never to the click after it).
     MUTATION 2 (run, red): delete `bindUpNextSwipe($("#view"));` from
     renderQueue -> the rows render with nothing listening; cp_queue keeps b.
     MUTATION 3 (run, red): delete `row.classList.add("swiping");` -> the
     carried row keeps the spring-back easing and lags the finger. */
  const m = mount();
  const v = liveView(m);
  m.ctx.renderQueue();
  assert.strictEqual((m.view().match(/<span class="qp-under" aria-hidden="true">Remove<\/span>/g) || []).length, 3,
    "every row carries the label the swipe reveals, hidden from assistive tech");
  const info = v.info("b");
  assert.ok(info, "the swipe listens on the row's cover, keyed by its id");
  fire(info, "pointerdown", { clientX: 300, clientY: 60, timeStamp: 0 });
  fire(info, "pointermove", { clientX: 250, clientY: 61, timeStamp: 50 });
  assert.ok(info.row.classList.contains("swiping"), "past the lock the row is carried");
  assert.strictEqual(info.row.style.transform, "translateX(-50px)", "the row follows the finger left");
  fire(info, "pointermove", { clientX: 200, clientY: 61, timeStamp: 100 });
  assert.deepStrictEqual(m.queueRaw(), ["a", "b", "c"], "nothing is written before the release");
  fire(info, "pointerup", { clientX: 200, clientY: 61, timeStamp: 400 });
  assert.deepStrictEqual(m.queueRaw(), ["a", "c"], "the swiped row left Up Next");
  assert.strictEqual(m.queueWrites(), 1, "one write, through removeFromQueue -> saveQueueIds");
  assert.ok(!m.view().includes('data-swipe-id="b"'), "the page is a live view of cp_queue: b's row is gone");
  /* A removal by swipe is the menu's Remove: the same Undo, so it can be taken back. (MUTATION: have the swipe call
     removeFromQueue directly instead of libRemoveRow -> libUi.undo is null and Undo restores nothing.) */
  m.ctx.libUndo();
  assert.deepStrictEqual(m.queueRaw(), ["a", "b", "c"], "Undo puts the swiped row back where it was");
  /* The click that follows a claimed swipe is the end of the gesture, not a tap to play. (MUTATION: delete the
     `_lbSwallow` line in the swipe's pointerup -> the flag stays false and the cover would play the row.) */
  assert.strictEqual(info._lbSwallow, true, "a claimed swipe tells the cover's click to stand down");
});

test("a gesture that moves vertically first is the list scrolling: nothing moves, nothing is written (PQ-06, #762)", () => {
  /* MUTATION (run, red): delete `if (swipe.rejected) { reset(); return; }`
     and `if (!swipe.claimed) return;` from pointermove -> the scroll paints
     the row (`translateX(-0px)` and `.swiping`). */
  const m = mount();
  const v = liveView(m);
  m.ctx.renderQueue();
  const info = v.info("a");
  const cancelled = swipe(info, 300, 60, [[300, 64], [300, 75], [200, 80], [150, 82]], { hold: true });
  assert.strictEqual(cancelled, false, "the page keeps the finger: it is scrolling");
  assert.ok(!info.row.classList.contains("swiping"), "the row is never carried, mid-gesture");
  assert.ok(!info.row.style.transform, "the row never moves, mid-gesture");
  fire(info, "pointerup", { clientX: 150, clientY: 82, timeStamp: 80 });
  assert.deepStrictEqual(m.queueRaw(), ["a", "b", "c"], "a long leftward pull after a vertical start removes nothing");
  assert.strictEqual(m.queueWrites(), 0);
});

test("a rightward drag never paints and never removes (PQ-06, #762)", () => {
  /* MUTATION (run, red): replace `g.endSwipe(swipe)` in the pointerup handler
     with `{ remove: true }` -> the rightward drag removes c: the removal must
     be the rules' decision, never the binder's. MUTATION 2 (run, red): drop
     `if (!swipe.claimed) return;` from pointermove -> the unclaimed rightward
     drag is painted `.swiping`. MUTATION 3 (run, red): drop `swipe.claimed && `
     from the touchmove listener -> an unclaimed drag cancels the page's
     touchmove and the list under the finger cannot pan. */
  const m = mount();
  const v = liveView(m);
  m.ctx.renderQueue();
  const info = v.info("c");
  const cancelled = swipe(info, 100, 140, [[150, 140], [220, 141], [330, 141]], { hold: true });
  assert.strictEqual(cancelled, false, "a rightward drag never takes the finger from the page");
  assert.ok(!info.row.style.transform, "a rightward drag paints nothing, mid-gesture");
  assert.ok(!info.row.classList.contains("swiping"), "and carries nothing");
  fire(info, "pointerup", { clientX: 330, clientY: 141, timeStamp: 64 });
  assert.deepStrictEqual(m.queueRaw(), ["a", "b", "c"], "rightward never removes");
  assert.strictEqual(m.queueWrites(), 0);
});

test("after a swipe removal: 'Removed from Up Next.' and focus on the menu of the row that took its place (PQ-06, #762)", () => {
  /* MUTATION (run, red): delete `afterQueueRemove(index);` from the swipe's
     pointerup handler -> focus is left behind.
     MUTATION 2 (run, red): pass `index + 1` -> focus lands on c's menu.
     MUTATION 3 (run, red): delete `announce(...)` from libRemoveRow -> nothing is announced. */
  const m = mount();
  const v = liveView(m);
  m.ctx.renderQueue();
  swipe(v.info("a"), 300, 20, [[280, 21], [240, 21], [190, 21]]);
  assert.deepStrictEqual(m.queueRaw(), ["b", "c"]);
  assert.strictEqual(m.said(), "Removed from Up Next.", "the removal is said, politely (the shared status region)");
  assert.deepStrictEqual(v.focused, { attr: "data-lb-menu", id: "b" }, "focus goes to the menu of the row that took its place");
  /* A pull short of the threshold, released slowly, springs back. */
  const info = v.info("b");
  fire(info, "pointerdown", { clientX: 300, clientY: 20, timeStamp: 0 });
  fire(info, "pointermove", { clientX: 250, clientY: 20, timeStamp: 400 });
  fire(info, "pointermove", { clientX: 250, clientY: 20, timeStamp: 800 });
  assert.strictEqual(info.row.style.transform, "translateX(-50px)");
  fire(info, "pointerup", { clientX: 250, clientY: 20, timeStamp: 900 });
  assert.ok(!info.row.style.transform && !info.row.classList.contains("swiping"), "short of 96 px, slow: it springs back");
  assert.deepStrictEqual(m.queueRaw(), ["b", "c"], "and stays");
});

test("the menu's Remove still removes beside the swipe, with the same after-step (PQ-06, #762)", () => {
  /* MUTATION (run, red): delete the `remove` branch from libMenuAct -> the item does nothing and cp_queue keeps b.
     MUTATION 2 (run, red): delete `info.addEventListener("pointercancel",
     cancel);` -> the cancelled row stays carried and translated.
     (The ✕ is gone with the row's arrow buttons; the menu is the alternative a pointer-only gesture owes keyboard and
     switch users, WCAG 2.5.1.) */
  const m = mount();
  const v = liveView(m);
  m.ctx.renderQueue();
  m.ctx.libMenuAct("b", "remove");
  assert.deepStrictEqual(m.queueRaw(), ["a", "c"], "the menu's Remove removes its row");
  assert.strictEqual(m.said(), "Removed from Up Next.");
  assert.deepStrictEqual(v.focused, { attr: "data-lb-menu", id: "c" }, "focus goes to the menu of the row that took its place");
  /* A swipe the system cancels writes nothing and springs the row back. */
  const info = v.info("a");
  fire(info, "pointerdown", { clientX: 300, clientY: 20, timeStamp: 0 });
  fire(info, "pointermove", { clientX: 180, clientY: 20, timeStamp: 50 });
  assert.ok(info.row.classList.contains("swiping"), "precondition: a carried row");
  fire(info, "pointercancel", {});
  assert.ok(!info.row.classList.contains("swiping") && !info.row.style.transform, "a cancel springs the row back");
  fire(info, "pointerup", { clientX: 180, clientY: 20, timeStamp: 60 });
  assert.deepStrictEqual(m.queueRaw(), ["a", "c"], "a release after the cancel finds no gesture to commit");
});

test("a row lifted by a hold is not swiped: the swipe lets go while the drag owns the finger (PQ-04 and PQ-06 share one cover)", () => {
  /* MUTATION (run, red): delete \`if (info._dragArmed) { reset(); return; }\` from the swipe's pointermove -> a lifted row
     dragged sideways is also carried left and removed on release. */
  const m = mount();
  const v = liveView(m);
  m.ctx.renderQueue();
  const info = v.info("a");
  info._dragArmed = true; // what bindUpNextDrag sets at the lift
  fire(info, "pointerdown", { clientX: 300, clientY: 20, timeStamp: 0 });
  fire(info, "pointermove", { clientX: 180, clientY: 21, timeStamp: 50 });
  assert.ok(!info.row.classList.contains("swiping") && !info.row.style.transform, "the swipe paints nothing under a drag");
  fire(info, "pointerup", { clientX: 180, clientY: 21, timeStamp: 80 });
  assert.deepStrictEqual(m.queueRaw(), ["a", "b", "c"], "and removes nothing");
  assert.strictEqual(m.queueWrites(), 0);
});
