/* The S-10 watchlist and its seed builder (tools/poll/watchlist.mjs,
   tools/poll/build-watchlist-seed.mjs, PKG-07).
   Run:
   node --test tools/poll/watchlist.test.mjs

   Every test uses a FAKE change index (the shape loadChangeIndex() returns:
   { ok, changedIds: Set<number>, idMap, topRows }) — no network, no pointer
   file, except the last CLI test, which points the real CLI at a pointer that
   does not exist and spawns ONE child `node` to prove the exit code reaches the
   shell. Every test names the one-line mutation that turns it red; each was
   applied, confirmed changed on disk, and seen to fail this suite. The rules
   are stated in watchlist.mjs's header.

   Harness audit (CLAUDE.md "a green test is not evidence"): the fake index
   marks curated rows `c: true` in topRows exactly as the real top.json does
   (shard-build.mjs's toShardRow), so the "curated and changed" test cannot pass
   only through an inconsistent fixture; the inconsistent case (`c: false` on a
   mapped curated id) is tested separately as what it is. */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWatchlist, expireOpened, summarize, assertSeedSize } from "./watchlist.mjs";
import { run } from "./build-watchlist-seed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 9, 5); // fixed so no test reads the clock
const DAY = 86_400_000;

const curated = (id, over = {}) => ({
  show_id: id,
  title: `Show ${id}`,
  apple_collection_id: 1000,
  feed_url: `https://feeds.example.com/${id}.xml`,
  episode_count: null,
  ...over,
});

const top = (id, over = {}) => ({
  id,
  t: `Top ${id}`,
  a: "Author",
  i: null,
  u: `https://top.example.com/${id}.xml`,
  img: null,
  n: 50,
  c: false,
  ...over,
});

const index = ({ idMap = {}, changed = [], topRows = [] } = {}) => ({
  ok: true,
  changedIds: new Set(changed),
  idMap,
  topRows,
});

const byPi = (rows, pi) => rows.filter((r) => r.pi_id === pi);

test("curated rows carry reason curated and the catalogue feed_url; an unmapped curated row is kept with pi_id null and reason unmapped", () => {
  // MUTATION: delete `if (pi_id === null) addReason(row, "unmapped");` -> red.
  const rows = buildWatchlist({
    curatedShows: [curated("a"), curated("b")],
    changeIndex: index({ idMap: { a: 101 }, topRows: [top(101, { c: true })] }),
    nowMs: NOW,
  });
  assert.equal(rows.length, 2);
  const [a, b] = rows;
  assert.deepEqual(
    { pi_id: a.pi_id, show_id: a.show_id, feed_url: a.feed_url, watch_reasons: a.watch_reasons },
    { pi_id: 101, show_id: "a", feed_url: "https://feeds.example.com/a.xml", watch_reasons: ["curated"] },
  );
  assert.deepEqual(
    { pi_id: b.pi_id, show_id: b.show_id, feed_url: b.feed_url, watch_reasons: b.watch_reasons },
    { pi_id: null, show_id: "b", feed_url: "https://feeds.example.com/b.xml", watch_reasons: ["curated", "unmapped"] },
  );
  for (const r of rows) {
    assert.equal(r.next_due_at_ms, null);
    assert.equal(r.state, "active");
  }
  assert.deepEqual(summarize(rows), {
    total: 2,
    mapped: 1,
    unmapped: 1,
    byReason: { curated: 2, unmapped: 1 },
    byTier: { daily: 2 },
  });
});

test("changed ∩ top-N non-curated rows carry changed_in_dump and stop at topN", () => {
  // MUTATION: delete `if (rank >= topN) break;` -> red (3 rows instead of 2).
  // topN cuts the top.json RANK of non-curated rows, not the output count:
  // curated rows (c: true) are skipped without using a rank slot.
  const topRows = [top(900, { c: true }), top(1), top(2), top(3)];
  const rows = buildWatchlist({
    curatedShows: [],
    changeIndex: index({ idMap: {}, changed: [1, 2, 3], topRows }),
    topN: 2,
    nowMs: NOW,
  });
  assert.deepEqual(rows.map((r) => r.pi_id), [1, 2]);
  assert.deepEqual(rows[0], {
    pi_id: 1,
    show_id: null,
    title: "Top 1",
    feed_url: "https://top.example.com/1.xml",
    watch_reasons: ["changed_in_dump"],
    episode_count: 50,
    tier: "weekly",
    next_due_at_ms: null,
    state: "active",
  });
  // An unchanged row inside the top 2 still uses its slot: only #2 qualifies.
  const cut = buildWatchlist({
    curatedShows: [],
    changeIndex: index({ changed: [2, 3], topRows }),
    topN: 2,
    nowMs: NOW,
  });
  assert.deepEqual(cut.map((r) => r.pi_id), [2]);
  // Unchanged non-curated rows are never watched.
  const none = buildWatchlist({ curatedShows: [], changeIndex: index({ changed: [], topRows }), nowMs: NOW });
  assert.equal(none.length, 0);
});

