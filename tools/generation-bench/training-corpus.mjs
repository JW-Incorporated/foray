/* training-corpus.mjs — the act-level training-example ledger and the
 * fine-tune readiness count (GV-114, docs/roadmap/generation-v2.md, from
 * W7-10; covers R2-17). NO TRAINING RUN AND NO MODEL CALL: this tool reads
 * files and writes files under data-local/, nothing else.
 *
 * WHAT IT IS FOR
 * "Fine-tuning last, about 500 act-level examples needed" (R2-17) is a
 * number nobody tracked. An act-level example is what the writer was SENT
 * for one act and what it RETURNED, plus a label saying whether that reply
 * was good. The committed Forays in data/forays.json keep only scripts: their
 * acts (16 today) have no inputs, so they are reference only and never an
 * example. Inputs exist only where `generate-forays --record-exchanges`
 * (GV-110, bench prompts only) wrote writer-exchange/1 lines; this tool joins
 * those to labels and counts what is usable.
 *
 * SUBCOMMANDS
 *   build      [--exchanges <dir>]... [--verdicts <jsonl>] [--swaps <dir>]
 *              [--cards <jsonl>] [--keys <dir>] [--out <jsonl>]
 *              Reads every *.exchanges.jsonl under each --exchanges dir
 *              (default data-local/swaps), the founder's review verdicts
 *              (data-local/review/verdicts.jsonl, review-queue.mjs, GV-41) and
 *              the per-prompt pairwise winners of every swap experiment
 *              (data-local/swaps/<id>/evidence.json unsealed with the
 *              founder's listen cards and the local pack keys, through
 *              swap-experiment.mjs's unsealForEvidence, GV-75). Writes one
 *              act-example/1 row per exchange to
 *              data-local/training/act-examples.jsonl (replaced whole).
 *   count      [--ledger <jsonl>] [--forays <json>] [--doc <md>] [--no-append]
 *              [--date YYYY-MM-DD]
 *              Prints READINESS_LINE (below) and appends it, dated, to the
 *              readiness section of docs/curation/model-swaps.md (between
 *              the training:readiness markers; an identical last line is not
 *              repeated). A missing ledger counts as no examples.
 *   export-sft --out <jsonl> [--ledger <jsonl>] [--allow-claude-derived]
 *              Writes one chat-format SFT line per usable example:
 *              { messages: [ { role: "user", content: <prompt rebuilt from the
 *              recorded request> }, { role: "assistant", content: <the seams
 *              JSON> } ] }. The prompt builder is injected; the CLI's default
 *              loads the Qwen writer's exported builder from
 *              backend/src/generation/prompts/actWrite.ts through tsx.
 *
 * THE ROW (EXAMPLE_SCHEMA, act-example/1)
 *   { schema, exampleId, forayKey, promptId?, attempt, actIndex, round, call,
 *     exchangeRef: { file, line }, label: keep|reject|edited|null,
 *     labelSource: founder-verdict|pairwise-win|pairwise-loss|null,
 *     generator: { impl, model } | null, claudeDerived, finalRound, verified }
 * - exampleId is sha-256 of the canonical JSON (sorted keys) of the request
 *   and the reply, so the same exchange recorded twice is one example.
 * - finalRound: this round's reply is the act's final text: the last round of
 *   the LATEST attempt that recorded the act in that file (a resumed run that
 *   rewrote the act supersedes the earlier attempt's rounds).
 * - verified: the round raised no mechanical issue and its verifier verdict
 *   judged at least one seam, every judged seam supported and every judged
 *   beat carried. A round with no verifier call is not verified.
 * - A label lands only on the final round of an act: the founder's verdict
 *   on that act (pass -> keep, fail -> reject, fix -> edited) wins; otherwise
 *   a swap pair's preference (the preferred arm's act -> keep/pairwise-win,
 *   the other arm's -> reject/pairwise-loss; a tie labels nothing). Every
 *   other exchange is a row with label null.
 * - claudeDerived: the generator's impl is "anthropic" or its model names
 *   Claude. Every data/forays.json act is Claude-written too; those have no
 *   inputs and are counted, not rowed.
 *
 * WHAT COUNTS TOWARD 500 (usableExample)
 *   final round AND verified AND labelled keep AND not claudeDerived AND a
 *   recorded generator, counted once per exampleId. Claude-built training
 *   data is parked (OQ-06, docs/roadmap/generation-v2.md "Constraints" and
 *   decision 25): claude-derived rows are held, counted separately, and
 *   export-sft leaves them out unless --allow-claude-derived is passed. That
 *   flag stays unused until the founder rules on OQ-06.
 *
 * JOINS
 * - Founder verdicts name a candidate id, a 1-based act and the candidate
 *   file's sha-256. An exchanges file sits next to its candidate
 *   (<out>/<forayKey>.exchanges.jsonl beside <out>/<forayKey>.json), so the
 *   candidate's id and bytes are read from there; a verdict on a regenerated
 *   candidate (another sha) labels nothing.
 * - Swap evidence names each arm's candidate by its file stem (== forayKey)
 *   and each arm's run dir; the listened act is act 1 (LISTEN_ACT), and an
 *   exchange is matched by run dir AND forayKey, since both arms share stems.
 *   An experiment whose pack keys are not on this machine is skipped, named.
 *
 * The exchanges hold transcript window text: every output stays under
 * data-local/ (gitignored). Nothing here writes data/forays.json.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { DEFAULT_STORE as DEFAULT_CARDS, REPO_ROOT, readCards } from "../listening/card.mjs";
import { DEFAULT_KEY_DIR, KEY_MISSING } from "../listening/unseal.mjs";
import { DEFAULT_VERDICTS, VERDICT_SCHEMA, actCount, readCandidate } from "../generation/review-queue.mjs";
import { listExchanges, parseExchanges, readExchange } from "./exchanges.mjs";
import { LISTEN_ACT, SWAPS_OUT, unsealForEvidence } from "./swap-experiment.mjs";

export const EXAMPLE_SCHEMA = "act-example/1";
export const READINESS_TARGET = 500;
export const LABELS = Object.freeze(["keep", "reject", "edited"]);
export const LABEL_SOURCES = Object.freeze(["founder-verdict", "pairwise-win", "pairwise-loss"]);
/** The founder's review verdict -> the example's label. */
export const VERDICT_LABEL = Object.freeze({ pass: "keep", fail: "reject", fix: "edited" });

