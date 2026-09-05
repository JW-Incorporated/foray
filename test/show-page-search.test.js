/* S-06 (kanban t_be4c1793, source: 4a-shows-pipeline-plan.md) — the in-page
 * episode search box on the show page: a real requirement from Wyatt's
 * original ask, not an extra. S-07 (the scoped full-catalogue search
 * endpoint) hasn't shipped yet, so this box runs a local-filter fallback
 * against whatever full-catalogue pages have loaded — labelled explicitly
 * as "searching loaded episodes" per the card's own instruction, rather
 * than silently filtering a partial list and implying completeness.
 *
 * WHAT THIS PROVES, in order:
 *  1. The search box stays hidden until at least one full-catalogue page
 *     has loaded (nothing to search yet, and the curated-pool episodes are
 *     already all on-screen).
 *  2. Typing a query filters the rendered list to matching titles/
 *     descriptions among the episodes loaded so far.
 *  3. While the full list is NOT fully loaded, the search note explicitly
 *     says "searching loaded episodes" (or equivalent honest scope
 *     language) — never implies it searched the whole show. This is the
 *     partial-list-honesty rule applied to search specifically.
 *  4. Once the full list IS fully loaded (no next_cursor left), the search
 *     note drops the partial-scope hedge and just reports the match count.
 *  5. A query with a real match on a page beyond what's loaded (i.e. "page
 *     12") is only findable after that page is loaded — the box does not
 *     fabricate a match it hasn't fetched.
 *  6. Clearing the query restores the full loaded list.
 *
 * Harness: same node:vm DOM stub + cursor-aware fetchImpl queue as
 * test/show-page-pagination.test.js, duplicated for the same fixture-scoped
 * reasons every other show-page suite gives.
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
  "sh-note", "sh-results",
];

function makeButtonEl() {
  const el = makeEl("button");
  const handlers = {};
  el.addEventListener = (type, fn) => { handlers[type] = fn; };
  el.click = () => { if (handlers.click) handlers.click(); };
  return el;
}

/* A real, value-holding, event-recording input/form pair so typing + submit
   drive renderShow's actual listeners rather than no-op stubs. */
function makeSearchInputEl() {
  const el = makeEl("input");
  const handlers = {};
  el.addEventListener = (type, fn) => { handlers[type] = fn; };
  el.type = (v) => { el.value = v; if (handlers.input) handlers.input(); };
  return el;
}
function makeSearchFormEl() {
  const el = makeEl("form");
  const handlers = {};
  el.addEventListener = (type, fn) => { handlers[type] = fn; };
  el.submit = () => { if (handlers.submit) handlers.submit({ preventDefault() {} }); };
  return el;
}

function makeViewEl() {
  const el = makeEl("div");
  el.id = "view";
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html || ""; },
    set(html) {
      this._html = html;
      this._countText = extractAttr(html, "data-show-count");
      this._hasEpisodesContainer = html.includes("data-show-episodes");
      this._hasMoreWrap = html.includes("data-show-more-wrap");
      this._hasSearchBox = html.includes("data-show-ep-search");
      this._searchBoxInitiallyHidden = /data-show-ep-search\s+hidden/.test(html);
    },
  });
  el.querySelector = (sel) => {
    const s = String(sel);
    if (s.includes("[data-show-episodes]")) {
      if (!el._hasEpisodesContainer) return null;
      if (!el._episodesContainerRef) {
        const container = makeEl("div");
        Object.defineProperty(container, "innerHTML", {
          get() { return this._innerHtml || ""; },
          set(html) { this._innerHtml = html; },
        });
        el._episodesContainerRef = container;
      }
      return el._episodesContainerRef;
    }
    if (s.includes("[data-show-count]")) {
      if (el._countText === null) return null;
      if (!el._countLabelRef) {
        const label = makeEl("p");
        Object.defineProperty(label, "textContent", {
          get() { return el._countLabelText ?? ""; },
          set(v) { el._countLabelText = v; },
        });
        el._countLabelRef = label;
      }
      return el._countLabelRef;
    }
    if (s.includes("[data-show-more-wrap]")) {
      if (!el._hasMoreWrap) return null;
      if (!el._moreWrapRef) {
        const wrap = makeEl("div");
        Object.defineProperty(wrap, "innerHTML", {
          get() { return this._innerHtml || ""; },
          set(html) {
            this._innerHtml = html;
            wrap._btnRef = html.includes("data-show-more") ? makeButtonEl() : null;
          },
        });
        wrap.querySelector = (innerSel) => (String(innerSel).includes("[data-show-more]") ? wrap._btnRef : null);
        el._moreWrapRef = wrap;
      }
      return el._moreWrapRef;
    }
    if (s.includes("[data-show-more]")) {
      return el._moreWrapRef ? el._moreWrapRef._btnRef : null;
    }
    if (s.includes("[data-show-ep-search-form]")) {
      if (!el._hasSearchBox) return null;
      if (!el._searchFormRef) el._searchFormRef = makeSearchFormEl();
      return el._searchFormRef;
    }
    if (s.includes("[data-show-ep-search-input]")) {
      if (!el._hasSearchBox) return null;
      if (!el._searchInputRef) el._searchInputRef = makeSearchInputEl();
      return el._searchInputRef;
    }
    if (s.includes("[data-show-ep-search-note]")) {
      if (!el._hasSearchBox) return null;
      if (!el._searchNoteRef) {
        const note = makeEl("p");
        Object.defineProperty(note, "textContent", {
          get() { return el._searchNoteText ?? ""; },
          set(v) { el._searchNoteText = v; },
        });
        el._searchNoteRef = note;
      }
      return el._searchNoteRef;
    }
    if (s.includes("[data-show-ep-search]")) {
      if (!el._hasSearchBox) return null;
      if (!el._searchWrapRef) {
        const wrap = makeEl("div");
        wrap.hidden = el._searchBoxInitiallyHidden;
        el._searchWrapRef = wrap;
      }
      return el._searchWrapRef;
    }
    return null;
  };
  return el;
}

