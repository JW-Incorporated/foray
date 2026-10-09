/* The listener-visible half of offline downloads (#29;
 * docs/roadmap/player-features.md §3 PQ-18).
 *
 * The RULES are player/download-store.js (PQ-16) and the WIRE is
 * player/download-bridge.js (PQ-17), each pinned by its own suite. This suite
 * pins app.js's wiring around them, with the REAL modules handed over on
 * `window.forayDownloads` exactly as player/client.js publishes them, and a fake
 * `window.Capacitor` ({ nativePromise, addListener, convertFileSrc,
 * isPluginAvailable }) standing
 * in for the shell — so the only fake is the phone:
 *
 *  1. Off the shell — or on a shell built without the ForayDownloads plugin —
 *     there is no bridge, and so no Download control, no Library section and
 *     no cellular switch — an honest absence.
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
 * 11. A missing downloaded file with NO network (#29: "stream if network
 *     exists, else drop the item with an earcon and advance"): the rule
 *     (`missingFileAction`), client.js's degrade executed over each answer,
 *     the earcon executed over a fake Web Audio, and app.js dropping the
 *     episode from Up Next and playing the next by the natural end's rule.
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
let CONTINUATION = null;
before(async () => {
  STORE = await import("../player/download-store.js");
  BRIDGE = await import("../player/download-bridge.js");
  CONTINUATION = await import("../player/continuation.js");
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
 * `plugin`: true (the default) is a shell whose isPluginAvailable names
 * ForayDownloads; false is one built without it; null is a shell with no
 * isPluginAvailable at all, which cannot say either way.
 */
