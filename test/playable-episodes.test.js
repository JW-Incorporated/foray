/* WHAT "PLAYABLE" MEANS — audit 2026-09-22, theme A.
 *
 * The curated discover pool (`state.poolIds`) was the identity test for "is this
 * a real episode" in five places. Since show pages gained the full catalogue,
 * most episodes a listener touches are NOT in that pool, so the app called its
 * own working episodes gone:
 *
 *   - Up Next rows read "Episode no longer available" for anything queued from
 *     a show page (qa 95, persona 29);
 *   - Library History read "No longer available" for every show-page play
 *     (qa 96);
 *   - Library Saved rendered a starred show-page episode unplayable although
 *     its snapshot carried audio_url (qa 97);
 *   - continuous playback stopped dead at the first such episode (qa 104);
 *   - "Open episode" on the restored bar said "Episode not found" for the audio
 *     in your ears, on any launch route but Home (qa 123, qa 165);
 *   - `#/show/pi:<n>` — a link the app itself produced — could never render
 *     after a reload (qa 124).
 *
 * THE HARNESS RULE THAT MATTERS HERE: every assertion that is about surviving a
 * reload boots app.js a SECOND time over the same storage Map, which throws
 * away `state.itemIndex`, `state.poolIds` and every in-memory cache exactly as
 * a fresh page would, and keeps only what the device kept. The defect lived in the gap between "the session
 * cache still has it" and "the device kept it" — a test that never reloads
 * starts in the one state where the old code was right (CLAUDE.md, #276).
 *
 * Every test names the mutation that kills it.
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
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn",
  "banner-slot", "pl-form", "pl-input", "pl-note",
];

/** Boot app.js in a fresh context over `store` (a Map standing in for the
    device's storage). Calling it twice over the same Map IS a reload. */
function boot(store, { hash = "#/" } = {}) {
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
  const listeners = {};
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
        return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    location: { hash, search: "", pathname: "/", href: "https://x.test/" + hash },
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
  const state = vm.runInContext("state", ctx);
  // A pool that does NOT hold the breadth episodes below — the founder's case.
  state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [], commute: {} };
  state.discover = { items: [] };
  state.taxonomy = { nodes: [] };
  state.catalog = { shows: [] };
  return { ctx, state, store, view: () => byId.get("view").innerHTML };
}

const SHOW = { show_id: "lex-fridman-podcast", title: "Lex Fridman Podcast", artwork_url: "https://art.test/lex.jpg" };

/** A show-page episode, minted by the real mapper a show page uses. */
function showPageEpisode(m, n) {
  return m.ctx.fullCatalogueRowToEpRowItem(SHOW, {
    guid: `https://lexfridman.com/?p=${n}`,
    title: `Episode ${n}`,
    description_text: "A long publisher description. ".repeat(60),
    audio_url: `https://audio.test/lex/${n}.mp3`,
    duration_seconds: 3600 + n,
    published_at: "2026-09-01",
    chapters: [{ start: 0, title: "Intro" }],
  });
}

/** A fake player that records plays; `pointer` is its durable now-playing row. */
function fakePlayer(pointer = null) {
  const calls = [];
  /* What the real player answers right after a successful `play(item)`: that
     item IS current. `bindPlay` checks it before the play (toggle vs start) and
     after it (audit round 2, p-impatient-2: a play superseded mid-load is not
     recorded), so a fake stuck on `false` was a fake the real thing contradicts. */
  let current = null;
  return {
    calls,
    async play(item) { calls.push(item); current = item.id; return true; },
    isCurrent: (id) => id === current,
    onEpisodeEnded() { return () => {}; },
    lastEpisodeCard: () => pointer,
    restoreLastEpisode: () => !!pointer,
  };
}

/** Drive the REAL bindPlay over one play button and click it. */
async function clickPlay(m, id, ctxName = "show-x") {
  let handler = null;
  const btn = { dataset: { play: id, ctx: ctxName }, addEventListener: (_t, fn) => { handler = fn; } };
  m.ctx.bindPlay({ querySelectorAll: (sel) => (sel === "[data-play]" ? [btn] : []) });
  await handler({ preventDefault() {}, stopPropagation() {} });
}

