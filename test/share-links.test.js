/* Share links (#1071, SH-1): copy link / share sheet on shows, episodes,
 * playlists, Suggested cards and published Forays.
 *
 * Founder, #1071 (2026-10-05): "Let's work towards opening directly in the
 * app" — so every link is on PUBLIC_WEB_ORIGIN, an origin whose root we control
 * (the universal-links groundwork serves the association files there), not
 * GitHub Pages. Sharing is not gated on a legal review (docs/DECISIONS.md,
 * 2026-10-05, PR #1074).
 *
 * What this suite pins, each with the one-line mutation that turns it red (all
 * run):
 *   (a) a show link is the bare show route, whatever the address bar says;
 *   (b) an episode link is the episode page for a catalogue episode and for a
 *       breadth one whose id names its show (SH-COLD), an episode of a pi:
 *       show carrying its show's shard key (/k/, pi-episodes-cold-open), else
 *       its show, else the publisher's Apple page, else no button; a pi:
 *       show's link carries its shard key (/k/), else pod.link, else no button;
 *   (c) a draft Foray has no button and no link; nothing reads location;
 *   (d) the origin is the one constant, the API's own;
 *   (e) a listener's own playlist is FROZEN into the link: never its own id,
 *       catalogue ids only, capped at 50, and the link renders back;
 *   (f) a shared title is escaped; a malformed link is "Playlist not found.";
 *   (g) a Suggested card shares its lead episode, not the subject route;
 *   (h) the share text never carries a hook;
 *   (i) delivery order: native plugin, Web Share, clipboard, the link on screen,
 *       and a cancel ends it;
 *   (j) no event is logged for a share.
 * The spec's (k), an appUrlOpen router, belongs to the universal-links
 * groundwork card (orchestrator amendment 4) and is not built here.
 *
 * WHICH SUITE COVERS WHAT ELSE: test/tap-targets.test.js classifies
 * `.share-btn` against the 44px floor; test/legal-citations.test.js holds the
 * event census this change leaves alone; test/playlist-durability.test.js holds
 * safeShareLink (its harness has no btoa, so a shareBtn that let a throw out
 * fails all 20 of its playlist-page tests; mutation run: return
 * shareLinkFor(target) without the try).
 *
 * HARNESS: node:vm with the flat-by-id DOM of test/save-playlist.test.js. The
 * share click is delegated, so tests drive onShareClick with a fake button the
 * way test/async-identity.test.js drives onForayScriptClick.
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
const ORIGIN = "https://foray-web-seven.vercel.app/";

process.on("unhandledRejection", () => {});

function makeEl(tag = "div") {
  const attrs = new Map();
  return {
    tagName: String(tag).toUpperCase(), id: null, className: "", innerHTML: "", textContent: "",
    hidden: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; }, append() {},
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => attrs.get(k) ?? null,
    removeAttribute: (k) => attrs.delete(k), hasAttribute: (k) => attrs.has(k),
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    focus() {}, select() {}, remove() {}, insertAdjacentHTML() {},
  };
}

function mount({ seed = {}, hash = "#/", search = "" } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(["view", "drawer", "drawer-overlay", "banner-slot"].map((id) => [id, Object.assign(makeEl(), { id })]));
  let viewHtml = "";
  Object.defineProperty(byId.get("view"), "innerHTML", { get: () => viewHtml, set: (v) => { viewHtml = String(v); } });
  const docListeners = [];
  const ctx = {
    console: { ...console, warn() {}, error() {}, log() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: makeEl("body"), documentElement: makeEl(), readyState: "complete",
      addEventListener: (type, fn) => docListeners.push([type, fn]), createElement: (t) => makeEl(t),
      querySelector: (sel) => (String(sel).startsWith("#") ? byId.get(String(sel).slice(1)) ?? null : null),
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    /* The address bar a shared link must never be built from: a show-page
       search, a `?foray=` draft unlock, and the shell's own origin. */
    location: { hash, search, pathname: "/", href: `capacitor://localhost/${search}${hash}` },
    history: { replaceState() {}, pushState() {}, back() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    btoa: (s) => Buffer.from(s, "latin1").toString("base64"),
    atob: (s) => { if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) throw new Error("InvalidCharacterError"); return Buffer.from(s, "base64").toString("latin1"); },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  return { ctx, evalIn, store, docListeners, state: evalIn("state"), view: () => viewHtml };
}

function ep(id, over = {}) {
  return {
    id, title: `Episode ${id}`, show: "Founders", duration_min: 30, topics: ["engineering"],
    release_date: "2026-09-01", audio_url: `https://cdn.test/${encodeURIComponent(id)}.mp3`,
    hook: "SECRET HOOK never leaves the app.", ...over,
  };
}

