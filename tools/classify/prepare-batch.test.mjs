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
import { tier0Prior } from "./prepare-batch.mjs";

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

// RED on main: T1-07 (prepare-batch ignores the taxonomy and hands the agent the dead id food/grilling-bbq)
test("tier0_prior never contains a topic absent from the taxonomy", () => {
  assert.deepEqual(tier0Prior(show("Grilling"), GMAP, TAXONOMY), { topics: ["food"], confidence: "high" });
});

// RED on main: T1-07 (returns { topics: ["food/grilling-bbq"], confidence: "high" })
test("a show whose only mapped topic is stale gets the no-topic shape, not the dead id", () => {
  assert.deepEqual(tier0Prior(show("Barbecue"), GMAP, TAXONOMY), { topics: [], confidence: "low" });
});
