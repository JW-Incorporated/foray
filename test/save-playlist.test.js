/* Keeping a playlist 4a made (founder, 2026-09-25: "we should add a feature to
 * save playlists").
 *
 * A generated playlist (generatedPlaylists) and a Suggested subject queue
 * (subjectQueueById) are rebuilt on every load. Saving one snapshots the items
 * it holds right now into a new cp_playlists entry that is the listener's own
 * from then on. What this suite pins, in order:
 *
 *   1. Save from a generated playlist: the stored shape (parts, mirror,
 *      provenance, no generated flag), the control's words and name, no network.
 *   2. Save from a Suggested subject queue.
 *   3. The copy never changes by itself when its source does.
 *   4. Idempotence: one copy per source AS IT IS NOW; a second tap on Saved
 *      stays on the page ("Open your copy" is its own link); removing the copy
 *      lets the source be saved again; a source whose episodes changed is not
 *      "Saved" — the new set can be kept, and the earlier copy is linked.
 *   5. The 50 cap is said, not applied: a full list refuses and keeps the
 *      oldest; Create's builder refuses too; a refused save or a remove never
 *      cuts a store that already holds more than 50.
 *   6. The copy is the listener's own everywhere: Library, the Playlists page,
 *      "Playlists for you" (no badge, and not drawn twice beside its unchanged
 *      source), Create's search, and its own page (remove, no Save).
 *   7. Family Mode: a copy saved under it holds only what Family Mode showed;
 *      a copy saved with it OFF neither lists nor plays (row or Home's play
 *      button) what Family Mode hides once it is on.
 *   8. The playable-snapshot rule: after the catalogue moves, an item with a
 *      stored audio_url snapshot still plays; one without stays listed.
 *   9. Playing a saved copy behaves like any own playlist: the rows are the
 *      play list for continuous playback, and last_played_at is stamped.
 *  10. The single writer (round-3 app-1-1): a save made before hydration lands
 *      is provisional ("Saving"), written over the HYDRATED list, and reports
 *      its real outcome only then — full or already-saved included; a play
 *      stamp or a remove made while it waits composes with it, never writing
 *      the unhydrated list over the durable one.
 *  11. "Delete my data" clears it; the copy follows CLAUDE.md's copy rules.
 *
 * Every test names the one-line mutation that turns it red, and each was run.
 *
 * WHICH SUITE COVERS WHAT ELSE: test/playlist-durability.test.js owns the part
 * whitelist and its byte budget (a saved copy uses the same playlistPart);
 * test/data-deletion.test.js owns that cp_playlists is enumerated, cleared from
 * both tiers and documented; test/tap-targets.test.js classifies the new
 * `.pl-save` button against the 44px floor; test/toggle-labels.test.js holds
 * the rule that its text changes only through setToggleLabel.
 *
 * HARNESS: node:vm with the flat-by-id DOM stub the neighbouring playlist suites
 * use (test/home-v2.test.js), plus elements that keep real text, attributes,
 * classes and click listeners for the Save control. `#pl-save` only exists
 * inside an innerHTML string, so every write of `#view` mints FRESH control
 * elements — as a browser would — so a listener bound on one render can never
 * answer a click on the next.
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

/** An element with real text, attributes, classes and click listeners. */
function makeEl(tag = "div") {
  const attrs = new Map();
  const classes = new Set();
  const listeners = [];
  return {
    tagName: String(tag).toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : on; if (v) classes.add(c); else classes.delete(c); return v; },
      contains: (c) => classes.has(c),
    },
    listeners,
    addEventListener(type, fn) { if (type === "click") listeners.push(fn); },
    removeEventListener() {},
    click() { for (const fn of listeners.slice()) fn({ preventDefault() {}, stopPropagation() {} }); },
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {},
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
  "pl-form", "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results",
];
/* Controls that live inside #view's markup: re-minted on every write of it. */
const VIEW_CONTROLS = ["pl-save", "pl-save-note", "pl-save-open", "pl-remove"];
const CONTROL_TAG = { "pl-save-note": "p", "pl-save-open": "a" };

function mount({ seed = {} } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const writes = [];
  const fetched = [];
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const view = byId.get("view");
  let viewHtml = "";
  const mintControls = () => {
    for (const id of VIEW_CONTROLS) {
      if (viewHtml.includes(`id="${id}"`)) {
        const el = makeEl(CONTROL_TAG[id] || "button");
        el.id = id;
        byId.set(id, el);
      } else {
        byId.delete(id);
      }
    }
  };
  Object.defineProperty(view, "innerHTML", {
    get: () => viewHtml,
    set: (v) => { viewHtml = String(v); mintControls(); },
  });
  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {}, log() {} },
    fetch: (url) => { fetched.push(String(url)); return new Promise(() => {}); },
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { writes.push([k, String(v)]); store.set(k, String(v)); },
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
    history: { replaceState() {}, pushState() {}, back() {} },
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

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, writes, fetched, byId,
    state: evalIn("state"),
    view: () => viewHtml,
    el: (id) => byId.get(id) || null,
    stored: () => JSON.parse(store.get("cp_playlists") || "null"),
  };
}

