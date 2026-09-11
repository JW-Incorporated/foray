/* "Show draft Forays" — the founder's test-track switch (2026-09-11).
 *
 * Wyatt: "I can't see these forays in the app, please fix that." "These" are
 * the generated Forays, which land in data/forays.json as `status: "draft"`
 * with `generated: true`, and the visitor rule in player/foray-resolve.js hides
 * a draft from anyone who did not arrive via `?foray=<id>`. Nothing about that
 * rule changed, and no Foray's status changed (tools/foray/check-forays.test.mjs
 * still pins exactly one published). What this suite pins is the SWITCH:
 *
 *   OFF (the default, `cp_show_drafts` absent or false)
 *     - every surface renders byte-for-byte what it rendered before the switch
 *       existed: the app with `showDraftsOn()` stubbed to `false`, and the app
 *       over a bridge that has never heard of `showDrafts`, produce the same
 *       HTML on #/forays, on Home and on a show page's Foray rows
 *     - the listed set is exactly the published set in the data, and no draft
 *       title appears anywhere
 *   ON
 *     - #/forays (the Library tab's Foray list) lists every draft with the
 *       "draft" kicker, generated ones newest first, after the published ones
 *     - Home's "Forays for you" carries every draft as a badged card after the
 *       ordinary picks, and Home carries the one-line notice
 *     - a show page's "Used in the following forays" rows name a draft that
 *       draws on the show, with the draft marker
 *     - a generated draft opens at #/foray/<id> and PLAYS through the same
 *       `resolve` + `playForay` path the published Foray uses
 *   EITHER WAY
 *     - the `?foray=<id>` unlock behaves exactly as it did
 *   THE DRAWER
 *     - the toggle exists, reads its state, flips the key, re-renders the page
 *       behind the drawer and does NOT close the drawer
 *
 * MUTATIONS, each run and seen red (named again at the test it kills):
 *   M1  `listableForays` returns `allForays(doc)` unfiltered -> "switch off" red
 *   M2  `showDraftsOn()` returns `true` -> "switch off" and "byte-identical" red
 *   M3  drop `showDrafts` from `forayViewOpts()` -> "opens and plays" red (the
 *       list advertises a page that answers "isn't available")
 *   M4  `draftTrackOrder` returns `drafts` as-is -> "newest first" red
 *   M5  `bindDraftsControl` calls `route()` instead of `renderCurrentPage()` ->
 *       "does not close the drawer" red
 *   M6  drop `testTrackNoticeHtml()` from renderHomeV2 -> "Home notice" red
 *
 * Harness: the REAL app.js in a node:vm over a hand-rolled DOM whose innerHTML
 * grows a child per `id="…"`, driven by the REAL player/foray-resolve.js through
 * a bridge in the shape player/client.js exports, over the REAL data files.
 * Deterministic Math.random so two mounts paint the same Home. Own harness,
 * not shared with the other suites that mount app.js, on purpose.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const readData = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const mods = (async () => ({ resolve: await import("../player/foray-resolve.js") }))();

/* ---------- the data, read rather than pinned ---------- */

const FORAYS = readData("data/forays.json").forays;
const PUBLISHED_IDS = FORAYS.filter((f) => f.status === "published").map((f) => f.id);
const DRAFTS = FORAYS.filter((f) => f.status === "draft");
const GENERATED_DRAFTS = DRAFTS.filter((f) => f.generated === true);
/** Newest first: the generator appends, so the file's order is arrival order. */
const GENERATED_NEWEST_FIRST = [...GENERATED_DRAFTS].reverse().map((f) => f.id);
const AUTHORED_DRAFT_IDS = DRAFTS.filter((f) => f.generated !== true).map((f) => f.id);
const titleOf = (id) => FORAYS.find((f) => f.id === id).title;

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
    this.type = "";
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
  click() { const out = []; for (const fn of [...(this._on.get("click") ?? [])]) out.push(fn({ target: this, stopPropagation() {}, preventDefault() {} })); return Promise.all(out); }
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
  constructor(seed = {}) { this.map = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)])); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

/** A seeded PRNG so two mounts deal the same Home. */
function seededRandom(seed = 42) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

/* ---------- the mount ---------- */

