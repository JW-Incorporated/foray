/* "Up Next" listening queue, Stage 1 (docs/listening-queue-plan.md,
 * kanban card t_f4da81f5).
 *
 * WHAT THIS PROVES, in order:
 *  1. `cp_queue` is a real, separate localStorage key — not a rename or a
 *     reuse of `cp_playlists`.
 *  2. The "+ Up Next" control (`upNextBtn`) renders on every entry point the
 *     card names: `epRow`, `archivedRow`, `renderEpisode`, and `renderShow`
 *     (which composes episodes via `epRow`) — and never says bare "queue" in
 *     its own markup (plan §3's naming rule).
 *  3. Adding an episode is idempotent (`addToQueue` twice does not duplicate).
 *  4. `#/queue` (`renderQueue`) lists every queued episode, in order, each
 *     playable/starrable exactly like an ordinary `ep-row`.
 *  5. `#/queue` renders an honest empty state when nothing is queued — not a
 *     blank or broken page.
 *  6. Removing an item (`removeFromQueue`) works and persists to `cp_queue`.
 *  7. Reordering (`moveQueueItem`) swaps neighbours and refuses to walk off
 *     either end.
 *  8. `route()` dispatches `#/queue` to `renderQueue`, the same pattern
 *     `#/playlists` already uses.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test is
 * not evidence until you have broken it".
 *
 * Harness: the same node:vm DOM stub as test/show-page.test.js /
 * test/playlist-durability.test.js, duplicated rather than imported for the
 * same reason those two do — this suite's fixtures (queue seeding, a real
 * `querySelectorAll` for click-driven binding tests) are its own.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note",
];

function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => {
      if (!boot) return new Promise(() => {});
      const file = path.join(ROOT, String(url));
      const ok = String(url).startsWith("data/") && fs.existsSync(file);
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
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
    queueRaw: () => JSON.parse(store.get("cp_queue") || "null"),
  };
}

async function mountBooted(seed) {
  const m = mount({ seed, boot: true });
  for (let i = 0; i < 200 && !m.state.ready; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.ok(m.state.ready, "init() never finished against the committed data files");
  return m;
}

/* ==================================================================== */
/* 1. cp_queue IS ITS OWN KEY, SEPARATE FROM cp_playlists                */
/* ==================================================================== */

test("cp_queue is a new, separate key — adding to it never touches cp_playlists", async () => {
  /* MUTATION: change addToQueue to write into "cp_playlists" instead of
     "cp_queue" (or to call savePlaylists). The cp_playlists-untouched
     assertion fails, and the cp_queue assertion fails too since nothing
     was ever written there. */
  const m = await mountBooted({ cp_playlists: "[]" });
  m.ctx.addToQueue("ep-1");
  assert.deepStrictEqual(m.queueRaw(), ["ep-1"], "cp_queue must hold the added id");
  assert.strictEqual(m.store.get("cp_playlists"), "[]", "cp_playlists must be untouched");
});

/* ==================================================================== */
/* 2. THE "+ UP NEXT" CONTROL RENDERS ON EVERY ENTRY POINT, NAMED RIGHT  */
/* ==================================================================== */

test("epRow renders the '+ Up Next' control, never bare 'queue' or 'Queue'", async () => {
  /* MUTATION: drop `${upNextBtn(item.id)}` from epRow's template. The
     data-upnext assertion fails. MUTATION 2: change upNextBtn's label to
     "+ Queue". The naming assertion fails — plan §3's collision the whole
     card exists to avoid. */
  const m = await mountBooted();
  const discover = readJson("data/discover.json");
  const item = discover.items.find((it) => it.id);
  assert.ok(item, "fixture assumption: discover.json has at least one item");
  m.state.itemIndex[item.id] = item;
  m.state.poolIds = new Set([item.id]);

  const html = m.ctx.epRow(item, 0, "test-ctx", -1);
  assert.ok(html.includes(`data-upnext="${m.ctx.esc(item.id)}"`), "epRow must render the Up Next control");
  assert.ok(html.includes("+ Up Next"), "the control's label must say Up Next");
  assert.ok(!/\bqueue\b/i.test(html), "epRow's markup must never say bare 'queue'");
});

