/* D13 dedupe unit tests. */
import test from "node:test";
import assert from "node:assert/strict";
import { applyD13Dedupe, groupKeyFor, normalizeKey, pickCanonical } from "./dedupe.mjs";

test("normalizeKey: case, whitespace and punctuation collapse the same way", () => {
  assert.equal(normalizeKey("The Daily: News"), normalizeKey("the daily   news"));
  assert.equal(normalizeKey("Café Society"), normalizeKey("cafe society"));
});

test("groupKeyFor: podcastGuid path wins when present", () => {
  const { key, kind } = groupKeyFor({ podcastGuid: "ABC-123", title: "X", itunesAuthor: "Y" });
  assert.equal(kind, "guid");
  assert.equal(key, "guid:abc-123");
});

test("groupKeyFor: falls back to normalised title+author when guid absent", () => {
  const { key, kind } = groupKeyFor({ podcastGuid: "", title: "The Show", itunesAuthor: "Jane Doe" });
  assert.equal(kind, "title_author");
  assert.equal(key, "ta:the show|jane doe");
});

test("pickCanonical: prefers the row with a non-null itunesId", () => {
  const group = [
    { id: 1, itunesId: null, newestItemPubdate: 200 },
    { id: 2, itunesId: 555, newestItemPubdate: 100 },
  ];
  const winner = pickCanonical(group);
  assert.equal(winner.id, 2);
});

test("pickCanonical: falls back to newest when nobody has itunesId", () => {
  const group = [
    { id: 1, itunesId: null, newestItemPubdate: 100 },
    { id: 2, itunesId: null, newestItemPubdate: 300 },
    { id: 3, itunesId: 0, newestItemPubdate: 50 }, // 0 treated as no itunesId
  ];
  const winner = pickCanonical(group);
  assert.equal(winner.id, 2);
});

test("pickCanonical: ties broken deterministically by lowest id", () => {
  const group = [
    { id: 5, itunesId: null, newestItemPubdate: 100 },
    { id: 2, itunesId: null, newestItemPubdate: 100 },
  ];
  assert.equal(pickCanonical(group).id, 2);

  const withItunes = [
    { id: 7, itunesId: 1, newestItemPubdate: 1 },
    { id: 3, itunesId: 2, newestItemPubdate: 1 },
  ];
  assert.equal(pickCanonical(withItunes).id, 3);
});

test("applyD13Dedupe: guid path collapses duplicates and counts groups correctly", () => {
  const rows = [
    { id: 1, podcastGuid: "g-1", title: "A", itunesId: null, newestItemPubdate: 10 },
    { id: 2, podcastGuid: "g-1", title: "A (mirror)", itunesId: 42, newestItemPubdate: 5 },
    { id: 3, podcastGuid: "g-2", title: "B", itunesId: null, newestItemPubdate: 1 },
  ];
  const { canonical, counts } = applyD13Dedupe(rows);
  assert.equal(canonical.length, 2);
  assert.equal(counts.input_rows, 3);
  assert.equal(counts.groups, 2);
  assert.equal(counts.guid_groups, 2);
  assert.equal(counts.title_author_groups, 0);
  assert.equal(counts.duplicates_collapsed, 1);
  // group g-1 canonical should be id 2 (has itunesId)
  assert.ok(canonical.find((r) => r.id === 2));
  assert.ok(!canonical.find((r) => r.id === 1));
});

test("applyD13Dedupe: title+author fallback path when no guid", () => {
  const rows = [
    { id: 10, podcastGuid: "", title: "Same Show", itunesAuthor: "Host", itunesId: null, newestItemPubdate: 1 },
    { id: 11, podcastGuid: "", title: "same show", itunesAuthor: "host", itunesId: null, newestItemPubdate: 99 },
  ];
  const { canonical, counts } = applyD13Dedupe(rows);
  assert.equal(canonical.length, 1);
  assert.equal(counts.title_author_groups, 1);
  assert.equal(canonical[0].id, 11); // newer wins, no itunesId anywhere
});

test("applyD13Dedupe: output is sorted by id and deterministic across shuffled input", () => {
  const rows = [
    { id: 3, podcastGuid: "g3", title: "C", itunesId: null, newestItemPubdate: 1 },
    { id: 1, podcastGuid: "g1", title: "A", itunesId: null, newestItemPubdate: 1 },
    { id: 2, podcastGuid: "g2", title: "B", itunesId: null, newestItemPubdate: 1 },
  ];
  const a = applyD13Dedupe(rows).canonical.map((r) => r.id);
  const b = applyD13Dedupe([...rows].reverse()).canonical.map((r) => r.id);
  assert.deepEqual(a, [1, 2, 3]);
  assert.deepEqual(b, [1, 2, 3]);
});
