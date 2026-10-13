#!/usr/bin/env node
/* Dossier selection pass by a local Qwen (GV-65, W3-20,
 * docs/roadmap/generation-v2.md): choose and flag passages, never write text.
 *
 * Input: the code-built dossiers of build.mjs (GV-30) in data-local/dossiers/.
 * Per node, ONE structured-output call (llm.mjs, the LiteLLM alias
 * FORAY_DOSSIER_MODEL, default local-worker) is shown the node label, a few
 * subject sentences and the numbered passages, and replies only with passage
 * NUMBERS:
 *
 *   {keep: int[], contested: int[], about_subject: int[]}
 *
 * Code applies the reply; the model's words are never stored:
 *   - every number must name a passage that was shown (1..shown), else the
 *     whole reply is refused;
 *   - passages not in `keep` are dropped, kept ones are copied unchanged (the
 *     same text, offset, docId and sourceId), in document order;
 *   - a kept passage in `contested` gets `contested: true` (GV-69 surfaces up
 *     to three contested passages as controversies);
 *   - the dossier's builder becomes 'qwen-select', with `model` (the alias
 *     sent) and `selected_at`. Sources are kept as they are (provenance).
 * `about_subject` has no field in the dossier schema; it is recorded, with
 * the kept, dropped and contested lists, in the selection record
 * <node>.select.json next to the dossier, for the live step's spot-check.
 *
 * Anything else leaves the code-built dossier exactly as it was: a transport
 * failure, a reply that is not JSON or not the schema, an out-of-range or
 * non-integer number, or a `keep` that keeps nothing. Before a selected
 * dossier replaces it, the code-built file's bytes are copied to
 * <node>.code.json, kept for the golden-set comparison.
 *
 * Trimming: the prompt is held to about 12k tokens (the P40 lane runs
 * -c 65536 --parallel 1). Passages are shown whole, in document order, until
 * the budget is spent; passages past the budget are not shown, get no
 * number, and are therefore not kept. The selection record counts them
 * (`unseen`).
 *
 * Resumable per node (P40 XID faults can stall a run): a dossier whose
 * builder is already 'qwen-select' is skipped, every node's files and the
 * manifest entry are written atomically as soon as it is done, and a rerun
 * picks up where the last one stopped. `--force` reselects a selected node
 * from its <node>.code.json. Three transport failures in a row stop the run
 * (the lane is down), leaving every remaining node code-built.
 *
 *   node tools/corpus/dossiers/qwen-select.mjs --all
 *   node tools/corpus/dossiers/qwen-select.mjs --node engineering/energy-fusion
 *     [--dir <dossier dir>] [--taxonomy <file>] [--force]
 *     [--max-prompt-tokens 12000] [--timeout-ms 600000]
 *
 * Opt-in tool: nothing runs it by default. GV-69 reads whichever dossier is
 * on disk, and `builder` says which pass made it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isEntryScript } from "../../ci/entry.mjs";
import { DOSSIERS_DIR, MANIFEST_FILE, dossierPath, readManifest, safeNodeId } from "./build.mjs";
import { validate, validateDossier, validateManifest } from "./schema.mjs";
import { TAXONOMY_PATH } from "./seeds.mjs";
import { DEFAULT_TIMEOUT_MS, LlmError, createChatClient, llmConfig } from "./llm.mjs";

export const BUILDER = "qwen-select";
export const SCHEMA_NAME = "dossier_select";
export const DEFAULT_MAX_PROMPT_TOKENS = 12_000;
/** Conservative chars-per-token for English under the Qwen tokenizer, so
    the estimate errs towards a shorter prompt. */
export const CHARS_PER_TOKEN = 3.5;
export const MAX_REPLY_TOKENS = 2_048;
export const MAX_TRANSPORT_FAILURES = 3;

/** The reply schema sent as response_format and checked again on receipt. */
export const REPLY_SCHEMA = {
  type: "object",
  required: ["keep", "contested", "about_subject"],
  additionalProperties: false,
  properties: {
    keep: { type: "array", items: { type: "integer", minimum: 1 } },
    contested: { type: "array", items: { type: "integer", minimum: 1 } },
    about_subject: { type: "array", items: { type: "integer", minimum: 1 } },
  },
};

