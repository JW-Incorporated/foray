#!/usr/bin/env node
/* tools/shows/search-shows.mjs — S-09: FTS + trgm ranking over
   `shows_catalog` (migration 0017), as a pure query-building module so it
   is unit-testable against a real Postgres (see search-shows.test.mjs's
   golden-query set) without any web/API framework glue. The API layer
   (a future card) is the caller; this module owns exactly the SQL and the
   ranking formula.

   RANKING. Two signals, blended rather than either alone:
     - `ts_rank_cd(search_tsv, query)` — lexical relevance against the
       generated tsvector (title weight A, author weight B; see 0017's
       comment on why those two fields and that split).
     - `similarity(title, :query)` (pg_trgm) — typo/fuzzy tolerance FTS
       alone does not give (a user typing "joe rogen" should still find
       "Joe Rogan").
   `curated` shows get a small additive boost (never enough to outrank a
   dramatically better lexical match) — same principle as
   shard-build.mjs's top.json ("curated is never displaced"), applied to
   search ranking instead of the size-budget list.

   Falls back to trigram-only when the FTS query has no matching lexemes at
   all (a single very-short or all-stopword query) rather than returning
   zero rows — see `searchShows`'s two-pass strategy. */

const CURATED_BOOST = 0.15;
const TRGM_MIN_SIMILARITY = 0.15; // pg_trgm's own set_limit default is 0.3; loosened for a "did you mean" tolerant search UX, not an index scan

export const SELECT_COLUMNS = `
  pi_id, title, author, itunes_id, feed_url, image_url, episode_count,
  popularity_score, curated, language, dead
`;

/** Builds the parameterised FTS-ranked query. `websearch_to_tsquery` is
    used over `plainto_tsquery` — it tolerates quoted phrases and bare `-`
    exclusions from a real search box without the caller having to
    preprocess the string, and degrades to plain AND-of-terms for anything
    that isn't using that syntax (Postgres's own documented behavior). */
export function buildFtsQuery({ query, limit = 20, includeDead = false }) {
  const clauses = ["search_tsv @@ websearch_to_tsquery('english', $1)"];
  if (!includeDead) clauses.push("dead = false");
  return {
    text: `
      select ${SELECT_COLUMNS},
        ts_rank_cd(search_tsv, websearch_to_tsquery('english', $1))
          + (case when curated then ${CURATED_BOOST} else 0 end) as rank
      from shows_catalog
      where ${clauses.join(" and ")}
      order by rank desc, popularity_score desc nulls last, pi_id asc
      limit $2
    `,
    values: [query, limit],
  };
}

/** Trigram-similarity fallback: fires when the FTS pass returns nothing
    (see `searchShows`) — most often a query too short/sparse for
    `websearch_to_tsquery` to extract any lexeme from, or a genuine typo
    FTS's exact-lexeme matching can't bridge on its own. */
export function buildTrgmQuery({ query, limit = 20, includeDead = false, minSimilarity = TRGM_MIN_SIMILARITY }) {
  const clauses = ["similarity(title, $1) > $3"];
  if (!includeDead) clauses.push("dead = false");
  return {
    text: `
      select ${SELECT_COLUMNS},
        similarity(title, $1) + (case when curated then ${CURATED_BOOST} else 0 end) as rank
      from shows_catalog
      where ${clauses.join(" and ")}
      order by rank desc, popularity_score desc nulls last, pi_id asc
      limit $2
    `,
    values: [query, limit, minSimilarity],
  };
}

/** Runs the two-pass strategy against a live `pg` client (or anything
    exposing an async `.query({text, values})` — the same shape every
    caller in this repo already uses, e.g. showEpisodesStore.ts). Returns
    `{ rows, strategy }` so a caller/test can see which pass answered. */
export async function searchShows(client, { query, limit = 20, includeDead = false } = {}) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return { rows: [], strategy: "empty_query" };

  const ftsResult = await client.query(buildFtsQuery({ query: trimmed, limit, includeDead }));
  if (ftsResult.rows.length > 0) return { rows: ftsResult.rows, strategy: "fts" };

  const trgmResult = await client.query(buildTrgmQuery({ query: trimmed, limit, includeDead }));
  return { rows: trgmResult.rows, strategy: "trgm_fallback" };
}
