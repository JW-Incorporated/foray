/* prepare-batch.mjs: the Tier-0 genre prior each batch entry carries, the
   batch document that names the stale map topics it dropped, and the
   progress-path default the six cloud classify routines share.
   Run: node --test tools/classify/prepare-batch.test.mjs

   CH2-13 (docs/roadmap/code-health-2.md, T1-07/T1-09/T1-17). The genre->topics
   rule used to exist twice: here, as a "kept in sync deliberately" copy, and in
   tools/classify-breadth.mjs. The copy had already drifted — it never checked
   the taxonomy, so a renamed taxonomy node made classify-breadth refuse to run
   while prepare-batch kept handing the classification agent the dead id as a
   prior. Both scripts now call genreTopicPrior in labels.mjs. The pins below
   are prepare-batch's half of that: its no-topic shape is its own, the rule is
   the shared one. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tier0Prior, batchDocument } from "./prepare-batch.mjs";
import { LABEL_SCHEMA_VERSION } from "./labels.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const TAXONOMY = new Set(["space", "space/astronomy", "science", "food", "food/baking"]);

const GMAP = {
  Astronomy: { topics: ["space/astronomy", "space", "science"], confidence: "high" },
  Science: { topics: ["science"], confidence: "medium" },
  Food: { topics: ["food"], confidence: "high" },
  Baking: { topics: ["food/baking", "food"], confidence: "low" },
  // A map row whose node was renamed out of the taxonomy (the T1-07 case).
  Grilling: { topics: ["food/grilling-bbq", "food"], confidence: "high" },
  // A map row whose ONLY node is stale.
  Barbecue: { topics: ["food/grilling-bbq"], confidence: "high" }
};

const show = (apple_genre, chart_genre_name = apple_genre) => ({ apple_collection_id: 1, title: "s", apple_genre, chart_genre_name });

/* ---------- characterization: today's rule, unchanged by CH2-13 ---------- */

test("the prior is the union of both genres' map topics, in map order", () => {
  assert.deepEqual(tier0Prior(show("Astronomy", "Science"), GMAP, TAXONOMY), {
    topics: ["space/astronomy", "space", "science"],
    confidence: "medium"
  });
});

test("the prior's confidence is the LOWEST across apple_genre and chart_genre_name", () => {
  assert.equal(tier0Prior(show("Food", "Baking"), GMAP, TAXONOMY).confidence, "low");
  assert.equal(tier0Prior(show("Astronomy"), GMAP, TAXONOMY).confidence, "high");
});

test("a show with no mapped genre keeps prepare-batch's no-topic shape", () => {
  assert.deepEqual(tier0Prior(show("Underwater Basketweaving"), GMAP, TAXONOMY), { topics: [], confidence: "low" });
  assert.deepEqual(tier0Prior(show(null, null), GMAP, TAXONOMY), { topics: [], confidence: "low" });
  assert.deepEqual(tier0Prior({ apple_collection_id: 2, title: "t" }, GMAP, TAXONOMY), { topics: [], confidence: "low" });
});

test("a missing chart genre falls back to apple_genre alone", () => {
  assert.deepEqual(tier0Prior(show("Food", null), GMAP, TAXONOMY), { topics: ["food"], confidence: "high" });
});

/* ---------- T1-07: the drift this card closes ---------- */

/* Mutation killed: drop the taxonomy filter in labels.mjs genreTopicPrior
   (`if (taxonomyIds.has(t)) topics.add(t)` -> `topics.add(t)`). This test and
   classify-breadth.test.mjs's "fails loudly ... non-taxonomy node" go red
   together, because there is one function. */
test("tier0_prior never contains a topic absent from the taxonomy", () => {
  assert.deepEqual(tier0Prior(show("Grilling"), GMAP, TAXONOMY), { topics: ["food"], confidence: "high" });
});

