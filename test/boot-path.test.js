/* The boot path, round 2 of the 4a audit (lane L5, 2026-09-23).
 *
 * WHAT THIS SUITE PINS, one finding per section, each test naming the
 * mutation that turns it red:
 *
 *   perf-1    every boot document is on the wire before the player module and
 *             IndexedDB hydration have answered; the player graph is
 *             modulepreloaded from a list that cannot drift.
 *   races-4   a hydration that overruns its five-second bound no longer lets
 *             boot's own writes shadow the durable rows: interests, the
 *             profile id, the anonymous account, the dealt-cards memory.
 *   nav-9     ☰ and ↻ are disabled until the line that binds them.
 *   p-first-2 the page is ui-v2 from the first byte.
 *   perf-2    list-row artwork is asked for at the size it is drawn, lazily.
 *   perf-3    vocabulary priming waits for the listener to stop.
 *   perf-4    the service worker registers after the first page, not during it.
 *   perf-5    the brand faces are in every generation and preloaded.
 *
 * The service worker's own half of perf-4/5/6 is in test/sw-generation.test.js,
 * which evaluates the real sw.js.
 *
 * Harness: the REAL app.js in a node:vm over a small DOM (the same shape as
 * test/load-states.test.js's), serving data/*.json from disk, with the REAL
 * DurableStore over a swept localStorage and an IndexedDB tier whose read is
 * held until the test lets it go — the case the durable store exists for.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

process.on("unhandledRejection", () => {});

/* ---------- a small DOM ---------- */

/* The shared small DOM (audit round 3, tests-10): one copy, and a
   `[name="value"]` selector compares the value. */
const { El } = require("./helpers/fake-dom.js");

async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- storage: the real store over a swept localStorage ---------- */

