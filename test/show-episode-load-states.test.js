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
      this._descRef = null;
    },
  });
  el.querySelector = (sel) => {
    const s = String(sel);
    if (s.includes("[data-show-episodes]")) {
      if (!el._hasContainer) return null;
      if (!el._containerRef) el._containerRef = makeContainerEl();
      return el._containerRef;
    }
    /* The publisher-description slot (2026-09-22). Present so the "description
       on every outcome branch" test below can observe paintShowDescription. */
    if (s.includes("[data-show-description]")) {
      if (!el.innerHTML.includes("data-show-description")) return null;
      if (!el._descRef) el._descRef = makeEl("div");
      return el._descRef;
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

/* The episode container, plus the one thing inside it this suite presses: the
   failed state's "Try again" (2026-09-22, audit theme G). A button stub is
   returned only while the container's markup actually carries `data-retry`, and
   it records the listener bindRetry attaches, so `retry()` below is the same
   press a listener makes — not a direct call into renderShow's closure. */
function makeContainerEl() {
  const c = makeEl("div");
  c._retryBtn = null;
  c.querySelector = (sel) => {
    if (!String(sel).includes("[data-retry]") || !String(c.innerHTML).includes("data-retry")) return null;
    const btn = makeEl("button");
    btn.addEventListener = (type, fn) => { if (type === "click") btn._onClick = fn; };
    c._retryBtn = btn;
    return btn;
  };
  return c;
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
    description: () => (viewEl._descRef && !viewEl._descRef.hidden ? viewEl._descRef.innerHTML : ""),
    /* Press the failed state's "Try again", or report that there is none. */
    retry: () => {
      const btn = viewEl._containerRef && viewEl._containerRef._retryBtn;
      if (!btn || typeof btn._onClick !== "function") return false;
      btn._onClick({ preventDefault() {} });
      return true;
    },
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
       two things. The subtitle is allowed to be EMPTY since the round-2 audit
       (states-8: one sentence per outcome) — but it must have been WRITTEN
       (`null` here means paintCount never asked for its element), so the
       one-writer property still has two regions to hold between. */
    assert.ok(body && body.trim(), `[${name}] the episode container must never be left empty`);
    assert.ok(sub !== null, `[${name}] …and the subtitle must have been painted by paintCount()`);
    const bodyStillWorking = /loading|fetching|check back/i.test(body);
    const subtitleFinished = /couldn't load|no episodes found|^\d+ episode/i.test(sub);
    assert.ok(!(bodyStillWorking && subtitleFinished),
      `[${name}] body and subtitle disagree — body: "${body}" / subtitle: "${sub}"`);
  }
});

test("ONE SENTENCE PER OUTCOME: while the body carries the status, the subtitle is empty (states-8)", async () => {
  /* Audit round 2, states-8: every outcome used to be said twice — "Loading
     episodes…" under the title and again 200 px lower; "Couldn't load this
     show's episodes right now." over "Couldn't load these episodes."; "No
     episodes found for this show." over "No episodes yet.". Same fact, two
     wordings, one screen. The body owns the status; the subtitle speaks only
     where there are rows to count.

     Counted on the RENDERED text, both regions together, so a status that
     moved from one region to the other still passes and one that is said
     twice does not.

     MUTATION: restore `return "Loading episodes…"` (or either of the two
     failed/empty sentences) in showEpisodeCountLabel. The count reads 2 and
     this goes red. RUN: failed as named, for each of the three. */
  const cases = [
    { name: "loading", fetchImpl: () => new Promise(() => {}), settle: false, said: /loading episodes/gi },
    { name: "failed", fetchImpl: () => Promise.reject(new Error("down")), settle: true, said: /couldn.t load/gi },
    { name: "empty", fetchImpl: ok({ show_id: "show-b", episodes: [] }), settle: true, said: /no episodes/gi },
  ];
  for (const { name, fetchImpl, settle, said } of cases) {
    const m = mount({ fetchImpl });
    seed(m.ctx, { show: BREADTH });
    m.ctx.renderShow("show-b");
    if (settle) await flushMicrotasks();
    const body = m.body();
    const sub = m.subtitle();
    assert.strictEqual((body.match(said) || []).length, 1, `[${name}] the body says it once — got: ${body}`);
    assert.strictEqual(sub.trim(), "", `[${name}] the subtitle says nothing the body already says — got: "${sub}"`);
    assert.strictEqual((`${body} ${sub}`.match(said) || []).length, 1, `[${name}] said exactly once on screen`);
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
  /* `null` means paintCount() never asked for the element; "" is the loading
     answer since states-8 (the body carries "Loading episodes…"). */
  assert.notStrictEqual(m.subtitle(), null, "…and paintCount() must have written it synchronously, so the page is never headless");
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
    "the rows are real, so the body must not say THESE episodes failed");
  /* Since the round-2 audit (states-2 / states-8) the failure line sits UNDER
     the rows, beside its Try again, and the subtitle keeps to the count — one
     sentence per outcome. */
  assert.match(m.body(), /Couldn't load the full list\./,
    `the body states the failure under the rows, got: ${m.body()}`);
  assert.match(m.subtitle(), /^\d+ episodes? in 4a's catalogue$/,
    `the subtitle keeps to the count and does not repeat the failure, got: "${m.subtitle()}"`);
});

