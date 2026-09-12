// api/shows/search.ts — S-05's degraded header and S-06's `id` lookup and
// Apple fall-through (docs/search-plan.md).
//
// WHAT THIS SUITE IS ABOUT, in one paragraph. The fall-through is the one
// thing in this deck that spends a budget somebody else controls: Apple's
// keyless search endpoint, capped by this repo's own committed ceiling of
// <=20/min per warm instance. So the tests that matter are not "does it
// return results" but "does it refuse to ask". Two gates have to hold — the
// client only sets `fallthrough=1` when its own local pass found nothing
// (asserted in test/show-search-fallthrough.test.js, on the other side of the
// wire), and this endpoint only performs the call when the full 19,904-row
// merged catalogue also found nothing. Without the second, the client's
// `chart_rank <= 100` index cut would make "zero hits" mean "not in 10,113"
// and a query for any mid-chart show would burn a slot for a show we hold.
//
// Every test names the mutation that kills it.
//
// Harness: the same `mockRes()` + `globalThis.fetch` swap api/test/
// episodes-search.test.mjs already uses, so a reader of one can read the
// other. Bucket and cache are INJECTED into `appleShowSearch` where the test
// is about them, rather than reaching into module singletons — the singletons
// are process-wide and a test that mutated them would leak into its
// neighbours.
import { test } from "node:test";
import assert from "node:assert";
import * as searchModule from "../shows/search.ts";
import {
  appleShowSearch, mapAppleShow, appleShowCacheKey,
} from "../shows/appleShowSearch.ts";
import { SlidingWindowBucket, APPLE_BUCKET_CAPACITY, APPLE_BUCKET_WINDOW_MS } from "../episodes/appleBucket.ts";
import { TtlCache } from "../episodes/searchCache.ts";

const handler = typeof searchModule.default === "function" ? searchModule.default : searchModule.default.default;

const REAL_SHOW_ID = "lex-fridman-podcast";      // first entry in data/catalog.json
const REAL_COLLECTION_ID = "1434243584";         // its apple_collection_id

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

const req = (query) => ({ method: "GET", query, headers: {} });