function fakeLocal(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** An IndexedDB-shaped tier whose first read waits for `release()`. */
function heldIdb(seed = {}) {
  const data = new Map(Object.entries(seed));
  let release;
  const gate = new Promise((r) => { release = r; });
  return {
    name: "idb", sync: false, durable: true, data, release: () => release(),
    async readAll(prefix) {
      await gate;
      const out = new Map();
      for (const [k, v] of data) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async write(k, v) { data.set(k, String(v)); },
    async remove(k) { data.delete(k); },
  };
}

/* ---------- the mount ---------- */

/**
 * @param {object} [o]
 * @param {Function} [o.fetchImpl] (url, opts) -> Promise<Response-ish>; default:
 *   data/*.json from disk, Supabase answers 200 {}, anything else hangs.
 * @param {object|null} [o.store] a store to publish as window.forayStorage
 * @param {object|null} [o.eventLog] a queue to publish as window.forayEventLog
 * @param {number} [o.storageWaitMs] the hydration bound, shortened
 */
function mount({ fetchImpl = null, store = null, eventLog = null, storageWaitMs = null, hash = "#/", readyState = "complete", ceilingMs = null, holdTimer = null } = {}) {
  const docListeners = new Map();
  const body = new El("body");
  const view = new El("main"); view.id = "view"; body.appendChild(view);
  for (const id of ["drawer", "drawer-overlay", "drawer-playlists", "family-toggle", "player-toggle", "autoadvance-toggle"]) {
    const e = new El("div"); e.id = id; body.appendChild(e);
  }
  const menu = new El("button"); menu.id = "menu-btn"; body.appendChild(menu);
  const refresh = new El("button"); refresh.id = "refresh-btn"; body.appendChild(refresh);
  const fetched = [];
  const winListeners = new Map();
  const serve = (url) => {
    const rel = url.split("?")[0].replace(/^\.?\//, "");
    if (/supabase\.co/.test(url)) return Promise.resolve({ ok: true, status: 200, json: async () => ({ access_token: "at-new", refresh_token: "rt-new", user: { id: "uid-new" } }) });
    const file = path.join(ROOT, rel);
    if (!rel.startsWith("data/") || !fs.existsSync(file)) return new Promise(() => {});
    return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) });
  };
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url, opts) => { fetched.push(String(url)); return (fetchImpl || serve)(String(url), opts); },
    localStorage: store ? undefined : fakeLocal(),
    ...(store ? { forayStorage: store, forayStorageReady: store.hydrate() } : {}),
    ...(eventLog ? { forayEventLog: eventLog } : {}),
    document: {
      body, documentElement: body, readyState, hidden: false,
      addEventListener(t, fn) { if (!docListeners.has(t)) docListeners.set(t, []); docListeners.get(t).push(fn); },
      removeEventListener() {},
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
    location: { hash, search: "", pathname: "/", href: "https://x.test/", protocol: "https:", reload() {} },
    history: { replaceState() {}, pushState() {}, back() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, queueMicrotask,
    /* `holdTimer(fn, ms)` returning true keeps that timer for the test to fire
       itself (tests-11): a claim about WHICH timer is armed needs no wall clock. */
    setTimeout: (fn, ms) => { if (holdTimer && holdTimer(fn, ms)) return 0; const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    encodeURIComponent, decodeURIComponent,
    scrollY: 0, scrollTo() {},
  };
  if (!store) delete ctx.forayStorage;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  /* The bound is shortened IN THE SOURCE, not only after it runs: boot calls
     `waitForStorage()` synchronously while app.js executes, and with no store
     published its `setTimeout(finish, STORAGE_WAIT_MS)` is armed right then —
     at the real 5000 ms. Assigning afterwards reached only the later race in
     storageReady(), so the no-store cases (readyState "interactive") painted
     at 5 s, outside booted()'s 600 ticks: green on Windows, where 600 ticks
     happen to outlast 5 s, red on Linux CI (2026-09-24). */
  const appSrc = storageWaitMs == null ? APP_SRC : (() => {
    const decl = "let STORAGE_WAIT_MS = 5000;";
    assert.ok(APP_SRC.includes(decl), `app.js no longer declares \`${decl}\`; update mount()`);
    return APP_SRC.replace(decl, `let STORAGE_WAIT_MS = ${storageWaitMs};`);
  })();
  vm.runInContext(appSrc, ctx, { filename: "app.js" });
  if (storageWaitMs != null) vm.runInContext(`STORAGE_WAIT_MS = ${storageWaitMs};`, ctx);
  if (ceilingMs != null) vm.runInContext(`STORAGE_SETTLE_CEILING_MS = ${ceilingMs};`, ctx);
  const state = vm.runInContext("state", ctx);
  return {
    ctx, state, view, menu, refresh, fetched, winListeners,
    fireWin: (t) => { for (const fn of winListeners.get(t) || []) fn(); winListeners.set(t, []); },
    fireDoc: (t) => { ctx.document.readyState = "complete"; for (const fn of docListeners.get(t) || []) fn(); docListeners.set(t, []); },
    booted: async (max = 600) => {
      for (let i = 0; i < max && (/data-boot-loading/.test(view.innerHTML) || !state.ready); i++) await settle(1);
      await settle(5);
    },
  };
}

/** A queue in the shape player/event-log.js publishes. */
function fakeEventLog() {
  const rows = [];
  return {
    rows,
    append: (row) => { rows.push({ ...row, id: rows.length + 1 }); },
    unsynced: async () => rows.filter((r) => !r.synced),
    markSynced: async (ids) => { for (const r of rows) if (ids.includes(r.id)) r.synced = true; },
    pruneToRetention: async () => {},
  };
}

async function storeOver({ local = {}, idb = {} } = {}) {
  const { createDurableStore } = await import(pathToFileURL(path.join(ROOT, "player/durable-store.js")).href);
  const tier = heldIdb(idb);
  const ls = fakeLocal(local);
  const store = createDurableStore({ localStorage: ls, idbTier: tier });
  return { store, tier, ls };
}

/* ==================================================================== */
/* perf-1: the boot documents do not wait for the module or for storage */
/* ==================================================================== */

const BOOT_DOCS = [
  "data/session.json", "data/validated-links.json", "data/taxonomy.json", "data/discover.json",
  "data/forays.json", "data/segments.json", "data/segment-sources.json", "data/catalog-client.json",
];

test("perf-1: all eight boot documents are requested before storage hydration has answered", async () => {
  /* They used to wait for storageReady() — on the web, the whole player module
     graph plus IndexedDB — and the seven behind session.json as well.
     MUTATION: put `await storageP;` (or `await storageReady()`) back above the
     documents' Promise.all. Only session.json goes out and this goes red. */
  const { store } = await storeOver();
  const m = mount({ store, storageWaitMs: 60000 });
  await settle(3);
  for (const doc of BOOT_DOCS) {
    assert.ok(m.fetched.some((u) => u.includes(doc)), `${doc} waited for storage`);
  }
  assert.strictEqual(m.state.ready, false, "premise: hydration is still held, so the boot has not finished");
});

test("ROUND 2 review: generate-manifest runs as a script when reached through a symlink or junction, not a silent exit 0", async () => {
  /* The entry guard compared path.resolve(argv[1]) with import.meta.url, which
     Node realpaths and argv[1] is not: from a symlinked or junctioned checkout
     `--check` exited 0 without checking. MUTATION: put
     `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)` back
     inside isEntryScript -> red. */
  const os = require("node:os");
  const url = pathToFileURL(path.join(ROOT, "tools/ci/generate-manifest.mjs")).href;
  const { isEntryScript } = await import(url);
  const real = path.join(ROOT, "tools", "ci", "generate-manifest.mjs");
  assert.strictEqual(isEntryScript(real, url), true, "the plain path");
  assert.strictEqual(isEntryScript(path.join(ROOT, "tools", "ci", "boot-path-not-this.mjs"), url), false, "another file is not it");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-link-"));
  const link = path.join(dir, "ci");
  try {
    fs.symlinkSync(path.join(ROOT, "tools", "ci"), link, "junction");
    assert.strictEqual(isEntryScript(path.join(link, "generate-manifest.mjs"), url), true, "through a symlink or junction");
    if (process.platform === "win32") {
      const flipped = real[0] === real[0].toUpperCase() ? real[0].toLowerCase() + real.slice(1) : real[0].toUpperCase() + real.slice(1);
      assert.strictEqual(isEntryScript(flipped, url), true, "with the drive letter cased differently");
    }
  } finally {
    try { fs.unlinkSync(link); } catch (_) { try { fs.rmdirSync(link); } catch (_) { /* best effort */ } }
    try { fs.rmdirSync(dir); } catch (_) { /* best effort */ }
  }
});

test("perf-1: index.html modulepreloads exactly the player graph the manifest generator lists", async () => {
  /* Five import levels were five serial round trips before hydration could
     even start. MUTATION: add a player module (or delete a <link>) — the two
     lists differ and this goes red until index.html follows. */
  const { playerSources } = await import(pathToFileURL(path.join(ROOT, "tools/ci/generate-manifest.mjs")).href);
  const html = read("index.html");
  const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]).sort();
  const listed = playerSources().map((p) => p.split(path.sep).join("/")).sort();
  assert.deepStrictEqual(preloaded, listed);
  // And they are in the head, ahead of the stylesheet, where they start early.
  assert.ok(html.indexOf("modulepreload") < html.indexOf("</head>"));
});

/* ==================================================================== */
/* races-4: nothing boot writes can shadow a late hydration              */
/* ==================================================================== */

test("races-4: a hydration that overruns the bound does not let defaults overwrite the learned profile", async () => {
  /* localStorage swept, IndexedDB holding the listener's interests, and a read
     slower than the bound. The first play used to write every seeded default
     over the durable profile. MUTATION: make saveInterests write
     `{ ...base, ...state.interests }` again — the learned weight is replaced by
     the taxonomy default and this goes red. */
  const tax = JSON.parse(read("data/taxonomy.json"));
  const root = tax.nodes.find((n) => n.parent === null);
  const other = tax.nodes.find((n) => n.parent === null && n.id !== root.id);
  const { store, tier } = await storeOver({ idb: { cp_interests: JSON.stringify({ [root.id]: 0.05, [other.id]: 0.97 }) } });
  const m = mount({ store, storageWaitMs: 20 });
  await m.booted();
  assert.strictEqual(m.state.ready, true, "premise: the page painted at the bound");
  assert.strictEqual(m.state.interests[other.id], Math.max(0, other.weight), "premise: seeded from defaults");

  m.ctx.nudgeTopics([root.id], 0.1);   // the first play, before hydration lands
  tier.release();
  await store.hydrate();
  await settle(10);
  await store.flush();

  const saved = JSON.parse(store.getItem("cp_interests"));
  assert.strictEqual(saved[other.id], 0.97, "a weight this session never touched was overwritten by its default");
  assert.ok(Math.abs(saved[root.id] - (Math.max(0, root.weight) + 0.1)) < 1e-9 || saved[root.id] > 0.05,
    "the id this session DID move is written");
  assert.strictEqual(m.state.interests[other.id], 0.97, "and the late hydration re-seeds what this session did not move");
});

