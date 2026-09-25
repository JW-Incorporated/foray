/* A show's first page of episodes is remembered — founder, 2026-09-18:
 * "I've had to load Lex's entire episode list multiple times now and each time
 * takes many seconds to load."
 *
 * Nothing was cached. `fetchShowEpisodes` passed `cache: "no-cache"`, which
 * forces a revalidation against the origin on EVERY call, and no caller kept the
 * answer — so every visit to a show page paid the full round trip again.
 *
 * WHAT THIS SUITE IS REALLY FOR. A cache is easy to add and easy to get subtly
 * wrong in ways a happy-path test will not see, and the three ways it could be
 * wrong here are all worse than the slowness it fixes:
 *
 *   1. serving a stale list forever (a podcast gains episodes),
 *   2. a failed background refresh WIPING a good list the listener is reading,
 *   3. repainting on every refresh, throwing away scroll position and any
 *      "load more" pages already pulled in.
 *
 * Most of the tests below are those three, not the speed-up.
 *
 * Harness: the source is read rather than executed for the structural claims —
 * `renderShow` needs a real page, a catalogue and a live fetch to run, and the
 * claims that matter here are about the SHAPE of the load path. The cache's own
 * arithmetic is exercised directly through the exported helpers.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
/* CRLF NORMALISED ON READ. This repo is developed on Windows against a
   Unix-normalised tree, so whole-tree line-ending churn is the expected state of
   the working copy (CLAUDE.md § "Never discard uncommitted work"). The
   multi-line regexes below match a bare LF and would silently stop matching — not
   fail loudly, just find nothing — the first time a checkout landed with CRLF.
   Caught exactly that way: a `git stash` round trip rewrote the endings and this
   suite went red without a line of source changing. */
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");

