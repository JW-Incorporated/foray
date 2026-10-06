/* The page's half of bookmarks (issue #30; roadmap PQ-13).
 *
 * The RULES — row shape, the 5-s dedupe, the caps — are player/bookmarks.js
 * and are pinned by player/bookmarks.test.js. This suite pins app.js's
 * WIRING around them: the Now Playing sheet's Bookmark button calls
 * `EPISODE_NAVIGATION.addBookmark(id, sec, durationSec)`, and the page must
 *
 *  1. write the real module's row into `cp_bookmarks` through its own
 *     editStored (read through storedValue), keyed by episode id -- queued
 *     before hydration and landed over the durable rows (CH-09a);
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
let RULES = null;
before(async () => {
  BOOKMARKS = await import("../player/bookmarks.js");
  RULES = await import("../player/continuation.js");
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

function mount({ store = new Map(), bookmarks = BOOKMARKS, rules = RULES } = {}) {
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
  /* player/client.js publishes the bookmark rules at module evaluation, and
     the continuation rules (the engine watermark's planner) beside them. */
  ctx.forayBookmarks = bookmarks;
  ctx.forayContinuation = rules;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body, events,
    nav: evalIn("EPISODE_NAVIGATION"),
    raw: () => JSON.parse(store.get("cp_bookmarks") || "null"),
    rows: (type) => events.filter((e) => e.type === type),
    status: () => body.children.find((k) => k && k.id === "a11y-status") || null,
  };
}

