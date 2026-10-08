/* The Up Next page (#/queue), Redesign 2026, ambient ("Afterglow"): the page is Library's Up Next section given the
 * whole screen (docs/redesign-2026/directions/ambient/BUILD-PLAN.md screen 13, BUILD-NOTES 17.3).
 *
 * WHAT THIS PROVES, in order:
 *  1. ONE row, one menu, one Toast: the page draws Library's QueueRow (`libQueueRowHtml`), opens Library's menu items
 *     (Move up, Move down, Play next, Remove), shows Library's Toast with Undo for five seconds, and writes through
 *     the same functions. Nothing on the page is a second copy.
 *  2. The playing row is first, marked by the Fill glyph and the Lamp word "Playing", with no menu and no drag; every
 *     other row has the 44 menu and is lifted by a hold on its cover (no handle glyph: one trailing control); the page
 *     lists every queued row (Library stops at ten), and History continues under it as it does in Library.
 *  3. The page is a live view painted IN PLACE: a write to cp_queue redraws the section (rows, count, Clear), not
 *     #view, and a move slides the neighbours on the motion tokens (280ms, --e-out).
 *  4. The Toast sits 8px above the mini row (the stylesheet's rule, in tokens), on the page's own Toast element.
 *  5. The page's head: Back is the history-aware a.back, the count, Clear only for more than one, the drag hint once.
 *  6. The gestures are on the row's cover: the drag id (a hold lifts the row) on every row that has a menu, the swipe id,
 *     the Remove label the swipe reveals; and the drag keeps the playing row first (its wiring is in
 *     test/up-next-gestures.test.js). Titles and captions are never cut (iteration 2).
 *  7. Empty is one line and one button; hostile data crosses esc(); the stylesheet owns no reduced-motion block and reads
 *     only tokens; the screen is registered in index.html and every shell list.
 *
 * Every test names the one-line mutation that kills it (CLAUDE.md "a green test is not evidence until you have broken
 * it"), and each was run red before it was committed. The harness is the node:vm page of test/up-next-gestures.test.js
 * (a real app.js over a small DOM), with the one extension this file needs: `#view` answers the page's section and its
 * Toast, so the in-place repaint and the Toast can be watched. The queue rules are the REAL player/queue-order.js.
 */

const { test, before } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource().replace(/\r\n/g, "\n");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const QUEUE_CSS = read("ui/queue.css").replace(/\/\*[\s\S]*?\*\//g, " ");
const LIB_CSS = read("ui/library.css").replace(/\/\*[\s\S]*?\*\//g, " ");
const TOKENS_CSS = read("ui/tokens.css");

process.on("unhandledRejection", () => {});

let QUEUE_ORDER = null;
before(async () => { QUEUE_ORDER = await import("../player/queue-order.js"); });

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
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
}

const PAGE_IDS = ["view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle", "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form", "pl-input", "pl-note"];
const SECTION_OPEN = '<section class="lb-section qp-section" data-lb-section="upnext" data-lb-page="queue">';

/** The page, mounted over the real app.js. `ids` is cp_queue; `current` is the episode the bar is on. */
function mount({ ids = ["a", "b", "c", "d"], current = null, hash = "#/queue", extra = {} } = {}) {
  const store = new Map([["cp_queue", JSON.stringify(ids)]]);
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
  const timers = [];
  const view = byId.get("view");
  const toast = makeEl("div");
  const toastLabel = makeEl("span");
  let toastOpen = false;
  toast.classList = { add(c) { if (c === "is-open") toastOpen = true; }, remove(c) { if (c === "is-open") toastOpen = false; }, toggle() {}, contains: (c) => c === "is-open" && toastOpen };
  toast.querySelector = (sel) => (sel === "[data-lb-toast-text]" ? toastLabel : null);
  /* The section is answered with the slice of #view between its tags, so the in-place repaint shows in `view()`. */
  view.querySelector = (sel) => {
    const s = String(sel);
    if (s === "[data-lb-toast]") return toast;
    if (!s.includes('data-lb-section="upnext"') || !view.innerHTML.includes(SECTION_OPEN)) return null;
    const bounds = () => { const a = view.innerHTML.indexOf(SECTION_OPEN) + SECTION_OPEN.length; return [a, view.innerHTML.indexOf("</section>", a)]; };
    return {
      dataset: { lbPage: "queue" }, contains: () => false, querySelector: () => null, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0 }),
      get innerHTML() { const [a, b] = bounds(); return view.innerHTML.slice(a, b); },
      set innerHTML(v) { const [a, b] = bounds(); view.innerHTML = view.innerHTML.slice(0, a) + v + view.innerHTML.slice(b); },
    };
  };
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
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => { const s = String(sel); return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null; },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash, search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, clearInterval,
    setTimeout: (fn, ms) => { timers.push(ms); const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    forayEventLog: { append() {} },
    ...extra,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.forayQueueOrder = QUEUE_ORDER;
  if (current) ctx.ForayPlayer = { currentEpisodeId: () => current, isCurrent: (id) => id === current, isPlaying: (id) => id === current };
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const state = vm.runInContext("state", ctx);
  state.session = { session_id: "s", episodes: {}, cards: [] };
  state.poolIds = new Set();
  const all = [...new Set([...ids, ...(current ? [current] : [])])];
  for (const id of all) state.itemIndex[id] = { id, title: `Episode ${id}`, show: "Show", audio_url: `https://x.test/${id}.mp3`, topics: [], duration_min: 30 };
  return {
    ctx, store, state, body, timers, toast, toastLabel,
    evalIn: (src) => vm.runInContext(src, ctx),
    view: () => view.innerHTML,
    queue: () => JSON.parse(store.get("cp_queue") || "[]"),
    said: () => body.children.map((c) => c.textContent).filter(Boolean).pop() || "",
    toastOpen: () => toastOpen,
  };
}

