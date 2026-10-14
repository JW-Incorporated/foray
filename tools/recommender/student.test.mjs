/* tools/recommender/student.mjs: the student (RV-14) -- closed-form ridge from
   features to the teacher's rating vector, the lambda choice, the gate read
   from agreement.mjs (RV-11), and the model file.

   Every test names the one-line mutation of student.mjs that turns it red;
   each was run red before this suite was committed. Offline and synthetic:
   seeded data built here, no model, no file written. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rng } from "../segments/rank-breadth.mjs";
import { AUDIO_SUBSCORES, RATING_SLOTS } from "./schema.mjs";
import {
  GATE_THRESHOLDS,
  TARGETS,
  applyGate,
  buildModel,
  checkModel,
  chooseLambda,
  featureNames,
  featuresFor,
  fitRidge,
  gate,
  loadModel,
  predict,
  predictRaw,
  predictTable,
  rawCoefficients,
  serializeModel,
  targetRow,
} from "./student.mjs";

/* ---------- seeded synthetic data ---------- */

function gaussian(next) {
  const u = Math.max(next(), 1e-12);
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** n rows of d raw features (column j has mean 3j and scale 1 + j), the
    planted map W (d x m) and intercept b, and Y = X W + b + noise. */
function planted({ n, d, m, noise, seed, wScale = 1 }) {
  const next = rng(seed);
  const X = Array.from({ length: n }, () => Array.from({ length: d }, (_, j) => 3 * j + (1 + j) * gaussian(next)));
  const W = Array.from({ length: d }, () => Array.from({ length: m }, () => wScale * gaussian(next)));
  const b = Array.from({ length: m }, () => gaussian(next));
  const Y = X.map((x) => b.map((bc, c) => bc + x.reduce((s, xj, j) => s + xj * W[j][c], 0) + noise * gaussian(next)));
  return { X, Y, W, b, next };
}

const PERSONAS = ["ann", "ben", "cat"];
const NODES = ["history", "science", "craft"];

/** A teacher ratings document: 60 shows, 20 per root node, every persona's
    fit spread over 1-5 and every sub-score varying, one decimal. */
function teacherDoc(seed = "teacher") {
  const next = rng(seed);
  const shows = {};
  const nodeOf = {};
  for (let i = 0; i < 60; i++) {
    const key = `show-${String(i).padStart(2, "0")}`;
    nodeOf[key] = NODES[i % 3];
    const personas = {};
    for (const pid of PERSONAS) {
      const one = () => Math.round((1 + 4 * next()) * 10) / 10;
      personas[pid] = [one(), Math.round(next() * 100) / 100, one(), one(), one(), one(), null, null, null, Math.round(next() * 50) / 100];
    }
    shows[key] = { evidence_tier: "show-metadata", personas };
  }
  return { doc: { version: 1, rubric_version: 1, built_at: "2026-10-14T00:00:00.000Z", shows }, nodeOf };
}

/** The teacher with every value nudged by up to +-0.1 (a faithful student),
    optionally with one (persona, field) column permuted across shows. */
function studentOf(teacher, { shuffle = null, seed = "student" } = {}) {
  const next = rng(seed);
  const keys = Object.keys(teacher.shows).sort();
  const shows = {};
  for (const key of keys) {
    const personas = {};
    for (const [pid, slots] of Object.entries(teacher.shows[key].personas)) {
      personas[pid] = slots.map((v) => (v === null ? null : Math.round((v + (next() - 0.5) * 0.2) * 100) / 100));
    }
    shows[key] = { personas };
  }
  if (shuffle) {
    const i = RATING_SLOTS.indexOf(shuffle.field);
    const order = keys.map((k) => [next(), k]).sort((a, b) => a[0] - b[0]).map(([, k]) => k);
    const values = order.map((k) => shows[k].personas[shuffle.persona][i]);
    keys.forEach((k, n) => {
      shows[k].personas[shuffle.persona][i] = values[n];
    });
  }
  return { shows };
}

/** A small trained model over PERSONAS (7 targets each) on planted data. */
function smallModel() {
  const d = 6;
  const { X, Y } = planted({ n: 80, d, m: PERSONAS.length * TARGETS.length, noise: 0.05, seed: "small-model" });
  const fit = fitRidge(X, Y, { lambda: 1 });
  const names = Array.from({ length: d }, (_, j) => `f${j}`);
  return { X, model: buildModel(fit, { personaIds: PERSONAS, featureNames: names, embedder: { kind: "stub", name: "stub", revision: "1", dim: 4 } }) };
}

/* ---------- ridge ---------- */

test("ridge recovers a planted linear map within 0.05", () => {
  // mutation: drop `a[i] += lambda;` in solveRidge -- the duplicated-column fit
  // below is singular without the lambda I term and throws.
  const { X, Y, W, b } = planted({ n: 200, d: 5, m: 3, noise: 0.01, seed: "planted" });
  Y[7][2] = null; // a missing target is fitted on the rows that have it
  Y[19][2] = null;
  const fit = fitRidge(X, Y, { lambda: 1e-3 });
  const { coef, intercept } = rawCoefficients(fit);
  for (let j = 0; j < 5; j++) for (let c = 0; c < 3; c++) assert.ok(Math.abs(coef[j][c] - W[j][c]) < 0.05, `coef[${j}][${c}] ${coef[j][c]} vs ${W[j][c]}`);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(intercept[c] - b[c]) < 0.05, `intercept[${c}] ${intercept[c]} vs ${b[c]}`);

  // A duplicated feature makes X^T X singular; lambda > 0 still solves it.
  const Xdup = X.map((x) => [...x, x[0]]);
  const dup = fitRidge(Xdup, Y, { lambda: 1 });
  const p = predictRaw(dup, Xdup[0]);
  assert.ok([...p].every(Number.isFinite));
  assert.ok(Math.abs(p[0] - Y[0][0]) < 0.5, `duplicated-column prediction ${p[0]} vs ${Y[0][0]}`);
});

