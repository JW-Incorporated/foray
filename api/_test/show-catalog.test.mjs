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
import os from "node:os";
import zlib from "node:zlib";
import { sharedFeedReader } from "../_lib/feedCache.ts";
import { episodeSearchCache } from "../_lib/searchCache.ts";
import { _resetCorpusCatalogueForTests, CORPUS_FETCH_TIMEOUT_MS } from "../_lib/showCatalog.ts";
import { loadShowIdMap } from "../_lib/showIdMap.ts";

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

/* ====================================================================== */
/* THE CORPUS CATALOGUE THROUGH ITS POINTER (docs/roadmap/corpus.md PKG-33) */
/* ====================================================================== */
/* api/_lib/showCatalog.ts's `ensureCorpusCatalogue()` reads
   data/corpus-catalogue-pointer.json (PKG-32's shape), fetches its
   `catalogue_url` (catalog-breadth-corpus.json.gz) once per process and, when
   it is a usable catalogue, serves its rows in place of
   data/catalog-breadth.json's. Every reader awaits it before its first
   lookup: show search (q and id), the episode list and the show-scoped
   search (api/_lib/resolveShow.ts) and the Apple fallback's id map
   (api/_lib/showIdMap.ts). The pointer does not exist on main, so the
   absent branch is the one every deploy takes today. */

const CORPUS_URL = "https://corpus.example.test/corpus-export-2026-10-09/catalog-breadth-corpus.json.gz";
const CORPUS_SHOWS = [
  { apple_collection_id: 990000201, title: "Zz Corpus Fixture Alpha", feed_url: "https://feeds.example.test/alpha.xml", artwork_url: null, in_curated: false, chart_rank: 12, taxonomy_node_ids: [] },
  { apple_collection_id: 990000202, title: "Zz Corpus Fixture Beta", feed_url: "https://feeds.example.test/beta.xml", artwork_url: null, in_curated: false, chart_rank: null, taxonomy_node_ids: [] },
];
const COMMITTED_BREADTH_ID = "73329284"; // Science Friday: a committed breadth row the 2-row corpus does not carry
const COMMITTED_BREADTH_TITLE = "Science Friday";

/** A pointer file in a tmp dir naming CORPUS_URL; returns its path. */
function writePointer(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-pointer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "corpus-catalogue-pointer.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    export_version: "2026-10-09",
    release_tag: "corpus-export-2026-10-09",
    asset_base_url: "https://corpus.example.test/corpus-export-2026-10-09",
    manifest_url: "https://corpus.example.test/corpus-export-2026-10-09/manifest.json",
    catalogue_url: CORPUS_URL,
    shows_url: "https://corpus.example.test/corpus-export-2026-10-09/shows.jsonl.gz",
    published_at: "2026-10-09T00:00:00.000Z",
    counts: { podcasts: 2 },
    ...extra,
  }));
  return file;
}

const gz = (value) => zlib.gzipSync(Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));

/** Runs `fn` with the corpus state reset to `opts`, fetch swapped for
    `fetchImpl` (every URL recorded), console output collected instead of
    printed, and everything put back afterwards (the committed catalogue
    included). */
async function withCorpus(t, opts, fetchImpl, fn) {
  const original = globalThis.fetch;
  const hadDb = "DATABASE_URL" in process.env;
  const db = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const urls = []; // listAnswer/scopedSearchAnswer empty this one per call
  const fetched = []; // every URL, never emptied
  const logs = [];
  const spies = ["warn", "log", "error", "info"].map((k) => t.mock.method(console, k, (...a) => logs.push(`${k}: ${a.join(" ")}`)));
  _resetCorpusCatalogueForTests(opts);
  freshCaches();
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    fetched.push(String(url));
    return fetchImpl(String(url), init);
  };
  try {
    return await fn({ urls, fetched, logs });
  } finally {
    globalThis.fetch = original;
    if (hadDb) process.env.DATABASE_URL = db;
    for (const s of spies) s.mock.restore();
    _resetCorpusCatalogueForTests();
    freshCaches();
  }
}

/** The corpus answer `corpus` for CORPUS_URL, a two-line feed for any other URL. */
const corpusFetch = (corpus) => async (url, init) => {
  if (url === CORPUS_URL) return corpus(init);
  return new Response(FEED, { status: 200, headers: { "content-type": "application/rss+xml" } });
};