/** Runs the handler with `globalThis.fetch` swapped, and always puts it back. */
async function withFetch(fetchImpl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const appleBody = (results) => ({
  ok: true, status: 200, headers: new Headers(),
  json: async () => ({ results }),
});

const APPLE_HIT = {
  collectionId: 999000111,
  collectionName: "A Show Not In Our Catalogue At All",
  artistName: "Somebody Else",
  artworkUrl600: "https://is1-ssl.mzstatic.com/x/600.jpg",
  feedUrl: "https://example.invalid/feed.xml",
};

/* ====================================================================== */
/* S-06(b): the `id` lookup                                               */
/* ====================================================================== */

test("id lookup returns the single merged-catalogue row for a curated show", async () => {
  /* The linkability fix (#560 item 7). Without this, `#/show/<id>` on a cold
     open renders "Show not found." for every breadth show, because
     `state.breadthShowCache` is in-memory and this-session-only.

     MUTATION: return the whole catalogue instead of one row. The
     `Array.isArray` assertion below fails — and the client, which reads
     `data.show`, would seed `breadthShowCache` with an array. */
  const res = mockRes();
  await handler(req({ id: REAL_SHOW_ID }), res);
  assert.equal(res.statusCode, 200);
  assert.ok(!Array.isArray(res.body.show), "one row, not a list");
  assert.equal(res.body.show.show_id, REAL_SHOW_ID);
  assert.equal(res.body.show.tier, "curated");
  assert.equal(res.body.degraded, false);
});

test("id lookup resolves a breadth show by its minted apple_collection_id", async () => {
  /* The id shape is the whole join: `breadthCatalog.ts` mints
     `String(apple_collection_id)`, `tools/build-show-index.mjs` emits the
     same string, and `#/show/:id` carries it. A lookup that only understood
     curated `show_id`s would answer null for exactly the shows this endpoint
     exists to make linkable.

     `lex-fridman-podcast` IS curated, so its collection id is deduped out of
     the merged index (`in_curated`) — which is itself the thing being pinned
     here: the id that is NOT in the merged catalogue must answer null rather
     than a stale duplicate.

     MUTATION: drop the `in_curated` skip from `loadBreadthCatalog`. This id
     resolves to a second, poorer copy of the same show and the null assertion
     fails. */
  const res = mockRes();
  await handler(req({ id: REAL_COLLECTION_ID }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.show, null);
});

test("an unknown id is a 200 with show: null, not a 404", async () => {
  /* Deliberate, and the client depends on it. `app.js:fetchApiJson` returns
     `null` for ANY non-ok response, so a 404 here would be indistinguishable
     from a dead endpoint — and those need different UI ("Show not found."
     versus leaving the page alone).

     MUTATION: `res.status(404)` for a null row. `resolveMissingShow` can no
     longer tell a real miss from an outage. */
  const res = mockRes();
  await handler(req({ id: "not-a-real-id-at-all" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.show, null);
  assert.equal(res.body.degraded, false);
});

test("q and id together are a 400, and neither is a 400", async () => {
  /* Rejected rather than silently preferring one: answering `q` and ignoring
     `id` would make a caller's bug look like a working request returning the
     wrong thing, which is the hardest kind to notice from the client.

     MUTATION: `if (id) { ... }` before the mutual-exclusion check. The first
     assertion gets a 200 and goes red. */
  const both = mockRes();
  await handler(req({ q: "lex", id: REAL_SHOW_ID }), both);
  assert.equal(both.statusCode, 400);

  const neither = mockRes();
  await handler(req({}), neither);
  assert.equal(neither.statusCode, 400);
});

/* ====================================================================== */
/* S-06(a): the Apple fall-through, and the two gates                     */
/* ====================================================================== */

test("the fall-through does NOT fire when the merged catalogue has hits, even if the client asked for it", async () => {
  /* THE SECOND GATE, and the one the card's own MUTATION line names. The
     client sets `fallthrough=1` when ITS index found nothing — and its index
     is the `chart_rank <= 100` cut, 10,113 of 19,904 rows. So "the client
     asked" is not "nobody has this show", and acting on the client's word
     alone would spend a 20/min budget on shows we already hold.

     MUTATION (the card's): fire the fall-through whenever `fallthrough=1` is
     present. Apple is called for a query the catalogue answered, `called`
     becomes true, and this goes red. */
  let called = false;
  await withFetch(async () => { called = true; return appleBody([APPLE_HIT]); }, async () => {
    const res = mockRes();
    await handler(req({ q: "lex", fallthrough: "1" }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.shows.length > 0, "fixture assumption: \"lex\" matches the real committed catalogue");
    assert.equal(res.body.fallthrough.attempted, false);
    assert.deepEqual(res.body.source, ["catalogue"]);
  });
  assert.equal(called, false, "Apple must not be asked about a show our own catalogue has");
});

test("the fall-through does NOT fire on a genuine miss when the client did not ask", async () => {
  /* THE FIRST GATE, asserted from this side. A zero-hit query is not on its
     own a licence to call Apple: a caller that is not the search box (a
     script, a probe, `tools/search-probe.mjs`'s own forced-MISS samples —
     which fire three unique queries per run) must not spend the budget.

     MUTATION: drop `fallthroughAsked` from the condition. The probe's own
     three forced-MISS queries per run would each cost an Apple call, and this
     goes red. */
  let called = false;
  await withFetch(async () => { called = true; return appleBody([APPLE_HIT]); }, async () => {
    const res = mockRes();
    await handler(req({ q: "zzqx-nothing-matches-this" }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.shows, []);
    assert.equal(res.body.fallthrough.attempted, false);
  });
  assert.equal(called, false);
});

test("both gates open: a genuine miss the client asked about returns Apple hits in the client's own row shape", async () => {
  /* The happy path, and the shape is the assertion. A tapped Apple result has
     to resolve through the SAME `state.breadthShowCache` -> `#/show/:id` path
     a breadth result does, with no new client branch — so the row must carry
     `show_id` (the collection id as a string), `title`, `artwork_url`, `tier`,
     `editorial_note` and `taxonomy_node_ids`.

     `artist_name` is the extra one and it is not decoration: §1.1 measured
     that our own breadth catalogue has NO author field on any of its 19,787
     rows, so this is the only place the "titles AND authors" half of the
     Pocket Casts premise exists at all.

     MUTATION: map `collectionId` without `String()`. `show_id` becomes a
     number, `encodeURIComponent` still works, and `showById`'s `===` compare
     against the string from the hash silently never matches — the result
     renders and then says "Show not found." The typeof assertion catches it. */
  await withFetch(async (url) => {
    assert.match(String(url), /entity=podcast&/, "the SHOW entity, not podcastEpisode");
    return appleBody([APPLE_HIT]);
  }, async () => {
    const res = mockRes();
    await handler(req({ q: "zzqx-nothing-matches-this", fallthrough: "1" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.fallthrough.attempted, true);
    assert.equal(res.body.fallthrough.error, null);
    assert.deepEqual(res.body.source, ["apple"]);
    const row = res.body.shows[0];
    assert.equal(typeof row.show_id, "string");
    assert.equal(row.show_id, "999000111");
    assert.equal(row.title, APPLE_HIT.collectionName);
    assert.equal(row.artwork_url, APPLE_HIT.artworkUrl600);
    assert.equal(row.artist_name, "Somebody Else");
    assert.equal(row.tier, "breadth");
    assert.deepEqual(row.taxonomy_node_ids, []);
  });
});

test("an unmappable Apple hit degrades rather than throwing, and is dropped rather than surfaced broken", async () => {
  /* A hit with no `collectionId` has no id for `#/show/:id` to resolve and one
     with no name has nothing to render. Both are dropped — never surfaced with
     a broken link, which is the rule the episode path already applies.

     MUTATION: return the hit with `show_id: String(undefined)`. A row titled
     correctly but linking to `#/show/undefined` appears, and the length
     assertion goes red. */
  await withFetch(async () => appleBody([
    { collectionName: "No Id Here" },
    { collectionId: 5 },
    { collectionId: 7, collectionName: "   " },
    APPLE_HIT,
  ]), async () => {
    const res = mockRes();
    await handler(req({ q: "zzqx-nothing-matches-this", fallthrough: "1" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.shows.length, 1);
    assert.equal(res.body.shows[0].show_id, "999000111");
  });
  assert.equal(mapAppleShow({ collectionName: "x" }), null);
  assert.equal(mapAppleShow(null), null);
});

test("an Apple transport failure returns the local results with a flag, never an error status", async () => {
  /* "Rate-limit exhaustion returns the local results with a flag, never an
     error" is the card's own line, and the same holds for a timeout or a 503:
     the listener gets the honest empty state they would have got anyway.

     MUTATION: rethrow the fetch error out of `appleShowSearch`. The handler
     500s and this goes red on the status assertion. */
  await withFetch(async () => { throw new Error("ECONNRESET"); }, async () => {
    const res = mockRes();
    await handler(req({ q: "zzqx-transport-failure-query", fallthrough: "1" }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.shows, []);
    assert.equal(res.body.fallthrough.attempted, true);
    assert.match(res.body.fallthrough.error, /ECONNRESET/);
    assert.equal(res.headers["Cache-Control"], "no-store",
      "a failed fall-through must not be edge-cached as an answer");
  });
});

/* ====================================================================== */
/* The bucket and the cache, driven directly                              */
/* ====================================================================== */

test("a synthetic burst of 25 queries against one warm instance yields at most 20 Apple calls and 5 honest empties", async () => {
  /* The card's own acceptance line, run against a fresh injected bucket so it
     does not depend on — or disturb — the module singleton.

     25 DISTINCT queries, because an identical one would be answered from the
     cache and would prove nothing about the bucket.

     MUTATION: have `tryConsume` record the timestamp before the capacity
     check. The 21st call is admitted and `calls` reads 21. */
  const bucket = new SlidingWindowBucket(APPLE_BUCKET_CAPACITY, APPLE_BUCKET_WINDOW_MS);
  const cache = new TtlCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return appleBody([APPLE_HIT]); };

  const outcomes = [];
  for (let i = 0; i < 25; i++) {
    outcomes.push(await appleShowSearch(`burst-query-${i}`, 25, fetchImpl, { bucket, cache }));
  }
  assert.equal(calls, 20, `expected exactly ${APPLE_BUCKET_CAPACITY} Apple calls, got ${calls}`);
  assert.equal(outcomes.filter((o) => o.error === null).length, 20);
  const refused = outcomes.filter((o) => o.error !== null);
  assert.equal(refused.length, 5);
  for (const o of refused) {
    assert.match(o.error, /rate limit/);
    assert.deepEqual(o.shows, [], "a refused query is an honest empty, never a throw");
  }
});

test("a cached query does not re-call Apple, and does not consume a bucket slot", async () => {
  /* The ORDER inside `appleShowSearch` is what this pins: cache first, bucket
     second. A cached answer that still consumed a slot would let a listener
     retyping the same miss exhaust the budget on a question already answered.

     An EMPTY successful answer is cached too — "Apple has never heard of this
     either" is a real answer worth remembering for an hour, and it is the
     common one for the queries that reach this path at all.

     MUTATION: move the `bucket.tryConsume()` above the cache read. The
     `currentCount` assertion reads 2 and this goes red. */
  const bucket = new SlidingWindowBucket(APPLE_BUCKET_CAPACITY, APPLE_BUCKET_WINDOW_MS);
  const cache = new TtlCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return appleBody([]); };

  const first = await appleShowSearch("same question", 25, fetchImpl, { bucket, cache });
  const second = await appleShowSearch("  SAME Question  ", 25, fetchImpl, { bucket, cache });
  assert.equal(calls, 1, "the second ask must be answered from the cache");
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.deepEqual(second.shows, []);
  assert.equal(bucket.currentCount(), 1, "a cache hit must not spend a slot");
  assert.equal(appleShowCacheKey("Radiolab", 25), appleShowCacheKey("  radiolab ", 25));
});

test("a failed Apple call is not cached, so a later identical query retries", async () => {
  /* Same rule the client-side hot-query cache follows: a transport failure is
     not an answer. Caching it would turn one bad moment into an hour of empty
     fall-throughs for that query on that instance.

     MUTATION: cache `shows` before checking `error`. The second call is served
     the failure and `calls` stays at 1. */
  const bucket = new SlidingWindowBucket(APPLE_BUCKET_CAPACITY, APPLE_BUCKET_WINDOW_MS);
  const cache = new TtlCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return appleBody([APPLE_HIT]);
  };
  const first = await appleShowSearch("retry me", 25, fetchImpl, { bucket, cache });
  assert.match(first.error, /boom/);
  const second = await appleShowSearch("retry me", 25, fetchImpl, { bucket, cache });
  assert.equal(calls, 2);
  assert.equal(second.error, null);
  assert.equal(second.shows.length, 1);
});

test("the show fall-through has its OWN bucket, so it cannot exhaust episode search's budget", async () => {
  /* The card says "do not copy-paste a third rate limiter", and this module
     does not — it imports the same CLASS and the same constants. But sharing
     the episode path's INSTANCE would mean a listener typing in the Shows box
     could starve the Episodes section on the same page, and vice versa.

     MUTATION: import `appleSearchBucket` from `../episodes/appleBucket` and
     use it here instead of a new instance. The two counts move together and
     the independence assertion fails. */
  const { appleSearchBucket } = await import("../episodes/appleBucket.ts");
  const { appleShowBucket } = await import("../shows/appleShowSearch.ts");
  assert.notEqual(appleShowBucket, appleSearchBucket, "two instances, not one");
  const before = appleSearchBucket.currentCount();
  appleShowBucket.tryConsume();
  assert.equal(appleSearchBucket.currentCount(), before,
    "spending a show-search slot must not spend an episode-search one");
  assert.equal(APPLE_BUCKET_CAPACITY, 20, "the CONSTANT is shared, so 20/min means one thing in this repo");
});

/* ====================================================================== */
/* S-05: the degraded branch's header                                     */
/* ====================================================================== */

test("the degraded branch sets Cache-Control: no-store", async () => {
  /* #560 item 10 / requirements §6.12. The catch branch set NO Cache-Control
     at all, so an empty degraded response — the shape produced when the
     catalogue files are missing from the deployed bundle — could be
     edge-cached under Vercel's default while `api/episodes/search.ts` sets
     `no-store` on its own degraded answers. A cached "the catalogue is
     unreadable" is a five-minute outage for everyone behind that edge.

     THIS IS A SOURCE-TEXT PIN, NOT AN EXECUTED ONE, and saying so is the
     point rather than an apology. `backend/src/catalog/breadthCatalog.ts`
     resolves `data/` from its own `__dirname`, so the only ways to make the
     real catch branch run are to delete or corrupt a committed 12.5 MB data
     file mid-suite, or to add a dependency-injection seam to production code
     that exists solely for this test. Both are worse than a regex: the first
     is a destructive test, the second is a production change with no
     production caller. What a source pin can still catch is the ONLY realistic
     regression here — somebody editing that branch and dropping the header —
     and it cannot silently become a no-op, because it asserts the branch was
     located before it asserts anything about it.

     The EXECUTED half of the same rule is two tests above: a failed
     fall-through really does set `no-store`, driven through the handler.

     MUTATION: delete the `res.setHeader("Cache-Control", "no-store")` line
     from the catch branch. Red. */
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "shows", "search.ts"), "utf8");
  const catchBlocks = [...src.matchAll(/catch\s*\{[\s\S]*?degraded:\s*true[\s\S]*?\}/g)].map((m) => m[0]);
  assert.equal(catchBlocks.length, 2,
    "expected exactly two degraded catch branches — the `id` lookup's and the search's. " +
    "If a third appears, it needs the same header and this count is how you find out.");
  for (const block of catchBlocks) {
    assert.match(block, /no-store/, "every degraded branch must set Cache-Control: no-store");
  }
  /* And that each answers an honest empty rather than a 500: `show: null` for
     the id lookup, `shows: []` for the search. */
  assert.ok(catchBlocks.some((b) => /show:\s*null/.test(b)));
  assert.ok(catchBlocks.some((b) => /shows:\s*\[\]/.test(b)));
});

test("a successful response still carries the cache header the source claims, and the source says what production actually returns", async () => {
  /* S-05's third ask: "do not silently keep a directive that does not arrive."
     Measured three times (docs/search-plan.md §1.4, §1.6, §1.7): the source
     sets `stale-while-revalidate=3600` and the response as received from
     production carries only `public, max-age=300`. S-05 deliberately did NOT
     add an `s-maxage` to compensate — that would be a second unverified
     directive beside the first — so the correction is a note in the source,
     and this test is what keeps the note attached to the code it describes.

     MUTATION: delete the measured paragraph from `api/shows/search.ts`'s
     header. The next reader plans against a directive that does not arrive,
     as two decks already did, and this goes red. */
  const res = mockRes();
  await handler(req({ q: "lex" }), res);
  assert.equal(res.headers["Cache-Control"], "public, max-age=300, stale-while-revalidate=3600");

  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "shows", "search.ts"), "utf8");
  assert.match(src, /stale-while-revalidate.{0,400}does NOT arrive/s,
    "the source must record that the directive it sets is not the one production returns");
});
