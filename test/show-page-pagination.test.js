/* S-06 (kanban t_be4c1793, source: 4a-shows-pipeline-plan.md), REWRITTEN
 * 2026-09-13 for the founder report that took the "Show more episodes"
 * control out of the show page.
 *
 * WHY THIS FILE STILL EXISTS RATHER THAN BEING DELETED WITH THE BUTTON.
 * What it was really guarding was never the button: it was the rule that this
 * page must not lie about how much of a show it is displaying. That rule
 * outlived the control, and the two things this change did — remove the
 * control, and delete the "N+ episodes loaded so far — more available"
 * subtitle — both cut straight across it. So every test below was re-pointed
 * at the behaviour that replaced the one it used to pin, and the file keeps
 * its floor in test/suite-integrity.test.js unchanged.
 *
 * THE DEFECT THAT CAUSED THE REMOVAL, since a test file is where the next
 * person will look for it: the control's visibility was decided by the
 * pagination cursor alone (`fullyLoaded || !nextCursor`), with no regard for
 * whether the container underneath it was showing the paginated list at all.
 * During a scoped search it was showing S-07's server-side results instead, so
 * clicking "Show more" fetched a page, appended it to `loaded`, repainted —
 * and repainted the unchanged search results. Real work, invisible outcome.
 * Note that the five tests this file used to hold ALL passed while that was
 * true, because not one of them typed in the search box first; the case is now
 * pinned from the other side in test/show-page-search.test.js.
 *
 * WHAT THIS PROVES, in order:
 *  1. A page 1 that comes back with a next_cursor renders NO "Show more"
 *     control and no wrap for one — the markup is gone, not merely empty.
 *  2. Nothing pages on its own instead: exactly one request is made, so
 *     removing the button did not become a silent auto-loader.
 *  3. A fully-loaded list still states its TRUE total, unqualified — the
 *     branch of the count label that survived, and the only one allowed to
 *     state a number.
 *  4. A partial load renders NO subtitle at all. This is the founder's own
 *     call ("delete that, it's useless info") and it is pinned rather than
 *     merely done, because the tempting repair — reusing the fully-loaded
 *     shape, "100 episodes" — would be the false-completeness claim the
 *     original hedge existed to prevent.
 *  5. A partial load that came back STALE still says so. The count went; the
 *     "couldn't refresh" signal did not, because that one is actionable.
 *
 * Harness: the same node:vm DOM stub test/show-pages-3b-full-catalogue.test.js
 * uses, duplicated for the same fixture-scoped reasons that file gives, and
 * extended here with a cursor-aware fetchImpl queue (each call in the queue
 * answers one fetch, matched to the request URL's cursor param). The
 * more-wrap/button plumbing in makeViewEl() is deliberately KEPT: a stub that
 * could not represent the control is a stub that cannot prove it is absent.
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

function page(n, { cursor = null, stale = false } = {}) {
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
      stale,
      error: null,
    },
  };
}

test('a next_cursor no longer renders a "Show more" control, and no wrap is left behind for one', async () => {
  /* The founder report, pinned from the DOM side. MUTATION: restore the
     `<div data-show-more-wrap></div>` line in renderShow's markup together
     with paintMoreButton(). The first assertion fails on the wrap alone, so
     it also catches a half-revert that leaves dead markup in the page. */
  const m = mount({ responses: [page(100, { cursor: "cursor-1" })] });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  assert.strictEqual(
    m.viewEl.querySelector("[data-show-more-wrap]"), null,
    "the Show more wrap must not be rendered at all, even empty",
  );
  assert.ok(
    !m.viewEl.innerHTML.includes("data-show-more"),
    "no Show more markup of any kind may reach the page",
  );
  assert.ok(
    !m.viewEl.innerHTML.includes("show-more-btn"),
    "and no Show more button class either",
  );
});

test("a next_cursor does not silently auto-load the next page either: exactly one request is made", async () => {
  /* Removing a control is not licence to do its job invisibly — an auto-pager
     would re-introduce the same unbounded fetching with no way to stop it, and
     on a 900-episode show would quietly pull nine pages on every visit.
     MUTATION: call fetchShowEpisodes(show.show_id, nc) again from inside the
     page-1 handler whenever `nc` is non-null. This assertion fails because a
     second URL lands in `calls`. */
  const m = mount({
    responses: [page(100, { cursor: "cursor-1" }), page(50, { cursor: null })],
  });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  assert.strictEqual(m.calls.length, 1, `exactly one episodes request must be made, got: ${JSON.stringify(m.calls)}`);
  assert.doesNotMatch(m.calls[0], /cursor=/, "and it must be the un-cursored page-1 request");

  const container = m.viewEl.querySelector("[data-show-episodes]");
  const epRowCount = (container.innerHTML.match(/class="ep-row"/g) || []).length;
  assert.strictEqual(epRowCount, 100, "page 1's episodes are what is rendered");
});

test("once a page arrives with next_cursor: null, the count label states the TRUE total with no qualifier", async () => {
  /* The surviving branch of showEpisodeCountLabel, and the only one allowed to
     state a number. MUTATION: drop the `fullyLoaded` branch so every load
     falls through to the partial case. This assertion fails because the label
     would then be empty instead of "30 episodes". */
  const m = mount({ responses: [page(30, { cursor: null })] });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const label = m.viewEl.querySelector("[data-show-count]");
  assert.strictEqual(label.textContent, "30 episodes", `count label must be the bare true total once fully loaded, got: "${label.textContent}"`);
});

test('a partial load renders NO subtitle: the "episodes loaded so far — more available" line is gone', async () => {
  /* Founder report 1, verbatim: "On some shows there will be a subtitle '100+
     episodes loaded so far - more available' delete that, it's useless info."

     Both assertions matter and they fail to different mutations. The first
     fails if the old hedge is restored. The second fails to the other
     tempting repair — reusing the fully-loaded shape and rendering a bare
     "100 episodes" for a partial load — which would be the false-completeness
     claim the hedge existed to prevent. The honest partial subtitle is no
     subtitle. */
  const m = mount({ responses: [page(100, { cursor: "cursor-1" })] });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const label = m.viewEl.querySelector("[data-show-count]");
  assert.strictEqual(label.textContent, "", `a partial load must render an empty subtitle, got: "${label.textContent}"`);
  assert.doesNotMatch(label.textContent, /\d/, "and must state no episode count of any kind while pages remain unfetched");
});

test("a partial load that came back stale still says it couldn't refresh", async () => {
  /* The count went; the failure signal did not. "Couldn't refresh" is
     something the listener can act on, unlike the count that was deleted.
     MUTATION: return "" unconditionally from showEpisodeCountLabel's partial
     branch instead of branching on `stale`. This assertion fails because the
     stale note disappears along with the count. */
  const m = mount({ responses: [page(100, { cursor: "cursor-1", stale: true })] });
  seedShowAndPool(m.ctx, { show: { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] } });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const label = m.viewEl.querySelector("[data-show-count]");
  assert.match(label.textContent, /couldn.t refresh/i, `a stale partial load must still surface the staleness, got: "${label.textContent}"`);
  assert.doesNotMatch(label.textContent, /more available/i, "and must not bring the deleted hedge back with it");
});
