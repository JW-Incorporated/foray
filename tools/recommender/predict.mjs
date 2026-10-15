/* RV-25 (docs/roadmap/recommender-v1.md, D4 (d), D3, D8; #1380): the student
   trained on the gold set, gated on its holdout, and carried to the catalogue.
   RV-32 (orchestrator decision of 2026-10-15, the D4 amendment): student v2
   and the ceiling-relative gate.

     node tools/recommender/predict.mjs --train   [--embeddings <file>] [--grid 1,10,100]
     node tools/recommender/predict.mjs --predict [--embeddings <file>]
     node tools/recommender/predict.mjs --check

   --train. Features (RV-14 `featuresFor`) for every gold-set row that the
   teacher rated (data/recommender/ratings.json, pass means) and that has an
   RV-12 embedding. Rows whose `roles` hold `holdout` NEVER enter training:
   not the standardiser, not the CV folds, not the solve, not the kNN, not the
   calibration. Every choice of student v2 (RV-32: per-persona lambda from
   STUDENT_LAMBDA_GRID, kNN k and blend weight, isotonic calibration or none)
   is made by 5-fold cross-validation on the training rows only (student.mjs
   `chooseStudentConfig`); the model is fitted on all training rows; the gate
   scores it on the holdout once. The gate's Spearman and within-node tau bars
   are ceiling-relative (the D4 amendment): computed by `gateCeilings` from the
   committed gold report's per-persona retest table, never hard-coded.
   Writes data/recommender/student-model.json (gate verdict inside, failing
   sub-scores dropped) and the generated block of
   docs/research/persona-ratings-student-2026-10.md.

   The report adds what the gold report asked for (its "Distribution" note):
   fit is over half ones for 10 of 13 personas (86% for true-crime-careful), so
   a student predicting "1" everywhere would look good on agreement over all
   shows. Beside each persona's overall
   Spearman it gives the Spearman on the holdout shows the teacher rated 3 or
   more, the MAE on both, and the teacher's own joint-vs-joint test-retest
   (the gold report's "mean retest" column, read from that file) as the
   ceiling no student can be expected to beat.

   --predict. Refused unless student-model.json's `gate.pass` is true. For
   every catalogued show (embed.mjs `keysFor("all")`: catalog.json plus the
   breadth rows that are not a curated show's twin) whose evidence tier is not
   `none`, that has an embedding and that the teacher did NOT rate (a consumer
   reads ratings.json first, so a gold-rated show keeps its teacher rating):
   predict, `fit` and the sub-scores to one decimal clamped to [1, 5],
   return_prob and confidence to two decimals, confidence capped by tier,
   host_style / production / ad_load always null (teacher-only, D3), a
   sub-score the gate dropped null. Writes data/recommender/ratings-predicted.json
   = { version, model_sha256, built_at, shows: { <show_key>: { tier, personas:
   { <id>: [RATING_SLOTS] } } } } on a single line.

   --check. Exit 1 when the model is unsound, its `trained_on.gold_set_sha256`
   is not the committed gold set's, its `trained_on.ratings_sha256` (the kNN
   reads its neighbours' targets from ratings.json) is not the committed
   ratings file's, the predicted file's `model_sha256` is not
   the model file's, or a predicted file exists for a model whose gate failed.
   Hashes are sha256 of the file text with CRLF folded to LF, so a Windows
   checkout hashes like CI.

   Calls no model and fetches nothing; reads committed data/ files and the
   local embeddings and RSS caches (data-local/, never committed). Nothing on a
   live app path reads what it writes (dark until the parked RV-27). */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { spearman, withinNodeTau } from "./agreement.mjs";
import { embeddingsPath, keysFor } from "./embed.mjs";
import { buildEvidence, loadSources, resolveShow } from "./evidence.mjs";
import { RATING_SLOTS, capConfidence } from "./schema.mjs";
import { BLEND_WEIGHTS, CEILING_FACTOR, GATE_THRESHOLDS, KNN_KS, TARGETS, applyGate, ceilingsFromRetest, checkModel, chooseStudentConfig, featureNames, featuresFor, finalise, fitStudent, gate, knnIndex, knnIndexFor, loadModel, predict, predictTable, serializeModel, targetRow } from "./student.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");

export const PREDICTED_VERSION = 1;
export const HOLDOUT_ROLE = "holdout";
/** The lower edge of the "rated it 3 or more" subset the report adds (fit is
    mostly ones; the gold report asks for the gate on this subset too). */