process.on("unhandledRejection", () => {});

/**
 * @param {object} [opts]
 * @param {object} [opts.seed]      `cp_` keys to pre-store (values JSON-encoded)
 * @param {string} [opts.hash]      the route to boot on
 * @param {string} [opts.search]    e.g. "?foray=<id>"
 * @param {string} [opts.appSrc]    a mutated app.js, for the byte-identical pin
 * @param {boolean} [opts.legacyBridge]  a bridge that has never heard of `showDrafts`
 */
async function mount({ seed = {}, hash = "#/forays", search = "", appSrc = APP_SRC, legacyBridge = false } = {}) {
  const { resolve } = await mods;
  const body = new El("body");
  for (const id of ["view", "drawer", "drawer-overlay", "drawer-playlists",
    "family-toggle", "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn",
    "banner-slot", "pl-form", "pl-input", "pl-note",
    "tab-topics", "tab-shows", "sh-form", "sh-input", "sh-note", "sh-results",
    "browse-all-link", "pl-remove", "banner-done"]) {
    const el = new El("div"); el.id = id; body.append(el);
  }
  const fetchFn = async (url) => {
    const u = String(url).split("?")[0];
    if (/^https?:/.test(u)) throw new TypeError("network down");
    const file = path.join(ROOT, u);
    if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
  };
  const docListeners = new Map();
  const document = {
    body, documentElement: body, readyState: "complete", hidden: false,
    addEventListener(t, fn) { if (!docListeners.has(t)) docListeners.set(t, new Set()); docListeners.get(t).add(fn); },
    removeEventListener(t, fn) { docListeners.get(t)?.delete(fn); },
    createElement: (t) => new El(t),
    querySelector: (s) => findIn(body, s),
    querySelectorAll: (s) => findAllIn(body, s),
  };
  const location = { hash, search, pathname: "/", href: "https://x.test/", protocol: "https:", reload() {} };
  const events = [];
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: fetchFn,
    localStorage: new FakeStorage(seed),
    forayEventLog: { rows: events, append(row) { events.push(row); }, async unsynced() { return events; }, async markSynced() {}, async pruneToRetention() {}, health() { return { ok: true }; } },
    document, location,
    navigator: { userAgent: "node" },
    history: { replaceState() {}, pushState() {}, back() {} },
    addEventListener() {}, removeEventListener() {},
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Date, JSON, Promise, clearTimeout, queueMicrotask,
    Math: Object.assign(Object.create(Math), { random: seededRandom() }),
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  /* The bridge, in the shape player/client.js exports: `resolve`/`listForays`/
     `foraysUsingShow` hand their options straight to the REAL resolver, so what
     the page passes is what the rule sees. `legacyBridge` is yesterday's shape —
     it destructures `unlocked` only — for the byte-identical pin. */
  const playCalls = [];
  let live = null;
  const pass = (o) => (legacyBridge ? { unlocked: o.unlocked ?? [] } : { unlocked: o.unlocked ?? [], showDrafts: o.showDrafts ?? false });
  const bridge = {
    resolve(foraysDoc, { id, segmentsDoc, sourcesDoc, ...o } = {}) {
      const doc = resolve.findForay(foraysDoc, id, pass(o));
      return doc ? resolve.resolveForay(doc, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc) }) : null;
    },
    listForays: (doc, o = {}) => resolve.listableForays(doc, pass(o)),
    foraysUsingShow: (doc, names, { segmentsDoc, sourcesDoc, ...o } = {}) =>
      resolve.foraysReferencingShow(doc, names, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc), ...pass(o) }),
    fmtClock: resolve.fmtClock, fmtSpan: resolve.fmtSpan, itemLen: () => 1,
    forayResume: () => null,
    forayDriftIsClean: () => true,
    forayResumeList: () => [],
    clearForayResume() {},
    async playForay(resolved, { startIndex = 0, onChange } = {}) {
      playCalls.push({ id: resolved.id, startIndex, playable: resolved.playable.length });
      live = { forayId: resolved.id, index: startIndex, playing: true, ended: false, elapsedSec: 0, rate: 1 };
      if (onChange) onChange(live);
      return { queued: resolved.playable.length, skipped: [] };
    },
    watchForay: () => live,
    forayToggle() {}, forayNext() {}, forayPrevious() {}, forayJump() {}, foraySeek() {},
    onEpisodeEnded() {}, stopForDataDeletion() {}, listVoices: () => [],
    canPlay: () => false, segmentAt: (items, at) => resolve.segmentAtElapsed(items, at),
  };

  vm.runInContext(appSrc, ctx, { filename: "app.js" });
  ctx.window.ForayPlayer = bridge;

  for (let i = 0; i < 200 && !vm.runInContext("state.ready", ctx); i++) await tick();
  assert.ok(vm.runInContext("state.ready", ctx), "the page never booted");
  const h = { ctx, body, document, location, playCalls, store: ctx.localStorage };
  h.state = () => vm.runInContext("state", ctx);
  h.view = () => findIn(body, "#view").innerHTML;
  h.ids = () => vm.runInContext("forayCards()", ctx).map((f) => f.id);
  h.route = (hh) => { location.hash = hh; vm.runInContext("route", ctx)(); };
  h.settle = async (n = 30) => { for (let i = 0; i < n; i++) await tick(); };
  h.fn = (name) => vm.runInContext(name, ctx);
  /** The show page's Foray rows, as renderShow() prints them. */
  h.showRows = (showId) => h.fn("showForaysHtml")(h.fn("showById")(showId));
  h.drawer = () => findIn(body, "#drawer");
  h.draftsToggle = () => findIn(body, "#drafts-toggle");
  return h;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A show one of the generated drafts draws on, found from the data rather
    than pinned, so a regenerated Foray does not break this suite. */
