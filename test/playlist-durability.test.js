/* A saved playlist must not decay (#276).
 *
 * WHAT WENT WRONG, AND WHY A SUITE RATHER THAN A PATCH
 * A playlist persisted `item_ids` and nothing else, then resolved them at render
 * time against whatever `data/discover.json` currently held. That pool moves —
 * the nightly refresh rotates episodes through it on the web, and after #274 the
 * native bundle ships a per-show slice of 622 of 1,534 items. So ids left the
 * pool, `.filter(Boolean)` dropped the parts behind them, and the list asserted a
 * count the detail view could not render: "7 parts" over five rows, with nothing
 * said. The failure is invisible on the day the playlist is built and appears
 * weeks later with no code change involved, which is precisely the shape a test
 * has to hold down, because no reviewer will ever see it happen.
 *
 * THE PROPERTY, stated once: THE POOL CANNOT CHANGE THE LENGTH OF A PLAYLIST.
 * The count in the list and the rows in the detail view come from the same
 * resolved array, and the pool's only remaining power is to upgrade a row it
 * still recognises. Everything below is that property, its storage cost, and its
 * migration.
 *
 * WHICH SUITE COVERS WHAT — read this before concluding these tests are vacuous
 * (#266's mutation round found a central mechanism surviving in two suites before
 * a third caught it, so the division is written down rather than assumed):
 *
 *   THIS FILE          the whole of #276: the decay reproduced against the REAL
 *                      committed catalogue and a real `buildPlaylist`, the
 *                      persisted field whitelist and its byte cost, what an
 *                      unresolvable part renders as, and both directions of the
 *                      migration. Every test names the mutation that kills it.
 *   test/data-deletion.test.js
 *                      that `cp_playlists` is enumerated, cleared from both
 *                      storage tiers, and documented in the privacy policy's §1
 *                      table. It pins the KEY, not the shape — the policy row was
 *                      rewritten in this PR because the shape change is material,
 *                      and that suite is what would have failed had a new key
 *                      been invented instead.
 *   test/app-security.test.js
 *                      that `esc()`/`safeUrl()` exist and behave, and that app.js
 *                      interpolates through them. It cannot see whether the NEW
 *                      row uses them, so this file asserts that directly.
 *   test/suite-integrity.test.js
 *                      that this file exists and keeps its test count.
 *
 * No dependencies: node:test + node:vm, a minimal DOM stub whose `#view` keeps
 * the HTML it is given (every render assertion here is against that string —
 * there is no parser, and pretending otherwise is how a stub starts lying), the
 * real `search-engine.js` in the same context, and for the reproduction the real
 * `data/*.json` served off disk. Nothing here touches the network.
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

/* Registered ONCE, not per mount: a non-booting mount leaves init() parked on a
   fetch that never settles, and one listener per mount trips node's
   MaxListeners warning long before the suite finishes. */
process.on("unhandledRejection", () => {});

/* ---------- the DOM stub ---------- */

/* Deliberately minimal and deliberately honest about it: ids resolve to stable
   objects so a render can be read back, and everything else answers "nothing
   here". `#pl-remove` is intentionally absent — it only exists inside an
   innerHTML string, so `$("#pl-remove")?.addEventListener` must survive a null,
   which is a real code path on any page whose markup changed. */
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
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results",
];

/**
 * Mount app.js (and search-engine.js, which the page loads first) in one vm
 * context.
 *
 * @param {object} [opts]
 * @param {object} [opts.seed]  initial `localStorage` rows, values already JSON.
 * @param {boolean} [opts.boot] let the REAL `init()` run, serving the committed
 *   `data/*.json` off disk. Without it `fetch` never settles and `init()` parks
 *   at its first await, which is what makes the fast tests dependency-free.
 */
function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const writes = [];
  const fetched = [];
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");
  const eventLog = {
    rows: [],
    append(row) { this.rows.push(row); },
    async unsynced() { return this.rows; },
    async markSynced() {},
    async pruneToRetention() {},
    health() { return { ok: true, backend: "memory", pending: 0, ringSize: this.rows.length, faults: [] }; },
  };

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => {
      fetched.push(String(url));
      if (!boot) return new Promise(() => {});
      const file = path.join(ROOT, String(url));
      const ok = String(url).startsWith("data/") && fs.existsSync(file);
      return Promise.resolve({
        ok, status: ok ? 200 : 404,
        json: async () => JSON.parse(fs.readFileSync(file, "utf8")),
      });
    },
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { writes.push(k); store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    /* `logEvent` (formerly `cp_events`) calls through `window.forayEventLog`
       now (M3) — a plain synchronous fake, mirroring the real module's shape.
       `eventLog.rows` is what this file's own assertion below reads. */
    forayEventLog: eventLog,
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
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  /* `state` is a top-level `const`, so it lives in the context's global lexical
     scope rather than on the context object. A script evaluated in the same
     context can read it — that is how the harness reaches the pool. */
  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, writes, fetched, body, eventLog,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
    playlistsRaw: () => JSON.parse(store.get("cp_playlists")),
  };
}

