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

const { test, before } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

process.on("unhandledRejection", () => {});

/* What plays after an episode is player/continuation.js's since NE-13, published
   to the page by player/client.js as `window.forayContinuation`. This harness
   has no client.js, so it publishes the REAL rules the same way — without them
   `advanceQueueOnEnded` finds no rules and, correctly, plays and removes
   nothing (test/up-next-autoadvance.test.js does the same). */
let CONTINUATION = null;
/* Play next / Clear's ORDER is player/queue-order.js's (PQ-01), published by
   client.js as `window.forayQueueOrder` — published here the same way. */
let QUEUE_ORDER = null;
before(async () => {
  CONTINUATION = await import("../player/continuation.js");
  QUEUE_ORDER = await import("../player/queue-order.js");
});

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
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results", "browse-all-link",
];

/* `#view`, able to resolve the one descendant renderShow paints into by
   attribute rather than by id. Added 2026-09-14 (issue #687): the show page's
   FIRST episode paint moved inside `[data-show-episodes]`, so a stub that
   understands nothing but `#id` sees an empty page and the Up Next assertion
   below fails for a control that is really there. `view()` splices the
   container's content back into the marker's place rather than appending it,
   so document order is preserved for anything that asks about it. */
function makeViewEl() {
  const el = makeEl("div");
  el.id = "view";
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return html; },
    set(v) { html = v; el._episodes = null; },
  });
  el.querySelector = (sel) => {
    if (!String(sel).includes("[data-show-episodes]")) return null;
    if (!html.includes("data-show-episodes")) return null;
    if (!el._episodes) el._episodes = makeEl("div");
    return el._episodes;
  };
  return el;
}

function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = id === "view" ? makeViewEl() : makeEl("div");
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
        if (!s.startsWith("#")) return null;
        const rest = s.slice(1);
        const space = rest.indexOf(" ");
        if (space === -1) return byId.get(rest) ?? null;
        const root = byId.get(rest.slice(0, space));
        return root ? root.querySelector(rest.slice(space + 1)) : null;
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
  ctx.forayContinuation = CONTINUATION;
  ctx.forayQueueOrder = QUEUE_ORDER;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body,
    state: evalIn("state"),
    view: () => {
      const el = byId.get("view");
      const inner = el._episodes ? el._episodes.innerHTML : "";
      return el.innerHTML.replace("<div data-show-episodes></div>", `<div data-show-episodes>${inner}</div>`);
    },
    queueRaw: () => JSON.parse(store.get("cp_queue") || "null"),
  };
}

/** Playable snapshots for bare ids, in the session cache: `addToQueue` accepts
    only what `liveEpisode` can play (audit round 2, p-impatient-10), and these
    ordering/removal tests are about the list, not the catalogue. */
