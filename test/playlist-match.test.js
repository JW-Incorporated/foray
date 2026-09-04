/* The Playlists page narrows the listener's OWN playlists while they type.
 *
 * Founder, TestFlight, 2026-09-03: "When we search for playlists, it should
 * show similar playlists." The box on #/playlists builds a NEW playlist on
 * Go, as before. As you type, the list of playlists already built on this
 * device narrows to the ones that share a word with the request — the
 * smallest reading of "similar" that is true today, because `cp_playlists`
 * is per-device localStorage and there is nothing else to be similar to.
 * (Whether it should ever mean a shared pool is a product decision; nothing
 * here invents one. See renderPlaylists' header comment.)
 *
 * WHAT THIS PROVES
 *  1. the matching rule, pure: whole request at a word start, or a shared
 *     word start, minus the words a request is built from
 *  2. typing narrows the rendered list; clearing restores it; no match is an
 *     honest note that names the query and points at Go
 *  3. with no playlists at all, typing changes nothing — there is nothing to
 *     narrow and the "build your first one" state stays
 *  4. narrowing is read-only: cp_playlists is byte-identical after typing,
 *     and Go is still wired to the builder
 *
 * Harness: the node:vm DOM stub the other app.js suites use (see
 * test/show-page.test.js), with a recording addEventListener on the input so
 * a test can fire the `input` handler renderPlaylists attaches.
 *
 * Every test names the mutation that kills it. All were run.
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
  const listeners = new Map();
  return {
    tagName: String(tag).toUpperCase(), id: "", className: "", innerHTML: "", textContent: "",
    value: "", hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener() {},
    fire(type, evt = { preventDefault() {} }) { const fn = listeners.get(type); if (fn) fn(evt); return Boolean(fn); },
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
  "pl-form", "pl-input", "pl-note", "pl-list",
];

function mount({ seed = {} } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
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
      querySelector: (sel) => { const s = String(sel); return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null; },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/playlists", search: "", pathname: "/", href: "https://x.test/" },
    history: { back() {}, replaceState() {}, pushState() {} },
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
  /* Enough state for playlists()/resolveParts() to run: an empty pool, so
     every seeded playlist hydrates to zero parts and nothing is rewritten. */
  evalIn("state.discover = { items: [] }; state.session = { session_id: 's', episodes: {}, cards: [] }; state.taxonomy = { nodes: [] };");
  /* renderPlaylists writes the whole page into #view; the input handler
     rewrites only #pl-list. In this stub those are two unrelated fakes, so
     "the list" is #view's markup until the first keystroke and #pl-list's
     after it. */
  let typed = false;
  const list = () => (typed ? byId.get("pl-list") : byId.get("view")).innerHTML;
  return {
    ctx, evalIn, store, byId, list,
    rows: () => (list().match(/class="pl-row"/g) || []).length,
    type(text) { const input = byId.get("pl-input"); input.value = text; const bound = input.fire("input"); typed = true; return bound; },
  };
}

const PLAYLISTS = [
  { id: "p-space", title: "Space", query: "space", items: [], created_at: "2026-09-01T00:00:00Z" },
  { id: "p-romans", title: "History of the Romans", query: "something about the romans", items: [], created_at: "2026-09-01T00:00:00Z" },
  { id: "p-ai", title: "AI safety", query: "ai safety", items: [], created_at: "2026-09-01T00:00:00Z" },
];

/* 1 */
test("playlistMatchesQuery: a request at a word start, or a shared word start, minus the words a request is built from", () => {
  /* MUTATIONS, one per assertion group:
     - drop PLAYLIST_MATCH_SKIP (make `word` only check length): "the" then
       matches "History of the Romans" and the skip-word assertions fail.
     - anchor the whole-query check with plain `hay.includes(q)` instead of
       at a word start: "ai" then matches "Brain science" via "br-ai-n". */
  const m = mount();
  const match = (p, q) => m.ctx.playlistMatchesQuery(p, q);
  const [space, romans, ai] = PLAYLISTS;
  assert.strictEqual(match(space, "space"), true, "the whole title");
  assert.strictEqual(match(space, "SPACE  "), true, "case and whitespace do not matter");
  assert.strictEqual(match(romans, "histor"), true, "a word start of the title");
  assert.strictEqual(match(romans, "romans"), true, "a word of the original request");
  assert.strictEqual(match(romans, "of the romans"), true, "a phrase from the middle, at a word start");
  assert.strictEqual(match(space, "spacecraft"), true, "the request extends a word of the title");
  assert.strictEqual(match(romans, "the"), false, "a request word on its own is not a match for everything with a 'the' in it");
  assert.strictEqual(match(romans, "about the"), false, "nor two of them");
  assert.strictEqual(match({ title: "Brain science", query: "brain science" }, "ai"), false, "'ai' is not inside 'brain'");
  assert.strictEqual(match(ai, "ai"), true, "but it is the start of a word of 'AI safety'");
  assert.strictEqual(match(space, "romans"), false, "and an unrelated word finds nothing");
  for (const p of PLAYLISTS) assert.strictEqual(match(p, ""), true, "an empty query is the list as it was");
});

