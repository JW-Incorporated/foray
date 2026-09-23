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
const EPS = (...ids) => ids.map((id) => ({ id, title: id }));

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
  assert.match(fn, /await fetch\(apiUrl\(url\)\)/, "a plain fetch, so Cache-Control applies");
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
  assert.strictEqual(app.sameEpisodeList(EPS("a", "b"), [{ id: "a", title: "EDITED" }, { id: "b", title: "b" }]), true);
  assert.strictEqual(app.sameEpisodeList(EPS("a", "b"), EPS("b", "a")), false, "order is part of it");
  assert.strictEqual(app.sameEpisodeList(EPS("a"), EPS("a", "b")), false, "a new episode is a change");
  assert.strictEqual(app.sameEpisodeList(null, EPS("a")), false);
  assert.strictEqual(app.sameEpisodeList(EPS("a"), null), false);
});

/* ---------- the load path's shape ---------------------------------------- */

test("a cached list paints before the fetch, and the fetch still goes out", () => {
  /* Stale-while-revalidate, not read-through. Both halves in one assertion pair:
     the cache is consulted first, and `fetchShowEpisodes` is called
     unconditionally afterwards rather than inside an else.
     MUTATION: put the fetch inside the `else` branch — the list would then never
     refresh for the whole TTL, which is the staleness bug this avoids. */
  const load = /const cached = cachedShowEpisodes\(show\.show_id\);[\s\S]*?revealSearchIfEligible\(\);\n  \}\);/.exec(SRC);
  assert.ok(load, "the show-page load path must still have this shape");
  const body = load[0];
  const paintIdx = body.indexOf('paintEpisodeOutcome("loaded")');
  const fetchIdx = body.indexOf("fetchShowEpisodes(show.show_id)");
  assert.ok(paintIdx >= 0 && fetchIdx > paintIdx, "the cached paint comes first, the refresh after");
  assert.ok(!/else\s*\{[^}]*fetchShowEpisodes/.test(body), "the refresh must not be conditional on a cache miss");
});

test("a failed refresh behind a good cached list changes nothing on screen", () => {
  /* The regression a cache introduces if nobody thinks about it: the listener is
     reading episodes, the revalidation misses, and the page replaces them with
     "couldn't load".
     MUTATION: delete the `if (cached && cached.episodes.length) return;` in the
     `episodes === null` branch. */
  const body = /if \(episodes === null\) \{[\s\S]*?\n    \}/.exec(SRC)[0];
  assert.match(body, /if \(cached && cached\.episodes\.length\) return;/);
  assert.ok(body.indexOf("return;") < body.indexOf("lastLoadError"),
    "the early return must come before the error is recorded");
});

test("an empty refresh behind a good cached list is also survivable", () => {
  const body = /if \(episodes\.length === 0\) \{[\s\S]*?\n    \}/.exec(SRC)[0];
  assert.match(body, /if \(cached && cached\.episodes\.length\) return;/);
});

test("an unchanged refresh does not repaint", () => {
  /* Repainting on every refresh throws away scroll position and any "load more"
     pages already pulled in — turning a silent background refresh into a
     visible jump.
     MUTATION: delete the `sameEpisodeList` early return.
     2026-09-22 (audit qa 85): the branch now repaints the COUNT LABEL before
     returning — the list stays put, but a stale "couldn't refresh" label must
     not outlive a refresh that succeeded (test/async-identity.test.js owns
     that). What this test pins is unchanged: the branch returns before the
     list is repainted. */
  const branch = /if \(cached && sameEpisodeList\(cached\.episodes, episodes\)\) \{[\s\S]*?\n    \}/.exec(SRC);
  assert.ok(branch, "the unchanged-list branch is gone");
  assert.match(branch[0], /return;/);
  assert.doesNotMatch(branch[0], /paintEpisodeOutcome/, "an unchanged list must not be repainted");
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
  const repaintIdx = SRC.indexOf("if (cached && sameEpisodeList(cached.episodes, episodes)) {");
  assert.ok(idx > 0 && repaintIdx > idx, "the write happens first");
});
