/* GV-110 (docs/roadmap/generation-v2.md, from W7-09; R2-17) — the writer
 * exchange reader.
 *
 * WHAT IT IS FOR
 * Published Forays keep only scripts, so no act-level training or calibration
 * example can exist without the writer's INPUT. `generate-forays
 * --record-exchanges` (bench prompts only, --out under data-local/) appends
 * one `writer-exchange/1` JSONL line per act per writer round to
 * `<out>/<checkpointKey>.exchanges.jsonl`: the request the writer was sent,
 * its reply, the round's mechanical issues and the verifier's verdict, with
 * the act's index, the attempt and the writer's stage assignment
 * (`generator`). This module reads those files: an index of every exchange
 * (no request or reply text) and one exchange in full. The training-example
 * ledger (GV-114, W7-10) and critic calibration (W7-08) read through it, and
 * backend/test/writerExchanges.test.ts replays a recorded exchange through
 * writeAct.ts's replayMechanicalGate.
 *
 * The files hold transcript window text: they live under data-local/ and
 * never go in git. Pure: no network, no model, nothing written.
 *
 * Usage:
 *   node tools/generation-bench/exchanges.mjs list <file.exchanges.jsonl | dir>
 *   node tools/generation-bench/exchanges.mjs show <file.exchanges.jsonl> <line>
 */

import fs from "node:fs";
import path from "node:path";
import { isEntryScript } from "../ci/entry.mjs";

export const EXCHANGE_SCHEMA = "writer-exchange/1";

/** The file-name suffix the batch driver writes (`exchangesFilename`). */
export const EXCHANGES_SUFFIX = ".exchanges.jsonl";

/** The fields every recorded line carries; a line missing one is refused. */
export const EXCHANGE_FIELDS = Object.freeze(["forayKey", "attempt", "actIndex", "actTitle", "round", "call", "request", "reply", "mechanical"]);

/** The writer calls a round can make (writeAct.ts `WriterExchange.call`). */
export const EXCHANGE_CALLS = Object.freeze(["writeAct", "writeActStream", "editSeams"]);

/**
 * Exchanges text -> `[{ line, record }]`, `line` 1-based in the file. Blank
 * lines are skipped. A line that is not JSON, names another schema, misses a
 * field or names an unknown call throws, naming the line, rather than being
 * read as no exchange.
 */
export function parseExchanges(text, label = "exchanges") {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === "") continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${label}: line ${i + 1} is not JSON (${err.message})`);
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error(`${label}: line ${i + 1} is not an object`);
    if (record.schema !== EXCHANGE_SCHEMA) throw new Error(`${label}: line ${i + 1} is not a ${EXCHANGE_SCHEMA} line (schema ${JSON.stringify(record.schema)})`);
    const missing = EXCHANGE_FIELDS.filter((f) => !(f in record));
    if (missing.length > 0) throw new Error(`${label}: line ${i + 1} has no ${missing.join(", ")}`);
    if (!EXCHANGE_CALLS.includes(record.call)) throw new Error(`${label}: line ${i + 1} names an unknown call ${JSON.stringify(record.call)}`);
    if (!Number.isInteger(record.actIndex) || record.actIndex < 0) throw new Error(`${label}: line ${i + 1} has no act index`);
    if (!Number.isInteger(record.round) || record.round < 1) throw new Error(`${label}: line ${i + 1} has no round`);
    out.push({ line: i + 1, record });
  }
  return out;
}

/** Every `*.exchanges.jsonl` under `dir`, recursively, sorted. */
function exchangeFilesUnder(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(EXCHANGES_SUFFIX)) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

/** The verdict, counted: beats carried of judged, seams supported of judged.
 * Null when the round made no verifier call. */
function verdictSummary(verdict) {
  if (!verdict || typeof verdict !== "object") return null;
  const beats = Array.isArray(verdict.beats) ? verdict.beats : [];
  const seams = Array.isArray(verdict.seams) ? verdict.seams : [];
  return {
    beatsJudged: beats.length,
    beatsCarried: beats.filter((b) => b && b.carried === true).length,
    seamsJudged: seams.length,
    seamsSupported: seams.filter((s) => s && s.claimsSupported === true).length
  };
}

/**
 * The index of every exchange in `target` (one exchanges file, or a directory
 * searched recursively): one row per line, in file then line order, with no
 * request or reply text. `finalRound` is true on the last round recorded for
 * its (file, forayKey, attempt, actIndex), the only round whose reply can be
 * the act's final text. `clean` is true when the round raised no mechanical
 * issue.
 */
export function listExchanges(target) {
  const stat = fs.statSync(target);
  const files = stat.isDirectory() ? exchangeFilesUnder(target) : [target];
  const rows = [];
  for (const file of files) {
    const parsed = parseExchanges(fs.readFileSync(file, "utf8"), file);
    const lastRound = new Map();
    const actKey = (r) => `${r.forayKey}\u0000${r.attempt}\u0000${r.actIndex}`;
    for (const { record } of parsed) lastRound.set(actKey(record), Math.max(lastRound.get(actKey(record)) ?? 0, record.round));
    for (const { line, record } of parsed) {
      rows.push({
        file,
        line,
        forayKey: record.forayKey,
        ...(record.promptId !== undefined ? { promptId: record.promptId } : {}),
        attempt: record.attempt,
        actIndex: record.actIndex,
        actTitle: record.actTitle,
        round: record.round,
        call: record.call,
        generator: record.generator ?? null,
        seams: Array.isArray(record.reply?.seams) ? record.reply.seams.length : 0,
        mechanical: Array.isArray(record.mechanical) ? record.mechanical.length : 0,
        clean: Array.isArray(record.mechanical) && record.mechanical.length === 0,
        verdict: verdictSummary(record.verdict),
        finalRound: lastRound.get(actKey(record)) === record.round
      });
    }
  }
  return rows;
}

/** One exchange in full: the record on 1-based `line` of `file`. Throws when
 * the line holds no exchange. */
export function readExchange(file, line) {
  const parsed = parseExchanges(fs.readFileSync(file, "utf8"), file);
  const hit = parsed.find((p) => p.line === Number(line));
  if (!hit) throw new Error(`${file}: no exchange on line ${line}`);
  return hit.record;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                  */
/* ------------------------------------------------------------------ */

function main(argv) {
  const [cmd, target, line] = argv;
  if (cmd === "list" && target) {
    for (const r of listExchanges(target)) {
      const v = r.verdict ? ` beats ${r.verdict.beatsCarried}/${r.verdict.beatsJudged} seams ${r.verdict.seamsSupported}/${r.verdict.seamsJudged}` : " (no verifier call)";
      const gen = r.generator ? ` ${r.generator.impl}/${r.generator.model}` : "";
      console.log(`${r.file}:${r.line} ${r.forayKey} a${r.attempt} act ${r.actIndex} round ${r.round}${r.finalRound ? " (final)" : ""} ${r.call}${gen} mechanical ${r.mechanical}${v}`);
    }
    return 0;
  }
  if (cmd === "show" && target && line) {
    console.log(JSON.stringify(readExchange(target, line), null, 2));
    return 0;
  }
  console.error("usage: exchanges.mjs list <file.exchanges.jsonl | dir> | show <file.exchanges.jsonl> <line>");
  return 1;
}

if (isEntryScript(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
