/* RV-12 (docs/roadmap/recommender-v1.md, D4 (d), D10): evidence-pack embeddings.

   WHAT THIS IS. One vector per catalogued show, built from the same evidence
   pack the raters see (RV-03's `buildEvidence`, the only place show text is
   assembled, D10), so the student (RV-14) and the later client similarity term
   (`beta * cos(e_u, e_i)`, D2) have features. Keyless by default.

   THE TEXT. `textForEmbedding(pack)` joins the title, the editorial note, the
   classifier blurb, the feed description, the episode titles and descriptions
   and the first transcript window, UNDATAMARKED (the embedder is not a rater,
   so the U+02C6 spotlighting marks would only be noise in its vocabulary), with
   whitespace collapsed and the whole capped at MAX_EMBED_CHARS. It reads named
   pack fields only, never the audit `stripped` list, so nothing D7 hides (chart
   rank, counts, the publisher, `in_curated`) can reach a vector: the pack never
   carried them in the first place.

   THE EMBEDDER. `createPassageEmbedder({ kind })` from
   tools/passage-index/embedder.mjs: `stub` (64-dim word hashing, tests),
   `transformers` (Xenova/bge-small-en-v1.5, 384-dim q8 on CPU; the runtime is
   an opt-in install, `cd tools/corpus/embed && npm install`, weights under
   data-local/models), `openai` (FORAY_EMBED_URL / MODEL / KEY / DIM, any
   OpenAI-compatible server; never Anthropic). The `passage_prefix` convention
   is the embedder's model row's; this tool passes raw text.

   THE FILE. data-local/recommender/embeddings/<kind>-<model name>.json =
   `{ model: { name, revision, dim }, keys: [...], vectors: [[...]] }`, written
   atomically (tmp + rename) every `--checkpoint` new vectors and at the end, so
   a killed overnight run keeps what it had. A rerun skips keys already in the
   file; a file written by another model, revision or dimension is refused
   rather than mixed. Every vector is checked against `model.dim` before it is
   stored, and `--check` re-verifies every file in the directory. Components are
   rounded to 6 decimals (about 10 bytes each instead of 20).

   Never committed (data-local/). Nothing on a live app path reads it (dark).
   This module fetches nothing itself; only the opt-in `openai` kind posts to
   the server the operator names.

   LIVE STEP (not run by tests): ~26k texts of ~500 tokens on CPU is hours, not
   minutes. Run `--keys gold` first, `--keys all` overnight. */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { EMBEDDER_KINDS, createPassageEmbedder } from "../passage-index/embedder.mjs";
import { DATAMARK, buildEvidence, loadSources } from "./evidence.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");

export const MAX_EMBED_CHARS = 2000;
export const KEY_SETS = Object.freeze(["gold", "curated", "all"]);
export const DEFAULT_BATCH = 16;
export const DEFAULT_CHECKPOINT = 500;
export const VECTOR_DECIMALS = 6;

/** Path settings: env override (resolved against cwd) or the repo default. */
export const EMBED_PATHS = Object.freeze({
  embeddingsDir: ["RECOMMENDER_EMBEDDINGS_DIR", "data-local/recommender/embeddings"],
  goldSet: ["RECOMMENDER_GOLD_SET_PATH", "data/recommender/gold-set.json"],
});

export function embedPaths({ root = REPO_ROOT, env = process.env } = {}) {
  const out = {};
  for (const [name, [envName, def]] of Object.entries(EMBED_PATHS)) {
    out[name] = env[envName] ? resolvePath(process.cwd(), env[envName]) : resolvePath(root, def);
  }
  return out;
}

/* ------------------------------------------------------------------- text */

const MARK_RUN = new RegExp(`[\\s${DATAMARK}]+`, "g");

/** Datamarks back to spaces, whitespace runs collapsed, trimmed; "" for none. */
function plain(text) {
  if (typeof text !== "string") return "";
  return text.replace(MARK_RUN, " ").trim();
}

