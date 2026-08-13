-- Embedding storage: a model REGISTRY plus a chunk×model join table.
--
-- WHY NOT `chunks.embedding` (which this migration drops).
-- 0001 reserved a single `chunks.embedding BLOB` for a future backfill. That
-- column cannot survive contact with a second model. Under the Postgres+
-- pgvector lift this schema is written for, a vector column's DIMENSION lives
-- in the column type (`vector(384)`), so one column physically cannot hold a
-- 384-dim and a 768-dim model at once; you would be adding a column per model
-- and teaching every reader which one is live. The join table is the shape
-- that survives a model swap: adding a model is one row in
-- `embedding_models` plus N rows here, and the old vectors stay queryable
-- while the new ones backfill.
--
-- WHY THE CASCADE MATTERS MORE THAN IT LOOKS. `chunks` is rewritten wholesale
-- by `corpus rechunk`. Vectors keyed to chunk ids that no longer exist are the
-- classic stale-index bug: search returns text that was never embedded, or
-- misses text that was. ON DELETE CASCADE makes that structurally impossible
-- instead of merely remembered — a re-chunk deletes its vectors, and the
-- backfill's own coverage count then reports the corpus as unembedded, which
-- is the truth.

CREATE TABLE embedding_models (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL,          -- e.g. 'Xenova/bge-small-en-v1.5'
  revision       TEXT    NOT NULL,          -- repo revision/tag actually loaded
  dim            INTEGER NOT NULL CHECK (dim > 0),
  pooling        TEXT    NOT NULL CHECK (pooling IN ('cls','mean','max')),
  normalized     INTEGER NOT NULL DEFAULT 1 CHECK (normalized IN (0,1)),
  quantization   TEXT    NOT NULL DEFAULT '',  -- 'q8', 'fp32', …

  -- ASYMMETRIC PREFIXES ARE DATA, NOT CALLER CODE. BGE-family models are
  -- trained so that QUERIES carry an instruction prefix and PASSAGES carry
  -- none. Getting that backwards (or applying one prefix to both sides)
  -- degrades every single result and does so SILENTLY — nothing errors, the
  -- numbers just get quietly worse. Storing both strings with the model means
  -- the retriever reads the convention off the row it is already loading, so
  -- a future model with the opposite convention (E5 prefixes both sides;
  -- GTE prefixes neither) is a registry row, not a code change nobody
  -- remembers to make.
  query_prefix   TEXT    NOT NULL DEFAULT '',
  passage_prefix TEXT    NOT NULL DEFAULT '',

  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (name, revision, quantization)
);

-- Composite PK (chunk_id, model_id) enforces one vector per chunk per model
-- and backs the cascade from `chunks`. It is chunk-major, so it canNOT serve
-- "every vector for model M" — that is what the separate index below is for,
-- and it is the access pattern the whole retrieval path uses.
--
-- `written_at`, not `created_at`: a re-backfill upserts the row in place, so
-- this is the time the CURRENT bytes were written, not the time the pairing
-- first existed. Naming it `created_at` would have made a re-embed look like
-- a fresh insert.
CREATE TABLE chunk_embeddings (
  chunk_id   INTEGER NOT NULL REFERENCES chunks(id)           ON DELETE CASCADE,
  model_id   INTEGER NOT NULL REFERENCES embedding_models(id) ON DELETE CASCADE,
  -- typeof() as well as length(): a TEXT value of exactly 4*dim characters
  -- would otherwise satisfy the length trigger and then fail confusingly at
  -- read time. Only reachable from hand-written SQL, and free to close.
  vector     BLOB    NOT NULL CHECK (typeof(vector) = 'blob'),
  written_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (chunk_id, model_id)
);

CREATE INDEX idx_chunk_embeddings_model ON chunk_embeddings(model_id, chunk_id);

-- The vector's length is not declared anywhere in the BLOB itself (that is
-- deliberate — see vectors.mjs), so the ONLY thing standing between a
-- truncated write and a corpus of silently-wrong similarities is this check.
-- `IS NOT` rather than `!=` so that an unregistered model_id (subquery NULL)
-- also aborts instead of comparing NULL and passing.
CREATE TRIGGER chunk_embeddings_dim_ai BEFORE INSERT ON chunk_embeddings BEGIN
  SELECT RAISE(ABORT, 'chunk_embeddings.vector byte length must be 4 * the registered model dim')
  WHERE length(new.vector) IS NOT 4 * (SELECT dim FROM embedding_models WHERE id = new.model_id);
END;

CREATE TRIGGER chunk_embeddings_dim_au BEFORE UPDATE ON chunk_embeddings BEGIN
  SELECT RAISE(ABORT, 'chunk_embeddings.vector byte length must be 4 * the registered model dim')
  WHERE length(new.vector) IS NOT 4 * (SELECT dim FROM embedding_models WHERE id = new.model_id);
END;

-- The now-ambiguous reservation from 0001. Dropped rather than left NULL:
-- a column named `embedding` sitting beside the real table is an invitation
-- to write to the wrong one. Verified to be safe with the FTS5
-- external-content triggers, which reference only id/text/heading_path.
ALTER TABLE chunks DROP COLUMN embedding;
