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
 *  b. With bookmarks, a "Bookmarks" section between the actions and the notes
 *     lists them in second order, each a `data-ts` row with a Remove.
 *  c. The words are player/bookmarks.js's: "At 1:02:03", or "Around minute 62"
 *     when a stitched copy drifted past seek-policy's tolerance since the mark
 *     was set (the player's observed length against the one stored with it).
 *  d. An unclassified show counts as stitched (chapterPrecision's reading); no
 *     player reading claims no drift; a typed label is shown as typed.
 *  e. A tap is the page's play-then-seek (bindEpisodeSeeks).
 *  f. Remove drops that row from cp_bookmarks, repaints, announces, keeps
 *     focus in the list, logs nothing; the last row takes the section.
 *  g. A refused Remove removes nothing and says nothing.
 *  h. A bookmark made from the sheet over this page is listed at once.
 *  i. A page painted before the durable store landed lists them when it does.
 *
 * The player's half of (c)/(d), the length of the copy in hand, is not built
 * here: PQ-15 says "Do not touch: client.js" and, since
 * `ForayPlayer.episodeProgress` has no duration field, pass `null` (its
 * escalation). Today ForayPlayer has no `observedDurationSec`, so the page
 * reads null and claims no drift; the stubs below stand in for the member a
 * later card exposes, and (c)/(d) pin what the page does once it exists.
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

/** A ForayPlayer that records every way audio could start, and reports the
    length of the copy in hand (`observedDurationSec`, a member a later card
    adds to client.js; absent today, so the page reads null). */
function recordingPlayer({ observed = null, current = false, loaded = true } = {}) {
  const rec = { plays: [], seeks: [], toggles: 0, asked: [] };
  rec.api = {
    canPlay: () => true,
    isPlaying: () => false,
    isCurrent: () => current,
    isLoadedCurrent: () => loaded,
    play: async (item, opts) => { rec.plays.push({ id: item.id, opts }); return true; },
    seekTo: async (s) => { rec.seeks.push(s); },
    togglePlayback: async () => { rec.toggles += 1; },
    reportPlayFailure: () => {},
    observedDurationSec: (id) => { rec.asked.push(id); return observed; },
  };
  return rec;
}

const rowsOf = (section) => [...section.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => ({
  ts: (/data-ts="([^"]*)"/.exec(m[1]) || [])[1],
  title: unesc((/<span class="ep-chapter-title">([^<]*)<\/span>/.exec(m[1]) || [])[1]),
  play: unesc((/class="ep-chapter-row ep-bookmark-row"[^>]*aria-label="([^"]*)"/.exec(m[1]) || [])[1]),
  remove: unesc((/class="ep-bookmark-remove"[^>]*aria-label="([^"]*)"/.exec(m[1]) || [])[1]),
}));
const CLICK = { preventDefault() {}, stopPropagation() {} };

/* ---------- b: the list ---------- */

test("(b) the episode's bookmarks are listed in second order, each a data-ts row with a Remove, between the actions and the notes", () => {
  /* MUTATION: drop `${bookmarksSlotHtml(item)}` from renderEpisode -> no
     section; red. MUTATION 2: drop the data-bookmark-remove button from the
     row template -> no Remove label; red. */
  const m = mount({ player: recordingPlayer({ observed: 3600 }).api });
  m.seed({ "ep-1": [row(900, "2026-10-01T10:02:00.000Z"), row(60, "2026-10-01T10:00:00.000Z"), row(3723, "2026-10-01T10:01:00.000Z")] });
  m.render(ep({ description: NOTES }));
  const sec = m.section();
  assert.ok(sec, "a Bookmarks section renders");
  assert.match(sec, /<h3>Bookmarks<\/h3>/);
  assert.deepStrictEqual(rowsOf(sec), [
    { ts: "60", title: "At 1:00", play: "Play bookmark at 1:00", remove: "Remove bookmark at 1:00" },
    { ts: "900", title: "At 15:00", play: "Play bookmark at 15:00", remove: "Remove bookmark at 15:00" },
    { ts: "3723", title: "At 1:02:03", play: "Play bookmark at 1:02:03", remove: "Remove bookmark at 1:02:03" },
  ]);
  const html = m.html();
  assert.ok(html.indexOf('class="ep-actions"') < html.indexOf(sec) && html.indexOf(sec) < html.indexOf('class="ep-description"'),
    "after the actions, before the notes");
  assert.ok(html.indexOf(sec) < html.indexOf('class="ep-chapters"'), "and before the chapters");
});

/* ---------- c/d: precision ---------- */

test("(c) a stitched show whose copy drifted 45 s since the mark reads 'Around minute 62'; inside the tolerance, or on a static show, 'At 1:02:03'", () => {
  /* The words are player/bookmarks.js's bookmarkLabel over its
     bookmarkPrecision (an OWN marker against seek-policy's 30 s tolerance).
     MUTATION: a hand-rolled label in bookmarksHtml
     (`const said = "at " + fmtChapterTime(bm.sec);`) -> the drifted row
     still claims 1:02:03; red. MUTATION 2: make bookmarkObservedSec
     `return null;` -> no drift is ever seen; red. */
  const mark = { "ep-1": [row(3723, "2026-10-01T10:00:00.000Z", { duration_sec: 3600 })] };
  const drifted = recordingPlayer({ observed: 3645 });
  const m = mount({ player: drifted.api });
  m.seed(mark);
  m.render(ep({ dai_suspected: true }));
  assert.deepStrictEqual(rowsOf(m.section()).map((r) => [r.title, r.play]), [["Around minute 62", "Play bookmark around minute 62"]]);
  assert.ok(drifted.asked.includes("ep-1"), "the length of the copy in hand is the player's");
  assert.doesNotMatch(m.section(), /1:02:03/, "a moved timeline is never claimed to the second");

  const close = mount({ player: recordingPlayer({ observed: 3610 }).api });
  close.seed(mark);
  close.render(ep({ dai_suspected: true }));
  assert.deepStrictEqual(rowsOf(close.section()).map((r) => r.title), ["At 1:02:03"], "10 s of drift is the same copy");

  const plain = mount({ player: recordingPlayer({ observed: 3645 }).api });
  plain.seed(mark);
  plain.render(ep({ dai_suspected: false }));
  assert.deepStrictEqual(rowsOf(plain.section()).map((r) => r.title), ["At 1:02:03"], "a static enclosure does not move");
});

test("(d) an unclassified show counts as stitched; a page with no player reading claims no drift; a typed label is shown as typed", () => {
  /* MUTATION: drop `|| item.dai_known === false` from bookmarksHtml's show
     reading -> the unclassified drifted row reads At 1:02:03; red.
     MUTATION 2: capitalise every label (drop the `bm.label ? said :` arm)
     -> "The good bit"; red. */
  const marks = { "ep-1": [row(3723, "2026-10-01T10:00:00.000Z"), row(4000, "2026-10-01T10:05:00.000Z", { label: "the good bit" })] };
  const m = mount({ player: recordingPlayer({ observed: 3645 }).api });
  m.seed(marks);
  m.render(ep({ dai_known: false, dai_suspected: false }));
  const rows = rowsOf(m.section());
  assert.strictEqual(rows[0].title, "Around minute 62", "unclassified + drifted: approximate");
  assert.deepStrictEqual([rows[1].title, rows[1].play, rows[1].remove], ["the good bit", "Play bookmark, the good bit", "Remove bookmark, the good bit"]);

  const none = mount();
  none.seed(marks);
  none.render(ep({ dai_suspected: true }));
  assert.strictEqual(rowsOf(none.section())[0].title, "At 1:02:03", "no reading of the copy in hand: no drift is claimed");
});

/* ---------- e: tap = play-then-seek ---------- */

test("(e) a tap on a bookmark is the page's play-then-seek: a start at the mark, or a seek and resume on the loaded episode", async () => {
  /* MUTATION: spell the row's attribute `data-at` instead of `data-ts` in
     bookmarksHtml -> bindEpisodeSeeks never sees it, nothing plays; red. */
  const rec = recordingPlayer({ observed: 3600 });
  const m = mount({ player: rec.api });
  m.seed({ "ep-1": [row(3723, "2026-10-01T10:00:00.000Z")] });
  m.render(ep());
  const btn = m.view.querySelectorAll("[data-ts]").find((c) => /ep-bookmark-row/.test(c.attrs));
  assert.ok(btn, "the bookmark row is a data-ts control");
  assert.strictEqual(btn.handlers.length, 1, "bound once, by the page's own binder");
  await btn.handlers[0](CLICK);
  assert.deepStrictEqual(rec.plays.map((p) => [p.id, p.opts.startOffset]), [["ep-1", 3723]], "not current: start this episode AT the mark");
  assert.deepStrictEqual(rec.seeks, []);

  const cur = recordingPlayer({ observed: 3600, current: true, loaded: true });
  const c = mount({ player: cur.api });
  c.seed({ "ep-1": [row(3723, "2026-10-01T10:00:00.000Z")] });
  c.render(ep());
  await c.view.querySelectorAll("[data-ts]").find((x) => /ep-bookmark-row/.test(x.attrs)).handlers[0](CLICK);
  assert.deepStrictEqual(cur.plays, [], "the loaded episode is not restarted");
  assert.deepStrictEqual(cur.seeks, [3723], "it is moved to the mark");
  assert.strictEqual(cur.toggles, 1, "and resumed");
});

/* ---------- f/g: Remove ---------- */

test("(f) Remove drops that bookmark from cp_bookmarks, repaints the list, says so and keeps focus in the list; the last one takes the section with it", () => {
  /* MUTATION: drop `repaintBookmarks(item.id);` from bindBookmarkRemove's
     handler -> the removed row stays on screen; red. MUTATION 2: drop
     `announce("Bookmark removed.");` -> a screen reader hears nothing; red.
     MUTATION 3: make EPISODE_NAVIGATION.removeBookmark `return true;`
     without the module's write -> cp_bookmarks keeps the row; red. */
  const m = mount({ player: recordingPlayer({ observed: 3600 }).api });
  const A = "2026-10-01T10:00:00.000Z", B = "2026-10-01T10:01:00.000Z", C = "2026-10-01T10:02:00.000Z";
  m.seed({ "ep-1": [row(60, A), row(900, B), row(3723, C)], "ep-2": [row(5, A)] });
  m.render(ep());
  const before = m.events.length;
  const removeOf = (createdAt) => m.view.querySelectorAll("[data-bookmark-remove]").find((b) => b.dataset.bookmarkRemove === createdAt);
  removeOf(B).handlers[0](CLICK);
  assert.deepStrictEqual(m.raw()["ep-1"].map((r) => r.created_at), [A, C], "the 15:00 bookmark is gone from storage");
  assert.deepStrictEqual(m.raw()["ep-2"].map((r) => r.created_at), [A], "another episode's are untouched");
  assert.deepStrictEqual(rowsOf(m.section()).map((r) => r.ts), ["60", "3723"], "and from the list");
  assert.strictEqual(m.status(), "Bookmark removed.");
  assert.strictEqual(removeOf(C).focused, 1, "focus moves to the next row's Remove");
  assert.strictEqual(removeOf(C).handlers.length, 1, "the repainted list is bound, once");

  removeOf(C).handlers[0](CLICK);
  removeOf(A).handlers[0](CLICK);
  assert.strictEqual(m.section(), "", "no bookmarks left, no section");
  assert.match(m.html(), /data-bookmarks-slot="ep-1"><\/div>/, "the empty slot stays for the next one");
  assert.ok(!("ep-1" in m.raw()), "the episode's key goes with its last row");
  assert.strictEqual(m.events.length, before, "no event is logged: bookmarks stay on the device");
});

test("(g) a Remove the store refuses removes nothing and says nothing", () => {
  /* MUTATION: announce before consulting the write (`announce(...)` above
     `if (!ok) return;`) -> "Bookmark removed." for a row still kept; red. */
  const m = mount({ player: recordingPlayer({ observed: 3600 }).api });
  const A = "2026-10-01T10:00:00.000Z";
  m.seed({ "ep-1": [row(60, A)] });
  m.render(ep());
  m.ctx.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  m.view.querySelectorAll("[data-bookmark-remove]")[0].handlers[0](CLICK);
  assert.deepStrictEqual(m.raw()["ep-1"].map((r) => r.created_at), [A], "still stored");
  assert.deepStrictEqual(rowsOf(m.section()).map((r) => r.ts), ["60"], "still listed");
  assert.notStrictEqual(m.status(), "Bookmark removed.");
});

/* ---------- h/i: the list follows the store ---------- */

test("(h) a bookmark made from the sheet with this episode's page underneath is listed at once, and bound; another episode's page is untouched", () => {
  /* MUTATION: drop `if (bm) repaintBookmarks(id);` from
     EPISODE_NAVIGATION.addBookmark -> the page keeps saying nothing until
     the listener navigates away and back; red. */
  const m = mount({ player: recordingPlayer({ observed: 3600 }).api });
  m.render(ep());
  assert.strictEqual(m.section(), "", "no bookmarks yet");
  const nav = m.evalIn("EPISODE_NAVIGATION");
  assert.ok(nav.addBookmark("ep-1", 125.4, 3600));
  assert.deepStrictEqual(rowsOf(m.section()).map((r) => [r.ts, r.title]), [["125", "At 2:05"]]);
  assert.strictEqual(m.view.querySelectorAll("[data-ts]").find((c) => /ep-bookmark-row/.test(c.attrs)).handlers.length, 1, "the new row plays");
  assert.strictEqual(m.view.querySelectorAll("[data-bookmark-remove]")[0].handlers.length, 1, "and removes");

  const other = mount({ player: recordingPlayer({ observed: 3600 }).api });
  other.render(ep({ id: "ep-2" }));
  other.evalIn("EPISODE_NAVIGATION").addBookmark("ep-1", 30, 3600);
  assert.strictEqual(other.section(), "", "ep-1's mark is not painted onto ep-2's page");
});

/** A durable store the way player/durable-store.js behaves (test/bookmarks.test.js's
    fixture): reads are memory; a key this session wrote is never replaced by hydration. */
function slowStore(durable) {
  const mem = new Map();
  const dirty = new Set();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { dirty.add(k); mem.set(k, String(v)); },
    removeItem: (k) => { dirty.add(k); mem.delete(k); },
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
    hydrate: () => new Promise(() => {}),
    land() { for (const [k, v] of Object.entries(durable)) if (!dirty.has(k)) mem.set(k, v); },
  };
}

test("(i) a page painted while the durable store is still hydrating lists the bookmarks when it lands", async () => {
  /* localStorage swept, IndexedDB slow: the first paint reads no bookmarks.
     MUTATION: drop the `afterStorageSettles(() => repaintBookmarks(item.id))`
     line from renderEpisode -> the list stays empty for the visit; red. */
  const m = mount({ player: recordingPlayer({ observed: 3600 }).api });
  await new Promise((r) => setTimeout(r, 0));   // let init()'s storage wait settle first
  const store = slowStore({ cp_bookmarks: JSON.stringify({ "ep-1": [row(900, "2026-09-01T10:00:00.000Z")] }) });
  m.ctx.forayStorage = store;
  m.evalIn("storageSettled = false");
  assert.strictEqual(m.evalIn("storageWaiting()"), true, "fixture assumption: the store is hydrating");
  m.render(ep());
  assert.strictEqual(m.section(), "", "nothing to read yet");
  store.land();
  m.evalIn("markStorageSettled()");
  assert.deepStrictEqual(rowsOf(m.section()).map((r) => r.ts), ["900"], "the durable bookmark is listed");
});