test("a curated row that is also changed has both reasons once", () => {
  // MUTATION: in addReason, drop the `includes` guard (always push) -> red.
  // MUTATION: delete `if (changedIds.has(pi_id)) addReason(row, "changed_in_dump");` -> red.
  // Real shape: top.json marks curated rows c: true, so the curated pass alone
  // must notice the change.
  const real = buildWatchlist({
    curatedShows: [curated("a")],
    changeIndex: index({ idMap: { a: 10 }, changed: [10], topRows: [top(10, { c: true })] }),
    nowMs: NOW,
  });
  assert.equal(real.length, 1);
  assert.deepEqual(real[0].watch_reasons, ["curated", "changed_in_dump"]);
  // Inconsistent release: the same pi_id also appears as a c: false row. Still
  // one row, each reason once, and the curated row's catalogue fields win.
  const dup = buildWatchlist({
    curatedShows: [curated("a")],
    changeIndex: index({ idMap: { a: 10 }, changed: [10], topRows: [top(10, { c: false })] }),
    nowMs: NOW,
  });
  assert.equal(byPi(dup, 10).length, 1);
  assert.deepEqual(dup[0].watch_reasons, ["curated", "changed_in_dump"]);
  assert.equal(dup[0].feed_url, "https://feeds.example.com/a.xml");
});

test("curated rows are daily; a changed non-curated row with no pubdates is weekly", () => {
  // MUTATION: replace the seedTier call with `row.tier = "weekly"` (skip seedTier) -> red.
  const rows = buildWatchlist({
    curatedShows: [curated("a", { episode_count: 400 }), curated("b")],
    changeIndex: index({ idMap: { a: 1 }, changed: [7], topRows: [top(1, { c: true }), top(7, { n: 900 })] }),
    nowMs: NOW,
  });
  assert.deepEqual(
    rows.map((r) => [r.show_id ?? r.pi_id, r.tier]),
    [["a", "daily"], ["b", "daily"], [7, "weekly"]],
  );
  assert.equal(rows[0].episode_count, 400);
  assert.deepEqual(summarize(rows).byTier, { daily: 2, weekly: 1 });
});

test("expireOpened drops rows older than 90 days; exactly 90 days is kept", () => {
  // MUTATION: `nowMs - row.opened_at_ms > ttl` -> `>=` -> red.
  const rows = [
    { pi_id: 1, watch_reasons: ["opened"], opened_at_ms: NOW - 90 * DAY }, // exactly 90 d: kept
    { pi_id: 2, watch_reasons: ["opened"], opened_at_ms: NOW - 90 * DAY - 1 }, // 1 ms past: dropped
    { pi_id: 3, watch_reasons: ["opened"], opened_at_ms: NOW - DAY },
    { pi_id: 4, watch_reasons: ["curated"] }, // never opened: never expires
  ];
  assert.deepEqual(expireOpened(rows, NOW).map((r) => r.pi_id), [1, 3, 4]);
  assert.deepEqual(expireOpened(rows, NOW, 1).map((r) => r.pi_id), [3, 4]);
  assert.equal(rows.length, 4, "pure: the input is not mutated");
});

test("assertSeedSize rejects fewer than 200 rows", () => {
  // MUTATION: default `min = 200` -> `min = 0` -> red.
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ pi_id: i }));
  assert.throws(() => assertSeedSize(rows(199)), RangeError);
  assert.throws(() => assertSeedSize([]), RangeError);
  assert.doesNotThrow(() => assertSeedSize(rows(200)));
  assert.doesNotThrow(() => assertSeedSize(rows(5), 5));
});

