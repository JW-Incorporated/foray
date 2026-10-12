/* mine-exemplars.mjs — a code-scored shortlist of narration seams for the
 * writer's voice exemplars (GV-42, docs/roadmap/generation-v2.md, #1286;
 * from W7-05, covers R2-17).
 *
 * WHY THIS EXISTS
 * R2-17's few-shot step needs two exemplar seams and a voice card. The only
 * committed generated prose is four pre-Q-03 per-beat Forays the founder
 * called clunky (docs/curation/listening-quality-plan.md); the three other
 * committed Forays are clip-only. So the exemplars are chosen on evidence: this
 * tool scores every seam in code, and the founder's ear picks from the
 * shortlist. Nothing here calls a model; committed Foray text is existing
 * published copy, and a candidate file is a local forays.json-shaped output.
 *
 * THE UNIT: a SEAM RUN, the consecutive narration items between two segments
 * (any non-narration item ends a run), excluding the 'disclosure' item. A run
 * never spans two acts: an act change between two narration items (act-N-exit
 * followed by act-(N+1)-introduction, with no tape between) starts a new run,
 * so an act exit and the next act's introduction are scored as what they are.
 *
 * ROLES, in this order of precedence:
 *   act-introduction  the run holds an act-N-introduction item;
 *   act-exit          the run holds an act-N-exit item;
 *   full-intro        the next segment's show (resolved through the
 *                     candidate's own segmentSources, then data/segments.json's
 *                     row -> data/segment-sources.json, then the row's show_id)
 *                     has not played earlier in the Foray;
 *   bridge            everything else, including an unresolved show and a run
 *                     with no segment after it.
 *
 * METRICS (per run). Every rule and measure comes from backend/src/copy/
 * spokenLine.js (decision 16: the only splitter, sentence shape and FK grade)
 * and narratorStructure.js, loaded through createRequire; this file adds no
 * splitter or readability code of its own.
 *   words, sentences, meanWords, maxWords, shortSentences (under
 *   SHORT_SENTENCE_WORDS), overMax (over SENTENCE_MAX_WORDS), meanOutOfBand
 *   (outside SENTENCE_MEAN_WORDS), rhythmMiss (check-narration N21's rhythm
 *   rule: over RHYTHM_TRIGGER_SEC at 17 chars/s with no short sentence),
 *   lineFindings (spokenLineErrors per sentence, hasTape: true — a seam always
 *   sits next to tape), structureLeaks (narratorStructureLeaks per item),
 *   fkGrade, and violations = the sum of the counts.
 *   `findings` = lineFindings + structureLeaks: a run with any finding can be
 *   shortlisted (ranked low) but never selected.
 *
 * OUTPUT. data-local/exemplars/candidates.json and shortlist.md (top 5 per
 * role: fewest violations, then mean sentence length closest to 13.5, then run
 * id). Byte-stable: no timestamps, inputs in the order given.
 *
 * SELECTION. `--select <runId> [<runId>] --voice-card <file> --listened-on
 * <YYYY-MM-DD> --selected-by <name>` writes
 * tools/generation/exemplars/narration-exemplars.json. It refuses an exemplar
 * with any finding, more than 2 exemplars, a voice card over 60 words, and a
 * missing selectedBy / listenedOn. The file is read only when GV-99's
 * FORAY_WRITER_EXEMPLARS flag is on.
 *
 * Usage:
 *   node tools/generation/exemplars/mine-exemplars.mjs
 *     [--forays <file>]            default data/forays.json (generated:true only)
 *     [--candidate <file>]...      a forays.json-shaped Qwen candidate
 *     [--historic-candidate <file>]...  a Claude-pipeline candidate (the 14 Sep upload)
 *     [--segments <file>] [--segment-sources <file>] [--out-dir <dir>] [--json]
 *   node tools/generation/exemplars/mine-exemplars.mjs --select <runId> <runId>
 *     --voice-card <file> --listened-on <YYYY-MM-DD> --selected-by <name> [--out <file>]
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../../ci/entry.mjs";
import { loadSegmentPool } from "../../generation-bench/run.mjs";
import { loadSegmentSources, sourcesMap } from "../../generation-bench/score.mjs";
import { NARRATION_CHARS_PER_SEC } from "../../foray/check-narration.mjs";

const require = createRequire(import.meta.url);
const spokenLine = require("../../../backend/src/copy/spokenLine.js");
const { narratorStructureLeaks } = require("../../../backend/src/copy/narratorStructure.js");

const {
  SENTENCE_MEAN_WORDS,
  SENTENCE_MAX_WORDS,
  SHORT_SENTENCE_WORDS,
  RHYTHM_TRIGGER_SEC,
  spokenLineErrors,
  splitSpokenSentences,
  sentenceShape,
  fleschKincaidGrade,
} = spokenLine;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
export const DEFAULT_FORAYS = path.join(REPO_ROOT, "data", "forays.json");
export const DEFAULT_SEGMENTS = path.join(REPO_ROOT, "data", "segments.json");
export const DEFAULT_SEGMENT_SOURCES = path.join(REPO_ROOT, "data", "segment-sources.json");
export const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "data-local", "exemplars");
export const EXEMPLARS_FILE = path.join(HERE, "narration-exemplars.json");

export const DISCLOSURE_ID = "disclosure";
export const ROLES = Object.freeze(["act-introduction", "full-intro", "bridge", "act-exit"]);
/* The midpoint of SENTENCE_MEAN_WORDS [12, 15]. */
export const TARGET_MEAN_WORDS = (SENTENCE_MEAN_WORDS[0] + SENTENCE_MEAN_WORDS[1]) / 2;
export const SHORTLIST_PER_ROLE = 5;
export const MAX_EXEMPLARS = 2;
export const VOICE_CARD_MAX_WORDS = 60;
export const PROVENANCE = Object.freeze({
  historic: "claude-pipeline-historic",
  qwen: "qwen-pipeline",
});
export const SOURCE_KIND = Object.freeze({ committed: "committed", candidate: "candidate" });

