/* Tests for candidates.mjs (S-11, 4a-shows-pipeline-plan.md card S-11).
   Run: node --test tools/refresh/ */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadChangeIndex,
  selectChangedCuratedShows,
  curationCandidates,
} from "./candidates.mjs";

function withPointer(pointer, fn) {
  const dir = mkdtempSync(join(tmpdir(), "s11-pointer-"));
  const path = join(dir, "shows-index-pointer.json");
  if (pointer !== undefined) writeFileSync(path, JSON.stringify(pointer));
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeFetch(routes) {
  return async (url) => {
    for (const [suffix, body] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => { throw new Error("no body"); } };
  };
}

/* ---------- loadChangeIndex ---------- */

test("loadChangeIndex returns ok:false when the pointer file is missing (S-04 hasn't published yet)", async () => {
  const result = await withPointer(undefined, (path) => loadChangeIndex({ pointerPath: path }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /pointer unreadable/);
});

test("loadChangeIndex returns ok:false when the pointer has no asset_base_url", async () => {
  const result = await withPointer({ version: 1 }, (path) => loadChangeIndex({ pointerPath: path }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /asset_base_url/);
});

test("loadChangeIndex returns ok:false on a fetch failure, never throws", async () => {
  const result = await withPointer(
    { asset_base_url: "https://example.com/rel" },
    (path) => loadChangeIndex({ pointerPath: path, fetchImpl: async () => { throw new Error("network down"); } }),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /fetch error/);
});

test("loadChangeIndex returns ok:false when any asset 404s", async () => {
  const fetchImpl = fakeFetch({ "changed.json": [1, 2], "id-map.json": {} }); // top.json missing -> 404
  const result = await withPointer(
    { asset_base_url: "https://example.com/rel" },
    (path) => loadChangeIndex({ pointerPath: path, fetchImpl }),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /top\.json fetch failed/);
});

test("loadChangeIndex returns ok:false on malformed asset shapes", async () => {
  const fetchImpl = fakeFetch({ "changed.json": { not: "an array" }, "id-map.json": {}, "top.json": [] });
  const result = await withPointer(
    { asset_base_url: "https://example.com/rel" },
    (path) => loadChangeIndex({ pointerPath: path, fetchImpl }),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpected asset shape/);
});

test("loadChangeIndex succeeds and parses all three assets", async () => {
  const fetchImpl = fakeFetch({
    "changed.json": [10, 20, "30"],
    "id-map.json": { "show-a": 10, "show-b": 99 },
    "top.json": [{ id: 10, t: "Show A", c: true }, { id: 500, t: "Big Show", c: false }],
  });
  const result = await withPointer(
    { asset_base_url: "https://example.com/rel" },
    (path) => loadChangeIndex({ pointerPath: path, fetchImpl }),
  );
  assert.equal(result.ok, true);
  assert.deepStrictEqual([...result.changedIds].sort((a, b) => a - b), [10, 20, 30]);
  assert.deepStrictEqual(result.idMap, { "show-a": 10, "show-b": 99 });
  assert.equal(result.topRows.length, 2);
});

/* ---------- selectChangedCuratedShows ---------- */

test("selectChangedCuratedShows keeps a curated show whose mapped pi_id changed", () => {
  const shows = [{ show_id: "a", feed_url: "https://a.example/feed" }];
  const idMap = { a: 10 };
  const changedIds = new Set([10]);
  assert.deepStrictEqual(selectChangedCuratedShows(shows, idMap, changedIds), shows);
});

test("selectChangedCuratedShows drops a curated show that mapped but did not change", () => {
  const shows = [{ show_id: "a", feed_url: "https://a.example/feed" }];
  const idMap = { a: 10 };
  const changedIds = new Set([999]);
  assert.deepStrictEqual(selectChangedCuratedShows(shows, idMap, changedIds), []);
});

test("selectChangedCuratedShows fails OPEN (always scans) a curated show absent from id-map", () => {
  // A curated show unmapped in this release (join gap in S-04's dump) must
  // never be silently starved of scans -- absence from id-map is not
  // evidence the show has no new episodes.
  const shows = [{ show_id: "unmapped-show", feed_url: "https://u.example/feed" }];
  const idMap = {}; // "unmapped-show" not present
  const changedIds = new Set([]);
  assert.deepStrictEqual(selectChangedCuratedShows(shows, idMap, changedIds), shows);
});

test("selectChangedCuratedShows drops a curated show with no feed_url regardless of change state", () => {
  const shows = [{ show_id: "a", feed_url: null }];
  const idMap = { a: 10 };
  const changedIds = new Set([10]);
  assert.deepStrictEqual(selectChangedCuratedShows(shows, idMap, changedIds), []);
});

test("selectChangedCuratedShows handles a mix of changed, unchanged, and unmapped shows", () => {
  const shows = [
    { show_id: "changed", feed_url: "https://c.example/feed" },
    { show_id: "unchanged", feed_url: "https://u.example/feed" },
    { show_id: "unmapped", feed_url: "https://m.example/feed" },
    { show_id: "no-feed", feed_url: null },
  ];
  const idMap = { changed: 1, unchanged: 2 };
  const changedIds = new Set([1]);
  const result = selectChangedCuratedShows(shows, idMap, changedIds);
  assert.deepStrictEqual(result.map((s) => s.show_id).sort(), ["changed", "unmapped"]);
});

/* ---------- curationCandidates ---------- */

test("curationCandidates returns changed, non-curated rows from top.json, preserving popularity order", () => {
  const topRows = [
    { id: 1, t: "Curated Show", a: "Author 1", c: true },
    { id: 2, t: "Popular Non-Curated", a: "Author 2", c: false },
    { id: 3, t: "Less Popular Non-Curated", a: "Author 3", c: false },
  ];
  const changedIds = new Set([2, 3]);
  const result = curationCandidates(topRows, changedIds);
  assert.deepStrictEqual(result, [
    { id: 2, title: "Popular Non-Curated", author: "Author 2", rank: 1 },
    { id: 3, title: "Less Popular Non-Curated", author: "Author 3", rank: 2 },
  ]);
});

test("curationCandidates excludes curated rows even if they changed", () => {
  const topRows = [{ id: 1, t: "Curated", c: true }];
  const changedIds = new Set([1]);
  assert.deepStrictEqual(curationCandidates(topRows, changedIds), []);
});

test("curationCandidates excludes non-curated rows that did not change", () => {
  const topRows = [{ id: 2, t: "Quiet Show", c: false }];
  const changedIds = new Set([999]);
  assert.deepStrictEqual(curationCandidates(topRows, changedIds), []);
});

test("curationCandidates respects the limit option", () => {
  const topRows = Array.from({ length: 10 }, (_, i) => ({ id: i, t: `Show ${i}`, c: false }));
  const changedIds = new Set(topRows.map((r) => r.id));
  const result = curationCandidates(topRows, changedIds, { limit: 3 });
  assert.equal(result.length, 3);
  assert.deepStrictEqual(result.map((r) => r.id), [0, 1, 2]);
});

test("curationCandidates records rank as position in the untouched top.json list, not the filtered output", () => {
  const topRows = [
    { id: 1, t: "Curated", c: true },       // rank 0, filtered out
    { id: 2, t: "Candidate A", c: false },  // rank 1
    { id: 3, t: "Curated 2", c: true },     // rank 2, filtered out
    { id: 4, t: "Candidate B", c: false },  // rank 3
  ];
  const changedIds = new Set([2, 4]);
  const result = curationCandidates(topRows, changedIds);
  assert.deepStrictEqual(result.map((r) => r.rank), [1, 3]);
});
