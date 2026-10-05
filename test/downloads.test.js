/* The listener-visible half of offline downloads (#29;
 * docs/roadmap/player-features.md §3 PQ-18).
 *
 * The RULES are player/download-store.js (PQ-16) and the WIRE is
 * player/download-bridge.js (PQ-17), each pinned by its own suite. This suite
 * pins app.js's wiring around them, with the REAL modules handed over on
 * `window.forayDownloads` exactly as player/client.js publishes them, and a fake
 * `window.Capacitor` ({ nativePromise, addListener, convertFileSrc }) standing
 * in for the shell — so the only fake is the phone:
 *
 *  1. Off the shell there is no bridge, and so no Download control, no Library
 *     section and no cellular switch — an honest absence.
 *  2. Download enqueues the episode's ORIGINAL enclosure URL with the build's
 *     user agent, over Wi-Fi only by default, after writing a `queued` row.
 *  3. A `downloadProgress` event repaints the control in place.
 *  4. `downloadDone` writes `done` with its path and the WebView URL; an event
 *     for an episode the record does not hold is dropped.
 *  5. A refused download (`downloadFailed` 403) says so, with the control off.
 *  6. Library lists finished downloads, with the usage line, between Up Next
 *     and History.
 *  7. The "Download over cellular" switch writes `settings.cellular`, and the
 *     next download carries it.
 *  8. Delete my data empties the plugin's files BEFORE the keys, and a plugin
 *     that refuses while downloads are recorded is not a clear device.
 *  9. A finished download that crosses the 2 GB cap evicts least-recently
 *     played first, and never an episode the listener is partway through.
 * 10. player/client.js publishes the real modules on `window.forayDownloads`
 *     (the object every test above stands in for), with the user agent built
 *     from the build stamp's string and no second stamp read.
 *
 * Tests 9 and 10 are beyond the plan's eight: 9 because eviction deletes a
 * listener's files, 10 because the stand-in would otherwise be unchecked.
 *
 * Every test names the one-line mutation that kills it (CLAUDE.md: "a green
 * test is not evidence until you have broken it").
 *
 * THE HARNESS, AUDITED. The node:vm page of test/engine-continuation.test.js,
 * duplicated rather than imported for the reason that suite gives. What the
 * fakes do NOT forgive: the fake Capacitor's `nativePromise` answers only what
 * the test tells it to (no method is implicitly `ok`), events reach app.js only
 * through the REAL bridge's `addListener` subscription, and the record is read
 * back from the raw `cp_downloads` string in storage, never from app.js's own
 * view of it. `#view`'s `querySelectorAll` finds the slot and the buttons by
 * parsing the HTML app.js actually wrote, so a control app.js did not draw
 * cannot be found or clicked.
 */

const { test, before } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

process.on("unhandledRejection", () => {});

