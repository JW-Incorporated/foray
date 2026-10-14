/* Agreement statistics for the persona-rating pipeline (RV-11).

   docs/roadmap/recommender-v1.md (#1380): every go/no-go in the plan is read
   from these numbers -- the pilot's test-retest and joint-vs-isolated checks
   (RV-13), the persona pruning (RV-29), the per-batch drift that decides
   whether pairwise calibration becomes a card (D13: > 0.3 on `fit`), and the
   student gate (RV-14, RV-25).

   Pure functions over plain arrays and the RV-02 file shapes (schema.mjs is
   the only definition of those), plus a CLI that rewrites one generated block
   of a report:

     node tools/recommender/agreement.mjs --ratings data/recommender/ratings.json \
       [--isolated data/recommender/ratings-isolated.json] \
       [--results data-local/recommender/results | --no-results] \
       --out docs/research/<report>.md --block pilot [--check]

   The block sits between `<!-- BEGIN agreement:<block> -->` and
   `<!-- END agreement:<block> -->`; `--check` exits 1 when it is stale or
   missing (the tools/similar-eval/run.mjs pattern). The block carries no
   timestamp, so the same inputs always render the same bytes.

   Where the inputs come from. ratings.json keeps one pass MEAN per show and
   persona (RV-02), so test-retest and per-batch drift cannot be read from it:
   they read the per-batch results files the agents wrote
   (data-local/recommender/results/rating-results-<batch_id>.json, never
   committed), keeping only the batches ratings.json (joint) or
   ratings-isolated.json (isolated) lists in `merged_batches`, skipped by
   file name before parsing, so a refused file never counts.

   No model call, no network: this module reads local JSON and writes one
   markdown file. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { RATING_SLOTS, validateRatingsFile } from "./schema.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The plan's thresholds, in one place so the report and the tests read the
    same numbers. */
export const THRESHOLDS = Object.freeze({
  /** research §4.2: joint-mode fit must rank shows like isolated-mode fit. */
  jointVsIsolated: 0.9,
  /** research §5.1 pruning rule: two personas this correlated are one. */
  correlatedPair: 0.85,
  /** research §5.1: a persona that is top for under 3% of shows earns no slot. */
  minTopShare: 0.03,
  /** D13: a batch whose mean fit moves more than this triggers calibration. */
  drift: 0.3,
  /** The compression check: more than this share of mass on one value. */
  compressedMass: 0.6,
});

/* ---------- small numeric helpers ---------- */

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const cmpValues = (a, b) => (isNum(a) && isNum(b) ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/** The (a[i], b[i]) pairs where both are finite numbers. */
function pairs(a, b) {
  const xs = [];
  const ys = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (isNum(a[i]) && isNum(b[i])) {
      xs.push(a[i]);
      ys.push(b[i]);
    }
  }
  return [xs, ys];
}

/** Ranks 1..n with tied values sharing their average rank. */
export function averageRanks(xs) {
  const order = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const ranks = new Array(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = r;
    i = j + 1;
  }
  return ranks;
}

/* ---------- correlation ---------- */

/** Pearson's r over the pairs where both sides are numbers; null when fewer
    than two pairs or either side has no variance. */
