/* GV-28 (W3-07, docs/roadmap/generation-v2.md): the passage store.
 *
 * A node:sqlite file holding the passages the backend cutter emits (GV-12,
 * indexBodies --passages-out) and their dense vectors, so a semantic arm can
 * find episodes that share no query word with a claim. The retrieval server
 * reads it through `createServerPassageStore` (GV-48, W3-09) when started with
 * --passages-db: mode 'hybrid' and the per-node shortlists (migration 0002).
 * The client asks for hybrid only under FORAY_RETRIEVAL_MODE=hybrid, which
 * stays off behind the replay gate (W3-15) because tools/corpus measured
 * hybrid losing to keyword on its gold set.
 *
 * What it reuses from tools/corpus, all dependency-free:
 * - db.mjs `migrate`, applied to this directory's own migrations/;
 * - vectors.mjs: the bare little-endian float32 blob (sqlite-vec's format),
 *   normalized at the write, read into one flat matrix, scored by dot product;
 * - chunk.mjs `estTokens` (chars/4) and embedder.mjs `EMBED_CHUNK_MAX` (400);
 * - the registerModel shape from embeddings.mjs: a model row is the vector
 *   space, and a change to anything that defines it is refused.
 *
 * SUB-CHUNKS, NEVER TRUNCATION. A 90-180 s passage is roughly 340-680 bge
 * tokens, over bge's 512-token limit, and an encoder truncates silently. So a
 * passage is split into sub-chunks of at most EMBED_CHUNK_MAX tokens, each
 * gets its own vector, and a passage scores the max over its chunks. The 400
 * leaves about 110 tokens under 512 for the model row's passage prefix and the
 * special tokens. */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { estTokens } from "../corpus/chunk.mjs";
import { migrate } from "../corpus/db.mjs";
import { EMBED_CHUNK_MAX } from "../corpus/embedder.mjs";
import { dotAt, l2Normalize, readVectorInto, toBlob, toFloat32 } from "../corpus/vectors.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = path.join(HERE, "migrations");

/** The store's default home: machine-local and gitignored, like every index. */
export const DEFAULT_DB_PATH = path.resolve(HERE, "..", "..", "data-local", "passage-index", "passages.db");

export const DEFAULT_EMBED_BATCH = 32;

/** Passages read per backfill page; a page is written in one transaction. */
const BACKFILL_PAGE = 256;

/** Chunk rows read per page while the dense index loads. */
const LOAD_PAGE = 10000;

export { EMBED_CHUNK_MAX };

/**
 * Open (and migrate) the store. `create` is explicit for the reason
 * tools/corpus/db.mjs gives: DatabaseSync silently creates an empty file, and
 * an empty store answering "nothing found" is how an absent index passes for
 * an empty one. Only `ingest` creates. ":memory:" is for tests.
 */
export function openStore(dbPath = DEFAULT_DB_PATH, { create = false } = {}) {
  const memory = dbPath === ":memory:";
  if (!memory && !create && !fs.existsSync(dbPath)) {
    throw new Error(
      `no passage store at ${dbPath}\n` +
        `The store is machine-local (data-local/ is gitignored). Build it on this machine with\n` +
        `  node --experimental-sqlite tools/passage-index/index-db.mjs ingest --passages <passages.jsonl>`
    );
  }
  if (!memory && create) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (!memory) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 15000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, MIGRATIONS_DIR);
  return db;
}

/* ------------------------------------------------------------------ models */

/* Fields that define the vector space (embeddings.mjs's rule): a change to
 * one makes every stored vector incomparable, so it is refused, and the new
 * configuration goes under a new revision. query_prefix only changes how
 * future queries are encoded, so it may change in place. */
const SPACE_DEFINING = ["dim", "pooling", "normalized", "passage_prefix"];

function normalizeSpec(spec) {
  const out = {
    name: String(spec?.name ?? ""),
    revision: String(spec?.revision ?? "main"),
    dim: Number(spec?.dim),
    pooling: String(spec?.pooling ?? ""),
    normalized: spec?.normalized === false || spec?.normalized === 0 ? 0 : 1,
    query_prefix: String(spec?.query_prefix ?? ""),
    passage_prefix: String(spec?.passage_prefix ?? ""),
  };
  if (!out.name) throw new Error("model name is required");
  if (!Number.isInteger(out.dim) || out.dim <= 0) throw new Error(`model dim must be a positive integer, got ${spec?.dim}`);
  if (!out.pooling) throw new Error("model pooling is required");
  return out;
}

