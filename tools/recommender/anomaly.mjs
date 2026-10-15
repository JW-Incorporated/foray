/* RV-26 (docs/roadmap/recommender-v1.md, D7; research section 7.4; #1380):
   the anomaly and injection audit of the teacher's gold ratings.

     node tools/recommender/anomaly.mjs [--json] [--no-student] [--embeddings <file>]

   A gold show is an anomaly, with every cause that applies, when:
     student_gap      |teacher fit - student fit| > STUDENT_GAP (1.5) on any persona;
     node_mean        |teacher fit - the persona's mean fit over the show's
                      taxonomy root| > NODE_GAP (2) on any persona;
     injection_flag   its `flags.injection_suspected` is set (rater or pack pre-scan);
     reason_injection its `top_reason`, or any persona reason in a merged joint
                      results file, matches RV-03's INJECTION_PATTERNS.

   The student's fit is never an in-sample prediction (the orchestrator's note
   on RV-26). The student (RV-25/RV-32) failed its gate, but student-model.json
   v2 exists; this tool reruns predict.mjs `trainStudent` on the committed data
   (it writes nothing) and reads, for each TRAINING row, its out-of-fold fit
   from the 5-fold CV that chose the model (`config.oofFit`: ridge plus the kNN
   blend fitted on the other folds), calibrated out-of-fold the same way
   (the persona's isotonic map fitted on the other folds only); for each
   HOLDOUT row, the plain prediction of the model fitted on the training rows.
   `--no-student` (or no embeddings) leaves the student_gap cause out and
   says so.

   Shows are audited on ratings.json's pass means. The per-batch table audits
   each merged joint results file on its OWN ratings (that pass's fits, flags
   and reasons) against the same node means and student fits, and counts a
   show once per batch however many causes it has; a batch where more than
   RERATE_SHARE (20%) of its rated shows are anomalous is a batch to re-rate.
   Isolated batches are not in the table (ratings-isolated.json is a side
   file; the joint ratings are what a consumer reads).

   Writes data-local/recommender/anomalies.json (gitignored, never committed)
   and prints a Markdown count table by cause and by batch, or the summary as
   JSON with --json. Calls no model and fetches nothing; edits no ratings
   file. Nothing on a live app path reads what it writes. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { loadResults } from "./agreement.mjs";
import { INJECTION_PATTERNS } from "./evidence.mjs";
import { loadInputs, nodeMapOf, predictPaths, teacherRetestFrom, trainStudent } from "./predict.mjs";
import { applyCalibration, finalise, fitIsotonic, foldOf } from "./student.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");

export const ANOMALIES_VERSION = 1;
/** |teacher - student| on fit above this, on any persona, is an anomaly. */
export const STUDENT_GAP = 1.5;
/** |teacher - node mean| on fit above this, on any persona, is an anomaly. */
export const NODE_GAP = 2;
/** A batch with more than this share of anomalous shows is one to re-rate. */
export const RERATE_SHARE = 0.2;
export const CAUSES = Object.freeze(["student_gap", "node_mean", "injection_flag", "reason_injection"]);
export const ANOMALIES_PATH = ["RECOMMENDER_ANOMALIES_PATH", "data-local/recommender/anomalies.json"];
export const RESULTS_DIR = ["RECOMMENDER_RESULTS_DIR", "data-local/recommender/results"];

/** The one pattern list every default below reads: RV-03's pre-scan list. */
const PATTERNS = INJECTION_PATTERNS;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, d = 2) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** The patterns of RV-03 that `text` matches, as their source strings. */
export function injectionMatches(text, patterns = PATTERNS) {
  if (typeof text !== "string" || !text) return [];
  return patterns.filter((re) => re.test(text)).map((re) => re.source);
}

/** `{ <show_key>: { <persona_id>: fit } }` from ratings.json (slot 0, the pass mean). */
export function teacherFits(ratings) {
  const out = {};
  for (const [key, entry] of Object.entries(ratings?.shows ?? {})) {
    if (!entry?.personas) continue;
    const row = {};
    for (const [pid, slots] of Object.entries(entry.personas)) if (Array.isArray(slots) && isNum(slots[0])) row[pid] = slots[0];
    out[key] = row;
  }
  return out;
}

/** `{ <node>: { <persona_id>: mean fit } }` over the shows whose node is known. */
export function nodeMeans(fits, nodeOf) {
  const acc = {};
  for (const [key, row] of Object.entries(fits)) {
    const node = nodeOf[key];
    if (!node) continue;
    acc[node] ??= {};
    for (const [pid, fit] of Object.entries(row)) {
      const a = (acc[node][pid] ??= { s: 0, n: 0 });
      a.s += fit;
      a.n++;
    }
  }
  const out = {};
  for (const [node, byPersona] of Object.entries(acc)) {
    out[node] = {};
    for (const [pid, { s, n }] of Object.entries(byPersona)) out[node][pid] = s / n;
  }
  return out;
}

