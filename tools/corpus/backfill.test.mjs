/* The backfill, the token-length gate, and the runtime boundary.
 *
 * NO MODEL IS DOWNLOADED AND NO RUNTIME IS LOADED. `backfill` takes its
 * embedder as a parameter, and everything in `tokenstats.mjs` is pure, so a
 * stub covers both. `embedder.mjs` is exercised only for the behaviour that
 * matters when the runtime is ABSENT — which is the state CI is always in,
 * because it installs `tools/corpus/package.json` and never
 * `tools/corpus/embed/`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMigrated } from "./db.mjs";
import { writeChunks } from "./ingest.mjs";
import { embeddingCoverage, loadMatrix, getModel, registerModel } from "./embeddings.mjs";
import { backfill } from "./backfill.mjs";
import { tokenHistogram, heuristicDrift, formatHistogram, RECHUNK_THRESHOLD, DANGER_MARGIN } from "./tokenstats.mjs";
import { BGE_SMALL_EN_V15, EMBED_CHUNK_MAX, EMBED_CHUNK_MIN, EmbeddingRuntimeUnavailable, MODELS_DIR, createEmbedder, runtimeInstalled } from "./embedder.mjs";
import { chunkMarkdown, estTokens } from "./chunk.mjs";

const tmpDb = () => openMigrated(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "corpus-backfill-")), "t.db"), { create: true });

const STUB_MODEL = {
  name: "stub/model", revision: "v1", dim: 4, pooling: "cls",
  normalized: 1, quantization: "test", query_prefix: "Q: ", passage_prefix: "",
  maxTokens: 20,
};

/* Deterministic pseudo-embedder: a vector derived from the text's own bytes.
 * Different texts get different vectors, the same text always gets the same
 * one, and nothing is ever the zero vector. */
function stubEmbedder(model = STUB_MODEL, { onBatch } = {}) {
  const seen = [];
  return {
    model,
    seen,
    countTokens: (t) => t.split(/\s+/).filter(Boolean).length,
    async embedPassages(texts) {
      onBatch?.(texts);
      seen.push(...texts);
      return texts.map((t) => {
        const v = new Float32Array(model.dim).fill(0.1);
        for (let i = 0; i < t.length; i++) v[i % model.dim] += t.charCodeAt(i) % 7;
        return v;
      });
    },
  };
}

function seedChunks(db, texts, { sourceId = 1, title = "Test Source" } = {}) {
  db.prepare(
    `INSERT INTO sources (id, area, area_name, title, url, source_type)
     VALUES (?, 4, 'Retrieval', ?, 'https://e.test/' || ?, 'blog')`
  ).run(sourceId, title, sourceId);
  const docId = db.prepare(
    `INSERT INTO documents (source_id, http_status, content_hash, raw_path, markdown_path)
     VALUES (?, 200, 'h', 'raw/x', 'markdown/x.md')`
  ).run(sourceId).lastInsertRowid;
  writeChunks(db, docId, texts.map((text, i) => ({ ordinal: i, heading_path: "Head", text, token_count: 5 })));
  return db.prepare("SELECT id FROM chunks WHERE document_id = ? ORDER BY ordinal").all(docId).map((r) => r.id);
}

/* --- the backfill -------------------------------------------------------- */

test("backfill registers the model and embeds every chunk", async () => {
  const db = tmpDb();
  seedChunks(db, ["alpha text here", "beta text here", "gamma text here"]);
  const r = await backfill(db, stubEmbedder());
  assert.equal(r.embedded, 3);
  assert.deepEqual(r.coverage, { chunks: 3, embedded: 3, missing: 0 });
  assert.ok(getModel(db, STUB_MODEL), "the model must be registered from the embedder's own spec");
  assert.equal(loadMatrix(db, r.model.id).count, 3);
  db.close();
});

