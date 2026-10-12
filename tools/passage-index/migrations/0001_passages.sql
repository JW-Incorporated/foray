-- GV-28 (W3-07, docs/roadmap/generation-v2.md): the passage store.
--
-- Passages come from the backend passage cutter (GV-12,
-- backend/src/generation/passageCutter.ts) through indexBodies --passages-out,
-- one JSON line per passage. Dense vectors are kept per SUB-CHUNK, not per
-- passage: a 90-180 s passage is roughly 340-680 bge tokens, over bge's
-- 512-token limit, and tools/corpus measured truncation making hybrid search
-- worse (tools/corpus/README.md, 'Semantic search'). So a passage owns one or
-- more vectors, and a dense search scores it by its best chunk.
--
-- The layout follows tools/corpus/migrations/0003_embeddings.sql: a model
-- registry, a join table keyed to the model, bare little-endian float32 blobs
-- (tools/corpus/vectors.mjs, the sqlite-vec convention) and a trigger that
-- checks each blob against the registered dimension.

CREATE TABLE passages (
  id             TEXT    PRIMARY KEY,       -- first 16 hex of sha1(show_id|guid|startSec|endSec)
  show_id        TEXT    NOT NULL,
  guid           TEXT    NOT NULL,          -- the ARCHIVE row's guid, not the body's own
  start_sec      REAL    NOT NULL,
  end_sec        REAL    NOT NULL,
  start_boundary TEXT    NOT NULL,          -- 'turn' | 'sentence' | 'cue', kept apart from the end edge
  end_boundary   TEXT    NOT NULL,
  start_anchor   TEXT,                      -- null when the passage yields no quotable phrase
  end_anchor     TEXT,
  text           TEXT    NOT NULL,
  index_version  INTEGER NOT NULL           -- PASSAGE_INDEX_VERSION of the cut
);

-- Ingest replaces an episode's passages whole, and a dense search filters by
-- episode: both look passages up by (show_id, guid).
CREATE INDEX idx_passages_episode ON passages(show_id, guid);

-- Prefixes are data, not caller code: the store reads query_prefix and
-- passage_prefix off this row and no embedder adds one of its own.
CREATE TABLE embedding_models (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL,
  revision       TEXT    NOT NULL,
  dim            INTEGER NOT NULL CHECK (dim > 0),
  pooling        TEXT    NOT NULL,
  normalized     INTEGER NOT NULL DEFAULT 1 CHECK (normalized IN (0,1)),
  query_prefix   TEXT    NOT NULL DEFAULT '',
  passage_prefix TEXT    NOT NULL DEFAULT '',
  UNIQUE (name, revision)
);

-- One vector per (passage, model, sub-chunk). The cascade from passages is
-- what keeps a re-ingest from leaving stale vectors behind: replacing an
-- episode deletes its passages, and with them every chunk vector.
CREATE TABLE passage_chunks (
  passage_id TEXT    NOT NULL REFERENCES passages(id)         ON DELETE CASCADE,
  ord        INTEGER NOT NULL CHECK (ord >= 0),
  model_id   INTEGER NOT NULL REFERENCES embedding_models(id) ON DELETE CASCADE,
  vector     BLOB    NOT NULL CHECK (typeof(vector) = 'blob'),
  PRIMARY KEY (passage_id, model_id, ord)
);

-- The dense index loads every vector of one model: model-major.
CREATE INDEX idx_passage_chunks_model ON passage_chunks(model_id, passage_id, ord);

-- length(vector) = 4 * dim. `IS NOT` so that an unregistered model_id (the
-- subquery is NULL) aborts too instead of comparing NULL and passing.
CREATE TRIGGER passage_chunks_dim_ai BEFORE INSERT ON passage_chunks BEGIN
  SELECT RAISE(ABORT, 'passage_chunks.vector byte length must be 4 * the registered model dim')
  WHERE length(new.vector) IS NOT 4 * (SELECT dim FROM embedding_models WHERE id = new.model_id);
END;

CREATE TRIGGER passage_chunks_dim_au BEFORE UPDATE ON passage_chunks BEGIN
  SELECT RAISE(ABORT, 'passage_chunks.vector byte length must be 4 * the registered model dim')
  WHERE length(new.vector) IS NOT 4 * (SELECT dim FROM embedding_models WHERE id = new.model_id);
END;
