// Bounded per-instance memory and outbound fetches (round-3 audit,
// search-api-css-4). TtlCache used to delete an expired entry only when that
// same key was read again and had no size cap, so every distinct query stayed
// in a warm instance forever; and the show-scoped search path had no limiter,
// so `?show=X&q=<random>` in a loop downloaded a multi-MB third-party feed per
// request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../_lib/searchCache.ts";
import { KeyedBuckets } from "../_lib/keyedBuckets.ts";
import * as searchModule from "../episodes/search.ts";
import { episodeFeedFailureCache, episodeSearchCache } from "../_lib/searchCache.ts";

const handler = typeof searchModule.default === "function" ? searchModule.default : searchModule.default.default;

function manualClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("TtlCache evicts the oldest entry past maxEntries", () => {
  /* MUTATION: drop the eviction loop in set() — size grows to 5. */
  const cache = new TtlCache(60_000, manualClock(), 3);
  for (const k of ["a", "b", "c", "d", "e"]) cache.set(k, k.toUpperCase());
  assert.equal(cache.size(), 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("e"), "E");
});

test("TtlCache sweeps expired entries on set, not only when their own key is read", () => {
  /* MUTATION: drop sweepExpired() from set() — the three expired entries stay. */
  const clock = manualClock();
  const cache = new TtlCache(1_000, clock, 100);
  cache.set("q1", 1);
  cache.set("q2", 2);
  cache.set("q3", 3);
  clock.advance(1_001);
  cache.set("q4", 4);
  assert.equal(cache.size(), 1, "the expired entries were never read again, and are still gone");
});

test("TtlCache: re-setting a key refreshes its place, so it is not evicted as the oldest", () => {
  const cache = new TtlCache(60_000, manualClock(), 2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 3);
  cache.set("c", 4);
  assert.equal(cache.get("a"), 3);
  assert.equal(cache.get("b"), undefined);
});

test("KeyedBuckets limits each key on its own and caps how many keys it remembers", () => {
  const buckets = new KeyedBuckets(2, 60_000, manualClock(), 3);
  assert.equal(buckets.tryConsume("x"), true);
  assert.equal(buckets.tryConsume("x"), true);
  assert.equal(buckets.tryConsume("x"), false, "x is out of budget");
  assert.equal(buckets.tryConsume("y"), true, "y has its own budget");
  for (const k of ["k1", "k2", "k3", "k4"]) buckets.tryConsume(k);
  assert.equal(buckets.size(), 3);
});

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Lex</title>
<item><title>Episode Alpha</title><guid>ep-a</guid><enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg" length="1"/></item>
</channel></rss>`;

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

test("the show-scoped path stops fetching a show's feed past its per-minute budget, and says so", async () => {
  /* The parsed feed is cached per show (search-api-css-3), so the budget only
     bites when that copy is gone: the loop drops it before every request, as
     an evicted or expired entry would be. MUTATION: drop the
     buckets.tryConsume check in feedCache.ts read() — every request
     downloads the feed again. */
  searchModule.sharedFeedReader.clear();
  episodeFeedFailureCache.clear();
  episodeSearchCache.clear();
  let feedFetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { feedFetches += 1; return new Response(FEED, { status: 200 }); };
  try {
    const answers = [];
    for (let i = 0; i < searchModule.FEED_FETCHES_PER_SHOW_PER_MINUTE + 3; i++) {
      searchModule.sharedFeedReader.cache.clear();
      const res = mockRes();
      await handler({ method: "GET", query: { q: `random-${i}`, show: "lex-fridman-podcast" }, headers: {} }, res);
      answers.push(res.body);
    }
    assert.ok(feedFetches <= searchModule.FEED_FETCHES_PER_SHOW_PER_MINUTE, `fetched the feed ${feedFetches} times`);
    const last = answers[answers.length - 1];
    assert.equal(last.degraded, true, "a refused fetch is degraded, never an empty success");
    assert.equal(last.error, searchModule.FEED_FETCH_LIMITED_ERROR);
  } finally {
    globalThis.fetch = originalFetch;
    searchModule.sharedFeedReader.clear();
    episodeSearchCache.clear();
  }
});
