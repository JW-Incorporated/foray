/* Tests for tools/refresh/fold-breadth-topics.mjs (catalogue-personalization
   plan PKG-08): breadth-classification topics folded into
   data/catalog-breadth.json as `taxonomy_node_ids`.
   Run: node --test tools/refresh/fold-breadth-topics.test.mjs

   Four fixture tests (a temp dir, three shows, `entries` as an OBJECT keyed by
   the collection id as a string — the real file's shape) and one REAL DATA
   test over the committed catalogue. Each test names the one-line mutation
   that turns it red. The floor for this suite lives in
   test/suite-integrity.test.js. */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { foldBreadthTopics, serialize } from "./fold-breadth-topics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRIPT = join(HERE, "fold-breadth-topics.mjs");

const NODE_IDS = new Set(["science", "science/space", "history", "comedy"]);

const showRow = (id, title) => ({ apple_collection_id: id, title, apple_genre: "Science", in_curated: false });
const fixtureDoc = () => ({
  version: 1,
  shows: [showRow(101, "High One"), showRow(202, "Medium Two"), showRow(303, "Low Three")],
});
const fixtureEntries = () => ({
  101: { topics: ["science/space", "science", "science/space"], confidence: "high", needs_review: false },
  202: { topics: ["history"], confidence: "medium", needs_review: false },
  303: { topics: ["comedy"], confidence: "low", needs_review: false },
});

/** Writes the three input files to a fresh temp dir; returns the env that points the script at them. */
function fixtureDir(doc = fixtureDoc(), entries = fixtureEntries()) {
  const dir = mkdtempSync(join(tmpdir(), "fold-breadth-"));
  const p = (f) => join(dir, f);
  writeFileSync(p("catalog-breadth.json"), serialize(doc));
  writeFileSync(p("classification.json"), JSON.stringify({ version: 1, entries }, null, 2) + "\n");
  writeFileSync(p("taxonomy.json"), JSON.stringify({ nodes: [...NODE_IDS].map((id) => ({ id })) }));
  return {
    breadthPath: p("catalog-breadth.json"),
    env: {
      ...process.env,
      FOLD_BREADTH_PATH: p("catalog-breadth.json"),
      FOLD_CLASS_PATH: p("classification.json"),
      FOLD_TAXONOMY_PATH: p("taxonomy.json"),
    },
  };
}

const run = (env, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" });
const byId = (doc) => Object.fromEntries(doc.shows.map((s) => [s.apple_collection_id, s]));

/* MUTATION: change entryFolds to `entry.confidence === "high"` -- the medium
   show comes back []. (Second kill: drop the `new Set` -- the high show keeps
   its duplicate "science/space".) */
test("folds topics for a high/medium entry", () => {
  const doc = fixtureDoc();
  const counts = foldBreadthTopics(doc, fixtureEntries(), NODE_IDS);
  const shows = byId(doc);
  assert.deepEqual(shows[101].taxonomy_node_ids, ["science/space", "science"], "deduped, first occurrence order kept");
  assert.deepEqual(shows[202].taxonomy_node_ids, ["history"]);
  assert.equal(counts.folded, 2);
  assert.equal(counts.unknown_id, 0);
});

/* MUTATION: drop either condition from entryFolds (`entry.confidence !== "low"`
   or `entry.needs_review !== true`) -- the low or the needs_review show is
   labelled. */
test("leaves [] for a low-confidence or needs_review entry", () => {
  const entries = fixtureEntries();
  entries[202].needs_review = true;
  const doc = fixtureDoc();
  doc.shows.push(showRow(404, "Unclassified Four"));
  const counts = foldBreadthTopics(doc, entries, NODE_IDS);
  const shows = byId(doc);
  assert.deepEqual(shows[303].taxonomy_node_ids, [], "low confidence gets no subject");
  assert.deepEqual(shows[202].taxonomy_node_ids, [], "needs_review gets no subject");
  assert.deepEqual(shows[404].taxonomy_node_ids, [], "no classification entry gets no subject");
  assert.deepEqual(counts, { folded: 1, empty: 3, unknown_id: 1, dropped_nodes: 0 });
});

/* MUTATION: skip the filter (`ids = unique`) -- "science/retired" reaches the row. */
test("drops an id the taxonomy does not know", () => {
  const entries = fixtureEntries();
  entries[101].topics = ["science/retired", "science"];
  const doc = fixtureDoc();
  const counts = foldBreadthTopics(doc, entries, NODE_IDS);
  assert.deepEqual(byId(doc)[101].taxonomy_node_ids, ["science"]);
  assert.equal(counts.dropped_nodes, 1);
});

/* MUTATION: `if (check) return 0;` in main() -- the unfolded and the edited
   file both pass --check. (Second kill: drop the `+ "\n"` from serialize() --
   the first run's output is no longer one line plus a newline.) */
test("--check is 0 after a run and 1 after an edit", () => {
  const { breadthPath, env } = fixtureDir();
  assert.equal(run(env, "--check").status, 1, "an unfolded file fails --check");

  const first = run(env);
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = readFileSync(breadthPath, "utf8");
  assert.ok(afterFirst.endsWith("}\n") && !afterFirst.slice(0, -1).includes("\n"), "single line plus one newline");
  assert.equal(run(env, "--check").status, 0, "--check is clean after a run");

  assert.equal(run(env).status, 0);
  assert.equal(readFileSync(breadthPath, "utf8"), afterFirst, "second run writes nothing");

  const edited = JSON.parse(afterFirst);
  edited.shows[0].taxonomy_node_ids = ["comedy"];
  writeFileSync(breadthPath, serialize(edited));
  const after = run(env, "--check");
  assert.equal(after.status, 1, "a hand edit fails --check");
  assert.equal(readFileSync(breadthPath, "utf8"), serialize(edited), "--check never writes");
});

/* REAL DATA. Every committed breadth row carries the folded array and every id
   in it is a real taxonomy node. Also fails after `tools/harvest-catalog.mjs`
   rebuilds the file without the field — re-run the fold.
   MUTATION: in a local copy of data/catalog-breadth.json set one row's
   `taxonomy_node_ids` to ["science/not-a-node"] (red: does not resolve), or
   delete the key from one row (red: missing array). */
test("REAL DATA: every taxonomy_node_ids in data/catalog-breadth.json resolves", () => {
  const taxonomy = JSON.parse(readFileSync(join(ROOT, "data", "taxonomy.json"), "utf8"));
  const nodeIds = new Set(taxonomy.nodes.map((n) => n.id));
  const { shows } = JSON.parse(readFileSync(join(ROOT, "data", "catalog-breadth.json"), "utf8"));
  const missing = [];
  const bad = [];
  let labelled = 0;
  for (const s of shows) {
    if (!Array.isArray(s.taxonomy_node_ids)) {
      missing.push(s.apple_collection_id);
      continue;
    }
    if (s.taxonomy_node_ids.length) labelled++;
    for (const id of s.taxonomy_node_ids) if (!nodeIds.has(id)) bad.push(`${s.apple_collection_id}:${id}`);
  }
  const head = (xs) => xs.slice(0, 10).join(", ") + (xs.length > 10 ? ` … and ${xs.length - 10} more` : "");
  assert.deepEqual(missing, [], `rows without taxonomy_node_ids (run fold-breadth-topics.mjs): ${head(missing)}`);
  assert.deepEqual(bad, [], `unknown taxonomy ids: ${head(bad)}`);
  assert.ok(labelled > 0, "no breadth row carries a topic — the fold has not run");
});