const corpusFetches = (fetched) => fetched.filter((u) => u === CORPUS_URL).length;

async function showSearchQ(q) {
  const res = mockRes();
  await showSearchHandler({ method: "GET", query: { q, limit: "25" }, headers: {} }, res);
  return res.body;
}

test("corpus pointer + a 2-row gz catalogue: every reader answers from it, fetched once (PKG-33)", async (t) => {
  /* Each reader is asked FIRST in a fresh instance state (the corpus
     forgotten before it), so each one's own await is what loads the corpus.
     MUTATION: drop `await ensureCorpusCatalogue()` from api/shows/search.ts ->
     the q search finds no "Zz Corpus Fixture" row and ?id= says null, red.
     MUTATION: drop it from api/_lib/resolveShow.ts -> the episode list
     404s the corpus show and the scoped search says unknown, red.
     MUTATION: drop it from api/_lib/showIdMap.ts -> the id map has no
     990000201, red. MUTATION: remember nothing (fetch on every ensure) ->
     fetched more than once, red. */
  const pointerPath = writePointer(t);
  const body = gz({ version: 1, source: "foraycorpus", shows: CORPUS_SHOWS });
  await withCorpus(t, { pointerPath }, corpusFetch(() => new Response(body, { status: 200 })), async ({ urls, fetched, logs }) => {
    const fresh = () => {
      _resetCorpusCatalogueForTests({ pointerPath });
      freshCaches();
      fetched.length = 0;
    };

    fresh();
    const idMap = await loadShowIdMap();
    assert.equal(idMap.byCollectionId.get(990000201), "990000201", "the Apple fallback's id map knows the corpus show");
    assert.equal(idMap.byCollectionId.get(1434243584), "lex-fridman-podcast", "and curated still wins its Apple id");

    fresh();
    const found = await showSearchQ("Zz Corpus Fixture");
    assert.equal(found.degraded, false);
    assert.deepEqual(found.shows.map((s) => s.show_id).sort(), ["990000201", "990000202"]);

    fresh();
    const alpha = await showById("990000201");
    assert.equal(alpha.show?.title, "Zz Corpus Fixture Alpha");
    assert.equal(alpha.show?.tier, "breadth");
    // In place of the committed breadth rows, not beside them: a committed
    // breadth show the corpus does not carry is gone; curated shows stay.
    assert.equal((await showById(COMMITTED_BREADTH_ID)).show, null);
    assert.equal((await showById("lex-fridman-podcast")).show?.tier, "curated");

    fresh();
    // (urls: what that one call fetched; the corpus asset comes first here)
    const feedsAsked = () => urls.filter((u) => u !== CORPUS_URL);
    const list = await listAnswer("990000201", urls);
    assert.equal(list.status, 200, "the episode list serves the corpus show");
    assert.deepEqual(feedsAsked(), ["https://feeds.example.test/alpha.xml"]);

    fresh();
    const scoped = await scopedSearchAnswer("990000202", urls);
    assert.equal(scoped.error, null, "the show-scoped search resolves it too");
    assert.deepEqual(feedsAsked(), ["https://feeds.example.test/beta.xml"]);

    // Once per instance: every reader, twice over, after one fresh start.
    fresh();
    for (let i = 0; i < 2; i++) {
      await loadShowIdMap();
      await showSearchQ("Zz Corpus Fixture");
      await showById("990000201");
      await listAnswer("990000201", urls);
      await scopedSearchAnswer("990000202", urls);
    }
    assert.equal(corpusFetches(fetched), 1, "the catalogue is fetched once per process");
    assert.deepEqual(logs, [], "a corpus that loads logs nothing");
  });
});