export function pearson(a, b) {
  const [xs, ys] = pairs(a, b);
  if (xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman's rho: Pearson's r on average ranks (ties handled). */
export function spearman(a, b) {
  const [xs, ys] = pairs(a, b);
  if (xs.length < 2) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

/** Kendall's tau-b: (concordant - discordant) / sqrt((n0 - tiesA)(n0 - tiesB)),
    so ties on either side shrink the denominator rather than counting as
    agreement or disagreement. Null when either side is constant. */
export function kendallTau(a, b) {
  const [xs, ys] = pairs(a, b);
  const n = xs.length;
  if (n < 2) return null;
  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Math.sign(xs[i] - xs[j]);
      const dy = Math.sign(ys[i] - ys[j]);
      if (dx === 0) tiesX++;
      if (dy === 0) tiesY++;
      if (dx !== 0 && dy !== 0) {
        if (dx === dy) concordant++;
        else discordant++;
      }
    }
  }
  const n0 = (n * (n - 1)) / 2;
  const denom = Math.sqrt((n0 - tiesX) * (n0 - tiesY));
  if (denom === 0) return null;
  return (concordant - discordant) / denom;
}

/* ---------- Krippendorff's alpha ---------- */

export const ALPHA_METRICS = ["nominal", "ordinal", "interval"];

/** Krippendorff's alpha from the coincidence matrix (Krippendorff 2011,
    "Computing Krippendorff's Alpha-Reliability"). `units` is one array per
    unit (a show, or a show x persona), one slot per rater (or pass), `null`
    for missing. Units with fewer than two values are not pairable and are
    dropped. alpha = 1 - (n - 1) * sum(o_ck d_ck) / sum(n_c n_k d_ck).
    Null when there is nothing pairable or no expected disagreement (every
    value identical). */
export function krippendorffAlpha(units, { metric = "interval" } = {}) {
  if (!ALPHA_METRICS.includes(metric)) throw new Error(`krippendorffAlpha: metric must be one of ${ALPHA_METRICS.join(", ")}`);
  const pairable = [];
  for (const u of units || []) {
    const vals = (u || []).filter((v) => v !== null && v !== undefined && !(typeof v === "number" && Number.isNaN(v)));
    if (vals.length >= 2) pairable.push(vals);
  }
  if (!pairable.length) return null;

  const values = [...new Set(pairable.flat())].sort(cmpValues);
  const index = new Map(values.map((v, i) => [v, i]));
  const V = values.length;
  const o = Array.from({ length: V }, () => new Array(V).fill(0));
  for (const vals of pairable) {
    const w = 1 / (vals.length - 1);
    for (let i = 0; i < vals.length; i++) {
      for (let j = 0; j < vals.length; j++) {
        if (i !== j) o[index.get(vals[i])][index.get(vals[j])] += w;
      }
    }
  }
  const nc = o.map((row) => row.reduce((s, x) => s + x, 0));
  const n = nc.reduce((s, x) => s + x, 0);

  const delta2 = (c, k) => {
    if (c === k) return 0;
    if (metric === "nominal") return 1;
    if (metric === "interval") return (values[c] - values[k]) ** 2;
    const lo = Math.min(c, k);
    const hi = Math.max(c, k);
    let s = 0;
    for (let g = lo; g <= hi; g++) s += nc[g];
    return (s - (nc[c] + nc[k]) / 2) ** 2;
  };

  let observed = 0;
  let expected = 0;
  for (let c = 0; c < V; c++) {
    for (let k = 0; k < V; k++) {
      const d = delta2(c, k);
      observed += o[c][k] * d;
      expected += nc[c] * nc[k] * d;
    }
  }
  if (expected === 0) return null;
  return 1 - ((n - 1) * observed) / expected;
}

/* ---------- reading the RV-02 shapes as tables ---------- */

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** One field of one persona's rating: a ratings.json slot array (RV-02
    RATING_SLOTS order), a results-file rating object, or a bare number. */
export function fieldValue(entry, field = "fit") {
  if (isNum(entry)) return field === "fit" ? entry : null;
  if (Array.isArray(entry)) {
    const i = RATING_SLOTS.indexOf(field);
    return i >= 0 && isNum(entry[i]) ? entry[i] : null;
  }
  if (isObject(entry)) return isNum(entry[field]) ? entry[field] : null;
  return null;
}

/** `{ <show_key>: { <persona_id>: number } }` from a ratings.json document
    (`shows.*.personas`), a results file (`results.*.personas`) or an already
    plain table. Missing and null values are left out. */
