/* swap-ledger.mjs — the append-only ledger of model-swap decisions (GV-35, W7-01).
 *
 * WHAT IT IS FOR (docs/roadmap/generation-v2.md, card GV-35; #1286)
 * Every stage swap, lever trial and measurement (E0..E7, docs/curation/
 * model-swaps.md) ends in ONE line of tools/generation-bench/swaps/ledger.jsonl.
 * A production default changes only through a PR that cites a ledger row id,
 * and swaps/adopted-stack.json names the row its stack came from, so the
 * ledger is what a reader audits: which arms, which commit, which corpus,
 * what the founder heard, what the rule said.
 *
 *   validateLedgerRow(row, existing)  -> { ok, errors }
 *   parseLedger(text)                 -> rows (throws on the first bad line)
 *   appendLedgerRow(file, row)        -> appends one line, never rewrites
 *   renderLedgerTable(rows)           -> the markdown table (byte-stable)
 *   spliceLedgerTable(doc, rows)      -> model-swaps.md with the table replaced
 *   validateAdoptedStack(stack, rows) -> { ok, errors }
 *
 * THE ROW
 *   { id, experiment, kind: "stage"|"lever"|"measure", stage?, lever?,
 *     armA: { stack, levers }, armB: { stack, levers },
 *     commit, goldenSetId, corpusFingerprint: "<fp>" | "unfrozen", runDirs: { A, B },
 *     pairwise: { wins, ties, losses, listener, listenedOn, packId },
 *     axisMeans: { A, B }, scorecardDelta, timingDelta,
 *     checks: [{ name, result: "pass"|"fail"|"unmeasured", note? }],
 *     decision: "adopt"|"hold"|"reject"|"measured", supersedes?, notes }
 * `pairwise.wins` and `losses` are arm B's (the changed arm): wins = B
 * preferred, losses = A preferred. The block, axisMeans, scorecardDelta,
 * timingDelta, checks and decision are swap-rule.mjs decideSwap's output.
 *
 * APPEND-ONLY
 * Rows are never edited. A correction is a NEW row, with its own id, carrying
 * `supersedes: <the old id>`; the table marks the old row superseded. A reused
 * id is refused (the error says to supersede instead), as is a row that
 * supersedes an id not in the ledger or one already superseded (one chain,
 * never a fork). An 'adopt' row on an 'unfrozen' corpus is refused: until the
 * eval workstream's corpus fingerprint lands (R2-02) the rule can only hold,
 * reject or measure.
 *
 * THE TABLE
 * renderLedgerTable splices between SWAPS_BEGIN / SWAPS_END in model-swaps.md,
 * the run.mjs ROWS_BEGIN / spliceRows pattern. Unlike the KPI table it is
 * rebuilt WHOLE from the ledger every time (the ledger is the source, the
 * table a view), so the same ledger always gives the same bytes and the suite
 * can assert the committed doc is in sync.
 *
 * USAGE
 *   node tools/generation-bench/swap-ledger.mjs check            # ledger, adopted stack, doc table in sync
 *   node tools/generation-bench/swap-ledger.mjs append <row.json>
 *   node tools/generation-bench/swap-ledger.mjs render [--write]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { CHECK_RESULTS, DECISIONS, KINDS } from "./swap-rule.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const DEFAULT_LEDGER = path.join(HERE, "swaps", "ledger.jsonl");
export const DEFAULT_ADOPTED_STACK = path.join(HERE, "swaps", "adopted-stack.json");
export const DEFAULT_DOC = path.join(REPO_ROOT, "docs", "curation", "model-swaps.md");

export const SWAPS_BEGIN = "<!-- swaps:ledger:begin -->";
export const SWAPS_END = "<!-- swaps:ledger:end -->";

export const ROW_KEYS = Object.freeze([
  "id",
  "experiment",
  "kind",
  "stage",
  "lever",
  "armA",
  "armB",
  "commit",
  "goldenSetId",
  "corpusFingerprint",
  "runDirs",
  "pairwise",
  "axisMeans",
  "scorecardDelta",
  "timingDelta",
  "checks",
  "decision",
  "supersedes",
  "notes"
]);
const PAIRWISE_KEYS = Object.freeze(["wins", "ties", "losses", "listener", "listenedOn", "packId"]);

export const ADOPTED_STACK_SCHEMA = "adopted-stack/1";
export const LEVER_KEYS = Object.freeze(["exemplars", "spineBestOf", "selfCritique"]);
const STAGE_ENTRY_KEYS = Object.freeze(["impl", "model", "machine"]);

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const isCount = (v) => Number.isInteger(v) && v >= 0;

function checkArm(errors, row, key) {
  const arm = row[key];
  if (!isPlainObject(arm) || !isPlainObject(arm.stack) || !isPlainObject(arm.levers)) {
    errors.push(`${key} must be { stack: {...}, levers: {...} }`);
    return;
  }
  for (const k of Object.keys(arm)) if (k !== "stack" && k !== "levers") errors.push(`${key}.${k} is not an arm field`);
}

/**
 * Check one row, and its place after `existing` (the rows already in the
 * ledger). Never throws; returns every problem.
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateLedgerRow(row, existing = []) {
  const errors = [];
  if (!isPlainObject(row)) return { ok: false, errors: ["a ledger row is a JSON object"] };
  for (const key of Object.keys(row)) if (!ROW_KEYS.includes(key)) errors.push(`unknown field "${key}"`);

  if (typeof row.id !== "string" || !ID_RE.test(row.id)) errors.push("id must be a short id (letters, digits, . _ -)");
  if (!isText(row.experiment)) errors.push("experiment must name the experiment (E0..E7, or a spec id)");
  if (!KINDS.includes(row.kind)) errors.push(`kind must be one of ${KINDS.join(", ")}`);
  if (row.kind === "stage" && !isText(row.stage)) errors.push("a stage row names its stage");
  if (row.kind === "lever" && !isText(row.lever)) errors.push("a lever row names its lever");
  if (row.stage !== undefined && !isText(row.stage)) errors.push("stage, when present, is a stage name");
  if (row.lever !== undefined && !isText(row.lever)) errors.push("lever, when present, is a lever name");
  checkArm(errors, row, "armA");
  checkArm(errors, row, "armB");
  if (typeof row.commit !== "string" || !COMMIT_RE.test(row.commit)) errors.push("commit must be the git sha both arms ran at (7-40 hex)");
  if (!isText(row.goldenSetId)) errors.push("goldenSetId must name the golden set");
  if (!isText(row.corpusFingerprint)) errors.push("corpusFingerprint must be a fingerprint or 'unfrozen'");
  if (!isPlainObject(row.runDirs) || !isText(row.runDirs.A) || !isText(row.runDirs.B)) errors.push("runDirs must be { A, B } run directories");

  const pw = row.pairwise;
  if (!isPlainObject(pw)) {
    errors.push("pairwise must be { wins, ties, losses, listener, listenedOn, packId }");
  } else {
    for (const k of ["wins", "ties", "losses"]) if (!isCount(pw[k])) errors.push(`pairwise.${k} must be a count >= 0`);
    if (pw.listener !== null && !isText(pw.listener)) errors.push("pairwise.listener must name who listened (or null)");
    if (pw.listenedOn !== null && (typeof pw.listenedOn !== "string" || !DATE_RE.test(pw.listenedOn))) {
      errors.push("pairwise.listenedOn must be a YYYY-MM-DD date (or null)");
    }
    const packs = Array.isArray(pw.packId) ? pw.packId : [pw.packId];
    if (pw.packId !== null && !packs.every((p) => typeof p === "string" && ID_RE.test(p))) {
      errors.push("pairwise.packId must be a pack id, a list of them, or null");
    }
    for (const k of Object.keys(pw)) if (!PAIRWISE_KEYS.includes(k)) errors.push(`pairwise.${k} is not a pairwise field`);
  }

  if (!isPlainObject(row.axisMeans) || !isPlainObject(row.axisMeans.A) || !isPlainObject(row.axisMeans.B)) {
    errors.push("axisMeans must be { A: {...}, B: {...} }");
  }
  if (row.scorecardDelta !== null && !isPlainObject(row.scorecardDelta)) errors.push("scorecardDelta must be an object or null");
  if (row.timingDelta !== null && !Array.isArray(row.timingDelta) && !isPlainObject(row.timingDelta)) {
    errors.push("timingDelta must be a list, an object or null");
  }

  if (!Array.isArray(row.checks)) {
    errors.push("checks must be a list of { name, result }");
  } else {
    row.checks.forEach((c, i) => {
      if (!isPlainObject(c) || !isText(c.name) || !CHECK_RESULTS.includes(c.result)) {
        errors.push(`checks[${i}] must be { name, result: ${CHECK_RESULTS.join(" | ")} }`);
        return;
      }
      for (const k of Object.keys(c)) if (!["name", "result", "note"].includes(k)) errors.push(`checks[${i}].${k} is not a check field`);
      if (c.note !== undefined && typeof c.note !== "string") errors.push(`checks[${i}].note must be text`);
    });
  }

  if (!DECISIONS.includes(row.decision)) errors.push(`decision must be one of ${DECISIONS.join(", ")}`);
  if ((row.kind === "measure") !== (row.decision === "measured") && KINDS.includes(row.kind) && DECISIONS.includes(row.decision)) {
    errors.push("a 'measure' row, and only a 'measure' row, is decided 'measured'");
  }
  if (row.decision === "adopt") {
    if (row.corpusFingerprint === "unfrozen") errors.push("an 'adopt' row on an 'unfrozen' corpus is refused (R2-02 has not frozen the corpus)");
    if (Array.isArray(row.checks) && row.checks.some((c) => c && c.result === "fail")) errors.push("an 'adopt' row cannot carry a failing check");
  }
  if (typeof row.notes !== "string") errors.push("notes must be text (may be empty)");

  if (typeof row.id === "string") {
    if (existing.some((r) => r.id === row.id)) {
      errors.push(`id "${row.id}" is already in the ledger; rows are never edited, a correction is a new row with its own id carrying supersedes: "${row.id}"`);
    }
  }
  if (row.supersedes !== undefined) {
    if (typeof row.supersedes !== "string" || !existing.some((r) => r.id === row.supersedes)) {
      errors.push(`supersedes must name a row already in the ledger, got ${JSON.stringify(row.supersedes)}`);
    } else if (existing.some((r) => r.supersedes === row.supersedes)) {
      errors.push(`row "${row.supersedes}" is already superseded; supersede the newest row of its chain`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Parse ledger text into rows, each validated against the rows above it.
 * Blank lines are skipped and a CRLF ending is tolerated; the first problem
 * throws, naming `name:line`. */