const ACT_ID_RE = /^act-(\d+)-(introduction|exit)$/;
const BEAT_ID_RE = /^narration-act-(\d+)-/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const wordCount = (s) => String(s ?? "").split(/\s+/).filter(Boolean).length;
const round = (x, places) => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};
/* Plain code-unit order, never localeCompare: the output must not depend on the
   machine's locale. */
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The act number an item id names, or null (disclosure, an unknown scheme). */
export function actOf(itemId) {
  const id = String(itemId ?? "");
  const m = ACT_ID_RE.exec(id) || BEAT_ID_RE.exec(id);
  return m ? Number(m[1]) : null;
}

/** The Forays in a forays.json-shaped document: { forays: [...] }, an array,
 *  or one Foray object. */
export function foraysOf(doc) {
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc?.forays)) return doc.forays;
  if (doc && typeof doc === "object" && Array.isArray(doc.items)) return [doc];
  return [];
}

/** The show of a segment id, or null when it cannot be resolved. Order: the
 *  candidate's own segmentSources, then the pool row's episode in the
 *  segment-sources registry, then the pool row's show_id (score.mjs's MQ-07
 *  order). A minted segment row on the candidate names its episode as itemId. */
export function showOfSegment(segmentId, foray, pool, sources) {
  if (!isStr(segmentId)) return null;
  const minted = (Array.isArray(foray?.segments) ? foray.segments : []).find((r) => r && r.id === segmentId) || null;
  const poolRow = pool.get(segmentId) || null;
  const episode =
    (minted && isStr(minted.itemId) && minted.itemId) || (poolRow && isStr(poolRow.item_id) && poolRow.item_id) || null;
  const own = sourcesMap(foray?.segmentSources);
  const registry = sourcesMap(sources);
  return (
    (episode !== null && isStr(own.get(episode)?.show) && own.get(episode).show) ||
    (episode !== null && isStr(registry.get(episode)?.show) && registry.get(episode).show) ||
    (poolRow && isStr(poolRow.show_id) && poolRow.show_id) ||
    null
  );
}

/**
 * The seam runs of one Foray, in item order. Each run: { itemIds, items, act,
 * nextSegmentId, nextSegmentIndex }: the first segment item after the run when
 * the run ended at a non-narration item, and null when it ended at an act
 * change or at the end of the Foray.
 */
