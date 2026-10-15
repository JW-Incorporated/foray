/* tools/recommender/predict.mjs (RV-25): the student trained on the gold set
   minus its holdout, gated on the holdout, and carried to the catalogue.

   Synthetic and offline: a seeded 40-show gold set with 4-dim embeddings and
   hand-built evidence packs, no model, no network; files go to a fresh temp
   directory. The one exception reads the committed gold set, model and gold
   report to check they are bound to each other.

   Every test names the one-line mutation of predict.mjs that turns it red;
   each was run red before this suite was committed. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rng } from "../segments/rank-breadth.mjs";
import { serializeModel } from "./student.mjs";
import { HIGH_FIT, checkBindings, gateCeilings, main, perPersonaTable, predictCatalogue, serializePredicted, sha256Text, splitRows, teacherRetestFrom, trainStudent } from "./predict.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PERSONAS = ["ann", "ben"];
const ROOTS = ["history", "science"];
const GRID = [1, 10];

/** 40 gold shows (s00..s39), the first 10 holdout; teacher fit follows the
    embedding's first two components so a ridge can learn it. */
function world(seed = "rv25") {
  const next = rng(seed);
  const keys = Array.from({ length: 40 }, (_, i) => `s${String(i).padStart(2, "0")}`);
  const emb = {};
  const shows = {};
  const rows = [];
  for (const [i, key] of keys.entries()) {
    const e = Array.from({ length: 4 }, () => Math.round((next() * 2 - 1) * 1000) / 1000);
    emb[key] = e;
    const one = (v) => Math.round(Math.min(5, Math.max(1, v)) * 10) / 10;
    const rating = (z) => [one(3 + 2 * z), Math.round(((z + 1) / 2) * 100) / 100, one(3 + z), one(3 - z), one(3 + z / 2), one(3), null, null, null, 0.4];
    shows[key] = { evidence_tier: "episode-metadata", passes: 1, personas: { ann: rating(e[0]), ben: rating(e[1]) } };
    rows.push({ show_key: key, strata: { root: ROOTS[i % 2] }, roles: i < 10 ? ["gold", "holdout"] : ["gold"] });
  }
  const goldSet = { version: 1, shows: rows };
  const ratings = { version: 1, rubric_version: 1, built_at: "2026-10-15T00:00:00.000Z", shows };
  return { keys, emb, goldSet, ratings };
}

const packOf = (tierOf = () => "episode-metadata") => (key) => ({
  show_key: key,
  tier: tierOf(key),
  taxonomy_node_ids: [Number(key.slice(1)) % 2 ? "science/physics" : "history/ancient"],
  typical_duration_min: 40,
  cadence_hint: "weekly",
  explicit: false,
  label_scope: null,
  episode_count_band: "10-49",
});
const showOf = () => ({ dai: null, episode_count: 30 });

function train(w, extra = {}) {
  return trainStudent({ goldSet: w.goldSet, ratings: w.ratings, personaIds: PERSONAS, packOf: packOf(), showOf, embeddingOf: (k) => w.emb[k], taxonomyRoots: ROOTS, grid: GRID, goldSetSha256: "g", ...extra });
}

const passed = (model) => ({ ...model, gate: { pass: true, per_metric: {}, failing_subscores: [] } });

const sink = () => {
  const s = { text: "", write: (x) => (s.text += x) };
  return s;
};

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv25-predict-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = (name) => path.join(dir, name);
  return {
    dir,
    p,
    env: {
      RECOMMENDER_GOLD_SET_PATH: p("gold-set.json"),
      RECOMMENDER_RATINGS_PATH: p("ratings.json"),
      RECOMMENDER_STUDENT_MODEL_PATH: p("student-model.json"),
      RECOMMENDER_PREDICTED_PATH: p("ratings-predicted.json"),
      RECOMMENDER_STUDENT_REPORT_PATH: p("report.md"),
    },
  };
}

