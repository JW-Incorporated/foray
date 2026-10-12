/* GV-28 (W3-07, docs/roadmap/generation-v2.md): the passage store. Synthetic
   cutter lines, in-memory or tmp node:sqlite files and the stub embedder; no
   model, no network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { estTokens } from "../corpus/chunk.mjs";
import { fromBlob, l2Normalize } from "../corpus/vectors.mjs";
import { createPassageEmbedder, stubVector } from "./embedder.mjs";
import { parseIndexDbArgs, runIndexDb } from "./index-db.mjs";
import {
  backfillEmbeddings,
  createServerPassageStore,
  denseSearch,
  EMBED_CHUNK_MAX,
  embedQuery,
  findModel,
  ingestPassages,
  loadDenseIndex,
  openStore,
  readShortlist,
  registerModel,
  replaceShortlist,
  splitForEmbedding,
} from "./store.mjs";

/** A cutter line (backend/src/generation/passageCutter.ts `Passage`). */
function passage(show_id, guid, i, text, extra = {}) {
  return {
    id: `${show_id}-${guid}-${i}`.padEnd(16, "0"),
    show_id,
    guid,
    firstCue: i * 10,
    lastCue: i * 10 + 9,
    startSec: i * 120,
    endSec: i * 120 + 120,
    startBoundary: "sentence",
    endBoundary: i % 2 ? "turn" : "cue",
    startAnchor: "first words here",
    endAnchor: null,
    text,
    indexVersion: 1,
    ...extra,
  };
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** Sentences of distinct filler words, about `chars` long, sharing no word with
 * the query sentences below. */
function filler(chars, seed = 0) {
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
  const out = [];
  let n = 0;
  let i = seed;
  while (n < chars) {
    const s = `${words.slice(i % 12).concat(words.slice(0, i % 12)).slice(0, 8).join(" ")}.`;
    out.push(s[0].toUpperCase() + s.slice(1));
    n += s.length + 1;
    i++;
  }
  return out.join(" ");
}

const QUERY = "Semmelweis handwashing childbed fever";

function count(db, sql, ...args) {
  return db.prepare(sql).get(...args).n;
}

test("the migration builds the three tables; an absent store is refused unless created", () => {
  const db = openStore(":memory:");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of ["embedding_models", "passage_chunks", "passages"]) assert.ok(tables.includes(t), t);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'passages'").all().map((r) => r.name);
  assert.ok(idx.includes("idx_passages_episode"));
  db.close();

  const dir = mkdtempSync(join(tmpdir(), "gv28-open-"));
  try {
    assert.throws(() => openStore(join(dir, "none.db")), /no passage store/);
    const created = openStore(join(dir, "sub", "p.db"), { create: true });
    created.close();
    openStore(join(dir, "sub", "p.db")).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingest is idempotent per episode and a re-ingest drops stale chunk vectors through the cascade", async () => {
  const db = openStore(":memory:");
  const a = [passage("showa", "g1", 0, "one two three."), passage("showa", "g1", 1, "four five six.")];
  const b = [passage("showb", "g2", 0, "seven eight nine.")];
  const first = await ingestPassages(db, jsonl([...a, ...b]));
  assert.deepEqual(first, { episodes: 2, passages: 3, removed: 0, lines: 3 });
  const again = await ingestPassages(db, jsonl([...a, ...b]));
  assert.equal(again.passages, 3);
  assert.equal(again.removed, 3);
  assert.equal(count(db, "SELECT COUNT(*) n FROM passages"), 3);

  const stored = db.prepare("SELECT * FROM passages WHERE id = ?").get(a[1].id);
  assert.equal(stored.start_sec, 120);
  assert.equal(stored.end_boundary, "turn");
  assert.equal(stored.start_anchor, "first words here");
  assert.equal(stored.end_anchor, null);
  assert.equal(stored.index_version, 1);

  const embedder = await createPassageEmbedder({ kind: "stub" });
  await backfillEmbeddings(db, embedder);
  assert.equal(count(db, "SELECT COUNT(*) n FROM passage_chunks"), 3);

  /* Episode showa/g1 is re-cut into one different passage: its two old
     passages and their vectors go; showb/g2 keeps its vector. */
  const recut = [passage("showa", "g1", 7, "a re-cut passage.")];
  const r = await ingestPassages(db, jsonl(recut));
  assert.deepEqual(r, { episodes: 1, passages: 1, removed: 2, lines: 1 });
  assert.deepEqual(
    db.prepare("SELECT id FROM passages ORDER BY id").all().map((x) => x.id),
    [recut[0].id, b[0].id].sort()
  );
  assert.equal(count(db, "SELECT COUNT(*) n FROM passage_chunks WHERE passage_id IN (?, ?)", a[0].id, a[1].id), 0);
  assert.equal(count(db, "SELECT COUNT(*) n FROM passage_chunks WHERE passage_id = ?", b[0].id), 1);
  db.close();
});

test("an appended re-stream wins: the last block of an episode replaces the earlier one; bad lines are named", async () => {
  const db = openStore(":memory:");
  const old = [passage("s", "g", 0, "old text."), passage("s", "g", 1, "old tail.")];
  const other = [passage("t", "h", 0, "other.")];
  const fresh = [passage("s", "g", 0, "new text.")];
  const r = await ingestPassages(db, `${jsonl([...old, ...other])}\r\n${jsonl(fresh)}`);
  assert.equal(r.episodes, 3);
  assert.deepEqual(
    db.prepare("SELECT text FROM passages WHERE show_id = 's'").all().map((x) => x.text),
    ["new text."]
  );
  await assert.rejects(ingestPassages(db, `${jsonl(fresh)}{not json\n`), /line 2: not JSON/);
  await assert.rejects(ingestPassages(db, jsonl([{ ...fresh[0], startBoundary: "pause" }])), /line 1: startBoundary/);
  await assert.rejects(ingestPassages(db, jsonl([{ ...fresh[0], guid: "" }])), /line 1: guid/);
  db.close();
});

test("the trigger rejects a vector of the wrong length, on insert and on update, and an unregistered model", async () => {
  const db = openStore(":memory:");
  await ingestPassages(db, jsonl([passage("s", "g", 0, "words.")]));
  const model = registerModel(db, { name: "m", revision: "1", dim: 4, pooling: "mean" });
  const ins = db.prepare("INSERT INTO passage_chunks (passage_id, ord, model_id, vector) VALUES (?, ?, ?, ?)");
  const id = db.prepare("SELECT id FROM passages").get().id;
  assert.throws(() => ins.run(id, 0, model.id, new Uint8Array(12)), /4 \* the registered model dim/);
  assert.throws(() => ins.run(id, 0, model.id + 99, new Uint8Array(16)), /4 \* the registered model dim|FOREIGN KEY/);
  ins.run(id, 0, model.id, new Uint8Array(16));
  assert.throws(
    () => db.prepare("UPDATE passage_chunks SET vector = ? WHERE passage_id = ?").run(new Uint8Array(20), id),
    /4 \* the registered model dim/
  );
  db.close();
});

test("registerModel returns the same row, updates query_prefix in place and refuses a space change", () => {
  const db = openStore(":memory:");
  const spec = { name: "m", revision: "1", dim: 8, pooling: "cls", query_prefix: "q: ", passage_prefix: "" };
  const a = registerModel(db, spec);
  assert.equal(registerModel(db, spec).id, a.id);
  assert.equal(registerModel(db, { ...spec, query_prefix: "Q: " }).query_prefix, "Q: ");
  assert.throws(() => registerModel(db, { ...spec, dim: 16 }), /different vector-space settings: dim/);
  assert.throws(() => registerModel(db, { ...spec, passage_prefix: "p: " }), /passage_prefix/);
  assert.notEqual(registerModel(db, { ...spec, revision: "2", dim: 16 }).id, a.id);
  db.close();
});

test("splitForEmbedding packs sentences under the limit and never truncates", () => {
  const long = filler(5000);
  const chunks = splitForEmbedding(long);
  assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`);
  for (const c of chunks) assert.ok(estTokens(c) <= EMBED_CHUNK_MAX, `chunk of ${estTokens(c)} tokens`);
  assert.equal(chunks.join(" "), long.split(/\s+/).join(" "));
  for (const c of chunks) assert.match(c, /\.$/, "whole sentences while they fit");

  /* The model's tokenizer when it has one (a word count here). */
  const words = (s) => s.split(/\s+/).length;
  const byWords = splitForEmbedding("one two three. four five six seven eight nine ten. eleven.", { maxTokens: 4, countTokens: words });
  assert.deepEqual(byWords, ["one two three.", "four five six seven", "eight nine ten. eleven."]);

  /* A word over the limit is cut, not dropped. */
  const cut = splitForEmbedding(`x ${"y".repeat(20)} z`, { maxTokens: 2 });
  assert.equal(cut.join(""), `x${"y".repeat(20)}z`);
  for (const c of cut) assert.ok(estTokens(c) <= 2);

  assert.deepEqual(splitForEmbedding("   "), []);
  assert.deepEqual(splitForEmbedding("short text."), ["short text."]);
});

test("backfill embeds every sub-chunk of a long passage with the model row's passage prefix, and resumes", async () => {
  const db = openStore(":memory:");
  const longText = `${filler(3000)} ${QUERY}.`;
  await ingestPassages(db, jsonl([passage("s", "g", 0, longText), passage("s", "g", 1, "a short one."), passage("s", "g", 2, " ")]));
  const stub = await createPassageEmbedder({ kind: "stub", passagePrefix: "passage: " });
  const seen = [];
  const embedder = { ...stub, embed: async (texts) => (seen.push(texts.length), texts.forEach((t) => assert.ok(t.startsWith("passage: "))), stub.embed(texts)) };

  const report = await backfillEmbeddings(db, embedder, { batch: 2 });
  const expected = splitForEmbedding(longText);
  assert.ok(expected.length >= 2);
  assert.equal(report.tokenizer, "chars/4");
  assert.equal(report.passages, 2);
  assert.equal(report.emptyPassages, 1);
  assert.equal(report.chunks, expected.length + 1);
  assert.equal(report.chunksPerPassage.max, expected.length);
  assert.equal(report.chunksPerPassage.min, 1);
  assert.deepEqual(report.chunksPerPassage.histogram, { 1: 1, [expected.length]: 1 });
  assert.ok(seen.every((n) => n <= 2), "batches of at most 2");

  const id = passage("s", "g", 0, "").id;
  const rows = db.prepare("SELECT ord, vector FROM passage_chunks WHERE passage_id = ? ORDER BY ord").all(id);
  assert.deepEqual(rows.map((r) => r.ord), expected.map((_, i) => i));
  rows.forEach((r, i) => {
    const want = l2Normalize(stubVector(`passage: ${expected[i]}`));
    const got = fromBlob(r.vector);
    for (let j = 0; j < want.length; j++) assert.ok(Math.abs(got[j] - want[j]) < 1e-6);
  });

  const again = await backfillEmbeddings(db, embedder);
  assert.equal(again.passages, 0);
  assert.equal(again.chunks, 0);

  const withTokenizer = await backfillEmbeddings(db, await createPassageEmbedder({ kind: "stub", revision: "tok", tokenizer: true }));
  assert.equal(withTokenizer.tokenizer, "model");
  await assert.rejects(backfillEmbeddings(db, { ...stub, model: { ...stub.model, revision: "x" }, embed: async (t) => t.map(() => new Float32Array(3)) }), /3-dim vector/);
  db.close();
});

test("denseSearch scores a passage by its best chunk, respects episodeFilter and returns the top k", async () => {
  const db = openStore(":memory:");
  /* Small chunks (20 chars/4 tokens, about one sentence each) so the query
     sentence is a chunk of its own inside a long passage. */
  const SMALL = 20;
  /* Another chunk shares one query word, so max and sum differ. */
  const long = `${filler(600)} Fever charts. ${QUERY}. ${filler(200, 3)}`;
  const rows = [
    passage("s1", "e1", 0, long),
    passage("s1", "e1", 1, `${filler(300, 5)} fever charts.`),
    passage("s2", "e2", 0, `${QUERY} again, Semmelweis.`),
    passage("s2", "e3", 0, filler(200, 7)),
  ];
  await ingestPassages(db, jsonl(rows));
  const embedder = await createPassageEmbedder({ kind: "stub", queryPrefix: "query: " });
  await backfillEmbeddings(db, embedder, { maxTokens: SMALL });
  const model = registerModel(db, embedder.model);
  const index = loadDenseIndex(db, model.id);
  assert.equal(index.passages.length, 4);
  assert.equal(index.episodes.size, 3);

  const q = await embedQuery(embedder, model, QUERY);
  assert.deepEqual(Array.from(q), Array.from(stubVector(`query: ${QUERY}`)));

  const chunks = splitForEmbedding(long, { maxTokens: SMALL });
  assert.ok(chunks.length >= 3);
  assert.equal(index.chunks, rows.reduce((n, r) => n + splitForEmbedding(r.text, { maxTokens: SMALL }).length, 0));
  const qn = l2Normalize(Float32Array.from(q));
  const sims = chunks.map((c) => {
    const v = l2Normalize(stubVector(c));
    return v.reduce((s, x, i) => s + x * qn[i], 0);
  });
  const bestSim = Math.max(...sims);
  assert.ok(bestSim > sims[0] + 0.1, "the query matches a later chunk, not the first");
  assert.ok(sims.filter((x) => x > 0.01).length >= 2, "more than one chunk scores");

  const onlyE1 = denseSearch(index, q, { episodeFilter: [["s1", "e1"]], k: 5 });
  assert.deepEqual(onlyE1.map((h) => h.passageId), [rows[0].id, rows[1].id]);
  assert.ok(Math.abs(onlyE1[0].sim - bestSim) < 1e-5, `best-chunk score ${onlyE1[0].sim} vs ${bestSim}`);
  assert.deepEqual(Object.keys(onlyE1[0]).sort(), ["guid", "passageId", "show_id", "sim"]);

  const all = denseSearch(index, q, { k: 2 });
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((h) => h.passageId), [rows[0].id, rows[2].id]);

  const objs = denseSearch(index, q, { episodeFilter: [{ show_id: "s2", guid: "e3" }, ["nope", "x"]], k: 5 });
  assert.deepEqual(objs.map((h) => h.passageId), [rows[3].id]);
  assert.deepEqual(denseSearch(index, q, { episodeFilter: [], k: 5 }), []);
  assert.throws(() => denseSearch(index, new Float32Array(3)), /3 dims/);
  db.close();
});

test("migration 0002: node_shortlist holds at most 50 ranks per node, is replaced whole, and loses rows with their passages", async () => {
  /* MUTATIONS THAT KILL THIS: drop the `rank < 50` CHECK (the 51-row write
     commits); drop the BEGIN/ROLLBACK around replaceShortlist (the failed
     write leaves the node half replaced); drop ON DELETE CASCADE (a re-cut
     episode's old passage stays in the shortlist). Ran all three — red. */
  const db = openStore(":memory:");
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
  const cols = db.prepare("PRAGMA table_info(node_shortlist)").all().map((c) => c.name);
  assert.deepEqual(cols, ["node_id", "rank", "passage_id", "score", "built_at"]);

  const rows = Array.from({ length: 51 }, (_x, i) => passage("s1", `e${Math.floor(i / 10)}`, i % 10, `text ${i}.`));
  await ingestPassages(db, jsonl(rows));
  const fifty = rows.slice(0, 50).map((p, rank) => ({ rank, passageId: p.id, score: 1 - rank / 100 }));
  replaceShortlist(db, "medicine", fifty, "2026-10-12T00:00:00.000Z");
  const stored = readShortlist(db, "medicine");
  assert.equal(stored.length, 50);
  assert.deepEqual(stored[0], { rank: 0, passageId: rows[0].id, score: 1, builtAt: "2026-10-12T00:00:00.000Z" });

  /* A 51st rank aborts the whole write; the old 50 stay. */
  const tooMany = rows.map((p, rank) => ({ rank, passageId: p.id, score: 0 }));
  assert.throws(() => replaceShortlist(db, "medicine", tooMany, "2026-10-13T00:00:00.000Z"), /CHECK constraint/);
  assert.deepEqual(readShortlist(db, "medicine"), stored);
  /* One passage once per node; an unknown passage is refused. */
  assert.throws(() => replaceShortlist(db, "x", [{ rank: 0, passageId: rows[0].id, score: 1 }, { rank: 1, passageId: rows[0].id, score: 1 }], "t"), /UNIQUE/);
  assert.throws(() => replaceShortlist(db, "x", [{ rank: 0, passageId: "nope", score: 1 }], "t"), /FOREIGN KEY/);
  assert.deepEqual(readShortlist(db, "x"), []);

  /* Replace with fewer rows; another node is untouched. */
  replaceShortlist(db, "science", [{ rank: 0, passageId: rows[50].id, score: 0.5 }], "t2");
  replaceShortlist(db, "medicine", fifty.slice(0, 3), "t3");
  assert.deepEqual(readShortlist(db, "medicine").map((r) => r.builtAt), ["t3", "t3", "t3"]);
  assert.equal(readShortlist(db, "science").length, 1);

  /* Re-cutting episode e0 deletes its passages and, through the cascade, their rows. */
  await ingestPassages(db, jsonl([passage("s1", "e0", 9, "a re-cut passage.")]));
  assert.deepEqual(readShortlist(db, "medicine"), []);
  db.close();
});

test("createServerPassageStore: the retrieval server's PassageStore and QueryEmbedder over the real store", async () => {
  /* MUTATION THAT KILLS THIS: in passagesById return rows in store order
     instead of the order asked (the reversed lookup comes back unreversed).
     Ran it (ids sorted) — red. */
  const db = openStore(":memory:");
  const rows = [
    passage("s1", "e1", 1, `${QUERY}.`, { startAnchor: "Semmelweis handwashing childbed" }),
    passage("s1", "e1", 0, filler(80)),
    passage("s2", "e2", 0, `${QUERY} again.`),
    passage("s3", "e3", 0, filler(80, 4)),
  ];
  await ingestPassages(db, jsonl(rows));

  const lexical = createServerPassageStore(db);
  assert.equal(lexical.queryEmbedder, null);
  assert.deepEqual(lexical.passageStore.denseSearch(new Float32Array(64), { episodes: null, k: 5 }), []);

  const embedder = await createPassageEmbedder({ kind: "stub", queryPrefix: "query: " });
  const { passageStore, queryEmbedder } = createServerPassageStore(db, { embedder });
  /* No vectors yet: no model row, nothing found, and a query is refused. */
  assert.equal(findModel(db, embedder.model), null);
  await assert.rejects(queryEmbedder.embedQuery(QUERY), /no vectors in this store yet/);
  await backfillEmbeddings(db, embedder);
  assert.deepEqual(passageStore.denseSearch(new Float32Array(64).fill(1), { episodes: null, k: 5 }), []);
  passageStore.reload();

  const q = await queryEmbedder.embedQuery(QUERY);
  assert.deepEqual(Array.from(q), Array.from(stubVector(`query: ${QUERY}`)));
  const hits = passageStore.denseSearch(q, { episodes: [["s1", "e1"], ["s3", "e3"]], k: 10 });
  assert.deepEqual(new Set(hits.map((h) => h.guid)), new Set(["e1", "e3"]));
  assert.equal(hits[0].passageId, rows[0].id);
  assert.equal(passageStore.denseSearch(q, { episodes: null, k: Infinity }).length, 4);

  const byId = passageStore.passagesById([rows[2].id, "missing", rows[0].id]);
  assert.deepEqual(byId.map((p) => p.passageId), [rows[2].id, rows[0].id]);
  assert.deepEqual(byId[1], {
    passageId: rows[0].id,
    show_id: "s1",
    guid: "e1",
    startSec: 120,
    endSec: 240,
    startBoundary: "sentence",
    endBoundary: "turn",
    startAnchor: "Semmelweis handwashing childbed",
    endAnchor: null,
    text: `${QUERY}.`,
  });
  /* Episode by episode in the order given, by start time within one. */
  assert.deepEqual(
    passageStore.passagesForEpisodes([["s2", "e2"], ["s1", "e1"], ["s2", "e2"]]).map((p) => p.passageId),
    [rows[2].id, rows[1].id, rows[0].id]
  );
  passageStore.replaceShortlist("medicine", [{ rank: 0, passageId: rows[2].id, score: 0.9 }], "t");
  assert.deepEqual(passageStore.readShortlist("medicine"), [{ rank: 0, passageId: rows[2].id, score: 0.9, builtAt: "t" }]);
  db.close();
});

test("index-db: ingest then embed through the CLI, with argument checks", async () => {
  assert.throws(() => parseIndexDbArgs([]), /unknown command/);
  assert.throws(() => parseIndexDbArgs(["ingest"]), /needs --passages/);
  assert.throws(() => parseIndexDbArgs(["embed", "--embedder", "claude"]), /needs --embedder stub\|transformers\|openai/);
  assert.throws(() => parseIndexDbArgs(["embed", "--embedder", "stub", "--passages", "x"]), /unknown flag --passages/);
  assert.throws(() => parseIndexDbArgs(["embed", "--embedder", "stub", "--batch", "0"]), /--batch/);

  const dir = mkdtempSync(join(tmpdir(), "gv28-cli-"));
  try {
    const file = join(dir, "passages.jsonl");
    writeFileSync(file, jsonl([passage("s", "g", 0, `${filler(2000)}`), passage("s", "g", 1, "tail.")]));
    const dbPath = join(dir, "store", "passages.db");
    const out = [];
    const stdout = { write: (s) => out.push(s) };
    const ing = await runIndexDb(parseIndexDbArgs(["ingest", "--passages", file, "--db", dbPath]), { stdout });
    assert.equal(ing.passages, 2);
    const emb = await runIndexDb(parseIndexDbArgs(["embed", "--embedder", "stub", "--db", dbPath, "--batch", "4"]), { stdout });
    assert.equal(emb.passages, 2);
    assert.ok(emb.chunks >= 3);
    assert.equal(emb.model.name, "stub-hash");
    assert.equal(out.length, 2);
    assert.deepEqual(JSON.parse(out[1]).chunksPerPassage, emb.chunksPerPassage);
    await assert.rejects(runIndexDb(parseIndexDbArgs(["embed", "--embedder", "stub", "--db", join(dir, "absent.db")]), { stdout }), /no passage store/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