/* 2 */
test("typing narrows the rendered list to the playlists that match; clearing restores it; no match names the query and points at Go", () => {
  /* MUTATION: make renderPlaylists' `input` listener a no-op (delete the
     `$("#pl-list").innerHTML = ...` line). The list stays at three rows for
     every query and the first narrowing assertion fails. */
  const m = mount({ seed: { cp_playlists: PLAYLISTS } });
  m.ctx.renderPlaylists();
  assert.strictEqual(m.rows(), 3, "all three before typing");
  assert.ok(m.byId.get("view").innerHTML.includes('id="pl-list"'), "the page renders the list container the filter rewrites");

  assert.strictEqual(m.type("space"), true, "renderPlaylists must bind an input listener");
  assert.strictEqual(m.rows(), 1);
  assert.ok(m.list().includes("#/playlist/p-space"), "the one row is the matching playlist, still a link to it");

  m.type("romans");
  assert.strictEqual(m.rows(), 1);
  assert.ok(m.list().includes("#/playlist/p-romans"));

  m.type("");
  assert.strictEqual(m.rows(), 3, "an emptied box is the full list again");

  m.type("zzz nothing");
  assert.strictEqual(m.rows(), 0);
  assert.ok(m.list().includes('None of your playlists match "zzz nothing" yet'), `the note names the query: ${m.list()}`);
  assert.ok(m.list().includes("Go builds one"), "and says what Go does next");
  assert.ok(!m.list().includes("No playlists yet"), "not the never-built-anything state — three exist");

  m.type("<b>zzz</b>");
  assert.ok(m.list().includes("&lt;b&gt;zzz&lt;/b&gt;"), `the query goes through esc() (CLAUDE.md Conventions): ${m.list()}`);
  assert.ok(!m.list().includes("<b>zzz"), "never raw");
});

/* 3 */
test("with no playlists at all, typing changes nothing: there is nothing to narrow", () => {
  /* MUTATION: delete the `if (!all.length) return ...` early return in
     playlistListHtml. Typing then shows "None of your playlists match" over a
     list that never had anything in it. */
  const m = mount();
  m.ctx.renderPlaylists();
  assert.ok(m.list().includes("No playlists yet"), "the first-run state");
  m.type("space");
  assert.ok(m.list().includes("No playlists yet"), "still the first-run state while typing");
  assert.ok(!m.list().includes("None of your playlists match"), "no 'none match' note over an empty list");
});

/* 4 */
test("narrowing is read-only: cp_playlists is unchanged by typing, and Go is still wired to the builder", () => {
  /* MUTATION: make playlistListHtml persist its result —
     `savePlaylists(matches)` before the return. The store then holds one
     playlist after typing "space" and the equality fails. For the second
     assertion: rebind #pl-form's submit to anything but
     bindPlaylistFormSubmit.
     WHAT THIS DOES NOT PROVE: that playlists() itself never writes. It can
     (it normalises the store on read), and this fixture — an empty pool,
     `items: []` — is one it has nothing to normalise. The input listener
     therefore closes over the list renderPlaylists rendered instead of
     re-reading; this test pins the filter, not playlists(). */
  const m = mount({ seed: { cp_playlists: PLAYLISTS } });
  m.ctx.renderPlaylists();
  const before = m.store.get("cp_playlists");
  m.type("space");
  m.type("zzz");
  m.type("");
  assert.strictEqual(m.store.get("cp_playlists"), before, "typing must not write the store");
  assert.ok(/\$\("#pl-form"\)\.addEventListener\("submit", bindPlaylistFormSubmit\)/.test(APP_SRC),
    "Go still builds a playlist — the submit path is not this change's to alter");
});