function loadApp() {
  const noop = () => {};
  function makeEl() {
    return {
      addEventListener: noop, removeEventListener: noop, appendChild: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => makeEl(), querySelectorAll: () => [],
    };
  }
  const store = new Map();
  const ctx = {
    console,
    fetch: () => new Promise(() => {}),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: makeEl(), documentElement: makeEl(),
      addEventListener: noop, createElement: makeEl,
      querySelector: () => makeEl(), querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    location: { hash: "#/", href: "https://example.test/" },
    history: { replaceState: noop, pushState: noop },
    CSS: { escape: (s) => String(s) },
    URL, Math, Date, JSON, Promise, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  ctx._state = (code) => vm.runInContext(code, ctx);
  return ctx;
}

const app = loadApp();
/* REAL API ROWS (audit round 3, app-1-3). `api/shows/:id/episodes` returns
   CatalogShowEpisode rows — `guid`, `title`, `published_at` — and NO `id`. This
   fixture used to build `{ id, title }`, a shape production never sends, which is
   exactly why it could not see sameEpisodeList comparing `undefined` to
   `undefined` on every real row. */
const EPS = (...ids) => ids.map((id) => ({ show_id: "s", guid: id, title: id, published_at: "2026-09-01T00:00:00Z" }));

/* ---------- the fetch no longer defeats the HTTP cache ------------------- */

test("fetchShowEpisodes does not pass cache: no-cache", () => {
  /* THE ROOT CAUSE. `no-cache` forces a revalidation round trip on every call,
     so the endpoint's own Cache-Control could never help.
     MUTATION: restore `{ cache: "no-cache" }`. This goes red. RUN: failed as
     named. */
  /* Comments stripped first — the function's own comment explains what was
     removed and names the string, and prose is not a code path. The same trick
     test/data-deletion.test.js uses on `cp_` keys. */
  const fn = /async function fetchShowEpisodesUncached\([\s\S]*?\n\}/.exec(SRC)[0]
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
  assert.ok(!/cache:\s*["']no-cache["']/.test(fn), "the HTTP cache must be allowed to answer");
  /* Since round 2 (states-4) the fetch carries an AbortController signal for its
     deadline; the only option it may carry is that signal. */
  assert.match(fn, /fetch\(apiUrl\(url\)(?:, ctl \? \{ signal: ctl\.signal \} : undefined)?\)/, "a plain fetch, so Cache-Control applies");
});

/* ---------- the cache's own arithmetic ---------------------------------- */

test("a cached page comes back, keyed per show", () => {
  app.cacheShowEpisodes("lex", { episodes: EPS("a", "b"), nextCursor: null, stale: false });
  app.cacheShowEpisodes("tim", { episodes: EPS("c"), nextCursor: "cur", stale: false });
  assert.strictEqual(app.cachedShowEpisodes("lex").episodes.length, 2);
  assert.strictEqual(app.cachedShowEpisodes("tim").nextCursor, "cur");
  assert.strictEqual(app.cachedShowEpisodes("never-fetched"), null);
});

test("a page past its TTL is not served, and is dropped", () => {
  /* The TTL bounds how stale the FIRST PAINT can be. It does not gate the
     refresh — see the next section.
     MUTATION: remove the age check from cachedShowEpisodes. */
  app.cacheShowEpisodes("old", { episodes: EPS("a"), nextCursor: null, stale: false });
  const ttl = app._state("SHOW_EPISODES_TTL_MS");
  app._state(`showEpisodesCache.get("old").at -= ${ttl + 1000};`);
  assert.strictEqual(app.cachedShowEpisodes("old"), null);
  assert.strictEqual(app._state('showEpisodesCache.has("old")'), false, "and the dead row is evicted");
});

test("the TTL is a bound on staleness, not a day", () => {
  /* A podcast gains episodes. Half an hour is the order of magnitude that makes
     a repeat visit instant without making the list wrong. */
  const ttl = app._state("SHOW_EPISODES_TTL_MS");
  assert.ok(ttl >= 60 * 1000, "a TTL under a minute would not answer the complaint");
  assert.ok(ttl <= 2 * 60 * 60 * 1000, "a multi-hour TTL is a staleness bug waiting to happen");
});

/* ---------- comparing two fetched pages --------------------------------- */

test("sameEpisodeList compares ids and order, not contents", () => {
  /* A description edited upstream is not a reason to yank the list out from
     under someone reading it — but a NEW EPISODE is.
     MUTATION: compare with JSON.stringify — the title change below then reads
     as a change and the list repaints for nothing. */
  assert.strictEqual(app.sameEpisodeList(EPS("a", "b"), EPS("a", "b")), true);
  assert.strictEqual(app.sameEpisodeList(EPS("a", "b"), [{ ...EPS("a")[0], title: "EDITED" }, EPS("b")[0]]), true);
  assert.strictEqual(app.sameEpisodeList(EPS("a", "b"), EPS("b", "a")), false, "order is part of it");
  assert.strictEqual(app.sameEpisodeList(EPS("a"), EPS("a", "b")), false, "a new episode is a change");
  assert.strictEqual(app.sameEpisodeList(null, EPS("a")), false);
  assert.strictEqual(app.sameEpisodeList(EPS("a"), null), false);
});

test("a same-length page with a NEW episode at the top is a change (real API rows)", () => {
  /* Audit round 3, app-1-3. Every show with 100+ episodes returns exactly
     PAGE_SIZE rows, so a new episode keeps the page the same length: the head
     changes and the tail drops one. Compared by `id`, which these rows do not
     carry, that read as "unchanged" and the refresh never repainted.
     MUTATION: compare `a[i].id !== b[i].id` again. This goes red. */
  const yesterday = EPS("e3", "e2", "e1");
  const today = EPS("e4", "e3", "e2");
  assert.strictEqual(app.sameEpisodeList(yesterday, today), false, "a new head episode must repaint");
  /* Guid-less rows fall back to title + date, like the list endpoint does. */
  const noGuid = (title, published_at) => ({ show_id: "s", guid: null, title, published_at });
  assert.strictEqual(app.sameEpisodeList([noGuid("A", "d1")], [noGuid("B", "d2")]), false);
  assert.strictEqual(app.sameEpisodeList([noGuid("A", "d1")], [noGuid("A", "d1")]), true);
});

test("guid-less show-scoped search rows get distinct ids, matching the list endpoint's fallback", () => {
  /* Audit round 3, app-1-5. The show-scoped search endpoint passes a null guid
     straight through, and the row id was `${show_id}--${ep.guid}`: every
     guid-less row became `<show>--null`, one itemIndex slot, so each row's ▶
     played the LAST row's audio and stars/Up Next/history shared one id.
     MUTATION: build the id from `ep.guid` again. This goes red. */
  const show = { show_id: "noguid-show", title: "No Guid Show" };
  const a = app.fullCatalogueRowToEpRowItem(show, { guid: null, title: "Part one", published_at: "2026-09-01T00:00:00Z", audio_url: "https://cdn.test/1.mp3" });
  const b = app.fullCatalogueRowToEpRowItem(show, { guid: null, title: "Part two", published_at: "2026-09-02T00:00:00Z", audio_url: "https://cdn.test/2.mp3" });
  assert.notStrictEqual(a.id, b.id, "two guid-less rows must not share an id");
  assert.ok(!/--null$/.test(a.id), "no `<show>--null` ids");
  /* The same fallback the list endpoint mints (episodes.ts toLiveEpisode), so an
     episode starred from the list is the same id in search results. */
  assert.strictEqual(a.id, "noguid-show--noguid:Part one:2026-09-01T00:00:00Z");
  assert.strictEqual(app._state("state.itemIndex")[a.id].audio_url, "https://cdn.test/1.mp3", "each row keeps its own audio");
  /* A row with a guid is unchanged. */
  assert.strictEqual(app.fullCatalogueRowToEpRowItem(show, { guid: "g-1", title: "x" }).id, "noguid-show--g-1");
});

/* ---------- the load path's shape ---------------------------------------- */

test("a cached list paints before the fetch, and the fetch still goes out", () => {
  /* Stale-while-revalidate, not read-through. Both halves in one assertion pair:
     the cache is consulted first, and `fetchShowEpisodes` is called
     unconditionally afterwards rather than inside an else.
     MUTATION: put the fetch inside the `else` branch — the list would then never
     refresh for the whole TTL, which is the staleness bug this avoids. */
  /* 2026-09-22 (audit theme G): the fetch moved into a named `loadEpisodes()`
     so the failed state's "Try again" re-runs the same fetch rather than a
     second path. The claim is unchanged — the cached paint first, then a
     refresh that is not conditional on a miss — so the shape now also pins that
     `loadEpisodes()` is CALLED unconditionally, at the end of renderShow. */
  const load = /const cached = cachedShowEpisodes\(show\.show_id\);[\s\S]*?\n  loadEpisodes\(\);\n\}/.exec(SRC);
  assert.ok(load, "the show-page load path must still have this shape");
  const body = load[0];
  const paintIdx = body.indexOf('paintEpisodeOutcome("loaded")');
  const fetchIdx = body.indexOf("fetchShowEpisodes(show.show_id)");
  assert.ok(paintIdx >= 0 && fetchIdx > paintIdx, "the cached paint comes first, the refresh after");
  assert.ok(!/else\s*\{[^}]*(fetchShowEpisodes|loadEpisodes\(\))/.test(body), "the refresh must not be conditional on a cache miss");
});

test("a failed refresh behind a good cached list changes nothing on screen", () => {
  /* The regression a cache introduces if nobody thinks about it: the listener is
     reading episodes, the revalidation misses, and the page replaces them with
     "couldn't load".
     MUTATION: delete the `if (cached && cached.episodes.length) return;` in the
     `episodes === null` branch. */
  /* 2026-09-22 (audit theme G): the branch now also says "couldn't refresh just
     now" in the SUBTITLE — the moment that sentence becomes true — but it still
     returns before the list is touched and before the error is recorded, which
     is this test's claim. Indentation moved two spaces with `loadEpisodes()`. */
  const body = /if \(episodes === null\) \{[\s\S]*?\n      \}/.exec(SRC)[0];
  assert.match(body, /if \(cached && cached\.episodes\.length\) \{\s*anyStale = true;\s*paintCount\(\);\s*return;\s*\}/);
  assert.ok(body.indexOf("return;") < body.indexOf("lastLoadError"),
    "the early return must come before the error is recorded");
});

test("an empty refresh behind a good cached list is also survivable", () => {
  const body = /if \(episodes\.length === 0\) \{[\s\S]*?\n      \}/.exec(SRC)[0];
  assert.match(body, /if \(cached && cached\.episodes\.length\) return;/);
});

test("an unchanged refresh does not repaint", () => {
  /* Repainting on every refresh throws away scroll position and any "load more"
     pages already pulled in — turning a silent background refresh into a
     visible jump.
     MUTATION: delete the `sameEpisodeList` early return.
     2026-09-22 (audit qa 85): a stale "couldn't refresh" label must not outlive
     a refresh that succeeded. At integration L5's shape won: the count label is
     repainted from the refresh's own answer just ABOVE this return (see
     test/async-identity.test.js), so the branch itself is a bare return again. */
  assert.match(SRC, /anyStale = !!stale;\s*paintCount\(\);[\s\S]{0,800}?if \(cached && sameEpisodeList\(cached\.episodes, episodes\)\) return;/);
});

test("the refresh caches what it fetched, before deciding whether to repaint", () => {
  /* Otherwise the next visit pays the round trip again for a list we already
     have in hand — the original complaint, surviving its own fix. */
  /* `show: header` joined this call on 2026-09-21 — the publisher's show
     description rides the same cache entry, so a revisit paints it without
     waiting for the network (test/show-description-source.test.js owns that
     claim). Matched loosely on the prefix so adding a further field is not a
     test edit; what this test is about is the ORDER, below. */
  const idx = SRC.indexOf("cacheShowEpisodes(show.show_id, { episodes, nextCursor: nc, stale: !!stale");
  const repaintIdx = SRC.indexOf("if (cached && sameEpisodeList(cached.episodes, episodes)) return;");
  assert.ok(idx > 0 && repaintIdx > idx, "the write happens first");
});