export const SYSTEM_PROMPT = [
  "You choose passages for a podcast research dossier about one subject.",
  "Every passage is fetched text. You never write, rewrite or summarise text: you only return passage numbers.",
  "keep: the passages worth keeping because they state facts relevant to the subject. Leave out passages that are off topic, navigation, captions, lists of names with no facts, or duplicates of another passage.",
  "contested: the kept passages that report a disputed, debated, disproven or uncertain claim.",
  "about_subject: the kept passages that are directly about the subject itself rather than background.",
  'Reply with JSON only: {"keep": [...], "contested": [...], "about_subject": [...]}. Use only the numbers shown in square brackets.',
].join("\n");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export class SelectionError extends Error {
  constructor(reason, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "SelectionError";
    this.reason = reason;
  }
}

/** Taxonomy node -> a few plain subject sentences (label, parent, terms).
    A node not in the taxonomy (e.g. subject/<slug>) gets its label only. */
export function subjectSentences(dossier, nodes = []) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const node = byId.get(dossier.node_id);
  const out = [`The subject is ${dossier.label}.`];
  const parent = node?.parent ? byId.get(node.parent) : null;
  if (parent?.label) out.push(`It is a topic within ${parent.label}.`);
  const terms = Array.isArray(node?.terms) ? node.terms.filter((t) => typeof t === "string" && t) : [];
  if (terms.length) out.push(`Related terms: ${terms.map((t) => t.replace(/-/g, " ")).join(", ")}.`);
  return out;
}

const sourceLabel = (src) => (src ? (src.title ? `${src.publication} - ${src.title}` : src.publication) : "unknown source");

/**
 * The prompt for one dossier. Passages are numbered from 1 in document order
 * and shown whole until `maxPromptTokens` (estimated at CHARS_PER_TOKEN) is
 * spent; at least one passage is always shown. Returns {messages, shown}
 * where `shown` is how many leading passages carry a number.
 */
export function buildPrompt(dossier, { nodes = [], maxPromptTokens = DEFAULT_MAX_PROMPT_TOKENS } = {}) {
  const sources = new Map(dossier.sources.map((s) => [s.sourceId, s]));
  const head = [`Subject: ${dossier.label}`, ...subjectSentences(dossier, nodes), "", "Passages:"].join("\n");
  const budget = Math.floor(maxPromptTokens * CHARS_PER_TOKEN) - SYSTEM_PROMPT.length - head.length;
  const lines = [];
  let used = 0;
  for (const [i, p] of dossier.passages.entries()) {
    const line = `[${i + 1}] (${sourceLabel(sources.get(p.sourceId))}) ${p.text}`;
    if (lines.length > 0 && used + line.length + 2 > budget) break;
    lines.push(line);
    used += line.length + 2;
  }
  return {
    shown: lines.length,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `${head}\n${lines.join("\n\n")}` },
    ],
  };
}

/** The reply content -> {keep, contested, about_subject} as sorted unique
    1-based numbers, or a SelectionError. Tolerates one ```json fence. */
export function parseReply(content, shown) {
  let obj;
  const text = String(content).trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1");
  try {
    obj = JSON.parse(text);
  } catch {
    throw new SelectionError("malformed_reply", "not JSON");
  }
  const errs = validate(REPLY_SCHEMA, obj);
  if (errs.length) throw new SelectionError("malformed_reply", errs.slice(0, 3).join("; "));
  const out = {};
  for (const key of ["keep", "contested", "about_subject"]) {
    const bad = obj[key].filter((n) => n < 1 || n > shown);
    if (bad.length) throw new SelectionError("out_of_range", `${key} names ${bad.join(", ")} but passages run 1..${shown}`);
    out[key] = [...new Set(obj[key])].sort((a, b) => a - b);
  }
  if (out.keep.length === 0) throw new SelectionError("empty_keep", "the reply keeps no passage");
  return out;
}

/**
 * Applies a parsed reply. Kept passages are the SAME objects' fields copied
 * unchanged (plus contested:true when flagged); nothing else is touched.
 * Throws SelectionError if any kept passage would differ from its input.
 */