function seedPlayable(m, ids) {
  for (const id of ids) m.state.itemIndex[id] = { id, title: `Episode ${id}`, show: "S", audio_url: `https://x.test/${id}.mp3`, topics: [] };
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
     "cp_queue" (or to call editPlaylists). The cp_playlists-untouched
     assertion fails, and the cp_queue assertion fails too since nothing
     was ever written there. */
  const m = await mountBooted({ cp_playlists: "[]" });
  /* A real playable id: addToQueue refuses what 4a cannot play (p-impatient-10). */
  const [a] = readJson("data/discover.json").items.filter((it) => it.audio_url);
  m.ctx.addToQueue(a.id);
  assert.deepStrictEqual(m.queueRaw(), [a.id], "cp_queue must hold the added id");
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

test("archivedRow offers no '+ Up Next': the row already says it cannot play (audit round 2, p-impatient-10)", () => {
  /* Stage 1 put the control on a named aged-out part, when the row still
     linked out to another app; #452 removed the link-out and the button stayed
     beside "Not available to play", turning "✓ Up Next" on a tap and listing a
     row continuous playback then passed over in silence.
     MUTATION: put `${named ? upNextBtn(item.id) : ""}` back in archivedRow. */
  const m = mount();
  const namedItem = { id: "arch-1", title: "An archived episode", show: "Some Show" };
  const namedHtml = m.ctx.archivedRow(namedItem, 0, "test-ctx");
  assert.ok(!namedHtml.includes("data-upnext"), "a named archived part offers no Up Next control");
  assert.ok(namedHtml.includes('data-star="arch-1"'), "…but keeps its star (the recovery path)");
  assert.ok(namedHtml.includes("Not available to play"), "and still says why");

  const unnamedHtml = m.ctx.archivedRow({}, 1, "test-ctx");
  assert.ok(!unnamedHtml.includes("data-upnext"), "an unnamed archived part gets no Up Next control either");
});

test("ROUND 2 review (p-impatient-10): no '+ Up Next' beside 'Not available to play', and a refused add never paints '✓ Up Next'", () => {
  /* epRow and the episode page still drew the button for an item with no
     audio, and bindUpNext painted "✓ Up Next" whatever addToQueue did.
     MUTATIONS: drop the `isPlayableId` gate from upNextBtn -> the silent row
     offers the button; paint `true` in bindUpNext -> the label lies. */
  const m = mount();
  m.state.poolIds = new Set();
  const silent = { id: "silent-2", title: "No audio", show: "S", audio_url: null };
  const live = { id: "live-2", title: "Has audio", show: "S", audio_url: "https://x.test/b.mp3" };
  m.state.itemIndex["silent-2"] = silent;
  m.state.itemIndex["live-2"] = live;
  const silentRow = m.ctx.epRow(silent, 0, "show-x");
  assert.ok(silentRow.includes("Not available to play"), "precondition: the row says it cannot play");
  assert.ok(!silentRow.includes("data-upnext"), "and offers no Up Next control");
  assert.ok(m.ctx.epRow(live, 0, "show-x").includes('data-upnext="live-2"'), "a playable row keeps it");

  // A stale button (drawn before the item aged out) is tapped: nothing is claimed.
  let onClick = null;
  const labels = [];
  const btn = {
    dataset: { upnext: "silent-2" }, _bound: false,
    addEventListener: (_t, fn) => { onClick = fn; },
    setAttribute: () => {}, removeAttribute: () => {}, getAttribute: () => null,
    classList: { add: (c) => labels.push(`+${c}`), remove: () => {}, toggle: (c, on) => labels.push(on ? `+${c}` : `-${c}`) },
    set textContent(v) { labels.push(v); }, get textContent() { return ""; },
  };
  m.ctx.bindUpNext({ querySelectorAll: () => [btn] });
  onClick({ preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(m.queueRaw(), null, "precondition: the add was refused");
  assert.ok(!labels.includes("✓ Up Next") && !labels.includes("+on"), `no false success: ${labels.join(" ")}`);
});

test("addToQueue refuses an episode 4a cannot play (audit round 2, p-impatient-10)", () => {
  /* The button turned "✓ Up Next" for an id with no playable snapshot, and the
     Up Next page then listed it as "not available right now". `isPlayableId` is
     the one definition of playable, so the refusal and the row agree.
     MUTATION: drop `if (!isPlayableId(id)) return false;` from addToQueue -> the ghost
     and the silent part land in cp_queue. */
  const m = mount();
  m.ctx.addToQueue("never-seen-anywhere");
  assert.strictEqual(m.queueRaw(), null, "an id nothing can describe is refused");
  const silent = { id: "silent", title: "No audio", show: "S", audio_url: null };
  const live = { id: "live", title: "Has audio", show: "S", audio_url: "https://x.test/a.mp3" };
  m.state.itemIndex.silent = silent;
  m.state.itemIndex.live = live;
  m.state.poolIds = new Set();
  m.ctx.addToQueue("silent");
  assert.strictEqual(m.queueRaw(), null, "a snapshot with no audio_url is refused");
  m.ctx.addToQueue("live");
  assert.deepStrictEqual(m.queueRaw(), ["live"], "a playable snapshot is accepted");
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
  /* SETTLED FIRST. Since 2026-09-21 a show page paints a placeholder while the
     episode fetch is in flight rather than the curated-pool rows (founder: stale
     rows that swap a second later are worse than a brief blank), so reading the
     view synchronously now finds no rows at all. This harness 404s the endpoint,
     so the page settles into `failed`, which is where those curated rows — the
     ones carrying the Up Next control this test is about — are painted. */
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
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
  const [a] = readJson("data/discover.json").items.filter((it) => it.audio_url);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(a.id);
  assert.deepStrictEqual(m.queueRaw(), [a.id], "adding the same episode twice must not duplicate it");
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
  seedPlayable(m, ["ep-1", "ep-2", "ep-3"]);
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
  seedPlayable(m, ["ep-only"]);
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
  seedPlayable(m, ["a", "b", "c"]);
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
  seedPlayable(m, ["a", "b"]);
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

/* ==================================================================== */
/* 9. THE PAGE IS A LIVE VIEW OF THE LIST (audit round 2)                */
/* ==================================================================== */

test("a write to Up Next repaints the page while it is showing, and only then (audit round 2, p-impatient-6)", async () => {
  /* An episode ended, continuous playback removed it from cp_queue, and row 1
     stayed on screen with a ▶ and "N queued" one too many until an arrow was
     pressed — then the whole list jumped. Every write goes through
     `saveQueueIds`, which now repaints #/queue when it is on screen.
     MUTATION: drop `repaintQueuePage()` from saveQueueIds -> the removed row is
     still in the view. MUTATION 2: drop the hash guard -> the Home paint below
     is replaced by the Up Next page. */
  const m = await mountBooted();
  const [a, b] = readJson("data/discover.json").items.filter((it) => it.audio_url);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  m.ctx.location.hash = "#/queue";
  m.ctx.renderQueue();
  assert.ok(m.view().includes(m.ctx.esc(a.title)) && m.view().includes("2 queued"), "precondition: both rows painted");

  m.ctx.removeFromQueue(a.id);                       // no renderQueue() here
  assert.ok(!m.view().includes(m.ctx.esc(a.title)), "the removed row is gone from the page at once");
  assert.ok(m.view().includes("1 queued"), "the count follows");

  /* The same write from continuous playback's end-of-episode path. */
  m.ctx.window.ForayPlayer = { async play() { return true; }, onEpisodeEnded() { return () => {}; }, setEpisodeNavigation() { return true; }, currentEpisodeId() { return null; } };
  m.ctx.advanceQueueOnEnded(b.id);
  assert.ok(m.view().includes("Nothing in Up Next yet"), "the finished episode's row leaves the page it was watched from");

  /* And on any other page, a write paints nothing into #view. */
  m.ctx.location.hash = "#/";
  m.evalIn('$("#view").innerHTML = "<p>Home</p>"');
  m.ctx.addToQueue(a.id);
  assert.strictEqual(m.view(), "<p>Home</p>", "a write off the page does not paint the page");
});

test("the row the bar is on is marked .is-current, playing or paused (audit round 2, p-impatient-6)", async () => {
  /* Only the ❚❚ glyph said which row was current, and a paused current row
     had none. MUTATION: drop the isCurrent read from upNextRow -> no row is
     marked. */
  const m = await mountBooted();
  const [a, b] = readJson("data/discover.json").items.filter((it) => it.audio_url);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  m.ctx.window.ForayPlayer = { isCurrent: (id) => id === b.id };
  m.ctx.renderQueue();
  const rows = [...m.view().matchAll(/<div class="ep-row up-next-row([^"]*)"([^>]*)>/g)];
  assert.strictEqual(rows.length, 2);
  assert.ok(!rows[0][1].includes("is-current"), "row 1 is not current");
  assert.ok(rows[1][1].includes("is-current") && rows[1][2].includes('aria-current="true"'), "row 2 is the one the bar is on");
});

test("a queued row and the episode page carry the player's 'Played' / 'NN min left' (audit round 2, honesty-5)", async () => {
  /* Every other episode row had the mark since persona 78; the Up Next row and
     the episode page did not, so a half-finished queued episode looked fresh and
     the mark vanished on the way into its page.
     MUTATION: drop `progHtml` from upNextRow's live sub-line, or from
     renderEpisode's meta line -> the matching assertion goes red. */
  const m = await mountBooted();
  const [a, b] = readJson("data/discover.json").items.filter((it) => it.audio_url);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  m.ctx.window.ForayPlayer = {
    episodeProgress: (id) => (id === a.id
      ? { state: "played", percent: 100, label: "Played" }
      : { state: "in-progress", percent: 50, label: "20 min left" }),
  };
  m.ctx.renderQueue();
  assert.match(m.view(), /<span class="ep-progress is-played">Played<\/span>/, "the finished queued row says so");
  assert.match(m.view(), /<span class="ep-progress">20 min left<\/span>/, "the half-way queued row says how far");
  m.ctx.renderEpisode(b.id);
  assert.match(m.view(), /fp-s-show[^]*?<span class="ep-progress">20 min left<\/span>/, "the episode page keeps the mark");
});

test("an Up Next row with no details says one sentence about THIS page (audit round 2, copy-9)", () => {
  /* It said "Removed from your history — no details saved": not History, and
     nothing was removed — the id is right there in the list.
     MUTATION: restore the old sentence. */
  const m = mount({ seed: { cp_queue: JSON.stringify(["an-id-nothing-can-name"]) } });
  m.state.session = { session_id: "s", episodes: {}, cards: [] };
  m.ctx.renderQueue();
  assert.ok(m.view().includes("4a no longer has this episode's details"), m.view());
  assert.ok(!/history/i.test(m.view()), "the sentence does not mention History");
});

test("the snapshot cap never prunes a QUEUED episode (audit round 2, p-impatient-11)", () => {
  /* Pruning was by key insertion order — the oldest remembered first — and the
     oldest remembered are the head of Up Next. Past the cap, the rows about to
     play lost their snapshots and read "not available right now".
     MUTATION: prune over every key again (drop the `!queued.has(k)` filter)
     -> the first queued episodes are gone. */
  const m = mount();
  m.state.session = { session_id: "s", episodes: {}, cards: [] };
  m.state.poolIds = new Set();
  const N = 405; // EPISODE_SNAPS_CAP is 400
  const ids = [];
  for (let i = 0; i < N; i++) {
    const id = `q-${i}`;
    ids.push(id);
    m.state.itemIndex[id] = { id, title: `Q ${i}`, show: "S", audio_url: "https://x.test/a.mp3", topics: [] };
    m.ctx.addToQueue(id);
  }
  const snaps = m.ctx.episodeSnaps();
  for (const id of ids.slice(0, 10)) assert.ok(snaps[id], `the head of Up Next (${id}) must keep its snapshot`);
  /* The cap still bounds what is NOT queued: history-only keys go first. */
  const m2 = mount();
  m2.state.session = { session_id: "s", episodes: {}, cards: [] };
  m2.state.poolIds = new Set();
  for (let i = 0; i < N; i++) {
    const id = `h-${i}`;
    m2.state.itemIndex[id] = { id, title: `H ${i}`, show: "S", audio_url: "https://x.test/a.mp3", topics: [] };
    m2.ctx.lsSet("cp_history", m2.ctx.pickedHistory().concat(id));
    m2.ctx.rememberEpisode(id);
  }
  const kept = Object.keys(m2.ctx.episodeSnaps());
  assert.ok(kept.length <= 400, `the cap holds for history keys (${kept.length})`);
  assert.ok(!kept.includes("h-0"), "the oldest history-only snapshot is the one pruned");
});

test("fullPool is memoised on the documents it reads (audit round 2, perf-10)", () => {
  /* Every Up Next reorder re-snapshotted the whole discover pool. The pool is
     the same until a document is replaced. MUTATION: drop the `poolCache`
     early return -> the second call snapshots again. */
  const m = mount();
  const items = [1, 2, 3].map((n) => ({ id: `p-${n}`, title: `P ${n}`, show: "S", audio_url: "https://x.test/a.mp3", topics: [] }));
  m.state.session = { session_id: "s", episodes: {}, cards: [] };
  m.state.discover = { items };
  const orig = m.ctx.snapshot;
  let calls = 0;
  m.ctx.snapshot = (...args) => { calls++; return orig(...args); };
  const first = m.ctx.fullPool();
  assert.strictEqual(calls, 3, "the first build snapshots every item");
  const second = m.ctx.fullPool();
  assert.strictEqual(calls, 3, "the second call is answered from the cache");
  assert.ok(first !== second, "…as a copy, so a caller's sort cannot leak into the next");
  assert.deepStrictEqual([...second.map((x) => x.id)], ["p-1", "p-2", "p-3"]); // spread: a vm-realm array has its own Array.prototype
  m.state.discover = { items: items.slice(0, 2) };
  m.ctx.fullPool();
  assert.strictEqual(calls, 5, "a replaced document rebuilds");
  assert.deepStrictEqual([...m.state.poolIds], ["p-1", "p-2"], "and membership is rebuilt with it (#276)");
});

/* ==================================================================== */
/* 10. PLAY NEXT + CLEAR UP NEXT (#762, PQ-02)                           */
/* ==================================================================== */

/** A list of playable ids, nothing booted: Play next is about the list. */
function mountQueue(ids, current) {
  const m = mount({ seed: { cp_queue: JSON.stringify(ids) } });
  m.state.session = { session_id: "s", episodes: {}, cards: [] };
  m.state.poolIds = new Set();
  seedPlayable(m, ids);
  m.ctx.window.ForayPlayer = { currentEpisodeId: () => current, isCurrent: (id) => id === current };
  return m;
}

/** A button the click-binding tests can press, recording what is painted. */
function fakeButton(dataset) {
  const painted = [];
  const btn = {
    dataset, _bound: false, onClick: null,
    addEventListener: (_t, fn) => { btn.onClick = fn; },
    setAttribute: () => {}, removeAttribute: () => {}, getAttribute: () => null,
    getBoundingClientRect: () => ({ top: 100 }),
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    set textContent(v) { painted.push(v); }, get textContent() { return ""; },
    focus() {},
    painted,
  };
  return btn;
}
const CLICK = { preventDefault() {}, stopPropagation() {} };

test("Play next from a row lands the episode right after the playing one (PQ-02, #762)", () => {
  /* MUTATION (run, red): make playNextInQueue call `addToQueue(id)` instead of
     the queue-order rule -> "c" is already queued, so cp_queue stays
     ["a","b","c"] and the first assertion fails. */
  const m = mountQueue(["a", "b", "c"], "a");
  assert.strictEqual(m.ctx.playNextInQueue("c"), true, "the list changed");
  assert.deepStrictEqual(m.queueRaw(), ["a", "c", "b"], "c goes directly after the playing a; nothing else moves");
  /* Already next: playNextOrder hands back the same list, so nothing is written. */
  assert.strictEqual(m.ctx.playNextInQueue("c"), false, "a second Play next on the same row changes nothing");
  assert.deepStrictEqual(m.queueRaw(), ["a", "c", "b"]);
});

test("Play next on an unqueued playable episode adds it, and refuses an unplayable one (PQ-02, #762)", () => {
  /* MUTATION (run, red): drop `!isPlayableId(id)` from playNextInQueue's first
     line -> "z-unplayable" lands in cp_queue and the last assertion fails. */
  const m = mountQueue(["a"], "a");
  m.state.itemIndex.z = { id: "z", title: "Z", show: "S", audio_url: "https://x.test/z.mp3", topics: [] };
  m.state.itemIndex["z-unplayable"] = { id: "z-unplayable", title: "Silent", show: "S", audio_url: null, topics: [] };
  assert.strictEqual(m.ctx.playNextInQueue("z"), true);
  assert.deepStrictEqual(m.queueRaw(), ["a", "z"], "an episode not yet queued is added right after the playing one");
  assert.ok(m.ctx.episodeSnaps().z, "and remembered, like addToQueue does, so its row can be drawn later");
  assert.strictEqual(m.ctx.playNextInQueue("z-unplayable"), false, "4a cannot play it, so it is refused");
  assert.deepStrictEqual(m.queueRaw(), ["a", "z"], "cp_queue unchanged by the refusal");
});

test("Clear keeps the playing row and announces the count (PQ-02, #762)", () => {
  /* MUTATION (run, red): in clearQueue, `const left = [];` (ignore the playing
     row) -> cp_queue is [] and the announcement says 3, both red. */
  const m = mountQueue(["a", "b", "c"], "b");
  const clear = fakeButton({});
  m.ctx.bindUpNextReorder({ querySelectorAll: (sel) => (sel === "#up-next-clear" ? [clear] : []) });
  assert.ok(clear.onClick, "the Clear control is bound by the Up Next page's binder");
  clear.onClick(CLICK);
  assert.deepStrictEqual(m.queueRaw(), ["b"], "everything but the playing row is gone");
  const said = m.body.children.map((c) => c.textContent).filter(Boolean).pop() || "";
  assert.match(said, /Removed 2 episodes from Up Next\./, `the screen reader hears the count: "${said}"`);
});

test("#/queue renders Clear only with two or more rows, and a Play next per row, disabled on the row after the playing one (PQ-02, #762)", () => {
  /* MUTATION (run, red): drop `rules.playNextOrder(ids, id, cur) === ids` from
     upNextRow's playNextDisabled (leave `false`) -> b's Play next is enabled
     (CH-35 replaced the hand-derived `ids[curIdx + 1] === id`). MUTATION 2:
     render Clear for any non-empty list -> the one-row page shows it. */
  const m = mountQueue(["a", "b", "c"], "a");
  m.ctx.renderQueue();
  const html = m.view();
  const controls = [...html.matchAll(/<button type="button" class="reorder playnext" data-playnext="([^"]+)" (disabled)?/g)]
    .map((x) => [x[1], !!x[2]]);
  assert.deepStrictEqual(controls, [["a", true], ["b", true], ["c", false]],
    "one Play next per row; off on the playing row and on the row already next");
  assert.ok(html.includes('id="up-next-clear"'), "three rows: Clear is offered");

  const one = mountQueue(["a"], null);
  one.ctx.renderQueue();
  assert.ok(!one.view().includes('id="up-next-clear"'), "one row: no Clear");
  assert.match(one.view(), /data-playnext="a" disabled/, "nothing playing: row 1 is already next");
});

test("#/episode renders Play next beside + Up Next, and its click goes through playNextInQueue (PQ-02, #762)", async () => {
  /* MUTATION (run, red): bind bindUpNext's [data-playnext] to `addToQueue(id)`
     instead of `playNextInQueue(id)` -> the episode lands at the END,
     ["x","y",id], and the order assertion fails. */
  const m = await mountBooted();
  const item = readJson("data/discover.json").items.find((it) => it.audio_url);
  m.ctx.renderEpisode(item.id);
  const html = m.view();
  const up = html.indexOf(`data-upnext="${m.ctx.esc(item.id)}"`);
  const next = html.indexOf(`data-playnext="${m.ctx.esc(item.id)}"`);
  assert.ok(up >= 0 && next > up, "Play next renders right after + Up Next in the episode actions");
  assert.match(html, /aria-label="Play next">Play next<\/button>/);

  seedPlayable(m, ["x", "y"]);
  m.ctx.lsSet("cp_queue", ["x", "y"]);
  m.ctx.window.ForayPlayer = { currentEpisodeId: () => "x" };
  const pn = fakeButton({ playnext: item.id });
  const upBtn = fakeButton({ upnext: item.id });
  m.ctx.bindUpNext({ querySelectorAll: (sel) => (sel === "[data-playnext]" ? [pn] : sel.startsWith("[data-upnext=") ? [upBtn] : []) });
  pn.onClick(CLICK);
  assert.deepStrictEqual(m.queueRaw(), ["x", item.id, "y"], "the episode plays right after the one playing");
  assert.ok(upBtn.painted.includes("✓ Up Next"), `its + Up Next is painted from the queue: ${upBtn.painted.join(" ")}`);
});

/* ==================================================================== */
/* 11. UP NEXT REFUSES POOL ROWS 4a CANNOT PLAY (CH-01, A1-01)           */
/* ==================================================================== */

/* The pool rows with no `audio_url` (8 of 2177 in data/discover.json: members-
   only and video-only items tools/refresh/backfill-audio.mjs could not resolve).
   `liveEpisode` answers for a pool row whatever its audio, while the walk asks
   `isPlayableId` (liveEpisode + audio_url, via continuationState) — so the
   gate used to accept what the walk then skipped. The tests above that seed a
   silent item all EMPTY `state.poolIds`; these keep it in the pool. */
function silentPoolRow(m) {
  const silent = readJson("data/discover.json").items.find((it) => !it.audio_url);
  assert.ok(silent, "fixture assumption: discover.json carries a pool row with no audio_url");
  assert.ok(m.state.poolIds.has(silent.id), "precondition: the silent row is IN the pool");
  assert.ok(m.ctx.liveEpisode(silent.id), "precondition: liveEpisode answers for it (the pool rule)");
  return silent;
}

/** Plays the queue head and lets continuous playback run (no tail in this
    harness: no window.forayTailFill), returning every id the walk played. */
function walkQueue(m) {
  const head = m.ctx.queueIds()[0];
  if (!head) return [];
  const played = [head];
  for (let i = 0; i < 20; i++) {
    const step = m.ctx.nextAfterEnded(played[played.length - 1]);
    if (!step.nextId || step.fromTail) break;
    played.push(step.nextId);
  }
  return played;
}

test("a pool row with no audio_url gets no '+ Up Next', is refused by addToQueue and Play next, and the walk plays every queued id (CH-01, A1-01)", async () => {
  /* MUTATION (run, red): revert addToQueue's gate to `if (!liveEpisode(id))`
     -> the silent pool row lands in cp_queue and "the silent pool row is
     refused" goes red (left unchecked, the walk would then play 2 of 3
     queued ids). MUTATION 2 (run, red): revert upNextBtn's gate to
     `!liveEpisode(id)` -> the button is drawn beside "Not available to play".
     MUTATION 3 (run, red): revert playNextInQueue's gate to `!liveEpisode(id)`
     -> "Play next refuses it too" goes red. MUTATION 4 (run, red): drop the
     `audio_url` check from isPlayableId -> every gate admits the silent row
     and the first upNextBtn assertion goes red. */
  const m = await mountBooted();
  const silent = silentPoolRow(m);
  const [a, b] = readJson("data/discover.json").items.filter((it) => it.audio_url);

  assert.strictEqual(m.ctx.upNextBtn(silent.id), "", "no Up Next control for a row 4a cannot play");
  assert.strictEqual(m.ctx.upNextBtn(silent.id, silent), "", "…with or without the row's own item in hand");
  const row = m.ctx.epRow(silent, 0, "show-x");
  assert.ok(row.includes("Not available to play"), "epRow says it cannot play (notPlayableNote)");
  assert.ok(!row.includes("data-upnext"), "and epRow offers no Up Next control");
  m.ctx.renderEpisode(silent.id);
  const page = m.view();
  assert.ok(page.includes("Not available to play"), "the episode page says it cannot play");
  /* Scoped to this id: "More from this show" below lists the show's other,
     playable episodes, each with its own control. */
  assert.ok(!page.includes(`data-upnext="${m.ctx.esc(silent.id)}"`), "and the episode page offers no Up Next control for it");

  assert.strictEqual(m.ctx.addToQueue(a.id), true, "a playable pool row is added");
  assert.strictEqual(m.ctx.addToQueue(silent.id), false, "the silent pool row is refused");
  assert.strictEqual(m.ctx.addToQueue(b.id), true);
  assert.deepStrictEqual(m.queueRaw(), [a.id, b.id], "cp_queue holds only what 4a can play");
  assert.strictEqual(m.ctx.playNextInQueue(silent.id), false, "Play next refuses it too");
  assert.deepStrictEqual(m.queueRaw(), [a.id, b.id], "cp_queue unchanged by the refusal");

  const queued = m.ctx.queueIds().length;
  assert.deepStrictEqual(walkQueue(m), [a.id, b.id], "the walk plays the queue in order");
  assert.strictEqual(queued, 2, "queue count equals walk count");
});

test("a pool row WITH audio_url still queues, and the walk plays every queued id (CH-01, characterization)", async () => {
  /* Pins today's good path so the tightening above cannot over-reach.
     MUTATION (run, red): gate addToQueue on `state.itemIndex[id]?.audio_url &&
     !state.poolIds.has(id)` (refuse pool rows outright) -> nothing is queued.
     MUTATION 2 (run, red): make continuationState's isPlayable `() => false`
     -> the walk stops after the head and plays 1 of 3. */
  const m = await mountBooted();
  const pool = readJson("data/discover.json").items.filter((it) => it.audio_url && m.state.poolIds.has(it.id)).slice(0, 3);
  assert.strictEqual(pool.length, 3, "fixture assumption: three playable pool rows");
  for (const it of pool) {
    assert.ok(m.ctx.upNextBtn(it.id).includes(`data-upnext="${m.ctx.esc(it.id)}"`), "a playable pool row offers Up Next");
    m.ctx.addToQueue(it.id);
  }
  const ids = pool.map((it) => it.id);
  assert.deepStrictEqual(m.queueRaw(), ids, "every playable pool row is queued, in order");
  assert.deepStrictEqual(walkQueue(m), ids, "and the walk plays every queued id");
});

/* ==================================================================== */
/* 11. CH-29 (A1-19): queueIds IS stringList; ONE ensurePool              */
/* ==================================================================== */

test("queueIds drops every entry that is not a non-empty string, and a non-array store reads as empty (CH-29, characterization)", () => {
  /* queueIds re-implemented stringList's filter inline; it is now that helper.
     The rule both carried: an id that cannot be a real episode id is dropped,
     never rendered as a permanently broken row.
     MUTATION (run, red): `return storedValue("cp_queue", [])` (no filter) ->
     the mixed list comes back with its 3, "", null and {} intact.
     MUTATION 2 (run, red): stringList keeps "" (`typeof x === "string"` alone)
     -> the empty id survives. */
  const m = mount({ seed: { cp_queue: JSON.stringify(["a", 3, "", null, "b", {}, ["c"]]) } });
  assert.deepStrictEqual([...m.ctx.queueIds()], ["a", "b"]);
  const objectStore = mount({ seed: { cp_queue: JSON.stringify({ a: 1 }) } });
  assert.deepStrictEqual([...objectStore.ctx.queueIds()], [], "a corrupt non-array value is an empty Up Next, not a crash");
  const nothing = mount();
  assert.deepStrictEqual([...nothing.ctx.queueIds()], []);
});

test("inDiscoverPool and hydrationPool build the pool on demand when a session is loaded, and never throw without one (CH-29, characterization)", () => {
  /* Both re-implemented "build the pool if there is a session; a missing
     catalogue is not an error" — now one ensurePool(). hydrationPool keeps its
     extra rule: it builds only while the index is still empty.
     MUTATION (run, red): drop the fullPool() call from ensurePool -> nothing
     builds the pool and "a pool id is in the pool" fails.
     MUTATION 2 (run, red): drop ensurePool's try/catch -> the throwing
     fullPool escapes and both "never throws" assertions fail.
     MUTATION 3 (run, red): drop ensurePool's session guard -> fullPool runs
     with no session and throws (session.episodes) inside the catch, but the
     spy counts the call, so "no session, no build" fails. */
  const items = [1, 2].map((n) => ({ id: `p-${n}`, title: `P ${n}`, show: "S", audio_url: "https://x.test/a.mp3", topics: [] }));

  const m = mount();
  m.state.session = { session_id: "s", episodes: {}, cards: [] };
  m.state.discover = { items };
  assert.strictEqual(m.ctx.inDiscoverPool("p-1"), true, "a pool id is in the pool, built on demand");
  assert.strictEqual(m.ctx.inDiscoverPool("nope"), false);
  assert.strictEqual(m.ctx.inDiscoverPool(7), false, "a non-string id is never in the pool");

  const h = mount();
  h.state.session = { session_id: "s", episodes: {}, cards: [] };
  h.state.discover = { items };
  assert.deepStrictEqual(Object.keys(h.ctx.hydrationPool()).sort(), ["p-1", "p-2"], "hydrationPool builds the empty index");

  const bare = mount();
  bare.state.discover = { items };
  const real = bare.ctx.fullPool;
  let calls = 0;
  bare.ctx.fullPool = (...a) => { calls++; return real(...a); };
  assert.strictEqual(bare.ctx.inDiscoverPool("p-1"), false, "no session: nothing is in the pool");
  assert.deepStrictEqual(Object.keys(bare.ctx.hydrationPool()), [], "no session: an empty index");
  assert.strictEqual(calls, 0, "no session, no build");

  const broken = mount();
  broken.state.session = { session_id: "s", episodes: {}, cards: [] };
  broken.ctx.fullPool = () => { throw new Error("catalogue not there yet"); };
  assert.doesNotThrow(() => broken.ctx.inDiscoverPool("p-1"), "inDiscoverPool never throws");
  assert.doesNotThrow(() => broken.ctx.hydrationPool(), "hydrationPool never throws");
});

/* ==================================================================== */
/* 11. CH-35 (docs/roadmap/code-health.md A2-01, A2-07, A2-19)           */
/* ==================================================================== */

/** [id, disabled] for every Play next control on the painted #/queue page. */
function playNextControls(m) {
  return [...m.view().matchAll(/<button type="button" class="reorder playnext" data-playnext="([^"]+)" (disabled)?/g)]
    .map((x) => [x[1], !!x[2]]);
}

/** A queue whose bar is on `current` as far as the app's pointer
    (`currentEpisodeId`) knows, and on `barOn` as far as `isCurrent` knows —
    the two differ while the app's pointer lags the player. `unplayable` ids get
    no playable snapshot, so their rows are `unnamed`. */
function mountQueueLagging(ids, { current = null, barOn = current, unplayable = [] } = {}) {
  const m = mount({ seed: { cp_queue: JSON.stringify(ids) } });
  m.state.session = { session_id: "s", episodes: {}, cards: [] };
  m.state.poolIds = new Set();
  seedPlayable(m, ids.filter((id) => !unplayable.includes(id)));
  m.ctx.window.ForayPlayer = { currentEpisodeId: () => current, isCurrent: (id) => id === barOn };
  return m;
}

test("Play next is disabled on exactly the rows playNextOrder would not move, for every reachable row state (CH-35, A2-01, characterization)", () => {
  /* The table the card names: the playing row, the row right after it, the
     head with nothing playing, a mid-list row, a row 4a cannot play, a playing
     id that is not in the list, AND the lag where `isCurrent` (the player) is
     on a row the app's `currentPlayingId` pointer has not reached yet.
     MUTATION (run, red): drop `isCurrent` from upNextRow's playNextDisabled ->
     the "lag" row c is enabled and the lag case fails. MUTATION 2 (run, red):
     drop `!playable` -> the unnamed row u is enabled. */
  const cases = [
    { name: "a playing", ids: ["a", "b", "c"], opts: { current: "a" }, want: [["a", true], ["b", true], ["c", false]] },
    { name: "nothing playing", ids: ["a", "b", "c"], opts: {}, want: [["a", true], ["b", false], ["c", false]] },
    { name: "b playing (mid-list)", ids: ["a", "b", "c"], opts: { current: "b" }, want: [["a", false], ["b", true], ["c", true]] },
    { name: "c playing (last)", ids: ["a", "b", "c"], opts: { current: "c" }, want: [["a", false], ["b", false], ["c", true]] },
    { name: "playing id not queued", ids: ["a", "b", "c"], opts: { current: "z" }, want: [["a", true], ["b", false], ["c", false]] },
    { name: "lag: pointer on a, bar on c", ids: ["a", "b", "c"], opts: { current: "a", barOn: "c" }, want: [["a", true], ["b", true], ["c", true]] },
    { name: "unplayable row", ids: ["a", "u", "c"], opts: { current: "c", unplayable: ["u"] }, want: [["a", false], ["u", true], ["c", true]] },
  ];
  for (const { name, ids, opts, want } of cases) {
    const m = mountQueueLagging(ids, opts);
    m.ctx.renderQueue();
    assert.deepStrictEqual(playNextControls(m), want, name);
  }
});

test("Play next's disabled state is the queue-order rule's answer, and no rules means disabled (CH-35, A2-01)", () => {
  /* The row used to re-derive playNextOrder by hand; the two agreed for every
     reachable state (the table above), and would have drifted the day the rule
     changed — a button enabled whose tap moves nothing.
     MUTATION (run, red): restore the hand-derived `id === cur || (curIdx >= 0 ?
     ids[curIdx + 1] === id : idx === 0)` -> with a rule that never moves
     anything, b and c are still enabled. MUTATION 2 (run, red): drop `!rules`
     -> with no rules published, b and c are enabled though their tap
     (`playNextInQueue`) does nothing. */
  const frozen = mountQueueLagging(["a", "b", "c"], { current: "a" });
  frozen.ctx.window.forayQueueOrder = { ...QUEUE_ORDER, playNextOrder: (ids) => ids };
  frozen.ctx.renderQueue();
  assert.deepStrictEqual(playNextControls(frozen), [["a", true], ["b", true], ["c", true]],
    "a rule that moves nothing leaves nothing to press");

  const none = mountQueueLagging(["a", "b", "c"], { current: "a" });
  none.ctx.window.forayQueueOrder = undefined;
  none.ctx.renderQueue();
  assert.deepStrictEqual(playNextControls(none), [["a", true], ["b", true], ["c", true]],
    "no queue-order rules (no player module): Play next would do nothing, so it is off");
});

test("the 'Played' / 'NN min left' chip is byte-identical on an episode row, the episode page and an Up Next row (CH-35, A2-07)", async () => {
  /* Three copies of one template: a new progress state or attribute landing on
     one of them would mark the same episode two ways.
     MUTATION (run, red): add ` data-x="1"` to any one of the three templates
     (or, after the change, edit the one helper's output on one caller) -> that
     surface's chip differs from the others. */
  const m = await mountBooted();
  const [a, b] = readJson("data/discover.json").items.filter((it) => it.audio_url);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  m.ctx.window.ForayPlayer = {
    episodeProgress: (id) => (id === a.id
      ? { state: "played", percent: 100, label: "Played" }
      : { state: "in-progress", percent: 50, label: "20 min <left> & \"more\"" }),
  };
  const chip = (html, id) => {
    const found = html.match(/<span class="ep-progress[^>]*>[^<]*<\/span>/g) || [];
    assert.ok(found.length >= 1, `a chip is painted for ${id}`);
    return found[0];
  };
  for (const it of [a, b]) {
    const fromRow = chip(m.ctx.epRow(m.state.itemIndex[it.id], 0, "library-saved", -1), it.id);
    m.ctx.renderEpisode(it.id);
    const fromPage = chip(m.view(), it.id);
    m.ctx.renderQueue();
    const rows = m.view().split('<div class="ep-row up-next-row');
    const fromQueue = chip(rows[it.id === a.id ? 1 : 2], it.id);
    assert.strictEqual(fromPage, fromRow, `episode page and row agree for ${it.id}`);
    assert.strictEqual(fromQueue, fromRow, `Up Next and row agree for ${it.id}`);
  }
  assert.strictEqual(m.ctx.epRow(m.state.itemIndex[a.id], 0, "library-saved", -1).match(/<span class="ep-progress[^>]*>[^<]*<\/span>/)[0],
    '<span class="ep-progress is-played">Played</span>', "the played chip, exactly");
  assert.strictEqual(m.ctx.epRow(m.state.itemIndex[b.id], 0, "library-saved", -1).match(/<span class="ep-progress[^>]*>[^<]*<\/span>/)[0],
    '<span class="ep-progress">20 min &lt;left&gt; &amp; &quot;more&quot;</span>', "the in-progress chip, escaped, exactly");
});

test("Up Next's empty state is one sentence on #/queue and in Library (CH-35, A2-19, characterization)", () => {
  /* MUTATION (run, red): reword either copy of the sentence -> the two
     surfaces disagree. */
  const SENTENCE = "Nothing in Up Next yet — add an episode from any row's \"+ Up Next\" button.";
  const empty = () => {
    const m = mount();
    m.state.catalog = { shows: [] };
    m.state.discover = { items: [] };
    m.state.taxonomy = { nodes: [] };
    m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
    return m;
  };
  const q = empty();
  q.ctx.renderQueue();
  assert.ok(q.view().includes(`<p class="note">${SENTENCE}</p>`), "#/queue empty");
  const lib = empty();
  lib.ctx.renderLibrary();
  assert.ok(lib.view().includes(`<p class="note">${SENTENCE}</p>`), "Library's Up Next section empty");
});
