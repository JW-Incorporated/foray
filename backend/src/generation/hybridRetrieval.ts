import { matchConceptsInText, tokenizeForSourcing, type SemanticConcept } from "./catalogueLookup";

/**
 * THE HYBRID MERGE (GV-48; roadmap docs/roadmap/generation-v2.md, from W3-09;
 * covers R1-09, R2-04 and QK-22).
 *
 * Pure functions, no I/O: the retrieval server (`cli/retrievalServer.ts`)
 * calls them with its BM25 answer and the passage store's dense hits, and the
 * tests call them with literals.
 *
 * WHY 'append' IS THE DEFAULT. The keyword arm is what sourcing is tuned on,
 * and tools/corpus measured hybrid search LOSING to keyword on its gold set.
 * So the semantic arm may only ADD candidates, the rule tier 2's title path
 * already follows (sourceBeats.ts `tier2Candidates`, "can only ADD
 * candidates"): every BM25 candidate keeps its place and rank, and at most
 * `denseExtra` dense-only episodes are appended after them. 'rrf' (reciprocal
 * rank fusion at episode level) reorders and exists for evaluation only (the
 * replay gate, GV-88).
 *
 * THE IDF TRAVELS WITH EVERY CANDIDATE. Tier 2's window floors
 * (transcriptArchiveLookup.ts, the weighted window search) weigh each claim
 * term by the corpus idf the BM25 search computed. A dense-only episode was
 * found without any term, but it is windowed the same way, so it carries the
 * same map as its BM25 neighbours: one map per query, shared by reference.
 *
 * Each candidate says how it was found (`via`): 'bm25', 'dense' or 'both', and
 * a candidate the dense arm found carries its best passage (seconds and
 * boundary kinds), which is what the client's hints (retrievalClient.ts
 * `CandidateHint`) read.
 */

export type MergePolicy = "append" | "rrf";
export type CandidateVia = "bm25" | "dense" | "both";

export const MERGE_POLICIES: readonly MergePolicy[] = ["append", "rrf"];
/** Dense-only episodes 'append' may add after the BM25 list. */
export const DEFAULT_DENSE_EXTRA = 4;
/** The reciprocal-rank-fusion constant (Cormack et al.'s 60). */
export const DEFAULT_RRF_K = 60;

/** A BM25 candidate as the server answers it (`WireCandidate`). */
export interface LexicalCandidate {
  show_id: string;
  guid: string;
  score: number;
  matchedTerms: number;
  rank: number;
}

/** A passage's place in its episode: what a candidate's hint carries. */
export interface BestPassage {
  passageId: string;
  startSec: number;
  endSec: number;
  startBoundary: string;
  endBoundary: string;
}

/** One dense passage hit, with its passage's bounds. */
export interface DenseHit extends BestPassage {
  show_id: string;
  guid: string;
  /** Cosine similarity of the query and the passage's best chunk. */
  sim: number;
}

export interface HybridCandidate extends LexicalCandidate {
  via: CandidateVia;
  /** The best dense passage of the episode; null when the dense arm did not
   * find it. */
  passage: BestPassage | null;
  /** That passage's similarity; null with no passage. */
  denseSim: number | null;
  /** The query's BM25 idf map, the same object on every candidate. */
  idf: ReadonlyMap<string, number>;
}

export interface MergeOptions {
  policy?: MergePolicy;
  denseExtra?: number;
  k?: number;
  /** The BM25 search's idf map for this query. */
  idf?: ReadonlyMap<string, number>;
}

const episodeKey = (showId: string, guid: string): string => `${showId}\u0000${guid}`;

function byIdAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface DenseEpisode {
  key: string;
  show_id: string;
  guid: string;
  best: DenseHit;
}

/** Dense hits grouped by episode, best passage first, episodes in the order of
 * their best passage. Sorted here (sim desc, passage id asc) so an unsorted
 * input gives the same answer. */