export function getModelById(db, id) {
  return db.prepare("SELECT * FROM embedding_models WHERE id = ?").get(id) ?? null;
}

/** Register a model, or return the existing row for the same name and
 * revision. Refuses a change to a space-defining field. */
export function registerModel(db, spec) {
  const s = normalizeSpec(spec);
  const existing = db.prepare("SELECT * FROM embedding_models WHERE name = ? AND revision = ?").get(s.name, s.revision);
  if (!existing) {
    const id = db
      .prepare(
        `INSERT INTO embedding_models (name, revision, dim, pooling, normalized, query_prefix, passage_prefix)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(s.name, s.revision, s.dim, s.pooling, s.normalized, s.query_prefix, s.passage_prefix).lastInsertRowid;
    return getModelById(db, Number(id));
  }
  const changed = SPACE_DEFINING.filter((k) => String(existing[k]) !== String(s[k]));
  if (changed.length) {
    throw new Error(
      `model ${s.name}@${s.revision} is already registered as id ${existing.id} with different vector-space settings: ` +
        changed.map((k) => `${k} ${JSON.stringify(existing[k])} -> ${JSON.stringify(s[k])}`).join(", ") +
        ". Register the new configuration under a different revision."
    );
  }
  if (existing.query_prefix !== s.query_prefix) {
    db.prepare("UPDATE embedding_models SET query_prefix = ? WHERE id = ?").run(s.query_prefix, existing.id);
    return getModelById(db, existing.id);
  }
  return existing;
}

/* ----------------------------------------------------------------- ingest */

const BOUNDARIES = new Set(["turn", "sentence", "cue"]);

/** One cutter line (backend/src/generation/passageCutter.ts `Passage`) as a
 * row, or a thrown error naming the line. */
export function passageRow(obj, where = "passage") {
  const fail = (why) => {
    throw new Error(`${where}: ${why}`);
  };
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) fail("not an object");
  for (const k of ["id", "show_id", "guid"]) if (typeof obj[k] !== "string" || !obj[k]) fail(`${k} must be a non-empty string`);
  for (const k of ["startSec", "endSec"]) if (typeof obj[k] !== "number" || !Number.isFinite(obj[k])) fail(`${k} must be a finite number`);
  if (obj.endSec < obj.startSec) fail("endSec is before startSec");
  for (const k of ["startBoundary", "endBoundary"]) if (!BOUNDARIES.has(obj[k])) fail(`${k} must be turn, sentence or cue`);
  for (const k of ["startAnchor", "endAnchor"]) if (obj[k] !== null && obj[k] !== undefined && typeof obj[k] !== "string") fail(`${k} must be a string or null`);
  if (typeof obj.text !== "string") fail("text must be a string");
  if (!Number.isInteger(obj.indexVersion)) fail("indexVersion must be an integer");
  return {
    id: obj.id,
    show_id: obj.show_id,
    guid: obj.guid,
    start_sec: obj.startSec,
    end_sec: obj.endSec,
    start_boundary: obj.startBoundary,
    end_boundary: obj.endBoundary,
    start_anchor: obj.startAnchor ?? null,
    end_anchor: obj.endAnchor ?? null,
    text: obj.text,
    index_version: obj.indexVersion,
  };
}

/** Lines of `source`: a JSONL string, or an (async) iterable of lines or of
 * already-parsed passage objects. */
async function* sourceItems(source) {
  if (typeof source === "string") {
    yield* source.split(/\r?\n/);
    return;
  }
  for await (const item of source) yield item;
}

/**
 * Ingest cutter passages. Per episode (show_id, guid), the episode's stored
 * passages are deleted and the new ones inserted in ONE transaction, so a
 * re-ingest is idempotent and the delete cascades to every chunk vector of
 * the old passages (a re-cut passage is embedded again, never served with a
 * stale vector).
 *
 * indexBodies APPENDS to --passages-out, so a re-streamed show's passages
 * appear again further down the file. An episode's passages are contiguous
 * within one emission, so each contiguous block replaces the episode, and the
 * last block in the file wins. Within a block, a repeated id keeps its last
 * line.
 *
 * A malformed line throws, naming its line number; blocks before it are
 * already committed, and re-running the ingest after a fix is safe.
 *
 * @returns {Promise<{episodes:number, passages:number, removed:number, lines:number}>}
 *   `lines` counts the non-blank lines read.
 */
export async function ingestPassages(db, source) {
  const del = db.prepare("DELETE FROM passages WHERE show_id = ? AND guid = ?");
  const ins = db.prepare(
    `INSERT INTO passages (id, show_id, guid, start_sec, end_sec, start_boundary, end_boundary, start_anchor, end_anchor, text, index_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const stats = { episodes: 0, passages: 0, removed: 0, lines: 0 };
  let key = null;
  let block = new Map();
  let episode = null;
  let lineNo = 0;

  const flush = () => {
    if (!episode) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      stats.removed += Number(del.run(episode.show_id, episode.guid).changes);
      for (const r of block.values()) {
        ins.run(r.id, r.show_id, r.guid, r.start_sec, r.end_sec, r.start_boundary, r.end_boundary, r.start_anchor, r.end_anchor, r.text, r.index_version);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    stats.episodes += 1;
    stats.passages += block.size;
  };

  for await (const item of sourceItems(source)) {
    lineNo += 1;
    let obj = item;
    if (typeof item === "string") {
      if (!item.trim()) continue;
      try {
        obj = JSON.parse(item);
      } catch {
        throw new Error(`line ${lineNo}: not JSON`);
      }
    }
    stats.lines += 1;
    const row = passageRow(obj, `line ${lineNo}`);
    const k = `${row.show_id}\u0000${row.guid}`;
    if (k !== key) {
      flush();
      key = k;
      block = new Map();
      episode = { show_id: row.show_id, guid: row.guid };
    }
    block.set(row.id, row);
  }
  flush();
  return stats;
}

/* ------------------------------------------------------------- sub-chunks */

/** A word ends a sentence when it ends in . ! or ?, maybe before a closing
 * quote or bracket. */
const SENTENCE_END = /[.!?]["'”’)\]]*$/;

/**
 * Split `text` into sub-chunks of at most `maxTokens` tokens by `countTokens`
 * (the embedder's tokenizer when it has one, chars/4 otherwise).
 *
 * Whole sentences are packed greedily; a sentence longer than one chunk is
 * packed word by word; a single word longer than one chunk is cut into
 * pieces. Nothing is dropped: the chunks joined with single spaces are the
 * text's words joined with single spaces (a cut word aside). Empty text gives
 * no chunk.
 */
export function splitForEmbedding(text, { maxTokens = EMBED_CHUNK_MAX, countTokens = estTokens } = {}) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const fits = (ws) => countTokens(ws.join(" ")) <= maxTokens;
  if (fits(words)) return [words.join(" ")];

  const sentences = [];
  let current = [];
  for (const w of words) {
    current.push(w);
    if (SENTENCE_END.test(w)) {
      sentences.push(current);
      current = [];
    }
  }
  if (current.length) sentences.push(current);

  const chunks = [];
  let acc = [];
  const close = () => {
    if (acc.length) chunks.push(acc.join(" "));
    acc = [];
  };
  for (const sentence of sentences) {
    if (fits([...acc, ...sentence])) {
      acc.push(...sentence);
      continue;
    }
    close();
    if (fits(sentence)) {
      acc = [...sentence];
      continue;
    }
    for (const w of sentence) {
      if (fits([...acc, w])) {
        acc.push(w);
        continue;
      }
      close();
      if (fits([w])) {
        acc = [w];
        continue;
      }
      /* One word over the limit (a run of characters with no space): cut it
         at the longest prefix that fits, at least one character a piece. */
      let rest = w;
      while (rest.length) {
        let lo = 1;
        let hi = rest.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (countTokens(rest.slice(0, mid)) <= maxTokens) lo = mid;
          else hi = mid - 1;
        }
        chunks.push(rest.slice(0, lo));
        rest = rest.slice(lo);
      }
    }
  }
  close();
  return chunks;
}

/* --------------------------------------------------------------- backfill */

/**
 * Embed every passage that has no vector under the embedder's model.
 *
 * `embedder` is the Embedder interface from embedder.mjs:
 * `{model, embed(texts) -> Promise<Float32Array[]>, countTokens?}`. Each
 * passage is split into sub-chunks (splitForEmbedding, never truncated); the
 * model row's passage_prefix is prepended to each chunk; vectors are written
 * normalized. A passage's chunks are written together in one transaction with
 * the rest of its page, so an interrupted run never leaves a passage half
 * embedded, and the next run resumes with the passages still missing.
 *
 * @returns {Promise<object>} model, passages and chunks embedded, empty
 *   passages (no words, so no vector), chunks-per-passage stats and which
 *   token counter split them.
 */
export async function backfillEmbeddings(db, embedder, { batch = DEFAULT_EMBED_BATCH, maxTokens = EMBED_CHUNK_MAX, onProgress } = {}) {
  if (!embedder || typeof embedder.embed !== "function") throw new Error("embedder must provide embed(texts)");
  if (!Number.isInteger(batch) || batch <= 0) throw new Error(`batch must be a positive integer, got ${batch}`);
  const model = registerModel(db, embedder.model);
  const countTokens = typeof embedder.countTokens === "function" ? (s) => embedder.countTokens(s) : estTokens;
  const tokenizer = typeof embedder.countTokens === "function" ? "model" : "chars/4";

  const page = db.prepare(
    `SELECT p.id, p.text FROM passages p
     WHERE p.id > ? AND NOT EXISTS (SELECT 1 FROM passage_chunks c WHERE c.passage_id = p.id AND c.model_id = ?)
     ORDER BY p.id LIMIT ?`
  );
  const clear = db.prepare("DELETE FROM passage_chunks WHERE passage_id = ? AND model_id = ?");
  const ins = db.prepare("INSERT INTO passage_chunks (passage_id, ord, model_id, vector) VALUES (?, ?, ?, ?)");
  const total = db
    .prepare("SELECT COUNT(*) n FROM passages p WHERE NOT EXISTS (SELECT 1 FROM passage_chunks c WHERE c.passage_id = p.id AND c.model_id = ?)")
    .get(model.id).n;

  const perPassage = new Map(); // chunk count -> passages
  const report = { model, tokenizer, maxTokens, passages: 0, chunks: 0, emptyPassages: 0 };
  let after = "";
  let seen = 0;
  for (;;) {
    const rows = page.all(after, model.id, BACKFILL_PAGE);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    const work = rows.map((r) => ({ id: r.id, chunks: splitForEmbedding(r.text, { maxTokens, countTokens }) }));
    const inputs = [];
    for (const w of work) for (const c of w.chunks) inputs.push(`${model.passage_prefix}${c}`);
    const vectors = [];
    for (let i = 0; i < inputs.length; i += batch) {
      const slice = inputs.slice(i, i + batch);
      const out = await embedder.embed(slice);
      if (!Array.isArray(out) || out.length !== slice.length) {
        throw new Error(`embedder returned ${Array.isArray(out) ? out.length : "no"} vectors for ${slice.length} inputs`);
      }
      for (const v of out) {
        if (!v || v.length !== model.dim) {
          throw new Error(`embedder returned a ${v?.length}-dim vector but model ${model.name} declares ${model.dim}`);
        }
        vectors.push(v);
      }
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      let v = 0;
      for (const w of work) {
        clear.run(w.id, model.id);
        w.chunks.forEach((_, ord) => ins.run(w.id, ord, model.id, toBlob(vectors[v++])));
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    for (const w of work) {
      if (w.chunks.length === 0) {
        report.emptyPassages += 1;
        continue;
      }
      report.passages += 1;
      report.chunks += w.chunks.length;
      perPassage.set(w.chunks.length, (perPassage.get(w.chunks.length) ?? 0) + 1);
    }
    seen += rows.length;
    onProgress?.({ done: seen, total });
  }

  const counts = [...perPassage.keys()].sort((a, b) => a - b);
  report.chunksPerPassage = {
    min: counts.length ? counts[0] : 0,
    max: counts.length ? counts[counts.length - 1] : 0,
    mean: report.passages ? report.chunks / report.passages : 0,
    histogram: Object.fromEntries(counts.map((c) => [String(c), perPassage.get(c)])),
  };
  return report;
}

/* ------------------------------------------------------------ dense index */

/**
 * Load every chunk vector of `modelId` into one Float32Array, with a
 * chunk -> passage map and a passage -> episode map. Loaded once and kept;
 * the read runs in one transaction so the count and the rows agree.
 *
 * Memory is chunks x dim x 4 bytes: about 1.5-3 GB for 1-2M chunks at 384
 * dims, which is the Spark's job, not a laptop's.
 */
export function loadDenseIndex(db, modelId) {
  const model = getModelById(db, modelId);
  if (!model) throw new Error(`no embedding model with id ${modelId}`);
  const dim = model.dim;
  db.exec("BEGIN");
  let open = true;
  try {
    const count = db.prepare("SELECT COUNT(*) n FROM passage_chunks WHERE model_id = ?").get(model.id).n;
    const matrix = new Float32Array(count * dim);
    const chunkPassage = new Int32Array(count);
    const passages = [];
    const passageEpisode = [];
    const episodes = new Map();
    const pageStmt = db.prepare(
      `SELECT c.passage_id, c.ord, c.vector, p.show_id, p.guid
       FROM passage_chunks c JOIN passages p ON p.id = c.passage_id
       WHERE c.model_id = ? AND (c.passage_id > ? OR (c.passage_id = ? AND c.ord > ?))
       ORDER BY c.passage_id, c.ord LIMIT ?`
    );
    let row = 0;
    let lastId = "";
    let lastOrd = -1;
    for (;;) {
      const rows = pageStmt.all(model.id, lastId, lastId, lastOrd, LOAD_PAGE);
      if (rows.length === 0) break;
      for (const r of rows) {
        if (passages.length === 0 || passages[passages.length - 1].passageId !== r.passage_id) {
          const key = `${r.show_id}\u0000${r.guid}`;
          let e = episodes.get(key);
          if (e === undefined) {
            e = episodes.size;
            episodes.set(key, e);
          }
          passages.push({ passageId: r.passage_id, show_id: r.show_id, guid: r.guid });
          passageEpisode.push(e);
        }
        readVectorInto(r.vector, matrix, row * dim);
        chunkPassage[row] = passages.length - 1;
        row += 1;
      }
      lastId = rows[rows.length - 1].passage_id;
      lastOrd = rows[rows.length - 1].ord;
    }
    db.exec("COMMIT");
    open = false;
    if (row !== count) throw new Error(`dense index loaded ${row} chunks but counted ${count}`);
    return { model, dim, chunks: count, matrix, chunkPassage, passages, passageEpisode: Int32Array.from(passageEpisode), episodes };
  } catch (err) {
    if (open) db.exec("ROLLBACK");
    throw err;
  }
}

function episodeMask(index, episodeFilter) {
  if (episodeFilter === null || episodeFilter === undefined) return null;
  const mask = new Uint8Array(index.episodes.size);
  for (const e of episodeFilter) {
    const showId = Array.isArray(e) ? e[0] : e?.show_id;
    const guid = Array.isArray(e) ? e[1] : e?.guid;
    const i = index.episodes.get(`${showId}\u0000${guid}`);
    if (i !== undefined) mask[i] = 1;
  }
  return mask;
}

/**
 * Brute-force dense search: the dot product of the (normalized) query vector
 * with every chunk in the filter. A passage scores the max over its chunks.
 *
 * `episodeFilter` is null (every episode) or an iterable of episodes, each
 * `[show_id, guid]` (the retrieval server's scope shape) or `{show_id, guid}`.
 * Ties order by passage id, so the answer is deterministic.
 *
 * @returns {{passageId:string, show_id:string, guid:string, sim:number}[]}
 */
export function denseSearch(index, q, { episodeFilter = null, k = 10 } = {}) {
  if (!q || q.length !== index.dim) throw new Error(`query vector has ${q?.length} dims, the index has ${index.dim}`);
  const query = l2Normalize(toFloat32(q));
  const mask = episodeMask(index, episodeFilter);
  const best = new Float64Array(index.passages.length).fill(-Infinity);
  const { matrix, chunkPassage, passageEpisode, dim } = index;
  for (let r = 0; r < index.chunks; r++) {
    const p = chunkPassage[r];
    if (mask && !mask[passageEpisode[p]]) continue;
    const s = dotAt(query, matrix, r, dim);
    if (s > best[p]) best[p] = s;
  }
  const hits = [];
  for (let p = 0; p < best.length; p++) {
    if (best[p] === -Infinity) continue;
    const { passageId, show_id, guid } = index.passages[p];
    hits.push({ passageId, show_id, guid, sim: best[p] });
  }
  hits.sort((a, b) => b.sim - a.sim || (a.passageId < b.passageId ? -1 : a.passageId > b.passageId ? 1 : 0));
  return hits.slice(0, Math.max(0, k));
}

/** Encode a query under the model row's own query_prefix (prefixes come from
 * the row only). */
export async function embedQuery(embedder, model, text) {
  const [v] = await embedder.embed([`${model.query_prefix}${text}`]);
  if (!v || v.length !== model.dim) throw new Error(`embedder returned a ${v?.length}-dim query vector but model ${model.name} declares ${model.dim}`);
  return v;
}

/* ------------------------------------------------- server adapter (GV-48) */

/** The registered row for an embedder's model, or null. Read-only: unlike
 * registerModel it never inserts, so a server with no vectors yet stays a
 * reader of the store. */
export function findModel(db, spec) {
  const s = normalizeSpec(spec);
  return db.prepare("SELECT * FROM embedding_models WHERE name = ? AND revision = ?").get(s.name, s.revision) ?? null;
}

function passageRecord(r) {
  return {
    passageId: r.id,
    show_id: r.show_id,
    guid: r.guid,
    startSec: r.start_sec,
    endSec: r.end_sec,
    startBoundary: r.start_boundary,
    endBoundary: r.end_boundary,
    startAnchor: r.start_anchor ?? null,
    endAnchor: r.end_anchor ?? null,
    text: r.text,
  };
}

/** Passages by id, in the order asked; an unknown id is skipped. */
export function getPassages(db, ids) {
  const stmt = db.prepare("SELECT * FROM passages WHERE id = ?");
  const out = [];
  for (const id of ids) {
    const r = stmt.get(id);
    if (r) out.push(passageRecord(r));
  }
  return out;
}

/** Every passage of the episodes (`[show_id, guid]` pairs), episode by
 * episode in the order given, by start time within one. */
export function passagesForEpisodes(db, episodes) {
  const stmt = db.prepare("SELECT * FROM passages WHERE show_id = ? AND guid = ? ORDER BY start_sec, id");
  const out = [];
  const seen = new Set();
  for (const e of episodes) {
    const showId = Array.isArray(e) ? e[0] : e?.show_id;
    const guid = Array.isArray(e) ? e[1] : e?.guid;
    const key = `${showId}\u0000${guid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const r of stmt.all(showId, guid)) out.push(passageRecord(r));
  }
  return out;
}

/** Replace a node's shortlist whole, in one transaction (migration 0002).
 * `rows` are `{rank, passageId, score}`; ranks must be 0..49 (the table's
 * CHECK), so a 51st row aborts the whole write and the old rows stay. */
export function replaceShortlist(db, nodeId, rows, builtAt) {
  const del = db.prepare("DELETE FROM node_shortlist WHERE node_id = ?");
  const ins = db.prepare("INSERT INTO node_shortlist (node_id, rank, passage_id, score, built_at) VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    del.run(nodeId);
    for (const r of rows) ins.run(nodeId, r.rank, r.passageId, r.score, builtAt);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** A node's stored rows by rank: `{rank, passageId, score, builtAt}`. */
export function readShortlist(db, nodeId) {
  return db
    .prepare("SELECT rank, passage_id, score, built_at FROM node_shortlist WHERE node_id = ? ORDER BY rank")
    .all(nodeId)
    .map((r) => ({ rank: r.rank, passageId: r.passage_id, score: r.score, builtAt: r.built_at }));
}

/**
 * The retrieval server's view of the store (backend/src/cli/retrievalServer.ts
 * `PassageStore` and `QueryEmbedder`). With an embedder, the dense index of
 * its model is loaded now and again on `reload()` (after a nightly embed);
 * until the model has vectors, a dense search finds nothing and a query
 * embedding is refused. Without one there is no query embedder and the dense
 * search is empty: the shortlist is then lexical only.
 */
export function createServerPassageStore(db, { embedder = null } = {}) {
  let model = null;
  let index = null;
  const load = () => {
    model = embedder ? findModel(db, embedder.model) : null;
    index = model ? loadDenseIndex(db, model.id) : null;
  };
  load();
  const passageStore = {
    denseSearch(vector, { episodes = null, k = 10 } = {}) {
      if (!index || index.chunks === 0) return [];
      return denseSearch(index, vector, { episodeFilter: episodes, k });
    },
    passagesById: (ids) => getPassages(db, ids),
    passagesForEpisodes: (episodes) => passagesForEpisodes(db, episodes),
    replaceShortlist: (nodeId, rows, builtAt) => replaceShortlist(db, nodeId, rows, builtAt),
    readShortlist: (nodeId) => readShortlist(db, nodeId),
    reload: load,
  };
  const queryEmbedder = embedder
    ? {
        async embedQuery(text) {
          if (!model) throw new Error(`model ${embedder.model.name}@${embedder.model.revision} has no vectors in this store yet (run index-db embed)`);
          return embedQuery(embedder, model, text);
        },
      }
    : null;
  return { passageStore, queryEmbedder };
}
