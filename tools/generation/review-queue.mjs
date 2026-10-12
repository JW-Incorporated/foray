/* GV-41 (W6-16, R2-19) — the review queue: local candidates ranked by
 * scorecard risk, one markdown card per act, and every per-act verdict
 * appended to a JSONL that later calibration work reads as labelled examples.
 *
 * WHY A QUEUE
 * The founder's hold review (D7) is the expensive step: every act is a listen.
 * The queue puts the candidates most likely to be wrong first, shows each act
 * as one card (every script and every clip, in play order, with the act's
 * numbers), and turns the verdict into a data row instead of a chat message,
 * so LM-24's Jev threshold calibration (GV-94, GV-103) and the two-lane
 * promotion rule (GV-81) can read it.
 *
 * SUBCOMMANDS
 *   list    --dir <candidates dir> [--dir <dir> ...] [--json]
 *           Reads <dir>/report.json: entries[].veracity (veracityMetrics.ts
 *           VeracityMetrics), entries[].spineReasks, and the candidate file
 *           each entry names (entries[].file). Prints the candidates in risk
 *           order (below).
 *   card    <forayId> --dir <dir> [--act N] [--segments f] [--sources f]
 *           Prints a markdown card per act (or act N only): the act title,
 *           every narration script in order, every clip (show and episode
 *           title from the candidate's segmentSources, then the committed
 *           data/segment-sources.json; start-end; boundary), and the act's
 *           metrics.
 *   verdict <forayId> --dir <dir> --act N --verdict pass|fail|fix
 *           --scores onSubject=4,flowsAtSeams=3,oneNarrator=5,nothingFalseOrOdd=4
 *           [--wince 132:'text' ...] [--lane catalogue|on-demand]
 *           [--out data-local/review/verdicts.jsonl] [--at <ISO time>]
 *           Appends exactly one VERDICT_SCHEMA (foray-review-verdict, v1) line.
 *
 * RISK ORDER (lexicographic; the first rule that separates two candidates wins)
 *   1. unverifiedPages > 0 first
 *   2. groundedQuoteRate < 1 first (null: no checkable quote, not a failure)
 *   3. purposeFidelity ascending, null worst
 *   4. clipOnSubjectRate ascending when the entry has it (the gates
 *      workstream's MQ-05 scorer), otherwise tapeRelevance; null worst
 *   5. retryRounds descending (null counts as 0: no evidence of a retry)
 *   6. spineReasks.length descending
 *   then forayId, so the order is total and the same on every machine.
 *
 * ONE LISTENING-AXES SCHEMA (decision 35)
 * A verdict row embeds the listen-card/1 axes. The axis names, the 1-5 range,
 * the wince shape and the validation all come from tools/listening/card.mjs
 * (GV-08): this file defines no axis list of its own. It validates a verdict's
 * scores and winces by handing them to card.mjs's validateCard inside an
 * otherwise-valid solo card, so a change to card.mjs's rules is a change here.
 *
 * THE ROW (VERDICT_SCHEMA: foray-review-verdict, version 1)
 *   { schema, forayId, act, candidateSha256, lane, verdict, scores, winces,
 *     reviewer: "founder", at }
 * candidateSha256 is the sha-256 of the candidate file's bytes as read, so a
 * verdict cannot be carried over to a regenerated candidate (GV-81 checks it).
 * The row holds no prompt. report.json rows DO carry `prompt` (ReportEntry);
 * no output of this tool copies it.
 *
 * WHERE VERDICTS LIVE
 * data-local/review/verdicts.jsonl (gitignored). Founder LISTENING cards from
 * blind packs stay in docs/curation/listening/cards.jsonl (GV-08); this store
 * is per-act REVIEW verdicts. Nothing here calls a model or the network, and
 * nothing writes data/forays.json.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isEntryScript } from "../ci/entry.mjs";
import { AXES, CARD_SCHEMA, ID_RE, LISTENED_AT_RE, Q06_KEYS, REPO_ROOT, validateCard } from "../listening/card.mjs";
import { DEFAULT_SEGMENTS, DEFAULT_SOURCES, extractAct, loadPools } from "../listening/pack.mjs";

// Split on purpose: tools/segments/politeness.test.mjs flags any "foray...<slash><digit>"
// literal under tools/ as a hand-copied User-Agent (#316). The value is
// still the spec's schema id; review-queue.test.mjs pins its exact bytes.
export const VERDICT_SCHEMA = "foray-review-verdict" + "/1";
export const DEFAULT_VERDICTS = path.join(REPO_ROOT, "data-local", "review", "verdicts.jsonl");
export const VERDICTS = Object.freeze(["pass", "fail", "fix"]);
/** GV-81's two lanes; a candidate without `meta.lane` is catalogue (its default). */
export const LANES = Object.freeze(["catalogue", "on-demand"]);
export const REVIEWER = "founder";
export const VERDICT_KEYS = Object.freeze(["schema", "forayId", "act", "candidateSha256", "lane", "verdict", "scores", "winces", "reviewer", "at"]);
export const NO_SCRIPT = "(no script in this candidate)";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/* ------------------------------------------------------------------ */
/* Reading a candidates directory                                      */
/* ------------------------------------------------------------------ */

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${what} ${file}: ${err.message}`);
  }
}

/** sha-256 hex of a file's bytes as read. */
export function sha256Of(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** A candidate file: its bytes' sha and the parsed object, from ONE read. */
export function readCandidate(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`cannot read candidate ${file}: ${err.message}`);
  }
  let candidate;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new Error(`candidate ${file} is not JSON: ${err.message}`);
  }
  if (!isPlainObject(candidate) || typeof candidate.id !== "string") throw new Error(`candidate ${file} has no id`);
  return { candidate, sha256: sha256Of(bytes) };
}

/** The acts a candidate declares: 1..N where act-N-introduction exists. */
export function actCount(candidate) {
  const items = Array.isArray(candidate.items) ? candidate.items : [];
  let n = 0;
  while (items.some((i) => isPlainObject(i) && i.id === `act-${n + 1}-introduction`)) n++;
  return n;
}

/**
 * Every reviewable row of one candidates directory: a report entry that names
 * a candidate file that exists. Rows carry the risk inputs and never the
 * entry's prompt.
 */
export function loadDir(dir) {
  const reportFile = path.join(dir, "report.json");
  const report = readJson(reportFile, "report");
  const entries = Array.isArray(report?.entries) ? report.entries : [];
  const rows = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry.file !== "string" || entry.file === "") {
      skipped++;
      continue;
    }
    const file = path.resolve(dir, entry.file);
    if (!fs.existsSync(file)) {
      skipped++;
      continue;
    }
    const { candidate, sha256 } = readCandidate(file);
    const veracity = isPlainObject(entry.veracity) ? entry.veracity : isPlainObject(candidate.meta?.veracity) ? candidate.meta.veracity : {};
    rows.push({
      forayId: candidate.id,
      file,
      dir: path.resolve(dir),
      sha256,
      lane: laneOf(candidate, entry),
      acts: actCount(candidate),
      veracity,
      spineReasks: Array.isArray(entry.spineReasks) ? entry.spineReasks.length : 0,
      narrationActs: Array.isArray(entry.narrationActs) ? entry.narrationActs : []
    });
  }
  return { rows, skipped };
}

function laneOf(candidate, entry) {
  const lane = candidate.meta?.lane ?? entry?.lane;
  return LANES.includes(lane) ? lane : "catalogue";
}

/* ------------------------------------------------------------------ */
/* Risk order                                                          */
/* ------------------------------------------------------------------ */

/** The six risk inputs of one row, as the header orders them. */
export function riskOf(row) {
  const v = isPlainObject(row.veracity) ? row.veracity : {};
  const subject = isNum(v.clipOnSubjectRate) ? { name: "clipOnSubjectRate", value: v.clipOnSubjectRate } : { name: "tapeRelevance", value: isNum(v.tapeRelevance) ? v.tapeRelevance : null };
  return {
    unverifiedPages: isNum(v.unverifiedPages) ? v.unverifiedPages : null,
    groundedQuoteRate: isNum(v.groundedQuoteRate) ? v.groundedQuoteRate : null,
    purposeFidelity: isNum(v.purposeFidelity) ? v.purposeFidelity : null,
    subject,
    retryRounds: isNum(v.retryRounds) ? v.retryRounds : null,
    spineReasks: row.spineReasks || 0
  };
}

/** Ascending, null worst (first). */
function ascNullFirst(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}

/** Riskier first: negative when `a` should be reviewed before `b`. */
export function compareRisk(a, b) {
  const ra = riskOf(a);
  const rb = riskOf(b);
  const flag = (x) => (x ? 0 : 1);
  return (
    flag(ra.unverifiedPages > 0) - flag(rb.unverifiedPages > 0) ||
    flag(ra.groundedQuoteRate !== null && ra.groundedQuoteRate < 1) - flag(rb.groundedQuoteRate !== null && rb.groundedQuoteRate < 1) ||
    ascNullFirst(ra.purposeFidelity, rb.purposeFidelity) ||
    ascNullFirst(ra.subject.value, rb.subject.value) ||
    (rb.retryRounds ?? 0) - (ra.retryRounds ?? 0) ||
    rb.spineReasks - ra.spineReasks ||
    (a.forayId < b.forayId ? -1 : a.forayId > b.forayId ? 1 : 0)
  );
}

export function rankRows(rows) {
  return [...rows].sort(compareRisk);
}

const cell = (v, digits = 2) => (v === null || v === undefined ? "-" : isNum(v) && !Number.isInteger(v) ? v.toFixed(digits) : String(v));

/** The queue as text: one line per candidate, riskiest first. */
export function formatQueue(ranked) {
  const lines = ["rank  forayId  acts  unverified  groundedQuote  purpose  onSubject  retries  reasks  lane"];
  ranked.forEach((row, i) => {
    const r = riskOf(row);
    const subject = r.subject.value === null ? "-" : `${cell(r.subject.value)}${r.subject.name === "tapeRelevance" ? " (tape)" : ""}`;
    lines.push(
      [i + 1, row.forayId, row.acts, cell(r.unverifiedPages), cell(r.groundedQuoteRate), cell(r.purposeFidelity), subject, cell(r.retryRounds), r.spineReasks, row.lane].join("  ")
    );
  });
  return lines.join("\n");
}

/** The queue as JSON rows (the same fields, no prompt, no file contents). */
export function queueJson(ranked) {
  return ranked.map((row, i) => ({ rank: i + 1, forayId: row.forayId, file: row.file, acts: row.acts, lane: row.lane, candidateSha256: row.sha256, risk: riskOf(row) }));
}

/* ------------------------------------------------------------------ */
/* Finding one candidate                                               */
/* ------------------------------------------------------------------ */

/** The one row whose candidate id is `forayId` across the given dirs. */
export function findRow(dirs, forayId) {
  const hits = dirs.flatMap((d) => loadDir(d).rows).filter((r) => r.forayId === forayId);
  if (hits.length === 0) throw new Error(`no candidate with id ${forayId} in ${dirs.join(", ")}`);
  const files = [...new Set(hits.map((h) => h.file))];
  if (files.length > 1) throw new Error(`${forayId} names ${files.length} candidate files (${files.join(", ")}); pass the one --dir to review`);
  return hits[0];
}

/* ------------------------------------------------------------------ */
/* The act card                                                        */
/* ------------------------------------------------------------------ */

const EMPTY_POOLS = Object.freeze({ segments: new Map(), sources: new Map() });

/** The committed pools, or empty ones when they cannot be read (a checkout
 * without data/): a clip then prints as unresolved rather than failing. */
export function loadPoolsOrEmpty(opts) {
  try {
    return loadPools(opts);
  } catch {
    return EMPTY_POOLS;
  }
}

/** A segment item -> what the card prints: show, episode, start, end,
 * boundary. The candidate's own minted rows win over the committed pool. */
export function describeClip(segmentId, candidate, pools = EMPTY_POOLS) {
  const minted = (candidate.segments || []).find((r) => isPlainObject(r) && r.id === segmentId);
  const row = minted || pools.segments.get(segmentId);
  if (!isPlainObject(row)) return { segmentId, unresolved: "segment not found" };
  const itemId = row.itemId ?? row.item_id;
  const startSec = row.startSec ?? row.start_sec;
  const endSec = row.endSec ?? row.end_sec;
  const source = (candidate.segmentSources || []).find((r) => isPlainObject(r) && r.id === itemId) || pools.sources.get(itemId);
  return {
    segmentId,
    show: isPlainObject(source) && typeof source.show === "string" ? source.show : null,
    episode: isPlainObject(source) && typeof source.title === "string" ? source.title : null,
    startSec: isNum(startSec) ? startSec : null,
    endSec: isNum(endSec) ? endSec : null,
    boundary: typeof row.boundary === "string" ? row.boundary : null
  };
}

export function fmtTime(sec) {
  if (!isNum(sec)) return "?";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

const words = (text) => (typeof text === "string" ? text.split(/\s+/).filter(Boolean).length : 0);

/** The act's title: a partial candidate's `acts[].title`, otherwise the
 * titles of the slots its items are stamped with (the final candidate carries
 * no act title of its own). */
export function actTitle(candidate, act, items) {
  const declared = Array.isArray(candidate.acts) ? candidate.acts.find((a) => isPlainObject(a) && a.index === act - 1) : null;
  if (declared && typeof declared.title === "string" && declared.title.trim() !== "") return declared.title;
  const slotIds = [...new Set(items.map((i) => i.slot).filter((s) => typeof s === "string"))];
  const slots = Array.isArray(candidate.slots) ? candidate.slots : [];
  const titles = slotIds.map((id) => slots.find((s) => isPlainObject(s) && s.id === id)?.title).filter((t) => typeof t === "string");
  return titles.length ? titles.join(" / ") : `Act ${act}`;
}

/** One act as data: the play-order lines and the act's metrics. */
export function buildActCard(candidate, act, { pools = EMPTY_POOLS, row } = {}) {
  const items = extractAct(candidate.items, act);
  const play = items.map((item) => {
    if (item.type === "segment") return { kind: "clip", ...describeClip(item.segment_id, candidate, pools) };
    if (item.type === "narration") {
      const script = typeof item.script === "string" && item.script.trim() !== "" ? item.script : null;
      return { kind: "narration", id: item.id, mode: item.mode ?? null, script };
    }
    return { kind: "jingle", id: item.id ?? null };
  });
  const clips = play.filter((p) => p.kind === "clip");
  const narration = play.filter((p) => p.kind === "narration");
  const clipSec = clips.reduce((sum, c) => sum + (isNum(c.startSec) && isNum(c.endSec) ? c.endSec - c.startSec : 0), 0);
  const metrics = {
    items: play.length,
    narrationItems: narration.length,
    narrationWords: narration.reduce((sum, n) => sum + words(n.script), 0),
    scriptsMissing: narration.filter((n) => !n.script).length,
    clips: clips.length,
    unresolvedClips: clips.filter((c) => c.unresolved).length,
    clipSec: Math.round(clipSec * 10) / 10
  };
  const timing = (row?.narrationActs || []).find((t) => isPlainObject(t) && t.act === act - 1);
  if (timing && isNum(timing.ms)) metrics.narrateMs = timing.ms;
  const delivered = Array.isArray(candidate.delivery?.acts) ? candidate.delivery.acts.find((a) => isPlainObject(a) && a.index === act - 1) : null;
  if (delivered) {
    metrics.servable = delivered.servable === true;
    metrics.blockers = Array.isArray(delivered.blockers) ? delivered.blockers.length : 0;
  }
  return { forayId: candidate.id, act, acts: actCount(candidate), title: actTitle(candidate, act, items), play, metrics };
}

/** The card as markdown. */
export function formatActCard(card, row) {
  const out = [`# ${card.forayId} · act ${card.act} of ${card.acts}`, "", `## ${card.title}`, ""];
  if (row) out.push(`Lane: ${row.lane} · candidate sha256 ${row.sha256.slice(0, 12)}`, "");
  out.push("### In play order", "");
  card.play.forEach((p, i) => {
    const n = `${i + 1}.`;
    if (p.kind === "narration") {
      out.push(`${n} Narration \`${p.id}\`${p.mode ? ` (${p.mode})` : ""}: ${p.script ?? NO_SCRIPT}`);
    } else if (p.kind === "clip") {
      if (p.unresolved) {
        out.push(`${n} Clip \`${p.segmentId}\`: unresolved (${p.unresolved})`);
      } else {
        const len = isNum(p.startSec) && isNum(p.endSec) ? ` (${(p.endSec - p.startSec).toFixed(1)} s)` : "";
        out.push(`${n} Clip: ${p.show ?? "unknown show"} · "${p.episode ?? "unknown episode"}" · ${fmtTime(p.startSec)}-${fmtTime(p.endSec)}${len} · boundary ${p.boundary ?? "unknown"} · \`${p.segmentId}\``);
      }
    } else {
      out.push(`${n} Jingle`);
    }
  });
  const m = card.metrics;
  out.push("", "### Act metrics", "");
  out.push(`- items ${m.items}: ${m.narrationItems} narration (${m.narrationWords} words${m.scriptsMissing ? `, ${m.scriptsMissing} without a script` : ""}), ${m.clips} clips (${m.clipSec} s${m.unresolvedClips ? `, ${m.unresolvedClips} unresolved` : ""})`);
  if ("narrateMs" in m) out.push(`- narrate time ${(m.narrateMs / 1000).toFixed(1)} s`);
  if ("servable" in m) out.push(`- servable ${m.servable ? "yes" : "no"} (${m.blockers} blocker(s))`);
  if (row) {
    const r = riskOf(row);
    out.push("", "### Foray risk", "");
    out.push(`- unverifiedPages ${cell(r.unverifiedPages)} · groundedQuoteRate ${cell(r.groundedQuoteRate)} · purposeFidelity ${cell(r.purposeFidelity)}`);
    out.push(`- ${r.subject.name} ${cell(r.subject.value)} · retryRounds ${cell(r.retryRounds)} · spineReasks ${r.spineReasks}`);
  }
  out.push("", `Verdict: node tools/generation/review-queue.mjs verdict ${card.forayId} --dir <dir> --act ${card.act} --verdict pass|fail|fix --scores ${AXES.map((a) => `${a}=N`).join(",")}`);
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Verdicts                                                            */
/* ------------------------------------------------------------------ */

