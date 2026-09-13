// api/episodes/search.ts end-to-end tests (S-07, kanban t_6baccaa0):
// general Apple-backed search, show-scoped live search, id-map dropping,
// rate limiting, and caching.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as searchModule from "../episodes/search.ts";
import { _resetShowIdMapCacheForTests, loadShowIdMap } from "../episodes/showIdMap.ts";
import { episodeFeedFailureCache } from "../episodes/searchCache.ts";

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
  /* P-05 piece 3: the feed-failure memory is module scope and 90 s long, so a
     failure remembered by one test would answer a later one from a different
     test's setup. Cleared here rather than per-test for the same reason the
     id-map cache is. */
  episodeFeedFailureCache.clear();
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

// ---------------------------------------------------------------------------
// P-05 piece 1 (docs/search-parity-plan.md §4, 2026-09-12): the id-map spans
// BOTH catalogue files, so `mapAppleHit`'s drop rule stops eating most of
// every answer.
//
// These read the REAL data/catalog.json + data/catalog-breadth.json on
// purpose — the defect was entirely a question of which committed file the
// map reads, and a fixture pair would have stayed green throughout the bug.
// Every assertion below is an INVARIANT or a floor, never an inventory count:
// the catalogue grows on a schedule (tools/harvest-*), and a test that reddens
// because 19,787 became 21,000 would be a false alarm, not a finding.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const CATALOG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data", "catalog.json"), "utf8"));
const BREADTH = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data", "catalog-breadth.json"), "utf8"));

/** A real breadth-only show: present in catalog-breadth.json, not flagged
 *  `in_curated`, and with no curated row claiming its Apple id. Derived rather
 *  than pinned so this suite survives any particular show leaving the
 *  catalogue — the id 863897795 that the P-05 probe measured is a fine example
 *  and a terrible fixture. */
function someBreadthOnlyShow() {
  const curatedIds = new Set(
    CATALOG.shows.filter((s) => typeof s.apple_collection_id === "number").map((s) => s.apple_collection_id)
  );
  return BREADTH.shows.find(
    (s) => !s.in_curated && typeof s.apple_collection_id === "number" && s.title && !curatedIds.has(s.apple_collection_id)
  );
}

async function loadFallbackMap() {
  _resetShowIdMapCacheForTests();
  // A fetchImpl that throws proves the map is built from committed files
  // alone: data/shows-index-pointer.json does not exist on main, so
  // tryLoadReleaseIdMap() must bail before it ever reaches the network.
  const map = await loadShowIdMap({
    fetchImpl: async () => {
      throw new Error("no network in this test");
    },
    forceReload: true,
  });
  _resetShowIdMapCacheForTests();
  return map;
}

test("id-map: a breadth-only show's Apple collectionId maps to its numeric show_id instead of being dropped", async () => {
  // MUTATION THAT TURNS THIS RED: delete the catalog-breadth.json pass from
  // showIdMap.ts:loadCatalogFallback() — i.e. restore the pre-P-05 220-id map,
  // under which this id resolved to nothing and every episode of this show was
  // silently discarded by mapAppleHit.
  const show = someBreadthOnlyShow();
  assert.ok(show, "data/catalog-breadth.json has no breadth-only show — the fixture assumption is gone, not the behaviour");
  const idMap = await loadFallbackMap();
  assert.strictEqual(
    idMap.byCollectionId.get(show.apple_collection_id),
    String(show.apple_collection_id),
    `breadth show "${show.title}" (${show.apple_collection_id}) must map to its minted numeric show_id`
  );
});

