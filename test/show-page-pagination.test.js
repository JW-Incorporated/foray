/* S-06 (kanban t_be4c1793, source: 4a-shows-pipeline-plan.md) — the paginated
 * "Show more" control on top of Stage 3b's full-catalogue episode list
 * (test/show-pages-3b-full-catalogue.test.js), plus the partial-list-honesty
 * rule the card's acceptance criteria pin explicitly: the count label must
 * NEVER claim completeness while pages remain unfetched.
 *
 * WHAT THIS PROVES, in order:
 *  1. Page 1 renders 100 episodes and a "Show more" control when the API
 *     says there's a next_cursor; the control resumes from that exact cursor.
 *  2. Clicking "Show more" appends page 2's episodes to what's already
 *     rendered (never replaces/loses page 1's rows).
 *  3. Once a page arrives with `next_cursor: null`, the "Show more" control
 *     disappears and the count label states the TRUE total with no
 *     qualifier — the only state honest enough to drop the "so far" hedge.
 *  4. Before that point, the count label always carries an explicit
 *     "loaded so far" / "+" qualifier — this is the partial-list-honesty
 *     rule from the card's acceptance criteria, pinned by test so a future
 *     edit can't quietly reintroduce a false completeness claim.
 *  5. A "Show more" fetch failure leaves the already-loaded rows and cursor
 *     intact (never discards progress) and re-offers the control to retry.
 *
 * Harness: the same node:vm DOM stub test/show-pages-3b-full-catalogue.test.js
 * uses, duplicated for the same fixture-scoped reasons that file gives, and
 * extended here with a cursor-aware fetchImpl queue (each call in the queue
 * answers one fetch, matched to the request URL's cursor param).
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

/* A real, event-recording button so click handlers attached via
   addEventListener actually fire when a test calls .click(). */
function makeButtonEl() {
  const el = makeEl("button");
  const handlers = {};
  el.addEventListener = (type, fn) => { handlers[type] = fn; };
  el.click = () => { if (handlers.click) handlers.click(); };
  return el;
}

/* Same lazy-parse-the-last-innerHTML-write idiom test/show-pages-3b-full-
   catalogue.test.js established, extended with the "Show more" wrap and a
   click-capable button reference. */
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
            if (this._hasBtn) wrap._btnRef = makeButtonEl();
            else wrap._btnRef = null;
          },
        });
        wrap.querySelector = (innerSel) => {
          if (String(innerSel).includes("[data-show-more]")) return wrap._btnRef;
          return null;
        };
        el._moreWrapRef = wrap;
      }
      return el._moreWrapRef;
    }
    if (s.includes("[data-show-more]")) {
      return el._moreWrapRef ? el._moreWrapRef._btnRef : null;
    }
    if (s.includes("[data-show-ep-search-form]") || s.includes("[data-show-ep-search-input]") || s.includes("[data-show-ep-search-note]") || s.includes("[data-show-ep-search]")) {
      if (!el._hasSearchBox) return null;
      return makeEl("div"); // not exercised by this file — the search suite owns these
    }
    return null;
  };
  return el;
}

function extractAttr(html, attr) {
  return html.includes(attr) ? "" : null;
}

/* `responses` is a queue: each `.fetchImpl()` call for `api/shows/` consumes
   the next entry, matched loosely by declared `expectCursor` (or unmatched
   if omitted) so a test can assert page 1 vs page 2 hit the right request. */
