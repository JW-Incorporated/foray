/* Stage 3b of docs/show-pages-plan.md — full per-show episode list fetched
 * on demand from the backend endpoint (kanban card t_567b570f), replacing
 * the curated discover-pool ceiling (median ~7 episodes) that Stage 1
 * shipped. See backend/src/catalog/ for the ingestion/storage side; this
 * suite covers only the client wiring in app.js.
 *
 * WHAT THIS PROVES, in order:
 *  1. renderShow() renders the curated pool immediately (never a blank page
 *     while the full-catalogue fetch is in flight), then swaps in the full
 *     list once the endpoint responds.
 *  2. A fetch failure (network error or non-2xx) degrades to the
 *     already-rendered curated pool, never a blank page or infinite spinner
 *     — Stage 3's explicit acceptance criterion.
 *  3. Every full-catalogue episode row carries a real, playable audio_url
 *     (playBtn renders) — no link-out for an episode this endpoint returned.
 *  4. A `stale: true` response is surfaced as a plain-English note, not
 *     hidden.
 *
 * Harness: same node:vm DOM stub as test/show-page.test.js, duplicated for
 * the same reason that file gives (harness is fixture-scoped, not a shared
 * module).
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

/* A minimal but real "view" element that supports querySelector so
   `$("#view [data-show-episodes]")`-style lookups inside renderShow's async
   continuation actually find the nodes it wrote via innerHTML — the plain
   makeEl() stub returns null for every querySelector call, which would make
   every assertion in this file vacuously fail to find its target.

   S-06 (kanban t_be4c1793) extended this with the "Show more" button wrap,
   the count label already handled, and the in-page episode search box —
   each parsed out of the last innerHTML write the same lazy way the
   original two attributes were, rather than a real DOM/JSDOM dependency. */
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
            this._hasBtn = html.includes("data-show-more");
          },
        });
        wrap.querySelector = (innerSel) => {
          if (String(innerSel).includes("[data-show-more]") && wrap._hasBtn) {
            if (!wrap._btnRef) wrap._btnRef = makeEl("button");
            return wrap._btnRef;
          }
          return null;
        };
        el._moreWrapRef = wrap;
      }
      return el._moreWrapRef;
    }
    // Bare `[data-show-more]` (not `-wrap`): renderShow's loadNextPage looks
    // this up directly (`$("#view [data-show-more]")`) rather than through
    // the wrap element, to grab the button after a click already fired.
    // Delegates to the same wrap-tracked button reference so both lookup
    // paths see the identical (disable/relabel-able) element.
    if (s.includes("[data-show-more]")) {
      if (!el._hasMoreWrap || !el._moreWrapRef || !el._moreWrapRef._hasBtn) return null;
      if (!el._moreWrapRef._btnRef) el._moreWrapRef._btnRef = makeEl("button");
      return el._moreWrapRef._btnRef;
    }
    if (s.includes("[data-show-ep-search-form]")) {
      if (!el._hasSearchBox) return null;
      if (!el._searchFormRef) el._searchFormRef = makeEl("form");
      return el._searchFormRef;
    }
    if (s.includes("[data-show-ep-search-input]")) {
      if (!el._hasSearchBox) return null;
      if (!el._searchInputRef) el._searchInputRef = makeEl("input");
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
      if (!el._searchWrapRef) el._searchWrapRef = makeEl("div");
      return el._searchWrapRef;
    }
    return null;
  };
  return el;
}

function extractAttr(html, attr) {
  return html.includes(attr) ? "" : null;
}

function mount({ fetchImpl = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) } = {}) {
  const viewEl = makeViewEl();
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = id === "view" ? viewEl : makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  /* app.js calls init() unconditionally at module load (bottom of the
     file), which itself calls fetch() for data/session.json and friends.
     Routing every non-episodes-endpoint request to a never-resolving
     promise keeps init() permanently pending — mirroring show-page.test.js's
     `boot: false` mode — so it can never race renderShow()'s own fetch and
     overwrite #view with "Couldn't load 4a" mid-test. */
  const routedFetch = (url, opts) => {
    if (String(url).includes("api/shows/")) return fetchImpl(url, opts);
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
  return { ctx, viewEl };
}

async function flushMicrotasks(n = 50) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

function seedShowAndPool(ctx, { show, discoverItems = [] } = {}) {
  ctx.state.catalog = { shows: [show] };
  ctx.state.discover = { items: discoverItems };
  ctx.state.taxonomy = { nodes: [] };
  ctx.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
}

test("renderShow renders the curated pool synchronously, before the full-catalogue fetch resolves", () => {
  /* MUTATION: make renderShow await fetchShowEpisodes before its first
     innerHTML write. This assertion fails because the view is empty at the
     point renderShow() returns (a genuinely blank page while loading). */
  const m = mount({ fetchImpl: () => new Promise(() => {}) }); // never resolves
  const show = { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] };
  seedShowAndPool(m.ctx, { show, discoverItems: [{ id: "a--1", show: "Show A", title: "Curated Ep", audio_url: "https://cdn.example.com/a.mp3" }] });

  m.ctx.renderShow("show-a");
  const html = m.viewEl.innerHTML;
  assert.ok(html.includes("Curated Ep"), "must render the curated episode immediately, not wait on the network");
});

