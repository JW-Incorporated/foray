/* The eval harness and the offline rechunk path — the two pieces of new code
 * that can respectively LIE about quality and DESTROY data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMigrated } from "./db.mjs";
import { runEval, runModes, compareToBaseline, formatComparison } from "./eval.mjs";
import { MODES } from "./search.mjs";
import { rechunkAll, writeChunks } from "./ingest.mjs";
import { keywordSearch, sourcesInOrder } from "./search.mjs";
import { registerModel, writeEmbeddings, embeddingCoverage } from "./embeddings.mjs";

/* Every test gets its own throwaway corpus root — nothing here touches the
 * real data-local/corpus/ archive. */
function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-eval-"));
  const db = openMigrated(path.join(dir, "t.db"), { create: true });
  return { db, dir };
}

function seed(db, { sourceId = 1, mdRelPath = null, chunks = [] } = {}) {
  db.prepare(
    `INSERT INTO sources (id, area, area_name, title, url, source_type)
     VALUES (?, 4, 'Retrieval', 'Source ${sourceId}', 'https://e.test/${sourceId}', 'blog')`
  ).run(sourceId);
  const docId = db.prepare(
    `INSERT INTO documents (source_id, http_status, content_hash, raw_path, markdown_path)
     VALUES (?, 200, 'h', 'raw/x', ?)`
  ).run(sourceId, mdRelPath).lastInsertRowid;
  writeChunks(db, docId, chunks.map((text, i) => ({
    ordinal: i, heading_path: "", text, token_count: Math.ceil(text.length / 4),
  })));
  return docId;
}

/* --- eval math ----------------------------------------------------------- */

const goldOf = (queries) => ({ queries });

test("a perfect ranking scores 1.0 across the board", async () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["reciprocal rank fusion combines ranked lists"] });
  const r = await runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1] }]));
  assert.equal(r.aggregate.recall5, 1);
  assert.equal(r.aggregate.mrr, 1);
  assert.equal(r.aggregate.ndcg, 1);
  db.close();
});

test("a miss scores zero and is reported as not-found, not as an error", async () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["completely unrelated wording about kittens"] });
  const r = await runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1] }]));
  assert.equal(r.perQuery[0].found, false);
  assert.equal(r.perQuery[0].error, null);
  assert.equal(r.aggregate.mrr, 0);
  db.close();
});

test("reciprocal rank reflects the position of the first primary hit", async () => {
  const { db } = tmpDb();
  // Source 1 matches one term; source 2 matches many and outranks it.
  seed(db, { sourceId: 1, chunks: ["fusion"] });
  seed(db, { sourceId: 2, chunks: ["reciprocal rank fusion reciprocal rank fusion ranked"] });
  const r = await runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1] }]));
  assert.equal(r.perQuery[0].firstHitRank, 2);
  assert.equal(r.perQuery[0].rr, 0.5);
  db.close();
});

test("secondary hits earn partial nDCG credit, never full", async () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 2, chunks: ["reciprocal rank fusion combines ranked lists"] });
  const r = await runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1], secondary: [2] }]));
  assert.ok(r.aggregate.ndcg > 0, "secondary should score something");
  assert.ok(r.aggregate.ndcg < 1, "secondary must not score a perfect run");
  assert.equal(r.aggregate.recall5, 0, "recall counts primaries only");
  db.close();
});

test("a query that errors is recorded, not thrown, and does not abort the run", async () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["anything at all here"] });
  const r = await runEval(db, goldOf([
    { id: 1, q: "what is DAI?", primary: [1] },
    { id: 2, q: "anything", primary: [1] },
  ]), { raw: true });
  assert.equal(r.aggregate.errors, 1);
  assert.equal(r.perQuery.length, 2, "the run continued past the error");
  db.close();
});

test("negatives appearing in the top 5 are counted", async () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 9, chunks: ["chromaprint fingerprint alignment offset"] });
  const r = await runEval(db, goldOf([{ id: 1, q: "alignment", primary: [1], negative: [9] }]));
  assert.deepEqual(r.perQuery[0].negativesInTop5, [9]);
  assert.equal(r.aggregate.negativeHits, 1);
  db.close();
});

test("eval runs the same retriever the CLI does", async () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["reciprocal rank fusion combines ranked lists"] });
  const r = await runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1] }]));
  const direct = sourcesInOrder(keywordSearch(db, "reciprocal rank fusion", { limit: 8 }).rows);
  assert.deepEqual(r.perQuery[0].top5, direct.slice(0, 5));
  db.close();
});