test("id-map: a curated show keeps its SLUG id — the curated pass is merged first and breadth never overwrites it", async () => {
  // MUTATION THAT TURNS THIS RED: swap the two passes in
  // loadCatalogFallback(), or drop its `if (map.has(...)) continue` guard.
  // Either one hands a curated show the numeric id, and
  // backend/src/catalog/breadthCatalog.ts DROPS the breadth row for a curated
  // show — so that numeric id resolves to nothing on the show page. That is
  // exactly the broken link mapAppleHit's drop rule exists to prevent,
  // reintroduced by the very change meant to widen it.
  const idMap = await loadFallbackMap();
  let checked = 0;
  for (const show of CATALOG.shows) {
    if (!show.show_id || typeof show.apple_collection_id !== "number") continue;
    assert.strictEqual(
      idMap.byCollectionId.get(show.apple_collection_id),
      show.show_id,
      `curated show ${show.show_id} must map to its slug, not to ${show.apple_collection_id}`
    );
    checked++;
  }
  assert.ok(checked > 0, "no curated show carries an apple_collection_id — the join this map is built on is gone");
});

test("id-map: every id it mints resolves to a show the merged catalogue will actually hand back", async () => {
  // THE INVARIANT THE DROP RULE WAS REALLY PROTECTING, stated directly. A
  // mapped hit renders a row linking to #/show/<show_id>, which
  // api/shows/search.ts answers out of backend/src/catalog/breadthCatalog.ts's
  // merged index. Any id in this map that is NOT in that index is a dead link
  // on a live result row — strictly worse than the drop it replaced.
  //
  // MUTATION THAT TURNS THIS RED: delete BOTH of loadCatalogFallback()'s
  // breadth-pass guards — `if (show.in_curated) continue` and
  // `if (map.has(...)) continue`. Verified red, 2026-09-12: the 103
  // `in_curated` rows then get numeric ids, breadthCatalog.ts drops exactly
  // those rows, and 103 entries point at show_ids the merged catalogue does
  // not contain.
  //
  // SAID HONESTLY, because a test that overstates its own coverage is worse
  // than no test: deleting the `in_curated` guard ALONE leaves this green on
  // the committed data, because every `in_curated` breadth row happens to
  // have a curated counterpart today (0 orphans, checked 2026-09-12) and the
  // `map.has` guard therefore catches all of them first. The guard is kept
  // anyway — it is the half of the rule that does not depend on that
  // coincidence holding — and THIS assertion is what notices if the
  // coincidence ever stops holding, which is the thing worth catching.
  //
  // Scale-free by construction: it quantifies over whatever the map holds, so
  // a bigger catalogue cannot redden it — only a drift between the two
  // admission rules can.
  const { loadBreadthCatalog } = await import("../../backend/src/catalog/breadthCatalog.ts");
  const resolvable = new Set(loadBreadthCatalog().map((s) => s.show_id));
  const idMap = await loadFallbackMap();
  const unresolvable = [];
  for (const [collectionId, showId] of idMap.byCollectionId) {
    if (!resolvable.has(showId)) unresolvable.push(`${collectionId} -> ${showId}`);
  }
  assert.deepStrictEqual(
    unresolvable.slice(0, 10),
    [],
    `${unresolvable.length} id-map entries point at show_ids the merged catalogue does not contain (first 10 shown)`
  );
});

test("id-map: it is strictly wider than the curated-only map it replaced, and lost no curated id buying that", async () => {
  // A FLOOR, NOT A COUNT. Containment (every curated Apple id still present)
  // plus "strictly more entries than curated rows", which holds for any
  // catalogue in which at least one breadth-only show exists. It deliberately
  // does NOT pin 19,843 or 19,787 or 220: the harvest moves those numbers on
  // its own schedule and nothing here may go red for the catalogue growing.
  //
  // MUTATION THAT TURNS THIS RED: reading catalog-breadth.json INSTEAD of
  // catalog.json rather than in addition to it — the plausible bad fix, which
  // widens the map while quietly breaking all 220 curated links.
  const idMap = await loadFallbackMap();
  const curatedIds = CATALOG.shows
    .filter((s) => s.show_id && typeof s.apple_collection_id === "number")
    .map((s) => s.apple_collection_id);
  for (const id of curatedIds) {
    assert.ok(idMap.byCollectionId.has(id), `curated Apple id ${id} fell out of the id-map`);
  }
  assert.ok(
    idMap.byCollectionId.size > curatedIds.length,
    `id-map (${idMap.byCollectionId.size}) must be wider than the curated set (${curatedIds.length}) it used to be limited to`
  );
});