function denseEpisodes(dense: readonly DenseHit[]): DenseEpisode[] {
  const sorted = [...dense].sort((a, b) => b.sim - a.sim || byIdAsc(a.passageId, b.passageId));
  const out: DenseEpisode[] = [];
  const seen = new Set<string>();
  for (const hit of sorted) {
    const key = episodeKey(hit.show_id, hit.guid);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, show_id: hit.show_id, guid: hit.guid, best: hit });
  }
  return out;
}

function boundsOf(hit: DenseHit): BestPassage {
  return { passageId: hit.passageId, startSec: hit.startSec, endSec: hit.endSec, startBoundary: hit.startBoundary, endBoundary: hit.endBoundary };
}

/** Reciprocal rank fusion: each id scores the sum of 1 / (k + rank + 1) over
 * the rankings it appears in (rank 0-based). */
export function reciprocalRankFusion(rankings: ReadonlyArray<readonly string[]>, k: number = DEFAULT_RRF_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    ranking.forEach((id, rank) => {
      if (seen.has(id)) return;
      seen.add(id);
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return fused;
}

/**
 * Merge one query's BM25 candidates and dense passage hits into episode
 * candidates. 'append' (the default): the BM25 list in its own order, then up
 * to `denseExtra` dense-only episodes in dense order. 'rrf': episode-level
 * reciprocal rank fusion, at most `bm25.length + denseExtra` candidates.
 */
export function mergeCandidates(bm25: readonly LexicalCandidate[], dense: readonly DenseHit[], options: MergeOptions = {}): HybridCandidate[] {
  const policy = options.policy ?? "append";
  const denseExtra = options.denseExtra ?? DEFAULT_DENSE_EXTRA;
  const k = options.k ?? DEFAULT_RRF_K;
  const idf = options.idf ?? new Map<string, number>();
  if (!MERGE_POLICIES.includes(policy)) throw new Error(`merge policy must be append or rrf, got ${String(policy)}`);
  if (!Number.isInteger(denseExtra) || denseExtra < 0) throw new Error(`denseExtra must be a non-negative integer, got ${denseExtra}`);
  if (!Number.isFinite(k) || k < 0) throw new Error(`k must be a non-negative number, got ${k}`);

  const fromDense = denseEpisodes(dense);
  const denseByKey = new Map(fromDense.map((e) => [e.key, e]));
  /* A repeated BM25 row keeps its first place. */
  const lexical: LexicalCandidate[] = [];
  const lexicalKeys = new Set<string>();
  for (const c of bm25) {
    const key = episodeKey(c.show_id, c.guid);
    if (lexicalKeys.has(key)) continue;
    lexicalKeys.add(key);
    lexical.push(c);
  }

  const fromLexical = (c: LexicalCandidate): Omit<HybridCandidate, "rank"> => {
    const d = denseByKey.get(episodeKey(c.show_id, c.guid));
    return {
      show_id: c.show_id,
      guid: c.guid,
      score: c.score,
      matchedTerms: c.matchedTerms,
      via: d ? "both" : "bm25",
      passage: d ? boundsOf(d.best) : null,
      denseSim: d ? d.best.sim : null,
      idf
    };
  };
  const fromDenseOnly = (d: DenseEpisode, score: number): Omit<HybridCandidate, "rank"> => ({
    show_id: d.show_id,
    guid: d.guid,
    score,
    matchedTerms: 0,
    via: "dense",
    passage: boundsOf(d.best),
    denseSim: d.best.sim,
    idf
  });

  if (policy === "append") {
    const out: HybridCandidate[] = lexical.map((c, rank) => ({ ...fromLexical(c), rank }));
    let added = 0;
    for (const d of fromDense) {
      if (added >= denseExtra) break;
      if (lexicalKeys.has(d.key)) continue;
      out.push({ ...fromDenseOnly(d, 0), rank: out.length });
      added += 1;
    }
    return out;
  }

  const lexicalRank = new Map(lexical.map((c, i) => [episodeKey(c.show_id, c.guid), i]));
  const denseRank = new Map(fromDense.map((d, i) => [d.key, i]));
  const fused = reciprocalRankFusion(
    [lexical.map((c) => episodeKey(c.show_id, c.guid)), fromDense.map((d) => d.key)],
    k
  );
  const order = [...fused.keys()].sort((a, b) => {
    const diff = (fused.get(b) ?? 0) - (fused.get(a) ?? 0);
    if (diff !== 0) return diff;
    const la = lexicalRank.get(a) ?? Infinity;
    const lb = lexicalRank.get(b) ?? Infinity;
    if (la !== lb) return la - lb;
    const da = denseRank.get(a) ?? Infinity;
    const db = denseRank.get(b) ?? Infinity;
    if (da !== db) return da - db;
    return byIdAsc(a, b);
  });
  const lexicalByKey = new Map(lexical.map((c) => [episodeKey(c.show_id, c.guid), c]));
  return order.slice(0, lexical.length + denseExtra).map((key, rank) => {
    const score = fused.get(key) ?? 0;
    const c = lexicalByKey.get(key);
    if (c) return { ...fromLexical(c), score, rank };
    return { ...fromDenseOnly(denseByKey.get(key) as DenseEpisode, score), rank };
  });
}

/* ---------------------------------------------------------------------------
   Lexical scoring over passage text: the shortlist's keyword arm and its
   rerank when the server has no query embedder.
   --------------------------------------------------------------------------- */

export interface PassageText {
  passageId: string;
  text: string;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * BM25 of `query` over each passage's text, with the sourcing tokenizer. A
 * term's weight comes from `idf` when the map has it (the corpus idf of the
 * episode search), else from the passages given. Passages that match no term
 * score 0.
 */
export function scorePassagesBm25(query: string, passages: readonly PassageText[], options: { idf?: ReadonlyMap<string, number> } = {}): Map<string, number> {
  const terms = [...new Set(tokenizeForSourcing(query))];
  const scores = new Map<string, number>();
  if (passages.length === 0) return scores;
  const docs = passages.map((p) => {
    const tokens = tokenizeForSourcing(p.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { id: p.passageId, length: tokens.length, tf };
  });
  const avgLength = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const weight = new Map<string, number>();
  for (const term of terms) {
    const given = options.idf?.get(term);
    if (given !== undefined) {
      weight.set(term, given);
      continue;
    }
    const df = docs.filter((d) => d.tf.has(term)).length;
    weight.set(term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)));
  }
  for (const d of docs) {
    let score = 0;
    for (const term of terms) {
      const f = d.tf.get(term) ?? 0;
      if (f === 0) continue;
      score += (weight.get(term) ?? 0) * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * d.length) / avgLength)));
    }
    scores.set(d.id, score);
  }
  return scores;
}

