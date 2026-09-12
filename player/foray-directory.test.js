/* player/foray-directory.js — the mechanism, away from any DOM (FD-03).

   `test/foray-directory.test.js` mounts the real app.js over this module and
   proves the ORDER (paint before network, swap before render). This file proves
   the module's own three rules against fakes for fetch, the cache tier and the
   clock, and every failure path between a pointer arriving and a set being held.

   Every test names the one-line mutation that turns it red, and each one was run.
   The fixtures are this suite's own; nothing here reads data/forays.json. */

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import {
  createForayDirectory, validatePointer, isOlderThan, resolveFileUrl, sha256Hex,
  parseCachedSet, serializeSet, POINTER_PATH, CACHE_KEY, FILE_KEYS, STATUS,
  SOURCE_BUNDLE, SOURCE_CACHE, SOURCE_NETWORK, DIRECTORY_DB_NAME,
} from "./foray-directory.js";
import { validateForayDocuments } from "./foray-resolve.js";

/* ---------- fixtures: a set of three documents that resolves ---------- */

const ORIGIN = "https://directory.test";

const seg = (id, item_id, extra = {}) => ({
  id, item_id, start_sec: 100, end_sec: 200, reference_duration_sec: 3600, why: "w", ...extra,
});
const src = (id, url) => ({ id, show: "A Show", title: "Ep", audio_url: url, duration_sec: 3600, dai_suspected: false });
const item = (segment_id) => ({ type: "segment", slot: "one", label: "L", role: "explanation", segment_id });
const foray = (id, segIds, extra = {}) => ({
  id, kind: "deep-dive", title: `Foray ${id}`, status: "published",
  slots: [{ id: "one", title: "One" }], items: segIds.map(item), ...extra,
});

/** A whole valid set. `n` Forays, each with two segments over two episodes. */
function makeSet(n = 1, { prefix = "f", host = "cdn.test" } = {}) {
  const forays = [], segments = [], sources = [];
  for (let i = 1; i <= n; i++) {
    const a = `${prefix}${i}-s1`, b = `${prefix}${i}-s2`;
    const ea = `${prefix}${i}-ep-a`, eb = `${prefix}${i}-ep-b`;
    forays.push(foray(`${prefix}${i}`, [a, b]));
    segments.push(seg(a, ea), seg(b, eb));
    sources.push(src(ea, `https://${host}/${ea}.mp3`), src(eb, `https://${host}/${eb}.mp3`));
  }
  return {
    forays: { version: 1, forays },
    segments: { version: 1, segments },
    sources: { version: 1, sources },
  };
}

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));

async function hashOf(obj) {
  return sha256Hex(enc(obj), webcrypto.subtle);
}

/** A pointer that describes `set` exactly — bytes and sha256 both right. */
async function pointerFor(set, version, built_at = "2026-09-10T10:00:00Z") {
  const bytes = {}, sha256 = {};
  for (const k of FILE_KEYS) {
    bytes[k] = enc(set[k]).byteLength;
    sha256[k] = `sha256:${await hashOf(set[k])}`;
  }
  return {
    version, built_at,
    files: { forays: "data/forays.json", segments: "data/segments.json", sources: "data/segment-sources.json" },
    bytes, sha256,
  };
}

/* ---------- fakes ---------- */