test("a curated show whose full-list fetch failed offers Try again under its rows, wired to the same fetch (states-2)", async () => {
  /* Audit round 2, states-2: the curated branch returned before the failed
     branch, so all 220 catalogue shows — the ones Home and Search link to —
     had no Try again when the full list failed. Only a breadth show (zero
     curated rows) ever got the button.

     MUTATION: drop the `if (loadState === "failed") bindRetry(c, retryEpisodes)`
     line from the curated branch. `m.retry()` finds nothing and this goes red.
     MUTATION 2: keep the button but bind it to a no-op. `calls` stays 1. Both
     RUN: failed as named. */
  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error("network down"));
    return Promise.resolve({ ok: true, json: async () => ({ show_id: "show-a", next_cursor: null, episodes: [RAW_EP("e1", "Full List Ep")] }) });
  };
  const m = mount({ fetchImpl });
  seed(m.ctx, { show: CURATED, discoverItems: [CURATED_EP] });

  m.ctx.renderShow("show-a");
  await flushMicrotasks();
  assert.match(m.body(), /Curated Ep/, "premise: the curated rows are on screen");
  assert.match(m.body(), /Try again/, `the failed curated page must offer a retry, got: ${m.body()}`);

  assert.ok(m.retry(), "the Try again button must be wired");
  await flushMicrotasks();
  assert.strictEqual(calls, 2, "the retry is the same fetch, made again");
  assert.match(m.body(), /Full List Ep/, `the retry's answer replaces the curated rows, got: ${m.body()}`);
  assert.doesNotMatch(m.body(), /Couldn't load/, "a retry that worked leaves no failure line behind");
});

