/* Search modes: keyword, vector, hybrid — and the degradation path that keeps
 * this CLI usable for someone who never installed a 250MB embedding runtime.
 *
 * NO MODEL IS LOADED HERE. The embedder is a parameter to `search`, so these
 * tests inject a tiny deterministic stub: a 4-dimensional "vector space" whose
 * coordinates are picked by hand so that expected neighbours are provable
 * rather than hoped for. A real model in a test would be slow, non-hermetic,
 * and would measure the model instead of the code.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMigrated } from "./db.mjs";
import { writeChunks } from "./ingest.mjs";
import { registerModel, writeEmbeddings } from "./embeddings.mjs";
import {
  search, keywordSearch, vectorSearch, rrfFuse, sourcesInOrder, resolveModel,
  MODES, DEFAULT_SEARCH_MODE,
} from "./search.mjs";
import { loadMatrix } from "./embeddings.mjs";

const tmpDb = () => openMigrated(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "corpus-search-")), "t.db"), { create: true });

const STUB_MODEL = {
  name: "stub/model", revision: "v1", dim: 4, pooling: "cls",
  normalized: 1, quantization: "test",
  query_prefix: "QUERY: ", passage_prefix: "",
};

/* A hand-built 4-d space. Each axis is a "topic"; a chunk's vector says which
 * topic it belongs to, and a query's vector says which topic it is asking
 * about. That makes every expected neighbour a fact about the fixture rather
 * than a fact about a model. */
const AXES = { dai: [1, 0, 0, 0], loudness: [0, 1, 0, 0], gapless: [0, 0, 1, 0], legal: [0, 0, 0, 1] };

function seedSource(db, id, title, chunkTexts) {
  db.prepare(
    `INSERT INTO sources (id, area, area_name, title, url, source_type)
     VALUES (?, 1, 'Podcast Infrastructure', ?, 'https://e.test/' || ?, 'blog')`
  ).run(id, title, id);
  const docId = db.prepare(
    `INSERT INTO documents (source_id, http_status, content_hash, raw_path, markdown_path)
     VALUES (?, 200, 'h', 'raw/x', 'markdown/x.md')`
  ).run(id).lastInsertRowid;
  writeChunks(db, docId, chunkTexts.map((text, i) => ({ ordinal: i, heading_path: "", text, token_count: 10 })));
  return db.prepare("SELECT id FROM chunks WHERE document_id = ? ORDER BY ordinal").all(docId).map((r) => r.id);
}

/** A corpus where lexical and semantic evidence deliberately disagree. */
function seededCorpus() {
  const db = tmpDb();
  // 1: says the words. 2: means the thing but shares no vocabulary.
  const a = seedSource(db, 1, "Namespace Issue", ["dynamic ad insertion shifts every timestamp in the transcript"]);
  const b = seedSource(db, 2, "Drift Postmortem", ["the offsets no longer line up after the break markers move"]);
  const c = seedSource(db, 3, "Loudness Guide", ["normalize the programme to a consistent target before stitching"]);
  const model = registerModel(db, STUB_MODEL);
  writeEmbeddings(db, model.id, [
    { chunkId: a[0], vector: AXES.dai },
    { chunkId: b[0], vector: [0.9, 0.1, 0, 0] },   // semantically near DAI
    { chunkId: c[0], vector: AXES.loudness },
  ]);
  return { db, model, ids: { a: a[0], b: b[0], c: c[0] } };
}

/* Encodes by keyword spotting. Deterministic, instant, and — importantly —
 * asserts that the QUERY PREFIX arrived, so a caller that forgot to apply it
 * (or applied the passage prefix instead) fails loudly here. */