export function seamRuns(foray) {
  const items = Array.isArray(foray?.items) ? foray.items : [];
  const runs = [];
  let cur = null;
  const close = (nextIndex) => {
    if (cur && cur.items.length > 0)
      runs.push({
        itemIds: cur.items.map((it) => String(it.id ?? "")),
        items: cur.items,
        act: cur.act,
        nextSegmentIndex: nextIndex,
        nextSegmentId: nextIndex === null ? null : isStr(items[nextIndex].segment_id) ? items[nextIndex].segment_id : null,
      });
    cur = null;
  };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item?.type !== "narration") {
      if (cur) {
        let next = null;
        for (let j = i; j < items.length; j++)
          if (items[j]?.type === "segment") {
            next = j;
            break;
          }
        close(next);
      }
      continue;
    }
    if (item.id === DISCLOSURE_ID) continue;
    const act = actOf(item.id);
    if (cur && act !== null && cur.act !== null && act !== cur.act) close(null);
    if (!cur) cur = { items: [], act };
    if (cur.act === null) cur.act = act;
    cur.items.push(item);
  }
  close(null);
  return runs;
}

/** Role of a run, given the shows already heard before its next segment. */
export function roleOf(run, nextShow, showsHeard) {
  if (run.itemIds.some((id) => /^act-\d+-introduction$/.test(id))) return "act-introduction";
  if (run.itemIds.some((id) => /^act-\d+-exit$/.test(id))) return "act-exit";
  if (nextShow !== null && !showsHeard.has(nextShow)) return "full-intro";
  return "bridge";
}

/** Every per-run metric, from spokenLine.js and narratorStructure.js only. */
export function runMetrics(items) {
  const scripts = items.map((it) => (typeof it?.script === "string" ? it.script : ""));
  const sentences = [];
  const lineFindings = [];
  const structureLeaks = [];
  items.forEach((it, k) => {
    const id = String(it?.id ?? `#${k}`);
    const own = splitSpokenSentences(scripts[k]);
    own.forEach((s, n) => {
      sentences.push(s);
      for (const f of spokenLineErrors(s, `${id} sentence ${n + 1}`, { hasTape: true })) lineFindings.push(f);
    });
    for (const leak of narratorStructureLeaks(scripts[k])) structureLeaks.push({ itemId: id, phrase: leak.phrase, rule: leak.rule });
  });
  const shape = sentenceShape(sentences);
  const text = scripts.join(" ");
  const shortSentences = sentences.filter((s) => wordCount(s) < SHORT_SENTENCE_WORDS).length;
  const meanOutOfBand = shape.n > 0 && (shape.mean < SENTENCE_MEAN_WORDS[0] || shape.mean > SENTENCE_MEAN_WORDS[1]);
  const seconds = text.length / NARRATION_CHARS_PER_SEC;
  const rhythmMiss = shape.n > 0 && seconds > RHYTHM_TRIGGER_SEC && shape.min >= SHORT_SENTENCE_WORDS;
  const findings = lineFindings.length + structureLeaks.length;
  return {
    words: scripts.reduce((a, s) => a + wordCount(s), 0),
    sentences: shape.n,
    meanWords: round(shape.mean, 3),
    maxWords: shape.max,
    shortSentences,
    overMax: shape.over25,
    meanOutOfBand,
    rhythmMiss,
    fkGrade: round(fleschKincaidGrade(text), 2),
    findings,
    violations: findings + shape.over25 + (meanOutOfBand ? 1 : 0) + (rhythmMiss ? 1 : 0),
    lineFindings,
    structureLeaks,
  };
}

/**
 * Mine every input. `inputs` is a list of { doc, label, sourceKind, provenance,
 * generatedOnly }. Returns { inputs, summary, runs, skipped }.
 */
