/* THE SHARD CACHE'S STORED SHAPE, AND WHAT A STORED ENTRY COSTS
 * (code-health CH-36, A2-16; docs/roadmap/code-health.md §0.3 item 3).
 *
 * S-05's shard pass keeps its rows in two tiers: a session Map, and a Cache
 * Storage bucket (`SHARD_CACHE_NAME`, "foray-shows-index-v1") that survives a
 * reload. S-04c changed what an entry holds from bare `rows[]` to
 * `{ version, rows }` so a newer shows-index release can invalidate an older
 * entry. These tests drive the real `fetchShardRows` / `readShardFromCache-
 * Storage` / `writeShardToCacheStorage` against a Cache Storage fake that
 * stores the JSON text a real `cache.put(new Response(...))` would, and a
 * fetch fake that counts every shard request — the network cost is the thing
 * a cache decision changes, so it is asserted on the raw request log, never
 * inferred from the rows that came back.
 *
 * WHY THE NAME IS PINNED: sw.js refuses to delete caches it does not own and
 * names `foray-shows-index-v1` as its example, and Delete my data deletes only
 * the current name, so a bump would orphan every device's v1 bucket forever.
 *
 * Own suite because no other one constructs a Cache Storage: show-search-shard
 * tests the pure shard functions, offline-search the skip-when-offline rule,
 * data-deletion only that the bucket is deleted.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");

const ROWS_OLD = [{ id: 1, t: "Old Row", a: "A", c: 0 }];
const ROWS_NEW = [{ id: 2, t: "Fresh Row", a: "B", c: 1 }];
const RELEASE = "rel-2026-10-01";

/** app.js alone (the shard pass reads nothing from search-engine.js), with a
    Cache Storage fake keyed by cache name and a fetch fake for the shard
    proxy. `buckets` is the persistent store a reload would find. */
function loadApp({ buckets = new Map() } = {}) {
  const noop = () => {};
  function makeEl() {
    return {
      addEventListener: noop, removeEventListener: noop, appendChild: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => makeEl(), querySelectorAll: () => [],
    };
  }
  const opened = [];
  const caches = {
    async open(name) {
      opened.push(name);
      if (!buckets.has(name)) buckets.set(name, new Map());
      const bucket = buckets.get(name);
      return {
        async match(key) {
          if (!bucket.has(key)) return undefined;
          const text = bucket.get(key);
          return { json: async () => JSON.parse(text) };
        },
        async put(key, res) { bucket.set(key, await res.text()); },
      };
    },
    async delete(name) { return buckets.delete(name); },
  };
  const shardRequests = [];
  const fetchImpl = (url) => {
    const u = String(url);
    if (u.includes("api/shows/index/shards/")) {
      shardRequests.push(u);
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: (k) => (k === "X-Shows-Index-Version" ? RELEASE : null) },
        json: () => Promise.resolve(ROWS_NEW),
      });
    }
    return new Promise(() => {});
  };
  const store = new Map();
  const ctx = {
    console: { ...console, warn: noop, error: noop },
    fetch: fetchImpl,
    caches,
    Response,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: makeEl(), documentElement: makeEl(),
      addEventListener: noop, createElement: makeEl,
      querySelector: () => makeEl(), querySelectorAll: () => [],
    },
    navigator: { userAgent: "node", onLine: true },
    location: { hash: "#/", href: "https://example.test/" },
    history: { replaceState: noop, pushState: noop },
    CSS: { escape: (s) => String(s) },
    URL, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.ForayPlayer = { forayResumeList: () => [], lastEpisodeCard: () => null };
  vm.createContext(ctx);
  process.on("unhandledRejection", noop);
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (code) => vm.runInContext(code, ctx);
  const v1 = () => buckets.get("foray-shows-index-v1");
  return { ctx, evalIn, buckets, opened, shardRequests, v1 };
}

/** A bucket map holding one entry under the v1 name, as a previous build left it. */
function bucketsWith(shardKey, value) {
  return new Map([["foray-shows-index-v1", new Map([[`shards/${shardKey}.json`, JSON.stringify(value)]])]]);
}

/** The stored entry, parsed (the fake keeps the JSON text a real put stores). */
function stored(m, shardKey) {
  const text = m.v1().get(`shards/${shardKey}.json`);
  return text === undefined ? undefined : JSON.parse(text);
}

const plain = (x) => JSON.parse(JSON.stringify(x)); // a vm-realm value has a foreign prototype

