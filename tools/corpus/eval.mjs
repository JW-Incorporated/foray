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
 *
 * THE COMPARISON IS THE PRODUCT. `runModes` runs every mode against the same
 * corpus, the same queries and the same depth, and `formatComparison` prints
 * them side by side with the per-query detail — because an aggregate alone
 * hides the one thing that actually blocks a default-mode change: a single
 * query flipping from found to not-found.
 */

import { search, sourcesInOrder, MODES } from "./search.mjs";

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
 *
 * Async because vector and hybrid have to encode the query; keyword still
 * touches nothing asynchronous, so the three modes stay directly comparable.
 * @returns {Promise<{mode, limit, perQuery, aggregate}>}
 */
export async function runEval(db, gold, { mode = "keyword", limit = 8, ...opts } = {}) {
  /* Depth defaults to the CLI's own --limit. Evaluating deeper than users
   * ever see inflates nDCG for free (at 25 this set scores 0.864 against
   * 0.788 at 8) and measures a product nobody uses. Pass --limit to explore. */
  const perQuery = [];
  let downgraded = null;

  for (const q of gold.queries) {
    /* A query that ERRORS is a legitimate measurement, not a reason to abort
     * the run — recording the old raw-passthrough behaviour (which threw
     * `fts5: syntax error` on ordinary questions) is half the point of having
     * a before-number at all. */
    let rows = [], match = null, error = null, ranMode = mode;
    try {
      const r = await search(db, q.q, { ...opts, mode, limit });
      ({ rows, match } = r);
      ranMode = r.mode;
      if (r.notice) downgraded = r.notice;
    } catch (err) {
      error = err.message;
    }
    const order = sourcesInOrder(rows);
    const rank = firstHitRank(order, q.primary);
    const negatives = (q.negative ?? []).filter((n) => order.slice(0, 5).includes(n));
    perQuery.push({
      id: q.id,
      q: q.q,
      found: rank > 0,
      recall5: order.slice(0, 5).some((id) => q.primary.includes(id)) ? 1 : 0,
      rr: rank ? 1 / rank : 0,
      ndcg10: ndcgAt(order, q, limit),
      top5: order.slice(0, 5),
      firstHitRank: rank,
      negativesInTop5: negatives,
      ranMode,
      match,
      error,
    });
  }

  const mean = (f) => perQuery.reduce((a, r) => a + f(r), 0) / perQuery.length;
  return {
    mode,
    limit,
    /* If the requested mode silently fell back, every number below describes
     * KEYWORD search wearing another mode's label. Saying so on the result is
     * the difference between an honest null result and a fabricated one. */
    downgraded,
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

/** Run several modes over the same corpus, queries and depth. */
export async function runModes(db, gold, { modes = MODES, ...opts } = {}) {
  const out = [];
  for (const mode of modes) out.push(await runEval(db, gold, { ...opts, mode }));
  return out;
}

/**
 * The acceptance gates, as code rather than as a paragraph someone has to
 * remember to apply.
 *
 * Gate 1 is absolute and is about individual queries, not averages: NO query
 * may go from found to not-found. A mode that lifts the mean while losing a
 * question outright has made the tool worse at the only job it has.
 * Gate 2 requires a win on BOTH Recall@5 and MRR — not one of them, and not
 * a tie. Keyword already answers this set 15/15, so recall cannot improve and
 * an unchanged 1.000 is explicitly not counted as a win.
 */
export function compareToBaseline(baseline, candidate) {
  const base = new Map(baseline.perQuery.map((r) => [r.id, r]));
  const regressions = candidate.perQuery
    .filter((r) => base.get(r.id)?.found && !r.found)
    .map((r) => ({ id: r.id, q: r.q, wasRank: base.get(r.id).firstHitRank }));
  const rankLosses = candidate.perQuery
    .filter((r) => r.found && base.get(r.id)?.found && r.firstHitRank > base.get(r.id).firstHitRank)
    .map((r) => ({ id: r.id, q: r.q, from: base.get(r.id).firstHitRank, to: r.firstHitRank }));

  const dRecall = candidate.aggregate.recall5 - baseline.aggregate.recall5;
  const dMrr = candidate.aggregate.mrr10 - baseline.aggregate.mrr10;
  const dNdcg = candidate.aggregate.ndcg10 - baseline.aggregate.ndcg10;
  return {
    baseline: baseline.mode,
    candidate: candidate.mode,
    regressions,
    rankLosses,
    dRecall, dMrr, dNdcg,
    noRegression: regressions.length === 0,
    beatsOnBoth: dRecall > 0 && dMrr > 0,
    /* The single boolean the default-mode decision hangs on. */
    earnsDefault: regressions.length === 0 && dRecall > 0 && dMrr > 0,
  };
}

/** Fixed-width report. Per-query lines are not optional — the aggregate alone
 *  hides exactly the regressions this exists to catch. */
export function formatEval(result) {
  const L = [];
  const k = result.limit;
  L.push(`mode: ${result.mode}   depth: top-${k} (the CLI's own default)`);
  if (result.downgraded) L.push(`!! DOWNGRADED: ${result.downgraded}`);
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

/** All modes side by side: per-query first, then aggregates, then the gates. */
export function formatComparison(results, { baselineMode = "keyword" } = {}) {
  const k = results[0].limit;
  const L = [];
  const modes = results.map((r) => r.mode);
  L.push(`gold set: ${results[0].aggregate.queries} queries   depth: top-${k}`);
  for (const r of results) {
    if (r.downgraded) L.push(`!! ${r.mode}: DOWNGRADED — ${r.downgraded}`);
  }
  L.push("");

  const head = modes.map((m) => `${m.slice(0, 7).padStart(7)}`).join("  ");
  L.push(` id  ${head}   query`);
  L.push(`     ${modes.map(() => "  rank ").join("  ")}`);
  for (let i = 0; i < results[0].perQuery.length; i++) {
    const cells = results.map((r) => {
      const p = r.perQuery[i];
      return (p.error ? "ERR" : p.found ? `#${p.firstHitRank}` : "MISS").padStart(7);
    }).join("  ");
    L.push(`${String(results[0].perQuery[i].id).padStart(3)}  ${cells}   ${results[0].perQuery[i].q}`);
  }

  L.push("");
  L.push(`  metric      ${modes.map((m) => m.slice(0, 7).padStart(9)).join("")}`);
  const row = (label, get) => L.push(`  ${label.padEnd(12)}${results.map((r) => get(r).padStart(9)).join("")}`);
  row("found", (r) => `${r.aggregate.found}/${r.aggregate.queries}`);
  row("Recall@5", (r) => r.aggregate.recall5.toFixed(3));
  row(`MRR@${k}`, (r) => r.aggregate.mrr10.toFixed(3));
  row(`nDCG@${k}`, (r) => r.aggregate.ndcg10.toFixed(3));
  row("neg-in-top5", (r) => String(r.aggregate.negativeHits));

  const baseline = results.find((r) => r.mode === baselineMode);
  if (baseline) {
    L.push("");
    L.push(`gates, against fixed-${baselineMode}:`);
    for (const cand of results.filter((r) => r.mode !== baselineMode)) {
      const c = compareToBaseline(baseline, cand);
      L.push(
        `  ${cand.mode.padEnd(8)} ΔRecall@5 ${c.dRecall >= 0 ? "+" : ""}${c.dRecall.toFixed(3)}` +
        `   ΔMRR ${c.dMrr >= 0 ? "+" : ""}${c.dMrr.toFixed(3)}` +
        `   ΔnDCG ${c.dNdcg >= 0 ? "+" : ""}${c.dNdcg.toFixed(3)}` +
        `   regressions ${c.regressions.length}` +
        `   -> ${c.earnsDefault ? "EARNS the default" : "does NOT earn the default"}`
      );
      for (const r of c.regressions) L.push(`      REGRESSION q${r.id} (was rank ${r.wasRank}, now not found): ${r.q}`);
      for (const r of c.rankLosses) L.push(`      rank loss  q${r.id}: ${r.from} -> ${r.to}: ${r.q}`);
    }
  }
  return L.join("\n");
}
