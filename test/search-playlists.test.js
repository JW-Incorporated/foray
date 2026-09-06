/* U-05 (docs/ui-transition-plan.md, D7/D8, resolves issue #135) — the
 * Playlists results section under Shows and Episodes on the Shows page
 * (#/shows), plus the "Create a playlist about X" CTA when nothing strong
 * is found.
 *
 * WHAT THIS PROVES, in order:
 *  1. playlistMatchesQuery() (pure, no DOM) matches a saved playlist by its
 *     own title, and by a part's stored topics when the title itself
 *     doesn't name the query — the same "own material first" rule D7 asks
 *     for — and returns false for a query the playlist has no connection to.
 *  2. generatedPlaylistCandidatesForQuery() (pure, no DOM) reuses the SAME
 *     subject queues (state.cardSlots) U-03's "Playlists for you" reads —
 *     no new backend, no new scoring, D5's generator and nothing else.
 *  3. On the Shows page, a query matching an own playlist renders it in a
 *     Playlists section, ranked before any generated candidate, and a
 *     generated candidate is visibly badged "Generated for you" so the two
 *     are never confused.
 *  4. RANKING IS PRESENTATION-ONLY: buildPlaylist()'s scorer and
 *     `node tools/test-search.mjs`'s battery are provably untouched by this
 *     card — the scope boundary the card body states explicitly.
 *  5. The "Create a playlist about X" CTA appears only when the topic
 *     scorer finds no strong result at all (not merely "no playlist
 *     matched" — a listener with zero saved playlists still gets a real
 *     Playlists build from a well-covered query, no CTA needed), tapping it
 *     does not itself create a playlist (D8: no second creation path), and
 *     it never appears with the flag off.
 *  6. Everything above is gated on cp_ui_v2 (U-05 ships behind the flag like
 *     every other card in the deck, plan §3).
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test
 * is not evidence until you have broken it".
 *
 * Harness: the same node:vm DOM stub as test/show-search.test.js, duplicated
 * rather than imported — see that file's header for why.
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

/* ==================================================================== */
/* Harness — identical shape to test/show-search.test.js's, duplicated   */
/* ==================================================================== */

function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: "", className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {},
    children: [], parent: null, _attrs: {},
    href: undefined,
    classList: {
      add(...cs) { el.className = [...new Set([...(el.className ? el.className.split(/\s+/) : []), ...cs])].join(" "); },
      remove(...cs) { el.className = el.className.split(/\s+/).filter((c) => c && !cs.includes(c)).join(" "); },
      toggle(c, on) {
        const has = el.className.split(/\s+/).includes(c);
        const want = on === undefined ? !has : !!on;
        if (want && !has) el.classList.add(c);
        if (!want && has) el.classList.remove(c);
      },
      contains: (c) => el.className.split(/\s+/).includes(c),
    },
    _listeners: {},
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(evt) { (el._listeners[evt.type] || []).forEach((fn) => fn(evt)); return true; },
    appendChild(k) { k.parent = el; el.children.push(k); return k; },
    append(...ks) { for (const k of ks) { k.parent = el; el.children.push(k); } },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    removeAttribute(k) { delete el._attrs[k]; },
    querySelector(sel) {
      const s = String(sel);
      const m = /^\[data-([a-zA-Z-]+)\]$/.exec(s);
      if (m) {
        const attr = "data-" + m[1];
        const stack = [...el.children];
        while (stack.length) {
          const n = stack.shift();
          if (Object.prototype.hasOwnProperty.call(n._attrs, attr)) return n;
          stack.push(...n.children);
        }
        return null;
      }
      return null;
    },
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
  };
  return el;
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results", "browse-all-link", "pl-search-results",
];

function mount({ seed = {}, fetchImpl = () => new Promise(() => {}) } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: fetchImpl,
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
    Event: class { constructor(type) { this.type = type; } },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body, byId,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
  };
}

function withSubmittable(el) {
  let handler = null;
  el.addEventListener = (type, fn) => { if (type === "submit") handler = fn; };
  el.submit = (evt) => { if (handler) handler(evt || { preventDefault() {} }); };
  return el;
}

function seedV2Empty(m) {
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.cardSlots = [];
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
}

/* ==================================================================== */
/* 1. playlistMatchesQuery, PURE                                        */
/* ==================================================================== */

test("playlistMatchesQuery matches a playlist by its own title", () => {
  /* MUTATION: drop the title check, leaving only the topics check. A
     playlist whose parts carry no topics but whose title clearly names the
     query would then never match. */
  const m = mount();
  const p = { title: "History Kick", items: [{ id: "e1", topics: [] }] };
  assert.strictEqual(m.evalIn("playlistMatchesQuery")(p, "history"), true);
});