/* Mutations (each run): (a) in splitRows, `if ((row.roles ?? []).includes(HOLDOUT_ROLE))`
   -> `if (false)` -- the holdout rows train the model and the holdout is
   empty; (b) in student.mjs fitStudent, `fitRidge(X, Y, { lambda: lambdas, rows })`
   -> `fitRidge(X, Y, { lambda: lambdas })` -- the split is right but the
   solve sees the holdout, and the planted extreme row moves the weights. */
test("holdout rows are excluded from training", () => {
  const w = world();
  const base = train(w);
  const split = splitRows(w.goldSet, w.ratings);
  assert.equal(split.holdout.length, 10);
  assert.equal(split.train.length, 30);
  assert.ok(split.holdout.every((k) => !split.train.includes(k)));
  assert.equal(base.model.trained_on.n, 30);
  assert.equal(base.model.trained_on.holdout_n, 10);

  // Plant an extreme teacher row on a holdout show: fit 5 / 1 against its features.
  const planted = structuredClone(w);
  planted.ratings.shows.s00.personas.ann = [5, 1, 5, 5, 5, 5, null, null, null, 1];
  planted.ratings.shows.s00.personas.ben = [1, 0, 1, 1, 1, 1, null, null, null, 0];
  planted.emb.s00 = [50, -50, 50, -50];
  const after = train(planted);
  for (const field of ["means", "scales", "intercepts", "weights", "lambdas", "knn", "calibration"]) assert.deepEqual(after.model[field], base.model[field], field);
});

/* Mutation (run): holdout kNN index built over all rows -- in trainStudent,
   `knnIndexFor(model, { embeddingOf: ..., targetsOf: ... })` -> `knnIndex(keys,
   E, Y)` -- the other holdout shows' teacher targets become neighbours of each
   holdout show, and the planted holdout row moves its neighbours' predictions. */
test("the holdout is predicted with the kNN over the training rows only", () => {
  const w = world();
  const opts = { weights: [0.75], ks: [5] };
  const base = train(w, opts);
  assert.ok(base.model.knn.weight.every((x) => x === 0.75), "the kNN is blended for every persona");
  // s00 sits on s01's embedding, so it is s01's nearest neighbour whenever it is in the index.
  const planted = structuredClone(w);
  planted.emb.s00 = [...w.emb.s01];
  planted.ratings.shows.s00.personas.ann = [5, 1, 5, 5, 5, 5, null, null, null, 1];
  planted.ratings.shows.s00.personas.ben = [1, 0, 1, 1, 1, 1, null, null, null, 0];
  const after = train(planted, opts);
  for (let i = 1; i < 10; i++) {
    const key = `s0${i}`;
    assert.deepEqual(after.predictedHoldout.shows[key], base.predictedHoldout.shows[key], key);
  }
  assert.notDeepEqual(after.predictedHoldout.shows.s00, base.predictedHoldout.shows.s00, "the planted row's own prediction moves");
});

/* Mutation (run): in trainStudent, `chooseStudentConfig(X, E, Y, { rows: trainRows, ...`
   -> `chooseStudentConfig(X, E, Y, { rows: X.map((_, i) => i), ...` -- the CV
   folds, the kNN candidates and the calibration see the holdout, and the planted
   row moves the CV tables and the chosen configuration. */
test("CV choices never read a holdout row", () => {
  const w = world();
  const base = train(w);
  assert.equal(base.config.oofFit[0].length, 30, "out-of-fold predictions cover the 30 training rows only");
  const planted = structuredClone(w);
  for (const k of ["s00", "s01", "s02"]) {
    planted.ratings.shows[k].personas.ann = [5, 1, 5, 5, 5, 5, null, null, null, 1];
    planted.ratings.shows[k].personas.ben = [1, 0, 1, 1, 1, 1, null, null, null, 0];
    planted.emb[k] = [-1, 1, -1, 1];
  }
  const after = train(planted);
  assert.deepEqual(after.config.personas, base.config.personas, "every chosen hyperparameter");
  assert.deepEqual(after.config.cv, base.config.cv, "every CV score");
  assert.deepEqual(after.model.selection, base.model.selection);
  assert.deepEqual(after.model.knn.train_keys, base.model.knn.train_keys);
  assert.ok(base.model.knn.train_keys.every((k) => !["s00", "s01", "s02"].includes(k)));
});

