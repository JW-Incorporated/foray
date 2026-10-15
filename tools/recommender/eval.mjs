#!/usr/bin/env node
/* RV-21 (docs/roadmap/recommender-v1.md, D2/D7/D12; issue #1380): the offline
   eval of the persona-rating prior. Before any client change, it measures
   whether the persona ratings agree with the only ground truth on main, and
   how skewed they are, against baselines that cost nothing.

     node tools/recommender/eval.mjs          rewrite the generated block
     node tools/recommender/eval.mjs --check  exit 1 if the committed block is stale
     node tools/recommender/eval.mjs --json   print the aggregates

   It writes the GENERATED block of docs/research/persona-ratings-eval-2026-10.md.
   Prose outside the block is hand-written and left alone. This is the
   tools/similar-eval/run.mjs pattern; test/recommender-eval.test.js pins the
   arithmetic on fixtures and runs the --check comparison in-process.

   THE FOUR MEASUREMENTS
   1. Archetype agreement. `data/catalog.json` gives each curated show an
      `archetype_fit` list, hand-assigned before any persona existed. Each
      value maps to a set of personas (ARCHETYPE_PERSONAS). A rated curated
      show is a hit when its `top_persona` (ratings.json, merge's rule) is in
      the union of its values' sets. `stretch` maps to no persona: a show
      whose only value is `stretch` is reported separately, never scored.
      Baselines: uniform random (|mapped| / personas, the expected hit
      rate), the root node's modal persona (the most common `top_persona`
      among the OTHER rated shows of the same root, leave-one-out), and the
      root node's affinity persona (the highest `taxonomy_affinity` weight
      for that root in persona-profiles.json: free, uses no rating).
   2. Similar-shows agreement. The 64 seeds of tools/similar-eval/eval-set.json
      are ranked by cosine over the persona `fit` vector, shifted so that 1
      (would not finish one episode) is 0: a show every persona rates 1 has no
      direction and no neighbours. Scored by tools/similar-eval/score.mjs
      (the same precision / recall@6 / hit rate / coverage / must-not
      arithmetic as the similarShows floors), three ways: every seed as
      listed (an unrated seed renders nothing), the reachable view (rated
      seeds, judged lists cut to rated shows), and app.js's similarShows over
      the same rated pool (the node-overlap ranking on equal footing).
      Reported, never gated (the card).
   3. Chart baseline. Spearman between `chart_rank` (1 is the top of an Apple
      genre chart) and each persona's `fit`, over the rated shows that chart.
      Raters never saw the rank (D7), so a strong NEGATIVE value (higher fit
      for better-ranked shows) would mean prestige leaked through the
      evidence.
   4. Coverage and skew (research §6.6, D12). Per persona, its top-50 rated
      shows (fit desc, return_prob desc, show_key asc): the share that is
      DAI (of those the DAI classifier covered), chart top-25, explicit,
      transcript-tier, and the leading root nodes, against two base rates: the
      rated set (what the top-50 is drawn from) and the catalogue (26k shows,
      what the student will serve). Explicit is the rater's `flags.explicit`
      for the persona and rated-set columns; the catalogue's explicit base is
      Apple's `explicit` in data/catalog.json over the curated shows that
      carry a boolean (the same curated-only denominator DAI uses, its n
      printed in brackets). Breadth rows carry no explicit share:
      catalog-breadth.json has `explicit: false` on all 26,340 rows (the chart
      harvest does not carry the flag), so counting them would read 0% by
      construction. Tier has only the rated-set base, because the catalogue's
      tier mix depends on the RSS and transcript caches in data-local/, which
      CI does not have.

   INPUTS (all committed; the block is reproducible in CI):
   data/recommender/ratings.json, data/recommender/persona-profiles.json,
   data/catalog.json, data/catalog-breadth.json, data/dai-classification.json,
   tools/similar-eval/eval-set.json. Any PR that changes ratings.json (RV-19's
   merges) reruns this script, or the block-is-current test goes red.

   Calls no model, fetches nothing, reads nothing a rater could not see that
   the plan does not already allow the eval to see (D7 binds raters, not the
   eval). Nothing on a live app path reads its output. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { aggregate, scoreSeed } from "../similar-eval/score.mjs";
import { similarShowsFor } from "../similar-eval/similar-shows.mjs";
import { spearman } from "./agreement.mjs";
import { chartBand, rootOf } from "./sample.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const PATHS = Object.freeze({
  ratings: "data/recommender/ratings.json",
  profiles: "data/recommender/persona-profiles.json",
  catalog: "data/catalog.json",
  breadth: "data/catalog-breadth.json",
  dai: "data/dai-classification.json",
  evalSet: "tools/similar-eval/eval-set.json",
});
export const REPORT_PATH = "docs/research/persona-ratings-eval-2026-10.md";
export const BEGIN = "<!-- BEGIN GENERATED: node tools/recommender/eval.mjs -->";
export const END = "<!-- END GENERATED -->";

/** The card's map (RV-21), plus `documentary`, which the card required to be
    covered but left unmapped: all 12 documentary shows in catalog.json are
    produced true-crime or paranormal story series, which is the narrative
    set. `stretch` means "outside the listener's lane" and names no persona. */