/** A mounted app with a catalogue of `n` pool episodes (p1..pn) and one show. */
function appMount(opts = {}, n = 4) {
  const m = mount(opts);
  m.state.catalog = { shows: [{ show_id: "lex-fridman-podcast", title: "Lex Fridman Podcast" }, { show_id: "founders", title: "Founders" }] };
  m.state.taxonomy = { nodes: [{ id: "engineering", parent: null, label: "Engineering", weight: 0.9 }] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.interests = { engineering: 0.9 };
  const items = Array.from({ length: n }, (_, i) => ep("p" + (i + 1)));
  items.push(ep("lex--https://lexfridman.com/?p=6554", { show: "Lex Fridman Podcast" }));
  m.state.discover = { items };
  m.state.itemIndex = {};
  m.state.poolIds = new Set();
  m.state.cardSlots = [{ branch: "engineering", role: "top", item: items[0], items: items.slice(0, 2) }];
  m.state.forays = { forays: [
    { id: "draft-1", status: "draft", title: "A draft" },
    { id: "pub-1", status: "published", title: "A published Foray" },
  ] };
  return m;
}

const link = (m, target) => {
  const r = m.ctx.ForayShare.linkFor(target);
  return r && JSON.parse(JSON.stringify(r));
};

/** Click a share button described by its data attributes; returns what
    navigator.share received. */
async function clickShare(m, kind, id) {
  const shared = [];
  m.ctx.navigator.share = async (d) => { shared.push({ ...d }); };
  const btn = { dataset: { share: kind, shareId: id } };
  m.ctx.onShareClick({ target: { closest: () => btn }, preventDefault() {}, stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  return shared;
}

/* (a) ------------------------------------------------------------------- */

test("(a) a show link is ORIGIN + #/show/<id>, even while the page is on its /q/ search", () => {
  /* MUTATION: build it as `showRouteHash(t.id, (parseShowRoute() || {}).query)`
     (or from location.href) -> it carries /q/foo (or capacitor://) and fails. */
  const m = appMount({ hash: "#/show/lex-fridman-podcast/q/foo" });
  assert.deepStrictEqual(link(m, { kind: "show", id: "lex-fridman-podcast" }),
    { url: ORIGIN + "#/show/lex-fridman-podcast", text: "Lex Fridman Podcast" });
});

test("(a) the show page renders a 44px Share button named for the show, beside Follow", () => {
  /* MUTATION: drop the shareBtn call from renderShow's hero -> no button. */
  const m = appMount({ hash: "#/show/lex-fridman-podcast" });
  m.ctx.renderShow("lex-fridman-podcast");
  assert.match(m.view(), /<button type="button" class="share-btn" data-share="show" data-share-id="lex-fridman-podcast" aria-label="Share Lex Fridman Podcast">[\s\S]*?<\/button><button class="show-star[^"]*" data-show-star="lex-fridman-podcast"/);
});

test("(a) a shared breadth show link cold-opens on a fresh device through the id lookup", async () => {
  /* CHARACTERIZATION for SH-COLD's refactor of resolveMissingShow (the `pi:`
     shard lookup and this one now share one Loading / late-answer / miss /
     Try again path); green on the code before it as well.
     MUTATION: drop `else state.breadthShowCache[show_id] = row;` -> showById
     never answers and the page stays on "Loading show…"; red. */
  const m = appMount({ hash: "#/show/breadth-77" });
  const asked = [];
  m.ctx.fetch = (url) => {
    asked.push(String(url));
    return String(url).includes("api/shows/search?id=breadth-77")
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ show: { show_id: "breadth-77", title: "Breadth Seventy-Seven", artwork_url: null, taxonomy_node_ids: [], tier: "breadth" } }) })
      : new Promise(() => {});
  };
  m.ctx.renderShow("breadth-77");
  assert.match(m.view(), /Loading show…/);
  for (let i = 0; i < 20 && !m.view().includes("Breadth Seventy-Seven"); i++) await new Promise((r) => setImmediate(r));
  assert.match(m.view(), /Breadth Seventy-Seven/);
  assert.strictEqual(asked.filter((u) => u.includes("api/shows/search?id=")).length, 1);
  assert.deepStrictEqual(link(m, { kind: "show", id: "breadth-77" }), { url: ORIGIN + "#/show/breadth-77", text: "Breadth Seventy-Seven" });
});

/* (b) ------------------------------------------------------------------- */

test("(b) a catalogue episode links to its own page, encoded", () => {
  /* MUTATION: drop encodeURIComponent -> the raw `?p=` id splits the route. */
  const m = appMount();
  const id = "lex--https://lexfridman.com/?p=6554";
  assert.strictEqual(link(m, { kind: "episode", id }).url, ORIGIN + "#/episode/" + encodeURIComponent(id));
  assert.strictEqual(link(m, { kind: "episode", id }).text, "Episode " + id + " · Lex Fridman Podcast");
});