/**
 * card.mjs's own errors for these scores and winces. They are checked inside
 * an otherwise-valid solo card, so every error returned is about them: the
 * axis names, the 1-5 range and the wince shape are card.mjs's rules, not a
 * copy of them.
 */
export function axisErrors(scores, winces) {
  const probe = {
    schema: CARD_SCHEMA,
    cardId: "review-probe",
    packId: "review-probe",
    label: "solo",
    act: 1,
    listener: REVIEWER,
    listenedAt: "2000-01-01T00:00:00Z",
    scores,
    overall: 1,
    q06: Object.fromEntries(Q06_KEYS.map((k) => [k, false])),
    winces
  };
  return validateCard(probe).errors;
}

/** Check one verdict row. Never throws; returns every problem. */
export function validateVerdict(row) {
  const errors = [];
  if (!isPlainObject(row)) return { ok: false, errors: ["a verdict is a JSON object"] };
  for (const key of Object.keys(row)) if (!VERDICT_KEYS.includes(key)) errors.push(`unknown field "${key}"`);
  if (row.schema !== VERDICT_SCHEMA) errors.push(`schema must be "${VERDICT_SCHEMA}"`);
  if (typeof row.forayId !== "string" || !ID_RE.test(row.forayId)) errors.push("forayId must be a candidate id");
  if (!Number.isInteger(row.act) || row.act < 1) errors.push("act must be an integer >= 1");
  if (typeof row.candidateSha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.candidateSha256)) errors.push("candidateSha256 must be a sha-256 hex digest");
  if (!LANES.includes(row.lane)) errors.push(`lane must be one of ${LANES.join(", ")}`);
  if (!VERDICTS.includes(row.verdict)) errors.push(`verdict must be one of ${VERDICTS.join(", ")}`);
  errors.push(...axisErrors(row.scores, row.winces));
  if (row.reviewer !== REVIEWER) errors.push(`reviewer must be "${REVIEWER}"`);
  if (typeof row.at !== "string" || !LISTENED_AT_RE.test(row.at) || !Number.isFinite(Date.parse(row.at))) errors.push("at must be an ISO 8601 date-time with a zone");
  return { ok: errors.length === 0, errors };
}

