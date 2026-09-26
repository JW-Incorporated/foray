// A guid-less episode has ONE id across the per-show list and the show-scoped
// search (round-3 audit; the server half of L2's app-1-5). The list minted
// `noguid:<title>:<published_at or feed position>` while search returned
// `guid: null`, so a search hit could not be matched to the row the client
// already held, and two guid-less hits shared the id null.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as searchModule from "../episodes/search.ts";
import * as episodesModule from "../shows/[show_id]/episodes.ts";
import { episodeSearchCache, episodeFeedFailureCache } from "../_lib/searchCache.ts";
import { liveEpisodeGuid } from "../_lib/liveEpisodeId.ts";
import { episodeIdentity as dbEpisodeIdentity } from "../../backend/src/catalog/ingestShowFeed.ts";

const pick = (m) => (typeof m.default === "function" ? m.default : m.default.default);
const search = pick(searchModule);
const list = pick(episodesModule);
const SHOW = "lex-fridman-podcast";

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Lex</title>
<item><title>Talk One</title><enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg" length="1"/><pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate></item>
<item><title>Talk Two</title><enclosure url="https://cdn.example.com/2.mp3" type="audio/mpeg" length="1"/></item>
<item><title>Has Guid</title><guid>real-guid</guid><enclosure url="https://cdn.example.com/3.mp3" type="audio/mpeg" length="1"/></item>
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

async function withFeed(run) {
  const originalFetch = globalThis.fetch;
  const had = "DATABASE_URL" in process.env;
  const originalDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  globalThis.fetch = async () => new Response(FEED, { status: 200 });
  episodeSearchCache.clear();
  episodeFeedFailureCache.clear();
  searchModule.sharedFeedReader.clear();
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (had) process.env.DATABASE_URL = originalDb;
  }
}

test("a show-scoped search hit carries the same id the per-show list serves that episode under", async () => {
  /* MUTATION: return `guid: ep.guid` from mapLiveEpisode again — the two
     guid-less hits come back null and match nothing in the list. */
  await withFeed(async () => {
    const listRes = mockRes();
    await list({ method: "GET", query: { show_id: SHOW }, headers: {} }, listRes);
    const listIds = listRes.body.episodes.map((e) => e.guid);

    const searchRes = mockRes();
    await search({ method: "GET", query: { q: "talk", show: SHOW }, headers: {} }, searchRes);
    const hitIds = searchRes.body.episodes.map((e) => e.guid);

    assert.equal(hitIds.length, 2);
    assert.ok(hitIds.every((id) => typeof id === "string" && id.startsWith("noguid:")), JSON.stringify(hitIds));
    assert.notEqual(hitIds[0], hitIds[1], "two guid-less episodes never share an id");
    for (const id of hitIds) assert.ok(listIds.includes(id), `${id} is not an id the list serves`);
  });
});

test("liveEpisodeGuid: a real guid wins, an empty one falls back, and the feed position breaks a missing date", () => {
  assert.equal(liveEpisodeGuid({ guid: "g", title: "T", publishedAt: null }, 3), "g");
  assert.equal(liveEpisodeGuid({ guid: "", title: "T", publishedAt: null }, 3), "noguid:T:3");
  assert.equal(liveEpisodeGuid({ guid: null, title: "T", publishedAt: "2026-01-01T00:00:00.000Z" }, 3), "noguid:T:2026-01-01T00:00:00.000Z");
});

/* Round-3 review (L6): the DB ingest keyed a guid-less episode as
   noguid:<enclosure url>:<title>:<date> while the live list and search keyed it
   noguid:<title>:<date>, so with DATABASE_URL set the list and search served
   different ids, and every stored guid-less row was duplicated on the next
   ingest (and again whenever the enclosure URL rotated).
   MUTATION: put the enclosure URL back into the DB key -- the ids differ. */
test("the DB ingest and the live paths mint one id for a guid-less episode, and a rotated URL keeps it", () => {
  const dated = { guid: null, title: "Talk One", publishedAt: "2026-01-01T00:00:00.000Z", enclosureUrl: "https://cdn.example.com/1.mp3" };
  assert.equal(dbEpisodeIdentity(dated), liveEpisodeGuid(dated, 0));
  assert.equal(dbEpisodeIdentity(dated), "noguid:Talk One:2026-01-01T00:00:00.000Z", "the key rows were already stored under");
  assert.equal(dbEpisodeIdentity({ ...dated, enclosureUrl: "https://dts.podtrac.com/redirect.mp3/cdn.example.com/1.mp3" }), dbEpisodeIdentity(dated));
  const undated = { guid: "", title: "Talk Two", publishedAt: null, enclosureUrl: "https://cdn.example.com/2.mp3" };
  assert.equal(dbEpisodeIdentity(undated), liveEpisodeGuid(undated, 7));
  assert.equal(liveEpisodeGuid(undated, 7), liveEpisodeGuid(undated, 8), "a prepended episode does not move an undated one's id");
});

/* Round-3 review (L4): the show-scoped cache key folded punctuation
   (normalizeSearchText) while the matcher is a raw substring test, so
   "part-2" and "part 2" shared one key but matched different titles, and the
   first query's answer was served to the second for an hour.
   MUTATION: key the show-scoped path with normalizeQueryKey again -- the second
   query gets the first one's hit. */
test("show-scoped queries that match different titles never share a cached answer", async () => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Lex</title>
<item><title>Deep Dive part-2</title><guid>g-dash</guid><enclosure url="https://cdn.example.com/d.mp3" type="audio/mpeg" length="1"/></item>
<item><title>Deep Dive part 2</title><guid>g-space</guid><enclosure url="https://cdn.example.com/s.mp3" type="audio/mpeg" length="1"/></item>
</channel></rss>`;
  const originalFetch = globalThis.fetch;
  const had = "DATABASE_URL" in process.env;
  const originalDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  globalThis.fetch = async () => new Response(feed, { status: 200 });
  episodeSearchCache.clear();
  episodeFeedFailureCache.clear();
  searchModule.sharedFeedReader.clear();
  try {
    const ask = async (q) => {
      const res = mockRes();
      await search({ method: "GET", query: { q, show: SHOW }, headers: {} }, res);
      return res.body.episodes.map((e) => e.guid);
    };
    assert.deepEqual(await ask("part-2"), ["g-dash"]);
    assert.deepEqual(await ask("part 2"), ["g-space"]);
    assert.deepEqual(await ask("Part-2 "), ["g-dash"], "case and outer spaces still share the key");
  } finally {
    globalThis.fetch = originalFetch;
    if (had) process.env.DATABASE_URL = originalDb;
  }
});