const sectionHtml = (html) => { const a = html.indexOf(SECTION_OPEN); return html.slice(a, html.indexOf("</section>", a)); };
const rowsOf = (html) => html.split("<article ").slice(1);
const ids = (html) => [...html.matchAll(/<article [^>]*data-lb-q="([^"]*)"/g)].map((x) => x[1]);

/* ==================================================================== */
/* 1. ONE ROW, ONE MENU, ONE TOAST                                      */
/* ==================================================================== */

test("the page draws Library's QueueRow, not a row of its own: the same function, the same anatomy", () => {
  /* MUTATION 1: give renderQueue its own row (e.g. restore a `function upNextRow` and map the rows through it) ->
     the "same function" assertion below is red.
     MUTATION 2: draw the rows without the \`page\` flag's base anatomy (drop \`ag-queue-row lb-qrow\` from libQueueRowHtml) ->
     red. */
  const m = mount();
  m.ctx.renderQueue();
  const html = m.view();
  const page = rowsOf(sectionHtml(html));
  assert.strictEqual(page.length, 4, "a row per queued episode");
  assert.ok(page.every((r) => /^class="raised ag-queue-row lb-row lb-qrow qp-row/.test(r)), "every row is the primitives' QueueRow wearing Library's classes");
  /* The row IS libQueueRowHtml's output: ask it for the same row and compare. */
  const row = m.ctx.libUpNextModel().rows[0];
  const direct = m.ctx.libQueueRowHtml(row, { upnext: true, ctx: "upnext", menu: true, page: true });
  assert.ok(html.includes(direct), "the page's first row is exactly what libQueueRowHtml returns for it");
  assert.doesNotMatch(APP_SRC, /function upNextRow\b/, "the page has no row of its own any more");
  assert.doesNotMatch(APP_SRC, /class="reorder |data-reorder-up|data-dequeue|class="up-next-remove/, "the arrows, Next and the ✕ are gone from every template");
});

test("the row menu is Library's: Move up, Move down, Play next, Remove, in that order, for a row on the page", () => {
  /* MUTATION 1: reorder libMenuItems (Remove first) -> the order assertion is red.
     MUTATION 2: give renderQueue a menu of its own (a different items list) -> the identity assertion is red.
     MUTATION 3: drop the \`at <= 0\` disabled on Move up -> the first row's Move up is enabled and the assertion is red. */
  const m = mount();
  m.ctx.renderQueue();
  const items = m.ctx.libMenuItems("b");
  assert.deepStrictEqual([...items.map((i) => i.label)], ["Move up", "Move down", "Play next", "Remove"]);
  assert.ok(m.ctx.libMenuItems("a").find((i) => i.key === "up").disabled, "the first row cannot move up");
  assert.ok(m.ctx.libMenuItems("d").find((i) => i.key === "down").disabled, "the last row cannot move down");
  assert.match(sectionHtml(m.view()), /<button type="button" class="ag-btn ag-btn-icon lb-dots" data-lb-menu="a" aria-haspopup="dialog" aria-label="More for Episode a">/, "a 44 icon button named for its row opens it");
  assert.match(APP_SRC, /function libOpenMenu\(/);
  assert.strictEqual((APP_SRC.match(/function libOpenMenu\(/g) || []).length, 1, "one menu in the whole app");
});

test("Remove opens Library's Toast for five seconds and Undo puts the list back exactly (the page has the Toast element)", () => {
  /* MUTATION 1: leave the Toast out of renderQueue's markup -> the markup assertion is red.
     MUTATION 2: set LIB_TOAST_MS to 3000 -> the timer assertion is red.
     MUTATION 3: save \`queueIds()\` after the removal as the undo list -> the order assertion is red. */
  const m = mount();
  m.ctx.renderQueue();
  assert.match(m.view(), /<div class="raised ag-toast lb-toast" role="status" aria-live="polite" data-lb-toast>[\s\S]*?data-lb-undo>Undo<\/button>/, "the page carries the Toast with Undo");
  m.timers.length = 0;
  m.ctx.libMenuAct("b", "remove");
  assert.deepStrictEqual(m.queue(), ["a", "c", "d"]);
  assert.strictEqual(m.toastOpen(), true, "the Toast is open");
  assert.strictEqual(m.toastLabel.textContent, "Removed from Up Next");
  assert.ok(m.timers.includes(5000), `closes after five seconds (timers: ${m.timers})`);
  assert.ok(!ids(m.view()).includes("b"), "the section was repainted without b");
  m.ctx.libUndo();
  assert.deepStrictEqual(m.queue(), ["a", "b", "c", "d"], "Undo restores the list exactly");
  assert.deepStrictEqual(ids(m.view()), ["a", "b", "c", "d"], "and the page shows it");
  assert.strictEqual(m.toastOpen(), false, "the Toast is gone");
});

/* ==================================================================== */
/* 2. THE PLAYING ROW, THE HANDLES, EVERY ROW                           */
/* ==================================================================== */

test("the playing row is first, with the Fill glyph and the word Playing, and neither a menu nor a handle", () => {
  /* MUTATION 1: draw the other rows before the playing one in libUpNextInnerHtml -> the order assertion is red.
     MUTATION 2: pass \`current: false\` for the first row -> no Playing word and no aria-current: red.
     MUTATION 3: let the playing row drag (drop \`o.menu\` from the \`drags\` guard in libQueueRowHtml) -> the drag assertion is red. */
  const m = mount({ ids: ["a", "b", "c"], current: "c" });
  m.ctx.renderQueue();
  const html = sectionHtml(m.view());
  assert.deepStrictEqual(ids(html), ["c", "a", "b"], "the row the bar is on is first, once, whatever its place in cp_queue");
  const [first, second] = rowsOf(html);
  assert.match(first, /lb-qrow qp-row is-current/);
  assert.match(first, /aria-current="true"/);
  assert.match(first, /<use href="[^"]*#i-play-fill">/, "the Fill glyph");
  assert.match(first, /<span class="ag-row-state">Playing<\/span>/, "the Lamp word");
  assert.ok(!/data-lb-menu=|data-drag-handle=/.test(first), "it leaves the list when it ends: no menu, no drag");
  assert.ok(/data-lb-menu="a"/.test(second) && /data-drag-handle="a"/.test(second), "every other row has both");
});

test("the page lists EVERY queued row; Library stops at ten with a link here", () => {
  /* MUTATION 1: apply LIB_UPNEXT_MAX to the page too (drop the \`page ?\` in libUpNextInnerHtml) -> ten rows, red.
     MUTATION 2: drop the \`!page &&\` from the link guard -> the page links to itself and the second assertion is red. */
  const many = Array.from({ length: 13 }, (_, i) => `e${i}`);
  const m = mount({ ids: many });
  m.ctx.renderQueue();
  assert.strictEqual(ids(m.view()).length, 13, "all thirteen");
  assert.ok(!/All \d+ in Up Next/.test(m.view()), "no link to itself");
  m.ctx.location.hash = "#/library";
  m.ctx.renderLibrary();
  assert.strictEqual(ids(m.view()).length, 10, "Library's section keeps its cap");
  assert.match(m.view(), /All 13 in Up Next/);
});

test("a finished queued row says Played, in Up Next only (History keeps its length)", () => {
  /* MUTATION 1: drop \`|| o.upnext\` from libQueueRowHtml's caption -> the played row shows its length: red.
     MUTATION 2: pass \`upnext: true\` to History's rows too -> every History row says Played: the second assertion is red. */
  const m = mount({ ids: ["a", "b"], extra: { ForayPlayer: { episodeProgress: (id) => (id === "a" ? { state: "played", percent: 100, label: "Played" } : { state: "in-progress", percent: 50, label: "20 min left" }) } } });
  m.ctx.renderQueue();
  const rows = rowsOf(m.view());
  assert.match(rows[0], /class="lb-ell">[^<]*Played</, "a: Played");
  assert.match(rows[1], /class="lb-ell">[^<]*20 min left</, "b: how far");
  const hist = m.ctx.libQueueRowHtml({ id: "a", state: "live", item: m.state.itemIndex.a }, { ctx: "library-history", date: true });
  assert.ok(!/Played</.test(hist), "a History row (every one played) keeps its length");
});

/* ==================================================================== */
/* 3. A LIVE VIEW, PAINTED IN PLACE; THE NEIGHBOURS SLIDE               */
/* ==================================================================== */

test("a write to cp_queue repaints the section in place: rows, count and Clear follow, and only on this page", () => {
  /* MUTATION 1: drop \`|| h === "#/queue"\` from repaintQueuePage -> the page does not follow the write: red.
     MUTATION 2: have repaintLibraryUpNext ignore \`data-lb-page\` (always draw the Library section) -> the head and the
     handles vanish on the first write: the head assertion is red.
     (The last assertion is a guard that cannot fail with the hash check dropped: the repaint is of the page's SECTION,
     and Home has none, so a write on Home finds nothing to paint. It is kept because the old renderQueue repaint DID
     paint #view, and a regression to it would fail here.) */
  const m = mount();
  m.ctx.renderQueue();
  assert.match(sectionHtml(m.view()), /4 queued/);
  m.ctx.removeFromQueue("a");
  assert.deepStrictEqual(ids(m.view()), ["b", "c", "d"], "the removed row is gone at once");
  assert.match(sectionHtml(m.view()), /3 queued/, "the count follows");
  assert.match(sectionHtml(m.view()), /<header class="lb-head qp-head">/, "and the page's head survives the repaint");
  assert.match(sectionHtml(m.view()), /data-drag-handle="b"/, "so does the drag id on each cover");
  m.ctx.clearQueue();
  assert.match(sectionHtml(m.view()), /Nothing queued\./);
  assert.ok(!/id="up-next-clear"/.test(m.view()), "Clear goes with the second-to-last row");
  m.ctx.location.hash = "#/";
  m.evalIn('$("#view").innerHTML = "<p>Home</p>"');
  m.ctx.addToQueue("a");
  assert.strictEqual(m.view(), "<p>Home</p>", "a write off the page paints nothing into #view");
});

test("a move slides the neighbours: the rows' tops are read BEFORE the write, then the section is slid", () => {
  /* MUTATION 1: drop the `libSlideRows(...)` call from libMenuAct -> no "slide" in the log: red.
     MUTATION 2: take the rows' tops AFTER the write instead of before (move `const before = ...` below the branch) ->
     the log reads save, tops, slide: red. */
  const m = mount();
  m.ctx.renderQueue();
  const log = [];
  const tops = m.ctx.libRowTops;
  const save = m.ctx.saveQueueIds;
  m.ctx.libRowTops = (section) => { log.push("tops"); return tops(section); };
  m.ctx.saveQueueIds = (next) => { log.push("save"); return save(next); };
  let slid = null;
  m.ctx.libSlideRows = (section) => { log.push("slide"); slid = section; };
  m.ctx.libMenuAct("b", "down");
  assert.deepStrictEqual(m.queue(), ["a", "c", "b", "d"], "Move down swaps with the row below");
  assert.deepStrictEqual([...log], ["tops", "save", "slide"], "tops before the write, the slide after the repaint");
  assert.strictEqual(slid.dataset.lbPage, "queue", "the section it slides is the page's");
});

test("the slide is 280ms on --e-out: the row's transform transition and the tokens it reads", () => {
  /* MUTATION 1: change .qp-row's transition duration token to --m-micro -> the duration assertion is red.
     MUTATION 2: change the easing to \`ease-out\` -> red. MUTATION 3: set --m-ui to 200ms in tokens.css -> red. */
  const row = /\.ag \.qp-row\s*\{([^}]*)\}/.exec(QUEUE_CSS);
  assert.ok(row, "the row's rule");
  assert.match(row[1], /transition:\s*transform var\(--m-ui\) var\(--e-out\)/, "transform only, on the motion tokens");
  assert.match(TOKENS_CSS, /--m-ui:\s*280ms/, "--m-ui is 280ms");
  assert.match(TOKENS_CSS, /--e-out:\s*cubic-bezier\(0\.2,\s*0\.8,\s*0\.2,\s*1\)/, "--e-out is the out curve");
  assert.match(read("ui/library.js"), /row\.style\.transition = "transform var\(--m-ui\) var\(--e-out\)"/, "and the script's slide is the same pair");
  assert.match(QUEUE_CSS, /\.ag \.qp-row\.swiping\s*\{\s*transition:\s*none/, "a row carried by a finger has no easing");
});

/* ==================================================================== */
/* 4. THE TOAST SITS 8px ABOVE THE MINI ROW                             */
/* ==================================================================== */

test("the Toast is 48 tall and 8px above the mini row: the Dock's own height + --s-2, on the page's Toast element", () => {
  /* The Toast rides the DOCK's geometry (ui/dock.css), not a copy of the tab bar's: `--dock-h` is the field row, the
     mini row and the tab row, and body.ui-v2.fp-open turns the mini row's 64 on.
     MUTATION 1: change `+ var(--s-2)` to `+ var(--s-1)` in the .lb-toast rule -> 4px, red.
     MUTATION 2: drop `var(--dock-h)` from that rule -> the Toast sits behind the Dock: red.
     MUTATION 3: set --s-2 to 12px in tokens.css -> red. MUTATION 4: min-height 48px -> 40px: red.
     MUTATION 5: delete `body.ui-v2.fp-open { --dock-mini-h: var(--mini); }` from dock.css -> the mini row stops counting: red.
     (The measured number, in a real browser: tools/ui-lab `up-next-toast` step, read in the PR.) */
  const base = /\.ag \.lb-toast\s*\{([^}]*)\}/.exec(LIB_CSS);
  assert.ok(base, "the Toast rule");
  assert.match(base[1], /bottom:\s*calc\(var\(--safe-bottom\) \+ var\(--dock-inset\) \+ var\(--dock-h\) \+ var\(--s-2\)\)/, "Dock top edge + 8");
  assert.ok(!/body\.fp-open \.ag \.lb-toast/.test(LIB_CSS), "no second rule lifting it: the Dock's height already carries the mini row");
  assert.match(read("ui/dock.css"), /body\.ui-v2\.fp-open \{ --dock-mini-h: var\(--mini\); \}/, "and the mini row counts in --dock-h while something is loaded");
  assert.match(TOKENS_CSS, /--s-1:\s*4px;\s*--s-2:\s*8px;/, "--s-2 is 8px");
  assert.match(TOKENS_CSS, /--mini:\s*64px/, "the mini row is 64");
  assert.match(base[1], /min-height:\s*48px/, "48 tall");
  /* The page's Toast is that element, and the page wears the classes the rule is scoped to. */
  const m = mount();
  m.ctx.renderQueue();
  assert.match(m.view(), /<div class="ag lb-page qp-page is-settling">[\s\S]*class="raised ag-toast lb-toast"/, "the Toast is inside .ag");
  assert.match(read("ui/queue.js"), /setBodyClass\("view-library"\)/, "the page wears the shell class Library's stylesheet is scoped to");
});

test("the Toast rises in by animation, not by transition, so Reduce Motion collapses it to no motion at all", () => {
  /* The motion gate (tools/ui-lab/gates.mjs, reduced-motion) read the Toast's 200ms opacity transition under Reduce
     Motion as a violation: the one block can only soften a transition to a 200ms crossfade, but it collapses an
     animation to 1ms. MUTATION 1: put \`transition: opacity var(--m-ui) var(--e-out)\` back on .lb-toast -> red.
     MUTATION 2: drop the \`animation\` from .is-open -> the Toast appears with no arrival: red.
     MUTATION 3: delete the @keyframes -> the name points at nothing: red. */
  const toast = /\.ag \.lb-toast\s*\{([^}]*)\}/.exec(LIB_CSS)[1];
  assert.ok(!/transition/.test(toast), "the closed Toast carries no transition");
  const open = /\.ag \.lb-toast\.is-open\s*\{([^}]*)\}/.exec(LIB_CSS)[1];
  assert.ok(!/transition/.test(open), "nor does the open one");
  assert.match(open, /animation:\s*lb-toast-in var\(--m-ui\) var\(--e-out\)/, "it arrives on the motion tokens");
  assert.match(LIB_CSS, /@keyframes lb-toast-in\s*\{\s*from\s*\{[^}]*opacity:\s*0[^}]*\}\s*to\s*\{[^}]*opacity:\s*1[^}]*\}\s*\}/, "from nothing to the resting place");
  assert.ok(!/prefers-reduced-motion/.test(LIB_CSS), "and the block that collapses it is still tokens.css's alone");
  assert.match(TOKENS_CSS, /animation-duration:\s*1ms !important/, "which makes an animation 1ms, under Reduce Motion");
});