test("the bucket keeps its v1 name: a bump would orphan every device's old bucket", async () => {
  /* MUTATION: SHARD_CACHE_NAME = "foray-shows-index-v2" -> red (both the
     constant and the name the pass actually opens). */
  const m = loadApp();
  assert.strictEqual(m.evalIn("SHARD_CACHE_NAME"), "foray-shows-index-v1");
  await m.evalIn('fetchShardRows("ab")');
  assert.deepStrictEqual([...new Set(m.opened)], ["foray-shows-index-v1"]);
});

test("a versioned entry is trusted on a fresh page: rows come from Cache Storage and the network is not asked", async () => {
  /* The tier's whole point: a reload answers from what the device holds.
     MUTATION: make readShardFromCacheStorage return null for the `{ version,
     rows }` shape (drop its `Array.isArray(parsed.rows)` branch) -> one shard
     request, red. */
  const m = loadApp({ buckets: bucketsWith("ab", { version: "rel-old", rows: ROWS_OLD }) });
  const rows = await m.evalIn('fetchShardRows("ab")');
  assert.deepStrictEqual(plain(rows), ROWS_OLD);
  assert.strictEqual(m.shardRequests.length, 0, "a Cache Storage hit costs no request");
});

test("a fetched shard is written back as { version, rows } under the v1 name", async () => {
  /* MUTATION: write bare `rows` in writeShardToCacheStorage (the pre-S-04c
     shape) -> red. */
  const m = loadApp();
  const rows = await m.evalIn('fetchShardRows("cd")');
  assert.deepStrictEqual(plain(rows), ROWS_NEW);
  assert.strictEqual(m.shardRequests.length, 1);
  await new Promise((r) => setImmediate(r)); // the write is fire-and-forget
  assert.deepStrictEqual(stored(m, "cd"), { version: RELEASE, rows: ROWS_NEW });
});

test("a pre-S-04c bare-array entry, once this session has seen a release: refetched once and rewritten, then served from memory", async () => {
  /* The same outcome before and after CH-36 deleted the bare-array branch:
     today's `{ version: null }` never matches a real tag, and after the
     deletion the entry is no hit at all. Either way one request, one rewrite.
     MUTATION: trust any Cache Storage hit regardless of version (drop the
     `cached.version === lastSeenShardVersion` clause) -> no request, red. */
  const m = loadApp({ buckets: bucketsWith("ef", ROWS_OLD) });
  await m.evalIn('fetchShardRows("zz")'); // a network answer this session: lastSeenShardVersion is set
  assert.strictEqual(m.evalIn("lastSeenShardVersion"), RELEASE);
  const before = m.shardRequests.length;
  const rows = await m.evalIn('fetchShardRows("ef")');
  assert.deepStrictEqual(plain(rows), ROWS_NEW, "the stale rows are not served");
  assert.strictEqual(m.shardRequests.length - before, 1, "exactly one request");
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(stored(m, "ef"), { version: RELEASE, rows: ROWS_NEW }, "rewritten in the versioned shape");
  await m.evalIn('fetchShardRows("ef")');
  assert.strictEqual(m.shardRequests.length - before, 1, "and the session map answers the next keystroke");
});

test("a pre-S-04c bare-array entry on a fresh page (TODAY): served as an unversioned hit, no request", async () => {
  /* CHARACTERIZATION of the branch CH-36 deletes. `Array.isArray(parsed)`
     reads a bare entry back as `{ version: null, rows }`, and on a fresh page
     (`lastSeenShardVersion === null`) an unversioned hit is trusted. */
  const m = loadApp({ buckets: bucketsWith("gh", ROWS_OLD) });
  assert.deepStrictEqual(plain(await m.evalIn('readShardFromCacheStorage("gh")')), { version: null, rows: ROWS_OLD });
  const rows = await m.evalIn('fetchShardRows("gh")');
  assert.deepStrictEqual(plain(rows), ROWS_OLD);
  assert.strictEqual(m.shardRequests.length, 0);
});

test("an entry of neither shape is a miss: one request, then the versioned shape", async () => {
  /* MUTATION: return `{ version: null, rows: [] }` instead of null for an
     unrecognised entry -> it is served (empty) with no request, red. */
  const m = loadApp({ buckets: bucketsWith("ij", { something: "else" }) });
  assert.strictEqual(await m.evalIn('readShardFromCacheStorage("ij")'), null);
  const rows = await m.evalIn('fetchShardRows("ij")');
  assert.deepStrictEqual(plain(rows), ROWS_NEW);
  assert.strictEqual(m.shardRequests.length, 1);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(stored(m, "ij"), { version: RELEASE, rows: ROWS_NEW });
});
