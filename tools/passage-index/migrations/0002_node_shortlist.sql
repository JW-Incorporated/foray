-- GV-48 (W3-09, docs/roadmap/generation-v2.md): the per-taxonomy-node
-- shortlist.
--
-- Each night the retrieval server's POST /v1/shortlist/rebuild runs one hybrid
-- passage search per data/taxonomy.json node (query = the node's label, its
-- children's labels and the terms of the semantic-index concepts the label
-- matches; scope = the episodes the lineage gate admits for the node) and
-- keeps the best 50 passages here, so request-time retrieval for a topic is a
-- lookup plus a rerank (GET /v1/shortlist). A node's rows are replaced whole,
-- in one transaction, so a reader never sees half of two builds.
--
-- Deleting a passage (an episode re-ingested with a new cut) deletes its rows
-- through the cascade: a shortlist never names a passage the store no longer
-- holds. It shrinks until the next rebuild instead, which is the nightly's
-- last step. The shortlist is a day stale by design.

CREATE TABLE node_shortlist (
  node_id    TEXT    NOT NULL,                 -- a data/taxonomy.json node id
  rank       INTEGER NOT NULL CHECK (rank >= 0 AND rank < 50),  -- 0-based; at most 50 rows per node
  passage_id TEXT    NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
  score      REAL    NOT NULL,                 -- the build's fused (RRF) score
  built_at   TEXT    NOT NULL,                 -- ISO time of the build that wrote the row
  PRIMARY KEY (node_id, rank),
  UNIQUE (node_id, passage_id)
);

-- The cascade looks rows up by passage.
CREATE INDEX idx_node_shortlist_passage ON node_shortlist(passage_id);
