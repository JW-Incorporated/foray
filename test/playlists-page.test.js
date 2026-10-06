/* The playlist ROW, on every surface that lists playlists, and the Library
 * housekeeping that sits beside it (CH-35, docs/roadmap/code-health.md A2-18,
 * A2-19).
 *
 * WHAT THIS PROVES, in order:
 *  1. `#/playlists` (renderPlaylists) prints each playlist as a `.pl-row`
 *     whose second line is the length and, once played, "played <date>".
 *  2. Search's Playlists section (renderPlaylistSearchResults) prints an own
 *     playlist with the SAME row `#/playlists` prints: its own header says a
 *     playlist opened from Search is indistinguishable from one opened from the
 *     Playlists page, and the "· played <date>" suffix had drifted off it.
 *  3. A generated candidate keeps its "Generated for you" badge, inside the
 *     title line, and only it does.
 *  4. Library's Playlists summary stays the short summary: title and length.
 *  5. A download removed while Library is on screen repaints Library, and
 *     only then.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test is
 * not evidence until you have broken it".
 *
 * Harness: the same node:vm DOM stub as test/search-playlists.test.js,
 * duplicated rather than imported (see test/show-search.test.js's header for
 * why).
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
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: "", className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {},
    children: [], parent: null, _attrs: {},
    href: undefined,
    classList: {
      add(...cs) { el.className = [...new Set([...(el.className ? el.className.split(/\s+/) : []), ...cs])].join(" "); },
      remove(...cs) { el.className = el.className.split(/\s+/).filter((c) => c && !cs.includes(c)).join(" "); },
      toggle(c, on) {
        const has = el.className.split(/\s+/).includes(c);
        const want = on === undefined ? !has : !!on;
        if (want && !has) el.classList.add(c);
        if (!want && has) el.classList.remove(c);
      },
      contains: (c) => el.className.split(/\s+/).includes(c),
    },
    _listeners: {},
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(evt) { (el._listeners[evt.type] || []).forEach((fn) => fn(evt)); return true; },
    appendChild(k) { k.parent = el; el.children.push(k); return k; },
    append(...ks) { for (const k of ks) { k.parent = el; el.children.push(k); } },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    removeAttribute(k) { delete el._attrs[k]; },
    querySelector(sel) {
      const s = String(sel);
      const m = /^\[data-([a-zA-Z-]+)\]$/.exec(s);
      if (m) {
        const attr = "data-" + m[1];
        const stack = [...el.children];
        while (stack.length) {
          const n = stack.shift();
          if (Object.prototype.hasOwnProperty.call(n._attrs, attr)) return n;
          stack.push(...n.children);
        }
        return null;
      }
      return null;
    },
    querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
  };
  return el;
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results", "browse-all-link", "pl-search-results",
];

function mount({ seed = {}, fetchImpl = () => new Promise(() => {}) } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: fetchImpl,
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
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    Event: class { constructor(type) { this.type = type; } },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body, byId,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
  };
}

function seedEmpty(m) {
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.cardSlots = [];
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
}

const PLAYED_AT = "2026-09-21T18:00:00Z";
const OWN = [
  { id: "p1", title: "History <Kick>", last_played_at: PLAYED_AT, items: [
    { id: "e1", title: "Ep 1", show: "S", topics: ["history/rome"] },
    { id: "e2", title: "Ep 2", show: "S", topics: ["history/rome"] },
  ] },
  { id: "p2", title: "History Fresh", items: [{ id: "e3", title: "Ep 3", show: "S", topics: ["history/rome"] }] },
];

/** Every `.pl-row` anchor in `html`, whole. */
function plRows(html) {
  return html.match(/<a class="pl-row"[^]*?<\/a>/g) || [];
}
const rowFor = (html, id) => plRows(html).find((r) => r.includes(`href="#/playlist/${id}"`));

function mountWithPlaylists() {
  const m = mount();
  seedEmpty(m);
  m.store.set("cp_playlists", JSON.stringify(OWN));
  return m;
}

test("#/playlists prints the length and, once played, 'played <date>' on each row (CH-35, characterization)", () => {
  /* MUTATION (run, red): drop `playedOnLabel(p.last_played_at)` from the
     Playlists page's row -> p1's second line loses its suffix. */
  const m = mountWithPlaylists();
  m.ctx.renderPlaylists();
  const html = m.view();
  const played = m.evalIn("playedOnLabel")(PLAYED_AT);
  assert.ok(played.startsWith("played "), `a played label for a valid stamp: ${played}`);
  const p1 = rowFor(html, "p1");
  const p2 = rowFor(html, "p2");
  assert.ok(p1 && p2, "both playlists are listed");
  assert.match(p1, /<div class="t">History &lt;Kick&gt;<\/div>/, "the title, escaped");
  assert.ok(p1.includes(`<div class="s">2 episodes · ${played}</div>`), `the played one says when: ${p1}`);
  assert.ok(p2.includes('<div class="s">1 episode</div>'), `the unplayed one says only its length: ${p2}`);
});

