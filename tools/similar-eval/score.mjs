/* Scoring for the Similar-shows eval (#560 item 8). Pure: no file reads, no
   app state. `rank(show)` is whatever ranking is under test — in the shipped
   eval it is the app.js mirror in ./similar-shows.mjs.

   THE METRICS, AND WHY EACH IS DEFINED THIS WAY
   `k` is the number of slots the show page renders (similarShows' default
   limit, 6). Per seed, with R = the ranked list (at most k) and E = the
   hand-judged expected set:

     precision  |R ∩ E| / |R|, only for a seed with |R| > 0. Divided by what
                was SHOWN, not by k: similarShows deliberately renders a short
                or empty row rather than padding ("honest sparse beats
                padding", app.js), so dividing by k would score that rule as
                imprecision. An empty row is measured by `coverage` instead.
     recall     |R ∩ E| / min(|E|, k). Capped at k so a seed with eight good
                neighbours can still score 1.0 in six slots.
     hit        |R ∩ E| > 0 — the row shows at least one right answer.
     covered    |R| > 0 — the row renders at all.
     violations every must_not show in R. A returned show in neither list is
                unjudged and counts as a miss in precision, never as a
                violation.

   Aggregates are macro-averages over seeds (each seed weighs the same), so
   one well-populated cluster cannot hide a dozen empty rows. */

/** Score one seed. `returned` is an array of show_ids, already cut to k. */
export function scoreSeed(returned, expected, mustNot, k) {
  const exp = new Set(expected);
  const bad = new Set(mustNot);
  const hits = returned.filter((id) => exp.has(id));
  const violations = returned.filter((id) => bad.has(id));
  const missed = expected.filter((id) => !returned.includes(id));
  return {
    returned,
    hits,
    missed,
    violations,
    unjudged: returned.filter((id) => !exp.has(id) && !bad.has(id)),
    precision: returned.length ? hits.length / returned.length : null,
    recall: expected.length ? hits.length / Math.min(expected.length, k) : null,
    hit: hits.length > 0,
    covered: returned.length > 0,
  };
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Macro-aggregate a list of scored seeds. */
export function aggregate(rows) {
  const precisions = rows.map((r) => r.precision).filter((p) => p !== null);
  const recalls = rows.map((r) => r.recall).filter((p) => p !== null);
  return {
    seeds: rows.length,
    precision: mean(precisions),
    precisionSeeds: precisions.length,
    recall: mean(recalls),
    hitRate: rows.length ? rows.filter((r) => r.hit).length / rows.length : null,
    coverage: rows.length ? rows.filter((r) => r.covered).length / rows.length : null,
    violations: rows.reduce((n, r) => n + r.violations.length, 0),
    seedsWithViolations: rows.filter((r) => r.violations.length).length,
  };
}

/**
 * Run the whole eval. `catalog` is the parsed data/catalog-client.json,
 * `evalSet` the parsed eval-set.json, `rank(show)` returns an ordered array of
 * show objects. Returns per-seed rows plus aggregates for all seeds, for the
 * curated seeds and for the label_scope "general" seeds.
 */
export function evaluate(catalog, evalSet, rank) {
  const byId = new Map(catalog.shows.map((s) => [s.show_id, s]));
  const k = evalSet.k;
  const rows = evalSet.seeds.map((entry) => {
    const show = byId.get(entry.seed);
    if (!show) throw new Error(`eval seed ${entry.seed} is not in the catalogue`);
    const returned = rank(show).slice(0, k).map((s) => s.show_id);
    return {
      seed: entry.seed,
      general: show.label_scope === "general",
      ...scoreSeed(returned, entry.expected, entry.must_not, k),
    };
  });
  return {
    k,
    rows,
    generalIds: catalog.shows.filter((s) => s.label_scope === "general").map((s) => s.show_id),
    all: aggregate(rows),
    curated: aggregate(rows.filter((r) => !r.general)),
    general: aggregate(rows.filter((r) => r.general)),
  };
}
