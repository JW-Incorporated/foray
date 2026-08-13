/* Retrieval over the corpus: keyword (FTS5/bm25), vector, and their fusion.
 *
 * This module exists so that `corpus search` and `corpus eval` run the exact
 * same code path — an eval that measures a different retriever than the one
 * users get is worse than no eval.
 *
 * IT HAS NO DEPENDENCY ON ANY EMBEDDING RUNTIME. The caller passes an
 * `embedQuery` function in; tests pass a deterministic stub, the CLI passes
 * the real one, and a checkout that never installed onnxruntime passes
 * nothing and gets keyword search. That is what makes "hybrid degrades to
 * keyword with a notice" a property of this file rather than a promise.
 */

import { buildFtsQuery } from "./ftsquery.mjs";
import { getModel, getModelById, loadMatrix } from "./embeddings.mjs";
import { topK } from "./vectors.mjs";

export const MODES = ["keyword", "vector", "hybrid"];

/* THE PRODUCT DEFAULT, and it is a measured claim rather than a preference.
 * It moves only when `corpus eval --all-modes` shows a candidate mode beating
 * fixed-keyword on BOTH Recall@5 and MRR with no query regressing from found
 * to not-found (see eval.mjs's compareToBaseline, which encodes those gates).
 * Whatever this constant says, PLAN.md's retro carries the numbers behind it. */
export const DEFAULT_SEARCH_MODE = "keyword";

const KEYWORD_SQL = `
  SELECT s.id AS source_id, s.title, s.area, c.id AS chunk_id, c.heading_path,
         snippet(chunks_fts, 0, '»', '«', ' … ', 18) AS snip,
         bm25(chunks_fts) AS score
  FROM chunks_fts
  JOIN chunks c    ON c.id = chunks_fts.rowid
  JOIN documents d ON d.id = c.document_id
  JOIN sources s   ON s.id = d.source_id
  WHERE chunks_fts MATCH ?
  ORDER BY score LIMIT ?
`;

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} query        raw user text (or literal FTS5 when raw=true)
 * @param {object} [opts]
 * @param {number}  [opts.limit=8]
 * @param {boolean} [opts.raw=false]      pass `query` to MATCH untouched
 * @param {boolean} [opts.bigrams=true]   phrase-boost adjacent term pairs
 * @returns {{rows: object[], match: string|null}}
 */
export function keywordSearch(db, query, { limit = 8, raw = false, bigrams = true } = {}) {
  const match = raw ? String(query) : buildFtsQuery(query, { bigrams }).match;
  if (!match) return { rows: [], match: null };
  return { rows: db.prepare(KEYWORD_SQL).all(match, limit), match };
}

/* Vector rows have no FTS snippet to show, so they carry a plain excerpt of
 * the chunk's own opening. Deliberately NOT a highlighted match: a semantic
 * hit often shares no literal term with the query, and inventing highlight
 * marks would suggest a lexical overlap that is not there. */
const EXCERPT_CHARS = 200;
const excerpt = (text) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)} …` : flat;
};

const CHUNK_META_SQL = (n) => `
  SELECT s.id AS source_id, s.title, s.area, c.id AS chunk_id, c.heading_path, c.text
  FROM chunks c
  JOIN documents d ON d.id = c.document_id
  JOIN sources s   ON s.id = d.source_id
  WHERE c.id IN (${Array(n).fill("?").join(",")})