export function toTable(source, { field = "fit" } = {}) {
  const out = {};
  if (!isObject(source)) return out;
  let shows;
  if (isObject(source.shows)) shows = Object.fromEntries(Object.entries(source.shows).map(([k, s]) => [k, s && s.personas]));
  else if (isObject(source.results)) shows = Object.fromEntries(Object.entries(source.results).map(([k, s]) => [k, s && s.personas]));
  else shows = source;
  for (const [key, personas] of Object.entries(shows)) {
    if (!isObject(personas)) continue;
    const row = {};
    for (const [pid, entry] of Object.entries(personas)) {
      const v = fieldValue(entry, field);
      if (v !== null) row[pid] = v;
    }
    if (Object.keys(row).length) out[key] = row;
  }
  return out;
}

const personasOf = (table) => [...new Set(Object.values(table).flatMap((row) => Object.keys(row)))].sort();
const lookup = (mapOrFn, key) => (typeof mapOrFn === "function" ? mapOrFn(key) : mapOrFn ? mapOrFn[key] : undefined);

/** The top persona of one show from its persona entries: highest `fit`,
    ties to the higher `return_prob`, then to the lower persona id (merge's
    rule, RV-09, made total). */
export function topPersona(personas) {
  let best = null;
  for (const pid of Object.keys(personas || {}).sort()) {
    const fit = fieldValue(personas[pid], "fit");
    if (fit === null) continue;
    const rp = fieldValue(personas[pid], "return_prob") ?? -1;
    if (!best || fit > best.fit || (fit === best.fit && rp > best.rp)) best = { pid, fit, rp };
  }
  return best ? best.pid : null;
}

/* ---------- test-retest ---------- */

/** The results files of joint-mode passes, one entry per (show, pass): a
    show rated twice in the same pass keeps the later `rated_at`. Returns
    `{ <show_key>: { <pass>: personas } }`. */
function passesByShow(resultsDocs) {
  const byShow = {};
  const stamp = {};
  for (const doc of resultsDocs || []) {
    if (!isObject(doc) || doc.mode !== "joint" || !isObject(doc.results)) continue;
    const pass = doc.pass;
    for (const [key, s] of Object.entries(doc.results)) {
      if (!isObject(s) || !isObject(s.personas)) continue;
      const at = Date.parse(doc.rated_at) || 0;
      const id = `${key}\u0000${pass}`;
      if (id in stamp && stamp[id] > at) continue;
      stamp[id] = at;
      (byShow[key] ||= {})[pass] = s.personas;
    }
  }
  return byShow;
}

/** Test-retest over the joint-mode results files (RV-02 results shape, one
    per batch; ratings.json holds only pass means). For every show rated in
    two or more passes: interval alpha on `field` across passes, per persona
    and over every show x persona unit; and the fraction of those shows whose
    top persona differs between its first pass and any later one. */
export function testRetest(resultsDocs, { field = "fit" } = {}) {
  const byShow = passesByShow(resultsDocs);
  const multi = Object.keys(byShow).filter((k) => Object.keys(byShow[k]).length >= 2).sort();
  const unitsByPersona = {};
  let changed = 0;
  for (const key of multi) {
    const passes = Object.keys(byShow[key]).map(Number).sort((a, b) => a - b);
    const pids = [...new Set(passes.flatMap((p) => Object.keys(byShow[key][p])))];
    for (const pid of pids) {
      (unitsByPersona[pid] ||= []).push(passes.map((p) => fieldValue(byShow[key][p][pid], field)));
    }
    const first = topPersona(byShow[key][passes[0]]);
    const later = passes.slice(1).map((p) => topPersona(byShow[key][p]));
    if (later.some((t) => t !== first)) changed++;
  }
  const per_persona = {};
  for (const pid of Object.keys(unitsByPersona).sort()) {
    per_persona[pid] = { units: unitsByPersona[pid].length, alpha: krippendorffAlpha(unitsByPersona[pid], { metric: "interval" }) };
  }
  const all = Object.values(unitsByPersona).flat();
  return {
    field,
    metric: "interval",
    shows: multi.length,
    overall: krippendorffAlpha(all, { metric: "interval" }),
    per_persona,
    top_persona_changed: changed,
    top_persona_change_fraction: multi.length ? changed / multi.length : null,
  };
}