/**
 * The anomaly causes of one show's ratings: `fits` `{ pid: fit }`, `injection`
 * (the injection_suspected flag), `reasons` (texts to scan), `nodeMean`
 * `{ pid: mean }` or null, `student` `{ pid: fit }` or null. Returns one entry
 * per cause that applies, with the personas or patterns that set it.
 */
export function causesOf({ fits, injection = false, reasons = [], nodeMean = null, student = null, studentGap = STUDENT_GAP, nodeGap = NODE_GAP, patterns = PATTERNS }) {
  const out = [];
  if (student) {
    const personas = [];
    for (const [pid, fit] of Object.entries(fits)) {
      const s = student[pid];
      if (isNum(fit) && isNum(s) && Math.abs(fit - s) > studentGap) personas.push({ persona: pid, teacher: fit, student: s, gap: round(fit - s) });
    }
    if (personas.length) out.push({ cause: "student_gap", personas });
  }
  if (nodeMean) {
    const personas = [];
    for (const [pid, fit] of Object.entries(fits)) {
      const m = nodeMean[pid];
      if (isNum(fit) && isNum(m) && Math.abs(fit - m) > nodeGap) personas.push({ persona: pid, teacher: fit, node_mean: round(m), gap: round(fit - m) });
    }
    if (personas.length) out.push({ cause: "node_mean", personas });
  }
  if (injection === true) out.push({ cause: "injection_flag" });
  const hits = [];
  for (const r of reasons) {
    const text = typeof r === "string" ? r : r?.text;
    const matched = injectionMatches(text, patterns);
    if (matched.length) hits.push({ ...(typeof r === "string" ? {} : { persona: r.persona ?? null, batch_id: r.batch_id ?? null }), text, patterns: matched });
  }
  if (hits.length) out.push({ cause: "reason_injection", reasons: hits });
  return out;
}

/** The joint results docs' persona reasons per show: `{ key: [{ persona, batch_id, text }] }`. */
function reasonsByShow(docs) {
  const out = {};
  for (const doc of docs) {
    for (const [key, res] of Object.entries(doc.results ?? {})) {
      for (const [pid, r] of Object.entries(res?.personas ?? {})) {
        if (typeof r?.reason === "string" && r.reason) (out[key] ??= []).push({ persona: pid, batch_id: doc.batch_id, text: r.reason });
      }
    }
  }
  return out;
}

/**
 * The audit. `ratings` is ratings.json, `goldSet` the gold set (nodes and
 * titles), `results` the merged results docs (joint ones are read) or null,
 * `student` `{ key: { pid: fit } }` or null (no student_gap cause). Returns
 * `{ shows: [...anomalous], counts, by_batch: [...] }`, deterministic.
 */
