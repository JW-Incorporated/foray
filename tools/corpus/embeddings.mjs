/* The embedding store: model registry + chunk vectors, with no dependency on
 * any embedding runtime. Everything here works on a checkout that has never
 * installed onnxruntime — which is what lets the whole corpus test suite, and
 * `search --mode keyword`, stay light.
 *
 * Schema and rationale: migrations/0003_embeddings.sql.
 */

import { toBlob, readVectorInto, vectorLength } from "./vectors.mjs";

/* Fields that DEFINE the vector space. If any of these changes, every vector
 * already stored under that model id becomes meaningless — not worse, but
 * incomparable. `passage_prefix` belongs here because it is literally part of
 * the text that was encoded. `query_prefix` does not: it changes how future
 * QUERIES are encoded, never what is already on disk. */
const SPACE_DEFINING = ["dim", "pooling", "normalized", "quantization", "passage_prefix"];

/* The identity of a registry row. Two loads of the same repo at the same
 * revision with the same quantization are the same model; a different
 * quantization is a different vector space and gets its own row and its own
 * backfill. */
const IDENTITY = ["name", "revision", "quantization"];

function normalizeSpec(spec) {
  const out = {
    name: String(spec.name),
    revision: String(spec.revision ?? "main"),
    dim: Number(spec.dim),
    pooling: String(spec.pooling),
    normalized: spec.normalized === false || spec.normalized === 0 ? 0 : 1,
    quantization: String(spec.quantization ?? ""),
    query_prefix: String(spec.query_prefix ?? ""),
    passage_prefix: String(spec.passage_prefix ?? ""),
  };
  if (!Number.isInteger(out.dim) || out.dim <= 0) throw new Error(`model dim must be a positive integer, got ${spec.dim}`);
  return out;
}

/** Look a model up by its identity triple. */
export function getModel(db, spec) {
  const s = normalizeSpec({ dim: 1, pooling: "cls", ...spec });
  return db.prepare(
    `SELECT * FROM embedding_models WHERE name = ? AND revision = ? AND quantization = ?`
  ).get(s.name, s.revision, s.quantization) ?? null;
}

export function getModelById(db, id) {
  return db.prepare(`SELECT * FROM embedding_models WHERE id = ?`).get(id) ?? null;
}

/**
 * Register a model, or return the existing row for the same identity.
 *
 * The strictness here is the point. If a caller re-registers the SAME
 * name/revision/quantization with a different dimension, pooling or passage
 * prefix, that is not an update — it is a claim that the vectors already in
 * `chunk_embeddings` mean something they do not. Rather than rewrite the row
 * (silently poisoning every stored vector) or ignore the difference (silently
 * embedding queries under a different convention than the passages), this
 * throws and tells the caller to bump `revision` — which gives the new space
 * its own id, its own backfill, and leaves the old vectors intact and
 * queryable.
 *
 * Cosmetic drift is allowed: `query_prefix` may be updated in place, because
 * it affects only how future queries are encoded, never what is on disk.
 */