export const ARCHETYPE_PERSONAS = Object.freeze({
  "deep-learn": Object.freeze(["history-deep-diver", "mechanism-hunter", "practical-improver"]),
  narrative: Object.freeze(["narrative-binger", "true-crime-careful"]),
  comfort: Object.freeze(["banter-regular", "comfort-companion"]),
  documentary: Object.freeze(["narrative-binger", "true-crime-careful"]),
  stretch: Object.freeze([]),
});

export const TOP_N = 50;
export const SIMILAR_K = 6;

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/* ------------------------------------------------------------ archetypes */

/** The union of the mapped persona sets of a show's archetype values. */
export function mappedPersonas(archetypes, map = ARCHETYPE_PERSONAS) {
  const out = new Set();
  for (const a of archetypes || []) for (const p of map[a] || []) out.add(p);
  return out;
}

/** The most common value of `xs` (ties to the lower value), or null. */
function modal(xs) {
  const n = new Map();
  for (const x of xs) n.set(x, (n.get(x) || 0) + 1);
  let best = null;
  for (const [x, c] of [...n].sort((a, b) => byKey(a[0], b[0]))) if (!best || c > best[1]) best = [x, c];
  return best ? best[0] : null;
}

/** Leave-one-out modal top persona per show: `rows` is every rated show as
    `{ show_key, root, top_persona }`. Returns `{ <show_key>: persona|null }`. */
export function nodeModalPersona(rows) {
  const byRoot = new Map();
  for (const r of rows) {
    if (!r.top_persona) continue;
    if (!byRoot.has(r.root)) byRoot.set(r.root, []);
    byRoot.get(r.root).push(r);
  }
  const out = {};
  for (const r of rows) {
    const others = (byRoot.get(r.root) || []).filter((o) => o.show_key !== r.show_key).map((o) => o.top_persona);
    out[r.show_key] = modal(others);
  }
  return out;
}

/** The persona with the highest affinity weight for `root` (ties to the lower
    id), or null when no persona names the root with a positive weight. */
export function affinityPersona(root, profiles) {
  let best = null;
  for (const p of [...(profiles || [])].sort((a, b) => byKey(a.id, b.id))) {
    const w = (p.taxonomy_affinity || []).find((t) => t.node_id === root)?.weight;
    if (isNum(w) && w > 0 && (!best || w > best.w)) best = { id: p.id, w };
  }
  return best ? best.id : null;
}

/**
 * Archetype agreement over rated curated shows.
 * `shows`: `[{ show_key, archetypes: [...], top_persona, root }]` (curated, rated).
 * `personaIds`: every rating persona (the random baseline's denominator).
 * `nodeModal`: `{ show_key: persona|null }`; `affinityOf(root)`: persona|null.
 * Returns `{ all, byArchetype: { <value>: row }, stretchOnly: { n, top: {pid: n} } }`
 * where a row is `{ n, hits, precision, random, nodeModal, affinity }`.
 */