test("(b) a breadth episode links to its own page, its id naming its show; a keyless pi: or unparseable id falls back to its show, then Apple's page, then nothing", () => {
  /* SH-COLD: a fresh device pages the show named in the id for it
     (resolveMissingEpisode, test/episode-deeplink.test.js). REWRITTEN for
     pi-episodes-cold-open: a pi: episode now links to its own page when its
     show gives a shard key (the next test), so the fallbacks are pinned on
     pi: episodes whose show title gives none ("日本の話").
     MUTATION: delete shareLinkFor's `localEpisodeIdentity` branch -> the
     breadth episode gets #/show/founders again; red on the first assert.
     MUTATION 2: drop `!idShow.startsWith("pi:")` -> the keyless pi: episode
     gets an #/episode/ link with no key, which a fresh device cannot open; red.
     MUTATION 3: drop the `item.show_id` pi: check -> `x--1` of a pi: show
     gets an #/episode/ link the fresh device would page the wrong show for; red. */
  const m = appMount();
  const breadth = ep("founders--guid-9", { show_id: "founders", title: "Breadth one" });
  assert.deepStrictEqual(link(m, { kind: "episode", item: breadth }),
    { url: ORIGIN + "#/episode/founders--guid-9", text: "Breadth one · Founders" });
  const urlGuid = ep("lex-fridman-podcast--https://lexfridman.com/?p=1", { show_id: "lex-fridman-podcast" });
  assert.strictEqual(link(m, { kind: "episode", item: urlGuid }).url, ORIGIN + "#/episode/" + encodeURIComponent(urlGuid.id), "encoded");
  const fromSearch = ep("apple:founders:g-1", { title: "From search" });
  assert.strictEqual(link(m, { kind: "episode", item: fromSearch }).url, ORIGIN + "#/episode/" + encodeURIComponent("apple:founders:g-1"));

  const piEpisode = ep("pi:77--g", { show: "日本の話", apple_episode_url: "https://podcasts.apple.com/us/podcast/x/id1?i=3" });
  assert.strictEqual(link(m, { kind: "episode", item: piEpisode }).url, "https://podcasts.apple.com/us/podcast/x/id1?i=3");
  const onlyApple = ep("x--1", { show: "Nowhere", show_id: "pi:77", apple_episode_url: "https://podcasts.apple.com/us/podcast/x/id1?i=2" });
  assert.strictEqual(link(m, { kind: "episode", item: onlyApple }).url, "https://podcasts.apple.com/us/podcast/x/id1?i=2");
  const unparsed = ep("solo", { title: "Solo" });
  assert.strictEqual(link(m, { kind: "episode", item: unparsed }).url, ORIGIN + "#/show/founders", "an id that does not parse keeps its show's link");
  const nothing = ep("pi:77--2", { show: "日本の話", apple_episode_url: "javascript:alert(1)" });
  assert.strictEqual(link(m, { kind: "episode", item: nothing }), null);
  assert.strictEqual(m.ctx.shareBtn({ kind: "episode", id: nothing.id, item: nothing, title: "t" }), "");
});

