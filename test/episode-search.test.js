/* Episodes section under Shows search (S-07, kanban t_6baccaa0):
 * `renderEpisodeSearchResults` in app.js, wired into `renderShowSearchResults`.
 *
 * Harness: the same node:vm DOM-stub pattern test/show-page.test.js uses,
 * duplicated per that file's own stated convention (a shared harness module
 * is a bigger refactor than this card's scope).
 *
 * WHAT THIS PROVES, in order:
 *  1. A successful api/episodes/search response renders an "Episodes"
 *     section with one ep-row per result.
 *  2. `source` including "apple" captions the section "from Apple's index";
 *     a result with source not including "apple" (e.g. show-scoped/live)
 *     does not add that caption.
 *  3. An empty result list renders nothing (hidden), not an empty section
 *     or a broken state — this repo's "absence is a real state" rule.
 *  4. Offline (`navigator.onLine === false`) skips the fetch entirely and
 *     renders nothing, rather than hanging on a request that will fail.
 *  5. A superseded (stale) response is dropped — the token guard.
 *  6. Results are playable exactly like a curated ep-row (audio_url reaches
 *     playBtn via snapshot()).
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

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
  "sh-note", "sh-results", "ep-search-results", "browse-all-link",
];

function mount({ fetchImpl, online = true } = {}) {
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    // Boot fetches (data/*.json triggered by init() at module load) never
    // resolve, exactly like show-page.test.js's unbooted mount() — this
    // suite doesn't need a real catalogue, only the episode-search fetch,
    // which the test-specific fetchImpl below distinguishes by URL.
    fetch: (url) => {
      if (fetchImpl) return fetchImpl(url);
      return new Promise(() => {});
    },
    localStorage: {
      get length() { return 0; },
      key: () => null, getItem: () => null, setItem() {}, removeItem() {},
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
    navigator: { userAgent: "node", onLine: online },
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

  return {
    ctx, byId,
    state: vm.runInContext("state", ctx),
    container: () => byId.get("ep-search-results"),
  };
}

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

/** Routes `api/episodes/search` and `api/shows/search` calls to the given
 * handlers; anything else (data/*.json boot fetches) never resolves, same
 * as show-page.test.js's unbooted harness — this suite never calls init(). */
function apiRouter({ episodes, shows } = {}) {
  return (url) => {
    const u = String(url);
    if (u.includes("api/episodes/search")) return episodes ? episodes(u) : jsonResponse({ episodes: [], source: [] });
    if (u.includes("api/shows/search")) return shows ? shows(u) : jsonResponse({ shows: [] });
    return new Promise(() => {});
  };
}

/* ==================================================================== */

