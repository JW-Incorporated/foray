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
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
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
    /* The Up Next page's section (ui/queue.js; Redesign 2026): `repaintLibraryUpNext` repaints it IN PLACE, so the
       page is a live view without #view being rebuilt. This answers the one selector it asks with a section whose
       innerHTML reads and writes the slice of the page between its tags, so the repaint shows in `view()`. */
    if (String(sel).includes('data-lb-section="upnext"')) {
      const open = '<section class="lb-section qp-section" data-lb-section="upnext" data-lb-page="queue">';
      if (!html.includes(open)) return null;
      const bounds = () => { const s = html.indexOf(open) + open.length; return [s, html.indexOf("</section>", s)]; };
      return {
        dataset: { lbPage: "queue" }, contains: () => false, querySelectorAll: () => [], querySelector: () => null,
        getBoundingClientRect: () => ({ top: 0 }),
        get innerHTML() { const [s, e] = bounds(); return html.slice(s, e); },
        set innerHTML(v) { const [s, e] = bounds(); html = html.slice(0, s) + v + html.slice(e); },
      };
    }
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
  runAppSource(APP_SRC, ctx);

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
     "cp_queue" (or to call savePlaylists). The cp_playlists-untouched
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
     MUTATIONS: drop the `liveEpisode` gate from upNextBtn -> the silent row
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
     Up Next page then listed it as "not available right now". `liveEpisode` is
     the one definition of playable, so the refusal and the row agree.
     MUTATION: drop `if (!liveEpisode(id)) return;` from addToQueue -> the ghost
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
  /* REDESIGN 2026 (ambient Episode page): the page's Up Next is its own icon button (`data-ep-upnext`), not the legacy "+ Up Next" text one. */
  assert.ok(html.includes(`data-ep-upnext="${m.ctx.esc(item.id)}"`), "renderEpisode must render the Up Next control");
});

test("renderShow's episode rows each open the episode page, which is where '+ Up Next' lives", async () => {
  /* REDESIGN 2026 (ambient, show page) — THE RULING THAT FELL: "an add-control on every show-page row" (Stage 1's
     card-body scope). A show page's rows are EpisodeRows now (art, title, Play, meta, a two-line why: the same row Today
     draws), and an EpisodeRow carries no Save and no Up Next: those are the episode page's actions (BUILD-NOTES section
     10 item 11; renderEpisode is pinned just above). The row's title is the one stretched link to that page, so the
     control is one tap further, never gone. This test pins the link, and that the page it opens offers the control.
     MUTATION: render the row's title as plain text in showEpisodeRowHtml (drop the anchor, class td-link) -> red. */
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
    assert.ok(html.includes(`href="#/episode/${encodeURIComponent(ep.id)}"`), `show page must link "${ep.title}" to its episode page`);
  }
  assert.ok(!html.includes("data-upnext"), "an EpisodeRow carries no Up Next control of its own");
  m.ctx.renderEpisode(expected[0].id);
  /* The page it opens carries Up Next as its own icon button (`data-ep-upnext`, ambient Episode page), not the legacy text control. */
  assert.ok(m.view().includes(`data-ep-upnext="${m.ctx.esc(expected[0].id)}"`), "the episode page it opens does");
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

test("#/queue lists every queued episode in saved order, each playable (the star lives on the episode page)", async () => {
  /* MUTATION: sort queueRows() by anything other than insertion order (e.g.
     alphabetically by title). The order assertion fails.
     MUTATION 2: drop the cover button from libQueueRowHtml for a live row. The
     data-lb-play assertion fails.
     RULING THAT FELL (Redesign 2026, ambient; card anatomy): the page's row is Library's QueueRow, which has no star;
     the star stays on the episode page. The `data-star` assertion went with it. */
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
  assert.ok(html.includes(`data-lb-play="${m.ctx.esc(a.id)}"`), "a live queued episode must be playable in-app");
  assert.ok(html.includes(`data-lb-q="${m.ctx.esc(a.id)}"`), "and it is a QueueRow, the one Library draws");
  assert.ok(!html.includes("data-star="), "no star on a QueueRow: it lives on the episode page");
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
  assert.ok(html.includes("Nothing queued."), `expected an honest empty state, got: ${html}`);
  assert.ok(html.includes("See today&#39;s picks"), "and the one button out of it");
  assert.ok(!/class="[^"]*qp-row/.test(html), "an empty queue must render zero rows");
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
  assert.ok(html.includes("Nothing queued."), `expected the empty state after removing the last item, got: ${html}`);
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
  assert.ok(m.view().includes("Nothing queued."), "route() must dispatch to renderQueue for #/queue");
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
  assert.ok(m.view().includes("Nothing queued."), "the finished episode's row leaves the page it was watched from");

  /* And on any other page, a write paints nothing into #view. */
  m.ctx.location.hash = "#/";
  m.evalIn('$("#view").innerHTML = "<p>Home</p>"');
  m.ctx.addToQueue(a.id);
  assert.strictEqual(m.view(), "<p>Home</p>", "a write off the page does not paint the page");
});