export function applySelection(dossier, reply, { model, selectedAt }) {
  const keep = new Set(reply.keep);
  const contested = new Set(reply.contested);
  const passages = [];
  dossier.passages.forEach((p, i) => {
    const n = i + 1;
    if (!keep.has(n)) return;
    const { contested: _drop, ...rest } = p;
    passages.push(contested.has(n) ? { ...rest, contested: true } : rest);
  });
  // The never-write guarantee, checked rather than assumed.
  const byDocId = new Map(dossier.passages.map((p) => [p.docId, p]));
  for (const p of passages) {
    const src = byDocId.get(p.docId);
    if (!src || src.text !== p.text || src.offset !== p.offset || src.sourceId !== p.sourceId) {
      throw new SelectionError("edited_passage", p.docId);
    }
  }
  const { model: _m, selected_at: _s, ...base } = dossier;
  const out = { ...base, builder: BUILDER, model, selected_at: selectedAt, passages };
  const errs = validateDossier(out);
  if (errs.length) throw new SelectionError("invalid_dossier", errs.slice(0, 3).join("; "));
  return out;
}

export const codePath = (dir, id) => path.join(dir, `${safeNodeId(id)}.code.json`);
export const selectRecordPath = (dir, id) => path.join(dir, `${safeNodeId(id)}.select.json`);

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Selects one node. Returns {status, reason?, ...}: status is 'skipped'
 * (already selected), 'selected', 'unchanged' (refused reply; the code-built
 * dossier stays) or 'transport' (the call failed; the dossier stays).
 */
export async function selectNode(id, { dir, client, nodes = [], force = false, maxPromptTokens, now = () => Date.now(), log = () => {} }) {
  const file = dossierPath(dir, id);
  if (!fs.existsSync(file)) return { id, status: "unchanged", reason: "no_file" };
  let current = readJson(file);
  let sourceBytes = fs.readFileSync(file);
  if (current.builder === BUILDER) {
    if (!force) return { id, status: "skipped" };
    const code = codePath(dir, id);
    if (!fs.existsSync(code)) return { id, status: "unchanged", reason: "no_code_copy" };
    sourceBytes = fs.readFileSync(code);
    current = JSON.parse(sourceBytes.toString("utf8"));
  }
  const errs = validateDossier(current);
  if (errs.length || current.builder !== "code") {
    return { id, status: "unchanged", reason: "invalid_input", detail: errs.slice(0, 3).join("; ") || `builder ${current.builder}` };
  }

  const { messages, shown } = buildPrompt(current, { nodes, maxPromptTokens });
  let reply;
  try {
    reply = await client.complete({ messages, schema: REPLY_SCHEMA, schemaName: SCHEMA_NAME, maxTokens: MAX_REPLY_TOKENS });
  } catch (err) {
    if (err instanceof LlmError) {
      log(`  ${id}: call failed (${err.reason}); code-built dossier kept`);
      return { id, status: "transport", reason: err.reason };
    }
    throw err;
  }
  let selected;
  let parsed;
  try {
    parsed = parseReply(reply.content, shown);
    selected = applySelection(current, parsed, { model: client.model, selectedAt: new Date(now()).toISOString() });
  } catch (err) {
    if (!(err instanceof SelectionError)) throw err;
    log(`  ${id}: reply refused (${err.message}); code-built dossier kept`);
    return { id, status: "unchanged", reason: err.reason };
  }

  // Order matters for resumability: the code copy first, then the selected
  // dossier (the "done" marker), then its record and the manifest entry.
  writeAtomic(codePath(dir, id), sourceBytes);
  const text = `${JSON.stringify(selected, null, 2)}\n`;
  writeAtomic(file, text);
  const dropped = [];
  for (let n = 1; n <= current.passages.length; n++) if (!parsed.keep.includes(n)) dropped.push(n);
  const record = {
    node_id: id,
    model: client.model,
    served_by: reply.model,
    selected_at: selected.selected_at,
    ms: reply.ms,
    usage: reply.usage,
    passages_in: current.passages.length,
    shown,
    unseen: current.passages.length - shown,
    keep: parsed.keep.map((n) => current.passages[n - 1].docId),
    dropped: dropped.map((n) => current.passages[n - 1].docId),
    contested: parsed.contested.filter((n) => parsed.keep.includes(n)).map((n) => current.passages[n - 1].docId),
    about_subject: parsed.about_subject.map((n) => current.passages[n - 1].docId),
  };
  writeAtomic(selectRecordPath(dir, id), `${JSON.stringify(record, null, 2)}\n`);
  updateManifest(dir, id, { sha256: sha256(Buffer.from(text, "utf8")), passages: selected.passages.length, now });
  log(`  ${id}: kept ${selected.passages.length}/${current.passages.length} (${record.contested.length} contested, ${record.unseen} unseen)`);
  return { id, status: "selected", kept: selected.passages.length, of: current.passages.length, unseen: record.unseen };
}