function ep(id, over = {}) {
  return {
    id, title: `Episode ${id}`, show: "Founders", duration_min: 30,
    topics: ["business/startups"], release_date: "2026-09-01",
    audio_url: `https://cdn.test/${id}.mp3`, artwork_url: `https://art.test/${id}.jpg`,
    hook: "A hook that is never stored in a playlist part.",
    ...over,
  };
}

/* A mounted app with one card slot ("engineering", the Suggested subject
   queue) and a startups leaf that "Playlists for you" generates from. The pool
   holds the slot's episodes too, so the subject queue resolves live. */
function appMount({ seed = {}, startups = [1, 2, 3, 4] } = {}) {
  const m = mount({ seed });
  m.state.catalog = { shows: [] };
  m.state.taxonomy = {
    nodes: [
      { id: "engineering", parent: null, label: "Engineering", weight: 0.9 },
      { id: "business", parent: null, label: "Business", weight: 0.5 },
      { id: "business/startups", parent: "business", label: "Startups", weight: 0.5 },
    ],
  };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.interests = { engineering: 0.9, business: 0.6, "business/startups": 0.8 };
  const eng = [ep("eng-1", { topics: ["engineering"], show: "Engineering Weekly" }), ep("eng-2", { topics: ["engineering"], show: "Engineering Weekly" })];
  m.state.discover = {
    items: startups.map((i) => ep("st" + i, { release_date: `2026-09-0${i}` })).concat(eng),
  };
  m.state.itemIndex = {};
  m.state.poolIds = new Set();
  m.state.cardSlots = [{ branch: "engineering", role: "top", item: eng[0], items: eng }];
  m.state.forays = { forays: [] };
  m.ctx.ForayPlayer = {
    listForays: () => [], forayResumeList: () => [], resolve: () => null,
    segmentStripHtml: () => "", applyStripGrow: () => {},
    play: async () => true, isCurrent: () => true, setEpisodeNavigation() {},
  };
  return m;
}

const GEN_ID = "gen-business/startups";
const ownPlaylist = (n) => ({
  id: "q" + n, title: `Own ${n}`, query: `own ${n}`,
  items: [{ id: "x" + n, title: "X " + n, show: "S" }], item_ids: ["x" + n],
  created: `2026-08-${String((n % 28) + 1).padStart(2, "0")}T00:00:00.000Z`, last_played_at: null, sparse: false,
});

const SAVED_NOTE = "Saved to your playlists. Your copy stays as it is now.";
const FULL_NOTE = "You have 50 playlists, the most 4a keeps. Remove one to save this.";

/** Record every logEvent type from here on. */
function spyEvents(m) {
  m.evalIn(`globalThis.__events = [];
    { const orig = logEvent; logEvent = function (t, p, o) { globalThis.__events.push(t); return orig(t, p, o); }; }`);
  return () => Array.from(m.evalIn("globalThis.__events"));
}

/** Render a playlist page and tap its Save control once. */
function renderAndSave(m, id) {
  m.ctx.renderPlaylistDetail(id);
  const btn = m.el("pl-save");
  assert.ok(btn, `no Save control on ${id}`);
  btn.click();
  return btn;
}

/* ==================================================================== */
/* 1. SAVE FROM A GENERATED PLAYLIST                                     */
/* ==================================================================== */