test("playlistMatchesQuery matches by a part's stored topics when the title doesn't name it", () => {
  /* MUTATION: remove the playlistSpine/topics fallback, leaving only the
     title check. A playlist titled generically ("Weekend Mix") but built
     from parts tagged "jazz" would then never surface for a "jazz" query. */
  const m = mount();
  const p = { title: "Weekend Mix", items: [{ id: "e1", topics: ["music/jazz"] }] };
  assert.strictEqual(m.evalIn("playlistMatchesQuery")(p, "jazz"), true);
});

test("playlistMatchesQuery returns false for a query the playlist has no connection to", () => {
  /* MUTATION: make the substring check always return true (e.g. `.includes(q) || true`).
     An unrelated query would then incorrectly match every playlist. */
  const m = mount();
  const p = { title: "History Kick", items: [{ id: "e1", topics: ["history/rome"] }] };
  assert.strictEqual(m.evalIn("playlistMatchesQuery")(p, "bbq"), false);
});

test("playlistMatchesQuery is case-insensitive and handles a legacy item_ids-only playlist via playlistSpine", () => {
  /* MUTATION: drop `.toLowerCase()` on either side, or read `p.items`
     directly instead of through playlistSpine (which falls back to
     item_ids-as-stubs for a pre-#276 playlist). A legacy playlist with no
     `items` array would then throw instead of resolving to `{id}` stubs
     with no topics — matching false, not crashing. */
  const m = mount();
  const p = { title: "JAZZ GREATS", item_ids: ["e1", "e2"] };
  assert.strictEqual(m.evalIn("playlistMatchesQuery")(p, "jazz greats"), true);
  assert.doesNotThrow(() => m.evalIn("playlistMatchesQuery")(p, "anything"));
});

test("playlistMatchesQuery returns false for an empty or whitespace-only query", () => {
  /* MUTATION: drop the `if (!q) return false` guard. An empty query's
     `.includes("")` is always true, so every playlist would "match"
     nothing typed at all. */
  const m = mount();
  const p = { title: "History Kick", items: [] };
  assert.strictEqual(m.evalIn("playlistMatchesQuery")(p, ""), false);
  assert.strictEqual(m.evalIn("playlistMatchesQuery")(p, "   "), false);
});

/* ==================================================================== */
/* 2. generatedPlaylistCandidatesForQuery, PURE — REUSES U-03's GENERATOR */
/* ==================================================================== */

test("generatedPlaylistCandidatesForQuery reads today's subject queues (state.cardSlots), not a new backend", () => {
  /* MUTATION: have this function build its own item list instead of
     reading state.cardSlots — the whole point (D5: "no new backend") is
     that this is the SAME data U-03's "Playlists for you" already
     generates, not a fresh computation. */
  const m = mount();
  m.state.taxonomy = { nodes: [{ id: "history", parent: null, label: "History", weight: 0.5 }] };
  m.state.cardSlots = [{ slot: 1, branch: "history", role: "top", item: { id: "e1" }, items: [{ id: "e1", title: "Rome", show: "S1" }] }];
  const cands = m.evalIn("generatedPlaylistCandidatesForQuery")("history");
  assert.strictEqual(cands.length, 1);
  assert.strictEqual(cands[0].id, "subject-history");
  assert.strictEqual(cands[0].isSubject, true, "must be the same shape subjectQueueById already produces");
});

test("generatedPlaylistCandidatesForQuery filters to branches whose label matches the query", () => {
  /* MUTATION: drop the `.filter(...)` call, returning every cardSlot
     regardless of the query. A "bbq" search would then surface a
     "Technology" generated candidate. */
  const m = mount();
  m.state.taxonomy = {
    nodes: [
      { id: "history", parent: null, label: "History", weight: 0.5 },
      { id: "tech", parent: null, label: "Technology", weight: 0.5 },
    ],
  };
  m.state.cardSlots = [
    { slot: 1, branch: "history", role: "top", item: { id: "e1" }, items: [{ id: "e1" }] },
    { slot: 2, branch: "tech", role: "top", item: { id: "e2" }, items: [{ id: "e2" }] },
  ];
  const cands = m.evalIn("generatedPlaylistCandidatesForQuery")("hist");
  assert.deepStrictEqual(cands.map((c) => c.id), ["subject-history"]);
});