test("ROUND 2 review (p-switcher-7): a show-page row's snapshot carries show_id, so its show name links after a save", () => {
  /* fullCatalogueRowToEpRowItem is the other producer of breadth rows, and it
     passed only `show: show.title`: saved or queued, the show name was plain
     text again. MUTATION: drop `show_id` from its snapshot source -> red. */
  const m = boot(new Map());
  const ep = showPageEpisode(m, 51);
  assert.strictEqual(ep.show_id, "lex-fridman-podcast");
  m.state.catalog = { shows: [] };   // not a curated show: no title join to fall back on
  const row = m.ctx.epRow(ep, 0, "saved");
  assert.ok(row.includes('href="#/show/lex-fridman-podcast"'), `the show name links by id: ${row.slice(0, 400)}`);
});

test("an episode queued from a show page is still a playable Up Next row after a reload", () => {
  /* qa 95 / persona 29. MUTATION: drop `rememberEpisode(id)` from addToQueue —
     the reloaded row resolves "unnamed" ("Episode no longer available"). */
  const store = new Map();
  const a = boot(store);
  const ep = showPageEpisode(a, 1);
  a.ctx.addToQueue(ep.id);

  const b = boot(store); // reload
  const [row] = b.ctx.queueRows();
  assert.strictEqual(row.state, "live", "a queued show-page episode must not read as gone");
  assert.strictEqual(row.item.audio_url, ep.audio_url, "and it must carry the audio it will play");
  assert.strictEqual(row.item.title, "Episode 1");
});

test("the same row is live in the SAME session too — the pool was never the question", () => {
  /* The in-session half of qa 95: before any reload, itemIndex holds the full
     row with its audio_url, and the old rule still refused it for not being in
     the curated pool. Nothing is stored here (no add, no star), so this is the
     session-cache path alone. MUTATION: restore `state.poolIds.has(id) ? … :
     null` as the liveness test, or drop liveEpisode's itemIndex branch. */
  const m = boot(new Map());
  const ep = showPageEpisode(m, 2);
  assert.strictEqual(m.ctx.rowsForIds([ep.id])[0].state, "live");
});

test("an episode played from a show page is a playable History row after a reload", async () => {
  /* qa 96. Drives the real bindPlay. MUTATION: have bindPlay append the id to
     cp_history itself instead of calling recordHistory — History reads "No
     longer available" after the reload. */
  const store = new Map();
  const a = boot(store);
  const ep = showPageEpisode(a, 3);
  a.ctx.window.ForayPlayer = fakePlayer();
  await clickPlay(a, ep.id);
  assert.deepStrictEqual(JSON.parse(store.get("cp_history")), [ep.id], "the play must be recorded");

  const b = boot(store);
  const [row] = b.ctx.rowsForIds(b.ctx.pickedHistory());
  assert.strictEqual(row.state, "live", "history must not deny the listening happened");
  assert.strictEqual(row.item.title, "Episode 3");
});

test("ROUND 2 review: a play SUPERSEDED mid-load reports no failure; a refused play that is still current does", async () => {
  /* `play()` answers false for row A once row B's tap replaced it, and bindPlay
     painted "That episode couldn't load" over B while B loaded. MUTATION:
     drop the `isCurrent` return inside `if (!ok)`. */
  const m = boot(new Map());
  const a = showPageEpisode(m, 21);
  const reports = [];
  let current = null;
  m.ctx.window.ForayPlayer = {
    // A's load resolves after B was tapped: B is current, A's answer is false.
    async play() { current = "some-later-row"; return false; },
    isCurrent: (id) => id === current,
    reportPlayFailure: (e) => reports.push(e),
    onEpisodeEnded() { return () => {}; },
  };
  await clickPlay(m, a.id);
  assert.deepStrictEqual(reports, [], "superseded is silent");
  assert.strictEqual(m.store.get("cp_history"), undefined, "and not recorded as played");

  m.ctx.window.ForayPlayer.play = async (item) => { current = item.id; return false; };
  current = null;
  await clickPlay(m, a.id);
  assert.strictEqual(reports.length, 1, "a refused play of the current item still says so");
});

