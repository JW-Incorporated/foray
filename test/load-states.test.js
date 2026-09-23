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
