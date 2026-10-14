/* THE RECOMMENDER PRIOR — the runtime half of the persona-rating plan, as pure
   functions (docs/roadmap/recommender-v1.md RV-16; D2, D5, D11, D12; #1380).

   Offline, persona agents rate shows (data/recommender/ratings.json) and a
   build step projects the curated slice into data/recommender/ratings-client.json
   (RV-02's client shape: `{ version, personas: [id...], shows: { <show_id>:
   { f: "<one digit per persona, 0 = unrated>", x: 0|1, t: "t|e|s" } } }`).
   This module turns that projection and a listener's interest map into a
   score, following D2:

     score(u, i) = w_u . r_i + beta * cos(e_u, e_i) + gamma * resid_i - delta * dai_penalty_i

   - `personaMixFromInterests` is w_u's prior: which rating personas this
     listener resembles, read from the interest map the caller already holds
     (no persona id is stored anywhere, D11).
   - `updateMix` is the soft-count update of w_u as listens arrive (a Dirichlet
     with pseudo-count MIX_N0 around the prior mix).
   - `showPrior` is w_u . r_i on the 1-5 fit scale.
   - `shrink` is the per-show shrinkage toward the prior: the prior must lose to
     the listener's own evidence within a dozen or so listens (D2).
   - `blend` is the whole score; the DAI penalty is a separate input, never a
     taste score (D12).
   - `decodeClientRow` reads one client row; `rankWithPrior` is the in-list
     reorder RV-27 will apply inside one branch's list (audit seams B and C).

   What this module does NOT do, by design (D5, the UI freeze and the privacy
   rows): it touches no storage, no network, no page and no event log, and it
   holds no state between calls. The caller reads what it reads and passes plain
   objects in; nothing here is wired to a live path until the parked RV-27,
   behind `RECOMMENDER_PRIOR = false`. A suite pins the absence of those calls in
   the source text. */

/** The Dirichlet pseudo-count of the persona mix (research §3.1 B: "user n0 ~
    5-10"). The prior mix counts as this many listens. */
export const MIX_N0 = 8;

/** The per-show shrinkage pseudo-count (research: "item n0 ~ 10-20"). */
export const ITEM_N0 = 15;

/** RV-17's completion buckets as soft counts for `updateMix`. A bounce is a
    negative count: the personas that liked the show lose weight. */
export const MIX_OUTCOMES = Object.freeze({ complete: 1, engaged: 0.6, sampled: 0.2, bounce: -0.5 });

/** RV-02's client tier codes, inverted. A copy of `CLIENT_TIER_CODES` in
    tools/recommender/schema.mjs (player/ ships to the device and cannot load from
    tools/); the suite pins the two equal. */
export const CLIENT_TIER_NAMES = Object.freeze({ t: "transcript", e: "episode-metadata", s: "show-metadata" });

/** The neutral fit: the middle of the 1-5 anchor scale. */
const NEUTRAL_FIT = 3;

/** The floor a pseudo-count is clamped to after a negative (bounce) update, so
    a persona's weight can fall toward zero but never below it. */
const MIN_ALPHA = 1e-6;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The persona ids of a profiles input: the parsed `persona-profiles.json`
    or its `personas` array. */
function profileList(profiles) {
  const list = Array.isArray(profiles) ? profiles : isObj(profiles) && Array.isArray(profiles.personas) ? profiles.personas : [];
  return list.filter((p) => isObj(p) && typeof p.id === "string" && p.id.length > 0);
}

/** `taxonomy_affinity` as a `{ node_id: weight }` map (RV-01 writes an array of
    `{ node_id, weight }`; a plain map is accepted too). */
function affinityMap(profile) {
  const a = profile.taxonomy_affinity;
  const out = {};
  if (Array.isArray(a)) {
    for (const e of a) if (isObj(e) && typeof e.node_id === "string" && isNum(e.weight)) out[e.node_id] = e.weight;
  } else if (isObj(a)) {
    for (const [k, w] of Object.entries(a)) if (isNum(w)) out[k] = w;
  }
  return out;
}

function uniform(ids) {
  const out = {};
  for (const id of ids) out[id] = 1 / ids.length;
  return out;
}

