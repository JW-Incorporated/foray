/* Library screen (#/library, `docs/ux/foray-mockup.jsx`'s `LibraryScreen`,
 * kanban card t_a1e7a69c).
 *
 * WHAT THIS PROVES, in order:
 *  1. `route()` dispatches `#/library` to `renderLibrary()`, matching the
 *     `#/playlists`/`#/queue` pattern.
 *  2. Saved (`cp_saved`) renders real starred episodes as full, playable rows
 *     — not a summary — because Library is their only page.
 *  3. Saved's empty state is honest when nothing is starred.
 *  4. History (`cp_history`) renders real listened episodes, newest first.
 *  5. History's empty state is honest when nothing has been listened to.
 *  6. Playlists (`cp_playlists`) render as summary rows linking to
 *     `#/playlist/:id`, not embedded detail — and playlists' own empty state
 *     is honest.
 *  7. Up Next (`cp_queue`) renders as a summary row linking to `#/queue`,
 *     same treatment as playlists — and its own empty state is honest.
 *  8. Every link Library renders stays in-app: no interpolated href bypasses
 *     the in-app hash-route/safeUrl composition every other page uses (this
 *     is also covered generally by test/app-security.test.js, pinned here
 *     against this file's own new markup).
 *  9. The Library screen is reachable — linked from the Playlists page
 *     (demoted off the drawer by the founder's later 5-item mandate; same
 *     precedent as Starred Shows).
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test
 * is not evidence until you have broken it".
 *
 * Harness: the same node:vm DOM stub as test/up-next-queue.test.js /
 * test/show-page.test.js, duplicated rather than imported for the same
 * reason those two do — this suite's fixtures are its own.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const INDEX_HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
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
/* 1. ROUTE WIRING                                                       */
/* ==================================================================== */

