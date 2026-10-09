// One parsed feed per show, shared by the list and the show-scoped search
// (round-3 audit, search-api-css-3). Every show-page search keystroke that
// missed the query-keyed cache, and every cursor page of the list, used to
// re-download and re-parse the whole feed.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as feedCacheModule from "../_lib/feedCache.ts";
import { createFeedReader, FEED_FRESH_MS, FEED_FETCHES_PER_SHOW_PER_MINUTE, FEED_FETCH_LIMITED_ERROR } from "../_lib/feedCache.ts";
import * as searchModule from "../episodes/search.ts";
import * as episodesModule from "../shows/[show_id]/episodes.ts";
import { episodeSearchCache } from "../_lib/searchCache.ts";

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Lex</title>
<item><title>Alpha talk</title><guid>a</guid><description><![CDATA[<p>Long <b>html</b> notes</p>]]></description><enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg" length="1"/></item>
<item><title>Beta talk</title><guid>b</guid><enclosure url="https://cdn.example.com/b.mp3" type="audio/mpeg" length="1"/></item>
</channel></rss>`;

function manualClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function countingFetch({ etag = '"v1"', notModifiedOnMatch = true } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const ifNoneMatch = init?.headers?.["If-None-Match"] ?? null;
    calls.push({ url: String(url), ifNoneMatch });
    if (notModifiedOnMatch && ifNoneMatch === etag) return new Response(null, { status: 304 });
    return new Response(FEED, { status: 200, headers: { ETag: etag } });
  };
  return { impl, calls };
}

test("a second read of the same show inside the fresh window does not fetch or parse again", async () => {
  /* MUTATION: skip the fresh-window return in read() — the feed is fetched twice. */
  const clock = manualClock();
  const reader = createFeedReader({ clock });
  const f = countingFetch();
  const one = await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: f.impl });
  const two = await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: f.impl });
  assert.equal(one.source, "fetched");
  assert.equal(two.source, "cache");
  assert.equal(f.calls.length, 1);
  assert.equal(two.parsed.episodes.length, 2);
});

test("past the fresh window it revalidates with the etag it kept, and a 304 reuses the parse", async () => {
  /* MUTATION: pass `{ etag: null, lastModified: null }` again — the refetch
     carries no If-None-Match and downloads the whole feed. */
  const clock = manualClock();
  const reader = createFeedReader({ clock });
  const f = countingFetch();
  await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: f.impl });
  clock.advance(FEED_FRESH_MS + 1);
  const again = await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: f.impl });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].ifNoneMatch, '"v1"');
  assert.equal(again.source, "revalidated");
  assert.equal(again.parsed.episodes.length, 2);
});

test("a failed refresh serves the copy it kept rather than a degraded empty answer", async () => {
  const clock = manualClock();
  const reader = createFeedReader({ clock });
  const f = countingFetch();
  await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: f.impl });
  clock.advance(FEED_FRESH_MS + 1);
  const down = async () => { throw new Error("feed host down"); };
  const read = await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: down });
  assert.equal(read.source, "stale");
  assert.equal(read.error, null);
  assert.equal(read.parsed.episodes.length, 2);
});

test("the kept parse drops descriptionHtml, and the number of shows kept is capped", async () => {
  const reader = createFeedReader({ clock: manualClock(), maxShows: 2 });
  const f = countingFetch();
  const first = await reader.read("s1", "https://feeds.example.com/1.xml", { fetchImpl: f.impl });
  assert.equal(first.parsed.episodes[0].descriptionHtml, null, "nothing reads the HTML; it is not kept");
  assert.ok(first.parsed.episodes[0].descriptionText.includes("Long"), "the text the episode page renders is kept");
  await reader.read("s2", "https://feeds.example.com/2.xml", { fetchImpl: f.impl });
  await reader.read("s3", "https://feeds.example.com/3.xml", { fetchImpl: f.impl });
  assert.equal(reader.cache.size(), 2);
});

function mockRes() {
  const state = { statusCode: null, body: undefined };
  return {
    headers: {},
    get statusCode() { return state.statusCode; },
    get body() { return state.body; },
    status(code) { state.statusCode = code; return this; },
    json(body) { state.body = body; },
    setHeader(name, value) { this.headers[name] = value; },
    end() {},
  };
}
const pick = (m) => (typeof m.default === "function" ? m.default : m.default.default);

test("the per-show list and show-scoped searches with different queries share ONE feed fetch", async () => {
  /* MUTATION: have either handler call fetchFeedConditional directly again —
     the fetch count rises with every request. */
  const had = "DATABASE_URL" in process.env;
  const originalDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const originalFetch = globalThis.fetch;
  const f = countingFetch();
  globalThis.fetch = f.impl;
  searchModule.sharedFeedReader.clear();
  episodeSearchCache.clear();
  searchModule.showScopedResultCache.clear();
  try {
    const list = pick(episodesModule);
    const search = pick(searchModule);
    const listRes = mockRes();
    await list({ method: "GET", query: { show_id: "lex-fridman-podcast" }, headers: {} }, listRes);
    for (const q of ["alp", "alph", "alpha", "beta"]) {
      const res = mockRes();
      await search({ method: "GET", query: { q, show: "lex-fridman-podcast" }, headers: {} }, res);
      assert.equal(res.body.degraded, false);
    }
    assert.equal(listRes.body.episodes.length, 2);
    assert.equal(f.calls.length, 1, `the feed was fetched ${f.calls.length} times for one list and four searches`);
  } finally {
    globalThis.fetch = originalFetch;
    if (had) process.env.DATABASE_URL = originalDb;
    searchModule.sharedFeedReader.clear();
    episodeSearchCache.clear();
  }
});

/* ---------------------------------------------------------------------------
   code-health-2 CH2-38 (A1-06, A1-05). ONE FAILURE MEMORY, IN THE FEED CACHE.

   A feed that just failed used to be remembered for 90 s by the show-scoped
   search alone (searchCache.ts's episodeFeedFailureCache), while the show
   page's list beside it re-fetched the dead feed for every visitor: up to
   6/min per instance, each able to hold the function 15 s. The memory now
   lives in the reader both endpoints share, so the list and the search box
   answer one dead feed the same way. LISTENER-VISIBLE: a retry of the list
   inside 90 s of a transient failure is answered from memory; the search box
   beside it already behaved so, and the inconsistency was the bug.
   --------------------------------------------------------------------------- */

const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34" }];

function failingFetch(message = "feed host down") {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    throw new Error(message);
  };
  return { impl, calls };
}

test("the reader remembers a failed feed for 90 s per show, before the per-show budget", async () => {
  /* MUTATION: drop the failure memory from feedCache.ts read() (the
     `failures.get` short-circuit or the `failures.set` after a failed fetch):
     the second read fetches again, or is answered with the budget refusal. */
  assert.equal(feedCacheModule.FEED_FAILURE_TTL_MS, 90_000, "the window the search box has always had");
  const clock = manualClock();
  const reader = createFeedReader({ clock, fetchesPerShowPerMinute: 1, lookup: PUBLIC_LOOKUP });
  const down = failingFetch();
  const first = await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: down.impl });
  assert.equal(first.feedFailed, true);
  assert.equal(first.source, "none");
  assert.match(first.error, /feed host down/);

  clock.advance(30_000); // inside the budget's minute: a refusal would answer if the memory came second
  const second = await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: down.impl });
  assert.deepEqual(second, first, "answered from memory with the original error, not the budget refusal");
  clock.advance(59_999); // 89_999 ms after the failure
  const third = await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: down.impl });
  assert.deepEqual(third, first);
  assert.equal(down.calls.length, 1, "the dead feed was not asked again inside the window");

  clock.advance(1); // 90 s after the failure; the budget's minute has long reopened
  const healthy = countingFetch();
  const fourth = await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: healthy.impl });
  assert.equal(healthy.calls.length, 1, "at 90 s the feed is asked again");
  assert.equal(fourth.source, "fetched");
});

test("a remembered failure is the show's and the feed's: another show, or another feed url, is asked", async () => {
  /* MUTATION: key the failure memory on anything shared across shows, or drop
     the feed url from it (a `pi:` show resolved through a different shard key
     can name a different feed): the healthy read is answered with the failure. */
  const reader = createFeedReader({ clock: manualClock(), lookup: PUBLIC_LOOKUP });
  await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: failingFetch().impl });
  const other = await reader.read("show-y", "https://feeds.example.com/y.xml", { fetchImpl: countingFetch().impl });
  assert.equal(other.source, "fetched");
  const moved = await reader.read("show-x", "https://feeds.example.com/x-moved.xml", { fetchImpl: countingFetch().impl });
  assert.equal(moved.source, "fetched");
});

test("a refused fetch (per-show budget) is not remembered as a feed failure", async () => {
  /* Only a fetch that went out and failed is worth remembering: the refusal
     never touched the network. MUTATION: remember every parsed:null answer:
     the read after the budget reopens is still the refusal. */
  const clock = manualClock();
  const reader = createFeedReader({ clock, fetchesPerShowPerMinute: 1, lookup: PUBLIC_LOOKUP });
  const f = countingFetch();
  await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: f.impl });
  reader.cache.clear();
  const refused = await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: f.impl });
  assert.equal(refused.error, FEED_FETCH_LIMITED_ERROR);
  assert.equal(refused.feedFailed, false);
  clock.advance(60_000);
  const after = await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: f.impl });
  assert.equal(after.source, "fetched");
});

test("PIN: the per-show budget is 6 fetches a minute", async () => {
  /* Survives CH2-38 unchanged. MUTATION: change the 6, or the 60_000 window
     in createFeedReader: a count or the reopening below moves. */
  assert.equal(FEED_FETCHES_PER_SHOW_PER_MINUTE, 6);
  const clock = manualClock();
  const reader = createFeedReader({ clock, lookup: PUBLIC_LOOKUP });
  const f = countingFetch();
  const sources = [];
  for (let i = 0; i < 7; i++) {
    reader.cache.clear(); // an evicted copy, so every read wants the origin
    sources.push((await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: f.impl })).source);
  }
  assert.equal(f.calls.length, 6);
  assert.equal(sources[6], "none");
  clock.advance(59_999);
  reader.cache.clear();
  assert.equal((await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: f.impl })).source, "none");
  clock.advance(1);
  reader.cache.clear();
  assert.equal((await reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: f.impl })).source, "fetched");
});

test("PIN: a feed fetch through the reader is abandoned at 15 s, and that failure is remembered", async (t) => {
  /* Survives CH2-38 unchanged. MUTATION: pass another `timeoutMs` from
     feedCache.ts, or change conditionalGet.ts's 15_000 default: the abort
     fires at another tick. */
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const reader = createFeedReader({ clock: manualClock(), lookup: PUBLIC_LOOKUP });
  let signal = null;
  let calls = 0;
  const hang = (url, init) => {
    calls += 1;
    signal = init.signal;
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  };
  const pending = reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: hang });
  for (let i = 0; i < 50 && !signal; i++) await new Promise((r) => setImmediate(r));
  assert.ok(signal, "the fetch went out");
  mock.timers.tick(14_999);
  assert.equal(signal.aborted, false);
  mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  const read = await pending;
  assert.equal(read.feedFailed, true);
  const next = reader.read("show-x", "https://feeds.example.com/x.xml", { fetchImpl: hang });
  for (let i = 0; i < 50 && calls < 2; i++) await new Promise((r) => setImmediate(r));
  mock.timers.tick(15_000); // settles a second fetch, if one went out
  assert.equal((await next).feedFailed, true);
  assert.equal(calls, 1, "a feed that timed out is not asked again for the next visitor");
});

function clearSharedState() {
  searchModule.sharedFeedReader.clear();
  episodeSearchCache.clear();
  searchModule.showScopedResultCache.clear();
}

async function withEnv(fetchImpl, body) {
  const had = "DATABASE_URL" in process.env;
  const originalDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  clearSharedState();
  try {
    await body();
  } finally {
    globalThis.fetch = originalFetch;
    if (had) process.env.DATABASE_URL = originalDb;
    clearSharedState();
  }
}

test("the per-show list answers a dead feed from memory, and the search box beside it shares that memory", async () => {
  /* RED before CH2-38: the list re-fetched the dead feed for every visitor
     (3 fetches here). MUTATION: drop the failure memory from feedCache.ts:
     the list re-hits the origin. */
  const down = failingFetch();
  await withEnv(down.impl, async () => {
    const list = pick(episodesModule);
    const search = pick(searchModule);
    const one = mockRes();
    await list({ method: "GET", query: { show_id: "lex-fridman-podcast" }, headers: {} }, one);
    const two = mockRes();
    await list({ method: "GET", query: { show_id: "lex-fridman-podcast" }, headers: {} }, two);
    const box = mockRes();
    await search({ method: "GET", query: { q: "alpha", show: "lex-fridman-podcast" }, headers: {} }, box);

    assert.equal(down.calls.length, 1, `the dead feed was fetched ${down.calls.length} times for two lists and a search`);
    assert.equal(two.body.degraded, true, "the remembered answer is the same honest degraded list");
    assert.equal(two.body.error, one.body.error);
    assert.equal(two.headers["Cache-Control"], "no-store", "never pinned at the edge past our own window");
    assert.equal(box.body.degraded, true);
    assert.equal(box.body.error, one.body.error, "one failure, said the same way by both endpoints");
    assert.equal(box.headers["Cache-Control"], "no-store");
  });
});

test("a show-scoped search answered from a stale feed copy says stale: true and is not remembered as fresh", async () => {
  /* RED before CH2-38: the stale answer was cached for an hour as a clean
     `degraded: false` success, while the list for the same read said stale and
     no-store (A1-05). MUTATION: drop the `feed.source === "stale"` skip before
     the result cache's set: the recovered feed is never read again. */
  let mode = "up";
  const f = countingFetch({ notModifiedOnMatch: false });
  const flaky = async (url, init) => {
    if (mode === "down") {
      f.calls.push({ url: String(url), ifNoneMatch: null });
      throw new Error("feed host down");
    }
    return f.impl(url, init);
  };
  await withEnv(flaky, async () => {
    const search = pick(searchModule);
    await search({ method: "GET", query: { q: "alpha", show: "lex-fridman-podcast" }, headers: {} }, mockRes());
    const kept = searchModule.sharedFeedReader.cache.get("lex-fridman-podcast");
    kept.checkedAt -= FEED_FRESH_MS + 1; // the kept copy is past its fresh window

    mode = "down";
    const stale = mockRes();
    await search({ method: "GET", query: { q: "beta", show: "lex-fridman-podcast" }, headers: {} }, stale);
    assert.equal(stale.body.degraded, false, "a kept copy still answers");
    assert.equal(stale.body.stale, true, "and says it is stale, as the list does");
    assert.equal(stale.body.episodes.length, 1);
    assert.equal(stale.headers["Cache-Control"], "no-store", "not pinned at the edge either");

    mode = "up";
    const fetchesBefore = f.calls.length;
    const recovered = mockRes();
    await search({ method: "GET", query: { q: "beta", show: "lex-fridman-podcast" }, headers: {} }, recovered);
    assert.equal(f.calls.length, fetchesBefore + 1, "the same query reads the feed again once it is back");
    assert.equal(recovered.body.stale, false);
  });
});

test("a show-scoped search result is kept no longer than the feed it came from is fresh", async () => {
  /* RED before CH2-38: the result was kept 1 h over a feed that is fresh for
     5 min, so a new episode stayed unfindable by that query for the hour.
     MUTATION: give the show-scoped result cache the 1 h TTL again: the third
     search is answered without a revalidation. */
  const f = countingFetch();
  const realNow = Date.now;
  const start = realNow();
  let offset = 0;
  Date.now = () => start + offset;
  try {
    await withEnv(f.impl, async () => {
      const search = pick(searchModule);
      await search({ method: "GET", query: { q: "alpha", show: "lex-fridman-podcast" }, headers: {} }, mockRes());
      offset = FEED_FRESH_MS - 1;
      await search({ method: "GET", query: { q: "alpha", show: "lex-fridman-podcast" }, headers: {} }, mockRes());
      assert.equal(f.calls.length, 1, "inside the fresh window the kept result answers");
      offset = FEED_FRESH_MS;
      const after = mockRes();
      await search({ method: "GET", query: { q: "alpha", show: "lex-fridman-podcast" }, headers: {} }, after);
      assert.equal(f.calls.length, 2, "past it, the result is not answered from an hour-long memory");
      assert.equal(f.calls[1].ifNoneMatch, '"v1"', "it revalidates the feed it kept");
      assert.equal(after.body.episodes.length, 1);
    });
  } finally {
    Date.now = realNow;
  }
});
