/* The show page's episode region has FOUR STATES and ONE WRITER — issue #687.
 *
 * FOUNDER REPORT, 2026-09-14, with a screenshot showing both of these on
 * screen at the same time on a breadth show's page:
 *
 *   subtitle: "Couldn't load this show's episodes right now."
 *   body:     "Fetching this show's episodes — 4a is adding full episode
 *              lists for shows outside its curated picks. Check back soon."
 *
 * One says it failed. The other says it is still working.
 *
 * THE DEFECT WAS STRUCTURAL, NOT A COPY ERROR, which is why this is its own
 * suite rather than a string assertion bolted onto the Stage 3b file next
 * door. Two independent writers described one state and only one of them was
 * ever told the outcome: the body was composed inline in renderShow's initial
 * `innerHTML`, painted once, synchronously, before the fetch resolved, with
 * no error branch and nothing that revisited it; the subtitle was painted by
 * paintCount(), which did receive `loadError`. Of the fetch's three terminal
 * outcomes, exactly ONE (success) wrote the body. Failure and empty each
 * called paintCount() alone and returned, so the optimistic placeholder
 * outlived them both, permanently.
 *
 * WHAT THIS SUITE PROVES, in order:
 *  1. The four states exist and each paints the body it should — `loading`,
 *     `loaded`, `empty`, `failed` — through one function called on every
 *     terminal path.
 *  2. THE PROPERTY THE BUG VIOLATED, asserted directly and as a property
 *     rather than per-case: after any terminal outcome, the body and the
 *     subtitle never describe different outcomes. Specifically, "still
 *     fetching" copy cannot coexist with a failure subtitle.
 *  3. Curated rows are not destroyed by a failure. A curated show whose
 *     full-list fetch fails keeps its real, playable rows; the placeholder
 *     is for when there is nothing else to show. This is the branch a naive
 *     "just paint the error everywhere" fix would have broken, trading one
 *     contradiction for a worse one.
 *  4. No user-facing string on this page blames 4a (founder's standing
 *     instruction, given twice) and none of them promises a "check back
 *     soon" that nothing in the system keeps.
 *
 * WHAT THIS SUITE DOES NOT PROVE, said plainly: that the new copy reads well
 * on a phone. That is the founder's call, not a property.
 *
 * Harness: the same node:vm DOM stub as
 * test/show-pages-3b-full-catalogue.test.js, duplicated rather than imported
 * for the reason that file's own header gives (harness is fixture-scoped),
 * and reduced to the elements this file actually reads — the episode
 * container and the count label.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md, "a
 * green test is not evidence until you have broken it"). Every one was run
 * red before being run green.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
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
  "view", "drawer", "drawer-overlay", "menu-btn", "refresh-btn", "banner-slot",
  "sh-form", "sh-input", "sh-note", "sh-results",
];

/* A `#view` whose `[data-show-episodes]` and `[data-show-count]` lookups
   return stable, writable elements, so renderShow's own paint functions can
   be observed writing to them. Both are live references: the container's
   innerHTML and the label's textContent are exactly what the page would be
   showing. */
function makeViewEl() {
  const el = makeEl("div");
  el.id = "view";
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html || ""; },
    set(html) {
      this._html = html;
      this._hasContainer = html.includes("data-show-episodes");
      this._hasCount = html.includes("data-show-count");
      /* A fresh render throws the old nodes away, exactly as innerHTML does
         in a browser — otherwise a second renderShow() in one test would
         observe the PREVIOUS render's container and this harness would hide
         precisely the leftover-paint class of bug the suite is about. */
      this._containerRef = null;
      this._countRef = null;
    },
  });
  el.querySelector = (sel) => {
    const s = String(sel);
    if (s.includes("[data-show-episodes]")) {
      if (!el._hasContainer) return null;
      if (!el._containerRef) el._containerRef = makeEl("div");
      return el._containerRef;
    }
    if (s.includes("[data-show-count]")) {
      if (!el._hasCount) return null;
      if (!el._countRef) el._countRef = makeEl("p");
      return el._countRef;
    }
    /* The in-page episode search box: absent from this fixture on purpose.
       Its wiring is test/show-page-search.test.js's subject, and a null here
       exercises renderShow's own "if (searchForm && searchInput)" guard. */
    return null;
  };
  return el;
}