/** Ids with a score above 0, best first, ties by id. */
export function rankByScore(scores: ReadonlyMap<string, number>): string[] {
  return [...scores.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || byIdAsc(a[0], b[0]))
    .map(([id]) => id);
}

/* ---------------------------------------------------------------------------
   The per-taxonomy-node shortlist query.
   --------------------------------------------------------------------------- */

export interface ShortlistNode {
  id: string;
  parent: string | null;
  label: string;
}

/**
 * A node's shortlist query: its label, its children's labels, and the terms
 * of every semantic-index concept the label matches (`matchConceptsInText`
 * with the node as the topic, so an off-branch concept matched only on a stem
 * is dropped, exactly as sourcing drops it). Terms are deduplicated, first
 * occurrence kept; hyphens become spaces so the sourcing tokenizer sees words.
 */
export function nodeShortlistQuery(node: ShortlistNode, nodes: readonly ShortlistNode[], concepts: Readonly<Record<string, SemanticConcept>>): string {
  const parts: string[] = [node.label];
  for (const child of nodes) if (child.parent === node.id) parts.push(child.label);
  for (const key of matchConceptsInText(node.label, concepts as Record<string, SemanticConcept>, { topic: node.id })) {
    for (const term of concepts[key]?.terms ?? []) parts.push(term.replace(/-/g, " "));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const p = part.trim();
    const key = p.toLowerCase();
    if (p.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.join(" ");
}