/** Cut to `max` UTF-16 units without leaving a lone high surrogate. */
function capChars(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/**
 * The embedder's input for one evidence pack: title, editorial note, blurb,
 * feed description, episode titles and descriptions, the first transcript
 * window; undatamarked and capped at MAX_EMBED_CHARS.
 */
export function textForEmbedding(pack, { maxChars = MAX_EMBED_CHARS } = {}) {
  const parts = [plain(pack?.title), plain(pack?.editorial_note), plain(pack?.blurb), plain(pack?.feed_description)];
  for (const ep of pack?.episodes ?? []) {
    const title = plain(ep?.title);
    const description = plain(ep?.description);
    parts.push(title && description ? `${title}: ${description}` : title || description);
  }
  parts.push(plain(pack?.transcript_windows?.[0]?.text));
  return capChars(parts.filter(Boolean).join("\n"), maxChars);
}

/* ------------------------------------------------------------------- keys */

/**
 * The show keys of a key set, in catalogue order. `curated` is every
 * data/catalog.json show_id; `all` adds every breadth row a curated show does
 * not already cover (the 26,394 catalogued shows, D4); `gold` is
 * data/recommender/gold-set.json's shows (RV-07).
 */
export function keysFor(set, sources, { goldSetPath } = {}) {
  if (set === "curated") return [...sources.curated.keys()];
  if (set === "all") {
    const keys = [...sources.curated.keys()];
    for (const acid of sources.breadth.keys()) if (!sources.curatedByAcid.has(acid)) keys.push(acid);
    return keys;
  }
  if (set === "gold") {
    if (!goldSetPath || !existsSync(goldSetPath)) {
      throw new Error(`no gold set at ${goldSetPath}; build it first with tools/recommender/sample.mjs (RV-07)`);
    }
    const doc = JSON.parse(readFileSync(goldSetPath, "utf8"));
    if (!Array.isArray(doc?.shows)) throw new Error(`${goldSetPath} has no shows array`);
    return [...new Set(doc.shows.map((s) => String(s?.show_key ?? "")).filter(Boolean))];
  }
  throw new Error(`unknown --keys ${JSON.stringify(set)}; expected one of ${KEY_SETS.join(", ")}`);
}

/* ------------------------------------------------------------------- file */

/** File-name-safe model name: "Xenova/bge-small-en-v1.5" -> "Xenova-bge-small-en-v1.5". */
export function safeModelName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

export function embeddingsPath(dir, kind, model) {
  return join(dir, `${kind}-${safeModelName(model.name)}.json`);
}

const round = (x) => {
  const f = 10 ** VECTOR_DECIMALS;
  const r = Math.round(Number(x) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** Problems with an embeddings document (`[]` when it is sound): every vector
    has exactly `model.dim` finite numbers, one per unique key. */
export function checkEmbeddings(doc) {
  const problems = [];
  const dim = doc?.model?.dim;
  if (typeof doc?.model?.name !== "string" || !doc.model.name) problems.push("model.name is missing");
  if (!Number.isInteger(dim) || dim <= 0) problems.push(`model.dim must be a positive integer, got ${JSON.stringify(dim ?? null)}`);
  if (!Array.isArray(doc?.keys) || !Array.isArray(doc?.vectors)) {
    problems.push("keys and vectors must be arrays");
    return problems;
  }
  if (doc.keys.length !== doc.vectors.length) problems.push(`${doc.keys.length} keys but ${doc.vectors.length} vectors`);
  const seen = new Set();
  doc.keys.forEach((k, i) => {
    if (typeof k !== "string" || !k) problems.push(`keys[${i}] is not a non-empty string`);
    else if (seen.has(k)) problems.push(`keys[${i}] ${k} is repeated`);
    seen.add(k);
  });
  if (Number.isInteger(dim)) {
    doc.vectors.forEach((v, i) => {
      if (!Array.isArray(v) || v.length !== dim) problems.push(`vectors[${i}] (${doc.keys[i]}) has ${Array.isArray(v) ? v.length : "no"} entries, model.dim is ${dim}`);
      else if (!v.every((x) => typeof x === "number" && Number.isFinite(x))) problems.push(`vectors[${i}] (${doc.keys[i]}) has a non-finite entry`);
    });
  }
  return problems;
}

function loadEmbeddings(path, model) {
  if (!existsSync(path)) return { model: { name: model.name, revision: String(model.revision ?? ""), dim: model.dim }, keys: [], vectors: [] };
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const problems = checkEmbeddings(doc);
  if (problems.length) throw new Error(`${path} is not a sound embeddings file: ${problems.slice(0, 3).join("; ")}`);
  const want = { name: model.name, revision: String(model.revision ?? ""), dim: model.dim };
  if (doc.model.name !== want.name || String(doc.model.revision ?? "") !== want.revision || doc.model.dim !== want.dim) {
    throw new Error(`${path} was written by ${JSON.stringify(doc.model)}, not ${JSON.stringify(want)}; move it aside rather than mix vector spaces`);
  }
  return doc;
}

function saveEmbeddings(path, doc) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc)}\n`);
  renameSync(tmp, path);
}

/* -------------------------------------------------------------------- run */

/**
 * Embeds every key not already in `outPath` (at most `limit` of them) and
 * writes the file. Returns counts. A vector of the wrong length is refused
 * before anything from its batch is stored.
 */
export async function runEmbed({ keys, sources, embedder, outPath, limit = Infinity, batchSize = DEFAULT_BATCH, checkpoint = DEFAULT_CHECKPOINT, log = () => {} }) {
  const { model } = embedder;
  if (!Number.isInteger(model?.dim) || model.dim <= 0) throw new Error(`embedder model has no positive integer dim: ${JSON.stringify(model ?? null)}`);
  const doc = loadEmbeddings(outPath, model);
  const have = new Set(doc.keys);
  const counts = { requested: keys.length, already: 0, embedded: 0, skipped_none: 0 };

  const todo = [];
  for (const key of keys) {
    if (have.has(key)) {
      counts.already++;
      continue;
    }
    if (todo.length >= limit) break;
    const pack = buildEvidence(key, sources);
    // A show with no evidence beyond its title gets no rating (D4) and no vector.
    if (pack.tier === "none") {
      counts.skipped_none++;
      continue;
    }
    have.add(key);
    todo.push({ key, text: textForEmbedding(pack) });
  }

  let sinceSave = 0;
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const vectors = await embedder.embed(batch.map((t) => t.text));
    if (!Array.isArray(vectors) || vectors.length !== batch.length) {
      throw new Error(`embedder returned ${Array.isArray(vectors) ? vectors.length : "no"} vectors for ${batch.length} texts`);
    }
    vectors.forEach((v, j) => {
      if (!v || v.length !== model.dim) throw new Error(`refused: ${batch[j].key} got a ${v ? v.length : 0}-entry vector, ${model.name} is ${model.dim}-dim`);
    });
    batch.forEach((t, j) => {
      doc.keys.push(t.key);
      doc.vectors.push(Array.from(vectors[j], round));
    });
    counts.embedded += batch.length;
    sinceSave += batch.length;
    if (sinceSave >= checkpoint) {
      saveEmbeddings(outPath, doc);
      sinceSave = 0;
      log(`checkpoint: ${doc.keys.length} vectors in ${outPath}`);
    }
  }
  if (counts.embedded > 0 || !existsSync(outPath)) saveEmbeddings(outPath, doc);
  return { ...counts, total: doc.keys.length, path: outPath };
}

/** `--check`: every embeddings file in `dir` (or the one `file`), problems by file. */
export function checkEmbeddingsDir(dir, { file } = {}) {
  const files = file ? [file] : existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)) : [];
  const out = [];
  for (const f of files) {
    let problems;
    try {
      problems = checkEmbeddings(JSON.parse(readFileSync(f, "utf8")));
    } catch (e) {
      problems = [`unreadable: ${e.message}`];
    }
    out.push({ file: f, problems });
  }
  return out;
}

/* -------------------------------------------------------------------- CLI */

const USAGE =
  "usage: node tools/recommender/embed.mjs --keys gold|curated|all --embedder stub|transformers|openai [--limit N] [--batch N] [--checkpoint N] [--out <file>]\n" +
  "       node tools/recommender/embed.mjs --check [--out <file>]";

export function parseArgs(argv) {
  const args = { keys: null, embedder: null, limit: Infinity, batch: DEFAULT_BATCH, checkpoint: DEFAULT_CHECKPOINT, out: null, check: false };
  const int = (flag, v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer; ${USAGE}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keys") args.keys = argv[++i];
    else if (a === "--embedder") args.embedder = argv[++i];
    else if (a === "--limit") args.limit = int(a, argv[++i]);
    else if (a === "--batch") args.batch = int(a, argv[++i]);
    else if (a === "--checkpoint") args.checkpoint = int(a, argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--check") args.check = true;
    else throw new Error(`unknown argument ${a}; ${USAGE}`);
  }
  if (args.check) return args;
  if (!KEY_SETS.includes(args.keys)) throw new Error(`--keys must be one of ${KEY_SETS.join(", ")}; ${USAGE}`);
  if (!EMBEDDER_KINDS.includes(args.embedder)) throw new Error(`--embedder must be one of ${EMBEDDER_KINDS.join(", ")}; ${USAGE}`);
  return args;
}

export async function main(argv = process.argv.slice(2), { env = process.env, root = REPO_ROOT, createEmbedder = createPassageEmbedder, stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return 2;
  }
  const paths = embedPaths({ root, env });
  const out = args.out ? resolvePath(process.cwd(), args.out) : null;

  if (args.check) {
    const results = checkEmbeddingsDir(paths.embeddingsDir, { file: out });
    let bad = 0;
    for (const r of results) {
      if (r.problems.length) bad++;
      stdout.write(`${r.problems.length ? "FAIL" : "ok"}  ${r.file}${r.problems.length ? `\n  ${r.problems.slice(0, 5).join("\n  ")}` : ""}\n`);
    }
    if (!results.length) stdout.write(`no embeddings files under ${paths.embeddingsDir}\n`);
    return bad ? 1 : 0;
  }

  let embedder;
  try {
    embedder = await createEmbedder({ kind: args.embedder, env });
  } catch (e) {
    const hint = args.embedder === "transformers" ? " (install the runtime: cd tools/corpus/embed && npm install)" : "";
    stderr.write(`embedder ${args.embedder} unavailable: ${e.message}${hint}\n`);
    return 2;
  }

  try {
    const sources = loadSources({ root, env });
    const keys = keysFor(args.keys, sources, { goldSetPath: paths.goldSet });
    const outPath = out ?? embeddingsPath(paths.embeddingsDir, args.embedder, embedder.model);
    const res = await runEmbed({ keys, sources, embedder, outPath, limit: args.limit, batchSize: args.batch, checkpoint: args.checkpoint, log: (m) => stderr.write(`${m}\n`) });
    stdout.write(`${JSON.stringify(res)}\n`);
    return 0;
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return 1;
  }
}

if (isEntryScript(import.meta.url)) process.exitCode = await main();
