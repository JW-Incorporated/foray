-- Corpus schema v1. SQLite today, written to lift to Postgres+pgvector later:
-- plain INTEGER/TEXT/BLOB types, no SQLite-only column tricks outside the FTS
-- migration (0002), timestamps as ISO-8601 TEXT.

CREATE TABLE sources (
  id             INTEGER PRIMARY KEY,
  area           INTEGER NOT NULL CHECK (area BETWEEN 1 AND 9),
  area_name      TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  url            TEXT    NOT NULL UNIQUE,
  source_type    TEXT    NOT NULL CHECK (source_type IN
                   ('paper','blog','docs','standard','repo','issue',
                    'court-opinion','forum','reference')),
  why_it_matters TEXT    NOT NULL DEFAULT '',
  read_first     INTEGER NOT NULL DEFAULT 0 CHECK (read_first IN (0,1)),
  added_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Append-only fetch history. Every attempt (success or failure) is a row;
-- the "current" document for a source is the newest row with an http 2xx
-- status and a markdown_path. Chunks exist only for the current document
-- (ingest deletes superseded chunks), so history stays queryable without
-- polluting search.
CREATE TABLE documents (
  id            INTEGER PRIMARY KEY,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  fetched_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  http_status   INTEGER NOT NULL,
  content_hash  TEXT,             -- sha256 hex of raw bytes; NULL on failure
  raw_path      TEXT,             -- relative to data-local/corpus/
  markdown_path TEXT,             -- relative to data-local/corpus/
  token_count   INTEGER NOT NULL DEFAULT 0,
  fetch_notes   TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX idx_documents_source ON documents(source_id, fetched_at DESC);

CREATE TABLE chunks (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  heading_path TEXT    NOT NULL DEFAULT '',
  text         TEXT    NOT NULL,
  token_count  INTEGER NOT NULL,
  embedding    BLOB,              -- NULL until the embedding backfill pass
  UNIQUE (document_id, ordinal)
);

CREATE INDEX idx_chunks_document ON chunks(document_id);
