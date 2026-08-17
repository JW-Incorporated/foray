/* Tests for tools/classify-breadth.mjs — the BASE (genre-map) layer of
   data/breadth-classification.json.
 *
 * The behaviour under test that actually matters is precedence: this script
 * used to rebuild `entries` from scratch, so one re-run would have deleted
 * every agent-authored classification in the file. Half of these tests exist
 * to keep that from coming back, because the failure is invisible — the file
 * stays valid JSON, CI stays green, and the shows just quietly lose their
 * good tags. */

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "classify-breadth.mjs");

const TAXONOMY = {
  version: 1,
  nodes: [
    { id: "space", parent: null },
    { id: "space/astronomy", parent: "space" },
    { id: "science", parent: null },
    { id: "food", parent: null },
    { id: "food/baking", parent: "food" },
  ],
};

const GENRE_MAP = {
  version: 1,
  map: {
    Astronomy: { topics: ["space/astronomy", "space", "science"], confidence: "high" },
    Food: { topics: ["food"], confidence: "high" },
    Science: { topics: ["science"], confidence: "medium" },
    // Adds a CHILD to the food branch — the upgrade case.
    Baking: { topics: ["food/baking", "food"], confidence: "high" },
    // Adds only another bare ROOT — the case an upgrade must decline.
    Nutrition: { topics: ["food", "science"], confidence: "high" },
  },
};

function show(id, genre, chartGenre = genre) {
  return { apple_collection_id: id, title: `show-${id}`, apple_genre: genre, chart_genre_name: chartGenre };
}

/** Writes a fixture dir and runs the script against it. */
function run({ shows, classification, genreMap = GENRE_MAP, taxonomy = TAXONOMY, args = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "classify-breadth-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  const p = (f) => join(dir, "data", f);
  writeFileSync(p("catalog.json"), JSON.stringify({ shows }));
  writeFileSync(p("genre-map.json"), JSON.stringify(genreMap));
  writeFileSync(p("taxonomy.json"), JSON.stringify(taxonomy));
  if (classification) writeFileSync(p("classification.json"), JSON.stringify(classification, null, 2) + "\n");

  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CATALOG_BREADTH_PATH: p("catalog.json"),
      GENRE_MAP_PATH: p("genre-map.json"),
      TAXONOMY_PATH: p("taxonomy.json"),
      BREADTH_CLASSIFICATION_PATH: p("classification.json"),
    },
  });
  const out = existsSync(p("classification.json")) ? JSON.parse(readFileSync(p("classification.json"), "utf8")) : null;
  return { res, out, path: p("classification.json") };
}

test("classifies a show whose genre is in the map", () => {
  const { res, out } = run({ shows: [show(1, "Astronomy")] });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(out.entries["1"].topics, ["space/astronomy", "space", "science"]);
  assert.equal(out.entries["1"].source, "genre-map");
});

test("emits the child node ahead of its parent, in map order", () => {
  const { out } = run({ shows: [show(1, "Astronomy")] });
  const t = out.entries["1"].topics;
  assert.ok(t.indexOf("space/astronomy") < t.indexOf("space"), "child must lead its parent: " + t.join());
  assert.deepEqual(t, GENRE_MAP.map.Astronomy.topics, "order follows the map, not insertion luck");
});

test("writes no entry for a show whose genre is not in the map, and warns", () => {
  const { res, out } = run({ shows: [show(1, "Underwater Basketweaving")] });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(out.entries["1"], undefined);
  assert.match(res.stderr + res.stdout, /UNMAPPED GENRES/);
});

test("takes the LOWEST confidence across apple_genre and chart_genre_name", () => {
  const { out } = run({ shows: [show(1, "Astronomy", "Science")] });
  assert.equal(out.entries["1"].confidence, "medium");
});

test("fails loudly, and writes nothing, when the map points at a non-taxonomy node", () => {
  const genreMap = { version: 1, map: { Food: { topics: ["food/grilling-bbq"], confidence: "high" } } };
  const { res, out } = run({ shows: [show(1, "Food")], genreMap });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /STALE GENRE MAP/);
  assert.match(res.stderr, /food\/grilling-bbq/);
  assert.equal(out, null, "nothing should have been written");
});