/* ---------- joint vs isolated ---------- */

/** Per persona, Spearman between its joint-mode `field` (ratings.json) and
    its isolated-mode `field` (ratings-isolated.json, same shape) over the
    shows rated both ways. A persona below `threshold` (research: 0.9) means
    rating every persona in one call bends that persona's scale. */
export function jointVsIsolated(ratings, isolated, { field = "fit", threshold = THRESHOLDS.jointVsIsolated } = {}) {
  const joint = toTable(ratings, { field });
  const iso = toTable(isolated, { field });
  const per_persona = {};
  for (const pid of personasOf(iso)) {
    const keys = Object.keys(iso).filter((k) => pid in iso[k] && joint[k] && pid in joint[k]).sort();
    const rho = spearman(keys.map((k) => joint[k][pid]), keys.map((k) => iso[k][pid]));
    per_persona[pid] = { n: keys.length, spearman: rho, below: rho === null || rho < threshold };
  }
  return {
    field,
    threshold,
    per_persona,
    below: Object.keys(per_persona).filter((pid) => per_persona[pid].below),
  };
}

/* ---------- persona differentiation ---------- */

/** How distinct the personas are (research §5.1 pruning, §5.3):
    - pairwise Pearson between persona `fit` columns over the shows both
      rate; a pair at or above `correlatedPair` (0.85) is flagged;
    - each persona's share of shows where it is the top persona (the stored
      `top_persona` of ratings.json, else the argmax); under `minTopShare`
      (3%) is flagged, never-top included;
    - the variance ratio: mean within-show variance across personas over the
      variance of show means. Near 0 the personas are one listener; above 1
      they disagree about a show more than shows differ from each other. */
export function personaDifferentiation(ratings, { personaIds, field = "fit", correlatedPair = THRESHOLDS.correlatedPair, minTopShare = THRESHOLDS.minTopShare } = {}) {
  const table = toTable(ratings, { field });
  const keys = Object.keys(table).sort();
  const personas = personaIds ? [...personaIds] : personasOf(table);

  const pairsOut = [];
  for (let i = 0; i < personas.length; i++) {
    for (let j = i + 1; j < personas.length; j++) {
      const a = personas[i];
      const b = personas[j];
      const both = keys.filter((k) => a in table[k] && b in table[k]);
      const r = pearson(both.map((k) => table[k][a]), both.map((k) => table[k][b]));
      pairsOut.push({ a, b, n: both.length, r, flagged: r !== null && r >= correlatedPair });
    }
  }
  pairsOut.sort((p, q) => (q.r ?? -2) - (p.r ?? -2) || (p.a + p.b < q.a + q.b ? -1 : 1));

  const shows = isObject(ratings) && isObject(ratings.shows) ? ratings.shows : null;
  const topCount = Object.fromEntries(personas.map((p) => [p, 0]));
  let withTop = 0;
  for (const k of keys) {
    const stored = shows && shows[k] && typeof shows[k].top_persona === "string" ? shows[k].top_persona : null;
    const top = stored ?? topPersona(shows && shows[k] ? shows[k].personas : table[k]);
    if (top === null) continue;
    withTop++;
    if (top in topCount) topCount[top]++;
  }
  const top_share = {};
  for (const p of personas) {
    const share = withTop ? topCount[p] / withTop : 0;
    top_share[p] = { shows: topCount[p], share, flagged: share < minTopShare };
  }

  const all = keys.flatMap((k) => Object.values(table[k]));
  const grand = mean(all);
  const showMeans = keys.map((k) => mean(Object.values(table[k])));
  const betweenShow = showMeans.length ? mean(showMeans.map((m) => (m - grand) ** 2)) : null;
  const withinShows = keys
    .map((k, i) => Object.values(table[k]).map((v) => (v - showMeans[i]) ** 2))
    .filter((d) => d.length >= 2)
    .map((d) => mean(d));
  const withinShow = withinShows.length ? mean(withinShows) : null;
  const ratio = betweenShow && withinShow !== null ? withinShow / betweenShow : null;

  return {
    field,
    shows: keys.length,
    personas,
    pairs: pairsOut,
    correlated: pairsOut.filter((p) => p.flagged).map((p) => [p.a, p.b]),
    top_share,
    rarely_top: personas.filter((p) => top_share[p].flagged),
    variance: { between_persona_within_show: withinShow, between_show: betweenShow, ratio },
  };
}