test("archivedRow renders the '+ Up Next' control only for a named part", () => {
  /* Mirrors starBtn's own named/unnamed split in archivedRow — an unnamed
     part has no snapshot to queue against.
     MUTATION: drop the `named ? upNextBtn(item.id) : ""` ternary and always
     call upNextBtn(item.id). The unnamed-part assertion fails because an
     id-less/unnamed row would render a control with an empty data-upnext. */
  const m = mount();
  const namedItem = { id: "arch-1", title: "An archived episode", show: "Some Show" };
  const namedHtml = m.ctx.archivedRow(namedItem, 0, "test-ctx");
  assert.ok(namedHtml.includes('data-upnext="arch-1"'), "a named archived part gets the Up Next control");

  const unnamedItem = {};
  const unnamedHtml = m.ctx.archivedRow(unnamedItem, 1, "test-ctx");
  assert.ok(!unnamedHtml.includes("data-upnext"), "an unnamed archived part gets no Up Next control");
});

test("renderEpisode renders the '+ Up Next' control beside play/star", async () => {
  /* MUTATION: drop upNextBtn from renderEpisode's ep-actions div. The
     data-upnext assertion fails while play/star continue to render fine —
     proving this pins the NEW control specifically, not the row shape. */
  const m = await mountBooted();
  const discover = readJson("data/discover.json");
  const item = discover.items[0];
  m.ctx.renderEpisode(item.id);
  const html = m.view();
  assert.ok(html.includes(`data-upnext="${m.ctx.esc(item.id)}"`), "renderEpisode must render the Up Next control");
});

test("renderShow's episode rows (via epRow) each carry the '+ Up Next' control", async () => {
  /* Confirms Stage 1's card-body scope (add-control on show pages too, since
     #366 is merged) actually reaches renderShow — not just epRow in
     isolation.
     MUTATION: call a stripped-down row renderer in renderShow instead of the
     shared epRow. Every data-upnext assertion below fails. */
  const m = await mountBooted();
  const catalog = readJson("data/catalog-client.json");
  const show = catalog.shows.find((s) => s.show_id === "lex-fridman-podcast");
  assert.ok(show, "fixture assumption: lex-fridman-podcast must be in catalog-client.json");

  m.ctx.renderShow("lex-fridman-podcast");
  const html = m.view();
  const discover = readJson("data/discover.json");
  const expected = discover.items.filter((it) => it.show === "Lex Fridman Podcast");
  for (const ep of expected.slice(0, 3)) {
    assert.ok(html.includes(`data-upnext="${m.ctx.esc(ep.id)}"`), `show page must offer Up Next for "${ep.title}"`);
  }
});

/* ==================================================================== */
/* 3. ADDING IS IDEMPOTENT                                               */
/* ==================================================================== */

test("addToQueue does not duplicate an episode already queued", async () => {
  /* MUTATION: remove the `if (ids.includes(id)) return;` guard from
     addToQueue. A second add duplicates the id and this assertion fails. */
  const m = await mountBooted();
  m.ctx.addToQueue("ep-dup");
  m.ctx.addToQueue("ep-dup");
  assert.deepStrictEqual(m.queueRaw(), ["ep-dup"], "adding the same episode twice must not duplicate it");
});

/* ==================================================================== */
/* 4. #/queue LISTS EVERY QUEUED EPISODE, IN ORDER, PLAYABLE             */
/* ==================================================================== */

test("#/queue lists every queued episode in saved order, each playable and starrable", async () => {
  /* MUTATION: sort queueRows() by anything other than insertion order (e.g.
     alphabetically by title). The order assertion fails.
     MUTATION 2: drop playBtn(item) from upNextRow for a live row. The
     data-play assertion fails. */
  const m = await mountBooted();
  const discover = readJson("data/discover.json");
  const playable = discover.items.filter((it) => it.audio_url);
  assert.ok(playable.length >= 2, "fixture assumption: need at least two playable episodes");
  const [a, b] = playable;

  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  m.ctx.renderQueue();
  const html = m.view();

  const posA = html.indexOf(m.ctx.esc(a.title));
  const posB = html.indexOf(m.ctx.esc(b.title));
  assert.ok(posA >= 0 && posB >= 0, "both queued episode titles must render");
  assert.ok(posA < posB, "episodes must render in the order they were added");
  assert.ok(html.includes(`data-play="${m.ctx.esc(a.id)}"`), "a live queued episode must be playable in-app");
  assert.ok(html.includes(`data-star="${m.ctx.esc(a.id)}"`), "a live queued episode must be starrable");
});

