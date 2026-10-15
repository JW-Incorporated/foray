/* RV-14 (docs/roadmap/recommender-v1.md, D4 (d), D3, D12): the student.

   WHAT THIS IS. A ridge regression from features every catalogued show has
   (its evidence-pack embedding, RV-12, plus a few catalogue facts) to the
   teacher's rating vector, so the gold set's persona ratings can be carried
   to the ~26k catalogued shows (RV-25). It is gated: the student's
   predictions on the held-out gold shows must agree with the teacher by
   RV-11's statistics before anything it predicts is written.

   FEATURES (`featuresFor`, names from `featureNames`), in this order:
     embedding (the embedder's dim: 384 transformers, 64 stub)
     root nodes (41, multi-hot: a show whose node list spans two roots sets both)
     evidence tier (3: transcript, episode-metadata, show-metadata; `none` sets none)
     length band (4: sample.mjs `lengthBand` of `typical_duration_min`)
     cadence (7: daily, weekly, biweekly, monthly, irregular, ended, none)
     explicit (1), dai (3: true / false / unknown, sample.mjs `daiValue`),
     label_scope === "general" (1), log episode count (1), bias (1)
   The rater-hygiene keys (D7: chart_rank, counts, artist_name, in_curated)
   are never read. DAI is a student feature by D12; raters never see it.

   TARGETS. Per persona, seven: fit, return_prob, topic_fit, depth,
   accessibility, binge_vs_dip, confidence. host_style, production and ad_load
   are NEVER predicted (teacher-only, D3): they need audio evidence, and a
   student reading an embedding has none.

   RIDGE (`fitRidge`). Closed form w = (Xs^T Xs + lambda I)^-1 Xs^T y on
   standardised, centred features, by Gaussian elimination with partial
   pivoting (no npm dependency: tools/ root is dependency-free). The means and
   scales are learned on the training rows only (`rows`), stored in the model,
   and applied unchanged to every row predicted later. The intercept is
   fitted, not penalised. A target column with missing values is fitted on the
   rows that have it; columns sharing a row mask share one Gram matrix.

   THE GATE (`gate`). On the held-out shows, teacher vs student, using
   agreement.mjs (RV-11): Krippendorff's alpha (interval) on `fit` >= 0.80;
   Spearman >= 0.75 for every persona's `fit` column; mean within-node Kendall
   tau >= 0.60; those three decide `pass`. Each predicted sub-score (topic_fit,
   depth, accessibility, binge_vs_dip) needs alpha >= 0.67 or it is listed in
   `failing_subscores` and dropped from what the model predicts (null, never a
   fabricated number). return_prob and confidence alphas are reported, not
   gated (the card gates fit and the sub-scores only).

   THE MODEL FILE (`serializeModel`, `loadModel`):
   data/recommender/student-model.json = { version, embedder, feature_names,
   means, scales, lambda, persona_ids, targets, dropped, intercepts (one row of
   7 per persona), weights (per persona, one row of 7 per feature), trained_on:
   { n, gold_set_sha256, ratings_built_at }, gate }. RV-25 writes it.

   No model call, no network, no file I/O: pure functions. Nothing on a live
   app path reads anything this module produces (dark until RV-27). */

import { AUDIO_SUBSCORES, RATING_SLOTS, SUBSCORES } from "./schema.mjs";
import { krippendorffAlpha, spearman, toTable, withinNodeTau } from "./agreement.mjs";
import { daiValue, lengthBand } from "./sample.mjs";

export const MODEL_VERSION = 1;

/** The seven predicted fields per persona, in model order. */
export const TARGETS = Object.freeze(["fit", "return_prob", "topic_fit", "depth", "accessibility", "binge_vs_dip", "confidence"]);
/** The sub-scores the gate holds to the sub-score alpha. */
export const GATED_SUBSCORES = Object.freeze(SUBSCORES.filter((s) => !AUDIO_SUBSCORES.includes(s)));

export const GATE_THRESHOLDS = Object.freeze({
  fitAlpha: 0.8,
  subscoreAlpha: 0.67,
  spearman: 0.75,
  withinNodeTau: 0.6,
});