/* ---------- within-node Kendall tau ---------- */

/** Mean Kendall tau-b between the teacher (`ratings`) and a second source
    (`predicted`; any shape `toTable` reads) over shows sharing a root node:
    per node and persona over the shows both sources rate (at least
    `minShows`), then the mean over those groups. `nodeOf` is a function or a
    `{ show_key: node_id }` map; a show without a node is left out. The student
    gate (RV-14, RV-25) reads `mean`. */
export function withinNodeTau(ratings, nodeOf, predicted, { field = "fit", minShows = 3 } = {}) {
  const teacher = toTable(ratings, { field });
  const second = toTable(predicted, { field });
  const byNode = {};
  for (const k of Object.keys(teacher).sort()) {
    if (!second[k]) continue;
    const node = lookup(nodeOf, k);
    if (node === undefined || node === null) continue;
    (byNode[node] ||= []).push(k);
  }
  const per_node = {};
  const taus = [];
  for (const node of Object.keys(byNode).sort()) {
    const keys = byNode[node];
    const nodeTaus = [];
    for (const pid of personasOf(Object.fromEntries(keys.map((k) => [k, teacher[k]])))) {
      const both = keys.filter((k) => pid in teacher[k] && pid in second[k]);
      if (both.length < minShows) continue;
      const tau = kendallTau(both.map((k) => teacher[k][pid]), both.map((k) => second[k][pid]));
      if (tau !== null) nodeTaus.push(tau);
    }
    if (nodeTaus.length) {
      per_node[node] = { groups: nodeTaus.length, mean: mean(nodeTaus) };
      taus.push(...nodeTaus);
    }
  }
  return { field, groups: taus.length, mean: mean(taus), per_node };
}

/* ---------- per-batch drift ---------- */

/** Per batch, the mean `field` over every persona rating of the batch's
    shows, and its deviation from the overall mean of the same values. A
    batch more than `threshold` (D13: 0.3) away is flagged. `batchOf` is a
    function or a `{ show_key: batch_id }` map; an unassigned show is left
    out. */
export function batchDrift(ratings, batchOf, { field = "fit", threshold = THRESHOLDS.drift } = {}) {
  const table = toTable(ratings, { field });
  const byBatch = {};
  const all = [];
  for (const k of Object.keys(table).sort()) {
    const batch = lookup(batchOf, k);
    if (batch === undefined || batch === null) continue;
    const vals = Object.values(table[k]);
    const b = (byBatch[batch] ||= { shows: 0, values: [] });
    b.shows++;
    b.values.push(...vals);
    all.push(...vals);
  }
  const overall = mean(all);
  const per_batch = {};
  let maxAbs = null;
  for (const id of Object.keys(byBatch).sort()) {
    const m = mean(byBatch[id].values);
    const deviation = m - overall;
    per_batch[id] = { shows: byBatch[id].shows, values: byBatch[id].values.length, mean: m, deviation, flagged: Math.abs(deviation) > threshold };
    if (maxAbs === null || Math.abs(deviation) > maxAbs) maxAbs = Math.abs(deviation);
  }
  return {
    field,
    threshold,
    overall_mean: overall,
    max_abs_deviation: maxAbs,
    per_batch,
    flagged: Object.keys(per_batch).filter((id) => per_batch[id].flagged),
  };
}