test("a show fetch that never answers ends as failed, with Try again, instead of loading for good (states-4)", async () => {
  /* Audit round 2, states-4: `fetchShowEpisodesUncached` was a bare fetch to
     API_ORIGIN — the one /api/* call the 2026-09-23 deadline review missed. In
     the native shell there is no service worker to cut a stalled socket off, so
     a captive portal left "Loading episodes…" on screen indefinitely, and
     `showEpisodesInFlight` handed every later visit the same hung promise.

     The bound is shortened through the same `let` the review left for suites.
     MUTATION: replace `withDeadline(fetch(...), API_DEADLINE_MS, …)` with the
     bare `await fetch(...)`. The body never leaves "Loading episodes…" and the
     first assertion goes red. RUN: failed as named. */
  let calls = 0;
  const m = mount({ fetchImpl: () => { calls += 1; return new Promise(() => {}); } }); // a socket that never answers
  vm.runInContext("API_DEADLINE_MS = 20", m.ctx);
  seed(m.ctx, { show: BREADTH });

  m.ctx.renderShow("show-b");
  assert.match(m.body(), /Loading episodes/, "premise: loading first");
  await new Promise((r) => setTimeout(r, 60));
  await flushMicrotasks();
  assert.match(m.body(), /Couldn't load these episodes/, `the deadline must reach the failed state, got: ${m.body()}`);
  assert.match(m.body(), /Try again/, "…with a way forward");
  /* And the retry is not handed the hung promise: `showEpisodesInFlight`
     clears when the bounded promise settles, so the same fetch runs again. */
  assert.ok(m.retry());
  await flushMicrotasks();
  assert.strictEqual(calls, 2, "Try again asks the network again rather than re-awaiting the stalled socket");
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
  /* "Pull to refresh" went on 2026-09-22 (audit theme G): there is no pull
     gesture, and the failed state now carries a real "Try again" instead — see
     "failed: 'Try again' re-runs the same fetch" below. */
  for (const s of ["Loading episodes…", "No episodes yet.", "Couldn't load these episodes."]) {
    assert.ok(APP_SRC.includes(s), `app.js must carry the replacement string ${JSON.stringify(s)}`);
  }
});

test("a CURATED show still loading does not state a count over an empty body", async () => {
  /* THE MISSING CELL, and it is the one that mattered.

     The case list above runs failed / empty / loaded, and every one of them is
     seeded with BREADTH — a show with zero curated episodes. So `curatedCount`
     was always 0, the subtitle's `curatedCount ? …` branch was never taken, and
     the whole loading + curated quadrant went untested.

     That is exactly where the defect lived. On 2026-09-21 the body stopped
     painting curated rows while loading (founder: stale rows that swap a second
     later are worse than a brief blank) and the subtitle was left naming the
     curated count — so a listener saw "33 episodes · loading the rest…" above
     "Loading episodes…" and no rows at all. The suite stayed green because no
     case combined a still-loading fetch with a show that HAS curated episodes.

     MUTATION: restore the `curatedCount ? ... : "Loading episodes…"` branch in
     showEpisodeCountLabel. This goes red; every case above stays green, which is
     the whole reason this cell had to be added rather than the others widened. */
  const m = mount({ fetchImpl: () => new Promise(() => {}) }); // never resolves: stays "loading"
  seed(m.ctx, { show: CURATED, discoverItems: [CURATED_EP] });
  m.ctx.renderShow("show-a");
  await flushMicrotasks();

  const body = m.body();
  const sub = m.subtitle();
  assert.ok(body && body.trim(), "the episode container must never be left empty");
  assert.notStrictEqual(sub, null, "…and the subtitle must have been painted (empty is the loading answer since states-8)");
  assert.ok(!/Curated Ep/.test(body), "no stale curated row may stand in for the list still loading");
  assert.ok(!/^\d+ episode/.test(sub.trim()),
    `the subtitle must not state a count while the body shows none — subtitle: "${sub}" / body: "${body}"`);
});

/* ==================================================================== */
/* 5. FAILURE OFFERS A WAY FORWARD; FRESHNESS IS TOLD IN THE RIGHT TENSE */
/*    (audit 2026-09-22, theme G — the three-state convention)          */
/* ==================================================================== */

const RAW_EP = (id, title = id) => ({
  id, guid: id, title, description_text: "", audio_url: `https://cdn.example.com/${id}.mp3`,
  duration_seconds: 600, published_at: null,
});

test("failed: 'Try again' re-runs the same fetch and paints what it answers", async () => {
  /* "Couldn't load these episodes. Pull to refresh." named a gesture this page
     does not have, so a failure was a dead end. The failed state now carries a
     real button, and the button is the SAME fetch (renderShow's loadEpisodes),
     not a parallel reload path.

     MUTATION: delete `bindRetry(c, retryEpisodes)` from paintBody. `m.retry()`
     finds no bound listener and this goes red. MUTATION 2: have retryEpisodes
     skip `loadEpisodes()`. The body stays on "Loading episodes…" and the second
     assertion goes red. Both RUN: failed as named. */
  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error("network down"));
    return Promise.resolve({ ok: true, json: async () => ({ show_id: "show-b", next_cursor: null, episodes: [RAW_EP("e1", "Second Try Ep")] }) });
  };
  const m = mount({ fetchImpl });
  seed(m.ctx, { show: BREADTH });

  m.ctx.renderShow("show-b");
  await flushMicrotasks();
  assert.match(m.body(), /Couldn't load these episodes/);
  assert.match(m.body(), /Try again/, `the failed state must offer a retry, got: ${m.body()}`);
  assert.doesNotMatch(m.body(), /Pull to refresh/i, "no gesture this page does not have");

  assert.ok(m.retry(), "the Try again button must be wired to something");
  await flushMicrotasks();
  assert.strictEqual(calls, 2, "the retry is the same fetch, made again");
  assert.match(m.body(), /Second Try Ep/, `the retry's answer must be painted, got: ${m.body()}`);
  assert.doesNotMatch(m.subtitle(), /couldn't/i, `a retry that worked must not leave the failure in the subtitle: "${m.subtitle()}"`);
});

test("a cached list does not claim 'couldn't refresh' before any refresh has been tried", async () => {
  /* The cache entry's `stale` flag is a true fact about the STORED response,
     but the subtitle words it as a present-tense failure. At first paint the
     refresh that would decide it has not been sent.

     MUTATION: restore `if (cached.stale) anyStale = true;` in the cached first
     paint. This goes red. RUN: failed as named. */
  const m = mount({ fetchImpl: () => new Promise(() => {}) }); // the refresh never answers
  seed(m.ctx, { show: BREADTH });
  m.ctx.cacheShowEpisodes("show-b", { episodes: [RAW_EP("e1"), RAW_EP("e2")], nextCursor: null, stale: true, show: null });

  m.ctx.renderShow("show-b");
  await flushMicrotasks();
  assert.match(m.body(), /e1/, "the cached list paints");
  assert.doesNotMatch(m.subtitle(), /couldn.t refresh/i,
    `no refresh has happened yet, so none can have failed — got "${m.subtitle()}"`);
});

test("a refresh that succeeds with the same list clears 'couldn't refresh'", async () => {
  /* `anyStale` used to be sticky and set only BELOW the unchanged-list early
     return, so a fresh answer that agreed with the stale list left the warning
     up for the whole visit.

     MUTATION: move `anyStale = !!stale; paintCount();` back below the
     `sameEpisodeList` return. The subtitle keeps the stale note. RUN: failed as
     named. */
  const eps = [RAW_EP("e1"), RAW_EP("e2")];
  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    return Promise.resolve({ ok: true, json: async () => ({ show_id: "show-b", next_cursor: null, stale: calls === 1, episodes: eps }) });
  };
  const m = mount({ fetchImpl });
  seed(m.ctx, { show: BREADTH });

  m.ctx.renderShow("show-b");   // first visit: the answer is stale
  await flushMicrotasks();
  assert.match(m.subtitle(), /couldn.t refresh/i, "a stale answer says so");

  m.ctx.renderShow("show-b");   // revisit inside the TTL: cached paint, then a FRESH, identical answer
  await flushMicrotasks();
  assert.strictEqual(calls, 2);
  assert.doesNotMatch(m.subtitle(), /couldn.t refresh/i,
    `the refresh succeeded, so the note must go — got "${m.subtitle()}"`);
  assert.match(m.subtitle(), /^2 episodes$/, `the count stays, got "${m.subtitle()}"`);
});