test("races-4: no profile id is minted and no account is signed up before hydration lands", async () => {
  /* logEvent minted cp_profile_id against an empty mirror and trySyncEvents
     signed up a NEW anonymous user; both then beat the durable copies.
     MUTATION: drop the `storageWaiting()` gate from logEvent (a fresh id) or
     from trySyncEvents (a signup request goes out). */
  const { store, tier } = await storeOver({
    idb: {
      cp_profile_id: JSON.stringify("p-durable"),
      cp_sb_session: JSON.stringify({ user_id: "uid-old", access_token: "at-old", refresh_token: "rt-old", expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    },
  });
  const log = fakeEventLog();
  // A row from yesterday, still unsent: a sync at boot has something to send.
  log.append({ ts: "2026-09-22T10:00:00Z", type: "picked", builder: "t", profile: "p-durable", payload: { episode_id: "e1" } });
  const m = mount({ store, eventLog: log, storageWaitMs: 20 });
  await m.booted();
  assert.strictEqual(m.state.ready, true);
  assert.ok(!m.fetched.some((u) => /auth\/v1\/signup/.test(u)), "a new account was created against an unread store");
  assert.strictEqual(log.rows.length, 1, "a row left the buffer before the profile could be read");

  tier.release();
  await store.hydrate();
  await settle(20);
  await store.flush();
  assert.strictEqual(JSON.parse(store.getItem("cp_profile_id")), "p-durable", "the durable profile id was shadowed");
  assert.ok(log.rows.length >= 2, "the buffered session row is delivered once storage settles");
  assert.ok(log.rows.every((r) => r.profile === "p-durable"), "and stamped with the durable id");
  assert.ok(!m.fetched.some((u) => /auth\/v1\/signup/.test(u)), "no signup after it either: the old account is reused");
  assert.strictEqual(JSON.parse(store.getItem("cp_sb_session")).user_id, "uid-old");
});

test("ROUND 2 review (races-4): a store that arrives AFTER the bound (a slow module, not a slow IndexedDB) still gates boot's writes until it hydrates", async () => {
  /* storageReady latched "settled" whenever the wait came back empty, the 5 s
     timeout included, so a module still downloading published its store into
     an open gate: logEvent minted a new cp_profile_id against the unhydrated
     store. MUTATION: `markStorageSettled(); return null;` for an empty wait
     again -> a new profile id shadows the durable one; red. */
  const { store, tier } = await storeOver({ idb: { cp_profile_id: JSON.stringify("p-durable") } });
  const log = fakeEventLog();
  const m = mount({ eventLog: log, storageWaitMs: 20, readyState: "interactive" });
  await m.booted();
  assert.strictEqual(m.state.ready, true, "premise: the page painted at the bound, with no store yet");
  assert.strictEqual(m.ctx.storageWaiting(), true, "the module is still loading: the store is late, not absent");

  m.ctx.forayStorage = store;          // the module lands and publishes its store...
  m.fireWin("forayplayer:ready");
  m.ctx.logEvent("picked", { episode_id: "e1" });   // ...and the listener does something before it hydrates
  assert.strictEqual(m.ctx.storageWaiting(), true, "the gate is shut while it hydrates");

  tier.release();
  await store.hydrate();
  await settle(20);
  await store.flush();
  assert.strictEqual(JSON.parse(store.getItem("cp_profile_id")), "p-durable", "the durable profile id was not shadowed");
  assert.ok(log.rows.length >= 1 && log.rows.every((r) => r.profile === "p-durable"), "the buffered row carries the durable id");
});

test("ROUND 2 review (races-4): with the modules run and no store published, the gate opens (nothing is coming)", async () => {
  const m = mount({ storageWaitMs: 20, readyState: "interactive" });
  await m.booted();
  assert.strictEqual(m.ctx.storageWaiting(), true, "premise: still parsing, the store may yet come");
  m.fireDoc("DOMContentLoaded");
  await settle(3);
  assert.strictEqual(m.ctx.storageWaiting(), false, "DOMContentLoaded with no store: plain localStorage, as always");
});

test("ROUND 2 review (races-4): a hydration that NEVER finishes is bounded, and nudges before it share one waiter", async () => {
  /* Nothing bounded the settle: a hung IndexedDB held every waiter for the
     session, so interests, the seen list and events were lost at page close,
     and each nudge pushed one more closure. MUTATIONS: drop
     armStorageSettleCeiling from settleOnHydrate -> the gate never opens; red.
     Push `saveInterests` per call again -> the waiter count grows; red. */
  const { store } = await storeOver({ idb: { cp_seen: JSON.stringify(["x"]) } });   // never released
  /* NO WALL CLOCK (audit round 3, tests-11). This waited out a real 4000 ms
     ceiling on every run, and a short one races the premise asserts below on a
     slow runner (booted() alone can outlast it). The claim is that the ceiling
     is ARMED and that firing it opens the gate, so the timer armed with the
     ceiling's (unique) delay is held, counted, and fired by the test. */
  const CEILING = 7_654_321;
  const held = [];
  const m = mount({ store, storageWaitMs: 20, ceilingMs: CEILING, holdTimer: (fn, ms) => (ms === CEILING ? (held.push(fn), true) : false) });
  await m.booted();
  const tax = JSON.parse(read("data/taxonomy.json"));
  const root = tax.nodes.find((n) => n.parent === null);
  const before = vm.runInContext("storageSettleWaiters.length", m.ctx);
  for (let i = 0; i < 5; i++) m.ctx.nudgeTopics([root.id], 0.05);
  const after = vm.runInContext("storageSettleWaiters.length", m.ctx);
  assert.ok(after - before <= 1, `five nudges queued ${after - before} waiters`);
  assert.strictEqual(m.ctx.storageWaiting(), true, "premise: still hydrating");
  assert.strictEqual(held.length, 1, "the settle ceiling was armed once");
  held[0]();
  await settle(5);
  assert.strictEqual(m.ctx.storageWaiting(), false, "the ceiling opened the gate");
  const saved = JSON.parse(store.getItem("cp_interests") || "null");
  assert.ok(saved && typeof saved[root.id] === "number", "the interests reached the store's sync tier");
});

test("races-4: saveInterests replaces a stored weight only for an id this session set", () => {
  /* The belt under the wait above: whatever state.interests holds for an id
     nobody moved (a seeded default, a stale copy), it fills a gap in the stored
     profile and never overwrites a weight there. MUTATION: write
     `{ ...base, ...state.interests }` again. */
  const m = mount({ fetchImpl: () => new Promise(() => {}) });
  m.state.taxonomy = { nodes: [{ id: "a", parent: null, weight: 0.5 }, { id: "b", parent: null, weight: 0.5 }, { id: "c", parent: null, weight: 0.5 }] };
  m.ctx.localStorage.setItem("cp_interests", JSON.stringify({ a: 0.97, b: 0.02 }));
  m.state.interests = { a: 0.5, b: 0.5, c: 0.5 };   // seeded, untouched
  m.ctx.setInterest("b", 0.3);                       // the one this session moved
  m.ctx.saveInterests();
  assert.deepStrictEqual(JSON.parse(m.ctx.localStorage.getItem("cp_interests")), { a: 0.97, b: 0.3, c: 0.5 });
});

test("races-4: the dealt-cards memory is written after hydration, onto the durable list", async () => {
  /* buildCards wrote cp_seen from an empty mirror, and the seen window started
     over. MUTATION: write cp_seen directly in buildCards again. */
  const { store, tier } = await storeOver({ idb: { cp_seen: JSON.stringify(["ep-old-1", "ep-old-2"]) } });
  const m = mount({ store, storageWaitMs: 20 });
  await m.booted();
  tier.release();
  await store.hydrate();
  await settle(10);
  const seen = JSON.parse(store.getItem("cp_seen"));
  assert.ok(seen.includes("ep-old-1") && seen.includes("ep-old-2"), "the durable seen list was replaced");
  assert.ok(seen.length > 2, "and this session's deal is appended to it");
});

/* ==================================================================== */
/* nav-9: ☰ and ↻ are disabled until they are bound                    */
/* ==================================================================== */

test("nav-9: ☰ and ↻ are disabled while the boot is loading and enabled with their listeners", async () => {
  /* MUTATION: drop setBootChrome(false) — the buttons are live-looking and
     dead; or drop setBootChrome(true) — they never come back. */
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = mount({
    fetchImpl: (url) => {
      const rel = url.split("?")[0];
      if (!rel.startsWith("data/")) return new Promise(() => {});
      return gate.then(() => ({ ok: true, status: 200, json: async () => JSON.parse(read(rel)) }));
    },
  });
  await settle(3);
  assert.strictEqual(m.menu.disabled, true, "☰ looks tappable while it does nothing");
  assert.strictEqual(m.refresh.disabled, true, "↻ looks tappable while it does nothing");
  assert.strictEqual(m.menu.listeners("click"), 0, "premise: nothing is bound yet");
  release();
  await m.booted();
  assert.strictEqual(m.menu.disabled, false);
  assert.strictEqual(m.refresh.disabled, false);
  assert.ok(m.menu.listeners("click") > 0 && m.refresh.listeners("click") > 0);
});

test("nav-9: a failed boot leaves them disabled, with the page's Try again as the way forward", async () => {
  const m = mount({ fetchImpl: () => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }) });
  await settle(20);
  assert.match(m.view.innerHTML, /Couldn't load 4a/);
  assert.strictEqual(m.menu.disabled, true);
  assert.ok(m.view.querySelector("[data-retry]"), "the failed page has its own Try again");
});

test("nav-9: the disabled buttons are dimmed", () => {
  assert.match(read("styles.css"), /\.topbar button:disabled \{[^}]*opacity/);
});

/* ==================================================================== */
/* p-first-2: ui-v2 from the first byte                                  */
/* ==================================================================== */

test("p-first-2: index.html ships <body class=\"ui-v2\"> and the boot screen is painted under it", async () => {
  /* The v1 light tokens answered until the first route. MUTATION: remove the
     class from index.html (first assertion) or the belt in init() (second). */
  assert.match(read("index.html"), /<body class="ui-v2">/);
  const m = mount({ fetchImpl: () => new Promise(() => {}) });
  assert.match(m.view.innerHTML, /data-boot-loading/, "premise: the boot screen is up");
  assert.ok(m.ctx.document.body.classList.contains("ui-v2"), "the boot screen is painted without ui-v2");
});

/* ==================================================================== */
/* perf-2: row artwork at its drawn size                                  */
/* ==================================================================== */

test("perf-2: a list row asks Apple's CDN for a small image, lazily, with its box reserved", () => {
  /* MUTATION: return `u` unchanged from artUrl, or drop loading="lazy" from rowArtImg. */
  const m = mount({ fetchImpl: () => new Promise(() => {}) });
  const big = "https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/3d/mza_1.jpg/600x600bb.jpg";
  const html = m.ctx.rowArtImg(big);
  assert.match(html, /\/132x132bb\.jpg"/, "a 44 px row fetched the 600 px image");
  assert.match(html, /loading="lazy"/);
  assert.match(html, /decoding="async"/);
  assert.match(html, /width="44" height="44"/);
  const other = "https://example.com/art/600x600bb.jpg";
  assert.strictEqual(m.ctx.artUrl(other, 132), other, "a host whose sizes we do not know is left alone");
  // The two row builders use it; nothing builds a row image by hand any more.
  assert.strictEqual((APP_SRC.match(/<img class="show-result-art"/g) || []).length, 1, "one row-image builder");
});

test("perf-2 (sweep): EVERY image app.js draws below hero size asks for its drawn size — Home's 56 px card too", () => {
  /* The lane fixed the two row builders; the finding also named miniCard, which
     still fetched and decoded the 600 px original for a 56 px box on every Home
     paint. The rule is promoted here from "the row builder" to "every <img> in
     app.js": each one goes through artUrl, or is one of the two heroes whose art
     IS the page (the show page's and the episode page's, drawn up to ~220-390 px).
     MUTATION: put miniCard back to `safeUrl(item.artwork_url)` -> red, naming it. */
  const HERO = new Set(["show-art", "ep-art"]);
  const imgs = [...APP_SRC.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(imgs.length >= 4, `fixture assumption: app.js draws its images from templates (${imgs.length})`);
  const unsized = imgs.filter((tag) => {
    const cls = (/class="([^"]+)"/.exec(tag) || [])[1] || "";
    if (cls.split(/\s+/).some((c) => HERO.has(c))) return false;
    return !/artUrl\(/.test(tag);
  });
  assert.deepStrictEqual(unsized, [], "an image drawn small fetches Apple's 600 px original");
  const m = mount({ fetchImpl: () => new Promise(() => {}) });
  const ep = { id: "e1", title: "T", show: "S", artwork_url: "https://is1-ssl.mzstatic.com/image/thumb/P/v4/mza_1.jpg/600x600bb.jpg", duration_min: 30 };
  const card = m.ctx.miniCard({ branch: "science", role: "core", item: ep, items: [ep] });
  assert.match(card, /\/168x168bb\.jpg"/, "Home's card fetched the 600 px image for a 56 px box");
  assert.match(card, /decoding="async" width="56" height="56"/);
});

test("ROUND 2 review (perf-2): an <img> whose width/height attributes CSS resizes by width also frees its height", () => {
  /* The attributes become CSS width and height. `.ep-art` overrode the width
     (min(100%, 68vmin)) and left the 600px height, so with both definite its
     aspect-ratio was ignored and a phone drew the art ~265 x 600. MUTATION:
     drop `height: auto` from `.ep-art` -> red, naming it. */
  const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, " ");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: m[1].split(",").map((x) => x.trim()), body: m[2] }));
  const bad = [];
  for (const tag of APP_SRC.match(/<img\b[^>]*>/g) || []) {
    if (!/\bheight="\d+"/.test(tag)) continue;
    for (const cls of ((/class="([^"]+)"/.exec(tag) || [])[1] || "").split(/\s+/).filter(Boolean)) {
      const mine = rules.filter((r) => r.sels.some((sel) => new RegExp(`\\.${cls}(?![\\w-])(?!.*[ >+~])`).test(sel) && !/:hover|:focus/.test(sel)));
      const sets = (prop) => mine.some((r) => new RegExp(`(^|;)\\s*${prop}\\s*:`).test(r.body));
      if (sets("width") && !sets("height")) bad.push(cls);
    }
  }
  assert.deepStrictEqual(bad, [], "an image whose CSS width overrides its attribute keeps the attribute's height");
});