export function audit({ ratings, goldSet, results = null, student = null, studentGap = STUDENT_GAP, nodeGap = NODE_GAP, rerateShare = RERATE_SHARE, patterns = PATTERNS }) {
  const nodeOf = nodeMapOf(goldSet);
  const titleOf = Object.fromEntries((goldSet?.shows ?? []).map((r) => [String(r.show_key), r.title ?? null]));
  const fits = teacherFits(ratings);
  const means = nodeMeans(fits, nodeOf);
  const joint = (results ?? []).filter((d) => d?.mode === "joint" && d.results);
  const reasons = reasonsByShow(joint);
  const batchesOf = {};
  for (const doc of joint) for (const key of Object.keys(doc.results)) (batchesOf[key] ??= []).push(doc.batch_id);
  const opts = { studentGap, nodeGap, patterns };

  const shows = [];
  const byCause = Object.fromEntries(CAUSES.map((c) => [c, 0]));
  const audited = Object.keys(fits).sort();
  for (const key of audited) {
    const entry = ratings.shows[key];
    const causes = causesOf({
      fits: fits[key],
      injection: entry.flags?.injection_suspected === true,
      reasons: [{ persona: entry.top_persona ?? null, batch_id: null, text: entry.top_reason }, ...(reasons[key] ?? [])],
      nodeMean: nodeOf[key] ? means[nodeOf[key]] : null,
      student: student?.[key] ?? null,
      ...opts,
    });
    if (!causes.length) continue;
    for (const c of causes) byCause[c.cause]++;
    shows.push({ show_key: key, title: titleOf[key] ?? null, node: nodeOf[key] ?? null, batches: [...(batchesOf[key] ?? [])].sort(), causes });
  }

  const byBatch = [];
  for (const doc of [...joint].sort((a, b) => (a.batch_id < b.batch_id ? -1 : a.batch_id > b.batch_id ? 1 : 0))) {
    const row = { batch_id: doc.batch_id, pass: doc.pass ?? null, shows: 0, anomalous: 0, share: 0, by_cause: Object.fromEntries(CAUSES.map((c) => [c, 0])), rerate: false };
    for (const [key, res] of Object.entries(doc.results)) {
      const f = {};
      for (const [pid, r] of Object.entries(res?.personas ?? {})) if (isNum(r?.fit)) f[pid] = r.fit;
      if (!Object.keys(f).length) continue;
      row.shows++;
      const causes = causesOf({
        fits: f,
        injection: res.flags?.injection_suspected === true,
        reasons: Object.values(res.personas).map((r) => r?.reason),
        nodeMean: nodeOf[key] ? means[nodeOf[key]] : null,
        student: student?.[key] ?? null,
        ...opts,
      });
      if (!causes.length) continue;
      row.anomalous++;
      for (const c of causes) row.by_cause[c.cause]++;
    }
    row.share = row.shows ? round(row.anomalous / row.shows, 3) : 0;
    row.rerate = row.share > rerateShare;
    byBatch.push(row);
  }

  return {
    shows,
    counts: { shows_audited: audited.length, anomalous_shows: shows.length, by_cause: byCause, batches: byBatch.length, batches_to_rerate: byBatch.filter((b) => b.rerate).map((b) => b.batch_id) },
    by_batch: byBatch,
  };
}

/* --------------------------------------------------------------- student */

/**
 * The student's fit for every gold row without an in-sample prediction, from
 * a predict.mjs `trainStudent` result: training rows from the CV's
 * out-of-fold blended fit (`config.oofFit`), calibrated out-of-fold when the
 * persona's config chose isotonic (the map fitted on the other folds, the
 * fold assignment chooseStudentConfig used); holdout rows from the model's
 * plain prediction. Values finalised like a published fit (one decimal, [1, 5]).
 * `{ key: { pid: fit } }`.
 */
export function outOfFoldStudent(res, ratings, personaIds) {
  const keys = res.features.train.keys;
  const folds = res.model.selection?.folds ?? 5;
  const out = {};
  personaIds.forEach((pid, p) => {
    const oof = res.config.oofFit[p];
    const y = keys.map((k) => ratings.shows[k].personas[pid]?.[0]);
    let vals = oof;
    if (res.config.personas[p].calibration === "isotonic") {
      vals = oof.slice();
      for (let f = 0; f < folds; f++) {
        const idx = oof.map((_, i) => i).filter((i) => foldOf(i, folds) !== f && isNum(oof[i]) && isNum(y[i]));
        const cal = fitIsotonic(idx.map((i) => oof[i]), idx.map((i) => y[i]));
        oof.forEach((v, i) => {
          if (foldOf(i, folds) === f) vals[i] = applyCalibration(cal, v);
        });
      }
    }
    keys.forEach((k, i) => {
      (out[k] ??= {})[pid] = finalise("fit", vals[i]);
    });
  });
  for (const [k, entry] of Object.entries(res.predictedHoldout.shows)) {
    out[k] = {};
    for (const pid of personaIds) out[k][pid] = entry.personas[pid]?.[0] ?? null;
  }
  return out;
}

/* ---------------------------------------------------------------- render */