function showUsedByGeneratedDraft() {
  const seg = new Map(readData("data/segments.json").segments.map((s) => [s.id, s]));
  const src = new Map(readData("data/segment-sources.json").sources.map((s) => [s.id, s]));
  const catalog = readData("data/catalog.json").shows;
  for (const f of GENERATED_DRAFTS) {
    for (const it of f.items) {
      if (it.type !== "segment") continue;
      const s = seg.get(it.segment_id);
      const r = s && src.get(s.item_id);
      const show = r && catalog.find((c) => c.title === r.show);
      if (show) return { show, foray: f };
    }
  }
  return null;
}

const ON = { cp_show_drafts: true };

/* ==================================================================== */
/* The data this suite is about                                         */
/* ==================================================================== */

test("the data holds the founder's case: one published Foray and at least two generated drafts", () => {
  /* Not a rule — a precondition, stated so a green run below cannot be read as
     proving something the data no longer carries. */
  assert.deepStrictEqual(PUBLISHED_IDS, ["capital-types-1"], "check-forays.test.mjs pins this; if it moved, both suites should have");
  assert.ok(GENERATED_DRAFTS.length >= 2, `expected the two generated drafts Wyatt could not see, found ${GENERATED_DRAFTS.length}`);
  for (const f of GENERATED_DRAFTS) assert.strictEqual(f.status, "draft", `${f.id} is not a draft — this suite did not change any status`);
});

/* ==================================================================== */
/* OFF                                                                  */
/* ==================================================================== */

test("switch off (the default): the listed set is exactly the published set, and no draft is named on #/forays, Home or a show page", async () => {
  /* M1: make `listableForays` return `allForays(doc)` — the ids assertion goes
     red. M2: make `showDraftsOn()` return true — every assertion below goes red. */
  const h = await mount();
  assert.deepStrictEqual(h.ids(), PUBLISHED_IDS);
  const forays = h.view();
  assert.ok(forays.includes(titleOf("capital-types-1")), "the published Foray is listed");
  assert.ok(!forays.includes("· draft"), "no draft kicker on #/forays");
  for (const f of DRAFTS) assert.ok(!forays.includes(f.title), `${f.id} must not be named on #/forays`);

  h.route("#/");
  const home = h.view();
  assert.ok(home.includes("hv2-forays"), "Home has its Forays section");
  assert.ok(!home.includes("hv2-draft-tag"), "no draft tag on Home");
  assert.ok(!home.includes("Showing draft Forays"), "no test-track notice on Home");
  for (const f of DRAFTS) assert.ok(!home.includes(f.title), `${f.id} must not be named on Home`);

  const used = showUsedByGeneratedDraft();
  assert.ok(used, "a generated draft draws on a catalogued show — this fixture needs one");
  const rows = h.showRows(used.show.show_id);
  assert.ok(!rows.includes(used.foray.title), "the show page must not name a hidden draft");
});

