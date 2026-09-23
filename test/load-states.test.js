/* Loading, failed and empty are three different pages — audit 2026-09-22, theme G.
 *
 * THE DEFECT, as the audit found it at ten sites: something still loading and
 * something that failed to load were both painted as a FACT about 4a. "0 forays"
 * and "No forays right now" whenever `player/client.js` had not evaluated yet;
 * "No shows here yet." when `data/catalog-client.json` 404'd; "Show not found."
 * when the endpoint that would have found it was down; one-sentence not-found
 * pages with no way back. Every one of those pages knew, or could have known,
 * which of the three states it was in, and threw the distinction away at the
 * paint.
 *
 * THE CONVENTION this suite pins (app.js, "loading / failed / empty: ONE
 * convention"):
 *   loading — says it is loading and claims nothing.
 *   failed  — says it failed and offers "Try again", wired to the SAME fetch.
 *   empty   — only once the source has answered, and answered "nothing".
 * plus: every status page carries a page head with ‹.
 *
 * The show page's own episode region has its own suite
 * (test/show-episode-load-states.test.js); this one covers the other routes.
 *
 * AND ITS SIBLING, theme L — "a count and its rows come from one source": the
 * Foray header's numbers against the strip's model, episode rows' progress
 * against the player's one reading of a position, a "played" count that the
 * history ring cannot shrink, a duration total over the same population as the
 * count beside it.
 *
 * Harness: the REAL app.js in a node:vm over a small DOM whose innerHTML is
 * parsed into a NESTED tree (tags, ids, classes and data-* attributes), because
 * "Try again" is found by `scope.querySelector("[data-retry]")` inside a
 * specific container and a flat stub would find it anywhere. init()'s own boot
 * fetches never resolve, so nothing repaints #view behind a test's back.
 *
 * Every test names the mutation that turns it red; each was run red before
 * being run green. The floor for this suite lives in test/suite-integrity.test.js.
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

/* ---------- a DOM whose innerHTML becomes a real (small) tree ---------- */

const VOID = new Set(["img", "input", "br", "hr", "meta", "link", "source", "wbr"]);