test("preserves a classify-agent-tier1 entry instead of overwriting it", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["food/baking"], confidence: "high", source: "classify-agent-tier1", rationale: "real signal" } },
  };
  const { res, out } = run({ shows: [show(1, "Food")], classification });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(out.entries["1"].topics, ["food/baking"]);
  assert.equal(out.entries["1"].source, "classify-agent-tier1");
  assert.equal(out.entries["1"].rationale, "real signal");
});

test("preserves a classify-agent-tier2 entry", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["food/baking"], confidence: "high", source: "classify-agent-tier2" } },
  };
  const { out } = run({ shows: [show(1, "Food")], classification });
  assert.equal(out.entries["1"].source, "classify-agent-tier2");
});

test("preserves an llm-title-genre entry that knows something the map does not", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["food/baking"], confidence: "medium", source: "llm-title-genre" } },
  };
  const { out } = run({ shows: [show(1, "Food")], classification });
  assert.equal(out.entries["1"].source, "llm-title-genre");
  assert.deepEqual(out.entries["1"].topics, ["food/baking"]);
});

test("enriches a lower-trust overlay in place when the map names a child of its bare root", () => {
  const classification = {
    version: 1,
    entries: {
      1: { topics: ["food"], confidence: "medium", source: "llm-title-genre", by: "breadth-refine-3", rationale: "kept" },
    },
  };
  const { res, out } = run({ shows: [show(1, "Baking")], classification });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(out.entries["1"].topics, ["food/baking", "food"], "child inserted ahead of its bare parent");
  assert.equal(out.entries["1"].source, "llm-title-genre", "the overlay still owns the entry");
  assert.equal(out.entries["1"].confidence, "medium", "the base layer does not restate the overlay's confidence");
  assert.equal(out.entries["1"].by, "breadth-refine-3", "every other field the overlay carried survives");
  assert.equal(out.entries["1"].rationale, "kept");
  assert.equal(out.entries["1"].enriched_by, "genre-map");
  assert.deepEqual(out.entries["1"].enriched_nodes, ["food/baking"]);
  assert.match(res.stdout, /1 overlay entries enriched in place/);
});

test("enrichment adds ONLY the fixing child, never the map's other branches", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["food"], confidence: "medium", source: "llm-title-genre" } },
  };
  // Carries food/baking (the fix) plus a bare `science` that must not ride along.
  const genreMap = {
    version: 1,
    map: { "Cake Science": { topics: ["food/baking", "food", "science"], confidence: "high" } },
  };
  const { out } = run({ shows: [show(1, "Cake Science")], classification, genreMap });
  assert.deepEqual(out.entries["1"].topics, ["food/baking", "food"], "a bare `science` is not an enrichment");
  assert.deepEqual(out.entries["1"].enriched_nodes, ["food/baking"]);
});

test("declines to touch an overlay when the map only offers another bare root", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["food"], confidence: "medium", source: "llm-title-genre" } },
  };
  const { out } = run({ shows: [show(1, "Nutrition")], classification });
  assert.deepEqual(out.entries["1"].topics, ["food"]);
  assert.equal(out.entries["1"].source, "llm-title-genre");
  assert.equal(out.entries["1"].enriched_by, undefined);
});

test("never enriches a classify-agent entry, even when the map has a child to add", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["food"], confidence: "high", source: "classify-agent-tier1" } },
  };
  const { out } = run({ shows: [show(1, "Baking")], classification });
  assert.deepEqual(out.entries["1"].topics, ["food"]);
  assert.equal(out.entries["1"].source, "classify-agent-tier1");
  assert.equal(out.entries["1"].enriched_by, undefined);
});

test("an entry with NO source field is protected exactly like a named overlay", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["food/baking", "food"], confidence: "high", display_title: "Pastry Arts" } },
  };
  const { res, out } = run({ shows: [show(1, "Food")], classification });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(out.entries["1"].topics, ["food/baking", "food"], "a sourceless entry is still somebody's work");
  assert.equal(out.entries["1"].display_title, "Pastry Arts");
  assert.equal(out.entries["1"].source, undefined, "and it is not re-sourced to the base layer");
  assert.match(res.stdout, /no source/);
});