export function registerModel(db, spec) {
  const s = normalizeSpec(spec);
  const existing = getModel(db, s);
  if (!existing) {
    const id = db.prepare(
      `INSERT INTO embedding_models (name, revision, dim, pooling, normalized, quantization, query_prefix, passage_prefix)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(s.name, s.revision, s.dim, s.pooling, s.normalized, s.quantization, s.query_prefix, s.passage_prefix).lastInsertRowid;
    return getModelById(db, Number(id));
  }
  const changed = SPACE_DEFINING.filter((k) => String(existing[k]) !== String(s[k]));
  if (changed.length) {
    throw new Error(
      `model ${s.name}@${s.revision} (${s.quantization || "unquantized"}) is already registered as id ${existing.id} ` +
      `with different vector-space settings: ${changed.map((k) => `${k} ${JSON.stringify(existing[k])} -> ${JSON.stringify(s[k])}`).join(", ")}. ` +
      `Every stored vector was produced under the old settings. Register the new configuration under a different revision ` +
      `instead of redefining this one.`
    );
  }
  if (existing.query_prefix !== s.query_prefix) {
    db.prepare(`UPDATE embedding_models SET query_prefix = ? WHERE id = ?`).run(s.query_prefix, existing.id);
    return getModelById(db, existing.id);
  }
  return existing;
}

/**
 * The exact text handed to the encoder for a chunk.
 *
 * A chunk's own text often does not say what document it came from — a
 * paragraph reading "the offset drifts by up to 30 seconds" is unattributable
 * on its own, and its vector lands nowhere near a query naming the standard
 * it belongs to. Prepending the source title and heading path gives every
 * vector that context. `chunks.text` is stored UNCHANGED: this is what gets
 * ENCODED, never what gets displayed, quoted or re-chunked.
 */
export function embeddingInput({ title, heading_path: headingPath, text }, passagePrefix = "") {
  const head = [title, headingPath].filter((s) => s && String(s).trim()).join(" — ");
  return `${passagePrefix}${head ? `${head}\n\n` : ""}${text}`;
}

/** Chunks of the CURRENT documents, with the source title, in id order. */
export function currentChunks(db) {
  return db.prepare(`
    SELECT c.id, c.heading_path, c.text, c.token_count, s.title, s.id AS source_id
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN sources   s ON s.id = d.source_id
    ORDER BY c.id
  `).all();
}

/** Chunks with no vector yet under `modelId` — the backfill's work list. */
export function chunksMissingEmbedding(db, modelId) {
  return db.prepare(`
    SELECT c.id, c.heading_path, c.text, c.token_count, s.title, s.id AS source_id
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN sources   s ON s.id = d.source_id
    WHERE NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.model_id = ?)
    ORDER BY c.id
  `).all(modelId);
}

export function embeddingCoverage(db, modelId) {
  const chunks = db.prepare(`SELECT COUNT(*) n FROM chunks`).get().n;
  const embedded = db.prepare(
    `SELECT COUNT(*) n FROM chunk_embeddings WHERE model_id = ?`
  ).get(modelId).n;
  return { chunks, embedded, missing: chunks - embedded };
}

/**
 * Write vectors for one model in a single transaction.
 * `entries` is `[{chunkId, vector}]` where `vector` is any array-like of
 * numbers; normalization happens here, at the write, exactly once.
 */
export function writeEmbeddings(db, modelId, entries) {
  const ins = db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model_id, vector) VALUES (?, ?, ?)
     ON CONFLICT (chunk_id, model_id) DO UPDATE SET vector = excluded.vector, created_at = excluded.created_at`
  );
  db.exec("BEGIN");
  try {
    for (const e of entries) ins.run(e.chunkId, modelId, toBlob(e.vector));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return entries.length;
}

/** Drop every vector for one model (the deliberate "clear before re-chunk"). */
export function clearEmbeddings(db, modelId) {
  return db.prepare(`DELETE FROM chunk_embeddings WHERE model_id = ?`).run(modelId).changes;
}

/**
 * Load every vector for `modelId` into ONE pre-allocated flat Float32Array.
 *
 * One allocation, not N: the scan in `topK` is then a straight walk over
 * contiguous memory, and — the part that actually bites — decoding row by row
 * into a shared buffer is the only way to sidestep the byteOffset alignment
 * trap described in vectors.mjs without a per-row copy.
 *
 * @returns {{chunkIds:Int32Array, matrix:Float32Array, dim:number, count:number}}
 */
export function loadMatrix(db, modelId) {
  const model = getModelById(db, modelId);
  if (!model) throw new Error(`no embedding model with id ${modelId}`);
  const rows = db.prepare(
    `SELECT chunk_id, vector FROM chunk_embeddings WHERE model_id = ? ORDER BY chunk_id`
  ).all(modelId);

  const dim = model.dim;
  const matrix = new Float32Array(rows.length * dim);
  const chunkIds = new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const n = vectorLength(rows[i].vector);
    /* The trigger already guarantees this at write time. Re-checking at read
     * time costs nothing and covers the one case the trigger cannot: a DB
     * whose rows were written before the trigger existed, or by hand. */
    if (n !== dim) {
      throw new Error(`chunk ${rows[i].chunk_id} has a ${n}-dim vector but model ${modelId} declares ${dim}`);
    }
    chunkIds[i] = rows[i].chunk_id;
    readVectorInto(rows[i].vector, matrix, i * dim);
  }
  return { chunkIds, matrix, dim, count: rows.length };
}