test("ROUND 2 review: a ▶ on Up Next does not snapshot the queue as a second play list", async () => {
  /* With `data-ctx="upnext"` the rows on screen became `state.playList`, so a
     row the listener then removed with ✕ still played next (planAfterEnded
     falls back to the list). MUTATION: drop `listCtx !== UP_NEXT_CTX`. */
  const m = boot(new Map());
  const eps = [31, 32, 33].map((n) => showPageEpisode(m, n));
  m.ctx.window.ForayPlayer = fakePlayer();
  const handlers = new Map();
  const btns = eps.map((e) => ({ dataset: { play: e.id, ctx: "upnext" }, addEventListener: (_t, fn) => { handlers.set(e.id, fn); } }));
  m.ctx.bindPlay({ querySelectorAll: (sel) => (sel === "[data-play]" ? btns : []) });
  await handlers.get(eps[0].id)({ preventDefault() {}, stopPropagation() {} });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m.state.playList)), [eps[0].id], "the list is the one episode; Up Next is the continuation");
});

test("ROUND 2 review: a row star reaches the Now Playing sheet with the NEW saved state", () => {
  /* toggleStar refreshed the sheet before writing cp_saved, and the sheet
     paints synchronously from storage, so it showed the pre-toggle Save.
     MUTATION: move refreshEpisodeNavigation() back above lsSet -> red. */
  const m = boot(new Map());
  const ep = showPageEpisode(m, 41);
  const painted = [];
  m.ctx.window.ForayPlayer = {
    setEpisodeNavigation: (nav) => painted.push(nav.isSaved(ep.id)),
  };
  m.ctx.toggleStar(ep.id);
  assert.strictEqual(painted[painted.length - 1], true, "the sheet paints Saved");
  m.ctx.toggleStar(ep.id);
  assert.strictEqual(painted[painted.length - 1], false, "and Save again after un-saving");
});

test("a starred show-page episode is PLAYABLE in Library → Saved after a reload, not greyed", () => {
  /* qa 97. The snapshot toggleStar writes has always carried audio_url; the old
     rule sent every non-pool id to `archived` anyway. MUTATION: drop the
     `storedEpisode` branch from liveEpisode — the row is archived. */
  const store = new Map();
  const a = boot(store);
  const ep = showPageEpisode(a, 4);
  a.ctx.toggleStar(ep.id);

  const b = boot(store);
  const [row] = b.ctx.rowsForIds(Object.keys(b.ctx.savedMap()));
  assert.strictEqual(row.state, "live");
});

test("a snapshot WITHOUT audio stays archived — #276's partial playlist part cannot become live", () => {
  /* The guard the new rule must keep. renderPlaylistDetail seeds archived parts
     (no audio_url) into itemIndex; the old defect was reading that seed as live.
     MUTATION: make liveEpisode return any itemIndex entry (drop the audio_url
     test) — this row turns live. */
  const m = boot(new Map());
  m.state.itemIndex["gone-part"] = { id: "gone-part", title: "Old part", show: "Some show" };
  assert.strictEqual(m.ctx.liveEpisode("gone-part"), null);
  assert.strictEqual(m.ctx.rowsForIds(["gone-part"])[0].state, "unnamed",
    "a partial with no stored snapshot is not something we can name from storage either");
});

test("continuous playback reaches a show-page episode queued before a reload", () => {
  /* qa 104 / persona 30. MUTATION: restore the `state.poolIds.has(nextId)` gate
     on the next item — nothing plays. */
  const store = new Map();
  const a = boot(store);
  const e1 = showPageEpisode(a, 5);
  const e2 = showPageEpisode(a, 6);
  a.ctx.addToQueue(e1.id);
  a.ctx.addToQueue(e2.id);

  const b = boot(store);
  const player = fakePlayer();
  b.ctx.window.ForayPlayer = player;
  b.ctx.advanceQueueOnEnded(e1.id);
  assert.strictEqual(player.calls.length, 1, "the next queued episode must play");
  assert.strictEqual(player.calls[0].id, e2.id);
});

