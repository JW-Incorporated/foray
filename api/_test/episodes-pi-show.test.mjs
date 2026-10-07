// api/shows/[show_id]/episodes.ts for a `pi:<n>` (shard-index) show
// (pi-episodes-cold-open, #690; follows SH-COLD #1141). The show is in
// neither catalogue file: the caller names its shard with `?k=<key>`, the
// endpoint reads that ONE shard of the published release (the same reader
// the shard proxy uses, api/_lib/showsIndexRelease.ts) and serves the row's
// feed in the catalogue response shape. Every test names the mutation it
// kills; each was run against the source and turned this suite red.
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as zlib from "node:zlib";
import * as episodesModule from "../shows/[show_id]/episodes.ts";
import { sharedFeedReader } from "../_lib/feedCache.ts";
import { _setPointerPathForTests, isShardKey } from "../_lib/showsIndexRelease.ts";

const handler = typeof episodesModule.default === "function" ? episodesModule.default : episodesModule.default.default;
const { LIST_RESPONSE_KEYS, PI_SHOW_CACHE_MAX, _resetPiShowCacheForTests, _piShowCacheSizeForTests } = episodesModule;

const SHARDS_A = "https://github.com/JW-Incorporated/foray/releases/download/shows-index-x-shards-1";
const SHARDS_B = "https://github.com/JW-Incorporated/foray/releases/download/shows-index-x-shards-2";
const POINTER = {
  asset_base_url: "https://github.com/JW-Incorporated/foray/releases/download/shows-index-x",
  release_tag: "shows-index-x",
  shards_published: true,
  shard_releases: [
    { tag: "shows-index-x-shards-1", asset_base_url: SHARDS_A, first_key: "00", last_key: "p4", count: 900 },
    { tag: "shows-index-x-shards-2", asset_base_url: SHARDS_B, first_key: "p5", last_key: "zz", count: 397 },
  ],
};

const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Tiny Show</title>
  <description>A small show from the shard index.</description>
  <item><title>Tiny One</title><guid>t-1</guid>
    <enclosure url="https://cdn.example.com/t1.mp3" type="audio/mpeg" length="1"/>
    <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;

const row = (id, u = `https://feeds.example.com/${id}.xml`) =>
  ({ id, t: "Tiny Show", a: "Tiny Author", i: null, u, img: "https://art.example.com/t.jpg", n: 1, c: false });

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

/** A release on disk (the pointer) and on the "network" (fetch): `shards`
    maps a shard key to its rows; every other URL is a feed and answers FEED,
    or `feedStatus`. Every request is recorded. */
