/* The Foray directory, at the page (FD-03), with FD-01's row, FD-04's empty seed
 * and FD-05's three playback cases.
 *
 * WHY THIS IS A ROOT SUITE AND NOT ONLY player/foray-directory.test.js
 * That file proves the module's three rules against fakes. What it cannot see is
 * the ORDER app.js puts them in, and the order is the design: the cache read
 * before the bundle fetches, the boot choice before `route()`, the pointer fetch
 * AFTER `route()` and never awaited, the swap into `state` and the re-render of
 * the Foray surfaces. `app.js` is a classic browser script that no ES module can
 * import, so — like test/diagnostics-surface.test.js — this file mounts the REAL
 * `app.js` in a `node:vm` over a hand-rolled DOM, and drives it with the REAL
 * `player/foray-directory.js`, the REAL resolver, the REAL resume store and the
 * REAL field record, over a fake origin and a fake IndexedDB tier. The harness is
 * not shared with the other suites that mount app.js, on purpose: coupling two
 * suites through one harness is how one of them silently stops covering anything.
 *
 * MUTATIONS NAMED IN THE HEADER, as the card asks; each was run and went red:
 *   - skip validation: delete the `if (!check.ok)` block in foray-directory.js's
 *     `run()` -> "an invalid set is refused" and FD-05's prefetch case go red.
 *   - block paint on the fetch: `await refreshForayDirectory("boot")` above
 *     `route()` in `init()` -> "first paint never waits on the network" goes red
 *     (the page never paints while the pointer request is pending).
 *   - forget the swap: drop `applyForaySet(out.set)` from refreshForayDirectory
 *     -> "a newer pointer renders the new Foray without a reload" goes red.
 *   - forget the re-render: drop `renderCurrentPage()` there -> same test, red on
 *     the DOM assertion while the state one still passes.
 *   - drop the cache on a network error: add `cache.remove(CACHE_KEY)` to the
 *     `offline` branch -> "network down: cache, then bundle" goes red.
 *   - drop the row: delete the `noteDataSource(...)` call from
 *     bootForayDirectory -> FD-01's test goes red.
 *
 * No dependencies: node:test + node:vm, with the player modules imported for
 * real through dynamic import.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

/* The seed the shell boots from is the committed data on disk, so the row's `n=` is read from
   there rather than pinned — a published Foray must not break this test (F-84 / PR #624). */
const SEED_FORAY_COUNT = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "forays.json"), "utf8")).forays.length;

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const ORIGIN = "https://foray-web-seven.vercel.app";
const POINTER = "data/forays-directory.json";

/* The real modules, once. Dynamic import from CJS is how a root suite reaches
   `player/`, whose package.json makes it an ES-module tree. */
const mods = (async () => {
  const dir = await import("../player/foray-directory.js");
  const resolve = await import("../player/foray-resolve.js");
  const progress = await import("../player/foray-progress.js");
  const diag = await import("../player/diagnostic-log.js");
  const qm = await import("../player/queue-manager.js");
  return { dir, resolve, progress, diag, qm };
})();

/* ---------- fixtures ---------- */

const readData = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const BASE = () => ({
  forays: readData("data/forays.json"),
  segments: readData("data/segments.json"),
  sources: readData("data/segment-sources.json"),
});
/** A published Foray that exists nowhere in the repo, with its own two segments
    over its own two episodes — the "new Foray" every directory test is about.
    `status`/`generated` make it a generated draft instead (F-92). */