function extractAttr(html, attr) {
  return html.includes(attr) ? "" : null;
}

function mount({ responses = [], fetchImpl = null, searchImpl = null } = {}) {
  const viewEl = makeViewEl();
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = id === "view" ? viewEl : makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");
  const calls = [];
  const searchCalls = [];

  const routedFetch = (url) => {
    if (String(url).includes("api/episodes/search")) {
      searchCalls.push(String(url));
      if (searchImpl) return searchImpl(url);
      // Default: endpoint unreachable — exercises the fallback path unless
      // a test supplies its own searchImpl for the "scoped" happy path.
      return Promise.reject(new Error("no searchImpl configured"));
    }
    if (String(url).includes("api/shows/")) {
      calls.push(String(url));
      if (fetchImpl) return fetchImpl(url);
      const next = responses.shift();
      if (!next) return Promise.resolve({ ok: true, json: async () => ({ episodes: [] }) });
      if (next.reject) return Promise.reject(new Error(next.reject));
      return Promise.resolve({ ok: next.ok !== false, status: next.status ?? 200, json: async () => next.body });
    }
    return new Promise(() => {});
  };

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: routedFetch,
    localStorage: {
      get length() { return 0; },
      key: () => null, getItem: () => null, setItem() {}, removeItem() {},
    },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => {
        const s = String(sel);
        if (s.startsWith("#")) {
          const rest = s.slice(1);
          const spaceIdx = rest.indexOf(" ");
          if (spaceIdx === -1) return byId.get(rest) ?? null;
          const rootId = rest.slice(0, spaceIdx);
          const rootEl = byId.get(rootId);
          if (!rootEl) return null;
          return rootEl.querySelector(rest.slice(spaceIdx + 1));
        }
        return null;
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

  ctx.state = vm.runInContext("state", ctx);
  return { ctx, viewEl, calls, searchCalls };
}

async function flushMicrotasks(n = 50) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/* renderShow's search input is debounced 250ms (S-06/S-07: avoids firing a
   live-feed-backed network request per keystroke) — tests that type into
   the box must wait past that window before asserting on the result. */
async function waitForSearchDebounce() {
  await new Promise((r) => setTimeout(r, 300));
  await flushMicrotasks();
}

function seedShowAndPool(ctx, { show, discoverItems = [] } = {}) {
  ctx.state.catalog = { shows: [show] };
  ctx.state.discover = { items: discoverItems };
  ctx.state.taxonomy = { nodes: [] };
  ctx.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
}

function makeEpisodes(n, { offset = 0, titles = null } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    guid: `g${offset + i}`,
    title: titles && titles[i] ? titles[i] : `Episode ${offset + i}`,
    description_text: "",
    audio_url: `https://cdn.example.com/${offset + i}.mp3`,
    duration_seconds: 60,
    published_at: null,
  }));
}

function pageResponse(episodes, { cursor = null } = {}) {
  return { body: { episodes, next_cursor: cursor, stale: false, error: null } };
}