function mount({ fetchImpl } = {}) {
  const viewEl = makeViewEl();
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = id === "view" ? viewEl : makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  /* Everything but the episodes endpoint hangs forever, so init()'s own boot
     fetches can never resolve and repaint #view mid-test — the same routing
     test/show-pages-3b-full-catalogue.test.js uses, for the same reason. */
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
        if (!s.startsWith("#")) return null;
        const rest = s.slice(1);
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx === -1) return byId.get(rest) ?? null;
        const rootEl = byId.get(rest.slice(0, spaceIdx));
        return rootEl ? rootEl.querySelector(rest.slice(spaceIdx + 1)) : null;
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

  return {
    ctx, viewEl,
    body: () => (viewEl._containerRef ? viewEl._containerRef.innerHTML : null),
    subtitle: () => (viewEl._countRef ? viewEl._countRef.textContent : null),
  };
}

async function flushMicrotasks(n = 50) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

function seed(ctx, { show, discoverItems = [] } = {}) {
  ctx.state.catalog = { shows: [show] };
  ctx.state.discover = { items: discoverItems };
  ctx.state.taxonomy = { nodes: [] };
  ctx.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
}

const BREADTH = { show_id: "show-b", title: "Breadth Show", tier: "breadth", taxonomy_node_ids: [] };
const CURATED = { show_id: "show-a", title: "Curated Show", taxonomy_node_ids: [] };
const CURATED_EP = { id: "show-a--1", show: "Curated Show", title: "Curated Ep", audio_url: "https://cdn.example.com/a.mp3" };

const ok = (bodyJson) => () => Promise.resolve({ ok: true, json: async () => bodyJson });

/* ==================================================================== */
/* 1. THE FOUR STATES                                                    */
/* ==================================================================== */

test("loading: the first paint goes through the one writer, not a template literal", async () => {
  /* The placeholder is a STATE now, not a string composed once into the
     initial innerHTML and forgotten. The proof that it is the one writer
     doing this and not the template: the episode CONTAINER holds it. Before
     the fix the container was created already full and #view's own markup
     carried the text.

     MUTATION: delete the `paintEpisodeOutcome("loading")` call before the
     fetch. This fails — the container is empty, which is the blank page the
     synchronous first paint exists to prevent. RUN: failed as named. */
  const m = mount({ fetchImpl: () => new Promise(() => {}) }); // never resolves
  seed(m.ctx, { show: BREADTH });

  m.ctx.renderShow("show-b");

  assert.ok(!m.viewEl.innerHTML.includes("Loading episodes"),
    "the placeholder must not be baked into #view's own markup — that is the second writer this fix removed");
  assert.match(m.body(), /Loading episodes/,
    `the container holds the loading state, got: ${m.body()}`);
});

test("failed: the body says the load failed instead of saying it is still fetching", async () => {
  /* THE FOUNDER'S SCREENSHOT, as an assertion. This is the bug.

     MUTATION: revert the `episodes === null` branch to `paintCount(); return;`
     — the exact line that shipped. This fails: the body still reads
     "Loading episodes…" while the subtitle reports a failure. RUN: failed as
     named. */
  const m = mount({ fetchImpl: () => Promise.reject(new Error("network down")) });
  seed(m.ctx, { show: BREADTH });

  m.ctx.renderShow("show-b");
  await flushMicrotasks();

  assert.match(m.body(), /Couldn't load these episodes/,
    `a failed load must say so in the body, got: ${m.body()}`);
  assert.ok(!/Loading episodes|Fetching|Check back soon/i.test(m.body()),
    `a failed load must not still claim to be working, got: ${m.body()}`);
});

test("empty: a show the endpoint says has no episodes says that, and does not keep loading", async () => {
  /* The second of the two outcomes that used to call paintCount() alone.

     MUTATION: revert the `episodes.length === 0` branch to `paintCount();
     return;`. This fails — the body sits on the loading placeholder for a
     load that finished successfully with nothing in it. RUN: failed as
     named. */
  const m = mount({ fetchImpl: ok({ show_id: "show-b", episodes: [] }) });
  seed(m.ctx, { show: BREADTH });

  m.ctx.renderShow("show-b");
  await flushMicrotasks();

  assert.match(m.body(), /No episodes yet/,
    `an empty result must say so, got: ${m.body()}`);
  assert.ok(!/Loading episodes/i.test(m.body()),
    `an empty result is a finished load, got: ${m.body()}`);
});