test("switch off is byte-identical to an app with no switch at all, on every surface", async () => {
  /* Three apps, three renders each, one answer. (a) the real app, key absent;
     (b) the real app, key stored as `false`; (c) the real app with
     `showDraftsOn()` stubbed to `return false`; (d) the real app over a bridge
     that has never heard of `showDrafts`. M2 (`showDraftsOn` returns true)
     turns (a) and (b) red against (c); a surface that started reading the key
     on its own would turn (a) red against (d). */
  const stubbed = APP_SRC.replace(
    'function showDraftsOn() { return lsGet("cp_show_drafts", false); }',
    "function showDraftsOn() { return false; }",
  );
  assert.notStrictEqual(stubbed, APP_SRC, "the stub must have found showDraftsOn() to replace");
  const used = showUsedByGeneratedDraft();
  const paint = async (opts) => {
    const h = await mount(opts);
    const out = { forays: h.view() };
    h.route("#/"); out.home = h.view();
    out.rows = h.showRows(used.show.show_id);
    out.publishedRows = h.showRows("practical-ai") + h.showRows("causality-engineered-network");
    return out;
  };
  const a = await paint({});
  const b = await paint({ seed: { cp_show_drafts: false } });
  const c = await paint({ appSrc: stubbed });
  const d = await paint({ legacyBridge: true });
  assert.ok(a.home.includes("hv2-forays") && a.forays.includes("fy-home-row"), "the renders are not empty");
  assert.deepStrictEqual(b, a, "key stored as false = key absent");
  assert.deepStrictEqual(c, a, "the switch off = no switch in the source");
  assert.deepStrictEqual(d, a, "the switch off = a bridge that cannot see it");
});

/* ==================================================================== */
/* ON                                                                   */
/* ==================================================================== */

test("switch on: #/forays lists every draft with the draft kicker — published first, generated drafts newest first, then hand-authored", async () => {
  /* M1 in reverse is not the risk here; M4 is: make `draftTrackOrder` return
     its input unchanged and the order assertion goes red (the generated ones
     come out oldest first, and the authored ones ahead of them). */
  const h = await mount({ seed: ON });
  assert.deepStrictEqual(h.ids(), [...PUBLISHED_IDS, ...GENERATED_NEWEST_FIRST, ...AUTHORED_DRAFT_IDS]);
  const html = h.view();
  const rows = html.split('class="fy-home-row"').slice(1);
  assert.strictEqual(rows.length, FORAYS.length, "one row per Foray in the file");
  assert.ok(rows[0].includes(titleOf("capital-types-1")) && !rows[0].includes("· draft"), "the published row is first and carries no draft kicker");
  for (const f of DRAFTS) {
    const row = rows.find((r) => r.includes(`href="#/foray/${f.id}"`));
    assert.ok(row, `${f.id} has a row`);
    assert.ok(row.includes("foray · draft"), `${f.id} carries the draft kicker`);
    assert.ok(row.includes(f.title.replace(/&/g, "&amp;")), `${f.id} is named`);
  }
  const genPos = GENERATED_NEWEST_FIRST.map((id) => html.indexOf(`href="#/foray/${id}"`));
  for (let i = 1; i < genPos.length; i++) assert.ok(genPos[i - 1] < genPos[i], "generated drafts are newest first");
});

