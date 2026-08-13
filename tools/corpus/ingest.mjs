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

/** Delete any archive file for `sourceId` in `dir` other than `keepFullPath`
 * (matched by the `<id>-` filename prefix `archivePath` always writes).
 * Best-effort: a stale file that's already gone is not an error. */
function removeStaleArchives(dir, sourceId, keepFullPath) {
  const prefix = `${String(sourceId).padStart(3, "0")}-`;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const full = path.resolve(dir, name);
    if (full === keepFullPath) continue;
    fs.rmSync(full, { force: true });
  }
}

/**
 * Shared tail for every ingestion route (fetch-based or captured): archive
 * raw + markdown under stable per-source names, chunk the markdown, and
 * commit the documents/chunks rows in one transaction (insert the new
 * document, retire the previous document's chunks, write the new ones).
 * `ingestSource` and `ingestCapturedText` differ only in where their bytes
 * came from and what provenance line belongs in the archive header —
 * everything after "we have markdown now" is identical, and duplicating it
 * across both functions risked one gaining a fix (e.g. to the supersession
 * query) that the other silently missed.
 */
function archiveAndCommit(db, source, { rawBody, rawExt, markdown, headerLine, httpStatus, contentHash, notes }) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(MARKDOWN_DIR, { recursive: true });
  const rawFull = archivePath(RAW_DIR, source.id, source.title, rawExt);
  const mdFull = archivePath(MARKDOWN_DIR, source.id, source.title, "md");

  /* archivePath names files `<id>-<slug>.<ext>`, and both the slug (from
   * the source's title) and the extension (from the acquisition route —
   * e.g. a JS-broken .html fetch later replaced by a .txt browser capture)
   * can change between ingestions. Without cleanup, the OLD file is simply
   * orphaned: real bytes on disk with no documents row pointing at them,
   * silently accumulating in raw/ and markdown/ every time a source's route
   * changes. Sweep any other archive file for this source id before writing
   * the new one — best-effort; a missing stale file is not an error. */
  removeStaleArchives(RAW_DIR, source.id, rawFull);
  removeStaleArchives(MARKDOWN_DIR, source.id, mdFull);

  fs.writeFileSync(rawFull, rawBody);

  const header = [
    `<!-- corpus source ${source.id}: ${source.title}`,
    `     url: ${source.url}`,
    `     ${headerLine} -->`,
    "",
  ].join("\n");
  fs.writeFileSync(mdFull, header + markdown, "utf8");

  const tokenCount = estTokens(markdown);
  const chunks = chunkMarkdown(markdown);

  db.exec("BEGIN");
  try {
    const docId = db.prepare(`
      INSERT INTO documents (source_id, http_status, content_hash, raw_path, markdown_path, token_count, fetch_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.id, httpStatus, contentHash,
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

  return { chunks, tokenCount };
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

  const ext = rawExtFor(route.kind, res.contentType, body);
  const { chunks, tokenCount } = archiveAndCommit(db, source, {
    rawBody: body,
    rawExt: ext,
    markdown: extracted.markdown ?? "",
    headerLine: `fetched: ${res.finalUrl} (${res.status})`,
    httpStatus: res.status,
    contentHash: hash,
    notes,
  });

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
/* The archive header that ingestSource prepends to the .md file for human
 * readability. It is NOT part of what ingest chunks, so rechunk must strip it
 * — otherwise the two paths build different indexes from identical bytes, the
 * source title and URL leak into searchable body text, and the corpus stops
 * being reproducible from a fresh ingest. */
const ARCHIVE_HEADER = /^<!--\s*corpus source [\s\S]*?-->\s*/;

export function rechunkAll(db, { onDoc, corpusRoot = CORPUS_ROOT, dropEmbeddings = false } = {}) {
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

  /* Refuse to run over embeddings rather than silently discarding them:
   * chunks are the FK parent of chunk_embeddings (ON DELETE CASCADE), so
   * rewriting them destroys every backfilled vector — quietly, and with no
   * error, because the cascade is doing exactly what it was asked to.
   * PLAN.md's backfill pass re-chunks BEFORE embedding for this reason.
   * `dropEmbeddings` is the deliberate opt-in for the other order. */
  const embedded = db.prepare("SELECT COUNT(*) n FROM chunk_embeddings").get().n;
  if (embedded > 0 && !dropEmbeddings) {
    throw new Error(
      `${embedded} vector(s) in chunk_embeddings would be cascade-deleted by a re-chunk. ` +
      `Re-chunk before backfilling, or pass --drop-embeddings and re-run the backfill afterwards.`
    );
  }

  const before = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  const missing = [];
  const emptied = [];

  db.exec("BEGIN");
  try {
    for (const d of docs) {
      const full = path.join(corpusRoot, d.markdown_path);
      if (!fs.existsSync(full)) { missing.push(d.markdown_path); continue; }
      const markdown = fs.readFileSync(full, "utf8").replace(ARCHIVE_HEADER, "");
      const chunks = chunkMarkdown(markdown);
      /* chunkMarkdown promises never to empty a document that had content,
       * but that guard cannot see the DB. An archive file that is empty or
       * truncated (writeFileSync is not atomic — a crash mid-ingest leaves
       * exactly that) would otherwise delete a source from search while
       * `stats` still reported it ingested. Skip loudly instead. */
      if (!chunks.length) { emptied.push(`${d.source_id} (${d.title})`); continue; }
      writeChunks(db, d.id, chunks);
      onDoc?.(d, chunks.length);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  /* Count after the commit so the number describes the DB, not the subset we
   * happened to rewrite. */
  const after = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  return { documents: docs.length, before, after, missing, emptied };
}

/**
 * Ingest a source from a browser-rendered text capture instead of a network
 * fetch. `fetcher.mjs` gets the server-sent bytes of a page; for a handful of
 * sources (forum threads, single-page apps) those bytes are a JS shell with
 * no content, and `htmlToMarkdown` correctly flags that as "thin extraction"
 * rather than inventing text that was never there. The honest fix is a real
 * browser: render the page, read its VISIBLE TEXT AS RENDERED, save that to a
 * file, and hand it to this function. Everything downstream — the chunker,
 * the archive layout, the documents/chunks schema, refetch/rechunk — is
 * identical to a normal fetch; only the fetch+HTML-extraction stage is
 * replaced by a capture step a human or agent drives once per source.
 *
 * `capturedText` must be the page's own rendered text, verbatim — this
 * function has no code path that accepts a paraphrase or summary in its
 * place. Chunking a hand-written stand-in into the corpus would misrepresent
 * the source as something we fetched when we did not; a thin-but-honest
 * extraction is a better failure than that.
 *
 * @param {object} source - a `sources` row (id, title, url)
 * @param {string} capturedText - rendered page text, verbatim
 * @param {{capturedAt?: string, tool?: string}} [meta]
 * @returns {{sourceId:number, outcome:"ok"|"unchanged", chunks?:number, tokens?:number}}
 */
export function ingestCapturedText(db, source, capturedText, { capturedAt = new Date().toISOString(), tool = "browser capture" } = {}) {
  const text = String(capturedText ?? "").trim();
  if (text.length < 50) {
    throw new Error(`captured text too short (${text.length} chars) — refusing to ingest a near-empty capture`);
  }

  /* ingestSource hashes the raw fetched bytes, pre-extraction; there is no
   * separate "raw vs. extracted" split for a capture, so this hashes the
   * captured text itself — deliberate, not an oversight. */
  const hash = sha256(Buffer.from(text, "utf8"));
  const prev = db.prepare(`
    SELECT content_hash FROM documents
    WHERE source_id = ? AND http_status BETWEEN 200 AND 299 AND markdown_path IS NOT NULL
    ORDER BY fetched_at DESC, id DESC LIMIT 1
  `).get(source.id);
  if (prev && prev.content_hash === hash) {
    return { sourceId: source.id, outcome: "unchanged" };
  }

  /* Checked before any fs write so a rejected capture never leaves an
   * orphaned raw/markdown file behind (archiveAndCommit re-chunks the same
   * text below; chunking is pure and cheap, so this recompute is harmless). */
  if (!chunkMarkdown(text).length) {
    throw new Error("captured text produced zero chunks — nothing worth indexing");
  }

  const notes = [`rendered capture via ${tool} (see tools/corpus/README.md#rendered-html-route)`];
  const { chunks, tokenCount } = archiveAndCommit(db, source, {
    rawBody: text,
    rawExt: "txt",
    markdown: text,
    headerLine: `captured: ${capturedAt} via ${tool} (rendered browser capture, not a network fetch)`,
    httpStatus: 200,
    contentHash: hash,
    notes,
  });

  return { sourceId: source.id, outcome: "ok", chunks: chunks.length, tokens: tokenCount, notes };
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