test("loaded: the full list replaces the placeholder", async () => {
  /* The one outcome that was never broken — pinned here so the refactor that
     routed it through paintBody() cannot have quietly cost it.

     MUTATION: make paintBody() return early for `loadState === "loaded"`
     instead of calling paintList(). This fails — the episode never appears.
     RUN: failed as named. */
  const m = mount({
    fetchImpl: ok({
      show_id: "show-b", next_cursor: null,
      episodes: [{ guid: "g1", title: "Full Ep", description_text: "", audio_url: "https://cdn.example.com/f.mp3", duration_seconds: 600, published_at: null }],
    }),
  });
  seed(m.ctx, { show: BREADTH });

  m.ctx.renderShow("show-b");
  await flushMicrotasks();

  assert.match(m.body(), /Full Ep/, `the loaded list must be on screen, got: ${m.body()}`);
  assert.ok(!/Loading episodes|No episodes yet/i.test(m.body()),
    `no placeholder may survive a successful load, got: ${m.body()}`);
});

/* ==================================================================== */
/* 2. THE PROPERTY THE BUG VIOLATED                                      */
/* ==================================================================== */

test("no terminal outcome leaves the body and the subtitle describing different outcomes", async () => {
  /* THE POINT OF THE WHOLE CHANGE, and the reason it is a structural fix and
     not a copy edit: this is asserted over EVERY terminal outcome rather
     than for the one the founder happened to screenshot, because the defect
     was that an outcome could be added without teaching the body about it.

     The check is deliberately crude and one-directional — "still working"
     language in the body must not coexist with "finished" language in the
     subtitle — because that is exactly the contradiction he photographed,
     and a cleverer check would be testing this file's own idea of the copy
     rather than the property.

     MUTATION: make paintEpisodeOutcome() call paintCount() only, dropping
     its paintBody() call — i.e. reintroduce the original defect at the one
     place it now cannot hide. Every failing/empty case below goes red at
     once. RUN: failed as named, 2 of 3 cases. */
  const cases = [
    { name: "failed", fetchImpl: () => Promise.reject(new Error("down")) },
    { name: "empty", fetchImpl: ok({ show_id: "show-b", episodes: [] }) },
    {
      name: "loaded",
      fetchImpl: ok({
        show_id: "show-b", next_cursor: null,
        episodes: [{ guid: "g1", title: "Full Ep", description_text: "", audio_url: "https://cdn.example.com/f.mp3", duration_seconds: 600, published_at: null }],
      }),
    },
  ];

  for (const { name, fetchImpl } of cases) {
    const m = mount({ fetchImpl });
    seed(m.ctx, { show: BREADTH });
    m.ctx.renderShow("show-b");
    await flushMicrotasks();

    const body = m.body();
    const sub = m.subtitle();
    /* THE BODY MUST HAVE BEEN WRITTEN AT ALL, asserted first and separately.
       Without this the test passes vacuously on an EMPTY container — which is
       exactly what dropping paintBody() from paintEpisodeOutcome() produces,
       and a mutation run caught this file green against that mutation. "The
       two never contradict each other" is only worth something if there are
       two things. */
    assert.ok(body && body.trim(), `[${name}] the episode container must never be left empty`);
    assert.ok(sub && sub.trim(), `[${name}] …nor the subtitle`);
    const bodyStillWorking = /loading|fetching|check back/i.test(body);
    const subtitleFinished = /couldn't load|no episodes found|^\d+ episode/i.test(sub);
    assert.ok(!(bodyStillWorking && subtitleFinished),
      `[${name}] body and subtitle disagree — body: "${body}" / subtitle: "${sub}"`);
  }
});

test("the subtitle has one author too — it is not composed in the initial markup", async () => {
  /* The matched half of the same defect. The loading subtitle used to be
     written by hand into renderShow's `<p class="sub" data-show-count>` with
     its own phrasing, which showEpisodeCountLabel never saw and never
     revisited. Fixing the body while leaving that in place would have left
     the identical bug on the identical page.

     MUTATION: put any literal text back inside the `data-show-count`
     element in renderShow's template. This fails. RUN: failed as named. */
  const m = mount({ fetchImpl: () => new Promise(() => {}) });
  seed(m.ctx, { show: BREADTH });

  m.ctx.renderShow("show-b");

  const markup = m.viewEl.innerHTML;
  const el = /<p class="sub" data-show-count>([\s\S]*?)<\/p>/.exec(markup);
  assert.ok(el, `expected the subtitle element in the markup, got: ${markup.slice(0, 400)}`);
  assert.strictEqual(el[1].trim(), "",
    `the subtitle element must be emitted empty and filled by paintCount(), got: "${el[1]}"`);
  assert.ok(m.subtitle(), "…and paintCount() must have filled it synchronously, so the page is never headless");
});

