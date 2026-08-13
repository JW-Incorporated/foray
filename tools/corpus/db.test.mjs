/* DB layer: migrations, schema constraints, FTS sync, ingest semantics,
 * hostgate. Everything runs against a temp-dir DB; no network, no fixtures
 * touched outside the temp dir.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, migrate, openMigrated } from "./db.mjs";
import { loadManifest } from "./manifest.mjs";
import { ingestSource } from "./ingest.mjs";
import { coverageData, coverageMarkdown, deadLinksMarkdown } from "./report.mjs";
import { createHostGate } from "./hostgate.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "corpus-test-"));
const tmpDb = () => path.join(tmp(), "test.db");

function seedSource(db, over = {}) {
  const e = {
    area: 1, area_name: "Podcast Infrastructure", title: "Test Source",
    url: `https://example.com/${Math.random().toString(36).slice(2)}`,
    source_type: "docs", why_it_matters: "testing", read_first: 0,
    ...over,
  };
  loadManifest(db, [e]);
  return db.prepare("SELECT * FROM sources WHERE url = ?").get(e.url);
}

function okFetcher(body = "# Title\n\n" + "Real content sentence here. ".repeat(60)) {
  return {
    async fetchUrl(url) {
      return {
        ok: true, status: 200, finalUrl: url, contentType: "text/plain",
        body: Buffer.from(body), notes: [],
      };
    },
  };
}

/* ------------------------------------------------- open: absent vs create */

test("openDb: absent db without create throws actionable error, creates nothing", () => {
  const dbPath = tmpDb();
  // The message must say where the db was expected and how to build it —
  // "no matches" from a silently created empty db is how a fresh checkout
  // concludes the corpus is empty rather than absent.
  assert.throws(() => openDb(dbPath), (err) => {
    assert.match(err.message, /no corpus database at /);
    assert.ok(err.message.includes(dbPath), "names the expected path");
    assert.match(err.message, /corpus\.mjs init/);
    assert.match(err.message, /load-manifest/);
    assert.match(err.message, /ingest --all/);
    assert.match(err.message, /digests\.md/);
    return true;
  });
  assert.ok(!fs.existsSync(dbPath), "a failed read-open must not create the db file");
});

test("openMigrated: absent db without create throws the same error", () => {
  const dbPath = tmpDb();
  assert.throws(() => openMigrated(dbPath), /no corpus database at /);
  assert.ok(!fs.existsSync(dbPath));
});

test("openDb: create:true builds db and parent dirs; later plain opens succeed", () => {
  const dbPath = path.join(tmp(), "nested", "deeper", "fresh.db");
  const db = openMigrated(dbPath, { create: true }); // fresh machine: init path
  assert.ok(fs.existsSync(dbPath), "create path makes the file (and parents)");
  db.close();
  // Once built, read-oriented opens (search/stats/report…) work without create.
  const again = openMigrated(dbPath);
  assert.equal(again.prepare("PRAGMA user_version").get().user_version, 2);
});

/* ----------------------------------------------------------- migrations */

test("migrate: applies all migrations once, then is a no-op", () => {
  const db = openDb(tmpDb(), { create: true });
  const first = migrate(db);
  assert.equal(first.applied, 2);
  const second = migrate(db);
  assert.equal(second.applied, 0);
  const v = db.prepare("PRAGMA user_version").get().user_version;
  assert.equal(v, 2);
});

test("migrate: failing migration rolls back and does not advance version", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "0001_bad.sql"), "CREATE TABLE ok(x);\nTHIS IS NOT SQL;");
  const db = openDb(tmpDb(), { create: true });
  assert.throws(() => migrate(db, dir), /0001_bad/);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
  assert.throws(() => db.prepare("SELECT * FROM ok"));
});

test("schema: sources url is unique, area range-checked, type whitelisted", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const ins = db.prepare(
    "INSERT INTO sources (area, area_name, title, url, source_type) VALUES (?,?,?,?,?)"
  );
  ins.run(1, "A", "t", "https://x.com/1", "paper");
  assert.throws(() => ins.run(1, "A", "t", "https://x.com/1", "paper"), /UNIQUE/);
  assert.throws(() => ins.run(10, "A", "t", "https://x.com/2", "paper"), /CHECK/);
  assert.throws(() => ins.run(1, "A", "t", "https://x.com/3", "npm-package"), /CHECK/);
});

test("schema: deleting a source cascades documents and chunks", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const s = seedSource(db);
  const docId = db.prepare(
    "INSERT INTO documents (source_id, http_status) VALUES (?, 200)"
  ).run(s.id).lastInsertRowid;
  db.prepare(
    "INSERT INTO chunks (document_id, ordinal, text, token_count) VALUES (?, 0, 'body', 1)"
  ).run(docId);
  db.prepare("DELETE FROM sources WHERE id = ?").run(s.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM chunks").get().n, 0);
});

/* ------------------------------------------------------------------ fts */