test("switch on: Home lists every draft as a badged card after the ordinary picks, and carries the notice", async () => {
  /* M6: drop `${testTrackNoticeHtml()}` from renderHomeV2 — the notice
     assertion goes red. Drop `${drafts.map(...)}` from foraysForYouHtml — the
     card assertions go red. */
  const h = await mount({ seed: ON, hash: "#/" });
  const home = h.view();
  assert.ok(home.includes('class="hv2-test-track note">Showing draft Forays — test track</p>'), "the one-line notice");
  assert.ok(home.indexOf("Showing draft Forays") < home.indexOf("hv2-forays"), "the notice is above the Forays section");
  const cards = home.split('class="hv2-foray-card').slice(1);
  assert.strictEqual(cards.length, 1 + DRAFTS.length, "the one published pick, then every draft");
  assert.ok(cards[0].includes('href="#/foray/capital-types-1"') && !cards[0].includes("hv2-draft-tag"), "the published card is first and unbadged");
  for (const f of DRAFTS) {
    const card = cards.find((c) => c.includes(`href="#/foray/${f.id}"`));
    assert.ok(card, `${f.id} has a card`);
    assert.ok(card.includes('<span class="hv2-draft-tag">draft</span>'), `${f.id} is badged draft`);
  }
  const genPos = GENERATED_NEWEST_FIRST.map((id) => home.indexOf(`href="#/foray/${id}"`));
  for (let i = 1; i < genPos.length; i++) assert.ok(genPos[i - 1] < genPos[i], "generated drafts are newest first on Home too");
  assert.ok(!home.includes("hv2-bridge\">undefined"), "no stretch bridge leaked onto a draft card");
});

test("switch on: a show page's Foray rows name a draft that draws on the show, with the draft marker", async () => {
  const used = showUsedByGeneratedDraft();
  assert.ok(used, "a generated draft draws on a catalogued show — this fixture needs one");
  const h = await mount({ seed: ON });
  const rows = h.showRows(used.show.show_id);
  assert.ok(rows.includes('class="show-forays"'), "the footer renders");
  assert.ok(rows.includes(`href="#/foray/${used.foray.id}"`), `${used.foray.id} is a row`);
  const row = rows.split('class="show-forays-row"').slice(1).find((r) => r.includes(used.foray.id));
  assert.ok(row.includes('<span class="show-forays-draft">draft</span>'), "and it carries the draft marker");
});

test("switch on: a generated draft opens at #/foray/<id> and plays through the same path the published Foray uses", async () => {
  /* M3: drop `showDrafts` from `forayViewOpts()` — the list still shows the
     draft (listForays goes through withTestTrackDrafts) but the page answers
     "isn't available" and nothing plays. That is the bug this test exists for:
     a list that advertises a page it cannot open. */
  const h = await mount({ seed: ON, hash: "#/forays" });
  const play = async (id) => {
    h.route(`#/foray/${id}`);
    await h.settle();
    assert.strictEqual(h.state().foray?.id, id, `${id} resolved`);
    assert.ok(h.view().includes(`<h2>${titleOf(id).replace(/&/g, "&amp;")}</h2>`), `${id} painted`);
    const btn = findIn(h.body, "#fy-play");
    assert.ok(btn, "the play button is on the page");
    await btn.click();
    await h.settle();
  };
  await play("capital-types-1");
  assert.ok(!h.view().includes("fy-draft"), "the published Foray carries no draft note");
  for (const id of GENERATED_NEWEST_FIRST) {
    await play(id);
    assert.ok(h.view().includes('Shown because "Show draft Forays" is on'), `${id}'s draft note names the switch, not the URL`);
  }
  assert.deepStrictEqual(h.playCalls.map((c) => c.id), ["capital-types-1", ...GENERATED_NEWEST_FIRST]);
  for (const c of h.playCalls) assert.ok(c.playable > 0, `${c.id} queued ${c.playable} segments`);
});

/* ==================================================================== */
/* EITHER WAY: the `?foray=` door                                        */
/* ==================================================================== */