test("standardisation is learned on training rows only", () => {
  // mutation: in prepareRidge, `standardiser(X, rows)` -> `standardiser(X, X.map((_, i) => i))`.
  const { X, Y } = planted({ n: 50, d: 3, m: 2, noise: 0.1, seed: "train-only" });
  X[45][0] = 1e6; // an extreme value on a row outside training
  const rows = Array.from({ length: 40 }, (_, i) => i);
  const fit = fitRidge(X, Y, { lambda: 0.5, rows });
  for (let j = 0; j < 3; j++) {
    const col = rows.map((r) => X[r][j]);
    const mean = col.reduce((s, v) => s + v, 0) / col.length;
    const sd = Math.sqrt(col.reduce((s, v) => s + (v - mean) ** 2, 0) / col.length);
    assert.ok(Math.abs(fit.means[j] - mean) < 1e-9, `mean ${j}`);
    assert.ok(Math.abs(fit.scales[j] - sd) < 1e-9, `scale ${j}`);
  }
  const alone = fitRidge(X.slice(0, 40), Y.slice(0, 40), { lambda: 0.5 });
  const a = predictRaw(fit, X[45]);
  const e = predictRaw(alone, X[45]);
  for (let c = 0; c < 2; c++) assert.ok(Math.abs(a[c] - e[c]) < 1e-6);
});

test("chooseLambda prefers the planted-noise optimum on a grid", () => {
  // mutation: `return { lambda: grid[best], scores }` -> `return { lambda: grid[0], scores }`.
  // 40 rows, 30 features (more than a fold trains on), unit noise: the near-zero lambda
  // overfits and the huge one predicts the mean, so the optimum is inside.
  const grid = [1e-4, 1e-2, 1, 10, 100, 1e5];
  const { X, Y } = planted({ n: 40, d: 30, m: 2, noise: 1, seed: "lambda", wScale: 0.05 });
  const { lambda, scores } = chooseLambda(X, Y, { folds: 5, grid });
  const best = scores.reduce((a, s) => (s.mse < a.mse ? s : a));
  assert.equal(lambda, best.lambda);
  assert.notEqual(lambda, grid[0]);
  assert.notEqual(lambda, grid[grid.length - 1]);
  assert.ok(scores[0].mse > best.mse * 1.05, "the unregularised end is measurably worse");
});