/* Repo-relative defaults, resolved against the CLI's root. */
const CARDS_REL = repoRel(DEFAULT_CARDS);
const KEYS_REL = repoRel(DEFAULT_KEY_DIR);
const VERDICTS_REL = repoRel(DEFAULT_VERDICTS);
function repoRel(abs) {
  return path.relative(REPO_ROOT, abs);
}

export const DEFAULT_EXCHANGES_DIR = path.join(REPO_ROOT, SWAPS_OUT);
export const DEFAULT_SWAPS_DIR = path.join(REPO_ROOT, SWAPS_OUT);
export const DEFAULT_LEDGER = path.join(REPO_ROOT, "data-local", "training", "act-examples.jsonl");
export const DEFAULT_FORAYS = path.join(REPO_ROOT, "data", "forays.json");
export const DEFAULT_DOC = path.join(REPO_ROOT, "docs", "curation", "model-swaps.md");
export const READINESS_BEGIN = "<!-- training:readiness:begin -->";
export const READINESS_END = "<!-- training:readiness:end -->";
export const ALLOW_CLAUDE_FLAG = "--allow-claude-derived";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const toPosix = (p) => p.split(path.sep).join("/");

/* ------------------------------------------------------------------ */
/* Identity and provenance                                             */
/* ------------------------------------------------------------------ */

/** JSON with every object's keys sorted, so key order never changes an id. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha-256 of the request and the reply: stable for an identical pair. */
export function exampleIdOf(request, reply) {
  return crypto.createHash("sha256").update(`${canonicalJson(request)}\n${canonicalJson(reply)}`).digest("hex");
}

/** The recorded writer assignment, as {impl, model}; null when unrecorded. */
export function generatorOf(generator) {
  if (!isPlainObject(generator) || typeof generator.impl !== "string" || generator.impl.length === 0) return null;
  return { impl: generator.impl, model: typeof generator.model === "string" ? generator.model : null };
}

