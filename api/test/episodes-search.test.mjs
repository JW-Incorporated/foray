// api/episodes/search.ts end-to-end tests (S-07, kanban t_6baccaa0):
// general Apple-backed search, show-scoped live search, id-map dropping,
// rate limiting, and caching.
import { test } from "node:test";
import assert from "node:assert";
import * as searchModule from "../episodes/search.ts";
import { _resetShowIdMapCacheForTests } from "../episodes/showIdMap.ts";

const handler = typeof searchModule.default === "function" ? searchModule.default : searchModule.default.default;

const REAL_SHOW_ID = "lex-fridman-podcast"; // first entry in data/catalog.json
const REAL_COLLECTION_ID = 1434243584; // lex-fridman-podcast's apple_collection_id in data/catalog.json

function mockRes() {
  const headers = {};
  const state = { statusCode: null, body: undefined, ended: false };
  return {
    headers,
    get statusCode() { return state.statusCode; },
    get body() { return state.body; },
    status(code) { state.statusCode = code; return this; },
    json(body) { state.body = body; },
    setHeader(name, value) { headers[name] = value; },
    end() { state.ended = true; },
  };
}

function resetSharedState() {
  _resetShowIdMapCacheForTests();
}

const FEED_TWO_EPS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Lex Fridman Podcast</title>
  <description>Conversations about science, tech, philosophy.</description>
  <item>
    <title>Episode Alpha</title>
    <guid>ep-a</guid>
    <description>First</description>
    <enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg" length="1000"/>
    <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Episode Beta</title>
    <guid>ep-b</guid>
    <description>Second</description>
    <enclosure url="https://cdn.example.com/b.mp3" type="audio/mpeg" length="1000"/>
    <pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

test("general search: an Apple hit whose collectionId maps to a known show is returned with source apple", async () => {
  resetSharedState();
  const fetchImpl = async (url) => {
    if (String(url).includes("itunes.apple.com")) {
      return new Response(
        JSON.stringify({
          results: [
            { collectionId: REAL_COLLECTION_ID, collectionName: "Lex Fridman Podcast", trackName: "A great episode", episodeGuid: "g1", episodeUrl: "https://cdn.example.com/ep.mp3", trackTimeMillis: 60000, releaseDate: "2026-01-01T00:00:00Z" },
          ],
        }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const req = { method: "GET", query: { q: `uniquequery-${Date.now()}-a` }, headers: {} };
  const res = mockRes();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await handler(req, res);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.episodes.length, 1);
  assert.strictEqual(res.body.episodes[0].show_id, REAL_SHOW_ID);
  assert.strictEqual(res.body.episodes[0].source, "apple");
  assert.deepStrictEqual(res.body.source, ["apple"]);
});

test("general search: an Apple hit whose collectionId does NOT map to any known show is dropped, never surfaced", async () => {
  resetSharedState();
  const fetchImpl = async (url) => {
    if (String(url).includes("itunes.apple.com")) {
      return new Response(
        JSON.stringify({
          results: [
            { collectionId: 999999999, collectionName: "Unknown Show", trackName: "Some episode", episodeGuid: "gx", episodeUrl: "https://cdn.example.com/x.mp3" },
          ],
        }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const req = { method: "GET", query: { q: `uniquequery-${Date.now()}-b` }, headers: {} };
  const res = mockRes();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await handler(req, res);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.episodes, [], "an unmapped collectionId must never appear in results");
});

test("show-scoped search (show=): fetches the live feed and filters by title substring, no Apple call", async () => {
  resetSharedState();
  let appleWasCalled = false;
  const fetchImpl = async (url) => {
    if (String(url).includes("itunes.apple.com")) {
      appleWasCalled = true;
      throw new Error("Apple must not be called in show-scoped mode");
    }
    return new Response(FEED_TWO_EPS, { status: 200, headers: { "content-type": "application/rss+xml" } });
  };
  const req = { method: "GET", query: { q: "alpha", show: REAL_SHOW_ID }, headers: {} };
  const res = mockRes();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await handler(req, res);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.strictEqual(appleWasCalled, false);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.episodes.length, 1);
  assert.strictEqual(res.body.episodes[0].title, "Episode Alpha");
  assert.strictEqual(res.body.episodes[0].source, "live");
  assert.deepStrictEqual(res.body.source, ["live"]);
});

test("show-scoped search: unknown show_id returns an empty, non-crashing result", async () => {
  resetSharedState();
  const req = { method: "GET", query: { q: "alpha", show: "definitely-not-a-real-show" }, headers: {} };
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.episodes, []);
});

test("missing q is 400", async () => {
  const req = { method: "GET", query: {}, headers: {} };
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 400);
});

test("method other than GET/OPTIONS is 405", async () => {
  const req = { method: "POST", query: { q: "x" }, headers: {} };
  const res = mockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 405);
});

test("CORS: OPTIONS preflight is answered before any Apple call is attempted", async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("must not be called on OPTIONS");
  };
  const req = { method: "OPTIONS", query: { q: "x" }, headers: { origin: "https://jwlabs.ai" } };
  const res = mockRes();
  try {
    await handler(req, res);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.headers["Access-Control-Allow-Origin"], "https://jwlabs.ai");
  assert.strictEqual(called, false);
});