test("a generated playlist's page carries Save, and Save stores its current items as the listener's own", () => {
  /* MUTATION 1: drop `saved_from` from the copy in savePlaylistCopy -> the
     provenance assertion fails. MUTATION 2: build the copy as `{ ...p, id, ... }`
     (carrying isGenerated) -> the "no generated flag" assertion fails.
     MUTATION 3: map the items to `{ id }` stubs instead of playlistPart -> the
     first-write assertion fails. (Every later read of playlists() heals a stub
     from the pool, which is why the FIRST write is what is asserted: the
     snapshot is taken at the tap, not left to a later read.) */
  const m = appMount();
  const source = m.ctx.generatedPlaylistById(GEN_ID);
  assert.ok(source, "fixture assumption: the startups leaf generates a playlist");
  m.ctx.renderPlaylistDetail(GEN_ID);
  assert.match(m.view(), /<button type="button" class="pl-save" id="pl-save">Save to my playlists<\/button>/);
  assert.match(m.view(), /id="pl-save-note" role="status"/, "the outcome is said in a live region");

  const fetchesBefore = m.fetched.length;
  const btn = m.el("pl-save");
  btn.click();

  const list = m.stored();
  assert.strictEqual(list.length, 1);
  const copy = list[0];
  assert.strictEqual(copy.title, "Startups");
  assert.deepStrictEqual(copy.items.map((p) => p.id), Array.from(source.items, (p) => p.id));
  assert.deepStrictEqual(copy.item_ids, copy.items.map((p) => p.id), "the mirror is kept in step");
  assert.deepStrictEqual(copy.saved_from, { kind: "generated", source_id: GEN_ID });
  assert.match(copy.created, /^\d{4}-\d\d-\d\dT/);
  assert.strictEqual(copy.last_played_at, null);
  assert.ok(!copy.isGenerated && !copy.isSubject, "a saved copy is not a generated playlist");
  assert.notStrictEqual(copy.id, GEN_ID, "the copy has its own id");
  assert.deepStrictEqual(Object.keys(copy.items[0]).sort(),
    ["apple_collection_id", "apple_track_id", "duration_min", "id", "show", "title", "topics"]
      .filter((k) => k in copy.items[0]).sort());
  assert.ok(copy.items.every((p) => p.title && !("audio_url" in p) && !("hook" in p)), "parts are playlistPart snapshots");
  const firstWrite = JSON.parse(m.writes.find(([k]) => k === "cp_playlists")[1]);
  assert.ok(firstWrite[0].items.every((p) => p.title && p.show), "the save itself wrote whole parts, not stubs");

  assert.strictEqual(btn.textContent, "✓ Saved");
  assert.strictEqual(btn.getAttribute("aria-label"), "Saved to your playlists");
  assert.strictEqual(btn.getAttribute("aria-disabled"), "true", "saved is a state, not an action");
  assert.ok(btn.classList.contains("on"));
  assert.strictEqual(m.el("pl-save-note").textContent, SAVED_NOTE);
  assert.strictEqual(m.el("pl-save-open").hidden, false);
  assert.strictEqual(m.el("pl-save-open").getAttribute("href"), `#/playlist/${copy.id}`, "the copy opens from its own link");
  assert.strictEqual(m.fetched.length, fetchesBefore, "saving touches no network: it works offline");
});

/* ==================================================================== */
/* 2. SAVE FROM A SUGGESTED SUBJECT QUEUE                                */
/* ==================================================================== */

test("a Suggested subject queue's page carries Save, and the copy records kind 'subject'", () => {
  /* MUTATION: return null for `p.isSubject` in savedFromOf -> no Save control
     on the subject page and this fails. */
  const m = appMount();
  renderAndSave(m, "subject-engineering");
  const [copy] = m.stored();
  assert.strictEqual(copy.title, "Engineering");
  assert.deepStrictEqual(copy.items.map((p) => p.id), ["eng-1", "eng-2"]);
  assert.deepStrictEqual(copy.saved_from, { kind: "subject", source_id: "subject-engineering" });
});

/* ==================================================================== */
/* 3. THE COPY NEVER CHANGES BY ITSELF                                   */
/* ==================================================================== */

test("when the generated source moves on, the saved copy keeps what it held", () => {
  /* MUTATION: have renderPlaylistDetail resolve a saved copy through its source
     (`generatedPlaylistById(p.saved_from.source_id) || p`) -> the copy grows the
     new episode and this fails. */
  const m = appMount();
  renderAndSave(m, GEN_ID);
  const copy = m.stored()[0];
  const before = copy.items.map((p) => p.id);

  m.state.discover.items.push(ep("st9", { release_date: "2026-09-09" }));
  m.state.itemIndex = {};
  m.state.poolIds = new Set();
  assert.ok(m.ctx.generatedPlaylistById(GEN_ID).items.some((p) => p.id === "st9"), "fixture assumption: the source changed");

  m.ctx.renderPlaylistDetail(copy.id);
  assert.ok(!m.view().includes("Episode st9"), "the copy did not follow its source");
  assert.deepStrictEqual(m.stored()[0].items.map((p) => p.id), before);
});

/* ==================================================================== */
/* 4. IDEMPOTENCE                                                        */
/* ==================================================================== */

test("saving the same source twice keeps one copy, and a second tap on Saved stays on the page", () => {
  /* MUTATION 1: drop the `existing` early return in savePlaylistCopy -> the
     direct second save makes a second copy. MUTATION 2: restore the old first
     line of the click handler (`if (existing) { location.hash = … }`) -> the
     second tap leaves the page. MUTATION 3: render the control with no copy
     (`currentCopyOf` answering null) -> the re-rendered page offers Save again. */
  const m = appMount();
  const route = `#/playlist/${encodeURIComponent(GEN_ID)}`;
  m.ctx.location.hash = route;
  const first = renderAndSave(m, GEN_ID);
  const copy = m.stored()[0];

  first.click();   // a double tap, or VoiceOver's double activation
  assert.strictEqual(m.ctx.location.hash, route, "a second tap on Save never leaves the page");
  assert.strictEqual(m.stored().length, 1);
  assert.strictEqual(m.el("pl-save-note").textContent, SAVED_NOTE, "the save's status line is still what is said");

  const again = m.ctx.savePlaylistCopy(m.ctx.generatedPlaylistById(GEN_ID));
  assert.strictEqual(again.status, "exists");
  assert.strictEqual(again.playlist.id, copy.id);
  assert.strictEqual(m.stored().length, 1, "no duplicate from a direct second save");

  m.ctx.renderPlaylistDetail(GEN_ID);
  assert.match(m.view(), /<button type="button" class="pl-save on" id="pl-save" aria-label="Saved to your playlists" aria-disabled="true">✓ Saved<\/button>/,
    "a page opened after the save starts as Saved, with its name");
  assert.ok(m.view().includes(`<a class="pl-save-open" id="pl-save-open" href="#/playlist/${copy.id}">Open your copy</a>`),
    "and with the link to the copy showing");
  m.el("pl-save").click();
  assert.strictEqual(m.stored().length, 1);
  assert.strictEqual(m.ctx.location.hash, route);
});

