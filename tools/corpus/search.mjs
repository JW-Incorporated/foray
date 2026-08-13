/* Retrieval over the corpus. Today: FTS5/bm25 keyword search only.
 *
 * This module exists so that `corpus search` and `corpus eval` run the exact
 * same code path — an eval that measures a different retriever than the one
 * users get is worse than no eval. The vector and hybrid modes land in a
 * later pass; the `mode` parameter is here now so the eval harness and its
 * committed before-numbers do not have to change shape when they do.
 */

import { buildFtsQuery } from "./ftsquery.mjs";

const SQL = `
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
  return { rows: db.prepare(SQL).all(match, limit), match };
}

/** Distinct source ids in result order — the unit the gold set scores against. */
export function sourcesInOrder(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.source_id)) continue;
    seen.add(r.source_id);
    out.push(r.source_id);
  }
  return out;
}