test("backfill is resumable: a second run embeds only what is missing", async () => {
  // A crash halfway through 558 chunks must not cost the whole run, and
  // `embed` has to work as "top up after an ingest".
  const db = tmpDb();
  seedChunks(db, ["alpha text here", "beta text here"]);
  await backfill(db, stubEmbedder());
  const e = stubEmbedder();
  const r = await backfill(db, e);
  assert.equal(r.embedded, 0);
  assert.equal(r.skipped, 2);
  assert.equal(e.seen.length, 0, "an up-to-date corpus must not re-encode anything");
  db.close();
});

test("backfill --force re-embeds everything", async () => {
  const db = tmpDb();
  seedChunks(db, ["alpha text here", "beta text here"]);
  await backfill(db, stubEmbedder());
  const r = await backfill(db, stubEmbedder(), { force: true });
  assert.equal(r.embedded, 2);
  assert.equal(r.coverage.embedded, 2, "re-embedding must upsert, not duplicate");
  db.close();
});

test("each batch is committed as it completes, so an interrupted run keeps its progress", async () => {
  const db = tmpDb();
  seedChunks(db, ["one text", "two text", "three text", "four text"]);
  let batches = 0;
  const e = stubEmbedder(STUB_MODEL, {
    onBatch: () => { if (++batches === 2) throw new Error("simulated crash mid-run"); },
  });
  await assert.rejects(() => backfill(db, e, { batch: 2 }), /simulated crash/);
  const model = getModel(db, STUB_MODEL);
  assert.equal(embeddingCoverage(db, model.id).embedded, 2, "the first batch must have survived the crash");
  // …and resuming finishes the job.
  const r = await backfill(db, stubEmbedder(), { batch: 2 });
  assert.equal(r.embedded, 2);
  assert.equal(r.coverage.missing, 0);
  db.close();
});

test("the encoded text carries the source title and heading, and the stored chunk text does not change", async () => {
  const db = tmpDb();
  seedChunks(db, ["the offset drifts by up to thirty seconds"], { title: "Namespace Issue 254" });
  const e = stubEmbedder();
  await backfill(db, e);
  assert.equal(e.seen[0], "Namespace Issue 254 — Head\n\nthe offset drifts by up to thirty seconds");
  assert.equal(
    db.prepare("SELECT text FROM chunks LIMIT 1").get().text,
    "the offset drifts by up to thirty seconds",
    "chunks.text must be stored unchanged — the header is what gets ENCODED, not what gets stored"
  );
  db.close();
});