/* ---------- prediction ---------- */

test("predict never emits host_style, production or ad_load", () => {
  // mutation: append "host_style", "production", "ad_load" to TARGETS.
  for (const a of AUDIO_SUBSCORES) assert.ok(!TARGETS.includes(a), `${a} is a target`);
  const { X, model } = smallModel();
  const m = predict(model, X[0]);
  assert.equal(m.length, PERSONAS.length);
  for (const row of m) assert.equal(row.length, 7);
  const table = predictTable(model, { s1: X[0], s2: X[1] });
  for (const show of Object.values(table.shows)) {
    for (const slots of Object.values(show.personas)) {
      assert.equal(slots.length, RATING_SLOTS.length);
      for (const a of AUDIO_SUBSCORES) assert.equal(slots[RATING_SLOTS.indexOf(a)], null, `${a} predicted`);
      assert.ok(slots[0] >= 1 && slots[0] <= 5);
    }
  }
  assert.ok(checkModel({ ...model, targets: [...TARGETS, "host_style"] }).length > 0);
});

/* ---------- the gate ---------- */

test("gate passes on faithful predictions and fails on a shuffled column", () => {
  // mutation: GATE_THRESHOLDS all 0 (fitAlpha, subscoreAlpha, spearman, withinNodeTau).
  const { doc, nodeOf } = teacherDoc();
  const faithful = gate(studentOf(doc), doc, { nodeOf });
  assert.equal(faithful.pass, true, JSON.stringify(faithful.per_metric));
  assert.deepEqual(faithful.failing_subscores, []);
  assert.ok(faithful.per_metric.fit_alpha.value >= GATE_THRESHOLDS.fitAlpha);
  assert.ok(faithful.per_metric.within_node_tau.value >= GATE_THRESHOLDS.withinNodeTau);

  const shuffled = gate(studentOf(doc, { shuffle: { persona: "ben", field: "fit" } }), doc, { nodeOf });
  assert.equal(shuffled.pass, false);
  assert.equal(shuffled.per_metric.spearman.pass, false);
  assert.ok(shuffled.per_metric.spearman.per_persona.ben < GATE_THRESHOLDS.spearman);
  assert.ok(shuffled.per_metric.spearman.per_persona.ann >= GATE_THRESHOLDS.spearman);
});

test("a failing sub-score is listed and dropped", () => {
  // mutation: applyGate keeps the predicted set (`dropped: model.dropped ?? []`).
  const { doc, nodeOf } = teacherDoc();
  const verdict = gate(studentOf(doc, { shuffle: { persona: "cat", field: "depth" } }), doc, { nodeOf, thresholds: { ...GATE_THRESHOLDS, subscoreAlpha: 0.9 } });
  assert.deepEqual(verdict.failing_subscores, ["depth"]);
  assert.equal(verdict.pass, true, "a failing sub-score drops itself, not the student");
  assert.equal(verdict.per_metric.subscore_alpha.depth.pass, false);

  const { X, model } = smallModel();
  const gated = applyGate(model, verdict);
  assert.deepEqual(gated.dropped, ["depth"]);
  const depth = TARGETS.indexOf("depth");
  for (const row of predict(gated, X[0])) {
    assert.equal(row[depth], null);
    assert.ok(Number.isFinite(row[TARGETS.indexOf("fit")]));
  }
  for (const slots of Object.values(predictTable(gated, { s: X[0] }).shows.s.personas)) assert.equal(slots[RATING_SLOTS.indexOf("depth")], null);
});

/* ---------- the model file ---------- */

