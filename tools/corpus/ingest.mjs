/* Ingestion: one source → fetched raw artifact + markdown + chunks in the DB.
 *
 * Semantics:
 * - documents is append-only fetch HISTORY (every attempt, success or not).
 * - chunks exist only for the CURRENT (latest successful) document of each
 *   source; a new success deletes superseded chunks (FTS follows via
 *   triggers). Raw/markdown files use stable per-source names, so a refetch
 *   overwrites them — history lives in the DB rows, bytes on disk are
 *   current-only.
 * - An unchanged content_hash on refetch skips re-extraction ("unchanged"),
 *   unless force is set.
 * - Failures (404, robots-blocked, network-dead) are recorded rows with
 *   fetch_notes and no paths. They feed dead-links.md — no workarounds here.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { routeUrl, htmlToMarkdown, pdfToMarkdown, issueToMarkdown, looksLikePdf } from "./extract.mjs";
import { chunkMarkdown, estTokens } from "./chunk.mjs";
import { RAW_DIR, MARKDOWN_DIR, CORPUS_ROOT, archivePath, relToCorpusRoot } from "./paths.mjs";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function rawExtFor(kind, contentType, body) {
  if (kind === "pdf" || looksLikePdf(contentType, body)) return "pdf";
  if (kind === "github-issue") return "json";
  if (kind === "github-readme") return "md";
  if (contentType?.includes("json")) return "json";
  if (contentType?.includes("text/plain")) return "txt";
  return "html";
}

/**
 * Ingest one source row. Returns a summary object; never throws for
 * fetch-level failures.
 */
export async function ingestSource(db, fetcher, source, { force = false } = {}) {
  const route = routeUrl(source.url);
  const notes = route.note ? [route.note] : [];

  const res = await fetcher.fetchUrl(route.fetchUrl);
  notes.push(...res.notes);

  const insertDoc = db.prepare(`
    INSERT INTO documents (source_id, http_status, content_hash, raw_path, markdown_path, token_count, fetch_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  if (!res.ok) {
    insertDoc.run(source.id, res.status, null, null, null, 0, notes.join("; ") || "fetch failed");
    return { sourceId: source.id, status: res.status, outcome: "failed", notes };
  }

  const body = res.body;
  const hash = sha256(body);

  if (!force) {
    const prev = db.prepare(`
      SELECT content_hash FROM documents
      WHERE source_id = ? AND http_status BETWEEN 200 AND 299 AND markdown_path IS NOT NULL
      ORDER BY fetched_at DESC, id DESC LIMIT 1
    `).get(source.id);
    if (prev && prev.content_hash === hash) {
      return { sourceId: source.id, status: res.status, outcome: "unchanged", notes };
    }
  }

  /* Extract markdown per artifact kind. */
  let extracted;
  const effectiveKind =
    route.kind === "pdf" || looksLikePdf(res.contentType, body) ? "pdf" : route.kind;
  try {
    if (effectiveKind === "pdf") {
      extracted = await pdfToMarkdown(body);
    } else if (effectiveKind === "github-issue") {
      const issue = JSON.parse(body.toString("utf8"));
      let comments = [];
      if (route.commentsUrl && (issue.comments ?? 0) > 0) {
        // Paginate: the API defaults to 30/page and long standards threads
        // (the DAI issue) run far past that. Page count is bounded to keep a
        // pathological thread from eating the unauthenticated rate limit.
        for (let page = 1; page <= 5; page++) {
          const cres = await fetcher.fetchUrl(`${route.commentsUrl}?per_page=100&page=${page}`);
          notes.push(...cres.notes);
          if (!cres.ok) { notes.push(`comments page ${page} fetch failed (${cres.status})`); break; }
          const batch = JSON.parse(cres.body.toString("utf8"));
          comments.push(...batch);
          if (batch.length < 100) break;
        }
        if (comments.length < (issue.comments ?? 0)) {
          notes.push(`comments truncated: ${comments.length}/${issue.comments}`);
        }
      }
      extracted = issueToMarkdown(issue, comments);
    } else if (effectiveKind === "github-readme") {
      extracted = { title: source.title, markdown: body.toString("utf8"), notes: ["raw README"] };
    } else if (res.contentType?.includes("text/plain") || res.contentType?.includes("text/markdown")) {
      // Already text — running it through an HTML pipeline only mangles it.
      extracted = { title: source.title, markdown: body.toString("utf8"), notes: ["plain text passthrough"] };
    } else {
      extracted = htmlToMarkdown(body.toString("utf8"), res.finalUrl);
    }
  } catch (err) {
    insertDoc.run(source.id, res.status, hash, null, null, 0, [...notes, `extraction failed: ${err.message}`].join("; "));
    return { sourceId: source.id, status: res.status, outcome: "extraction-failed", notes: [...notes, err.message] };
  }
  notes.push(...(extracted.notes ?? []));

  /* Archive raw + markdown under stable per-source names. */
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(MARKDOWN_DIR, { recursive: true });
  const ext = rawExtFor(route.kind, res.contentType, body);
  const rawFull = archivePath(RAW_DIR, source.id, source.title, ext);
  const mdFull = archivePath(MARKDOWN_DIR, source.id, source.title, "md");
  fs.writeFileSync(rawFull, body);

  const header = [
    `<!-- corpus source ${source.id}: ${source.title}`,
    `     url: ${source.url}`,
    `     fetched: ${res.finalUrl} (${res.status}) -->`,
    "",
  ].join("\n");
  fs.writeFileSync(mdFull, header + (extracted.markdown ?? ""), "utf8");

  const tokenCount = estTokens(extracted.markdown ?? "");
  const chunks = chunkMarkdown(extracted.markdown ?? "");

  /* One transaction: record the fetch, retire superseded chunks, add new. */
  db.exec("BEGIN");
  try {
    const docId = insertDoc.run(
      source.id, res.status, hash,
      relToCorpusRoot(rawFull), relToCorpusRoot(mdFull),
      tokenCount, notes.join("; ")
    ).lastInsertRowid;

    db.prepare(`
      DELETE FROM chunks WHERE document_id IN
        (SELECT id FROM documents WHERE source_id = ? AND id != ?)
    `).run(source.id, docId);

    writeChunks(db, docId, chunks);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return {
    sourceId: source.id,
    status: res.status,
    outcome: "ok",
    chunks: chunks.length,
    tokens: tokenCount,
    notes,
  };
}

/** Replace a document's chunks. Caller owns the transaction. */
export function writeChunks(db, docId, chunks) {
  db.prepare("DELETE FROM chunks WHERE document_id = ?").run(docId);
  const ins = db.prepare(`
    INSERT INTO chunks (document_id, ordinal, heading_path, text, token_count)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const c of chunks) ins.run(docId, c.ordinal, c.heading_path, c.text, c.token_count);
  return chunks.length;
}