test("(b) an episode of a pi: show links to its own page with its show's shard key: the show record's, else the episode's show title's", () => {
  /* pi-episodes-cold-open: the endpoint finds a pi: show only in the shard its
     row lives in (api/shows/[show_id]/episodes.ts resolvePiShow), so the link
     carries it the way a pi: show link does, and the router hands it back.
     MUTATION: delete the pi: branch (`if (idShow && guid && /^pi:\d+$/ ...`)
     -> the Apple fallback; red. MUTATION 2: drop `showById(idShow) ||` ->
     the record's author key ("ya") is lost and the title gives none; red.
     MUTATION 3: drop `|| { title: item.show }` -> an episode whose show is
     not in this session has no key and falls back; red. MUTATION 4: drop
     `!item.show_id ||` -> an episode with no show_id field falls back; red.
     MUTATION 5: parseEpisodeSeg's id part `(.+)` instead of `([^/]+)` ->
     a raw-slash legacy id is split at its own "/k/"; red. */
  const m = appMount();
  const apple = "https://podcasts.apple.com/us/podcast/x/id1?i=9";
  const fromTitle = ep("pi:77--g-1", { show: "Tiny", show_id: "pi:77", apple_episode_url: apple });
  const url = link(m, { kind: "episode", item: fromTitle }).url;
  assert.strictEqual(url, ORIGIN + "#/episode/" + encodeURIComponent("pi:77--g-1") + "/k/ti");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m.ctx.parseEpisodeSeg(url.slice((ORIGIN + "#/episode/").length)))),
    { id: "pi:77--g-1", key: "ti" }, "the router reads the id and the key back");
  const noShowId = ep("pi:77--g-2", { show: "Tiny", apple_episode_url: apple });
  assert.strictEqual(link(m, { kind: "episode", item: noShowId }).url, ORIGIN + "#/episode/" + encodeURIComponent("pi:77--g-2") + "/k/ti");
  m.state.shardShowCache["pi:78"] = { show_id: "pi:78", title: "日本の話", artist_name: "Taro Yamada" };
  const fromRecord = ep("pi:78--g", { show: "日本の話", show_id: "pi:78", apple_episode_url: apple });
  assert.strictEqual(link(m, { kind: "episode", item: fromRecord }).url, ORIGIN + "#/episode/" + encodeURIComponent("pi:78--g") + "/k/ya",
    "the show record's author keys it, as on the show's own link");
  const showLink = link(m, { kind: "show", id: "pi:78" }).url;
  assert.strictEqual(/\/k\/([^/]+)$/.exec(showLink)[1], "ya", "the same key the show's own link carries");
  for (const [seg, want] of [
    ["founders--g", { id: "founders--g", key: "" }],
    [encodeURIComponent("lex--https://x.test/k/ab"), { id: "lex--https://x.test/k/ab", key: "" }],
    ["lex--https://x.test/k/ab", { id: "lex--https://x.test/k/ab", key: "" }],
  ]) assert.deepStrictEqual(JSON.parse(JSON.stringify(m.ctx.parseEpisodeSeg(seg))), want, seg);
});

test("(b) a pi: show links with its shard key (title, else author); with no key, pod.link; with neither, no link and no button", () => {
  /* SH-COLD: the key is what lets a fresh device find the row
     (resolveMissingShow, test/offline-search.test.js).
     MUTATION: delete the `if (key) return` line -> pod.link / null; red.
     MUTATION 2: drop `|| SearchEngine.shardKeyForQuery(s.artist_name)` -> the
     title with no a-z0-9 token has no key and falls to pod.link; red. */
  const m = appMount({ hash: "#/show/pi:42" });
  m.state.shardShowCache["pi:42"] = { show_id: "pi:42", title: "Shard show", tier: "breadth" };
  assert.deepStrictEqual(link(m, { kind: "show", id: "pi:42" }),
    { url: ORIGIN + "#/show/pi%3A42/k/sh", text: "Shard show" }, "the longest title token keys the shard");
  m.state.shardShowCache["pi:43"] = { show_id: "pi:43", title: "日本の話", artist_name: "Taro Yamada", apple_collection_id: 1434243584 };
  assert.strictEqual(link(m, { kind: "show", id: "pi:43" }).url, ORIGIN + "#/show/pi%3A43/k/ya", "the author keys it when the title cannot");
  m.state.shardShowCache["pi:44"] = { show_id: "pi:44", title: "日本の話", tier: "breadth" };
  assert.strictEqual(link(m, { kind: "show", id: "pi:44" }), null);
  m.ctx.location.hash = "#/show/pi:44";
  m.ctx.renderShow("pi:44");
  assert.ok(m.view().includes("日本の話") && !m.view().includes("share-btn"), "rendered, with no share button");
  m.state.shardShowCache["pi:44"].apple_collection_id = 1434243584;
  assert.strictEqual(link(m, { kind: "show", id: "pi:44" }).url, "https://pod.link/1434243584");
});

test("(b) a pi: link's key is one tools/shows/shard-build.mjs files that row under, so client and builder cannot drift", async () => {
  /* Mirrors the builder: tokenPrefixesFor over the same title and author.
     MUTATION: derive the key as
     `SearchEngine.normalizeShardPrefixKey(String(s.title).slice(0, 2).toLowerCase())`
     -> "¡Café Tacvba!" keys "__", a shard the builder never put it in; red. */
  const builder = await import(pathToFileURL(path.join(ROOT, "tools", "shows", "shard-build.mjs")).href);
  const m = appMount();
  const cases = [
    { title: "¡Café Tacvba!", author: null },
    { title: "The Daily", author: "The New York Times" },
    { title: "Économie & Société", author: "Radio France" },
    { title: "99% Invisible", author: "Roman Mars" },
    { title: "X", author: null },
    { title: "日本の話", author: "Taro Yamada" },
  ];
  cases.forEach(({ title, author }, i) => {
    const id = "pi:" + (900 + i);
    m.state.shardShowCache[id] = { show_id: id, title, artist_name: author };
    const url = link(m, { kind: "show", id }).url;
    const key = decodeURIComponent(/\/k\/([^/]+)$/.exec(url)[1]);
    const prefixes = builder.tokenPrefixesFor({ title, itunesAuthor: author });
    assert.ok(prefixes.includes(key), `${title}: key ${key} not among the builder's ${prefixes}`);
    assert.strictEqual(m.ctx.parseShowRoute(url.slice(ORIGIN.length)).key, key, "and the router reads it back");
  });
});