test("changeIndex.ok false yields curated rows only", () => {
  // MUTATION: `const ok = ...` -> `if (changeIndex.ok !== true) throw new Error("no index")` -> red.
  // MUTATION: `const ok = Boolean(...)` -> `const ok = true` -> red (the failed index's data is read).
  const failed = {
    ok: false,
    reason: "changed.json has no baseline",
    // A failed index must not be read even if a buggy loader left data on it.
    changedIds: new Set([5]),
    idMap: { a: 5 },
    topRows: [top(5, { c: true }), top(6)],
  };
  const rows = buildWatchlist({
    curatedShows: [curated("a"), curated("b", { pi_id: 77 })],
    changeIndex: failed,
    nowMs: NOW,
  });
  assert.deepEqual(
    rows.map((r) => [r.show_id, r.pi_id, r.watch_reasons]),
    [
      ["a", null, ["curated", "unmapped"]],
      ["b", 77, ["curated"]], // a seed row keeps its own pi_id (PKG-08's ok:false path)
    ],
  );
  assert.deepEqual(buildWatchlist({ curatedShows: [], changeIndex: failed, nowMs: NOW }), []);
});

/* ---- build-watchlist-seed.mjs ----------------------------------------- */

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "watchlist-seed-"));
}

/** A catalogue with n curated shows; the first n-1 mapped, the last not. */
function fixtureCatalog(dir, n = 210) {
  const shows = Array.from({ length: n }, (_, i) => curated(`s${i}`));
  const idMap = Object.fromEntries(shows.slice(0, n - 1).map((s, i) => [s.show_id, 5000 + i]));
  const catalogPath = path.join(dir, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify({ version: 1, shows }));
  return { catalogPath, idMap, shows };
}

const quiet = () => {
  const lines = [];
  return { lines, log: (s) => lines.push(s), err: (s) => lines.push(s) };
};