test("addBookmark writes the module's row into cp_bookmarks, keyed by the episode id", () => {
  /* MUTATION: hand bookmarks.addBookmark `{ episodeId: "x", sec, durationSec }`
     (or hand it a throwaway store instead of BOOKMARK_STORE) in
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

/* ==================================================================== */
/* CH-09a: the starred-show follow and the engine watermark, pinned as    */
/* they behave once storage has settled (characterization, A1-03/A1-04). */
/* ==================================================================== */

const SHOW = { show_id: "show-1", title: "A Show", artwork_url: "https://art.test/s.jpg" };

/** The page with one show in its catalogue and one Follow button the
    repaint can find, recording its text. */
function mountWithShow(opts) {
  const m = mount(opts);
  m.evalIn("state").catalog = { shows: [SHOW] };
  const btn = makeEl("button");
  m.ctx.document.querySelectorAll = (sel) => (sel === '[data-show-star="show-1"]' ? [btn] : []);
  return { ...m, btn };
}

test("a follow that is kept logs show_starred once and repaints Followed; the unfollow logs show_unstarred", () => {
  /* Characterization (CH-09a): today's behaviour for a write that takes.
     MUTATION: drop `logEvent("show_starred", ...)` from toggleShowStar -> no
     row; red. MUTATION 2: drop the setToggleLabel repaint -> the button keeps
     its old text; red. */
  const m = mountWithShow();
  m.ctx.toggleShowStar("show-1");
  assert.strictEqual(m.rows("show_starred").length, 1, "one show_starred");
  assert.strictEqual(JSON.stringify(m.rows("show_starred")[0].payload), JSON.stringify({ show_id: "show-1" }));
  assert.ok(JSON.parse(m.store.get("cp_starred_shows"))["show-1"], "the follow is stored");
  assert.strictEqual(m.btn.textContent, "✓ Followed");
  m.ctx.toggleShowStar("show-1");
  assert.strictEqual(m.rows("show_unstarred").length, 1, "one show_unstarred");
  assert.deepStrictEqual(JSON.parse(m.store.get("cp_starred_shows")), {}, "the unfollow is stored");
  assert.strictEqual(m.btn.textContent, "+ Follow");
});

function engineHop(planSeq, hopSeq, id) {
  return {
    planSeq, hopSeq, finishedId: "earlier", nextId: id, fromList: false, queueAfter: [],
    item: { id, title: id, audio_url: `https://audio.test/${id}.mp3`, topics: [] }, lastEpisodeRow: null,
  };
}

test("once settled, an engine hop and a position drain write one watermark that keeps both halves", () => {
  /* Characterization (CH-09a): the watermark is written at once and each
     writer moves only its own half. MUTATION: write `{ event: step.applied.event }`
     in drainEngineEvents -> the advance half is lost; red. MUTATION 2: drop the
     watermark write from applyEngineAdvance -> the second delivery logs a
     second play_started; red. */
  const m = mount();
  assert.strictEqual(m.ctx.applyEngineAdvance(engineHop(5, 1, "ep-a")), true);
  assert.strictEqual(m.ctx.applyEngineAdvance(engineHop(5, 1, "ep-a")), false, "the same hop again is a no-op");
  assert.strictEqual(m.ctx.drainEngineEvents([{ seq: 3, kind: "position", episode_id: "ep-a", seconds: 60, duration: 600, at: 1 }]), 1);
  assert.deepStrictEqual(JSON.parse(m.store.get("cp_engine_applied")), { advance: { planSeq: 5, hopSeq: 1 }, event: 3 });
  assert.strictEqual(m.rows("play_started").length, 1);
});

/* ==================================================================== */
/* CH-09a: the three writers go through editStored (A1-03, A1-04)         */
/* ==================================================================== */

/** A durable store the way player/durable-store.js behaves (the fixture of
    test/save-playlist.test.js): reads are memory; a key this session wrote is
    DIRTY and hydration never replaces it (property 2). */
function slowStore(durable) {
  const mem = new Map();
  const dirty = new Set();
  const setCalls = [];
  return {
    setCalls,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { setCalls.push(k); dirty.add(k); mem.set(k, String(v)); },
    removeItem: (k) => { dirty.add(k); mem.delete(k); },
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
    hydrate: () => new Promise(() => {}),   // never on its own: the test lands it
    land() { for (const [k, v] of Object.entries(durable)) if (!dirty.has(k)) mem.set(k, v); },
  };
}

/** Put `m` behind a slow durable store holding `durable` (localStorage swept,
    IndexedDB slow). `land()` lands hydration and settles storage, as init() would. */
async function hydrating(m, durable) {
  await new Promise((r) => setTimeout(r, 0));   // let init()'s storage wait settle first
  const store = slowStore(durable);
  m.ctx.forayStorage = store;
  m.evalIn("storageSettled = false");
  assert.strictEqual(m.evalIn("storageWaiting()"), true, "fixture assumption: the store is hydrating");
  const json = (k) => JSON.parse(store.getItem(k) || "null");
  return { store, json, land() { store.land(); m.evalIn("markStorageSettled()"); } };
}

const OLD_ROW = { sec: 900, label: null, created_at: "2026-09-01T10:00:00.000Z", duration_sec: 3600 };

test("a refused follow logs no show_starred and the button stays + Follow; a refused unfollow logs no show_unstarred", () => {
  /* A1-04: the store at quota. toggleShowStar logged before it wrote and
     ignored the answer, so a follow the next reload would not have was synced.
     MUTATION: move `logEvent("show_starred", ...)` back above the editStored
     call (log without consulting `ok`) -> one show_starred; red. */
  const m = mountWithShow();
  m.ctx.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  m.ctx.toggleShowStar("show-1");
  assert.strictEqual(m.rows("show_starred").length, 0, "nothing logged for a follow that was not kept");
  assert.strictEqual(m.btn.textContent, "+ Follow", "the button repaints from storage: not followed");

  const f = mountWithShow();
  f.store.set("cp_starred_shows", JSON.stringify({ "show-1": { show_id: "show-1", title: "A Show", artwork_url: null, starred_at: "2026-09-01T00:00:00.000Z" } }));
  f.ctx.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  f.ctx.toggleShowStar("show-1");
  assert.strictEqual(f.rows("show_unstarred").length, 0, "nothing logged for an unfollow that was not kept");
  assert.strictEqual(f.btn.textContent, "✓ Followed");
});

test("a bookmark tapped before hydration is queued and lands over the durable bookmarks, not over {}", async () => {
  /* A1-03: localStorage swept, IndexedDB slow. The raw lsGet/lsSet read `{}`
     and wrote `{thisOne}`, and durable-store's property 2 then kept that
     one-row map over the durable list for good. MUTATION: give BOOKMARK_STORE
     an edit that writes at once (`edit: (k, f, fn) => lsSet(k, fn(lsGet(k, f)))`,
     the old raw read-modify-write) -> written before hydration, "ep-old" lost; red. */
  const m = mount();
  const h = await hydrating(m, { cp_bookmarks: JSON.stringify({ "ep-old": [OLD_ROW] }) });
  const bm = m.nav.addBookmark("ep-1", 30, 600);
  assert.ok(bm, "the tap is taken");
  assert.strictEqual(m.status()?.textContent, "Bookmarked.");
  assert.ok(!h.store.setCalls.includes("cp_bookmarks"), "nothing written before hydration");
  assert.deepStrictEqual(m.nav.bookmarksFor("ep-1").map((b) => b.sec), [30], "the page reads its own queued tap");
  h.land();
  const stored = h.json("cp_bookmarks");
  assert.deepStrictEqual(Object.keys(stored).sort(), ["ep-1", "ep-old"], "the durable list and the tap both survive");
  assert.strictEqual(stored["ep-old"][0].created_at, OLD_ROW.created_at);
  assert.strictEqual(stored["ep-1"][0].sec, 30);
});

test("before hydration a second tap is the same bookmark, and a mark the durable list already holds is not doubled", async () => {
  /* The dedupe runs twice: over what the page can see now (so a double tap
     answers the same row) and again inside the edit over the SETTLED value
     (so a mark made in an earlier session is not added a second time).
     MUTATION: BOOKMARK_STORE.get back to `lsGet` (no queued edits in the
     view) -> the second tap is a new row; red. MUTATION 2: drop the near check
     from the edit in player/bookmarks.js's addBookmark -> two rows on ep-2; red. */
  const m = mount();
  const h = await hydrating(m, { cp_bookmarks: JSON.stringify({ "ep-2": [{ ...OLD_ROW, sec: 62 }] }) });
  const first = m.nav.addBookmark("ep-1", 30, 600);
  const second = m.nav.addBookmark("ep-1", 32, 600);
  assert.strictEqual(second.created_at, first.created_at, "the queued tap answers the second");
  m.nav.addBookmark("ep-2", 60, 3600);
  h.land();
  const stored = h.json("cp_bookmarks");
  assert.strictEqual(stored["ep-1"].length, 1, "one row for the double tap");
  assert.deepStrictEqual(stored["ep-2"].map((r) => r.created_at), [OLD_ROW.created_at], "the durable mark stands; no second row");
});

test("an engine hop applied before hydration keeps the durable watermark: the event half, and an advance never rewritten low", async () => {
  /* A1-03: an attach in the window read the watermark as null and lsSet it,
     and the durable copy was lost: the event half went (positions re-drained)
     and a higher advance was rewritten low (a redelivered hop logs
     play_started twice). MUTATION: back to `lsSet(ENGINE_APPLIED_KEY,
     step.applied)` -> written before hydration and kept over the durable
     value; red. MUTATION 2: `editStored(ENGINE_APPLIED_KEY, null, () =>
     step.applied)` -> queued, but it still overwrites the settled value: event
     40 lost and advance 9/1 rewritten to 7/1; red. */
  const m = mount();
  const h = await hydrating(m, { cp_engine_applied: JSON.stringify({ advance: { planSeq: 9, hopSeq: 1 }, event: 40 }) });
  m.ctx.applyEngineAdvance(engineHop(7, 1, "ep-a"));
  assert.ok(!h.store.setCalls.includes("cp_engine_applied"), "nothing written before hydration");
  h.land();
  assert.deepStrictEqual(h.json("cp_engine_applied"), { advance: { planSeq: 9, hopSeq: 1 }, event: 40 }, "the higher durable watermark stands");

  const n = mount();
  const g = await hydrating(n, { cp_engine_applied: JSON.stringify({ advance: { planSeq: 5, hopSeq: 1 }, event: 40 }) });
  n.ctx.applyEngineAdvance(engineHop(7, 1, "ep-a"));
  g.land();
  assert.deepStrictEqual(g.json("cp_engine_applied"), { advance: { planSeq: 7, hopSeq: 1 }, event: 40 }, "the hop moves the advance and keeps the event half");
});

test("before hydration the same hop delivered twice is applied once, and a drain keeps the durable advance", async () => {
  /* The read goes through the pending-edit overlay, so the queued watermark
     answers a second delivery inside the window. MUTATION: read the
     watermark with `lsGet(ENGINE_APPLIED_KEY, null)` in applyEngineAdvance
     -> the second delivery sees null and logs a second play_started; red.
     MUTATION 2: `() => step.applied` in drainEngineEvents -> the durable
     advance 5/1 is lost; red. */
  const m = mount();
  const h = await hydrating(m, { cp_engine_applied: JSON.stringify({ advance: { planSeq: 5, hopSeq: 1 }, event: 2 }) });
  assert.strictEqual(m.ctx.applyEngineAdvance(engineHop(6, 1, "ep-a")), true);
  assert.strictEqual(m.ctx.applyEngineAdvance(engineHop(6, 1, "ep-a")), false, "the queued watermark answers the second delivery");
  h.land();
  assert.strictEqual(m.rows("play_started").length, 1, "one play_started for one hop");

  const n = mount();
  const g = await hydrating(n, { cp_engine_applied: JSON.stringify({ advance: { planSeq: 5, hopSeq: 1 }, event: 2 }) });
  n.ctx.drainEngineEvents([{ seq: 3, kind: "position", episode_id: "ep-a", seconds: 60, duration: 600, at: 1 }]);
  g.land();
  assert.deepStrictEqual(g.json("cp_engine_applied"), { advance: { planSeq: 5, hopSeq: 1 }, event: 3 });
});