test("general search: a breadth-only show's Apple hit now reaches the response, end to end through the handler", async () => {
  // The point of the card, through the real handler rather than the map alone.
  //
  // MUTATION THAT TURNS THIS RED: any change that puts loadCatalogFallback()
  // back on catalog.json alone. Pre-P-05 this exact request answered
  // `{episodes: [], source: [], degraded: false}` — the measured production
  // behaviour for `tim ferriss`, `sam harris`, `elon musk`,
  // `artificial intelligence` and `the daily` on 2026-09-12.
  resetSharedState();
  const show = someBreadthOnlyShow();
  assert.ok(show, "no breadth-only show in the committed catalogue");
  const fetchImpl = async (url) => {
    if (String(url).includes("itunes.apple.com")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              collectionId: show.apple_collection_id,
              collectionName: show.title,
              trackName: "A breadth-show episode",
              episodeGuid: "breadth-g1",
              episodeUrl: "https://cdn.example.com/breadth.mp3",
              trackTimeMillis: 90000,
              releaseDate: "2026-01-01T00:00:00Z",
            },
          ],
        }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const req = { method: "GET", query: { q: `breadth-hit-${Date.now()}` }, headers: {} };
  const res = mockRes();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await handler(req, res);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.episodes.length, 1, "the breadth hit must survive mapAppleHit");
  assert.strictEqual(res.body.episodes[0].show_id, String(show.apple_collection_id));
  assert.strictEqual(res.body.episodes[0].source, "apple");
});

// ---------------------------------------------------------------------------
// P-05 piece 3 (docs/search-parity-plan.md §4, 2026-09-12) — THE SHOW PAGE.
// A feed that just failed is not refetched on the next keystroke.
//
// Measured motivation, live endpoint 2026-09-12: `omega-tau`'s feed fails from
// Vercel on every attempt, burns 387 / 467 / 756 ms, and — because the handler
// set `no-store` and skipped the cache write on error — paid that on EVERY
// query, forever.
// ---------------------------------------------------------------------------

const FAILING_SHOW = "lex-fridman-podcast"; // a real catalogue show; only its FETCH is made to fail here

test("show-scoped: a feed that just failed is not refetched for the next, different query", async () => {
  // THE CARD. Two different `q` values against the same show, so
  // episodeSearchCache's query-keyed entry cannot be what answers the second
  // one — only the show-keyed failure memory can.
  //
  // MUTATION THAT TURNS THIS RED: delete the `episodeFeedFailureCache.get`
  // short-circuit in the handler's showScope branch, or the
  // `else if (feedFailed)` write that fills it. `feedFetches` becomes 2.
  resetSharedState();
  let feedFetches = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("itunes.apple.com")) throw new Error("Apple must not be called in show-scoped mode");
    feedFetches++;
    throw new Error("fetch failed");
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  let first, second;
  try {
    first = mockRes();
    await handler({ method: "GET", query: { q: `p05c-${Date.now()}-one`, show: FAILING_SHOW }, headers: {} }, first);
    second = mockRes();
    await handler({ method: "GET", query: { q: `p05c-${Date.now()}-two`, show: FAILING_SHOW }, headers: {} }, second);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.strictEqual(feedFetches, 1, "the second query must be answered from the remembered failure, not a second feed fetch");
  assert.strictEqual(first.body.degraded, true);
  assert.strictEqual(second.body.degraded, true, "the remembered answer must still be honest about being degraded");
  assert.ok(second.body.error, "and must carry the original error rather than a silent empty result");
  assert.deepStrictEqual(second.body.episodes, []);
});