test("the row the bar is on is marked .is-current, playing or paused (audit round 2, p-impatient-6)", async () => {
  /* Only the ❚❚ glyph said which row was current, and a paused current row
     had none. MUTATION: drop the `current` argument from the first row in libUpNextInnerHtml -> no row is
     marked. MUTATION 2: key the mark on isPlaying instead of the bar's episode -> the paused case is red.
     PORTED (Redesign 2026, ambient): the playing row is first on screen, marked by the Fill glyph, the word
     "Playing" and aria-current; it is the row the BAR is on (playing OR paused), not the first queued. */
  const m = await mountBooted();
  const [a, b] = readJson("data/discover.json").items.filter((it) => it.audio_url);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  m.ctx.window.ForayPlayer = { isCurrent: (id) => id === b.id, currentEpisodeId: () => b.id, isPlaying: () => false };
  m.ctx.renderQueue();
  const rows = [...m.view().matchAll(/<article class="([^"]*qp-row[^"]*)" data-lb-q="([^"]*)"([^>]*)>/g)];
  assert.strictEqual(rows.length, 2, "the playing row is listed once, not twice");
  assert.ok(rows[0][1].includes("is-current") && rows[0][3].includes('aria-current="true"'), "the row the bar is on is first and marked, though only paused");
  assert.strictEqual(rows[0][2], m.ctx.esc(b.id), "and it is b, not the first queued");
  assert.ok(!rows[1][1].includes("is-current"), "the other row is not current");
  assert.match(m.view(), /<span class="ag-row-state">Playing<\/span>/, "the Lamp word");
});

test("a queued row and the episode page carry the player's 'Played' / 'NN min left' (audit round 2, honesty-5)", async () => {
  /* Every other episode row had the mark since persona 78; the Up Next row and
     the episode page did not, so a half-finished queued episode looked fresh and
     the mark vanished on the way into its page.
     MUTATION: drop the `o.upnext` allowance for a played row in libQueueRowHtml, or `progHtml` from
     renderEpisode's meta line -> the matching assertion goes red.
     PORTED (Redesign 2026, ambient): the mark is the QueueRow's caption, not a span of its own. */
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
  const rowOf = (id) => { const at = m.view().indexOf(`data-lb-q="${m.ctx.esc(id)}"`); return m.view().slice(at, m.view().indexOf("</article>", at)); };
  assert.match(rowOf(a.id), /class="lb-ell">[^<]*\bPlayed<\/span>/, "the finished queued row says so");
  assert.match(rowOf(b.id), /class="lb-ell">[^<]*\b20 min left<\/span>/, "the half-way queued row says how far");
  m.ctx.renderEpisode(b.id);
  assert.match(m.view(), /ep-caption[^]*?<span class="ep-progress">20 min left<\/span>/, "the episode page keeps the mark");
});

