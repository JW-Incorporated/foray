/* Retrieval evaluation: the instrument that keeps us honest.
 *
 * Scores a committed gold set (eval/gold-queries.json) against the real
 * search path. Its whole reason for existing is that "search feels better"
 * is not a claim anyone should accept, including from us — so before any
 * change to retrieval, the previous numbers are recorded here, per query.
 *
 * Scored on distinct SOURCE ids in result order, because "did it find the
 * right document" is the question a human actually has. Chunk-level scoring
 * would reward a system that returns eight chunks of one right answer over
 * one that returns three different right answers.
 */

import { keywordSearch, sourcesInOrder } from "./search.mjs";

/** Rank (1-indexed) of the first primary hit, or 0 if none in the list. */
function firstHitRank(order, primary) {
  for (let i = 0; i < order.length; i++) if (primary.includes(order[i])) return i + 1;
  return 0;
}

const gain = (id, q) => (q.primary.includes(id) ? 2 : (q.secondary ?? []).includes(id) ? 1 : 0);

function ndcgAt(order, q, k) {
  let dcg = 0;
  for (let i = 0; i < Math.min(order.length, k); i++) {
    const g = gain(order[i], q);
    if (g) dcg += g / Math.log2(i + 2);
  }
  const ideal = [
    ...q.primary.map(() => 2),
    ...(q.secondary ?? []).map(() => 1),
  ].slice(0, k);
  let idcg = 0;
  for (let i = 0; i < ideal.length; i++) idcg += ideal[i] / Math.log2(i + 2);
  return idcg ? dcg / idcg : 0;
}

/**
 * Run every gold query in one mode.
 * @returns {{mode, perQuery: object[], aggregate: object}}
 */
export function runEval(db, gold, { mode = "keyword", limit = 8, ...opts } = {}) {
  /* Depth defaults to the CLI's own --limit. Evaluating deeper than users
   * ever see inflates nDCG for free (at 25 this set scores 0.865 against
   * 0.790 at 8) and measures a product nobody uses. Pass --limit to explore. */
  const perQuery = gold.queries.map((q) => {
    if (mode !== "keyword") throw new Error(`unknown eval mode: ${mode}`);
    /* A query that ERRORS is a legitimate measurement, not a reason to abort
     * the run — recording the old raw-passthrough behaviour (which threw
     * `fts5: syntax error` on ordinary questions) is half the point of having
     * a before-number at all. */
    let rows = [], match = null, error = null;
    try {
      ({ rows, match } = keywordSearch(db, q.q, { ...opts, limit }));
    } catch (err) {
      error = err.message;
    }
    const order = sourcesInOrder(rows);
    const rank = firstHitRank(order, q.primary);
    const negatives = (q.negative ?? []).filter((n) => order.slice(0, 5).includes(n));
    return {
      id: q.id,
      q: q.q,
      found: rank > 0,
      recall5: order.slice(0, 5).some((id) => q.primary.includes(id)) ? 1 : 0,
      rr: rank ? 1 / rank : 0,
      ndcg10: ndcgAt(order, q, limit),
      top5: order.slice(0, 5),
      firstHitRank: rank,
      negativesInTop5: negatives,
      match,
      error,
    };
  });

  const mean = (f) => perQuery.reduce((a, r) => a + f(r), 0) / perQuery.length;
  return {
    mode,
    limit,
    perQuery,
    aggregate: {
      queries: perQuery.length,
      found: perQuery.filter((r) => r.found).length,
      recall5: mean((r) => r.recall5),
      mrr10: mean((r) => r.rr),
      ndcg10: mean((r) => r.ndcg10),
      errors: perQuery.filter((r) => r.error).length,
      negativeHits: perQuery.reduce((a, r) => a + r.negativesInTop5.length, 0),
    },
  };
}

/** Fixed-width report. Per-query lines are not optional — the aggregate alone
 *  hides exactly the regressions this exists to catch. */
export function formatEval(result) {
  const L = [];
  const k = result.limit;
  L.push(`mode: ${result.mode}   depth: top-${k} (the CLI's own default)`);
  L.push("");
  L.push(` id  found  rr     ndcg@${String(k).padEnd(2)} top-5 sources                 query`);
  for (const r of result.perQuery) {
    L.push(
      `${String(r.id).padStart(3)}  ${(r.error ? "ERR" : r.found ? "yes" : "NO ").padEnd(5)}  ` +
        `${r.rr.toFixed(2)}   ${r.ndcg10.toFixed(3)}   ` +
        `${r.top5.join(",").padEnd(28).slice(0, 28)}  ${r.q}` +
        (r.error ? `  [${r.error}]` : "") +
        (r.negativesInTop5.length ? `  [!negative: ${r.negativesInTop5.join(",")}]` : "")
    );
  }
  const a = result.aggregate;
  L.push("");
  L.push(
    `found ${a.found}/${a.queries}   Recall@5 ${a.recall5.toFixed(3)}   ` +
      `MRR@${k} ${a.mrr10.toFixed(3)}   nDCG@${k} ${a.ndcg10.toFixed(3)}` +
      (a.errors ? `   ERRORED ${a.errors}` : "") +
      (a.negativeHits ? `   negatives-in-top5 ${a.negativeHits}` : "")
  );
  return L.join("\n");
}