`;

/**
 * Nearest chunks to an already-encoded query vector.
 *
 * `index` is the flat matrix from `loadMatrix`. It is passed in rather than
 * loaded here because `eval` runs 15 queries against the same matrix and
 * reloading 558 vectors per query would make the eval measure I/O.
 */
export function vectorSearch(db, queryVector, { limit = 8, index }) {
  if (!index || !index.count) return { rows: [], match: null };
  const ranked = topK(queryVector, index.matrix, index.dim, limit);
  const ids = ranked.map((r) => index.chunkIds[r.index]);
  if (!ids.length) return { rows: [], match: null };
  const meta = new Map(db.prepare(CHUNK_META_SQL(ids.length)).all(...ids).map((r) => [r.chunk_id, r]));
  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    const m = meta.get(ids[i]);
    /* A vector whose chunk vanished should be impossible — chunk_embeddings
     * cascades from chunks — so if it happens, skipping quietly would hide a
     * broken invariant. Surface it as a placeholder row instead of pretending
     * the result set is one shorter. */
    if (!m) {
      rows.push({ source_id: null, title: "(orphaned vector — chunk missing)", area: null, chunk_id: ids[i], heading_path: "", snip: "", score: ranked[i].score });
      continue;
    }
    const { text, ...rest } = m;
    rows.push({ ...rest, snip: excerpt(text), score: ranked[i].score });
  }
  return { rows, match: null };
}

/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Buettcher, SIGIR 2009 — source 29
 * in this very corpus). score(d) = Σ 1/(k + rank_i(d)).
 *
 * The point of RRF is that it never looks at the retrievers' SCORES, only at
 * their rank positions — so a bm25 score and a cosine similarity, which live
 * on incomparable scales and would need per-corpus normalisation to be added
 * directly, fuse with no tuning at all. k=60 is the paper's own constant; it
 * damps the top ranks so that one retriever's confident first place cannot
 * single-handedly outweigh broad agreement further down.
 *
 * Fusion is at CHUNK level because that is what both arms return and what the
 * CLI displays; source-level ordering is derived afterwards by
 * `sourcesInOrder`.
 */
export function rrfFuse(lists, { k = 60, limit = 8 } = {}) {
  const scores = new Map();
  const rows = new Map();
  const ranksOf = new Map();
  for (const list of lists) {
    list.forEach((row, i) => {
      const id = row.chunk_id;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
      if (!rows.has(id)) rows.set(id, row);
      if (!ranksOf.has(id)) ranksOf.set(id, []);
      ranksOf.get(id).push(i + 1);
    });
  }
  return [...scores.entries()]
    /* Ties broken by chunk id so the same inputs always produce the same
     * output — an eval whose ordering depends on Map insertion luck is not
     * reproducible. */
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([id, score]) => ({ ...rows.get(id), score, rrf: score, ranks: ranksOf.get(id) }));
}

/** Distinct source ids in result order — the unit the gold set scores against. */
export function sourcesInOrder(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (r.source_id == null || seen.has(r.source_id)) continue;
    seen.add(r.source_id);
    out.push(r.source_id);
  }
  return out;
}

/** Resolve which registered model to search against. */
export function resolveModel(db, modelSpec = null) {
  if (modelSpec) return getModel(db, modelSpec);
  /* No spec given: use whichever model actually has vectors, most recently
   * registered first. Guessing a name here would silently search an empty
   * space when a model was registered under a revision nobody remembers. */
  const row = db.prepare(`
    SELECT m.id FROM embedding_models m
    WHERE EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.model_id = m.id)
    ORDER BY m.id DESC LIMIT 1
  `).get();
  return row ? getModelById(db, row.id) : null;
}

/* How deep each arm retrieves before fusion. Fusing two lists of exactly
 * `limit` items throws away the evidence that makes fusion work — a document
 * ranked 9th by both retrievers deserves to beat one ranked 1st by one and
 * nowhere by the other, and it cannot if neither list is long enough to say
 * so. Deep enough to matter, bounded so an eval stays fast. */
export const POOL_FACTOR = 4;
export const POOL_MIN = 50;
const poolFor = (limit) => Math.max(POOL_MIN, limit * POOL_FACTOR);

/**
 * The one entry point `search` and `eval` both call.
 *
 * @param {object} [opts]
 * @param {"keyword"|"vector"|"hybrid"} [opts.mode="keyword"]
 * @param {(text:string)=>Promise<Float32Array>} [opts.embedQuery]
 *   encodes a query string. MUST NOT apply the model's query prefix — this
 *   function does that, from the registry row, so the convention lives with
 *   the model rather than with each caller.
 * @returns {Promise<{rows, match, mode, requestedMode, notice, model}>}
 *   `mode` is what actually ran; `notice` explains any downgrade.
 */
export async function search(db, query, {
  mode = "keyword",
  limit = 8,
  raw = false,
  bigrams = true,
  embedQuery = null,
  modelSpec = null,
  rrfK = 60,
  index = null,
} = {}) {
  if (!MODES.includes(mode)) throw new Error(`unknown search mode: ${mode} (expected ${MODES.join("|")})`);
  const requestedMode = mode;

  if (mode === "keyword") {
    return { ...keywordSearch(db, query, { limit, raw, bigrams }), mode, requestedMode, notice: null, model: null };
  }

  /* Everything below can fail for reasons that are NORMAL on a checkout that
   * only ever wanted keyword search. None of them may throw: the CLI must
   * stay usable for someone who never installed a 250MB runtime. */
  const downgrade = (notice) => ({
    ...keywordSearch(db, query, { limit, raw, bigrams }),
    mode: "keyword", requestedMode, notice, model: null,
  });

  const model = resolveModel(db, modelSpec);
  if (!model) return downgrade(`no embeddings in this corpus — run \`corpus embed\` first; using keyword search`);
  if (!embedQuery) return downgrade(`the embedding runtime is not available — using keyword search (install: cd tools/corpus/embed && npm install)`);

  let vec;
  try {
    vec = await embedQuery(`${model.query_prefix}${query}`);
  } catch (err) {
    return downgrade(`could not encode the query (${err.message.split("\n")[0]}) — using keyword search`);
  }

  const idx = index ?? loadMatrix(db, model.id);
  if (!idx.count) return downgrade(`model ${model.name} is registered but has no vectors — using keyword search`);

  if (mode === "vector") {
    return { ...vectorSearch(db, vec, { limit, index: idx }), mode, requestedMode, notice: null, model };
  }

  const pool = poolFor(limit);
  const kw = keywordSearch(db, query, { limit: pool, raw, bigrams });
  const vs = vectorSearch(db, vec, { limit: pool, index: idx });
  return {
    rows: rrfFuse([kw.rows, vs.rows], { k: rrfK, limit }),
    match: kw.match,
    mode: "hybrid",
    requestedMode,
    notice: null,
    model,
  };
}
