// One catalogue for api/ (code-health-2 CH2-24: B1-02, A1-02).
//
// Three endpoints resolve a show id against data/catalog.json +
// data/catalog-breadth.json:
//   - GET /api/shows/:id/episodes          (the show page's list)
//   - GET /api/episodes/search?show=<id>   (the show page's search box)
//   - GET /api/shows/search?id=<id> / ?q=  (the show record / show search)
// This suite drives the three REAL handlers over the committed data, with
// `fetch` stubbed (it records the feed URL a resolved show asks for and
// answers a two-line feed), and pins what each one answers for the three
// populations the review found:
//   - every curated show_id,
//   - the in_curated breadth rows' numeric ids (the curated shows' Apple ids),
//   - the admitted breadth rows that carry no feed_url.
//
// CHARACTERIZATION FIRST: this file pins TODAY's answers, including the two
// defects, before anything moves. The change commit flips the two defect
// pins and says so beside each.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as episodesModule from "../shows/[show_id]/episodes.ts";
import * as episodeSearchModule from "../episodes/search.ts";
import * as showSearchModule from "../shows/search.ts";
import { sharedFeedReader } from "../_lib/feedCache.ts";
import { episodeSearchCache, episodeFeedFailureCache } from "../_lib/searchCache.ts";

const unwrap = (m) => (typeof m.default === "function" ? m.default : m.default.default);
const listHandler = unwrap(episodesModule);
const episodeSearchHandler = unwrap(episodeSearchModule);
const showSearchHandler = unwrap(showSearchModule);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const readData = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", name), "utf8"));
const CATALOG = readData("catalog.json");
const BREADTH = readData("catalog-breadth.json");