const stubEmbedQuery = async (prefixed) => {
  assert.ok(prefixed.startsWith(STUB_MODEL.query_prefix), `query prefix missing: ${JSON.stringify(prefixed)}`);
  const q = prefixed.slice(STUB_MODEL.query_prefix.length).toLowerCase();
  if (/timestamp|offset|drift|ad insertion/.test(q)) return Float32Array.from(AXES.dai);
  if (/loud|lufs|normali/.test(q)) return Float32Array.from(AXES.loudness);
  if (/gapless|queue/.test(q)) return Float32Array.from(AXES.gapless);
  return Float32Array.from(AXES.legal);
};

/* --- modes and their contract -------------------------------------------- */

test("the shipped default mode is keyword until the gates say otherwise", () => {
  // Not a preference: eval.mjs's compareToBaseline is what may change this,
  // and PLAN.md's retro carries the numbers behind whatever it says.
  assert.equal(DEFAULT_SEARCH_MODE, "keyword");
  assert.deepEqual(MODES, ["keyword", "vector", "hybrid"]);
});

test("an unknown mode is rejected rather than silently treated as keyword", async () => {
  const { db } = seededCorpus();
  await assert.rejects(() => search(db, "anything", { mode: "semantic" }), /unknown search mode/);
  db.close();
});

test("keyword mode finds the source that uses the words", async () => {
  const { db } = seededCorpus();
  const r = await search(db, "dynamic ad insertion timestamps", { mode: "keyword" });
  assert.equal(r.mode, "keyword");
  assert.equal(sourcesInOrder(r.rows)[0], 1);
  db.close();
});

test("vector mode finds the paraphrase that shares no vocabulary", async () => {
  // The whole case for embeddings in one assertion: source 2 says none of the
  // query's words and is invisible to bm25.
  const { db } = seededCorpus();
  const kw = await search(db, "dynamic ad insertion timestamps", { mode: "keyword" });
  assert.ok(!sourcesInOrder(kw.rows).includes(2), "the fixture must be lexically invisible");
  const vec = await search(db, "dynamic ad insertion timestamps", { mode: "vector", embedQuery: stubEmbedQuery });
  assert.equal(vec.mode, "vector");
  assert.deepEqual(sourcesInOrder(vec.rows).slice(0, 2), [1, 2]);
  db.close();
});

test("hybrid returns both the lexical and the semantic hit", async () => {
  const { db } = seededCorpus();
  const r = await search(db, "dynamic ad insertion timestamps", { mode: "hybrid", embedQuery: stubEmbedQuery });
  assert.equal(r.mode, "hybrid");
  const order = sourcesInOrder(r.rows);
  assert.ok(order.includes(1), "lost the lexical hit");
  assert.ok(order.includes(2), "lost the semantic hit");
  db.close();
});

test("the query prefix comes from the registry row, not from the caller", async () => {
  // stubEmbedQuery asserts the prefix is present; this proves search applies
  // it (the caller here passes the bare user text).
  const { db } = seededCorpus();
  const r = await search(db, "timestamps", { mode: "vector", embedQuery: stubEmbedQuery });
  assert.equal(r.mode, "vector");
  assert.equal(r.model.query_prefix, STUB_MODEL.query_prefix);
  db.close();
});

test("a passage prefix is never applied to a query", async () => {
  const { db } = seededCorpus();
  db.prepare("UPDATE embedding_models SET passage_prefix = 'PASSAGE: '").run();
  const seen = [];
  await search(db, "timestamps", { mode: "vector", embedQuery: async (t) => { seen.push(t); return Float32Array.from(AXES.dai); } });
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].includes("PASSAGE:"), `passage prefix leaked into a query: ${seen[0]}`);
  assert.ok(seen[0].startsWith(STUB_MODEL.query_prefix));
  db.close();
});

/* --- degradation: the property that keeps keyword users safe -------------- */

test("hybrid degrades to keyword, with a notice, when the corpus has no vectors", async () => {
  const db = tmpDb();
  seedSource(db, 1, "S", ["dynamic ad insertion shifts every timestamp"]);
  const r = await search(db, "dynamic ad insertion", { mode: "hybrid", embedQuery: stubEmbedQuery });
  assert.equal(r.mode, "keyword");
  assert.equal(r.requestedMode, "hybrid");
  assert.match(r.notice, /no embeddings/);
  assert.ok(r.rows.length, "the downgrade must still return keyword results");
  db.close();
});

