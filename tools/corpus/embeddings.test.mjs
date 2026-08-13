/* Vector serialization and the embedding store.
 *
 * Fixture-only: nothing here loads an embedding runtime or downloads a model.
 * That is deliberate and load-bearing — `tools/corpus/` advertises zero native
 * dependencies, and CI installs only `tools/corpus/package.json`. If any test
 * in this file ever needs onnxruntime, the isolation has been broken.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMigrated } from "./db.mjs";
import {
  l2Normalize, toBlob, fromBlob, readVectorInto, vectorLength, topK, dotAt, HOST_IS_LE,
} from "./vectors.mjs";
import {
  registerModel, getModel, getModelById, writeEmbeddings, clearEmbeddings,
  loadMatrix, embeddingCoverage, chunksMissingEmbedding, currentChunks, embeddingInput,
} from "./embeddings.mjs";
import { writeChunks } from "./ingest.mjs";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-embed-"));
  return { db: openMigrated(path.join(dir, "t.db"), { create: true }), dir };
}

const MODEL = {
  name: "test/model", revision: "v1", dim: 4, pooling: "cls",
  normalized: 1, quantization: "q8",
  query_prefix: "Q: ", passage_prefix: "",
};

function seedChunks(db, texts, { sourceId = 1, title = "Test Source" } = {}) {
  db.prepare(
    `INSERT INTO sources (id, area, area_name, title, url, source_type)
     VALUES (?, 4, 'Retrieval', ?, 'https://e.test/' || ?, 'blog')`
  ).run(sourceId, title, sourceId);
  const docId = db.prepare(
    `INSERT INTO documents (source_id, http_status, content_hash, raw_path, markdown_path)
     VALUES (?, 200, 'h', 'raw/x', 'markdown/x.md')`
  ).run(sourceId).lastInsertRowid;
  writeChunks(db, docId, texts.map((text, i) => ({
    ordinal: i, heading_path: "Head", text, token_count: 10,
  })));
  return docId;
}

/* --- serialization ------------------------------------------------------- */

test("a vector round-trips through the blob format unchanged", () => {
  const v = [0.5, -0.5, 0.5, -0.5]; // already unit length
  const back = fromBlob(toBlob(v));
  assert.equal(back.length, 4);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-6, `index ${i}`);
});

test("the blob is bare float32 with no header — length is byteLength/4", () => {
  const blob = toBlob([1, 0, 0, 0]);
  assert.equal(blob.byteLength, 16, "4 floats, no header bytes");
  assert.equal(vectorLength(blob), 4);
});

test("the blob is little-endian regardless of how it is read back", () => {
  // 1.0f is 00 00 80 3F little-endian, 3F 80 00 00 big-endian.
  const blob = toBlob([1, 0, 0, 0]);
  assert.deepEqual([...blob.slice(0, 4)], [0x00, 0x00, 0x80, 0x3f]);
});

test("a blob whose length is not a multiple of 4 is rejected, not truncated", () => {
  assert.throws(() => vectorLength(new Uint8Array(10)), /multiple of 4/);
});