/* ==================================================================== */
/* 3. THE BRANCH A NAIVE FIX WOULD HAVE BROKEN                           */
/* ==================================================================== */

test("a curated show keeps its real rows when the full-list fetch fails", async () => {
  /* Those rows are playable right now. Replacing them with "Couldn't load
     these episodes" would delete working content in order to display an
     error about content the listener cannot tell is missing — a worse
     contradiction than the one being fixed, arrived at by fixing it
     carelessly. The subtitle carries the failure instead, which is what it
     is for.

     MUTATION: delete paintBody()'s `if (curatedEps.length)` branch, so every
     non-loaded state paints a placeholder. This fails — "Curated Ep"
     vanishes from a page that was showing it a moment ago. RUN: failed as
     named. */
  const m = mount({ fetchImpl: () => Promise.reject(new Error("down")) });
  seed(m.ctx, { show: CURATED, discoverItems: [CURATED_EP] });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  assert.match(m.body(), /Curated Ep/,
    `curated rows must survive a failed full-list fetch, got: ${m.body()}`);
  assert.ok(!/Couldn't load these episodes/.test(m.body()),
    "the body shows the rows; the subtitle carries the failure");
  assert.match(m.subtitle(), /couldn't load the full list/i,
    `the subtitle must state the failure, got: ${m.subtitle()}`);
});

/* ==================================================================== */
/* 4. THE COPY                                                           */
/* ==================================================================== */

test("no episode-state copy blames 4a or promises a check-back that nothing keeps", async () => {
  /* Founder's standing instruction, given twice: "don't blame it on 4a."

     ASSERTED AGAINST WHAT IS RENDERED, not against app.js as text, and the
     first draft of this test got that wrong. A source-text scan cannot tell
     a string the page SHOWS from the same string quoted in a comment
     recording why it was deleted — and this change deliberately keeps those
     quotations, because "what used to be here and why it went" is the most
     useful thing a comment on a deleted string can say. Rendering every
     terminal state and reading the actual body and subtitle is both stricter
     (it covers strings composed at runtime, which a grep for a literal
     misses) and immune to that.

     A neutral COUNT is deliberately not caught by this: "N episodes in 4a's
     catalogue" states a fact about what is on screen. "4a is adding full
     episode lists for shows outside its curated picks" explains our
     catalogue's internal tiering to a listener, which is the thing he asked
     us to stop doing — so the pattern below is "4a" followed by an
     explanation, plus the check-back promise nothing keeps.

     MUTATION: restore any one of the deleted strings to the code that
     renders it. This fails. RUN: failed as named, for each. */
  const banned = [
    /4a is adding/i,
    /outside its curated picks/i,
    /4a's wider catalogue/i,
    /check back/i,
    /No episodes from this show are in 4a's catalogue/i,
  ];
  const cases = [
    { name: "loading", show: BREADTH, fetchImpl: () => new Promise(() => {}), settle: false },
    { name: "failed", show: BREADTH, fetchImpl: () => Promise.reject(new Error("down")), settle: true },
    { name: "empty", show: BREADTH, fetchImpl: ok({ show_id: "show-b", episodes: [] }), settle: true },
    { name: "failed-with-curated", show: CURATED, discoverItems: [CURATED_EP], fetchImpl: () => Promise.reject(new Error("down")), settle: true },
  ];

  for (const { name, show, discoverItems = [], fetchImpl, settle } of cases) {
    const m = mount({ fetchImpl });
    seed(m.ctx, { show, discoverItems });
    m.ctx.renderShow(show.show_id);
    if (settle) await flushMicrotasks();

    const onScreen = `${m.body()} ${m.subtitle()}`;
    for (const re of banned) {
      assert.ok(!re.test(onScreen), `[${name}] nothing on screen may match ${re} — got: ${onScreen}`);
    }
  }
});

test("the replacement copy is the plain, short, listener-facing text asked for", () => {
  /* Pinned so a later edit cannot drift back toward explaining ourselves.
     MUTATION: reword any one of the three. This fails. RUN: failed as
     named. */
  for (const s of ["Loading episodes…", "No episodes yet.", "Couldn't load these episodes. Pull to refresh."]) {
    assert.ok(APP_SRC.includes(s), `app.js must carry the replacement string ${JSON.stringify(s)}`);
  }
});