/**
 * The prior persona mix for an interest map.
 *
 * `interests` is a plain `{ node_id: weight }` map; the caller decides what an
 * unset node means (app.js reads `state.interests[root] ?? 0.5`, so it passes
 * every root it wants counted). For each persona, the cosine between the
 * interest vector and the persona's whole `taxonomy_affinity` vector, with the
 * dot product over the node ids present in `interests` (a node the map leaves
 * out contributes 0), then a softmax. The affinity's norm is its whole norm,
 * not the norm of its overlap with the map: projecting it would make a persona
 * with one faint shared node (0.3 on history) look perfectly aligned with a
 * history listener, ahead of the persona built around history. `temperature` is the softmax's sharpness: the logit is
 * `temperature * cos`, so a cosine range of [-1, 1] spans [-4, 4] at the
 * default (dividing by 4 instead would leave every mix within a factor of 1.65
 * of uniform, which no listener's evidence could tell apart from no prior).
 *
 * Empty interests or an all-zero interest vector give the uniform mix: that is the Dirichlet prior with no onboarding signal.
 * A persona whose affinity touches none of the interest nodes has cosine 0.
 */
export function personaMixFromInterests(interests, profiles, { temperature = 4 } = {}) {
  const personas = profileList(profiles);
  const ids = personas.map((p) => p.id);
  if (ids.length === 0) return {};
  const nodes = isObj(interests) ? Object.keys(interests).filter((k) => isNum(interests[k])) : [];
  const iNorm = Math.sqrt(nodes.reduce((s, k) => s + interests[k] * interests[k], 0));
  if (nodes.length === 0 || iNorm === 0) return uniform(ids);
  const t = isNum(temperature) ? temperature : 4;
  const logits = personas.map((p) => {
    const aff = affinityMap(p);
    let dot = 0;
    for (const k of nodes) dot += interests[k] * (aff[k] ?? 0);
    const aSq = Object.values(aff).reduce((s, a) => s + a * a, 0);
    const cos = aSq === 0 ? 0 : dot / (iNorm * Math.sqrt(aSq));
    return t * cos;
  });
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((s, e) => s + e, 0);
  const out = {};
  ids.forEach((id, i) => { out[id] = exps[i] / sum; });
  return out;
}

/** The fit map of a rating row: a decoded client row (`{ fit: {...} }`) or a
    bare `{ persona_id: fit }` map. */
function fitMapOf(ratingRow) {
  if (!isObj(ratingRow)) return {};
  return isObj(ratingRow.fit) ? ratingRow.fit : ratingRow;
}

/** A rated fit is a number in [1, 5]; 0 (the client file's "unrated" digit),
    null and anything else is unrated. */
const ratedFit = (v) => (isNum(v) && v >= 1 && v <= 5 ? v : null);

/** The row's mean fit over its rated personas, 3 when nothing is rated. */
function rowMean(ratingRow) {
  const rated = Object.values(fitMapOf(ratingRow)).map(ratedFit).filter((v) => v !== null);
  return rated.length ? rated.reduce((s, v) => s + v, 0) / rated.length : NEUTRAL_FIT;
}

/** The fit per persona id of `ids`, with every unrated slot filled by the
    row's mean over its rated personas. */
function filledFits(ratingRow, ids) {
  const fit = fitMapOf(ratingRow);
  const mean = rowMean(ratingRow);
  const out = {};
  for (const id of ids) out[id] = ratedFit(fit[id]) ?? mean;
  return out;
}

/** The mix's own weights, renormalised over its finite non-negative entries. */
function normalisedMix(mix) {
  const ids = isObj(mix) ? Object.keys(mix).filter((k) => isNum(mix[k]) && mix[k] >= 0) : [];
  const sum = ids.reduce((s, k) => s + mix[k], 0);
  if (ids.length === 0) return {};
  if (sum === 0) return uniform(ids);
  const out = {};
  for (const k of ids) out[k] = mix[k] / sum;
  return out;
}

/**
 * The prior score of one show for one mix, in [1, 5]: `sum_p mix[p] * fit[p]`.
 * An unrated persona slot (the client file's `0` digit, decoded to null) takes
 * the row's mean over its rated personas, or 3 when nothing is rated. (Upstream
 * a null is filled with the node mean; on the device the row mean is what there
 * is.) A persona in the mix but absent from the row is unrated too.
 */
export function showPrior(mix, ratingRow) {
  const m = normalisedMix(mix);
  const ids = Object.keys(m);
  if (ids.length === 0) return rowMean(ratingRow);
  const fits = filledFits(ratingRow, ids);
  const v = ids.reduce((s, id) => s + m[id] * fits[id], 0);
  return Math.min(5, Math.max(1, v));
}