/* ---------- score distribution ---------- */

/** Histogram of `field` (rounded to the 1-5 anchors) per persona, and the
    compression check: a persona with more than `maxShare` (60%) of its mass
    on one value is flagged -- consistent but uninformative (research §1.4). */
export function scoreDistribution(ratings, { field = "fit", maxShare = THRESHOLDS.compressedMass } = {}) {
  const table = toTable(ratings, { field });
  const per_persona = {};
  for (const pid of personasOf(table)) {
    const hist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let n = 0;
    for (const row of Object.values(table)) {
      if (!(pid in row)) continue;
      hist[Math.min(5, Math.max(1, Math.round(row[pid])))]++;
      n++;
    }
    const top = Math.max(...Object.values(hist));
    const modal_share = n ? top / n : 0;
    per_persona[pid] = { n, hist, modal_share, compressed: modal_share > maxShare };
  }
  return { field, max_share: maxShare, per_persona, compressed: Object.keys(per_persona).filter((p) => per_persona[p].compressed) };
}

/* ---------- the report block ---------- */

const fmt = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? "n/a" : v.toFixed(d));
const pct = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
const flag = (b) => (b ? "**flag**" : "");

/** Map each show to the batch of its first joint pass (the batch whose
    ratings set its scale), from the merged results files. */
export function firstBatchOf(resultsDocs) {
  const out = {};
  const passOf = {};
  for (const doc of resultsDocs || []) {
    if (!isObject(doc) || doc.mode !== "joint" || !isObject(doc.results)) continue;
    for (const key of Object.keys(doc.results)) {
      if (!(key in passOf) || doc.pass < passOf[key] || (doc.pass === passOf[key] && doc.batch_id < out[key])) {
        passOf[key] = doc.pass;
        out[key] = doc.batch_id;
      }
    }
  }
  return out;
}