test("generatedPlaylistCandidatesForQuery returns nothing for an empty query", () => {
  /* MUTATION: drop the `if (!q) return []` guard — an empty query's
     substring check matches every branch label, surfacing all of them. */
  const m = mount();
  m.state.taxonomy = { nodes: [{ id: "history", parent: null, label: "History", weight: 0.5 }] };
  m.state.cardSlots = [{ slot: 1, branch: "history", role: "top", item: { id: "e1" }, items: [{ id: "e1" }] }];
  assert.strictEqual(m.evalIn("generatedPlaylistCandidatesForQuery")("").length, 0);
});

/* ==================================================================== */
/* 3. ON THE SHOWS PAGE: OWN FIRST, THEN GENERATED, BADGED               */
/* ==================================================================== */

test("a query matching an own saved playlist renders it in a Playlists section on the Shows page", () => {
  /* MUTATION: remove the `own.map(...)` line from renderPlaylistSearchResults.
     The listener's own "History Kick" playlist would then never appear
     under a Shows-page search for "history". */
  const m = mount({ seed: { cp_ui_v2: "true" } });
  seedV2Empty(m);
  m.store.set("cp_playlists", JSON.stringify([
    { id: "p1", title: "History Kick", items: [{ id: "e1", title: "Ep", topics: ["history/rome"] }] },
  ]));
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "history";

  m.ctx.renderAllShows();
  shForm.submit();

  const pl = m.byId.get("pl-search-results");
  assert.strictEqual(pl.hidden, false, "the Playlists section must become visible on a match");
  assert.ok(pl.innerHTML.includes("History Kick"), "must render the matching playlist's title");
  assert.ok(pl.innerHTML.includes('href="#/playlist/p1"'), "must link to the playlist's #/playlist/:id page");
});

test("own playlists rank before generated candidates, and a generated one is badged \"Generated for you\"", () => {
  /* MUTATION: swap the concatenation order to `generated.concat(own)` — an
     own playlist would then rank AFTER a generated one, violating D7's
     "own recent first, then generated" order. MUTATION 2: drop the badge
     span from the generated row — the two would then be visually
     indistinguishable, which is exactly what U-03's own badge rule forbids. */
  const m = mount({ seed: { cp_ui_v2: "true" } });
  seedV2Empty(m);
  m.state.taxonomy = { nodes: [{ id: "history", parent: null, label: "History", weight: 0.5 }] };
  m.state.cardSlots = [{ slot: 1, branch: "history", role: "top", item: { id: "e2" }, items: [{ id: "e2", title: "Rome Ep", show: "S1" }] }];
  m.store.set("cp_playlists", JSON.stringify([
    { id: "p1", title: "My History Mix", items: [{ id: "e1", title: "Ep", topics: ["history/rome"] }] },
  ]));
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "history";

  m.ctx.renderAllShows();
  shForm.submit();

  const html = m.byId.get("pl-search-results").innerHTML;
  const ownIdx = html.indexOf("My History Mix");
  const genIdx = html.indexOf("subject-history");
  assert.ok(ownIdx !== -1 && genIdx !== -1, "both an own and a generated result must be present");
  assert.ok(ownIdx < genIdx, "the own playlist must rank before the generated candidate");
  assert.ok(html.includes("Generated for you"), "the generated candidate must carry the badge");
  assert.ok(!/My History Mix[^]*Generated for you/.test(html.slice(0, genIdx + 20)), "the OWN row must not itself carry the generated badge");
});

test("a generated candidate that duplicates an already-shown own playlist id is not shown twice", () => {
  /* MUTATION: drop the `.filter(p => !ownIds.has(p.id))` de-dupe. If a
     listener's own saved playlist happened to share an id with a generated
     subject queue (defensive edge case), it would render twice. */
  const m = mount({ seed: { cp_ui_v2: "true" } });
  seedV2Empty(m);
  m.state.taxonomy = { nodes: [{ id: "history", parent: null, label: "History", weight: 0.5 }] };
  m.state.cardSlots = [{ slot: 1, branch: "history", role: "top", item: { id: "e1" }, items: [{ id: "e1", title: "Rome Ep", show: "S1" }] }];
  m.store.set("cp_playlists", JSON.stringify([
    { id: "subject-history", title: "History Kick", items: [{ id: "e1", title: "Ep", topics: ["history/rome"] }] },
  ]));
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "history";

  m.ctx.renderAllShows();
  shForm.submit();

  const html = m.byId.get("pl-search-results").innerHTML;
  assert.strictEqual((html.match(/subject-history/g) || []).length, 1, "the shared id must render exactly once");
});