test("removing the saved copy lets the source be saved again", () => {
  /* MUTATION 1: build the copy as `{ ...p, ... }` so it keeps isGenerated ->
     the copy's page has no remove control and this fails. MUTATION 2: filter
     the remove edit by title instead of id -> nothing is removed. */
  const m = appMount({ seed: { cp_playlists: JSON.stringify([ownPlaylist(1)]) } });
  renderAndSave(m, GEN_ID);
  const copy = m.stored().find((p) => p.saved_from);

  m.ctx.renderPlaylistDetail(copy.id);
  assert.ok(m.el("pl-remove"), "the copy can be removed like any own playlist");
  m.el("pl-remove").click();
  assert.deepStrictEqual(m.stored().map((p) => p.id), ["q1"], "the copy is gone and nothing else moved");

  m.ctx.renderPlaylistDetail(GEN_ID);
  assert.match(m.view(), />Save to my playlists</);
  assert.ok(!m.view().includes("earlier version"), "no copy is left to point at");
  m.el("pl-save").click();
  assert.strictEqual(m.stored().filter((p) => p.saved_from).length, 1);
});

test("once the source's episodes change, the page no longer says Saved: the new set can be kept, and the earlier copy is linked", () => {
  /* A source's id outlives its episodes ("gen-<leaf>" on Monday and Friday).
     MUTATION: match a copy on saved_from alone in currentCopyOf (drop the
     holdsIds check) -> the changed source still reads "✓ Saved" and this fails. */
  const m = appMount();
  renderAndSave(m, GEN_ID);
  const monday = m.stored()[0];

  m.state.discover.items.push(ep("st9", { release_date: "2026-09-09" }));
  m.state.itemIndex = {};
  m.state.poolIds = new Set();
  m.ctx.renderPlaylistDetail(GEN_ID);
  assert.match(m.view(), /<button type="button" class="pl-save" id="pl-save">Save to my playlists<\/button>/,
    "a copy of a different set of episodes is not this playlist saved");
  assert.ok(m.view().includes(`You saved an earlier version of this playlist. <a href="#/playlist/${monday.id}">Open that copy</a>`));

  m.el("pl-save").click();
  const list = m.stored();
  assert.strictEqual(list.length, 2, "the new set is a new copy; the earlier one is kept");
  assert.ok(list[0].items.some((p) => p.id === "st9"));
  assert.notStrictEqual(list[0].id, monday.id, "the two copies have their own ids");
  assert.deepStrictEqual(list[1].items.map((p) => p.id), monday.items.map((p) => p.id), "the earlier copy did not change");
  assert.strictEqual(m.el("pl-save").textContent, "✓ Saved");
});

/* ==================================================================== */
/* 5. THE CAP IS SAID, NOT APPLIED                                        */
/* ==================================================================== */

test("with 50 playlists kept, Save says so and pushes nothing off the end", () => {
  /* MUTATION: drop `if (all.length >= PLAYLISTS_CAP) return { status: "full" }`
     -> the edit's own guard keeps the list, but the page claims "Saved"; drop
     both guards -> the slice to 50 silently removes "Own 49" and this fails. */
  const fifty = Array.from({ length: 50 }, (_, i) => ownPlaylist(i));
  const m = appMount({ seed: { cp_playlists: JSON.stringify(fifty) } });
  const btn = renderAndSave(m, GEN_ID);

  const list = m.stored();
  assert.strictEqual(list.length, 50);
  assert.ok(list.some((p) => p.id === "q49"), "the oldest playlist is still there");
  assert.ok(!list.some((p) => p.saved_from), "nothing was saved");
  assert.strictEqual(btn.textContent, "Save to my playlists", "the control does not claim a save");
  assert.ok(!btn.classList.contains("on"));
  assert.strictEqual(m.el("pl-save-note").textContent, FULL_NOTE);

  /* One fewer and it saves, as the newest. */
  const m2 = appMount({ seed: { cp_playlists: JSON.stringify(fifty.slice(0, 49)) } });
  renderAndSave(m2, GEN_ID);
  assert.strictEqual(m2.stored().length, 50);
  assert.ok(m2.stored()[0].saved_from, "the copy is first, like a new build");
  assert.ok(m2.stored().some((p) => p.id === "q48"), "and the 49th own playlist stays");
});