/** The markdown of one generated block: deterministic for the same inputs. */
export function renderBlock({ ratings, isolated = null, results = null }) {
  const out = [];
  const shows = isObject(ratings && ratings.shows) ? Object.keys(ratings.shows).length : 0;
  const dist = scoreDistribution(ratings);
  const diff = personaDifferentiation(ratings);
  out.push(`Inputs: ${shows} rated shows, ${diff.personas.length} personas; ${results ? `${results.length} merged results files` : "no per-pass results files"}; ${isolated ? "isolated ratings present" : "no isolated ratings"}.`);
  out.push("");

  out.push("**Score distribution** (`fit`, rounded to the anchors; flagged when one value holds more than " + pct(THRESHOLDS.compressedMass) + ")");
  out.push("");
  out.push("| persona | n | 1 | 2 | 3 | 4 | 5 | modal share | compressed |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const [pid, d] of Object.entries(dist.per_persona)) {
    out.push(`| ${pid} | ${d.n} | ${d.hist[1]} | ${d.hist[2]} | ${d.hist[3]} | ${d.hist[4]} | ${d.hist[5]} | ${pct(d.modal_share)} | ${flag(d.compressed)} |`);
  }
  out.push("");

  out.push("**Test-retest** (interval alpha on `fit` across passes, joint mode)");
  out.push("");
  if (!results) {
    out.push("- no per-pass results files were read");
  } else {
    const tr = testRetest(results);
    out.push(`- shows rated in two or more passes: ${tr.shows}`);
    out.push(`- overall alpha: ${fmt(tr.overall)}`);
    out.push(`- top persona changed between passes: ${tr.top_persona_changed} of ${tr.shows} (${pct(tr.top_persona_change_fraction)})`);
    if (Object.keys(tr.per_persona).length) {
      out.push("");
      out.push("| persona | units | alpha |");
      out.push("|---|---|---|");
      for (const [pid, p] of Object.entries(tr.per_persona)) out.push(`| ${pid} | ${p.units} | ${fmt(p.alpha)} |`);
    }
  }
  out.push("");

  out.push(`**Joint vs isolated** (Spearman on \`fit\` per persona; flagged below ${THRESHOLDS.jointVsIsolated})`);
  out.push("");
  if (!isolated) {
    out.push("- no isolated ratings were read");
  } else {
    const jv = jointVsIsolated(ratings, isolated);
    out.push("| persona | shows | spearman | below |");
    out.push("|---|---|---|---|");
    for (const [pid, p] of Object.entries(jv.per_persona)) out.push(`| ${pid} | ${p.n} | ${fmt(p.spearman)} | ${flag(p.below)} |`);
  }
  out.push("");

  out.push(`**Persona differentiation** (pairs flagged at r >= ${THRESHOLDS.correlatedPair}; top share flagged under ${pct(THRESHOLDS.minTopShare)})`);
  out.push("");
  out.push(`- variance ratio (mean within-show variance across personas / variance of show means): ${fmt(diff.variance.ratio)} (within ${fmt(diff.variance.between_persona_within_show)}, between shows ${fmt(diff.variance.between_show)})`);
  out.push(`- correlated pairs: ${diff.correlated.length ? diff.correlated.map(([a, b]) => `${a} ~ ${b}`).join(", ") : "none"}`);
  out.push(`- rarely top: ${diff.rarely_top.length ? diff.rarely_top.join(", ") : "none"}`);
  out.push("");
  out.push("| persona | top for | share | flagged |");
  out.push("|---|---|---|---|");
  for (const [pid, t] of Object.entries(diff.top_share)) out.push(`| ${pid} | ${t.shows} | ${pct(t.share)} | ${flag(t.flagged)} |`);
  out.push("");
  out.push("Most correlated pairs:");
  out.push("");
  out.push("| a | b | shows | r |");
  out.push("|---|---|---|---|");
  for (const p of diff.pairs.slice(0, 5)) out.push(`| ${p.a} | ${p.b} | ${p.n} | ${fmt(p.r)} |`);
  out.push("");

  out.push(`**Per-batch drift** (mean \`fit\` of each batch's shows against the overall mean; flagged beyond ${THRESHOLDS.drift}, D13)`);
  out.push("");
  if (!results) {
    out.push("- no per-pass results files were read");
  } else {
    const dr = batchDrift(ratings, firstBatchOf(results));
    out.push(`- overall mean: ${fmt(dr.overall_mean)}; max deviation: ${fmt(dr.max_abs_deviation)}; flagged: ${dr.flagged.length ? dr.flagged.join(", ") : "none"}`);
    if (Object.keys(dr.per_batch).length) {
      out.push("");
      out.push("| batch | shows | mean | deviation | flagged |");
      out.push("|---|---|---|---|---|");
      for (const [id, b] of Object.entries(dr.per_batch)) out.push(`| ${id} | ${b.shows} | ${fmt(b.mean)} | ${fmt(b.deviation)} | ${flag(b.flagged)} |`);
    }
  }
  return out.join("\n");
}

export const beginMarker = (block) => `<!-- BEGIN agreement:${block} -->`;
export const endMarker = (block) => `<!-- END agreement:${block} -->`;

/** `text` (or a new report when null) with the block replaced by `section`;
    a report without the markers gets the block appended. Line endings are
    compared and written as LF. */