test("evaluation depth defaults to the CLI's own limit", async () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["alpha"] });
  assert.equal((await runEval(db, goldOf([{ id: 1, q: "alpha", primary: [1] }]))).limit, 8);
  db.close();
});

/* --- the metric, which decided the experiment ---------------------------- */

test("Recall@5 is a FRACTION of a query's primaries, not a hit rate", async () => {
  /* This is the bug that made the whole embedding verdict unsafe: the metric
   * called Recall@5 was `top5.some(id => primary.includes(id))`, so finding
   * one of three right answers scored a perfect 1.000. Ten of the fifteen gold
   * queries have 2-3 primaries, which pinned the keyword baseline at the
   * ceiling BY DEFINITION and made "must beat it on Recall@5" unpassable. */
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["reciprocal rank fusion combines ranked lists"] });
  const r = await runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1, 2, 3] }]));
  assert.equal(r.perQuery[0].recall5, 1 / 3, "one of three primaries is a third of the recall, not all of it");
  assert.equal(r.perQuery[0].hit5, 1, "hit rate is still 1 — the user did get an answer");
  assert.equal(r.aggregate.recall5, 1 / 3);
  db.close();
});

test("Recall@5 reaches 1.000 only when every primary is retrieved", async () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["reciprocal rank fusion combines ranked lists"] });
  seed(db, { sourceId: 2, chunks: ["reciprocal rank fusion is a fusion method"] });
  const r = await runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1, 2] }]));
  assert.equal(r.perQuery[0].recall5, 1);
  db.close();
});

test("aggregate metric names say the depth they are actually computed at", async () => {
  // These were `mrr10`/`ndcg10` while the depth follows --limit (8 by default),
  // so every --json consumer read an "@10" that was never 10.
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["alpha"] });
  const r = await runEval(db, goldOf([{ id: 1, q: "alpha", primary: [1] }]));
  assert.ok("mrr" in r.aggregate && "ndcg" in r.aggregate);
  assert.ok(!("mrr10" in r.aggregate), "the misleading @10 names must be gone, not aliased");
  db.close();
});

/* --- the acceptance gates ------------------------------------------------ */

const fakeRun = (mode, perQuery, over = {}) => ({
  mode, limit: 8, downgraded: null, perQuery,
  aggregate: {
    queries: perQuery.length,
    found: perQuery.filter((r) => r.found).length,
    hit5: 1,
    recall5: perQuery.reduce((a, r) => a + r.recall5, 0) / perQuery.length,
    mrr: perQuery.reduce((a, r) => a + r.rr, 0) / perQuery.length,
    ndcg: perQuery.reduce((a, r) => a + r.ndcg, 0) / perQuery.length,
    errors: 0, negativeHits: 0,
  },
  ...over,
});
const qr = (id, { found = true, rank = 1, recall5 = 1, ndcg = 1 } = {}) =>
  ({ id, q: `q${id}`, found, firstHitRank: rank, rr: rank ? 1 / rank : 0, recall5, ndcg });

test("a query going from found to not-found blocks the default, even when the averages improve", () => {
  // Gate 1 is about individual queries, not means. A mode that lifts the
  // average while losing a question outright is worse at the only job it has.
  const base = fakeRun("keyword", [qr(1, { rank: 3, recall5: 0.5, ndcg: 0.5 }), qr(2, { rank: 3, recall5: 0.5, ndcg: 0.5 })]);
  const cand = fakeRun("hybrid", [qr(1, { rank: 1, recall5: 1, ndcg: 1 }), qr(2, { found: false, rank: 0, recall5: 0, ndcg: 0 })]);
  const c = compareToBaseline(base, cand);
  assert.equal(c.regressions.length, 1);
  assert.equal(c.regressions[0].id, 2);
  assert.equal(c.regressions[0].wasRank, 3);
  assert.equal(c.earnsDefault, false);
});

test("winning on MRR but only tying on Recall@5 does not earn the default", () => {
  const base = fakeRun("keyword", [qr(1, { rank: 2, recall5: 1 })]);
  const cand = fakeRun("hybrid", [qr(1, { rank: 1, recall5: 1 })]);
  const c = compareToBaseline(base, cand);
  assert.ok(c.dMrr > 0);
  assert.equal(c.dRecall, 0);
  assert.equal(c.beatsOnBoth, false);
  assert.equal(c.earnsDefault, false);
});

test("winning on both, with no regression, earns the default", () => {
  const base = fakeRun("keyword", [qr(1, { rank: 3, recall5: 0.5 })]);
  const cand = fakeRun("hybrid", [qr(1, { rank: 1, recall5: 1 })]);
  const c = compareToBaseline(base, cand);
  assert.equal(c.earnsDefault, true);
  assert.deepEqual(c.saturated, []);
});

