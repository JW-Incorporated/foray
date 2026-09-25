// One caller cannot spend everyone's Apple budget (round-3 audit,
// security-10). The Apple buckets are shared by every caller per instance, so
// one script with unique queries drained the directory and episode search for
// every listener. Now: a per-client bucket in front, a query length window,
// and a stronger cache-key normalisation.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as searchModule from "../episodes/search.ts";
import * as showsModule from "../shows/search.ts";
import {
  appleCallerBuckets, clientKey, normalizeSearchText, CLIENT_LIMITED_ERROR,
  PER_CLIENT_APPLE_CALLS_PER_MINUTE, QUERY_TOO_LONG_ERROR, QUERY_TOO_SHORT_ERROR,
} from "../_lib/clientLimit.ts";
import { episodeSearchCache, normalizeQueryKey } from "../_lib/searchCache.ts";
import { appleShowCacheKey } from "../_lib/appleShowSearch.ts";
import { appleSearchBucket } from "../_lib/appleBucket.ts";

const pick = (m) => (typeof m.default === "function" ? m.default : m.default.default);
const episodes = pick(searchModule);
const shows = pick(showsModule);

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

async function withApple(run) {
  const originalFetch = globalThis.fetch;
  const calls = { apple: 0 };
  globalThis.fetch = async (url) => {
    if (String(url).includes("itunes.apple.com")) calls.apple += 1;
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  appleCallerBuckets.clear();
  episodeSearchCache.clear();
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    appleCallerBuckets.clear();
  }
}

test("clientKey reads the first x-forwarded-for hop, then x-real-ip, then a shared 'unknown'", () => {
  assert.equal(clientKey({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" }), "198.51.100.7");
  assert.equal(clientKey({ "x-forwarded-for": ["198.51.100.8"] }), "198.51.100.8");
  assert.equal(clientKey({ "x-real-ip": " 198.51.100.9 " }), "198.51.100.9");
  assert.equal(clientKey({}), "unknown");
  assert.equal(clientKey(undefined), "unknown");
});

test("trivial variants of a query share one cache key, so they share one Apple slot", () => {
  /* MUTATION: normalizeQueryKey back to `q.trim().toLowerCase()` — "Sleep?"
     and "sleep" become two keys and two slots. */
  assert.equal(normalizeSearchText("  Sleep?! "), "sleep");
  assert.equal(normalizeQueryKey("Sleep?", null, 25), normalizeQueryKey("  sleep ", null, 25));
  assert.equal(normalizeQueryKey("true-crime", null, 25), normalizeQueryKey("True  Crime", null, 25));
  assert.equal(appleShowCacheKey("Hard Fork!", 25), appleShowCacheKey("hard fork", 25));
});

test("episode search: one client past its budget is refused, and another client is still answered", async () => {
  /* MUTATION: drop the appleCallerBuckets check in the general path — the
     noisy client keeps spending the shared slots. */
  await withApple(async (calls) => {
    const noisy = { "x-forwarded-for": "198.51.100.66" };
    let refused = 0;
    for (let i = 0; i < PER_CLIENT_APPLE_CALLS_PER_MINUTE + 4; i++) {
      const res = mockRes();
      await episodes({ method: "GET", query: { q: `noisy-${Date.now()}-${i}` }, headers: noisy }, res);
      if (res.body.error === CLIENT_LIMITED_ERROR) {
        refused += 1;
        assert.equal(res.body.degraded, true);
        assert.deepEqual(res.body.episodes, []);
      }
    }
    assert.equal(refused, 4, "exactly the calls past the per-client budget were refused");
    assert.equal(calls.apple, PER_CLIENT_APPLE_CALLS_PER_MINUTE);

    const res = mockRes();
    await episodes({ method: "GET", query: { q: `quiet-${Date.now()}` }, headers: { "x-forwarded-for": "198.51.100.1" } }, res);
    assert.equal(res.body.error, null, "a different listener is not punished for the noisy one");
  });
});

test("episode search: a query too long is a 400, one too short spends no slot", async () => {
  await withApple(async (calls) => {
    const long = mockRes();
    await episodes({ method: "GET", query: { q: "x".repeat(201) }, headers: {} }, long);
    assert.equal(long.statusCode, 400);
    assert.equal(long.body.error, QUERY_TOO_LONG_ERROR);

    const before = appleSearchBucket.currentCount();
    const short = mockRes();
    await episodes({ method: "GET", query: { q: "?!" }, headers: {} }, short);
    assert.equal(short.body.degraded, true);
    assert.equal(short.body.error, QUERY_TOO_SHORT_ERROR);
    assert.equal(calls.apple, 0);
    assert.equal(appleSearchBucket.currentCount(), before, "no shared slot was spent");
  });
});

test("show search: the directory pass honours the per-client budget and skips a too-short query", async () => {
  await withApple(async (calls) => {
    const headers = { "x-forwarded-for": "198.51.100.77" };
    const errors = [];
    for (let i = 0; i < PER_CLIENT_APPLE_CALLS_PER_MINUTE + 2; i++) {
      const res = mockRes();
      await shows({ method: "GET", query: { q: `zz-nomatch-${Date.now()}-${i}`, fallthrough: "1" }, headers }, res);
      assert.equal(res.statusCode, 200);
      errors.push(res.body.fallthrough.error);
    }
    assert.equal(errors.filter((e) => e === CLIENT_LIMITED_ERROR).length, 2);
    assert.equal(calls.apple, PER_CLIENT_APPLE_CALLS_PER_MINUTE);

    const short = mockRes();
    await shows({ method: "GET", query: { q: "a", fallthrough: "1" }, headers: { "x-forwarded-for": "198.51.100.78" } }, short);
    assert.equal(short.body.fallthrough.attempted, false);
    assert.equal(short.body.fallthrough.error, QUERY_TOO_SHORT_ERROR);
    assert.equal(calls.apple, PER_CLIENT_APPLE_CALLS_PER_MINUTE, "a one-letter query spent nothing");

    const long = mockRes();
    await shows({ method: "GET", query: { q: "y".repeat(201) }, headers }, long);
    assert.equal(long.statusCode, 400);
  });
});