export function mine(inputs, { pool = new Map(), sources = new Map() } = {}) {
  const runs = [];
  const skipped = [];
  const seen = new Set();
  const inputRows = [];
  const summary = { forays: 0, acts: 0, narrationItems: 0, disclosureItems: 0, seamRuns: 0, byRole: Object.fromEntries(ROLES.map((r) => [r, 0])) };
  for (const input of inputs) {
    let mined = 0;
    for (const foray of foraysOf(input.doc)) {
      const forayId = String(foray?.id ?? "");
      const items = Array.isArray(foray?.items) ? foray.items : [];
      const narration = items.filter((it) => it?.type === "narration");
      if (seen.has(forayId)) {
        skipped.push({ forayId, source: input.label, reason: "duplicate foray id" });
        continue;
      }
      if (narration.length === 0) {
        skipped.push({ forayId, source: input.label, reason: "clip-only" });
        continue;
      }
      if (input.generatedOnly && foray.generated !== true) {
        skipped.push({ forayId, source: input.label, reason: "not generated" });
        continue;
      }
      seen.add(forayId);
      mined++;
      summary.forays++;
      summary.narrationItems += narration.length;
      summary.disclosureItems += narration.filter((it) => it.id === DISCLOSURE_ID).length;
      summary.acts += new Set(narration.map((it) => actOf(it.id)).filter((a) => a !== null)).size;

      /* The show of every segment item, by item index. A run's next segment
         is "new" when no earlier segment item in this Foray resolved to its
         show. */
      const showAt = items.map((it) => (it?.type === "segment" ? showOfSegment(it.segment_id, foray, pool, sources) : null));
      const heardBefore = (index) => new Set(showAt.slice(0, index).filter((s) => s !== null));

      for (const run of seamRuns(foray)) {
        const nextShow = run.nextSegmentIndex === null ? null : showAt[run.nextSegmentIndex];
        const role = roleOf(run, nextShow, run.nextSegmentIndex === null ? new Set() : heardBefore(run.nextSegmentIndex));
        summary.byRole[role]++;
        summary.seamRuns++;
        runs.push({
          runId: `${forayId}:${run.itemIds[0]}`,
          role,
          forayId,
          act: run.act,
          itemIds: run.itemIds,
          sourceKind: input.sourceKind,
          provenance: input.provenance,
          source: input.label,
          nextSegmentId: run.nextSegmentId,
          nextShow,
          text: run.items.map((it) => (typeof it?.script === "string" ? it.script : "")).join("\n"),
          metrics: runMetrics(run.items),
        });
      }
    }
    inputRows.push({ source: input.label, sourceKind: input.sourceKind, provenance: input.provenance, forays: mined });
  }
  return { inputs: inputRows, summary, runs, skipped };
}

/** Shortlist order: fewest violations, then mean closest to 13.5, then run id. */
export function compareRuns(a, b) {
  return (
    a.metrics.violations - b.metrics.violations ||
    Math.abs(a.metrics.meanWords - TARGET_MEAN_WORDS) - Math.abs(b.metrics.meanWords - TARGET_MEAN_WORDS) ||
    byString(a.runId, b.runId)
  );
}

/** The top `per` runs of each role, in ROLES order. */
export function shortlist(runs, per = SHORTLIST_PER_ROLE) {
  return Object.fromEntries(ROLES.map((role) => [role, runs.filter((r) => r.role === role).sort(compareRuns).slice(0, per)]));
}

/** candidates.json's text: version 1, the inputs, the summary, every run. */
export function candidatesJson(result) {
  return JSON.stringify({ version: 1, inputs: result.inputs, summary: result.summary, skipped: result.skipped, runs: result.runs }, null, 2) + "\n";
}

/** The markdown shortlist the founder reads. */
export function shortlistMarkdown(result, per = SHORTLIST_PER_ROLE) {
  const s = result.summary;
  const lines = [
    "# Narration exemplar shortlist",
    "",
    "Written by tools/generation/exemplars/mine-exemplars.mjs (GV-42). Code-scored; the founder's ear picks 2 exemplars and the voice card.",
    "",
    `Mined ${s.forays} Foray(s), ${s.acts} act(s), ${s.narrationItems} narration item(s) (${s.disclosureItems} disclosure item(s) excluded), ${s.seamRuns} seam run(s). Skipped ${result.skipped.length}: ${result.skipped.map((k) => `${k.forayId} (${k.reason})`).join(", ") || "none"}.`,
    "",
    `Order: fewest violations, then mean sentence length closest to ${TARGET_MEAN_WORDS}. A run with findings > 0 cannot be selected.`,
    "",
    "Select: node tools/generation/exemplars/mine-exemplars.mjs --select <runId> <runId> --voice-card <file> --listened-on <YYYY-MM-DD> --selected-by <name>",
  ];
  const list = shortlist(result.runs, per);
  for (const role of ROLES) {
    const rows = list[role];
    lines.push("", `## ${role} (${s.byRole[role]} run(s))`, "");
    if (rows.length === 0) {
      lines.push("None.");
      continue;
    }
    lines.push("| # | runId | violations | findings | sentences | mean | max | short | FK | words |", "|---|---|---|---|---|---|---|---|---|---|");
    rows.forEach((r, i) => {
      const m = r.metrics;
      lines.push(`| ${i + 1} | ${r.runId} | ${m.violations} | ${m.findings} | ${m.sentences} | ${m.meanWords} | ${m.maxWords} | ${m.shortSentences} | ${m.fkGrade} | ${m.words} |`);
    });
    rows.forEach((r, i) => {
      lines.push("", `### ${role} ${i + 1}: ${r.runId}`, "", `${r.provenance}, ${r.sourceKind}; items ${r.itemIds.join(", ")}${r.nextShow ? `; next show ${r.nextShow}` : ""}`, "");
      for (const line of r.text.split("\n")) lines.push(`> ${line}`);
      for (const f of r.metrics.lineFindings) lines.push("", `- finding: ${f}`);
      for (const l of r.metrics.structureLeaks) lines.push("", `- structure leak: ${l.itemId} "${l.phrase}" (${l.rule})`);
    });
  }
  return lines.join("\n") + "\n";
}