/* ==================================================================== */
/* 5. THE PAGE'S HEAD                                                   */
/* ==================================================================== */

test("the head: a history-aware Back, the count, Clear only for more than one, and the drag hint exactly once", () => {
  /* MUTATION 1: drop \`back\` from the link's class -> the route no longer steps back: red.
     MUTATION 2: render Clear for any count -> the one-row page shows it: red.
     MUTATION 3: render the hint per row (move it into libQueueRowHtml) -> the \"once\" assertion is red. */
  const m = mount();
  m.ctx.renderQueue();
  const html = m.view();
  assert.match(html, /<a class="back qp-back ag-btn ag-btn-icon" href="#\/library" aria-label="Back">/, "Back is the a.back app.js steps back on, with a href for a cold open");
  assert.match(html, /<h2 class="t-title" tabindex="-1">Up Next<\/h2>/);
  assert.match(html, /<span class="t-caption qp-count">4 queued<\/span>/);
  assert.ok(html.includes('id="up-next-clear"'), "four rows: Clear is offered");
  assert.strictEqual((html.match(/id="up-next-drag-hint"/g) || []).length, 1, "every handle points at one hint");
  const one = mount({ ids: ["a"] });
  one.ctx.renderQueue();
  assert.ok(!one.view().includes('id="up-next-clear"'), "one row: no Clear");
  assert.match(one.view(), /1 queued/);
});