test("corpus fetch fails, times out or is unusable: the committed rows are used, one log line, never degraded (PKG-33)", async (t) => {
  /* MUTATION: let a failed fetch propagate out of ensureCorpusCatalogue
     (rethrow in its catch) -> the handler throws, red. MUTATION: drop the
     AbortController deadline -> "times out" never settles and the subtest's
     own 20 s timeout fails it. MUTATION: drop the shape check (accept any
     JSON with a `shows` array) -> "a row without a numeric id" / "an empty
     catalogue" serve a corpus without Science Friday, red. MUTATION:
     forget a failure (retry per request) -> fetched and logged twice, red. */
  const failures = {
    "fetch rejects": () => Promise.reject(new TypeError("fetch failed")),
    "times out": (init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
    "HTTP 404": () => new Response("Not Found", { status: 404 }),
    "not gzip": () => new Response(JSON.stringify({ shows: CORPUS_SHOWS }), { status: 200 }),
    "not JSON": () => new Response(gz("{not json"), { status: 200 }),
    "a row without a numeric id": () => new Response(gz({ shows: [...CORPUS_SHOWS, { apple_collection_id: "990000203", title: "Zz String Id" }] }), { status: 200 }),
    "a row without a title": () => new Response(gz({ shows: [...CORPUS_SHOWS, { apple_collection_id: 990000204, title: "" }] }), { status: 200 }),
    "an empty catalogue": () => new Response(gz({ shows: [] }), { status: 200 }),
  };
  for (const [name, answer] of Object.entries(failures)) {
    await t.test(name, { timeout: 20_000 }, async (st) => {
      const pointerPath = writePointer(st);
      await withCorpus(st, { pointerPath, timeoutMs: 50 }, corpusFetch(answer), async ({ urls, fetched, logs }) => {
        const first = await showSearchQ(COMMITTED_BREADTH_TITLE);
        assert.equal(first.degraded, false, "never degraded (never CatalogFilesUnavailableError)");
        assert.ok(first.shows.some((s) => s.show_id === COMMITTED_BREADTH_ID), "the committed breadth row is served");
        assert.equal((await showById("990000201")).show, null, "no corpus row leaked in");
        assert.equal((await showById(COMMITTED_BREADTH_ID)).show?.title, COMMITTED_BREADTH_TITLE);
        assert.equal((await listAnswer(COMMITTED_BREADTH_ID, urls)).status, 200);
        assert.equal(corpusFetches(fetched), 1, "tried once per process, not per request");
        assert.equal(logs.length, 1, `one log line: ${logs.join(" / ")}`);
        assert.match(logs[0], /corpus catalogue/);
      });
    });
  }
});

test("corpus pointer absent: the committed rows, no fetch, no log line (PKG-33)", async (t) => {
  /* The normal path: data/corpus-catalogue-pointer.json is not on main.
     MUTATION: log the ENOENT like any other pointer failure -> a log line,
     red. MUTATION: fetch something when there is no pointer -> a fetch,
     red. MUTATION: treat a missing pointer as an empty catalogue -> the
     committed rows are missing, red. MUTATION: `await` the ensure step
     unconditionally in api/shows/search.ts (an `await null` still yields)
     -> the first answer is no longer written synchronously, red: with no
     pointer the handler behaves exactly as it did before PKG-33. */
  const missing = path.join(os.tmpdir(), `no-corpus-pointer-${process.pid}`, "corpus-catalogue-pointer.json");
  assert.equal(fs.existsSync(missing), false, "premise: the pointer is absent");
  await withCorpus(t, { pointerPath: missing }, async (url) => { throw new Error(`unexpected fetch ${url}`); }, async ({ fetched, logs }) => {
    const sync = mockRes();
    const pending = showSearchHandler({ method: "GET", query: { q: COMMITTED_BREADTH_TITLE }, headers: {} }, sync);
    assert.equal(sync.statusCode, 200, "the first answer is written before the handler's promise is awaited");
    await pending;
    const found = await showSearchQ(COMMITTED_BREADTH_TITLE);
    assert.equal(found.degraded, false);
    assert.ok(found.shows.some((s) => s.show_id === COMMITTED_BREADTH_ID));
    assert.equal((await showById(COMMITTED_BREADTH_ID)).show?.tier, "breadth");
    assert.equal((await showById("990000201")).show, null);
    const idMap = await loadShowIdMap();
    assert.equal(idMap.byCollectionId.get(Number(COMMITTED_BREADTH_ID)), COMMITTED_BREADTH_ID);
    assert.deepEqual(fetched, [], "no fetch at all");
    assert.deepEqual(logs, [], "no log line");
  });
  // The deadline is the brief's 2 s (docs/roadmap/corpus.md PKG-33).
  assert.equal(CORPUS_FETCH_TIMEOUT_MS, 2_000);
});
