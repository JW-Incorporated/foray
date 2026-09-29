// One parsed feed per show, shared by the list and the show-scoped search
// (round-3 audit, search-api-css-3). Every show-page search keystroke that
// missed the query-keyed cache, and every cursor page of the list, used to
// re-download and re-parse the whole feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeedReader, FEED_FRESH_MS } from "../_lib/feedCache.ts";
import * as searchModule from "../episodes/search.ts";
import * as episodesModule from "../shows/[show_id]/episodes.ts";
import { episodeSearchCache, episodeFeedFailureCache } from "../_lib/searchCache.ts";

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
  episodeFeedFailureCache.clear();
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