/** A `fetch` over a map of URL -> body (object or raw bytes), with knobs. */
function fakeFetch(routes, { reject = false, never = false, status = 200 } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    if (never) return new Promise(() => {});
    if (reject) throw new TypeError("network down");
    const body = routes[String(url)];
    if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = body instanceof Uint8Array ? body : enc(body);
    return { ok: status < 400, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  fn.calls = calls;
  /** Only what went to the ORIGIN. `boot()` also reads the bundled pointer by a
      relative path, and that read is not a network request. */
  fn.remote = () => calls.filter((u) => /^https?:/.test(u));
  return fn;
}

/** The `DurableTier` shape `idb-tier.js` gives the directory. */
function fakeTier({ failReads = false, failWrites = false, hang = false } = {}) {
  const rows = new Map();
  return {
    rows, writes: 0, removes: 0,
    async readAll() {
      if (hang) return new Promise(() => {});
      if (failReads) throw new Error("idb read failed");
      return new Map(rows);
    },
    async write(k, v) {
      if (failWrites) throw new Error("idb write failed");
      this.writes += 1; rows.set(k, v);
    },
    async remove(k) { this.removes += 1; rows.delete(k); },
  };
}

function remote(pointer, set) {
  const r = {};
  r[`${ORIGIN}/${POINTER_PATH}`] = pointer;
  r[`${ORIGIN}/data/forays.json`] = set.forays;
  r[`${ORIGIN}/data/segments.json`] = set.segments;
  r[`${ORIGIN}/data/segment-sources.json`] = set.sources;
  return r;
}

function make(opts = {}) {
  const events = [];
  const d = createForayDirectory({
    subtle: webcrypto.subtle,
    onEvent: (e) => events.push(e),
    cacheWaitMs: 50, pointerTimeoutMs: 50, filesTimeoutMs: 50, minRefreshIntervalMs: 0,
    ...opts,
  });
  return { d, events };
}

/* ==================================================================== */
/* the pointer                                                          */
/* ==================================================================== */

test("a pointer needs a version and three file paths; bytes and sha256 are optional per file", () => {
  /* MUTATION: drop the `no-file-${k}` loop. A pointer naming two files passes and
     the refresh fetches `undefined`. Red. */
  assert.equal(validatePointer(null).ok, false);
  assert.equal(validatePointer({ files: {} }).code, "bad-version");
  assert.equal(validatePointer({ version: "has space", files: {} }).code, "bad-version");
  assert.equal(validatePointer({ version: "abc" }).code, "no-files");
  assert.equal(validatePointer({ version: "abc", files: { forays: "a", segments: "b" } }).code, "no-file-sources");
  const v = validatePointer({
    version: "9fc92a61a8896278", built_at: "2026-09-10T09:00:00Z",
    files: { forays: "data/forays.json", segments: "data/segments.json", sources: "data/segment-sources.json" },
    bytes: { forays: 10, segments: "x" },
    sha256: { forays: "SHA256:" + "a".repeat(64), segments: "not-hex" },
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.pointer.bytes, { forays: 10, segments: null, sources: null });
  assert.deepEqual(v.pointer.sha256, { forays: "a".repeat(64), segments: null, sources: null });
  assert.equal(v.pointer.built_at, "2026-09-10T09:00:00Z");
  /* An unparseable clock is null, never a string a comparison would coerce. */
  assert.equal(validatePointer({ version: "a", built_at: "yesterday", files: v.pointer.files }).pointer.built_at, null);
  /* `partial` (F-92) is carried through strictly: absent or anything but `true` is
     a whole set. Only the bundled pointer ever says it. */
  assert.equal(v.pointer.partial, false);
  assert.equal(validatePointer({ version: "a", files: v.pointer.files, partial: true }).pointer.partial, true);
  assert.equal(validatePointer({ version: "a", files: v.pointer.files, partial: "true" }).pointer.partial, false);
});

test("older-than needs a clock on BOTH sides; an unknown side is not older", () => {
  /* MUTATION: return `!Number.isFinite(c) || c < h`. A seed with no bundled
     pointer would then block every update forever. Red on the third line. */
  assert.equal(isOlderThan("2026-09-09T00:00:00Z", "2026-09-10T00:00:00Z"), true);
  assert.equal(isOlderThan("2026-09-10T00:00:00Z", "2026-09-10T00:00:00Z"), false);
  assert.equal(isOlderThan(null, "2026-09-10T00:00:00Z"), false);
  assert.equal(isOlderThan("2026-09-10T00:00:00Z", null), false);
});

test("a file path resolves on the directory's origin and never off it", () => {
  /* MUTATION: return `u.href` without the origin comparison. A pointer could send
     the shell to fetch a third party's file. Red. */
  assert.equal(resolveFileUrl(ORIGIN, "data/forays.json"), `${ORIGIN}/data/forays.json`);
  assert.equal(resolveFileUrl(`${ORIGIN}/`, "/data/forays.json"), `${ORIGIN}/data/forays.json`);
  assert.equal(resolveFileUrl(ORIGIN, "https://evil.test/forays.json"), null);
  assert.equal(resolveFileUrl(ORIGIN, "//evil.test/forays.json"), null);
  assert.equal(resolveFileUrl("not a url", "data/forays.json"), null);
});

test("the cache row round-trips, and a row missing a document is absent rather than repaired", () => {
  /* MUTATION: drop the `for (const k of FILE_KEYS)` check in parseCachedSet. A
     truncated row would boot the app with `segments: undefined`. Red. */
  const set = { ...makeSet(1), version: "v1", built_at: "2026-09-10T00:00:00Z", fetched_at: "2026-09-10T01:00:00Z" };
  const back = parseCachedSet(serializeSet(set));
  assert.deepEqual(back, { version: "v1", built_at: set.built_at, fetched_at: set.fetched_at, forays: set.forays, segments: set.segments, sources: set.sources });
  assert.equal(parseCachedSet(JSON.stringify({ version: "v1", forays: set.forays, segments: set.segments })), null);
  assert.equal(parseCachedSet("{not json"), null);
  assert.equal(parseCachedSet(""), null);
});

/* ==================================================================== */
/* boot: cache, then seed; never the network                            */
/* ==================================================================== */

test("boot with no cache holds the seed, and the bundled pointer's version if there is one", async () => {
  /* MUTATION: in boot(), read `seedPointer?.version` as null. The seed loses its
     version, the first refresh always re-fetches, and the second assertion is red. */
  const seed = makeSet(1);
  const fetch = fakeFetch({ "data/forays-directory.json": { version: "seed-v", built_at: "2026-09-01T00:00:00Z", files: { forays: "a", segments: "b", sources: "c" } } });
  const { d, events } = make({ fetch, cache: null });
  const held = await d.boot({ seed });
  assert.equal(held.source, SOURCE_BUNDLE);
  assert.equal(held.version, "seed-v");
  assert.equal(held.why, "seed");
  assert.equal(held.valid, true);
  assert.equal(d.held().forays, seed.forays);
  /* Only the LOCAL pointer was read; nothing left for the origin. */
  assert.deepEqual(fetch.calls, ["data/forays-directory.json"]);
  assert.equal(held.files.forays, "bundle@seed-v");
  /* The boot ROW is app.js's to write (it knows web from shell from pinned), so
     boot() itself records nothing: one writer per row. MUTATION: emit a `boot`
     event from boot(). Two rows per boot; red. */
  assert.deepEqual(events.filter((e) => e.phase === "boot"), []);
});

test("boot prefers a VALID cached set over the seed", async () => {
  /* MUTATION: `chosen = seedSet` unconditionally. Red. */
  const seed = makeSet(1);
  const cached = makeSet(2, { prefix: "c" });
  const tier = fakeTier();
  tier.rows.set(CACHE_KEY, serializeSet({ ...cached, version: "cache-v", built_at: "2026-09-05T00:00:00Z" }));
  const { d } = make({ fetch: fakeFetch({}), cache: tier });
  const held = await d.boot({ seed });
  assert.equal(held.source, SOURCE_CACHE);
  assert.equal(held.version, "cache-v");
  assert.equal(held.forays.forays.length, 2);
  assert.equal(held.files.segments, "cache@cache-v");
});

test("boot refuses a cached set that does not validate and falls back to the seed, saying why", async () => {
  /* MUTATION: skip `safeValidate(cached)` and adopt the cache when present. The
     app would paint a torn set from disk. Red. */
  const seed = makeSet(1);
  const torn = makeSet(1, { prefix: "t" });
  torn.segments.segments = [];                       // every reference dangles
  const tier = fakeTier();
  tier.rows.set(CACHE_KEY, serializeSet({ ...torn, version: "torn-v" }));
  const { d } = make({ fetch: fakeFetch({}), cache: tier });
  const held = await d.boot({ seed });
  assert.equal(held.source, SOURCE_BUNDLE);
  assert.equal(held.why, "cache-segment-missing");
  assert.equal(d.held().forays, seed.forays);
});

test("a store update newer than the cache wins at boot", async () => {
  /* The package can carry a newer set than the last one fetched (the founder
     shipped a build the same day). MUTATION: drop the `isOlderThan(cached.built_at,
     seedSet.built_at)` branch. Red. */
  const seed = makeSet(2, { prefix: "new" });
  const cached = makeSet(1, { prefix: "old" });
  const tier = fakeTier();
  tier.rows.set(CACHE_KEY, serializeSet({ ...cached, version: "old-v", built_at: "2026-09-01T00:00:00Z" }));
  const fetch = fakeFetch({ [POINTER_PATH]: { version: "new-v", built_at: "2026-09-09T00:00:00Z", files: { forays: "a", segments: "b", sources: "c" } } });
  const { d } = make({ fetch, cache: tier });
  const held = await d.boot({ seed });
  assert.equal(held.source, SOURCE_BUNDLE);
  assert.equal(held.why, "seed-newer-than-cache");
  assert.equal(held.version, "new-v");
});

test("a hung cache costs the cache, not the boot", async () => {
  /* MUTATION: remove `bounded(...)` around readCache() in start(). This test
     never resolves — the harness's timeout is the red. */
  const seed = makeSet(1);
  const { d } = make({ fetch: fakeFetch({}), cache: fakeTier({ hang: true }), cacheWaitMs: 20 });
  const held = await d.boot({ seed });
  assert.equal(held.source, SOURCE_BUNDLE);
  assert.equal(held.why, "seed");
});

test("an unreadable cache is reported and the seed stands", async () => {
  const seed = makeSet(1);
  const { d, events } = make({ fetch: fakeFetch({}), cache: fakeTier({ failReads: true }) });
  const held = await d.boot({ seed });
  assert.equal(held.source, SOURCE_BUNDLE);
  assert.ok(events.some((e) => e.status === "cache-unreadable"));
});

test("an EMPTY seed still boots: held, marked invalid, and the reason is a code", async () => {
  /* FD-04's "the shell boots with an empty seed too". MUTATION: throw from boot()
     when the seed does not validate. Red. */
  const { d } = make({ fetch: fakeFetch({}), cache: null });
  const held = await d.boot({ seed: { forays: null, segments: null, sources: null } });
  assert.equal(held.valid, false);
  assert.equal(held.why, "seed-no-forays-array");
  assert.deepEqual(held.files, { forays: "absent", segments: "absent", sources: "absent" });
});

/* ==================================================================== */
/* refresh: adopt, refuse, keep                                          */
/* ==================================================================== */

test("a newer pointer with whole files is fetched, verified, validated, held and cached", async () => {
  /* THE HAPPY PATH, with every check live: the pointer carries real byte counts
     and real sha256s and the files match them.
     MUTATION: `held = set` before the validate call and return `adopted` there. The
     "invalid set" test below goes red, not this one — which is why both exist. */
  const seed = makeSet(1);
  const next = makeSet(2, { prefix: "n" });
  const ptr = await pointerFor(next, "v2");
  const tier = fakeTier();
  const fetch = fakeFetch(remote(ptr, next));
  const { d, events } = make({ fetch, cache: tier });
  await d.boot({ seed });
  const out = await d.refresh({ origin: ORIGIN, reason: "boot" });
  assert.equal(out.status, STATUS.ADOPTED);
  assert.equal(out.version, "v2");
  assert.equal(out.set.forays.forays.length, 2);
  assert.equal(out.forays, 2);
  assert.equal(out.playable, 4);
  assert.equal(out.code, null, "sha256 was verifiable, so nothing is flagged unverified");
  assert.equal(d.held().source, SOURCE_NETWORK);
  assert.equal(d.held().version, "v2");
  assert.equal(tier.writes, 1);
  assert.equal(parseCachedSet(tier.rows.get(CACHE_KEY)).version, "v2");
  const ev = events.find((e) => e.phase === "refresh");
  assert.equal(ev.status, "adopted");
  assert.equal(ev.trigger, "boot");
  assert.equal(ev.files.sources, "network@v2");
  /* Four requests: the pointer and the three files, all on the origin. */
  assert.deepEqual(fetch.remote(), [
    `${ORIGIN}/${POINTER_PATH}`, `${ORIGIN}/data/forays.json`,
    `${ORIGIN}/data/segments.json`, `${ORIGIN}/data/segment-sources.json`,
  ]);
});

test("a pointer naming the held version is `current`, and fetches no file", async () => {
  /* MUTATION: drop the `held.version === ptr.version` early return. Every boot
     re-downloads ~300 KB and the second assertion is red. */
  const seed = makeSet(1);
  const ptr = await pointerFor(seed, "v1");
  const fetch = fakeFetch(remote(ptr, seed));
  const tier = fakeTier();
  tier.rows.set(CACHE_KEY, serializeSet({ ...seed, version: "v1" }));
  const { d } = make({ fetch, cache: tier });
  await d.boot({ seed });
  const out = await d.refresh({ origin: ORIGIN });
  assert.equal(out.status, STATUS.CURRENT);
  assert.equal(fetch.remote().length, 1);
});

test("F-92: a seed marked `partial` at the live version is fetched whole once, then answers `current`", async () => {
  /* The seed leaves generated drafts to the directory (prepare-webdir.mjs
     `seedCarries`), so a package built from the live deploy holds a SUBSET at the
     live version. `partial: true` on the bundled pointer (`seedPointerDoc`) is what
     stops the version match above from answering `current` and never fetching them.
     MUTATION: drop `&& held.partial !== true` from the `current` early return in
     run(). The first refresh answers `current`, no file is fetched, and the
     `adopted` assertion is red. */
  const seed = makeSet(1);
  const whole = makeSet(2);
  const ptr = await pointerFor(whole, "v1");
  const local = { version: "v1", built_at: ptr.built_at, files: ptr.files, partial: true };
  const fetch = fakeFetch({ ...remote(ptr, whole), "data/forays-directory.json": local });
  const tier = fakeTier();
  const { d } = make({ fetch, cache: tier });
  const held = await d.boot({ seed });
  assert.equal(held.version, "v1");
  assert.equal(held.partial, true);
  assert.equal(d.describe().partial, true);
  const out = await d.refresh({ origin: ORIGIN });
  assert.equal(out.status, STATUS.ADOPTED);
  assert.equal(fetch.remote().length, 4, "the pointer and all three files");
  assert.equal(d.held().forays.forays.length, 2, "the whole set is held");
  assert.equal(d.held().partial, false);
  assert.equal(tier.writes, 1, "and cached, whole");
  /* Whole now: the same pointer is `current` and costs one request. */
  const again = await d.refresh({ origin: ORIGIN });
  assert.equal(again.status, STATUS.CURRENT);
  assert.equal(fetch.remote().length, 5);

  /* THE CONTROL: the same seed under an unmarked pointer is `current` at once — the
     pre-F-92 answer, still right for a package whose seed IS the whole set. */
  const plain = fakeFetch({ ...remote(ptr, whole), "data/forays-directory.json": { version: "v1", built_at: ptr.built_at, files: ptr.files } });
  const { d: d2 } = make({ fetch: plain, cache: null });
  assert.equal((await d2.boot({ seed })).partial, false);
  assert.equal((await d2.refresh({ origin: ORIGIN })).status, STATUS.CURRENT);
  assert.equal(plain.remote().length, 1);
});

test("a pointer OLDER than the held set is refused, not adopted", async () => {
  /* A stale edge must not walk a phone backwards. MUTATION: drop the
     `isOlderThan(ptr.built_at, held.built_at)` return. Red. */
  const held = makeSet(2, { prefix: "h" });
  const old = makeSet(1, { prefix: "o" });
  const ptr = await pointerFor(old, "v-old", "2026-09-01T00:00:00Z");
  const tier = fakeTier();
  tier.rows.set(CACHE_KEY, serializeSet({ ...held, version: "v-held", built_at: "2026-09-08T00:00:00Z" }));
  const fetch = fakeFetch(remote(ptr, old));
  const { d } = make({ fetch, cache: tier });
  await d.boot({ seed: makeSet(1) });
  const out = await d.refresh({ origin: ORIGIN });
  assert.equal(out.status, STATUS.OLDER);
  assert.equal(d.held().version, "v-held");
  assert.equal(fetch.remote().length, 1);
});

test("a set that fails validation is refused: the held set and the cache are untouched, and the code names the Foray", async () => {
  /* THE SECOND RULE. MUTATION: delete the `if (!check.ok)` block in run(). The
     torn set is held and cached; every assertion below is red. */
  const seed = makeSet(1);
  const bad = makeSet(2, { prefix: "b" });
  bad.segments.segments = bad.segments.segments.filter((s) => s.id !== "b2-s2");   // b2 dangles
  const ptr = await pointerFor(bad, "v-bad");
  const tier = fakeTier();
  const { d, events } = make({ fetch: fakeFetch(remote(ptr, bad)), cache: tier });
  await d.boot({ seed });
  const out = await d.refresh({ origin: ORIGIN, reason: "foreground" });
  assert.equal(out.status, STATUS.INVALID);
  assert.equal(out.code, "segment-missing");
  assert.equal(out.forayId, "b2");
  assert.equal(d.held().source, SOURCE_BUNDLE);
  assert.equal(d.held().forays, seed.forays);
  assert.equal(tier.writes, 0);
  const ev = events.find((e) => e.phase === "refresh");
  assert.equal(ev.status, "invalid");
  assert.equal(ev.code, "segment-missing");
  assert.equal(ev.forayId, "b2");
});

test("a file whose sha256 disagrees with the pointer is `torn`, and nothing is held", async () => {
  /* Files from two deploys — the exact hazard sw.js guards on the web.
     MUTATION: drop the `hex !== ptr.sha256[k]` comparison. Red. */
  const seed = makeSet(1);
  const next = makeSet(1, { prefix: "n" });
  const ptr = await pointerFor(next, "v2");
  const served = { ...next, segments: { ...next.segments, provenance: "a different deploy" } };
  ptr.bytes.segments = enc(served.segments).byteLength;     // bytes agree, the hash does not
  const { d } = make({ fetch: fakeFetch(remote(ptr, served)), cache: fakeTier() });
  await d.boot({ seed });
  const out = await d.refresh({ origin: ORIGIN });
  assert.equal(out.status, STATUS.TORN);
  assert.equal(out.code, "sha256-segments");
  assert.equal(d.held().version, null);
});

test("a file whose byte count disagrees with the pointer is `torn` before any hash is computed", async () => {
  /* MUTATION: drop the `byteLength !== ptr.bytes[k]` check. The sha256 check
     catches it too, so this test only turns red if BOTH are dropped — it is the
     cheap check for a browser with no `crypto.subtle`, which the next test is
     about. */
  const seed = makeSet(1);
  const next = makeSet(1, { prefix: "n" });
  const ptr = await pointerFor(next, "v2");
  ptr.bytes.forays += 1;
  const { d } = make({ fetch: fakeFetch(remote(ptr, next)), cache: fakeTier(), subtle: null });
  await d.boot({ seed });
  const out = await d.refresh({ origin: ORIGIN });
  assert.equal(out.status, STATUS.TORN);
  assert.equal(out.code, "bytes-forays");
});

test("with no crypto.subtle the set is adopted on bytes alone, and says the hash went unverified", async () => {
  /* MUTATION: treat `hex === null` as a mismatch. A WebView with no SubtleCrypto
     could never update. Red. */
  const seed = makeSet(1);
  const next = makeSet(1, { prefix: "n" });
  const ptr = await pointerFor(next, "v2");
  const { d } = make({ fetch: fakeFetch(remote(ptr, next)), cache: fakeTier(), subtle: null });
  await d.boot({ seed });
  const out = await d.refresh({ origin: ORIGIN });
  assert.equal(out.status, STATUS.ADOPTED);
  assert.equal(out.code, "sha256-unverified");
});

test("a pointer that is not a pointer is `bad-pointer`, and a foreign file path too", async () => {
  const seed = makeSet(1);
  const { d } = make({ fetch: fakeFetch({ [`${ORIGIN}/${POINTER_PATH}`]: { version: "v", files: {} } }) });
  await d.boot({ seed });
  assert.equal((await d.refresh({ origin: ORIGIN })).code, "no-file-forays");

  const next = makeSet(1, { prefix: "n" });
  const ptr = await pointerFor(next, "v2");
  ptr.files.segments = "https://evil.test/segments.json";
  const d2 = make({ fetch: fakeFetch(remote(ptr, next)) }).d;
  await d2.boot({ seed });
  const out = await d2.refresh({ origin: ORIGIN });
  assert.equal(out.status, STATUS.BAD_POINTER);
  assert.equal(out.code, "foreign-segments");
});

test("THE THIRD RULE: a network failure keeps the held set AND the cache exactly as they were", async () => {
  /* MUTATION: in the `!got.ok` branch of run(), add `held = null; cache.remove(CACHE_KEY)`.
     Both halves below are red. */
  const cached = makeSet(2, { prefix: "c" });
  const tier = fakeTier();
  tier.rows.set(CACHE_KEY, serializeSet({ ...cached, version: "c-v", built_at: "2026-09-05T00:00:00Z" }));
  const { d, events } = make({ fetch: fakeFetch({}, { reject: true }), cache: tier });
  await d.boot({ seed: makeSet(1) });
  assert.equal(d.held().version, "c-v");
  const out = await d.refresh({ origin: ORIGIN, reason: "boot" });
  assert.equal(out.status, STATUS.OFFLINE);
  assert.equal(out.code, "network");
  assert.equal(d.held().version, "c-v");
  assert.equal(d.held().source, SOURCE_CACHE);
  assert.equal(tier.removes, 0);
  assert.equal(parseCachedSet(tier.rows.get(CACHE_KEY)).version, "c-v");
  assert.equal(events.at(-1).status, "offline");
});

test("a pointer that never answers times out to `offline` — and the held set stays", async () => {
  /* MUTATION: remove the `timeout` promise from fetchBytes' race. This test hangs;
     the harness timeout is the red. */
  const { d } = make({ fetch: fakeFetch({}, { never: true }), pointerTimeoutMs: 20 });
  await d.boot({ seed: makeSet(1) });
  const out = await d.refresh({ origin: ORIGIN });
  assert.equal(out.status, STATUS.OFFLINE);
  assert.equal(out.code, "timeout");
  assert.equal(d.held().source, SOURCE_BUNDLE);
});

test("one file failing to arrive is `offline` too, naming the file, with nothing held", async () => {
  const seed = makeSet(1);
  const next = makeSet(1, { prefix: "n" });
  const ptr = await pointerFor(next, "v2");
  const routes = remote(ptr, next);
  delete routes[`${ORIGIN}/data/segment-sources.json`];
  const { d } = make({ fetch: fakeFetch(routes), cache: fakeTier() });
  await d.boot({ seed });
  const out = await d.refresh({ origin: ORIGIN });
  assert.equal(out.status, STATUS.OFFLINE);
  assert.equal(out.code, "http-404-sources");
  assert.equal(d.held().version, null);
});

test("a cache write that fails does not un-adopt a valid set; it is reported", async () => {
  /* The set is valid in memory and the phone can play it; the next boot simply
     starts from the seed again. MUTATION: rethrow from the write's catch. Red. */
  const seed = makeSet(1);
  const next = makeSet(1, { prefix: "n" });
  const ptr = await pointerFor(next, "v2");
  const { d } = make({ fetch: fakeFetch(remote(ptr, next)), cache: fakeTier({ failWrites: true }) });
  await d.boot({ seed });
  const out = await d.refresh({ origin: ORIGIN });
  assert.equal(out.status, STATUS.ADOPTED);
  assert.equal(out.cacheWrite, "write-failed");
  assert.equal(d.held().version, "v2");
});

test("refreshes are throttled, and a refresh in flight is not doubled", async () => {
  /* MUTATION: drop the `lastAttemptAt` check. The second call fetches again and
     `fetch.calls.length` is 2. */
  const seed = makeSet(1);
  const ptr = await pointerFor(seed, "v1");
  let t = 1000;
  const fetch = fakeFetch(remote(ptr, seed));
  const { d } = make({ fetch, now: () => t, minRefreshIntervalMs: 60000 });
  await d.boot({ seed });
  assert.equal((await d.refresh({ origin: ORIGIN })).status, STATUS.ADOPTED);
  t += 1000;
  assert.equal((await d.refresh({ origin: ORIGIN })).status, STATUS.THROTTLED);
  assert.equal(fetch.remote().length, 4);
  t += 60000;
  const first = d.refresh({ origin: ORIGIN });
  const second = await d.refresh({ origin: ORIGIN });
  assert.equal(second.status, STATUS.BUSY);
  assert.equal((await first).status, STATUS.CURRENT);
});

test("no origin, no fetch", async () => {
  const fetch = fakeFetch({});
  const { d } = make({ fetch });
  await d.boot({ seed: makeSet(1) });
  assert.equal((await d.refresh({})).status, STATUS.NO_ORIGIN);
  assert.equal(fetch.calls.filter((u) => u.startsWith("http")).length, 0);
});

test("describe() names the source, the version and the last outcome, for the diagnostics surface", async () => {
  const seed = makeSet(1);
  const { d } = make({ fetch: fakeFetch({}, { reject: true }), cache: null });
  await d.boot({ seed });
  await d.refresh({ origin: ORIGIN });
  const s = d.describe();
  assert.equal(s.source, SOURCE_BUNDLE);
  assert.equal(s.cache, "none");
  assert.equal(s.last.status, STATUS.OFFLINE);
});

/* ==================================================================== */
/* the validator, at the edges the directory relies on                   */
/* ==================================================================== */

test("validateForayDocuments: the join is the rule — a dangling reference is fatal, a skipped item is a warning", () => {
  /* MUTATION: in foray-resolve.js, drop the `if (dropped.length)` return. A torn
     set validates and the first assertion is red. */
  const set = makeSet(1);
  assert.equal(validateForayDocuments(set).ok, true);

  const torn = makeSet(1);
  torn.sources.sources = torn.sources.sources.slice(0, 1);
  const t = validateForayDocuments(torn);
  assert.equal(t.ok, false);
  assert.equal(t.code, "source-missing");
  assert.equal(t.forayId, "f1");

  /* One item without an audio URL: the builder skips it, the set still stands,
     and the warning names it. */
  const thin = makeSet(1);
  thin.sources.sources[1].audio_url = null;
  const w = validateForayDocuments(thin);
  assert.equal(w.ok, true);
  assert.equal(w.playable, 1);
  assert.equal(w.warnings.length, 1);

  /* But a Foray with NOTHING playable is fatal. */
  const empty = makeSet(1);
  for (const s of empty.sources.sources) s.audio_url = null;
  assert.equal(validateForayDocuments(empty).code, "nothing-playable");
});

test("validateForayDocuments: shapes, ids, and the vocabulary of codes", () => {
  assert.equal(validateForayDocuments({}).code, "no-forays-array");
  assert.equal(validateForayDocuments({ forays: { forays: [] }, segments: { segments: [] }, sources: { sources: [] } }).code, "no-forays");
  const dup = makeSet(2);
  dup.forays.forays[1].id = "f1";
  assert.equal(validateForayDocuments(dup).code, "duplicate-foray-id");
  const noId = makeSet(1);
  delete noId.forays.forays[0].id;
  assert.equal(validateForayDocuments(noId).code, "foray-without-id");
  /* Every code the record can carry is a token the field record admits. */
  for (const c of ["segment-missing", "source-missing", "nothing-playable", "no-forays-array"]) {
    assert.match(c, /^[a-z][a-z0-9-]*$/);
  }
  assert.equal(DIRECTORY_DB_NAME, "foray-directory");
});