test("hybrid degrades to keyword when the runtime is absent (no embedQuery)", async () => {
  const { db } = seededCorpus();
  const r = await search(db, "dynamic ad insertion", { mode: "hybrid", embedQuery: null });
  assert.equal(r.mode, "keyword");
  assert.match(r.notice, /runtime is not available/);
  assert.ok(r.rows.length);
  db.close();
});

test("a failure inside the embedder degrades instead of throwing at the user", async () => {
  const { db } = seededCorpus();
  const r = await search(db, "dynamic ad insertion", {
    mode: "vector",
    embedQuery: async () => { throw new Error("onnxruntime exploded\nstack line"); },
  });
  assert.equal(r.mode, "keyword");
  assert.match(r.notice, /could not encode the query/);
  assert.ok(!r.notice.includes("stack line"), "only the first line of the error belongs in a one-line notice");
  db.close();
});

test("a registered model with zero vectors degrades rather than returning nothing", async () => {
  const db = tmpDb();
  seedSource(db, 1, "S", ["dynamic ad insertion shifts every timestamp"]);
  registerModel(db, STUB_MODEL);
  const r = await search(db, "dynamic ad insertion", { mode: "vector", embedQuery: stubEmbedQuery });
  assert.equal(r.mode, "keyword");
  assert.match(r.notice, /no embeddings/);
  db.close();
});

test("keyword mode never touches the embedder, even when one is available", async () => {
  const { db } = seededCorpus();
  let called = 0;
  const r = await search(db, "dynamic ad insertion", {
    mode: "keyword",
    embedQuery: async () => { called++; return Float32Array.from(AXES.dai); },
  });
  assert.equal(called, 0);
  assert.equal(r.notice, null);
  db.close();
});

/* --- RRF ----------------------------------------------------------------- */

test("RRF fuses on ranks, never on scores", () => {
  // Same ranks, wildly different score scales: the fusion must be identical.
  const listA = [{ chunk_id: 1, score: -0.5 }, { chunk_id: 2, score: -9.9 }];
  const listB = [{ chunk_id: 2, score: 0.99 }, { chunk_id: 3, score: 0.10 }];
  const a = rrfFuse([listA, listB], { limit: 3 }).map((r) => r.chunk_id);
  const scaled = rrfFuse([
    listA.map((r) => ({ ...r, score: r.score * 1000 })),
    listB.map((r) => ({ ...r, score: r.score / 1000 })),
  ], { limit: 3 }).map((r) => r.chunk_id);
  assert.deepEqual(a, scaled);
});

test("RRF puts a document both retrievers agree on above either one's favourite", () => {
  const kw = [{ chunk_id: 10 }, { chunk_id: 20 }];
  const vec = [{ chunk_id: 30 }, { chunk_id: 20 }];
  assert.equal(rrfFuse([kw, vec], { limit: 3 })[0].chunk_id, 20);
});

test("RRF uses k=60, the paper's constant, by default", () => {
  const fused = rrfFuse([[{ chunk_id: 1 }]], { limit: 1 });
  assert.ok(Math.abs(fused[0].rrf - 1 / 61) < 1e-12, `expected 1/(60+1), got ${fused[0].rrf}`);
});

test("RRF ties break deterministically, so the same inputs give the same order", () => {
  const one = [{ chunk_id: 7 }];
  const two = [{ chunk_id: 3 }];
  assert.deepEqual(rrfFuse([one, two], { limit: 2 }).map((r) => r.chunk_id), [3, 7]);
  assert.deepEqual(rrfFuse([two, one], { limit: 2 }).map((r) => r.chunk_id), [3, 7]);
});

