/* ingestCapturedText: the rendered-HTML route (README.md#rendered-html-route).
 * Covers what a normal fetch-based ingest gets from fetcher.mjs/extract.mjs
 * for free — chunking, archiving, supersession, unchanged-detection — now
 * exercised for the path that skips both of those modules.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMigrated } from "./db.mjs";
import { ingestCapturedText } from "./ingest.mjs";
import { CORPUS_ROOT } from "./paths.mjs";

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "corpus-ingest-")), "t.db");

/* Distinct, unlikely-to-collide id/title so this suite's archive files never
 * shadow another suite's or a real ingested source's on disk (data-local/ is
 * shared, disposable, gitignored — see export-index.test.mjs precedent). */
let nextId = 90001;

function seededSource(db, over = {}) {
  const id = over.id ?? nextId++;
  db.prepare(`
    INSERT INTO sources (id, area, area_name, title, url, source_type, why_it_matters, read_first)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    over.area ?? 6,
    over.area_name ?? "TTS & AI Narration",
    over.title ?? `Ingest Capture Fixture ${id}`,
    over.url ?? `https://example.com/capture-${id}`,
    over.source_type ?? "reference",
    over.why_it_matters ?? "fixture",
    over.read_first ?? 0
  );
  return db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
}

const REAL_PARAGRAPH =
  "This is a rendered capture of a JS-only page. ".repeat(6) +
  "It has enough real words to survive the chunker's noise gate. ".repeat(6);

test("ingestCapturedText: stores a document and at least one chunk", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const source = seededSource(db);

  const result = ingestCapturedText(db, source, REAL_PARAGRAPH);

  assert.equal(result.outcome, "ok");
  assert.ok(result.chunks >= 1);
  assert.ok(result.tokens > 0);

  const chunkCount = db.prepare(`
    SELECT COUNT(*) n FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE d.source_id = ?
  `).get(source.id).n;
  assert.equal(chunkCount, result.chunks);
});

test("ingestCapturedText: archives raw .txt and markdown under the source's id/slug", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const source = seededSource(db, { title: "A Rendered Thread" });

  ingestCapturedText(db, source, REAL_PARAGRAPH);

  const doc = db.prepare("SELECT * FROM documents WHERE source_id = ?").get(source.id);
  assert.match(doc.raw_path, /^raw\/\d+-a-rendered-thread\.txt$/);
  assert.match(doc.markdown_path, /^markdown\/\d+-a-rendered-thread\.md$/);

  const rawFull = path.join(CORPUS_ROOT, doc.raw_path);
  const mdFull = path.join(CORPUS_ROOT, doc.markdown_path);
  assert.ok(fs.existsSync(rawFull));
  assert.ok(fs.existsSync(mdFull));
  assert.equal(fs.readFileSync(rawFull, "utf8"), REAL_PARAGRAPH.trim());
  assert.match(fs.readFileSync(mdFull, "utf8"), /rendered browser capture, not a network fetch/);
});

test("ingestCapturedText: records http_status 200 and a fetch_notes trail naming the capture", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const source = seededSource(db);

  ingestCapturedText(db, source, REAL_PARAGRAPH, { tool: "chrome-devtools-mcp" });

  const doc = db.prepare("SELECT * FROM documents WHERE source_id = ?").get(source.id);
  assert.equal(doc.http_status, 200);
  assert.match(doc.fetch_notes, /rendered capture via chrome-devtools-mcp/);
});

test("ingestCapturedText: default tool label is 'browser capture'", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const source = seededSource(db);

  ingestCapturedText(db, source, REAL_PARAGRAPH);

  const doc = db.prepare("SELECT * FROM documents WHERE source_id = ?").get(source.id);
  assert.match(doc.fetch_notes, /rendered capture via browser capture/);
});

test("ingestCapturedText: refuses text under 50 chars", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const source = seededSource(db);

  assert.throws(
    () => ingestCapturedText(db, source, "too short"),
    /too short/
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM documents WHERE source_id = ?").get(source.id).n,
    0,
    "a rejected capture must not leave a partial document row"
  );
});

test("ingestCapturedText: refuses a capture that is only separator characters", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const source = seededSource(db);
  const separatorOnly = "-".repeat(80);

  assert.throws(
    () => ingestCapturedText(db, source, separatorOnly),
    /zero chunks/
  );
});

test("ingestCapturedText: identical text on a second call is a no-op ('unchanged')", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const source = seededSource(db);

  const first = ingestCapturedText(db, source, REAL_PARAGRAPH);
  const second = ingestCapturedText(db, source, REAL_PARAGRAPH);

  assert.equal(first.outcome, "ok");
  assert.equal(second.outcome, "unchanged");
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM documents WHERE source_id = ?").get(source.id).n,
    1,
    "an unchanged capture must not insert a second document row"
  );
});

test("ingestCapturedText: changed text on a recapture supersedes the prior chunks", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const source = seededSource(db);

  ingestCapturedText(db, source, REAL_PARAGRAPH);
  const updated = REAL_PARAGRAPH + " A brand-new sentence that was not there before, added on recapture.";
  const second = ingestCapturedText(db, source, updated);

  assert.equal(second.outcome, "ok");
  const chunks = db.prepare(`
    SELECT c.text FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE d.source_id = ? AND d.id = (
      SELECT id FROM documents WHERE source_id = ? ORDER BY fetched_at DESC, id DESC LIMIT 1
    )
  `).all(source.id, source.id);
  assert.ok(chunks.some((c) => c.text.includes("brand-new sentence")));

  // Only the CURRENT document's chunks remain (documents is append-only
  // history; chunks exist only for the latest success — same invariant as
  // ingestSource).
  const docCount = db.prepare("SELECT COUNT(*) n FROM documents WHERE source_id = ?").get(source.id).n;
  assert.equal(docCount, 2);
  const totalChunks = db.prepare(`
    SELECT COUNT(*) n FROM chunks c JOIN documents d ON c.document_id = d.id WHERE d.source_id = ?
  `).get(source.id).n;
  assert.equal(totalChunks, chunks.length, "superseded chunks must be deleted, not accumulated");
});

test("ingestCapturedText: capturedAt is accepted but does not change outcome shape", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const source = seededSource(db);

  const result = ingestCapturedText(db, source, REAL_PARAGRAPH, { capturedAt: "2026-08-12T00:00:00.000Z" });
  assert.equal(result.outcome, "ok");

  const doc = db.prepare("SELECT * FROM documents WHERE source_id = ?").get(source.id);
  const md = fs.readFileSync(path.join(CORPUS_ROOT, doc.markdown_path), "utf8");
  assert.match(md, /captured: 2026-08-12T00:00:00\.000Z/);
});

test("ingestCapturedText: never writes an archive path outside CORPUS_ROOT", () => {
  const db = openMigrated(tmpDb(), { create: true });
  // A hostile-looking title (scraped titles are untrusted in the fetch path;
  // a captured source's title comes from the same `sources` row, so the same
  // guard in paths.mjs must hold here too).
  const source = seededSource(db, { title: "../../etc/passwd" });

  ingestCapturedText(db, source, REAL_PARAGRAPH);

  const doc = db.prepare("SELECT * FROM documents WHERE source_id = ?").get(source.id);
  const rawFull = path.resolve(CORPUS_ROOT, doc.raw_path);
  const mdFull = path.resolve(CORPUS_ROOT, doc.markdown_path);
  assert.ok(rawFull.startsWith(path.resolve(CORPUS_ROOT, "raw") + path.sep));
  assert.ok(mdFull.startsWith(path.resolve(CORPUS_ROOT, "markdown") + path.sep));
});