test("Search prints an own playlist with the same row #/playlists prints, 'played <date>' included (CH-35, A2-18)", () => {
  /* The Search section's header says a playlist opened from Search is
     indistinguishable from one opened from the Playlists page; its own row
     template had drifted, and "2 episodes · played Sep 21" there read
     "2 episodes" here. Listener-visible: the suffix now appears in Search.
     MUTATION (run, red): give renderPlaylistSearchResults its own row template
     again (title + `playlistLengthLabel(p)` only) -> the rows differ and the
     suffix is missing. */
  const m = mountWithPlaylists();
  m.ctx.renderPlaylists();
  const page = m.view();
  m.ctx.renderPlaylistSearchResults("history", m.evalIn("showSearchToken"));
  const results = m.byId.get("pl-search-results");
  assert.strictEqual(results.hidden, false, "own playlists matched");
  const played = m.evalIn("playedOnLabel")(PLAYED_AT);
  for (const id of ["p1", "p2"]) {
    const fromSearch = rowFor(results.innerHTML, id);
    assert.ok(fromSearch, `${id} is in Search`);
    assert.ok(fromSearch.includes(m.evalIn("playlistLengthLabel")(OWN.find((p) => p.id === id))), `${id}'s length (today's line)`);
    assert.strictEqual(fromSearch, rowFor(page, id), `${id}: Search's row is the Playlists page's row`);
  }
  assert.ok(rowFor(results.innerHTML, "p1").includes(`2 episodes · ${played}`), "the suffix the page shows, in Search too");
});

test("a generated candidate in Search carries the 'Generated for you' badge in its title line, and an own playlist does not (CH-35, characterization)", () => {
  /* MUTATION (run, red): pass the badge for own rows too, or drop it from
     generated rows -> one of the two assertions fails. */
  const m = mount();
  seedEmpty(m);
  m.state.taxonomy = { nodes: [
    { id: "history", parent: null, label: "History", weight: 0.5 },
    { id: "history/rome", parent: "history", label: "Rome history", weight: 0.5 },
  ] };
  m.state.interests = { "history/rome": 0.8 };
  m.state.discover = { items: [1, 2, 3].map((i) => ({ id: "r" + i, title: "Rome " + i, show: "S" + i, topics: ["history/rome"], release_date: "2026-09-0" + i })) };
  m.store.set("cp_playlists", JSON.stringify([OWN[0]]));
  m.ctx.renderPlaylistSearchResults("history", m.evalIn("showSearchToken"));
  const rows = plRows(m.byId.get("pl-search-results").innerHTML);
  const own = rows.find((r) => r.includes('href="#/playlist/p1"'));
  const gen = rows.find((r) => r.includes("gen-history%2Frome"));
  assert.ok(own && gen, `an own and a generated row: ${rows.length}`);
  assert.ok(!own.includes("Generated for you"), "the own row is not badged");
  assert.match(gen, /<div class="t">[^<]*<span class="fy-badge fy-badge-generated">Generated for you<\/span><\/div>/,
    "the generated row's badge sits in its title line");
});

test("Library's Playlists summary is the short one: title and length, no played date (CH-35, characterization)", () => {
  /* MUTATION (run, red): give the Library summary the full playlist row's
     second line -> p1's summary gains "· played …". */
  const m = mountWithPlaylists();
  m.ctx.renderLibrary();
  const p1 = rowFor(m.view(), "p1");
  assert.ok(p1, "the playlist is summarised in Library");
  assert.match(p1, /<div class="t">History &lt;Kick&gt;<\/div>\s*<div class="s">2 episodes<\/div>/, `title and length only: ${p1}`);
});

test("removing a download repaints Library while it is on screen, and only then (CH-35, A2-19, characterization)", async () => {
  /* MUTATION (run, red): drop the Library repaint from removeAllDownloads (or
     removeDownload) -> the #/library count stays 0. MUTATION 2 (run, red):
     repaint unconditionally -> the #/queue count is not 0. */
  for (const [hash, want] of [["#/library", 1], ["#/queue", 0]]) {
    const m = mount();
    seedEmpty(m);
    m.ctx.location.hash = hash;
    m.state.downloadBridge = { remove: async () => ({ ok: true }), removeAll: async () => ({ ok: true }) };
    let repaints = 0;
    m.ctx.renderCurrentPage = () => { repaints++; };
    await m.ctx.removeDownload("e1");
    assert.strictEqual(repaints, want, `removeDownload on ${hash}`);
    repaints = 0;
    await m.ctx.removeAllDownloads();
    assert.strictEqual(repaints, want, `removeAllDownloads on ${hash}`);
  }
});