/**
 * Every reason a narration-exemplars.json object would be refused; empty when
 * it is acceptable. GV-99's loader applies the same selectedBy/listenedOn rule.
 */
export function exemplarsFileProblems(file) {
  const out = [];
  if (!file || typeof file !== "object") return ["not an object"];
  if (file.version !== 1) out.push("version must be 1");
  if (file.voiceCard !== null) {
    if (!file.voiceCard || !isStr(file.voiceCard.text)) out.push("voiceCard must be null or { text, words }");
    else {
      const words = wordCount(file.voiceCard.text);
      if (words > VOICE_CARD_MAX_WORDS) out.push(`voice card is ${words} words; the limit is ${VOICE_CARD_MAX_WORDS}`);
      if (file.voiceCard.words !== words) out.push(`voiceCard.words is ${file.voiceCard.words}, the text has ${words}`);
    }
  }
  if (!Array.isArray(file.exemplars)) return [...out, "exemplars must be an array"];
  if (file.exemplars.length > MAX_EXEMPLARS) out.push(`${file.exemplars.length} exemplars; at most ${MAX_EXEMPLARS}`);
  file.exemplars.forEach((e, i) => {
    if (!ROLES.includes(e?.role)) out.push(`exemplar ${i + 1}: unknown role ${JSON.stringify(e?.role)}`);
    if (!isStr(e?.text)) out.push(`exemplar ${i + 1}: empty text`);
    if (!isStr(e?.selectedBy)) out.push(`exemplar ${i + 1}: missing selectedBy`);
    if (!isStr(e?.listenedOn) || !DATE_RE.test(e.listenedOn)) out.push(`exemplar ${i + 1}: missing or malformed listenedOn`);
    if (!Object.values(PROVENANCE).includes(e?.provenance)) out.push(`exemplar ${i + 1}: unknown provenance ${JSON.stringify(e?.provenance)}`);
  });
  return out;
}

/**
 * Build narration-exemplars.json from the founder's picks. Throws one Error
 * listing every refusal.
 */
export function selectExemplars(runs, { runIds = [], voiceCard = null, listenedOn, selectedBy } = {}) {
  const problems = [];
  if (runIds.length === 0 && voiceCard === null) problems.push("nothing selected: name a run id or a voice card");
  if (runIds.length > MAX_EXEMPLARS) problems.push(`${runIds.length} exemplars selected; at most ${MAX_EXEMPLARS}`);
  if (new Set(runIds).size !== runIds.length) problems.push("a run id is selected twice");
  if (!isStr(selectedBy)) problems.push("--selected-by is required");
  if (!isStr(listenedOn)) problems.push("--listened-on is required");
  else if (!DATE_RE.test(listenedOn) || Number.isNaN(Date.parse(`${listenedOn}T00:00:00Z`))) problems.push(`--listened-on ${listenedOn} is not a YYYY-MM-DD date`);
  let card = null;
  if (voiceCard !== null) {
    const text = String(voiceCard).trim();
    const words = wordCount(text);
    if (words === 0) problems.push("the voice card is empty");
    if (words > VOICE_CARD_MAX_WORDS) problems.push(`the voice card is ${words} words; the limit is ${VOICE_CARD_MAX_WORDS}`);
    card = { text, words };
  }
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const exemplars = [];
  for (const id of runIds) {
    const run = byId.get(id);
    if (!run) {
      problems.push(`unknown run id ${id}`);
      continue;
    }
    if (run.metrics.findings > 0)
      problems.push(`${id} has ${run.metrics.findings} finding(s): ${[...run.metrics.lineFindings, ...run.metrics.structureLeaks.map((l) => `${l.itemId}: structure leak "${l.phrase}"`)].join("; ")}`);
    exemplars.push({
      role: run.role,
      text: run.text,
      forayId: run.forayId,
      itemIds: run.itemIds,
      sourceKind: run.sourceKind,
      provenance: run.provenance,
      selectedBy: isStr(selectedBy) ? selectedBy.trim() : selectedBy,
      listenedOn,
    });
  }
  if (problems.length > 0) throw new Error(`refused:\n- ${problems.join("\n- ")}`);
  const file = { version: 1, voiceCard: card, exemplars };
  const left = exemplarsFileProblems(file);
  if (left.length > 0) throw new Error(`refused:\n- ${left.join("\n- ")}`);
  return file;
}

