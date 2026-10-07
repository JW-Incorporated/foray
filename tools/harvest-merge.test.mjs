/* tools/harvest-merge.mjs — a re-harvest of data/catalog-breadth.json UNIONS
 * with the file it replaces instead of overwriting it.
 *
 * Why it is pinned: #1148 (PKG-14) re-harvested by overwrite and 6,632 shows
 * that had left every US chart since July lost their breadth row — their
 * server-search result, their breadth show page (shared links to which now
 * cold-open) and their topics. A merge that quietly regressed to "replace"
 * would pass every other suite, exactly as #1148 did.
 *
 * Every test names the mutation that kills it.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROW_KEYS, LOOKUP_BATCH, canonicalRow, mergeBreadthHarvest, rowsMissingArtist,
  backfillArtistNames, writeMergedHarvest,
} from "./harvest-merge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const JULY = "2026-07-09T15:00:00.000Z";
const OCT = "2026-10-07T00:30:00.000Z";

/* An old (pre-P-03a) row: no artist_name key, folded topics, a chart rank. */
const oldRow = (id, extra = {}) => ({
  apple_collection_id: id, title: `old-${id}`, feed_url: `https://old/${id}`, artwork_url: null,
  apple_genre: "History", apple_genre_ids: ["1487"], episode_count: 10, explicit: false,
  chart_genre_id: "1487", chart_genre_name: "History", chart_rank: 50, in_curated: false,
  podcastindex_id: null, tier: "breadth", region: "us", harvest_source: "apple-top-charts",
  harvested_at: JULY, taxonomy_node_ids: [`topic-${id}`], ...extra,
});
/* A row as the harvester writes it now. */
const freshRow = (id, rank, extra = {}) => ({
  apple_collection_id: id, title: `new-${id}`, feed_url: `https://new/${id}`, artwork_url: null,
  apple_genre: "History", apple_genre_ids: ["1487"], artist_name: `Artist ${id}`, episode_count: 20,
  explicit: false, chart_genre_id: "1487", chart_genre_name: "History", chart_rank: rank,
  last_charted_at: OCT, in_curated: false, podcastindex_id: null, tier: "breadth", region: "us",
  harvest_source: "apple-top-charts", harvested_at: OCT, ...extra,
});

const prevDoc = () => ({ version: 1, built_at: JULY, region: "us", shows: [oldRow(1), oldRow(2), oldRow(3)] });
const freshDoc = () => ({
  version: 1, built_at: OCT, regions: ["us"], source: "apple-top-charts+lookup", genre_count: 110,
  shows: [freshRow(2, 7), freshRow(4, 3)],
});
const byId = (doc) => new Map(doc.shows.map((s) => [s.apple_collection_id, s]));

test("a show that LEFT the charts is kept, not dropped", () => {
  /* The #1148 defect itself. Ids 1 and 3 are in the old file and in no chart.
     MUTATION: drop the "every old row the harvest did not see" loop (the
     pre-2026-10-07 replace behaviour) -> ids 1 and 3 vanish, total 2. */
  const { doc, stats } = mergeBreadthHarvest(prevDoc(), freshDoc());
  assert.deepStrictEqual(doc.shows.map((s) => s.apple_collection_id).sort(), [1, 2, 3, 4]);
  assert.strictEqual(stats.kept_off_chart, 2);
  assert.strictEqual(stats.total, 4);
  assert.strictEqual(byId(doc).get(1).title, "old-1", "and it keeps its own metadata");
});

test("a kept show's chart_rank is nulled, and last_charted_at says when it last charted", () => {
  /* A show off every chart has no position; carrying July's 50 would rank a
     dead entry as if it charted today (every consumer bands null as UNRANKED).
     MUTATION: keep `old.chart_rank` -> 50 survives. MUTATION: set
     last_charted_at to the new harvest's time (or drop it) -> not JULY. */
  const kept = byId(mergeBreadthHarvest(prevDoc(), freshDoc()).doc).get(1);
  assert.strictEqual(kept.chart_rank, null);
  assert.strictEqual(kept.last_charted_at, JULY, "a pre-merge row's harvested_at is when it was seen charting");
  assert.strictEqual(kept.harvested_at, JULY, "harvested_at stays the last metadata fetch");
  assert.strictEqual(kept.chart_genre_name, "History", "the chart it was last on is kept (a classifier genre signal)");
});

test("a kept show keeps its topics", () => {
  /* taxonomy_node_ids is folded AFTER a harvest and the harvester never writes
     it; a kept row must not lose it. MUTATION: rebuild kept rows from ROW_KEYS
     only (dropping unknown keys) -> taxonomy_node_ids is undefined. */
  const kept = byId(mergeBreadthHarvest(prevDoc(), freshDoc()).doc).get(3);
  assert.deepStrictEqual(kept.taxonomy_node_ids, ["topic-3"]);
});