test("fills in an overlay entry that has no topics at all", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: [], confidence: "low", source: "llm-title-genre", by: "breadth-refine-1" } },
  };
  const { res, out } = run({ shows: [show(1, "Food")], classification });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(out.entries["1"].topics, ["food"], "an empty overlay entry asserts nothing to protect");
  assert.equal(out.entries["1"].by, "breadth-refine-1");
  assert.equal(out.entries["1"].enriched_by, "genre-map");
});

test("enrichment never drops a topic the overlay asserted", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["food", "science"], confidence: "medium", source: "llm-title-genre" } },
  };
  const { out } = run({ shows: [show(1, "Baking")], classification });
  assert.deepEqual(out.entries["1"].topics, ["food/baking", "food", "science"], "science is kept, baking is added");
});

test("a duplicated topic in an overlay does not block enrichment", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["food", "food"], confidence: "medium", source: "llm-title-genre" } },
  };
  const { out } = run({ shows: [show(1, "Baking")], classification });
  assert.ok(out.entries["1"].topics.includes("food/baking"), "a length comparison must not stand in for a set test");
});

test("does not add a whole branch the overlay never named", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["space/astronomy", "space"], confidence: "medium", source: "llm-title-genre" } },
  };
  const genreMap = {
    version: 1,
    map: { Mixed: { topics: ["space/astronomy", "space", "food/baking", "food"], confidence: "high" } },
  };
  const { out } = run({ shows: [show(1, "Mixed")], classification, genreMap });
  assert.deepEqual(out.entries["1"].topics, ["space/astronomy", "space"], "food is a new BRANCH, not a fix for a bare one");
  assert.equal(out.entries["1"].enriched_by, undefined);
});

test("enriches the branch left bare and leaves the one that already has a child", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["space", "food/baking", "food"], confidence: "medium", source: "llm-title-genre" } },
  };
  const genreMap = {
    version: 1,
    map: { Mixed: { topics: ["space/astronomy", "space", "food/baking", "food"], confidence: "high" } },
  };
  const { out } = run({ shows: [show(1, "Mixed")], classification, genreMap });
  assert.deepEqual(out.entries["1"].enriched_nodes, ["space/astronomy"], "food already has a child; only space was bare");
  assert.deepEqual(out.entries["1"].topics, ["space/astronomy", "space", "food/baking", "food"]);
});

test("preserves an entry whose source it has never heard of (fail-safe direction)", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["food/baking"], confidence: "high", source: "some-future-pipeline" } },
  };
  const { out } = run({ shows: [show(1, "Food")], classification });
  assert.equal(out.entries["1"].source, "some-future-pipeline");
});

test("reports how many higher-precedence entries it preserved", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["food/baking"], confidence: "high", source: "classify-agent-tier1" } },
  };
  const { res } = run({ shows: [show(1, "Food")], classification });
  assert.match(res.stdout, /preserved higher-precedence entries/);
  assert.match(res.stdout, /classify-agent-tier1/);
});

test("replaces its own stale genre-map entry with the current mapping", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["space"], confidence: "high", source: "genre-map" } },
  };
  const { out } = run({ shows: [show(1, "Astronomy")], classification });
  assert.deepEqual(out.entries["1"].topics, ["space/astronomy", "space", "science"]);
  assert.equal(out.entries["1"].source, "genre-map");
});

test("keeps entries for shows that are not in the input catalog", () => {
  const classification = {
    version: 1,
    entries: { 999: { topics: ["science"], confidence: "high", source: "genre-map" } },
  };
  const { out } = run({ shows: [show(1, "Astronomy")], classification });
  assert.deepEqual(out.entries["999"].topics, ["science"], "a show outside this catalog must not be dropped");
  assert.ok(out.entries["1"]);
});

test("never un-classifies a show whose genre stopped being mapped", () => {
  const classification = {
    version: 1,
    entries: { 1: { topics: ["science"], confidence: "high", source: "genre-map" } },
  };
  const { res, out } = run({ shows: [show(1, "Genre That Vanished")], classification });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(out.entries["1"].topics, ["science"]);
});

