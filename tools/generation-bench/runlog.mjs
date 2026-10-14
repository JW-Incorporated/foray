/* GV-17 (docs/roadmap/generation-v2.md, from W1-04) — the runlog reader.
 *
 * WHAT IT IS FOR
 * Every generation attempt writes one `runlog/1` JSONL file beside its
 * report (`runlogs/<checkpointKey>.<attempt>.runlog.jsonl`, GV-01), and every
 * model request in it is a CallRecord (GV-07). Nobody read those files. This
 * module turns one into the per-call speed scorecard the Baseline doc says is
 * not measured: tokens by stage (MT-05), calls in series (MT-06), repeat work
 * (MT-07), queue, TTFT and cache share (MT-04), prose decode rate (MT-12),
 * code time (MT-08), render rate (MT-09) and unit spend (MT-10).
 *
 * It lives in tools/ so it can change without the founder label; the backend
 * pins the emitter to it (backend/test/runLogBenchParity.test.ts feeds a real
 * RunLog's toJsonl() through summarizeRunLog and checks the counts).
 *
 * THE RULE IT INHERITS FROM run.mjs: A FIELD NOBODY MEASURED IS NULL, NEVER 0.
 * A CallRecord carries `null` for every number its provider could not know
 * (Anthropic reports no queue time and no TTFT on a non-streamed call). A p50,
 * a share or a rate over records that carry none of the field is null, and a
 * sum over them is null; a sum skips a record whose field is null rather than
 * adding 0 for it. A measured zero (a log with no reask) stays 0.
 *
 * Pure: no network, no model, nothing written.
 */

import fs from "node:fs";

export const RUNLOG_SCHEMA = "runlog/1";

/** Every event kind runLog.ts declares (GV-01). The parity test asserts that
 * every kind a real run emits is one of these, so a new kind on the TS side
 * cannot be silently ignored here. */
export const EVENT_KINDS = Object.freeze(["stage", "call", "parse", "code", "ready", "render", "meter"]);

/** The CallRecord fields this reader uses. The parity test asserts each one is
 * present on every record a real run emits, which pins the TS emitter and this
 * reader to one schema: a rename on either side fails there, not in a bench
 * that would quietly read every renamed field as absent. */
export const CALL_FIELDS = Object.freeze([
  "stage",
  "act",
  "attempt",
  "role",
  "reask",
  "startMs",
  "endMs",
  "ms",
  "queueMs",
  "ttftMs",
  "promptTokens",
  "cachedTokens",
  "outputTokens",
  "outputBudget",
  "overBudget"
]);

/** The key a call with no stage context is filed under. */
export const UNSTAGED = "(none)";

/** The MT-10 unit the bench's `spark_s` column reads (GV-90's MeterUnit). */
export const SPARK_UNIT = "sparkSeconds";

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * `runlog/1` text -> `{ header, events }`. The first non-blank line must be
 * the `{schema: "runlog/1", t0Iso}` header: a file without it is not a runlog
 * (or is one of a schema this reader does not know) and is refused rather than
 * summarised as an empty run. A line that is not JSON throws, naming its line
 * number.
 */
export function parseRunLog(text, label = "runlog") {
  const lines = String(text).split(/\r?\n/);
  let header = null;
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new Error(`${label}: line ${i + 1} is not JSON (${err.message})`);
    }
    if (header === null) {
      if (!obj || obj.schema !== RUNLOG_SCHEMA) {
        throw new Error(`${label}: no ${RUNLOG_SCHEMA} header (first line is ${line.slice(0, 80)})`);
      }
      header = obj;
      continue;
    }
    events.push(obj);
  }
  if (header === null) throw new Error(`${label}: empty file, no ${RUNLOG_SCHEMA} header`);
  return { header, events };
}

/** A runlog file -> `{ header, events }` (see parseRunLog). */
export function readRunLog(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  return parseRunLog(text, file);
}

/* ------------------------------------------------------------------ */
/* Small numeric helpers (rule 1 lives here)                           */
/* ------------------------------------------------------------------ */

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Sum of the finite values; null when there are none (nobody measured it). */
function sumOrNull(values) {
  let total = null;
  for (const v of values) {
    const n = num(v);
    if (n !== null) total = (total ?? 0) + n;
  }
  return total;
}

/** The median of the finite values (the mean of the two middle ones for an
 * even count); null when there are none. */
