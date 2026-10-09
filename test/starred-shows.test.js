/* Starred shows (follow-lite), requirement A2.4, resolved by Joey's Q2
 * answer: "yes, add starred shows, and a section for all of your starred
 * shows. It is not the home page but is somewhat easily accessible."
 * Kanban card: Build: starred shows (follow-lite) + dedicated Starred
 * Shows page.
 *
 * Deliberately NOT subscribe semantics -- nothing queued, no
 * auto-download, no algorithmic surfacing, and no phone (OS) notification.
 * A per-device marker, mirroring the existing episode star (`cp_saved`)
 * pattern, keyed on show_id under its own storage key (`cp_starred_shows`)
 * so it never collides with episode stars. Since PQ-26 (#761) a followed
 * show is CHECKED for new episodes (the show page's own episodes request,
 * at most every six hours) and its row is marked "N new" until the show's
 * page is opened; a per-show switch turns that off. The mark is the whole
 * of it: nothing is added to Up Next or anywhere else.
 *
 * WHAT THIS PROVES, in order:
 *  1. toggleShowStar/isShowStarred round-trip through cp_starred_shows,
 *     and toggling twice is a true no-op (idempotent unstar).
 *  2. showStarBtn on the show page reflects starred/unstarred state and
 *     survives a toggle via bindShowStars' live DOM update (the same
 *     pattern toggleStar uses for episode stars).
 *  3. Starring an unknown show_id is a safe no-op (no throw, nothing
 *     written) -- mirrors toggleStar's own itemIndex-miss guard.
 *  4. #/starred-shows renders every starred show as a linked row, in
 *     most-recently-starred-first order, with an honest empty state.
 *  5. route() dispatches #/starred-shows to renderStarredShows, same
 *     wiring pattern as #/playlists and #/queue.
 *  6. #/starred-shows is reachable from the Shows page, and is NOT a
 *     top-level drawer entry (the menu is five named pages since 2026-09-03).
 *  7. Starring a show never touches cp_saved (the episode star store) --
 *     the two features share a pattern, not a storage key.
 *  8. PQ-26 (#761): checkFollowedShows writes what show-alerts.js says (a
 *     count past the watermark, a seeded watermark on a first check), leaves
 *     a failed check untouched, skips alerts-off and unplaceable pi: shows
 *     and takes at most six, oldest check first; the row prints "N new";
 *     opening the show page clears it; the show page's switch writes
 *     `alerts: false`.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test
 * is not evidence until you have broken it".
 *
 * Harness: the same node:vm DOM stub as test/show-page.test.js, duplicated
 * rather than imported for the same reason that file gives -- its helpers
 * are scoped to that suite's own fixtures.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const INDEX_HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

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
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results",
];

function mount({ seed = {}, fetch = () => new Promise(() => {}) } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  /* A tiny live registry of elements created via querySelectorAll matches,
     so bindShowStars' `document.querySelectorAll('[data-show-star="…"]')`
     lookup in toggleShowStar can find buttons rendered into #view's
     innerHTML. Mirrors how show-page.test.js gets away without this: that
     suite never asserts a POST-toggle DOM update. This one does (test 2),
     so the stub has to parse the rendered buttons out of #view.innerHTML
     on demand rather than track a real DOM tree. */
  function starButtonsIn(view) {
    const out = [];
    const re = /<button class="show-star( on)?" data-show-star="([^"]*)"[^>]*>/g;
    let m;
    while ((m = re.exec(view.innerHTML))) {
      out.push({ raw: m[0], id: m[2] });
    }
    return out;
  }

  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch,
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
      querySelectorAll: (sel) => {
        const s = String(sel);
        const m = /^\[data-show-star="(.*)"\]$/.exec(s);
        if (!m) return [];
        const targetId = m[1];
        const view = byId.get("view");
        return starButtonsIn(view)
          .filter((b) => b.id === targetId)
          .map(() => ({
            textContent: "",
            classList: { toggle(cls, on) { this._on = on; }, _on: false },
            set _text(v) {},
          }));
      },
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

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
  };
}