test("backfill counts chunks the model would truncate instead of hiding them", async () => {
  // Truncation is silent at the model: the tail of an over-long chunk simply
  // is not in its vector while search keeps displaying the whole chunk.
  const db = tmpDb();
  seedChunks(db, ["short one", Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")]);
  const r = await backfill(db, stubEmbedder());
  assert.equal(r.truncated, 1);
  db.close();
});

test("a wrong-dimension vector from the embedder aborts rather than being stored", async () => {
  const db = tmpDb();
  seedChunks(db, ["alpha text here"]);
  const bad = { ...stubEmbedder(), async embedPassages(t) { return t.map(() => new Float32Array(8).fill(0.5)); } };
  await assert.rejects(() => backfill(db, bad), /8-dim vector but model .* declares 4/);
  db.close();
});

test("an embedder returning the wrong number of vectors aborts", async () => {
  const db = tmpDb();
  seedChunks(db, ["alpha text here", "beta text here"]);
  const bad = { ...stubEmbedder(), async embedPassages() { return [new Float32Array(4).fill(0.5)]; } };
  await assert.rejects(() => backfill(db, bad), /returned 1 vectors for 2 chunks/);
  db.close();
});

test("re-registering the same model under changed vector-space settings is refused mid-backfill", async () => {
  const db = tmpDb();
  seedChunks(db, ["alpha text here"]);
  await backfill(db, stubEmbedder());
  await assert.rejects(
    () => backfill(db, stubEmbedder({ ...STUB_MODEL, dim: 8 })),
    /different vector-space settings/
  );
  db.close();
});

/* --- the length gate ----------------------------------------------------- */

test("the histogram reports percentiles and the truncated count", () => {
  const h = tokenHistogram([10, 20, 600, 700], { maxTokens: 512 });
  assert.equal(h.chunks, 4);
  assert.equal(h.min, 10);
  assert.equal(h.max, 700);
  assert.equal(h.truncated, 2);
  assert.equal(h.truncatedRate, 0.5);
});

test("the gate fires on the DANGER band, not only on actual truncation", () => {
  // A chunk at 500 tokens is not truncated yet but is one re-extraction away.
  const h = tokenHistogram(Array(100).fill(0).map((_, i) => (i < 20 ? 500 : 100)), { maxTokens: 512 });
  assert.equal(h.truncated, 0, "nothing is over the hard limit");
  assert.equal(h.danger, 20);
  assert.ok(h.shouldRechunk, "20% in the danger band must still trip the gate");
  assert.equal(h.dangerAt, 512 - DANGER_MARGIN);
});

test("a corpus comfortably under the limit does not trip the gate", () => {
  const h = tokenHistogram(Array(100).fill(300), { maxTokens: 512 });
  assert.equal(h.shouldRechunk, false);
  assert.equal(h.threshold, RECHUNK_THRESHOLD);
});

test("the gate threshold is exclusive — exactly 10% does not trip it", () => {
  const h = tokenHistogram(Array(100).fill(0).map((_, i) => (i < 10 ? 600 : 100)), { maxTokens: 512 });
  assert.equal(h.dangerRate, 0.1);
  assert.equal(h.shouldRechunk, false);
});

test("measuring nothing is an error, not a clean bill of health", () => {
  assert.throws(() => tokenHistogram([], { maxTokens: 512 }), /no chunks to measure/);
});

test("heuristicDrift says how wrong chars/4 was, and in which direction", () => {
  const d = heuristicDrift([107, 107], [100, 100]);
  assert.equal(d.realSum, 214);
  assert.equal(d.estSum, 200);
  assert.ok(Math.abs(d.ratio - 1.07) < 1e-9);
});

test("the formatted report states the verdict in words, not just numbers", () => {
  const out = formatHistogram(tokenHistogram(Array(10).fill(600), { maxTokens: 512 }));
  assert.match(out, /GATE: RE-CHUNK/);
  assert.match(out, /TRUNCATED/);
  const ok = formatHistogram(tokenHistogram(Array(10).fill(100), { maxTokens: 512 }));
  assert.match(ok, /GATE: no re-chunk needed/);
});

/* --- the injectable chunker --------------------------------------------- */

test("the default hard-split still cuts at exactly maxTokens*4 chars, for every length class", () => {
  /* Pins the DEFAULT chunker against the constant it used before `countTokens`
   * became injectable. Comparing `chunkMarkdown(md)` to
   * `chunkMarkdown(md, {countTokens: estTokens})` cannot catch a regression
   * here — both go down the same new path — and the obvious fixture length
   * (a multiple of 4) is the one class where a broken ratio coincidentally
   * agrees. So: assert the emitted split sizes directly, at each length mod 4.
   *
   * This caught a real bug: deriving chars-per-token with `Math.floor` yields
   * 3 rather than 4 whenever length % 4 !== 0, which silently moved the split
   * from 4000 chars to 3000 for three lengths out of four. */
  for (const extra of [0, 1, 2, 3]) {
    const oneLongSentence = "x".repeat(10000 + extra); // no sentence boundaries
    const chunks = chunkMarkdown(oneLongSentence);
    assert.equal(chunks[0].text.length, 4000, `length %4 == ${extra}: first cut moved`);
    assert.equal(chunks[1].text.length, 4000, `length %4 == ${extra}: second cut moved`);
    assert.equal(chunks.length, 3, `length %4 == ${extra}: chunk count moved`);
  }
});

test("passing the default countTokens explicitly changes nothing", () => {
  const md = `# H\n\n${"word ".repeat(2000)}`;
  assert.deepEqual(chunkMarkdown(md), chunkMarkdown(md, { countTokens: estTokens }));
});

test("injecting a real tokenizer and a lower ceiling produces smaller chunks", () => {
  // A tokenizer that counts every character as a token: 4x the default unit.
  const md = `# H\n\n${"word ".repeat(2000)}`;
  const big = chunkMarkdown(md);
  const small = chunkMarkdown(md, { countTokens: (s) => s.length, maxTokens: 400, minTokens: 100 });
  assert.ok(small.length > big.length, `${small.length} should exceed ${big.length}`);
  for (const c of small) assert.ok(c.token_count <= 400, `chunk of ${c.token_count} exceeds the injected ceiling`);
});

test("no emitted piece exceeds the ceiling, even when the tokenizer is denser than average", () => {
  /* The hard-split sizes its cut from a whole-string chars-per-token estimate
   * but only ever re-measures the REMAINDER, so an emitted piece could sail
   * past the ceiling unchecked. Under the real bge tokenizer that left five
   * chunks over the model's 512-token limit — silently truncated — while the
   * histogram reported the corpus as clean. */
  const dense = "aaaa "; // 1 token per 5 chars at the front…
  const sparse = "x".repeat(4000); // …and much denser after
  const countTokens = (s) => Math.ceil(s.replace(/\s/g, "").length / 2);
  for (const c of chunkMarkdown(dense.repeat(200) + sparse, { countTokens, maxTokens: 100, minTokens: 25 })) {
    assert.ok(c.token_count <= 100, `emitted a chunk of ${c.token_count} tokens against a ceiling of 100`);
  }
});

test("token_count is reported in whatever unit countTokens measures", () => {
  const [c] = chunkMarkdown("alpha beta gamma delta epsilon", { countTokens: (s) => s.split(" ").length });
  assert.equal(c.token_count, 5);
});

test("the embed chunk ceiling leaves real headroom under the model's limit", () => {
  // 400 body tokens + title/heading header + the two special tokens must fit
  // in 512, or the re-chunk would not have solved anything.
  assert.ok(EMBED_CHUNK_MAX < BGE_SMALL_EN_V15.maxTokens - 100, `${EMBED_CHUNK_MAX} leaves too little headroom`);
  assert.equal(EMBED_CHUNK_MIN * 4, EMBED_CHUNK_MAX, "min:max should keep the 1:4 ratio the default profile uses");
});

/* --- the runtime boundary ------------------------------------------------ */

test("the model spec stores query and passage prefixes asymmetrically", () => {
  // BGE prefixes queries only. The empty passage prefix is a deliberate value.
  assert.ok(BGE_SMALL_EN_V15.query_prefix.length > 0);
  assert.equal(BGE_SMALL_EN_V15.passage_prefix, "");
  assert.equal(BGE_SMALL_EN_V15.dim, 384);
  assert.equal(BGE_SMALL_EN_V15.pooling, "cls");
  assert.equal(BGE_SMALL_EN_V15.quantization, "q8", "q8 must be explicit — Node/CPU defaults to fp32");
});

test("model weights are pointed at data-local/, never node_modules", () => {
  assert.match(MODELS_DIR.replace(/\\/g, "/"), /\/data-local\/models$/);
  assert.ok(!MODELS_DIR.includes("node_modules"));
});

test("a missing runtime is a typed, actionable error — never a module-resolution stack trace", async () => {
  // This is THE property that keeps `tools/corpus/` installable without 250MB
  // of onnxruntime. On CI the runtime is genuinely absent, so this asserts the
  // real path; where it is installed, the type is still what callers catch.
  if (runtimeInstalled()) {
    await assert.rejects(() => createEmbedder({ model: { ...BGE_SMALL_EN_V15, name: "does-not-exist/nope" }, allowRemote: false }));
    return;
  }
  await assert.rejects(() => createEmbedder(), (err) => {
    assert.ok(err instanceof EmbeddingRuntimeUnavailable);
    assert.equal(err.code, "EMBEDDING_RUNTIME_UNAVAILABLE");
    assert.match(err.message, /cd tools\/corpus\/embed && npm install/);
    return true;
  });
});

test("registerModel accepts the real bge spec (dim, pooling and prefixes all valid)", () => {
  const db = tmpDb();
  const m = registerModel(db, BGE_SMALL_EN_V15);
  assert.equal(m.dim, 384);
  assert.equal(m.normalized, 1);
  assert.equal(m.passage_prefix, "");
  db.close();
});