test("(b) parseShowRoute round-trips id, /k/ key and /q/ query; every older spelling parses as before", () => {
  /* MUTATION: drop the `(?:\/k\/([^/]+))?` group -> `pi:123/k/ab` no longer
     parses (the id segment cannot hold a `/`); red.
     MUTATION 2: emit `/q/` before `/k/` in showRoutePath -> the key is read as
     part of the query; red on the round trip. */
  const m = appMount();
  const parse = (h) => JSON.parse(JSON.stringify(m.ctx.parseShowRoute(h)));
  assert.deepStrictEqual(parse("#/show/pi%3A123/k/ab"), { id: "pi:123", key: "ab", query: "" });
  assert.deepStrictEqual(parse("#/show/pi%3A123/k/ab/q/foo"), { id: "pi:123", key: "ab", query: "foo" });
  assert.deepStrictEqual(parse("#/show/founders"), { id: "founders", key: "", query: "" });
  assert.deepStrictEqual(parse("#/show/founders/q/k%2Fab"), { id: "founders", key: "", query: "k/ab" });
  assert.deepStrictEqual(parse("#/show/founders/q/k/ab"), { id: "founders", key: "", query: "k/ab" }, "a raw /k/ after /q/ is query text");
  for (const [id, query, key] of [["pi:123", "", "ab"], ["pi:123", "big thing", "a_"], ["x/y?z", "q/r", ""], ["founders", "", ""]]) {
    assert.deepStrictEqual(parse("#" + m.ctx.showRoutePath(id, query, key)), { id, key, query });
  }
  assert.strictEqual(m.ctx.showRouteHash("founders", "foo"), "#/show/founders/q/foo", "the two-argument callers are unchanged");
});

test("(b) the episode page's action row carries the share button", () => {
  /* MUTATION: drop the shareBtn call from renderEpisode's .ep-actions line. */
  const m = appMount({ hash: "#/episode/p1" });
  m.ctx.renderEpisode("p1");
  assert.match(m.view(), /<div class="ep-actions">.*<button type="button" class="share-btn" data-share="episode" data-share-id="p1" aria-label="Share Episode p1">.*<\/div>/);
});

/* (c) ------------------------------------------------------------------- */

test("(c) a draft Foray has no link and no button; a published one links to its route", async () => {
  /* MUTATION: remove `|| f.status !== "published"` from shareLinkFor -> the
     draft gets a link, and its page a button. (renderForay's own `draft ? "" :`
     is a second guard over the same rule: dropping it alone stays green,
     because shareBtn asks shareLinkFor, so the status check above is the one
     this test holds.) */
  const m = appMount({ hash: "#/foray/draft-1", search: "?foray=draft-1" });
  assert.strictEqual(link(m, { kind: "foray", id: "draft-1" }), null);
  assert.strictEqual(m.ctx.shareBtn({ kind: "foray", id: "draft-1", title: "A draft" }), "");
  assert.deepStrictEqual(link(m, { kind: "foray", id: "pub-1" }), { url: ORIGIN + "#/foray/pub-1", text: "A published Foray" });

  for (const [id, status] of [["draft-1", "draft"], ["pub-1", "published"]]) {
    m.ctx.location.hash = "#/foray/" + id;
    m.ctx.ForayPlayer = {
      resolve: () => ({ id, title: "T " + id, foray: { status }, entries: [], unplayable: [], playable: [], slots: [] }),
      fmtClock: () => "0:00", forayResumeList: () => [], listForays: () => [],
    };
    await m.ctx.renderForay(id).catch(() => {}); // the head is written before the strip is mounted
    assert.ok(m.view().includes(`<h2>T ${id}</h2>`), `${id}: the page head was written (else the next line is vacuous)`);
    assert.strictEqual(m.view().includes('class="share-btn"'), status === "published", `${id}: button iff published`);
  }
});