/** OQ-06: an exchange the Anthropic writer produced, or any Claude model. */
export function isClaudeDerived(generator) {
  if (!generator) return false;
  return generator.impl.toLowerCase() === "anthropic" || /claude|anthropic/i.test(generator.model ?? "");
}

/** The round is mechanically clean and its verifier passed every seam and
 * beat it judged (at least one seam). No verifier call: not verified. */
export function isVerifiedRound(record) {
  if (!Array.isArray(record.mechanical) || record.mechanical.length > 0) return false;
  const verdict = record.verdict;
  if (!isPlainObject(verdict)) return false;
  const seams = Array.isArray(verdict.seams) ? verdict.seams : [];
  const beats = Array.isArray(verdict.beats) ? verdict.beats : [];
  if (seams.length === 0) return false;
  return seams.every((s) => isPlainObject(s) && s.claimsSupported === true) && beats.every((b) => isPlainObject(b) && b.carried === true);
}

/** The one rule for what counts toward READINESS_TARGET. */
export function usableExample(row) {
  return row.label === "keep" && row.finalRound === true && row.verified === true && row.claudeDerived === false && row.generator !== null;
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

/** verdicts.jsonl -> rows of the review schema; a missing file is none. */
export function readVerdicts(file = DEFAULT_VERDICTS) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === "") continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${file}: line ${i + 1} is not JSON (${err.message})`);
    }
    if (!isPlainObject(row) || row.schema !== VERDICT_SCHEMA) throw new Error(`${file}: line ${i + 1} is not a ${VERDICT_SCHEMA} row`);
    if (!(row.verdict in VERDICT_LABEL)) throw new Error(`${file}: line ${i + 1} has verdict ${JSON.stringify(row.verdict)}`);
    if (!Number.isInteger(row.act) || row.act < 1) throw new Error(`${file}: line ${i + 1} has no act`);
    out.push(row);
  }
  return out;
}

/** The latest verdict per (forayId, act, candidateSha256). */
function latestVerdicts(verdicts) {
  const m = new Map();
  for (const v of verdicts) {
    const k = `${v.forayId}\u0000${v.act}\u0000${v.candidateSha256}`;
    const prev = m.get(k);
    if (!prev || Date.parse(v.at) >= Date.parse(prev.at)) m.set(k, v);
  }
  return m;
}

/**
 * The per-prompt pairwise outcome of every swap experiment under `swapsDir`
 * that has an evidence.json: one entry per arm of a pair with a preference,
 * { experiment, promptId, actIndex, dir, forayKey, outcome: win|loss }.
 * `dir` is the arm's run dir, absolute. Ties, unheard prompts and E0's
 * reference arm (no run dir) yield nothing. Returns { outcomes, skipped }.
 */
export function pairwiseOutcomes({ swapsDir = DEFAULT_SWAPS_DIR, cards = [], keyDir = DEFAULT_KEY_DIR, root = REPO_ROOT, unsealer = unsealForEvidence } = {}) {
  const outcomes = [];
  const skipped = [];
  if (!fs.existsSync(swapsDir)) return { outcomes, skipped };
  for (const entry of fs.readdirSync(swapsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = path.join(swapsDir, entry.name, "evidence.json");
    if (!fs.existsSync(file)) continue;
    const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
    const packs = new Set((evidence.prompts || []).map((p) => p.packId).filter(Boolean));
    const mine = cards.filter((c) => packs.has(c.packId));
    if (mine.length === 0) continue;
    let heard;
    try {
      heard = unsealer(evidence, mine, { keyDir });
    } catch (err) {
      if (err.code === KEY_MISSING) {
        skipped.push(`${evidence.experiment}: pack keys not on this machine`);
        continue;
      }
      throw err;
    }
    for (const prompt of evidence.prompts || []) {
      const preference = heard.get(prompt.promptId)?.preference;
      if (preference !== "A" && preference !== "B") continue;
      for (const arm of ["A", "B"]) {
        const runDir = evidence.runDirs?.[arm];
        const forayKey = prompt.candidates?.[arm];
        if (typeof runDir !== "string" || typeof forayKey !== "string" || runDir.endsWith(".json")) continue;
        outcomes.push({
          experiment: evidence.experiment,
          promptId: prompt.promptId,
          actIndex: LISTEN_ACT - 1,
          dir: path.resolve(root, runDir),
          forayKey,
          outcome: arm === preference ? "win" : "loss"
        });
      }
    }
  }
  return { outcomes, skipped };
}

/* ------------------------------------------------------------------ */
/* build                                                               */
/* ------------------------------------------------------------------ */

/** A path for the ledger: repo-relative POSIX when inside `root`. */
function refPath(file, root) {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? toPosix(rel) : toPosix(path.resolve(file));
}

/** The candidate beside an exchanges file, or null when there is none. */
function candidateBeside(file, forayKey, cache) {
  const candidateFile = path.join(path.dirname(file), `${forayKey}.json`);
  if (!cache.has(candidateFile)) {
    let hit = null;
    if (fs.existsSync(candidateFile)) {
      try {
        const { candidate, sha256 } = readCandidate(candidateFile);
        hit = { id: candidate.id, sha256 };
      } catch {
        hit = null;
      }
    }
    cache.set(candidateFile, hit);
  }
  return cache.get(candidateFile);
}

/**
 * The ledger rows: one per exchange under `exchangeDirs`, in file then line
 * order, labelled from `verdicts` and pairwise `outcomes`.
 */
export function buildExamples({ exchangeDirs = [DEFAULT_EXCHANGES_DIR], verdicts = [], outcomes = [], root = REPO_ROOT } = {}) {
  const indexed = [];
  for (const dir of exchangeDirs) if (fs.existsSync(dir)) indexed.push(...listExchanges(dir));

  /* The latest attempt that recorded each act, per file. */
  const actKey = (r) => `${path.resolve(r.file)}\u0000${r.forayKey}\u0000${r.actIndex}`;
  const latestAttempt = new Map();
  for (const r of indexed) latestAttempt.set(actKey(r), Math.max(latestAttempt.get(actKey(r)) ?? 0, r.attempt));

  const byVerdict = latestVerdicts(verdicts);
  const byPair = new Map(outcomes.map((o) => [`${o.dir}\u0000${o.forayKey}\u0000${o.actIndex}`, o]));
  const candidates = new Map();
  const parsed = new Map();
  const recordAt = (file, line) => {
    if (!parsed.has(file)) parsed.set(file, new Map(parseExchanges(fs.readFileSync(file, "utf8"), file).map((p) => [p.line, p.record])));
    return parsed.get(file).get(line);
  };

  const rows = [];
  const seen = new Set();
  for (const r of indexed) {
    const file = path.resolve(r.file);
    const fileLine = `${file}\u0000${r.line}`;
    if (seen.has(fileLine)) continue;
    seen.add(fileLine);
    const record = recordAt(file, r.line);
    const generator = generatorOf(record.generator);
    const finalRound = r.finalRound === true && latestAttempt.get(actKey(r)) === r.attempt;

    let label = null;
    let labelSource = null;
    if (finalRound) {
      const candidate = candidateBeside(file, r.forayKey, candidates);
      const verdict = candidate ? byVerdict.get(`${candidate.id}\u0000${r.actIndex + 1}\u0000${candidate.sha256}`) : undefined;
      const pair = byPair.get(`${path.dirname(file)}\u0000${r.forayKey}\u0000${r.actIndex}`);
      if (verdict) {
        label = VERDICT_LABEL[verdict.verdict];
        labelSource = "founder-verdict";
      } else if (pair) {
        label = pair.outcome === "win" ? "keep" : "reject";
        labelSource = pair.outcome === "win" ? "pairwise-win" : "pairwise-loss";
      }
    }

    rows.push({
      schema: EXAMPLE_SCHEMA,
      exampleId: exampleIdOf(record.request, record.reply),
      forayKey: r.forayKey,
      ...(r.promptId !== undefined ? { promptId: r.promptId } : {}),
      attempt: r.attempt,
      actIndex: r.actIndex,
      round: r.round,
      call: r.call,
      exchangeRef: { file: refPath(file, root), line: r.line },
      label,
      labelSource,
      generator,
      claudeDerived: isClaudeDerived(generator),
      finalRound,
      verified: isVerifiedRound(record)
    });
  }
  return rows;
}

/** Rows as JSONL text. */
export function examplesJsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

/** The ledger file -> rows; a missing file is no rows. */
export function readExamples(file = DEFAULT_LEDGER) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === "") continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${file}: line ${i + 1} is not JSON (${err.message})`);
    }
    if (!isPlainObject(row) || row.schema !== EXAMPLE_SCHEMA) throw new Error(`${file}: line ${i + 1} is not an ${EXAMPLE_SCHEMA} row`);
    rows.push(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* count                                                               */
/* ------------------------------------------------------------------ */

/** The acts of the committed Forays: Claude-written, no inputs, reference only. */
export function historicReferenceActs(forays) {
  const list = Array.isArray(forays) ? forays : Array.isArray(forays?.forays) ? forays.forays : [];
  return list.reduce((n, f) => n + (isPlainObject(f) ? actCount(f) : 0), 0);
}

/**
 * The readiness numbers: usable (distinct exampleIds that pass usableExample),
 * held (distinct claude-derived exampleIds that would otherwise be usable),
 * unknownProvenance (would be usable but no generator was recorded) and
 * historic (data/forays.json acts).
 */
export function readiness(rows, historic) {
  const usable = new Set();
  const held = new Set();
  const unknown = new Set();
  for (const row of rows) {
    if (usableExample(row)) usable.add(row.exampleId);
    const wouldCount = row.label === "keep" && row.finalRound === true && row.verified === true;
    if (wouldCount && row.claudeDerived === true) held.add(row.exampleId);
    else if (wouldCount && row.generator === null) unknown.add(row.exampleId);
  }
  return { usable: usable.size, target: READINESS_TARGET, held: held.size, unknownProvenance: unknown.size, historic };
}

/** The one-line readiness statement. */
export function readinessLine(r) {
  const base = `usable act-level examples: ${r.usable} of ${r.target} (non-claude, labelled keep); claude-derived held: ${r.held}; historic reference acts without inputs: ${r.historic}`;
  return r.unknownProvenance > 0 ? `${base}; no recorded generator: ${r.unknownProvenance}` : base;
}

/** The doc with `- <date>: <line>` appended inside the readiness markers.
 * An identical last entry is not repeated. Throws when the markers are gone. */
export function appendReadiness(doc, date, line) {
  const begin = doc.indexOf(READINESS_BEGIN);
  const end = doc.indexOf(READINESS_END);
  if (begin < 0 || end < begin) throw new Error(`the readiness section's markers (${READINESS_BEGIN} ... ${READINESS_END}) are missing`);
  const eol = doc.includes("\r\n") ? "\r\n" : "\n";
  const entry = `- ${date}: ${line}`;
  const body = doc.slice(begin + READINESS_BEGIN.length, end);
  const entries = body.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (entries[entries.length - 1] === entry) return doc;
  const next = [...entries, entry].join(eol);
  return `${doc.slice(0, begin + READINESS_BEGIN.length)}${eol}${next}${eol}${doc.slice(end)}`;
}

/* ------------------------------------------------------------------ */
/* export-sft                                                          */
/* ------------------------------------------------------------------ */

/**
 * The SFT lines for `rows`: every usable example once (by exampleId), and
 * claude-derived ones only with `allowClaudeDerived`. `promptBuilder(request,
 * record)` returns the user prompt; the assistant turn is the reply's seams
 * as JSON. Each exchange is re-read and its id re-derived, so an exchanges
 * file edited after build is refused rather than exported.
 * Returns { lines, refused } (refused: the claude-derived rows left out).
 */
export function sftLines(rows, { promptBuilder, allowClaudeDerived = false, root = REPO_ROOT } = {}) {
  if (typeof promptBuilder !== "function") throw new Error("export-sft needs a prompt builder (the Qwen writer's, or an injected one)");
  const lines = [];
  const done = new Set();
  let refused = 0;
  for (const row of rows) {
    const claudeCandidate = row.claudeDerived === true && row.label === "keep" && row.finalRound === true && row.verified === true && row.generator !== null;
    if (!usableExample(row) && !claudeCandidate) continue;
    if (row.claudeDerived === true && !allowClaudeDerived) {
      refused += 1;
      continue;
    }
    if (done.has(row.exampleId)) continue;
    done.add(row.exampleId);
    const file = path.resolve(root, row.exchangeRef.file);
    const record = readExchange(file, row.exchangeRef.line);
    if (exampleIdOf(record.request, record.reply) !== row.exampleId) {
      throw new Error(`${row.exchangeRef.file}:${row.exchangeRef.line} no longer holds example ${row.exampleId}; re-run build`);
    }
    const prompt = promptBuilder(record.request, record);
    if (typeof prompt !== "string" || prompt.length === 0) throw new Error(`the prompt builder returned no prompt for ${row.exampleId}`);
    const seams = Array.isArray(record.reply?.seams) ? record.reply.seams : [];
    lines.push(
      JSON.stringify({
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: JSON.stringify({ seams }) }
        ]
      })
    );
  }
  return { lines, refused };
}