test("caching: a repeated identical query does not call Apple a second time", async () => {
  resetSharedState();
  let calls = 0;
  const q = `cache-test-${Date.now()}`;
  const fetchImpl = async (url) => {
    if (String(url).includes("itunes.apple.com")) {
      calls++;
      return new Response(JSON.stringify({ results: [{ collectionId: REAL_COLLECTION_ID, collectionName: "Lex Fridman Podcast", trackName: "Cached ep", episodeGuid: "gc", episodeUrl: "https://cdn.example.com/c.mp3" }] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const req1 = { method: "GET", query: { q }, headers: {} };
    const res1 = mockRes();
    await handler(req1, res1);
    assert.strictEqual(res1.body.episodes.length, 1);

    const req2 = { method: "GET", query: { q }, headers: {} };
    const res2 = mockRes();
    await handler(req2, res2);
    assert.strictEqual(res2.body.episodes.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.strictEqual(calls, 1, "a cached query must not call Apple's endpoint a second time");
});

test("caching: the cache key includes limit, so a later request with a different limit is never served a stale truncated/expanded list", async () => {
  /* MUTATION: drop `limit` from normalizeQueryKey's key. A ?limit=1 request
     followed by a ?limit=10 request for the same query text would then
     return the cached 1-item list for the second call — this test catches
     exactly that regression (found in review of t_6baccaa0). */
  resetSharedState();
  let calls = 0;
  const q = `cache-limit-test-${Date.now()}`;
  const fetchImpl = async (url) => {
    if (String(url).includes("itunes.apple.com")) {
      calls++;
      return new Response(
        JSON.stringify({
          results: [
            { collectionId: REAL_COLLECTION_ID, collectionName: "Lex Fridman Podcast", trackName: "Ep A", episodeGuid: "ga", episodeUrl: "https://cdn.example.com/a.mp3" },
            { collectionId: REAL_COLLECTION_ID, collectionName: "Lex Fridman Podcast", trackName: "Ep B", episodeGuid: "gb", episodeUrl: "https://cdn.example.com/b.mp3" },
          ],
        }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const req1 = { method: "GET", query: { q, limit: "1" }, headers: {} };
    const res1 = mockRes();
    await handler(req1, res1);
    assert.strictEqual(res1.body.episodes.length, 1, "limit=1 must return exactly one result");

    const req2 = { method: "GET", query: { q, limit: "10" }, headers: {} };
    const res2 = mockRes();
    await handler(req2, res2);
    assert.strictEqual(res2.body.episodes.length, 2, "a different limit for the same query text must not be served the other limit's cached, differently-sized list");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rate limit: the 21st distinct general search within the same instant is refused without calling Apple", async () => {
  // Drives the handler itself through the bucket capacity — imports across
  // separate test files can get separate module instances under tsx's ESM
  // loader, so exhausting the bucket via the handler's OWN calls (rather
  // than importing appleBucket.ts directly here) is what actually proves
  // the acceptance criterion end-to-end.
  resetSharedState();
  let appleCallCount = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("itunes.apple.com")) {
      appleCallCount++;
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const prefix = `burst-${Date.now()}`;
  try {
    const results = [];
    // 25 distinct (uncached) queries fired as fast as this loop can go.
    for (let i = 0; i < 25; i++) {
      const req = { method: "GET", query: { q: `${prefix}-${i}` }, headers: {} };
      const res = mockRes();
      await handler(req, res);
      results.push(res.body);
    }
    const refused = results.filter((r) => r.degraded && /rate limit/.test(r.error || ""));
    assert.ok(refused.length > 0, "at least one of the 25 rapid distinct queries must be rate-limited");
    assert.ok(appleCallCount <= 20, `Apple must never be called more than 20 times in the burst, got ${appleCallCount}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