/* Mutations (each run): (a) in trainStudent, `gate(predictedHoldout, teacherHoldout, { nodeOf, ceilings })`
   -> `{ nodeOf }` -- the bars are the caps whatever the teacher's retest; (b) in
   ceilingsFromRetest (student.mjs), `spearman: Object.fromEntries(rhos)` ->
   `spearman: {}` -- the per-persona ceilings are lost. */
test("the gate's ceilings are computed from the committed gold report", () => {
  const gold = fs.readFileSync(path.join(ROOT, "docs/research/persona-ratings-gold-2026-10.md"), "utf8");
  const ceilings = gateCeilings(teacherRetestFrom(gold));
  assert.equal(ceilings.spearman["family-listener"], 0.703);
  assert.equal(Object.keys(ceilings.spearman).length, 13);
  assert.ok(ceilings.within_node_tau > 0.5 && ceilings.within_node_tau < 0.7, `tau ceiling ${ceilings.within_node_tau}`);

  const w = world();
  const plain = train(w).verdict.per_metric;
  assert.equal(plain.spearman.bars.ann, 0.75);
  assert.equal(plain.within_node_tau.threshold, 0.6);
  const relative = train(w, { teacherRetest: { ann: 0.5, ben: 0.95 } }).verdict.per_metric;
  assert.ok(Math.abs(relative.spearman.bars.ann - 0.45) < 1e-12);
  assert.equal(relative.spearman.bars.ben, 0.75);
  assert.ok(relative.within_node_tau.threshold < 0.6 && relative.within_node_tau.ceiling !== null);
});

/* Mutations (each run): (a) in predictCatalogue, delete the line
   `if (model?.gate?.pass !== true) throw ...` -- predictions are written for a
   failed model; (b) in main, `if (model.gate?.pass !== true)` -> `if (false)`
   -- the CLI goes on to read its inputs before anything refuses. */
test("--predict refuses when gate.pass is false", async (t) => {
  const w = world();
  const { model } = train(w);
  const failed = { ...model, gate: { pass: false, per_metric: {}, failing_subscores: [] } };
  assert.throws(() => predictCatalogue(failed, { keys: ["x1"], ratings: w.ratings, packOf: packOf(), showOf, embeddingOf: () => [0, 0, 0, 0], modelSha256: "m", builtAt: "t" }), /gate did not pass/);

  const { env, p } = tmp(t);
  fs.writeFileSync(p("student-model.json"), serializeModel(failed));
  fs.writeFileSync(p("ratings.json"), JSON.stringify(w.ratings));
  // Refused before any input is loaded: touching the inputs throws.
  const inputs = new Proxy({}, { get: (_, k) => { throw new Error(`inputs.${String(k)} was read`); } });
  const err = sink();
  const code = await main(["--predict"], { env, inputs, stdout: sink(), stderr: err });
  assert.equal(code, 1);
  assert.match(err.text, /gate did not pass/);
  assert.equal(fs.existsSync(p("ratings-predicted.json")), false);
});

/* Mutation (run): in predictCatalogue, delete `if (rated[key]) { ... continue; }`'s
   `continue;` -- gold-rated shows get a predicted row beside their teacher rating. */
test("gold-rated shows are not in the predicted file", () => {
  const w = world();
  const model = passed(train(w).model);
  const keys = ["s05", "s20", "n1", "n2"];
  const { doc, counts } = predictCatalogue(model, { keys, ratings: w.ratings, packOf: packOf(), showOf, embeddingOf: (k) => w.emb[k] ?? [0.1, 0.2, 0.3, 0.4], modelSha256: "m", builtAt: "t" });
  assert.deepEqual(Object.keys(doc.shows), ["n1", "n2"]);
  assert.equal(counts.teacher_rated, 2);
  assert.equal(counts.predicted, 2);
});