/* ==================================================================== */
/* 1. STORE ROUND-TRIP + IDEMPOTENT UNSTAR                              */
/* ==================================================================== */

test("toggleShowStar writes/removes cp_starred_shows and isShowStarred reflects it", () => {
  /* MUTATION: drop the `delete starred[id]` branch. Toggling twice would
     leave the show starred, and the second assertion below fails. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "s-1", title: "Show One", artwork_url: "https://example.com/a.png" }] };

  assert.strictEqual(m.ctx.isShowStarred("s-1"), false, "unstarred by default");
  m.ctx.toggleShowStar("s-1");
  assert.strictEqual(m.ctx.isShowStarred("s-1"), true, "starring must flip isShowStarred");
  const stored = JSON.parse(m.store.get("cp_starred_shows"));
  assert.strictEqual(stored["s-1"].title, "Show One", "must snapshot the show title");
  assert.strictEqual(stored["s-1"].show_id, "s-1");
  assert.ok(stored["s-1"].starred_at, "must record a starred_at timestamp");

  m.ctx.toggleShowStar("s-1");
  assert.strictEqual(m.ctx.isShowStarred("s-1"), false, "toggling twice must be a true no-op (unstar)");
  assert.deepStrictEqual(JSON.parse(m.store.get("cp_starred_shows")), {}, "unstarring must remove the entry, not blank it");
});

/* ==================================================================== */
/* 2. showStarBtn STATE + LIVE TOGGLE ON THE SHOW PAGE                  */
/* ==================================================================== */

test("renderShow includes an unstarred showStarBtn by default, and starring updates it in place", () => {
  /* MUTATION: remove `${showStarBtn(show.show_id)}` from renderShow's
     template. The first assertion fails outright -- no show-star button in
     the page at all.
     MUTATION 2: drop bindShowStars($("#view")) from renderShow. The click
     listener never attaches and toggleShowStar is never called from the
     page, so the live-update assertion (via direct toggleShowStar call)
     still passes, but the wiring test below (which checks _bound) would
     catch a regression there instead. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "s-2", title: "Show Two", artwork_url: null }] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };

  m.ctx.renderShow("s-2");
  let html = m.view();
  assert.match(html, /class="show-star "/, "must render an unstarred show-star button");
  assert.match(html, /data-show-star="s-2"/, "button must carry the show_id for the click handler");
  assert.ok(html.includes("+ Follow"), "unfollowed label must read '+ Follow' (R3 vocabulary, 2026-09-22: shows are Followed, episodes are Saved)");

  m.ctx.toggleShowStar("s-2");
  m.ctx.renderShow("s-2");
  html = m.view();
  assert.match(html, /class="show-star on"/, "re-rendering the page after starring must show the 'on' state");
  assert.ok(html.includes("✓ Followed"), "followed label must read '✓ Followed'");
});

test("REVIEW: the show page says, beside Follow, that following queues nothing and sends no notification", () => {
  /* Apple's Follow delivers new episodes; 4a's marks them and no more. The
     only line saying so was on #/starred-shows, which the tap never shows, so
     a switcher would wait for episodes that never come. MUTATION: drop the
     `show-follow-note` paragraph from renderShow's template. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "s-2", title: "Show Two", artwork_url: null }] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.ctx.renderShow("s-2");
  const html = m.view();
  const btnAt = html.indexOf('data-show-star="s-2"');
  const noteAt = html.indexOf("show-follow-note");
  assert.ok(btnAt > 0 && noteAt > btnAt, "the note sits right after the Follow button");
  /* Said as what Follow IS (audit round 2, copy-14), and since PQ-26 what the
     "N new" mark is not: nothing is queued, and no phone notification.
     The notification clause is about new episodes only: 4a does post a phone
     notification on Android while audio plays (the foray-audio plugin's
     PlaybackKeepAliveService media notification), so an app-wide "4a sends no
     phone notifications" was false.
     MUTATION: restore "4a doesn't add its new episodes anywhere" — the
     bug-report wording; or drop the notification clause from FOLLOW_NOTE; or
     put back the app-wide "4a sends no phone notifications". */
  assert.match(html.slice(noteAt, noteAt + 260), /marked when it has new episodes\. Nothing is queued for you, and no phone notification is sent about them\./);
  assert.doesNotMatch(html, /sends no phone notifications/, "the denial is scoped to new episodes, not the whole app");
  assert.doesNotMatch(html, /doesn(&#39;|')t add its new episodes anywhere/);
  const policy = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "docs/legal/privacy-policy.md"), "utf8");
  const row = policy.split("\n").find((l) => l.startsWith("| `cp_starred_shows`"));
  assert.match(row, /followed from a show page/, "the policy names the control the listener actually taps");
  assert.match(row, /never adds its new episodes anywhere/);
  /* PQ-27: the row says the mark is not a phone notification and points at
     the §4.3 sentence saying what the check sends. MUTATION: put "No
     notifications" back as the row's whole account of alerts. */
  assert.match(row, /no phone notification/);
  assert.match(row, /§4\.3/);
});

/* ==================================================================== */
/* 3. UNKNOWN SHOW_ID IS A SAFE NO-OP                                    */
/* ==================================================================== */

test("toggleShowStar on an unknown show_id is a no-op, mirroring toggleStar's itemIndex guard", () => {
  /* MUTATION: remove the `if (!show) return;` guard. This would write a
     starred-show entry with title `undefined`, and the assertion that the
     store stays empty fails. */
  const m = mount();
  m.state.catalog = { shows: [] };
  assert.doesNotThrow(() => m.ctx.toggleShowStar("does-not-exist"));
  assert.strictEqual(m.store.get("cp_starred_shows"), undefined, "an unknown show_id must write nothing");
});

/* ==================================================================== */
/* 4. #/starred-shows PAGE                                              */
/* ==================================================================== */

test("renderStarredShows lists every starred show, most-recently-starred first", () => {
  /* MUTATION: drop the `.sort(...)` call. The order assertion below fails
     because the map's insertion order (oldest first) would surface instead. */
  const m = mount();
  m.state.catalog = { shows: [] };
  const older = { show_id: "s-old", title: "Older Show", artwork_url: null, starred_at: "2026-01-01T00:00:00.000Z" };
  const newer = { show_id: "s-new", title: "Newer Show", artwork_url: "https://example.com/b.png", starred_at: "2026-06-01T00:00:00.000Z" };
  m.store.set("cp_starred_shows", JSON.stringify({ "s-old": older, "s-new": newer }));

  m.ctx.renderStarredShows();
  const html = m.view();
  assert.ok(html.includes("Followed shows"), "must render the page heading");
  assert.ok(html.includes("2 shows"), "must render an accurate count");
  const oldIdx = html.indexOf("Older Show");
  const newIdx = html.indexOf("Newer Show");
  assert.ok(newIdx >= 0 && oldIdx >= 0 && newIdx < oldIdx, "newer star must render before the older one");
  assert.ok(html.includes(`href="#/show/${encodeURIComponent("s-new")}"`), "each row must link to its show page");
});

test("a starred snapshot with no artwork falls back to the live show's artwork, never a blank tile", () => {
  /* The stored entry is a SNAPSHOT of the show record at the moment the star
     was tapped, so for the 53 catalog shows harvested with `artwork_url: null`
     it carries null forever — even after showArtworkUrl() learned to fill the
     same show's tile from the discover pool on every other surface. The row
     must resolve through the live record, and a snapshot that DID capture
     artwork must keep it (the snapshot is the cheaper, already-correct
     answer). A show that has since left the catalogue still renders the grey
     placeholder rather than throwing on a null record.

     MUTATION: in starredShowRow, revert
       `const art = entry.artwork_url || showArtworkUrl(showById(entry.show_id));`
     to `const art = entry.artwork_url;`. The first row renders
     `show-result-art-blank` and the pool assertion below fails. */
  const m = mount();
  m.state.catalog = {
    shows: [{ show_id: "s-null", title: "Snapshot Show", artwork_url: null, taxonomy_node_ids: [] }],
  };
  m.state.discover = {
    items: [{ id: "ep-1", title: "Ep 1", show: "Snapshot Show", duration_min: 5, artwork_url: "https://cdn.test/live.jpg" }],
  };
  m.store.set("cp_starred_shows", JSON.stringify({
    "s-null": { show_id: "s-null", title: "Snapshot Show", artwork_url: null, starred_at: "2026-03-01T00:00:00.000Z" },
    "s-snap": { show_id: "s-snap", title: "Captured Show", artwork_url: "https://cdn.test/captured.jpg", starred_at: "2026-02-01T00:00:00.000Z" },
    "s-gone": { show_id: "s-gone", title: "Gone Show", artwork_url: null, starred_at: "2026-01-01T00:00:00.000Z" },
  }));

  m.ctx.renderStarredShows();
  const html = m.view();
  assert.ok(html.includes('src="https://cdn.test/live.jpg"'),
    "a null snapshot must resolve the live show's pool artwork");
  assert.ok(html.includes('src="https://cdn.test/captured.jpg"'),
    "a snapshot that captured artwork keeps it");
  assert.strictEqual((html.match(/show-result-art-blank/g) || []).length, 1,
    "exactly one placeholder: the show that is gone from the catalogue and has nothing in the pool");
});

test("renderStarredShows shows an honest empty state when nothing is starred", () => {
  /* MUTATION: remove the ternary's empty branch (always render the list
     div). The empty-state copy assertion fails, and an empty `<div
     class="show-results"></div>` would render silently instead. */
  const m = mount();
  m.ctx.renderStarredShows();
  const html = m.view();
  assert.ok(html.includes("No followed shows yet"), "must render an honest empty state, not a blank list");
  assert.ok(!html.includes('class="show-results"'), "must not render the results wrapper when there is nothing to show");
});

/* ==================================================================== */
/* 5. ROUTE WIRING                                                       */
/* ==================================================================== */

test("route() dispatches #/starred-shows to renderStarredShows, matching #/playlists/#/queue's pattern", () => {
  /* MUTATION: delete the `#/starred-shows` branch from route(). This test
     fails because renderHome (the fallback) runs instead and the view
     never contains the starred-shows heading. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  m.state.ready = true;

  m.ctx.location.hash = "#/starred-shows";
  m.ctx.route();
  assert.ok(m.view().includes("Followed shows"), "route() must dispatch #/starred-shows to renderStarredShows");
});

/* ==================================================================== */
/* 6. REACHABILITY — FROM THE SHOWS PAGE, NOT THE DRAWER                 */
/* ==================================================================== */

test("#/starred-shows is reachable from the Shows page and is no longer a drawer entry", () => {
  /* Was: "the drawer nav carries a link to #/starred-shows". The founder
     named the menu's five pages on 2026-09-03 (Home, Shows, Playlists,
     Forays, Up Next) and Starred Shows is not one of them, so the drawer
     entry came out and the link moved onto the Shows page — a show-shaped
     surface belongs with the shows. Both halves are pinned: the page must
     still be reachable by a tap somewhere, and it must not have quietly
     stayed in the drawer as a sixth entry (test/home-information-
     architecture.test.js pins the drawer's exact five; this is the
     starred-shows side of the same fact). Not on the home screen, per
     Joey's framing -- nothing here asserts renderHome's markup.

     MUTATION: delete the `page-link-row` anchor from renderAllShows's
     `above` block. The first assertion fails and #/starred-shows becomes
     reachable only by typing the URL. MUTATION 2: put the
     `<a class="drawer-section" href="#/starred-shows">` line back in
     index.html. The second assertion fails.

     WITH A SHOW FOLLOWED: since audit round 2 (p-first-12) the Shows page draws
     the shortcut only when there is something behind it — the empty half is
     pinned in test/home-information-architecture.test.js. */
  const m = mount({ seed: { cp_starred_shows: JSON.stringify({ "show-a": { show_id: "show-a", title: "Show A", starred_at: "2026-09-01T00:00:00Z" } }) } });
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.ctx.renderAllShows();
  assert.ok(
    m.view().includes('href="#/starred-shows"'),
    "the Shows page must carry a reachable link to #/starred-shows"
  );
  assert.doesNotMatch(
    INDEX_HTML,
    /<nav id="drawer"[^]*?href="#\/starred-shows"[^]*?<\/nav>/,
    "the drawer must not carry a top-level Starred Shows entry — the menu is the five named pages"
  );
});

/* ==================================================================== */
/* 7. STORAGE ISOLATION FROM EPISODE STARS                              */
/* ==================================================================== */

test("starring a show never writes to cp_saved (the episode-star store)", () => {
  /* MUTATION: change toggleShowStar to reuse `savedMap()`/`lsSet("cp_saved",
     ...)` instead of its own key. This would corrupt episode stars with a
     show entry, and the assertion that cp_saved stays untouched fails. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "s-3", title: "Show Three", artwork_url: null }] };
  m.ctx.toggleShowStar("s-3");
  assert.strictEqual(m.store.get("cp_saved"), undefined, "starring a show must not touch cp_saved");
});

/* ==================================================================== */
/* 8. NEW EPISODES OF FOLLOWED SHOWS (PQ-26, #761)                        */
/* ==================================================================== */

const { pathToFileURL } = require("node:url");
const showAlertsModule = () => import(pathToFileURL(path.join(ROOT, "player/show-alerts.js")).href);

/** A fetch that answers `api/shows/<id>/episodes` from `pages` (id → rows, a
    number for an HTTP failure, or a plain object sent as the 200 body as is —
    the endpoint's degraded answer) and records every show id it was asked for. */
function episodesFetch(pages) {
  const asked = [];
  const fn = (url) => {
    const m = /api\/shows\/([^/?]+)\/episodes/.exec(String(url));
    if (!m) return new Promise(() => {});
    const id = decodeURIComponent(m[1]);
    asked.push(id);
    const page = pages[id];
    if (typeof page === "number") return Promise.resolve({ ok: false, status: page, json: async () => ({}) });
    if (page && typeof page === "object" && !Array.isArray(page)) return Promise.resolve({ ok: true, status: 200, json: async () => page });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ episodes: page || [], next_cursor: null }) });
  };
  return { fn, asked };
}

const OLD_CHECK = "2026-09-01T00:00:00.000Z";
const followed = (id, extra = {}) => ({ show_id: id, title: `Show ${id}`, artwork_url: null, starred_at: OLD_CHECK, ...extra });
const storedShows = (m) => JSON.parse(m.store.get("cp_starred_shows"));

test("PQ-26: a check that finds two newer episodes writes unseen_count 2; a failed check leaves its record untouched", async () => {
  /* MUTATION: drop the updateFollowedShow(...) save in checkFollowedShows —
     the count is computed and thrown away, and `unseen_count` stays 0.
     MUTATION 2: treat `episodes: null` as an empty page (`res.episodes || []`)
     — the failed show is stamped `checked_at` and stops being due for six
     hours without having been checked, and the untouched assertion fails.
     MUTATION 3: drop the `res.error && !res.episodes.length` clause from
     checkFollowedShows' failure guard — the endpoint's degraded 200 (`{
     episodes: [], degraded: true, error }`, a feed it could not read) reads as
     "nothing published", s-c's "2 new" badge is wiped and `checked_at` is
     stamped: `written` becomes 2 and s-c's record changes.
     MUTATION 4: drop `followedCheckFailedAt.set(...)` (or the filter that
     reads it) — the second call asks s-b and s-c again at once, so every
     Library open and every return to the foreground re-sends a failing show's
     id, and the "not asked again" assertion fails.
     MUTATION 5: drop `followedCheckFailedAt.delete(id)` from toggleShowStar —
     a show unfollowed and followed again is held back by the old failure and
     its seeding check is never sent. */
  const watermarked = followed("s-a", { checked_at: OLD_CHECK, seen_published_at: "2026-09-10T00:00:00Z", latest_published_at: "2026-09-10T00:00:00Z", unseen_count: 0 });
  const failing = followed("s-b", { checked_at: OLD_CHECK, seen_published_at: "2026-09-10T00:00:00Z" });
  const degraded = followed("s-c", { checked_at: OLD_CHECK, seen_published_at: "2026-09-10T00:00:00Z", latest_published_at: "2026-09-20T00:00:00Z", unseen_count: 2 });
  const { fn, asked } = episodesFetch({
    "s-a": [
      { title: "Newest", published_at: "2026-09-20T00:00:00Z" },
      { title: "Newer", published_at: "2026-09-15T00:00:00Z" },
      { title: "Seen", published_at: "2026-09-10T00:00:00Z" },
    ],
    "s-b": 503,
    "s-c": { episodes: [], next_cursor: null, degraded: true, stale: false, error: "feed unavailable" },
  });
  const m = mount({ fetch: fn, seed: { cp_starred_shows: JSON.stringify({ "s-a": watermarked, "s-b": failing, "s-c": degraded }) } });
  m.ctx.forayShowAlerts = await showAlertsModule();
  const written = await m.ctx.checkFollowedShows();
  assert.deepStrictEqual(asked.slice().sort(), ["s-a", "s-b", "s-c"], "every due show is asked");
  assert.strictEqual(written, 1, "only the answered check is written");
  const after = storedShows(m);
  assert.strictEqual(after["s-a"].unseen_count, 2);
  assert.strictEqual(after["s-a"].latest_published_at, "2026-09-20T00:00:00Z");
  assert.strictEqual(after["s-a"].seen_published_at, "2026-09-10T00:00:00Z", "the watermark waits for the listener");
  assert.notStrictEqual(after["s-a"].checked_at, OLD_CHECK, "the check is stamped");
  assert.deepStrictEqual(after["s-b"], failing, "a failed check changes nothing");
  assert.deepStrictEqual(after["s-c"], degraded, "a degraded 200 with no episodes is a failure: the badge and the clock stay as they were");
  /* A failed show stays due by its record (rule 1), so without a session
     clock every Library open and every foreground would ask for it again. */
  asked.length = 0;
  assert.strictEqual(await m.ctx.checkFollowedShows(), 0);
  assert.deepStrictEqual(asked, [], "a show whose check just failed is not asked again within six hours in the same session");
  /* A fresh follow is checked at once, even of a show whose check failed
     before it was unfollowed. */
  m.state.catalog = { shows: [{ show_id: "s-b", title: "Show s-b", artwork_url: null }] };
  m.ctx.toggleShowStar("s-b");
  m.ctx.toggleShowStar("s-b");
  await m.evalIn("followedCheckInFlight");
  assert.deepStrictEqual(asked, ["s-b"], "following again sends the seeding check");
});

test("PQ-26: a fresh follow is checked at once, seeds its watermark and shows no badge", async () => {
  /* Following is not a backlog of every episode the show ever published.
     MUTATION: drop `checkFollowedShows()` from toggleShowStar — nothing seeds
     the watermark and `seen_published_at` is absent. MUTATION 2: render the
     badge on `n >= 0` in starredShowRow — "0 new" appears. */
  const { fn } = episodesFetch({ "s-f": [{ title: "Back catalogue", published_at: "2026-09-20T00:00:00Z" }] });
  const m = mount({ fetch: fn });
  m.state.catalog = { shows: [{ show_id: "s-f", title: "Fresh Show", artwork_url: null }] };
  m.ctx.forayShowAlerts = await showAlertsModule();
  m.ctx.toggleShowStar("s-f");
  await m.evalIn("followedCheckInFlight");
  const rec = storedShows(m)["s-f"];
  assert.strictEqual(rec.seen_published_at, "2026-09-20T00:00:00Z", "the first check seeds the watermark to the newest row");
  assert.strictEqual(rec.unseen_count, 0);
  m.ctx.renderStarredShows();
  assert.doesNotMatch(m.view(), /show-new-badge/);
});

test("PQ-26: a followed show with new episodes is marked \"2 new\" on #/starred-shows", () => {
  /* MUTATION: drop the badge span from starredShowRow. */
  const m = mount({ seed: { cp_starred_shows: JSON.stringify({
    "s-n": followed("s-n", { unseen_count: 2 }),
    "s-q": followed("s-q", { unseen_count: 0 }),
  }) } });
  m.state.catalog = { shows: [] };
  m.ctx.renderStarredShows();
  const html = m.view();
  assert.match(html, /<span class="show-new-badge" aria-label="2 new episodes">2 new<\/span>/);
  assert.strictEqual((html.match(/show-new-badge/g) || []).length, 1, "a show with nothing new carries no badge");
});

test("PQ-26: opening a followed show's page clears its badge", async () => {
  /* MUTATION: drop `markFollowedShowSeen(show.show_id)` from renderShow — the
     count stays 2 and the watermark stays behind. */
  const m = mount({ seed: { cp_starred_shows: JSON.stringify({
    "s-o": followed("s-o", { checked_at: OLD_CHECK, seen_published_at: "2026-09-10T00:00:00Z", latest_published_at: "2026-09-20T00:00:00Z", unseen_count: 2 }),
  }) } });
  m.state.catalog = { shows: [{ show_id: "s-o", title: "Show s-o", artwork_url: null }] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.ctx.forayShowAlerts = await showAlertsModule();
  m.ctx.renderShow("s-o");
  const rec = storedShows(m)["s-o"];
  assert.strictEqual(rec.unseen_count, 0);
  assert.strictEqual(rec.seen_published_at, "2026-09-20T00:00:00Z");
  m.ctx.renderStarredShows();
  assert.doesNotMatch(m.view(), /show-new-badge/);
});

test("PQ-26: the show page's switch writes alerts:false, and a later check skips that show", async () => {
  /* MUTATION: drop `rules.alertsOn(r) &&` from checkFollowedShows' filter —
     the switched-off show is asked again. MUTATION 2: drop `.slice(0,
     FOLLOWED_CHECK_CAP)` — every due show is asked in one call. MUTATION 3:
     drop the `pi:` shard-key filter — a pi: show with no shard key is asked
     without one (a 404 by construction). MUTATION 4: drop the setAlerts
     save in toggleShowAlerts — the record keeps alerts on. */
  const others = {};
  for (let i = 1; i <= 7; i++) others[`s-${i}`] = followed(`s-${i}`, { checked_at: `2026-08-0${i}T00:00:00.000Z` });
  const { fn, asked } = episodesFetch({});
  const m = mount({ fetch: fn, seed: { cp_starred_shows: JSON.stringify({
    "s-x": followed("s-x"),
    /* A followed pi: show is found through its own follow record
       (rememberedShardShow), so its key comes from the title it was followed
       under; a title that yields no shard key is the case left to skip. */
    "pi:404": followed("pi:404", { title: "!!" }),
    ...others,
  }) } });
  m.state.catalog = { shows: [{ show_id: "s-x", title: "Show s-x", artwork_url: null }] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.ctx.forayShowAlerts = await showAlertsModule();
  m.ctx.renderShow("s-x");
  assert.match(m.view(), /<button type="button" class="show-star alerts-toggle on" data-show-alerts="s-x" aria-pressed="true">New-episode alerts: on<\/button>/,
    "a followed show's page carries the switch, on");
  m.ctx.toggleShowAlerts("s-x");
  assert.strictEqual(storedShows(m)["s-x"].alerts, false, "the switch writes alerts:false on the follow record");
  m.ctx.renderShow("s-x");
  assert.match(m.view(), /aria-pressed="false">New-episode alerts: off</);

  asked.length = 0; // the show page's own episodes request is not the check
  await m.evalIn("followedCheckInFlight");
  await m.ctx.checkFollowedShows({ force: true });
  assert.ok(!asked.includes("s-x"), "a show with alerts off is never checked");
  assert.ok(!asked.includes("pi:404"), "a pi: show with no shard key is skipped");
  assert.deepStrictEqual(asked, ["s-1", "s-2", "s-3", "s-4", "s-5", "s-6"], "at most six per call, oldest check first");
});