test("show-scoped: a remembered failure is never replayed as an empty success, and never handed to the edge", async () => {
  // TWO LIES THIS MUST NOT TELL. `degraded: false` with zero episodes tells the
  // listener their query matched nothing (the client's
  // `searchShowEpisodesScoped` branches on exactly that and would stop falling
  // back to `filterLoadedEpisodes`). And a cacheable `Cache-Control` would let
  // the CDN keep the dark window alive long past FEED_FAILURE_TTL_MS, turning
  // a 90-second guard into an unbounded outage.
  //
  // MUTATION THAT TURNS THIS RED: answer the short-circuit with
  // `degraded: false`, or give it the success path's
  // `public, max-age=300, ...` header.
  resetSharedState();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("itunes.apple.com")) throw new Error("no Apple here");
    throw new Error("fetch failed");
  };
  let replay;
  try {
    await handler({ method: "GET", query: { q: `p05c-${Date.now()}-a`, show: FAILING_SHOW }, headers: {} }, mockRes());
    replay = mockRes();
    await handler({ method: "GET", query: { q: `p05c-${Date.now()}-b`, show: FAILING_SHOW }, headers: {} }, replay);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.strictEqual(replay.body.degraded, true);
  assert.strictEqual(replay.headers["Cache-Control"], "no-store");
});

test("show-scoped: an unknown show_id is not remembered as a feed failure", async () => {
  // ONLY THE EXPENSIVE FAILURE IS WORTH REMEMBERING. An unknown show_id never
  // touched the network, so caching it buys nothing and costs honesty — and
  // more to the point, a failure memory that fills up with non-failures is one
  // that will eventually dark-window a show that was never broken.
  //
  // MUTATION THAT TURNS THIS RED: write the failure cache on any `error`
  // rather than on `feedFailed` (i.e. drop the `feedFailed` flag threaded
  // through searchWithinShow). The second call would be answered from the
  // remembered failure and `reached` would stay false.
  resetSharedState();
  await handler({ method: "GET", query: { q: "anything", show: "definitely-not-a-real-show" }, headers: {} }, mockRes());

  // The same unknown id again must still walk the real path rather than a
  // remembered one: it reaches loadShowMeta and answers "unknown show_id".
  const again = mockRes();
  await handler({ method: "GET", query: { q: "anything-else", show: "definitely-not-a-real-show" }, headers: {} }, again);
  assert.deepStrictEqual(again.body.episodes, []);
  assert.match(String(again.body.error || ""), /unknown show_id/, "must still be the real unknown-id answer, not a replayed feed failure");
});

test("show-scoped: a healthy feed is never poisoned by another show's failure", async () => {
  // The memory is keyed by show. A broken feed elsewhere in the catalogue must
  // not take a working show's search box down with it.
  //
  // MUTATION THAT TURNS THIS RED: key episodeFeedFailureCache on anything
  // shared across shows (a single boolean, the query, the empty string).
  resetSharedState();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("itunes.apple.com")) throw new Error("no Apple here");
    throw new Error("fetch failed");
  };
  try {
    await handler({ method: "GET", query: { q: `p05c-${Date.now()}-x`, show: FAILING_SHOW }, headers: {} }, mockRes());
  } finally {
    globalThis.fetch = originalFetch;
  }

  const healthy = mockRes();
  const healthyFetch = async (url) => {
    if (String(url).includes("itunes.apple.com")) throw new Error("no Apple here");
    return new Response(FEED_TWO_EPS, { status: 200, headers: { "content-type": "application/rss+xml" } });
  };
  const restore = globalThis.fetch;
  globalThis.fetch = healthyFetch;
  try {
    // A different show_id whose feed answers normally.
    await handler({ method: "GET", query: { q: "alpha", show: "huberman-lab" }, headers: {} }, healthy);
  } finally {
    globalThis.fetch = restore;
  }
  assert.strictEqual(healthy.body.degraded, false, "an unrelated show must be unaffected by the remembered failure");
  assert.strictEqual(healthy.body.episodes.length, 1);
});

/* THIS TEST MUST STAY LAST IN THE FILE. It deliberately drains
   appleBucket.ts's 20/min bucket, which is module state shared by every test
   above it — node:test runs a file's top-level tests in source order, so any
   Apple-path test placed after this one is answered `degraded: true, "rate
   limit exceeded"` and fails for a reason that has nothing to do with what it
   asserts. That is not hypothetical: P-05's end-to-end test was appended below
   it and failed exactly this way before being moved above. Add new Apple-path
   tests ABOVE this comment. */
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