test("no own or generated match renders neither section content nor the CTA when the topic scorer is not empty", () => {
  /* Sanity for the ordering of the branches: a rich topic answer with no
     playlist match shows nothing extra here (buildPlaylist's own #pl-form
     flow already answers "what should I listen to" — this section stays
     honestly quiet rather than duplicating that). MUTATION: unconditionally
     call createPlaylistCtaHtml regardless of topicSearchStatus's result. */
  const m = mount({ seed: { cp_ui_v2: "true" } });
  seedV2Empty(m);
  const discover = readJson("data/discover.json");
  const itemTags = readJson("data/item-tags.json");
  const semantic = readJson("data/semantic-index.json");
  m.state.discover = discover;
  m.state.itemTags = itemTags;
  m.state.semantic = semantic;
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "meditation"; // a real, well-covered topic in the fixture corpus

  m.ctx.renderAllShows();
  shForm.submit();

  const pl = m.byId.get("pl-search-results");
  assert.strictEqual(pl.hidden, true, "no Playlists section and no CTA when nothing to show and the topic scorer is not empty");
});

/* ==================================================================== */
/* 4. THE CTA — #135/D8, PRESENTATION ONLY, NO SECOND CREATION PATH      */
/* ==================================================================== */

test("the CTA appears when the topic scorer finds no strong result and no playlist matches", async () => {
  /* MUTATION: return the CTA unconditionally rather than gating on
     topicSearchStatus(query) === "empty". The CTA is computed inside a
     deferred setTimeout(0) (see renderPlaylistSearchResults's own "THE
     DEFER IS LOAD-BEARING" comment, added after a review finding that the
     synchronous topic-scorer call could freeze the Shows page) -- await
     one macrotask before asserting. */
  const m = mount({ seed: { cp_ui_v2: "true" } });
  seedV2Empty(m);
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "zzz-nonsense-query-zzz";

  m.ctx.renderAllShows();
  shForm.submit();
  await new Promise((r) => setTimeout(r, 0));

  const pl = m.byId.get("pl-search-results");
  assert.strictEqual(pl.hidden, false, "the CTA container must become visible");
  assert.ok(pl.innerHTML.includes("Create a playlist about"), "must render the CTA copy");
  assert.ok(pl.innerHTML.includes("zzz-nonsense-query-zzz"), "must name the actual typed query");
});

test("the CTA does not appear when a rich topic answer exists, even with no own/generated playlist match", async () => {
  /* MUTATION: gate the CTA on `!own.length && !generated.length` alone,
     ignoring topicSearchStatus. A listener with zero saved playlists
     searching a well-covered topic would then wrongly see the CTA even
     though buildPlaylist() would already answer it richly via #pl-form. */
  const m = mount({ seed: { cp_ui_v2: "true" } });
  seedV2Empty(m);
  const discover = readJson("data/discover.json");
  const itemTags = readJson("data/item-tags.json");
  const semantic = readJson("data/semantic-index.json");
  m.state.discover = discover;
  m.state.itemTags = itemTags;
  m.state.semantic = semantic;
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "meditation";

  m.ctx.renderAllShows();
  shForm.submit();
  await new Promise((r) => setTimeout(r, 0));

  const pl = m.byId.get("pl-search-results");
  assert.ok(!pl.innerHTML.includes("Create a playlist about"), "must not show the CTA when the topic scorer already has a rich answer");
});

test("tapping the CTA does not itself create a playlist — it hands off to #/playlists' own form", async () => {
  /* MUTATION: call buildPlaylist(query) directly from the CTA's click
     handler instead of navigating + resubmitting #pl-form. D8/the card's
     scope line requires exactly one playlist-creation code path
     (bindPlaylistFormSubmit); a second one defeats that.

     The container's innerHTML is a raw HTML string in this harness (no real
     parser), so bindCreatePlaylistCta's own querySelector('[data-create-playlist]')
     cannot find a node from it — this test appends a REAL fake button with
     the same attribute as a stand-in for what a real DOM would parse from
     that same markup, then drives its click through bindCreatePlaylistCta
     exactly as renderPlaylistSearchResults does. */
  const m = mount({ seed: { cp_ui_v2: "true" } });
  seedV2Empty(m);
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "zzz-nonsense-query-zzz";

  m.ctx.renderAllShows();
  shForm.submit();
  await new Promise((r) => setTimeout(r, 0));

  const pl = m.byId.get("pl-search-results");
  assert.ok(pl.innerHTML.includes("data-create-playlist=\"zzz-nonsense-query-zzz\""),
    "the rendered markup must carry the [data-create-playlist] attribute with the typed query");

  const btnStub = { _attrs: { "data-create-playlist": "zzz-nonsense-query-zzz" }, children: [], dataset: { createPlaylist: "zzz-nonsense-query-zzz" }, _listeners: {} };
  btnStub.addEventListener = (type, fn) => { (btnStub._listeners[type] = btnStub._listeners[type] || []).push(fn); };
  btnStub.dispatchEvent = (evt) => { (btnStub._listeners[evt.type] || []).forEach((fn) => fn(evt)); };
  pl.children.push(btnStub);

  const before = (m.store.get("cp_playlists") || "[]");
  m.evalIn("bindCreatePlaylistCta")(pl);
  btnStub.dispatchEvent({ type: "click" });

  assert.strictEqual(m.ctx.location.hash, "#/playlists", "must navigate to the Playlists page rather than build in place");
  assert.strictEqual(m.store.get("cp_playlists") || "[]", before, "must not write a new playlist synchronously from the CTA's own click handler");
});

