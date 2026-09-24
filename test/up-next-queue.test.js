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