/**
 * The production prompt builder: the Qwen writer's own (prompts/actWrite.ts,
 * the parts ChatNarrationWriterBuilder sends) loaded through tsx, joined into
 * one string with promptLayout.ts's joinParts. Every call is rebuilt with the
 * one-shot 'json' contract, so the prompt and the assistant's seams JSON agree
 * even for a round the writer streamed. Needs backend/node_modules.
 */
export async function loadWriterPromptBuilder(repoRoot = REPO_ROOT) {
  const backend = path.join(repoRoot, "backend");
  /* The backend is CommonJS (its copy/*.js siblings are plain CJS), so tsx's
     CommonJS loader, not its ESM tsImport, resolves the extensionless
     imports the way the backend's own tests do. */
  const req = createRequire(path.join(backend, "package.json"));
  const api = await import(pathToFileURL(req.resolve("tsx/cjs/api")).href);
  const tsxRequire = api.require ?? api.default?.require;
  const load = (rel) => tsxRequire(path.join(backend, rel), import.meta.url);
  const actWrite = load("src/generation/prompts/actWrite.ts");
  const layout = load("src/generation/promptLayout.ts");
  return (request, record) =>
    layout.joinParts(record.call === "editSeams" ? actWrite.seamEditPromptParts(request, { output: "json" }) : actWrite.actWritePromptParts(request, { output: "json" }));
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

/** Refuses an output path outside <root>/data-local/. */
export function dataLocalRefusal(file, root = REPO_ROOT) {
  const rel = path.relative(path.join(root, "data-local"), path.resolve(root, file));
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? `${file} is not under data-local/ (examples hold transcript text and never go in git)` : null;
}

export const USAGE = [
  "usage: node tools/generation-bench/training-corpus.mjs build [--exchanges <dir>]... [--verdicts <jsonl>] [--swaps <dir>] [--cards <jsonl>] [--keys <dir>] [--out <jsonl>]",
  "       node tools/generation-bench/training-corpus.mjs count [--ledger <jsonl>] [--forays <json>] [--doc <md>] [--no-append] [--date YYYY-MM-DD]",
  `       node tools/generation-bench/training-corpus.mjs export-sft --out <jsonl> [--ledger <jsonl>] [${ALLOW_CLAUDE_FLAG}]`
].join("\n");

function parseArgs(argv) {
  const args = { exchanges: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--exchanges") args.exchanges.push(value());
    else if (a === "--verdicts") args.verdicts = value();
    else if (a === "--swaps") args.swaps = value();
    else if (a === "--cards") args.cards = value();
    else if (a === "--keys") args.keys = value();
    else if (a === "--out") args.out = value();
    else if (a === "--ledger") args.ledger = value();
    else if (a === "--forays") args.forays = value();
    else if (a === "--doc") args.doc = value();
    else if (a === "--date") args.date = value();
    else if (a === "--no-append") args.noAppend = true;
    else if (a === ALLOW_CLAUDE_FLAG) args.allowClaudeDerived = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/**
 * @param {string[]} argv
 * @param {(line: string) => void} out
 * @param {{ root?: string, promptBuilder?: Function, now?: () => Date }} deps
 */
export async function main(argv, out = console.log, deps = {}) {
  const root = deps.root ?? REPO_ROOT;
  const [cmd, ...rest] = argv;
  let args;
  try {
    args = parseArgs(rest);
  } catch (err) {
    out(err.message);
    out(USAGE);
    return 1;
  }
  const at = (p, fallback) => (p === undefined ? fallback : path.resolve(root, p));
  const ledger = at(args.ledger, path.join(root, "data-local", "training", "act-examples.jsonl"));

  if (cmd === "build") {
    const outFile = at(args.out, ledger);
    const refusal = dataLocalRefusal(outFile, root);
    if (refusal) {
      out(`build refused: ${refusal}`);
      return 1;
    }
    const swapsDir = at(args.swaps, path.join(root, SWAPS_OUT));
    const exchangeDirs = args.exchanges.length ? args.exchanges.map((d) => path.resolve(root, d)) : [path.join(root, SWAPS_OUT)];
    const cardsFile = at(args.cards, path.join(root, CARDS_REL));
    const cards = fs.existsSync(cardsFile) ? readCards(cardsFile) : [];
    const { outcomes, skipped } = pairwiseOutcomes({ swapsDir, cards, keyDir: at(args.keys, path.join(root, KEYS_REL)), root });
    const verdicts = readVerdicts(at(args.verdicts, path.join(root, VERDICTS_REL)));
    const rows = buildExamples({ exchangeDirs, verdicts, outcomes, root });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, examplesJsonl(rows));
    const labelled = rows.filter((r) => r.label !== null).length;
    out(`${rows.length} exchange(s), ${labelled} labelled (${verdicts.length} founder verdict row(s), ${outcomes.length} pairwise arm outcome(s)) -> ${refPath(outFile, root)}`);
    for (const s of skipped) out(`  skipped ${s}`);
    return 0;
  }

  if (cmd === "count") {
    const forays = JSON.parse(fs.readFileSync(at(args.forays, path.join(root, "data", "forays.json")), "utf8"));
    const r = readiness(readExamples(ledger), historicReferenceActs(forays));
    const line = readinessLine(r);
    out(line);
    if (!args.noAppend) {
      const docFile = at(args.doc, path.join(root, "docs", "curation", "model-swaps.md"));
      const date = args.date ?? (deps.now ? deps.now() : new Date()).toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        out(`--date must be YYYY-MM-DD, got ${date}`);
        return 1;
      }
      const before = fs.readFileSync(docFile, "utf8");
      const after = appendReadiness(before, date, line);
      if (after !== before) fs.writeFileSync(docFile, after);
      out(after === before ? `  ${refPath(docFile, root)}: already the last readiness line` : `  appended to ${refPath(docFile, root)}`);
    }
    return 0;
  }

  if (cmd === "export-sft") {
    if (args.out === undefined) {
      out("export-sft needs --out <jsonl>");
      out(USAGE);
      return 1;
    }
    const outFile = path.resolve(root, args.out);
    const refusal = dataLocalRefusal(outFile, root);
    if (refusal) {
      out(`export-sft refused: ${refusal}`);
      return 1;
    }
    const promptBuilder = deps.promptBuilder ?? (await loadWriterPromptBuilder(root));
    const { lines, refused } = sftLines(readExamples(ledger), { promptBuilder, allowClaudeDerived: args.allowClaudeDerived === true, root });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, lines.map((l) => `${l}\n`).join(""));
    out(`${lines.length} SFT example(s) -> ${refPath(outFile, root)}`);
    if (refused) out(`  refused ${refused} claude-derived row(s) (OQ-06 parks Claude-built training data; ${ALLOW_CLAUDE_FLAG} overrides and stays unused until it is ruled on)`);
    return 0;
  }

  out(USAGE);
  return 1;
}

if (isEntryScript(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err.message);
      process.exitCode = 1;
    }
  );
}