test("the landing heading is the page's h2, found through .lb-head", () => {
  /* MUTATION: drop \`.lb-head\` from pageHeading's selectors -> the page names no heading and focus lands nowhere: red. */
  assert.match(read("app.js"), /querySelector\("\.page-head"\) \|\| view\.querySelector\("\.lb-head"\)/);
  assert.match(read("ui/queue.js"), /<header class="lb-head qp-head">[\s\S]*?<h2 class="t-title" tabindex="-1">Up Next<\/h2>/);
});

/* ==================================================================== */
/* 6. THE GESTURES ARE ON THE ROW                                       */
/* ==================================================================== */

test("every row with a menu carries the drag id and the swipe's id and label on its COVER, with no handle button; the cover names the Up Next list", () => {
  /* MUTATION 1: drop \`data-swipe-id\` from the cover -> the swipe has nothing to bind: red.
     MUTATION 2: drop the qp-under label -> the swipe reveals nothing: red.
     MUTATION 3: render the drag id on Library's section too (ignore \`o.page\`) -> the Library assertion is red.
     MUTATION 4 (iteration 2): restore a \`<button class="qp-handle" data-drag-handle>\` beside the menu in libQueueRowHtml
     -> the "two buttons a row" and "no handle" assertions are red (the direction gives the row one trailing control). */
  const m = mount({ ids: ["a", "b"] });
  m.ctx.renderQueue();
  const html = sectionHtml(m.view());
  assert.deepStrictEqual([...html.matchAll(/data-drag-handle="([^"]+)"/g)].map((x) => x[1]), ["a", "b"]);
  assert.deepStrictEqual([...html.matchAll(/class="lb-cover" data-lb-play="([^"]+)" data-swipe-id="([^"]+)" data-drag-handle="([^"]+)" aria-describedby="up-next-drag-hint" data-ctx="upnext"/g)].map((x) => [x[1], x[2], x[3]]), [["a", "a", "a"], ["b", "b", "b"]], "the drag id rides the cover, with the hint that says how");
  assert.ok(!/qp-handle/.test(html), "no handle glyph button");
  assert.ok(rowsOf(html).every((r) => (r.match(/<button\b/g) || []).length === 2), "a row has two buttons: the cover (a tap plays) and the menu");
  assert.strictEqual((html.match(/<span class="qp-under" aria-hidden="true">Remove<\/span>/g) || []).length, 2, "the label the swipe reveals, hidden from assistive tech");
  m.ctx.location.hash = "#/library";
  m.ctx.renderLibrary();
  const lib = sectionHtml(m.view().replace('<section class="lb-section" data-lb-section="upnext">', SECTION_OPEN));
  assert.ok(!/data-drag-handle=|data-swipe-id=|qp-under/.test(lib), "Library's section has neither the drag nor the swipe");
});

test("a tap on a row plays it with the Up Next context (the played row moves to the top)", async () => {
  /* MUTATION: have libPlayPress pass ctx "library-saved" regardless -> the call assertion is red. */
  const m = mount();
  m.ctx.renderQueue();
  const calls = [];
  m.ctx.startEpisodePlay = async (id, item, opts) => { calls.push({ id, ctx: opts.ctx }); return true; };
  m.evalIn("window.ForayPlayer = { isCurrent: () => false, currentEpisodeId: () => null, isPlaying: () => false }");
  await m.ctx.libPlayPress({ dataset: { lbPlay: "c", ctx: "upnext" } });
  assert.deepStrictEqual(calls, [{ id: "c", ctx: "upnext" }]);
});

test("the click that ends a claimed swipe does not play the row", async () => {
  /* MUTATION: delete the \`_lbSwallow\` check from the cover's click listener in bindLibrary -> the click plays: red. */
  const m = mount();
  const calls = [];
  m.ctx.startEpisodePlay = async (id) => { calls.push(id); return true; };
  m.evalIn("window.ForayPlayer = { isCurrent: () => false }");
  let click = null;
  const cover = { dataset: { lbPlay: "b", ctx: "upnext" }, addEventListener: (t, fn) => { if (t === "click") click = fn; } };
  m.ctx.bindLibrary({ querySelectorAll: (sel) => (sel === "[data-lb-play]" ? [cover] : []) });
  cover._lbSwallow = true;
  click({ preventDefault() {}, stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(calls, [], "swallowed once");
  assert.strictEqual(cover._lbSwallow, false, "and only once");
  click({ preventDefault() {}, stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(calls, ["b"], "the next tap plays");
});

/* ==================================================================== */
/* 7. EMPTY, HOSTILE DATA, THE STYLESHEET, REGISTRATION                 */
/* ==================================================================== */

test("empty is one line and one button, with the page's own head and no Clear, no hint, no drag", () => {
  /* MUTATION: render the rows' wrapper even with nothing queued -> the \`lb-stack\` assertion is red. */
  const m = mount({ ids: [] });
  m.ctx.renderQueue();
  const html = sectionHtml(m.view());
  assert.match(html, /<p class="t-body">Nothing queued\.<\/p><a class="ag-btn ag-btn-secondary" href="#\/">See today&#39;s picks<\/a>/);
  assert.ok(!/lb-stack|up-next-clear|up-next-drag-hint|data-drag-handle|qp-count/.test(html));
  assert.match(html, /<h2 class="t-title" tabindex="-1">Up Next<\/h2>/, "the head is still there, with its Back");
});

test("hostile titles cross esc() on the page", () => {
  /* MUTATION: interpolate the title raw in libQueueRowHtml (drop esc around \`title\`) -> the raw tag appears: red. */
  const m = mount({ ids: ["a"] });
  m.state.itemIndex.a.title = '<img src=x onerror=alert(1)>"';
  m.state.itemIndex.a.show = "<b>Show</b>";
  m.ctx.renderQueue();
  const html = m.view();
  assert.ok(!html.includes("<img src=x") && !html.includes("<b>Show</b>"), "no raw markup from episode data");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;&quot;"), "the title is escaped");
});

test("queue.css owns no reduced-motion block and reads only tokens: no colour literal, no raw duration or easing", () => {
  /* MUTATION 1: append \`@media (prefers-reduced-motion: reduce) { .ag .qp-row { transition: none } }\` -> red.
     MUTATION 2: write \`background: #222\` into .qp-under -> red. MUTATION 3: write \`transition: transform 280ms ease\` -> red. */
  assert.ok(!/prefers-reduced-motion/.test(QUEUE_CSS), "the one block is tokens.css's");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|oklch\(/.test(QUEUE_CSS), "no colour literal");
  assert.ok(!/\b\d+m?s\b|cubic-bezier|\bease\b/.test(QUEUE_CSS), "no raw duration or easing");
  /* every rule is under .ag or a body.view-* shell */
  const selectors = QUEUE_CSS.split("}").map((r) => r.split("{")[0].trim()).filter(Boolean).flatMap((s) => s.split(","));
  assert.ok(selectors.every((s) => s.trim().startsWith(".ag ")), `every selector is scoped under .ag: ${selectors.filter((s) => !s.trim().startsWith(".ag ")).join(" | ")}`);
});

test("the row is Library's three columns and the cover is the gesture surface: no handle column, the vertical scroll kept, no callout", () => {
  /* MUTATION 1: restore \`.ag .qp-handle\` or a four-column \`grid-template-columns\` on .qp-row in queue.css -> the first two
     assertions are red (the handle column is what crowded the text and cut the titles). MUTATION 2: drop \`touch-action:
     pan-y\` from the cover -> the swipe takes the scroll: red. MUTATION 3: drop \`-webkit-touch-callout: none\` -> a held
     press raises the system callout on iOS: red. */
  assert.doesNotMatch(QUEUE_CSS, /qp-handle/, "no handle styles");
  assert.doesNotMatch(QUEUE_CSS, /grid-template-columns/, "the row keeps Library's art, copy, menu");
  const cover = /\.ag \.qp-row \.lb-cover\s*\{([^}]*)\}/.exec(QUEUE_CSS);
  assert.ok(cover, "the cover rule exists");
  assert.match(cover[1], /touch-action:\s*pan-y/);
  assert.match(cover[1], /-webkit-touch-callout:\s*none/);
  assert.match(cover[1], /user-select:\s*none/);
});

test("Clear is a quiet grey word, never Ember (iteration 2): the header carries no listener-mark colour", () => {
  /* Ember is the listener's own marks (saved, followed, progress); `.ag-btn-quiet` paints Ember by default, so the page's
     Clear overrides it. This test is a deliberate guard, not a tripwire on today's markup.
     MUTATION 1: delete `color: var(--text-2)` from the `.qp-clear` rule in queue.css -> the colour assertion is red.
     MUTATION 2: change it to `var(--ember)` -> the no-Ember assertion is red. */
  const rule = /\.ag \.qp-head \.qp-clear\s*\{([^}]*)\}/.exec(QUEUE_CSS);
  assert.ok(rule, "the Clear rule exists, scoped under the head");
  assert.match(rule[1], /color:\s*var\(--text-2\)/);
  assert.doesNotMatch(rule[1], /ember/);
  assert.ok(/\.ag \.ag-btn-quiet\s*\{[^}]*color:\s*var\(--ember\)/.test(read("ui/primitives.css").replace(/\/\*[\s\S]*?\*\//g, " ")), "premise: the quiet button IS Ember by default, so the override is what keeps Clear grey");
});

test("titles and captions are never cut: the title is not clamped and the caption runs as wrapping text (iteration 2)", () => {
  /* The first judge pass saw 'Head, School of Nuclear...' and '56 ...': a two-line clamp on the title and a nowrap ellipsis
     on the caption hid the very length a listener reads a queue for. DIRECTION: titles never cut; the prototype wraps a
     long title whole and keeps the caption intact.
     MUTATION 1: put \`clamp2\` back on the title <p> in libQueueRowHtml -> the markup assertion is red.
     MUTATION 2: restore \`white-space: nowrap\` or \`text-overflow: ellipsis\` on \`.lb-qrow .lb-ell\` -> the CSS assertions are red.
     MUTATION 3: put \`flex-wrap: nowrap\` and \`display: flex\` back on \`.lb-qrow .ag-row-meta\` -> the display assertion is red. */
  const long = "A very long episode title that runs past two lines of a narrow phone column and then a little more besides";
  const m = mount({ ids: ["a"] });
  m.state.itemIndex.a.title = long;
  m.state.itemIndex.a.show = "A show with a rather long name, Catalyst with Shayle Kann";
  m.ctx.renderQueue();
  const row = rowsOf(sectionHtml(m.view()))[0];
  assert.ok(row.includes(`<p class="t-label">${long}</p>`), "the whole title, in an unclamped label");
  assert.ok(!/clamp[1-4]/.test(row), "no line clamp anywhere in the row");
  assert.ok(row.includes("A show with a rather long name, Catalyst with Shayle Kann"), "the whole caption is in the markup");
  const ell = /\.ag \.lb-qrow \.ag-row-meta \.lb-ell\s*\{([^}]*)\}/.exec(LIB_CSS);
  assert.ok(ell, "the queue row's caption rule exists");
  assert.match(ell[1], /white-space:\s*normal/);
  assert.match(ell[1], /overflow:\s*visible/);
  assert.doesNotMatch(ell[1], /text-overflow:\s*ellipsis|nowrap/);
  const meta = /\.ag \.lb-qrow \.ag-row-meta\s*\{([^}]*)\}/.exec(LIB_CSS);
  assert.ok(meta && /display:\s*block/.test(meta[1]), "the caption is a block of inline text, not a nowrap flex row");
});

test("History continues under the queue on the page, as it does in Library", () => {
  /* MUTATION: drop \`\${libHistorySectionHtml()}\` from renderQueue -> the order assertion is red (the page ended at the
     queue and left the prototype's Library surface behind). */
  const m = mount({ ids: ["a", "b"] });
  m.store.set("cp_history", JSON.stringify(["h1"]));
  m.state.itemIndex.h1 = { id: "h1", title: "Played before", show: "Old show", audio_url: "https://x.test/h1.mp3", topics: [], duration_min: 20 };
  m.ctx.renderQueue();
  const html = m.view();
  const up = html.indexOf('data-lb-section="upnext"');
  const hist = html.indexOf('data-lb-section="history"');
  const toast = html.indexOf("data-lb-toast");
  assert.ok(up >= 0 && hist > up && toast > hist, "Up Next, then History, then the Toast");
  assert.match(html.slice(hist), /Played before/, "the played episode is a row there");
  assert.deepStrictEqual(ids(sectionHtml(html)), ["a", "b"], "History's rows are not Up Next's: the queue section holds only the queue");
  /* Nothing played yet: History says so in one line. */
  const none = mount({ ids: ["a"] });
  none.ctx.renderQueue();
  assert.match(none.view(), /data-lb-section="history"[\s\S]*Nothing played yet\./);
});

test("the screen is registered: linked once in index.html, in every shell list, and its script is a classic script after library.js", () => {
  /* MUTATION 1: delete the <link> from index.html -> red. MUTATION 2: delete "ui/queue.css" from tools/web/prepare-dist.mjs
     -> its list assertion is red. MUTATION 3: move queue.js before library.js in index.html -> red (it calls library.js's
     helpers at run time, but the shared \`const libUi\` must exist by the first call). */
  const html = read("index.html");
  assert.strictEqual((html.match(/<link rel="stylesheet" href="ui\/queue\.css">/g) || []).length, 1);
  assert.ok(html.indexOf('href="ui/queue.css"') > html.indexOf('href="ui/library.css"'), "after the stylesheet whose shell it wears");
  for (const rel of ["tools/ci/generate-manifest.mjs", "tools/web/prepare-dist.mjs", "tools/mobile/prepare-webdir.mjs"]) {
    assert.ok(read(rel).includes('"ui/queue.css"'), `${rel} ships queue.css`);
  }
  const scripts = [...html.matchAll(/<script src="(ui\/[a-z-]+\.js)"/g)].map((x) => x[1]);
  assert.ok(scripts.indexOf("ui/queue.js") > scripts.indexOf("ui/library.js") || scripts.indexOf("ui/library.js") < 0, "queue.js loads after library.js");
});
