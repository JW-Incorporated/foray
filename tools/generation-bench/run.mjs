/* G-42a — the benchmark harness over generation reports.
 *
 * WHAT IT IS FOR (docs/curation/foray-to-spec-roadmap.md §10, card G-42a)
 * Every number in the roadmap's §1.2 acceptance table is supposed to come off
 * `report.json` — the file `backend/src/cli/generateForays.ts` writes at the
 * end of a run. Until now nobody read those files mechanically: the run ledger
 * (`docs/curation/generation-run-2026-09-09.md`) carries the numbers in prose,
 * typed by hand from a run log, and the roadmap quotes the prose. This file is
 * the reader. Point it at one or many `report.json` files and it prints one row
 * per generated Foray with the columns §1.2 and the listening deck (Q-01…Q-05)
 * grade a run against, plus one machine-readable JSON line per row so G-42b
 * (the scheduled CI job, blocked on D11) can diff two runs later without
 * re-parsing a table meant for a person.
 *
 * THE FIVE RULES THIS FILE IS BUILT AROUND
 *
 * 1. A FIELD THE REPORT DOES NOT CARRY IS ABSENT, NEVER ZERO. Reports grew
 *    field by field across runs 4–9: run 4's row has no `calls`, runs 4–8 have
 *    no `narrationPagesPerSeam` (Q-05 added it on 2026-09-12), no report yet
 *    written carries `seedLostBeats` (F-99 landed after run 9) and none has
 *    ever carried a dollar figure. `?? 0` on any of those would publish a
 *    fabricated KPI — "0 seed-lost beats" reads as a clean run and means "we
 *    did not measure". Absent prints `—` and serialises as `null` beside a
 *    `sources` entry saying `absent`.
 *
 * 2. A TARGET IS NAMED ONLY WHERE IT IS SETTLED. §1.2 marks several targets
 *    *proposed* — they wait on founder decision D0 — and the harness must not
 *    launder a proposal into a pass/fail. `TARGET_PROPOSED` columns print their
 *    number with a `?` and the legend says "proposed, D0"; `TARGET_SETTLED`
 *    columns print theirs plain. Nothing here emits a verdict either way: the
 *    card asks for "a trend with a tolerance band rather than a hard
 *    pass/fail — LLM runs are non-deterministic and a hard gate would be flaky
 *    by construction". Grading is G-42b's, past a band, past D0.
 *
 * 3. TWO DIFFERENT NUMBERS ARE BOTH CALLED "TAPE SHARE", SO BOTH ARE PRINTED —
 *    AND ONLY ONE OF THEM IS THE ROADMAP'S ROW (F-101).
 *    `meta.veracity.tapeOfTapePlusNarration` (Q-05, `computeListeningShares`;
 *    `tapeShare` on runs 4–9, before F-101 put the denominator in the name) is
 *    tape seconds over tape + narration seconds, estimated at write time. The
 *    roadmap's "59–61 % (runs 5–7), 78 % (run 8) [measured on
 *    `data/forays.json` @ #642]" is a different quantity: tape seconds over the
 *    candidate's whole `runtimeSec`, which also counts jingles and the band the
 *    player actually plays. On run 9 they read 0.684 and 0.557 — thirteen
 *    points apart. Collapsing them would make the trend line jump the day the
 *    report started carrying its own. So `tape_share` is the report's,
 *    `tape_of_runtime` is the candidate's, the legend says which is which, and
 *    §1.2's *proposed* ≥ 70 % target — whose row is titled "Tape share OF
 *    RUNTIME" and whose history is the candidate's quantity — is attached to
 *    `tape_of_runtime`, not to the flattering one it used to sit on.
 *
 * 4. CLIP LENGTHS COME FROM THE CANDIDATE, NOT THE REPORT. No report field
 *    holds a clip duration; the deck's "10 clips, mean 107 s, max 188 s" was
 *    measured on the candidate Foray the run wrote. So when the candidate JSON
 *    sits next to the report (`entry.file`'s basename in the report's own
 *    directory, or `--candidates <dir>`), the harness resolves each `segment`
 *    item's duration — from the candidate's own minted `segments[]` first, then
 *    from the committed pool `data/segments.json` for tier-1 rows the candidate
 *    does not restate — and reports how many of the clips it could measure. No
 *    candidate, no clip columns. A partially resolved set prints with a `*`.
 *
 * 5. A RATE WHOSE UNIT CHANGED MID-TREND GETS A COLUMN PER UNIT (F-101).
 *    `firstAttemptPassRate` meant "share of kept PAGES accepted on the writer's
 *    first try" for runs 4–8 and "share of narration BEATS the verifier
 *    confirmed on round 1" from run 9, and which one you got was decided by
 *    sniffing the candidate. Run 9's 0.048 is not run 8's 0.68 measured worse;
 *    it is a different measurement. Reports from F-101 on carry
 *    `firstAttemptPassRatePages`, `firstAttemptPassRateBeats` and
 *    `firstAttemptUnit`, and this harness prints `1stPg` and `1stBt` from them.
 *    A report that carries only the old scalar prints it in `1stPass?` — the
 *    `?` is the unit, not a target — and rule 1 applies: it is NOT guessed into
 *    one of the two declared columns.
 *
 * USAGE
 *   node tools/generation-bench/run.mjs <report.json|dir> [...]   # table + jsonl
 *   node tools/generation-bench/run.mjs --format table  out-8/ out-9/
 *   node tools/generation-bench/run.mjs --format jsonl  out-4 out-5 ... > baseline.jsonl
 *   node tools/generation-bench/run.mjs --append docs/curation/generation-kpis.md out-9/
 *   node tools/generation-bench/run.mjs --candidates <dir> --segments <segments.json>
 *
 * A directory argument is read as `<dir>/report.json`. The run id is the
 * directory's name with a leading `out-` rewritten to `run-` (the generation
 * host writes `relay/run/out-9/report.json`), or `--run-id` when given.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not run the pipeline, spend a model call, or price a run. Cost is a
 * column because §1.2 has a cost row; it is empty on every report written so
 * far because `ReportEntry` has no `usage` block, and the honest reading of
 * "≈ $1–4 per attempt [estimated]" is that nobody has measured it. The day a
 * keyed run records `usage.costUsd`, the column fills itself.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/* ------------------------------------------------------------------ */