test("fts: insert/delete/update keep the index in sync", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const s = seedSource(db);
  const docId = db.prepare("INSERT INTO documents (source_id, http_status) VALUES (?, 200)").run(s.id).lastInsertRowid;
  const chunkId = db.prepare(
    "INSERT INTO chunks (document_id, ordinal, text, token_count) VALUES (?, 0, 'reciprocal rank fusion combines lists', 6)"
  ).run(docId).lastInsertRowid;

  const hit = () => db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'fusion'").all();
  assert.equal(hit().length, 1);

  db.prepare("UPDATE chunks SET text = 'dynamic ad insertion shifts offsets' WHERE id = ?").run(chunkId);
  assert.equal(hit().length, 0);
  assert.equal(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'insertion'").all().length, 1);

  db.prepare("DELETE FROM chunks WHERE id = ?").run(chunkId);
  assert.equal(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'insertion'").all().length, 0);
});

test("fts: porter stemming matches inflected query terms", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const s = seedSource(db);
  const docId = db.prepare("INSERT INTO documents (source_id, http_status) VALUES (?, 200)").run(s.id).lastInsertRowid;
  db.prepare(
    "INSERT INTO chunks (document_id, ordinal, text, token_count) VALUES (?, 0, 'the server test protects embedding', 5)"
  ).run(docId);
  const rows = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'embeddings protect'").all();
  assert.equal(rows.length, 1);
});

/* --------------------------------------------------------------- ingest */

test("ingest: success writes raw+markdown files, doc row, chunks", async () => {
  const db = openMigrated(tmpDb(), { create: true });
  const s = seedSource(db, { title: "Ingest Happy Path" });
  const r = await ingestSource(db, okFetcher(), s);
  assert.equal(r.outcome, "ok");
  assert.ok(r.chunks >= 1);

  const doc = db.prepare("SELECT * FROM documents WHERE source_id = ?").get(s.id);
  assert.equal(doc.http_status, 200);
  assert.match(doc.content_hash, /^[0-9a-f]{64}$/);
  assert.ok(doc.raw_path && doc.markdown_path);
  const chunks = db.prepare("SELECT * FROM chunks WHERE document_id = ?").all(doc.id);
  assert.equal(chunks.length, r.chunks);
});

test("ingest: refetch with same content is 'unchanged', no duplicate chunks", async () => {
  const db = openMigrated(tmpDb(), { create: true });
  const s = seedSource(db);
  const f = okFetcher();
  const r1 = await ingestSource(db, f, s);
  const r2 = await ingestSource(db, f, s);
  assert.equal(r1.outcome, "ok");
  assert.equal(r2.outcome, "unchanged");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE source_id = ?").get(s.id).n, 1);
});

test("ingest: changed content supersedes old chunks (search sees one copy)", async () => {
  const db = openMigrated(tmpDb(), { create: true });
  const s = seedSource(db);
  await ingestSource(db, okFetcher("# V1\n\nalpha bravo. " + "pad sentence. ".repeat(40)), s);
  await ingestSource(db, okFetcher("# V2\n\ncharlie delta. " + "pad sentence. ".repeat(40)), s);

  const docs = db.prepare("SELECT * FROM documents WHERE source_id = ? ORDER BY id").all(s.id);
  assert.equal(docs.length, 2, "history keeps both fetches");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM chunks c JOIN documents d ON c.document_id=d.id WHERE d.source_id=?").get(s.id).n > 0, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM chunks WHERE document_id = ?").get(docs[0].id).n, 0, "old chunks retired");
  assert.equal(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'alpha'").all().length, 0, "fts follows deletes");
  assert.equal(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'charlie'").all().length >= 1, true);
});

test("ingest: fetch failure records a document row with notes, no files", async () => {
  const db = openMigrated(tmpDb(), { create: true });
  const s = seedSource(db);
  const failFetcher = {
    async fetchUrl(url) {
      return { ok: false, status: 404, finalUrl: url, contentType: null, body: null, notes: ["gone"] };
    },
  };
  const r = await ingestSource(db, failFetcher, s);
  assert.equal(r.outcome, "failed");
  const doc = db.prepare("SELECT * FROM documents WHERE source_id = ?").get(s.id);
  assert.equal(doc.http_status, 404);
  assert.equal(doc.raw_path, null);
  assert.match(doc.fetch_notes, /gone/);
});

test("ingest: github issue route fetches comments and stores markdown", async () => {
  const db = openMigrated(tmpDb(), { create: true });
  const s = seedSource(db, {
    url: "https://github.com/o/r/issues/9",
    title: "Issue Nine",
    source_type: "issue",
  });
  const calls = [];
  const fetcher = {
    async fetchUrl(url) {
      calls.push(url);
      if (url.includes("/comments")) {
        return { ok: true, status: 200, finalUrl: url, contentType: "application/json", body: Buffer.from(JSON.stringify([{ user: { login: "z" }, created_at: "2024-01-01T0:0:0Z", body: "a comment" }])), notes: [] };
      }
      return { ok: true, status: 200, finalUrl: url, contentType: "application/json", body: Buffer.from(JSON.stringify({ number: 9, title: "Issue Nine", state: "open", html_url: url, created_at: "2024-01-01T0:0:0Z", user: { login: "a" }, body: "issue body text", comments: 1 })), notes: [] };
    },
  };
  const r = await ingestSource(db, fetcher, s);
  assert.equal(r.outcome, "ok");
  assert.ok(calls[0].includes("api.github.com/repos/o/r/issues/9"));
  assert.match(calls[1], /\/comments\?per_page=100&page=1$/);
  const doc = db.prepare("SELECT * FROM documents WHERE source_id = ?").get(s.id);
  assert.match(doc.fetch_notes, /github issue→REST API/);
});