export const TIER_FEATURES = Object.freeze(["transcript", "episode-metadata", "show-metadata"]);
export const LENGTH_BANDS = Object.freeze(["<=30", "31-60", ">60", "unknown"]);
/** The catalogue's cadence_hint vocabulary plus the two evidence.mjs
    `cadenceFromDates` adds (daily, irregular); `none` is a null hint. */
export const CADENCES = Object.freeze(["daily", "weekly", "biweekly", "monthly", "irregular", "ended", "none"]);
export const DAI_VALUES = Object.freeze(["true", "false", "unknown"]);
/** A representative count per evidence.mjs `episodeCountBand`, used when the
    caller has no exact count. */
export const EPISODE_BAND_COUNT = Object.freeze({ "<10": 5, "10-49": 30, "50-199": 125, "200-999": 600, "1000+": 1500 });

export const DEFAULT_LAMBDA_GRID = Object.freeze([0.01, 0.1, 1, 10, 100, 1000]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/* ------------------------------------------------------------- features */

/** The feature names for an embedding of `dim` and the ordered root ids. */
export function featureNames(dim, taxonomyRoots) {
  return [
    ...Array.from({ length: dim }, (_, i) => `emb:${i}`),
    ...taxonomyRoots.map((r) => `root:${r}`),
    ...TIER_FEATURES.map((t) => `tier:${t}`),
    ...LENGTH_BANDS.map((b) => `length:${b}`),
    ...CADENCES.map((c) => `cadence:${c}`),
    "explicit",
    ...DAI_VALUES.map((d) => `dai:${d}`),
    "label_scope:general",
    "log_episode_count",
    "bias",
  ];
}

function episodeCountOf(show, pack) {
  for (const n of [show?.episode_count, show?.episode_count_in_feed, show?.episodes_total]) if (isNum(n) && n >= 0) return n;
  return EPISODE_BAND_COUNT[pack?.episode_count_band] ?? 0;
}

/**
 * The feature vector of one show. `pack` is its evidence pack (RV-03
 * `buildEvidence`); `embedding` its RV-12 vector; `show` the catalogue facts
 * the pack does not carry: `dai` (a dai-classification.json entry's value)
 * and, when known, an exact `episode_count`. `taxonomyRoots` is the ordered
 * list of root node ids (taxonomy.json nodes with parent null).
 */
export function featuresFor(show, pack, embedding, { taxonomyRoots } = {}) {
  if (!Array.isArray(taxonomyRoots) || !taxonomyRoots.length) throw new Error("featuresFor: taxonomyRoots is required");
  if (!embedding || typeof embedding.length !== "number" || !embedding.length) throw new Error("featuresFor: an embedding is required");
  const dim = embedding.length;
  const x = new Float64Array(featureNames(dim, taxonomyRoots).length);
  let o = 0;
  for (let i = 0; i < dim; i++) {
    const v = Number(embedding[i]);
    if (!Number.isFinite(v)) throw new Error(`featuresFor: embedding[${i}] is not finite`);
    x[o + i] = v;
  }
  o += dim;
  const roots = new Set((pack?.taxonomy_node_ids ?? []).filter((id) => typeof id === "string" && id).map((id) => id.split("/")[0]));
  taxonomyRoots.forEach((r, i) => {
    if (roots.has(r)) x[o + i] = 1;
  });
  o += taxonomyRoots.length;
  const tier = TIER_FEATURES.indexOf(pack?.tier);
  if (tier >= 0) x[o + tier] = 1;
  o += TIER_FEATURES.length;
  x[o + LENGTH_BANDS.indexOf(lengthBand(pack?.typical_duration_min))] = 1;
  o += LENGTH_BANDS.length;
  const cadence = CADENCES.indexOf(pack?.cadence_hint ?? "none");
  x[o + (cadence >= 0 ? cadence : CADENCES.indexOf("none"))] = 1;
  o += CADENCES.length;
  x[o++] = pack?.explicit === true ? 1 : 0;
  x[o + DAI_VALUES.indexOf(daiValue(show))] = 1;
  o += DAI_VALUES.length;
  x[o++] = pack?.label_scope === "general" ? 1 : 0;
  x[o++] = Math.log1p(episodeCountOf(show, pack));
  x[o++] = 1;
  return x;
}

/* --------------------------------------------------------------- targets */

/** One persona's seven targets from a ratings.json slot array (RATING_SLOTS
    order) or a results-file rating object; null where the teacher has none. */
export function targetsOf(entry) {
  return TARGETS.map((t) => {
    let v;
    if (Array.isArray(entry)) v = entry[RATING_SLOTS.indexOf(t)];
    else if (entry && typeof entry === "object") v = entry[t];
    return isNum(v) ? v : null;
  });
}

/** The flat target row (persona-major, 7 per persona) of one show's
    `personas` map, in `personaIds` order. */
export function targetRow(personas, personaIds) {
  return personaIds.flatMap((pid) => targetsOf(personas?.[pid]));
}

/* ----------------------------------------------------------------- ridge */

/** Means and scales (population standard deviation) of each column over the
    given rows. A constant column gets scale 1, so it standardises to 0. */
export function standardiser(X, rows) {
  const d = X[rows[0]].length;
  const means = new Float64Array(d);
  const scales = new Float64Array(d);
  for (const r of rows) for (let j = 0; j < d; j++) means[j] += X[r][j];
  for (let j = 0; j < d; j++) means[j] /= rows.length;
  for (const r of rows) {
    for (let j = 0; j < d; j++) {
      const e = X[r][j] - means[j];
      scales[j] += e * e;
    }
  }
  for (let j = 0; j < d; j++) {
    const s = Math.sqrt(scales[j] / rows.length);
    scales[j] = s > 1e-12 ? s : 1;
  }
  return { means, scales };
}

/**
 * Solves A W = B in place by Gaussian elimination with partial pivoting.
 * `A` is d x d (array of Float64Array), `B` is d x m. Throws on a singular A.
 */
export function solveLinear(A, B) {
  const d = A.length;
  const m = B[0]?.length ?? 0;
  let norm = 0;
  for (const row of A) for (const v of row) norm = Math.max(norm, Math.abs(v));
  const tiny = Math.max(norm, 1) * 1e-12;
  for (let k = 0; k < d; k++) {
    let p = k;
    for (let i = k + 1; i < d; i++) if (Math.abs(A[i][k]) > Math.abs(A[p][k])) p = i;
    if (Math.abs(A[p][k]) <= tiny) throw new Error(`solveLinear: singular matrix at column ${k}`);
    if (p !== k) {
      [A[p], A[k]] = [A[k], A[p]];
      [B[p], B[k]] = [B[k], B[p]];
    }
    const akk = A[k][k];
    for (let i = k + 1; i < d; i++) {
      const f = A[i][k] / akk;
      if (f === 0) continue;
      const Ai = A[i];
      const Ak = A[k];
      for (let j = k; j < d; j++) Ai[j] -= f * Ak[j];
      const Bi = B[i];
      const Bk = B[k];
      for (let c = 0; c < m; c++) Bi[c] -= f * Bk[c];
    }
  }
  const W = Array.from({ length: d }, () => new Float64Array(m));
  for (let i = d - 1; i >= 0; i--) {
    for (let c = 0; c < m; c++) {
      let s = B[i][c];
      for (let j = i + 1; j < d; j++) s -= A[i][j] * W[j][c];
      W[i][c] = s / A[i][i];
    }
  }
  return W;
}

/**
 * Everything a ridge solve needs that does not depend on lambda, so
 * `chooseLambda` builds it once per fold: the standardiser learned on `rows`
 * and, per group of target columns sharing a row mask, the centred Gram
 * matrix and cross-products.
 */
function prepareRidge(X, Y, rows) {
  if (!rows.length) throw new Error("fitRidge: no training rows");
  const { means, scales } = standardiser(X, rows);
  const d = means.length;
  const m = Y[rows[0]].length;
  const Xs = new Map(rows.map((r) => [r, Float64Array.from(X[r], (v, j) => (v - means[j]) / scales[j])]));
  const groups = new Map();
  for (let c = 0; c < m; c++) {
    const have = rows.filter((r) => isNum(Y[r][c]));
    const key = have.join(",");
    if (!groups.has(key)) groups.set(key, { rows: have, cols: [] });
    groups.get(key).cols.push(c);
  }
  const prepared = [];
  for (const { rows: gr, cols } of groups.values()) {
    if (!gr.length) {
      prepared.push({ cols, empty: true });
      continue;
    }
    const xbar = new Float64Array(d);
    for (const r of gr) {
      const xs = Xs.get(r);
      for (let j = 0; j < d; j++) xbar[j] += xs[j];
    }
    for (let j = 0; j < d; j++) xbar[j] /= gr.length;
    const ybar = cols.map((c) => gr.reduce((s, r) => s + Y[r][c], 0) / gr.length);
    const G = Array.from({ length: d }, () => new Float64Array(d));
    const XtY = Array.from({ length: d }, () => new Float64Array(cols.length));
    const e = new Float64Array(d);
    for (const r of gr) {
      const xs = Xs.get(r);
      for (let j = 0; j < d; j++) e[j] = xs[j] - xbar[j];
      for (let i = 0; i < d; i++) {
        const ei = e[i];
        if (ei === 0) continue;
        const Gi = G[i];
        for (let j = i; j < d; j++) Gi[j] += ei * e[j];
        const XtYi = XtY[i];
        cols.forEach((c, k) => {
          XtYi[k] += ei * (Y[r][c] - ybar[k]);
        });
      }
    }
    for (let i = 0; i < d; i++) for (let j = 0; j < i; j++) G[i][j] = G[j][i];
    prepared.push({ cols, xbar, ybar, G, XtY });
  }
  return { means, scales, d, m, prepared };
}

function solveRidge(prep, lambda) {
  const { d, m } = prep;
  const W = Array.from({ length: d }, () => new Float64Array(m));
  const intercept = new Float64Array(m);
  for (const g of prep.prepared) {
    if (g.empty) {
      for (const c of g.cols) intercept[c] = NaN;
      continue;
    }
    const A = g.G.map((row, i) => {
      const a = Float64Array.from(row);
      a[i] += lambda;
      return a;
    });
    const B = g.XtY.map((row) => Float64Array.from(row));
    const Wg = solveLinear(A, B);
    g.cols.forEach((c, k) => {
      let b = g.ybar[k];
      for (let j = 0; j < d; j++) {
        W[j][c] = Wg[j][k];
        b -= g.xbar[j] * Wg[j][k];
      }
      intercept[c] = b;
    });
  }
  return { W, intercept };
}

/**
 * Ridge regression of Y (n x m, null where a target is missing) on X (n x d),
 * fitted on `rows` (default every row): standardisation, centring and the
 * solve all use those rows only. Returns `{ means, scales, lambda, W (d x m,
 * standardised space), intercept (m) }`.
 */
export function fitRidge(X, Y, { lambda = 1, rows = null } = {}) {
  if (!(lambda >= 0)) throw new Error("fitRidge: lambda must be >= 0");
  if (X.length !== Y.length) throw new Error(`fitRidge: ${X.length} feature rows but ${Y.length} target rows`);
  const train = rows ?? X.map((_, i) => i);
  const prep = prepareRidge(X, Y, train);
  return { means: prep.means, scales: prep.scales, lambda, ...solveRidge(prep, lambda) };
}

/** The raw predictions (m) of a `fitRidge` result for one feature row. */
export function predictRaw(fit, x) {
  const { means, scales, W, intercept } = fit;
  const out = Float64Array.from(intercept);
  for (let j = 0; j < means.length; j++) {
    const xs = (x[j] - means[j]) / scales[j];
    if (xs === 0) continue;
    const Wj = W[j];
    for (let c = 0; c < out.length; c++) out[c] += xs * Wj[c];
  }
  return out;
}

/** The fit as coefficients on the raw features: `{ coef (d x m), intercept (m) }`. */
export function rawCoefficients(fit) {
  const { means, scales, W, intercept } = fit;
  const coef = W.map((row, j) => Float64Array.from(row, (w) => w / scales[j]));
  const b = Float64Array.from(intercept);
  for (let j = 0; j < means.length; j++) for (let c = 0; c < b.length; c++) b[c] -= coef[j][c] * means[j];
  return { coef, intercept: b };
}

/**
 * k-fold choice of lambda on the training rows: row i is in fold i % folds;
 * each fold's model is standardised and fitted on the other folds only. The
 * score is the mean squared error over the held-out finite targets; the
 * lowest wins, a tie going to the larger lambda (the simpler model).
 */
export function chooseLambda(X, Y, { folds = 5, grid = DEFAULT_LAMBDA_GRID, rows = null } = {}) {
  if (!grid.length) throw new Error("chooseLambda: empty grid");
  const train = rows ?? X.map((_, i) => i);
  if (train.length < folds) throw new Error(`chooseLambda: ${train.length} rows for ${folds} folds`);
  const sse = new Float64Array(grid.length);
  let count = 0;
  for (let f = 0; f < folds; f++) {
    const fitRows = train.filter((_, i) => i % folds !== f);
    const testRows = train.filter((_, i) => i % folds === f);
    const prep = prepareRidge(X, Y, fitRows);
    grid.forEach((lambda, g) => {
      const fit = { means: prep.means, scales: prep.scales, ...solveRidge(prep, lambda) };
      for (const r of testRows) {
        const p = predictRaw(fit, X[r]);
        Y[r].forEach((y, c) => {
          if (isNum(y) && Number.isFinite(p[c])) {
            sse[g] += (p[c] - y) ** 2;
            if (g === 0) count += 1;
          }
        });
      }
    });
  }
  const scores = grid.map((lambda, g) => ({ lambda, mse: count ? sse[g] / count : null }));
  let best = 0;
  for (let g = 1; g < grid.length; g++) {
    if (scores[g].mse === null) continue;
    if (scores[best].mse === null || scores[g].mse < scores[best].mse || (scores[g].mse === scores[best].mse && grid[g] > grid[best])) best = g;
  }
  return { lambda: grid[best], scores };
}

/* ----------------------------------------------------------------- model */

/** A student model from a `fitRidge` over flat target rows (`targetRow`). */
export function buildModel(fit, { personaIds, featureNames: names, embedder = null, trainedOn = null }) {
  const P = personaIds.length;
  const T = TARGETS.length;
  if (fit.intercept.length !== P * T) throw new Error(`buildModel: ${fit.intercept.length} target columns for ${P} personas x ${T}`);
  if (names && names.length !== fit.means.length) throw new Error(`buildModel: ${names.length} feature names for ${fit.means.length} features`);
  return {
    version: MODEL_VERSION,
    embedder,
    feature_names: names ? [...names] : null,
    means: Array.from(fit.means),
    scales: Array.from(fit.scales),
    lambda: fit.lambda,
    persona_ids: [...personaIds],
    targets: [...TARGETS],
    dropped: [],
    intercepts: personaIds.map((_, p) => Array.from(fit.intercept.slice(p * T, p * T + T))),
    weights: personaIds.map((_, p) => fit.W.map((row) => Array.from(row.slice(p * T, p * T + T)))),
    trained_on: trainedOn,
    gate: null,
  };
}

/**
 * The P x 7 prediction for one feature row, persona rows in
 * `model.persona_ids` order, columns in TARGETS order. A target the gate
 * dropped is null. host_style, production and ad_load are not columns.
 */
export function predict(model, x) {
  const { means, scales, weights, intercepts } = model;
  if (x.length !== means.length) throw new Error(`predict: ${x.length} features, the model has ${means.length}`);
  const xs = Array.from(x, (v, j) => (v - means[j]) / scales[j]);
  const dropped = new Set(model.dropped ?? []);
  return model.persona_ids.map((_, p) =>
    TARGETS.map((t, c) => {
      if (dropped.has(t)) return null;
      let s = intercepts[p][c];
      const Wp = weights[p];
      for (let j = 0; j < xs.length; j++) if (xs[j] !== 0) s += xs[j] * Wp[j][c];
      return s;
    }),
  );
}

/** A predicted value as it is published: clamped to its scale, `fit` and the
    sub-scores to one decimal, the probabilities to two. */
export function finalise(target, value) {
  if (!isNum(value)) return null;
  if (target === "return_prob" || target === "confidence") return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
  return Math.round(Math.min(5, Math.max(1, value)) * 10) / 10;
}

/** Predictions in the ratings.json shape (`{ shows: { key: { personas: { pid:
    [RATING_SLOTS] } } } }`, audio slots null), finalised, so agreement.mjs
    reads them like the teacher. `featuresByKey` maps show_key to features. */
export function predictTable(model, featuresByKey) {
  const shows = {};
  for (const key of Object.keys(featuresByKey).sort()) {
    const matrix = predict(model, featuresByKey[key]);
    const personas = {};
    model.persona_ids.forEach((pid, p) => {
      personas[pid] = RATING_SLOTS.map((slot) => {
        const c = TARGETS.indexOf(slot);
        return c >= 0 ? finalise(slot, matrix[p][c]) : null;
      });
    });
    shows[key] = { personas };
  }
  return { shows };
}

/* ------------------------------------------------------------------ gate */

function alphaOf(teacher, predicted, field) {
  const t = toTable(teacher, { field });
  const s = toTable(predicted, { field });
  const units = [];
  for (const key of Object.keys(t).sort()) {
    if (!s[key]) continue;
    for (const pid of Object.keys(t[key]).sort()) if (pid in s[key]) units.push([t[key][pid], s[key][pid]]);
  }
  return krippendorffAlpha(units, { metric: "interval" });
}

const passes = (value, threshold) => value !== null && value !== undefined && value >= threshold;

/**
 * The student gate (research §4.4), teacher vs student on the held-out shows.
 * `predicted` and `teacher` are any shape agreement.mjs `toTable` reads
 * (`predictTable` output, ratings.json); `nodeOf` maps show_key to its root
 * node (function or map). Returns `{ pass, per_metric, failing_subscores }`.
 */
export function gate(predicted, teacher, { nodeOf, thresholds = GATE_THRESHOLDS } = {}) {
  const fitAlpha = alphaOf(teacher, predicted, "fit");
  const subscores = {};
  const failing = [];
  for (const sub of GATED_SUBSCORES) {
    const value = alphaOf(teacher, predicted, sub);
    const ok = passes(value, thresholds.subscoreAlpha);
    subscores[sub] = { alpha: value, threshold: thresholds.subscoreAlpha, pass: ok };
    if (!ok) failing.push(sub);
  }
  const reported = Object.fromEntries(["return_prob", "confidence"].map((f) => [f, { alpha: alphaOf(teacher, predicted, f) }]));

  const t = toTable(teacher, { field: "fit" });
  const s = toTable(predicted, { field: "fit" });
  const personaIds = [...new Set(Object.values(t).flatMap((row) => Object.keys(row)))].sort();
  const perPersona = {};
  for (const pid of personaIds) {
    const keys = Object.keys(t).filter((k) => pid in t[k] && s[k] && pid in s[k]).sort();
    perPersona[pid] = spearman(keys.map((k) => t[k][pid]), keys.map((k) => s[k][pid]));
  }
  const rhos = Object.values(perPersona);
  const spearmanPass = rhos.length > 0 && rhos.every((r) => passes(r, thresholds.spearman));
  const minRho = rhos.some((r) => r === null) ? null : rhos.length ? Math.min(...rhos) : null;

  const tau = withinNodeTau(teacher, nodeOf, predicted, { field: "fit" });
  const per_metric = {
    fit_alpha: { value: fitAlpha, threshold: thresholds.fitAlpha, pass: passes(fitAlpha, thresholds.fitAlpha) },
    subscore_alpha: subscores,
    spearman: { per_persona: perPersona, min: minRho, threshold: thresholds.spearman, pass: spearmanPass },
    within_node_tau: { value: tau.mean, groups: tau.groups, threshold: thresholds.withinNodeTau, pass: passes(tau.mean, thresholds.withinNodeTau) },
    reported,
  };
  const pass = per_metric.fit_alpha.pass && per_metric.spearman.pass && per_metric.within_node_tau.pass;
  return { pass, per_metric, failing_subscores: failing };
}

/** The model with the gate's verdict recorded and its failing sub-scores
    dropped from every later prediction. */
export function applyGate(model, verdict) {
  return { ...model, gate: verdict, dropped: [...new Set([...(model.dropped ?? []), ...verdict.failing_subscores])].sort((a, b) => TARGETS.indexOf(a) - TARGETS.indexOf(b)) };
}

/* ------------------------------------------------------------ the file */

const SIG = 7;
const sig = (v) => (isNum(v) ? Number(v.toPrecision(SIG)) : v);

/** The model file's bytes: numbers to 7 significant digits, one line per
    persona's weights, trailing newline. */
export function serializeModel(model) {
  const doc = {
    ...model,
    means: model.means.map(sig),
    scales: model.scales.map(sig),
    intercepts: model.intercepts.map((row) => row.map(sig)),
    weights: model.weights.map((rows) => rows.map((row) => row.map(sig))),
  };
  const { weights, ...head } = doc;
  const top = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  const body = weights.map((rows) => `    ${JSON.stringify(rows)}`).join(",\n");
  return `${top},\n  "weights": [\n${body}\n  ]\n}\n`;
}

/** Problems with a model document (`[]` when it is sound). */
export function checkModel(doc) {
  const problems = [];
  if (doc?.version !== MODEL_VERSION) problems.push(`version must be ${MODEL_VERSION}`);
  const d = Array.isArray(doc?.means) ? doc.means.length : -1;
  if (d <= 0) problems.push("means is missing");
  if (!Array.isArray(doc?.scales) || doc.scales.length !== d) problems.push("scales is missing or the wrong length");
  else if (!doc.scales.every((s) => isNum(s) && s > 0)) problems.push("scales must be positive numbers");
  if (doc?.feature_names && doc.feature_names.length !== d) problems.push(`${doc.feature_names.length} feature names for ${d} features`);
  if (JSON.stringify(doc?.targets) !== JSON.stringify(TARGETS)) problems.push(`targets must be ${TARGETS.join(", ")}`);
  for (const a of AUDIO_SUBSCORES) if (doc?.targets?.includes(a)) problems.push(`${a} is teacher-only and never predicted`);
  const P = Array.isArray(doc?.persona_ids) ? doc.persona_ids.length : 0;
  if (!P) problems.push("persona_ids is missing");
  if (!Array.isArray(doc?.intercepts) || doc.intercepts.length !== P || !doc.intercepts.every((r) => Array.isArray(r) && r.length === TARGETS.length)) problems.push("intercepts must be one row of 7 per persona");
  if (!Array.isArray(doc?.weights) || doc.weights.length !== P || !doc.weights.every((rows) => Array.isArray(rows) && rows.length === d && rows.every((r) => Array.isArray(r) && r.length === TARGETS.length))) problems.push("weights must be, per persona, one row of 7 per feature");
  if (doc?.dropped && !doc.dropped.every((t) => GATED_SUBSCORES.includes(t))) problems.push("dropped may list only gated sub-scores");
  return problems;
}

/** A model from its file text or parsed document; throws when unsound. */
export function loadModel(textOrDoc) {
  const doc = typeof textOrDoc === "string" ? JSON.parse(textOrDoc) : textOrDoc;
  const problems = checkModel(doc);
  if (problems.length) throw new Error(`student model is not sound: ${problems.join("; ")}`);
  return doc;
}
