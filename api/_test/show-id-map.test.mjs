// api/_lib/showIdMap.ts — the Apple collectionId -> 4a show_id map behind
// api/episodes/search.ts's Apple fallback (code-health-2 CH2-02, A1-01).
//
// The two committed catalogue files are the map's only source, read through
// api/_lib/showCatalog.ts (code-health-2 CH2-24). These pins are about the
// source and its agreement with the show lookup, not the merge rule: the
// curated-first merge and the in_curated skip are pinned in
// episodes-search.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadShowIdMap } from "../_lib/showIdMap.ts";
import { showById } from "../_lib/showCatalog.ts";
import { buildIdMap } from "../../tools/shows/shard-build.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readData = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", name), "utf8"));
const CATALOG = readData("catalog.json");
const BREADTH = readData("catalog-breadth.json");
const POINTER = readData("shows-index-pointer.json");

/** Runs `run` with globalThis.fetch replaced by a stub that records every
    call and throws. */
async function withThrowingFetch(run) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error("showIdMap must not touch the network");
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("the committed pointer names no id-map: the premise of a catalogue-only map", () => {
  /* If someone teaches tools/shows/publish-release.mjs:buildPointer to write
     an id-map URL, this goes red first and points at the shape pin below. */
  assert.ok(POINTER.shards_published, "premise: main carries a published shows-index pointer");
  assert.deepEqual(Object.keys(POINTER).filter((k) => /id.?map/i.test(k)), [], "the pointer names no id-map asset");
});

test("the map is built from the two committed catalogue files", async () => {
  await withThrowingFetch(async () => {
    const map = await loadShowIdMap();
    assert.equal(map.source, "catalog");

    const curated = CATALOG.shows.find((s) => s.show_id && typeof s.apple_collection_id === "number");
    assert.equal(map.byCollectionId.get(curated.apple_collection_id), curated.show_id, "a curated show maps to its slug");

    const curatedIds = new Set(CATALOG.shows.map((s) => s.apple_collection_id));
    const breadth = BREADTH.shows.find(
      (s) => !s.in_curated && s.title && typeof s.apple_collection_id === "number" && !curatedIds.has(s.apple_collection_id)
    );
    assert.equal(map.byCollectionId.get(breadth.apple_collection_id), String(breadth.apple_collection_id), "a breadth show maps to its numeric id");
  });
});

test("loading the map makes no network call, and a throwing fetch cannot fail it", async () => {
  /* MUTATION: re-add a fetch of the pointer's id-map URL to loadShowIdMap
     (`await fetch(pointer.<id-map url>)`) — the stub records the call and
     throws, and this goes red. */
  await withThrowingFetch(async (calls) => {
    const first = await loadShowIdMap();
    const again = await loadShowIdMap();
    assert.ok(first.byCollectionId.size > 0);
    assert.equal(again.byCollectionId, first.byCollectionId, "memoised per warm instance (by showCatalog.ts)");
    assert.deepEqual(calls, []);
  });
});

test("every show_id the map hands out is one the show lookup answers (CH2-24)", async () => {
  /* The map and the show lookup are one catalogue now, so an Apple hit links
     to the id its show page is served under. MUTATION: in breadthCatalog.ts
     map every breadth row to its own number, `in_curated` too
     (`showIdByAppleId.set(id, id)` above the `in_curated` skip) -> 175 Apple
     hits link to a numeric id the lookup answers as a DIFFERENT id (the
     twin's slug), and this is red. */
  const map = await loadShowIdMap();
  const dead = [...map.byCollectionId].filter(([, showId]) => showById(showId)?.show_id !== showId);
  assert.deepEqual(dead.slice(0, 5), [], `${dead.length} mapped show_ids resolve to nothing`);
});

test("the released id-map.json is slug -> pi_id, not an Apple collectionId -> show_id map", () => {
  /* A1-01: tools/shows/shard-build.mjs:buildIdMap writes curated slug ->
     PodcastIndex id. Read as collectionId -> show_id it has no numeric key
     and no string value, so it maps nothing (the deleted release reader
     answered `map: null, failed: true` and retried every 10 minutes). This
     records the mismatch so nobody wires the release id-map into showIdMap. */
  const curated = [
    { show_id: "the-daily", feed_url: "https://feeds.example.test/daily.xml", apple_collection_id: 1200361736 },
    { show_id: "huberman-lab", feed_url: "https://feeds.example.test/huberman.xml", apple_collection_id: 1545953110 },
  ];
  const canonical = [
    { id: 5001, url: "https://feeds.example.test/daily.xml", itunesId: 1200361736 },
    { id: 5002, url: "https://other.example.test/hl.xml", itunesId: 1545953110 },
  ];
  const { idMap, missing } = buildIdMap(canonical, curated);
  assert.deepEqual(missing, []);
  assert.deepEqual(idMap, { "the-daily": 5001, "huberman-lab": 5002 });
  for (const [key, value] of Object.entries(idMap)) {
    assert.equal(Number.isFinite(Number(key)), false, `${key} is a slug, not an Apple collectionId`);
    assert.equal(typeof value, "number", `${key}'s value is a pi_id, not a show_id`);
  }
});