test("the search box stays hidden until at least one full-catalogue page has loaded", async () => {
  /* MUTATION: drop the `hidden` attribute from the search box template.
     This assertion fails because the box would be visible before page 1
     resolves, contradicting "nothing to search yet". */
  const m = mount({ fetchImpl: () => new Promise(() => {}) }); // never resolves
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  const wrap = m.viewEl.querySelector("[data-show-ep-search]");
  assert.ok(wrap, "search box element must exist in the initial render");
  assert.strictEqual(wrap.hidden, true, "search box must start hidden before any full-catalogue page has loaded");
});

test("typing a query filters the rendered list to loaded episodes matching title or description (fallback path, S-07 unreachable)", async () => {
  /* MUTATION: drop the `.filter(...)` in filterLoadedEpisodes and return
     loadedRaw unconditionally. This assertion fails because both matching
     and non-matching episodes would remain in the container.

     mount()'s default searchImpl rejects every api/episodes/search call,
     so this exercises the fallback local-filter path deliberately — the
     scoped-path test below covers S-07 answering successfully. */
  const episodes = makeEpisodes(5, { titles: ["Alpha Show Kickoff", "Bravo Update", "Charlie Deep Dive", "Delta Recap", "Echo Finale"] });
  const m = mount({ responses: [pageResponse(episodes, { cursor: null })] });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const input = m.viewEl.querySelector("[data-show-ep-search-input]");
  input.type("deep dive");
  await waitForSearchDebounce();

  const container = m.viewEl.querySelector("[data-show-episodes]");
  assert.ok(container.innerHTML.includes("Charlie Deep Dive"), "matching episode must remain visible");
  assert.ok(!container.innerHTML.includes("Alpha Show Kickoff"), "non-matching episode must be filtered out");
  assert.ok(!container.innerHTML.includes("Bravo Update"), "non-matching episode must be filtered out");
});

test("a query answered by S-07's scoped endpoint renders those results and reports an unhedged match count", async () => {
  /* The primary, non-fallback path: S-07 (api/episodes/search.ts) searches
     the show's FULL feed server-side and returns real results, independent
     of how many pages this render has paged in via fetchShowEpisodes.

     MUTATION: skip calling searchShowEpisodesScoped and always fall
     through to the local filter. This assertion fails because the scoped-
     only episode (never in `loaded`) would not appear, and the note would
     carry the fallback's "loaded episodes only" hedge instead of a bare
     count. */
  const loadedPage = makeEpisodes(3, { titles: ["Local A", "Local B", "Local C"] });
  const m = mount({
    responses: [pageResponse(loadedPage, { cursor: "cursor-1" })],
    searchImpl: () => Promise.resolve({
      ok: true,
      json: async () => ({
        query: "scoped only",
        show: "show-a",
        episodes: [{ guid: "far-away", title: "Scoped Only Episode", description_text: "", audio_url: "https://cdn.example.com/far.mp3", duration_seconds: 60, published_at: null }],
        source: ["live"],
        degraded: false,
        error: null,
      }),
    }),
  });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const input = m.viewEl.querySelector("[data-show-ep-search-input]");
  input.type("scoped only");
  await waitForSearchDebounce();

  assert.ok(m.searchCalls.length >= 1, "must call S-07's scoped endpoint");
  assert.match(m.searchCalls[0], /api\/episodes\/search\?show=show-a&q=scoped(%20|\+)only/, `must scope the search request to this show, got: ${m.searchCalls[0]}`);

  const container = m.viewEl.querySelector("[data-show-episodes]");
  assert.ok(container.innerHTML.includes("Scoped Only Episode"), "must render the scoped-search result even though it was never paged in via fetchShowEpisodes");
  assert.ok(!container.innerHTML.includes("Local A"), "must not mix in unrelated loaded episodes for a scoped-search result set");

  const note = m.viewEl.querySelector("[data-show-ep-search-note]");
  assert.doesNotMatch(note.textContent, /loaded episodes only/i, "a real scoped-search result must never carry the partial-list fallback hedge");
  assert.match(note.textContent, /1 episode found/i, `note must report the scoped result count plainly, got: "${note.textContent}"`);
});

