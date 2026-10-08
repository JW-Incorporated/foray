/* Today, offline (Redesign 2026, Tactile, screen "home-offline"; BUILD-NOTES 3.1
 * "Offline-blocked", 3.9 the meta line, 4.1 "States: Offline"; DIRECTION.md
 * "Offline: undownloaded items get a grey lip and 'Needs a connection'").
 *
 * OFFLINE IS OBSERVED, never declared (product principle 2): `navigator.onLine`
 * says so, and a runtime that cannot say is online. What changes on Today:
 *
 *  1. Every Play key whose audio is not on the device (the Foray hero, each
 *     Also today row, the Stretch card) is the blocked key: disabled, the
 *     cloud-slash, named "Needs a connection: <title>", and carrying no engine
 *     hook (a press can start nothing).
 *  2. An episode the downloads record says is `done` keeps a LIVE key and shows
 *     the downloaded mark with its word ("Downloaded", check-circle, aria-label).
 *     Online, the same episode shows the circle alone.
 *  3. The date readout ends " · Offline"; "Needs a connection" is drawn once
 *     under the hero and under each blocked row.
 *  4. The radio coming and going repaints Today, only while Today is on screen.
 *  5. The meta line wraps after the show name, the blocked key looks blocked in
 *     CSS (paper-2 fill, line lip, ink-3, no depress), and the harness state
 *     and `screens.json` row exist.
 *
 * HARNESS: the flat-by-id node:vm DOM stub test/today-first-run.test.js uses,
 * duplicated rather than imported (a test file that requires another registers
 * its tests). Audit of the fakes: (a) `window.forayDownloads.store` is the REAL
 * player/download-store.js normaliser (imported, not re-written), because
 * `downloadsValue()` ignores the record when no rules are present, so a
 * hand-written fake would have made "downloaded" unreachable or too easy;
 * (b) the `#view` stub answers `.today` only when a test says Today is on
 * screen, in both directions, so the repaint test cannot pass by repainting
 * everywhere; (c) the seed has a listened-to history, so no first run.
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { rule, CSS } = require("./helpers/tactile-primitives.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
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
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
  "pl-form", "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results",
];

let downloadStore = null;
async function realDownloadStore() {
  if (!downloadStore) downloadStore = await import(pathToFileURL(path.join(ROOT, "player", "download-store.js")).href);
  return downloadStore;
}

async function mount({ online = true, downloaded = [] } = {}) {
  const store = new Map([["cp_history", JSON.stringify(["earlier-listen"])]]);
  const items = {};
  for (const id of downloaded) items[id] = { status: "done", bytes: 1000, total: 1000, path: `downloads/${id}.mp3`, updated_at: "2026-10-04T12:00:00.000Z" };
  if (downloaded.length) store.set("cp_downloads", JSON.stringify({ settings: { cellular: false }, items }));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");
  const handlers = {};
  const navigator = { userAgent: "node", onLine: online };
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
    navigator,
    addEventListener: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    removeEventListener() {},
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
  runAppSource(APP_SRC, ctx);
  /* What player/client.js publishes on the real page: the rules `downloadsValue` reads through. */
  ctx.forayDownloads = { store: await realDownloadStore() };
  const evalIn = (src) => vm.runInContext(src, ctx);
  const m = { ctx, evalIn, state: evalIn("state"), navigator, handlers, byId, view: () => byId.get("view").innerHTML };

  m.state.catalog = { shows: [] };
  m.state.taxonomy = { nodes: [
    { id: "engineering", parent: null, label: "Engineering", weight: 0.9 },
    { id: "comedy", parent: null, label: "Comedy", weight: 0.5 },
    { id: "history", parent: null, label: "History", weight: 0.5 },
  ] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.interests = { engineering: 0.9, comedy: 0.1 };
  m.state.discover = { items: [] };
  const ep = (id, title, show, topic) => ({ id, title, show, duration_min: 35, artwork_url: "https://img.test/" + id + ".jpg", topics: [topic], hook: `${title}, in one line.`, audio_url: `https://cdn.test/${id}.mp3` });
  const slot = (branch, role, item) => ({ branch, role, item, items: [item] });
  m.state.cardSlots = [
    slot("engineering", "top", ep("ep-top", "Fusion 101", "Engineering Weekly", "engineering")),
    slot("history", "top", ep("ep-hist", "The long view", "History Hour", "history")),
    slot("comedy", "stretch", ep("ep-stretch", "A comedy bit", "Laugh Hour", "comedy")),
  ];
  m.state.forays = { forays: [] };
  m.ctx.ForayPlayer = {
    listForays: () => [{ id: "foray-eng", title: "Deep Fusion", topic: "engineering/energy-fusion", status: "published", summary: "Fusion, from the magnets to the money." }],
    forayResumeList: () => [],
    resolve: (doc, { id }) => ({ id, title: id, totalSec: 1320, playable: [{ show: "Engineering Weekly", kind: "tape" }, { show: "Founders Weekly", kind: "tape" }] }),
    stripModel: () => ({ segments: [
      { kind: "segment", show: "Engineering Weekly", sourceKey: "a", lengthSec: 600 },
      { kind: "segment", show: "Founders Weekly", sourceKey: "b", lengthSec: 700 },
    ] }),
    stripTally: () => ({ clips: 2, bridges: 0, shows: 2, totalSec: 1320, estimated: false }),
    fmtSpan: (sec) => `${Math.round(sec / 60)} min`,
    segmentStripHtml: () => "",
    applyStripGrow: () => {},
  };
  return m;
}