test("the model file round-trips through serialize/load", () => {
  // mutation: serializeModel drops `scales` (`scales: undefined`).
  const { X, model } = smallModel();
  const { doc, nodeOf } = teacherDoc();
  const gated = applyGate({ ...model, trained_on: { n: 80, gold_set_sha256: "a".repeat(64), ratings_built_at: "2026-10-14T00:00:00.000Z" } }, gate(studentOf(doc), doc, { nodeOf }));
  const text = serializeModel(gated);
  assert.ok(text.endsWith("}\n"));
  const loaded = loadModel(text);
  assert.deepEqual(loaded.persona_ids, PERSONAS);
  assert.deepEqual(loaded.trained_on, gated.trained_on);
  assert.equal(loaded.gate.pass, true);
  assert.equal(serializeModel(loaded), text, "serialising a loaded model is byte-identical");
  for (const x of X.slice(0, 5)) {
    const a = predict(gated, x);
    const b = predict(loaded, x);
    a.forEach((row, p) => row.forEach((v, c) => assert.ok(Math.abs(v - b[p][c]) < 1e-4, `persona ${p} target ${c}: ${v} vs ${b[p][c]}`)));
  }
  const { scales: _scales, ...noScales } = JSON.parse(text);
  assert.throws(() => loadModel(noScales), /scales/);
});

/* ---------- features ---------- */

test("featuresFor lays out the named blocks and reads no rater-hidden field", () => {
  // mutation: drop `if (tier >= 0) x[o + tier] = 1;`.
  const roots = ["history", "science", "craft"];
  const pack = {
    tier: "episode-metadata",
    taxonomy_node_ids: ["science/physics", "history"],
    typical_duration_min: 45,
    cadence_hint: "weekly",
    explicit: true,
    label_scope: "general",
    episode_count_band: "50-199",
  };
  const emb = [0.1, -0.2, 0.3, 0.4];
  const names = featureNames(emb.length, roots);
  const x = featuresFor({ dai: true }, pack, emb, { taxonomyRoots: roots });
  assert.equal(x.length, names.length);
  const at = (name) => x[names.indexOf(name)];
  assert.deepEqual(Array.from(x.slice(0, 4)), emb);
  assert.deepEqual([at("root:history"), at("root:science"), at("root:craft")], [1, 1, 0]);
  assert.deepEqual([at("tier:transcript"), at("tier:episode-metadata"), at("tier:show-metadata")], [0, 1, 0]);
  assert.equal(at("length:31-60"), 1);
  assert.equal(at("cadence:weekly"), 1);
  assert.equal(at("explicit"), 1);
  assert.deepEqual([at("dai:true"), at("dai:false"), at("dai:unknown")], [1, 0, 0]);
  assert.equal(at("label_scope:general"), 1);
  assert.ok(Math.abs(at("log_episode_count") - Math.log1p(125)) < 1e-12);
  assert.equal(at("bias"), 1);

  // An exact count wins over the band; an unclassified show is dai:unknown;
  // a none-tier pack sets no tier; the cadenceFromDates words have slots.
  const y = featuresFor({ episode_count: 9 }, { ...pack, tier: "none", cadence_hint: "daily" }, emb, { taxonomyRoots: roots });
  const yat = (name) => y[names.indexOf(name)];
  assert.ok(Math.abs(yat("log_episode_count") - Math.log1p(9)) < 1e-12);
  assert.equal(yat("dai:unknown"), 1);
  assert.equal(yat("tier:transcript") + yat("tier:episode-metadata") + yat("tier:show-metadata"), 0);
  assert.equal(yat("cadence:daily"), 1);

  // D7: chart rank, counts, the publisher and in_curated never move a feature.
  const hidden = { chart_rank: 3, artist_name: "Big Network", in_curated: true, rating_count: 9000 };
  const z = featuresFor({ dai: true, ...hidden }, { ...pack, ...hidden }, emb, { taxonomyRoots: roots });
  assert.deepEqual(Array.from(z), Array.from(x));
});

test("targetRow reads the seven targets of a ratings.json slot array, persona-major", () => {
  // mutation: in targetsOf, read `entry[TARGETS.indexOf(t)]` instead of the RATING_SLOTS index.
  const personas = { ann: [4, 0.6, 3, 2, 5, 1, 4, 4, 4, 0.5], ben: [2, 0.2, 1, 1, 1, 1, null, null, null, 0.3] };
  assert.deepEqual(targetRow(personas, ["ann", "ben", "cat"]), [4, 0.6, 3, 2, 5, 1, 0.5, 2, 0.2, 1, 1, 1, 1, 0.3, null, null, null, null, null, null, null]);
});