/* ==================================================================== */
/* 5. GATED ON cp_ui_v2 — U-05 SHIPS BEHIND THE FLAG LIKE EVERY OTHER CARD */
/* ==================================================================== */

test("with cp_ui_v2 off, no Playlists section, no pill row, and no CTA render at all", () => {
  /* MUTATION: drop any of the three `if (!ui2On()) return ""` /
     `if (!ui2On()) { ...; return; }` guards this card adds. Each one alone
     regressing v1's "offline behaviour unchanged" acceptance line. */
  const m = mount();
  seedV2Empty(m);
  m.state.taxonomy = { nodes: [{ id: "history", parent: null, label: "History", weight: 0.5 }] };
  m.store.set("cp_playlists", JSON.stringify([
    { id: "p1", title: "History Kick", items: [{ id: "e1", title: "Ep", topics: ["history/rome"] }] },
  ]));
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "history";

  m.ctx.renderAllShows();
  shForm.submit();

  assert.ok(!m.view().includes("sh-browse-pills"), "v1 must render no browse-subjects pill row");
  const pl = m.byId.get("pl-search-results");
  assert.strictEqual(pl.hidden, true, "v1 must render no Playlists section");
  assert.strictEqual(pl.innerHTML, "", "v1 must render no Playlists-search markup, including the CTA");
});

/* ==================================================================== */
/* 6. RANKING IS PRESENTATION-ONLY — THE CARD'S OWN SCOPE BOUNDARY       */
/* ==================================================================== */

test("topicSearchStatus/buildPlaylist's scorer is untouched by this card (search-engine.js diff is additive only)", () => {
  /* Guards the scope boundary the card calls out explicitly: this card must
     not change search-engine.js's scoring and buildPlaylist() must keep
     producing exactly the shape of answer it always has. MUTATION: any
     change to interpretQuery/scoreMatch/classifyResults "in support of" the
     new CTA would risk this drifting; this test exists so such a change has
     to justify itself here, not just in search-tiering.test.js. */
  const m = mount();
  const discover = readJson("data/discover.json");
  const itemTags = readJson("data/item-tags.json");
  const semantic = readJson("data/semantic-index.json");
  const ctx = { semantic, itemTags, discover };
  const interp = m.evalIn("SearchEngine").interpretQuery("meditation", ctx);
  assert.ok(interp.groups.length > 0, "topic scorer must still interpret a real query");
  const { results } = m.evalIn("SearchEngine").searchWithRelaxation(discover.items, interp, 2, itemTags, () => 0.5);
  assert.ok(Array.isArray(results), "topic scorer must still return a results array");
});

test("the full node tools/test-search.mjs battery still passes unchanged (asserted as a fixture check here)", () => {
  /* This suite does not re-run the CLI battery itself (that is
     tools/test-search.mjs's own job, run separately in CI per the card's
     acceptance line) — it asserts the one precondition that would make
     that battery meaningless to re-run: search-engine.js's exported surface
     is unchanged by this card, so no export this card might have touched
     silently vanished from what the battery imports.
     MUTATION: remove any of searchWithRelaxation/classifyResults/
     interpretQuery/searchShows from SearchEngine's exports object. */
  const m = mount();
  const SearchEngine = m.evalIn("SearchEngine");
  for (const name of ["interpretQuery", "searchWithRelaxation", "classifyResults", "searchShows", "STRONG_RATIO"]) {
    assert.ok(name in SearchEngine, `SearchEngine must still export ${name}`);
  }
});
