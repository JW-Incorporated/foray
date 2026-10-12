/* validate.mjs — checks and locks the golden set (GV-45, W1-14).
 *
 * WHAT IT IS FOR (docs/roadmap/generation-v2.md, card GV-45; #1286, R2-02)
 * golden-v1.json is the fixed benchmark every later generation change is
 * judged on: 50 prompts, 10 of them listened to by the founder and 40 scored
 * by the bench, stratified 30 / 10 / 5 / 5 (decision 25). A benchmark that
 * moves is not one, so this file does three things:
 *
 *   validateManifest(entries, ctx) -> { ok, errors, counts }
 *     schema, unique ids and prompts, strata counts, exactly 10 listened,
 *     every node a taxonomy node, every forays-json reference a Foray that
 *     exists in data/forays.json.
 *   buildLock({ manifestBytes, entries, report, now }) -> lock
 *     `--lock <report.json>`: freezes the set against the corpus a real
 *     (non --dry-run) generate-forays run of THIS manifest read, as
 *     golden-v1.lock.json { manifestSha, corpusFingerprint, frozenAt }.
 *   checkLock(manifestBytes, lock) -> errors
 *     a manifest whose sha no longer matches its lock is refused: a locked set
 *     is never edited, it is copied to golden-v2.json.
 *
 * THE SHA IS OF THE BYTES WITH CRLF READ AS LF. This repo is developed on
 * Windows; a checkout that converts line endings must not read as an edited
 * benchmark. The report's own `prompts.sha256` (GV-39) is of the raw bytes the
 * run parsed, so the lock accepts a report whose sha matches either line-ending
 * form of the manifest.
 *
 * STRATA DRIFT IS A NOTE, NOT AN ERROR. Strata were assigned from the
 * committed digests (select.mjs). When the archive grows a node can change
 * stratum; the locked set does not change with it (that is what locked means),
 * so validate prints the drift for a reader and still exits 0. `--strict-strata`
 * turns drift into a failure, for the moment a v2 is being drawn.
 *
 * USAGE
 *   node tools/generation-bench/golden/validate.mjs                 # check manifest (+ lock if present)
 *   node tools/generation-bench/golden/validate.mjs --strict-strata
 *   node tools/generation-bench/golden/validate.mjs --lock <report.json>
 *   options: --manifest <file> --lock-file <file>
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../../ci/entry.mjs";
import { buildFamilies, countSupply, loadInputs, MIN_TOPIC_SUPPLY, REPO_ROOT, STRATA, STRATA_TARGETS } from "./select.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST = path.join(HERE, "golden-v1.json");
export const DEFAULT_LOCK = path.join(HERE, "golden-v1.lock.json");

export const SET_SIZE = 50;
export const LISTENED = 10;
export const DURATIONS = ["short", "medium", "long"];
/** A prompt is a listener's request, not a document: anything longer is a
 * sign that text from somewhere else was pasted in. */
export const MAX_PROMPT_CHARS = 300;
/** The keys an entry may carry. generate-forays reads prompt, duration, topic
 * and id (normalizePrompts passes the object through); bench is GV-62's
 * --keep-checkpoints marker; stratum, listened, nodes and reference are the
 * bench's own. Anything else is refused, so no candidate text rides along. */
export const ENTRY_KEYS = ["id", "prompt", "duration", "topic", "stratum", "listened", "nodes", "reference", "bench"];
export const REFERENCE_KINDS = ["forays-json", "founder-candidate"];
/** Where generate-forays writes candidates by default, from the repo root. */
export const FOUNDER_CANDIDATE_DIR = "backend/data-local/foray-candidates/";

export function expectedIds() {
  return Array.from({ length: SET_SIZE }, (_, i) => `g${String(i + 1).padStart(2, "0")}`);
}