export function spliceBlock(text, block, section) {
  const begin = beginMarker(block);
  const end = endMarker(block);
  const fresh = `${begin}\n${section}\n${end}`;
  if (text === null || text === undefined) return `# Persona-rating agreement (${block})\n\n${fresh}\n`;
  const norm = text.replace(/\r\n/g, "\n");
  const a = norm.indexOf(begin);
  const b = norm.indexOf(end, a < 0 ? 0 : a);
  if (a < 0 || b < 0) return `${norm.replace(/\n*$/, "")}\n\n${fresh}\n`;
  return norm.slice(0, a) + fresh + norm.slice(b + end.length);
}

/* ---------- CLI ---------- */

export function parseArgs(argv) {
  const args = { ratings: null, isolated: null, results: undefined, out: null, block: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--ratings") args.ratings = next();
    else if (a === "--isolated") args.isolated = next();
    else if (a === "--results") args.results = next();
    else if (a === "--no-results") args.results = null;
    else if (a === "--out") args.out = next();
    else if (a === "--block") args.block = next();
    else if (a === "--check") args.check = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.ratings) throw new Error("--ratings <path> is required");
  if (!args.out) throw new Error("--out <report.md> is required");
  if (!args.block || !/^[a-z0-9-]+$/.test(args.block)) throw new Error("--block <name> is required (lowercase letters, digits, hyphens)");
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The merged joint and isolated results files in `dir`: only batches the
    `merged_batches` ledgers list (ratings.json for joint batches,
    ratings-isolated.json for isolated ones, as RV-09 records them), when
    either has that ledger. Null when the directory does not exist. */
export function loadResults(dir, ratings, isolated = null) {
  if (!dir || !fs.existsSync(dir)) return null;
  const ledgers = [ratings, isolated].filter((d) => d && Array.isArray(d.merged_batches));
  const merged = ledgers.length ? new Set(ledgers.flatMap((d) => d.merged_batches)) : null;
  const docs = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const m = /^rating-results-(.+)\.json$/.exec(name);
    if (!m) continue;
    /* Skip by name before parsing: a refused file (for example an agent's
       truncated output) stays in the directory and may not be valid JSON. */
    if (merged && !merged.has(m[1])) continue;
    const doc = readJson(path.join(dir, name));
    if (merged && !merged.has(doc.batch_id)) continue;
    docs.push(doc);
  }
  return docs;
}

/** Exit codes: 0 written or current; 1 stale (`--check`) or an input that
    fails schema.mjs; 2 a usage error. */
export function main(argv = process.argv.slice(2), { root = ROOT, log = console.log, error = console.error } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    error(`agreement: ${e.message}`);
    return 2;
  }
  const resolve = (p) => path.resolve(root, p);
  const ratings = readJson(resolve(args.ratings));
  const isolated = args.isolated ? readJson(resolve(args.isolated)) : null;
  for (const [name, doc] of [["--ratings", ratings], ["--isolated", isolated]]) {
    if (!doc) continue;
    const problems = validateRatingsFile(doc);
    if (problems.length) {
      error(`agreement: ${name} fails schema.mjs validateRatingsFile (${problems.length} problems):`);
      for (const p of problems.slice(0, 20)) error(`  ${p.code} ${p.at}`);
      return 1;
    }
  }
  const resultsDir = args.results === undefined ? path.join(root, "data-local", "recommender", "results") : args.results === null ? null : resolve(args.results);
  const results = loadResults(resultsDir, ratings, isolated);

  const outPath = resolve(args.out);
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : null;
  const next = spliceBlock(current, args.block, renderBlock({ ratings, isolated, results }));
  if (args.check) {
    if (current !== null && current.replace(/\r\n/g, "\n") === next) {
      log(`${args.out}: agreement:${args.block} block is current`);
      return 0;
    }
    error(`${args.out}: agreement:${args.block} block is STALE or missing -- rerun without --check`);
    return 1;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, next);
  log(`wrote ${args.out} (agreement:${args.block})`);
  return 0;
}

if (isEntryScript(import.meta.url)) {
  process.exitCode = main();
}
