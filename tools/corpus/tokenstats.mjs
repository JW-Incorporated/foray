/* The measurement that gates the re-chunk.
 *
 * `chunk.mjs` packs chunks by a chars/4 heuristic. That heuristic is fine for
 * FTS5, which has no length limit, and it was documented as crude from the
 * start. An embedding model does have a limit — bge truncates at 512 real
 * tokens — and truncation is SILENT: the tail of an over-long chunk simply
 * does not exist as far as its vector is concerned, while `search` keeps
 * displaying the whole thing. A corpus can be 30% silently truncated and look
 * perfectly healthy.
 *
 * So: before embedding anything, run the model's OWN tokenizer over the exact
 * strings that will be encoded, and decide from the histogram whether the
 * corpus needs re-chunking. The decision rule is committed here rather than
 * eyeballed, so the same rule applies to whatever model comes next.
 *
 * Everything in this file is pure. The tokenizer is injected, so the
 * histogram maths is unit-tested with a stub and never needs the runtime.
 */

/** Default gate: re-chunk if more than 10% of chunks are within 32 tokens of
 *  the model's truncation limit (i.e. > 480 real tokens for a 512-token
 *  model). The margin exists because a chunk at 500 tokens is not yet
 *  truncated but is one re-extraction away from being. */
export const RECHUNK_THRESHOLD = 0.1;
export const DANGER_MARGIN = 32;

const BUCKET_EDGES = [64, 128, 192, 256, 320, 384, 448, 512, 640, 768, 1024, Infinity];

/**
 * @param {number[]} counts   real token counts, one per chunk
 * @param {{maxTokens:number, threshold?:number, margin?:number}} opts
 */
export function tokenHistogram(counts, { maxTokens, threshold = RECHUNK_THRESHOLD, margin = DANGER_MARGIN } = {}) {
  if (!counts.length) throw new Error("no chunks to measure");
  const sorted = [...counts].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

  const dangerAt = maxTokens - margin;
  const truncated = counts.filter((n) => n > maxTokens).length;
  const danger = counts.filter((n) => n > dangerAt).length;

  /* First bucket is inclusive of 0 so the buckets always sum to `chunks` —
   * an exclusive `> 0` silently dropped any zero-token chunk, which is
   * precisely the pathological input a histogram exists to surface. */
  const buckets = [];
  let lo = 0;
  for (const hi of BUCKET_EDGES) {
    buckets.push({ lo, hi, n: counts.filter((n) => (lo === 0 ? n >= lo : n > lo) && n <= hi).length });
    lo = hi;
  }

  return {
    chunks: counts.length,
    min: sorted[0],
    max: sorted.at(-1),
    mean: counts.reduce((a, b) => a + b, 0) / counts.length,
    p50: at(50), p90: at(90), p95: at(95), p99: at(99),
    maxTokens,
    dangerAt,
    truncated,
    truncatedRate: truncated / counts.length,
    danger,
    dangerRate: danger / counts.length,
    threshold,
    /* The gate itself. Deliberately keyed on the DANGER band rather than on
     * actual truncation: a corpus where 9% of chunks are truncated and
     * another 15% sit at 500 tokens is one extraction change away from being
     * much worse, and re-chunking is free. */
    shouldRechunk: danger / counts.length > threshold,
    buckets,
  };
}

/**
 * Ratio of real tokens to the chars/4 heuristic. Prints as the one number
 * that says whether the heuristic was lying, and in which direction — which
 * is what tells the next person whether to trust `stats`' token column.
 */
export function heuristicDrift(realCounts, estCounts) {
  const realSum = realCounts.reduce((a, b) => a + b, 0);
  const estSum = estCounts.reduce((a, b) => a + b, 0);
  return { realSum, estSum, ratio: estSum ? realSum / estSum : 0 };
}

export function formatHistogram(h, drift = null) {
  const L = [];
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const bar = (n) => "█".repeat(Math.round((n / Math.max(1, h.chunks)) * 60));
  L.push(`${h.chunks} chunks measured with the model's own tokenizer (limit ${h.maxTokens} tokens)`);
  L.push("");
  L.push(` min ${h.min}   p50 ${h.p50}   p90 ${h.p90}   p95 ${h.p95}   p99 ${h.p99}   max ${h.max}   mean ${h.mean.toFixed(1)}`);
  L.push("");
  for (const b of h.buckets) {
    if (!b.n && b.lo >= h.maxTokens) continue;
    const label = b.hi === Infinity ? `>${b.lo}` : `${b.lo + 1}–${b.hi}`;
    L.push(`  ${label.padStart(9)}  ${String(b.n).padStart(4)}  ${bar(b.n)}`);
  }
  L.push("");
  L.push(`TRUNCATED (>${h.maxTokens}):        ${h.truncated} chunks (${pct(h.truncatedRate)}) — text the vector cannot see`);
  L.push(`danger band (>${h.dangerAt}):      ${h.danger} chunks (${pct(h.dangerRate)})`);
  if (drift) {
    L.push(
      `chars/4 heuristic drift:    ${drift.realSum} real vs ${drift.estSum} estimated ` +
      `(real = ${drift.ratio.toFixed(2)}x estimated)`
    );
  }
  L.push("");
  L.push(
    h.shouldRechunk
      ? `GATE: RE-CHUNK. ${pct(h.dangerRate)} of chunks exceed ${h.dangerAt} real tokens, over the ${pct(h.threshold)} threshold.`
      : `GATE: no re-chunk needed. ${pct(h.dangerRate)} of chunks exceed ${h.dangerAt} real tokens, under the ${pct(h.threshold)} threshold.`
  );
  return L.join("\n");
}