test("a show whose only mapped topic is stale gets the no-topic shape, not the dead id", () => {
  assert.deepEqual(tier0Prior(show("Barbecue"), GMAP, TAXONOMY), { topics: [], confidence: "low" });
});

/* Mutation killed: drop `for (const t of prior.staleTopics) staleTopics.add(t)`
   from tier0Prior, or the `stale_map_topics` line from batchDocument — the dead
   id then vanishes without a trace, which is how T1-07 stayed invisible. */
test("the stale map topics it dropped reach the batch document, sorted and de-duplicated", () => {
  const stale = new Set();
  tier0Prior(show("Grilling"), GMAP, TAXONOMY, stale);
  tier0Prior(show("Barbecue", "Astronomy"), GMAP, TAXONOMY, stale);
  tier0Prior(show("Food"), GMAP, TAXONOMY, stale);
  const doc = batchDocument({ batchId: "fresh-x", mode: "fresh", now: 0, shard: "0/6", shows: [], staleMapTopics: stale });
  assert.deepEqual(doc.stale_map_topics, ["food/grilling-bbq"]);
});

test("the batch document keeps its existing fields and states 'no stale topics' as []", () => {
  const doc = batchDocument({ batchId: "escalate-x", mode: "escalate", now: Date.UTC(2026, 9, 7), shard: null, shows: [{ a: 1 }] });
  assert.deepEqual(doc, {
    batch_id: "escalate-x",
    mode: "escalate",
    tier: 2,
    generated_at: "2026-10-07T00:00:00.000Z",
    taxonomy_path: "data/taxonomy.json",
    genre_map_path: "data/genre-taxonomy-map.json",
    label_schema_version: LABEL_SCHEMA_VERSION,
    shard: null,
    stale_map_topics: [],
    shows: [{ a: 1 }]
  });
  assert.equal(batchDocument({ batchId: "f", mode: "fresh", now: 0, shard: "2/6", shows: [] }).tier, 1);
});

/* ---------- T1-17: dead copies of select.mjs's constants ---------- */

/** Source with comments removed, so the note explaining the deletion does not count. */
const code = (file) =>
  readFileSync(join(HERE, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

/* Mutation killed: restore `const RETRY_COOLDOWN_MS = 6 * 3600_000;` (or the
   prefix) in prepare-batch.mjs. select.mjs owns both; a second copy is the one
   the next cooldown tweak edits while nothing reads it. */
test("RETRY_COOLDOWN_MS and NEW_PIPELINE_SOURCE_PREFIX are declared only in select.mjs", () => {
  for (const name of ["RETRY_COOLDOWN_MS", "NEW_PIPELINE_SOURCE_PREFIX"]) {
    const decl = new RegExp(`\\b(const|let|var)\\s+${name}\\b`);
    assert.ok(!decl.test(code("prepare-batch.mjs")), `prepare-batch.mjs declares its own ${name}`);
    assert.ok(decl.test(code("select.mjs")), `select.mjs no longer declares ${name}; update this pin`);
  }
});

/* ---------- T1-09: one committed progress path ---------- */

/* The resolver's behaviour is pinned in labels.test.mjs. These pins hold that
   both scripts USE it, since neither main() can be run with PROGRESS_PATH unset
   without writing the real data/classify-progress.json.
   Mutation killed: put back
   `envPath("PROGRESS_PATH", ["data-local", "classify-progress.json"])` in either
   script. */
for (const file of ["prepare-batch.mjs", "merge-results.mjs"]) {
  test(`${file} resolves the progress path through labels.mjs classifyProgressPath, never data-local`, () => {
    const src = code(file);
    assert.match(src, /classifyProgressPath\(ROOT\b/, `${file} must call classifyProgressPath(ROOT, ...)`);
    assert.ok(!/classify-progress/.test(src), `${file} names a classify-progress path of its own`);
    assert.ok(!/["']PROGRESS_PATH["']/.test(src), `${file} reads PROGRESS_PATH itself instead of through the resolver`);
  });
}