export function parseLedger(text, name = "ledger.jsonl") {
  const rows = [];
  String(text)
    .split("\n")
    .forEach((raw, index) => {
      const line = raw.replace(/\r$/, "");
      if (line.trim() === "") return;
      const at = `${name}:${index + 1}`;
      let row;
      try {
        row = JSON.parse(line);
      } catch (err) {
        throw new Error(`${at}: not JSON (${err.message})`);
      }
      const { ok, errors } = validateLedgerRow(row, rows);
      if (!ok) throw new Error(`${at}: ${errors.join("; ")}`);
      rows.push(row);
    });
  return rows;
}

/** Every row of a ledger file. A file that does not exist holds no rows. */
export function readLedger(file = DEFAULT_LEDGER) {
  if (!fs.existsSync(file)) return [];
  return parseLedger(fs.readFileSync(file, "utf8"), file);
}

/**
 * Append one row. The whole ledger is re-read first (a broken ledger is not
 * appended to) and the row is validated against it. Existing bytes are never
 * rewritten: the only change is a newline if the last line lacks one, then
 * the new line. Returns the new row count.
 */
export function appendLedgerRow(file, row) {
  const existingText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const rows = parseLedger(existingText, file);
  const { ok, errors } = validateLedgerRow(row, rows);
  if (!ok) throw new Error(`ledger row refused: ${errors.join("; ")}`);
  const lead = existingText !== "" && !existingText.endsWith("\n") ? "\n" : "";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${lead}${JSON.stringify(row)}\n`);
  return rows.length + 1;
}

/* ------------------------------------------------------------------ */
/* The table                                                           */
/* ------------------------------------------------------------------ */

export const TABLE_HEADER = Object.freeze([
  "| id | experiment | kind | change | B wins / ties / A wins | decision | failing checks | corpus | commit | status |",
  "|---|---|---|---|---|---|---|---|---|---|"
]);

/* A cell never carries a pipe or a newline: either would break the row. */
const cell = (v) => String(v).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

/**
 * The ledger as a markdown table, one line per row in ledger order. Byte-
 * stable: it reads only the rows, in order, and formats no number with
 * locale or clock. `status` is 'superseded by <id>' or 'current'.
 */
export function renderLedgerTable(rows) {
  const supersededBy = new Map();
  for (const r of rows) if (r.supersedes) supersededBy.set(r.supersedes, r.id);
  const lines = rows.map((r) => {
    const change = r.kind === "lever" ? `lever ${r.lever}` : r.stage ? `stage ${r.stage}` : "-";
    const pw = r.pairwise ? `${r.pairwise.wins} / ${r.pairwise.ties} / ${r.pairwise.losses}` : "-";
    const failing = (r.checks || []).filter((c) => c.result === "fail").map((c) => c.name);
    const status = supersededBy.has(r.id) ? `superseded by ${supersededBy.get(r.id)}` : "current";
    return `| ${[
      r.id,
      r.experiment,
      r.kind,
      change,
      pw,
      r.decision,
      failing.length ? failing.join(", ") : "none",
      r.corpusFingerprint,
      r.commit.slice(0, 7),
      status
    ]
      .map(cell)
      .join(" | ")} |`;
  });
  if (lines.length === 0) lines.push(`| (no rows yet) |${" |".repeat(TABLE_HEADER[1].split("|").length - 3)}`);
  return [...TABLE_HEADER, ...lines].join("\n");
}

/** Replace everything between the markers with the rendered table. Throws
 * when the doc has no marker block. Everything outside the markers is kept
 * byte for byte. */
export function spliceLedgerTable(doc, rows) {
  const begin = doc.indexOf(SWAPS_BEGIN);
  const end = doc.indexOf(SWAPS_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`the document has no ${SWAPS_BEGIN} … ${SWAPS_END} block to render into`);
  }
  return `${doc.slice(0, begin + SWAPS_BEGIN.length)}\n${renderLedgerTable(rows)}\n${doc.slice(end)}`;
}

/* ------------------------------------------------------------------ */
/* The adopted stack                                                   */
/* ------------------------------------------------------------------ */

/**
 * swaps/adopted-stack.json: { schema, note, stages: { <stage>: { impl, model,
 * machine } }, levers: { exemplars?, spineBestOf?, selfCritique? }, ledgerRow }.
 * A stack that names stages must name the ledger row that adopted it, and that
 * row must be a current 'adopt' row: a default changes only through the ledger.
 */
export function validateAdoptedStack(stack, rows = []) {
  const errors = [];
  if (!isPlainObject(stack)) return { ok: false, errors: ["the adopted stack is a JSON object"] };
  for (const k of Object.keys(stack)) {
    if (!["schema", "note", "stages", "levers", "ledgerRow"].includes(k)) errors.push(`unknown field "${k}"`);
  }
  if (stack.schema !== ADOPTED_STACK_SCHEMA) errors.push(`schema must be "${ADOPTED_STACK_SCHEMA}"`);
  if (typeof stack.note !== "string") errors.push("note must be text");
  if (!isPlainObject(stack.stages)) {
    errors.push("stages must map each stage to { impl, model, machine }");
  } else {
    for (const [stage, entry] of Object.entries(stack.stages)) {
      if (!isPlainObject(entry) || !STAGE_ENTRY_KEYS.every((k) => isText(entry[k]))) {
        errors.push(`stages.${stage} must be { impl, model, machine }`);
        continue;
      }
      for (const k of Object.keys(entry)) if (!STAGE_ENTRY_KEYS.includes(k)) errors.push(`stages.${stage}.${k} is not a stage field`);
      if (/anthropic|claude/i.test(`${entry.impl} ${entry.model}`)) errors.push(`stages.${stage} names an Anthropic model; the adopted stack is all-local`);
    }
  }
  if (!isPlainObject(stack.levers)) errors.push(`levers must be an object of ${LEVER_KEYS.join(", ")}`);
  else for (const k of Object.keys(stack.levers)) if (!LEVER_KEYS.includes(k)) errors.push(`levers.${k} is not a lever`);

  const adopted = isPlainObject(stack.stages) && Object.keys(stack.stages).length > 0;
  if (stack.ledgerRow === null) {
    if (adopted) errors.push("a stack that names stages cites the ledger row that adopted it");
  } else if (typeof stack.ledgerRow !== "string") {
    errors.push("ledgerRow must be a ledger row id or null");
  } else {
    const row = rows.find((r) => r.id === stack.ledgerRow);
    if (!row) errors.push(`ledgerRow "${stack.ledgerRow}" is not in the ledger`);
    else if (row.decision !== "adopt") errors.push(`ledgerRow "${stack.ledgerRow}" is a '${row.decision}' row, not 'adopt'`);
    else if (rows.some((r) => r.supersedes === row.id)) errors.push(`ledgerRow "${stack.ledgerRow}" has been superseded`);
  }
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function main(argv, out = console.log, files = {}) {
  const ledger = files.ledger || DEFAULT_LEDGER;
  const stackFile = files.stack || DEFAULT_ADOPTED_STACK;
  const docFile = files.doc || DEFAULT_DOC;
  const [command, ...rest] = argv;
  if (command === "check") {
    const rows = readLedger(ledger);
    const stack = validateAdoptedStack(JSON.parse(fs.readFileSync(stackFile, "utf8")), rows);
    if (!stack.ok) throw new Error(`${stackFile}: ${stack.errors.join("; ")}`);
    const doc = fs.readFileSync(docFile, "utf8");
    if (spliceLedgerTable(doc, rows) !== doc) throw new Error(`${docFile}: the ledger table is stale; run render --write`);
    out(`${rows.length} ledger row(s), adopted stack valid, table in sync`);
    return rows.length;
  }
  if (command === "append") {
    if (!rest[0]) throw new Error("usage: node tools/generation-bench/swap-ledger.mjs append <row.json>");
    const count = appendLedgerRow(ledger, JSON.parse(fs.readFileSync(path.resolve(rest[0]), "utf8")));
    out(`appended; ${count} row(s) in ${ledger}`);
    return count;
  }
  if (command === "render") {
    const rows = readLedger(ledger);
    if (rest.includes("--write")) {
      fs.writeFileSync(docFile, spliceLedgerTable(fs.readFileSync(docFile, "utf8"), rows));
      out(`rendered ${rows.length} row(s) into ${docFile}`);
    } else out(renderLedgerTable(rows));
    return rows.length;
  }
  throw new Error("usage: node tools/generation-bench/swap-ledger.mjs check | append <row.json> | render [--write]");
}

if (isEntryScript(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