/** Points the manifest entry at the selected file's bytes; a dir with no
    manifest (or no entry for the node) is left alone. */
function updateManifest(dir, id, { sha256: digest, passages, now }) {
  const manifest = readManifest(dir);
  const entry = manifest?.nodes?.[id];
  if (!entry) return;
  entry.sha256 = digest;
  entry.passages = passages;
  manifest.updated_at = new Date(now()).toISOString();
  const errs = validateManifest(manifest);
  if (errs.length) throw new Error(`manifest fails schema.mjs: ${errs.slice(0, 3).join("; ")}`);
  writeAtomic(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Every node in the manifest that has a file, in manifest order. */
export function manifestNodeIds(dir) {
  const manifest = readManifest(dir);
  if (!manifest) throw new Error(`no ${MANIFEST_FILE} in ${dir}: run build.mjs first`);
  return Object.entries(manifest.nodes)
    .filter(([, e]) => e.file)
    .map(([id]) => id);
}

export async function selectDossiers({ ids, dir, client, nodes = [], force = false, maxPromptTokens = DEFAULT_MAX_PROMPT_TOKENS, now, log = () => {} }) {
  const results = [];
  let failuresInARow = 0;
  for (const id of ids) {
    const r = await selectNode(id, { dir, client, nodes, force, maxPromptTokens, ...(now ? { now } : {}), log });
    results.push(r);
    if (r.status === "transport") {
      failuresInARow += 1;
      if (failuresInARow >= MAX_TRANSPORT_FAILURES) {
        log(`stopping: ${failuresInARow} calls failed in a row; rerun to resume`);
        break;
      }
    } else if (r.status !== "skipped") {
      failuresInARow = 0;
    }
  }
  return results;
}

const USAGE =
  "usage: node tools/corpus/dossiers/qwen-select.mjs (--all | --node <id> [--node <id> ...]) [--dir <dir>] [--taxonomy <file>] [--force] [--max-prompt-tokens <n>] [--timeout-ms <n>]";

export function parseArgs(argv) {
  const opts = { all: false, nodes: [], dir: DOSSIERS_DIR, taxonomy: TAXONOMY_PATH, force: false, maxPromptTokens: DEFAULT_MAX_PROMPT_TOKENS, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    const positive = () => {
      const n = Number(value());
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${a} needs a positive integer\n${USAGE}`);
      return n;
    };
    if (a === "--all") opts.all = true;
    else if (a === "--node") opts.nodes.push(value());
    else if (a === "--dir") opts.dir = path.resolve(value());
    else if (a === "--taxonomy") opts.taxonomy = value();
    else if (a === "--force") opts.force = true;
    else if (a === "--max-prompt-tokens") opts.maxPromptTokens = positive();
    else if (a === "--timeout-ms") opts.timeoutMs = positive();
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  if (!opts.all && opts.nodes.length === 0) throw new Error(USAGE);
  if (opts.all && opts.nodes.length) throw new Error(`--all and --node are exclusive\n${USAGE}`);
  return opts;
}

function loadNodes(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).nodes ?? [];
  } catch {
    return [];
  }
}

export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl, now, log = (s) => console.log(s) } = {}) {
  const opts = parseArgs(argv);
  const cfg = llmConfig(env);
  const client = createChatClient({ ...cfg, timeoutMs: opts.timeoutMs, ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}) });
  const ids = opts.all ? manifestNodeIds(opts.dir) : opts.nodes;
  log(`selecting ${ids.length} node(s) in ${opts.dir} with ${cfg.model}`);
  const results = await selectDossiers({ ids, dir: opts.dir, client, nodes: loadNodes(opts.taxonomy), force: opts.force, maxPromptTokens: opts.maxPromptTokens, now, log });
  const count = (s) => results.filter((r) => r.status === s).length;
  log(`selected ${count("selected")}, skipped ${count("skipped")} (already selected), unchanged ${count("unchanged")}, failed ${count("transport")}, not reached ${ids.length - results.length}`);
  return results;
}

if (isEntryScript(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
