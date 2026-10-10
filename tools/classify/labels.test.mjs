/* labels.mjs's two CH2-13 rules: the genre->topics prior (genreTopicPrior) and
   the classify pipeline's default progress path (classifyProgressPath).
   Run: node --test tools/classify/labels.test.mjs

   Both used to exist twice. The prior was in tools/classify-breadth.mjs and, as
   a hand-synced copy that never checked the taxonomy, in prepare-batch.mjs
   (T1-07). The progress path defaulted to the gitignored data-local/ copy while
   the six cloud shard routines passed the committed data/ file explicitly, so a
   run that left the flag off kept its own private state (T1-09). The transcript
   label and the shard key have their own suites (transcript-label, shard,
   no-exclusion). */

import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { genreTopicPrior, classifyProgressPath, PROGRESS_PATH_DEFAULT } from "./labels.mjs";

const TAXONOMY = new Set(["space", "space/astronomy", "science", "food"]);

const GMAP = {
  Astronomy: { topics: ["space/astronomy", "space", "science"], confidence: "high" },
  Science: { topics: ["science"], confidence: "medium" },
  Food: { topics: ["food"], confidence: "low" },
  Grilling: { topics: ["food/grilling-bbq", "food"], confidence: "high" },
  Barbecue: { topics: ["food/grilling-bbq"], confidence: "medium" }
};

const show = (apple_genre, chart_genre_name = apple_genre) => ({ apple_genre, chart_genre_name });

/* ---------------------------------------------------- genreTopicPrior -- */

test("map lookup over both genres: topics in map order, de-duplicated", () => {
  const p = genreTopicPrior(show("Astronomy", "Science"), GMAP, TAXONOMY);
  assert.deepEqual(p.topics, ["space/astronomy", "space", "science"]);
});

test("confidence is the minimum across the genres that mapped", () => {
  assert.equal(genreTopicPrior(show("Astronomy", "Science"), GMAP, TAXONOMY).confidence, "medium");
  assert.equal(genreTopicPrior(show("Astronomy", "Food"), GMAP, TAXONOMY).confidence, "low");
  assert.equal(genreTopicPrior(show("Astronomy", "Unmapped"), GMAP, TAXONOMY).confidence, "high");
});

/* Mutation killed: `if (taxonomyIds.has(t)) topics.add(t); else staleTopics.push(t);`
   -> `topics.add(t);`. Red here, in prepare-batch.test.mjs's "tier0_prior never
   contains a topic absent from the taxonomy", and in classify-breadth.test.mjs's
   "fails loudly ... non-taxonomy node" — one function, every caller's pin. */
test("a map topic that is not a taxonomy node is reported, never emitted", () => {
  const p = genreTopicPrior(show("Grilling"), GMAP, TAXONOMY);
  assert.deepEqual(p.topics, ["food"]);
  assert.deepEqual(p.staleTopics, ["food/grilling-bbq", "food/grilling-bbq"], "one report per genre that named it");
});

test("a show with no surviving topic gets confidence 'low' (prepare-batch's no-topic shape)", () => {
  const stale = genreTopicPrior(show("Barbecue"), GMAP, TAXONOMY);
  assert.deepEqual([stale.topics, stale.confidence], [[], "low"]);
  const unmapped = genreTopicPrior(show("Underwater Basketweaving", null), GMAP, TAXONOMY);
  assert.deepEqual([unmapped.topics, unmapped.confidence], [[], "low"]);
});

test("unmapped genres are reported for classify-breadth's UNMAPPED GENRES warning", () => {
  const p = genreTopicPrior(show("Underwater Basketweaving", "Astronomy"), GMAP, TAXONOMY);
  assert.deepEqual(p.unmappedGenres, ["Underwater Basketweaving"]);
  assert.deepEqual(genreTopicPrior(show(null, undefined), GMAP, TAXONOMY).unmappedGenres, []);
});

/* Mutation killed: delete the `instanceof Set` guard — a caller that forgets the
   taxonomy then gets `taxonomyIds.has` of undefined, or (if the guard became a
   skip) the unfiltered T1-07 prior back. */
test("the taxonomy is required: leaving it off throws instead of skipping the check", () => {
  assert.throws(() => genreTopicPrior(show("Food"), GMAP), /taxonomyIds must be a Set/);
  assert.throws(() => genreTopicPrior(show("Food"), GMAP, ["food"]), /taxonomyIds must be a Set/);
});

/* ------------------------------------------------ classifyProgressPath -- */

const ROOT = resolve("/repo");
const CWD = resolve("/somewhere/else");

/* Mutation killed: change PROGRESS_PATH_DEFAULT (or the join) back to
   "data-local/classify-progress.json". */
test("PROGRESS_PATH unset resolves to the committed data/classify-progress.json", () => {
  assert.equal(PROGRESS_PATH_DEFAULT, "data/classify-progress.json");
  assert.equal(classifyProgressPath(ROOT, { env: {}, cwd: CWD }), join(ROOT, "data", "classify-progress.json"));
});

test("an empty PROGRESS_PATH or --progress value counts as unset, as it always has", () => {
  assert.equal(classifyProgressPath(ROOT, { flag: "", env: { PROGRESS_PATH: "" }, cwd: CWD }), join(ROOT, "data", "classify-progress.json"));
});

test("PROGRESS_PATH, when set, is resolved against the working directory", () => {
  assert.equal(classifyProgressPath(ROOT, { env: { PROGRESS_PATH: "tmp/p.json" }, cwd: CWD }), join(CWD, "tmp", "p.json"));
});

test("the --progress flag wins over PROGRESS_PATH", () => {
  assert.equal(
    classifyProgressPath(ROOT, { flag: "x/flag.json", env: { PROGRESS_PATH: "tmp/p.json" }, cwd: CWD }),
    join(CWD, "x", "flag.json")
  );
});