const curatedByAppleId = new Map(CATALOG.shows.map((s) => [String(s.apple_collection_id), s]));
const IN_CURATED = BREADTH.shows.filter((s) => s.in_curated);
const FEEDLESS = BREADTH.shows.filter(
  (s) => !s.in_curated && s.apple_collection_id != null && s.title && !s.feed_url
);

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>
<item><title>Only Episode</title><guid>g-1</guid>
<enclosure url="https://cdn.example.test/1.mp3" type="audio/mpeg" length="1"/>
<pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate></item></channel></rss>`;

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

/** Runs `fn` with fetch answering FEED and recording every URL asked for,
    no database, and no kept feed or search answer from an earlier call. */
async function withFeedStub(fn) {
  const original = globalThis.fetch;
  const hadDb = "DATABASE_URL" in process.env;
  const db = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(FEED, { status: 200, headers: { "content-type": "application/rss+xml" } });
  };
  try {
    return await fn(urls);
  } finally {
    globalThis.fetch = original;
    if (hadDb) process.env.DATABASE_URL = db;
  }
}

function freshCaches() {
  sharedFeedReader.clear();
  episodeSearchCache.clear();
  episodeFeedFailureCache.clear();
}

/** What the list endpoint does with `id`: its status and the feed it fetched. */
async function listAnswer(id, urls) {
  freshCaches();
  urls.length = 0;
  const res = mockRes();
  await listHandler({ method: "GET", query: { show_id: id }, headers: {} }, res);
  return { status: res.statusCode, feed: urls[0] ?? null, body: res.body };
}

let searchSeq = 0;
/** What the show-scoped search does with `id`: resolved (feed fetched) or its error. */
async function scopedSearchAnswer(id, urls) {
  freshCaches();
  urls.length = 0;
  const res = mockRes();
  await episodeSearchHandler({ method: "GET", query: { q: `zz-no-title-${searchSeq++}`, show: id }, headers: {} }, res);
  return { feed: urls[0] ?? null, error: res.body.error, degraded: res.body.degraded };
}

/** What `/api/shows/search?id=` hands back for `id`. */
async function showById(id) {
  const res = mockRes();
  await showSearchHandler({ method: "GET", query: { id }, headers: {} }, res);
  return res.body;
}

test("premise: the populations this suite is about exist in the committed data", () => {
  /* Counts are the review's (A1-02, B1-02), measured on the committed data.
     They are premises, not the behaviour under test: a harvest that moves
     them reddens THIS test only, and its message says which number moved. */
  assert.equal(IN_CURATED.length, 175, "in_curated breadth rows");
  assert.equal(FEEDLESS.length, 89, "admitted breadth rows with no feed_url");
  const orphans = IN_CURATED.filter((s) => !curatedByAppleId.has(String(s.apple_collection_id)));
  assert.deepEqual(orphans.map((s) => s.apple_collection_id), [], "every in_curated row has a curated twin");
});

test("every curated show_id resolves to the same feed through all three readers", async () => {
  /* Green before and after: the curated tier is what the unification must
     not move. MUTATION: drop the curated pass from any one reader (or let a
     breadth row win an id) -> that reader's answer differs and this fails. */
  await withFeedStub(async (urls) => {
    const drift = [];
    for (const show of CATALOG.shows) {
      const list = await listAnswer(show.show_id, urls);
      const scoped = await scopedSearchAnswer(show.show_id, urls);
      const row = await showById(show.show_id);
      const got = [list.status === 200 ? list.feed : `list ${list.status}`, scoped.feed ?? scoped.error, row.show?.feed_url ?? "id: null"];
      if (got.some((g) => g !== show.feed_url)) drift.push(`${show.show_id}: ${got.join(" | ")}`);
    }
    assert.deepEqual(drift.slice(0, 5), [], `${drift.length} curated ids resolve differently somewhere`);
  });
});

test("an in_curated numeric id: TODAY the two episode endpoints resolve it to its own breadth row and shows/search?id= does not know it (A1-02)", async () => {
  await withFeedStub(async (urls) => {
    let listOwnFeed = 0;
    let scopedOwnFeed = 0;
    let idNull = 0;
    for (const row of IN_CURATED) {
      const id = String(row.apple_collection_id);
      const list = await listAnswer(id, urls);
      if (list.status === 200 && list.feed === row.feed_url) listOwnFeed++;
      const scoped = await scopedSearchAnswer(id, urls);
      if (scoped.feed === row.feed_url) scopedOwnFeed++;
      if ((await showById(id)).show === null) idNull++;
    }
    assert.equal(listOwnFeed, 175, "list endpoint: 200 on the breadth row's own feed");
    assert.equal(scopedOwnFeed, 175, "show-scoped search: the breadth row's own feed");
    assert.equal(idNull, 175, "shows/search?id=: show null");
  });
});

test("a feed-less breadth show: TODAY show search returns it, and its episode list 404s (B1-02)", async () => {
  await withFeedStub(async (urls) => {
    let searchable = 0;
    let list404 = 0;
    let idAnswers = 0;
    for (const row of FEEDLESS) {
      const id = String(row.apple_collection_id);
      const res = mockRes();
      await showSearchHandler({ method: "GET", query: { q: row.title, limit: "100" }, headers: {} }, res);
      if (res.body.shows.some((s) => s.show_id === id)) searchable++;
      if ((await listAnswer(id, urls)).status === 404) list404++;
      if ((await showById(id)).show?.show_id === id) idAnswers++;
    }
    assert.equal(searchable, 89, "searchable");
    assert.equal(list404, 89, "episode list 404s");
    assert.equal(idAnswers, 89, "shows/search?id= answers the row");
  });
});

/** Runs `body` (an ES module source) in a fresh process from api/, where
    every fs.readFileSync of data/catalog*.json throws ENOENT — a deploy that
    shipped without the two catalogue files. Returns its JSON on stdout. */
function inInstanceWithoutCatalogue(body) {
  const script = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const real = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) {
      if (/data[\\\\/]catalog(-breadth)?\\.json$/.test(String(file))) {
        const err = new Error("ENOENT: " + file); err.code = "ENOENT"; throw err;
      }
      return real.call(this, file, ...rest);
    };
    syncBuiltinESMExports();
    delete process.env.DATABASE_URL;
    globalThis.fetch = async () => { throw new Error("no network"); };
    const unwrap = (m) => (typeof m.default === "function" ? m.default : m.default.default);
    const res = () => { const s = {}; return { s, status(c) { s.status = c; return this; }, json(b) { s.body = b; }, setHeader() {}, end() {} }; };
    ${body}
  `;
  const out = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.join(ROOT, "api"),
    encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

test("catalogue files missing: TODAY the list says 404 unknown, the searches say degraded", () => {
  const got = inInstanceWithoutCatalogue(`
    const list = unwrap(await import("./shows/[show_id]/episodes.ts"));
    const scoped = unwrap(await import("./episodes/search.ts"));
    const shows = unwrap(await import("./shows/search.ts"));
    const a = res(); await list({ method: "GET", query: { show_id: "lex-fridman-podcast" }, headers: {} }, a);
    const b = res(); await scoped({ method: "GET", query: { q: "x", show: "lex-fridman-podcast" }, headers: {} }, b);
    const c = res(); await shows({ method: "GET", query: { q: "lex" }, headers: {} }, c);
    const d = res(); await shows({ method: "GET", query: { id: "lex-fridman-podcast" }, headers: {} }, d);
    console.log(JSON.stringify({ list: a.s, scoped: b.s, showsQ: c.s, showsId: d.s }));
  `);
  assert.deepEqual(got.list, { status: 404, body: { error: "unknown show_id" } });
  assert.equal(got.scoped.body.degraded, true);
  assert.equal(got.scoped.body.error, "show metadata catalog files are unavailable");
  assert.deepEqual(got.showsQ.body, { query: "lex", shows: [], degraded: true });
  assert.deepEqual(got.showsId.body, { id: "lex-fridman-podcast", show: null, degraded: true });
});
