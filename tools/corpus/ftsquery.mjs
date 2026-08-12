/* Natural language → a safe FTS5 MATCH expression.
 *
 * WHY THIS EXISTS
 * `corpus search` used to pass the user's string straight into MATCH. Two
 * failures, both found by asking the corpus ordinary questions:
 *
 *   1. CRASHES. FTS5's query language owns `?`, `+`, `*`, `:`, `^`, `"`, and
 *      the bare words AND/OR/NOT/NEAR. So `search "what is DAI?"` died with
 *      `fts5: syntax error near "?"`, `search "C++ audio"` died on `+`, and
 *      an unbalanced quote died with `unterminated string`. Three of four
 *      plausible agent queries were errors, not results.
 *   2. SILENT ZEROES. Bare terms in FTS5 are implicitly ANDed, so a
 *      seven-word question demands a chunk containing all seven words.
 *      `what loudness target for stitched segments` returned nothing, while
 *      `loudness OR target OR stitched OR segments` returned the AES
 *      loudness source at rank 1. The corpus had the answer the whole time.
 *
 * THE FIX, in three parts:
 *   - Every term is emitted as a QUOTED PHRASE. Inside double quotes FTS5
 *     treats the content as literal text, so operators and punctuation stop
 *     being syntax. This is the same move as parameterising SQL: the user's
 *     bytes become data, never grammar.
 *   - Terms are ORed, not ANDed. bm25 already rewards documents that match
 *     more of the terms (it sums per-term contributions), so OR widens recall
 *     without flattening the ranking.
 *   - Adjacent term pairs are ORed in as phrases too. "reciprocal rank
 *     fusion" should beat a chunk that merely says "rank" three times;
 *     bigrams give bm25 something to prefer without costing any recall,
 *     because they are additional OR arms, never constraints.
 *
 * MEASURED, so nobody has to guess (15-query gold set, `corpus eval`):
 *   raw passthrough      found  3/15  Recall@5 0.200  MRR 0.200  nDCG 0.160  (4 crashed)
 *   built, bigrams off   found 15/15  Recall@5 1.000  MRR 0.911  nDCG 0.869  (1 distractor in top5)
 *   built, bigrams on    found 15/15  Recall@5 1.000  MRR 0.902  nDCG 0.865  (0 distractors)
 * Read that honestly: the bigram boost is NOT a measurable aggregate win —
 * it is inside the noise of a 15-query set, and on MRR it is nominally
 * behind. It is kept on by default on the strength of one datapoint (it
 * keeps a known Chromaprint distractor out of the top 5 on query 6) and
 * `--bigrams off` exists so the next person can re-measure rather than
 * inherit a belief. Do not cite it as an improvement.
 *
 * Deliberate literal input (real FTS5 syntax) is still available via the
 * `--raw` flag on the CLI; this builder is total and never throws.
 */

/* Function words that carry no retrieval signal in this corpus. Kept short
 * and boring on purpose: an aggressive list starts eating real query terms
 * ("state", "will", "case" are all meaningful here). */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "did", "do", "does", "for", "from", "had", "has", "have", "how", "i", "if",
  "in", "into", "is", "it", "its", "me", "my", "of", "on", "or", "our", "should",
  "so", "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "to", "was", "we", "were", "what", "when", "where", "which", "who",
  "why", "will", "with", "would", "you", "your",
]);

/** One term → an FTS5 phrase literal. Internal quotes double, per FTS5. */
const phrase = (t) => `"${t.replace(/"/g, '""')}"`;

/** Does this fragment contain anything the tokenizer would actually index? */
const indexable = (t) => /[\p{L}\p{N}]/u.test(t);

/**
 * Build an FTS5 MATCH expression from arbitrary user input.
 *
 * @param {string} input        raw user text; may contain anything
 * @param {object} [opts]
 * @param {boolean} [opts.bigrams=true]  OR in adjacent-pair phrases
 * @returns {{match: string|null, terms: string[], phrases: string[], dropped: string[]}}
 *          `match` is null when the input contains nothing indexable — callers
 *          must treat that as "no query", not as an empty result set.
 */
export function buildFtsQuery(input, { bigrams = true } = {}) {
  const raw = String(input ?? "");

  /* Explicit "quoted phrases" are honoured as phrases. An unterminated quote
   * is not an error here — the trailing fragment is just treated as words,
   * which is what someone who fumbled a quote meant anyway. */
  const phrases = [];
  const rest = raw.replace(/"([^"]*)"/g, (_, inner) => {
    const p = inner.trim();
    if (p && indexable(p)) phrases.push(p);
    return " ";
  });

  /* Everything else splits on non-alphanumerics. This is also what strips the
   * FTS5 metacharacters: they simply are not word characters. */
  const all = rest.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && indexable(t));

  const kept = all.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  const dropped = all.filter((t) => STOPWORDS.has(t.toLowerCase()));
  /* If the question was ALL function words ("how does it do that"), keeping
   * nothing would turn a real query into "no matches" — a silent lie. Fall
   * back to the unfiltered terms and let bm25 sort it out. */
  const terms = kept.length ? kept : all;

  const arms = [...phrases.map(phrase)];

  if (bigrams && terms.length >= 2) {
    for (let i = 0; i < terms.length - 1; i++) arms.push(phrase(`${terms[i]} ${terms[i + 1]}`));
  }
  arms.push(...terms.map(phrase));

  return {
    match: arms.length ? arms.join(" OR ") : null,
    terms,
    phrases,
    dropped: kept.length ? dropped : [],
  };
}