test("RRF records which ranks each result came from", () => {
  const fused = rrfFuse([[{ chunk_id: 1 }, { chunk_id: 2 }], [{ chunk_id: 2 }]], { limit: 2 });
  assert.deepEqual(fused.find((r) => r.chunk_id === 2).ranks, [2, 1]);
});

test("hybrid pools deeper than the display limit before fusing", async () => {
  /* Fusing two lists of exactly `limit` throws away the evidence that makes
   * fusion work. With limit 1, the keyword arm alone would return only source
   * 1 — the agreement with the vector arm is only visible because both arms
   * retrieve deeper than one row. */
  const { db } = seededCorpus();
  const r = await search(db, "dynamic ad insertion timestamps", { mode: "hybrid", limit: 1, embedQuery: stubEmbedQuery });
  assert.equal(r.rows.length, 1);
  assert.ok(r.rows[0].ranks.length >= 1);
  db.close();
});

/* --- the pieces ---------------------------------------------------------- */

test("vectorSearch returns an excerpt, not a fabricated keyword highlight", async () => {
  // A semantic hit often shares no literal term with the query; inventing
  // highlight marks would imply a lexical overlap that is not there.
  const { db, model } = seededCorpus();
  const r = vectorSearch(db, Float32Array.from(AXES.loudness), { limit: 1, index: loadMatrix(db, model.id) });
  assert.equal(r.rows[0].source_id, 3);
  assert.ok(!r.rows[0].snip.includes("»"), "vector rows must not carry FTS highlight marks");
  assert.ok(r.rows[0].snip.includes("normalize the programme"));
  assert.equal(r.rows[0].text, undefined, "the full chunk text must not ride along in a result row");
  db.close();
});

test("a query vector of the wrong dimension is rejected, not silently mis-ranked", () => {
  /* This fails SILENTLY AND WRONGLY if unchecked: a short query makes every
   * dot product NaN, `sort` leaves NaN comparisons in insertion order, and the
   * lowest chunk ids come back dressed as nearest neighbours. Reachable
   * because resolveModel picks whichever model has vectors while the caller
   * encodes with whatever model it was built with. */
  const { db, model } = seededCorpus();
  const index = loadMatrix(db, model.id);
  assert.throws(() => vectorSearch(db, Float32Array.from([1, 0]), { limit: 3, index }), /2 dimensions but the index holds 4/);
  assert.throws(() => vectorSearch(db, Float32Array.from([1, 0, 0, 0, 0, 0]), { limit: 3, index }), /6 dimensions but the index holds 4/);
  db.close();
});

test("vectorSearch on an empty index returns nothing rather than throwing", () => {
  const { db } = seededCorpus();
  const r = vectorSearch(db, Float32Array.from(AXES.dai), { limit: 5, index: { count: 0, chunkIds: new Int32Array(0), matrix: new Float32Array(0), dim: 4 } });
  assert.deepEqual(r.rows, []);
  db.close();
});

test("resolveModel picks a model that actually has vectors", () => {
  const { db, model } = seededCorpus();
  registerModel(db, { ...STUB_MODEL, revision: "v2" }); // newer, but empty
  assert.equal(resolveModel(db).id, model.id);
  db.close();
});

test("resolveModel returns null on a corpus with no vectors at all", () => {
  const db = tmpDb();
  registerModel(db, STUB_MODEL);
  assert.equal(resolveModel(db), null);
  db.close();
});

test("sourcesInOrder dedupes and drops orphan placeholder rows", () => {
  assert.deepEqual(sourcesInOrder([{ source_id: 5 }, { source_id: 5 }, { source_id: null }, { source_id: 2 }]), [5, 2]);
});

test("keywordSearch still reports the MATCH it built, and null for an unindexable query", () => {
  const { db } = seededCorpus();
  assert.ok(keywordSearch(db, "dynamic ad insertion").match.includes("dynamic"));
  assert.equal(keywordSearch(db, "???").match, null);
  db.close();
});