test("a successful fetch swaps in the full-catalogue episode list", async () => {
  /* MUTATION: drop the `.then()` continuation's `container.innerHTML = ...`
     line. This assertion fails because the container is still empty after
     the fetch resolves. */
  const fetchImpl = () => Promise.resolve({
    ok: true,
    json: async () => ({
      show_id: "show-a",
      stale: false,
      error: null,
      episodes: [
        { guid: "g1", title: "Full Ep One", description_text: "desc", audio_url: "https://cdn.example.com/full1.mp3", duration_seconds: 600, published_at: "2026-01-02T00:00:00.000Z" },
        { guid: "g2", title: "Full Ep Two", description_text: "desc", audio_url: "https://cdn.example.com/full2.mp3", duration_seconds: 700, published_at: "2026-01-01T00:00:00.000Z" },
      ],
    }),
  });
  const m = mount({ fetchImpl });
  const show = { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] };
  seedShowAndPool(m.ctx, { show });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const container = m.viewEl._episodesContainerRef;
  assert.ok(container, "episodes container must exist");
  assert.ok(container.innerHTML.includes("Full Ep One"), "must render the full-catalogue episode");
  assert.ok(container.innerHTML.includes("Full Ep Two"), "must render every full-catalogue episode");
});

test("every full-catalogue episode row is playable in-app (real audio_url, no link-out)", async () => {
  /* Direct fix for the link-out problem the card exists to close. Checks the
     play button renders, which playBtn() only does when item.audio_url is
     truthy — proving the endpoint's audio_url survived the full pipeline
     (fetch -> snapshot() -> epRow -> playBtn) intact.

     MUTATION: drop `audio_url: ep.audio_url` from
     fullCatalogueRowToEpRowItem's snapshot() call. This assertion fails
     because playBtn() renders nothing without an audio_url. */
  const fetchImpl = () => Promise.resolve({
    ok: true,
    json: async () => ({
      show_id: "show-a", stale: false, error: null,
      episodes: [{ guid: "g1", title: "Full Ep", description_text: "", audio_url: "https://cdn.example.com/full1.mp3", duration_seconds: 600, published_at: null }],
    }),
  });
  const m = mount({ fetchImpl });
  const show = { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] };
  seedShowAndPool(m.ctx, { show });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const container = m.viewEl._episodesContainerRef;
  assert.match(container.innerHTML, /class="play-btn"/, "the full-catalogue episode must render a play button, not a link-out");
  assert.ok(!container.innerHTML.includes("Listen in your podcast app"), "must not fall back to link-out when a real audio_url is present");
});

test("a fetch failure degrades to the already-rendered curated pool, never a blank page", async () => {
  /* Stage 3's explicit acceptance criterion (docs/show-pages-plan.md):
     "a feed fetch failure degrades to the 3a view plus a stated reason,
     never a blank page or an infinite spinner."

     MUTATION: change the `if (episodes === null)` branch to clear the
     container instead of leaving the curated rows in place. This assertion
     fails because the curated episode disappears from the view. */
  const fetchImpl = () => Promise.reject(new Error("network down"));
  const m = mount({ fetchImpl });
  const show = { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] };
  seedShowAndPool(m.ctx, {
    show,
    discoverItems: [{ id: "a--1", show: "Show A", title: "Curated Ep", audio_url: "https://cdn.example.com/a.mp3" }],
  });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const html = m.viewEl.innerHTML;
  assert.ok(html.includes("Curated Ep"), "curated episode must remain visible after a fetch failure");
  assert.ok(!html.includes("undefined"), "must never render a literal undefined into the page");
});

test("a non-2xx response also degrades to the curated pool rather than throwing", async () => {
  const fetchImpl = () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
  const m = mount({ fetchImpl });
  const show = { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] };
  seedShowAndPool(m.ctx, {
    show,
    discoverItems: [{ id: "a--1", show: "Show A", title: "Curated Ep", audio_url: "https://cdn.example.com/a.mp3" }],
  });

  assert.doesNotThrow(() => m.ctx.renderShow("show-a"));
  await flushMicrotasks();
  assert.ok(m.viewEl.innerHTML.includes("Curated Ep"));
});

test("a stale:true response surfaces a plain-English note rather than hiding the staleness", async () => {
  /* MUTATION: drop the `(stale ? ... : "")` branch from the count-label
     update. This assertion fails because no "couldn't refresh" text
     appears anywhere the label writes landed. */
  const fetchImpl = () => Promise.resolve({
    ok: true,
    json: async () => ({
      show_id: "show-a", stale: true, error: "feed fetch failed",
      episodes: [{ guid: "g1", title: "Cached Ep", description_text: "", audio_url: "https://cdn.example.com/c.mp3", duration_seconds: 600, published_at: null }],
    }),
  });
  const m = mount({ fetchImpl });
  const show = { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] };
  seedShowAndPool(m.ctx, { show });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const label = m.viewEl._countLabelRef;
  assert.ok(label, "count label element must exist");
  assert.ok(/couldn.t refresh/i.test(label.textContent), `expected a stale-refresh note, got: "${label.textContent}"`);
});

test("fetchShowEpisodes requests the show's own endpoint path", async () => {
  /* Pins the URL shape against the backend route
     GET /api/shows/:show_id/episodes — a typo here would 404 silently
     against the real deployment while still passing every other test in
     this file (they all inject their own fetchImpl). */
  let capturedUrl = null;
  const fetchImpl = (url) => {
    capturedUrl = String(url);
    return Promise.resolve({ ok: true, json: async () => ({ episodes: [] }) });
  };
  const m = mount({ fetchImpl });
  await m.ctx.fetchShowEpisodes("my-show-id");
  assert.match(capturedUrl, /api\/shows\/my-show-id\/episodes$/, `expected the per-show episodes endpoint, got: ${capturedUrl}`);
});
