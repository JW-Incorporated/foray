/* shard-build unit tests — manifest/shards/top/changed/id-map shapes,
   size budgets, id-map fail-closed behaviour. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChanged, buildIdMap, buildShards, buildTop,
  normalizePrefixKey, tokenPrefixesFor, toShardRow,
} from "./shard-build.mjs";

test("normalizePrefixKey: passes through clean 2-char a-z0-9", () => {
  assert.equal(normalizePrefixKey("fr"), "fr");
  assert.equal(normalizePrefixKey("a1"), "a1");
});

test("normalizePrefixKey: single char pads with underscore", () => {
  assert.equal(normalizePrefixKey("a"), "a_");
});

test("normalizePrefixKey: anything else collapses to __", () => {
  assert.equal(normalizePrefixKey(""), "__");
});

test("tokenPrefixesFor: 'fridman' yields shard 'fr' (the plan's own example)", () => {
  const prefixes = tokenPrefixesFor({ title: "Lex Fridman Podcast", itunesAuthor: "Lex Fridman" });
  assert.ok(prefixes.includes("fr"));
  assert.ok(prefixes.includes("le"));
  assert.ok(prefixes.includes("po"));
});

test("tokenPrefixesFor: accents normalise the same as dedupe's normalizeKey", () => {
  const prefixes = tokenPrefixesFor({ title: "Café Talk", itunesAuthor: "" });
  assert.ok(prefixes.includes("ca"));
});

test("toShardRow: shape matches the plan's compact keys", () => {
  const row = toShardRow(
    { id: 5, title: "T", itunesAuthor: "A", itunesId: 9, url: "https://x", imageUrl: "https://img", episodeCount: 12 },
    { curated: true },
  );
  assert.deepEqual(row, { id: 5, t: "T", a: "A", i: 9, u: "https://x", img: "https://img", n: 12, c: true });
});

test("buildShards: a row appears in the shard for every token prefix in title+author", () => {
  const rows = [{ id: 1, title: "Science Friday", itunesAuthor: "WNYC", popularityScore: 10, episodeCount: 5 }];
  const shards = buildShards(rows, new Set());
  assert.ok(shards.has("sc")); // science
  assert.ok(shards.has("fr")); // friday
  assert.ok(shards.has("wn")); // wnyc
});

test("buildShards: sorted by popularity desc within a shard, id tiebreak", () => {
  const rows = [
    { id: 1, title: "Alpha Show", itunesAuthor: "", popularityScore: 5 },
    { id: 2, title: "Alpha Two", itunesAuthor: "", popularityScore: 50 },
    { id: 3, title: "Alpha Three", itunesAuthor: "", popularityScore: 50 },
  ];
  const shards = buildShards(rows, new Set());
  const al = shards.get("al").map((r) => r.id);
  assert.deepEqual(al, [2, 3, 1]); // 50s first (id tiebreak 2<3), then 5
});

test("buildTop: curated rows are never displaced by the popularity cap", () => {
  const curated = { id: 1, title: "Curated Show", itunesAuthor: "", popularityScore: 0, episodeCount: 1 };
  const rest = Array.from({ length: 5 }, (_, i) => ({
    id: 100 + i, title: `Rest ${i}`, itunesAuthor: "", popularityScore: 100 - i, episodeCount: 1,
  }));
  const top = buildTop([curated, ...rest], new Set([1]), 2);
  const ids = top.map((r) => r.id);
  assert.ok(ids.includes(1), "curated show must always be present");
  assert.equal(top.length, 1 + 2); // curated + topN cap
});

test("buildChanged: a row absent from the previous snapshot counts as changed", () => {
  const rows = [{ id: 1, newestItemPubdate: 100 }];
  const changed = buildChanged(rows, {});
  assert.deepEqual(changed, [1]);
});

test("buildChanged: only rows whose newestItemPubdate advanced are reported", () => {
  const rows = [
    { id: 1, newestItemPubdate: 100 }, // unchanged
    { id: 2, newestItemPubdate: 200 }, // advanced
    { id: 3, newestItemPubdate: 50 },  // went backwards -> not changed
  ];
  const prev = { 1: 100, 2: 150, 3: 100 };
  const changed = buildChanged(rows, prev);
  assert.deepEqual(changed, [2]);
});

test("buildIdMap: matches curated shows by normalised feed_url", () => {
  const canonical = [{ id: 42, url: "https://feeds.example.com/show/", itunesId: null }];
  const curated = [{ show_id: "example-show", title: "Example Show", feed_url: "HTTPS://FEEDS.EXAMPLE.COM/show" }];
  const { idMap, missing } = buildIdMap(canonical, curated);
  assert.deepEqual(idMap, { "example-show": 42 });
  assert.deepEqual(missing, []);
});

test("buildIdMap: falls back to apple_collection_id === itunesId when feed_url doesn't match", () => {
  const canonical = [{ id: 42, url: "https://moved.example.com/feed", itunesId: 9999 }];
  const curated = [{ show_id: "moved-show", title: "Moved Show", feed_url: "https://old.example.com/feed", apple_collection_id: 9999 }];
  const { idMap, missing } = buildIdMap(canonical, curated);
  assert.deepEqual(idMap, { "moved-show": 42 });
  assert.deepEqual(missing, []);
});

test("buildIdMap: fails closed — an unresolvable curated show is named in `missing`, never silently dropped", () => {
  const canonical = [{ id: 1, url: "https://a.example.com/feed", itunesId: null }];
  const curated = [
    { show_id: "found-show", title: "Found Show", feed_url: "https://a.example.com/feed" },
    { show_id: "lost-show", title: "Lost Show", feed_url: "https://nowhere.example.com/feed", apple_collection_id: null },
  ];
  const { idMap, missing } = buildIdMap(canonical, curated);
  assert.deepEqual(idMap, { "found-show": 1 });
  assert.equal(missing.length, 1);
  assert.deepEqual(missing[0], { show_id: "lost-show", title: "Lost Show" });
});