export const HIGH_FIT = 3;
/** Wider than RV-14's DEFAULT_LAMBDA_GRID at the top: 446 features on ~2,500
    rows want more shrinkage than 1,000 can give. Chosen by k-fold on the
    training rows only. */
export const STUDENT_LAMBDA_GRID = Object.freeze([1, 10, 30, 100, 300, 1000, 3000, 10000, 30000]);
export const DEFAULT_EMBEDDER = Object.freeze({ kind: "transformers", name: "Xenova/bge-small-en-v1.5" });
export const REPORT_BEGIN = "<!-- BEGIN student:gate -->";
export const REPORT_END = "<!-- END student:gate -->";

export const PATHS = Object.freeze({
  goldSet: ["RECOMMENDER_GOLD_SET_PATH", "data/recommender/gold-set.json"],
  ratings: ["RECOMMENDER_RATINGS_PATH", "data/recommender/ratings.json"],
  profiles: ["RECOMMENDER_PROFILES_PATH", "data/recommender/persona-profiles.json"],
  dai: ["RECOMMENDER_DAI_PATH", "data/dai-classification.json"],
  taxonomy: ["RECOMMENDER_TAXONOMY_PATH", "data/taxonomy.json"],
  model: ["RECOMMENDER_STUDENT_MODEL_PATH", "data/recommender/student-model.json"],
  predicted: ["RECOMMENDER_PREDICTED_PATH", "data/recommender/ratings-predicted.json"],
  report: ["RECOMMENDER_STUDENT_REPORT_PATH", "docs/research/persona-ratings-student-2026-10.md"],
  goldReport: ["RECOMMENDER_GOLD_REPORT_PATH", "docs/research/persona-ratings-gold-2026-10.md"],
  embeddingsDir: ["RECOMMENDER_EMBEDDINGS_DIR", "data-local/recommender/embeddings"],
});