test("the ?foray=<id> unlock behaves exactly as before, with the switch off and with it on", async () => {
  const draft = GENERATED_NEWEST_FIRST[GENERATED_NEWEST_FIRST.length - 1];
  const other = GENERATED_NEWEST_FIRST[0];

  /* Off, no unlock: the draft is not there and its page says so. */
  const closed = await mount({ hash: `#/foray/${draft}` });
  await closed.settle();
  assert.ok(closed.view().includes("That foray isn't available."), "a hidden draft's page is the not-available page");
  assert.strictEqual(closed.state().foray, null);

  /* Off, unlocked by id: listed after the published one, opens, says "by name". */
  const byName = await mount({ hash: `#/foray/${draft}`, search: `?foray=${draft}` });
  await byName.settle();
  assert.strictEqual(byName.state().foray?.id, draft);
  assert.ok(byName.view().includes("You opened it by name; nobody else sees it."), "today's sentence, exactly");
  assert.deepStrictEqual(byName.ids(), [...PUBLISHED_IDS, draft], "the unlocked draft is listed, the other draft is not");
  byName.route(`#/foray/${other}`);
  await byName.settle();
  assert.ok(byName.view().includes("That foray isn't available."), "naming one draft does not unlock another");

  /* On, unlocked by id: the unlock still owns the sentence, and the list is the
     unlocked draft in its place plus the rest of the track. */
  const both = await mount({ seed: ON, hash: `#/foray/${draft}`, search: `?foray=${draft}` });
  await both.settle();
  assert.strictEqual(both.state().foray?.id, draft);
  assert.ok(both.view().includes("You opened it by name; nobody else sees it."), "the URL's door wins the sentence");
  assert.deepStrictEqual(both.ids(), [...PUBLISHED_IDS, draft, ...GENERATED_NEWEST_FIRST.filter((id) => id !== draft), ...AUTHORED_DRAFT_IDS]);
});

/* ==================================================================== */
/* THE DRAWER                                                           */
/* ==================================================================== */

test("the drawer carries the toggle: it reads its state, flips the key, re-renders the page behind it, and does not close the drawer", async () => {
  /* M5: `bindDraftsControl` calls `route()` instead of `renderCurrentPage()` —
     the drawer-still-open assertion goes red (route() closes it). Drop the
     `lsSet` — the store and re-render assertions go red. */
  const h = await mount();
  const btn = h.draftsToggle();
  assert.ok(btn, "#drafts-toggle is in the DOM after init");
  assert.strictEqual(btn.parent, h.drawer(), "appended to the drawer");
  const order = h.drawer().children.map((c) => c.id);
  assert.ok(order.indexOf("drafts-toggle") < order.indexOf("diag-open"), "above Playback diagnostics");
  assert.ok(order.indexOf("drafts-toggle") < order.indexOf("delete-data"), "above Delete my data");

  h.fn("openDrawer")(true);
  assert.strictEqual(h.drawer().hidden, false);
  assert.strictEqual(btn.textContent, "Show draft Forays: off");
  assert.ok(!h.view().includes("· draft"), "#/forays shows no draft before the tap");

  await btn.click();
  assert.strictEqual(h.store.getItem("cp_show_drafts"), "true", "the durable key is written");
  assert.strictEqual(btn.textContent, "Show draft Forays: on");
  assert.strictEqual(h.drawer().hidden, false, "a settings toggle must not close the drawer");
  assert.deepStrictEqual(h.ids(), [...PUBLISHED_IDS, ...GENERATED_NEWEST_FIRST, ...AUTHORED_DRAFT_IDS]);
  assert.ok(h.view().includes("foray · draft"), "the page behind the drawer re-rendered with the drafts");

  await btn.click();
  assert.strictEqual(h.store.getItem("cp_show_drafts"), "false");
  assert.strictEqual(btn.textContent, "Show draft Forays: off");
  assert.deepStrictEqual(h.ids(), PUBLISHED_IDS, "off again: back to the published set");
  assert.ok(!h.view().includes("· draft"));
});

test("the key is a cp_ key like every other: named in the privacy policy's stored-keys table", () => {
  /* The count itself lives in test/data-deletion.test.js (24 -> 25); this is
     the row, checked here too so this suite alone says what the switch stores. */
  const policy = fs.readFileSync(path.join(ROOT, "docs/legal/privacy-policy.md"), "utf8");
  assert.match(policy, /^\|\s*`cp_show_drafts`\s*\|.*\| \*\*No\*\* \|$/m, "one row, and it never leaves the device");
  assert.ok(APP_SRC.includes('lsGet("cp_show_drafts", false)'), "read through lsGet with a false default");
  assert.ok(!fs.readdirSync(path.join(ROOT, "player")).some((f) => f.endsWith(".js") && !f.endsWith(".test.js") && fs.readFileSync(path.join(ROOT, "player", f), "utf8").includes("cp_show_drafts")), "player/ never reads the key — it takes `showDrafts` as an option");
});