test("Create's builder refuses at the cap too, and nothing cuts a store that already holds more than 50", () => {
  /* MUTATION 1: drop buildPlaylist's cap check -> savePlaylists' slice pushes
     the oldest playlist off the end and the first half fails. MUTATION 2: put
     `.slice(0, PLAYLISTS_CAP)` back in applyPlaylistEdit -> the refused save
     and the remove each cut the 52-entry store and the second half fails. */
  const m = appMount({ seed: { cp_playlists: JSON.stringify(Array.from({ length: 49 }, (_, i) => ownPlaylist(i))) } });
  renderAndSave(m, GEN_ID);   // the 50th: a saved copy, told it "stays as it is now"
  const before = m.stored().map((p) => p.id);
  assert.strictEqual(before.length, 50, "fixture assumption: the store is full");
  const built = m.ctx.buildPlaylist("startups");
  assert.strictEqual(built.status, "full", "a 51st build is refused, not squeezed in");
  assert.deepStrictEqual(m.stored().map((p) => p.id), before, "nothing was pushed off the end");

  const m2 = appMount({ seed: { cp_playlists: JSON.stringify(Array.from({ length: 52 }, (_, i) => ownPlaylist(i))) } });
  renderAndSave(m2, GEN_ID);
  assert.strictEqual(m2.stored().length, 52, "a refused save leaves a store of more than 50 untouched");
  m2.ctx.renderPlaylistDetail("q3");
  m2.el("pl-remove").click();
  assert.strictEqual(m2.stored().length, 51, "a remove takes one playlist, not every one past 50");
  assert.ok(m2.stored().some((p) => p.id === "q51"));
});

/* ==================================================================== */
/* 6. IT IS THE LISTENER'S OWN, EVERYWHERE                                */
/* ==================================================================== */

test("the copy is listed in Library and on the Playlists page, and drawn as own under Playlists for you", () => {
  /* MUTATION 1: have playlistsForYouHtml badge every card whose `saved_from`
     is set (`generated: Boolean(p.saved_from)`) -> the own-card assertion
     fails. MUTATION 2: drop the currentCopyOf filter from playlistsForYouPicks
     (or from playlistSearchMatches) -> two identical cards and this fails.
     Library and the Playlists page read playlists(), so a copy written under
     any other key fails their assertions. */
  const m = appMount();
  renderAndSave(m, GEN_ID);
  const copy = m.stored()[0];

  m.ctx.renderLibrary();
  assert.ok(m.view().includes(`href="#/playlist/${copy.id}"`), "Library -> Playlists lists the copy");

  m.ctx.renderPlaylists();
  assert.ok(m.view().includes(`href="#/playlist/${copy.id}"`), "the Playlists page lists the copy");
  assert.match(m.view(), /<p class="sub">1 playlist<\/p>/, "the count no longer calls every playlist 'built'");

  const rail = m.ctx.playlistsForYouHtml();
  const at = rail.indexOf(`href="#/playlist/${copy.id}"`);
  assert.ok(at > 0, "the copy is under Playlists for you");
  const card = rail.slice(rail.lastIndexOf("<a ", at), rail.indexOf("</a>", at));
  assert.ok(!card.includes("Generated for you"), "the copy carries no generated badge");
  assert.ok(!rail.includes(`href="#/playlist/${encodeURIComponent(GEN_ID)}"`),
    "the unchanged source is not drawn beside its copy as a second identical card");

  const found = m.ctx.playlistSearchMatches("startups");
  assert.deepStrictEqual(Array.from(found.own, (p) => p.id), [copy.id], "Create's search finds the copy as the listener's own");
  assert.strictEqual(found.generated.length, 0, "and not its unchanged source as a second result");
});

test("the copy's own page is an own playlist's page: remove, no Save, and no 'generated for you'", () => {
  /* MUTATION: return the source for an own playlist in savedFromOf (e.g. read
     `p.saved_from` back) -> the copy's page offers Save and this fails. */
  const m = appMount();
  renderAndSave(m, GEN_ID);
  const copy = m.stored()[0];
  m.ctx.renderPlaylistDetail(copy.id);
  const html = m.view();
  assert.ok(!html.includes('id="pl-save"'), "a saved copy is not saved again");
  assert.ok(html.includes('id="pl-remove"'));
  assert.ok(!/generated for you/i.test(html));
  assert.match(html, /4 episodes · playlist/);
});

/* ==================================================================== */
/* 7. FAMILY MODE                                                         */
/* ==================================================================== */

test("a copy saved under Family Mode holds only what Family Mode showed", () => {
  /* The rule is the source's (generatedPlaylists reads poolFiltered); the copy
     inherits it by snapshotting the source as shown. MUTATION: build the copy
     from `fullPool()` filtered to the leaf instead of the source's items (or
     change generatedPlaylists to fullPool()) -> the explicit episode is saved
     and this fails. */
  const m = appMount({ seed: { cp_family: "true" }, startups: [1, 2, 3, 4] });
  m.state.discover.items.push(ep("st-explicit", { release_date: "2026-09-08", explicit: true }));
  renderAndSave(m, GEN_ID);
  const copy = m.stored()[0];
  assert.ok(!copy.items.some((p) => p.id === "st-explicit"), "Family Mode's filter carried into the copy");
  assert.strictEqual(copy.items.length, 4);
});

