/* player/catalogue-directory-driver.js — the catalogue directory's boot,
   refresh and IndexedDB tier (issue #40), against fakes for fetch, the cache
   tier and the clock. The pure decisions it drives are proven in
   player/catalogue-directory.test.js; this file proves the ORDER and the
   refusals between a pointer arriving and a set being held.

   Every test names the one-line mutation that turns it red, and each one was
   run. The fixtures are this suite's own; nothing here reads data/. */

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import {
  createCatalogueDirectory, parseCatalogueSet, serializeCatalogueSet,
  STATUS, SET_KEY, CHECKED_KEY, CATALOGUE_DB_NAME,
} from "./catalogue-directory-driver.js";
import { CATALOGUE_FILE_KEYS, CATALOGUE_TTL_MS, SOURCE } from "./catalogue-directory.js";
import { sha256Hex } from "./foray-directory.js";

const ORIGIN = "https://catalogue.test";
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-10-09T12:00:00.000Z");
const PATHS = {
  discover: "data/discover.json", session: "data/session.json", taxonomy: "data/taxonomy.json",
  itemTags: "data/item-tags.json", semanticIndex: "data/semantic-index.json",
};
const POINTER_URL = `${ORIGIN}/data/catalogue-directory.json`;

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));

/** Five documents, tagged so two generations are told apart. */
function makeDocs(tag) {
  const docs = {};
  for (const k of CATALOGUE_FILE_KEYS) docs[k] = { gen: tag, key: k };
  return docs;
}

/** A pointer describing `docs` exactly: bytes and sha256 both right. */
async function pointerFor(docs, version, built_at) {
  const bytes = {}, sha256 = {};
  for (const k of CATALOGUE_FILE_KEYS) {
    bytes[k] = enc(docs[k]).byteLength;
    sha256[k] = `sha256:${await sha256Hex(enc(docs[k]), webcrypto.subtle)}`;
  }
  return { version, built_at, files: { ...PATHS }, bytes, sha256 };
}

/** Routes for the pointer and its five files on ORIGIN. */
function routesFor(pointer, docs) {
  const r = { [POINTER_URL]: pointer };
  for (const k of CATALOGUE_FILE_KEYS) r[`${ORIGIN}/${PATHS[k]}`] = docs[k];
  return r;
}

/* ---------- fakes ---------- */

function fakeFetch(routes, { failUrl = null } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    if (failUrl && String(url) === failUrl) throw new TypeError("network down");
    const body = routes[String(url)];
    if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = body instanceof Uint8Array ? body : enc(body);
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  fn.calls = calls;
  return fn;
}