/** sha256 of the manifest with CRLF read as LF (see the header). */
export function manifestSha(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  return crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** The raw-bytes sha of both line-ending forms of the manifest. */
function rawShas(bytes) {
  const lf = (Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes)).replace(/\r\n/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  return [lf, crlf].map((t) => crypto.createHash("sha256").update(t, "utf8").digest("hex"));
}

function normalisedPrompt(prompt) {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Taxonomy families and the Foray ids the manifest is checked against. */
export function loadContext(root = REPO_ROOT) {
  const taxonomy = JSON.parse(fs.readFileSync(path.join(root, "data", "taxonomy.json"), "utf8"));
  const forays = JSON.parse(fs.readFileSync(path.join(root, "data", "forays.json"), "utf8"));
  return {
    families: buildFamilies(taxonomy.nodes.map((n) => ({ id: n.id, parent: n.parent ?? null }))),
    forayIds: new Set((forays.forays ?? []).map((f) => f.id))
  };
}

function validateReference(ref, where, ctx, errors) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    errors.push(`${where}: reference must be an object`);
    return;
  }
  if (!REFERENCE_KINDS.includes(ref.kind)) {
    errors.push(`${where}: reference.kind must be one of ${REFERENCE_KINDS.join(", ")}`);
    return;
  }
  if (ref.kind === "forays-json") {
    const keys = Object.keys(ref).sort().join(",");
    if (keys !== "forayId,kind") errors.push(`${where}: a forays-json reference carries exactly {kind, forayId}`);
    if (typeof ref.forayId !== "string" || !ctx.forayIds.has(ref.forayId)) {
      errors.push(`${where}: reference forayId ${JSON.stringify(ref.forayId)} is not a Foray in data/forays.json`);
    }
  } else {
    const keys = Object.keys(ref).sort().join(",");
    if (keys !== "file,kind") errors.push(`${where}: a founder-candidate reference carries exactly {kind, file}`);
    if (
      typeof ref.file !== "string" ||
      !ref.file.startsWith(FOUNDER_CANDIDATE_DIR) ||
      !ref.file.endsWith(".json") ||
      ref.file.includes("..")
    ) {
      errors.push(`${where}: a founder-candidate file is a .json path under ${FOUNDER_CANDIDATE_DIR} (local data, never committed)`);
    }
  }
}

/**
 * Checks the manifest. `ctx` is loadContext()'s { families, forayIds }.
 * Returns { ok, errors, counts: { strata, listened } }.
 */
export function validateManifest(entries, ctx) {
  const errors = [];
  const strata = Object.fromEntries(STRATA.map((s) => [s, 0]));
  let listened = 0;
  if (!Array.isArray(entries)) {
    return { ok: false, errors: ["the manifest must be a JSON array of prompt objects"], counts: { strata, listened } };
  }
  if (entries.length !== SET_SIZE) errors.push(`the set has ${entries.length} entries; golden-v1 has exactly ${SET_SIZE}`);

  const ids = new Set();
  const prompts = new Map();
  entries.forEach((e, i) => {
    const where = `entry ${i}${e && typeof e.id === "string" ? ` (${e.id})` : ""}`;
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    for (const key of Object.keys(e)) if (!ENTRY_KEYS.includes(key)) errors.push(`${where}: unknown key "${key}"`);

    if (typeof e.id !== "string" || !/^g\d{2}$/.test(e.id)) errors.push(`${where}: id must be g01..g50`);
    else if (ids.has(e.id)) errors.push(`${where}: duplicate id ${e.id}`);
    else ids.add(e.id);

    if (typeof e.prompt !== "string" || e.prompt.trim() === "") errors.push(`${where}: prompt must be a non-empty string`);
    else {
      if (e.prompt !== e.prompt.trim()) errors.push(`${where}: prompt has leading or trailing whitespace`);
      if (e.prompt.length > MAX_PROMPT_CHARS) errors.push(`${where}: prompt is ${e.prompt.length} chars (max ${MAX_PROMPT_CHARS})`);
      const key = normalisedPrompt(e.prompt);
      if (prompts.has(key)) errors.push(`${where}: duplicate prompt (same as ${prompts.get(key)})`);
      else prompts.set(key, e.id);
    }

    if (!DURATIONS.includes(e.duration)) errors.push(`${where}: duration must be one of ${DURATIONS.join(", ")}`);
    if (e.topic !== undefined && (typeof e.topic !== "string" || !ctx.families.has(e.topic))) {
      errors.push(`${where}: topic ${JSON.stringify(e.topic)} is not a node in data/taxonomy.json`);
    }
    if (e.bench !== true) errors.push(`${where}: bench must be true (GV-62's --keep-checkpoints accepts only a bench manifest)`);

    if (!STRATA.includes(e.stratum)) errors.push(`${where}: stratum must be one of ${STRATA.join(", ")}`);
    else strata[e.stratum] += 1;

    if (typeof e.listened !== "boolean") errors.push(`${where}: listened must be true or false`);
    else if (e.listened) listened += 1;

    const nodes = e.nodes;
    if (!Array.isArray(nodes) || nodes.some((n) => typeof n !== "string")) {
      errors.push(`${where}: nodes must be an array of taxonomy node ids`);
    } else {
      for (const n of nodes) if (!ctx.families.has(n)) errors.push(`${where}: node ${JSON.stringify(n)} is not in data/taxonomy.json`);
      if (e.stratum === "ambiguous") {
        if (nodes.length < 2) errors.push(`${where}: an ambiguous prompt names at least 2 readings`);
        for (let a = 0; a < nodes.length; a++) {
          for (let b = a + 1; b < nodes.length; b++) {
            if (ctx.families.get(nodes[a])?.has(nodes[b])) {
              errors.push(`${where}: readings ${nodes[a]} and ${nodes[b]} are one family, so not two readings`);
            }
          }
        }
      } else if (nodes.length !== 1) {
        errors.push(`${where}: a ${e.stratum} prompt names exactly 1 node (the one its stratum was counted on)`);
      }
    }

    if (e.reference !== undefined) {
      validateReference(e.reference, where, ctx, errors);
      if (e.listened !== true) errors.push(`${where}: a prompt with a reference is a listened prompt`);
    }
  });

  for (const s of STRATA) {
    if (strata[s] !== STRATA_TARGETS[s]) errors.push(`stratum ${s} has ${strata[s]} prompts; golden-v1 has ${STRATA_TARGETS[s]}`);
  }
  if (listened !== LISTENED) errors.push(`${listened} prompts are listened; golden-v1 has exactly ${LISTENED}`);
  return { ok: errors.length === 0, errors, counts: { strata, listened } };
}