test("a saturated baseline is reported as unbeatable, not as a candidate failure", () => {
  // Otherwise an impossible gate and a genuinely losing mode print the same
  // verdict, and the impossibility gets published as evidence.
  const base = fakeRun("keyword", [qr(1, { rank: 1, recall5: 1 })]);
  const cand = fakeRun("hybrid", [qr(1, { rank: 1, recall5: 1 })]);
  const c = compareToBaseline(base, cand);
  assert.deepEqual(c.saturated, ["Recall@5", "MRR"]);
  assert.equal(c.earnsDefault, false);
});

test("a downgraded candidate can never earn the default, however good its numbers", () => {
  // Its results are partly the baseline's own, so they are not a measurement
  // of the candidate at all.
  const base = fakeRun("keyword", [qr(1, { rank: 3, recall5: 0.5 })]);
  const cand = fakeRun("hybrid", [qr(1, { rank: 1, recall5: 1 })], { downgraded: "runtime absent" });
  const c = compareToBaseline(base, cand);
  assert.ok(c.dRecall > 0 && c.dMrr > 0, "the numbers themselves look like a win");
  assert.equal(c.trustworthy, false);
  assert.equal(c.earnsDefault, false);
});

test("rank losses that stay found are reported but do not block", () => {
  const base = fakeRun("keyword", [qr(1, { rank: 1, recall5: 0.5 })]);
  const cand = fakeRun("hybrid", [qr(1, { rank: 3, recall5: 1 })]);
  const c = compareToBaseline(base, cand);
  assert.deepEqual(c.rankLosses.map((r) => [r.from, r.to]), [[1, 3]]);
  assert.equal(c.noRegression, true);
});

test("runModes runs every mode over the same gold set and depth", async () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["reciprocal rank fusion combines ranked lists"] });
  const results = await runModes(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1] }]), { limit: 5 });
  assert.deepEqual(results.map((r) => r.mode), MODES);
  for (const r of results) {
    assert.equal(r.limit, 5);
    assert.equal(r.perQuery.length, 1);
  }
  db.close();
});

test("a downgraded run says so on the result, not only in the printed banner", async () => {
  // Without this the numbers describe keyword search wearing another label,
  // and a --json consumer cannot tell.
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["reciprocal rank fusion combines ranked lists"] });
  const r = await runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1] }]), { mode: "hybrid" });
  assert.match(r.downgraded, /no embeddings/);
  assert.equal(r.perQuery[0].ranMode, "keyword");
  db.close();
});

test("the comparison report names the saturated term and the downgrade", async () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["reciprocal rank fusion combines ranked lists"] });
  const results = await runModes(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1] }]));
  const out = formatComparison(results);
  assert.match(out, /DOWNGRADED/);
  assert.match(out, /cannot be beaten, only tied/);
  db.close();
});

/* --- rechunk: the destructive path -------------------------------------- */

function withArchive(dir, name, body) {
  const rel = `markdown/${name}`;
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, "utf8");
  return rel;
}

test("rechunk rebuilds chunks from archived markdown with no network", () => {
  const { db, dir } = tmpDb();
  const a = withArchive(dir, "rechunk-test-ok.md", `# Head\n\n${"word ".repeat(400)}`);
  seed(db, { sourceId: 1, mdRelPath: a, chunks: ["stale text"] });
  const r = rechunkAll(db, { corpusRoot: dir });
  assert.equal(r.documents, 1);
  assert.ok(r.after > 0);
  const texts = db.prepare("SELECT text FROM chunks").all().map((x) => x.text);
  assert.ok(!texts.some((t) => t === "stale text"), "stale chunk survived");
  db.close();
});

test("rechunk strips the archive header so it never becomes searchable body text", () => {
  // ingestSource writes `header + markdown` to disk but chunks only the
  // markdown. If rechunk indexed the header, the two paths would build
  // different indexes from identical bytes.
  const { db, dir } = tmpDb();
  const a = withArchive(
    dir,
    "rechunk-test-header.md",
    `<!-- corpus source 1: Title\n     url: https://e.test/1\n     fetched: x (200) -->\n\n# Head\n\n${"word ".repeat(400)}`
  );
  seed(db, { sourceId: 1, mdRelPath: a, chunks: ["stale"] });
  rechunkAll(db, { corpusRoot: dir });
  const texts = db.prepare("SELECT text FROM chunks").all().map((x) => x.text);
  assert.ok(!texts.some((t) => t.includes("corpus source 1")), "header leaked into a chunk");
  assert.ok(!texts.some((t) => t.includes("https://e.test/1")), "url leaked into a chunk");
  db.close();
});