let STORE = null;
let BRIDGE = null;
before(async () => {
  STORE = await import("../player/download-store.js");
  BRIDGE = await import("../player/download-bridge.js");
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

/* The buttons app.js wrote into `html`, as clickable elements carrying the
   dataset the binder reads. Parsed from the markup, so only a button that is
   really in the page can be found. */
function buttonsIn(html, attr) {
  const out = [];
  for (const m of String(html).matchAll(/<button\b([^>]*)>/g)) {
    const attrs = m[1];
    if (!new RegExp(`\\b${attr}=`).test(attrs)) continue;
    const el = makeEl("button");
    const get = (name) => (new RegExp(`\\b${name}="([^"]*)"`).exec(attrs) || [])[1];
    el.dataset = {
      download: get("data-download"),
      downloadAction: get("data-download-action"),
      downloadsRemoveAll: get("data-downloads-remove-all"),
    };
    el.disabled = /\sdisabled\b/.test(attrs);
    out.push(el);
  }
  return out;
}

/** `#view`: a page element whose queries read its own innerHTML. Slots are
    remembered by id, so a repaint into one is visible to the test. */
function makeView() {
  const view = makeEl("div");
  view.id = "view";
  view.slots = new Map();
  view.found = new Map();
  view.querySelectorAll = (sel) => {
    const s = String(sel);
    if (s === "[data-download-slot]") {
      const found = [];
      for (const m of String(view.innerHTML).matchAll(/data-download-slot="([^"]*)"/g)) {
        if (!view.slots.has(m[1])) {
          const slot = makeEl("div");
          slot.dataset = { downloadSlot: m[1] };
          slot.querySelectorAll = (q) => (q === "[data-download]" ? buttonsIn(slot.innerHTML, "data-download") : []);
          view.slots.set(m[1], slot);
        }
        found.push(view.slots.get(m[1]));
      }
      return found;
    }
    /* The same elements for the same markup, so the button the binder bound
       is the one the test clicks. */
    if (s === "[data-download]" || s === "[data-downloads-remove-all]") {
      const key = `${s}
${view.innerHTML}`;
      if (!view.found.has(key)) view.found.set(key, buttonsIn(view.innerHTML, s.slice(1, -1)));
      return view.found.get(key);
    }
    return [];
  };
  return view;
}

const PAGE_IDS = [
  "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn",
  "banner-slot", "pl-form", "pl-input", "pl-note",
];

/**
 * A fake shell. `answers[method]` is what `nativePromise` resolves with (a
 * function gets the options); a method with no answer REJECTS, the way
 * Capacitor does for a method the plugin lacks — so nothing is ok by default.
 */
function makeCapacitor(answers = {}) {
  const calls = [];
  const listeners = {};
  return {
    calls, listeners,
    nativePromise(plugin, method, options) {
      calls.push({ plugin, method, options });
      if (!(method in answers)) return Promise.reject(new Error(`"${plugin}" plugin is not implemented on ios`));
      const a = answers[method];
      return Promise.resolve(typeof a === "function" ? a(options) : a);
    },
    addListener(plugin, eventName, fn) { (listeners[eventName] ||= []).push({ plugin, fn }); return { remove() {} }; },
    convertFileSrc: (p) => `capacitor://localhost/_capacitor_file_${p}`,
    /** The plugin emits: every subscriber for that event hears it. */
    emit(eventName, payload) { for (const l of listeners[eventName] || []) l.fn(payload); },
  };
}

function mount({ store = new Map(), capacitor = null, build = "37", order = null, durable = false } = {}) {
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const view = makeView();
  byId.set("view", view);
  const body = makeEl("body");
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { if (order) order.push(`remove ${k}`); store.delete(k); },
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
  if (capacitor) ctx.Capacitor = capacitor;
  if (durable) {
    /* player/client.js's store and event queue, each purging for real and
       reporting what it did — so the device can be reported clear, and the
       downloads' answer is the only thing left that can say otherwise. */
    ctx.forayStorage = {
      getItem: (k) => ctx.localStorage.getItem(k),
      setItem: (k, v) => ctx.localStorage.setItem(k, v),
      removeItem: (k) => ctx.localStorage.removeItem(k),
      async purge() {
        const keys = [...store.keys()].filter((k) => k.startsWith("cp_"));
        for (const k of keys) ctx.localStorage.removeItem(k);
        return { ok: true, keys, remaining: [], unverified: [], faults: 0 };
      },
    };
    ctx.forayEventLog = { append() {}, async purge() { return { ok: true, remaining: 0 }; } };
  }
  /* What player/client.js publishes, with the REAL modules, the UA already
     composed from the build stamp's answer (client.js's noteDownloadsBuild). */
  ctx.forayDownloads = {
    store: STORE,
    createBridge: BRIDGE.createDownloadBridge,
    USER_AGENT: BRIDGE.USER_AGENT,
    userAgentFor: BRIDGE.userAgentFor,
    userAgent: BRIDGE.userAgentFor(build),
    platform: "ios",
    bridge: null,
    recordFor: () => null,
    onMissing: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  const state = evalIn("state");
  const playable = readJson("data/discover.json").items.filter((it) => it.audio_url);
  const [item] = playable;
  const [, other] = playable;
  /* The pool Library's fullPool() rebuilds from: no session episodes, and two
     catalogue episodes with audio. */
  state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  state.discover = { items: [item, other] };
  state.itemIndex[item.id] = item;
  state.itemIndex[other.id] = other;
  state.poolIds = new Set([item.id, other.id]);
  evalIn("bootDownloads()");
  return {
    ctx, evalIn, state, store, view, item, other, byId, capacitor,
    record: () => JSON.parse(store.get("cp_downloads") || "null"),
  };
}

const settle = () => new Promise((r) => setImmediate(r));

/** Seed a finished download straight into storage, in the store's own shape. */
function seedDone(store, id, { bytes = 50 * 1024 ** 2, cellular = false } = {}) {
  const v = STORE.applyProgress(STORE.normaliseDownloads({ settings: { cellular } }),
    { id, status: "done", path: `/data/foray-downloads/${id}.bin`, bytes, now: "2026-10-05T10:00:00Z" });
  store.set("cp_downloads", JSON.stringify(v));
}

/* ==================================================================== */

test("off the shell there is no Download control, no Library section and no cellular switch", () => {
  /* MUTATION: drop `!state.downloadBridge ||` from downloadControlHtml — the
     button is drawn on the web, where a download can never work (CORS, #29).
     MUTATION 2: drop the `state.downloadBridge ?` gate on Library's
     Downloads section — red on the Library half.
     MUTATION 3: drop `if (state.downloadBridge)` around the cellular
     drawerToggle — red on the drawer half. */
  const m = mount({ capacitor: null });
  assert.strictEqual(m.state.downloadBridge, null, "no nativePromise, no bridge");
  m.ctx.renderEpisode(m.item.id);
  assert.ok(m.view.innerHTML.includes("ep-actions"), "fixture premise: the episode page rendered");
  assert.ok(!/data-download/.test(m.view.innerHTML), "no Download control off the shell");

  m.ctx.renderLibrary();
  assert.ok(m.view.innerHTML.includes(">History<"), "fixture premise: Library rendered");
  assert.ok(!m.view.innerHTML.includes(">Downloads<"), "no Downloads section off the shell");

  m.ctx.bindDrawerToggles();
  const appended = m.byId.get("drawer").children.map((c) => c.id);
  assert.ok(appended.includes("interlude-toggle"), "fixture premise: the drawer's switches were bound");
  assert.ok(!appended.includes("downloads-cellular-toggle"), "no cellular switch off the shell");
});

test("Download enqueues the ORIGINAL audio_url with the build's user agent, Wi-Fi only, after a queued row", async () => {
  /* MUTATION: send `url: item.source_audio_url` (or any rewrite of the
     enclosure) in startDownload — the url assertion fails.
     MUTATION 2: pass `userAgent: surface.USER_AGENT` — the UA reads 4a/dev,
     not the build the stamp named.
     MUTATION 3: delete the `saveDownloads(... status: "queued" ...)` line — the
     row is absent when the plugin is asked, so its events would be dropped. */
  let rowAtEnqueue = "unset";
  const store = new Map();
  const cap = makeCapacitor({
    enqueue: () => { rowAtEnqueue = JSON.parse(store.get("cp_downloads") || "null"); return { ok: true }; },
  });
  const m = mount({ store, capacitor: cap, build: "37" });
  m.ctx.renderEpisode(m.item.id);
  const btn = m.view.querySelectorAll("[data-download]").find((b) => b.dataset.download === m.item.id);
  assert.ok(btn, "the Download control is drawn on the shell");
  assert.strictEqual(btn.dataset.downloadAction, "enqueue");
  btn.click();
  await settle();
  const call = cap.calls.find((c) => c.method === "enqueue");
  assert.ok(call, "the plugin was asked to enqueue");
  assert.strictEqual(call.plugin, "ForayDownloads");
  assert.deepStrictEqual(
    { ...call.options },
    {
      id: m.item.id,
      url: m.item.audio_url,
      userAgent: "4a/37 (+https://jw-incorporated.github.io/foray/)",
      allowCellular: false,
    },
  );
  assert.strictEqual(rowAtEnqueue?.items?.[m.item.id]?.status, "queued", "the row exists before the plugin is asked");
  assert.strictEqual(rowAtEnqueue.items[m.item.id].source_url, m.item.audio_url);
});

test("a downloadProgress event repaints the control in place: Downloading 43%, disabled", async () => {
  /* MUTATION: delete `repaintDownload(report.id);` in onDownloadEvent — the
     record says 43% and the page still says "Download queued".
     MUTATION 2: drop `reportFromEvent` and pass the payload straight to
     applyProgress — a progress payload has no status and is refused, so the
     record never reaches `downloading`. */
  const cap = makeCapacitor({ enqueue: { ok: true } });
  const m = mount({ capacitor: cap });
  m.ctx.renderEpisode(m.item.id);
  await m.ctx.startDownload(m.item.id);
  const slot = m.view.slots.get(m.item.id);
  assert.ok(slot && /Download queued/.test(slot.innerHTML), "fixture premise: the slot shows the queued row");
  cap.emit("downloadProgress", { id: m.item.id, bytes: 43, total: 100 });
  assert.strictEqual(m.record().items[m.item.id].status, "downloading");
  assert.match(slot.innerHTML, /Downloading 43%/);
  assert.match(slot.innerHTML, /<button[^>]*\sdisabled[^>]*>Downloading 43%/, "an in-flight download is not a button to press again");
});

test("downloadDone writes done with the path and the WebView URL; an event for an unknown episode is dropped", async () => {
  /* MUTATION: compute `webSrc` as undefined (drop the `bridge.fileSrc({ path })`
     call) — the Android lane would have no URL to play the file from.
     MUTATION 2: delete `if (!before.items[report.id]) return;` — the late
     event for "ghost" writes a row the listener never asked for (and, after
     Delete my data, would put cp_downloads straight back). */
  const cap = makeCapacitor({ enqueue: { ok: true }, remove: { ok: true } });
  const m = mount({ capacitor: cap });
  m.ctx.renderEpisode(m.item.id);
  await m.ctx.startDownload(m.item.id);
  cap.emit("downloadDone", { id: m.item.id, path: "/var/app/foray-downloads/abc.bin", bytes: 1234 });
  const rec = m.record().items[m.item.id];
  assert.strictEqual(rec.status, "done");
  assert.strictEqual(rec.path, "/var/app/foray-downloads/abc.bin");
  assert.strictEqual(rec.webSrc, "capacitor://localhost/_capacitor_file_/var/app/foray-downloads/abc.bin");
  assert.strictEqual(rec.bytes, 1234);
  assert.match(m.view.slots.get(m.item.id).innerHTML, /Downloaded ✓/);

  cap.emit("downloadDone", { id: "ghost", path: "/var/app/foray-downloads/ghost.bin", bytes: 9 });
  assert.ok(!("ghost" in m.record().items), "a row-less event is a late one, and is dropped");
});

test("a refused download (downloadFailed 403) shows the note and a disabled control", async () => {
  /* MUTATION: drop the `<p class="note ep-download-note"…>` append from the
     unplayable-here case of downloadControlInner — the control greys out with
     no word of why. MUTATION 2: map the case to the "failed" button — the
     control invites a retry the host will refuse again. */
  const cap = makeCapacitor({ enqueue: { ok: true } });
  const m = mount({ capacitor: cap });
  m.ctx.renderEpisode(m.item.id);
  await m.ctx.startDownload(m.item.id);
  cap.emit("downloadFailed", { id: m.item.id, reason: null, status: 403 });
  const rec = m.record().items[m.item.id];
  assert.strictEqual(rec.status, "unplayable-here");
  assert.strictEqual(rec.reason, "http 403");
  const html = m.view.slots.get(m.item.id).innerHTML;
  assert.match(html, /<button[^>]*\sdisabled[^>]*>Not available for download here<\/button>/);
  assert.match(html, /<p class="note ep-download-note" data-reason="http 403">[^<]*refused the download[^<]*<\/p>/);
  assert.ok(!/data-download-action/.test(html), "nothing to press");

  /* And a fresh page draws the same thing from the record alone. */
  m.ctx.renderEpisode(m.item.id);
  assert.match(m.view.innerHTML, /ep-download-note/);
});

test("Library lists finished downloads with the usage line, after Up Next and before History", () => {
  /* MUTATION: move `${state.downloadBridge ? libSection("Downloads", …) : ""}`
     below the History line — the order assertion fails.
     MUTATION 2: list every row, not only `done` ones (drop the status filter in
     libraryDownloadsHtml) — the queued episode appears beside a usage line that
     does not count it. */
  const store = new Map();
  const cap = makeCapacitor({});
  const m = mount({ store, capacitor: cap });
  const { other } = m;
  seedDone(store, m.item.id, { bytes: 1.2 * 1024 ** 3 });
  const v = STORE.applyProgress(JSON.parse(store.get("cp_downloads")), { id: other.id, status: "queued", now: "2026-10-05T11:00:00Z" });
  store.set("cp_downloads", JSON.stringify(v));

  m.ctx.renderLibrary();
  const html = m.view.innerHTML;
  const heads = [...html.matchAll(/class="lib-section-head">([^<]*)</g)].map((x) => x[1]);
  const at = (t) => heads.indexOf(t);
  assert.ok(at("Downloads") > -1, `a Downloads section on the shell: ${heads.join(", ")}`);
  assert.strictEqual(at("Downloads"), at("Up Next") + 1, `Downloads right after Up Next: ${heads.join(", ")}`);
  assert.strictEqual(at("History"), at("Downloads") + 1, `History right after Downloads: ${heads.join(", ")}`);

  const section = html.slice(html.indexOf(">Downloads<"), html.indexOf(">History<"));
  assert.match(section, /1\.2 GB of 2 GB used · 1 episode</);
  assert.ok(section.includes(m.item.id), "the finished download is a row");
  assert.ok(!section.includes(other.id), "a queued download is not listed as downloaded");
  assert.match(section, /data-downloads-remove-all/);
});

test("the cellular switch writes settings.cellular, and the next download carries it", async () => {
  /* MUTATION: make setDownloadsCellular write `cellular: false` regardless of
     `on` — the stored setting stays off and the enqueue says Wi-Fi only.
     MUTATION 2: read `allowCellular` as `false` in startDownload — the switch
     is stored and ignored. */
  const cap = makeCapacitor({ enqueue: { ok: true } });
  const m = mount({ capacitor: cap });
  m.ctx.bindDrawerToggles();
  const sw = m.byId.get("drawer").children.find((c) => c.id === "downloads-cellular-toggle");
  assert.ok(sw, "the switch is appended on the shell");
  assert.strictEqual(m.ctx.downloadsCellularOn(), false, "Wi-Fi only by default (Q17)");
  sw.click();
  assert.strictEqual(m.record().settings.cellular, true);
  await m.ctx.startDownload(m.item.id);
  assert.strictEqual(cap.calls.find((c) => c.method === "enqueue").options.allowCellular, true);
  sw.click();
  assert.strictEqual(m.record().settings.cellular, false, "and back off");
});

test("Delete my data empties the plugin's files before the keys, and a refusal with downloads recorded is not clear", async () => {
  /* MUTATION: move `const downloads = await clearDownloads();` below
     `clearStoredKeys()` in clearLocalData — `cp_downloads` is removed first,
     so the order assertion fails (and the refusal case reads an empty record).
     MUTATION 2: drop `&& Boolean(downloads.ok)` from clearLocalData's `ok` —
     a plugin that kept the files is reported as a clear device.
     MUTATION 3: delete clearDownloads' `none-recorded` line — a shell with no
     plugin (every one built before PQ-20) reads "NOT fully clear" forever. */
  const order = [];
  const store = new Map();
  seedDone(store, "ep-1");
  store.set("cp_seen", "[]");
  const cap = makeCapacitor({ removeAll: () => { order.push("removeAll"); return { ok: true }; } });
  const m = mount({ store, capacitor: cap, order, durable: true });
  m.evalIn('deleteSheet().input.value = "DELETE"');
  const out = await m.ctx.deleteMyData({ deviceOnly: true });
  assert.ok(order.includes("removeAll"), "the plugin was asked to remove every file");
  const firstKey = order.findIndex((e) => e.startsWith("remove cp_"));
  assert.ok(firstKey > -1, "fixture premise: the keys were purged");
  assert.ok(order.indexOf("removeAll") < firstKey, `files before keys: ${order.join(", ")}`);
  assert.deepStrictEqual({ ...out.local.downloads }, { ok: true, state: "deleted" });
  assert.strictEqual(out.local.ok, true, "fixture premise: with the files gone, the device is clear");

  /* A plugin that refuses while the record lists a download: kept, not clear. */
  const store2 = new Map();
  seedDone(store2, "ep-1");
  const cap2 = makeCapacitor({ removeAll: { ok: false, reason: "io-error" } });
  const m2 = mount({ store: store2, capacitor: cap2, durable: true });
  m2.evalIn('deleteSheet().input.value = "DELETE"');
  const out2 = await m2.ctx.deleteMyData({ deviceOnly: true });
  assert.deepStrictEqual({ ...out2.local.downloads }, { ok: false, state: "kept", reason: "io-error" });
  assert.strictEqual(out2.local.ok, false, "files that may remain are not a clear device");

  /* A shell with no plugin at all and nothing recorded: no file can exist. */
  const m3 = mount({ store: new Map(), capacitor: makeCapacitor({}), durable: true });
  m3.evalIn('deleteSheet().input.value = "DELETE"');
  const out3 = await m3.ctx.deleteMyData({ deviceOnly: true });
  assert.strictEqual(out3.local.downloads.ok, true);
  assert.strictEqual(out3.local.downloads.state, "none-recorded");
  assert.strictEqual(out3.local.ok, true, "an older shell without the plugin is not told its device is unclear");
});

test("a download that crosses the cap evicts least-recently played first, never an episode in progress", async () => {
  /* Not one of the plan's eight: the eviction wiring deletes a listener's files,
     so it is pinned too. The RULE is evictionPlan's (player/download-store.test.js);
     this pins app.js's half — that it runs after downloadDone, and that the
     player's reading of each position reaches the planner.
     MUTATION: make downloadPositions return `{}` (drop the in-progress mapping)
     — the oldest download, the one being listened to, is evicted.
     MUTATION 2: delete the `evictDownloads()` call in onDownloadEvent — the cap
     is never enforced and nothing is removed. */
  const store = new Map();
  let v = STORE.normaliseDownloads({ settings: { capBytes: 100 } });
  v = STORE.applyProgress(v, { id: "listening", status: "done", path: "/d/a.bin", bytes: 60, now: "2026-10-01T00:00:00Z" });
  v = STORE.applyProgress(v, { id: "finished", status: "done", path: "/d/b.bin", bytes: 30, now: "2026-10-02T00:00:00Z" });
  v = STORE.applyProgress(v, { id: "fresh", status: "downloading", bytes: 10, total: 30, now: "2026-10-03T00:00:00Z" });
  store.set("cp_downloads", JSON.stringify(v));
  const cap = makeCapacitor({ remove: { ok: true } });
  const m = mount({ store, capacitor: cap });
  m.ctx.ForayPlayer = {
    episodeProgress: (id) => (id === "listening"
      ? { state: "in-progress", percent: 40, label: "30 min left" }
      : id === "finished" ? { state: "played", percent: 100, label: "Played" } : { state: "unplayed", percent: null, label: null }),
  };
  cap.emit("downloadDone", { id: "fresh", path: "/d/c.bin", bytes: 30 });
  for (let i = 0; i < 5; i++) await settle();
  const removed = cap.calls.filter((c) => c.method === "remove").map((c) => c.options.id);
  assert.deepStrictEqual(removed, ["finished"], "120 bytes over a 100-byte cap: the played one goes, and only it");
  assert.deepStrictEqual(Object.keys(m.record().items).sort(), ["fresh", "listening"]);
});

test("player/client.js publishes the real modules on window.forayDownloads, and the UA from the build stamp's string", () => {
  /* Source-text, because client.js builds DOM at import and cannot be loaded
     under node (player/now-playing-sheet.test.js says why). Every test above
     stands in for this object, so this is what keeps the stand-in honest.
     MUTATION: pass the whole stamp — `userAgentFor(stamp)` — in
     noteDownloadsBuild: userAgentFor takes a string or a number only, so every
     download would announce itself as 4a/dev.
     MUTATION 2: drop `createBridge: createDownloadBridge,` from the published
     object — app.js finds no bridge and no listener ever sees a Download control.
     MUTATION 3: add a second `readBuildStamp(` call for the UA — one more
     bridge round-trip at boot for an answer the first one already carries. */
  const src = fs.readFileSync(path.join(ROOT, "player", "client.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  assert.match(src, /import \* as downloadStore from "\.\/download-store\.js";/);
  assert.match(src, /import \{ createDownloadBridge, USER_AGENT, userAgentFor \} from "\.\/download-bridge\.js";/);
  const published = /window\.forayDownloads = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(published, "window.forayDownloads is published");
  for (const field of ["store: downloadStore,", "createBridge: createDownloadBridge,", "USER_AGENT,", "recordFor:", "onMissing:"]) {
    assert.ok(published[1].includes(field), `window.forayDownloads carries ${field}`);
  }
  assert.match(src, /surface\.userAgent = userAgentFor\(stamp\.native \?\? stamp\.version\);/);
  assert.strictEqual((src.match(/\breadBuildStamp\(/g) || []).length, 1, "one build-stamp read, shared");
  assert.match(src, /noteDownloadsBuild\(stamp\)/, "the one read's answer reaches the downloads UA");
});