test("an Up Next row with no details says one sentence about THIS page (audit round 2, copy-9)", () => {
  /* It said "Removed from your history — no details saved": not History, and
     nothing was removed — the id is right there in the list.
     MUTATION: restore the old sentence. */
  const m = mount({ seed: { cp_queue: JSON.stringify(["an-id-nothing-can-name"]) } });
  m.state.session = { session_id: "s", episodes: {}, cards: [] };
  m.ctx.renderQueue();
  assert.ok(m.view().includes(m.ctx.esc("4a no longer has this episode's details")), m.view());
  /* The page now ends with Library's History section (its head says "History"), so the sentence is read from the queue's own section. */
  const queueOnly = m.view().slice(0, m.view().indexOf('data-lb-section="history"') < 0 ? undefined : m.view().indexOf('data-lb-section="history"'));
  assert.ok(!/history/i.test(queueOnly), "the sentence does not mention History");
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
  /* MUTATION (run, red): drop `!liveEpisode(id)` from playNextInQueue's first
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
  m.ctx.bindUpNextClear({ querySelectorAll: (sel) => (sel === "#up-next-clear" ? [clear] : []) });
  assert.ok(clear.onClick, "the Clear control is bound by the Up Next page's binder");
  clear.onClick(CLICK);
  assert.deepStrictEqual(m.queueRaw(), ["b"], "everything but the playing row is gone");
  const said = m.body.children.map((c) => c.textContent).filter(Boolean).pop() || "";
  assert.match(said, /Removed 2 episodes from Up Next\./, `the screen reader hears the count: "${said}"`);
});

test("#/queue renders Clear only with two or more rows, and a Play next per row, disabled on the row after the playing one (PQ-02, #762)", () => {
  /* MUTATION (run, red): drop `at === 0` from libMenuItems' Play next (leave
     `!playable`) -> b's Play next is enabled. MUTATION 2: render Clear for any non-empty list -> the one-row page
     shows it.
     PORTED (Redesign 2026, ambient): Play next is an item of the row's menu (the same libMenuItems Library's menu uses),
     not a button on the row; the playing row has no menu at all. Clear is in the page's head. */
  const m = mountQueue(["a", "b", "c"], "a");
  m.ctx.renderQueue();
  const html = m.view();
  const menus = [...html.matchAll(/data-lb-menu="([^"]+)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(menus, ["b", "c"], "a menu per row, none on the playing row");
  const next = (id) => m.ctx.libMenuItems(id).find((i) => i.key === "next").disabled;
  assert.deepStrictEqual([next("b"), next("c")], [true, false], "off on the row already next, on for the one after it");
  assert.ok(html.includes('id="up-next-clear"'), "three rows: Clear is offered");

  const one = mountQueue(["a"], null);
  one.ctx.renderQueue();
  assert.ok(!one.view().includes('id="up-next-clear"'), "one row: no Clear");
  assert.strictEqual(one.ctx.libMenuItems("a").find((i) => i.key === "next").disabled, true, "nothing playing: row 1 is already next");
});

test("#/episode renders Play next beside + Up Next, and its click goes through playNextInQueue (PQ-02, #762)", async () => {
  /* MUTATION (run, red): bind bindUpNext's [data-playnext] to `addToQueue(id)`
     instead of `playNextInQueue(id)` -> the episode lands at the END,
     ["x","y",id], and the order assertion fails. */
  const m = await mountBooted();
  const item = readJson("data/discover.json").items.find((it) => it.audio_url);
  m.ctx.renderEpisode(item.id);
  const html = m.view();
  /* REDESIGN 2026 (ambient Episode page): the page's two queue controls are its own (`data-ep-upnext`, `data-ep-playnext`), bound by
     bindEpisodeActions; the legacy `[data-playnext]` binder in bindUpNext now serves no episode page. */
  const up = html.indexOf(`data-ep-upnext="${m.ctx.esc(item.id)}"`);
  const next = html.indexOf(`data-ep-playnext="${m.ctx.esc(item.id)}"`);
  assert.ok(up >= 0 && next > up, "Play next renders right after Up Next in the episode actions");
  assert.match(html, /data-ep-playnext="[^"]*" aria-label="Play next">/);

  seedPlayable(m, ["x", "y"]);
  m.ctx.lsSet("cp_queue", ["x", "y"]);
  m.ctx.window.ForayPlayer = { currentEpisodeId: () => "x" };
  const pn = fakeButton({ epPlaynext: item.id });
  m.ctx.bindEpisodeActions({ querySelector: (sel) => (sel === "[data-ep-playnext]" ? pn : null) }, item);
  pn.onClick(CLICK);
  assert.deepStrictEqual(m.queueRaw(), ["x", item.id, "y"], "the episode plays right after the one playing");
});