/** Env override (resolved against cwd, the evidence.mjs idiom), else repo-relative. */
export function predictPaths({ root = REPO_ROOT, env = process.env } = {}) {
  const out = {};
  for (const [name, [envName, def]] of Object.entries(PATHS)) {
    out[name] = env[envName] ? resolvePath(process.cwd(), env[envName]) : resolvePath(root, def);
  }
  return out;
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** sha256 of a file's text with CRLF folded to LF (a Windows checkout and CI agree). */
export function sha256Text(text) {
  return createHash("sha256").update(String(text).replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/* ----------------------------------------------------------------- split */

/**
 * The gold set's rated rows split for the student: `holdout` = rows whose
 * `roles` hold "holdout"; `train` = every other row the teacher rated. Both in
 * gold-set order. A holdout row never appears in `train`.
 */
export function splitRows(goldSet, ratings) {
  const rated = ratings?.shows ?? {};
  const train = [];
  const holdout = [];
  let unrated = 0;
  for (const row of goldSet?.shows ?? []) {
    const key = String(row?.show_key ?? "");
    if (!key) continue;
    if (!rated[key]?.personas) {
      unrated++;
      continue;
    }
    if ((row.roles ?? []).includes(HOLDOUT_ROLE)) holdout.push(key);
    else train.push(key);
  }
  return { train, holdout, unrated };
}

/** `{ show_key: root }` from the gold set's strata (the within-node tau's node). */
export function nodeMapOf(goldSet) {
  const out = {};
  for (const row of goldSet?.shows ?? []) if (row?.show_key && row?.strata?.root) out[String(row.show_key)] = row.strata.root;
  return out;
}

/* --------------------------------------------------------------- dataset */

/**
 * Feature rows for `keys`. `packOf(key)` is the evidence pack (RV-03),
 * `showOf(key)` the catalogue facts featuresFor wants (`dai`, `episode_count`),
 * `embeddingOf(key)` the RV-12 vector or undefined. A key without an
 * embedding is left out and listed in `missing`; `none`-tier packs too.
 */
export function buildFeatures(keys, { packOf, showOf, embeddingOf, taxonomyRoots }) {
  const out = { keys: [], X: [], tiers: [], missing: [], none: [] };
  for (const key of keys) {
    const embedding = embeddingOf(key);
    if (!embedding) {
      out.missing.push(key);
      continue;
    }
    const pack = packOf(key);
    if (!pack || pack.tier === "none") {
      out.none.push(key);
      continue;
    }
    out.keys.push(key);
    out.X.push(featuresFor(showOf(key), pack, embedding, { taxonomyRoots }));
    out.tiers.push(pack.tier);
  }
  return out;
}

/* ----------------------------------------------------------------- train */

/**
 * The gate's ceilings (RV-32, the D4 amendment), computed from committed data:
 * the teacher's per-persona joint-vs-joint retest Spearman (`teacherRetest`,
 * read by `teacherRetestFrom` from the committed gold report) and the
 * within-node tau ceiling derived from it (student.mjs `ceilingsFromRetest`).
 * ratings.json keeps only pass means, so no per-pass within-node tau can be
 * measured from committed data; the report says so.
 */
export function gateCeilings(teacherRetest) {
  return ceilingsFromRetest(teacherRetest);
}

/**
 * Trains student v2 on the gold set minus its holdout and gates it on the
 * holdout. Every choice is made by `folds`-fold CV on the training rows only;
 * the holdout is predicted once, after the choices are fixed. Returns
 * `{ model (gate applied), verdict, config, ceilings, split, features,
 * predictedHoldout, teacherHoldout, nodeOf }`. Pure: the caller supplies every
 * lookup.
 */
export function trainStudent({ goldSet, ratings, personaIds, packOf, showOf, embeddingOf, taxonomyRoots, embedder = null, goldSetSha256 = null, ratingsSha256 = null, grid = STUDENT_LAMBDA_GRID, ks = KNN_KS, weights = BLEND_WEIGHTS, folds = 5, teacherRetest = {} }) {
  const split = splitRows(goldSet, ratings);
  const train = buildFeatures(split.train, { packOf, showOf, embeddingOf, taxonomyRoots });
  const hold = buildFeatures(split.holdout, { packOf, showOf, embeddingOf, taxonomyRoots });
  if (!train.keys.length) throw new Error("trainStudent: no training rows with an embedding");
  const keys = [...train.keys, ...hold.keys];
  const X = [...train.X, ...hold.X];
  const Y = keys.map((k) => targetRow(ratings.shows[k].personas, personaIds));
  const trainRows = train.keys.map((_, i) => i);
  const dim = X[0].length - featureNames(0, taxonomyRoots).length;
  const E = X.map((x) => x.subarray(0, dim));
  const keyOf = (r) => keys[r];
  const nFolds = Math.min(folds, trainRows.length);
  // Every choice below sees `trainRows` only.
  const config = chooseStudentConfig(X, E, Y, { rows: trainRows, personaCount: personaIds.length, folds: nFolds, grid, ks, weights, keyOf });
  let model = fitStudent(X, Y, {
    rows: trainRows,
    config,
    oofFit: config.oofFit,
    personaIds,
    featureNames: featureNames(dim, taxonomyRoots),
    embedder,
    keyOf,
    dim,
    trainedOn: { n: train.keys.length, holdout_n: hold.keys.length, gold_set_sha256: goldSetSha256, ratings_sha256: ratingsSha256, ratings_built_at: ratings.built_at ?? null },
  });
  model.selection = {
    folds: nFolds,
    criterion: "out-of-fold MSE on each persona's fit, training rows only",
    lambda_grid: [...grid],
    knn_ks: [...ks],
    blend_weights: [...weights],
    personas: Object.fromEntries(personaIds.map((pid, p) => [pid, config.personas[p]])),
  };
  // The holdout's one look: predicted with the kNN over the training rows.
  const knn = knnIndex(trainRows.map(keyOf), trainRows.map((r) => E[r]), trainRows.map((r) => Y[r]));
  const featuresByKey = Object.fromEntries(hold.keys.map((k, i) => [k, hold.X[i]]));
  const predictedHoldout = predictTable(model, featuresByKey, { knn });
  const teacherHoldout = { shows: Object.fromEntries(hold.keys.map((k) => [k, ratings.shows[k]])) };
  const nodeOf = nodeMapOf(goldSet);
  const ceilings = gateCeilings(teacherRetest);
  const verdict = hold.keys.length ? gate(predictedHoldout, teacherHoldout, { nodeOf, ceilings }) : { pass: false, per_metric: {}, failing_subscores: [] };
  model = applyGate(model, verdict);
  return { model, verdict, config, ceilings, split, features: { train, holdout: hold }, predictedHoldout, teacherHoldout, nodeOf };
}

/* ---------------------------------------------------------------- report */

/** The teacher's joint-vs-joint retest per persona: the gold report's table
    whose header has a "mean retest" column. `{}` when there is none. */
export function teacherRetestFrom(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const head = cells(lines[i]).map((c) => c.toLowerCase());
    const col = head.indexOf("mean retest");
    if (col < 0) continue;
    const out = {};
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const row = cells(lines[j]);
      const pid = row[0].replace(/\*/g, "").trim();
      const v = Number(row[col]);
      if (pid && Number.isFinite(v)) out[pid] = v;
    }
    return out;
  }
  return {};
}

function fitPairs(teacher, predicted, pid, keys) {
  const t = [];
  const s = [];
  for (const k of keys) {
    const tv = teacher.shows[k]?.personas?.[pid]?.[0];
    const sv = predicted.shows[k]?.personas?.[pid]?.[0];
    if (isNum(tv) && isNum(sv)) {
      t.push(tv);
      s.push(sv);
    }
  }
  return { t, s };
}

const mae = (t, s) => (t.length ? mean(t.map((v, i) => Math.abs(v - s[i]))) : null);

/**
 * Per persona on the holdout: Spearman and MAE on `fit` over every show and
 * over the shows the teacher rated HIGH_FIT or more, the persona's own
 * within-node tau, and the teacher's retest ceiling.
 */
export function perPersonaTable({ teacherHoldout, predictedHoldout, personaIds, nodeOf, teacherRetest = {}, bars = {} }) {
  const keys = Object.keys(teacherHoldout.shows).sort();
  return personaIds.map((pid) => {
    const all = fitPairs(teacherHoldout, predictedHoldout, pid, keys);
    const highKeys = keys.filter((k) => (teacherHoldout.shows[k]?.personas?.[pid]?.[0] ?? 0) >= HIGH_FIT);
    const high = fitPairs(teacherHoldout, predictedHoldout, pid, highKeys);
    const only = (doc) => ({ shows: Object.fromEntries(Object.entries(doc.shows).map(([k, v]) => [k, { personas: { [pid]: v.personas[pid] } }])) });
    const tau = withinNodeTau(only(teacherHoldout), nodeOf, only(predictedHoldout), { field: "fit" });
    return {
      persona: pid,
      n: all.t.length,
      spearman: spearman(all.t, all.s),
      mae: mae(all.t, all.s),
      high_n: high.t.length,
      high_spearman: high.t.length >= 3 ? spearman(high.t, high.s) : null,
      high_mae: mae(high.t, high.s),
      high_student_mean: mean(high.s),
      tau: tau.mean,
      retest: isNum(teacherRetest[pid]) ? teacherRetest[pid] : null,
      bar: isNum(bars[pid]) ? bars[pid] : null,
    };
  });
}

const f3 = (v) => (isNum(v) ? v.toFixed(3) : "n/a");
const f2 = (v) => (isNum(v) ? v.toFixed(2) : "n/a");
const ok = (b) => (b ? "pass" : "**fail**");

/** The generated report block (between REPORT_BEGIN and REPORT_END). */
export function renderReport({ verdict, config, ceilings, split, features, model, table }) {
  const m = verdict.per_metric;
  const pids = model.persona_ids;
  const L = [];
  L.push(REPORT_BEGIN);
  L.push(`Inputs: ${split.train.length + split.holdout.length} rated gold shows (${split.train.length} training, ${split.holdout.length} holdout); ${features.train.keys.length} training and ${features.holdout.keys.length} holdout rows with an embedding; ${model.feature_names.length} features; ${pids.length} personas; ratings built ${model.trained_on?.ratings_built_at ?? "n/a"}.`);
  L.push("");
  L.push(`Every choice (per-persona lambda, kNN k and blend weight, calibration) was made by ${model.selection?.folds ?? 5}-fold CV on the ${features.train.keys.length} training rows only. The holdout was predicted once, after the choices were fixed.`);
  L.push("");
  L.push(`**Gate: ${verdict.pass ? "PASS" : "FAIL"}.** Bars per the D4 amendment (RV-32): per-persona Spearman bar = min(${GATE_THRESHOLDS.spearman}, ${CEILING_FACTOR} x the persona's teacher retest Spearman); within-node tau bar = min(${GATE_THRESHOLDS.withinNodeTau}, ${CEILING_FACTOR} x the tau ceiling); alpha on fit and the sub-score rule unchanged.`);
  L.push("");
  L.push("| metric | value | bar | result |");
  L.push("|---|---|---|---|");
  L.push(`| alpha (interval) on fit | ${f3(m.fit_alpha.value)} | ${m.fit_alpha.threshold} | ${ok(m.fit_alpha.pass)} |`);
  L.push(`| per-persona Spearman on fit (personas at or above their own bar) | ${pids.length - (m.spearman.failing?.length ?? 0)} of ${pids.length} | per persona, below | ${ok(m.spearman.pass)} |`);
  L.push(`| mean within-node Kendall tau on fit (${m.within_node_tau.groups} groups) | ${f3(m.within_node_tau.value)} | ${f3(m.within_node_tau.threshold)} | ${ok(m.within_node_tau.pass)} |`);
  for (const [sub, v] of Object.entries(m.subscore_alpha)) L.push(`| alpha on ${sub} (sub-score) | ${f3(v.alpha)} | ${v.threshold} | ${v.pass ? "kept" : "**dropped**"} |`);
  for (const [f, v] of Object.entries(m.reported)) L.push(`| alpha on ${f} (reported, not gated) | ${f3(v.alpha)} | - | - |`);
  L.push("");
  L.push(`Failing sub-scores (dropped from every prediction): ${verdict.failing_subscores.length ? verdict.failing_subscores.join(", ") : "none"}.`);
  L.push(`Personas under their own Spearman bar: ${m.spearman.failing?.length ? m.spearman.failing.join(", ") : "none"}.`);
  L.push("");
  L.push(`Ceilings, computed by \`gateCeilings\` from the committed gold report: ${ceilings?.method ?? "n/a"}. Within-node tau ceiling ${f3(ceilings?.within_node_tau)}, so its bar is ${f3(m.within_node_tau.threshold)}.`);
  L.push("");
  L.push(`**Per persona on the holdout** (fit; "3+" = the shows the teacher rated ${HIGH_FIT} or more; ceiling = the teacher's own joint-vs-joint retest Spearman, the gold report's mean retest column; bar = min(${GATE_THRESHOLDS.spearman}, ${CEILING_FACTOR} x ceiling))`);
  L.push("");
  L.push("| persona | n | Spearman | bar | MAE | 3+ n | 3+ Spearman | 3+ MAE | 3+ student mean | within-node tau | ceiling (teacher retest) |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of table) L.push(`| ${r.persona} | ${r.n} | ${f3(r.spearman)}${isNum(r.spearman) && isNum(r.bar) && r.spearman < r.bar ? " **<**" : ""} | ${f3(r.bar)} | ${f2(r.mae)} | ${r.high_n} | ${f3(r.high_spearman)} | ${f2(r.high_mae)} | ${f2(r.high_student_mean)} | ${f3(r.tau)} | ${f3(r.retest)} |`);
  L.push("");
  L.push("**Chosen configuration** (per persona, by CV on the training rows)");
  L.push("");
  L.push("| persona | lambda | kNN k | blend weight | calibration | CV MSE on fit, ridge alone | CV MSE on fit, chosen |");
  L.push("|---|---|---|---|---|---|---|");
  pids.forEach((pid, p) => {
    const c = config.personas[p];
    const ridgeAlone = config.cv.lambda[p].find((s) => s.lambda === c.lambda)?.mse;
    const blend = config.cv.blend[p].find((s) => s.weight === c.weight && s.k === c.k)?.mse;
    const cal = config.cv.calibration[p].find((s) => s.calibration === c.calibration)?.mse;
    L.push(`| ${pid} | ${c.lambda} | ${c.k ?? "-"} | ${c.weight} | ${c.calibration} | ${f3(ridgeAlone)} | ${f3(c.calibration === "none" ? blend : cal)} |`);
  });
  L.push("");
  const grid = config.cv.lambda[0].map((s) => s.lambda);
  L.push(`**CV table, (a) lambda** (out-of-fold MSE on fit, ridge alone; the chosen cell in bold)`);
  L.push("");
  L.push(`| persona | ${grid.join(" | ")} |`);
  L.push(`|---|${grid.map(() => "---").join("|")}|`);
  pids.forEach((pid, p) => L.push(`| ${pid} | ${config.cv.lambda[p].map((s) => (s.lambda === config.personas[p].lambda ? `**${f3(s.mse)}**` : f3(s.mse))).join(" | ")} |`));
  L.push("");
  const cands = config.cv.blend[0].map((s) => (s.weight === 0 ? "w 0" : `w ${s.weight}, k ${s.k}`));
  L.push(`**CV table, (b) kNN blend** (out-of-fold MSE on fit at the persona's lambda; w = the kNN's weight, k = neighbours; the chosen cell in bold)`);
  L.push("");
  L.push(`| persona | ${cands.join(" | ")} |`);
  L.push(`|---|${cands.map(() => "---").join("|")}|`);
  pids.forEach((pid, p) => L.push(`| ${pid} | ${config.cv.blend[p].map((s) => (s.weight === config.personas[p].weight && s.k === config.personas[p].k ? `**${f3(s.mse)}**` : f3(s.mse))).join(" | ")} |`));
  L.push("");
  L.push(`**CV table, (c) calibration** (MSE on fit of the chosen blend's out-of-fold predictions, a second ${model.selection?.folds ?? 5}-fold over them; the chosen cell in bold)`);
  L.push("");
  L.push("| persona | none | isotonic |");
  L.push("|---|---|---|");
  pids.forEach((pid, p) => L.push(`| ${pid} | ${config.cv.calibration[p].map((s) => (s.calibration === config.personas[p].calibration ? `**${f3(s.mse)}**` : f3(s.mse))).join(" | ")} |`));
  L.push(REPORT_END);
  return L.join("\n");
}

/** Replaces the generated block in `text` (or appends it). */
export function spliceReport(text, block) {
  const a = text.indexOf(REPORT_BEGIN);
  const b = text.indexOf(REPORT_END);
  if (a >= 0 && b > a) return text.slice(0, a) + block + text.slice(b + REPORT_END.length);
  return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
}

/* --------------------------------------------------------------- predict */

const AUDIO_SLOTS = new Set(["host_style", "production", "ad_load"]);

/** One persona's published row (RATING_SLOTS order) from its TARGETS-order prediction. */
export function predictedSlots(values, tier) {
  return RATING_SLOTS.map((slot) => {
    if (AUDIO_SLOTS.has(slot)) return null;
    const c = TARGETS.indexOf(slot);
    const v = c >= 0 ? finalise(slot, values[c]) : null;
    if (v === null) return null;
    return slot === "confidence" ? Math.round(capConfidence(v, tier) * 100) / 100 : v;
  });
}

/** The ordered taxonomy roots a model was trained with (from its feature names). */
export function modelRoots(model) {
  return (model.feature_names ?? []).filter((n) => n.startsWith("root:")).map((n) => n.slice(5));
}

/**
 * The predicted-ratings document. Refused (throws) unless `model.gate.pass`.
 * Every key that the teacher rated, whose pack is `none`-tier or that has no
 * embedding is left out; counts are returned beside the document.
 */
export function predictCatalogue(model, { keys, ratings, packOf, showOf, embeddingOf, modelSha256, builtAt }) {
  if (model?.gate?.pass !== true) throw new Error("refused: the student's gate did not pass (student-model.json gate.pass is not true); nothing is predicted");
  const taxonomyRoots = modelRoots(model);
  const rated = ratings?.shows ?? {};
  const knn = knnIndexFor(model, { embeddingOf, targetsOf: (k) => targetRow(rated[k]?.personas, model.persona_ids) });
  const counts = { candidates: keys.length, teacher_rated: 0, none_tier: 0, no_embedding: 0, predicted: 0 };
  const shows = {};
  for (const key of [...keys].sort()) {
    if (rated[key]) {
      counts.teacher_rated++;
      continue;
    }
    const embedding = embeddingOf(key);
    const pack = packOf(key);
    if (!pack || pack.tier === "none") {
      counts.none_tier++;
      continue;
    }
    if (!embedding) {
      counts.no_embedding++;
      continue;
    }
    const matrix = predict(model, featuresFor(showOf(key), pack, embedding, { taxonomyRoots }), { knn, key });
    const personas = {};
    model.persona_ids.forEach((pid, p) => {
      personas[pid] = predictedSlots(matrix[p], pack.tier);
    });
    shows[key] = { tier: pack.tier, personas };
    counts.predicted++;
  }
  return { doc: { version: PREDICTED_VERSION, model_sha256: modelSha256, built_at: builtAt, shows }, counts };
}

export const serializePredicted = (doc) => `${JSON.stringify(doc)}\n`;

/* ----------------------------------------------------------------- check */

/** Problems binding the model to the gold set and the predictions to the
    model (`[]` when sound). `predictedText` null = no predicted file. */
export function checkBindings({ goldSetText, modelText, predictedText = null, ratingsText = null }) {
  const problems = [];
  let model;
  try {
    model = JSON.parse(modelText);
  } catch (e) {
    return [`student-model.json is not JSON: ${e.message}`];
  }
  problems.push(...checkModel(model));
  const goldSha = sha256Text(goldSetText);
  if (model?.trained_on?.gold_set_sha256 !== goldSha) problems.push(`student-model.json was trained on gold set ${model?.trained_on?.gold_set_sha256 ?? "(none)"}, the committed gold set is ${goldSha}; retrain with --train`);
  if (ratingsText !== null && model?.knn) {
    const ratingsSha = sha256Text(ratingsText);
    if (model?.trained_on?.ratings_sha256 !== ratingsSha) problems.push(`student-model.json's kNN reads ratings ${model?.trained_on?.ratings_sha256 ?? "(none)"}, the committed ratings.json is ${ratingsSha}; retrain with --train`);
  }
  if (predictedText !== null) {
    let predicted;
    try {
      predicted = JSON.parse(predictedText);
    } catch (e) {
      return [...problems, `ratings-predicted.json is not JSON: ${e.message}`];
    }
    const modelSha = sha256Text(modelText);
    if (predicted?.model_sha256 !== modelSha) problems.push(`ratings-predicted.json was built from model ${predicted?.model_sha256 ?? "(none)"}, the committed model is ${modelSha}; rerun --predict`);
    if (model?.gate?.pass !== true) problems.push("ratings-predicted.json exists but the model's gate did not pass");
  }
  return problems;
}

/* ------------------------------------------------------------------- I/O */

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Every lookup the CLI needs, from files. */
export function loadInputs({ root = REPO_ROOT, env = process.env, embeddingsFile = null } = {}) {
  const paths = predictPaths({ root, env });
  const sources = loadSources({ root, env });
  const daiShows = existsSync(paths.dai) ? readJson(paths.dai).shows ?? {} : {};
  const embFile = embeddingsFile ? resolvePath(process.cwd(), embeddingsFile) : embeddingsPath(paths.embeddingsDir, DEFAULT_EMBEDDER.kind, DEFAULT_EMBEDDER);
  if (!existsSync(embFile)) throw new Error(`no embeddings at ${embFile}; run tools/recommender/embed.mjs --keys gold --embedder transformers (RV-12)`);
  const emb = readJson(embFile);
  const vectors = new Map(emb.keys.map((k, i) => [k, emb.vectors[i]]));
  const showOf = (key) => {
    const s = resolveShow(key, sources);
    return { dai: s.acid ? daiShows[s.acid]?.dai ?? null : null, episode_count: s.breadth?.episode_count ?? s.curated?.episode_count ?? null };
  };
  const taxonomy = readJson(paths.taxonomy);
  return {
    paths,
    sources,
    embeddingsFile: embFile,
    embedder: { kind: DEFAULT_EMBEDDER.kind, name: emb.model.name, revision: emb.model.revision ?? "", dim: emb.model.dim },
    embeddingOf: (key) => vectors.get(key),
    packOf: (key) => buildEvidence(key, sources),
    showOf,
    taxonomyRoots: taxonomy.nodes.filter((n) => n.parent === null).map((n) => n.id),
    personaIds: readJson(paths.profiles).personas.map((p) => p.id),
  };
}

/* -------------------------------------------------------------------- CLI */

const USAGE =
  "usage: node tools/recommender/predict.mjs --train [--embeddings <file>] [--grid a,b,c]\n" +
  "       node tools/recommender/predict.mjs --predict [--embeddings <file>]\n" +
  "       node tools/recommender/predict.mjs --check";

export function parseArgs(argv) {
  const args = { mode: null, embeddings: null, grid: null };
  const setMode = (m) => {
    if (args.mode) throw new Error(`one of --train, --predict, --check; ${USAGE}`);
    args.mode = m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--train") setMode("train");
    else if (a === "--predict") setMode("predict");
    else if (a === "--check") setMode("check");
    else if (a === "--embeddings") args.embeddings = argv[++i];
    else if (a === "--grid") {
      args.grid = String(argv[++i] ?? "").split(",").map(Number);
      if (!args.grid.length || !args.grid.every((x) => Number.isFinite(x) && x >= 0)) throw new Error(`--grid must be comma-separated non-negative numbers; ${USAGE}`);
    } else throw new Error(`unknown argument ${a}; ${USAGE}`);
  }
  if (!args.mode) throw new Error(USAGE);
  return args;
}

export async function main(argv = process.argv.slice(2), { root = REPO_ROOT, env = process.env, now = () => new Date(), stdout = process.stdout, stderr = process.stderr, inputs = null } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return 2;
  }
  const paths = predictPaths({ root, env });
  try {
    if (args.mode === "check") {
      const problems = existsSync(paths.model)
        ? checkBindings({ goldSetText: readFileSync(paths.goldSet, "utf8"), modelText: readFileSync(paths.model, "utf8"), predictedText: existsSync(paths.predicted) ? readFileSync(paths.predicted, "utf8") : null, ratingsText: existsSync(paths.ratings) ? readFileSync(paths.ratings, "utf8") : null })
        : [`no student model at ${paths.model}; run --train`];
      for (const p of problems) stderr.write(`${p}\n`);
      stdout.write(problems.length ? `predict --check: ${problems.length} problem(s)\n` : `predict --check: ok${existsSync(paths.predicted) ? "" : " (no ratings-predicted.json)"}\n`);
      return problems.length ? 1 : 0;
    }

    if (args.mode === "predict") {
      const modelText = readFileSync(paths.model, "utf8");
      const model = loadModel(modelText);
      if (model.gate?.pass !== true) {
        stderr.write("refused: the student's gate did not pass (student-model.json gate.pass is not true); nothing is predicted\n");
        return 1;
      }
      const inp = inputs ?? loadInputs({ root, env, embeddingsFile: args.embeddings });
      const emb = inp.embedder;
      if (model.embedder && (model.embedder.name !== emb.name || model.embedder.dim !== emb.dim)) throw new Error(`the embeddings (${emb.name}, ${emb.dim}) are not the model's (${model.embedder.name}, ${model.embedder.dim})`);
      const ratings = readJson(paths.ratings);
      const keys = keysFor("all", inp.sources);
      const { doc, counts } = predictCatalogue(model, { keys, ratings, packOf: inp.packOf, showOf: inp.showOf, embeddingOf: inp.embeddingOf, modelSha256: sha256Text(modelText), builtAt: now().toISOString() });
      writeAtomic(paths.predicted, serializePredicted(doc));
      stdout.write(`${JSON.stringify({ ...counts, path: paths.predicted })}\n`);
      return 0;
    }

    // --train
    const inp = inputs ?? loadInputs({ root, env, embeddingsFile: args.embeddings });
    const goldSetText = readFileSync(paths.goldSet, "utf8");
    const goldSet = JSON.parse(goldSetText);
    const ratingsText = readFileSync(paths.ratings, "utf8");
    const ratings = JSON.parse(ratingsText);
    const teacherRetest = existsSync(paths.goldReport) ? teacherRetestFrom(readFileSync(paths.goldReport, "utf8")) : {};
    const res = trainStudent({
      goldSet,
      ratings,
      personaIds: inp.personaIds,
      packOf: inp.packOf,
      showOf: inp.showOf,
      embeddingOf: inp.embeddingOf,
      taxonomyRoots: inp.taxonomyRoots,
      embedder: inp.embedder,
      goldSetSha256: sha256Text(goldSetText),
      ratingsSha256: sha256Text(ratingsText),
      grid: args.grid ?? STUDENT_LAMBDA_GRID,
      teacherRetest,
    });
    writeAtomic(paths.model, serializeModel(res.model));
    const table = perPersonaTable({ teacherHoldout: res.teacherHoldout, predictedHoldout: res.predictedHoldout, personaIds: inp.personaIds, nodeOf: res.nodeOf, teacherRetest, bars: res.verdict.per_metric.spearman?.bars ?? {} });
    const block = renderReport({ verdict: res.verdict, config: res.config, ceilings: res.ceilings, split: res.split, features: res.features, model: res.model, table });
    const existing = existsSync(paths.report) ? readFileSync(paths.report, "utf8") : "# Persona-rating student (RV-25), 2026-10\n";
    writeAtomic(paths.report, spliceReport(existing, block));
    stdout.write(`${JSON.stringify({ pass: res.verdict.pass, failing_personas: res.verdict.per_metric.spearman?.failing ?? [], train: res.features.train.keys.length, holdout: res.features.holdout.keys.length, failing_subscores: res.verdict.failing_subscores, model: paths.model, report: paths.report })}\n`);
    return 0;
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return 1;
  }
}

if (isEntryScript(import.meta.url)) process.exitCode = await main();