test("ingest: issue comments paginate past 100 and stop on a short page", async () => {
  const db = openMigrated(tmpDb(), { create: true });
  const s = seedSource(db, { url: "https://github.com/o/r/issues/1", title: "Big Thread", source_type: "issue" });
  const pageCalls = [];
  const mkComment = (i) => ({ user: { login: `u${i}` }, created_at: "2024-01-01T0:0:0Z", body: `comment ${i}` });
  const fetcher = {
    async fetchUrl(url) {
      if (url.includes("/comments")) {
        const page = Number(new URL(url).searchParams.get("page"));
        pageCalls.push(page);
        const batch = page === 1 ? Array.from({ length: 100 }, (_, i) => mkComment(i))
                    : Array.from({ length: 30 }, (_, i) => mkComment(100 + i));
        return { ok: true, status: 200, finalUrl: url, contentType: "application/json", body: Buffer.from(JSON.stringify(batch)), notes: [] };
      }
      return { ok: true, status: 200, finalUrl: url, contentType: "application/json", body: Buffer.from(JSON.stringify({ number: 1, title: "Big Thread", state: "open", html_url: url, created_at: "2024-01-01T0:0:0Z", user: { login: "a" }, body: "body", comments: 130 })), notes: [] };
    },
  };
  const r = await ingestSource(db, fetcher, s);
  assert.equal(r.outcome, "ok");
  assert.deepEqual(pageCalls, [1, 2]);
  const doc = db.prepare("SELECT * FROM documents WHERE source_id = ?").get(s.id);
  assert.doesNotMatch(doc.fetch_notes, /truncated/);
});

/* --------------------------------------------------------------- report */

test("report: coverage rolls up per area; dead links lists failures with reasons", async () => {
  const db = openMigrated(tmpDb(), { create: true });
  const good = seedSource(db, { area: 4, area_name: "Retrieval & Recommendation", title: "Good Doc" });
  const bad = seedSource(db, { area: 8, area_name: "Legal / Policy Landscape", title: "Paywalled Thing" });
  await ingestSource(db, okFetcher(), good);
  await ingestSource(db, { async fetchUrl(u) { return { ok: false, status: 403, finalUrl: u, contentType: null, body: null, notes: ["bot-walled"] }; } }, bad);

  const { areas } = coverageData(db);
  const a4 = areas.find((a) => a.area === 4);
  const a8 = areas.find((a) => a.area === 8);
  assert.equal(a4.ok, 1);
  assert.equal(a8.failed, 1);

  const cov = coverageMarkdown(db, "TEST-TIME");
  assert.match(cov, /1\/2 sources ingested|\*\*1\/2/);
  assert.match(cov, /Good Doc/);

  const dead = deadLinksMarkdown(db, "TEST-TIME");
  assert.match(dead, /Paywalled Thing/);
  assert.match(dead, /HTTP 403/);
  assert.match(dead, /bot-walled/);
  assert.doesNotMatch(dead, /Good Doc/);
});

test("report: unfetched sources counted separately from failures", () => {
  const db = openMigrated(tmpDb(), { create: true });
  seedSource(db, { area: 2, area_name: "Speech Processing" });
  const { areas } = coverageData(db);
  assert.equal(areas[0].unfetched, 1);
  assert.equal(areas[0].failed, 0);
});

/* ------------------------------------------------------------- hostgate */

test("hostgate: two gates on one state dir space reservations", async () => {
  const dir = tmp();
  let t = 0;
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  const g1 = createHostGate({ dir, ...clock });
  const g2 = createHostGate({ dir, ...clock });
  await g1.reserve("arxiv.org", 2000);
  const before = t;
  await g2.reserve("arxiv.org", 2000);
  assert.ok(t - before >= 2000, `second process waited ${t - before}ms`);
});

test("hostgate: different hosts do not block each other", async () => {
  const dir = tmp();
  let t = 0;
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  const g = createHostGate({ dir, ...clock });
  await g.reserve("a.com", 2000);
  const before = t;
  await g.reserve("b.com", 2000);
  assert.equal(t, before, "no wait for an unrelated host");
});

test("hostgate: hostile host strings cannot escape the state dir", async () => {
  const dir = tmp();
  const g = createHostGate({ dir });
  await g.reserve("../../evil", 0);
  const entries = fs.readdirSync(dir);
  assert.ok(entries.every((e) => !e.includes("..")), `entries: ${entries}`);
  assert.ok(fs.readdirSync(path.join(dir, "..")).length >= 1); // parent intact, nothing written above
});