/* Columns                                                             */
/* ------------------------------------------------------------------ */

/** A target that D0 has NOT confirmed. Printed with `?`, never graded. */
export const PROPOSED = "proposed";
/** A target the fix plan or the shipped gate already fixes. */
export const SETTLED = "settled";

/**
 * The table, in print order. Each column says where its number comes from
 * (`from`), so the JSONL can carry provenance per cell and the PR body can say
 * which figures are a report's and which a candidate's.
 *
 *   from: "report"     — a field on the report row or its `meta.veracity`
 *   from: "candidate"  — measured on the candidate Foray beside the report
 *   from: "derived"    — computed from report fields only (e.g. ms -> minutes)
 *
 * `target` is `null` where §1.2 names none. Where it names one, `targetState`
 * is SETTLED or PROPOSED and `targetNote` cites the row or the code that fixes
 * it. Nothing in this file compares a value to a target.
 */
export const COLUMNS = [
  { key: "run", header: "run", from: "derived", width: 7, kind: "text" },
  { key: "outcome", header: "outcome", from: "report", width: 9, kind: "text" },
  /* `outcome` is NOT the same question as "did this run produce a Foray".
     Run 5's row reads `outcome: "generated"` with `detail: "INVALID … D5 FAIL
     …"`: the pipeline generated a candidate and `check-forays` refused it.
     `generateForays.ts` counts its own publishable runs by the `detail`
     prefix (`report.filter(r => r.detail.startsWith("OK "))`), so this column
     asks the driver's own question rather than inventing a second one. */
  { key: "valid", header: "valid", from: "derived", width: 5, kind: "text" },
  {
    key: "wall_min",
    header: "wall m",
    from: "derived",
    width: 6,
    kind: "number",
    digits: 1,
    target: 6,
    targetState: PROPOSED,
    targetNote: "§1.2 prompt -> finished Foray, <= 6 min p50 keyed (proposed, D0)"
  },
  {
    key: "ttl_a1_min",
    header: "ttlA1 m",
    from: "derived",
    width: 7,
    kind: "number",
    digits: 1,
    target: 0.5,
    targetState: SETTLED,
    targetNote: "§1.2 prompt -> act 1 playable, <= 30 s p50 (fix plan WS-D; D6 re-baseline pending)"
  },
  { key: "calls", header: "calls", from: "report", width: 5, kind: "number", digits: 0 },
  {
    key: "tape_share",
    header: "tapeSh",
    from: "report",
    width: 6,
    kind: "number",
    digits: 3,
    targetNote:
      "report's Q-05 tape/(tape+narration) (`tapeOfTapePlusNarration`, `tapeShare` before F-101). NOT §1.2's row — that is tape/rt"
  },
  {
    key: "tape_of_runtime",
    header: "tape/rt",
    from: "candidate",
    width: 7,
    kind: "number",
    digits: 3,
    target: 0.7,
    targetState: PROPOSED,
    targetNote:
      "§1.2 tape share OF RUNTIME, >= 70 % (proposed, D0) — the roadmap's own 59-61 %/78 % reading: tape seconds over the candidate's runtimeSec"
  },
  { key: "clips", header: "clips", from: "candidate", width: 5, kind: "number", digits: 0 },
  {
    key: "clip_mean_s",
    header: "clip mean",
    from: "candidate",
    width: 9,
    kind: "number",
    digits: 1,
    targetNote: "Q-01 cuts clips to a thought, 60-1,800 s; no §1.2 target"
  },
  { key: "clip_max_s", header: "clip max", from: "candidate", width: 8, kind: "number", digits: 1 },
  {
    key: "pages_per_seam",
    header: "pg/seam",
    from: "report",
    width: 7,
    kind: "number",
    digits: 2,
    target: 1,
    targetState: PROPOSED,
    targetNote: "§1.2 narration <= 1 page per seam (proposed, D0)"
  },
  {
    key: "narration_share",
    header: "narrSh",
    from: "report",
    width: 6,
    kind: "number",
    digits: 3,
    target: 0.25,
    targetState: PROPOSED,
    targetNote: "§1.2 narration <= 25 % of runtime (proposed, D0)"
  },
  {
    key: "first_pass_pages",
    header: "1stPg",
    from: "report",
    width: 5,
    kind: "number",
    digits: 2,
    target: 0.8,
    targetState: SETTLED,
    targetNote: "§1.2 first-attempt PAGE pass rate >= 80 % — kept pages accepted on the writer's first try"
  },
  {
    key: "first_pass_beats",
    header: "1stBt",
    from: "report",
    width: 5,
    kind: "number",
    digits: 2,
    targetNote: "Q-03's per-act reading: narration BEATS the verifier confirmed on round 1. Not comparable to 1stPg"
  },
  {
    key: "first_pass",
    header: "1stPass?",
    from: "report",
    width: 8,
    kind: "number",
    digits: 2,
    targetNote:
      "runs 4-9: the old single `firstAttemptPassRate`, unit UNDECLARED (4-8 pages, 9 beats). Never folded into the two columns above (F-101)"
  },
  {
    key: "unverified",
    header: "unver",
    from: "report",
    width: 5,
    kind: "number",
    digits: 0,
    target: 0,
    targetState: SETTLED,
    targetNote: "F-51: any page kept `verified: false` refuses publish (evaluateVeracityGate)"
  },
  { key: "synth_verified", header: "synth", from: "report", width: 5, kind: "number", digits: 0 },
  { key: "seed_lost", header: "seedLost", from: "report", width: 8, kind: "number", digits: 0 },
  {
    key: "intro_restates",
    header: "introRe",
    from: "report",
    width: 7,
    kind: "number",
    digits: 0,
    target: 0,
    targetState: SETTLED,
    targetNote: "Q-02: a page before a clip may not repeat its first sentences; the writer is refused for it"
  },
  {
    key: "calls_per_beat",
    header: "call/bt",
    from: "report",
    width: 7,
    kind: "number",
    digits: 2,
    target: 1.5,
    targetState: SETTLED,
    targetNote: "§1.2 narration calls per beat <= 1.5"
  },
  {
    key: "tokens",
    header: "tokens",
    from: "report",
    width: 7,
    kind: "number",
    digits: 0,
    target: 50000,
    targetState: SETTLED,
    targetNote: "§1.2 pipeline tokens <= 50 k for 3 acts (D6 re-baseline pending)"
  },
  {
    key: "cost_usd",
    header: "cost $",
    from: "report",
    width: 6,
    kind: "number",
    digits: 2,
    target: 10,
    targetState: PROPOSED,
    targetNote: "§1.2 cost per Foray inside EPISODE_BUDGET_USD $10 (proposed, D0); no report carries `usage` yet"
  }
];