/**
 * The soft-count update of the persona mix after one listen.
 *
 * The mix is read as a Dirichlet with total count `n0 + n`: `n0` the prior's
 * pseudo-count and `n` the evidence already folded into `mix` (0 for a mix
 * straight from `personaMixFromInterests`; the caller, which rebuilds the mix
 * from on-device observations each time, knows it). The outcome's soft count
 * (`MIX_OUTCOMES[outcome]`, or a number) is spread over the personas in
 * proportion to each one's share of the show's total fit (unrated slots at the
 * row mean), added, clamped at zero, and renormalised. A completed show moves
 * weight toward the personas that rated it highest; a bounce moves it away; and
 * the same listen moves the mix less the more evidence it already holds.
 * An unknown outcome returns the mix unchanged (renormalised).
 */
export function updateMix(mix, ratingRow, outcome, { n0 = MIX_N0, n = 0 } = {}) {
  const m = normalisedMix(mix);
  const ids = Object.keys(m);
  const value = isNum(outcome) ? outcome : MIX_OUTCOMES[outcome];
  if (ids.length === 0 || !isNum(value)) return m;
  const fits = filledFits(ratingRow, ids);
  const fitSum = ids.reduce((s, id) => s + fits[id], 0);
  const total = Math.max(0, isNum(n0) ? n0 : MIX_N0) + Math.max(0, isNum(n) ? n : 0);
  const alpha = {};
  for (const id of ids) alpha[id] = Math.max(MIN_ALPHA, total * m[id] + value * (fits[id] / fitSum));
  return normalisedMix(alpha);
}

/**
 * Shrink a show's prior toward the listener's observed score:
 * `(n0 * prior + n * obs) / (n0 + n)`. `n = 0` (or no usable observation) is
 * the prior; as `n` grows the result approaches `obs`.
 */
export function shrink(prior, obs, n, { n0 = ITEM_N0 } = {}) {
  if (!isNum(n) || n <= 0 || !isNum(obs)) return prior;
  return (n0 * prior + n * obs) / (n0 + n);
}

/**
 * The blended score (D2): `prior + beta * embeddingSim + gamma * resid -
 * delta * daiPenalty`. The DAI penalty is subtracted: a show whose episodes
 * carry dynamically inserted ads is a product constraint against it (D12),
 * never a point in its favour. A missing or non-finite term counts as 0.
 */
export function blend({ prior, embeddingSim = 0, resid = 0, daiPenalty = 0 } = {}, { beta = 0.5, gamma = 1, delta = 0.5 } = {}) {
  const z = (v) => (isNum(v) ? v : 0);
  return z(prior) + beta * z(embeddingSim) + gamma * z(resid) - delta * z(daiPenalty);
}

/**
 * One row of `ratings-client.json` decoded against the file's `personas` list:
 * `{ fit: { <persona_id>: 1..5 | null }, explicit, tier }`. The digit `0` is
 * unrated (null), as is a missing digit; `explicit` is `x === 1`; `tier` is the
 * tier name of `t` ("transcript", "episode-metadata", "show-metadata") or null.
 * A row that is not an object with a string `f` decodes to null.
 */
export function decodeClientRow(row, personas) {
  if (!isObj(row) || typeof row.f !== "string") return null;
  const ids = Array.isArray(personas) ? personas : [];
  const fit = {};
  ids.forEach((id, i) => {
    const d = row.f.charCodeAt(i) - 48;
    fit[id] = d >= 1 && d <= 5 ? d : null;
  });
  return { fit, explicit: row.x === 1, tier: CLIENT_TIER_NAMES[row.t] ?? null };
}

/**
 * Reorder one list by the caller's score plus the prior's nudge:
 * `scoreOf(item) + weight * (priorOf(item) - 3) / 2`, highest first, ties in
 * the caller's order. A prior of 3 (or none) nudges nothing; 5 adds `weight`,
 * 1 subtracts it. The result holds exactly the items it was given: this
 * reorders within one branch's list (seam B) or breaks ties in Similar shows
 * (seam C), and never moves an item across the caller's tiers, so the stretch
 * slot and `pickWithStretchFloor` are untouched by construction.
 */
export function rankWithPrior(items, { scoreOf, priorOf, weight = 0.35 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const score = (it) => {
    const s = typeof scoreOf === "function" ? scoreOf(it) : 0;
    const p = typeof priorOf === "function" ? priorOf(it) : null;
    return (isNum(s) ? s : 0) + weight * ((isNum(p) ? p : NEUTRAL_FIT) - NEUTRAL_FIT) / 2;
  };
  return list
    .map((item, index) => ({ item, index, key: score(item) }))
    .sort((a, b) => b.key - a.key || a.index - b.index)
    .map((e) => e.item);
}