/**
 * Where a manifest's strata disagree with the counts on the given data
 * (select.mjs countSupply). A count stratum must equal its node's stratum; an
 * ambiguous prompt needs at least two readings with supply. Notes, not errors
 * (see the header).
 */
export function strataDrift(entries, supply) {
  const byId = new Map(supply.nodes.map((n) => [n.id, n]));
  const notes = [];
  for (const e of entries) {
    if (!Array.isArray(e.nodes)) continue;
    if (e.stratum === "ambiguous") {
      const supplied = e.nodes.filter((n) => (byId.get(n)?.rows ?? 0) >= MIN_TOPIC_SUPPLY);
      if (supplied.length < 2) notes.push(`${e.id}: ambiguous, but only ${supplied.length} of its readings has supply`);
    } else {
      const counted = byId.get(e.nodes[0])?.stratum;
      if (counted !== e.stratum) notes.push(`${e.id}: listed ${e.stratum}, the data now counts ${e.nodes[0]} as ${counted ?? "unknown"}`);
    }
  }
  return notes;
}

/** Errors for a manifest checked against its lock; [] when it still matches. */
export function checkLock(manifestBytes, lock) {
  const errors = [];
  if (!lock || typeof lock !== "object") return ["the lock file is not a JSON object"];
  const keys = Object.keys(lock).sort().join(",");
  if (keys !== "corpusFingerprint,frozenAt,manifestSha") {
    errors.push("the lock carries exactly {manifestSha, corpusFingerprint, frozenAt}");
  }
  const sha = manifestSha(manifestBytes);
  if (lock.manifestSha !== sha) {
    errors.push(
      `golden-v1.json changed after it was locked at ${lock.frozenAt} (lock ${String(lock.manifestSha).slice(0, 12)}, ` +
        `file ${sha.slice(0, 12)}). A locked set is never edited: put the new set in golden-v2.json and lock that.`
    );
  }
  return errors;
}

/**
 * The lock for a manifest, from the report.json of a generate-forays run of
 * that manifest. Throws, naming every reason, when the report cannot vouch for
 * it: a --dry-run report (it writes none, so a dry_run flag means a forged or
 * foreign one), a different prompt file, no corpus fingerprint, or golden ids
 * the run never reached.
 */
