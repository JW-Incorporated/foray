/* The episode page lists its bookmarks (issue #30, roadmap PQ-15; code-health
 * CH-09b, P2-02).
 *
 * Bookmarks shipped write-only: the Now Playing sheet's Bookmark button wrote
 * `cp_bookmarks` and announced "Bookmarked.", and no page showed the list the
 * privacy policy's `cp_bookmarks` row says is "listed on the episode page".
 * WHAT THIS PROVES:
 *  a. With no bookmarks (or no bookmark rules published) the page has no
 *     Bookmarks section and keeps its order: actions, notes, chapters
 *     (characterization, green before the list existed).
 *
 * Every test names the one-line mutation that kills it, and each was run.
 *
 * Harness: test/episode-chapters-visible.test.js's node:vm DOM stub, with a
 * #view whose `querySelectorAll` answers the controls the render actually
 * wrote (episode-deeplink's shape: one stub per button, carrying its click
 * handlers) and whose `[data-bookmarks-slot]` node rewrites the markup when
 * its innerHTML is set, as a browser's does. The page is handed the REAL
 * player/bookmarks.js as `window.forayBookmarks` (client.js publishes it
 * whole) and the real player/seek-policy.js as `window.ForaySeekPolicy`.
 */

const { test, before } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

let BOOKMARKS = null;
let POLICY = null;
before(async () => {
  BOOKMARKS = await import("../player/bookmarks.js");
  POLICY = await import("../player/seek-policy.js");
});

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
    closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

const SLOT_RE = /(<div class="ep-bookmarks-slot" data-bookmarks-slot="([^"]*)">)([\s\S]*?)(<\/div>)/;
const SECTION_RE = /<section class="ep-bookmarks"[\s\S]*?<\/section>/;
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function mount({ hash = "#/episode/ep-1", bookmarks = undefined, policy = undefined, player = null } = {}) {
  const byId = new Map();
  const el = (id) => { if (!byId.has(id)) { const e = makeEl("div"); e.id = id; byId.set(id, e); } return byId.get(id); };
  const view = el("view");
  /* One stub per button, keyed by its attributes, so a control keeps its
     handlers (and its `_bound` mark) across reads of the same markup. */
  const stubs = new Map();
  const buttons = (html, attr) => [...html.matchAll(/<button\b([^>]*)>/g)]
    .filter((m) => new RegExp(`\\b${attr}="`).test(m[1]))
    .map((m) => {
      if (!stubs.has(m[1])) {
        const handlers = [];
        const data = {};
        for (const [, k, v] of m[1].matchAll(/\bdata-([\w-]+)="([^"]*)"/g)) {
          data[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = unesc(v);
        }
        stubs.set(m[1], {
          attrs: m[1], dataset: data, handlers, focused: 0,
          addEventListener(type, fn) { if (type === "click") handlers.push(fn); },
          focus() { this.focused += 1; },
        });
      }
      return stubs.get(m[1]);
    });
  const region = (getHtml) => ({
    querySelectorAll(sel) {
      const html = getHtml();
      if (sel === "[data-ts]") return buttons(html, "data-ts");
      if (sel === "[data-bookmark-remove]") return buttons(html, "data-bookmark-remove");
      return [];
    },
    querySelector: () => null,
  });
  const viewRegion = region(() => view.innerHTML);
  view.querySelectorAll = (sel) => {
    if (sel === "[data-bookmarks-slot]") {
      const m = SLOT_RE.exec(view.innerHTML);
      if (!m) return [];
      const slot = region(() => (SLOT_RE.exec(view.innerHTML) || [])[3] || "");
      slot.dataset = { bookmarksSlot: unesc(m[2]) };
      Object.defineProperty(slot, "innerHTML", {
        get: () => (SLOT_RE.exec(view.innerHTML) || [])[3] || "",
        set: (h) => { view.innerHTML = view.innerHTML.replace(SLOT_RE, (_, open, _id, _old, close) => `${open}${h}${close}`); },
      });
      return [slot];
    }
    return viewRegion.querySelectorAll(sel);
  };
  const body = makeEl("body");
  const store = new Map();
  const events = [];
  const ctx = {
    console: { ...console, warn() {}, error() {}, info() {} },
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
      querySelector: (sel) => (/^#[\w-]+$/.test(String(sel)) ? el(String(sel).slice(1)) : null),
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash, search: "", pathname: "/", href: "https://x.test/" + hash, protocol: "https:" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    forayEventLog: { append(row) { events.push(row); } },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.forayBookmarks = bookmarks === undefined ? BOOKMARKS : bookmarks;
  ctx.ForaySeekPolicy = policy === undefined ? POLICY : policy;
  if (player) ctx.ForayPlayer = player;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  evalIn(`state.ready = true;
    state.session = { session_id: 's', episodes: {}, cards: [], commute: {} };
    state.discover = { items: [] }; state.catalog = { shows: [] }; state.taxonomy = { nodes: [] };`);
  const state = evalIn("state");
  return {
    ctx, evalIn, state, view, store, events,
    html: () => view.innerHTML,
    section: () => (SECTION_RE.exec(view.innerHTML) || [""])[0],
    raw: () => JSON.parse(store.get("cp_bookmarks") || "null"),
    status: () => el("a11y-status").textContent,
    seed(rows) { store.set("cp_bookmarks", JSON.stringify(rows)); },
    render(item) { state.itemIndex[item.id] = item; ctx.renderEpisode(item.id); },
  };
}

const ep = (over = {}) => ({
  id: "ep-1", title: "Ep", show: "Show", hook: "hook", audio_url: "https://x.test/a.mp3",
  duration_sec: 3600, dai_known: true, dai_suspected: false, topics: [], ...over,
});
const row = (sec, created, over = {}) => ({ sec, label: null, created_at: created, duration_sec: 3600, ...over });
const NOTES = "Welcome.\n0:00 Cold open\n12:30 The main story\nBye.";

/* ---------- a: characterization ---------- */

test("(a) no bookmarks, or no bookmark rules published: no Bookmarks section, and the page keeps actions, notes, chapters in that order", () => {
  /* Characterization: green before the list existed, and after.
     MUTATION: make bookmarksFor (EPISODE_NAVIGATION) return one made-up row
     whatever is stored -> a section renders on an episode with none; red. */
  const m = mount();
  m.seed({ "ep-other": [row(60, "2026-10-01T10:00:00.000Z")] });
  m.render(ep({ description: NOTES }));
  const html = m.html();
  assert.doesNotMatch(html, /<section class="ep-bookmarks"/, "no section for an episode with no bookmarks");
  const at = (needle) => html.indexOf(needle);
  assert.ok(at('class="ep-actions"') > 0, "the actions render");
  assert.ok(at('class="ep-actions"') < at('class="ep-description"'), "actions before the notes");
  assert.ok(at('class="ep-description"') < at('class="ep-chapters"'), "notes before the chapters");

  const bare = mount({ bookmarks: null });
  bare.seed({ "ep-1": [row(60, "2026-10-01T10:00:00.000Z")] });
  bare.render(ep());
  assert.doesNotMatch(bare.html(), /<section class="ep-bookmarks"/, "no rules published, no list (a stale cached player)");
});
