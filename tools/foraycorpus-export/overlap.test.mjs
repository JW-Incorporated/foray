/* PKG-09 (docs/roadmap/corpus.md): breadth overlap of the export's shows
   rows (catalogue.mjs buildShows over the synthetic fixture: A itunes 111,
   B itunes null, D itunes 444, feeds feeds.example.org/{a,b,d}/rss) against
   breadth stubs shaped like data/catalog-breadth.json rows. The suite never
   reads data/: the stubs carry the real file's 18 row keys with invented
   values, and the CLI test writes its inputs to a tmp dir. No network, no
   database, no credential. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildShows } from "./catalogue.mjs";
import { computeOverlap } from "./overlap.mjs";
import { jsonlRowSource } from "./row-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "synthetic");
const KEYS = ["breadth_shows", "matched_by_itunes_id", "matched_by_feed_url_only", "unmatched"];

/** A data/catalog-breadth.json row (all 18 keys) with invented values. */
function breadthRow(overrides) {
  return {
    apple_collection_id: null,
    title: "Synthetic breadth show",
    feed_url: "https://breadth.example/feed",
    artwork_url: "https://breadth.example/art.jpg",
    apple_genre: "Technology",
    apple_genre_ids: ["1318", "26"],
    episode_count: 10,
    explicit: false,
    chart_genre_id: "1318",
    chart_genre_name: "Technology",
    chart_rank: 1,
    in_curated: false,
    podcastindex_id: null,
    tier: "breadth",
    region: "us",
    harvest_source: "apple-top-charts",
    harvested_at: "2026-07-09T00:00:00.000Z",
    taxonomy_node_ids: ["technology"],
    ...overrides,
  };
}

function breadthDoc(shows) {
  return { version: 1, built_at: "2026-07-09T00:00:00.000Z", region: "us", source: "synthetic", genre_count: 1, shows };
}

async function syntheticRows() {
  const { rows } = await buildShows(jsonlRowSource(FIXTURE), { catalog: { shows: [] } });
  return rows;
}

/* Show 1 matches A on BOTH itunes id and feed and counts once, as itunes.
   Show 2's id is unknown and its feed is B's, spelled with another scheme,
   case and a trailing slash, so it is a feed-only match through
   normalizeFeedUrl. Show 3 matches nothing.
   Mutation that turns this red: in overlap.mjs computeOverlap delete the
   `continue;` after `byItunes += 1;` (show 1 also counts as a feed match).
   That gives { 3, 1, 2, 0 }. */
test("a 3-show breadth stub vs the synthetic rows gives {3, 1, 1, 1}", async () => {
  const doc = breadthDoc([
    breadthRow({ apple_collection_id: 111, feed_url: "https://feeds.example.org/a/rss" }),
    breadthRow({ apple_collection_id: 999999, feed_url: "HTTP://Feeds.Example.org/b/rss/" }),
    breadthRow({ apple_collection_id: 555555, feed_url: "https://elsewhere.example/x" }),
  ]);
  assert.deepEqual(computeOverlap(await syntheticRows(), doc), {
    breadth_shows: 3,
    matched_by_itunes_id: 1,
    matched_by_feed_url_only: 1,
    unmatched: 1,
  });
});

/* B's itunes_id is null. A breadth row with a null, absent or blank
   apple_collection_id (and a feed nobody has) must not match it. The id
   comparison is a string, so pg's int8-as-string "444" matches the breadth
   file's number 444.
   Mutation that turns this red: in overlap.mjs computeOverlap add null ids
   too, `if (id !== null) itunesIds.add(id);` → `itunesIds.add(id);`. */
test("a missing apple_collection_id never matches a null itunes_id", async () => {
  const rows = await syntheticRows();
  const missing = breadthDoc([
    breadthRow({ apple_collection_id: null, feed_url: "https://nowhere.example/1" }),
    (({ apple_collection_id, ...rest }) => rest)(breadthRow({ feed_url: "https://nowhere.example/2" })),
    breadthRow({ apple_collection_id: "", feed_url: "https://nowhere.example/3" }),
  ]);
  assert.deepEqual(computeOverlap(rows, missing), { breadth_shows: 3, matched_by_itunes_id: 0, matched_by_feed_url_only: 0, unmatched: 3 });

  const asString = rows.map((r) => ({ ...r, itunes_id: r.itunes_id == null ? null : String(r.itunes_id) }));
  const numeric = breadthDoc([breadthRow({ apple_collection_id: 444, feed_url: "https://nowhere.example/4" })]);
  assert.equal(computeOverlap(asString, numeric).matched_by_itunes_id, 1);
});

/* The output keys are exactly these four, in this order, from the module
   and from the CLI (`--shows` + `--breadth`, run on tmp files), including
   for an empty breadth list.
   Mutation that turns this red: in overlap.mjs computeOverlap's return
   object move `unmatched` first. */
test("output keys are stable (module and CLI)", async () => {
  const rows = await syntheticRows();
  assert.deepEqual(Object.keys(computeOverlap(rows, breadthDoc([]))), KEYS);
  assert.deepEqual(Object.keys(computeOverlap([], [breadthRow({})])), KEYS);

  const dir = mkdtempSync(join(tmpdir(), "corpus-overlap-"));
  try {
    const showsPath = join(dir, "shows.jsonl");
    const breadthPath = join(dir, "breadth.json");
    writeFileSync(showsPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(breadthPath, JSON.stringify(breadthDoc([breadthRow({ apple_collection_id: 444 })])));
    const out = execFileSync(process.execPath, [join(HERE, "overlap.mjs"), "--shows", showsPath, "--breadth", breadthPath], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    assert.deepEqual(Object.keys(parsed), KEYS);
    assert.deepEqual(parsed, { breadth_shows: 1, matched_by_itunes_id: 1, matched_by_feed_url_only: 0, unmatched: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