test('while S-07 is unreachable and the list is not fully loaded, the search note says it is searching loaded episodes only', async () => {
  /* Direct pin of the card's own instruction: label the local-filter
     fallback "searching loaded episodes" (or equivalent honest scope
     language) rather than implying a full-catalogue search — this is the
     state the box is in whenever S-07 fails/degrades for the typed query.

     MUTATION: use the `fullyLoaded` branch's wording unconditionally. This
     assertion fails because the note would drop the "loaded episodes"/
     partial-scope language even with a next_cursor still pending. */
  const episodes = makeEpisodes(100, { titles: Array.from({ length: 100 }, (_, i) => (i === 42 ? "Findable Needle Episode" : `Filler ${i}`)) });
  const m = mount({ responses: [pageResponse(episodes, { cursor: "cursor-1" })] });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const input = m.viewEl.querySelector("[data-show-ep-search-input]");
  input.type("needle");
  await waitForSearchDebounce();

  const note = m.viewEl.querySelector("[data-show-ep-search-note]");
  assert.match(note.textContent, /loaded episodes/i, `note must state it is scoped to loaded episodes while pages remain unfetched, got: "${note.textContent}"`);
  assert.match(note.textContent, /1 of the full list loaded so far|100 of the full list/i, `note must state how much of the full list is loaded, got: "${note.textContent}"`);
});

test("once the full list is fully loaded, the fallback search note drops the partial-scope hedge", async () => {
  /* MUTATION: never flip the note's wording once fullyLoaded is true (keep
     always returning the partial-scope sentence). This assertion fails
     because the note would still say "searching loaded episodes only" after
     the whole show has loaded. */
  const episodes = makeEpisodes(20, { titles: Array.from({ length: 20 }, (_, i) => (i === 5 ? "The One True Match" : `Other ${i}`)) });
  const m = mount({ responses: [pageResponse(episodes, { cursor: null })] });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const input = m.viewEl.querySelector("[data-show-ep-search-input]");
  input.type("true match");
  await waitForSearchDebounce();

  const note = m.viewEl.querySelector("[data-show-ep-search-note]");
  assert.doesNotMatch(note.textContent, /loaded episodes only/i, `note must drop the partial-scope hedge once the full list has loaded, got: "${note.textContent}"`);
  assert.match(note.textContent, /1 match/i, `note must still report the match count, got: "${note.textContent}"`);
});

test('a query matching only a not-yet-loaded page ("page 12"), with S-07 unreachable, is unfindable until that page loads, then finds it', async () => {
  /* Pins the card's own acceptance criterion phrasing: "the box finds an
     episode on page 12". Simulated here with two pages (rather than
     fetching 12 real pages) — the mechanism under test (the fallback path
     only considers `loaded`) is identical regardless of page count. S-07
     is unreachable in this test (mount()'s default searchImpl) so the
     fallback path is what's exercised, matching the card's own instruction
     to ship the local-filter fallback for exactly this scenario.

     MUTATION: have filterLoadedEpisodes search some global/cached episode
     list instead of the `loaded` array passed in. This assertion fails
     because the page-2-only episode would be findable before page 2 loads. */
  const page1 = makeEpisodes(100, { titles: Array.from({ length: 100 }, (_, i) => `Common Topic ${i}`) });
  const page2 = makeEpisodes(20, { offset: 100, titles: ["Deep Cut On Page Two", ...Array.from({ length: 19 }, (_, i) => `Later Topic ${i}`)] });
  const m = mount({
    responses: [pageResponse(page1, { cursor: "cursor-1" }), pageResponse(page2, { cursor: null })],
  });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const input = m.viewEl.querySelector("[data-show-ep-search-input]");
  input.type("deep cut on page two");
  await waitForSearchDebounce();

  let container = m.viewEl.querySelector("[data-show-episodes]");
  assert.ok(!container.innerHTML.includes("Deep Cut On Page Two"), "must not find an episode that hasn't loaded yet");

  const btn = m.viewEl.querySelector("[data-show-more]");
  assert.ok(btn, "Show more control must be present to load page 2");
  btn.click();
  await flushMicrotasks();

  container = m.viewEl.querySelector("[data-show-episodes]");
  assert.ok(container.innerHTML.includes("Deep Cut On Page Two"), "episode must be findable once its page has loaded");
});

test("clearing the query restores the full loaded list", async () => {
  const episodes = makeEpisodes(3, { titles: ["Alpha", "Bravo", "Charlie"] });
  const m = mount({ responses: [pageResponse(episodes, { cursor: null })] });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const input = m.viewEl.querySelector("[data-show-ep-search-input]");
  input.type("alpha");
  await waitForSearchDebounce();
  let container = m.viewEl.querySelector("[data-show-episodes]");
  assert.ok(!container.innerHTML.includes("Bravo"), "sanity: filtered list excludes Bravo");

  input.type("");
  await waitForSearchDebounce();
  container = m.viewEl.querySelector("[data-show-episodes]");
  assert.ok(container.innerHTML.includes("Alpha") && container.innerHTML.includes("Bravo") && container.innerHTML.includes("Charlie"), "clearing the query must restore every loaded episode");
});