/** Boot the real page against the real catalogue and wait for it to land. */
async function mountBooted(seed) {
  const m = mount({ seed, boot: true });
  for (let i = 0; i < 200 && !m.state.ready; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.ok(m.state.ready, "init() never finished against the committed data files");
  return m;
}

/* ---------- a synthetic pool, in the discover.json shape ---------- */

function poolItem(n, over = {}) {
  return {
    id: `show-${n}--episode-${n}`,
    show: `Show ${n}`,
    title: `Episode ${n} of something`,
    apple_collection_id: 1000 + n,
    apple_track_id: 2000 + n,
    apple_episode_url: `https://podcasts.apple.com/us/podcast/ep${n}/id${1000 + n}?i=${2000 + n}`,
    release_date: "2026-05-01",
    duration_min: 40 + n,
    duration_sec: (40 + n) * 60,
    artwork_url: `https://art.test/${n}/600x600bb.jpg`,
    audio_url: `https://audio.test/${n}/episode.mp3`,
    audio_type: "audio/mpeg",
    topics: ["science/physics"],
    hook: `Why episode ${n} matters, at length, in a sentence nobody needs stored twice.`,
    ...over,
  };
}

/* THE HARNESS RULE THIS SUITE LEARNED THE HARD WAY, stated here because the next
   agent inherits these two helpers.

   `setPool` and `rotateOut` both clear `state.itemIndex` and `state.poolIds`, and
   that is CORRECT: each of them models a fresh page load — the one after the
   nightly refresh moved the catalogue. Keep it.

   What was WRONG was that every render assertion in the first draft of this file
   rendered once, from exactly that just-cleared state. `state.itemIndex` is
   session-lived and `renderPlaylistDetail` writes to it, so the second render of
   the same page in one session ran against state no test ever constructed — and
   that is where the fix silently stopped working (an archived part read as live
   from render two onward). The fake was more forgiving than the browser.

   So the resets stay, and `renderTwice` below is the second entry point: it
   renders, then renders again with NOTHING reset in between, which is what a
   listener does by leaving the page and coming back, and what the drawer's two
   toggles do on their own by calling route(). If a property is supposed to hold
   for a playlist, assert it on the SECOND render. */

/** Install a pool as a freshly-loaded page would have it. */
function setPool(m, items) {
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.discover = { items };
  m.state.taxonomy = { nodes: [] };
  m.state.itemIndex = {};
  m.state.poolIds = new Set();
  return items;
}

/* Take ids out of the pool exactly as the nightly refresh does — out of BOTH
   halves of it, since fullPool() unions session.json's curated episodes with
   discover.json's — and drop the derived caches, as a fresh page would. */
function rotateOut(m, gone) {
  m.state.discover.items = m.state.discover.items.filter((it) => !gone.has(it.id));
  for (const id of gone) delete m.state.session.episodes[id];
  m.state.itemIndex = {};
  m.state.poolIds = new Set();
}

/** Render the same playlist twice in one session, touching nothing in between.
    Returns both HTML strings. This is a navigation, not a reload. */
function renderTwice(m, id) {
  m.ctx.renderPlaylistDetail(id);
  const first = m.view();
  m.ctx.renderPlaylistDetail(id);
  return { first, second: m.view() };
}

/** Run the REAL bindPickLogging over one link and click it. The DOM stub cannot
    parse innerHTML, so the markup and the handler are asserted separately: a test
    that wants both checks the attributes in the HTML and then drives the handler
    with the same values. Anything else would be the handler-shaped no-op this
    suite's header warns about. */
function clickPick(m, { ep, ctx: dataCtx, app }) {
  const handlers = [];
  const a = {
    dataset: { ev: "picked", ep, ctx: dataCtx, ...(app ? { app } : {}) },
    addEventListener: (t, fn) => { if (t === "click") handlers.push(fn); },
  };
  m.ctx.bindPickLogging({ querySelectorAll: () => [a] });
  assert.strictEqual(handlers.length, 1, "bindPickLogging did not bind the link");
  handlers[0]({});
  return a;
}

const rowCount = (html) => (html.match(/class="ep-row/g) || []).length;
const goneCount = (html) => (html.match(/class="ep-row gone"/g) || []).length;
const nextMarkers = (html) =>
  [...html.matchAll(/<span class="q-num ([^"]*)">(\d+)<\/span>/g)]
    .filter(([, cls]) => cls.includes("next")).map(([, , n]) => n);

/* ==================================================================== */
/* 1. THE REPRODUCTION — the real catalogue, the real builder            */
/* ==================================================================== */

test("REPRODUCED: a playlist built today keeps every part after the pool rotates under it", async () => {
  /* THE TEST THE ISSUE ASKS FOR, and it is a reproduction rather than a
     reasoning: the real `data/*.json`, the real `buildPlaylist`, and then items
     REMOVED from the pool exactly as the nightly refresh removes them. On main
     this playlist comes back four parts shorter with nothing said.

     MUTATION 1: put `.filter(Boolean)` back into the row mapping (resolveParts
     dropping anything the pool lacks) — the row count falls to 6 and this fails.
     MUTATION 2: have buildPlaylist store `item_ids` only, with no `items` — every
     dropped part becomes unnameable and the title assertions fail. */
  const m = await mountBooted();
  const built = m.ctx.buildPlaylist("physics");
  assert.strictEqual(built.status, "ok");
  const saved = built.playlist;
  assert.ok(saved.items.length >= 6, `need a real multi-part playlist, got ${saved.items.length}`);

  const dropped = saved.items.slice(0, 4).map((part) => ({ id: part.id, title: part.title }));
  const gone = new Set(dropped.map((d) => d.id));
  rotateOut(m, gone);

  m.ctx.renderPlaylistDetail(saved.id);
  const html = m.view();
  assert.strictEqual(
    rowCount(html), saved.items.length,
    `the pool lost 4 parts and the detail view lost them too: ${rowCount(html)} rows for ${saved.items.length} saved`
  );
  assert.ok(
    html.includes(`${saved.items.length} episode`),
    `the heading must count what it renders: ${/[0-9]+ episodes?/.exec(html)}`
  );
  assert.strictEqual(goneCount(html), 4, "the four departed parts must be marked, not hidden");
  for (const d of dropped) {
    assert.ok(html.includes(m.ctx.esc(d.title)), `"${d.title}" vanished instead of being labelled`);
  }
});

test("REPRODUCED: the list's part count and the detail view's rows agree after a rotation", async () => {
  /* The listener-visible symptom in the issue title — "7 parts" over five rows —
     asserted as the equality it is, across BOTH views, after real decay.

     MUTATION: change renderPlaylists back to `p.item_ids.length` while
     resolveParts drops unresolvable parts. The two numbers separate and this
     fails. (Both views calling resolveParts is why they cannot separate now,
     which is also why this test pins the ABSOLUTE number and not just equality —
     a resolveParts that filtered would move both together.) */
  const m = await mountBooted();
  const saved = m.ctx.buildPlaylist("physics").playlist;
  const total = saved.items.length;
  rotateOut(m, new Set([saved.items[1].id]));

  m.ctx.renderPlaylists();
  const list = m.view();
  const listed = Number(/(\d+) parts/.exec(list)[1]);
  m.ctx.renderPlaylistDetail(saved.id);
  const detail = m.view();
  assert.strictEqual(listed, total, "the list must count the saved parts");
  assert.strictEqual(rowCount(detail), total, "the detail view must render the saved parts");
  assert.strictEqual(listed, rowCount(detail));
});

/* ==================================================================== */
/* 2. WHAT A PLAYLIST PERSISTS                                          */
/* ==================================================================== */

test("a saved part carries exactly the seven whitelisted fields, and no more", () => {
  /* The whitelist is the decision, so it is pinned literally: a field added to
     the pool must not silently start costing 50 playlists' worth of storage,
     and a field removed here must not silently stop rendering.

     MUTATION 1: add `audio_url` to PLAYLIST_PART_FIELDS — fails here and again in
     the byte-budget test below. MUTATION 2: drop `title` — fails here, and the
     archived row loses the only thing that makes it useful. */
  const m = mount();
  const part = m.ctx.playlistPart(poolItem(1));
  assert.deepStrictEqual(Object.keys(part).sort(), [
    "apple_collection_id", "apple_track_id", "duration_min", "id", "show", "title", "topics",
  ]);
});

test("the fields that ROT or cost the most are deliberately not copied", () => {
  /* `audio_url` is the point: it is the most expensive field AND the only one
     whose staleness produces a play button that fails, which is worse than the
     link-out an absent one degrades to. `artwork_url` is never rendered by a row,
     `apple_episode_url` is derivable from the two ids appleLink() already uses,
     and `hook` only reaches an in-app play.

     MUTATION: copy any of them into the part. This fails, by name. */
  const m = mount();
  const stored = JSON.stringify(m.ctx.playlistPart(poolItem(1)));
  for (const field of ["audio_url", "artwork_url", "apple_episode_url", "hook", "duration_sec"]) {
    assert.ok(!stored.includes(field), `${field} must not be persisted per playlist`);
  }
});

test("a full store of 50 playlists stays inside its stated storage budget", () => {
  /* The arithmetic from app.js's § header, asserted rather than claimed: ~268 B a
     part, ~3.4 KB a playlist, ~168 KB for a full 50 against savePlaylists' cap
     and SearchEngine.DEFAULT_CAP's 10 picks. Measured on REAL catalogue rows, so
     the titles and show names are the real lengths.

     This is a BYTE budget, not a wall-clock one: it is deterministic, it is the
     resource that actually binds (DurableStore's localStorage tier), and it is
     the one number that moves if somebody widens the whitelist.

     MUTATION: add `audio_url` (182 B a part) or `artwork_url` (161 B) to
     PLAYLIST_PART_FIELDS. Either blows the per-part ceiling and the total. */
  const m = mount();
  const cap = m.evalIn("SearchEngine.DEFAULT_CAP");
  assert.strictEqual(cap, 10, "the arithmetic below is stated against a 10-pick playlist");
  /* Measured over the WHOLE catalogue rather than its first ten rows, and with the
     worst case separated from the mean — the first draft sampled `slice(0, 10)` and
     left 49% slack against its own stated figure, so adding `hook` (97 B) or
     `duration_sec` (20 B) would have passed the budget it claimed to defend. The
     ceilings below are tight enough that either one goes red. */
  const real = readJson("data/discover.json").items;
  const sizes = real.map((it) => JSON.stringify(m.ctx.playlistPart(it)).length);
  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  assert.ok(mean < 285, `the mean part is ${mean.toFixed(0)} B against a documented 268; the budget is 285`);
  assert.ok(Math.max(...sizes) < 500, `the largest part is ${Math.max(...sizes)} B; the budget is 500`);

  const playlistOf = (parts) => m.ctx.withMirror({
    id: "q1", query: "a query somebody typed", title: "A Query Somebody Typed",
    items: parts, created: "2026-08-18T00:00:00.000Z", last_played_at: null, sparse: false,
  });
  const fifty = (parts) => JSON.stringify(Array.from({ length: 50 }, () => playlistOf(parts))).length;

  /* The typical full store, which is the ~168 KB app.js documents. */
  const typical = fifty(real.slice(0, cap).map((it) => m.ctx.playlistPart(it)));
  assert.ok(typical < 180 * 1024, `50 typical playlists are ${(typical / 1024).toFixed(0)} KB; the budget is 180 KB`);

  /* And the true worst case: 50 playlists of the ten longest-titled episodes in the
     catalogue. ~252 KB, which is the number to compare against a browser quota. */
  const longest = [...real].sort((a, b) =>
    JSON.stringify(m.ctx.playlistPart(b)).length - JSON.stringify(m.ctx.playlistPart(a)).length).slice(0, cap);
  const worst = fifty(longest.map((it) => m.ctx.playlistPart(it)));
  assert.ok(worst < 270 * 1024, `the worst 50 are ${(worst / 1024).toFixed(0)} KB; the budget is 270 KB`);
});

test("the item_ids mirror tracks items on every write, so an older app.js cannot read a lie", () => {
  /* The mirror exists for one reason: a service worker still serving a previous
     `app.js` reads `p.item_ids.length` in renderPlaylists and would throw on its
     absence, blanking the view for the length of the update window. A mirror that
     could drift from `items` would be this same defect one level down.

     MUTATION: drop `.map(withMirror)` from savePlaylists. The stale mirror
     survives the write and this fails. */
  const m = mount();
  const parts = [1, 2, 3].map((n) => m.ctx.playlistPart(poolItem(n)));
  m.ctx.savePlaylists([{ id: "q1", title: "T", created: "2026-08-18T00:00:00.000Z", items: parts, item_ids: ["stale"] }]);
  const [saved] = m.playlistsRaw();
  assert.deepStrictEqual(saved.item_ids, parts.map((p) => p.id));
});

test("items is authoritative: a mirror that disagrees is repaired, not believed", () => {
  /* WHY THIS TEST EXISTS: a mutation round proved it had to. Reverting
     renderPlaylists to `p.item_ids.length` killed nothing, because the mirror is
     kept in step and the two numbers are equal — which is fine, but only as long
     as SOMETHING pins which of them is the source of truth. This does: a store
     whose mirror claims five parts for two is corrected to two, in storage, and
     both views print two.

     MUTATION 1: drop the mirror-disagreement branch from hydratePlaylistParts. The
     stale mirror survives the read and this fails on the persisted value — and
     with it, `p.item_ids.length` becomes a number no test can distinguish.
     MUTATION 2: make resolveParts read `item_ids` in preference to `items`. Both
     the count and the row count go to five (six tests fail).

     AND THE SURVIVOR THIS TEST EXISTS TO JUSTIFY: reverting renderPlaylists to
     `p.item_ids.length` still kills nothing, and that is now correct rather than
     untested. Hydration repairs the mirror before either view reads it, so
     `p.item_ids.length === resolveParts(p).length` is an invariant — enforced by
     MUTATION 1 above. Both views are pointed at `resolveParts` anyway, because one
     source of truth is cheaper to keep right than two that happen to agree. */
  const m = mount();
  const items = setPool(m, [poolItem(1), poolItem(2)]);
  m.ctx.fullPool();
  const parts = items.map((it) => m.ctx.playlistPart(it));
  m.store.set("cp_playlists", JSON.stringify([{
    id: "q1", title: "T", items: parts,
    item_ids: [...parts.map((x) => x.id), "ghost-a", "ghost-b", "ghost-c"],
    created: "2026-08-18T00:00:00.000Z", last_played_at: null, sparse: false,
  }]));
  const [p] = m.ctx.playlists();
  assert.deepStrictEqual([...p.item_ids], parts.map((x) => x.id), "the mirror must be corrected");
  assert.deepStrictEqual([...m.playlistsRaw()[0].item_ids], parts.map((x) => x.id), "and the correction persisted");

  /* ORDER, not just length. The ghost mirror above is longer, so a repair that only
     compared `length` would pass it — and order is the whole point of a mirror an
     older app.js counts positions from. This one is the right length and wrong. */
  const swapped = mount();
  setPool(swapped, [poolItem(1), poolItem(2)]);
  swapped.ctx.fullPool();
  swapped.store.set("cp_playlists", JSON.stringify([{
    id: "q1", title: "T", items: parts, item_ids: [parts[1].id, parts[0].id],
    created: "2026-08-18T00:00:00.000Z",
  }]));
  swapped.ctx.playlists();
  assert.deepStrictEqual([...swapped.playlistsRaw()[0].item_ids], parts.map((x) => x.id),
    "a same-length mirror in the wrong order must still be repaired");
  m.ctx.renderPlaylists();
  assert.ok(m.view().includes("2 parts"), `the list must count items: ${/\d+ parts/.exec(m.view())}`);
  m.ctx.renderPlaylistDetail("q1");
  assert.strictEqual(rowCount(m.view()), 2);
});

test("savePlaylists still caps the store at 50 playlists", () => {
  /* Unchanged behaviour, floored here because per-playlist growth multiplies
     against it — the cap is now load-bearing for storage, not just for the list.

     MUTATION: raise or remove the `.slice(0, 50)`. This fails. */
  const m = mount();
  const many = Array.from({ length: 63 }, (_, i) => ({
    id: `q${i}`, title: `T${i}`, created: "2026-08-18T00:00:00.000Z", items: [m.ctx.playlistPart(poolItem(i))],
  }));
  m.ctx.savePlaylists(many);
  assert.strictEqual(m.playlistsRaw().length, 50);
});

/* ==================================================================== */
/* 3. WHAT AN UNRESOLVABLE PART BECOMES                                 */
/* ==================================================================== */

/** Save one playlist whose parts are snapshotted, then take the pool away. */
function withArchivedPart(m, { extraStub = false, over = {} } = {}) {
  const items = setPool(m, [poolItem(1), poolItem(2, over)]);
  m.ctx.fullPool();
  const parts = items.map((it) => m.ctx.playlistPart(it));
  if (extraStub) parts.push({ id: "long-gone--episode" });
  m.ctx.savePlaylists([{
    id: "q1", query: "physics", title: "Physics", items: parts,
    created: "2026-08-18T00:00:00.000Z", last_played_at: null, sparse: false,
  }]);
  setPool(m, [poolItem(1)]);       // episode 2 has rotated out
  m.ctx.renderPlaylistDetail("q1");
  return m.view();
}

test("an archived part is SHOWN and labelled, never hidden — 'label, never exclude' (#226)", () => {
  /* The catalogue keeps shows that are useless for Forays because playlists want
     them (#226). A playlist that silently drops parts works against the reason
     they are kept, so the row stays, named, with its number.

     MUTATION: filter non-live parts out of the render. Both the row count and the
     title assertion fail. */
  const m = mount();
  const html = withArchivedPart(m);
  assert.strictEqual(rowCount(html), 2, "both saved parts must render");
  assert.strictEqual(goneCount(html), 1, "the departed one must be marked");
  assert.ok(html.includes("Episode 2 of something"), "the archived part must still be named");
  assert.ok(html.includes("Show 2"), "and still credit its show");
  assert.ok(html.includes("not in 4a's catalogue right now"), "and say what happened to it");
});

test("THE SECOND RENDER SAYS WHAT THE FIRST SAID — liveness is the pool, not the snapshot cache", () => {
  /* THE MOST IMPORTANT TEST IN THIS FILE, and it exists because the first version
     of this fix worked exactly once per page session and then reverted to the
     defect #276 is about — found by review, not by these tests.

     `renderPlaylistDetail` seeds an archived part into `state.itemIndex` so it can
     be starred and reported. `resolveParts` originally asked `state.itemIndex` whether
     a part was live. Nothing clears that cache in a session, so on render two the
     part it had just seeded came back LIVE: the `gone` class went, the "not in
     4a right now" caption went, `partsNote` went, and the next-up marker moved
     onto a row that cannot be played. Reachable by opening a playlist, going back
     and opening it again — or by touching either drawer toggle, which calls route().

     MUTATION: revert liveness to `state.itemIndex[id]` in resolveParts (drop the
     `state.poolIds.has(id) &&`). THE FIRST RENDER STILL PASSES; every `second`
     assertion below fails. That asymmetry is the whole point of the test, so if
     you are checking it, check which half goes red.
     MUTATION 2: stop assigning `state.poolIds` in fullPool. Nothing is ever live
     and the live-row assertions fail. */
  const m = mount();
  const items = setPool(m, [poolItem(1), poolItem(2)]);
  m.ctx.fullPool();
  m.ctx.savePlaylists([{
    id: "q1", query: "physics", title: "Physics", items: items.map((it) => m.ctx.playlistPart(it)),
    created: "2026-08-18T00:00:00.000Z", last_played_at: null, sparse: false,
  }]);
  setPool(m, [poolItem(2)]);            // episode 1 rotated out; ep2 is still live
  const { first, second } = renderTwice(m, "q1");

  for (const [label, html] of [["first", first], ["second", second]]) {
    assert.strictEqual(rowCount(html), 2, `${label} render: both parts must be there`);
    assert.strictEqual(goneCount(html), 1, `${label} render: the archived part must stay marked`);
    assert.ok(html.includes("not in 4a's catalogue right now"), `${label} render: it must keep its caption`);
    assert.ok(html.includes("class=\"note\""), `${label} render: the shortfall must still be announced`);
    assert.deepStrictEqual(nextMarkers(html), ["2"], `${label} render: next belongs on the live part`);
    assert.strictEqual((html.match(/data-play="/g) || []).length, 1,
      `${label} render: only the live part may offer in-app playback`);
  }
  assert.strictEqual(first, second, "a re-render with nothing changed must be byte-identical");
});

test("a rotated-out part does not become live for a DIFFERENT playlist that also holds it", () => {
  /* The same cache pollution across two playlists rather than two renders: open
     playlist A holding the archived part, then playlist B holding the same id.
     B's first render is B's only render, so a per-render guard would not save it —
     only a liveness test that asks the pool.

     MUTATION: revert liveness to `state.itemIndex[id]`. B renders the part as a
     normal episode and this fails. */
  const m = mount();
  const items = setPool(m, [poolItem(1), poolItem(2)]);
  m.ctx.fullPool();
  const parts = items.map((it) => m.ctx.playlistPart(it));
  m.ctx.savePlaylists([
    { id: "qA", title: "A", items: parts, created: "2026-08-18T00:00:00.000Z" },
    { id: "qB", title: "B", items: [parts[1]], created: "2026-08-18T00:00:00.000Z" },
  ]);
  setPool(m, [poolItem(1)]);            // episode 2 rotated out of both
  m.ctx.renderPlaylistDetail("qA");
  assert.strictEqual(goneCount(m.view()), 1, "A must mark it");
  m.ctx.renderPlaylistDetail("qB");
  assert.strictEqual(goneCount(m.view()), 1, "and B must mark it too, on its first render");
  assert.ok(m.view().includes("not in 4a's catalogue right now"));
});

test("an archived pick never becomes the continue banner, and cannot degrade a live snapshot", () => {
  /* The other half of the same root cause. `bindPickLogging` writes
     `state.itemIndex[id]` into `cp_lastpick`, and `bannerHtml()` later re-runs
     `snapshot()` over it — so a PARTIAL archived snapshot stored there would
     overwrite the pool's full entry on a later page load where the episode is back,
     leaving a live episode with a play button that does nothing (`bindPlay` resolves
     through `state.itemIndex`). Banner-wise it would also offer to resume something
     the app cannot play.

     MUTATION: revert the guard to `const snap = state.itemIndex[id]`. cp_lastpick
     gains the archived part and the first assertion fails. */
  const m = mount();
  withArchivedPart(m);                  // ep2 archived, ep1 live, both rendered
  clickPick(m, { ep: "show-2--episode-2", ctx: "playlist-q1" });
  assert.strictEqual(m.store.get("cp_lastpick") ?? null, null,
    "an episode the catalogue no longer has must not become the continue banner");

  /* A live pick still does, unchanged — the guard must not cost the feature. */
  clickPick(m, { ep: "show-1--episode-1", ctx: "playlist-q1" });
  const last = JSON.parse(m.store.get("cp_lastpick"));
  assert.strictEqual(last.id, "show-1--episode-1");
  assert.strictEqual(last.audio_url, "https://audio.test/1/episode.mp3", "and it keeps its audio");
});

test("an archived part offers no in-app play button — the audio URL was deliberately not kept", () => {
  /* A copied enclosure URL that has moved gives a play button that fails. The
     row links out instead, which is the same degradation playBtn() already gives
     an item with no audio.

     MUTATION: render an archived part through epRow. `data-play` appears for it
     (or, with no audio_url, a bare `Play` link built from a snapshot that has no
     apple_episode_url) and this fails. */
  const m = mount();
  const html = withArchivedPart(m);
  const plays = (html.match(/data-play="/g) || []).length;
  assert.strictEqual(plays, 1, "only the live part may offer in-app playback");
  assert.ok(html.includes(`data-play="show-1--episode-1"`), "and it must be the live one");
  assert.ok(!html.includes(`data-play="show-2--episode-2"`));
  assert.ok(/Listen in your podcast app ↗<\/a>/.test(html), "the archived part must still be openable elsewhere");
});

test("a part with no snapshot behind it still holds its place, and links nowhere rather than to idundefined", () => {
  /* The legacy case: an id saved before this change whose episode had already
     left the pool. It cannot be named, so it says so — and it must NOT be
     dropped, because a count that agrees with nothing is the whole defect.

     MUTATION 1: drop stubs from resolveParts — the row count falls to 2.
     MUTATION 2: remove the `apple_collection_id` guard in archivedRow — the row
     links to `.../idundefined`, and this fails on that string.
     MUTATION 3: give the unnamed row a star (drop the `named ?` guard). toggleStar
     has no snapshot to store for it, so the control would sit there doing nothing
     at all — a silent no-op is worse than an absent button, and this fails. */
  const m = mount();
  const html = withArchivedPart(m, { extraStub: true });
  assert.strictEqual(rowCount(html), 3, "the unnameable part is still a part");
  assert.ok(html.includes("3 episodes"), "and the count must include it");
  assert.ok(html.includes("Part no longer in the catalogue"));
  assert.ok(!html.includes("idundefined"), "a part with no apple id must get no link at all");
  assert.ok(!html.includes(`data-star="long-gone--episode"`),
    "and no star either — there is no snapshot for toggleStar to store");
});

test("the page says what happened, once, and says nothing when nothing is missing", () => {
  /* An unannounced shortfall is what made this look like a playlist built wrong
     rather than one that aged out. The note is also the only place that tells a
     listener what they CAN do, so its absence is a real regression and not copy
     polish.

     MUTATION: delete `${partsNote(rows)}` from the template. This fails.
     MUTATION 2: emit it unconditionally. The all-live assertion fails.

     The note is asserted through `partsNote` output rather than by fishing for a
     substring in the page: the first draft looked for `1 part is not in 4a's
     catalogue` in the RENDERED html, where `esc()` has already turned the
     apostrophe into `&#39;`, so that disjunct could never match and the whole
     assertion was carried by `includes("not in 4a")` — which archivedRow's own
     caption satisfies. It passed with partsNote returning anything at all. */
  const m = mount();
  const withGaps = withArchivedPart(m, { extraStub: true });
  const notes = (withGaps.match(/class="note"/g) || []).length;
  assert.strictEqual(notes, 1, "one note, not one per missing part");
  const noteText = /<p class="note">([\s\S]*?)<\/p>/.exec(withGaps)[1];
  assert.match(noteText, /^1 part is not in 4a&#39;s catalogue right now/,
    `the note must open by naming the shortfall: ${noteText}`);
  assert.match(noteText, /1 part was saved before 4a kept episode details/,
    `and name the unnameable one too: ${noteText}`);
  assert.match(noteText, /home screen/, "and say what can be done about it");

  const m2 = mount();
  const items = setPool(m2, [poolItem(1), poolItem(2)]);
  m2.ctx.fullPool();
  m2.ctx.savePlaylists([{
    id: "q1", title: "T", items: items.map((it) => m2.ctx.playlistPart(it)),
    created: "2026-08-18T00:00:00.000Z", last_played_at: null, sparse: false,
  }]);
  m2.ctx.renderPlaylistDetail("q1");
  assert.strictEqual((m2.view().match(/class="note"/g) || []).length, 0,
    "a healthy playlist must not be told anything is wrong with it");
});

test("the new copy follows the repo's rules: no exclamation, no blame, an actual next step", () => {
  /* CLAUDE.md's copy conventions. Worth a test rather than a review note because
     the strings are generated in three plural branches, so a reviewer reads one
     of them and the listener with two missing parts reads another.

     MUTATION 1: write "you saved this before…" or add an exclamation mark.
     MUTATION 2: pluralise a noun without its verb — `${one ? "" : "s"}` on `part`
     while leaving `return` alone, which is exactly what the first draft did and
     shipped "if the episode return" to every listener with one gap. The
     verb-agreement assertions below are what catch it, and they are why this test
     exercises the SINGULAR branch as carefully as the plural one. */
  const m = mount();
  const rows = [
    { item: { id: "a", title: "A", show: "S" }, part: {}, state: "archived" },
    { item: { id: "b", title: "B", show: "S" }, part: {}, state: "archived" },
    { item: { id: "c" }, part: {}, state: "unnamed" },
    { item: { id: "d" }, part: {}, state: "unnamed" },
  ];
  const many = m.ctx.partsNote(rows);
  const single = m.ctx.partsNote([rows[1], rows[2]]);
  for (const note of [single, many]) {
    assert.ok(!note.includes("!"), `no exclamation marks: ${note}`);
    assert.ok(!/\byou (saved|built|did|chose)\b/i.test(note), `no blaming the listener: ${note}`);
  }
  assert.match(many, /2 parts are not/, `plural must agree: ${many}`);
  assert.match(single, /1 part is not/, `singular must agree: ${single}`);
  /* Verb agreement, both branches, because this is the one that shipped wrong. */
  assert.match(single, /1 part was saved before/, `singular verb: ${single}`);
  assert.match(single, /if the episode returns to the catalogue/, `singular verb: ${single}`);
  assert.match(many, /2 parts were saved before/, `plural verb: ${many}`);
  assert.match(many, /if the episodes return to the catalogue/, `plural verb: ${many}`);
  assert.ok(!/episode return\b/.test(single), `"the episode return" is not English: ${single}`);
  assert.match(many, /podcast app/, "an archived part must be given somewhere to go");
  /* And it must not promise something buildPlaylist does not do: rebuilding mints
     a NEW playlist and leaves this one alone, stubs included. */
  assert.ok(!/replaces/.test(many), `rebuilding does not replace this playlist: ${many}`);
  assert.match(many, /gives you a fresh one/, `say what rebuilding actually does: ${many}`);
});

test("an archived title is escaped, so a hostile feed cannot reach the page through a saved playlist", () => {
  /* The row is new markup on a new path, and app-security.test.js can only assert
     that `esc()` exists and that app.js interpolates through it in general.
     Storage is also a longer-lived injection vector than a fetch: this string was
     written weeks ago and is replayed on every visit.

     Every interpolation in the new row is covered, not just the two obvious ones:
     a mutation round found that dropping `esc()` from the href, from `data-ep` or
     from `data-ctx` all survived the first draft, because the only assertions were
     on title and show.

     MUTATION 1: interpolate `item.title` or `item.show` raw in archivedRow.
     MUTATION 2: drop `esc()` (or `safeUrl()`) from the row's `href`.
     MUTATION 3: drop `esc()` from `data-ep` or `data-ctx`. */
  const m = mount();
  const html = withArchivedPart(m, { over: { title: `<img src=x onerror="alert(1)">`, show: `"><script>alert(2)</script>` } });
  assert.ok(!html.includes("<img src=x"), "raw markup from a stored title reached the page");
  assert.ok(!html.includes("<script>alert(2)"), "raw markup from a stored show name reached the page");
  assert.ok(html.includes("&lt;img src=x"), "the title should be there, escaped");

  /* The href, `data-ep` and `data-ctx`. A stored `apple_collection_id` goes
     straight into the Apple URL, so it is an attribute-breakout vector even though
     it looks like a number, and the id reaches both `data-ep` and that URL. Only
     the archived part carries these values, so the whole page is the right scope —
     an `on…=` handler anywhere in it means one of them escaped. */
  const hostile = mount();
  const rowHtml = withArchivedPart(hostile, {
    over: { id: `ep" onmouseover="alert(3)`, apple_collection_id: `9" onfocus="alert(4)` },
  });
  /* The payload text survives either way — what must NOT survive is a RAW quote
     ending the attribute, so the check is for `onmouseover="` with a real `"`
     rather than for the words. `onmouseover=&quot;` is inert. */
  assert.ok(!/onmouseover="/.test(rowHtml), `the id broke out of an attribute: ${rowHtml}`);
  assert.ok(!/onfocus="/.test(rowHtml), `the collection id broke out of the href: ${rowHtml}`);
  assert.ok(rowHtml.includes("&quot; onmouseover=&quot;"), "the id should be there, escaped");
  assert.ok(rowHtml.includes("&quot; onfocus=&quot;"), "and so should the collection id");
  /* And the star, which is the attribute this found the hard way: it interpolated
     `data-star` raw, and a playlist part is the first STORED id to reach it. */
  assert.match(rowHtml, /data-star="ep&quot; onmouseover=&quot;alert\(3\)"/, "data-star must be escaped");

  /* NOT ASSERTED, and named so nobody writes a hollow test for it later: `safeUrl`
     on this row cannot currently refuse anything, because `playLink` always builds
     its own `https://` prefix, so no stored field can change the scheme. The
     `safeUrl()` call is defensive against a future playLink, and a test pretending
     to exercise it would pass with `safeUrl` deleted. */
});

test("an archived part keeps its star, and starring it makes it permanently recoverable", () => {
  /* Without the itemIndex seeding, starring an archived part is a silent no-op:
     toggleStar bails when `state.itemIndex` has no snapshot. And the star is not
     decoration here — `cp_saved` is the second place hydratePlaylistParts looks,
     so starring an aged-out part is the one action that guarantees it can always
     be named again. This test walks that whole loop: star it, throw the playlist
     back to legacy ids, and watch the migration recover it from the star.

     MUTATION 1: delete the itemIndex seeding loop in renderPlaylistDetail — the
     star is a no-op and this fails. MUTATION 2: drop `starBtn` from archivedRow —
     the control is unreachable, and the assertion on the rendered row fails, which
     is what stops the rest of this test from covering something a listener cannot
     do.

     A CLAIM THIS TEST USED TO MAKE AND DOES NOT: "make the loop overwrite live
     entries and the live part loses its audio_url". That mutation kills nothing,
     and cannot: the loop only touches rows `resolveParts` returned as `archived`,
     and an archived row's id is by construction absent from the live pool, so
     there is no live entry there to overwrite. The `!state.itemIndex[...]` guard is
     belt-and-braces against a future caller, not a live defence — said plainly
     rather than left as a mutation a reviewer would try and find dead. */
  const m = mount();
  const html = withArchivedPart(m);
  assert.ok(html.includes(`data-star="show-2--episode-2"`), "the archived row must offer the star");
  m.ctx.toggleStar("show-2--episode-2");
  const saved = JSON.parse(m.store.get("cp_saved"));
  assert.ok(saved["show-2--episode-2"], "starring an archived part did nothing");
  assert.strictEqual(saved["show-2--episode-2"].title, "Episode 2 of something");
  assert.deepStrictEqual(saved["show-2--episode-2"].topics, ["science/physics"]);

  /* The loop closing: the same id, back to a bare legacy entry, recovered. */
  m.store.set("cp_playlists", JSON.stringify([{
    id: "q2", title: "T", item_ids: ["show-2--episode-2"], created: "2026-08-18T00:00:00.000Z",
  }]));
  const [p] = m.ctx.playlists();
  assert.strictEqual(p.items[0].title, "Episode 2 of something", "the star should have rescued it");
});

test("opening an archived part still records the pick, so history and the played count do not go backwards", () => {
  /* Opening an aged-out part in another app is the same act as opening a live one.
     If the row stopped carrying `data-ev="picked"` it would leave `cp_history`,
     and this playlist's own played count and next-up marker would silently regress
     the moment an episode rotated out — the same class of defect as #276 itself.
     The topics it reports come from the seeded snapshot, which is the reachable
     justification for persisting `topics`.

     Two halves, asserted separately because the DOM stub cannot parse innerHTML:
     the MARKUP carries the right attributes, and the REAL bindPickLogging, driven
     with those attributes, does the four things that matter. The first draft
     hand-rolled a `logEvent` call and claimed it was the handler, which covered
     nothing — `touchPlaylistPlayed` in particular had no coverage at all.

     MUTATION 1: drop `data-ev="picked"` or `data-ep` from archivedRow's link. The
     markup assertion fails.
     MUTATION 2: drop `topics` from PLAYLIST_PART_FIELDS. The handler reports no
     topics and that assertion fails.
     MUTATION 3: delete the itemIndex seeding loop. Same — the handler has no
     snapshot to read topics from.
     MUTATION 4: remove the `touchPlaylistPlayed` call from bindPickLogging. The
     `last_played_at` assertion fails. */
  const m = mount();
  const html = withArchivedPart(m, { extraStub: true });
  assert.ok(/data-ev="picked" data-ep="show-2--episode-2" data-ctx="playlist-q1"/.test(html),
    "the archived row's link must be a logged pick");
  /* The unnameable part has no link, so it must log nothing at all. */
  assert.ok(!html.includes(`data-ep="long-gone--episode"`), "there is nothing to open, so nothing to log");

  clickPick(m, { ep: "show-2--episode-2", ctx: "playlist-q1" });

  const ev = m.eventLog.rows.filter((e) => e.type === "picked").pop();
  assert.ok(ev, "the real handler logged no picked event");
  assert.strictEqual(ev.payload.episode_id, "show-2--episode-2");
  assert.deepStrictEqual(ev.payload.topics, ["science/physics"],
    "the topics come from the seeded snapshot — this is what `topics` is persisted for");
  assert.deepStrictEqual(JSON.parse(m.store.get("cp_history")), ["show-2--episode-2"],
    "an archived part must still enter cp_history, or the played count regresses");
  assert.ok(m.playlistsRaw()[0].last_played_at, "and the playlist must be marked as played");
});

test("the 'next' marker never lands on a part that cannot be opened in the app", () => {
  /* The highlighted number means "start here". Putting it on a row with no
     playback is an instruction that cannot be followed.

     MUTATION: compute nextIdx over all rows instead of live ones. The marker
     moves onto the archived row and this fails. */
  const m = mount();
  const items = setPool(m, [poolItem(1), poolItem(2)]);
  m.ctx.fullPool();
  m.ctx.savePlaylists([{
    id: "q1", title: "T", items: items.map((it) => m.ctx.playlistPart(it)),
    created: "2026-08-18T00:00:00.000Z", last_played_at: null, sparse: false,
  }]);
  setPool(m, [poolItem(2)]);       // episode 1 — the FIRST part — has rotated out
  m.ctx.renderPlaylistDetail("q1");
  const html = m.view();
  const next = /<span class="q-num ([^"]*)">(\d+)<\/span>/g;
  const marked = [...html.matchAll(next)].filter(([, cls]) => cls.includes("next")).map(([, , n]) => n);
  assert.deepStrictEqual(marked, ["2"], "the marker belongs on the part that can actually play");
});

test("an archived part that was already played still counts as played", () => {
  /* `played` is read off the rows now rather than off the pool, so a part that
     left the catalogue after being played must not un-play itself.

     MUTATION: count only live rows as played. This fails. */
  const m = mount();
  m.ctx.lsSet("cp_history", ["show-2--episode-2"]);
  const html = withArchivedPart(m);
  assert.ok(html.includes("· 1 played"), `played count was wrong: ${/· \d+ played/.exec(html)}`);
});

/* ==================================================================== */
/* 4. MIGRATION — what a playlist saved BEFORE this change becomes       */
/* ==================================================================== */

const LEGACY = {
  id: "q-old", query: "give me a series about physics", title: "Physics",
  item_ids: ["show-1--episode-1", "starred--episode", "long-gone--episode", "show-3--episode-3"],
  created: "2026-07-01T00:00:00.000Z", last_played_at: null, sparse: false,
};

test("MIGRATION: an id the pool still has is snapshotted now, in place", () => {
  /* The recoverable half. A migration cannot invent fields that were never
     stored, so it takes what the live pool can still tell it.

     MUTATION: skip the pool lookup and leave every legacy id a stub. The title
     assertion fails, and every part becomes an unnameable row. */
  const m = mount({ seed: { cp_playlists: JSON.stringify([LEGACY]) } });
  setPool(m, [poolItem(1), poolItem(3)]);
  m.ctx.fullPool();
  const [p] = m.ctx.playlists();
  assert.strictEqual(p.items.length, 4, "no part may be lost by the migration");
  assert.strictEqual(p.items[0].title, "Episode 1 of something");
  assert.strictEqual(p.items[3].title, "Episode 3 of something");
  assert.deepStrictEqual(p.items.map((x) => x.id), LEGACY.item_ids, "order is the listener's, not ours");
});

test("MIGRATION: an id the pool lost but the listener STARRED is recovered from cp_saved", () => {
  /* `cp_saved` has held whole snapshots since stars shipped, so it is a second
     place a departed episode can still be named from. Free recovery, and it
     turns the listener's own signal into the thing that saves their playlist.

     MUTATION: drop the `|| saved[part.id]` fallback in hydratePlaylistParts. The
     starred part degrades to an unnameable row and this fails. */
  const m = mount({
    seed: {
      cp_playlists: JSON.stringify([LEGACY]),
      cp_saved: JSON.stringify({
        "starred--episode": {
          id: "starred--episode", title: "A starred episode", show: "Starred Show",
          duration_min: 61, apple_collection_id: 77, apple_track_id: 88,
          topics: ["science/physics"], audio_url: "https://audio.test/starred.mp3",
          artwork_url: "https://art.test/starred.jpg", saved_at: "2026-07-02T00:00:00.000Z",
        },
      }),
    },
  });
  setPool(m, [poolItem(1)]);
  m.ctx.fullPool();
  const [p] = m.ctx.playlists();
  assert.strictEqual(p.items[1].title, "A starred episode");
  assert.strictEqual(p.items[1].show, "Starred Show");
  /* Recovered through the SAME whitelist — a cp_saved snapshot carries audio_url
     and artwork_url, and the recovery must not smuggle them into 50 playlists. */
  assert.ok(!("audio_url" in p.items[1]), "recovery must go through playlistPart");
  assert.ok(!("saved_at" in p.items[1]));
});

test("MIGRATION: an id that cannot be named anywhere stays a stub, keeps its place, and is still counted", () => {
  /* The irrecoverable half, and the decision the issue asks for: it is KEPT, not
     dropped. It costs a row, it is honest about itself, and — unlike a deletion —
     it can still come back. A listener with saved playlists today ends up with
     more than they had, never less: before, five rows under a count of seven.

     MUTATION: `filter(Boolean)` the unresolvable ids away in
     hydratePlaylistParts. The length and the position assertions both fail. */
  const m = mount({ seed: { cp_playlists: JSON.stringify([LEGACY]) } });
  setPool(m, [poolItem(1), poolItem(3)]);
  m.ctx.fullPool();
  const [p] = m.ctx.playlists();
  /* Spread first: the stub was built inside the vm realm, so its prototype is not
     this realm's Object and deepStrictEqual compares prototypes. */
  assert.deepStrictEqual({ ...p.items[2] }, { id: "long-gone--episode" }, "the stub is the id, and only the id");
  assert.strictEqual(m.ctx.resolveParts(p).length, 4);
  assert.deepStrictEqual(p.item_ids, LEGACY.item_ids, "the mirror must still name every id");
});

test("MIGRATION: the result is written back, so it is paid for once", () => {
  /* MUTATION: return `false` from hydratePlaylistParts (or drop the
     `if (hydratePlaylistParts(p)) touched = true`). Storage keeps the legacy
     shape, every read re-migrates, and this fails. */
  const m = mount({ seed: { cp_playlists: JSON.stringify([LEGACY]) } });
  setPool(m, [poolItem(1), poolItem(3)]);
  m.ctx.fullPool();
  m.ctx.playlists();
  const [onDisk] = m.playlistsRaw();
  assert.ok(Array.isArray(onDisk.items), "the migration was never persisted");
  assert.strictEqual(onDisk.items[0].title, "Episode 1 of something");
});

test("MIGRATION: a fully snapshotted playlist is not rewritten on every read", () => {
  /* The fast path. `playlists()` is called from the drawer, from every render and
     from touchPlaylistPlayed, so a migration that always reports "changed" turns
     every read into a write of the whole store.

     MUTATION: set `changed = true` unconditionally in hydratePlaylistParts. This
     fails on the write count. */
  const m = mount();
  const items = setPool(m, [poolItem(1)]);
  m.ctx.fullPool();
  m.ctx.savePlaylists([{
    id: "q1", title: "T", items: items.map((it) => m.ctx.playlistPart(it)),
    created: "2026-08-18T00:00:00.000Z", last_played_at: null, sparse: false,
  }]);
  const before = m.writes.filter((k) => k === "cp_playlists").length;
  m.ctx.playlists();
  m.ctx.playlists();
  assert.strictEqual(m.writes.filter((k) => k === "cp_playlists").length, before,
    "a healthy playlist must be read without being rewritten");
});

test("MIGRATION IS SAFE WITH NO CATALOGUE — a stale service worker must not empty a playlist", () => {
  /* THE LANDMINE, and the reason the migration keeps stubs rather than deleting.
     `state.discover` is null on a partial deploy or a stale service-worker cache,
     and `playlists()` is reachable from the drawer before any of that has
     settled. A migration that deleted what it could not resolve would run once
     against an empty pool and write "this playlist is empty" down permanently.

     MUTATION: delete unresolvable ids in hydratePlaylistParts. Every id
     disappears here, and it is not recoverable afterwards. */
  const m = mount({ seed: { cp_playlists: JSON.stringify([LEGACY]) } });
  assert.strictEqual(m.state.discover, null, "this test is only meaningful with no pool");
  const [p] = m.ctx.playlists();
  assert.deepStrictEqual(p.items.map((x) => x.id), LEGACY.item_ids);
  assert.deepStrictEqual(m.playlistsRaw()[0].item_ids, LEGACY.item_ids);
  m.ctx.renderPlaylists();
  assert.ok(m.view().includes("4 parts"), "the count must survive a page with no catalogue");
});

test("HEALING: a stub upgrades itself the day the pool carries that episode again", () => {
  /* Which is what makes the answer above safe rather than merely non-destructive.
     The web pool rotates and the native slice changes with the shipped bundle, so
     an id coming back is a real event, not a hypothetical.

     MUTATION: run the pool lookup only on the `!hadItems` branch — i.e. migrate
     once and never retry. The upgrade never happens and this fails. */
  const m = mount({ seed: { cp_playlists: JSON.stringify([LEGACY]) } });
  const [before] = m.ctx.playlists();
  assert.deepStrictEqual({ ...before.items[0] }, { id: "show-1--episode-1" }, "starts as a stub");

  setPool(m, [poolItem(1)]);
  m.ctx.fullPool();
  const [after] = m.ctx.playlists();
  assert.strictEqual(after.items[0].title, "Episode 1 of something", "the stub never healed");
  assert.strictEqual(m.playlistsRaw()[0].items[0].title, "Episode 1 of something", "and it must be persisted");
  assert.deepStrictEqual({ ...after.items[2] }, { id: "long-gone--episode" }, "the others stay stubs");
});

test("A CORRUPT STORE COSTS ONE ROW, NOT THE WHOLE APP", () => {
  /* `playlists()` feeds the list, the detail view AND the drawer, so anything that
     throws out of it blanks all three — the permanent-blank failure the `item_ids`
     mirror exists to prevent, arriving through the mirror repair itself. Verified
     before the fix: `items: [null, …]` threw
     `TypeError: Cannot read properties of null (reading 'id')`.

     The second half is quieter and worse: a part with no `id` made the mirror
     disagree forever, so EVERY read rewrote the entire store.

     MUTATION 1: use `part.id` instead of `partId(part)` in the mirror comparison
     or in either `map`. This throws and fails.
     MUTATION 2: drop the `if (!Array.isArray(all)) return []` guard. `for…of` over
     an object throws.
     MUTATION 3: drop the non-object filter. `playlistById`'s `find` is the first of
     six iterations of this array to throw on the null, and it takes the detail view,
     the list and the drawer with it. */
  const m = mount();
  setPool(m, [poolItem(1)]);
  m.ctx.fullPool();

  /* A store holding something that is not a list at all. `lsGet` hands back
     whatever parsed, so without the guard `all.filter` throws and every view that
     calls playlists() goes blank. */
  m.store.set("cp_playlists", JSON.stringify({ q1: { id: "q1" } }));
  assert.deepStrictEqual([...m.ctx.playlists()], [], "a non-array store must read as empty, not throw");
  m.ctx.renderPlaylists();
  assert.ok(m.view().includes("No playlists yet"), "and the view must still render");

  m.store.set("cp_playlists", JSON.stringify([
    null,
    { id: "q1", title: "T", items: [null, { id: "show-1--episode-1", title: "Episode 1 of something" }] },
    { id: "q2", title: "U", items: [{ title: "no id at all" }] },
  ]));
  const all = m.ctx.playlists();
  /* The two real playlists survive; the `null` is discarded, because it is not a
     playlist and there is nothing in it to lose. */
  assert.strictEqual(all.length, 2, `the real playlists must survive: ${all.length}`);
  assert.deepStrictEqual(all.map((p) => p.id), ["q1", "q2"]);
  assert.strictEqual(m.playlistsRaw().length, 2, "and the cleaned store is persisted");
  /* The rows still render, and the corrupt part is an unnameable row rather than a
     crash — count and contents still agree, which is the invariant. */
  m.ctx.renderPlaylistDetail("q1");
  assert.strictEqual(rowCount(m.view()), 2);
  assert.ok(m.view().includes("2 episodes"));
  m.ctx.renderPlaylists();
  assert.ok(m.view().includes("2 parts") && m.view().includes("1 parts"));

  /* And the no-id row must be STABLE: read it repeatedly and the store is written
     once, not once per read. */
  const before = m.writes.filter((k) => k === "cp_playlists").length;
  m.ctx.playlists();
  m.ctx.playlists();
  m.ctx.playlists();
  assert.strictEqual(m.writes.filter((k) => k === "cp_playlists").length, before,
    "a corrupt row must not make every read rewrite the whole store");
});

test("a playlist the device refuses to store is reported, not navigated to", () => {
  /* `lsSet` has returned a boolean since #40 and `buildPlaylist` was discarding it,
     so a store at quota produced a playlist the home screen navigated to and the
     detail view rendered as "Playlist not found." — a dead end with no
     explanation. Reachable now that a full store is ~168 KB rather than ~33 KB.

     MUTATION: go back to ignoring savePlaylists' return value. `status` comes back
     `ok` and this fails. */
  const m = mount();
  const items = setPool(m, Array.from({ length: 12 }, (_, i) => poolItem(i + 1)));
  m.ctx.fullPool();
  m.state.semantic = { concepts: {} };
  m.state.itemTags = {};
  m.store.set("cp_playlists", JSON.stringify([]));
  const realSet = m.ctx.localStorage.setItem;
  m.ctx.localStorage.setItem = (k, v) => {
    if (k === "cp_playlists") { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; }
    return realSet.call(m.ctx.localStorage, k, v);
  };
  /* Drive the builder the way the form does, with a query the synthetic pool
     answers, and assert the refusal is surfaced rather than the playlist. */
  const result = m.ctx.buildPlaylist("physics");
  assert.strictEqual(result.status, "unsaved", `a refused write must be reported: ${result.status}`);
  assert.deepStrictEqual([...(result.suggestions || [])], [],
    "the home screen's else-branch reads suggestions, so it must be present");
  assert.ok(!result.playlist, "and there must be no playlist to navigate to");
  m.ctx.localStorage.setItem = realSet;
  assert.ok(items.length > 0);
});

test("one read parses cp_saved once, however many legacy playlists there are", () => {
  /* Post-#274 some legacy ids are permanently unresolvable, so the migration's slow
     path never stops running for those playlists — and `playlists()` is on the path
     for every drawer open, every list render and every pick. The pool build and the
     `cp_saved` parse are therefore hoisted to one per READ, not one per playlist.

     MUTATION 1: move `savedMap()`/`hydrationPool()` back inside
     hydratePlaylistParts. Reads go to 5 and this fails.
     MUTATION 2: build the sources eagerly in `playlists()` instead of lazily. The
     fully-hydrated case reads cp_saved when it should not, and the second half
     fails. */
  const m = mount();
  setPool(m, [poolItem(1)]);
  m.ctx.fullPool();
  const reads = [];
  const realGet = m.ctx.localStorage.getItem;
  m.ctx.localStorage.getItem = (k) => { reads.push(k); return realGet.call(m.ctx.localStorage, k); };

  m.store.set("cp_playlists", JSON.stringify(
    Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, title: `T${i}`, item_ids: ["long-gone--episode"] }))
  ));
  m.ctx.playlists();
  assert.strictEqual(reads.filter((k) => k === "cp_saved").length, 1,
    `five legacy playlists must cost one cp_saved parse, not five: ${reads.filter((k) => k === "cp_saved").length}`);

  /* And a fully-hydrated store must not consult it at all — that is the fast path. */
  reads.length = 0;
  m.ctx.savePlaylists([{
    id: "q9", title: "T", items: [m.ctx.playlistPart(poolItem(1))], created: "2026-08-18T00:00:00.000Z",
  }]);
  reads.length = 0;
  m.ctx.playlists();
  assert.strictEqual(reads.filter((k) => k === "cp_saved").length, 0,
    "a snapshotted playlist must not touch cp_saved");
  m.ctx.localStorage.getItem = realGet;
});

test("THE FIRST MIGRATION STILL WORKS: cp_quests becomes cp_playlists, with the title backfill", () => {
  /* Regression cover for the migration that was already there. The second one is
     bolted into the same loop, so a mistake there takes the first one out — and
     nothing else in the repo asserts the `cp_quests` path at all.

     MUTATION 1: drop the `cp_quests` read. The title and the parts vanish.
     MUTATION 2: drop the `prettyTitle` backfill. The title assertion fails. */
  const m = mount({
    seed: {
      cp_quests: JSON.stringify([{
        id: "q-ancient", query: "give me a series about fusion",
        item_ids: ["show-1--episode-1"], created: "2026-06-01T00:00:00.000Z",
      }]),
    },
  });
  setPool(m, [poolItem(1)]);
  m.ctx.fullPool();
  const [p] = m.ctx.playlists();
  assert.strictEqual(p.title, "Fusion", "the derived title is the first migration's job");
  assert.strictEqual(p.items[0].title, "Episode 1 of something", "and the second one runs on the same pass");
  assert.ok(m.store.has("cp_playlists"), "the new key must be written");
});

test("today's subject queue renders through the same one path as a saved playlist", () => {
  /* `subjectQueueById` is app.js:545 — the line the issue points at — and it hands
     renderPlaylistDetail the same shape. Nothing is persisted there, so its parts
     are always live; what this pins is that the two shapes did not diverge, which
     is how the detail view would grow a second, untested branch.

     MUTATION: drop `isSubject: true`. The queue grows a "remove this playlist"
     button for something that was never saved, and this fails.

     AND ONE MUTATION THAT DELIBERATELY SURVIVES, recorded because a reviewer will
     try it: reverting subjectQueueById to `item_ids` only changes nothing here.
     resolveParts falls back to `item_ids` when there is no `items`, and every id in
     a live queue is in the pool, so all of them resolve `live` and the render is
     identical. That fallback is the same one that keeps a pre-#276 playlist
     renderable, and it is asserted where it matters — the migration tests and the
     no-catalogue test. `items` is used here so the detail view has ONE branch, not
     because the other would break this page. */
  const m = mount();
  const items = setPool(m, [poolItem(1), poolItem(2)]);
  m.ctx.fullPool();
  m.state.cardSlots = [{ slot: 1, branch: "science", role: "top", item: items[0], items }];
  m.state.taxonomy = { nodes: [{ id: "science", parent: null, label: "Science" }] };
  m.ctx.renderPlaylistDetail("subject-science");
  const html = m.view();
  assert.strictEqual(rowCount(html), 2);
  assert.strictEqual(goneCount(html), 0, "a live queue has nothing archived in it");
  assert.ok(html.includes("today's queue"));
  assert.ok(!html.includes("remove this playlist"), "a subject queue is not removable");
});