export function p50(values) {
  const xs = values.map(num).filter((v) => v !== null).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/* ------------------------------------------------------------------ */
/* MT-06 · calls in series                                             */
/* ------------------------------------------------------------------ */

/**
 * The length of the longest chain of calls in which each call starts at or
 * after the previous one ended. Calls that overlap are parallel and add one
 * link, not several. Sorted by startMs, then an O(n^2) DP: depth[i] is one
 * more than the deepest earlier call that ended by the time call i started.
 * GV-123's criticalPath.serialCallChain computes the same quantity; its suite
 * asserts the two agree on fixtures/runlog-synth.
 */
export function seriesDepth(calls) {
  const xs = calls
    .filter((c) => num(c.startMs) !== null && num(c.endMs) !== null)
    .slice()
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const depth = new Array(xs.length).fill(1);
  let best = 0;
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < i; j++) {
      if (xs[j].endMs <= xs[i].startMs && depth[j] + 1 > depth[i]) depth[i] = depth[j] + 1;
    }
    if (depth[i] > best) best = depth[i];
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* MT-12 · decode rate                                                 */
/* ------------------------------------------------------------------ */

/**
 * The output rate of a set of calls, in two NEVER-MIXED readings:
 *   proseTokPerSec — output tokens over decode time (ms - ttftMs), over the
 *     calls that report a TTFT. This is the model's decode rate.
 *   e2eTokPerSec — output tokens over the whole call time, over the calls
 *     that do NOT report a TTFT. It includes queue and prefill, so it is
 *     labelled end-to-end and is never folded into the decode rate.
 * Each is null when no call qualifies (or its time sums to zero).
 */
export function tokRates(calls) {
  let proseTok = 0;
  let proseMs = 0;
  let proseN = 0;
  let e2eTok = 0;
  let e2eMs = 0;
  let e2eN = 0;
  for (const c of calls) {
    const out = num(c.outputTokens);
    const ms = num(c.ms);
    if (out === null || ms === null) continue;
    const ttft = num(c.ttftMs);
    if (ttft !== null) {
      proseTok += out;
      proseMs += ms - ttft;
      proseN += 1;
    } else {
      e2eTok += out;
      e2eMs += ms;
      e2eN += 1;
    }
  }
  return {
    proseTokPerSec: proseN > 0 && proseMs > 0 ? proseTok / (proseMs / 1000) : null,
    e2eTokPerSec: e2eN > 0 && e2eMs > 0 ? e2eTok / (e2eMs / 1000) : null
  };
}

/* ------------------------------------------------------------------ */
/* The summary                                                         */
/* ------------------------------------------------------------------ */

const isKind = (kind) => (e) => e && e.kind === kind;

/**
 * One runlog's events -> the speed scorecard.
 *
 *   calls, callsByStage          — how many CallRecords, overall and per stage
 *   perStage[stage]              — {calls, promptTokens, cachedTokens,
 *                                  outputTokens, outputBudget, overBudget, ms,
 *                                  p50CallMs, proseTokPerSec, e2eTokPerSec}
 *   promptTokens, cachedTokens   — sums (null when no record carries them)
 *   outputTokens, outputTokensByStage                                 (MT-05)
 *   seriesDepth, seriesBeforeFirstReady                               (MT-06)
 *   repeatWork {jsonReasks, spineReasks, extraRounds, continuations,
 *               parseFailures}                                        (MT-07)
 *   queueP50Ms, ttftP50Ms, cachedShare                                (MT-04)
 *   prose {tokPerSec, basis: "ttft"|"e2e"} over the writer's calls    (MT-12)
 *   codeMsByStage, codeMs                                             (MT-08)
 *                                — exclusive code time: the sum of each code
 *                                  aggregate's selfMs (totalMs on a runlog
 *                                  that predates selfMs), never the nested
 *                                  inclusive totals
 *   renderRealtime, firstRenderMs                                     (MT-09)
 *   unitSpend {unit: amount}, unitReserved {unit: amount}             (MT-10)
 */
export function summarizeRunLog(events) {
  const list = Array.isArray(events) ? events : [];
  const calls = list.filter(isKind("call"));

  /* Per stage. */
  const byStage = new Map();
  for (const c of calls) {
    const key = typeof c.stage === "string" && c.stage !== "" ? c.stage : UNSTAGED;
    if (!byStage.has(key)) byStage.set(key, []);
    byStage.get(key).push(c);
  }
  const perStage = {};
  const callsByStage = {};
  const outputTokensByStage = {};
  for (const [stage, group] of byStage) {
    const overFlags = group.map((c) => c.overBudget).filter((v) => typeof v === "boolean");
    perStage[stage] = {
      calls: group.length,
      promptTokens: sumOrNull(group.map((c) => c.promptTokens)),
      cachedTokens: sumOrNull(group.map((c) => c.cachedTokens)),
      outputTokens: sumOrNull(group.map((c) => c.outputTokens)),
      outputBudget: sumOrNull(group.map((c) => c.outputBudget)),
      /* How many calls went over their budget; null when no call says. */
      overBudget: overFlags.length > 0 ? overFlags.filter(Boolean).length : null,
      ms: sumOrNull(group.map((c) => c.ms)) ?? 0,
      p50CallMs: p50(group.map((c) => c.ms)),
      ...tokRates(group)
    };
    callsByStage[stage] = group.length;
    outputTokensByStage[stage] = perStage[stage].outputTokens;
  }

  /* MT-06: the serial chain, overall and up to the first playable moment. */
  const ready = list.filter(isKind("ready")).map((e) => num(e.readyMs)).filter((v) => v !== null);
  const firstReadyMs = ready.length > 0 ? Math.min(...ready) : null;

  /* MT-07: repeat work. A JSON re-ask, a spine re-ask (structural or
     seed-floor) and a continuation are each one extra request, told apart by
     the `reask` context the backend sets (parseWithRetry, buildSpine,
     postSeedSpine, anthropicCall). An extra round is a WRITER request on a
     round after the first (writeAct's `attempt` is 1-based) that is not
     itself a re-ask, so one request is never counted twice. */
  const repeatWork = {
    jsonReasks: calls.filter((c) => c.reask === "json").length,
    spineReasks: calls.filter((c) => c.reask === "structural" || c.reask === "seed-floor").length,
    extraRounds: calls.filter((c) => c.role === "writer" && num(c.attempt) !== null && c.attempt > 1 && (c.reask === null || c.reask === undefined)).length,
    continuations: calls.filter((c) => c.reask === "continuation").length,
    parseFailures: list.filter(isKind("parse")).filter((e) => e.ok === false).length
  };

  /* MT-04: cache share over the records that carry BOTH counts. */
  let cachedNum = 0;
  let cachedDen = 0;
  let cachedN = 0;
  for (const c of calls) {
    const cached = num(c.cachedTokens);
    const prompt = num(c.promptTokens);
    if (cached === null || prompt === null) continue;
    cachedNum += cached;
    cachedDen += prompt;
    cachedN += 1;
  }

  /* MT-12: the writer's prose. The decode rate when the writer's calls report
     a TTFT, else the end-to-end rate, labelled as such. */
  const writerRates = tokRates(calls.filter((c) => c.role === "writer"));
  const prose =
    writerRates.proseTokPerSec !== null
      ? { tokPerSec: writerRates.proseTokPerSec, basis: "ttft" }
      : writerRates.e2eTokPerSec !== null
        ? { tokPerSec: writerRates.e2eTokPerSec, basis: "e2e" }
        : { tokPerSec: null, basis: null };

  /* MT-08: code time per stage, as the sum of each aggregate's EXCLUSIVE
     time. Code spans nest (sourcing.all > sourcing.tier2 > index.search >
     index.load > transcript.read) and `totalMs` is inclusive, so summing it
     would count nested time once per level. `selfMs` (the span's time minus
     its direct children's, backend codeSpans.ts) sums without overlap. A
     runlog written before selfMs existed falls back to `totalMs`. */
  const code = list.filter(isKind("code"));
  const codeMsByStage = {};
  for (const e of code) {
    const ms = num(e.selfMs) ?? num(e.totalMs);
    if (ms === null) continue;
    const key = typeof e.stage === "string" && e.stage !== "" ? e.stage : UNSTAGED;
    codeMsByStage[key] = (codeMsByStage[key] ?? 0) + ms;
  }
  const codeMs = Object.keys(codeMsByStage).length > 0 ? Object.values(codeMsByStage).reduce((a, b) => a + b, 0) : null;

  /* MT-09: seconds of audio per second of rendering, over every render. */
  const renders = list.filter(isKind("render")).filter((e) => num(e.audioSec) !== null && num(e.ms) !== null);
  const renderMs = renders.reduce((s, e) => s + e.ms, 0);
  const renderAudioSec = renders.reduce((s, e) => s + e.audioSec, 0);

  /* MT-10: spend per unit. A reservation (reserved: true) is a hold, not a
     spend; the reconciled amount (reserved: false) is what was charged. */
  const unitSpend = {};
  const unitReserved = {};
  for (const e of list.filter(isKind("meter"))) {
    const amount = num(e.amount);
    if (amount === null || typeof e.unit !== "string") continue;
    const into = e.reserved === true ? unitReserved : unitSpend;
    into[e.unit] = (into[e.unit] ?? 0) + amount;
  }

  return {
    calls: calls.length,
    callsByStage,
    perStage,
    promptTokens: sumOrNull(calls.map((c) => c.promptTokens)),
    cachedTokens: sumOrNull(calls.map((c) => c.cachedTokens)),
    outputTokens: sumOrNull(calls.map((c) => c.outputTokens)),
    outputTokensByStage,
    seriesDepth: seriesDepth(calls),
    seriesBeforeFirstReady: firstReadyMs === null ? null : seriesDepth(calls.filter((c) => num(c.endMs) !== null && c.endMs <= firstReadyMs)),
    repeatWork,
    queueP50Ms: p50(calls.map((c) => c.queueMs)),
    ttftP50Ms: p50(calls.map((c) => c.ttftMs)),
    cachedShare: cachedN > 0 && cachedDen > 0 ? cachedNum / cachedDen : null,
    prose,
    codeMsByStage,
    codeMs,
    renderRealtime: renders.length > 0 && renderMs > 0 ? renderAudioSec / (renderMs / 1000) : null,
    firstRenderMs: renders.length > 0 ? renders[0].ms : null,
    unitSpend,
    unitReserved
  };
}

/** Total repeat-work requests (the bench's `reasks` column): every request
 * that only exists because an earlier one was not good enough. Parse failures
 * are not requests and are not counted here. */
export function repeatRequests(repeatWork) {
  if (!repeatWork) return null;
  return repeatWork.jsonReasks + repeatWork.spineReasks + repeatWork.extraRounds + repeatWork.continuations;
}