test("route() dispatches #/library to renderLibrary, matching the #/playlists pattern", () => {
  /* MUTATION: delete the `h === "#/library"` branch from route(). This test
     fails because renderHome (the fallback) runs instead and the view never
     contains Library's page heading. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  m.state.ready = true;

  m.ctx.location.hash = "#/library";
  m.ctx.route();
  assert.ok(m.view().includes("<h2>Library</h2>"), "route() must dispatch to renderLibrary for #/library");
});

/* ==================================================================== */
/* 2 & 3. SAVED SECTION: REAL ROWS, HONEST EMPTY STATE                   */
/* ==================================================================== */

test("Library's Saved section renders every starred episode as a real, playable row", async () => {
  /* MUTATION: read the saved section from anything other than savedMap()
     (e.g. an empty array). The title assertion fails.
     MUTATION 2: render a summary instead of the full row (drop epRow/
     archivedRow). The data-star assertion fails because summary rows
     (libSummaryRow) never carry a star control. */
  const m = await mountBooted();
  const discover = readJson("data/discover.json");
  const item = discover.items.find((it) => it.audio_url);
  assert.ok(item, "fixture assumption: discover.json has at least one playable item");
  m.ctx.toggleStar(item.id);

  m.ctx.renderLibrary();
  const html = m.view();
  assert.ok(html.includes(m.ctx.esc(item.title)), "a saved episode's title must render in Library");
  assert.ok(html.includes(`data-star="${m.ctx.esc(item.id)}"`), "a saved row must still be starrable (it's a real row, not a summary)");
  assert.ok(html.includes(`data-play="${m.ctx.esc(item.id)}"`), "a saved, live episode must be playable in-app");
});

test("Library's Saved section renders an honest empty state when nothing is starred", () => {
  /* MUTATION: drop the `savedRows.length ? ... : <empty state>` ternary.
     With zero saved rows that renders an empty string, so this assertion
     (which requires visible copy) fails rather than passing on an
     accidentally-blank section. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };

  assert.doesNotThrow(() => m.ctx.renderLibrary());
  const html = m.view();
  assert.ok(html.includes("Nothing saved yet"), `expected an honest empty state, got: ${html}`);
});

/* ==================================================================== */
/* 4 & 5. HISTORY SECTION: REAL ROWS NEWEST-FIRST, HONEST EMPTY STATE    */
/* ==================================================================== */

test("Library's History section renders listened episodes, newest first", async () => {
  /* MUTATION: render history in raw pickedHistory() order instead of
     reversed. pickedHistory() appends, so the raw array is oldest-first;
     with the mutation `a` (added first) would come before `b`, and the
     posA < posB assertion below (which expects newest-first: b before a)
     fails. */
  const m = await mountBooted();
  const discover = readJson("data/discover.json");
  const playable = discover.items.filter((it) => it.audio_url);
  assert.ok(playable.length >= 2, "fixture assumption: need at least two playable episodes");
  const [a, b] = playable;

  const history = m.ctx.pickedHistory();
  m.evalIn(`lsSet("cp_history", ${JSON.stringify([a.id, b.id])})`);
  void history;

  m.ctx.renderLibrary();
  const html = m.view();
  const posA = html.indexOf(m.ctx.esc(a.title));
  const posB = html.indexOf(m.ctx.esc(b.title));
  assert.ok(posA >= 0 && posB >= 0, "both listened episode titles must render");
  assert.ok(posB < posA, "the most recently listened episode (b, added second) must render first");
});

test("Library's History section renders an honest empty state with no listening history", () => {
  /* MUTATION: drop the `historyRows.length ? ... : <empty state>` ternary.
     Same shape as the Saved empty-state mutation above. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };

  const html = (() => { m.ctx.renderLibrary(); return m.view(); })();
  assert.ok(html.includes("No listening history yet"), `expected an honest empty state, got: ${html}`);
});

/* ==================================================================== */
/* 6. PLAYLISTS SECTION: SUMMARY ROWS, LINKED NOT EMBEDDED               */
/* ==================================================================== */

test("Library's Playlists section renders a summary row per playlist, linking to #/playlist/:id", async () => {
  /* MUTATION: embed resolveParts(p) rows instead of a summary link (i.e.
     replicate renderPlaylistDetail's row list inline). The href assertion
     fails because there would be no `#/playlist/<id>` anchor — only ep-rows
     with no such href. */
  const m = await mountBooted({
    cp_playlists: JSON.stringify([
      { id: "pl-1", title: "Test Playlist", items: [], created: new Date().toISOString() },
    ]),
  });
  m.ctx.renderLibrary();
  const html = m.view();
  assert.ok(html.includes('href="#/playlist/pl-1"'), "a playlist must summary-link to its own #/playlist/:id page");
  assert.ok(html.includes(m.ctx.esc("Test Playlist")), "the playlist's title must render");
});

test("Library's Playlists section renders an honest empty state with no playlists", async () => {
  /* MUTATION: drop the `allPlaylists.length ? ... : <empty state>` ternary. */
  const m = await mountBooted({ cp_playlists: "[]" });
  m.ctx.renderLibrary();
  const html = m.view();
  assert.ok(html.includes("No playlists yet"), `expected an honest empty state, got: ${html}`);
});

/* ==================================================================== */
/* 7. UP NEXT SECTION: SUMMARY ROW, LINKED NOT EMBEDDED                  */
/* ==================================================================== */

test("Library's Up Next section renders a single summary row linking to #/queue", async () => {
  /* MUTATION: render queueRows() inline instead of one summary link (the
     same "linked, not embedded" rule as Playlists). The href assertion
     fails because there would be no `#/queue` anchor. */
  const m = await mountBooted();
  m.ctx.addToQueue("ep-a");
  m.ctx.addToQueue("ep-b");
  m.ctx.renderLibrary();
  const html = m.view();
  assert.ok(html.includes('href="#/queue"'), "Up Next must summary-link to #/queue");
  assert.ok(html.includes("2 queued"), "the summary must report the real queued count");
});

test("Library's Up Next section renders an honest empty state with nothing queued", async () => {
  /* MUTATION: drop the `queued.length ? ... : <empty state>` ternary. */
  const m = await mountBooted();
  m.ctx.renderLibrary();
  const html = m.view();
  assert.ok(html.includes("Nothing in Up Next yet"), `expected an honest empty state, got: ${html}`);
});

/* ==================================================================== */
/* 8. EVERY LINK STAYS IN-APP                                            */
/* ==================================================================== */

test("Library renders no external link-out that bypasses the app's own row/summary controls", async () => {
  /* MUTATION: add a bare `<a href="https://...">` anywhere in renderLibrary
     for a summary/section (e.g. a "share" or "view on the web" link). This
     assertion greps the rendered markup for any http(s) href and fails if
     one appears — Library's only allowed external surface is the SAME
     archivedRow/epRow degradation (an aged-out episode's listening-app link)
     every other page already uses, which itself goes through safeUrl(). */
  const m = await mountBooted({
    cp_playlists: JSON.stringify([
      { id: "pl-1", title: "Test Playlist", items: [], created: new Date().toISOString() },
    ]),
  });
  m.ctx.addToQueue("ep-a");
  const discover = readJson("data/discover.json");
  const item = discover.items.find((it) => it.audio_url);
  m.ctx.toggleStar(item.id);

  m.ctx.renderLibrary();
  const html = m.view();
  const externalHrefs = (html.match(/href="https?:\/\/[^"]*"/g) || [])
    .filter((h) => !h.includes("target=")); // archivedRow/epRow's own out-links are covered by app-security.test.js
  assert.deepStrictEqual(externalHrefs, [], "Library's own summary/section markup must not introduce a bare external href");
});

/* ==================================================================== */
/* 9. REACHABLE FROM THE APP — LINKED OFF THE PLAYLISTS PAGE             */
/* ==================================================================== */

/* Fable ruling (2026-09-06): the founder's later 2026 five-item drawer
   mandate (test/home-information-architecture.test.js) floors the drawer
   at exactly Home/Shows/Playlists/Forays/Up Next, so Library is off the
   drawer -- same precedent as Starred Shows, which left the menu without
   leaving the app (test/home-information-architecture.test.js, "Starred
   Shows is NOT dropped"). As an interim measure this card's Playlists
   page carried its own `page-link-row` to #/library; now that U-02's
   four-tab bar (Home/Search/Create/Library) has landed with a real
   Library tab wired to #/library (test/tab-bar.test.js, "the Library
   tab's href is #/library"), the interim link is redundant with it --
   but NOT removable outright: cp_ui_v2 (and therefore the tab bar) is
   off by default on web (only on by default for the native shell/
   TestFlight per U-02), so a flag-off web listener has no tab bar at
   all. renderPlaylists() now shows the interim link only when the tab
   bar is not rendering (`!ui2On()`), so #/library stays reachable for
   both cohorts without a duplicate link when the tab bar is present. */
test("Library stays reachable in both cohorts — the Playlists link when the tab bar is off, the tab bar when it's on", () => {
  /* MUTATION: drop the `!ui2On()` guard (always/never show the interim
     link), or point either entry point's href at anything other than
     #/library.
     NOTE: this suite's mount() uses the flat by-id DOM stub (see the file
     header), whose querySelector/querySelectorAll always return null/[] —
     unlike test/tab-bar.test.js's real DOM harness. renderTabBar() still
     appends the real bar element to document.body via body.append(), so
     it is found by walking body.children directly instead. */
  // Flag off: the tab bar does not render, so the interim link must.
  const off = mount();
  off.state.catalog = { shows: [] };
  off.state.discover = { items: [] };
  off.state.taxonomy = { nodes: [] };
  off.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  off.state.cardSlots = [];
  off.state.ready = true;
  off.ctx.renderPlaylists();
  assert.ok(
    /<a class="page-link-row" href="#\/library">/.test(off.view()),
    "with cp_ui_v2 off, the Playlists page must carry the interim link to #/library"
  );
  assert.strictEqual(off.body.children.find((el) => el.id === "tab-bar"), undefined,
    "with cp_ui_v2 off, no tab bar should exist");

  // Flag on: the tab bar renders and owns the Library entry point instead.
  const on = mount({ seed: { cp_ui_v2: "true" } });
  on.state.catalog = { shows: [] };
  on.state.discover = { items: [] };
  on.state.taxonomy = { nodes: [] };
  on.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  on.state.cardSlots = [];
  on.state.ready = true;
  on.ctx.renderPlaylists();
  assert.ok(
    !/<a class="page-link-row" href="#\/library">/.test(on.view()),
    "with cp_ui_v2 on, the Playlists page must not duplicate the tab bar's #/library link"
  );
  on.evalIn("renderTabBar();");
  const bar = on.body.children.find((el) => el.id === "tab-bar");
  assert.ok(bar, "the tab bar must exist when cp_ui_v2 is on");
  const lib = bar.children.find((a) => a.dataset.tabKey === "library");
  assert.ok(lib, "a library tab must exist");
  assert.strictEqual(lib.href, "#/library");
});