/**
 * Re-chunk every current document from its ARCHIVED markdown — no network,
 * no refetch, no politeness budget spent. This is the whole reason raw+
 * markdown are archived on disk: when the chunker changes (a boundary rule,
 * a junk filter, or later a real tokenizer's max length), the corpus can be
 * rebuilt offline in seconds against bytes we already have.
 *
 * @returns {{documents:number, before:number, after:number, missing:string[]}}
 */
export function rechunkAll(db, { onDoc } = {}) {
  const docs = db.prepare(`
    SELECT d.id, d.source_id, d.markdown_path, s.title
    FROM documents d
    JOIN sources s ON s.id = d.source_id
    WHERE d.markdown_path IS NOT NULL
      AND d.id = (SELECT id FROM documents
                  WHERE source_id = d.source_id
                    AND http_status BETWEEN 200 AND 299 AND markdown_path IS NOT NULL
                  ORDER BY fetched_at DESC, id DESC LIMIT 1)
    ORDER BY d.source_id
  `).all();

  const before = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  const missing = [];
  let after = 0;

  db.exec("BEGIN");
  try {
    for (const d of docs) {
      const full = path.join(CORPUS_ROOT, d.markdown_path);
      if (!fs.existsSync(full)) { missing.push(d.markdown_path); continue; }
      const markdown = fs.readFileSync(full, "utf8");
      const chunks = chunkMarkdown(markdown);
      writeChunks(db, d.id, chunks);
      after += chunks.length;
      onDoc?.(d, chunks.length);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { documents: docs.length, before, after, missing };
}

/** Ingest a set of sources sequentially (the fetcher paces hosts). */
export async function ingestMany(db, fetcher, sources, opts = {}) {
  const results = [];
  for (const source of sources) {
    const r = await ingestSource(db, fetcher, source, opts);
    results.push(r);
    opts.onResult?.(source, r);
  }
  return results;
}