test("a copy saved with Family Mode OFF neither lists nor plays an explicit episode once Family Mode is on", () => {
  /* The leak direction. MUTATION: drop the `familyHides(live)` line from
     resolveParts -> the copy's page draws the explicit row with its ▶ and
     Home's play button starts it (it is newest, so first); this fails. */
  const m = appMount({ startups: [1, 2, 3, 4] });
  m.state.discover.items.push(ep("st-explicit", { release_date: "2026-09-08", explicit: true }));
  renderAndSave(m, GEN_ID);
  const copy = m.stored()[0];
  assert.strictEqual(copy.items[0].id, "st-explicit", "fixture assumption: saved with it off, the explicit episode is first");

  m.store.set("cp_family", "true");
  m.ctx.renderPlaylistDetail(copy.id);
  const html = m.view();
  assert.ok(!html.includes('data-play="st-explicit"'), "no play button for it");
  assert.ok(!html.includes("Episode st-explicit"), "nor its title");
  assert.ok(html.includes("Hidden by Family Mode"), "its row says what holds it back");
  assert.strictEqual((html.match(/class="ep-row/g) || []).length, 5, "and keeps its place, so the count stays true");

  const t = m.ctx.homePlayTarget();
  assert.ok(t, "fixture assumption: Home has something to play");
  assert.notStrictEqual(t.item.id, "st-explicit", "Home's play button does not start it");
  assert.ok(!Array.from(t.list || [], (x) => x.id).includes("st-explicit"), "nor queue it after the first");
});

/* ==================================================================== */
/* 8. THE PLAYABLE-SNAPSHOT RULE                                          */
/* ==================================================================== */

test("after the catalogue moves, a saved item with an audio_url snapshot still plays; one without stays listed", () => {
  /* The rule is liveEpisode's, reached through resolveParts — one path for
     every own playlist. MUTATION: make liveEpisode answer from the pool only
     (drop the storedEpisode branch) -> st4 renders archived and this fails;
     make resolveParts drop non-live parts -> the row count falls. */
  const m = appMount();
  renderAndSave(m, GEN_ID);
  const copy = m.stored()[0];

  m.store.set("cp_episode_snaps", JSON.stringify({ st4: ep("st4", { release_date: "2026-09-04" }) }));
  m.state.discover.items = m.state.discover.items.filter((it) => it.id !== "st4" && it.id !== "st3");
  m.state.itemIndex = {};
  m.state.poolIds = new Set();

  m.ctx.renderPlaylistDetail(copy.id);
  const html = m.view();
  assert.strictEqual((html.match(/class="ep-row/g) || []).length, 4, "every saved item keeps its row");
  assert.ok(html.includes('data-play="st4"'), "st4 has a stored audio_url snapshot: it plays");
  assert.ok(!html.includes('data-play="st3"'), "st3 has none: no play button");
  assert.strictEqual((html.match(/class="ep-row gone"/g) || []).length, 1, "st3 stays listed, labelled");

  m.ctx.renderPlaylistDetail(copy.id);   // the second render (#276's lesson)
  assert.ok(m.view().includes('data-play="st4"') && !m.view().includes('data-play="st3"'));
});

/* ==================================================================== */
/* 9. PLAYING A SAVED COPY                                                */
/* ==================================================================== */

test("playing from a saved copy uses its rows as the play list and stamps its last_played_at", async () => {
  /* MUTATION: give a saved copy the generated ctx (keep `isGenerated` on it)
     -> its rows carry `generated-…`, touchPlaylistPlayed never runs and the
     stamp assertion fails. */
  const m = appMount();
  renderAndSave(m, GEN_ID);
  const copy = m.stored()[0];
  m.ctx.renderPlaylistDetail(copy.id);
  const ctxName = `playlist-${copy.id}`;
  assert.ok(m.view().includes(`data-ctx="${ctxName}"`), "the copy's rows carry an own playlist's ctx");

  const ids = copy.items.map((p) => p.id);
  const ok = await m.ctx.startEpisodePlay(ids[1], m.ctx.liveEpisode(ids[1]), {
    ctx: ctxName, list: ids.map((id) => ({ id, ctx: ctxName })),
  });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual([...m.state.playList], ids, "continuous playback walks the copy's rows");
  assert.strictEqual(m.state.playListCursor, ids[1]);
  assert.match(m.stored()[0].last_played_at || "", /^\d{4}-/, "the copy is stamped like any own playlist");
});

/* ==================================================================== */
/* 10. THE SINGLE WRITER (round-3 app-1-1)                                */
/* ==================================================================== */

/** A durable store the way durable-store.js behaves: reads are memory; a key
    this session wrote is DIRTY and hydration never replaces it (property 2). */
function slowStore(durable) {
  const mem = new Map();
  const dirty = new Set();
  const setCalls = [];
  return {
    setCalls,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { setCalls.push(k); dirty.add(k); mem.set(k, String(v)); },
    removeItem: (k) => { dirty.add(k); mem.delete(k); },
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
    hydrate: () => new Promise(() => {}),   // never on its own: the test lands it
    land() { for (const [k, v] of Object.entries(durable)) if (!dirty.has(k)) mem.set(k, v); },
  };
}

/** Put `m` behind a slow durable store holding `durable`. `land()` lands
    hydration and settles storage, as init() would. */
async function hydrating(m, durable) {
  await new Promise((r) => setTimeout(r, 0));   // let init()'s storage wait settle first
  const store = slowStore(durable);
  m.ctx.forayStorage = store;
  m.evalIn("storageSettled = false");
  assert.strictEqual(m.evalIn("storageWaiting()"), true, "fixture assumption: the store is hydrating");
  return {
    store,
    list: () => JSON.parse(store.getItem("cp_playlists") || "null"),
    land() { store.land(); m.evalIn("markStorageSettled()"); },
  };
}

test("a save before hydration is provisional, lands on the hydrated list, and only then says Saved", async () => {
  /* MUTATION 1: make editPlaylists write immediately (drop the storageWaiting
     branch) -> the early write marks cp_playlists dirty, hydration skips the
     durable list, and "Own 1" is lost. MUTATION 2: answer "saved" for a queued
     edit in savePlaylistCopy -> the control claims Saved before anything is
     kept and the provisional assertions fail. */
  const m = appMount();
  const events = spyEvents(m);
  const h = await hydrating(m, { cp_playlists: JSON.stringify([ownPlaylist(1)]) });

  const btn = renderAndSave(m, GEN_ID);
  assert.ok(!h.store.setCalls.includes("cp_playlists"), "nothing written before hydration");
  assert.strictEqual(btn.textContent, "Save to my playlists", "no claim before the save has landed");
  assert.strictEqual(btn.getAttribute("aria-disabled"), "true", "and no second save while it waits");
  assert.strictEqual(m.el("pl-save-note").textContent, "Saving. 4a is still opening your playlists.");
  assert.ok(!events().includes("playlist_saved"), "nothing is logged as saved yet");
  btn.click();
  assert.strictEqual(m.evalIn("pendingPlaylistEdits.length"), 1, "a second tap queues nothing");

  h.land();
  assert.deepStrictEqual(h.list().map((p) => p.title), ["Startups", "Own 1"], "the copy joined the durable list");
  assert.strictEqual(btn.textContent, "✓ Saved", "the page says Saved once it is");
  assert.strictEqual(m.el("pl-save-note").textContent, SAVED_NOTE);
  assert.strictEqual(m.el("pl-save-open").getAttribute("href"), `#/playlist/${h.list()[0].id}`);
  assert.deepStrictEqual(events().filter((t) => t === "playlist_saved"), ["playlist_saved"], "logged once, when it landed");
});

test("a save before hydration onto a durable list already at 50 ends saying Full, not Saved", async () => {
  /* localStorage swept, IndexedDB slow, the durable list full. MUTATION: drop
     the `list.length >= PLAYLISTS_CAP` refusal from the edit -> the copy lands
     and pushes past 50 (the store is 51 and "Own 49" is not the last); drop
     the settle report instead -> the note stays "Saving". */
  const m = appMount();
  const events = spyEvents(m);
  const fifty = Array.from({ length: 50 }, (_, i) => ownPlaylist(i));
  const h = await hydrating(m, { cp_playlists: JSON.stringify(fifty) });

  const btn = renderAndSave(m, GEN_ID);
  assert.notStrictEqual(btn.textContent, "✓ Saved");
  h.land();
  assert.strictEqual(h.list().length, 50, "nothing was added and nothing pushed off");
  assert.ok(!h.list().some((p) => p.saved_from));
  assert.strictEqual(btn.textContent, "Save to my playlists", "the page does not end up claiming Saved");
  assert.ok(!btn.hasAttribute("aria-disabled"), "and Save can be tried again after removing one");
  assert.strictEqual(m.el("pl-save-note").textContent, FULL_NOTE);
  assert.strictEqual(m.el("pl-save-open").hidden, true);
  assert.ok(!events().includes("playlist_saved"), "a refused save is not logged as saved");
});

test("a save before hydration does not duplicate a copy the durable list already holds, and links that one", async () => {
  /* The realistic race: the listener saved this source in an earlier session,
     localStorage was swept, and IndexedDB is slow. The unhydrated overlay
     cannot see the old copy, so the tap queues a save; the edit re-checks over
     the SETTLED list. MUTATION: drop the existing-copy check from the edit in
     savePlaylistCopy -> two copies land and this fails. */
  const m = appMount();
  const source = m.ctx.generatedPlaylistById(GEN_ID);
  const earlier = {
    id: "s1", title: "Startups", items: Array.from(source.items, (p) => ({ ...p })), item_ids: Array.from(source.item_ids),
    created: "2026-09-01T00:00:00.000Z", last_played_at: null, sparse: false,
    saved_from: { kind: "generated", source_id: GEN_ID },
  };
  const h = await hydrating(m, { cp_playlists: JSON.stringify([earlier, ownPlaylist(1)]) });
  const btn = renderAndSave(m, GEN_ID);
  h.land();
  const list = h.list();
  assert.strictEqual(list.filter((p) => p.saved_from).length, 1, "one copy per source");
  assert.deepStrictEqual(list.map((p) => p.id), ["s1", "q1"], "and nothing else moved");
  assert.strictEqual(btn.textContent, "✓ Saved");
  assert.strictEqual(m.el("pl-save-open").getAttribute("href"), "#/playlist/s1", "the link opens the copy that exists, not the one that never landed");
});

test("removing a pending copy before hydration removes it; the queued save does not bring it back", async () => {
  /* MUTATION: go back to `savePlaylists(playlists().filter(...))` in the remove
     handler -> it writes the unhydrated list before hydration (and the queued
     save re-adds the copy at settle); this fails. */
  const m = appMount();
  const h = await hydrating(m, { cp_playlists: JSON.stringify([ownPlaylist(1)]) });
  renderAndSave(m, GEN_ID);
  const pending = m.ctx.playlists().find((p) => p.saved_from);
  assert.ok(pending, "the pending copy is listed at once");

  m.ctx.renderPlaylistDetail(pending.id);
  m.el("pl-remove").click();
  assert.ok(!m.ctx.playlists().some((p) => p.saved_from), "gone from the list at once");
  assert.ok(!h.store.setCalls.includes("cp_playlists"), "nothing written before hydration");
  h.land();
  assert.deepStrictEqual(h.list().map((p) => p.id), ["q1"], "the copy stays removed, and the durable list is whole");
});

test("playing a pending copy before hydration stamps it without writing the unhydrated list over the durable one", async () => {
  /* MUTATION: go back to `savePlaylists(all)` in touchPlaylistPlayed -> the
     stamp writes [copy] before hydration, property 2 keeps it over the durable
     list, and "Own 1" is lost; this fails. */
  const m = appMount();
  const h = await hydrating(m, { cp_playlists: JSON.stringify([ownPlaylist(1)]) });
  renderAndSave(m, GEN_ID);
  const pending = m.ctx.playlists().find((p) => p.saved_from);
  m.ctx.touchPlaylistPlayed(pending.id);
  assert.ok(!h.store.setCalls.includes("cp_playlists"), "nothing written before hydration");
  h.land();
  const list = h.list();
  assert.deepStrictEqual(list.map((p) => p.title), ["Startups", "Own 1"], "the durable list is whole");
  assert.match(list[0].last_played_at || "", /^\d{4}-/, "and the copy carries its stamp");
});

/* ==================================================================== */
/* 11. DELETE MY DATA, AND THE COPY                                       */
/* ==================================================================== */

test("'Delete my data' clears a saved copy with every other playlist", async () => {
  /* The storage purge is prefix-based (clearStoredKeys); this pins that a
     saved copy lives under cp_playlists and nowhere else. MUTATION: write the
     copy under a new key without the cp_ prefix -> it survives the clear. */
  const m = appMount();
  renderAndSave(m, GEN_ID);
  const res = await m.ctx.clearStoredKeys();
  /* `ok` is false here only because this harness has no durable tier to purge
     ("no-durable-tier"); what matters is that the key was found and removed. */
  assert.ok(Array.from(res.keys).includes("cp_playlists"), JSON.stringify(res));
  assert.ok(!m.store.has("cp_playlists"));
  assert.deepStrictEqual([...m.store.keys()].filter((k) => !k.startsWith("cp_")), [], "nothing a playlist wrote survives outside cp_");
});

test("the Save control's words and notes follow CLAUDE.md's copy rules, and every outcome it can report has its words", () => {
  /* MUTATION 1: write "Saved to your playlists — a fascinating deep dive." into
     SAVE_PLAYLIST_NOTES.saved -> the banned-word check fails. MUTATION 2:
     delete any one note (say `full` or `pending`) -> the page would say nothing
     about that outcome, and the coverage check fails. */
  const m = appMount();
  const spec = m.evalIn("SAVE_PLAYLIST_TOGGLE");
  const notes = m.evalIn("SAVE_PLAYLIST_NOTES");
  const lines = [spec.offText, spec.onText, spec.offLabel, spec.onLabel, ...Object.values(notes)];
  for (const line of lines) {
    assert.doesNotMatch(line, /fascinating|deep dive|delve|explores|commute/i, `banned word: "${line}"`);
  }
  assert.match(spec.onLabel, /^Saved\b/, "the name starts with the visible word (label in name)");
  for (const status of ["saved", "exists", "pending", "full", "unsaved"]) {
    assert.ok(typeof notes[status] === "string" && notes[status].length, `no words for a "${status}" save`);
  }
});