function makeCapacitor(answers = {}, { plugin = true } = {}) {
  const calls = [];
  const listeners = {};
  const shell = {
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
  if (plugin !== null) shell.isPluginAvailable = (name) => plugin === true && name === "ForayDownloads";
  return shell;
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
    onPlayedFromFile: () => {},
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
     drawerToggle — red on the drawer half.
     MUTATION 4: delete bootDownloads' `pluginMissing("ForayDownloads")` check
     — a shell built before the plugin (#1052) gets a bridge, and a control
     whose every tap fails. */
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

  /* A shell that says it has no ForayDownloads plugin: the same absence. */
  const old = mount({ capacitor: makeCapacitor({}, { plugin: false }) });
  assert.strictEqual(old.state.downloadBridge, null, "a shell without the plugin has no bridge");
  old.ctx.renderEpisode(old.item.id);
  assert.ok(old.view.innerHTML.includes("ep-actions"), "fixture premise: the episode page rendered");
  assert.ok(!/data-download/.test(old.view.innerHTML), "no Download control on a plugin-less shell");
  old.ctx.renderLibrary();
  assert.ok(!old.view.innerHTML.includes(">Downloads<"), "no Downloads section on a plugin-less shell");
  old.ctx.bindDrawerToggles();
  assert.ok(!old.byId.get("drawer").children.some((c) => c.id === "downloads-cellular-toggle"),
    "no cellular switch on a plugin-less shell");
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
     MUTATION 3: delete clearDownloads' `none-recorded` line — a shell that
     cannot say whether it has the plugin (no isPluginAvailable), and lacks it,
     reads "NOT fully clear" forever. */
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

  /* A shell that cannot say whether it has the plugin (no isPluginAvailable),
     lacks it, and has nothing recorded: no file can exist. (A shell that SAYS
     it lacks the plugin gets no bridge at all — test 1.) */
  const m3 = mount({ store: new Map(), capacitor: makeCapacitor({}, { plugin: null }), durable: true });
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
     is never enforced and nothing is removed.
     MUTATION 3: give DOWNLOAD_IN_PROGRESS `durationSec: null` — isInProgress
     falls back to the row's observed_duration_sec (3600), reads the sentinel's
     huge `sec` as past the end, and the episode being listened to is evicted. */
  const store = new Map();
  let v = STORE.normaliseDownloads({ settings: { capBytes: 100 } });
  v = STORE.applyProgress(v, { id: "listening", status: "done", path: "/d/a.bin", bytes: 60, observed_duration_sec: 3600, now: "2026-10-01T00:00:00Z" });
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

/** Three finished, never-played downloads of 40 bytes under a 100-byte cap,
    finished a (Oct 1) → b (Oct 2) → c (Oct 3), stored raw. */
function seedThreeUnplayed(store) {
  let v = STORE.normaliseDownloads({ settings: { capBytes: 100 } });
  for (const [id, day] of [["a", "01"], ["b", "02"], ["c", "03"]]) {
    v = STORE.applyProgress(v, { id, status: "done", path: `/d/${id}.bin`, bytes: 40, now: `2026-10-${day}T00:00:00Z` });
  }
  store.set("cp_downloads", JSON.stringify(v));
}

/** A player whose every stored position reads "played": nothing is protected. */
const NOTHING_IN_PROGRESS = { episodeProgress: () => ({ state: "played", percent: 100, label: "Played" }) };

test("cp_downloads is written through the durable store lsGet/lsSet use; saveDownloads(null) removes the row", async () => {
  /* CH-02 characterization, then its one decision. The record has ONE writer
     and it is the storage backend every other `cp_` key uses (DurableStore once
     player/client.js publishes it), so "Delete my data" and the IndexedDB tier
     see it.
     MUTATION: make saveDownloads write through `localStorage` instead of
     `storageBackend()` — the durable store never sees the write; red. */
  const store = new Map();
  const cap = makeCapacitor({});
  const m = mount({ store, capacitor: cap, durable: true });
  const writes = [];
  const durableSet = m.ctx.forayStorage.setItem;
  m.ctx.forayStorage.setItem = (k, v) => { writes.push(k); return durableSet(k, v); };
  m.ctx.setDownloadsCellular(true);
  assert.deepStrictEqual(writes, ["cp_downloads"], "the write went through the durable store");
  assert.strictEqual(m.record().settings.cellular, true);
  assert.strictEqual(m.ctx.downloadsCellularOn(), true, "and is read back through it");

  /* Null: at origin/main saveDownloads normalised null into the EMPTY record
     and wrote it, while the module's writeDownloads(null) removed the key —
     two writers, two answers (P2-11). The card's ruling: null removes,
     matching the module, because saveDownloads now IS the module's writer.
     MUTATION 2: saveDownloads hands writeDownloads
     `rules.normaliseDownloads(value)` — null becomes the empty record and the
     key survives; red. */
  assert.strictEqual(m.ctx.saveDownloads(null), true, "the store took the removal");
  assert.strictEqual(store.has("cp_downloads"), false, "null removes the row");
  assert.deepStrictEqual({ ...m.ctx.downloadsValue().items }, {}, "and it reads back as the empty record");
});

test("with no play recorded, eviction goes oldest-finished first", async () => {
  /* CH-02 characterization of the bug's premise (P2-01): every row's
     `last_played_at` is null, so least-recently-PLAYED degrades to
     least-recently-FINISHED.
     MUTATION: sort newest-first in evictionPlan — `c` goes; red. */
  const store = new Map();
  seedThreeUnplayed(store);
  const cap = makeCapacitor({ remove: { ok: true } });
  const m = mount({ store, capacitor: cap });
  m.ctx.ForayPlayer = NOTHING_IN_PROGRESS;
  const plan = await m.ctx.evictDownloads();
  assert.deepStrictEqual([...plan], ["a"], "120 bytes over a 100-byte cap: the oldest finished goes");
  assert.deepStrictEqual(Object.keys(m.record().items).sort(), ["b", "c"]);
  assert.ok(Object.values(m.record().items).every((r) => r.last_played_at === null), "fixture premise: nothing played");
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
  for (const field of ["store: downloadRecordRules,", "createBridge: createDownloadBridge,", "USER_AGENT,", "recordFor:", "onMissing:", "onPlayedFromFile:"]) {
    assert.ok(published[1].includes(field), `window.forayDownloads carries ${field}`);
  }
  /* CH3-04: the store is download-store.js's own rules, its writer wrapped
     only to re-send the engine's plan (test/engine-continuation.test.js). */
  assert.match(src, /const downloadRecordRules = Object\.freeze\(\{\s*\.\.\.downloadStore,\s*writeDownloads\(storageArea, value\) \{\s*const wrote = downloadStore\.writeDownloads\(storageArea, value\);/);
  assert.match(src, /surface\.userAgent = userAgentFor\(stamp\.native \?\? stamp\.version\);/);
  assert.strictEqual((src.match(/\breadBuildStamp\(/g) || []).length, 1, "one build-stamp read, shared");
  assert.match(src, /noteDownloadsBuild\(stamp\)/, "the one read's answer reaches the downloads UA");
});

test("a download played from its file moves to the back of the eviction queue: the never-played one goes first", async () => {
  /* CH-02 (P2-01, high): least-recently-PLAYED eviction never saw a play, so
     the file listened to daily was the first evicted. `a` is the oldest
     download and was played (player/client.js fires `onPlayedFromFile` where
     the local load succeeded); `b` was never played.
     MUTATION: delete bootDownloads' `surface.onPlayedFromFile = …` assignment
     (revert the hook) — the stand-in no-op runs, `a` keeps a null
     last_played_at and is evicted; red.
     MUTATION 2: drop `if (next !== before)` — the row-less call below writes a
     record over a purged device; red on the last assertion. */
  const store = new Map();
  seedThreeUnplayed(store);
  const cap = makeCapacitor({ remove: { ok: true } });
  const m = mount({ store, capacitor: cap });
  m.ctx.ForayPlayer = NOTHING_IN_PROGRESS;
  const t0 = Date.now();
  m.ctx.forayDownloads.onPlayedFromFile("a");
  const played = Date.parse(m.record().items.a.last_played_at);
  assert.ok(played >= t0 && played <= Date.now(), "the play is stamped now");
  assert.strictEqual(m.record().items.b.last_played_at, null, "only the played row moves");
  const plan = await m.ctx.evictDownloads();
  assert.deepStrictEqual([...plan], ["b"], "the never-played download goes before the one played today");
  assert.deepStrictEqual(Object.keys(m.record().items).sort(), ["a", "c"]);

  /* Idempotent and silent for an id with no row (removed, or purged). */
  store.delete("cp_downloads");
  m.ctx.forayDownloads.onPlayedFromFile("a");
  assert.strictEqual(store.has("cp_downloads"), false, "no row, no write: a purge is not undone");
});

test("app.js keeps no copy of the record's rules: no key literal, no downloadsWithout; client.js stamps a play only on a successful local load", () => {
  /* Source text, as test 10 reads client.js (it cannot load under node).
     MUTATION: re-spell `lsGet("cp_downloads", null)` in downloadsValue — the
     literal is back; red.
     MUTATION 2: restore app.js's own `function downloadsWithout` — red. */
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const app = strip(APP_SRC);
  assert.doesNotMatch(app, /["'`]cp_downloads["'`]/, "the key is the module's KEY, never re-spelled in app.js");
  assert.doesNotMatch(app, /function downloadsWithout\b/, "the remove rule is download-store.js's removeRow");
  assert.match(app, /rules\.readDownloads\(storageBackend\(\)\)/, "the one reader");
  assert.match(app, /rules\.writeDownloads\(storageBackend\(\), value\)/, "the one writer");

  /* The hook fires where play() spends its ticket on SUCCESS — executed, not
     only read: the statements between the spend and the rethrow are lifted
     out of client.js and run over each way a play can end.
     MUTATION 3: move the `onPlayedFromFile` call into localSourceFor (the
     mapper) — a file chosen and then found missing is stamped; red on the
     placement asserts.
     MUTATION 4: drop `else ticket = null;` — a local load that FAILED (and
     fell back to the stream) stamps the missing file as played; red on the
     "failed" case. */
  const client = fs.readFileSync(path.join(ROOT, "player", "client.js"), "utf8").replace(/\r\n/g, "\n");
  const code = strip(client);
  /* Two call sites: play()'s success line below, and the native lane's
     `settleEngineLocalLoad` (on the engine's `playing` snapshot for a load
     play() handed back still loading; test 11 runs it). Nowhere else. */
  const calls = code.match(/onPlayedFromFile\?\.\(/g) || [];
  assert.strictEqual(calls.length, 2, "two call sites");
  const fnBody = (head) => {
    const at = code.indexOf(head);
    assert.ok(at >= 0, head);
    let depth = 0;
    for (let i = code.indexOf("{", at + head.length - 1); i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) return code.slice(at, i + 1);
    }
    throw new Error(`unbalanced ${head}`);
  };
  assert.match(fnBody("function settleEngineLocalLoad(ev) {"), /onPlayedFromFile\?\.\(/, "the second is the engine's settle");
  assert.doesNotMatch(fnBody("function localSourceFor(item, opts) {"), /onPlayedFromFile/, "never in the mapper");
  assert.doesNotMatch(fnBody("function degradeLocalPlay() {"), /onPlayedFromFile/, "never on the degrade");
  const start = code.indexOf("if (!loadError && manager.state?.type !== \"idle\" && localAttempt === ticket) localAttempt = null;");
  const end = code.indexOf("if (loadError) throw loadError.err;");
  assert.ok(start > 0 && end > start, "the success line precedes the rethrow");
  const snippet = code.slice(start, end);
  assert.match(snippet, /onPlayedFromFile/, "the hook sits between the ticket's spend and the rethrow");
  const run = ({ loadError = null, type = "playing", localAttempt, ticket }) => {
    const heard = [];
    const window = { forayDownloads: { onPlayedFromFile: (id) => heard.push(id) } };
    new Function("loadError", "manager", "localAttempt", "ticket", "item", "window", snippet)(
      loadError, { state: { type } }, localAttempt, ticket, { id: "ep-1" }, window);
    return heard;
  };
  const T = { item: { id: "ep-1" }, opts: {} };
  assert.deepStrictEqual(run({ localAttempt: T, ticket: T }), ["ep-1"], "a local load that succeeded is a play");
  assert.deepStrictEqual(run({ loadError: { err: new Error("404") }, localAttempt: T, ticket: T }), [], "failed, fell back to the stream");
  assert.deepStrictEqual(run({ type: "idle", localAttempt: T, ticket: T }), [], "idle: a missing file, or an autoplay refusal");
  assert.deepStrictEqual(run({ localAttempt: { item: { id: "ep-2" } }, ticket: T }), [], "superseded by a newer local play");
  assert.deepStrictEqual(run({ localAttempt: null, ticket: T }), [], "superseded by a stream");
  assert.deepStrictEqual(run({ localAttempt: null, ticket: null }), [], "a stream, or the noLocal retry after a missing file");
});

/* ==================================================================== */
/* 11. OFFLINE, A MISSING FILE IS DROPPED WITH AN EARCON AND UP NEXT ADVANCES */
/* ==================================================================== */

/* client.js cannot load under node (test 10 says why), so its two pieces are
   lifted out of the source text — comments stripped, code verbatim — and RUN
   over fakes, the way the onPlayedFromFile placement test runs its snippet. */
const CLIENT_CODE = fs.readFileSync(path.join(ROOT, "player", "client.js"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
function clientFn(head) {
  const at = CLIENT_CODE.indexOf(head);
  assert.ok(at >= 0, `client.js has ${head}`);
  let depth = 0;
  for (let i = CLIENT_CODE.indexOf("{", at + head.length - 1); i < CLIENT_CODE.length; i++) {
    if (CLIENT_CODE[i] === "{") depth++;
    else if (CLIENT_CODE[i] === "}" && --depth === 0) return CLIENT_CODE.slice(at, i + 1);
  }
  throw new Error(`unbalanced ${head}`);
}

test("missingFileAction: only a positive offline drops; online and unknown stream", () => {
  /* MUTATION: `online !== true ? MISSING_DROP` — a browser that cannot say
     (null) drops an episode the network could have served; red.
     MUTATION 2: swap the two answers — online drops, offline streams; red. */
  assert.strictEqual(STORE.missingFileAction({ online: false }), STORE.MISSING_DROP);
  assert.strictEqual(STORE.missingFileAction({ online: true }), STORE.MISSING_STREAM);
  assert.strictEqual(STORE.missingFileAction({ online: null }), STORE.MISSING_STREAM, "unknown is not offline");
  assert.strictEqual(STORE.missingFileAction(), STORE.MISSING_STREAM, "total");
  assert.notStrictEqual(STORE.MISSING_DROP, STORE.MISSING_STREAM);
});

test("client.js degrade: offline drops (bar line, earcon, onMissing offline, answers false); online streams once with noLocal", () => {
  /* degradeLocalPlay, executed over each answer of browserOnline().
     MUTATION: delete the `if (downloadStore.missingFileAction(...) ===
     downloadStore.MISSING_DROP) { ... }` branch — offline streams again (the
     retry that can only fail); red on the offline case.
     MUTATION 2: drop `playEarcon();` from the branch — red on `earcons`.
     MUTATION 3: drop `{ offline: true }` from the offline onMissing call —
     app.js says "streaming instead" and never advances; red.
     MUTATION 4: `return null;` instead of `return false;` in the branch —
     play() falls through to its rethrow/"couldn't load"; red on the answer. */
  const src = clientFn("function degradeLocalPlay() {");
  const run = (online, { ticketFor = "ep-1" } = {}) => {
    const log = { missing: [], plays: [], lines: [], earcons: 0 };
    const window = { forayDownloads: { onMissing: (...a) => log.missing.push(a) } };
    const ForayPlayer = { play: (item, opts) => { log.plays.push({ id: item.id, opts }); return Promise.resolve(true); } };
    const answer = new Function(
      "localAttempt", "current", "downloadStore", "browserOnline", "setPlayFailure", "EP_MISSING_OFFLINE",
      "playEarcon", "window", "ForayPlayer",
      `${src}\nreturn degradeLocalPlay();`,
    )(
      ticketFor ? { item: { id: ticketFor }, opts: { why: "w" } } : null, { id: "ep-1" }, STORE, () => online,
      (line) => log.lines.push(line), "OFFLINE-LINE", () => { log.earcons++; }, window, ForayPlayer,
    );
    return { answer, ...log };
  };

  const off = run(false);
  assert.strictEqual(off.answer, false, "offline: this item did not start, and play() answers false");
  assert.deepStrictEqual(off.missing, [["ep-1", { offline: true }]], "app.js is told it was dropped offline");
  assert.strictEqual(off.earcons, 1, "one earcon");
  assert.deepStrictEqual(off.lines, ["OFFLINE-LINE"], "the bar says why nothing played");
  assert.deepStrictEqual(off.plays, [], "no stream retry with no network");

  for (const online of [true, null]) {
    const on = run(online);
    assert.ok(on.answer && typeof on.answer.then === "function", `online=${online}: the stream retry's promise`);
    assert.deepStrictEqual(on.missing, [["ep-1"]], `online=${online}: marked, streaming instead`);
    assert.deepStrictEqual(on.plays, [{ id: "ep-1", opts: { why: "w", noLocal: true } }], "streamed once, never the file again");
    assert.strictEqual(on.earcons, 0, "no earcon when it streams");
    assert.deepStrictEqual(on.lines, []);
  }

  const none = run(false, { ticketFor: null });
  assert.strictEqual(none.answer, null, "no ticket, nothing to degrade");
  assert.deepStrictEqual([none.missing, none.plays, none.earcons], [[], [], 0]);

  /* The two callers. play() returns the drop's `false` rather than falling
     through to the rethrow; reportPlayFailure chains nothing after a drop —
     `current` may be the NEXT episode by then, loading its own file.
     MUTATION 5: back to `if (retried) return retried;` in play(); red.
     MUTATION 6: drop `if (retry === false) return;` from reportPlayFailure; red. */
  assert.match(clientFn("async play(item, opts) {"), /const retried = degradeLocalPlay\(\);\s*if \(retried != null\) return retried;/);
  const report = clientFn("reportPlayFailure(err) {");
  const dropAt = report.indexOf("if (retry === false) return;");
  assert.ok(dropAt > 0 && dropAt < report.indexOf("if (retry) {"), "a drop returns before the stream retry is chained");
});

test("the earcon: one short tone on Web Audio, the context reused, and silence (never a throw) without it", () => {
  /* MUTATION: drop `tone.start(t0);` — the tone is built and never sounds; red.
     MUTATION 2: drop `gain.connect(ac.destination);` — it sounds into nothing; red.
     MUTATION 3: drop the try/catch around the body — a context that throws
     takes the degrade (and Up Next's advance) down with it; red. */
  const make = (window) => new Function("window", `let earconContext = null;\n${clientFn("function playEarcon() {")}\nreturn playEarcon;`)(window);
  const made = [];
  class FakeContext {
    constructor() {
      made.push(this);
      this.state = "suspended";
      this.resumed = 0;
      this.currentTime = 5;
      this.destination = { name: "speakers" };
      this.tones = [];
    }
    resume() { this.resumed++; return Promise.resolve(); }
    createGain() {
      const ramps = [];
      return { ramps, gain: { setValueAtTime: (v, t) => ramps.push([v, t]), exponentialRampToValueAtTime: (v, t) => ramps.push([v, t]) },
        connect(to) { this.to = to; } };
    }
    createOscillator() {
      const tone = { freqs: [], frequency: { setValueAtTime: (v, t) => tone.freqs.push([v, t]) },
        connect(to) { this.to = to; }, start(t) { this.startAt = t; }, stop(t) { this.stopAt = t; } };
      this.tones.push(tone);
      return tone;
    }
  }
  const earcon = make({ AudioContext: FakeContext });
  assert.strictEqual(earcon(), true);
  assert.strictEqual(earcon(), true);
  assert.strictEqual(made.length, 1, "one context, reused");
  const [ac] = made;
  assert.ok(ac.resumed >= 1, "a suspended context is asked to resume");
  assert.strictEqual(ac.tones.length, 2);
  const [tone] = ac.tones;
  assert.strictEqual(tone.startAt, 5, "starts now");
  assert.ok(tone.stopAt > 5 && tone.stopAt - 5 < 1, "and is short (under a second)");
  assert.strictEqual(tone.to.to, ac.destination, "through its gain to the speakers");

  assert.strictEqual(make({ webkitAudioContext: FakeContext })(), true, "the prefixed constructor (older WebKit)");
  assert.strictEqual(make({})(), false, "no Web Audio: silence");
  assert.strictEqual(make({ AudioContext: class { constructor() { throw new Error("refused"); } } })(), false, "a refusing context: silence, not a throw");
});

test("offline, a missing download is dropped: the record is missing, Up Next loses it and the next one plays", async () => {
  /* app.js's half: onMissing(id, { offline: true }) marks the row, says so,
     and runs the natural end's rule, `advanceQueueOnEnded`.
     MUTATION: drop the `advanceQueueOnEnded(id)` call in bootDownloads'
     onMissing — the episode stays at the head of Up Next and nothing plays; red.
     MUTATION 2: call `playNextAfter(id, "autoadvance")` instead — with
     Continuous playback off the next episode plays anyway; red on that half.
     MUTATION 3: advance on every onMissing (drop the `if (offline)`) — online,
     the stream retry and the next episode both start; red on the online half. */
  const setup = ({ autoadvance = true } = {}) => {
    const store = new Map();
    const m = mount({ store, capacitor: makeCapacitor({}) });
    m.ctx.forayContinuation = CONTINUATION;
    seedDone(store, m.item.id);
    store.set("cp_queue", JSON.stringify([m.item.id, m.other.id]));
    if (!autoadvance) store.set("cp_autoadvance", "false");
    const plays = [];
    m.ctx.ForayPlayer = {
      play: async (item, opts) => { plays.push({ id: item.id, opts }); return true; },
      onEpisodeEnded: () => () => {},
      setEpisodeNavigation: () => true,
      setContinuation() {},
      currentEpisodeId: () => null,
      isCurrent: () => true,
    };
    const said = () => m.ctx.document.body.children.map((c) => c.textContent).filter(Boolean);
    return { m, store, plays, said, queue: () => JSON.parse(store.get("cp_queue") || "[]") };
  };

  const off = setup();
  off.m.ctx.forayDownloads.onMissing(off.m.item.id, { offline: true });
  await settle();
  assert.strictEqual(off.m.record().items[off.m.item.id].status, "missing", "the row is marked");
  assert.deepStrictEqual(off.queue(), [off.m.other.id], "the missing episode leaves Up Next");
  assert.deepStrictEqual(off.plays.map((p) => p.id), [off.m.other.id], "and the next one plays");
  assert.ok(off.said().includes("Downloaded copy missing, and no connection — skipped."), "the listener is told");

  const still = setup({ autoadvance: false });
  still.m.ctx.forayDownloads.onMissing(still.m.item.id, { offline: true });
  await settle();
  assert.deepStrictEqual(still.queue(), [still.m.other.id], "switch off: dropped all the same");
  assert.deepStrictEqual(still.plays, [], "but nothing plays — the switch decides, as at an end");

  const on = setup();
  on.m.ctx.forayDownloads.onMissing(on.m.item.id);
  await settle();
  assert.strictEqual(on.m.record().items[on.m.item.id].status, "missing");
  assert.deepStrictEqual(on.queue(), [on.m.item.id, on.m.other.id], "online: Up Next untouched, the episode streams");
  assert.deepStrictEqual(on.plays, [], "app.js starts nothing: client.js's retry streams it");
  assert.ok(on.said().includes("Downloaded copy missing — streaming instead."));
});

/* The NATIVE lane (review of offline-missing-file). The shipping iOS default
   is the native engine (mobile/ENGINE_DEFAULT.json: ios "native", with
   "episode"), and there a missing file fails AFTER play() returns: the
   facade's play() resolves when `playEpisode` is taken, the engine loads the
   file afterwards, and the failure is an `error` event with code "load". */

test("native lane: play() holds the downloaded copy's ticket while the engine is still loading it, and stamps nothing yet", () => {
  /* The spend line, executed over each lane and state play() can return in.
     MUTATION: delete the `if (engineMode === "native" && ... "loadingItem")
     ticket = null;` hold — the ticket is spent on a load that has not
     happened, the engine's later load error has nothing to degrade (no
     stream online, no drop offline), and the missing file is stamped as
     played; red on the native loadingItem case. */
  const start = CLIENT_CODE.indexOf("if (engineMode === \"native\" && ticket && localAttempt === ticket");
  const end = CLIENT_CODE.indexOf("if (loadError) throw loadError.err;");
  assert.ok(start > 0 && end > start, "the hold precedes the spend, before the rethrow");
  const snippet = CLIENT_CODE.slice(start, end);
  const run = ({ engineMode, type, loadError = null }) => {
    const T = { item: { id: "ep-1" }, opts: {} };
    const heard = [];
    const window = { forayDownloads: { onPlayedFromFile: (id) => heard.push(id) } };
    const left = new Function("engineMode", "loadError", "manager", "localAttempt", "ticket", "item", "window",
      `${snippet}\nreturn localAttempt;`)(engineMode, loadError, { state: { type } }, T, T, { id: "ep-1" }, window);
    return { held: left === T, heard };
  };
  assert.deepStrictEqual(run({ engineMode: "native", type: "loadingItem" }), { held: true, heard: [] },
    "native, still loading: the ticket waits for the engine's word, nothing stamped");
  assert.deepStrictEqual(run({ engineMode: "native", type: "playing" }), { held: false, heard: ["ep-1"] },
    "native, already playing by the reply: spent and stamped, as before");
  assert.deepStrictEqual(run({ engineMode: "js", type: "loadingItem" }), { held: false, heard: ["ep-1"] },
    "the JS lane settles its load inside play(): unchanged");
  assert.deepStrictEqual(run({ engineMode: "native", type: "loadingItem", loadError: { err: new Error("x") } }).heard, [],
    "a thrown play is never a hold, never a stamp");
});

test("native lane: the engine's load error over a held ticket streams online and drops offline; a playing snapshot spends it", async () => {
  /* settleEngineLocalLoad + degradeLocalPlay, executed together over one
     shared ticket, and onEngineEvent's call into them.
     MUTATION: delete `settleEngineLocalLoad(ev);` from onEngineEvent — the
     engine's load error reaches nothing: no earcon, no drop, no stream; red
     on the wiring case.
     MUTATION 2: drop the `(s.state !== "playing" && s.state !== "ended")`
     test — the idle snapshot the engine sends JUST BEFORE its load error
     spends the ticket, and the error then degrades nothing; red.
     MUTATION 3: drop `if (ev.code !== "load") return;` — a hop the engine
     walked (`chain-start`) drops or streams the episode on screen; red.
     MUTATION 4: drop the `retry.then(...)` chain — a stream retry that fails
     too is never painted; red on `reports`. */
  const src = `${clientFn("function degradeLocalPlay() {")}\n${clientFn("function settleEngineLocalLoad(ev) {")}`;
  const lane = ({ online, playOk = true, currentId = "ep-1" }) => {
    const log = { missing: [], plays: [], lines: [], earcons: 0, stamped: [], reports: [] };
    const window = { forayDownloads: {
      onMissing: (...a) => log.missing.push(a),
      onPlayedFromFile: (id) => log.stamped.push(id),
    } };
    const ForayPlayer = {
      play: (item, opts) => { log.plays.push({ id: item.id, opts }); return Promise.resolve(playOk); },
      reportPlayFailure: (e) => log.reports.push(e),
    };
    const api = new Function(
      "current", "downloadStore", "browserOnline", "setPlayFailure", "EP_MISSING_OFFLINE",
      "playEarcon", "window", "ForayPlayer",
      `let localAttempt = { item: { id: "ep-1" }, opts: { why: "w" } };\n${src}\n` +
      "return { settle: settleEngineLocalLoad, held: () => localAttempt !== null };",
    )(
      { id: currentId, isLocalFile: true }, STORE, () => online, (line) => log.lines.push(line), "OFFLINE-LINE",
      () => { log.earcons++; }, window, ForayPlayer,
    );
    return { ...api, log };
  };
  const snap = (state, itemId = "ep-1") => ({ type: "snapshot", snapshot: { state, itemId } });
  const loadError = { type: "error", code: "load", message: "decode" };

  /* Still loading, then the idle snapshot that precedes the error: held. */
  const off = lane({ online: false });
  off.settle(snap("loadingItem"));
  off.settle(snap("idle"));
  off.settle({ type: "error", code: "chain-start" });
  assert.strictEqual(off.held(), true, "loading, idle and a hop's error leave the ticket alone");
  off.settle(loadError);
  assert.deepStrictEqual(off.log.missing, [["ep-1", { offline: true }]], "offline: dropped, app.js advances Up Next");
  assert.strictEqual(off.log.earcons, 1, "with the earcon");
  assert.deepStrictEqual(off.log.lines, ["OFFLINE-LINE"]);
  assert.deepStrictEqual(off.log.plays, [], "no stream with no network");
  assert.deepStrictEqual(off.log.stamped, [], "a missing file is never stamped as played");
  off.settle(loadError);
  assert.strictEqual(off.log.earcons, 1, "spent: a second report degrades nothing");

  const on = lane({ online: true, playOk: false });
  on.settle(snap("idle"));
  on.settle(loadError);
  await settle();
  assert.deepStrictEqual(on.log.missing, [["ep-1"]], "online: marked, streaming instead");
  assert.deepStrictEqual(on.log.plays, [{ id: "ep-1", opts: { why: "w", noLocal: true } }], "streamed once, noLocal");
  assert.strictEqual(on.log.earcons, 0);
  assert.deepStrictEqual(on.log.reports, [null], "and a stream that fails too is painted");

  const played = lane({ online: false });
  played.settle(snap("playing", "ep-other"));
  assert.strictEqual(played.held(), true, "another item's snapshot is not this load");
  played.settle(snap("playing"));
  assert.deepStrictEqual(played.log.stamped, ["ep-1"], "the file played: stamped once");
  assert.strictEqual(played.held(), false, "and the ticket is spent");
  played.settle(loadError);
  assert.deepStrictEqual([played.log.missing, played.log.earcons], [[], 0], "a later failure about a file that played degrades nothing");

  const moved = lane({ online: false, currentId: "ep-2" });
  moved.settle(loadError);
  assert.deepStrictEqual([moved.log.missing, moved.log.earcons, moved.log.plays], [[], 0, []], "the bar is on another episode: nothing");

  /* The wiring: onEngineEvent hands every native event to the settle, and
     none on the JS lane. */
  const wire = (engineMode) => {
    const seen = [];
    new Function("engineMode", "settleEngineLocalLoad", `${clientFn("function onEngineEvent(ev) {")}\nonEngineEvent(${JSON.stringify(loadError)});`)(
      engineMode, (ev) => seen.push(ev.type));
    return seen;
  };
  assert.deepStrictEqual(wire("native"), ["error"], "native: the engine's load error reaches the settle");
  assert.deepStrictEqual(wire("js"), [], "the JS lane settles inside play()");
});

/* ==================================================================== */
/* CH3-05 (docs/roadmap/code-health-3.md): the native index is the one truth.
   iOS moves the app's container on every update, so a stored absolute path
   goes stale; a transfer that finished (or was flipped to `interrupted`)
   while 4a was not running emitted its event before the page listened. At
   boot the page re-reads the plugin's `list()` and the record follows it. */

const OLD_IOS_PATH = (id) => `/var/mobile/Containers/Data/Application/OLD-UUID/Library/Application Support/foray-downloads/${id}.bin`;
const NEW_IOS_PATH = (id) => `/var/mobile/Containers/Data/Application/NEW-UUID/Library/Application Support/foray-downloads/${id}.bin`;

/** The two catalogue episodes mount() puts in the pool, in its order. */
const CATALOGUE_IDS = () => readJson("data/discover.json").items.filter((it) => it.audio_url).slice(0, 2).map((it) => it.id);

/** One stored row in the store's own shape, written straight into storage. */
function seedRow(store, id, report) {
  const before = store.has("cp_downloads") ? JSON.parse(store.get("cp_downloads")) : STORE.normaliseDownloads({});
  store.set("cp_downloads", JSON.stringify(STORE.applyProgress(before, { id, now: "2026-10-05T10:00:00Z", ...report })));
}

// RED on main: R4-02 — nothing reads list(), so the record keeps the pre-update path forever.
/* MUTATION: drop the boot replay in download-bridge.js -> the record keeps OLD-UUID. */
test("CH3-05: after an app update the record takes TODAY's path from the native index, and the play opens it", async () => {
  const store = new Map();
  const [id] = CATALOGUE_IDS();
  seedRow(store, id, { status: "done", path: OLD_IOS_PATH(id), bytes: 1234 });
  const cap = makeCapacitor({ list: () => ({ items: [{ id, status: "done", bytes: 1234, total: 1234, reason: null, path: NEW_IOS_PATH(id) }] }) });
  const m = mount({ store, capacitor: cap });
  await settle();
  const rec = m.record().items[id];
  assert.strictEqual(rec.status, "done");
  assert.strictEqual(rec.path, NEW_IOS_PATH(id), "the stale container path is replaced");
  assert.strictEqual(rec.webSrc, `capacitor://localhost/_capacitor_file_${NEW_IOS_PATH(id)}`);
  assert.match(STORE.playSource(m.item, rec, { platform: "ios" }).audio_url, /NEW-UUID/);
});

// RED on main: R4-04 — a transfer that settled while 4a was not running reads "Downloading…" forever.
/* MUTATION: drop the boot replay in download-bridge.js -> both rows stay `downloading`. */
test("CH3-05: a transfer that finished, or was interrupted, while 4a was not running is recorded at boot", async () => {
  const store = new Map();
  const [a, b] = CATALOGUE_IDS();
  seedRow(store, a, { status: "downloading", bytes: 87, total: 100 });
  seedRow(store, b, { status: "downloading", bytes: 10, total: 100 });
  const cap = makeCapacitor({ list: () => ({ items: [
    { id: a, status: "done", bytes: 100, total: 100, reason: null, path: NEW_IOS_PATH(a) },
    { id: b, status: "failed", bytes: 10, total: 100, reason: "interrupted", path: null },
  ] }) });
  const m = mount({ store, capacitor: cap });
  await settle();
  const items = m.record().items;
  assert.strictEqual(items[a].status, "done", "the finished transfer is no longer Downloading 87%");
  assert.strictEqual(items[a].path, NEW_IOS_PATH(a));
  assert.strictEqual(items[b].status, "failed", "the interrupted one is offered for retry");
  assert.strictEqual(items[b].reason, "interrupted");
});