/** What an absent cell prints as. Never `0`, never an empty string — a blank
 * column in a trend table reads as "nothing happened" rather than "nobody
 * measured", which is the confusion rule 1 exists to prevent. */
export const ABSENT = "—";

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** JSON or a thrown error naming the file — a bench that silently skips an
 * unreadable report under-reports the fleet and looks healthy doing it. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
}

/** `<dir>` -> `<dir>/report.json`; a file path is taken as given. */
export function resolveReportPath(target) {
  const abs = path.resolve(target);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return path.join(abs, "report.json");
  return abs;
}

/** `.../out-9/report.json` -> `run-9`. The generation host names its output
 * directories `out-N` and the deck calls the same thing "run N"; keeping the
 * mapping here means the ledger, the roadmap and the baseline all say `run-9`.
 * A directory that is not `out-*` keeps its own name. */
export function runIdFor(reportPath) {
  const dir = path.basename(path.dirname(path.resolve(reportPath)));
  return /^out-/.test(dir) ? `run-${dir.slice(4)}` : dir;
}

/** A number, or null. Anything that is not a finite number — undefined, null,
 * a string, NaN — is ABSENT. This is rule 1's single choke point: no caller
 * defaults, no caller coerces. */
export function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Milliseconds to minutes, or null when there were no milliseconds. A run
 * that never recorded `ttlA1Ms` did not take 0 minutes to a playable act 1. */