test("the stored snapshot is bounded: long text is cut and ids nothing refers to are pruned", () => {
  /* The store is written on every queue add and every play. MUTATION: store
     the snapshot whole (drop storableEpisode) — the description survives and
     the hook is the publisher's full text. MUTATION 2: drop the prune — the
     dequeued episode's snapshot is still there. */
  const store = new Map();
  const m = boot(store);
  const e1 = showPageEpisode(m, 7);
  const e2 = showPageEpisode(m, 8);
  m.ctx.addToQueue(e1.id);
  const snap = JSON.parse(store.get("cp_episode_snaps"))[e1.id];
  assert.strictEqual(snap.description, null, "the publisher's description is not stored per add");
  assert.strictEqual(snap.chapters, null);
  assert.ok(snap.hook.length <= 280, `hook is capped, got ${snap.hook.length}`);

  m.ctx.removeFromQueue(e1.id);
  m.ctx.addToQueue(e2.id);
  const ids = Object.keys(JSON.parse(store.get("cp_episode_snaps")));
  assert.deepStrictEqual(ids, [e2.id], "a snapshot nothing refers to must not accumulate");
});

test("'Open episode' resolves the episode the player holds, on a cold start off Home", () => {
  /* qa 123 / qa 165: launch on #/shows, the bar restores a show-page episode,
     and #/episode/<id> must find it. MUTATION: drop the playerPointerEpisode
     source from resolveEpisode — "Episode not found". */
  const m = boot(new Map(), { hash: "#/shows" });
  const pointer = {
    id: "lex-fridman-podcast--https://lexfridman.com/?p=9", title: "Episode 9",
    show: "Lex Fridman Podcast", audio_url: "https://audio.test/lex/9.mp3",
  };
  m.ctx.window.ForayPlayer = fakePlayer(pointer);
  m.ctx.renderEpisode(pointer.id);
  assert.ok(!m.view().includes("Episode not found"), m.view().slice(0, 200));
  assert.ok(m.view().includes("Episode 9"));
});

test("restoring the bar seeds the episode into the index on a non-Home route", () => {
  /* qa 165's other half: the seed used to happen only as a side effect of
     Home's Jump back in card. MUTATION: drop `playerPointerEpisode(null)` from
     restoreNowPlayingRibbon — the index stays empty on #/queue. */
  const m = boot(new Map(), { hash: "#/queue" });
  const pointer = { id: "breadth--7", title: "Seven", show: "S", audio_url: "https://audio.test/7.mp3" };
  m.ctx.window.ForayPlayer = fakePlayer(pointer);
  m.ctx.restoreNowPlayingRibbon();
  assert.strictEqual(m.state.itemIndex["breadth--7"]?.title, "Seven");
});

test("a #/show/pi:<n> page the listener opened resolves again after a reload", () => {
  /* qa 124. MUTATION: drop `rememberShardShow(show)` from renderShow — the
     reloaded showById answers null and the page says "Show not found." */
  const store = new Map();
  const a = boot(store);
  a.state.shardShowCache["pi:42"] = a.ctx.mapShardRow({ id: 42, t: "Tiny Show", img: "https://art.test/t.jpg" });
  a.ctx.renderShow("pi:42");

  const b = boot(store);
  const show = b.ctx.showById("pi:42");
  assert.ok(show, "a pi: show we rendered must survive the reload");
  assert.strictEqual(show.title, "Tiny Show");
});

test("a FOLLOWED pi: show resolves from its follow record, even if never re-rendered", () => {
  /* The Followed-shows row links to #/show/pi:<n>; the follow record already
     holds its title and art. MUTATION: drop the starredShowsMap fallback from
     rememberedShardShow. */
  const store = new Map([["cp_starred_shows", JSON.stringify({
    "pi:77": { show_id: "pi:77", title: "Followed Tiny", artwork_url: null, starred_at: "2026-09-01" },
  })]]);
  const m = boot(store);
  assert.strictEqual(m.ctx.showById("pi:77")?.title, "Followed Tiny");
});

test("every not-found page has a page head and a ‹", () => {
  /* qa 125. MUTATION: revert renderEpisode to the one-line note. */
  const m = boot(new Map());
  m.ctx.renderEpisode("no-such-episode");
  assert.ok(m.view().includes("Episode not found."));
  assert.ok(m.view().includes('class="back"'), "a stale link must not be a dead end");
  m.ctx.renderShow("pi:999999");
  assert.ok(m.view().includes("Show not found."));
  assert.ok(m.view().includes('class="back"'));
});