function withNewForay(set, { id = "fd-new-1", host = "cdn.directory.test", status = "published", generated = false } = {}) {
  const out = JSON.parse(JSON.stringify(set));
  out.forays.forays.push({
    id, kind: "deep-dive", title: "A Foray that arrived by directory", status,
    ...(generated ? { generated: true } : {}),
    slots: [{ id: "one", title: "One" }],
    items: [
      { type: "segment", slot: "one", label: "L1", role: "explanation", segment_id: `${id}-s1` },
      { type: "segment", slot: "one", label: "L2", role: "explanation", segment_id: `${id}-s2` },
    ],
  });
  out.segments.segments.push(
    { id: `${id}-s1`, item_id: `${id}-ep-a`, start_sec: 10, end_sec: 100, reference_duration_sec: 3600, why: "w" },
    { id: `${id}-s2`, item_id: `${id}-ep-b`, start_sec: 20, end_sec: 200, reference_duration_sec: 3600, why: "w" },
  );
  out.sources.sources.push(
    { id: `${id}-ep-a`, show: "New Show", title: "Ep A", audio_url: `https://${host}/${id}-a.mp3`, duration_sec: 3600, dai_suspected: false },
    { id: `${id}-ep-b`, show: "New Show", title: "Ep B", audio_url: `https://${host}/${id}-b.mp3`, duration_sec: 3600, dai_suspected: false },
  );
  return out;
}

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));
async function pointerFor(set, version, built_at = "2026-09-10T12:00:00Z") {
  const bytes = {}, sha256 = {};
  for (const k of ["forays", "segments", "sources"]) {
    bytes[k] = enc(set[k]).byteLength;
    const d = await webcrypto.subtle.digest("SHA-256", enc(set[k]));
    sha256[k] = "sha256:" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return {
    version, built_at,
    files: { forays: "data/forays.json", segments: "data/segments.json", sources: "data/segment-sources.json" },
    bytes, sha256,
  };
}
function routesFor(pointer, set) {
  return {
    [`${ORIGIN}/${POINTER}`]: pointer,
    [`${ORIGIN}/data/forays.json`]: set.forays,
    [`${ORIGIN}/data/segments.json`]: set.segments,
    [`${ORIGIN}/data/segment-sources.json`]: set.sources,
  };
}

/* ---------- a DOM with a tree, whose innerHTML grows ids ---------- */

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.id = null;
    this.className = "";
    this.textContent = "";
    this._html = "";
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this._on = new Map();
    this._c = new Set();
    this.classList = {
      add: (c) => this._c.add(c), remove: (c) => this._c.delete(c),
      contains: (c) => this._c.has(c),
      toggle: (c, on) => { const want = on ?? !this._c.has(c); if (want) this._c.add(c); else this._c.delete(c); return want; },
    };
  }
  /* The one trick this harness adds over diagnostics-surface's: assigning
     innerHTML grows a child per `id="…"` in the markup, so the page's own
     `$("#fy-play")` after a render finds something. The markup itself is kept
     verbatim for the string assertions below. */
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = String(html);
    this.children = [];
    const re = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\sid="([^"]+)"/g;
    let m;
    while ((m = re.exec(this._html))) {
      const kid = new El(m[1]);
      kid.id = m[2];
      this.appendChild(kid);
    }
  }
  append(...kids) { for (const k of kids) this.appendChild(k); }
  appendChild(k) { k.parent = this; this.children.push(k); return k; }
  insertBefore(k, ref) {
    k.parent = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(k); else this.children.splice(i, 0, k);
    return k;
  }
  removeChild(k) { this.children = this.children.filter((c) => c !== k); k.parent = null; return k; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  get parentNode() { return this.parent; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(t, fn) { if (!this._on.has(t)) this._on.set(t, new Set()); this._on.get(t).add(fn); }
  removeEventListener(t, fn) { this._on.get(t)?.delete(fn); }
  click() { const out = []; for (const fn of [...(this._on.get("click") ?? [])]) out.push(fn({ target: this })); return Promise.all(out); }
  focus() {}
  select() {}
  closest() { return null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  querySelector(sel) { return findIn(this, sel); }
  querySelectorAll(sel) { return findAllIn(this, sel); }
  tree() { return [this, ...this.children.flatMap((c) => c.tree())]; }
}
function matches(el, sel) {
  const s = String(sel).trim();
  if (s.startsWith("#")) return el.id === s.slice(1);
  if (s.startsWith(".")) return String(el.className).split(/\s+/).includes(s.slice(1));
  if (s.startsWith("[")) return false;
  return el.tagName === s.toUpperCase();
}
function findIn(root, sel) { return root.tree().find((e) => e !== root && matches(e, sel)) ?? null; }
function findAllIn(root, sel) { return root.tree().filter((e) => e !== root && matches(e, sel)); }

class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

/** The `DurableTier` shape idb-tier.js gives the directory: one row per key. */
function fakeTier() {
  const rows = new Map();
  return {
    rows, writes: 0, removes: 0,
    async readAll() { return new Map(rows); },
    async write(k, v) { this.writes += 1; rows.set(k, v); },
    async remove(k) { this.removes += 1; rows.delete(k); },
  };
}

/** A backend in the shape queue-manager.test.js's PrefetchBackend has: records
    every call, and records WHICH AUDIO the manager asked it to warm. */
class FakeBackend {
  constructor() {
    this.calls = []; this.warmed = []; this.currentTime = 0; this.duration = 3600;
    this.onItemEnded = null; this.onError = null; this.onPrefetchWindow = null;
  }
  async load(item, { startOffset = 0 } = {}) { this.calls.push(`load:${item.id}@${Math.round(startOffset)}`); }
  play() { this.calls.push("play"); }
  pause() { this.calls.push("pause"); }
  seek(s) { this.calls.push(`seek:${Math.round(s)}`); }
  setOutPoint(s) { this.calls.push(`outPoint:${s == null ? "null" : Math.round(s)}`); }
  setRate(r) { this.calls.push(`rate:${r}`); }
  release() { this.calls.push("release"); }
  prefetch(item, { startOffset = 0 } = {}) {
    this.calls.push(`prefetch:${item.id}@${Math.round(startOffset)}`);
    this.warmed.push(item.audio_url);
    return true;
  }
  openPrefetchWindow() { if (this.onPrefetchWindow) this.onPrefetchWindow(); }
}
const INSTANT = {
  nowMs: () => 0,
  schedule: (_ms, fn) => { let dead = false; queueMicrotask(() => { if (!dead) fn(); }); return () => { dead = true; }; },
};

/* ---------- the mount ---------- */

/**
 * Mount app.js and boot it for real.
 *
 * @param {object} [opts]
 * @param {object} [opts.remote]    URL -> document, for the live origin; mutable
 * @param {"never"|"reject"|null} [opts.remoteMode]  a pointer that never answers,
 *   or an origin that throws, for every remote URL
 * @param {object|null} [opts.localPointer]  what `data/forays-directory.json`
 *   answers from the "bundle"; null = 404, which is today's shell
 * @param {object|null} [opts.cacheSet]  a set pre-written to the fake IndexedDB
 * @param {boolean} [opts.emptySeed]  404 the three bundled Foray files (FD-04)
 * @param {object} [opts.localStorageItems]  `cp_` keys already on the device
 *   before app.js runs, as values (JSON-encoded the way lsSet writes them)
 * @param {string} [opts.hash]  the route to boot on
 */
process.on("unhandledRejection", () => {});

async function mount({
  remote = {}, remoteMode = null, localPointer = null, cacheSet = null,
  emptySeed = false, hash = "#/forays", appSrc = APP_SRC, localStorageItems = {},
} = {}) {
  const { dir, resolve, progress, diag, qm } = await mods;
  const fetched = [];
  const pending = [];
  const body = new El("body");
  for (const id of ["view", "drawer", "drawer-overlay", "drawer-playlists",
    "family-toggle", "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn",
    "banner-slot", "pl-form", "pl-input", "pl-note",
    "tab-topics", "tab-shows", "sh-form", "sh-input", "sh-note", "sh-results",
    "browse-all-link", "pl-remove", "banner-done"]) {
    const el = new El("div"); el.id = id; body.append(el);
  }
  const response = (obj, ok = true, status = 200) => {
    const bytes = enc(obj);
    return {
      ok, status,
      json: async () => JSON.parse(JSON.stringify(obj)),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  const fetchFn = async (url) => {
    const u = String(url).split("?")[0];
    fetched.push(u);
    if (/^https?:/.test(u)) {
      if (remoteMode === "never") { const p = new Promise(() => {}); pending.push(u); return p; }
      if (remoteMode === "reject") throw new TypeError("network down");
      const doc = harness.remote[u];
      return doc === undefined ? response({}, false, 404) : response(doc);
    }
    if (u === POINTER) return localPointer ? response(localPointer) : response({}, false, 404);
    if (emptySeed && /^data\/(forays|segments|segment-sources)\.json$/.test(u)) return response({}, false, 404);
    const file = path.join(ROOT, u);
    if (!fs.existsSync(file)) return response({}, false, 404);
    return response(JSON.parse(fs.readFileSync(file, "utf8")));
  };

  const docListeners = new Map();
  const document = {
    body, documentElement: body, readyState: "complete", hidden: false,
    addEventListener(t, fn) { if (!docListeners.has(t)) docListeners.set(t, new Set()); docListeners.get(t).add(fn); },
    removeEventListener(t, fn) { docListeners.get(t)?.delete(fn); },
    fire(t) { for (const fn of [...(docListeners.get(t) ?? [])]) fn(); },
    createElement: (t) => new El(t),
    querySelector: (s) => findIn(body, s),
    querySelectorAll: (s) => findAllIn(body, s),
  };
  const location = { hash, search: "", pathname: "/", href: "capacitor://localhost/", protocol: "capacitor:", reloads: 0, reload() { this.reloads += 1; } };
  const events = [];
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: fetchFn,
    localStorage: new FakeStorage(),
    forayEventLog: { rows: events, append(row) { events.push(row); }, async unsynced() { return events; }, async markSynced() {}, async pruneToRetention() {}, health() { return { ok: true }; } },
    document, location,
    navigator: { userAgent: "node" },
    history: { replaceState() {}, pushState() {}, back() {} },
    addEventListener() {}, removeEventListener() {},
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, queueMicrotask,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  for (const [k, v] of Object.entries(localStorageItems)) ctx.localStorage.setItem(k, JSON.stringify(v));
  vm.createContext(ctx);

  /* The real field record, over a Storage of its own. */
  const diagStorage = new FakeStorage();
  const log = new diag.DiagnosticLog({ storage: diagStorage });
  const pd = new diag.PlayerDiagnostics({ log });
  /* The real directory, over the fake origin, the fake tier and node's crypto. */
  const tier = fakeTier();
  if (cacheSet) tier.rows.set(dir.CACHE_KEY, dir.serializeSet(cacheSet));
  const directory = dir.createForayDirectory({
    fetch: fetchFn, cache: tier, subtle: webcrypto.subtle, onEvent: (f) => pd.dataSource(f),
    minRefreshIntervalMs: 0, cacheWaitMs: 500, pointerTimeoutMs: 2000, filesTimeoutMs: 2000,
  });
  /* The real resume store and the real queue manager behind a bridge that
     answers exactly the calls the Foray surfaces make. */
  const progressStore = new progress.ForayProgressStore({ storage: new FakeStorage() });
  const backend = new FakeBackend();
  qm.__resetInstanceForTests();
  const manager = new qm.PlayerQueueManager({ backend, telemetry: () => {}, scheduler: INSTANT });
  let live = null;
  const playCalls = [];
  const bridge = {
    resolve(foraysDoc, { id, segmentsDoc, sourcesDoc, unlocked = [] } = {}) {
      const doc = resolve.findForay(foraysDoc, id, { unlocked });
      return doc ? resolve.resolveForay(doc, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc) }) : null;
    },
    /* `showDrafts` passed through as player/client.js passes it (#631), so the
       founder's switch reaches the resolver here too (F-92). */
    listForays: (doc, { unlocked = [], showDrafts = false } = {}) => resolve.listableForays(doc, { unlocked, showDrafts }),
    foraysUsingShow: (doc, names, { segmentsDoc, sourcesDoc, unlocked = [] } = {}) =>
      resolve.foraysReferencingShow(doc, names, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc), unlocked }),
    fmtClock: resolve.fmtClock, fmtSpan: resolve.fmtSpan, itemLen: () => 1,
    forayResume(forayId, { totalSec = null, itemCount = null, resolved = null, present = true } = {}) {
      const record = progressStore.get(forayId);
      const segments = resolved ? resolve.progressSegments(resolved) : null;
      const point = progress.resumePoint(record, { totalSec, maxIndex: itemCount ? itemCount - 1 : null, segments, present });
      return point && !point.finished ? { ...point, title: record.title, clock: resolve.fmtClock(point.elapsedSec), label: progress.remainingLabel(point.remainingSec) } : null;
    },
    forayDriftIsClean: (p) => !p || ["exact", "unverified", "unanchored"].includes(p.drift),
    forayResumeList({ foraysDoc = null } = {}) {
      const liveIds = foraysDoc ? new Set(resolve.allForays(foraysDoc).map((f) => f.id)) : null;
      return progressStore.list().map((r) => {
        const present = liveIds ? liveIds.has(r.foray_id) : true;
        const point = progress.resumePoint(r, { present });
        return {
          id: r.foray_id, title: r.title, updated_at: r.updated_at, elapsedSec: r.elapsed_sec, totalSec: r.total_sec,
          index: r.index, percent: progress.percentDone(r.elapsed_sec, r.total_sec),
          finished: Boolean(point?.finished), label: point && !point.finished ? progress.remainingLabel(point.remainingSec) : "",
          drift: present ? (point?.drift ?? progress.DRIFT_UNVERIFIED) : progress.DRIFT_DROPPED,
        };
      });
    },
    clearForayResume: (id) => progressStore.clear(id),
    async playForay(resolved, { startIndex = 0, onChange } = {}) {
      playCalls.push(resolved.id);
      const report = manager.setQueueFromForay(resolved.hydrated, { resolveItem: (id) => resolved.sources.get(id) ?? null });
      await manager.play(startIndex);
      live = { forayId: resolved.id, index: manager.currentIndex, playing: true, ended: false, elapsedSec: 0, rate: 1 };
      if (onChange) onChange(live);
      return report;
    },
    watchForay: () => live,
    forayToggle() {}, forayNext() {}, forayPrevious() {}, forayJump() {}, foraySeek() {},
    onEpisodeEnded() {}, stopForDataDeletion() {}, listVoices: () => [],
    canPlay: () => false, segmentAt: (items, at) => resolve.segmentAtElapsed(items, at),
  };
  const harness = { ctx, body, document, location, fetched, pending, remote, tier, directory, log, pd, progressStore, backend, manager, bridge, playCalls };

  vm.runInContext(appSrc, ctx, { filename: "app.js" });
  ctx.window.ForayPlayer = bridge;
  ctx.window.forayDirectory = directory;
  ctx.window.forayNoteDataSource = (f) => { pd.dataSource(f); return true; };

  for (let i = 0; i < 200 && !vm.runInContext("state.ready", ctx); i++) await tick();
  assert.ok(vm.runInContext("state.ready", ctx), "the page never booted");
  harness.state = () => vm.runInContext("state", ctx);
  harness.view = () => findIn(body, "#view").innerHTML;
  harness.report = () => diag.formatDiagnosticReport(log.read());
  harness.dataLines = () => harness.report().split("\n").filter((l) => /\bdata\s/.test(l));
  harness.ids = () => vm.runInContext("forayCards()", ctx).map((f) => f.id);
  harness.refresh = (why = "test") => vm.runInContext("refreshForayDirectory", ctx)(why);
  harness.route = (h) => { location.hash = h; vm.runInContext("route", ctx)(); };
  harness.settle = async (n = 30) => { for (let i = 0; i < n; i++) await tick(); };
  return harness;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/* Wait for the boot refresh (fired after route()) to reach an outcome. */
async function bootRefreshDone(h) {
  for (let i = 0; i < 200; i++) {
    if (h.directory.describe().last) return;
    await tick();
  }
}

const SEED_IDS = () => BASE().forays.forays.map((f) => f.id);

/* ==================================================================== */
/* FD-03: boot, adopt, refuse, keep                                     */
/* ==================================================================== */

test("with no cache and no reachable origin, the page boots from the bundled seed", async () => {
  const h = await mount({ remoteMode: "reject" });
  await bootRefreshDone(h);
  const ids = h.ids().filter((id) => SEED_IDS().includes(id));
  assert.ok(ids.length >= 1, "the seed's listable Forays are on the page");
  assert.deepStrictEqual(h.state().forays.forays.map((f) => f.id), SEED_IDS());
  assert.strictEqual(h.directory.describe().source, "bundle");
  assert.strictEqual(h.directory.describe().last.status, "offline");
  assert.strictEqual(h.tier.removes, 0);
});

test("a newer pointer + valid files: the new Foray is rendered WITHOUT a reload", async () => {
  /* THE CARD'S FIRST DONE-WHEN. The origin serves a pointer at a version the seed
     has never heard of, and files that carry one more Foray. After the boot
     refresh the list page shows it, `state` holds it, the cache holds it, and
     `location.reload` was never called.
     MUTATION 1: drop `applyForaySet(out.set)` in refreshForayDirectory — the
     state assertion goes red. MUTATION 2: drop `renderCurrentPage()` there —
     the DOM assertion goes red while the state one passes. */
  const next = withNewForay(BASE());
  const ptr = await pointerFor(next, "deploy-b2");
  const h = await mount({ remote: routesFor(ptr, next) });
  await bootRefreshDone(h);
  await h.settle();
  assert.strictEqual(h.directory.describe().last.status, "adopted");
  assert.ok(h.state().forays.forays.some((f) => f.id === "fd-new-1"), "state holds the new Foray");
  assert.ok(h.state().segments.segments.some((s) => s.id === "fd-new-1-s1"), "and its segments");
  assert.ok(h.state().segmentSources.sources.some((s) => s.id === "fd-new-1-ep-a"), "and its sources");
  assert.match(h.view(), /A Foray that arrived by directory/, "the list page repainted with it");
  assert.strictEqual(h.location.reloads, 0);
  assert.strictEqual(h.tier.writes, 1, "the set is cached durably");
  /* And it plays: the resolver joins it out of the swapped state. */
  const r = h.bridge.resolve(h.state().forays, { id: "fd-new-1", segmentsDoc: h.state().segments, sourcesDoc: h.state().segmentSources });
  assert.strictEqual(r.playable.length, 2);
});

test("an invalid set is refused: the old one is kept and the reason is recorded", async () => {
  /* THE SECOND DONE-WHEN. One Foray in the candidate references a segment the
     candidate's segments.json does not carry — the torn-deploy signature.
     MUTATION: delete the `if (!check.ok)` block in foray-directory.js `run()`.
     The torn set lands in state and every assertion below goes red. */
  const bad = withNewForay(BASE(), { id: "fd-broken" });
  bad.segments.segments = bad.segments.segments.filter((s) => s.id !== "fd-broken-s2");
  const ptr = await pointerFor(bad, "deploy-bad");
  const h = await mount({ remote: routesFor(ptr, bad) });
  await bootRefreshDone(h);
  await h.settle();
  assert.strictEqual(h.directory.describe().last.status, "invalid");
  assert.deepStrictEqual(h.state().forays.forays.map((f) => f.id), SEED_IDS(), "state still holds the seed");
  assert.ok(!h.view().includes("fd-broken"));
  assert.strictEqual(h.tier.writes, 0, "nothing invalid reaches the cache");
  const line = h.dataLines().find((l) => /refresh\(boot\)/.test(l));
  assert.ok(line, `no refresh row in:\n${h.report()}`);
  assert.match(line, /invalid/);
  assert.match(line, /why=segment-missing/);
  assert.match(line, /foray=fd-broken/);
});

test("network down: the page boots from the cache, and the cache is not dropped for the failure", async () => {
  /* THE THIRD DONE-WHEN, cache half. A set from an earlier run sits in IndexedDB;
     the origin throws. The page paints the cached Foray, and the row stays.
     MUTATION: in foray-directory.js's `offline` path, add `cache.remove(CACHE_KEY)`.
     `tier.removes` becomes 1 and the last assertion is red. */
  const cached = { ...withNewForay(BASE(), { id: "fd-cached-1" }), version: "deploy-c9", built_at: "2026-09-09T00:00:00Z" };
  const h = await mount({ remoteMode: "reject", cacheSet: cached });
  await bootRefreshDone(h);
  assert.ok(h.state().forays.forays.some((f) => f.id === "fd-cached-1"), "the cached set is what booted");
  assert.match(h.view(), /A Foray that arrived by directory/);
  assert.strictEqual(h.directory.describe().source, "cache");
  assert.strictEqual(h.directory.describe().last.status, "offline");
  assert.strictEqual(h.tier.removes, 0);
  assert.ok(h.tier.rows.has("set"));
});

test("network down with no cache: the bundle, and nothing else changes", async () => {
  /* The bundle half of the third done-when. */
  const h = await mount({ remoteMode: "reject" });
  await bootRefreshDone(h);
  assert.strictEqual(h.directory.describe().source, "bundle");
  assert.deepStrictEqual(h.state().forays.forays.map((f) => f.id), SEED_IDS());
  assert.strictEqual(h.tier.writes, 0);
});

test("first paint never waits on the network", async () => {
  /* THE ORDER, asserted. The origin's pointer request is issued and NEVER
     answers; the page is painted anyway, with the request still pending.
     MUTATION: move `refreshForayDirectory("boot")` above `route()` in init() and
     `await` it. `state.ready` never flips and mount() fails its own assertion. */
  const h = await mount({ remoteMode: "never" });
  assert.ok(h.state().ready);
  assert.match(h.view(), /Forays/, "the list page is on screen");
  assert.ok(h.pending.includes(`${ORIGIN}/${POINTER}`), "the pointer WAS requested…");
  assert.strictEqual(h.directory.describe().last, null, "…and has not answered");
  assert.strictEqual(h.directory.describe().source, "bundle");
});

test("a pinned page (the web's stale-shell) neither boots from the cache nor refreshes", async () => {
  /* #233's pin means "this page is running last-known code against its own
     generation on purpose". Swapping a fresher set under it would rebuild the
     exact mismatched pair the pin prevents. MUTATION: drop `!pinnedDeployId`
     from refreshForayDirectory's guard. The remote pointer is fetched and the
     first assertion is red. */
  const cached = { ...withNewForay(BASE(), { id: "fd-cached-1" }), version: "deploy-c9" };
  const next = withNewForay(BASE());
  const ptr = await pointerFor(next, "deploy-b2");
  /* Pin BEFORE app.js runs, the way sw.js does it: a statement prepended to the
     file's own bytes. */
  const h = await mount({
    remote: routesFor(ptr, next), cacheSet: cached,
    appSrc: `self.__forayPinnedDeployId = "gen-77";\n${APP_SRC}`,
  });
  await h.settle(40);
  assert.ok(!h.fetched.some((u) => u.startsWith(ORIGIN)), `a pinned page fetched from the origin: ${h.fetched.join(", ")}`);
  assert.deepStrictEqual(h.state().forays.forays.map((f) => f.id), SEED_IDS(), "the pinned generation's data stands");
  const line = h.dataLines().find((l) => /\bboot\b/.test(l));
  assert.match(line, /source=sw-cache/);
  assert.match(line, /forays=sw-cache@gen-77/);
});

/* ==================================================================== */
/* FD-04: the seed is a seed                                             */
/* ==================================================================== */

test("FD-04: the shell boots with an EMPTY seed, and a directory set then fills it", async () => {
  /* The bundle's three files 404 (a package built with none of them). The page
     still paints — "No forays right now" — and the first refresh brings the
     directory in. MUTATION: in bootForayDirectory, throw when `held.valid` is
     false. mount() fails its boot assertion. */
  const next = withNewForay(BASE());
  const ptr = await pointerFor(next, "deploy-b2");
  const h = await mount({ remote: routesFor(ptr, next), emptySeed: true });
  assert.ok(h.state().ready);
  assert.strictEqual(h.state().forays, null, "the seed really was empty");
  await bootRefreshDone(h);
  await h.settle();
  assert.strictEqual(h.directory.describe().last.status, "adopted");
  assert.ok(h.state().forays.forays.some((f) => f.id === "fd-new-1"));
  assert.match(h.view(), /A Foray that arrived by directory/);
});

test("F-92: a fresh install whose seed pointer names the LIVE version still fetches the set once, and the switch then lists the generated draft", async () => {
  /* THE SEED LEAVES GENERATED DRAFTS TO THE DIRECTORY (tools/mobile/prepare-webdir.mjs
     `seedCarries`), and a package built from the same commit as the live site holds
     that subset at the live version. Before F-92 a version match was `current` and
     nothing was fetched — so with the founder's switch on, the phone would list no
     generated draft until the next deploy moved the version. The bundled pointer
     now carries `partial: true` (`seedPointerDoc`) and the directory treats a
     partial held set as "fetch whole, once".
     MUTATION: in player/foray-directory.js `run()`, drop `held.partial !== true`
     from the `current` early return. The refresh answers `current`, state never
     holds `fd-gen-draft-1`, and the page never lists it. */
  const next = withNewForay(BASE(), { id: "fd-gen-draft-1", status: "draft", generated: true });
  const ptr = await pointerFor(next, "deploy-live");
  /* The pointer as prepare-webdir writes it into the bundle: the deploy's own, plus the flag. */
  const seedPointer = { version: ptr.version, built_at: ptr.built_at, files: ptr.files, partial: true };
  const h = await mount({
    remote: routesFor(ptr, next), localPointer: seedPointer, localStorageItems: { cp_show_drafts: true },
  });
  assert.strictEqual(h.directory.describe().version, "deploy-live", "the seed booted at the live version");
  await bootRefreshDone(h);
  await h.settle();
  assert.strictEqual(h.directory.describe().last.status, "adopted", "a partial seed at the live version is fetched whole");
  assert.ok(h.state().forays.forays.some((f) => f.id === "fd-gen-draft-1"), "state holds the generated draft");
  assert.ok(h.ids().includes("fd-gen-draft-1"), "and the switch lists it");
  assert.strictEqual(h.tier.writes, 1, "the whole set is cached");
  assert.strictEqual(h.location.reloads, 0);

  /* THE CONTROL: the same package under an unmarked pointer is `current` at once —
     the pre-F-92 answer, and still right for a seed that IS the whole set. */
  const { partial: _partial, ...unmarked } = seedPointer;
  const c = await mount({
    remote: routesFor(ptr, next), localPointer: unmarked, localStorageItems: { cp_show_drafts: true },
  });
  await bootRefreshDone(c);
  await c.settle();
  assert.strictEqual(c.directory.describe().last.status, "current");
  assert.ok(!c.state().forays.forays.some((f) => f.id === "fd-gen-draft-1"));
  assert.ok(!c.ids().includes("fd-gen-draft-1"));
  assert.strictEqual(c.tier.writes, 0);
});

/* ==================================================================== */
/* FD-01: the row                                                        */
/* ==================================================================== */

test("FD-01: a boot row names the source of each data file, and the deploy id it carries", async () => {
  /* THE BEFORE-NUMBER. With today's shell — no bundled pointer — the row says
     `bundle@unknown` for all three; with a bundled pointer it says the id.
     MUTATION: delete the `noteDataSource({ phase: "boot", … })` call in
     bootForayDirectory. No boot row; red. */
  const h = await mount({ remoteMode: "reject" });
  const line = h.dataLines().find((l) => /\bboot\b/.test(l));
  assert.ok(line, `no boot row in:\n${h.report()}`);
  assert.match(line, /source=bundle/);
  assert.match(line, /forays=bundle@unknown/);
  assert.match(line, /segments=bundle@unknown/);
  assert.match(line, /sources=bundle@unknown/);
  assert.match(line, new RegExp(`n=${SEED_FORAY_COUNT}(?!\\d)`)); // the seed's own Foray count, not a literal

  const local = { version: "seed-9fc92a61", built_at: "2026-09-10T00:00:00Z", files: { forays: "a", segments: "b", sources: "c" } };
  const h2 = await mount({ remoteMode: "reject", localPointer: local });
  const line2 = h2.dataLines().find((l) => /\bboot\b/.test(l));
  assert.match(line2, /forays=bundle@seed-9fc92a61/);
  assert.match(line2, /v=seed-9fc92a61/);

  /* And the row is in the durable record, not only in memory. */
  const raw = JSON.parse(h.log.storage.getItem("cp_diag"));
  assert.ok(raw.entries.some((e) => e.type === "data" && e.phase === "boot"));
});

test("FD-01: the refresh row names the trigger and the outcome, and the adopted row names the files' new source", async () => {
  const next = withNewForay(BASE());
  const ptr = await pointerFor(next, "deploy-b2");
  const h = await mount({ remote: routesFor(ptr, next) });
  await bootRefreshDone(h);
  await h.settle();
  const line = h.dataLines().find((l) => /refresh\(boot\)/.test(l));
  assert.ok(line, `no refresh row in:\n${h.report()}`);
  assert.match(line, /adopted/);
  assert.match(line, /v=deploy-b2/);
  assert.match(line, /forays=network@deploy-b2/);
  assert.match(line, new RegExp(`n=${SEED_FORAY_COUNT + 1}(?!\\d)`)); // seed + the one Foray the fixture adds
  /* A foreground return records its own attempt, under its own trigger. */
  h.document.fire("visibilitychange");
  await h.settle(40);
  assert.ok(h.dataLines().some((l) => /refresh\(foreground\)/.test(l) && /current/.test(l)),
    `no foreground row in:\n${h.report()}`);
});

/* ==================================================================== */
/* FD-05: playback survives a directory change                           */
/* ==================================================================== */

const PLAYING = "capital-types-1";   // published on main; listable without an unlock

test("FD-05 (1): a version swap mid-session does not move the playhead or drop the queue", async () => {
  /* The listener is 150 s into segment 1 of a Foray when a newer directory
     arrives that still carries it. The page repaints; the queue manager and the
     backend hear NOTHING — no load, no seek, no pause — and the resume row still
     reconciles `exact` against the new order.
     MUTATION: in refreshForayDirectory, call `window.ForayPlayer.playForay(...)`
     after the swap (the "reload the Foray" instinct). The backend's calls grow,
     red. */
  const h = await mount({ remote: {}, hash: `#/foray/${PLAYING}` });
  await bootRefreshDone(h);
  assert.match(h.view(), /fy-play/, "the Foray page painted");
  await findIn(h.body, "#fy-play").click();
  await h.settle();
  assert.deepStrictEqual(h.playCalls, [PLAYING]);
  assert.strictEqual(h.state().forayPlaying, PLAYING);
  h.backend.currentTime = 150;
  const callsBefore = h.backend.calls.slice();
  const indexBefore = h.manager.currentIndex;
  /* A resume row written where the listener is, in the seed's order: 30 s into
     the first segment (segments are ~90 s, so this stays inside it). */
  const r0 = h.bridge.resolve(h.state().forays, { id: PLAYING, segmentsDoc: h.state().segments, sourcesDoc: h.state().segmentSources });
  const { resolve } = await mods;
  const first = r0.entries.find((e) => e.playable && e.segment_id);
  const at = resolve.segmentStarts(r0.playable)[first.queueIndex] + 30;
  h.progressStore.save({ forayId: PLAYING, title: r0.title, elapsedSec: at, totalSec: r0.totalSec, index: first.queueIndex, segmentId: first.segment_id, intoSec: 30, force: true });

  const next = withNewForay(BASE());
  const ptr = await pointerFor(next, "deploy-b2");
  Object.assign(h.remote, routesFor(ptr, next));
  const out = await h.refresh("foreground");
  assert.strictEqual(out.status, "adopted");
  await h.settle();

  assert.deepStrictEqual(h.backend.calls, callsBefore, "the backend heard nothing about the swap");
  assert.strictEqual(h.backend.currentTime, 150, "the playhead did not move");
  assert.strictEqual(h.manager.currentIndex, indexBefore, "the queue is where it was");
  assert.strictEqual(h.state().forayPlaying, PLAYING, "the page still knows what is playing");
  assert.deepStrictEqual(h.playCalls, [PLAYING], "nothing re-started the Foray");
  const r1 = h.bridge.resolve(h.state().forays, { id: PLAYING, segmentsDoc: h.state().segments, sourcesDoc: h.state().segmentSources });
  const point = h.bridge.forayResume(PLAYING, { resolved: r1, totalSec: r1.totalSec, itemCount: r1.playable.length });
  assert.strictEqual(point.drift, "exact");
  assert.strictEqual(Math.round(point.elapsedSec), Math.round(at));
});

test("FD-05 (2): a Foray that disappeared reads DRIFT_DROPPED; the page says so and nothing crashes", async () => {
  /* Same listener, but the newer directory no longer carries the Foray they are
     inside. The audio keeps going (the queue is untouched), the page says the
     Foray is not available, the resume row reads `dropped`, and the rail does not
     offer it.
     MUTATION 1: in foray-progress.js's reconcileSegment, drop the `present === false`
     return. The row reads `unverified` and the drift assertion is red.
     MUTATION 2: in forayResumeRows, drop `p.drift !== "dropped"` AND the visible
     filter. The rail offers a Foray that cannot be opened; red. */
  const h = await mount({ remote: {}, hash: `#/foray/${PLAYING}` });
  await bootRefreshDone(h);
  await findIn(h.body, "#fy-play").click();
  await h.settle();
  const r0 = h.bridge.resolve(h.state().forays, { id: PLAYING, segmentsDoc: h.state().segments, sourcesDoc: h.state().segmentSources });
  h.progressStore.save({ forayId: PLAYING, title: r0.title, elapsedSec: 600, totalSec: r0.totalSec, index: 3, segmentId: r0.entries[3].segment_id, intoSec: 20, force: true });
  const callsBefore = h.backend.calls.slice();

  const without = withNewForay(BASE());
  without.forays.forays = without.forays.forays.filter((f) => f.id !== PLAYING);
  const ptr = await pointerFor(without, "deploy-gone");
  Object.assign(h.remote, routesFor(ptr, without));
  const out = await h.refresh("foreground");
  assert.strictEqual(out.status, "adopted");
  await h.settle();

  assert.match(h.view(), /isn't available/, "the page says so rather than throwing");
  assert.deepStrictEqual(h.backend.calls, callsBefore, "the audio was not touched");
  const rows = h.bridge.forayResumeList({ foraysDoc: h.state().forays });
  const row = rows.find((p) => p.id === PLAYING);
  assert.ok(row, "the row itself is kept — a directory change is not a reason to forget a listener");
  assert.strictEqual(row.drift, "dropped");
  assert.strictEqual(h.bridge.forayResume(PLAYING, { present: false }).drift, "dropped");
  const offered = vm.runInContext("forayResumeRows()", h.ctx).map((p) => p.id);
  assert.ok(!offered.includes(PLAYING), `the rail offered a vanished Foray: ${offered.join(", ")}`);
});

test("FD-05 (3): the seam prefetch never warms audio from a set that was never validated", async () => {
  /* The candidate carries the SAME Foray with NEW audio URLs (a re-hosted
     episode) and a second Foray that is torn. The set as a whole is refused, so
     when the listener presses play again the queue is built from the held set and
     the prefetch window warms the held set's audio — never the candidate's.
     MUTATION: delete the `if (!check.ok)` block in foray-directory.js `run()`.
     The candidate is adopted, the re-resolve carries `cdn.candidate.test`, and
     the last assertion is red. */
  const h = await mount({ remote: {}, hash: `#/foray/${PLAYING}` });
  await bootRefreshDone(h);
  /* The queue is built from `state`, the way the page builds it. Started on a
     tape segment whose NEXT item is also tape: a seam into a narration bridge
     gets no beat and therefore no prefetch (seam-gap.js), and this test is about
     what IS warmed. */
  const fromState = () => h.bridge.resolve(h.state().forays, { id: PLAYING, segmentsDoc: h.state().segments, sourcesDoc: h.state().segmentSources });
  const tapeSeam = (r) => r.playable.findIndex((it, i) => it.kind === "episode" && r.playable[i + 1]?.kind === "episode");
  const r0 = fromState();
  const i0 = tapeSeam(r0);
  assert.ok(i0 >= 0, "the fixture Foray has a tape-to-tape seam");
  await h.bridge.playForay(r0, { startIndex: i0 });
  await h.settle();
  h.backend.openPrefetchWindow();
  await h.settle();
  const heldUrls = new Set(h.state().segmentSources.sources.map((s) => s.audio_url));
  assert.ok(h.backend.warmed.length >= 1, "the window warmed the next segment");
  assert.ok(h.backend.warmed.every((u) => heldUrls.has(u)));

  const candidate = withNewForay(BASE(), { id: "fd-broken" });
  for (const s of candidate.sources.sources) s.audio_url = `https://cdn.candidate.test/${s.id}.mp3`;
  candidate.segments.segments = candidate.segments.segments.filter((s) => s.id !== "fd-broken-s2");
  const ptr = await pointerFor(candidate, "deploy-cand");
  Object.assign(h.remote, routesFor(ptr, candidate));
  const out = await h.refresh("foreground");
  assert.strictEqual(out.status, "invalid");
  await h.settle();

  /* Press play again: the queue is rebuilt from `state`, which still holds the
     seed — so the URLs the candidate carried for this same Foray never reach the
     backend. */
  const r1 = fromState();
  await h.bridge.playForay(r1, { startIndex: tapeSeam(r1) });
  await h.settle();
  h.backend.openPrefetchWindow();
  await h.settle();
  assert.ok(h.backend.warmed.length >= 2, "the second window warmed something too");
  assert.ok(h.backend.warmed.every((u) => heldUrls.has(u)), `warmed: ${h.backend.warmed.join(", ")}`);
  assert.ok(h.backend.warmed.every((u) => !u.includes("cdn.candidate.test")));
  /* Re-resolving the same Foray from `state` produced the SAME audio as before —
     the candidate's re-hosted URLs never reached the join. */
  assert.deepStrictEqual(
    r1.playable.map((it) => it.audio_url), r0.playable.map((it) => it.audio_url),
  );
});

/* ==================================================================== */
/* the wiring, at the source                                             */
/* ==================================================================== */

test("player/client.js builds the directory and publishes it, and app.js reads it from init()", () => {
  /* The tts-bridge lesson (test/suite-integrity.test.js): a feature can be
     complete and tested and never wired. MUTATION: delete `window.forayDirectory =
     directory` from client.js, or `bootForayDirectory(directory)` from init(). Red. */
  const client = fs.readFileSync(path.join(ROOT, "player", "client.js"), "utf8");
  assert.match(client, /createForayDirectory\(\{/);
  assert.match(client, /window\.forayDirectory = directory/);
  assert.match(client, /window\.forayNoteDataSource = /);
  const src = APP_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
  const init = src.slice(src.indexOf("async function init()"), src.indexOf("bindDiagnosticsControl();"));
  assert.ok(init.length > 500, "init() has to be found");
  const boot = init.indexOf("await bootForayDirectory(directory)");
  const paint = init.indexOf("route();");
  const refresh = init.indexOf('refreshForayDirectory("boot")');
  assert.ok(boot > 0 && paint > boot, "the boot choice comes before the first paint");
  assert.ok(refresh > paint, "the network refresh comes after the first paint");
  assert.ok(!/await\s+refreshForayDirectory/.test(init), "and is never awaited by init()");
  assert.match(init, /visibilitychange/);
});