test("a show new to the charts is added", () => {
  /* MUTATION: only refresh ids the old file already had (`if (!old) continue`)
     -> id 4 is missing and stats.added is 0. */
  const { doc, stats } = mergeBreadthHarvest(prevDoc(), freshDoc());
  const added = byId(doc).get(4);
  assert.ok(added, "id 4 must be in the merged file");
  assert.strictEqual(added.chart_rank, 3);
  assert.strictEqual(added.last_charted_at, OCT);
  assert.strictEqual(stats.added, 1);
});

test("a show still charting gets the fresh fields, and keeps fields the harvest does not write", () => {
  /* MUTATION: spread in the wrong order (`{ ...row, ...old }`) -> rank 50,
     title "old-2", no artist_name. MUTATION: build the refreshed row from the
     fresh row alone -> its topics are lost until the next fold. */
  const { doc, stats } = mergeBreadthHarvest(prevDoc(), freshDoc());
  const refreshed = byId(doc).get(2);
  assert.strictEqual(refreshed.chart_rank, 7);
  assert.strictEqual(refreshed.title, "new-2");
  assert.strictEqual(refreshed.artist_name, "Artist 2");
  assert.strictEqual(refreshed.episode_count, 20);
  assert.strictEqual(refreshed.last_charted_at, OCT);
  assert.strictEqual(refreshed.harvested_at, OCT);
  assert.deepStrictEqual(refreshed.taxonomy_node_ids, ["topic-2"], "carried from the old row");
  assert.strictEqual(stats.refreshed, 1);
});

test("a show off the charts twice keeps its FIRST last_charted_at, not the harvest that missed it", () => {
  /* Second-generation merge: the old row already says when it last charted.
     MUTATION: always use `prev.harvested_at` -> it would read the row's own
     metadata time instead. A rankless row with no record gets null, not a
     guess. MUTATION: fall back to harvested_at regardless of rank -> JULY. */
  const prev = { shows: [
    oldRow(1, { chart_rank: null, last_charted_at: "2026-04-01T00:00:00.000Z", harvested_at: JULY }),
    oldRow(5, { chart_rank: null }), // written by some other path, never seen charting
  ] };
  const m = byId(mergeBreadthHarvest(prev, freshDoc()).doc);
  assert.strictEqual(m.get(1).last_charted_at, "2026-04-01T00:00:00.000Z");
  assert.strictEqual(m.get(5).last_charted_at, null);
});

test("in_curated is recomputed on every row, kept rows included", () => {
  /* A show promoted to curated after it fell off the charts must not ship a
     breadth twin beside its curated row (both builders skip `in_curated`).
     MUTATION: recompute only on fresh rows -> kept id 1 stays false. */
  const prev = prevDoc();
  prev.shows[2].in_curated = true; // id 3 was curated in July, is not any more
  const m = byId(mergeBreadthHarvest(prev, freshDoc(), { curatedIds: new Set([1, 4]) }).doc);
  assert.strictEqual(m.get(1).in_curated, true);
  assert.strictEqual(m.get(3).in_curated, false);
  assert.strictEqual(m.get(4).in_curated, true);
  assert.strictEqual(m.get(2).in_curated, false);
});

test("rows come out in one canonical key order whichever path wrote them", () => {
  /* So a row's bytes do not depend on whether it was refreshed, added or
     kept. MUTATION: skip canonicalRow in `finish` -> the refreshed row starts
     with the old row's key order and the kept row has last_charted_at last. */
  const { doc } = mergeBreadthHarvest(prevDoc(), freshDoc());
  for (const row of doc.shows) {
    const keys = Object.keys(row).filter((k) => ROW_KEYS.includes(k));
    assert.deepStrictEqual(keys, ROW_KEYS.filter((k) => k in row), `row ${row.apple_collection_id}`);
  }
  assert.deepStrictEqual(Object.keys(canonicalRow({ z: 1, chart_rank: 2, apple_collection_id: 3 })),
    ["apple_collection_id", "chart_rank", "z"]);
});

test("the document head is the fresh harvest's; a malformed previous file is refused", () => {
  /* MUTATION: treat an unparseable/shapeless previous file as empty -> the
     merge "succeeds" and silently drops everything it held (#1148 again). */
  const { doc } = mergeBreadthHarvest(prevDoc(), freshDoc());
  assert.strictEqual(doc.built_at, OCT);
  assert.deepStrictEqual(doc.regions, ["us"]);
  assert.throws(() => mergeBreadthHarvest({ nope: [] }, freshDoc()), /refusing to merge/);
  assert.strictEqual(mergeBreadthHarvest(null, freshDoc()).doc.shows.length, 2, "no previous file = first harvest");
});