test("(c) with ?foray= in the address, no produced link carries it (nothing reads location)", () => {
  /* MUTATION: build any URL from location.href (or append location.search)
     -> `foray=` or capacitor:// appears. */
  const m = appMount({ hash: "#/playlist/q1", search: "?foray=draft-1" });
  const urls = [
    link(m, { kind: "show", id: "lex-fridman-podcast" }),
    link(m, { kind: "episode", id: "p1" }),
    link(m, { kind: "foray", id: "pub-1" }),
    link(m, { kind: "playlist", playlist: { id: "q1", title: "Mine", items: [{ id: "p1" }] } }),
    link(m, { kind: "playlist", id: "gen-engineering", playlist: { id: "gen-engineering", title: "Gen", isGenerated: true, items: [] } }),
  ].map((r) => r.url);
  for (const u of urls) {
    assert.ok(!u.includes("foray="), u);
    assert.ok(u.startsWith(ORIGIN), u);
  }
});

/* (d) ------------------------------------------------------------------- */

test("(d) PUBLIC_WEB_ORIGIN is the one constant, on the API's own origin", () => {
  /* MUTATION: typo the constant (e.g. `foray-web-seven.vercel.app` ->
     `foray-web-7.vercel.app`, or drop the trailing slash) -> red. */
  const m = mount();
  assert.strictEqual(m.evalIn("PUBLIC_WEB_ORIGIN"), ORIGIN);
  assert.strictEqual(m.evalIn("PUBLIC_WEB_ORIGIN"), m.evalIn("API_ORIGIN") + "/");
  const csp = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(csp.includes(ORIGIN.replace(/\/$/, "")), "the same origin index.html's CSP already names");
});