export function exemplarsJson(file) {
  return JSON.stringify(file, null, 2) + "\n";
}

/* ------------------------------------------------------------------ */
/* CLI                                                                  */
/* ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const args = { forays: null, candidates: [], historicCandidates: [], segments: null, segmentSources: null, outDir: null, out: null, select: null, voiceCard: null, listenedOn: null, selectedBy: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--forays") args.forays = next();
    else if (a === "--candidate") args.candidates.push(next());
    else if (a === "--historic-candidate") args.historicCandidates.push(next());
    else if (a === "--segments") args.segments = next();
    else if (a === "--segment-sources") args.segmentSources = next();
    else if (a === "--out-dir") args.outDir = next();
    else if (a === "--out") args.out = next();
    else if (a === "--voice-card") args.voiceCard = next();
    else if (a === "--listened-on") args.listenedOn = next();
    else if (a === "--selected-by") args.selectedBy = next();
    else if (a === "--json") args.json = true;
    else if (a === "--select") {
      args.select = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args.select.push(argv[++i]);
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** A path as recorded in the output: repo-relative with forward slashes. */
const label = (file) => path.relative(REPO_ROOT, path.resolve(file)).split(path.sep).join("/");
const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export function inputsFromArgs(args) {
  const forays = args.forays ? path.resolve(args.forays) : DEFAULT_FORAYS;
  return [
    { doc: readJsonFile(forays), label: label(forays), sourceKind: SOURCE_KIND.committed, provenance: PROVENANCE.historic, generatedOnly: true },
    ...args.historicCandidates.map((f) => ({ doc: readJsonFile(f), label: label(f), sourceKind: SOURCE_KIND.candidate, provenance: PROVENANCE.historic, generatedOnly: false })),
    ...args.candidates.map((f) => ({ doc: readJsonFile(f), label: label(f), sourceKind: SOURCE_KIND.candidate, provenance: PROVENANCE.qwen, generatedOnly: false })),
  ];
}

export function main(argv, out = console.log) {
  const args = parseArgs(argv);
  const pool = loadSegmentPool(args.segments ? path.resolve(args.segments) : DEFAULT_SEGMENTS);
  const sources = loadSegmentSources(args.segmentSources ? path.resolve(args.segmentSources) : DEFAULT_SEGMENT_SOURCES);
  const result = mine(inputsFromArgs(args), { pool, sources });
  if (args.select !== null) {
    const voiceCard = args.voiceCard ? fs.readFileSync(path.resolve(args.voiceCard), "utf8") : null;
    const file = selectExemplars(result.runs, { runIds: args.select, voiceCard, listenedOn: args.listenedOn, selectedBy: args.selectedBy });
    const target = args.out ? path.resolve(args.out) : EXEMPLARS_FILE;
    fs.writeFileSync(target, exemplarsJson(file));
    out(`wrote ${label(target)}: ${file.exemplars.length} exemplar(s), voice card ${file.voiceCard ? `${file.voiceCard.words} words` : "none"}`);
    return 0;
  }
  const dir = args.outDir ? path.resolve(args.outDir) : DEFAULT_OUT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "candidates.json"), candidatesJson(result));
  fs.writeFileSync(path.join(dir, "shortlist.md"), shortlistMarkdown(result));
  const s = result.summary;
  if (args.json) out(JSON.stringify({ summary: s, skipped: result.skipped }, null, 2));
  else
    out(
      `mined ${s.forays} Foray(s), ${s.acts} act(s), ${s.narrationItems} narration item(s) (${s.disclosureItems} disclosure excluded), ` +
        `${s.seamRuns} seam run(s); skipped ${result.skipped.length} (${result.skipped.map((k) => k.reason).join(", ") || "none"}); wrote ${label(dir)}/candidates.json and shortlist.md`
    );
  return 0;
}

if (isEntryScript(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