/* ==================================================================== */
/* perf-3: priming waits for a still listener                             */
/* ==================================================================== */

test("perf-3: whenQuiet runs nothing while the listener keeps touching the page", (t) => {
  /* MUTATION: make whenQuiet call whenIdle at once, or drop the re-check.
     THE CLOCK IS DRIVEN, NOT SLEPT (audit round 3, tests-2): this slept 25/25/60
     ms of wall clock, and a ~45 ms stall of a loaded runner let the final sleep
     resolve before the re-armed check's fn, turning unrelated PRs red. The
     mount's setTimeout forwards to the (mocked) global, and ctx.Date is the
     mocked Date, so app.js's own timers and Date.now() run on this clock. */
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const m = mount({ fetchImpl: () => new Promise(() => {}) });
  let ran = 0;
  m.ctx.whenQuiet(() => { ran += 1; }, 40);
  t.mock.timers.tick(25);
  m.ctx.noteInteraction();
  t.mock.timers.tick(25);
  assert.strictEqual(ran, 0, "it ran 50 ms in, 25 ms after a tap");
  t.mock.timers.tick(14);
  assert.strictEqual(ran, 0, "39 ms after the tap is not yet 40 ms of stillness");
  t.mock.timers.tick(2);
  t.mock.timers.tick(1);
  assert.strictEqual(ran, 1, "and it runs once the listener has been still");
  t.mock.timers.tick(500);
  assert.strictEqual(ran, 1, "once");
});