function mount({ responses = [] } = {}) {
  const viewEl = makeViewEl();
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = id === "view" ? viewEl : makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");
  const calls = [];

  const routedFetch = (url) => {
    if (String(url).includes("api/shows/")) {
      calls.push(String(url));
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
  return { ctx, viewEl, calls };
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

function page(n, { cursor = null } = {}) {
  return {
    body: {
      episodes: Array.from({ length: n }, (_, i) => ({
        guid: `g${i}`,
        title: `Ep ${i}`,
        description_text: "",
        audio_url: `https://cdn.example.com/${i}.mp3`,
        duration_seconds: 60,
        published_at: null,
      })),
      next_cursor: cursor,
      stale: false,
      error: null,
    },
  };
}

test('page 1 with a next_cursor renders a "Show more" control', async () => {
  /* MUTATION: drop paintMoreButton()'s call after page 1 resolves. This
     assertion fails because the wrap never gets a button written into it. */
  const m = mount({ responses: [page(100, { cursor: "cursor-1" })] });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const wrap = m.viewEl.querySelector("[data-show-more-wrap]");
  assert.ok(wrap, "more-wrap element must exist");
  assert.ok(wrap.innerHTML.includes("data-show-more"), "must render a Show more button when a next_cursor is present");
});

test('clicking "Show more" fetches the next page using the exact cursor and appends its episodes', async () => {
  /* MUTATION: call fetchShowEpisodes(show.show_id) instead of
     fetchShowEpisodes(show.show_id, nextCursor) in loadNextPage. This
     assertion fails because the second captured URL has no ?cursor= param. */
  const m = mount({
    responses: [page(100, { cursor: "cursor-1" }), page(50, { cursor: null })],
  });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const btn = m.viewEl.querySelector("[data-show-more]");
  assert.ok(btn, "Show more button must exist after page 1");
  btn.click();
  await flushMicrotasks();

  assert.match(m.calls[1], /cursor=cursor-1/, `second fetch must carry page 1's cursor, got: ${m.calls[1]}`);
  const container = m.viewEl.querySelector("[data-show-episodes]");
  assert.ok(container.innerHTML.includes("Ep 0"), "page 1's first episode must still be present");
  assert.ok(container.innerHTML.includes("Ep 99"), "page 1's last episode must still be present");
  assert.ok(container.innerHTML.includes(">Ep 0<") || container.innerHTML.includes("Ep 0"), "sanity: page 1 content present");
  // Page 2 reuses guids g0..g49 (fixture shorthand) so distinguish by count instead.
  const epRowCount = (container.innerHTML.match(/class="ep-row"/g) || []).length;
  assert.strictEqual(epRowCount, 150, "must render all 150 episodes across both pages, not just the latest page");
});

test("once a page arrives with next_cursor: null, the Show more control disappears and the count label drops its hedge", async () => {
  /* MUTATION: remove the `fullyLoaded || !nextCursor` guard in
     paintMoreButton so it keeps rendering the button. This assertion fails
     because the wrap still has button markup after the final page. */
  const m = mount({ responses: [page(30, { cursor: null })] });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const wrap = m.viewEl.querySelector("[data-show-more-wrap]");
  assert.ok(!wrap.innerHTML.includes("data-show-more"), "no Show more control once the list is fully loaded");

  const label = m.viewEl.querySelector("[data-show-count]");
  assert.strictEqual(label.textContent, "30 episodes", `count label must be the bare true total once fully loaded, got: "${label.textContent}"`);
});

test("partial-list-honesty rule: the count label always hedges while a next_cursor remains, never claims a bare total", async () => {
  /* Direct pin of the card's own acceptance criterion. MUTATION: drop the
     `fullyLoaded` branch split in showEpisodeCountLabel and always return the
     bare "`N episodes`" form. This assertion fails because the partial-load
     label would then read "100 episodes" with no qualifier. */
  const m = mount({ responses: [page(100, { cursor: "cursor-1" })] });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const label = m.viewEl.querySelector("[data-show-count]");
  assert.match(label.textContent, /\+/, `partial load must hedge with a qualifier (e.g. "100+"), got: "${label.textContent}"`);
  assert.doesNotMatch(label.textContent, /^100 episodes$/, "must never render the bare, unqualified total while pages remain unfetched");
});

test("a Show more fetch failure keeps the already-loaded episodes and re-offers the control, never discards progress", async () => {
  /* MUTATION: clear `loaded` on a failed loadNextPage response. This
     assertion fails because page 1's 100 episodes would disappear from the
     rendered container. */
  const m = mount({
    responses: [page(100, { cursor: "cursor-1" }), { reject: "network down" }],
  });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const btn = m.viewEl.querySelector("[data-show-more]");
  btn.click();
  await flushMicrotasks();

  const container = m.viewEl.querySelector("[data-show-episodes]");
  const epRowCount = (container.innerHTML.match(/class="ep-row"/g) || []).length;
  assert.strictEqual(epRowCount, 100, "page 1's 100 episodes must remain rendered after a failed Show more fetch");

  const wrapAfter = m.viewEl.querySelector("[data-show-more-wrap]");
  assert.ok(wrapAfter.innerHTML.includes("data-show-more") || m.viewEl.querySelector("[data-show-more]"), "the control must still exist to retry after a failure");
});
