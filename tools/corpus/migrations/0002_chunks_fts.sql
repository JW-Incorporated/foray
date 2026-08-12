-- FTS5 keyword index over chunks. External-content table: the text lives in
-- chunks; this stores only the index. Triggers keep it in sync, including the
-- delete-then-reinsert dance FTS5 requires for external content.
--
-- This migration is the one deliberately SQLite-only piece of the schema; on
-- the Postgres lift it is replaced wholesale by a tsvector column + GIN index
-- (and the pgvector column takes over semantic search).

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  heading_path,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Unconditional correctness for pre-populated DBs (restored dumps, future
-- migration re-splits): index whatever chunks already exist. A no-op on the
-- normal fresh-DB path.
INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading_path)
  VALUES (new.id, new.text, new.heading_path);
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading_path)
  VALUES ('delete', old.id, old.text, old.heading_path);
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading_path)
  VALUES ('delete', old.id, old.text, old.heading_path);
  INSERT INTO chunks_fts(rowid, text, heading_path)
  VALUES (new.id, new.text, new.heading_path);
END;