/* ==================================================================== */
/* 5. #/queue's EMPTY STATE IS HONEST                                    */
/* ==================================================================== */

test("#/queue with nothing queued renders an honest empty state, not a blank page", () => {
  /* MUTATION: remove the `rows.length ? ... : <empty state>` ternary and
     always render the row-list branch. With zero rows that renders an empty
     string inside the page shell, so this assertion (which requires visible
     copy) fails rather than passing on an accidentally-empty page. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };

  assert.doesNotThrow(() => m.ctx.renderQueue());
  const html = m.view();
  assert.ok(html.includes("Nothing in Up Next yet"), `expected an honest empty state, got: ${html}`);
  assert.ok(!/class="ep-row/.test(html), "an empty queue must render zero rows");
});

/* ==================================================================== */
/* 6. REMOVING WORKS AND PERSISTS                                       */
/* ==================================================================== */

test("removeFromQueue removes exactly the requested episode and persists", async () => {
  /* MUTATION: change the filter in removeFromQueue from `x !== id` to
     `x === id` (or drop the call to saveQueueIds). Either the wrong item
     survives or nothing is ever written back, and this assertion fails. */
  const m = await mountBooted();
  m.ctx.addToQueue("ep-1");
  m.ctx.addToQueue("ep-2");
  m.ctx.addToQueue("ep-3");
  m.ctx.removeFromQueue("ep-2");
  assert.deepStrictEqual(m.queueRaw(), ["ep-1", "ep-3"], "removeFromQueue must drop only the requested id and persist");
  assert.strictEqual(m.ctx.isQueued("ep-2"), false, "the removed episode must no longer read as queued");
});

test("removing the last item leaves #/queue on its honest empty state, not a broken page", async () => {
  /* MUTATION: same as the empty-state mutation above, exercised via the
     remove path instead of a fresh boot — the plan's own acceptance
     criterion ("removing the last item shows the empty state"). */
  const m = await mountBooted();
  m.ctx.addToQueue("ep-only");
  m.ctx.removeFromQueue("ep-only");
  assert.doesNotThrow(() => m.ctx.renderQueue());
  const html = m.view();
  assert.ok(html.includes("Nothing in Up Next yet"), `expected the empty state after removing the last item, got: ${html}`);
});

/* ==================================================================== */
/* 7. REORDERING SWAPS NEIGHBOURS AND REFUSES TO WALK OFF EITHER END     */
/* ==================================================================== */

test("moveQueueItem swaps with the previous or next neighbour and persists", async () => {
  /* MUTATION: swap the sign of `dir` inside moveQueueItem. Moving "b" with
     dir -1 would then swap with "c" instead of "a", and the first assertion
     fails. */
  const m = await mountBooted();
  m.ctx.addToQueue("a"); m.ctx.addToQueue("b"); m.ctx.addToQueue("c");
  m.ctx.moveQueueItem("b", -1);
  assert.deepStrictEqual(m.queueRaw(), ["b", "a", "c"], "moving b up must swap it with a");
  m.ctx.moveQueueItem("b", 1);
  assert.deepStrictEqual(m.queueRaw(), ["a", "b", "c"], "moving b back down must restore the original order");
});

test("moveQueueItem refuses to move the first item up or the last item down", async () => {
  /* MUTATION: remove the `if (j < 0 || j >= ids.length) return;` bound
     check. The first item would wrap to the end (or vice versa) instead of
     staying put, and both assertions fail. */
  const m = await mountBooted();
  m.ctx.addToQueue("a"); m.ctx.addToQueue("b");
  m.ctx.moveQueueItem("a", -1);
  assert.deepStrictEqual(m.queueRaw(), ["a", "b"], "the first item must not move further up");
  m.ctx.moveQueueItem("b", 1);
  assert.deepStrictEqual(m.queueRaw(), ["a", "b"], "the last item must not move further down");
});

/* ==================================================================== */
/* 8. ROUTE WIRING                                                       */
/* ==================================================================== */

test("route() dispatches #/queue to renderQueue, matching the #/playlists pattern", () => {
  /* MUTATION: delete the `h === "#/queue"` branch from route(). This test
     fails because renderHome (the fallback) runs instead and the view never
     contains the empty-state copy renderQueue would have produced. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  m.state.ready = true;

  m.ctx.location.hash = "#/queue";
  m.ctx.route();
  assert.ok(m.view().includes("Nothing in Up Next yet"), "route() must dispatch to renderQueue for #/queue");
});