/* Mutation (run): in predictCatalogue, delete the `none_tier` branch's
   `continue;` -- a `none`-tier show gets a predicted row. */
test("none-tier shows are absent", () => {
  const w = world();
  const model = passed(train(w).model);
  const tierOf = (k) => (k === "n2" ? "none" : "show-metadata");
  const { doc, counts } = predictCatalogue(model, { keys: ["n1", "n2", "n3"], ratings: w.ratings, packOf: packOf(tierOf), showOf, embeddingOf: (k) => (k === "n3" ? undefined : [0.1, 0.2, 0.3, 0.4]), modelSha256: "m", builtAt: "t" });
  assert.deepEqual(Object.keys(doc.shows), ["n1"]);
  assert.equal(counts.none_tier, 1);
  assert.equal(counts.no_embedding, 1);
  assert.equal(doc.shows.n1.tier, "show-metadata");
});

/* Mutations (each run): (a) in predictedSlots, `if (AUDIO_SLOTS.has(slot)) return null;`
   -> `return 3;` -- the three audio slots are filled; (b) `capConfidence(v, tier)`
   -> `v` -- a show-metadata row's confidence passes the 0.5 tier cap. */
test("audio sub-scores are null in every predicted row", () => {
  const w = world();
  const trained = train(w).model;
  // An intercept of 0.9 on confidence: above the show-metadata cap of 0.5.
  const model = passed({ ...trained, intercepts: trained.intercepts.map((row) => row.map((v, c) => (c === 6 ? 0.9 : v))), weights: trained.weights.map((rows) => rows.map((r) => r.map((v, c) => (c === 6 ? 0 : v)))) });
  const keys = Array.from({ length: 12 }, (_, i) => `n${i}`);
  const next = rng("emb");
  const { doc } = predictCatalogue(model, { keys, ratings: w.ratings, packOf: packOf(() => "show-metadata"), showOf, embeddingOf: () => [next(), next(), next(), next()], modelSha256: "m", builtAt: "t" });
  assert.equal(Object.keys(doc.shows).length, 12);
  for (const show of Object.values(doc.shows)) {
    for (const row of Object.values(show.personas)) {
      assert.equal(row.length, 10);
      assert.deepEqual(row.slice(6, 9), [null, null, null]);
      assert.ok(row[0] >= 1 && row[0] <= 5 && Math.round(row[0] * 10) === row[0] * 10, `fit ${row[0]} is one decimal in [1, 5]`);
      assert.equal(row[9], 0.5);
    }
  }
});

/* Mutations (each run): in checkBindings, (a) `if (model?.trained_on?.gold_set_sha256 !== goldSha)`
   -> `if (false)` -- a model trained on another gold set passes; (b)
   `if (predicted?.model_sha256 !== modelSha)` -> `if (false)` -- predictions
   from another model pass. */