test("build-watchlist-seed exits 2 and writes nothing when loadChangeIndex is ok:false for a stale pointer", async () => {
  // MUTATION: in run(), `return 2;` after "change index unavailable" -> `return 0;` -> red.
  // MUTATION: `if (!isNoBaselineReason(reason))` -> `if (false)` (every ok:false takes the fallback) -> red.
  // A stale pointer is NOT the no-baseline case: no fallback, no fetch.
  const dir = tmp();
  try {
    const { catalogPath } = fixtureCatalog(dir);
    const outPath = path.join(dir, "seed.json");
    const pointerPath = path.join(dir, "pointer.json");
    writeFileSync(pointerPath, JSON.stringify({ release_tag: "shows-index-test", asset_base_url: "https://assets.example.com/rel" }));
    let asked;
    const loadIndex = async (opts) => {
      asked = opts;
      return { ok: false, reason: "pointer is stale: published_at 2026-09-15T06:20:47Z is 480.0h old (ceiling 216h)" };
    };
    let fetches = 0;
    const fetchImpl = async () => {
      fetches++;
      throw new Error("no fetch on a stale pointer");
    };
    for (const extra of [[], ["--check"]]) {
      const io = quiet();
      const code = await run({ argv: ["--out", outPath, "--pointer", pointerPath, ...extra], loadIndex, fetchImpl, catalogPath, nowMs: NOW, ...io });
      assert.equal(code, 2, `exit code with ${JSON.stringify(extra)}`);
      assert.equal(existsSync(outPath), false, "nothing written");
      assert.match(io.lines.join("\n"), /pointer is stale/, "the loader's reason is printed");
    }
    assert.deepEqual(Object.keys(asked), ["pointerPath"], "maxAgeHours is never overridden");
    assert.equal(fetches, 0, "a stale pointer never reaches the id-map fallback");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---- no-baseline fallback: id-map.json only (PKG-07-part) --------------- */

const BASE = "https://assets.example.com/rel";
const NO_BASELINE = "changed.json has no baseline (no previous-release snapshot) -- index unavailable";
const BARE_ARRAY = "changed.json is a bare array (pre-baseline release: every show listed, no real diff) -- index unavailable";

/** A fake fetch serving one id-map.json body (or status); records every URL. */
function fakeFetch({ body, status = 200 }) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { urls, fetchImpl };
}

function fixturePointer(dir) {
  const pointerPath = path.join(dir, "pointer.json");
  writeFileSync(pointerPath, JSON.stringify({ release_tag: "shows-index-nobase", asset_base_url: BASE, published_at: "2026-10-04T23:32:30.065Z" }));
  return pointerPath;
}

test("no-baseline release + a valid id-map.json writes a curated-only seed from the id-map alone", async () => {
  // MUTATION: `if (!isNoBaselineReason(reason))` -> `if (true)` (no fallback) -> red (exit 2).
  // MUTATION: in NO_BASELINE_REASONS, drop the bare-array regex -> red (the bare-array pass exits 2).
  // MUTATION: in the fallback, `idMap: only.idMap` -> `idMap: {}` -> red (every row unmapped).
  const dir = tmp();
  try {
    const { catalogPath, idMap, shows } = fixtureCatalog(dir);
    const pointerPath = fixturePointer(dir);
    for (const reason of [NO_BASELINE, BARE_ARRAY]) {
      const outPath = path.join(dir, "seed.json");
      rmSync(outPath, { force: true });
      const { urls, fetchImpl } = fakeFetch({ body: idMap });
      const io = quiet();
      const code = await run({
        argv: ["--out", outPath, "--pointer", pointerPath],
        loadIndex: async () => ({ ok: false, reason }),
        fetchImpl,
        catalogPath,
        nowMs: NOW,
        ...io,
      });
      assert.equal(code, 0, io.lines.join("\n"));
      assert.deepEqual(urls, [`${BASE}/id-map.json`], "only id-map.json is fetched, from the pointer's asset_base_url");
      assert.match(io.lines.join("\n"), /id-map\.json only/, "stderr says the seed came from id-map only");
      const seed = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(seed.version, 1);
      assert.equal(seed.pointer_release_tag, "shows-index-nobase");
      assert.equal(seed.rows.length, shows.length);
      assert.ok(seed.rows.every((r) => r.watch_reasons[0] === "curated" && !r.watch_reasons.includes("changed_in_dump")));
      assert.equal(seed.rows[0].pi_id, 5000);
      assert.equal(seed.rows.filter((r) => r.pi_id !== null).length, shows.length - 1);
      assert.deepEqual(seed.rows.at(-1).watch_reasons, ["curated", "unmapped"]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no-baseline fallback refuses an id-map.json with a non-numeric value (exit 1, nothing written)", async () => {
  // MUTATION: in run(), delete the badIds refusal `return 1;` -> red (exit 0, a seed with pi_id "5000" written).
  // The refusal must run AFTER the fallback swaps in the fetched id-map, so the fallback inherits it.
  const dir = tmp();
  try {
    const { catalogPath, idMap } = fixtureCatalog(dir);
    const pointerPath = fixturePointer(dir);
    const outPath = path.join(dir, "seed.json");
    const { fetchImpl } = fakeFetch({ body: { ...idMap, s0: "5000" } });
    const io = quiet();
    const code = await run({
      argv: ["--out", outPath, "--pointer", pointerPath],
      loadIndex: async () => ({ ok: false, reason: NO_BASELINE }),
      fetchImpl,
      catalogPath,
      nowMs: NOW,
      ...io,
    });
    assert.equal(code, 1);
    assert.match(io.lines.join("\n"), /not numbers/);
    assert.equal(existsSync(outPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no-baseline fallback exits 2 and writes nothing on an id-map HTTP error, a bad shape, or a pointer with no asset_base_url", async () => {
  // MUTATION: in run(), the fallback's `return 2;` -> `return 0;` -> red.
  // MUTATION: in loadIdMapOnly, delete `if (!res || !res.ok) return ...` -> red (the 404 body {} builds an all-unmapped seed).
  // MUTATION: in loadIdMapOnly, drop `|| Array.isArray(idMap)` -> red (an array id-map builds an all-unmapped seed).
  const dir = tmp();
  try {
    const { catalogPath } = fixtureCatalog(dir);
    const pointerPath = fixturePointer(dir);
    const noBase = path.join(dir, "nobase.json");
    writeFileSync(noBase, JSON.stringify({ release_tag: "x" }));
    const outPath = path.join(dir, "seed.json");
    const cases = [
      { name: "HTTP 404", pointer: pointerPath, fetch: fakeFetch({ body: {}, status: 404 }), want: /HTTP 404/ },
      { name: "array id-map", pointer: pointerPath, fetch: fakeFetch({ body: [] }), want: /unexpected asset shape/ },
      { name: "no asset_base_url", pointer: noBase, fetch: fakeFetch({ body: {} }), want: /no asset_base_url/ },
    ];
    for (const c of cases) {
      const io = quiet();
      const code = await run({
        argv: ["--out", outPath, "--pointer", c.pointer],
        loadIndex: async () => ({ ok: false, reason: NO_BASELINE }),
        fetchImpl: c.fetch.fetchImpl,
        catalogPath,
        nowMs: NOW,
        ...io,
      });
      assert.equal(code, 2, c.name);
      assert.match(io.lines.join("\n"), c.want, c.name);
      assert.equal(existsSync(outPath), false, `${c.name}: nothing written`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the seed is curated rows only with no changed_in_dump; --check is 0 on a fresh seed and 1 on a stale one", async () => {
  // MUTATION: in buildSeed, pass `changeIndex` as-is instead of blanking changedIds/topRows -> red.
  // MUTATION: in --check, compare JSON.stringify of the whole object (built_at included) -> red (the --check run is a day later).
  const dir = tmp();
  try {
    const { catalogPath, idMap, shows } = fixtureCatalog(dir);
    const outPath = path.join(dir, "seed.json");
    const pointerPath = path.join(dir, "pointer.json");
    writeFileSync(pointerPath, JSON.stringify({ release_tag: "shows-index-test" }));
    const topRows = [...shows.slice(0, 3).map((s, i) => top(5000 + i, { c: true })), top(1), top(2)];
    const fake = index({ idMap, changed: [5000, 1, 2], topRows });
    const loadIndex = async () => fake;

    const io = quiet();
    assert.equal(await run({ argv: ["--out", outPath, "--pointer", pointerPath], loadIndex, catalogPath, nowMs: NOW, ...io }), 0);
    const seed = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(seed.version, 1);
    assert.equal(seed.pointer_release_tag, "shows-index-test");
    assert.equal(seed.built_at, new Date(NOW).toISOString());
    assert.equal(seed.rows.length, shows.length, "curated rows only: the two changed top rows are not committed");
    assert.ok(seed.rows.every((r) => r.watch_reasons[0] === "curated" && !r.watch_reasons.includes("changed_in_dump")));
    assert.equal(seed.rows[0].pi_id, 5000);
    assert.deepEqual(seed.rows.at(-1).watch_reasons, ["curated", "unmapped"]);

    const later = quiet();
    assert.equal(await run({ argv: ["--out", outPath, "--pointer", pointerPath, "--check"], loadIndex, catalogPath, nowMs: NOW + DAY, ...later }), 0);
    assert.match(later.lines.join("\n"), /up to date/);

    const before = readFileSync(outPath, "utf8");
    const stale = { ...fake, idMap: { ...idMap, [shows.at(-1).show_id]: 9999 } }; // next release maps the last show
    const io3 = quiet();
    assert.equal(await run({ argv: ["--out", outPath, "--pointer", pointerPath, "--check"], loadIndex: async () => stale, catalogPath, nowMs: NOW, ...io3 }), 1);
    assert.match(io3.lines.join("\n"), /stale/);
    assert.equal(readFileSync(outPath, "utf8"), before, "--check writes nothing");

    // Too few curated shows: refused before anything is written.
    const small = fixtureCatalog(dir, 150);
    const smallOut = path.join(dir, "small.json");
    assert.equal(await run({ argv: ["--out", smallOut], loadIndex: async () => index({ idMap: small.idMap }), catalogPath: small.catalogPath, nowMs: NOW, ...quiet() }), 1);
    assert.equal(existsSync(smallOut), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real CLI pointed at a missing pointer exits 2 and writes nothing", () => {
  // MUTATION: in the entrypoint guard, `process.exitCode = await run(...)` -> `await run(...)` -> red (exit 0).
  // Spawns one child `node`, synchronously. The missing pointer makes the real
  // loadChangeIndex return ok:false before any fetch, so no network is touched.
  const dir = tmp();
  try {
    const outPath = path.join(dir, "seed.json");
    const res = spawnSync(
      process.execPath,
      [path.join(HERE, "build-watchlist-seed.mjs"), "--pointer", path.join(dir, "no-such-pointer.json"), "--out", outPath],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(res.status, 2, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /pointer unreadable/);
    assert.equal(existsSync(outPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