/** The Markdown count tables, by cause and by batch (batches to re-rate first). */
export function renderTables(report) {
  const { counts, by_batch: byBatch } = report;
  const lines = [];
  lines.push(`Audited ${counts.shows_audited} rated gold shows; ${counts.anomalous_shows} anomalous (a show counts once per cause).`);
  if (report.student) lines.push(`Student: ${report.student.note}`);
  lines.push("", "| cause | shows |", "|---|---|");
  for (const c of CAUSES) lines.push(`| ${c} | ${counts.by_cause[c]} |`);
  lines.push("", `| batch | pass | shows | anomalous | share | ${CAUSES.join(" | ")} | re-rate |`, `|---|---|---|---|---|${CAUSES.map(() => "---|").join("")}---|`);
  const ordered = [...byBatch].sort((a, b) => b.share - a.share || (a.batch_id < b.batch_id ? -1 : 1));
  for (const b of ordered) lines.push(`| ${b.batch_id} | ${b.pass ?? ""} | ${b.shows} | ${b.anomalous} | ${(b.share * 100).toFixed(1)}% | ${CAUSES.map((c) => b.by_cause[c]).join(" | ")} | ${b.rerate ? "**yes**" : ""} |`);
  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------------- CLI */

const USAGE = "usage: node tools/recommender/anomaly.mjs [--json] [--no-student] [--embeddings <file>]";

export function parseArgs(argv) {
  const args = { json: false, student: true, embeddings: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--no-student") args.student = false;
    else if (a === "--embeddings") {
      args.embeddings = argv[++i];
      if (!args.embeddings) throw new Error(`--embeddings needs a file; ${USAGE}`);
    } else throw new Error(`unknown argument ${a}; ${USAGE}`);
  }
  return args;
}

const envPath = ([name, def], { root, env }) => (env[name] ? resolvePath(process.cwd(), env[name]) : resolvePath(root, def));

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Exit codes: 0 written; 1 an input is missing or unreadable; 2 a usage error.
 * `studentOf` (tests) replaces the out-of-fold student: a function
 * `({ ratings, goldSet }) -> { student, note }`.
 */
export async function main(argv = process.argv.slice(2), { root = REPO_ROOT, env = process.env, now = () => new Date(), stdout = process.stdout, stderr = process.stderr, studentOf = null } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return 2;
  }
  try {
    const paths = predictPaths({ root, env });
    const ratings = JSON.parse(readFileSync(paths.ratings, "utf8"));
    const goldSet = JSON.parse(readFileSync(paths.goldSet, "utf8"));
    const results = loadResults(envPath(RESULTS_DIR, { root, env }), ratings);
    let student = null;
    let note = "not used (--no-student): the student_gap cause is not checked";
    if (args.student) {
      if (studentOf) ({ student, note } = studentOf({ ratings, goldSet }));
      else ({ student, note } = defaultStudent({ root, env, ratings, goldSet, paths, embeddings: args.embeddings }));
    }
    const report = audit({ ratings, goldSet, results, student });
    const doc = {
      version: ANOMALIES_VERSION,
      built_at: now().toISOString(),
      thresholds: { student_gap: STUDENT_GAP, node_gap: NODE_GAP, rerate_share: RERATE_SHARE },
      student: { used: Boolean(student), note },
      results_files: results ? results.filter((d) => d.mode === "joint").length : 0,
      ...report,
    };
    const outPath = envPath(ANOMALIES_PATH, { root, env });
    writeAtomic(outPath, `${JSON.stringify(doc, null, 2)}\n`);
    if (args.json) stdout.write(`${JSON.stringify({ path: outPath, student: doc.student, results_files: doc.results_files, counts: doc.counts, by_batch: doc.by_batch })}\n`);
    else stdout.write(renderTables({ ...report, student: doc.student }) + `\nwrote ${outPath}\n`);
    return 0;
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return 1;
  }
}

/** The out-of-fold student from the committed data and the local embeddings,
    or none with the reason. Writes nothing. */
function defaultStudent({ root, env, ratings, goldSet, paths, embeddings }) {
  let inp;
  try {
    inp = loadInputs({ root, env, embeddingsFile: embeddings });
  } catch (e) {
    return { student: null, note: `unavailable: ${e.message}` };
  }
  const committed = existsSync(paths.model) ? JSON.parse(readFileSync(paths.model, "utf8")) : null;
  const teacherRetest = existsSync(paths.goldReport) ? teacherRetestFrom(readFileSync(paths.goldReport, "utf8")) : {};
  const grid = committed?.selection?.lambda_grid;
  const res = trainStudent({ goldSet, ratings, personaIds: inp.personaIds, packOf: inp.packOf, showOf: inp.showOf, embeddingOf: inp.embeddingOf, taxonomyRoots: inp.taxonomyRoots, embedder: inp.embedder, ...(grid ? { grid } : {}), teacherRetest });
  const student = outOfFoldStudent(res, ratings, inp.personaIds);
  const same = committed?.selection?.personas ? JSON.stringify(committed.selection.personas) === JSON.stringify(res.model.selection.personas) : null;
  const note =
    `out-of-fold fit for ${res.features.train.keys.length} training rows (${res.model.selection.folds}-fold CV of student v2), ` +
    `plain prediction for ${res.features.holdout.keys.length} holdout rows; ` +
    (same === null ? "no committed model to compare" : same ? "the retrained selection matches the committed student-model.json" : "the retrained selection DIFFERS from the committed student-model.json");
  return { student, note };
}

if (isEntryScript(import.meta.url)) process.exitCode = await main();