export function archetypeAgreement(shows, { personaIds, nodeModal = {}, affinityOf = () => null, map = ARCHETYPE_PERSONAS }) {
  const row = () => ({ n: 0, hits: 0, randomSum: 0, modalHits: 0, affinityHits: 0 });
  const add = (acc, mapped, s) => {
    acc.n += 1;
    if (mapped.has(s.top_persona)) acc.hits += 1;
    acc.randomSum += mapped.size / personaIds.length;
    if (mapped.has(nodeModal[s.show_key])) acc.modalHits += 1;
    if (mapped.has(affinityOf(s.root))) acc.affinityHits += 1;
  };
  const finish = (acc) => ({
    n: acc.n,
    hits: acc.hits,
    precision: acc.n ? acc.hits / acc.n : null,
    random: acc.n ? acc.randomSum / acc.n : null,
    nodeModal: acc.n ? acc.modalHits / acc.n : null,
    affinity: acc.n ? acc.affinityHits / acc.n : null,
  });
  const all = row();
  const per = {};
  const stretchOnly = { n: 0, top: {} };
  for (const s of shows) {
    const mapped = mappedPersonas(s.archetypes, map);
    if (!mapped.size) {
      stretchOnly.n += 1;
      stretchOnly.top[s.top_persona] = (stretchOnly.top[s.top_persona] || 0) + 1;
      continue;
    }
    add(all, mapped, s);
    for (const a of s.archetypes) {
      const m = mappedPersonas([a], map);
      if (!m.size) continue;
      add((per[a] ||= row()), m, s);
    }
  }
  const byArchetype = {};
  for (const a of Object.keys(per).sort()) byArchetype[a] = finish(per[a]);
  return { all: finish(all), byArchetype, stretchOnly };
}

/* ------------------------------------------------------- similar shows */

/** A show's persona fit vector in `personaIds` order, shifted so 1 is 0
    (an unrated persona slot is 0 too). */
export function fitVector(personas, personaIds) {
  return personaIds.map((pid) => {
    const v = Array.isArray(personas?.[pid]) ? personas[pid][0] : personas?.[pid]?.fit;
    return isNum(v) ? v - 1 : 0;
  });
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : null;
}

/** The k nearest rated shows to `seed` by cosine over the fit vectors
    (`vectors`: Map show_key -> vector), ties to the lower show_key; a zero
    vector has no neighbours and is no one's neighbour. */
export function personaNeighbours(seed, vectors, k = SIMILAR_K) {
  const v = vectors.get(seed);
  if (!v) return [];
  const out = [];
  for (const [key, w] of vectors) {
    if (key === seed) continue;
    const c = cosine(v, w);
    if (c !== null) out.push([key, c]);
  }
  out.sort((a, b) => b[1] - a[1] || byKey(a[0], b[0]));
  return out.slice(0, k).map(([key]) => key);
}

/** Score `rank(seedKey) -> [show_key...]` over the eval set. With `pool`
    (a Set of rated keys) the view is the reachable one: only seeds in the
    pool, `expected` and `must_not` cut to the pool, and a seed with no
    expected show left is skipped. */
export function similarAgreement(evalSet, rank, { k = evalSet.k ?? SIMILAR_K, pool = null } = {}) {
  const rows = [];
  for (const e of evalSet.seeds) {
    let expected = e.expected;
    let mustNot = e.must_not;
    if (pool) {
      if (!pool.has(e.seed)) continue;
      expected = expected.filter((id) => pool.has(id));
      mustNot = mustNot.filter((id) => pool.has(id));
      if (!expected.length) continue;
    }
    rows.push({ seed: e.seed, ...scoreSeed(rank(e.seed).slice(0, k), expected, mustNot, k) });
  }
  return { k, rows, ...aggregate(rows) };
}

/* ------------------------------------------------------------ chart */

/** Spearman between chart rank and fit per persona (and the per-show mean
    fit), over shows whose `chart_rank` is an integer 1-200.
    `shows`: `[{ chart_rank, fits: { pid: fit } }]`. */