async function withRelease(opts, run) {
  const { pointer = POINTER, shards = {}, feedStatus = 200 } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-episodes-"));
  const file = path.join(dir, "shows-index-pointer.json");
  if (pointer) fs.writeFileSync(file, JSON.stringify(pointer));
  _setPointerPathForTests(pointer ? file : path.join(dir, "missing.json"));
  _resetPiShowCacheForTests();
  sharedFeedReader.clear();
  const calls = [];
  const original = globalThis.fetch;
  const hadDb = "DATABASE_URL" in process.env;
  const db = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const m = /\/([a-z0-9_]{2})\.json\.gz$/.exec(u);
    if (m) {
      if (opts.shardStatus && opts.shardStatus !== 200) return new Response("", { status: opts.shardStatus });
      return new Response(zlib.gzipSync(JSON.stringify(shards[m[1]] || [])), { status: 200 });
    }
    return new Response(feedStatus === 200 ? FEED : "", { status: feedStatus, headers: { "content-type": "application/rss+xml" } });
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
    if (hadDb) process.env.DATABASE_URL = db;
    _setPointerPathForTests();
    _resetPiShowCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function get(query) {
  const res = mockRes();
  await handler({ method: "GET", query, headers: {} }, res);
  return res;
}

test("a pi: show named with its shard key is served from that shard's row: catalogue shape, the row's title and art, its feed's episodes", async () => {
  /* MUTATION: drop the `if (!meta && showId.startsWith("pi:"))` branch from
     the handler -> 404 "unknown show_id", the pre-change answer; red.
     MUTATION 2: read the shard from pointer.asset_base_url instead of the
     key's shard release (fetchIndexAsset's resolveShardRelease) -> the shard
     URL is wrong; red. */
  await withRelease({ shards: { ti: [row(41), row(42)] } }, async (calls) => {
    const res = await get({ show_id: "pi:42", k: "ti" });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(Object.keys(res.body).sort(), [...LIST_RESPONSE_KEYS].sort(), "one endpoint, one shape");
    assert.strictEqual(res.body.show_id, "pi:42");
    assert.strictEqual(res.body.show.title, "Tiny Show");
    assert.strictEqual(res.body.show.image, "https://art.example.com/t.jpg");
    assert.strictEqual(res.body.show.description, "A small show from the shard index.");
    assert.strictEqual(res.body.episodes.length, 1);
    assert.strictEqual(res.body.episodes[0].guid, "t-1");
    assert.strictEqual(res.body.episodes[0].show_id, "pi:42");
    assert.deepStrictEqual(calls, [`${SHARDS_B}/ti.json.gz`, "https://feeds.example.com/42.xml"]);
  });
});

test("the pages of one show read its shard once (resolved rows are kept per id AND key)", async () => {
  /* MUTATION: drop `piShowMeta.set(cacheKey, meta)` -> every page re-reads
     the shard (two shard requests); red. */
  await withRelease({ shards: { ti: [row(42)] } }, async (calls) => {
    assert.strictEqual((await get({ show_id: "pi:42", k: "ti" })).statusCode, 200);
    assert.strictEqual((await get({ show_id: "pi:42", k: "ti", cursor: "bogus" })).statusCode, 200);
    assert.strictEqual(calls.filter((u) => u.endsWith(".json.gz")).length, 1);
  });
});

test("a kept row answers only the key it was found under: the answer never depends on an earlier request", async () => {
  /* MUTATION: key the kept rows by `showId` alone -> `pi:42` with the wrong
     shard key answers 200 from the cache; red. */
  await withRelease({ shards: { ti: [row(42)], sh: [row(7)] } }, async () => {
    assert.strictEqual((await get({ show_id: "pi:42", k: "ti" })).statusCode, 200);
    const wrong = await get({ show_id: "pi:42", k: "sh" });
    assert.strictEqual(wrong.statusCode, 404);
    assert.deepStrictEqual(wrong.body, { error: "unknown show_id" });
  });
});

test("no key, a malformed key or a malformed pi: id is the catalogue's 404, no-store, with no request at all", async () => {
  /* MUTATION: drop the `!id ||` (PI_SHOW_RE) check -> `pi:abc` reads the
     shard; red. MUTATION 2: drop `!isShardKey(key) ||` -> still no request
     (fetchIndexAsset's allowlist refuses the path), so this test alone cannot
     see it; the isShardKey unit test below does. */
  await withRelease({ shards: { ti: [row(42)] } }, async (calls) => {
    for (const query of [
      { show_id: "pi:42" },
      { show_id: "pi:42", k: "" },
      { show_id: "pi:42", k: "TI" },
      { show_id: "pi:42", k: "tin" },
      { show_id: "pi:42", k: "../x" },
      { show_id: "pi:abc", k: "ti" },
      { show_id: "pi:", k: "ti" },
      { show_id: "pi:42x", k: "ti" },
    ]) {
      const res = await get(query);
      assert.strictEqual(res.statusCode, 404, JSON.stringify(query));
      assert.deepStrictEqual(res.body, { error: "unknown show_id" }, JSON.stringify(query));
      assert.strictEqual(res.headers["Cache-Control"], "no-store", JSON.stringify(query));
    }
    assert.deepStrictEqual(calls, []);
  });
});

test("isShardKey accepts exactly the keys the release files shards under", () => {
  /* MUTATION: `return typeof key === "string"` -> "TI", "tin", "../" pass; red. */
  for (const k of ["ti", "a_", "__", "0z"]) assert.strictEqual(isShardKey(k), true, k);
  for (const k of ["", "TI", "tin", "t", "../", "t/", null, undefined, 42]) assert.strictEqual(isShardKey(k), false, String(k));
});

test("a shard without the row, or whose row has no http(s) feed, is a 404 and no feed is fetched", async () => {
  /* MUTATION: drop the `/^https?:\/\//i` check -> the `ftp:` feed is
     fetched; red. MUTATION 2: `String(r.id) === id` -> `r.id === id` (number
     vs string) -> the real row is never found; the first test goes red. */
  await withRelease({ shards: { ti: [row(41), row(43, "ftp://feeds.example.com/43.xml"), { id: 44, t: "No feed" }] } }, async (calls) => {
    for (const id of ["pi:42", "pi:43", "pi:44"]) {
      const res = await get({ show_id: id, k: "ti" });
      assert.strictEqual(res.statusCode, 404, id);
      assert.deepStrictEqual(res.body, { error: "unknown show_id" }, id);
      assert.strictEqual(res.headers["Cache-Control"], "no-store", id);
    }
    assert.ok(calls.every((u) => u.endsWith(".json.gz")), `only shards were read: ${calls.join(", ")}`);
  });
});

test("a release that could not be read is a 502 (Try again), not \"unknown show_id\"; nothing published is a 404", async () => {
  /* MUTATION: answer every fetchIndexAsset failure with the 404 -> the
     upstream 500 reads as "not found"; red. MUTATION 2: drop the no-store on
     the failure -> a transient failure is pinned at the edge; red. */
  await withRelease({ shards: { ti: [row(42)] }, shardStatus: 500 }, async () => {
    const res = await get({ show_id: "pi:42", k: "ti" });
    assert.strictEqual(res.statusCode, 502);
    assert.match(res.body.error, /^shows index unavailable: upstream responded 500/);
    assert.strictEqual(res.headers["Cache-Control"], "no-store");
  });
  await withRelease({ pointer: null }, async (calls) => {
    const res = await get({ show_id: "pi:42", k: "ti" });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: "unknown show_id" });
    assert.deepStrictEqual(calls, []);
  });
});