test("rechunk refuses to empty a source when its archive yields nothing", () => {
  // writeFileSync is not atomic; a crash mid-ingest leaves a truncated file.
  // Wiping the source would delete it from search while stats still counted
  // it as ingested — a silent lie.
  const { db, dir } = tmpDb();
  const a = withArchive(dir, "rechunk-test-empty.md", "   \n\n  \n");
  seed(db, { sourceId: 1, mdRelPath: a, chunks: ["real content that must survive"] });
  const r = rechunkAll(db, { corpusRoot: dir });
  assert.equal(r.emptied.length, 1, "the skip must be reported, not silent");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM chunks").get().n, 1, "source was wiped");
  db.close();
});

test("rechunk reports a missing archive instead of wiping the source", () => {
  const { db, dir } = tmpDb();
  seed(db, { sourceId: 1, mdRelPath: "markdown/does-not-exist.md", chunks: ["keep me"] });
  const r = rechunkAll(db, { corpusRoot: dir });
  assert.equal(r.missing.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM chunks").get().n, 1);
  db.close();
});

test("rechunk refuses to run when vectors would be cascade-deleted", () => {
  // chunks is the FK parent of chunk_embeddings (ON DELETE CASCADE), so a
  // re-chunk silently destroys every backfilled vector — no error, because the
  // cascade is doing exactly what it was asked to.
  const { db, dir } = tmpDb();
  const a = withArchive(dir, "rechunk-test-embed.md", `# H\n\n${"word ".repeat(400)}`);
  seed(db, { sourceId: 1, mdRelPath: a, chunks: ["has a vector"] });
  const model = registerModel(db, {
    name: "test/model", revision: "v1", dim: 4, pooling: "cls", quantization: "q8",
  });
  const chunkId = db.prepare("SELECT id FROM chunks LIMIT 1").get().id;
  writeEmbeddings(db, model.id, [{ chunkId, vector: [1, 0, 0, 0] }]);

  assert.throws(() => rechunkAll(db, { corpusRoot: dir }), /cascade-deleted/);
  assert.equal(embeddingCoverage(db, model.id).embedded, 1, "the refusal must not have deleted anything");
  db.close();
});

test("rechunk --drop-embeddings is the deliberate opt-in, and leaves coverage at zero", () => {
  // The escape hatch has to be explicit AND honest: after it runs, the
  // backfill's own coverage number must report the corpus as unembedded,
  // because that is what it is.
  const { db, dir } = tmpDb();
  const a = withArchive(dir, "rechunk-test-drop.md", `# H\n\n${"word ".repeat(400)}`);
  seed(db, { sourceId: 1, mdRelPath: a, chunks: ["has a vector"] });
  const model = registerModel(db, {
    name: "test/model", revision: "v1", dim: 4, pooling: "cls", quantization: "q8",
  });
  const chunkId = db.prepare("SELECT id FROM chunks LIMIT 1").get().id;
  writeEmbeddings(db, model.id, [{ chunkId, vector: [1, 0, 0, 0] }]);

  const r = rechunkAll(db, { corpusRoot: dir, dropEmbeddings: true });
  assert.ok(r.after > 0, "the re-chunk itself still ran");
  assert.equal(embeddingCoverage(db, model.id).embedded, 0);
  db.close();
});

test("rechunk is idempotent and keeps the FTS index in sync", () => {
  const { db, dir } = tmpDb();
  const a = withArchive(dir, "rechunk-test-idem.md", `# Head\n\n${"loudness ".repeat(400)}`);
  seed(db, { sourceId: 1, mdRelPath: a, chunks: ["stale"] });
  const first = rechunkAll(db, { corpusRoot: dir }).after;
  const second = rechunkAll(db, { corpusRoot: dir }).after;
  assert.equal(first, second);
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
  const hits = db.prepare("SELECT COUNT(*) n FROM chunks_fts WHERE chunks_fts MATCH 'loudness'").get().n;
  assert.equal(hits, first, "FTS rows out of sync with chunks");
  db.close();
});

test("rechunk counts describe the database, not just the rewritten subset", () => {
  const { db, dir } = tmpDb();
  const a = withArchive(dir, "rechunk-test-count.md", `# H\n\n${"word ".repeat(400)}`);
  seed(db, { sourceId: 1, mdRelPath: a, chunks: ["x"] });
  seed(db, { sourceId: 2, mdRelPath: "markdown/gone.md", chunks: ["kept", "also kept"] });
  const r = rechunkAll(db, { corpusRoot: dir });
  assert.equal(r.after, db.prepare("SELECT COUNT(*) n FROM chunks").get().n);
  db.close();
});
