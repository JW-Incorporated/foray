/* The page's half of bookmarks (issue #30; roadmap PQ-13).
 *
 * The RULES — row shape, the 5-s dedupe, the caps — are player/bookmarks.js
 * and are pinned by player/bookmarks.test.js. This suite pins app.js's
 * WIRING around them: the Now Playing sheet's Bookmark button calls
 * `EPISODE_NAVIGATION.addBookmark(id, sec, durationSec)`, and the page must
 *
 *  1. write the real module's row into `cp_bookmarks` through its own
 *     lsGet/lsSet, keyed by episode id;
 *  2. keep no copy of the dedupe rule (a second tap two seconds later is the
 *     module's "same bookmark", so nothing new is written);
 *  3. hand back the episode's bookmarks sorted, for the episode page (PQ-15);
 *  4. tell a screen reader it happened;
 *  5. log nothing — bookmarks stay on the device (roadmap README Q19 / plan
 *     Q3: no new event type; a `logEvent` here is a privacy-policy §2 change).
 *
 * Every test names the mutation that kills it (CLAUDE.md: "a green test is not
 * evidence until you have broken it").
 *
 * Harness: the node:vm page of test/engine-continuation.test.js, duplicated
 * rather than imported for the reason test/up-next-autoadvance.test.js gives.
 * The page is handed the REAL player/bookmarks.js as `window.forayBookmarks`,
 * the way player/client.js publishes it, plus a recording event log.
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
before(async () => {
  BOOKMARKS = await import("../player/bookmarks.js");
});

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {},
    click() { for (const fn of this.listeners.click || []) fn({ preventDefault() {}, stopPropagation() {} }); },
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn",
  "banner-slot", "pl-form", "pl-input", "pl-note",
];

function mount({ store = new Map(), bookmarks = BOOKMARKS } = {}) {
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");
  const events = [];
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
      querySelector: (sel) => {
        const s = String(sel);
        if (!s.startsWith("#")) return null;
        const id = s.slice(1);
        return byId.get(id) ?? body.children.find((k) => k && k.id === id) ?? null;
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
    /* player/client.js's event pipeline, recording every row the page appends. */
    forayEventLog: { append(row) { events.push(row); } },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  /* player/client.js publishes the bookmark rules at module evaluation. */
  ctx.forayBookmarks = bookmarks;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body, events,
    nav: evalIn("EPISODE_NAVIGATION"),
    raw: () => JSON.parse(store.get("cp_bookmarks") || "null"),
    status: () => body.children.find((k) => k && k.id === "a11y-status") || null,
  };
}

test("addBookmark writes the module's row into cp_bookmarks, keyed by the episode id", () => {
  /* MUTATION: hand bookmarks.addBookmark `{ episodeId: "x", sec, durationSec }`
     (or drop the lsSet store for a throwaway object) in
     EPISODE_NAVIGATION.addBookmark -> nothing under "ep-1"; red. */
  const m = mount();
  const bm = m.nav.addBookmark("ep-1", 125.4, 3600);
  assert.ok(bm, "a row comes back");
  const raw = m.raw();
  assert.ok(raw && Array.isArray(raw["ep-1"]), "cp_bookmarks holds the episode's list");
  assert.strictEqual(raw["ep-1"].length, 1);
  assert.strictEqual(raw["ep-1"][0].sec, 125, "the module rounds to a whole second");
  assert.strictEqual(raw["ep-1"][0].duration_sec, 3600, "the length at that moment rides along");
  assert.strictEqual(typeof raw["ep-1"][0].created_at, "string");
  assert.deepStrictEqual(Object.keys(raw), ["ep-1"], "one key, nothing else");
});

test("a second tap two seconds later is the same bookmark — nothing new is written", () => {
  /* The rule is the module's (5-s window); the page must not add its own
     write around it. MUTATION: in EPISODE_NAVIGATION.addBookmark, write the
     returned row again with lsSet (or append a fresh row yourself) -> two
     rows; red. */
  const m = mount();
  const first = m.nav.addBookmark("ep-1", 125, 3600);
  const second = m.nav.addBookmark("ep-1", 127, 3600);
  assert.strictEqual(m.raw()["ep-1"].length, 1, "one row");
  assert.strictEqual(second.created_at, first.created_at, "the existing bookmark comes back");
});

test("bookmarksFor hands back the episode's bookmarks sorted by second, and [] without the rules", () => {
  /* MUTATION: make bookmarksFor return `lsGet("cp_bookmarks", {})[id]` (the
     stored order, here insertion order) -> 900 before 60; red. MUTATION 2:
     drop the `b ?` guard -> throws on a page without the module; red. */
  const m = mount();
  m.store.set("cp_bookmarks", JSON.stringify({
    "ep-1": [
      { sec: 900, label: null, created_at: "2026-10-01T10:00:00.000Z", duration_sec: 3600 },
      { sec: 60, label: null, created_at: "2026-10-01T10:01:00.000Z", duration_sec: 3600 },
    ],
  }));
  m.nav.addBookmark("ep-1", 400, 3600);
  assert.deepStrictEqual(m.nav.bookmarksFor("ep-1").map((b) => b.sec), [60, 400, 900]);
  assert.deepStrictEqual(m.nav.bookmarksFor("ep-2"), [], "an episode with none");

  const bare = mount({ bookmarks: null });
  /* The page's `[]` is made in the vm's realm, so compare its shape, not its prototype. */
  assert.strictEqual(JSON.stringify(bare.nav.bookmarksFor("ep-1")), "[]", "no module, no list");
  assert.strictEqual(bare.nav.addBookmark("ep-1", 10, 100), null, "no module, no write");
  assert.strictEqual(bare.raw(), null);
});

test("a bookmark that took is announced to a screen reader; a refused one is not", () => {
  /* MUTATION: delete `if (bm) announce("Bookmarked.");` -> no live-region
     text; red. MUTATION 2: announce unconditionally -> the refused write
     speaks; red. */
  const m = mount();
  m.nav.addBookmark("ep-1", 30, 600);
  assert.strictEqual(m.status()?.textContent, "Bookmarked.");

  const refusing = mount();
  refusing.ctx.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  const bm = refusing.nav.addBookmark("ep-1", 30, 600);
  assert.strictEqual(bm, null, "a refused write is null (player/bookmarks.js)");
  assert.ok(!refusing.status() || refusing.status().textContent === "", "and nothing claims it was bookmarked");
});

test("a bookmark logs no event — it stays on the device (README Q19, no new event type)", () => {
  /* MUTATION: add `logEvent("bookmark_added", { episode_id: id })` to
     EPISODE_NAVIGATION.addBookmark -> a row reaches the event pipeline; red. */
  const m = mount();
  const before = m.events.length;
  m.nav.addBookmark("ep-1", 30, 600);
  m.nav.addBookmark("ep-1", 300, 600);
  m.nav.bookmarksFor("ep-1");
  assert.strictEqual(m.events.length, before, "no event row for a bookmark");
});