test("a failed refresh behind a cached list says 'couldn't refresh' once it has failed", async () => {
  /* The other direction, and the reason the flag moved rather than vanished:
     when the refresh really does fail, the sentence becomes true, and it is
     painted then — without touching the list the listener is reading.

     MUTATION: drop `anyStale = true; paintCount();` from the `episodes === null`
     branch's cached case. The failure goes unsaid. RUN: failed as named. */
  const m = mount({ fetchImpl: () => Promise.reject(new Error("down")) });
  seed(m.ctx, { show: BREADTH });
  m.ctx.cacheShowEpisodes("show-b", { episodes: [RAW_EP("e1")], nextCursor: null, stale: false, show: null });

  m.ctx.renderShow("show-b");
  await flushMicrotasks();
  assert.match(m.body(), /e1/, "the cached list is untouched");
  assert.match(m.subtitle(), /couldn.t refresh/i, `the failed refresh is reported, got "${m.subtitle()}"`);
});

test("a show with no episodes still shows the publisher's description", async () => {
  /* The empty branch returned before the description was painted, so the
     emptiest page in the app withheld the one paragraph the response carried.

     MUTATION: move `if (header) paintShowDescription(header);` back below the
     `episodes.length === 0` branch. The description is never painted. RUN:
     failed as named. */
  const m = mount({ fetchImpl: ok({ show_id: "show-b", episodes: [], show: { description: "A show about quiet things." } }) });
  seed(m.ctx, { show: BREADTH });

  m.ctx.renderShow("show-b");
  await flushMicrotasks();
  assert.match(m.body(), /No episodes yet/);
  assert.match(m.description(), /A show about quiet things/, `got description: "${m.description()}"`);
});