export function chartBaseline(shows, personaIds) {
  const charted = shows.filter((s) => Number.isInteger(s.chart_rank) && s.chart_rank >= 1 && s.chart_rank <= 200);
  const per = {};
  for (const pid of personaIds) {
    const pairs = charted.filter((s) => isNum(s.fits[pid]));
    per[pid] = { n: pairs.length, rho: pairs.length >= 3 ? spearman(pairs.map((s) => s.chart_rank), pairs.map((s) => s.fits[pid])) : null };
  }
  const meanFit = (s) => {
    const v = personaIds.map((p) => s.fits[p]).filter(isNum);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const withMean = charted.filter((s) => meanFit(s) !== null);
  const mean = { n: withMean.length, rho: withMean.length >= 3 ? spearman(withMean.map((s) => s.chart_rank), withMean.map(meanFit)) : null };
  return { charted: charted.length, total: shows.length, per, mean };
}

/* ------------------------------------------------------- coverage, skew */

/** The `n` best rated shows for one persona: fit desc, return_prob desc,
    show_key asc. `shows`: `[{ show_key, personas: { pid: [fit, return_prob, ...] } }]`. */
export function topShows(shows, pid, n = TOP_N) {
  return shows
    .filter((s) => Array.isArray(s.personas?.[pid]) && isNum(s.personas[pid][0]))
    .sort((a, b) => b.personas[pid][0] - a.personas[pid][0] || (b.personas[pid][1] ?? -1) - (a.personas[pid][1] ?? -1) || byKey(a.show_key, b.show_key))
    .slice(0, n);
}

/** Share profile of a set of shows `{ dai: "true"|"false"|"unknown", chart, explicit?, tier?, root }`.
    DAI's share is over the classified shows only (`daiKnown` is its
    denominator) and explicit's over the rows that carry a boolean
    (`explicitKnown`); every other share is over all `n`. A set whose rows all
    lack `explicit` or `tier` has no share for it (null, "n/a"). */
export function shareProfile(rows) {
  const n = rows.length;
  const daiKnown = rows.filter((r) => r.dai === "true" || r.dai === "false").length;
  const explicitKnown = rows.filter((r) => typeof r.explicit === "boolean").length;
  const roots = {};
  for (const r of rows) roots[r.root] = (roots[r.root] || 0) + 1;
  const share = (count, total) => (total ? count / total : null);
  return {
    n,
    daiKnown,
    dai: share(rows.filter((r) => r.dai === "true").length, daiKnown),
    chartTop25: share(rows.filter((r) => r.chart === "1-25").length, n),
    explicitKnown,
    explicit: share(rows.filter((r) => r.explicit === true).length, explicitKnown),
    transcript: rows.every((r) => r.tier === undefined) ? null : share(rows.filter((r) => r.tier === "transcript").length, n),
    roots: Object.fromEntries(Object.entries(roots).map(([k, c]) => [k, c / n])),
  };
}

/** Per persona, the share profile of its top-N rated shows (and `minFit`, the
    lowest fit that made the cut), beside the rated set's and the catalogue's. `rated`: `[{ show_key, personas, attrs }]`;
    `catalogue`: attrs rows without `tier` (breadth rows also without `explicit`). */
export function skewAudit(rated, catalogue, personaIds, { n = TOP_N } = {}) {
  const per = {};
  for (const pid of personaIds) {
    const top = topShows(rated, pid, n);
    per[pid] = { ...shareProfile(top.map((s) => s.attrs)), minFit: top.length ? Math.min(...top.map((s) => s.personas[pid][0])) : null };
  }
  return { n, per, rated: shareProfile(rated.map((s) => s.attrs)), catalogue: shareProfile(catalogue) };
}

/* ------------------------------------------------------------- loading */

function readJson(rel, root) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

/** The catalogue universe (curated by show_id, breadth by apple id minus the
    curated shows' breadth twins; sample.mjs's universe) with the attributes
    the skew audit reads. A curated show's root, archetypes and Apple
    `explicit` (only when it is a boolean; catalog.json has null for a few)
    come from catalog.json; chart rank from the breadth row (a curated show's
    via its twin). A breadth row has no `explicit`: the harvest's flag is
    false on every row, so it is not evidence. */
export function catalogueAttrs(catalog, breadth, dai) {
  const byAcid = new Map(breadth.shows.map((b) => [String(b.apple_collection_id), b]));
  const daiOf = (acid) => {
    const e = acid ? dai.shows?.[acid] : undefined;
    return e?.dai === true ? "true" : e?.dai === false ? "false" : "unknown";
  };
  const out = new Map();
  const curatedAcids = new Set();
  for (const c of catalog.shows) {
    const acid = c.apple_collection_id ? String(c.apple_collection_id) : null;
    if (acid) curatedAcids.add(acid);
    const twin = acid ? byAcid.get(acid) : undefined;
    out.set(String(c.show_id), {
      root: rootOf(c.taxonomy_node_ids?.length ? c.taxonomy_node_ids : twin?.taxonomy_node_ids),
      chart_rank: twin?.chart_rank ?? null,
      chart: chartBand(twin?.chart_rank ?? null),
      dai: daiOf(acid),
      ...(typeof c.explicit === "boolean" ? { explicit: c.explicit } : {}),
      archetypes: Array.isArray(c.archetype_fit) ? c.archetype_fit : [],
      curated: true,
    });
  }
  for (const b of breadth.shows) {
    const acid = String(b.apple_collection_id);
    if (curatedAcids.has(acid)) continue;
    out.set(acid, {
      root: rootOf(b.taxonomy_node_ids),
      chart_rank: b.chart_rank ?? null,
      chart: chartBand(b.chart_rank ?? null),
      dai: daiOf(acid),
      archetypes: [],
      curated: false,
    });
  }
  return out;
}

/** Load the committed inputs and compute every table. */
export function runEval(root = ROOT) {
  const ratings = readJson(PATHS.ratings, root);
  const profiles = readJson(PATHS.profiles, root).personas;
  const personaIds = profiles.map((p) => p.id).sort(byKey);
  const attrs = catalogueAttrs(readJson(PATHS.catalog, root), readJson(PATHS.breadth, root), readJson(PATHS.dai, root));
  const evalSet = readJson(PATHS.evalSet, root);

  const rated = [];
  const missing = [];
  for (const key of Object.keys(ratings.shows).sort(byKey)) {
    const s = ratings.shows[key];
    const a = attrs.get(key);
    if (!a) {
      missing.push(key);
      continue;
    }
    rated.push({ show_key: key, personas: s.personas, top_persona: s.top_persona, tier: s.evidence_tier, explicit: s.flags?.explicit === true, a });
  }

  // 1. archetype agreement
  const modalOf = nodeModalPersona(rated.map((r) => ({ show_key: r.show_key, root: r.a.root, top_persona: r.top_persona })));
  const curatedRated = rated.filter((r) => r.a.curated && r.a.archetypes.length);
  const archetype = archetypeAgreement(
    curatedRated.map((r) => ({ show_key: r.show_key, archetypes: r.a.archetypes, top_persona: r.top_persona, root: r.a.root })),
    { personaIds, nodeModal: modalOf, affinityOf: (rt) => affinityPersona(rt, profiles) }
  );

  // 2. similar shows
  const vectors = new Map(rated.filter((r) => r.a.curated).map((r) => [r.show_key, fitVector(r.personas, personaIds)]));
  const pool = new Set(vectors.keys());
  const personaRank = (seed) => personaNeighbours(seed, vectors, evalSet.k);
  const catalog = readJson(PATHS.catalog, root);
  const pooledCatalog = { shows: catalog.shows.filter((s) => pool.has(s.show_id)) };
  const byId = new Map(catalog.shows.map((s) => [s.show_id, s]));
  const nodeRank = (seed) => (pool.has(seed) ? similarShowsFor(pooledCatalog, byId.get(seed)).map((s) => s.show_id) : []);
  const similar = {
    pool: pool.size,
    personaAll: similarAgreement(evalSet, personaRank),
    personaReachable: similarAgreement(evalSet, personaRank, { pool }),
    nodeReachable: similarAgreement(evalSet, nodeRank, { pool }),
  };

  // 3. chart baseline
  const chart = chartBaseline(
    rated.map((r) => ({ chart_rank: r.a.chart_rank, fits: Object.fromEntries(personaIds.map((p) => [p, r.personas[p]?.[0]])) })),
    personaIds
  );

  // 4. coverage and skew
  const skew = skewAudit(
    rated.map((r) => ({ show_key: r.show_key, personas: r.personas, attrs: { dai: r.a.dai, chart: r.a.chart, explicit: r.explicit, tier: r.tier, root: r.a.root } })),
    [...attrs.values()].map((a) => ({ dai: a.dai, chart: a.chart, root: a.root, ...(a.explicit === undefined ? {} : { explicit: a.explicit }) })),
    personaIds
  );

  return {
    inputs: { rated: rated.length, curatedRated: rated.filter((r) => r.a.curated).length, missing, personas: personaIds.length, catalogue: attrs.size, merged_batches: Array.isArray(ratings.merged_batches) ? ratings.merged_batches.length : null },
    personaIds,
    archetype,
    similar,
    chart,
    skew,
  };
}

/* ------------------------------------------------------------- report */

const f3 = (x) => (x === null || x === undefined ? "n/a" : x.toFixed(3));
const pct = (x) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`);

/** The generated block's body (without the markers), deterministic. */
export function renderSection(r) {
  const out = [];
  const i = r.inputs;
  out.push(
    `Inputs: ${i.rated} rated shows (${i.curatedRated} curated), ${i.personas} personas, ${i.merged_batches ?? "n/a"} merged batches in \`${PATHS.ratings}\`; catalogue universe ${i.catalogue} shows.${i.missing.length ? ` Rated keys not in the catalogue: ${i.missing.map((k) => `\`${k}\``).join(", ")}.` : ""}`
  );
  out.push("");

  out.push("### 1. Archetype agreement");
  out.push("");
  out.push("A hit: the show's `top_persona` is in the persona set its `archetype_fit` values map to. Baselines: uniform random, the root's modal top persona (leave-one-out over every rated show), the root's highest-affinity persona.");
  out.push("");
  out.push("| archetype | personas | shows | hits | precision | random | node modal | node affinity |");
  out.push("|---|---|---:|---:|---:|---:|---:|---:|");
  const line = (name, personas, a) => `| ${name} | ${personas} | ${a.n} | ${a.hits} | ${f3(a.precision)} | ${f3(a.random)} | ${f3(a.nodeModal)} | ${f3(a.affinity)} |`;
  out.push(line("**all mapped**", "union", r.archetype.all));
  for (const [a, row] of Object.entries(r.archetype.byArchetype)) out.push(line(`\`${a}\``, ARCHETYPE_PERSONAS[a].join(", "), row));
  const so = r.archetype.stretchOnly;
  const tops = Object.entries(so.top).sort((a, b) => b[1] - a[1] || byKey(a[0], b[0]));
  out.push("");
  out.push(`\`stretch\` only (no mapped persona, not scored): ${so.n} shows; top persona ${tops.length ? tops.map(([p, n]) => `${p} ${n}`).join(", ") : "none"}.`);
  out.push("");

  out.push("### 2. Similar-shows agreement");
  out.push("");
  out.push(`Persona ranking: cosine over the fit vector (fit - 1) among the ${r.similar.pool} rated curated shows. k = ${r.similar.personaAll.k}. Reported, not gated.`);
  out.push("");
  out.push("| ranking | view | seeds | precision (shown) | recall@6 | hit rate | coverage | must-not |");
  out.push("|---|---|---:|---:|---:|---:|---:|---:|");
  const sim = (name, view, a) => `| ${name} | ${view} | ${a.seeds} | ${f3(a.precision)} (${a.precisionSeeds}) | ${f3(a.recall)} | ${f3(a.hitRate)} | ${f3(a.coverage)} | ${a.violations} in ${a.seedsWithViolations} |`;
  out.push(sim("persona fit", "every seed, lists as judged", r.similar.personaAll));
  out.push(sim("persona fit", "reachable: rated seeds, lists cut to rated shows", r.similar.personaReachable));
  out.push(sim("similarShows (node overlap)", "reachable, same rated pool", r.similar.nodeReachable));
  out.push("| similarShows floors (229 shows) | committed, test/similar-shows-eval.test.js | 64 | 0.613 | 0.425 | 0.687 | 0.718 | general 0 |");
  out.push("");

  out.push("### 3. Chart baseline");
  out.push("");
  out.push(`Spearman between \`chart_rank\` (1 = top of an Apple genre chart) and \`fit\`, over the ${r.chart.charted} of ${r.chart.total} rated shows that chart. Negative means better-charting shows got higher fits.`);
  out.push("");
  out.push("| persona | shows | spearman |");
  out.push("|---|---:|---:|");
  for (const pid of r.personaIds) out.push(`| ${pid} | ${r.chart.per[pid].n} | ${f3(r.chart.per[pid].rho)} |`);
  out.push(`| **mean fit** | ${r.chart.mean.n} | ${f3(r.chart.mean.rho)} |`);
  out.push("");

  out.push("### 4. Coverage and skew");
  out.push("");
  out.push(`Each persona's top ${r.skew.n} rated shows (fit, then return_prob, then show_key). DAI is a share of the shows the DAI classifier covered (n in brackets); chart and tier shares are of all ${r.skew.n}. Explicit is a share of the shows with a known flag (n in brackets): the rater's flag for the rated set and the personas, Apple's flag in \`${PATHS.catalog}\` for the catalogue row, which covers curated shows only (the breadth harvest carries no explicit flag). Transcript tier has no catalogue base (the catalogue's tier mix depends on data-local caches).`);
  out.push("");
  out.push("| set | lowest fit | DAI (classified) | chart top-25 | explicit (known) | transcript tier | leading roots |");
  out.push("|---|---:|---:|---:|---:|---:|---|");
  const roots = (p) =>
    Object.entries(p.roots)
      .sort((a, b) => b[1] - a[1] || byKey(a[0], b[0]))
      .slice(0, 3)
      .map(([k, s]) => `${k} ${pct(s)}`)
      .join(", ");
  const skewLine = (name, p) => `| ${name} | ${p.minFit ?? ""} | ${pct(p.dai)} (${p.daiKnown}) | ${pct(p.chartTop25)} | ${pct(p.explicit)} (${p.explicitKnown}) | ${pct(p.transcript)} | ${roots(p)} |`;
  out.push(skewLine("**catalogue**", r.skew.catalogue));
  out.push(skewLine("**rated set**", r.skew.rated));
  for (const pid of r.personaIds) out.push(skewLine(pid, r.skew.per[pid]));
  return out.join("\n");
}