export function minutes(ms) {
  const v = num(ms);
  return v === null ? null : v / 60000;
}

/* ------------------------------------------------------------------ */
/* The candidate Foray beside the report                               */
/* ------------------------------------------------------------------ */

/**
 * Where the candidate JSON for this entry is, if it is anywhere we can read.
 *
 * `entry.file` is an ABSOLUTE path on the machine that generated it — a temp
 * directory under the operator's profile — so it is nearly always wrong
 * anywhere else, and following it would read a stale file on the one machine
 * where it happens to resolve. Only its BASENAME is used, looked for in the
 * directory that holds the report (or `candidatesDir`). Null when there is no
 * `file` on the row (every non-`generated` outcome) or the file is not there.
 */
export function candidatePathFor(entry, reportPath, candidatesDir = null) {
  if (!entry || typeof entry.file !== "string" || entry.file.trim() === "") return null;
  const base = entry.file.replace(/\\/g, "/").split("/").pop();
  if (!base) return null;
  const dir = candidatesDir ? path.resolve(candidatesDir) : path.dirname(path.resolve(reportPath));
  const guess = path.join(dir, base);
  return fs.existsSync(guess) ? guess : null;
}

/** The committed segment pool, keyed by id, or an empty map when the file is
 * not there (a checkout without `data/`, or `--segments` pointed elsewhere). */