test("writes are L2-normalized so similarity is a plain dot product", () => {
  const back = fromBlob(toBlob([3, 4, 0, 0]));
  assert.ok(Math.abs(back[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(back[1] - 0.8) < 1e-6);
  let norm = 0;
  for (const x of back) norm += x * x;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-6);
});

test("a zero vector throws instead of being stored as invisible-to-search", () => {
  assert.throws(() => l2Normalize(new Float32Array(4)), /zero vector/);
  assert.throws(() => toBlob([0, 0, 0, 0]), /zero vector/);
});

test("a NaN or Infinity in a vector throws at the write", () => {
  assert.throws(() => toBlob([1, NaN, 0, 0]), /non-finite/);
  assert.throws(() => toBlob([1, Infinity, 0, 0]), /non-finite/);
});

test("decoding survives an unaligned blob byteOffset", () => {
  /* The trap this whole module exists for: node:sqlite can hand back a
   * Uint8Array VIEW at an arbitrary offset, and
   * `new Float32Array(u8.buffer, u8.byteOffset, n)` throws on any offset that
   * is not a multiple of 4. Simulate one directly. */
  const source = toBlob([0.5, 0.5, 0.5, 0.5]);
  const padded = new Uint8Array(source.byteLength + 1);
  padded.set(source, 1);
  const unaligned = new Uint8Array(padded.buffer, 1, source.byteLength);
  assert.equal(unaligned.byteOffset % 4, 1, "the fixture must actually be misaligned");
  if (HOST_IS_LE) {
    assert.throws(() => new Float32Array(unaligned.buffer, unaligned.byteOffset, 4), /multiple of 4|offset/i);
  }
  const out = new Float32Array(4);
  readVectorInto(unaligned, out);
  for (const x of out) assert.ok(Math.abs(x - 0.5) < 1e-6);
});

test("readVectorInto refuses to write past the end of the matrix", () => {
  assert.throws(() => readVectorInto(toBlob([1, 0, 0, 0]), new Float32Array(4), 2), /does not fit/);
});

test("topK ranks by cosine similarity over a flat matrix", () => {
  const dim = 4;
  const rows = [[1, 0, 0, 0], [0.9, 0.1, 0, 0], [0, 1, 0, 0]].map((r) => fromBlob(toBlob(r)));
  const matrix = new Float32Array(rows.length * dim);
  rows.forEach((r, i) => matrix.set(r, i * dim));
  const q = fromBlob(toBlob([1, 0, 0, 0]));
  const ranked = topK(q, matrix, dim, 3);
  assert.deepEqual(ranked.map((r) => r.index), [0, 1, 2]);
  assert.ok(Math.abs(ranked[0].score - 1) < 1e-6);
  assert.ok(Math.abs(dotAt(q, matrix, 2, dim)) < 1e-6, "orthogonal rows score ~0");
});

/* --- the registry -------------------------------------------------------- */

test("registering a model is idempotent for the same identity", () => {
  const { db } = tmpDb();
  const a = registerModel(db, MODEL);
  const b = registerModel(db, MODEL);
  assert.equal(a.id, b.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM embedding_models").get().n, 1);
  db.close();
});

test("prefix asymmetry is stored as data, both sides, on the model row", () => {
  // Getting this backwards degrades every result and errors nowhere, so the
  // convention lives with the model rather than in whichever caller runs next.
  const { db } = tmpDb();
  const m = registerModel(db, MODEL);
  assert.equal(m.query_prefix, "Q: ");
  assert.equal(m.passage_prefix, "", "bge prefixes queries only — an empty passage prefix is the correct value, not a missing one");
  db.close();
});

test("re-registering the same identity with a different dim throws", () => {
  const { db } = tmpDb();
  registerModel(db, MODEL);
  assert.throws(() => registerModel(db, { ...MODEL, dim: 8 }), /different vector-space settings/);
  db.close();
});

test("changing the passage prefix throws — it changes what was encoded", () => {
  const { db } = tmpDb();
  registerModel(db, MODEL);
  assert.throws(() => registerModel(db, { ...MODEL, passage_prefix: "passage: " }), /passage_prefix/);
  db.close();
});

test("changing only the query prefix updates in place — no stored vector changes", () => {
  const { db } = tmpDb();
  const a = registerModel(db, MODEL);
  const b = registerModel(db, { ...MODEL, query_prefix: "Represent this: " });
  assert.equal(a.id, b.id);
  assert.equal(b.query_prefix, "Represent this: ");
  db.close();
});

test("a different quantization is a different model row, not an overwrite", () => {
  const { db } = tmpDb();
  const q8 = registerModel(db, MODEL);
  const fp32 = registerModel(db, { ...MODEL, quantization: "fp32" });
  assert.notEqual(q8.id, fp32.id);
  db.close();
});

/* --- the store ----------------------------------------------------------- */

test("a vector whose length disagrees with the model dim is rejected by the DB", () => {
  // The trigger is the last line of defence against a truncated write, so it
  // is tested against the DB itself, not against the JS that usually guards it.
  const { db } = tmpDb();
  const m = registerModel(db, MODEL);
  seedChunks(db, ["alpha text"]);
  const chunkId = db.prepare("SELECT id FROM chunks LIMIT 1").get().id;
  assert.throws(
    () => db.prepare("INSERT INTO chunk_embeddings (chunk_id, model_id, vector) VALUES (?,?,?)")
            .run(chunkId, m.id, new Uint8Array(12)),
    /byte length must be 4 \* the registered model dim/
  );
  db.close();
});

test("a vector for an unregistered model is rejected too", () => {
  const { db } = tmpDb();
  registerModel(db, MODEL);
  seedChunks(db, ["alpha text"]);
  const chunkId = db.prepare("SELECT id FROM chunks LIMIT 1").get().id;
  assert.throws(
    () => db.prepare("INSERT INTO chunk_embeddings (chunk_id, model_id, vector) VALUES (?,?,?)")
            .run(chunkId, 999, new Uint8Array(16)),
    /model dim|FOREIGN KEY/
  );
  db.close();
});

test("two models can hold vectors for the same chunk at once", () => {
  // The reason for the join table: one column could not do this at all.
  const { db } = tmpDb();
  const a = registerModel(db, MODEL);
  const b = registerModel(db, { ...MODEL, name: "test/other", dim: 8 });
  seedChunks(db, ["alpha text"]);
  const chunkId = db.prepare("SELECT id FROM chunks LIMIT 1").get().id;
  writeEmbeddings(db, a.id, [{ chunkId, vector: [1, 0, 0, 0] }]);
  writeEmbeddings(db, b.id, [{ chunkId, vector: [1, 0, 0, 0, 0, 0, 0, 0] }]);
  assert.equal(loadMatrix(db, a.id).dim, 4);
  assert.equal(loadMatrix(db, b.id).dim, 8);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM chunk_embeddings").get().n, 2);
  db.close();
});

test("re-writing a chunk's vector replaces it rather than failing or duplicating", () => {
  const { db } = tmpDb();
  const m = registerModel(db, MODEL);
  seedChunks(db, ["alpha text"]);
  const chunkId = db.prepare("SELECT id FROM chunks LIMIT 1").get().id;
  writeEmbeddings(db, m.id, [{ chunkId, vector: [1, 0, 0, 0] }]);
  writeEmbeddings(db, m.id, [{ chunkId, vector: [0, 1, 0, 0] }]);
  const { matrix, count } = loadMatrix(db, m.id);
  assert.equal(count, 1);
  assert.ok(Math.abs(matrix[1] - 1) < 1e-6, "the second write won");
  db.close();
});

test("deleting a chunk cascade-deletes its vectors", () => {
  const { db } = tmpDb();
  const m = registerModel(db, MODEL);
  seedChunks(db, ["alpha text", "beta text"]);
  const ids = db.prepare("SELECT id FROM chunks ORDER BY id").all().map((r) => r.id);
  writeEmbeddings(db, m.id, ids.map((chunkId) => ({ chunkId, vector: [1, 0, 0, 0] })));
  db.prepare("DELETE FROM chunks WHERE id = ?").run(ids[0]);
  assert.equal(embeddingCoverage(db, m.id).embedded, 1, "the orphaned vector must be gone");
  db.close();
});

test("loadMatrix returns one flat matrix with chunk ids in the same order", () => {
  const { db } = tmpDb();
  const m = registerModel(db, MODEL);
  seedChunks(db, ["alpha", "beta", "gamma"]);
  const ids = db.prepare("SELECT id FROM chunks ORDER BY id").all().map((r) => r.id);
  writeEmbeddings(db, m.id, [
    { chunkId: ids[0], vector: [1, 0, 0, 0] },
    { chunkId: ids[1], vector: [0, 1, 0, 0] },
    { chunkId: ids[2], vector: [0, 0, 1, 0] },
  ]);
  const { chunkIds, matrix, dim, count } = loadMatrix(db, m.id);
  assert.equal(count, 3);
  assert.equal(matrix.length, 3 * dim);
  assert.deepEqual([...chunkIds], ids);
  const best = topK(fromBlob(toBlob([0, 1, 0, 0])), matrix, dim, 1)[0];
  assert.equal(chunkIds[best.index], ids[1]);
  db.close();
});

test("coverage reports what is missing, and the work list matches it", () => {
  const { db } = tmpDb();
  const m = registerModel(db, MODEL);
  seedChunks(db, ["alpha", "beta", "gamma"]);
  const ids = db.prepare("SELECT id FROM chunks ORDER BY id").all().map((r) => r.id);
  writeEmbeddings(db, m.id, [{ chunkId: ids[0], vector: [1, 0, 0, 0] }]);
  assert.deepEqual(embeddingCoverage(db, m.id), { chunks: 3, embedded: 1, missing: 2 });
  assert.deepEqual(chunksMissingEmbedding(db, m.id).map((c) => c.id), [ids[1], ids[2]]);
  db.close();
});

test("clearEmbeddings removes one model's vectors and leaves the other's", () => {
  const { db } = tmpDb();
  const a = registerModel(db, MODEL);
  const b = registerModel(db, { ...MODEL, revision: "v2" });
  seedChunks(db, ["alpha"]);
  const chunkId = db.prepare("SELECT id FROM chunks LIMIT 1").get().id;
  writeEmbeddings(db, a.id, [{ chunkId, vector: [1, 0, 0, 0] }]);
  writeEmbeddings(db, b.id, [{ chunkId, vector: [1, 0, 0, 0] }]);
  assert.equal(clearEmbeddings(db, a.id), 1);
  assert.equal(embeddingCoverage(db, a.id).embedded, 0);
  assert.equal(embeddingCoverage(db, b.id).embedded, 1);
  db.close();
});

/* --- what gets encoded --------------------------------------------------- */

test("the encoded text carries source title and heading path, and chunk.text does not change", () => {
  const input = embeddingInput({ title: "AES TD1004", heading_path: "Loudness > Targets", text: "-16 LUFS." });
  assert.equal(input, "AES TD1004 — Loudness > Targets\n\n-16 LUFS.");
  const stored = { title: "AES TD1004", heading_path: "Loudness > Targets", text: "-16 LUFS." };
  embeddingInput(stored);
  assert.equal(stored.text, "-16 LUFS.", "the chunk's stored text must never be rewritten by the encoder");
});

test("a passage prefix, when a model needs one, goes in front of everything", () => {
  assert.equal(embeddingInput({ title: "T", heading_path: "", text: "body" }, "passage: "), "passage: T\n\nbody");
});

test("a chunk with no heading path still gets its title", () => {
  assert.equal(embeddingInput({ title: "T", heading_path: "", text: "body" }), "T\n\nbody");
});

test("currentChunks joins each chunk to its source title", () => {
  const { db } = tmpDb();
  seedChunks(db, ["alpha", "beta"], { title: "A Real Title" });
  const rows = currentChunks(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "A Real Title");
  assert.equal(rows[0].heading_path, "Head");
  db.close();
});

/* --- the schema itself --------------------------------------------------- */

test("the schema no longer carries the ambiguous chunks.embedding column", () => {
  // 0001 reserved one BLOB column for "the" model. Leaving it in place beside
  // chunk_embeddings would be an invitation to write to the wrong one.
  const { db } = tmpDb();
  const cols = db.prepare("PRAGMA table_info(chunks)").all().map((c) => c.name);
  assert.ok(!cols.includes("embedding"), `chunks still has an embedding column: ${cols.join(",")}`);
  assert.ok(cols.includes("text") && cols.includes("heading_path"), "the rest of chunks survived the drop");
  db.close();
});

test("dropping chunks.embedding left the FTS index working", () => {
  const { db } = tmpDb();
  seedChunks(db, ["reciprocal rank fusion combines ranked lists"]);
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
  const n = db.prepare("SELECT COUNT(*) n FROM chunks_fts WHERE chunks_fts MATCH 'fusion'").get().n;
  assert.equal(n, 1);
  db.close();
});

test("getModel finds by identity and getModelById round-trips", () => {
  const { db } = tmpDb();
  const m = registerModel(db, MODEL);
  assert.equal(getModel(db, MODEL).id, m.id);
  assert.equal(getModelById(db, m.id).name, MODEL.name);
  assert.equal(getModel(db, { ...MODEL, revision: "nope" }), null);
  db.close();
});

test("loadMatrix rejects a model id that was never registered", () => {
  const { db } = tmpDb();
  assert.throws(() => loadMatrix(db, 42), /no embedding model with id 42/);
  db.close();
});