/** `text` with its generated block replaced by `section`. Throws if the markers are missing. */
export function spliceReport(text, section) {
  const norm = text.replace(/\r\n/g, "\n");
  const a = norm.indexOf(BEGIN);
  const b = norm.indexOf(END, a < 0 ? 0 : a);
  if (a < 0 || b < a) throw new Error(`${REPORT_PATH} has lost its GENERATED markers`);
  return norm.slice(0, a + BEGIN.length) + "\n" + section + "\n" + norm.slice(b);
}

/** True when the committed report's generated block matches a fresh run. */
export function reportIsCurrent(root = ROOT) {
  const text = fs.readFileSync(path.join(root, REPORT_PATH), "utf8").replace(/\r\n/g, "\n");
  return spliceReport(text, renderSection(runEval(root))) === text;
}

/** The --json summary: aggregates only, no per-seed rows. */
export function summary(r) {
  const strip = ({ rows, ...rest }) => rest;
  return {
    inputs: r.inputs,
    archetype: r.archetype,
    similar: { pool: r.similar.pool, personaAll: strip(r.similar.personaAll), personaReachable: strip(r.similar.personaReachable), nodeReachable: strip(r.similar.nodeReachable) },
    chart: r.chart,
    skew: r.skew,
  };
}

export function main(argv = process.argv.slice(2), { root = ROOT, log = console.log, error = console.error } = {}) {
  if (argv.includes("--json")) {
    log(JSON.stringify(summary(runEval(root)), null, 2));
    return 0;
  }
  if (argv.includes("--check")) {
    if (reportIsCurrent(root)) {
      log(`${REPORT_PATH}: generated block is current`);
      return 0;
    }
    error(`${REPORT_PATH}: generated block is STALE -- run node tools/recommender/eval.mjs`);
    return 1;
  }
  const full = path.join(root, REPORT_PATH);
  const text = fs.readFileSync(full, "utf8");
  fs.writeFileSync(full, spliceReport(text, renderSection(runEval(root))));
  log(`wrote ${REPORT_PATH}`);
  return 0;
}

/* tools/ci/entry.mjs's guard (tools/entrypoint-guards.test.mjs). */
if (isEntryScript(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