test("artist_name backfill: only rows without the key, batched, null for an id Apple no longer returns", async () => {
  /* MUTATION: select rows where `!s.artist_name` -> the fresh rows (and any
     row Apple answered with null) are looked up again every run.
     MUTATION: leave unanswered ids without the key -> they are re-requested
     forever. */
  const { doc } = mergeBreadthHarvest(prevDoc(), freshDoc());
  const missing = rowsMissingArtist(doc);
  assert.deepStrictEqual(missing.map((s) => s.apple_collection_id).sort(), [1, 3]);
  const urls = [];
  const counts = await backfillArtistNames(missing, async (url) => {
    urls.push(url);
    return { results: [{ kind: "podcast", collectionId: 1, artistName: "Someone" }] };
  });
  assert.strictEqual(urls.length, 1);
  assert.match(urls[0], /lookup\?id=1,3&entity=podcast$/);
  const m = byId(doc);
  assert.strictEqual(m.get(1).artist_name, "Someone");
  assert.strictEqual(m.get(3).artist_name, null);
  assert.deepStrictEqual(counts, { requests: 1, failed_batches: 0, filled: 1, absent: 1 });
  assert.strictEqual(rowsMissingArtist(doc).length, 0);
});

test("artist_name backfill: LOOKUP_BATCH ids per request, a failed batch leaves its rows for next time", async () => {
  /* MUTATION: one request per id -> requests = n. MUTATION: mark a failed
     batch's rows null -> they are never retried. */
  const rows = Array.from({ length: LOOKUP_BATCH + 1 }, (_, i) => ({ apple_collection_id: 1000 + i }));
  let calls = 0;
  const counts = await backfillArtistNames(rows, async () => {
    if (++calls === 2) throw new Error("boom");
    return { results: [] };
  });
  assert.strictEqual(counts.requests, 2);
  assert.strictEqual(counts.failed_batches, 1);
  assert.ok(!("artist_name" in rows[LOOKUP_BATCH]), "the failed batch's row keeps no key");
  assert.strictEqual(rows[0].artist_name, null);
});

test("the harvester's write step merges into the existing file, and --replace overwrites", async () => {
  /* The wiring tools/harvest-catalog.mjs calls. MUTATION: write `harvest`
     directly (ignore the existing file) -> 2 rows, not 4. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-merge-"));
  try {
    const out = path.join(dir, "breadth.json");
    fs.writeFileSync(out, JSON.stringify(prevDoc()) + "\n");
    const lookups = [];
    const fetchJson = async (url) => { lookups.push(url); return { results: [] }; };
    const doc = await writeMergedHarvest(freshDoc(), { outPath: out, fetchJson, log: () => {} });
    const raw = fs.readFileSync(out, "utf8");
    assert.strictEqual(raw, JSON.stringify(doc) + "\n", "single line + newline, the fold's byte-stable form");
    assert.strictEqual(JSON.parse(raw).shows.length, 4);
    assert.strictEqual(lookups.length, 1, "kept pre-P-03a rows get one artist_name lookup batch");

    fs.writeFileSync(out, JSON.stringify(prevDoc()) + "\n");
    await writeMergedHarvest(freshDoc(), { outPath: out, replace: true, fetchJson, log: () => {} });
    assert.strictEqual(JSON.parse(fs.readFileSync(out, "utf8")).shows.length, 2);

    fs.writeFileSync(out, "{not json");
    await assert.rejects(writeMergedHarvest(freshDoc(), { outPath: out, fetchJson, log: () => {} }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const harvester = fs.readFileSync(path.join(ROOT, "tools", "harvest-catalog.mjs"), "utf8");
  assert.match(harvester, /await writeMergedHarvest\(harvest, \{ outPath, replace,/,
    "tools/harvest-catalog.mjs must write through writeMergedHarvest");
});

test("REAL DATA: the committed breadth file kept the shows #1148 dropped, each dated", () => {
  /* The union is monotone (nothing is ever removed by a re-harvest), so the
     row count can only grow from the 26,340 of the 2026-10-07 repair. Every
     rankless row says when it last charted, and every row carries the
     artist_name key (null = Apple had none).
     MUTATION: re-run the harvester with --replace and commit -> ~19.7k rows. */
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "catalog-breadth.json"), "utf8"));
  assert.ok(doc.shows.length >= 26_340, `expected >= 26,340 rows, saw ${doc.shows.length}`);
  const ids = new Set(doc.shows.map((s) => s.apple_collection_id));
  assert.strictEqual(ids.size, doc.shows.length, "apple_collection_id stays unique");
  for (const s of doc.shows) {
    if (s.chart_rank === null) assert.ok(s.last_charted_at, `off-chart row ${s.apple_collection_id} has no last_charted_at`);
    assert.ok("artist_name" in s, `row ${s.apple_collection_id} has no artist_name key`);
  }
});