test("a failed read is not kept: the next request reads the shard again and resolves", async () => {
  /* MUTATION: remember a failed lookup per id+key (a negative entry in
     piShowMeta, answered before fetchIndexAsset) -> the recovered release is
     never asked again; red. */
  const opts = { shards: { ti: [row(42)] }, shardStatus: 500 };
  await withRelease(opts, async (calls) => {
    assert.strictEqual((await get({ show_id: "pi:42", k: "ti" })).statusCode, 502);
    assert.strictEqual(_piShowCacheSizeForTests(), 0);
    opts.shardStatus = 200;
    assert.strictEqual((await get({ show_id: "pi:42", k: "ti" })).statusCode, 200);
    assert.strictEqual(calls.filter((u) => u.endsWith(".json.gz")).length, 2);
  });
});

test("the resolved rows a warm instance keeps are bounded", async () => {
  /* MUTATION: drop the eviction line before `piShowMeta.set` -> the instance
     keeps PI_SHOW_CACHE_MAX + 5 rows; red. */
  const ids = Array.from({ length: PI_SHOW_CACHE_MAX + 5 }, (_, i) => i + 1);
  await withRelease({ shards: { ti: ids.map((id) => row(id)) }, feedStatus: 503 }, async () => {
    for (const id of ids) await get({ show_id: `pi:${id}`, k: "ti" });
    assert.strictEqual(_piShowCacheSizeForTests(), PI_SHOW_CACHE_MAX);
  });
});

test("a catalogue show is untouched by the pi: path: no shard is read for it", async () => {
  /* MUTATION: route every id through resolvePiShow -> a catalogue show
     without a key 404s; red. */
  await withRelease({ shards: { ti: [row(42)] } }, async (calls) => {
    const res = await get({ show_id: "lex-fridman-podcast" });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(calls.every((u) => !u.endsWith(".json.gz")));
  });
});