test("--check binds the model to the gold set and the predictions to the model", async (t) => {
  const w = world();
  const { env, p } = tmp(t);
  const goldText = `${JSON.stringify(w.goldSet, null, 2)}\n`;
  fs.writeFileSync(p("gold-set.json"), goldText);
  const model = passed(train(w, { goldSetSha256: sha256Text(goldText) }).model);
  const modelText = serializeModel(model);
  fs.writeFileSync(p("student-model.json"), modelText);
  const { doc } = predictCatalogue(model, { keys: ["n1"], ratings: w.ratings, packOf: packOf(), showOf, embeddingOf: () => [0.1, 0.2, 0.3, 0.4], modelSha256: sha256Text(modelText), builtAt: "t" });
  fs.writeFileSync(p("ratings-predicted.json"), serializePredicted(doc));
  assert.equal(await main(["--check"], { env, stdout: sink(), stderr: sink() }), 0);

  // A CRLF checkout of the same gold set still binds.
  assert.deepEqual(checkBindings({ goldSetText: goldText.replace(/\n/g, "\r\n"), modelText, predictedText: serializePredicted(doc) }), []);

  // The gold set changes under the model.
  fs.writeFileSync(p("gold-set.json"), goldText.replace('"s00"', '"s99"'));
  const err = sink();
  assert.equal(await main(["--check"], { env, stdout: sink(), stderr: err }), 1);
  assert.match(err.text, /trained on gold set/);
  fs.writeFileSync(p("gold-set.json"), goldText);

  // The ratings the kNN reads change under the model (RV-32; mutation run: in
  // checkBindings, `if (ratingsText !== null && model?.knn)` -> `if (false)`).
  const bound = checkBindings({ goldSetText: goldText, modelText: serializeModel({ ...model, trained_on: { ...model.trained_on, ratings_sha256: sha256Text("r") } }), ratingsText: "r" });
  assert.deepEqual(bound, []);
  assert.match(checkBindings({ goldSetText: goldText, modelText: serializeModel({ ...model, trained_on: { ...model.trained_on, ratings_sha256: sha256Text("r") } }), ratingsText: "r2" }).join(";"), /kNN reads ratings/);

  // The model changes under the predictions.
  fs.writeFileSync(p("student-model.json"), serializeModel({ ...model, lambdas: model.lambdas.map((l) => l + 1) }));
  const err2 = sink();
  assert.equal(await main(["--check"], { env, stdout: sink(), stderr: err2 }), 1);
  assert.match(err2.text, /built from model/);

  // The committed files are bound to each other.
  const committed = checkBindings({
    goldSetText: fs.readFileSync(path.join(ROOT, "data/recommender/gold-set.json"), "utf8"),
    modelText: fs.readFileSync(path.join(ROOT, "data/recommender/student-model.json"), "utf8"),
    predictedText: fs.existsSync(path.join(ROOT, "data/recommender/ratings-predicted.json")) ? fs.readFileSync(path.join(ROOT, "data/recommender/ratings-predicted.json"), "utf8") : null,
    ratingsText: fs.readFileSync(path.join(ROOT, "data/recommender/ratings.json"), "utf8"),
  });
  assert.deepEqual(committed, []);
});

/* Mutations (each run): (a) in perPersonaTable, `>= HIGH_FIT` -> `>= 0` -- the
   3+ subset is every show; (b) in teacherRetestFrom, `head.indexOf("mean retest")`
   -> `head.indexOf("joint pass 1 vs 2")` -- the ceiling is one pass pair, not
   the mean. */
test("the report puts the 3+ subset and the teacher's retest ceiling beside each persona", () => {
  const w = world();
  const res = train(w);
  const gold = fs.readFileSync(path.join(ROOT, "docs/research/persona-ratings-gold-2026-10.md"), "utf8");
  const retest = teacherRetestFrom(gold);
  assert.equal(retest["banter-regular"], 0.899);
  assert.equal(retest["slow-news-contextualist"], 0.8);
  assert.equal(Object.keys(retest).length, 13);

  const table = perPersonaTable({ teacherHoldout: res.teacherHoldout, predictedHoldout: res.predictedHoldout, personaIds: PERSONAS, nodeOf: res.nodeOf, teacherRetest: { ann: 0.9 } });
  const ann = table.find((r) => r.persona === "ann");
  const highByHand = Object.values(res.teacherHoldout.shows).filter((s) => s.personas.ann[0] >= HIGH_FIT).length;
  assert.equal(ann.n, 10);
  assert.equal(ann.high_n, highByHand);
  assert.ok(highByHand > 0 && highByHand < 10, `fixture has a proper 3+ subset (${highByHand})`);
  assert.equal(ann.retest, 0.9);
  assert.equal(table.find((r) => r.persona === "ben").retest, null);
});