/** An idb-tier-shaped Map: `readAll(prefix)` and `write(key, value)`. */
function fakeCache(rows = {}) {
  const map = new Map(Object.entries(rows));
  const writes = [];
  return {
    map, writes,
    async readAll(prefix) {
      const out = new Map();
      for (const [k, v] of map) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async write(key, value) { writes.push(key); map.set(key, value); },
  };
}

function clock(t = T0) {
  const c = { t };
  c.now = () => c.t;
  return c;
}

const A_BUILT = "2026-10-08T03:00:00.000Z";
const B_BUILT = "2026-10-09T03:00:00.000Z";

/** A cache already holding generation A, last checked long ago. */
function cacheHoldingA() {
  return fakeCache({
    [SET_KEY]: serializeCatalogueSet({ version: "genA", built_at: A_BUILT, fetched_at: A_BUILT, docs: makeDocs("A") }),
  });
}

function make({ fetch, cache = null, c = clock(), ...rest } = {}) {
  return createCatalogueDirectory({
    fetch, cache, now: c.now, origin: ORIGIN, subtle: webcrypto.subtle,
    timeouts: { pointerMs: 200, filesMs: 200, cacheWaitMs: 50 }, ...rest,
  });
}

/* ---------- boot ---------- */

test("boot-never-fetches: boot reads the cache and the bundled pointer and makes no request, even with a check due", async () => {
  /* #40: the network is never consulted before paint. The bundled pointer is
     handed in, not fetched. KILLED BY: `void refresh({ reason: "boot" });`
     added to boot() before `return current()` (a "refresh at boot" that sits
     in front of nothing yet still fires a request before paint). */
  const docsB = makeDocs("B");
  const fetch = fakeFetch(routesFor(await pointerFor(docsB, "genB", B_BUILT), docsB));
  const dir = make({ fetch, cache: cacheHoldingA() });
  const got = await dir.boot({ bundledPointer: { version: "seed1", built_at: "2026-10-01T00:00:00Z", files: PATHS, partial: true }, bundledValid: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fetch.calls, [], "boot made no request");
  assert.equal(got.source, SOURCE.CACHE);
  assert.equal(got.version, "genA");
  assert.equal(got.docs.discover.gen, "A");
  assert.equal(CATALOGUE_DB_NAME, "foray-catalogue-directory");
});

test("boot is bounded: a hung cache costs the cache, never the first paint", async () => {
  /* KILLED BY: dropping the `bounded(...)` around readCache() in boot()
     (boot then waits on an IndexedDB read that never answers). */
  const hung = { readAll: () => new Promise(() => {}), write: async () => {} };
  const dir = make({ fetch: fakeFetch({}), cache: hung });
  const raced = await Promise.race([
    dir.boot({ bundledPointer: { version: "seed1", built_at: A_BUILT, files: PATHS }, bundledValid: true }),
    new Promise((r) => setTimeout(() => r("hung"), 1000)),
  ]);
  assert.notEqual(raced, "hung");
  assert.equal(raced.source, SOURCE.BUNDLE);
  assert.equal(raced.version, "seed1");
});

/* ---------- refresh ---------- */

test("complete set adopted: a verified five-file set becomes current, is cached as one row, and the next launch boots from it", async () => {
  /* KILLED BY: deleting the `cache.write(SET_KEY, serializeCatalogueSet(set))`
     line (the set is held for this run only; the next launch paints the
     bundle again). */
  const docsB = makeDocs("B");
  const routes = routesFor(await pointerFor(docsB, "genB", B_BUILT), docsB);
  const cache = fakeCache();
  const c = clock();
  const dir = make({ fetch: fakeFetch(routes), cache, c });
  const seed = { version: "seed1", built_at: A_BUILT, files: PATHS, partial: true };
  assert.equal((await dir.boot({ bundledPointer: seed, bundledValid: true })).source, SOURCE.BUNDLE);

  const out = await dir.refresh({ reason: "boot" });
  assert.equal(out.status, STATUS.ADOPTED);
  assert.equal(out.code, null, "every file was verified");
  const now = dir.current();
  assert.equal(now.source, SOURCE.CACHE);
  assert.equal(now.version, "genB");
  assert.deepEqual(now.docs, docsB);
  assert.deepEqual(cache.writes.filter((k) => k === SET_KEY), [SET_KEY], "one row, written once");

  const relaunch = make({ fetch: fakeFetch({}), cache, c });
  const booted = await relaunch.boot({ bundledPointer: seed, bundledValid: true });
  assert.equal(booted.source, SOURCE.CACHE);
  assert.equal(booted.version, "genB");
  assert.deepEqual(booted.docs, docsB);
});

test("TTL gate: a second launch within six hours of an answered check makes no network call; past it, it asks", async () => {
  /* #40's acceptance line. KILLED BY: deleting the
     `if (!refreshDue({ checkedAt, now: now(), ttlMs })) return ...` line in
     run(), or deleting the `cache.write(CHECKED_KEY, checkedAt)` in
     recordChecked() (the answer is forgotten across launches). */
  const docsB = makeDocs("B");
  const routes = routesFor(await pointerFor(docsB, "genB", B_BUILT), docsB);
  const cache = fakeCache();
  const c = clock();
  const first = make({ fetch: fakeFetch(routes), cache, c });
  await first.boot({ bundledValid: true });
  assert.equal((await first.refresh()).status, STATUS.ADOPTED);

  c.t += 2 * HOUR;
  const fetch2 = fakeFetch(routes);
  const second = make({ fetch: fetch2, cache, c });
  await second.boot({ bundledValid: true });
  assert.equal((await second.refresh()).status, STATUS.WITHIN_TTL);
  assert.deepEqual(fetch2.calls, [], "no request inside the window");

  c.t += CATALOGUE_TTL_MS;
  const out = await second.refresh();
  assert.equal(out.status, STATUS.CURRENT, "past the window the pointer is asked, and the held set is current");
  assert.deepEqual(fetch2.calls, [POINTER_URL], "the pointer only: a current set fetches no files");
});

test("older refused: a pointer whose built_at is behind the held set's never walks the phone backwards", async () => {
  /* KILLED BY: deleting the `if (decision === DECISION.OLDER) { ... }` branch
     in run() (the older set is fetched, verifies, and is adopted). */
  const docsOld = makeDocs("old");
  const fetch = fakeFetch(routesFor(await pointerFor(docsOld, "genOld", "2026-10-01T03:00:00.000Z"), docsOld));
  const cache = cacheHoldingA();
  const dir = make({ fetch, cache });
  await dir.boot({ bundledValid: true });
  const out = await dir.refresh();
  assert.equal(out.status, STATUS.OLDER);
  assert.deepEqual(fetch.calls, [POINTER_URL], "no file was fetched");
  assert.equal(dir.current().version, "genA");
  assert.ok(!cache.writes.includes(SET_KEY));
});

test("torn set refused: one file from another deploy (wrong byte count) refuses the whole set", async () => {
  /* KILLED BY: deleting `if (!check.ok) return { status: STATUS.TORN, ... }`
     in run() (four files of B and one of C are adopted as B). */
  const docsB = makeDocs("B");
  const routes = routesFor(await pointerFor(docsB, "genB", B_BUILT), docsB);
  routes[`${ORIGIN}/${PATHS.session}`] = { gen: "C-from-the-next-deploy", key: "session" };
  const cache = cacheHoldingA();
  const dir = make({ fetch: fakeFetch(routes), cache });
  await dir.boot({ bundledValid: true });
  const out = await dir.refresh();
  assert.equal(out.status, STATUS.TORN);
  assert.equal(out.code, "bytes-session");
  assert.equal(dir.current().version, "genA");
  assert.equal(dir.current().docs.session.gen, "A");
  assert.deepEqual(cache.writes, [], "nothing cached, and a torn answer is not an answered check");
});

test("sha mismatch refused: same byte count, different content, is torn", async () => {
  /* KILLED BY: passing `sha256: null` to checkFetchedFile in run() (the
     digest is never compared, so a same-size file from another deploy is
     adopted, reported only as sha256-unverified). */
  const docsB = makeDocs("B");
  const routes = routesFor(await pointerFor(docsB, "genB", B_BUILT), docsB);
  routes[`${ORIGIN}/${PATHS.taxonomy}`] = { gen: "C", key: "taxonomy" }; // "C" and "B": same length
  assert.equal(enc(routes[`${ORIGIN}/${PATHS.taxonomy}`]).byteLength, enc(docsB.taxonomy).byteLength, "premise: same size");
  const cache = cacheHoldingA();
  const dir = make({ fetch: fakeFetch(routes), cache });
  await dir.boot({ bundledValid: true });
  const out = await dir.refresh();
  assert.equal(out.status, STATUS.TORN);
  assert.equal(out.code, "sha256-taxonomy");
  assert.equal(dir.current().version, "genA");
  assert.ok(!cache.writes.includes(SET_KEY));
});

test("network error keeps held set: a file that does not arrive leaves the held set and the cache, and is not an answered check", async () => {
  /* KILLED BY: `cached = null;` added just before the five files are fetched
     (the held set is dropped for a network error), or `await recordChecked();`
     moved to the top of run() (an unanswered attempt silences six hours). */
  const docsB = makeDocs("B");
  const routes = routesFor(await pointerFor(docsB, "genB", B_BUILT), docsB);
  const cache = cacheHoldingA();
  const before = cache.map.get(SET_KEY);
  const fetch = fakeFetch(routes, { failUrl: `${ORIGIN}/${PATHS.semanticIndex}` });
  const dir = make({ fetch, cache });
  await dir.boot({ bundledValid: true });
  const out = await dir.refresh();
  assert.equal(out.status, STATUS.OFFLINE);
  assert.equal(out.code, "network-semanticIndex");
  assert.equal(dir.current().source, SOURCE.CACHE);
  assert.equal(dir.current().version, "genA");
  assert.equal(cache.map.get(SET_KEY), before, "the cached row is untouched");
  assert.ok(!cache.map.has(CHECKED_KEY), "no check was recorded");

  const again = await dir.refresh();
  assert.notEqual(again.status, STATUS.WITHIN_TTL, "the next refresh still asks");
});

test("cellular policy (unruled input): a policy that says no defers the files, records nothing, and is asked with the set's size", async () => {
  /* KILLED BY: deleting `if (!allowed) return { status: STATUS.DEFERRED, ... }`
     in run() (the policy is asked and then ignored). */
  const docsB = makeDocs("B");
  const ptr = await pointerFor(docsB, "genB", B_BUILT);
  const fetch = fakeFetch(routesFor(ptr, docsB));
  const asked = [];
  const cache = cacheHoldingA();
  const dir = make({ fetch, cache, cellularPolicy: (ctx) => { asked.push(ctx.bytes); return false; } });
  await dir.boot({ bundledValid: true });
  const out = await dir.refresh();
  assert.equal(out.status, STATUS.DEFERRED);
  assert.deepEqual(fetch.calls, [POINTER_URL]);
  assert.deepEqual(asked, [Object.values(ptr.bytes).reduce((a, b) => a + b, 0)]);
  assert.equal(dir.current().version, "genA");
  assert.deepEqual(cache.writes, []);
});

test("a cache row missing any of the five documents is not a set", () => {
  /* KILLED BY: deleting the per-key loop in parseCatalogueSet (a row with
     four documents boots as the cache and the fifth reads undefined). */
  const docs = makeDocs("A");
  const whole = serializeCatalogueSet({ version: "genA", built_at: A_BUILT, docs });
  assert.equal(parseCatalogueSet(whole).version, "genA");
  const { itemTags, ...four } = docs;
  assert.equal(parseCatalogueSet(serializeCatalogueSet({ version: "genA", built_at: A_BUILT, docs: four })), null);
  assert.equal(parseCatalogueSet("{not json"), null);
});
