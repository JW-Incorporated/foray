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
// CHARACTERIZATION FIRST: this file pinned the answers before the one
// catalogue reader (api/_lib/showCatalog.ts) replaced the three, including
// the defects; the change commit flipped each defect pin and says beside it
// what it said before.
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
import { episodeSearchCache } from "../_lib/searchCache.ts";

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
  episodeSearchModule.showScopedResultCache.clear();
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

test("an in_curated numeric id is an alias: all three readers answer its curated twin (A1-02)", async () => {
  /* WAS: the two episode endpoints answered 200 on the dropped breadth row's
     OWN feed (175 of 175; 5 of those feeds are not the twin's) and
     shows/search?id= answered `show: null` (175 of 175).
     MUTATION: drop the alias (showCatalog.showById's twin lookup) -> the list
     404s, the scoped search says unknown, ?id= says null: all three 0. */
  await withFeedStub(async (urls) => {
    let listTwin = 0;
    let scopedTwin = 0;
    let idTwin = 0;
    for (const row of IN_CURATED) {
      const id = String(row.apple_collection_id);
      const twin = curatedByAppleId.get(id);
      const list = await listAnswer(id, urls);
      if (list.status === 200 && list.feed === twin.feed_url && list.body.show_id === twin.show_id) listTwin++;
      const scoped = await scopedSearchAnswer(id, urls);
      if (scoped.feed === twin.feed_url) scopedTwin++;
      if ((await showById(id)).show?.show_id === twin.show_id) idTwin++;
    }
    assert.equal(listTwin, 175, "list endpoint: 200, served as the twin, on the twin's feed");
    assert.equal(scopedTwin, 175, "show-scoped search: the twin's feed");
    assert.equal(idTwin, 175, "shows/search?id=: the twin's row");
  });
});

test("a feed-less breadth show: show search no longer offers it; its record still answers, its episode list still 404s (B1-02)", async () => {
  /* WAS: searchable 89 of 89 - offered by show search, then a 404 on tap.
     MUTATION: search `loadBreadthCatalog()` again instead of
     `searchableShows()` in api/shows/search.ts -> searchable 89, red. */
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
    assert.equal(searchable, 0, "searchable");
    assert.equal(list404, 89, "episode list 404s");
    assert.equal(idAnswers, 89, "shows/search?id= answers the row");
  });
});

test("a feed-less breadth show: the directory pass does not hand it back either (B1-02)", async () => {
  /* The catalogue pass above leaves the 89 out, but `fallthrough=1` (app.js
     sends it on every search of SHOW_DIRECTORY_MIN_QUERY_LENGTH or more)
     appends Apple's rows, and Apple's row for a show IS its collectionId:
     the same id as the feed-less breadth row. mergeDirectoryShows dedups
     only against the rows in the reply, where the feed-less row no longer
     is, so Apple's twin of it came back and 404'd on tap the same way.
     Apple is stubbed answering all 89 under their real titles plus one
     show we have never heard of (the premise that the pass ran and merged).
     WAS: offered 89 of 89.
     MUTATION: drop the feed-less filter on `apple.shows` in
     api/shows/search.ts -> offered > 0, red. */
  const CONTROL = { collectionId: 999000222, collectionName: "Zz Directory Only Control Show", artistName: "Somebody" };
  const hits = [...FEEDLESS.map((s) => ({ collectionId: s.apple_collection_id, collectionName: s.title })), CONTROL];
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ results: hits }) });
  const res = mockRes();
  try {
    await showSearchHandler(
      { method: "GET", query: { q: "zzfeedlessdirectorypin", limit: "100", fallthrough: "1" }, headers: {} },
      res
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(res.body.fallthrough.attempted, true, "premise: the directory pass ran");
  assert.equal(res.body.fallthrough.error, null, "premise: the directory pass succeeded");
  const ids = new Set(res.body.shows.map((s) => s.show_id));
  assert.ok(ids.has(String(CONTROL.collectionId)), "premise: a directory row the catalogue does not know is merged");
  const offered = FEEDLESS.filter((s) => ids.has(String(s.apple_collection_id))).length;
  assert.equal(offered, 0, "feed-less shows offered by the directory pass");
});

/** Runs `body` (an ES module source) in a fresh process from api/ — fresh
    module state, so every module-scope cache starts empty — after `prelude`,
    with no database and a network that throws. Returns its JSON on stdout. */
function inFreshInstance(prelude, body) {
  const script = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    ${prelude}
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

/** inFreshInstance, where every fs.readFileSync of data/catalog*.json throws
    ENOENT — a deploy that shipped without the two catalogue files. */
function inInstanceWithoutCatalogue(body) {
  return inFreshInstance(`
    const real = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) {
      if (/data[\\\\/]catalog(-breadth)?\\.json$/.test(String(file))) {
        const err = new Error("ENOENT: " + file); err.code = "ENOENT"; throw err;
      }
      return real.call(this, file, ...rest);
    };
  `, body);
}

test("catalogue files missing: the list says 503, the searches say degraded", () => {
  /* WAS: the list said 404 `unknown show_id` - a broken deploy dressed as a
     bad link. The four answers are showCatalog.ts's header's table. */
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
  assert.deepEqual(got.list, { status: 503, body: { error: "show metadata catalog files are unavailable" } });
  assert.equal(got.scoped.body.degraded, true);
  assert.equal(got.scoped.body.error, "show metadata catalog files are unavailable");
  assert.deepEqual(got.showsQ.body, { query: "lex", shows: [], degraded: true });
  assert.deepEqual(got.showsId.body, { id: "lex-fridman-podcast", show: null, degraded: true });
});

test("the episodes/search bundle parses catalog-breadth.json once per instance (B1-02)", () => {
  /* WAS: 2 - the show-scoped search (its own loadShowMeta) and the Apple
     path (showIdMap's own map) each read the 12.5 MB pair.
     MUTATION: give showIdMap.ts its own readFileSync of the pair again ->
     2, red. */
  const got = inFreshInstance(`
    const real = fs.readFileSync;
    globalThis.__breadthReads = 0;
    fs.readFileSync = function (file, ...rest) {
      if (/data[\\\\/]catalog-breadth\\.json$/.test(String(file))) globalThis.__breadthReads++;
      return real.call(this, file, ...rest);
    };
  `, `
    const search = unwrap(await import("./episodes/search.ts"));
    const a = res(); await search({ method: "GET", query: { q: "zz", show: "lex-fridman-podcast" }, headers: {} }, a);
    const b = res(); await search({ method: "GET", query: { q: "history" }, headers: {} }, b);
    const c = res(); await search({ method: "GET", query: { q: "zz", show: "the-daily" }, headers: {} }, c);
    console.log(JSON.stringify({ reads: globalThis.__breadthReads, apple: b.s.body.error }));
  `);
  assert.match(got.apple, /Apple search fetch error/, "premise: the Apple path ran (and asked the network, which throws)");
  assert.equal(got.reads, 1);
});