test("counts new / changed / unchanged shows separately", () => {
  const classification = {
    version: 1,
    entries: {
      1: { topics: ["space"], confidence: "high", source: "genre-map" },
      2: { topics: ["food"], confidence: "high", source: "genre-map" },
    },
  };
  const { res } = run({ shows: [show(1, "Astronomy"), show(2, "Food"), show(3, "Science")], classification });
  assert.match(res.stdout, /1 new, 1 changed, 1 unchanged/);
});

test("--dry-run reports but writes nothing", () => {
  const classification = { version: 1, entries: { 1: { topics: ["space"], confidence: "high", source: "genre-map" } } };
  const { res, out } = run({ shows: [show(1, "Astronomy")], classification, args: ["--dry-run"] });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\[dry-run\]/);
  assert.deepEqual(out.entries["1"].topics, ["space"], "the file on disk must be untouched");
});

test("is idempotent across EVERY path, not just the base one", () => {
  const dir = mkdtempSync(join(tmpdir(), "classify-breadth-idem-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  const p = (f) => join(dir, "data", f);
  // One show per path: base-owned, agent-preserved, overlay-enriched,
  // overlay-preserved, sourceless, and outside the catalog. The first version of
  // this test seeded only base-path shows, which is exactly why an
  // enrichment-path field could be silently erased on the second run.
  writeFileSync(
    p("catalog.json"),
    JSON.stringify({
      shows: [show(1, "Astronomy"), show(2, "Food"), show(3, "Baking"), show(4, "Nutrition"), show(5, "Food"), show(6, "Baking")],
    })
  );
  writeFileSync(
    p("classification.json"),
    JSON.stringify({
      version: 1,
      entries: {
        2: { topics: ["food/baking"], confidence: "high", source: "classify-agent-tier1" },
        3: { topics: ["food"], confidence: "medium", source: "llm-title-genre", by: "breadth-refine-2" },
        4: { topics: ["food"], confidence: "medium", source: "llm-title-genre" },
        5: { topics: ["food/baking", "food"], confidence: "high" },
        6: { topics: [], confidence: "low", source: "llm-title-genre" },
        999: { topics: ["science"], confidence: "high", source: "genre-map" },
      },
    })
  );
  writeFileSync(p("genre-map.json"), JSON.stringify(GENRE_MAP));
  writeFileSync(p("taxonomy.json"), JSON.stringify(TAXONOMY));
  const env = {
    ...process.env,
    CATALOG_BREADTH_PATH: p("catalog.json"),
    GENRE_MAP_PATH: p("genre-map.json"),
    TAXONOMY_PATH: p("taxonomy.json"),
    BREADTH_CLASSIFICATION_PATH: p("classification.json"),
  };
  spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env });
  const first = JSON.parse(readFileSync(p("classification.json"), "utf8")).entries;
  spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env });
  const second = JSON.parse(readFileSync(p("classification.json"), "utf8")).entries;
  assert.deepEqual(second, first);
});

test("starts from nothing when no classification file exists yet", () => {
  const { res, out } = run({ shows: [show(1, "Astronomy")] });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(Object.keys(out.entries).length, 1);
});

test("records its own provenance under its own key, without claiming the overlays' work", () => {
  const { out } = run({ shows: [show(1, "Astronomy")] });
  assert.equal(out.provenance.base_layer.produced_by, "classify-breadth.mjs");
  assert.match(out.provenance.base_layer.method, /base layer/);
});

test("keeps the refinement pipeline's provenance instead of signing over it", () => {
  const classification = {
    version: 1,
    provenance: { produced_by: "tools/classify/merge-results.mjs", last_batch_id: "fresh-2026-08-03-03cc71da", last_batch_tier: 1 },
    entries: { 1: { topics: ["space"], confidence: "high", source: "genre-map" } },
  };
  const { out } = run({ shows: [show(1, "Astronomy")], classification });
  assert.equal(out.provenance.last_batch_id, "fresh-2026-08-03-03cc71da", "merge-results batch pointer must survive");
  assert.equal(out.provenance.last_batch_tier, 1);
  assert.equal(out.provenance.base_layer.produced_by, "classify-breadth.mjs");
});