test("perf-3: init() primes the vocabulary through whenQuiet, and taps are what it listens for", () => {
  const init = /async function init\(\) \{[\s\S]*?\n\}\n/.exec(APP_SRC)[0];
  assert.match(init, /loadSearchData\(\)\.then\(\(\) => whenQuiet\(primeSearchVocab\)\)/);
  assert.ok(!/setTimeout\(primeSearchVocab, 0\)/.test(init), "the 0 ms fallback is back");
  for (const t of ["pointerdown", "keydown", "scroll"]) assert.ok(init.includes(`"${t}"`), `${t} is not noted`);
});

/* ==================================================================== */
/* perf-4: the worker registers after the first page                      */
/* ==================================================================== */

test("perf-4: the service worker is registered only once the first page is on screen", () => {
  /* A source check: the harness has no service worker to register with.
     MUTATION: call navigator.serviceWorker.register at script end again. */
  assert.ok(/firstPagePainted\.then\(\(\) => whenIdle\(\(\) => \{\s*navigator\.serviceWorker\.register/.test(APP_SRC),
    "registration is not behind the first page");
  assert.strictEqual((APP_SRC.match(/serviceWorker\.register\(/g) || []).length, 1, "one registration");
  // The promise it waits on is resolved by init's first route and by the failed boot.
  const init = /async function init\(\) \{[\s\S]*?\n\}\n/.exec(APP_SRC)[0];
  assert.strictEqual((init.match(/markFirstPagePainted\(\)/g) || []).length, 2);
});

/* ==================================================================== */
/* perf-5: the brand faces ship in every generation                       */
/* ==================================================================== */

test("perf-5: every face styles.css loads is listed in the deploy manifest and copied to the web dist", async () => {
  /* MUTATION: drop fontSources() from listedFiles (the manifest half) or from
     prepare-dist's copy loop (the dist half — the Vercel deploy 404'd them). */
  const { listedFiles } = await import(pathToFileURL(path.join(ROOT, "tools/ci/generate-manifest.mjs")).href);
  const listed = listedFiles().map((p) => p.split(path.sep).join("/"));
  const faces = [...read("styles.css").matchAll(/url\("(fonts\/[^"]+\.woff2)"\)/g)].map((m) => m[1]);
  assert.ok(faces.length >= 3, "premise: the three faces");
  for (const f of faces) assert.ok(listed.includes(f), `${f} is in no generation`);
  assert.match(read("tools/web/prepare-dist.mjs"), /\.\.\.fontSources\(\)/);
});

test("perf-5: the CRLF guard knows the faces are binary, so listing them does not block every manifest run", async () => {
  /* Two of the three faces carry `
` byte pairs. Listed without being
     classified, `generate-manifest.mjs --check` refused to run anywhere.
     MUTATION: drop a face from BINARY_LISTED — its bytes are reported as a CRLF
     checkout and this goes red. */
  const { fontSources } = await import(pathToFileURL(path.join(ROOT, "tools/ci/generate-manifest.mjs")).href);
  const { crlfOffenders, BINARY_LISTED } = await import(pathToFileURL(path.join(ROOT, "tools/ci/crlf-guard.mjs")).href);
  const faces = fontSources();
  assert.ok(faces.length >= 3);
  for (const f of faces) assert.ok(BINARY_LISTED.has(f.split(path.sep).join("/")), `${f} is not classified binary`);
  assert.deepStrictEqual(crlfOffenders(ROOT, faces), []);
});

test("perf-5: the two roman faces are preloaded, same-origin, as fonts", () => {
  const html = read("index.html");
  for (const f of ["fonts/fraunces-variable.woff2", "fonts/dm-sans-variable.woff2"]) {
    assert.ok(html.includes(`<link rel="preload" href="${f}" as="font" type="font/woff2" crossorigin>`), `${f} is not preloaded`);
  }
});

/* ==================================================================== */
/* tests-10: the shared small DOM compares attribute values               */
/* ==================================================================== */

test("tests-10: [name=\"value\"] matches only the element with that value, in both harnesses' shared DOM", () => {
  /* boot-path and load-states each had a copy whose `[data-x="id"]` threw the
     value away, so a lookup by value got the first element carrying the
     attribute. MUTATION: in test/helpers/fake-dom.js make the valued branch
     `name in el.attrs` again -> the lookup for "b" answers "a"; red. Put an
     inline El back in either suite -> the second assertion group is red. */
  const { El } = require("./helpers/fake-dom.js");
  const root = new El("div");
  root.innerHTML = '<ul><li><button data-star="a" class="star">A</button></li><li><button data-star="b.c #d" class="star on">B</button></li></ul>';
  const [a, b] = root.querySelectorAll("[data-star]");
  assert.ok(a && b, "premise: two stars");
  assert.strictEqual(root.querySelector('[data-star="b.c #d"]'), b, "a value holding . # and a space is one token");
  assert.strictEqual(root.querySelector("[data-star='a']"), a);
  assert.strictEqual(root.querySelector('button.on[data-star="b.c #d"]'), b);
  assert.strictEqual(root.querySelector('[data-star="zzz"]'), null, "a value no element has matches nothing");
  assert.strictEqual(root.querySelectorAll('ul [data-star="a"]').length, 1);
  assert.throws(() => root.querySelector("[data-star^=a]"), /not supported/, "an operator it does not know throws instead of matching nothing");
  for (const f of ["boot-path.test.js", "load-states.test.js"]) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    assert.ok(!/\bclass El\b/.test(src), `${f} carries its own El again`);
    assert.ok(src.includes('require("./helpers/fake-dom.js")'), `${f} does not use the shared DOM`);
  }
});

/* ==================================================================== */
/* app-1-2: syncs asked for before storage settles share one waiter       */
/* ==================================================================== */

test("app-1-2: five syncs asked for while storage is settling queue ONE waiter, and it runs one sync", async () => {
  /* Each call pushed its own afterStorageSettles closure and markStorageSettled
     ran them all at once: N syncs POSTing the same rows. MUTATION: push a
     waiter per call again -> the count grows by five; red. */
  const { store, tier } = await storeOver({
    idb: { cp_sb_session: JSON.stringify({ user_id: "uid-old", access_token: "at-old", refresh_token: "rt-old", expires_at: Math.floor(Date.now() / 1000) + 3600 }) },
  });
  const log = fakeEventLog();
  log.append({ ts: "2026-09-22T10:00:00Z", type: "picked", builder: "t", profile: "p", payload: { episode_id: "e1" } });
  const posts = [];
  const m = mount({
    store, eventLog: log, storageWaitMs: 20, ceilingMs: 60000,
    fetchImpl: (url, opts) => {
      if (/rest\/v1\/events/.test(url)) { posts.push(opts.body); return Promise.resolve({ ok: true, status: 201, json: async () => ({}) }); }
      if (/supabase\.co/.test(url)) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      return new Promise(() => {});
    },
  });
  await settle(20);
  assert.strictEqual(m.ctx.storageWaiting(), true, "premise: still hydrating");
  const before = vm.runInContext("storageSettleWaiters.length", m.ctx);
  const calls = [];
  for (let i = 0; i < 5; i++) calls.push(m.ctx.trySyncEvents());
  const after = vm.runInContext("storageSettleWaiters.length", m.ctx);
  assert.ok(after - before <= 1, `five syncs queued ${after - before} waiters`);
  tier.release();
  await store.hydrate();
  await Promise.all(calls);
  await settle(10);
  assert.strictEqual(posts.length, 1, `the row went out ${posts.length} times`);
});

/* ==================================================================== */
/* app-1-1: the listener's own actions before hydration lands             */
/* ==================================================================== */

test("app-1-1: a star, an Up Next add, a play and a follow before a slow hydration land ON the durable rows, not over them", async () => {
  /* localStorage swept, IndexedDB holding the listener's library, hydration
     slower than the five-second bound. toggleStar read {} and wrote {b}, and
     property 2 kept that over the durable {a} for good; the same for Up Next,
     History and Followed. MUTATION: make toggleStar (or saveQueueIds, or
     recordHistory, or toggleShowStar) lsSet its read-modify-write directly
     again -> the durable row is gone after hydration; red. */
  const snapA = { id: "a", title: "A", show: "S", audio_url: "https://x.test/a.mp3", topics: [] };
  const { store, tier } = await storeOver({
    idb: {
      cp_saved: JSON.stringify({ a: snapA }),
      cp_queue: JSON.stringify(["q-durable"]),
      cp_history: JSON.stringify(["h-durable"]),
      cp_starred_shows: JSON.stringify({ "show-durable": { show_id: "show-durable", title: "D" } }),
      cp_episode_snaps: JSON.stringify({ "q-durable": { id: "q-durable", audio_url: "https://x.test/q.mp3" } }),
    },
  });
  const m = mount({ store, storageWaitMs: 20, ceilingMs: 60000 });
  await m.booted();
  assert.strictEqual(m.ctx.storageWaiting(), true, "premise: the page painted and hydration has not landed");
  m.state.itemIndex.b = { id: "b", title: "B", show: "S", audio_url: "https://x.test/b.mp3", topics: [] };
  m.ctx.toggleStar("b");
  assert.strictEqual(m.ctx.isSaved("b"), true, "the star paints at once, from the overlay");
  m.ctx.addToQueue("b");
  assert.ok(m.ctx.queueIds().includes("b"), "Up Next shows the add at once");
  m.ctx.recordHistory("b");
  const show = m.state.catalog && m.state.catalog.shows && m.state.catalog.shows[0];
  assert.ok(show, "premise: the catalogue is loaded");
  m.ctx.toggleShowStar(show.show_id);

  tier.release();
  await store.hydrate();
  await settle(20);
  await store.flush();
  const saved = JSON.parse(store.getItem("cp_saved"));
  assert.ok(saved.a && saved.b, `Saved after hydration: ${Object.keys(saved)}`);
  const queue = JSON.parse(store.getItem("cp_queue"));
  assert.ok(queue.includes("q-durable") && queue.includes("b"), `Up Next after hydration: ${queue}`);
  const history = JSON.parse(store.getItem("cp_history"));
  assert.ok(history.includes("h-durable") && history[history.length - 1] === "b", `History after hydration: ${history}`);
  const snaps = JSON.parse(store.getItem("cp_episode_snaps"));
  assert.ok(snaps["q-durable"] && snaps.b, `snapshots after hydration: ${Object.keys(snaps)}`);
  const followed = JSON.parse(store.getItem("cp_starred_shows"));
  assert.ok(followed["show-durable"] && followed[show.show_id], `Followed after hydration: ${Object.keys(followed)}`);
  assert.strictEqual(m.ctx.isSaved("a"), true, "the durable star reads back");
});

test("app-1-1: an un-star before hydration removes the durable row it names, and only that one", async () => {
  /* MUTATION: resolve the toggle against the stored value at settle time
     (flip, not the intent the tap painted) -> the tapped row survives; red. */
  const { store, tier } = await storeOver({ idb: { cp_saved: JSON.stringify({ a: { id: "a" }, c: { id: "c" } }) } });
  const m = mount({ store, storageWaitMs: 20, ceilingMs: 60000 });
  await m.booted();
  m.state.itemIndex.c = { id: "c", title: "C", audio_url: "https://x.test/c.mp3", topics: [] };
  m.ctx.toggleStar("c");            // unhydrated: not saved yet as far as the page knows -> a star
  m.ctx.toggleStar("c");            // and off again
  assert.strictEqual(m.ctx.isSaved("c"), false);
  tier.release();
  await store.hydrate();
  await settle(20);
  const saved = JSON.parse(store.getItem("cp_saved"));
  assert.deepStrictEqual(Object.keys(saved).sort(), ["a"], "star-then-unstar of c removes c and keeps a");
});

test("app-1-1: no first-run sheet is offered while the store has not answered; it is decided once it has", async () => {
  /* isGenuineFirstTimeUser read an unhydrated cp_history/cp_saved and a
     returning listener got the Welcome sheet. MUTATION: drop the
     storageWaiting() return from offerHomeOnboarding -> the sheet opens over a
     returning listener's Home; red. */
  const { store, tier } = await storeOver({ idb: { cp_history: JSON.stringify(["h1", "h2"]), cp_intro_dismissed: "true" } });
  const m = mount({ store, storageWaitMs: 20, ceilingMs: 60000 });
  await m.booted();
  assert.strictEqual(m.ctx.storageWaiting(), true, "premise");
  const sheetUp = () => Boolean(m.ctx.document.querySelector("#first-time-sheet"));
  assert.strictEqual(m.ctx.isGenuineFirstTimeUser(), true, "premise: unhydrated, the listener looks new");
  assert.ok(!sheetUp(), "the first-run sheet opened before the store answered");
  tier.release();
  await store.hydrate();
  await settle(20);
  assert.strictEqual(m.ctx.isGenuineFirstTimeUser(), false);
  assert.ok(!sheetUp(), "a returning listener got the first-run sheet");
});

/* ==================================================================== */
/* app-1-7: a re-deal before storage settles records only the new deal    */
/* ==================================================================== */

test("app-1-7: 'Show my picks' before storage settles keeps the durable deal memory and records only the re-deal", async () => {
  /* The undo ran against a deal whose recorder had not run yet (it cut the
     PREVIOUS session's entries), and then both recorders fired, so the
     pre-pick deal was counted as seen after all. MUTATION: drop the
     `epoch !== dealEpoch` stand-down -> deal 1's branches are recorded; red.
     Drop the `lastDealRecorded` guard -> the undo runs early; red on the
     durable entries. */
  const { store, tier } = await storeOver({ idb: { cp_recent_branches: JSON.stringify(["r1", "r2", "r3"]), cp_seen: JSON.stringify(["s1"]) } });
  const m = mount({ store, storageWaitMs: 20, ceilingMs: 60000 });
  await m.booted();
  assert.strictEqual(m.ctx.storageWaiting(), true, "premise");
  const deal1 = m.state.cardSlots.map((sl) => sl.branch);
  const deal1Ids = m.state.cardSlots.flatMap((sl) => sl.items.map((it) => it.id));
  assert.ok(deal1.length, "premise: a deal was made");
  m.ctx.redealAfterOnboardingPicks([]);
  const deal2 = m.state.cardSlots.map((sl) => sl.branch);
  const deal2Ids = new Set(m.state.cardSlots.flatMap((sl) => sl.items.map((it) => it.id)));
  tier.release();
  await store.hydrate();
  await settle(20);
  const recent = JSON.parse(store.getItem("cp_recent_branches"));
  assert.deepStrictEqual(recent, ["r1", "r2", "r3"].concat(deal2).slice(-8), "only the re-deal is remembered, after the durable entries");
  const seen = JSON.parse(store.getItem("cp_seen"));
  assert.ok(seen.includes("s1"), "the durable seen list survived");
  const leaked = deal1Ids.filter((id) => !deal2Ids.has(id) && seen.includes(id));
  assert.strictEqual(leaked.length, 0, `the pre-pick deal was recorded as seen: ${leaked}`);
});

/* ==================================================================== */
/* app-1-8 / perf-3: cp_saved is trimmed, and parsed once per string      */
/* ==================================================================== */

/** Count JSON.parse calls app.js makes, from now on. */
function countParses(m) {
  const counter = { n: 0 };
  m.ctx.JSON = { stringify: JSON.stringify, parse: (...a) => { counter.n += 1; return JSON.parse(...a); } };
  return counter;
}

test("app-1-8: a star stores a trimmed snapshot, and an old untrimmed entry shrinks on the next star", () => {
  /* toggleStar stored `{ ...snap }`: a breadth episode's whole description as
     hook AND description, plus every chapter. MUTATION: store `{ ...snap }`
     again -> the stored hook is 20,000 characters; red. */
  const huge = "x".repeat(20000);
  const chapters = Array.from({ length: 300 }, (_, i) => ({ title: `c${i}`, start_time_seconds: i }));
  const m = mount({ fetchImpl: () => new Promise(() => {}) });
  m.ctx.localStorage.setItem("cp_saved", JSON.stringify({ old: { id: "old", title: "Old", hook: huge, description: huge, chapters } }));
  m.state.itemIndex.b = { id: "b", title: "B", audio_url: "https://x.test/b.mp3", topics: [], hook: huge, description: huge, chapters };
  m.ctx.toggleStar("b");
  const saved = JSON.parse(m.ctx.localStorage.getItem("cp_saved"));
  for (const id of ["b", "old"]) {
    assert.ok(saved[id].hook.length <= 280, `${id}: hook ${saved[id].hook.length}`);
    assert.ok(saved[id].description.length <= 4000, `${id}: description kept for the episode page, bounded (${saved[id].description.length})`);
    assert.ok(saved[id].chapters.length <= 100, `${id}: chapters ${saved[id].chapters.length}`);
  }
  assert.ok(m.ctx.localStorage.getItem("cp_saved").length < 20000, "the whole list is small");
});

test("app-1-8: a star the store refuses stays off, and is not logged or learned from", () => {
  /* lsSet's refusal was ignored: the star lit, the save was logged, and the
     next reload lost it. MUTATION: ignore editStored's answer in toggleStar ->
     a "saved" event is logged; red. */
  const m = mount({ fetchImpl: () => new Promise(() => {}) });
  const ls = m.ctx.localStorage;
  const realSet = ls.setItem;
  ls.setItem = (k, v) => { if (k === "cp_saved") throw new Error("QuotaExceededError"); return realSet(k, v); };
  m.state.itemIndex.b = { id: "b", title: "B", audio_url: "https://x.test/b.mp3", topics: ["science"] };
  const events = vm.runInContext("_bufferedEvents.length", m.ctx);
  m.ctx.toggleStar("b");
  assert.strictEqual(m.ctx.isSaved("b"), false, "the star shows what was kept");
  const logged = vm.runInContext("_bufferedEvents", m.ctx).slice(events).map((r) => r.type);
  assert.ok(!logged.includes("saved"), `logged: ${logged}`);
});

test("app-1-8: a page of rows parses cp_saved once, not once per row's star", () => {
  /* MUTATION: make storedValue call lsGet (a fresh parse) again -> 100 parses; red. */
  const m = mount({ fetchImpl: () => new Promise(() => {}) });
  const saved = {};
  for (let i = 0; i < 100; i++) saved[`e${i}`] = { id: `e${i}`, title: `E${i}`, hook: "h".repeat(200) };
  m.ctx.localStorage.setItem("cp_saved", JSON.stringify(saved));
  const parses = countParses(m);
  let html = "";
  for (let i = 0; i < 100; i++) html += m.ctx.starBtn(`e${i}`);
  assert.strictEqual((html.match(/class="star on"/g) || []).length, 100, "premise: every star reads saved");
  assert.ok(parses.n <= 1, `${parses.n} parses for one paint`);
  m.ctx.localStorage.setItem("cp_saved", JSON.stringify({ e0: saved.e0 }));
  assert.strictEqual(m.ctx.isSaved("e1"), false, "a new stored string is read, not the old parse");
});

test("perf-3: the Now Playing sheet's per-tick reads parse nothing once Up Next and Saved are unchanged", async () => {
  /* Every 4 Hz timeupdate read EPISODE_NAVIGATION.next, .upNextCount and
     .isSaved, each re-parsing cp_queue and cp_saved. player/client.js is
     unchanged: its getters now read the memoised maps. MUTATION: make
     storedValue call lsGet again -> dozens of parses per second; red. */
  const m = mount({ fetchImpl: () => new Promise(() => {}) });
  m.ctx.forayContinuation = await import(pathToFileURL(path.join(ROOT, "player/continuation.js")).href);
  m.ctx.ForayPlayer = { currentEpisodeId: () => "cur" };
  m.ctx.localStorage.setItem("cp_queue", JSON.stringify(["cur", "q1", "q2"]));
  m.ctx.localStorage.setItem("cp_saved", JSON.stringify({ q1: { id: "q1", audio_url: "https://x.test/1.mp3" } }));
  m.ctx.localStorage.setItem("cp_episode_snaps", JSON.stringify({ q2: { id: "q2", audio_url: "https://x.test/2.mp3" } }));
  const nav = vm.runInContext("EPISODE_NAVIGATION", m.ctx);
  const warm = [nav.next, nav.upNextCount, nav.isSaved("cur")];
  assert.ok(typeof warm[0] === "function" && warm[1] === 3, "premise: the getters answer");
  const parses = countParses(m);
  for (let tick = 0; tick < 40; tick++) { void nav.next; void nav.upNextCount; nav.isSaved("cur"); }
  assert.strictEqual(parses.n, 0, `${parses.n} parses over 40 ticks`);
});