export function buildLock({ manifestBytes, entries, report, now = new Date() }) {
  const reasons = [];
  if (!report || typeof report !== "object") throw new Error("the report is not a JSON object");
  if (report.dry_run !== false) reasons.push("the report is not from a real run (dry_run is not false); run without --dry-run");
  const shas = rawShas(manifestBytes);
  const reportSha = report.prompts?.sha256;
  if (typeof reportSha !== "string" || !shas.includes(reportSha)) {
    reasons.push("the report ran a different prompt file (prompts.sha256 does not match this manifest)");
  }
  const fingerprint = report.corpus?.fingerprint;
  if (!fingerprint || typeof fingerprint.sha256 !== "string") {
    reasons.push("the report has no corpus fingerprint (no transcripts on disk, or a report from before GV-39)");
  }
  const reached = new Set((report.entries ?? []).map((r) => r?.promptId).filter((id) => typeof id === "string"));
  const missing = entries.map((e) => e.id).filter((id) => !reached.has(id));
  if (missing.length > 0) reasons.push(`the run never reached ${missing.length} golden prompt(s): ${missing.join(", ")}`);
  if (reasons.length > 0) throw new Error(`refusing to lock:\n  - ${reasons.join("\n  - ")}`);
  return { manifestSha: manifestSha(manifestBytes), corpusFingerprint: fingerprint, frozenAt: now.toISOString() };
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

export function main(argv = process.argv.slice(2), io = {}) {
  const { root = REPO_ROOT, stdout = process.stdout, stderr = process.stderr, now = new Date(), inputs } = io;
  const out = (s) => stdout.write(`${s}\n`);
  const err = (s) => stderr.write(`${s}\n`);
  let manifestPath, lockPath, reportPath;
  try {
    manifestPath = path.resolve(argValue(argv, "--manifest") ?? DEFAULT_MANIFEST);
    lockPath = path.resolve(argValue(argv, "--lock-file") ?? DEFAULT_LOCK);
    reportPath = argValue(argv, "--lock");
  } catch (e) {
    err(e.message);
    return 2;
  }
  const manifestBytes = fs.readFileSync(manifestPath);
  let entries;
  try {
    entries = JSON.parse(manifestBytes.toString("utf8"));
  } catch (e) {
    err(`${path.basename(manifestPath)} is not JSON: ${e.message}`);
    return 1;
  }
  const result = validateManifest(entries, loadContext(root));
  if (!result.ok) {
    err(`${path.basename(manifestPath)} is invalid:\n  - ${result.errors.join("\n  - ")}`);
    return 1;
  }
  const s = result.counts.strata;
  out(
    `${path.basename(manifestPath)}: ${entries.length} prompts, ${result.counts.listened} listened, strata ` +
      STRATA.map((k) => `${k} ${s[k]}`).join(" / ")
  );

  /* `inputs` lets a caller that already parsed the committed data (18 MB of
     breadth classification) pass it in; the CLI reads it here. */
  const drift = strataDrift(entries, countSupply(inputs ?? loadInputs(root)));
  for (const note of drift) out(`  strata drift: ${note}`);
  if (drift.length > 0 && argv.includes("--strict-strata")) {
    err(`${drift.length} prompt(s) no longer sit in their stratum on the committed data (--strict-strata)`);
    return 1;
  }

  if (reportPath !== undefined) {
    if (fs.existsSync(lockPath)) {
      err(`${path.basename(lockPath)} already exists: the set is locked. A new lock is a new set (golden-v2.json).`);
      return 1;
    }
    let lock;
    try {
      lock = buildLock({ manifestBytes, entries, report: JSON.parse(fs.readFileSync(path.resolve(reportPath), "utf8")), now });
    } catch (e) {
      err(e.message);
      return 1;
    }
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    out(`locked: ${path.basename(lockPath)} manifestSha ${lock.manifestSha.slice(0, 12)}, corpus ${lock.corpusFingerprint.sha256.slice(0, 12)}`);
    return 0;
  }

  if (fs.existsSync(lockPath)) {
    const errors = checkLock(manifestBytes, JSON.parse(fs.readFileSync(lockPath, "utf8")));
    if (errors.length > 0) {
      err(errors.join("\n"));
      return 1;
    }
    out(`lock: matches ${path.basename(lockPath)}`);
  } else {
    out("lock: not locked yet (the stub-mode run in README.md writes it)");
  }
  return 0;
}

if (isEntryScript(import.meta.url)) process.exitCode = main();