test("(d) CH-23 (A1-17): app.js spells the origin once — PUBLIC_WEB_ORIGIN is derived from API_ORIGIN, not a second literal", () => {
  /* Two literals meant a domain move edited one, and the pin above (not the
     code) said so. MUTATION: write PUBLIC_WEB_ORIGIN as its own
     "https://foray-web-seven.vercel.app/" literal again -> two; red. */
  const code = APP_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const host = ORIGIN.replace(/^https:\/\//, "").replace(/\/$/, "");
  const literals = code.match(new RegExp(`["'\`]https://${host.replace(/\./g, "\\.")}`, "g")) || [];
  assert.strictEqual(literals.length, 1, `the origin is spelled ${literals.length} times in app.js's code`);
  assert.match(code, /const API_ORIGIN = "https:\/\/foray-web-seven\.vercel\.app";/, "the one spelling is API_ORIGIN");
  assert.match(code, /const PUBLIC_WEB_ORIGIN = API_ORIGIN \+ "\/";/, "and the share links' origin is derived from it");
});

/* (e) ------------------------------------------------------------------- */

function sharedIdOf(url) {
  const m = /#\/playlist\/(.+)$/.exec(url);
  assert.ok(m, "a #/playlist/ link: " + url);
  return decodeURIComponent(m[1]);
}

test("(e) a listener's own playlist is frozen into the link: never its id, catalogue ids only, and it renders back", () => {
  /* MUTATION: share the raw id (`playlistRoute({ id: p.id })` for every
     playlist) -> the link contains q1690000000000. MUTATION: drop the
     `.filter(inDiscoverPool)` in shareLinkFor -> the gone id is carried. */
  const own = { id: "q1690000000000", title: "Commute mix", query: "commute", created: "2026-09-01T00:00:00.000Z",
    items: [{ id: "p2", title: "Episode p2", show: "Founders" }, { id: "gone-1", title: "Gone", show: "S" }, { id: "p1" }],
    item_ids: ["p2", "gone-1", "p1"], last_played_at: null, sparse: false };
  const m = appMount({ seed: { cp_playlists: JSON.stringify([own]) } });
  const out = link(m, { kind: "playlist", id: own.id });
  assert.ok(out, "the playlist has a link");
  assert.ok(!out.url.includes("q1690000000000"), out.url);
  assert.strictEqual(out.text, "Commute mix");
  const id = sharedIdOf(out.url);
  assert.ok(id.startsWith("shared~"));
  const payload = JSON.parse(Buffer.from(id.slice(7), "base64url").toString("utf8"));
  assert.deepStrictEqual(payload, { t: "Commute mix", e: ["p2", "p1"] }, "the link itself carries only catalogue ids");

  const fresh = appMount();
  fresh.ctx.renderPlaylistDetail(id);
  const html = fresh.view();
  assert.ok(html.includes("<h2>Commute mix</h2>"), "same title");
  assert.ok(html.includes("Shared playlist"), "headed as shared");
  const ids = [...html.matchAll(/href="#\/episode\/([^"]+)"/g)].map((x) => decodeURIComponent(x[1]));
  assert.deepStrictEqual(ids, ["p2", "p1"], "the catalogue ids, in order; the gone one dropped");
  assert.ok(!html.includes('id="pl-remove"') && !html.includes('id="pl-save"'), "read-only");
  /* MUTATION: drop `if (p.isShared) return "shared-playlist";` from
     playlistCtx -> the rows' data-ctx (what the `picked` event logs) quotes the
     sharer's payload. */
  assert.ok(html.includes('data-ctx="shared-playlist"') && !html.includes("data-ctx=\"playlist-shared~"), "the event context names the page, never its payload");
});

test("(e) a Suggested subject queue freezes too, and 60 catalogue ids give 50", () => {
  /* MUTATION: drop `.slice(0, SHARED_PLAYLIST_MAX)` in shareLinkFor -> 60.
     MUTATION: drop it in sharedPlaylistFromId -> a hand-made 60-id link
     renders 60. */
  const m = appMount({}, 60);
  const big = { id: "q1", title: "Big", items: Array.from({ length: 60 }, (_, i) => ({ id: "p" + (i + 1) })) };
  const id = sharedIdOf(link(m, { kind: "playlist", playlist: big }).url);
  const decoded = JSON.parse(Buffer.from(id.slice(7).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  assert.strictEqual(decoded.e.length, 50);
  assert.deepStrictEqual(Object.keys(decoded).sort(), ["e", "t"], "title and ids, nothing else");

  const forged = "shared~" + Buffer.from(JSON.stringify({ t: "Forged", e: big.items.map((x) => x.id) })).toString("base64url");
  const p = m.ctx.sharedPlaylistFromId(forged);
  assert.strictEqual(p.items.length, 50);

  const subject = link(m, { kind: "playlist", id: "subject-engineering" });
  assert.ok(subject.url.includes("#/playlist/shared~") && !subject.url.includes("subject"), subject.url);
});

test("(e) a generated playlist keeps its own route", () => {
  /* MUTATION: freeze generated playlists too -> the gen- route is lost. */
  const m = appMount();
  assert.strictEqual(link(m, { kind: "playlist", playlist: { id: "gen-history/technology", title: "Tech", isGenerated: true, items: [] } }).url,
    ORIGIN + "#/playlist/" + encodeURIComponent("gen-history/technology"));
});

/* (f) ------------------------------------------------------------------- */

test("(f) a shared title renders as text, and a malformed link is 'Playlist not found.' without a throw", () => {
  /* MUTATION: render `${p.title}` unescaped in renderPlaylistDetail -> the
     <img> survives. MUTATION: drop sharedPlaylistFromId's try/catch -> the
     malformed ids throw out of renderPlaylistDetail. */
  const m = appMount();
  const evil = "shared~" + Buffer.from(JSON.stringify({ t: "<img src=x onerror=1>", e: ["p1"] })).toString("base64url");
  m.ctx.renderPlaylistDetail(evil);
  assert.ok(m.view().includes("&lt;img src=x onerror=1&gt;"));
  assert.ok(!m.view().includes("<img src=x"));
  const b64 = (s) => "shared~" + Buffer.from(s).toString("base64url");
  for (const bad of ["shared~", "shared~!!!!", "shared~a", b64("not json"), b64('{"t":1,"e":["p1"]}'),
    b64('{"t":"x","e":"p1"}'), b64('{"t":"x","e":[]}'), b64('{"t":"x","e":["gone"]}'), b64("null"),
    "shared~" + Buffer.from([0xff, 0xfe, 0x7b]).toString("base64url")]) {
    m.ctx.renderPlaylistDetail(bad);
    assert.ok(m.view().includes("Playlist not found."), bad);
  }
});

/* (g) ------------------------------------------------------------------- */

test("(g) a Suggested card's share button shares its lead episode, not the subject route", async () => {
  /* MUTATION: give miniCard `shareBtn({ kind: "playlist", id: "subject-" +
     slot.branch, ... })` -> the shared URL is a #/playlist/ (or #/subject/)
     link, whose list differs on the recipient's device. */
  const m = appMount();
  const slot = m.state.cardSlots[0];
  const card = m.ctx.miniCard(slot);
  const btn = /<button type="button" class="share-btn" data-share="([^"]+)" data-share-id="([^"]+)"/.exec(card);
  assert.ok(btn, "the card has a share button");
  assert.ok(card.indexOf("share-btn") > card.indexOf("mc-link"), "a sibling after the stretched link, like the star");
  const shared = await clickShare(m, btn[1], btn[2]);
  assert.strictEqual(shared.length, 1);
  assert.strictEqual(shared[0].url, ORIGIN + "#/episode/" + encodeURIComponent(slot.item.id));
  /* Suggested draws miniCard itself since code-health CH-32 (miniCardV2 went). */
  assert.ok(m.ctx.miniCard({ ...slot, role: "stretch" }).includes("share-btn"), "Suggested's stretch card keeps it");
});

/* (h) ------------------------------------------------------------------- */

test("(h) share text is the title and show, never the hook", () => {
  /* MUTATION: append ` ${item.hook}` to the episode text -> red. */
  const m = appMount();
  const out = link(m, { kind: "episode", id: "p1" });
  assert.strictEqual(out.text, "Episode p1 · Founders");
  assert.ok(!JSON.stringify(out).includes("SECRET HOOK"));
});

/* (i) ------------------------------------------------------------------- */

function delivery(m, { plugin, share, clipboard } = {}) {
  const calls = [];
  m.ctx.Capacitor = plugin ? { Plugins: { Share: { share: async (d) => { calls.push("plugin"); return plugin(d); } } } } : undefined;
  m.ctx.navigator.share = share ? async (d) => { calls.push("share"); return share(d); } : undefined;
  m.ctx.navigator.clipboard = clipboard ? { writeText: async (t) => { calls.push("clipboard:" + t); return clipboard(t); } } : undefined;
  return calls;
}
const LINK = { url: ORIGIN + "#/show/x", text: "X" };

test("(i) the native share plugin is preferred over the Web Share sheet", async () => {
  /* MUTATION: try navigator.share before the Capacitor plugin -> "share" first. */
  const m = mount();
  const calls = delivery(m, { plugin: () => {}, share: () => {}, clipboard: () => {} });
  assert.strictEqual(await m.ctx.shareTo(LINK), "shared");
  assert.deepStrictEqual(calls, ["plugin"]);
});

test("(i) AbortError is the listener cancelling: it never reaches the clipboard", async () => {
  /* MUTATION: drop `if (e && e.name === "AbortError") return "cancelled";`
     -> a cancelled sheet copies the link anyway. */
  const m = mount();
  const calls = delivery(m, { share: () => { const e = new Error("cancel"); e.name = "AbortError"; throw e; }, clipboard: () => {} });
  assert.strictEqual(await m.ctx.shareTo(LINK), "cancelled");
  assert.deepStrictEqual(calls, ["share"]);
});

test("(i) any other Web Share failure falls to the clipboard, then to the link on screen", async () => {
  /* MUTATION: return after any navigator.share rejection -> no clipboard.
     MUTATION: drop the last-resort shareNote(…, link.url) -> no field. */
  const m = mount();
  const calls = delivery(m, { share: () => { const e = new Error("no"); e.name = "NotAllowedError"; throw e; }, clipboard: () => {} });
  const notes = [];
  const anchor = { insertAdjacentHTML: (_where, html) => { notes.push(html); }, nextElementSibling: null };
  assert.strictEqual(await m.ctx.shareTo(LINK, anchor), "copied");
  assert.deepStrictEqual(calls, ["share", "clipboard:" + LINK.url]);
  assert.match(notes[0], /Link copied/);

  delivery(m, { clipboard: () => { throw new Error("denied"); } });
  let selected = false;
  const input = { focus() {}, select() { selected = true; } };
  const anchor2 = { insertAdjacentHTML(_w, html) { notes.push(html); this.nextElementSibling = { querySelector: () => input, classList: { contains: () => true } }; }, nextElementSibling: null };
  assert.strictEqual(await m.ctx.shareTo(LINK, anchor2), "manual");
  assert.match(notes[1], /Copy this link<input class="share-input" readonly value="https:\/\/foray-web-seven\.vercel\.app\/#\/show\/x"/);
  assert.ok(selected, "the link is pre-selected");
});

/* (j) ------------------------------------------------------------------- */

test("(j) the share block logs no event", () => {
  /* MUTATION: add `logEvent("shared", { url: link.url });` to shareTo -> red. */
  const start = APP_SRC.indexOf("/* ---------- share links (#1071, SH-1)");
  const end = APP_SRC.indexOf("window.ForayShare = {");
  assert.ok(start > 0 && end > start, "the share block is where this suite looks");
  const block = APP_SRC.slice(start, APP_SRC.indexOf("};", end));
  assert.ok(!/logEvent\(/.test(block), "a share is not an event");
});

test("ForayShare is published for SH-2 and the click listener is bound once, lazily", () => {
  /* MUTATION: bind document click in shareBtn without the shareClicksBound
     guard -> two listeners after two buttons. */
  const m = appMount();
  assert.deepStrictEqual(Object.keys(m.ctx.ForayShare).sort(), ["linkFor", "shareEpisode", "shareForay"]);
  m.ctx.shareBtn({ kind: "show", id: "founders", title: "Founders" });
  m.ctx.shareBtn({ kind: "show", id: "lex-fridman-podcast", title: "Lex" });
  assert.strictEqual(m.docListeners.filter(([t, fn]) => t === "click" && fn === m.ctx.onShareClick).length, 1);
});