const SECTION = (html, from, to) => html.slice(html.indexOf(from), to ? html.indexOf(to) : undefined);
/** The row/bridge article for one episode title, by its Play control's name. */
const rowOf = (html, title) => {
  const articles = html.match(/<article class="(?:row-episode|card bridge)[\s\S]*?<\/article>/g) || [];
  return articles.find((a) => a.includes(title));
};
const keycaps = (html) => html.match(/<button type="button" class="keycap [^>]*>/g) || [];

/* ==================================================================== */
/* 1. EVERY UNDOWNLOADED PLAY KEY IS BLOCKED, A DOWNLOADED ONE IS LIVE   */
/* ==================================================================== */

test("offline: the hero, the undownloaded row and the Stretch card take the blocked key; the downloaded row keeps a live one", async () => {
  /* MUTATION: make todayIsOffline() return false -> no key is blocked and the first assertion fails.
     MUTATION 2: drop `!downloaded &&` from `blocked` in todayEpisodeData -> the downloaded row's key
     is blocked and the live-key assertion fails. MUTATION 3: in tactilePlayKey keep the engine
     `data` on the blocked key -> the no-hook assertions fail. */
  const m = await mount({ online: false, downloaded: ["ep-hist"] });
  m.ctx.renderHome();
  const html = m.view();

  const hero = SECTION(html, "today-hero", "today-also");
  assert.match(hero, /class="keycap keycap--xl keycap--paper keycap--round keycap--blocked"[^>]*disabled[^>]*aria-label="Needs a connection: Deep Fusion"/, "the Foray is never on the device");
  assert.doesNotMatch(hero, /data-home-play/, "a blocked hero key has no engine hook");

  for (const [title, name] of [["Fusion 101", "Fusion 101"], ["A comedy bit", "A comedy bit"]]) {
    const row = rowOf(html, title);
    assert.ok(row, `${title} is on Today`);
    const key = keycaps(row);
    assert.strictEqual(key.length, 1, `${title}: one trailing key (raw, not a truncated view)`);
    assert.match(key[0], /keycap--blocked/);
    assert.match(key[0], /disabled/);
    assert.match(key[0], new RegExp(`aria-label="Needs a connection: ${name}"`));
    assert.doesNotMatch(key[0], /data-play=/, `${title}: a press can start nothing`);
  }

  const live = rowOf(html, "The long view");
  const liveKey = keycaps(live);
  assert.strictEqual(liveKey.length, 1);
  assert.doesNotMatch(liveKey[0], /keycap--blocked|disabled/, "the downloaded episode stays playable offline");
  assert.match(liveKey[0], /data-play="ep-hist"/);
  assert.match(liveKey[0], /aria-label="Play The long view"/);
});

test("offline: the downloaded mark carries its word, the circle and its name; the blocked rows carry the sentence", async () => {
  /* MUTATION: pass `downloadedMark: "icon"` while offline in todayEpisodeData -> the word assertion fails.
     MUTATION 2: drop the `d.blocked ? tactileNeedsLine()` call from tactileEpisodeRow -> the
     sentence count fails. MUTATION 3: draw the needs line for every row -> the count is 3, not 2. */
  const m = await mount({ online: false, downloaded: ["ep-hist"] });
  m.ctx.renderHome();
  const html = m.view();
  const live = rowOf(html, "The long view");
  assert.match(live, /<span class="tag tag--downloaded" role="img" aria-label="Downloaded"><svg class="i i--sm"[^>]*><use href="#ph-check-circle"><\/use><\/svg><span>Downloaded<\/span><\/span>/, "check-circle plus the word");
  assert.doesNotMatch(live, /Needs a connection/, "an episode on the device needs nothing");
  assert.doesNotMatch(rowOf(html, "Fusion 101"), /tag--downloaded/, "nothing downloaded, no mark");
  /* One sentence under the hero and one under each blocked ROW; the Stretch card's key is named only. */
  assert.strictEqual((html.match(/<p class="needs">/g) || []).length, 2, "hero + the one blocked row");
  assert.match(rowOf(html, "Fusion 101"), /<p class="needs"><svg[^>]*><use href="#ph-cloud-slash"><\/use><\/svg><span>Needs a connection<\/span><\/p>/);
  assert.match(SECTION(html, "today-hero", "today-also"), /<p class="needs">/);
});

test("offline: a downloaded episode whose file is missing or still arriving is NOT playable offline", async () => {
  /* The record says `done` only when the bytes are on disk; `missing`, `queued` and
     `downloading` stream, so offline they are blocked.
     MUTATION: make todayIsDownloaded return `Boolean(rec)` -> a `missing` row reads as on the device. */
  const m = await mount({ online: false });
  m.ctx.localStorage.setItem("cp_downloads", JSON.stringify({ settings: {}, items: {
    "ep-hist": { status: "missing", bytes: 0, path: null, updated_at: "2026-10-04T12:00:00.000Z" },
    "ep-top": { status: "downloading", bytes: 10, total: 100, path: null, updated_at: "2026-10-04T12:00:00.000Z" },
  } }));
  m.ctx.renderHome();
  const html = m.view();
  for (const title of ["The long view", "Fusion 101"]) assert.match(keycaps(rowOf(html, title))[0], /keycap--blocked/, `${title} streams, so it is blocked`);
  assert.doesNotMatch(html, /tag--downloaded/, "no mark for a file that is not on the device");
});

/* ==================================================================== */
/* 2. ONLINE: THE SAME EPISODE SHOWS THE CIRCLE ALONE, NOTHING IS BLOCKED */
/* ==================================================================== */

test("online: every key is live, the downloaded episode shows the check-circle alone (named), and the date says nothing about the radio", async () => {
  /* MUTATION: drop `downloadedMark: offline ? "word" : "icon"` to always "word" -> the icon-only
     assertions fail. MUTATION 2: make todayIsOffline return true -> the blocked/needs assertions fail. */
  const m = await mount({ online: true, downloaded: ["ep-hist"] });
  m.ctx.renderHome();
  const html = m.view();
  assert.doesNotMatch(html, /keycap--blocked|class="needs"|Needs a connection/);
  assert.doesNotMatch(html, /Offline</, "no Offline in the date readout");
  const live = rowOf(html, "The long view");
  assert.match(live, /<span class="tag tag--downloaded tag--icon" role="img" aria-label="Downloaded"><svg class="i i--sm"[^>]*><use href="#ph-check-circle"><\/use><\/svg><\/span>/);
  assert.doesNotMatch(live, /<span>Downloaded<\/span>/, "the word is the aria-label online, not on screen");
  assert.match(SECTION(html, "today-hero", "today-also"), /data-home-play="foray-eng"/, "the Foray plays online");
});

test("a runtime that cannot say is online: navigator.onLine undefined blocks nothing", async () => {
  /* MUTATION: test `!navigator.onLine` instead of `=== false` in todayIsOffline -> this fails. */
  const m = await mount();
  delete m.navigator.onLine;
  m.ctx.renderHome();
  assert.doesNotMatch(m.view(), /keycap--blocked/);
});

/* ==================================================================== */
/* 3. THE DATE READOUT                                                   */
/* ==================================================================== */

test("offline: the date readout ends ' · Offline', at render and when the foreground hook refreshes it", async () => {
  /* MUTATION: render `todayDateLine()` in todayHeaderHtml (not todayDateReadout) -> the render
     assertion fails. MUTATION 2: refresh with todayDateLine in refreshTodayDate -> the refresh
     assertion fails (the label would drop " · Offline" at the next foreground). */
  const m = await mount({ online: false });
  m.ctx.renderHome();
  assert.match(m.view(), /data-today-date>[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} · Offline</);
  assert.strictEqual(m.ctx.todayDateReadout(new Date(2026, 9, 5)), "Mon 5 Oct · Offline");
  const online = await mount({ online: true });
  assert.strictEqual(online.ctx.todayDateReadout(new Date(2026, 9, 5)), "Mon 5 Oct");
  /* The foreground hook rewrites the one element; the stub document answers it only here. */
  const date = makeEl("span");
  const realQuery = m.ctx.document.querySelector;
  m.ctx.document.querySelector = (sel) => (sel === "[data-today-date]" ? date : realQuery(sel));
  m.ctx.refreshTodayDate(new Date(2026, 9, 6));
  assert.strictEqual(date.textContent, "Tue 6 Oct · Offline", "the refresh keeps the suffix");
});

/* ==================================================================== */
/* 4. THE RADIO COMING AND GOING REPAINTS TODAY, ONLY WHILE ON TODAY     */
/* ==================================================================== */

test("going offline repaints Today in place, and only while Today is the page on screen", async () => {
  /* MUTATION: drop `bindTodayConnection()` from renderHomeV2 -> no handler is registered and the
     first assertion fails. MUTATION 2: drop the `.today` guard in `repaint` -> the second half
     repaints Today over another page and the last assertion fails. */
  const m = await mount({ online: true });
  const view = m.byId.get("view");
  let todayOnScreen = true;
  view.querySelector = (sel) => (sel === ".today" && todayOnScreen ? {} : null);
  m.ctx.renderHome();
  assert.ok(m.handlers.offline && m.handlers.online, "both events are listened for");
  assert.doesNotMatch(m.view(), /keycap--blocked/);

  m.navigator.onLine = false;
  m.handlers.offline.forEach((fn) => fn());
  assert.match(m.view(), /keycap--blocked/, "the keys are blocked without a reload");
  assert.match(m.view(), /Mon|Tue|Wed|Thu|Fri|Sat|Sun[^<]* · Offline</);

  m.navigator.onLine = true;
  m.handlers.online.forEach((fn) => fn());
  assert.doesNotMatch(m.view(), /keycap--blocked/, "coming back unblocks them");

  todayOnScreen = false;
  view.innerHTML = "<p>another page</p>";
  m.navigator.onLine = false;
  m.handlers.offline.forEach((fn) => fn());
  assert.strictEqual(m.view(), "<p>another page</p>", "no repaint over a page that is not Today");
  /* Rendering twice binds once. */
  todayOnScreen = true;
  m.ctx.renderHome();
  m.ctx.renderHome();
  assert.strictEqual(m.handlers.offline.length, 1, "bound once, however many renders");
});

/* ==================================================================== */
/* 5. CSS: THE BLOCKED KEY, THE WRAP                                     */
/* ==================================================================== */

test("the blocked key is paper-2 on a line lip in ink-3 and does not depress; the meta line wraps after the show name", () => {
  /* MUTATION: change `--k-fill: var(--paper-2)` to `var(--card)` in `.keycap--blocked` -> the fill
     assertion fails. MUTATION 2: delete the `.keycap--blocked::after { transform: none }` rule -> the
     lip would still scale under :active and the no-depress assertion fails. MUTATION 3: delete
     `flex-wrap: wrap` from the downloaded meta rule -> the wrap assertion fails (the facts would
     push the name to an ellipsis instead of onto line two). */
  const blocked = rule(".keycap:disabled, .keycap--blocked") || rule(".keycap--blocked");
  assert.match(blocked, /--k-fill:\s*var\(--paper-2\)/);
  assert.match(blocked, /--k-lip:\s*var\(--dial-line\)/, "--dial-line is the line token's name in the app");
  assert.match(blocked, /--k-ink:\s*var\(--ink-3\)/);
  assert.match(blocked, /transform:\s*none/);
  assert.match(CSS, /\.keycap:disabled::after, \.keycap--blocked::after\s*\{\s*transform:\s*none/);
  assert.match(rule(".row-episode:has(.tag--downloaded) .row__meta"), /flex-wrap:\s*wrap/);
  assert.match(rule(".today .row-episode:has(.tag--downloaded) .row__meta"), /row-gap:\s*0/, "Today's two meta lines sit tight, as the prototype's do");
  /* The facts (length, mark, + Up Next) are ONE unshrinking group: a wrap can never leave the
     action alone on a line. MUTATION: `flex: none` -> `flex: 0 1 auto` on `.row__facts`. */
  assert.match(rule(".row__facts"), /flex:\s*none/);
  assert.match(rule(".needs"), /color:\s*var\(--warn\)/);
});

/* ==================================================================== */
/* 6. THE HARNESS STATE AND THE SCREEN MAP                               */
/* ==================================================================== */

test("the harness has an `offline` state (seed returning, the radio off, steps home and foray) and screens.json points at it", async () => {
  /* MUTATION: delete the `offline` entry from appStates() -> fidelity.mjs refuses the map (exit 2)
     and this fails. MUTATION 2: drop `setOffline(true)` from goOffline -> the source assertion fails.
     MUTATION 3: point `home-offline` back at `app: null` -> the map assertion fails. */
  const states = await import(pathToFileURL(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs")).href);
  const fx = { items: [{ id: "a" }], shows: [{ show_id: "s" }], forays: [{ id: "foray-1" }], category: "c" };
  const offline = states.appStates(fx).find((s) => s.id === "offline");
  assert.ok(offline, "the offline state exists");
  assert.strictEqual(offline.seed, "returning");
  assert.deepStrictEqual(offline.steps.map((s) => s.label), ["home", "foray"]);
  assert.strictEqual(offline.steps[0].route, "#/");
  assert.strictEqual(offline.steps[1].route, "#/foray/foray-1");
  assert.strictEqual(typeof offline.steps[0].run, "function", "the first step puts the phone offline");
  const src = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs"), "utf8");
  assert.match(src, /page\.context\(\)\.setOffline\(true\)/);
  /* Existing states are untouched and `offline` was appended after them. */
  const ids = states.appStates(fx).map((s) => s.id);
  assert.strictEqual(ids[ids.length - 1], "offline");

  const map = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "redesign-2026", "directions", "tactile", "screens.json"), "utf8"));
  const row = map.screens["home-offline"];
  assert.deepStrictEqual(row.app, { state: "offline", step: "home" });
  assert.strictEqual(row.prototype.route, "#/home/offline");
  for (const [name, region] of Object.entries(row.regions)) assert.ok(region.app, `region ${name} is mapped to the app`);
  assert.strictEqual(row.regions.hero.app, ".today-hero");
  assert.strictEqual(row.regions.rows.app, ".today .row-episode");
});