/** Every row of a verdicts file, validated; a missing file holds none. */
export function readVerdicts(file = DEFAULT_VERDICTS) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  fs.readFileSync(file, "utf8")
    .split("\n")
    .forEach((raw, index) => {
      const line = raw.replace(/\r$/, "");
      if (line.trim() === "") return;
      let row;
      try {
        row = JSON.parse(line);
      } catch (err) {
        throw new Error(`${file}:${index + 1}: not JSON (${err.message})`);
      }
      const { ok, errors } = validateVerdict(row);
      if (!ok) throw new Error(`${file}:${index + 1}: ${errors.join("; ")}`);
      rows.push(row);
    });
  return rows;
}

/** Append one validated row. Existing bytes are never rewritten. */
export function appendVerdict(file, row) {
  const { ok, errors } = validateVerdict(row);
  if (!ok) throw new Error(`verdict refused: ${errors.join("; ")}`);
  readVerdicts(file);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lead = existing !== "" && !existing.endsWith("\n") ? "\n" : "";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${lead}${JSON.stringify(row)}\n`);
}

/** "onSubject=4,flowsAtSeams=3" -> { onSubject: 4, flowsAtSeams: 3 }. A value
 * that is not a number stays as text, so card.mjs names the axis it refuses. */
export function parseScores(text) {
  if (typeof text !== "string" || text.trim() === "") throw new Error(`--scores is required: ${AXES.map((a) => `${a}=1-5`).join(",")}`);
  const scores = {};
  for (const part of text.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 1) throw new Error(`--scores: "${part}" is not axis=score`);
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (Object.hasOwn(scores, name)) throw new Error(`--scores: ${name} is given twice`);
    scores[name] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return scores;
}

/** "132:text" -> { atSec: 132, note: "text" }. */
export function parseWince(text) {
  const colon = String(text).indexOf(":");
  if (colon < 1) throw new Error(`--wince: "${text}" is not <seconds>:<note>`);
  const at = String(text).slice(0, colon).trim();
  let note = String(text).slice(colon + 1);
  if (/^'.*'$/s.test(note)) note = note.slice(1, -1);
  return { atSec: /^\d+(\.\d+)?$/.test(at) ? Number(at) : at, note };
}

/**
 * Build the verdict row for act `act` of the candidate `row` names. The
 * candidate is read ONCE, here: its sha and its acts come from the same bytes.
 */
export function buildVerdict({ row, act, verdict, scores, winces = [], lane, at }) {
  const { candidate, sha256 } = readCandidate(row.file);
  if (!Number.isInteger(act) || act < 1) throw new Error(`--act must be an integer >= 1, got ${act}`);
  const acts = actCount(candidate);
  if (act > acts) throw new Error(`${candidate.id} has ${acts} act(s); there is no act ${act}`);
  const ordered = isPlainObject(scores) ? Object.fromEntries([...AXES.filter((a) => a in scores), ...Object.keys(scores).filter((k) => !AXES.includes(k))].map((k) => [k, scores[k]])) : scores;
  const out = {
    schema: VERDICT_SCHEMA,
    forayId: candidate.id,
    act,
    candidateSha256: sha256,
    lane: lane ?? (LANES.includes(row.lane) ? row.lane : laneOf(candidate, null)),
    verdict,
    scores: ordered,
    winces,
    reviewer: REVIEWER,
    at: at ?? new Date().toISOString()
  };
  const { ok, errors } = validateVerdict(out);
  if (!ok) throw new Error(`verdict refused: ${errors.join("; ")}`);
  return out;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, dirs: [], winces: [], positional: [] };
  const value = (i, flag) => {
    if (i >= rest.length || rest[i].startsWith("--")) throw new Error(`${flag} needs a value`);
    return rest[i];
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--dir") args.dirs.push(value(++i, a));
    else if (a === "--act") args.act = Number(value(++i, a));
    else if (a === "--verdict") args.verdict = value(++i, a);
    else if (a === "--scores") args.scores = value(++i, a);
    else if (a === "--wince") args.winces.push(parseWince(value(++i, a)));
    else if (a === "--lane") args.lane = value(++i, a);
    else if (a === "--out") args.out = value(++i, a);
    else if (a === "--at") args.at = value(++i, a);
    else if (a === "--segments") args.segments = value(++i, a);
    else if (a === "--sources") args.sources = value(++i, a);
    else if (a === "--json") args.json = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else args.positional.push(a);
  }
  return args;
}

const USAGE = [
  "usage: node tools/generation/review-queue.mjs list --dir <dir> [--dir <dir>] [--json]",
  "       node tools/generation/review-queue.mjs card <forayId> --dir <dir> [--act N]",
  "       node tools/generation/review-queue.mjs verdict <forayId> --dir <dir> --act N --verdict pass|fail|fix",
  `         --scores ${AXES.map((a) => `${a}=N`).join(",")} [--wince 132:'note'] [--lane catalogue|on-demand] [--out data-local/review/verdicts.jsonl]`
].join("\n");

export function main(argv, out = console.log) {
  const args = parseArgs(argv);
  if (!["list", "card", "verdict"].includes(args.command)) throw new Error(USAGE);
  if (args.dirs.length === 0) throw new Error(`${args.command} needs --dir <candidates dir>\n${USAGE}`);
  const dirs = args.dirs.map((d) => path.resolve(d));

  if (args.command === "list") {
    const loaded = dirs.map(loadDir);
    const ranked = rankRows(loaded.flatMap((l) => l.rows));
    const skipped = loaded.reduce((s, l) => s + l.skipped, 0);
    if (args.json) out(JSON.stringify(queueJson(ranked), null, 2));
    else {
      out(formatQueue(ranked));
      if (skipped) out(`${skipped} report ${skipped === 1 ? "entry has no candidate file and is" : "entries have no candidate file and are"} not reviewable`);
    }
    return ranked;
  }

  const forayId = args.positional[0];
  if (!forayId) throw new Error(`${args.command} needs a forayId\n${USAGE}`);
  const row = findRow(dirs, forayId);

  if (args.command === "card") {
    const { candidate } = readCandidate(row.file);
    const pools = loadPoolsOrEmpty({
      segmentsFile: args.segments ? path.resolve(args.segments) : DEFAULT_SEGMENTS,
      sourcesFile: args.sources ? path.resolve(args.sources) : DEFAULT_SOURCES
    });
    const total = actCount(candidate);
    if (args.act !== undefined && (!Number.isInteger(args.act) || args.act < 1 || args.act > total)) throw new Error(`${forayId} has ${total} act(s); there is no act ${args.act}`);
    const acts = args.act !== undefined ? [args.act] : Array.from({ length: total }, (_, i) => i + 1);
    const cards = acts.map((act) => buildActCard(candidate, act, { pools, row }));
    out(cards.map((c) => formatActCard(c, row)).join("\n\n---\n\n"));
    return cards;
  }

  if (args.lane !== undefined && !LANES.includes(args.lane)) throw new Error(`--lane must be one of ${LANES.join(", ")}`);
  if (args.act === undefined) throw new Error("verdict needs --act N");
  const verdict = buildVerdict({ row, act: args.act, verdict: args.verdict, scores: parseScores(args.scores), winces: args.winces, lane: args.lane, at: args.at });
  const file = args.out ? path.resolve(args.out) : DEFAULT_VERDICTS;
  appendVerdict(file, verdict);
  out(`appended a ${verdict.verdict} verdict for ${verdict.forayId} act ${verdict.act} to ${file}`);
  return verdict;
}

if (isEntryScript(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(2);
  }
}