export function loadSegmentPool(file) {
  if (!file || !fs.existsSync(file)) return new Map();
  const doc = readJson(file);
  const rows = Array.isArray(doc) ? doc : doc.segments || [];
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Clip statistics for one candidate Foray.
 *
 * Every `type: "segment"` item is a clip the listener hears. Its duration
 * lives in one of two places and the order matters: the candidate's own
 * `segments[]` holds the rows THIS run minted (camelCase `startSec`/`endSec`,
 * the generator's shape), and `data/segments.json` holds the tier-1 pool rows
 * it merely pointed at (snake_case `start_sec`/`end_sec`, the committed data
 * shape). A run that reused a pool row does not restate it, so reading only
 * the candidate loses 3 of run 7's 10 clips and 4 of run 9's.
 *
 * `measured` says how many of `count` resolved. Callers print mean/max with a
 * `*` when it is short: a mean over 6 of 10 clips is a real measurement of a
 * subset, not the run's mean, and the difference has to be visible.
 */
export function clipStats(candidate, pool = new Map()) {
  const minted = new Map();
  for (const row of candidate.segments || []) {
    const start = num(row.startSec);
    const end = num(row.endSec);
    if (start !== null && end !== null) minted.set(row.id, end - start);
  }
  const items = (candidate.items || []).filter((item) => item && item.type === "segment");
  const durations = [];
  for (const item of items) {
    if (minted.has(item.segment_id)) {
      durations.push(minted.get(item.segment_id));
      continue;
    }
    const row = pool.get(item.segment_id);
    const start = row ? num(row.start_sec) : null;
    const end = row ? num(row.end_sec) : null;
    if (start !== null && end !== null) durations.push(end - start);
  }
  const tapeSec = durations.reduce((sum, d) => sum + d, 0);
  const runtimeSec = num(candidate.runtimeSec);
  return {
    count: items.length,
    measured: durations.length,
    meanSec: durations.length ? tapeSec / durations.length : null,
    maxSec: durations.length ? Math.max(...durations) : null,
    tapeSec: durations.length ? tapeSec : null,
    runtimeSec,
    /* Absent — not 0 — when no clip resolved or the candidate has no runtime:
       a Foray with unmeasurable tape has an unknown tape share, not none. */
    tapeOfRuntime: durations.length && runtimeSec ? tapeSec / runtimeSec : null
  };
}

/**
 * The dollar figure, if any report field ever holds one.
 *
 * `ReportEntry` has no `usage` block today (`backend/src/cli/generateForays.ts`
 * counts tokens and calls, not money; `TokenUsageTotals` has no price), so this
 * returns null on every report written so far and the column prints `—`. The
 * three shapes it accepts are the ones a future keyed run could plausibly
 * write. It NEVER multiplies tokens by a list price: §1.2's "[estimated] ≈
 * $1–4 per attempt" is an estimate precisely because nobody has measured it,
 * and a harness that quietly turned the estimate into a measurement would
 * close D0's cost row with arithmetic instead of a run.
 */
export function costUsdFor(entry, report) {
  return (
    num(entry?.usage?.costUsd) ??
    num(entry?.costUsd) ??
    num(report?.usage?.costUsd) ??
    null
  );
}

/* ------------------------------------------------------------------ */
/* One row                                                             */
/* ------------------------------------------------------------------ */

/**
 * One report entry -> one row: `{ values, sources }`, both keyed by column.
 * `sources[key]` is the column's `from` when the cell has a number and
 * `"absent"` when it does not, so a consumer never has to guess whether a
 * `null` means "the run did not do it" or "the file did not say".
 */
export function rowFor(entry, context = {}) {
  const { report = {}, runId = "run", clips = null } = context;
  const v = entry.veracity || {};
  const values = {
    run: runId,
    outcome: typeof entry.outcome === "string" ? entry.outcome : null,
    valid: typeof entry.detail === "string" ? (entry.detail.startsWith("OK ") ? "yes" : "no") : null,
    wall_min: minutes(entry.ms),
    ttl_a1_min: minutes(entry.ttlA1Ms),
    calls: num(entry.calls),
    /* F-101 put the denominator in the name; runs 4–9 carry the old one. The
       two are the same quantity, so reading either is a rename, not a guess. */
    tape_share: num(v.tapeOfTapePlusNarration) ?? num(v.tapeShare),
    tape_of_runtime: clips ? clips.tapeOfRuntime : null,
    clips: clips ? clips.count : null,
    clip_mean_s: clips ? clips.meanSec : null,
    clip_max_s: clips ? clips.maxSec : null,
    pages_per_seam: num(v.narrationPagesPerSeam),
    narration_share: num(v.narrationOfTapePlusNarration) ?? num(v.narrationShare),
    first_pass_pages: num(v.firstAttemptPassRatePages),
    first_pass_beats: num(v.firstAttemptPassRateBeats),
    /* Rule 1, applied to a UNIT rather than a value: a report that declares the
       two rates has said everything, so the undeclared column is absent for it.
       A report that carries only the old scalar keeps it here, in its own
       column, rather than being guessed into `1stPg` or `1stBt` — runs 4–8 are
       pages and run 9 is beats, and the report does not say which. */
    first_pass:
      v.firstAttemptPassRatePages === undefined && v.firstAttemptPassRateBeats === undefined ? num(v.firstAttemptPassRate) : null,
    unverified: num(v.unverifiedPages),
    synth_verified: num(v.synthesisVerifiedPages),
    seed_lost: num(v.seedLostBeats),
    intro_restates: num(v.introRestates),
    calls_per_beat: num(v.narrationCallsPerBeat),
    tokens: num(v.pipelineTokens),
    cost_usd: costUsdFor(entry, report)
  };
  const sources = {};
  for (const col of COLUMNS) {
    sources[col.key] = values[col.key] === null || values[col.key] === undefined ? "absent" : col.from;
  }
  return {
    values,
    sources,
    /* Context a diff wants that is not a graded column. */
    meta: {
      run: runId,
      generated_at: typeof report.generated_at === "string" ? report.generated_at : null,
      prompt: typeof entry.prompt === "string" ? entry.prompt : null,
      detail: typeof entry.detail === "string" ? entry.detail : null,
      clips_measured: clips ? clips.measured : null,
      candidate_read: Boolean(clips)
    }
  };
}

/** Every row a report yields — one per entry, in the report's own order. */
export function rowsForReport(reportPath, options = {}) {
  const report = readJson(reportPath);
  const runId = options.runId || runIdFor(reportPath);
  const entries = Array.isArray(report.entries) ? report.entries : [];
  const pool = options.pool || new Map();
  return entries.map((entry, index) => {
    const candidateFile = candidatePathFor(entry, reportPath, options.candidatesDir);
    const clips = candidateFile ? clipStats(readJson(candidateFile), pool) : null;
    const id = entries.length > 1 ? `${runId}#${index + 1}` : runId;
    return rowFor(entry, { report, runId: id, clips });
  });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** One cell. Absent is ABSENT; a partially measured clip figure carries `*`. */
export function formatCell(col, row) {
  const value = row.values[col.key];
  if (value === null || value === undefined) return ABSENT;
  if (col.kind === "text") return String(value);
  const partial =
    col.from === "candidate" &&
    col.key !== "clips" &&
    row.meta.clips_measured !== null &&
    row.meta.clips_measured < row.values.clips;
  return value.toFixed(col.digits) + (partial ? "*" : "");
}

/** The target cell of the legend: settled targets plain, proposed with `?`. */
export function targetLabel(col) {
  if (col.target === undefined || col.target === null) return "";
  const n = col.digits === 0 ? String(col.target) : col.target.toFixed(col.digits);
  return col.targetState === PROPOSED ? `${n}?` : n;
}

/** The human table: a header, one row per run, then the legend that says what
 * each column is, where it came from, and whether its target is settled. */
export function formatTable(rows) {
  const widths = COLUMNS.map((col) =>
    Math.max(col.header.length, col.width, ...rows.map((row) => formatCell(col, row).length))
  );
  const line = (cells) => cells.map((cell, i) => String(cell).padStart(widths[i])).join("  ");
  const out = [line(COLUMNS.map((c) => c.header)), line(widths.map((w) => "-".repeat(w)))];
  for (const row of rows) out.push(line(COLUMNS.map((col) => formatCell(col, row))));

  out.push("");
  out.push(`${ABSENT} = the report does not carry it (never read as zero).  * = measured over some of the clips, not all.`);
  out.push("targets: a bare number is SETTLED; a number with ? is PROPOSED and waits on founder decision D0.");
  out.push("");
  for (const col of COLUMNS) {
    const target = targetLabel(col);
    const note = col.targetNote || "";
    if (!target && !note) continue;
    out.push(`  ${col.header.padEnd(9)} ${(target || "no target").padEnd(10)} ${note}`);
  }
  return out.join("\n");
}

/** One machine line per row. Stable key order, no floats reformatted: G-42b
 * diffs these, and a renderer that rounded would invent movement. */
export function jsonlLine(row) {
  return JSON.stringify({
    run: row.values.run,
    generated_at: row.meta.generated_at,
    outcome: row.values.outcome,
    valid: row.values.valid,
    metrics: Object.fromEntries(COLUMNS.filter((c) => c.kind === "number").map((c) => [c.key, row.values[c.key]])),
    sources: row.sources,
    clips_measured: row.meta.clips_measured,
    candidate_read: row.meta.candidate_read,
    prompt: row.meta.prompt
  });
}

/**
 * The inverse of `jsonlLine`: a parsed baseline line back into the row shape
 * the renderers take.
 *
 * This is what makes the baseline a BASELINE rather than a log. G-42b compares
 * a fresh run against the committed `baseline.jsonl` without the archived
 * reports (they live on the generation host, not in the repo), and the KPI
 * doc's committed table has to be checkable against the same file — a
 * hand-edited cell in the markdown is exactly the drift a trend document
 * cannot survive. Round-tripping through here is how both are done.
 */
export function rowFromJsonl(line) {
  const obj = typeof line === "string" ? JSON.parse(line) : line;
  const values = { run: obj.run, outcome: obj.outcome ?? null, valid: obj.valid ?? null };
  for (const col of COLUMNS) {
    if (col.kind === "number") values[col.key] = num(obj.metrics?.[col.key]);
  }
  /* A baseline line written before a column existed carries no source for it,
     and rule 1 says the cell is ABSENT, not sourceless: the archived report did
     not carry the field, which is exactly what "absent" means. Filling it here
     rather than leaving the key off keeps a re-serialised baseline honest about
     every column the harness has today (F-101 added three). */
  const sources = { ...(obj.sources || {}) };
  for (const col of COLUMNS) {
    if (sources[col.key] === undefined) sources[col.key] = values[col.key] === null || values[col.key] === undefined ? "absent" : col.from;
  }
  return {
    values,
    sources,
    meta: {
      run: obj.run,
      generated_at: obj.generated_at ?? null,
      prompt: obj.prompt ?? null,
      detail: null,
      clips_measured: obj.clips_measured ?? null,
      candidate_read: Boolean(obj.candidate_read)
    }
  };
}

/* ------------------------------------------------------------------ */
/* Appending to the KPI doc                                            */
/* ------------------------------------------------------------------ */

export const ROWS_BEGIN = "<!-- bench:rows:begin -->";
export const ROWS_END = "<!-- bench:rows:end -->";

/** One markdown table row, `| run | … |`. */
export function markdownRow(row) {
  return `| ${COLUMNS.map((col) => formatCell(col, row)).join(" | ")} |`;
}

/** The two header lines the spliced rows sit under. The KPI doc commits these
 * verbatim above the begin marker, and the suite asserts the committed copy
 * equals this — so adding a column cannot silently shift every cell one place
 * left in a table nobody re-generates. */
export function markdownHeader() {
  return [`| ${COLUMNS.map((c) => c.header).join(" | ")} |`, `|${COLUMNS.map(() => "---").join("|")}|`];
}

/**
 * Splice rows into the block the KPI doc marks out, REPLACING any row whose
 * run id matches and appending the rest in run order.
 *
 * Replace-not-append is the point: a scheduled bench re-reading the same
 * archived report must not grow the table by a duplicate row every time it
 * runs, and a re-measurement of run 9 (a new candidate, a corrected pool) is
 * the same run, not a new one. Rows are sorted by the numeric suffix of the
 * run id where there is one, so `run-10` lands after `run-9` rather than
 * between `run-1` and `run-2`.
 */
export function spliceRows(doc, rows) {
  const begin = doc.indexOf(ROWS_BEGIN);
  const end = doc.indexOf(ROWS_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`the document has no ${ROWS_BEGIN} … ${ROWS_END} block to append into`);
  }
  const head = doc.slice(0, begin + ROWS_BEGIN.length);
  const tail = doc.slice(end);
  const existing = doc
    .slice(begin + ROWS_BEGIN.length, end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));

  const idOf = (line) => line.split("|")[1]?.trim() ?? "";
  const kept = existing.filter((line) => !rows.some((row) => idOf(line) === row.values.run));
  const merged = [...kept, ...rows.map(markdownRow)];
  const sortKey = (line) => {
    const id = idOf(line);
    const m = /(\d+)/.exec(id);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  merged.sort((a, b) => sortKey(a) - sortKey(b) || idOf(a).localeCompare(idOf(b)));
  return `${head}\n${merged.join("\n")}\n${tail}`;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const args = { targets: [], format: "both", candidatesDir: null, segments: null, runId: null, append: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format") args.format = argv[++i];
    else if (a === "--candidates") args.candidatesDir = argv[++i];
    else if (a === "--segments") args.segments = argv[++i];
    else if (a === "--run-id") args.runId = argv[++i];
    else if (a === "--append") args.append = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else args.targets.push(a);
  }
  if (!["both", "table", "jsonl"].includes(args.format)) throw new Error(`unknown --format ${args.format}`);
  if (args.targets.length === 0) throw new Error("usage: node tools/generation-bench/run.mjs <report.json|dir> [...]");
  if (args.runId && args.targets.length > 1) throw new Error("--run-id names one run; pass one report");
  return args;
}

export function collectRows(args) {
  const pool = loadSegmentPool(args.segments || path.join(REPO_ROOT, "data", "segments.json"));
  const rows = [];
  for (const target of args.targets) {
    rows.push(
      ...rowsForReport(resolveReportPath(target), {
        runId: args.runId,
        candidatesDir: args.candidatesDir,
        pool
      })
    );
  }
  return rows;
}

export function main(argv, out = console.log) {
  const args = parseArgs(argv);
  const rows = collectRows(args);
  if (args.format === "both" || args.format === "table") out(formatTable(rows));
  if (args.format === "both") out("");
  if (args.format === "both" || args.format === "jsonl") for (const row of rows) out(jsonlLine(row));
  if (args.append) {
    const file = path.resolve(args.append);
    fs.writeFileSync(file, spliceRows(fs.readFileSync(file, "utf8"), rows));
  }
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(2);
  }
}