class El {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.parent = null;
    this.id = null;
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.attrs = {};
    this.dataset = {};
    this.style = { setProperty() {} };
    this._html = "";
    this._on = new Map();
    const cls = () => new Set(String(this.className).split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...c) => { const s = cls(); c.forEach((x) => s.add(x)); this.className = [...s].join(" "); },
      remove: (...c) => { const s = cls(); c.forEach((x) => s.delete(x)); this.className = [...s].join(" "); },
      contains: (c) => cls().has(c),
      toggle: (c, on) => { const want = on ?? !cls().has(c); if (want) this.classList.add(c); else this.classList.remove(c); return want; },
    };
  }
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = String(html);
    this.children = [];
    const stack = [this];
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
    let m;
    while ((m = re.exec(this._html))) {
      const [, closing, tag, rest] = m;
      if (closing) { if (stack.length > 1) stack.pop(); continue; }
      const kid = new El(tag);
      for (const a of rest.matchAll(/([a-zA-Z_:][\w:.-]*)(?:="([^"]*)")?/g)) {
        const [, name, val = ""] = a;
        kid.attrs[name] = val;
        if (name === "id") kid.id = val;
        if (name === "class") kid.className = val;
        if (name === "hidden") kid.hidden = true;
        if (name.startsWith("data-")) kid.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
      }
      stack[stack.length - 1].appendChild(kid);
      if (!VOID.has(tag.toLowerCase()) && !/\/\s*$/.test(rest)) stack.push(kid);
    }
  }
  appendChild(k) { k.parent = this; this.children.push(k); return k; }
  append(...ks) { ks.forEach((k) => this.appendChild(k)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { if (!this._on.has(t)) this._on.set(t, []); this._on.get(t).push(fn); }
  removeEventListener() {}

  /** Fire this element's click listeners, once-listeners included. */
  click() { const fns = this._on.get("click") || []; this._on.set("click", []); for (const fn of fns) fn({ target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} select() {}
  closest() { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const parts = String(sel).trim().split(/\s+/);
    let scopes = [this];
    for (const p of parts) scopes = scopes.flatMap((s) => s.descendants().filter((e) => matches(e, p)));
    return [...new Set(scopes)];
  }
}
function matches(el, sel) {
  return sel.split(/(?=[#.[])/).every((tok) => {
    if (tok.startsWith("#")) return el.id === tok.slice(1);
    if (tok.startsWith(".")) return el.classList.contains(tok.slice(1));
    if (tok.startsWith("[")) { const name = tok.slice(1, -1).split("=")[0]; return name in el.attrs; }
    return el.tagName === tok.toUpperCase();
  });
}

/* ---------- the mount ---------- */

function mount({ hash = "#/", fetchImpl = () => new Promise(() => {}), bridge = null } = {}) {
  const body = new El("body");
  const view = new El("main"); view.id = "view"; body.appendChild(view);
  for (const id of ["drawer", "drawer-overlay", "menu-btn", "refresh-btn", "drawer-playlists"]) {
    const e = new El("div"); e.id = id; body.appendChild(e);
  }
  const winListeners = new Map();
  const fetched = [];
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    /* Only what a test routes answers; everything else (init()'s boot fetches)
       hangs forever, so the boot can never repaint #view mid-test. */
    fetch: (url, opts) => { fetched.push(String(url)); return fetchImpl(String(url), opts); },
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body, documentElement: body, readyState: "complete", hidden: false,
      addEventListener() {}, removeEventListener() {},
      createElement: (t) => new El(t),
      querySelector: (s) => {
        const str = String(s).trim();
        if (str === "#view") return view;
        if (str.startsWith("#view ")) return view.querySelector(str.slice(6));
        return body.querySelector(str);
      },
      querySelectorAll: (s) => body.querySelectorAll(s),
    },
    navigator: { userAgent: "node", onLine: true },
    addEventListener(t, fn) { if (!winListeners.has(t)) winListeners.set(t, []); winListeners.get(t).push(fn); },
    removeEventListener() {},
    location: { hash, search: "", pathname: "/", href: "https://x.test/", protocol: "https:" },
    history: { replaceState() {}, pushState() {}, back() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, queueMicrotask,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  if (bridge) ctx.ForayPlayer = bridge;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const state = vm.runInContext("state", ctx);
  state.ready = true;
  state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
  state.discover = { items: [] };
  state.taxonomy = { nodes: [{ id: "science", label: "Science" }] };
  return {
    ctx, state, view, fetched,
    html: () => view.innerHTML,
    /** Press the first "Try again" inside `scope` (default: #view). */
    retry: (scope = view) => {
      const btn = scope.querySelector("[data-retry]");
      if (!btn) return false;
      btn.click();
      return true;
    },
    fire: (type) => { for (const fn of winListeners.get(type) || []) fn(); winListeners.set(type, []); },
  };
}

async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }

const okJson = (obj) => Promise.resolve({ ok: true, status: 200, json: async () => obj });
const CATALOG = { shows: [
  { show_id: "s1", title: "Alpha Show", taxonomy_node_ids: ["science"] },
  { show_id: "s2", title: "Beta Show", taxonomy_node_ids: [] },
] };

/* A bridge in the shape player/client.js exports — only what the Forays pages
   read. `listForays` answers from the document handed to it, so a test controls
   the list through `state.forays` exactly as the page does. */
const bridge = () => ({
  listForays: (doc) => (doc?.forays || []).filter((f) => f.status === "published"),
  forayResumeList: () => [],
  fmtClock: (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`,
  fmtSpan: (s) => `${Math.round(s / 60)} min`,
});
const FORAYS_DOC = { forays: [{ id: "f1", title: "First Foray", status: "published", items: [] }] };

/* ==================================================================== */
/* The catalogue: a failed fetch is not an empty catalogue               */
/* ==================================================================== */

test("#/shows with no catalogue says it could not load the list, and Try again fetches it", async () => {
  /* "No shows here yet." was painted over `state.catalog === null` — a claim
     about 4a's catalogue standing in for a failed fetch.
     MUTATION: in renderShowIndexPage, drop the `shows === null` branch (treat
     null like an empty list). This goes red on the first assertion. MUTATION 2:
     drop `bindRetry(... retryCatalog)`. The retry finds nothing to press. */
  const m = mount({
    hash: "#/shows",
    fetchImpl: (url) => (url.includes("data/catalog-client.json") ? okJson(CATALOG) : new Promise(() => {})),
  });
  m.state.catalog = null;
  m.ctx.renderCurrentPage();

  assert.match(m.html(), /Couldn't load the show list\./);
  assert.doesNotMatch(m.html(), /No shows here yet/, "a failed fetch is not an empty catalogue");
  assert.ok(m.retry(), "the failed list must offer Try again");
  await settle();
  assert.ok(m.fetched.some((u) => u.includes("data/catalog-client.json")), "Try again re-fetches the catalogue");
  assert.match(m.html(), /Alpha Show/, "and the page repaints from what it answered");
  assert.doesNotMatch(m.html(), /Couldn't load the show list/);
});

test("a category page counts nothing until the catalogue has answered", async () => {
  /* "0 shows" over a failed fetch was the same false claim as the sentence
     under it. The genuinely-empty category keeps both.
     MUTATION: delete the `catalogShowsOrNull() === null` guard in
     renderCategory. The failed page says "0 shows" and this goes red. */
  const m = mount({ hash: "#/category/science" });
  m.state.catalog = null;
  m.ctx.renderCurrentPage();
  assert.doesNotMatch(m.html(), /0 shows/, `no count without a catalogue: ${m.html()}`);
  assert.doesNotMatch(m.html(), /No shows here yet/);
  assert.match(m.html(), /Couldn't load the show list\./);

  m.state.catalog = { shows: [] };
  m.ctx.renderCurrentPage();
  assert.match(m.html(), /0 shows/, "an answered, empty catalogue is still counted");
  assert.match(m.html(), /No shows here yet/);
});

/* ==================================================================== */
/* Not-found and loading pages have a way back; a dead endpoint is not    */
/* a missing show                                                        */
/* ==================================================================== */

test("an unknown episode page has a ‹ back link", () => {
  /* MUTATION: restore the bare `<div class="page"><p class="note">Episode not
     found.</p></div>`. No `a.back`, and this goes red. */
  const m = mount({ hash: "#/episode/nope" });
  m.ctx.renderCurrentPage();
  assert.match(m.html(), /Episode not found\./);
  assert.ok(m.view.querySelector("a.back") || m.view.querySelector(".back"), `no way back: ${m.html()}`);
});

test("a show lookup that FAILED says so and retries; a genuine miss still says 'Show not found.'", async () => {
  /* The endpoint answers a real miss with 200 and `show: null` so the client can
     tell it from a failure, and `fetchApiJson` reports a failure as `null`. The
     page used to fold both into "Show not found.".
     MUTATION: delete the `data === null` branch in resolveMissingShow. The dead
     endpoint reads "Show not found." and this goes red. */
  let calls = 0;
  const m = mount({
    hash: "#/show/12345",
    fetchImpl: (url) => {
      if (!url.includes("api/shows/search")) return new Promise(() => {});
      calls += 1;
      return calls === 1 ? Promise.reject(new TypeError("offline")) : okJson({ show: null });
    },
  });
  m.state.catalog = CATALOG;
  m.ctx.renderCurrentPage();
  assert.match(m.html(), /Loading show…/);
  assert.ok(m.view.querySelector("a.back") || m.view.querySelector(".back"), "the loading page has a way back");
  await settle();
  assert.match(m.html(), /Couldn't load this show\./);
  assert.doesNotMatch(m.html(), /Show not found/, "a dead endpoint is not a missing show");
  assert.ok(m.view.querySelector(".back"), "the failed page has a way back");

  assert.ok(m.retry(), "the failed page offers Try again");
  await settle();
  assert.strictEqual(calls, 2, "Try again asks the same endpoint again");
  assert.match(m.html(), /Show not found\./, "and a genuine miss is still reported as one");
  assert.ok(m.view.querySelector(".back"), "the not-found page has a way back");
});

/* ==================================================================== */
/* #/forays: never "0 forays" for a module or a document that is missing */
/* ==================================================================== */

test("#/forays waits for the player instead of saying there are no Forays, and paints the list when it lands", async () => {
  /* `forayCards()` answers [] when the module has not evaluated, and the page
     used to paint that as "0 forays" / "No forays right now" and never repaint.
     MUTATION: delete the `if (!window.ForayPlayer) { … }` block in renderForays.
     The first paint claims there are none, and this goes red. */
  const m = mount({ hash: "#/forays" });
  m.state.forays = FORAYS_DOC;
  m.ctx.renderCurrentPage();
  assert.match(m.html(), /Loading…/);
  assert.doesNotMatch(m.html(), /0 forays|No forays right now/, `a missing module is not an empty list: ${m.html()}`);

  m.ctx.ForayPlayer = bridge();
  m.fire("forayplayer:ready");
  await settle();
  assert.match(m.html(), /First Foray/, `the list paints once the player lands: ${m.html()}`);
  assert.doesNotMatch(m.html(), /Loading…/);
});

test("#/forays with a player that never arrives says so, with Try again", async () => {
  /* The bounded wait ends in a named failure, not in an empty list. The wait is
     shortened here by firing the ready event with no bridge behind it — the same
     `finish()` the 5 s timeout calls.
     MUTATION: make the `!player` branch call renderForays()'s empty state
     instead. "The player didn't load." never appears. */
  const m = mount({ hash: "#/forays" });
  m.state.forays = FORAYS_DOC;
  m.ctx.renderCurrentPage();
  m.fire("forayplayer:ready"); // the module "arrived" without publishing a bridge
  await settle();
  assert.match(m.html(), /The player didn.t load\./);
  assert.doesNotMatch(m.html(), /0 forays|No forays right now/);
  assert.ok(m.view.querySelector("[data-retry]"), "the failure offers Try again");
});

test("#/forays with no Forays document says it could not load them, and Try again fetches them", async () => {
  /* MUTATION: delete the `!state.forays` branch in renderForays. The page paints
     "No forays right now" over a failed fetch, and this goes red. */
  const m = mount({
    hash: "#/forays", bridge: bridge(),
    fetchImpl: (url) => (url.includes("data/forays.json") ? okJson(FORAYS_DOC)
      : url.includes("data/segments.json") ? okJson({ segments: [] })
      : url.includes("data/segment-sources.json") ? okJson({ sources: [] })
      : new Promise(() => {})),
  });
  m.state.forays = null;
  m.ctx.renderCurrentPage();
  assert.match(m.html(), /Couldn't load forays right now\./);
  assert.doesNotMatch(m.html(), /No forays right now|0 forays/);
  assert.ok(m.retry(), "the failure offers Try again");
  await settle();
  assert.match(m.html(), /First Foray/, `Try again re-fetches the documents and repaints: ${m.html()}`);
});

test("#/forays explains what a Foray is, from the same sentence the first-run sheet uses", () => {
  /* The first-run sheet was the only place the product said what a Foray is, and
     "Skip for now" hid it forever. The page's subtitle now carries it — and it
     is ONE constant, so the two cannot drift.
     MUTATION: put the count back in the subtitle (`${list.length} forays`). The
     sentence is gone and this goes red. MUTATION 2: inline the literal back into
     the sheet. The second assertion goes red. */
  const m = mount({ hash: "#/forays", bridge: bridge() });
  m.state.forays = FORAYS_DOC;
  m.ctx.renderCurrentPage();
  const about = vm.runInContext("FORAY_ABOUT", m.ctx);
  assert.ok(about.length > 40, "the explanation is a real sentence");
  assert.ok(m.html().includes(about), "the Forays page states what a Foray is");
  assert.doesNotMatch(m.html(), /\b\d+ forays?\b/, "and states no count in its place");
  assert.match(APP_SRC, /ddEl\("p", "fy-sheet-sub", FORAY_ABOUT\)/, "the first-run sheet reads the same constant");
});

test("a Foray page whose player failed has a way back to the list and a Try again", async () => {
  /* MUTATION: restore the bare "The player didn't load — reload the page." note.
     There is no ‹ and no retry, and this goes red. */
  const m = mount({ hash: "#/foray/f1" });
  m.state.forays = FORAYS_DOC;
  m.ctx.renderCurrentPage();
  assert.ok(m.view.querySelector(".back"), "the loading page has a way back");
  m.fire("forayplayer:ready");
  await settle();
  assert.match(m.html(), /The player didn.t load\./);
  assert.doesNotMatch(m.html(), /reload the page/, "no browser advice inside a native shell");
  const back = m.view.querySelector(".back");
  assert.ok(back && back.attrs.href === "#/forays", "‹ goes back to the Forays list");
  assert.ok(m.view.querySelector("[data-retry]"));
});

/* ==================================================================== */
/* Home repaints when the module lands late                              */
/* ==================================================================== */

test("Home repaints once when the player module lands after its first paint, restored ribbon or not", () => {
  /* Home's Forays rail reads `forayCards()`, which is [] with no module. Only a
     restored episode used to trigger the repaint, so a listener who had never
     played anything kept a Home with no Forays on it.
     MUTATION: revert `(restored || late)` to `restored`. No repaint, red. */
  const m = mount({ hash: "#/" });
  let repaints = 0;
  m.ctx.renderCurrentPage = () => { repaints += 1; };
  m.ctx.restoreNowPlayingRibbon();
  assert.strictEqual(repaints, 0, "nothing to repaint before the module lands");
  m.ctx.ForayPlayer = { restoreLastEpisode: () => null }; // nothing to restore
  m.fire("forayplayer:ready");
  assert.strictEqual(repaints, 1, "Home repaints once the module is there");
});

/* ==================================================================== */
/* The Shows search: nothing is "not found" until every pass has answered */
/* ==================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The Shows page with its search endpoints routed. `catalogue` answers the
    fast pass, `directory` the fall-through, `directoryError` models the
    endpoint's own 200-with-an-error on a limiter trip. Episodes answer empty
    and the shard pass answers the real "not published" 404. */
function mountSearch({ catalogue = [], directory = [], directoryError = null, catalogueDelayMs = 0, taxonomy = null, catalog = CATALOG } = {}) {
  const calls = [];
  const m = mount({
    hash: "#/shows",
    fetchImpl: (url) => {
      calls.push(url);
      if (url.includes("api/shows/search") && url.includes("fallthrough=1")) {
        return okJson({ shows: directoryError ? [] : directory, fallthrough: { attempted: true, error: directoryError } });
      }
      if (url.includes("api/shows/search")) {
        const answer = okJson({ shows: catalogue, degraded: false });
        return catalogueDelayMs ? sleep(catalogueDelayMs).then(() => answer) : answer;
      }
      if (url.includes("api/episodes/search")) return okJson({ episodes: [] });
      if (url.includes("api/shows/index/")) return Promise.resolve({ ok: false, status: 404, json: async () => ({ available: false }) });
      return new Promise(() => {});
    },
  });
  m.state.catalog = catalog;
  if (taxonomy) m.state.taxonomy = taxonomy;
  m.state.cardSlots = [];
  m.ctx.renderCurrentPage();
  const note = m.view.querySelector("#sh-note");
  /* Every sentence the note ever showed, so a claim that flashed and was then
     replaced is still caught — which is the whole defect. */
  const said = [];
  let text = "";
  Object.defineProperty(note, "textContent", { get: () => text, set: (v) => { text = String(v); said.push(text); } });
  return { ...m, calls, note, said, offer: () => m.view.querySelector("#sh-empty-offer") };
}

test("a keystroke with no local match says it is searching — never 'not found' — and the rows arrive under it", async () => {
  /* The keystroke pass is local-only; the passes that can find "huberman" run
     250 ms later. The note used to read `No results for "huberman".` for that
     whole window and then sit above ten results.
     MUTATION: in paintShowResults, drop the `settled` test and always write the
     "No shows found" sentence. The first assertion goes red. */
  const m = mountSearch({ catalogue: [{ show_id: "hub", title: "Huberman Lab" }], catalogueDelayMs: 50 });
  m.ctx.onShowSearchInput("huberman");
  assert.match(m.note.textContent, /Searching for "huberman"/, `the keystroke must not claim an answer: "${m.note.textContent}"`);
  await sleep(450);
  assert.match(m.view.querySelector("#sh-results").innerHTML, /Huberman Lab/, "the catalogue's row lands");
  assert.ok(m.note.hidden, "and the note steps aside for it");
  assert.ok(!m.said.some((s) => /not found|No results|No shows found/i.test(s)),
    `"not found" must never have been said about a search that found something: ${JSON.stringify(m.said)}`);
});

test("a search that every pass answered with nothing says 'No shows found' — scoped to shows", async () => {
  /* The settled half of the same convention, and the scope: the note sits above
     the Episodes and Playlists sections, so it names what IT searched.
     MUTATION: delete the `showPassDone(...)` call from the catalogue pass. The
     count never reaches zero, the note stays "Searching…", red. */
  const m = mountSearch();
  m.ctx.renderShowSearchResults("zzqx");
  await sleep(150);
  assert.strictEqual(m.note.textContent, 'No shows found for "zzqx".');
  assert.ok(!m.note.hidden);
  assert.ok(m.offer().hidden, "every pass answered, and there is nothing else to offer");
});

test("an empty answer behind a pass that FAILED says part of the search did not load, and Try again re-runs it", async () => {
  /* `api/shows/search.ts` answers a limiter trip with 200 and zero directory
     rows by design; offline, every network pass fails. Either way "no shows"
     was a permanent claim about a moment's network, with nothing to press.
     MUTATION: pass `false` instead of `!answered` to the directory's
     showPassDone. The failure is not reported, and this goes red. */
  const m = mountSearch({ directoryError: "rate-limited" });
  m.ctx.renderShowSearchResults("zzqx");
  await sleep(150);
  assert.match(m.note.textContent, /No shows found/);
  assert.match(m.offer().innerHTML, /Part of this search didn't load\./);
  const before = m.calls.filter((u) => u.includes("fallthrough=1")).length;
  assert.ok(m.retry(m.offer()), "the failure offers Try again");
  await sleep(150);
  assert.ok(m.calls.filter((u) => u.includes("fallthrough=1")).length > before, "Try again asks the directory again");
});

test("a subject's own name that finds no show by title offers that subject's categories that hold shows", async () => {
  /* A browse pill runs the ordinary search for its label (founder, #684) and a
     label like "Science" rarely matches a show TITLE. The empty answer now
     offers the subject's narrower categories that do hold shows — each chip a
     page with at least one show on it — instead of a dead end.
     MUTATION: delete the `if (node) { … }` block in paintShowSearchEmptyOffer.
     The offer is empty and this goes red. */
  const taxonomy = { nodes: [
    { id: "science", parent: null, label: "Science" },
    { id: "science/physics", parent: "science", label: "Physics" },
    { id: "science/geology", parent: "science", label: "Geology" },
  ] };
  const catalog = { shows: [{ show_id: "s1", title: "Alpha Show", taxonomy_node_ids: ["science/physics"] }] };
  const m = mountSearch({ taxonomy, catalog });
  m.ctx.renderShowSearchResults("Science");
  await sleep(150);
  assert.match(m.note.textContent, /No shows found for "Science"/);
  const html = m.offer().innerHTML;
  assert.match(html, /href="#\/category\/science%2Fphysics"/, `the category that holds a show is offered: ${html}`);
  assert.doesNotMatch(html, /geology/, "a category with no shows is not offered — it would be another dead end");
  assert.doesNotMatch(html, /data-retry/, "nothing failed, so nothing to retry");
});

test("while the playlist check behind the results is still owed, the page says so, and the line always ends", async () => {
  /* Persona audit #28: the topic scan behind "Create a playlist about…" runs
     on an idle callback, blocks for seconds on a phone, then grows a section
     at the bottom — with nothing on screen saying work was still going.
     MUTATION: in renderPlaylistSearchResults, paint "" (hidden) instead of
     CTA_PENDING_HTML before the whenIdle. The first assertion goes red. */
  const m = mountSearch();
  m.ctx.renderShowSearchResults("zzqx");
  const pl = m.view.querySelector("#pl-search-results");
  assert.ok(!pl.hidden && /data-cta-pending/.test(pl.innerHTML),
    `the section says it is still looking before the scan runs: hidden=${pl.hidden} ${pl.innerHTML}`);
  assert.doesNotMatch(pl.innerHTML, /Create a playlist|No /, "and claims no outcome while it does");
  await sleep(150);
  assert.doesNotMatch(pl.innerHTML, /data-cta-pending/, `the scan answered, so "still looking" is gone: ${pl.innerHTML}`);
});

test("a playlist check that throws still ends 'Still looking' — it is not a spinner that never resolves", async () => {
  /* MUTATION: drop the try/catch round createPlaylistCtaHtml. The throw
     escapes the idle callback, the pending line stays up for good, red. */
  const m = mountSearch();
  m.ctx.topicSearchStatus = () => { throw new Error("scorer blew up"); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    m.ctx.renderShowSearchResults("zzqx");
    await sleep(150);
  } finally { console.warn = warn; }
  const pl = m.view.querySelector("#pl-search-results");
  assert.doesNotMatch(pl.innerHTML, /data-cta-pending/, `a failed scan must not leave the line up: ${pl.innerHTML}`);
  assert.ok(pl.hidden, "and nothing is offered from a scan that did not answer");
});

/* ==================================================================== */
/* The Foray page: one model for its numbers (audit 2026-09-22, theme L) */
/* ==================================================================== */

const playerMods = (async () => ({
  resolve: await import("../player/foray-resolve.js"),
  strip: await import("../player/segment-strip.js"),
}))();
const readData = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

/** A bridge over the REAL resolver and the REAL strip module, so the page's
    numbers are checked against the definitions it is supposed to share. */
async function forayBridge() {
  const { resolve, strip } = await playerMods;
  return {
    resolve(doc, { id, segmentsDoc, sourcesDoc } = {}) {
      const f = resolve.findForay(doc, id, { unlocked: [id], showDrafts: true });
      return f ? resolve.resolveForay(f, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc) }) : null;
    },
    stripTally: strip.stripTally,
    stripModel: strip.stripModel,
    fmtClock: resolve.fmtClock,
    fmtSpan: resolve.fmtSpan,
    playbackRate: () => 1, rateStops: () => [1], setPlaybackRate() {},
    watchForay: () => null, forayResume: () => null,
  };
}

async function mountForay(id, { forays = readData("data/forays.json"), segments = readData("data/segments.json"), sources = readData("data/segment-sources.json") } = {}) {
  const b = await forayBridge();
  const m = mount({ hash: `#/foray/${id}`, bridge: b });
  m.state.forays = forays;
  m.state.segments = segments;
  m.state.segmentSources = sources;
  m.ctx.renderCurrentPage();
  await settle(10);
  return { ...m, bridge: b };
}

/* The header's <p class="sub"> text, read from the markup (this DOM parses
   tags, not text nodes). */
const headSub = (html) => (/<p class="sub">([^<]*)<\/p>/.exec(html) || [])[1] || "";

test("a narrated Foray's header counts the strip's clips, not every queue item, and calls its runtime an estimate", async () => {
  /* "50 segments · 1 show · 43:07" over a strip announcing 11 segments, with 41%
     of that clock a script-length projection.
     MUTATION: restore `${r.playable.length} segment…` in forayHeadSub. The
     header counts the bridges and the first assertion goes red. MUTATION 2:
     print `fmtClock(r.totalSec)` unconditionally. "about" is gone, red. */
  const id = "how-ai-actually-gets-built-3b83e1";
  const m = await mountForay(id);
  const { strip } = await playerMods;
  const r = m.state.foray;
  assert.ok(r, "the Foray resolved");
  const model = strip.stripModel(r.playable);
  const sub = headSub(m.html());
  assert.match(sub, new RegExp(`^${model.segmentCount} clips from ${model.shows.length} shows?, with narration`), `header: "${sub}"`);
  assert.ok(!sub.includes(`${r.playable.length} `), `the queue length (${r.playable.length}) is not the clip count: "${sub}"`);
  assert.match(sub, /· about \d+ min$/, `an estimated runtime says so: "${sub}"`);
  assert.match(m.view.querySelector("#fy-total").textContent, /^~\d/, "the clock beside the scrubber carries the same hedge");
});

test("a Foray of measured tape keeps its clock", async () => {
  /* The other side of the estimate rule: a runtime that IS measured is not
     hedged. MUTATION: make forayRuntimeLabel always return "about …". Red. */
  const m = await mountForay("capital-types-1");
  const sub = headSub(m.html());
  assert.match(sub, /^\d+ clips from \d+ shows · \d+:\d{2}(:\d{2})?$/, `header: "${sub}"`);
  assert.doesNotMatch(sub, /about|narration/);
});

test("a clip missing from the segment pool is not promised as 'listed below'", async () => {
  /* `r.unplayable` is entries that will not play (rows below, marked) PLUS items
     hydration dropped, which are rows nowhere. "N segments can't play — listed
     below" counted both over a list showing neither of the dropped ones.
     MUTATION: restore `const lost = r.unplayable.length` and its one note. The
     page says "can't play — listed below" for a clip it does not list, red. */
  const doc = readData("data/forays.json");
  const base = doc.forays.find((f) => f.id === "capital-types-1");
  const broken = { ...base, id: "broken-1", items: [{ type: "segment", segment_id: "no-such-segment", slot: base.items[0].slot }, ...base.items] };
  const m = await mountForay("broken-1", { forays: { ...doc, forays: [broken] } });
  const html = m.html();
  assert.doesNotMatch(html, /listed below|marked below/, `nothing below is marked, so nothing may point there: ${html.slice(0, 600)}`);
  assert.match(html, /1 clip from this Foray couldn't be found, so it's left out\./);
});

test("the header does not count a show whose only clip will not play", async () => {
  /* The credits block counts only shows that will be heard, on purpose
     (player/foray-sources.js); the header counted `r.shows`, every AUTHORED
     entry's show — "7 shows" in the header, "6 shows" in the credits.
     Built on the real capital-types-1 plus one clip from a show whose episode
     has no audio URL, which the queue builder refuses: that clip resolves, is
     listed as can't-play, and its show must not be counted.
     MUTATION: count `r.shows.length` in forayHeadSub. The ghost show is
     counted and this goes red. */
  const doc = readData("data/forays.json");
  const segments = readData("data/segments.json");
  const sources = readData("data/segment-sources.json");
  const base = doc.forays.find((f) => f.id === "capital-types-1");
  sources.sources.push({ id: "ghost-src", show: "A Show Nobody Will Hear", title: "Ghost", audio_url: null });
  segments.segments.push({ id: "ghost-src#0", item_id: "ghost-src", start_sec: 0, end_sec: 30 });
  const withGhost = { ...base, id: "ghost-1", items: [...base.items, { type: "segment", segment_id: "ghost-src#0", slot: base.items[base.items.length - 1].slot }] };
  const m = await mountForay("ghost-1", { forays: { ...doc, forays: [withGhost] }, segments, sources });
  const r = m.state.foray;
  assert.ok(r.shows.includes("A Show Nobody Will Hear"), "fixture: the ghost show is an authored show");
  assert.ok(r.entries.some((e) => !e.playable && e.show === "A Show Nobody Will Hear"), "fixture: its only clip will not play");
  const heard = new Set(r.entries.filter((e) => e.playable && e.show).map((e) => e.show)).size;
  const sub = headSub(m.html());
  assert.match(sub, new RegExp(` from ${heard} shows? `), `the header counts heard shows (${heard}), not authored ones (${r.shows.length}): "${sub}"`);
  assert.match(m.html(), /1 clip can't play — marked below\./, "and the clip that will not play is the one marked below");
});

/* ==================================================================== */
/* Episode progress on rows, and counts that do not decay (theme L)     */
/* ==================================================================== */

const progressMod = import("../player/episode-progress.js");

/** A bridge whose `episodeProgress` is the REAL reading over a fake position
    table — the shape player/client.js bridges. */
async function progressBridge(positions) {
  const { episodeProgress } = await progressMod;
  return { episodeProgress: (id, durSec) => episodeProgress({ duration_sec: durSec }, positions[id] ?? null) };
}

test("episode rows say 'Played' or 'NN min left' from the player's reading, and nothing without it", async () => {
  /* Persona #78: nothing on any list said which episodes were played or how far
     in. The data (the position store) existed; the rows never read it.
     MUTATION: drop `${progHtml}` from epRow's subtitle line. Both marks vanish
     and this goes red. */
  const m = mount({ bridge: await progressBridge({ a: 3590, b: 600 }) });
  const row = (id) => m.ctx.epRow({ id, title: `Ep ${id}`, show: "Show", duration_min: 60, audio_url: "https://x.test/a.mp3" }, 0, "ctx", -1);
  assert.match(row("a"), /<span class="ep-progress is-played">Played<\/span>/);
  assert.match(row("b"), /<span class="ep-progress">50 min left<\/span>/);
  assert.doesNotMatch(row("c"), /ep-progress/, "an unplayed row carries no mark");

  const cold = mount(); // no player bridge yet: no guess
  assert.doesNotMatch(cold.ctx.epRow({ id: "a", title: "A", show: "S", duration_min: 60 }, 0, "ctx", -1), /ep-progress/);
});

test("'played' counts history OR a stored position, so it cannot fall as the history ring rotates", async () => {
  /* cp_history is a 200-entry ring; a playlist's "N played" and its "next"
     marker read it alone, so both regressed as the listener started other
     episodes. Positions are one row per episode and never rotate out.
     MUTATION: make hasOpened return `history.has(id)` alone. The rotated-out
     episode reads unplayed and this goes red. */
  const m = mount({ bridge: await progressBridge({ rotatedOut: 1200, sampled: 3 }) });
  const history = new Set(["recent"]);
  assert.strictEqual(m.ctx.hasOpened("recent", history), true);
  assert.strictEqual(m.ctx.hasOpened("rotatedOut", history), true, "listened to, then evicted from the ring: still played");
  assert.strictEqual(m.ctx.hasOpened("sampled", history), true, "opened for a few seconds still counts as opened");
  assert.strictEqual(m.ctx.hasOpened("never", history), false);
  /* And the playlist page reads it for BOTH the count and the next marker, so
     the two cannot disagree. */
  const body = /function renderPlaylistDetail\(id\) \{[\s\S]*?\n\}/.exec(APP_SRC)[0];
  assert.match(body, /const nextIdx = rows\.findIndex\(r => r\.state === "live" && !hasOpened\(r\.item\.id, history\)\);/);
  assert.match(body, /const played = rows\.filter\(r => hasOpened\(r\.item\.id, history\)\)\.length;/);
});

test("a subject card states a total duration only when every episode has one", () => {
  /* "3 episodes · 1h 20m" summed two of three when one had no duration_min —
     a partial sum presented as the total of the count beside it.
     MUTATION: restore `slot.items.reduce((s, it) => s + (it.duration_min || 0), 0)`.
     The partial total is printed and this goes red. */
  const m = mount();
  m.state.taxonomy = { nodes: [{ id: "history", parent: null, label: "History" }] };
  const item = (id, duration_min) => ({ id, title: `T ${id}`, show: "S", duration_min });
  const kicker = (items) => (/<p class="mc-kicker">([\s\S]*?)<\/p>/.exec(
    m.ctx.miniCard({ branch: "history", role: "anchor", item: items[0], items }),
  ) || [])[1];
  assert.match(kicker([item("a", 40), item("b", 40)]), /^2 episodes · 1h 20m$/);
  assert.strictEqual(kicker([item("a", 40), item("b", 40), item("c", null)]), "3 episodes",
    "an unknown length means no total, not a smaller one");
});

/* ==================================================================== */
/* A play that fails is never a swallowed tap (persona audit #4)        */
/* ==================================================================== */

test("a play button whose play() throws or refuses reports it to the player bar", async () => {
  /* `bindPlay` did `const ok = await play(...); if (!ok) return;` with no try:
     a refusal said nothing, and a throw was an unhandled rejection.
     MUTATION: delete the `reportPlayFailure?.(err)` call in the catch. The
     report never arrives and this goes red. MUTATION 2: remove the try/catch.
     The throw escapes the listener instead of being reported. */
  for (const [label, play] of [
    ["throws", async () => { throw Object.assign(new Error("boom"), { name: "TypeError" }); }],
    ["refuses", async () => false],
  ]) {
    const reports = [];
    const m = mount({ bridge: { isCurrent: () => false, play, reportPlayFailure: (e) => reports.push(e) } });
    m.state.itemIndex = { ep1: { id: "ep1", title: "E", audio_url: "https://x.test/e.mp3" } };
    m.view.innerHTML = `<div><button data-play="ep1">▶</button></div>`;
    m.ctx.bindPlay(m.view);
    const btn = m.view.querySelector("[data-play]");
    let escaped = null;
    try { await Promise.all((btn._on.get("click") || []).map((fn) => fn({ target: btn, preventDefault() {}, stopPropagation() {} }))); }
    catch (e) { escaped = e; }
    assert.strictEqual(escaped, null, `[${label}] nothing may escape the listener`);
    assert.strictEqual(reports.length, 1, `[${label}] the failure is reported to the bar exactly once`);
  }
});

/* ==================================================================== */
/* Cold boot (persona #43): a first paint before the first await, and    */
/* the search-only documents after the first route()                     */
/* ==================================================================== */

/** Serve data/*.json from disk, except the paths in `hang` (never answer) and
    `fail` (404). */
function diskFetch({ hang = [], fail = [] } = {}) {
  return (url) => {
    const rel = url.split("?")[0].replace(/^\.?\//, "");
    if (hang.some((h) => rel.endsWith(h))) return new Promise(() => {});
    if (fail.some((f) => rel.endsWith(f))) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    const file = path.join(ROOT, rel);
    if (!rel.startsWith("data/") || !fs.existsSync(file)) return new Promise(() => {});
    return okJson(JSON.parse(fs.readFileSync(file, "utf8")));
  };
}

test("the boot paints 'Loading 4a…' before its first await, not a blank page", () => {
  /* The body used to stay blank behind the header until ~3.5 MB of JSON had
     landed. MUTATION: delete the `view.innerHTML = BOOT_LOADING_HTML` line at the
     top of init(). The view is empty and this goes red. */
  const m = mount(); // every fetch hangs: init() is parked on its first await
  assert.match(m.html(), /data-boot-loading/);
  assert.match(m.html(), /Loading 4a…/);
});

test("a boot whose session never loads says so, and Try again runs the boot again", async () => {
  /* The failure note had no way forward but a reload the native shell does not
     offer. MUTATION: drop the bindRetry(... init()) call. Nothing to press. */
  let sessionAsks = 0;
  const serve = diskFetch();
  const m = mount({
    fetchImpl: (url) => {
      if (url.includes("data/session.json")) {
        sessionAsks += 1;
        return sessionAsks === 1 ? Promise.resolve({ ok: false, status: 503, json: async () => ({}) }) : new Promise(() => {});
      }
      return serve(url);
    },
  });
  await settle();
  assert.match(m.html(), /Couldn't load 4a — check your connection\./);
  assert.ok(m.retry(), "the failed boot offers Try again");
  assert.match(m.html(), /Loading 4a…/, "and says it is loading again while it retries");
  await settle();
  assert.strictEqual(sessionAsks, 2, "Try again is the same boot, asking for the session again");
});

test("the first route() does not wait for the search-only documents", async () => {
  /* semantic-index.json + item-tags.json (465.7 KB, 97 KB gzipped) are read only
     by the topic scorer, which Home's first paint never runs.
     MUTATION: put either fetch back into init()'s awaited Promise.all. With
     them hanging here, the boot never reaches route() and this goes red. */
  const m = mount({ fetchImpl: diskFetch({ hang: ["data/semantic-index.json", "data/item-tags.json"] }) });
  /* mount() pre-sets `state.ready` for the other tests, so readiness is read off
     the page: the boot line is replaced only by init()'s own route(). */
  for (let i = 0; i < 400 && /data-boot-loading/.test(m.html()); i++) await settle(1);
  assert.doesNotMatch(m.html(), /data-boot-loading/, "the first page replaced the loading line with the search documents still in flight");
  assert.strictEqual(m.state.itemTags, null, "fixture: the tags really were still in flight");
  assert.ok(m.fetched.some((u) => u.includes("data/item-tags.json")), "they were still asked for, after the paint");
});

test("the search documents landing replace the scorer's context and clear its cache", async () => {
  /* search-engine.js memoizes term frequencies on the ctx and must never have
     itemTags swapped under a used one; results cached against a tagless ctx
     must not outlive it. MUTATION: drop `state._searchCtx = null` from
     loadSearchData. A stale ctx survives and this goes red. */
  const m = mount({ fetchImpl: diskFetch() });
  m.state.semantic = null;
  m.state.itemTags = null;
  const stale = m.ctx.searchCtx();
  assert.strictEqual(stale.itemTags, null, "fixture: a ctx built before the documents");
  await m.ctx.loadSearchData();
  assert.ok(m.state.itemTags && m.state.semantic, "both documents are in");
  const fresh = m.ctx.searchCtx();
  assert.notStrictEqual(fresh, stale, "a new ctx");
  assert.strictEqual(fresh.itemTags, m.state.itemTags);
  assert.strictEqual(vm.runInContext("searchCache.size", m.ctx), 0);
});

test("a playlist build waits for search documents that are still in flight, then scores with them", async () => {
  /* The deferral is only safe if the three topic-scoring paths wait for the
     documents init() started; a build in the window would otherwise score a
     tagless pool and cache that answer.
     MUTATION: make whenSearchDataReady always `setTimeout(fn, 0)`. The build runs
     while the tags are still null and this goes red. */
  let open;
  const gate = new Promise((r) => { open = r; });
  const m = mount({
    fetchImpl: (url) => {
      if (url.includes("data/semantic-index.json") || url.includes("data/item-tags.json")) {
        const rel = url.split("?")[0].replace(/^\.?\//, "");
        return gate.then(() => okJson(readData(rel)));
      }
      return new Promise(() => {});
    },
  });
  m.state.semantic = null;
  m.state.itemTags = null;
  m.ctx.loadSearchData(); // what init() does after its first route()
  let sawTags = null;
  m.ctx.whenSearchDataReady(() => { sawTags = m.state.itemTags; });
  await settle();
  assert.strictEqual(sawTags, null, "nothing ran while the documents were in flight");
  open();
  await settle();
  assert.ok(sawTags && sawTags.tags, "the build ran once they landed, and saw them");
});