test("a successful episode search renders one ep-row per result under an Episodes heading", async () => {
  const m = mount({
    fetchImpl: apiRouter({
      episodes: () => jsonResponse({
        query: "geology",
        episodes: [
          { show_id: "geology-bites", show_title: "Geology Bites", title: "Ep One", guid: "g1", audio_url: "https://cdn.test/g1.mp3", duration_seconds: 600 },
          { show_id: "geology-bites", show_title: "Geology Bites", title: "Ep Two", guid: "g2", audio_url: "https://cdn.test/g2.mp3", duration_seconds: 700 },
        ],
        source: ["apple"],
        degraded: false,
        error: null,
      }),
    }),
  });

  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('geology')", m.ctx);
  await flush();

  const html = m.container().innerHTML;
  assert.ok(html.includes("Episodes"), "must render an Episodes heading");
  assert.ok(html.includes("Ep One") && html.includes("Ep Two"), "must render both episode titles");
  assert.strictEqual((html.match(/class="ep-row/g) || []).length, 2, "must render exactly one ep-row per result");
  assert.strictEqual(m.container().hidden, false);
});

test('source including "apple" captions the section "from Apple\'s index"; a non-apple source does not', async () => {
  /* MUTATION: drop the `fromApple ?` conditional and always append the
     caption (or never append it). Either direction makes one of these two
     assertions fail. */
  const appleRun = mount({
    fetchImpl: apiRouter({
      episodes: () => jsonResponse({ episodes: [{ show_id: "s", title: "T", guid: "g", audio_url: "https://cdn.test/a.mp3" }], source: ["apple"] }),
    }),
  });
  appleRun.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('x')", appleRun.ctx);
  await flush();
  assert.ok(appleRun.container().innerHTML.includes("from Apple's index"));

  const liveRun = mount({
    fetchImpl: apiRouter({
      episodes: () => jsonResponse({ episodes: [{ show_id: "s", title: "T", guid: "g", audio_url: "https://cdn.test/a.mp3" }], source: ["live"] }),
    }),
  });
  liveRun.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('x')", liveRun.ctx);
  await flush();
  assert.ok(!liveRun.container().innerHTML.includes("from Apple's index"),
    "a live (show-scoped) source must not carry the Apple caption");
});

test("an empty episode result list renders nothing — hidden, not an empty section", async () => {
  /* MUTATION: drop the `if (!episodes.length)` early return so the section
     header renders even with zero rows. This fails on the hidden assertion. */
  const m = mount({
    fetchImpl: apiRouter({ episodes: () => jsonResponse({ episodes: [], source: [] }) }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('nomatch')", m.ctx);
  await flush();
  assert.strictEqual(m.container().hidden, true);
  assert.strictEqual(m.container().innerHTML, "");
});

test("offline never issues the episode-search fetch and renders nothing", async () => {
  /* MUTATION: remove the navigator.onLine guard. fetchCalled would flip true
     and this fails. */
  let fetchCalled = false;
  const m = mount({
    online: false,
    fetchImpl: apiRouter({
      episodes: () => { fetchCalled = true; return jsonResponse({ episodes: [], source: [] }); },
    }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('geology')", m.ctx);
  await flush();
  assert.strictEqual(fetchCalled, false, "must not call the episode-search endpoint while offline");
  assert.strictEqual(m.container().hidden, true);
});

test("a superseded (stale) episode-search response is dropped", async () => {
  /* Two overlapping queries; the first's response resolves AFTER the second
     starts. The stale response must never overwrite the fresher one.
     MUTATION: drop the `myToken !== showSearchToken` guard inside the
     episode-search .then(). The stale "first" text would win and this fails. */
  let resolveFirst;
  const firstPromise = new Promise((r) => { resolveFirst = r; });
  let call = 0;
  const m = mount({
    fetchImpl: apiRouter({
      episodes: () => {
        call++;
        if (call === 1) {
          return firstPromise.then(() => ({ ok: true, status: 200, json: async () => ({ episodes: [{ show_id: "s", title: "STALE", guid: "g1", audio_url: "https://cdn.test/a.mp3" }], source: [] }) }));
        }
        return jsonResponse({ episodes: [{ show_id: "s", title: "FRESH", guid: "g2", audio_url: "https://cdn.test/b.mp3" }], source: [] });
      },
    }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('first')", m.ctx);
  vm.runInContext("renderShowSearchResults('second')", m.ctx);
  await flush();
  resolveFirst();
  await flush();

  const html = m.container().innerHTML;
  assert.ok(html.includes("FRESH"), "the newer query's results must be shown");
  assert.ok(!html.includes("STALE"), "the superseded query's results must never render");
});

test("an episode result is playable exactly like a curated row (audio_url reaches the play button)", async () => {
  /* MUTATION: drop `audio_url: ep.audio_url` from the snapshot() call inside
     renderEpisodeSearchResults. playBtn() would then render nothing for the
     row (see app.js's own rule: no audio_url -> no in-app play button) and
     this fails. */
  const m = mount({
    fetchImpl: apiRouter({
      episodes: () => jsonResponse({ episodes: [{ show_id: "s", title: "Playable Ep", guid: "g1", audio_url: "https://cdn.test/play.mp3", duration_seconds: 120 }], source: ["apple"] }),
    }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('play')", m.ctx);
  await flush();
  const html = m.container().innerHTML;
  assert.ok(html.includes('class="play-btn"'), "a result with audio_url must render an in-app play button");
});
