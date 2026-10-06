// One rule for a repeated query parameter (code-health CH-17, X1-13).
//
// WHY THIS EXISTS
// `?q=a&q=b` arrives as `req.query.q = ["a", "b"]`. Which value an endpoint
// answers was decided by a private `firstParam` copied into every handler
// (and a `firstHeader` copy in `_lib/cors.ts`), so a fix to one copy would
// leave the show-scoped search and the per-show list disagreeing about the
// same URL. The rule now lives once, in `api/_lib/params.ts`, and every
// caller imports it.
//
// These tests drive each REAL handler with a repeated parameter, so they pin
// the behaviour a caller sees, not the helper in isolation:
//   - the three single-value endpoints answer the FIRST value;
//   - CORS reads the FIRST Origin header value;
//   - the catch-all shard route keeps EVERY path segment (its helper is
//     `allParams`, a different rule with a different name).
//
// MUTATION (what makes this red): change `firstParam` in api/_lib/params.ts to
// prefer the last value (`v[v.length - 1]`) and the episodes-search, the
// shows-search, the per-show-list and the CORS tests below all fail at once,
// which is the point of the shared helper. Making `allParams` keep only the
// first segment fails the catch-all test.
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { firstParam } from "../_lib/params.ts";
import { applyCors } from "../_lib/cors.ts";
import * as episodeSearchModule from "../episodes/search.ts";
import * as showSearchModule from "../shows/search.ts";
import * as showEpisodesModule from "../shows/[show_id]/episodes.ts";
import * as indexModule from "../shows/index/[...path].ts";
import { encodeCursor } from "../_lib/episodeCursor.ts";
import { sharedFeedReader } from "../_lib/feedCache.ts";
import { episodeFeedFailureCache } from "../_lib/searchCache.ts";
import { appleCallerBuckets } from "../_lib/clientLimit.ts";

const unwrap = (m) => (typeof m.default === "function" ? m.default : m.default.default);
const episodeSearch = unwrap(episodeSearchModule);
const showSearch = unwrap(showSearchModule);
const showEpisodes = unwrap(showEpisodesModule);
const showsIndex = unwrap(indexModule);

const REAL_SHOW_ID = "lex-fridman-podcast"; // first entry in data/catalog.json

function mockRes() {
  const headers = {};
  const state = { statusCode: null, body: undefined };
  return {
    headers,
    get statusCode() { return state.statusCode; },
    get body() { return state.body; },
    status(code) { state.statusCode = code; return this; },
    json(body) { state.body = body; },
    setHeader(name, value) { headers[name] = value; },
    end() {},
  };
}

async function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function withoutDatabaseUrl(run) {
  const had = "DATABASE_URL" in process.env;
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    return await run();
  } finally {
    if (had) process.env.DATABASE_URL = original;
  }
}

const FEED_TWO_EPS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Lex Fridman Podcast</title>
  <description>Conversations.</description>
  <item>
    <title>Episode One</title>
    <guid>ep-1</guid>
    <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg" length="1000"/>
    <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Episode Two</title>
    <guid>ep-2</guid>
    <enclosure url="https://cdn.example.com/ep2.mp3" type="audio/mpeg" length="1000"/>
    <pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

test("firstParam: a string is itself, an array is its first value, absent is null", () => {
  assert.strictEqual(firstParam("a"), "a");
  assert.strictEqual(firstParam(["a", "b"]), "a");
  assert.strictEqual(firstParam([]), null);
  assert.strictEqual(firstParam(undefined), null);
  assert.strictEqual(firstParam(""), "");
});

test("GET /api/episodes/search?q=a&q=b answers the first q", async () => {
  episodeFeedFailureCache.clear();
  episodeSearchModule.sharedFeedReader.clear();
  appleCallerBuckets.clear();
  const first = `ch17-first-${Date.now()}`;
  const req = { method: "GET", query: { q: [first, `ch17-second-${Date.now()}`] }, headers: {} };
  const res = mockRes();
  const asked = [];
  await withFetch(async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }, () => episodeSearch(req, res));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.query, first);
  assert.ok(asked.every((u) => u.includes(first) && !u.includes("ch17-second")), asked.join("\n"));
});

test("GET /api/shows/search?q=a&q=b answers the first q, and ?id=a&id=b the first id", async () => {
  const qRes = mockRes();
  await withFetch(async (url) => assert.fail(`no network without fallthrough: ${url}`),
    () => showSearch({ method: "GET", query: { q: ["lex fridman", "zzzz"] }, headers: {} }, qRes));
  assert.strictEqual(qRes.statusCode, 200);
  assert.strictEqual(qRes.body.query, "lex fridman");

  const idRes = mockRes();
  await showSearch({ method: "GET", query: { id: [REAL_SHOW_ID, "definitely-not-a-show"] }, headers: {} }, idRes);
  assert.strictEqual(idRes.statusCode, 200);
  assert.strictEqual(idRes.body.id, REAL_SHOW_ID);
  assert.notStrictEqual(idRes.body.show, null);
});

test("GET /api/shows/:id/episodes?cursor=a&cursor=b pages from the first cursor", async () => {
  await withoutDatabaseUrl(() =>
    withFetch(
      async () => new Response(FEED_TWO_EPS, { status: 200, headers: { "content-type": "application/rss+xml" } }),
      async () => {
        sharedFeedReader.clear();
        const top = mockRes();
        await showEpisodes({ method: "GET", query: { show_id: REAL_SHOW_ID }, headers: {} }, top);
        assert.strictEqual(top.statusCode, 200);
        assert.deepStrictEqual(top.body.episodes.map((e) => e.title), ["Episode Two", "Episode One"]);

        const newest = top.body.episodes[0];
        const cursor = encodeCursor({ publishedAt: newest.published_at, guid: newest.guid });
        const res = mockRes();
        await showEpisodes({ method: "GET", query: { show_id: REAL_SHOW_ID, cursor: [cursor, "not-a-cursor"] }, headers: {} }, res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body.episodes.map((e) => e.title), ["Episode One"]);
      }
    )
  );
});

test("CORS reads the first Origin value of a repeated header", () => {
  const res = mockRes();
  applyCors({ method: "GET", headers: { origin: ["https://jwlabs.ai", "https://evil.example"] } }, res);
  assert.strictEqual(res.headers["Access-Control-Allow-Origin"], "https://jwlabs.ai");
});

test("GET /api/shows/index/shards/fr.json keeps EVERY catch-all segment (allParams, not firstParam)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch17-pointer-"));
  indexModule._setPointerPathForTests(path.join(dir, "does-not-exist.json"));
  try {
    const res = mockRes();
    await withFetch(async (url) => assert.fail(`no pointer, no fetch: ${url}`),
      () => showsIndex({ method: "GET", query: { path: ["shards", "fr.json"] }, headers: {} }, res));
    /* "shards/fr.json" is an allowed asset, so the request reaches the
       pointer check (404, nothing published). Keeping only "shards" would be
       an unlisted asset: a 400. */
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.available, false);

    const single = mockRes();
    await showsIndex({ method: "GET", query: { path: "manifest.json" }, headers: {} }, single);
    assert.strictEqual(single.statusCode, 404);

    const none = mockRes();
    await showsIndex({ method: "GET", query: {}, headers: {} }, none);
    assert.strictEqual(none.statusCode, 400);
  } finally {
    indexModule._setPointerPathForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
