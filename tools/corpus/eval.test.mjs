/* The eval harness and the offline rechunk path — the two pieces of new code
 * that can respectively LIE about quality and DESTROY data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMigrated } from "./db.mjs";
import { runEval } from "./eval.mjs";
import { rechunkAll, writeChunks } from "./ingest.mjs";
import { keywordSearch, sourcesInOrder } from "./search.mjs";

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

test("a perfect ranking scores 1.0 across the board", () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["reciprocal rank fusion combines ranked lists"] });
  const r = runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1] }]));
  assert.equal(r.aggregate.recall5, 1);
  assert.equal(r.aggregate.mrr10, 1);
  assert.equal(r.aggregate.ndcg10, 1);
  db.close();
});

test("a miss scores zero and is reported as not-found, not as an error", () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["completely unrelated wording about kittens"] });
  const r = runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1] }]));
  assert.equal(r.perQuery[0].found, false);
  assert.equal(r.perQuery[0].error, null);
  assert.equal(r.aggregate.mrr10, 0);
  db.close();
});

test("reciprocal rank reflects the position of the first primary hit", () => {
  const { db } = tmpDb();
  // Source 1 matches one term; source 2 matches many and outranks it.
  seed(db, { sourceId: 1, chunks: ["fusion"] });
  seed(db, { sourceId: 2, chunks: ["reciprocal rank fusion reciprocal rank fusion ranked"] });
  const r = runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1] }]));
  assert.equal(r.perQuery[0].firstHitRank, 2);
  assert.equal(r.perQuery[0].rr, 0.5);
  db.close();
});

test("secondary hits earn partial nDCG credit, never full", () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 2, chunks: ["reciprocal rank fusion combines ranked lists"] });
  const r = runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1], secondary: [2] }]));
  assert.ok(r.aggregate.ndcg10 > 0, "secondary should score something");
  assert.ok(r.aggregate.ndcg10 < 1, "secondary must not score a perfect run");
  assert.equal(r.aggregate.recall5, 0, "recall counts primaries only");
  db.close();
});

test("a query that errors is recorded, not thrown, and does not abort the run", () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["anything at all here"] });
  const r = runEval(db, goldOf([
    { id: 1, q: "what is DAI?", primary: [1] },
    { id: 2, q: "anything", primary: [1] },
  ]), { raw: true });
  assert.equal(r.aggregate.errors, 1);
  assert.equal(r.perQuery.length, 2, "the run continued past the error");
  db.close();
});

test("negatives appearing in the top 5 are counted", () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 9, chunks: ["chromaprint fingerprint alignment offset"] });
  const r = runEval(db, goldOf([{ id: 1, q: "alignment", primary: [1], negative: [9] }]));
  assert.deepEqual(r.perQuery[0].negativesInTop5, [9]);
  assert.equal(r.aggregate.negativeHits, 1);
  db.close();
});

test("eval runs the same retriever the CLI does", () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["reciprocal rank fusion combines ranked lists"] });
  const r = runEval(db, goldOf([{ id: 1, q: "reciprocal rank fusion", primary: [1] }]));
  const direct = sourcesInOrder(keywordSearch(db, "reciprocal rank fusion", { limit: 8 }).rows);
  assert.deepEqual(r.perQuery[0].top5, direct.slice(0, 5));
  db.close();
});

test("evaluation depth defaults to the CLI's own limit", () => {
  const { db } = tmpDb();
  seed(db, { sourceId: 1, chunks: ["alpha"] });
  assert.equal(runEval(db, goldOf([{ id: 1, q: "alpha", primary: [1] }])).limit, 8);
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

test("rechunk refuses to run when embeddings would be destroyed", () => {
  // chunks is the FK parent of any future vector; rewriting them discards it.
  const { db, dir } = tmpDb();
  const a = withArchive(dir, "rechunk-test-embed.md", `# H\n\n${"word ".repeat(400)}`);
  seed(db, { sourceId: 1, mdRelPath: a, chunks: ["has a vector"] });
  db.exec("UPDATE chunks SET embedding = x'00000000'");
  assert.throws(() => rechunkAll(db, { corpusRoot: dir }), /embeddings/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM chunks WHERE embedding IS NOT NULL").get().n, 1);
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
