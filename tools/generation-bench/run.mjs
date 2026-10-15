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
 *   node tools/generation-bench/run.mjs --wide out-9/        # every column, detail included
 *   node tools/generation-bench/run.mjs --wide --cards <store.jsonl> --listen-keys <dir> out-9/
 *   node tools/generation-bench/run.mjs --scorecard --wide out-9/   # + the MQ scorecard (GV-24)
 *   node tools/generation-bench/run.mjs --golden tools/generation-bench/golden/golden-v1.json out-g/
 *   node tools/generation-bench/run.mjs --golden <manifest> --headline out-g/
 *   node tools/generation-bench/run.mjs --golden <manifest> --compare tools/generation-bench/golden-baseline.jsonl out-g/
 *
 * THE GOLDEN SET (GV-64, GEN-05; GP-28, R2-02). `--golden <manifest>` joins
 * each row to its golden prompt by `entry.promptId` (GV-45's `id`, carried by
 * generateForays.ts) and aggregates per stratum and overall: p50/p90 of
 * first_s, full_s, elapsed_min and lead_s, the means of the scorecard's MQ
 * rates, the MQ-21 share, the MQ-20 mean and the out_tok and series medians.
 * It prints one table and one `golden-summary` JSONL line per run id instead
 * of the per-row output. `--headline` prints only the five headline numbers
 * (MT-01, MT-02, MQ-02, MQ-05, MQ-20). `--compare <golden-baseline.jsonl>`
 * says, per metric and stratum, better, worse or within-band (GOLDEN_BANDS),
 * and 'absent' when either side lacks the number. It exits 0 whatever it
 * finds (rule 2); `--fail-on-regression` (kept for G-42b, not to be used until
 * the bands are re-derived from the noise floor) exits 1 on any 'worse'.
 *
 * THE QUALITY SCORECARD (GV-24, MQ-01..MQ-21). `--scorecard` scores each
 * entry with score.mjs's scoreCandidate (the report entry, the candidate
 * beside it, a `<candidate>.judged.json` beside that, the listening cards)
 * and adds a `scorecard` object to each JSONL line; under `--wide` the MQ
 * columns (detail group) print after the others. Without the flag nothing
 * changes: the lines and tables are byte-identical to the bench's own.
 *
 * PER-CALL SPEED (GV-17, MT-04..MT-12). A report entry written since GV-01
 * names its attempt's runlog (`entry.runLog`, relative to the report's own
 * directory). When that file is there, `runlog.mjs` summarises its
 * CallRecords and events into the speed detail columns (out_tok, series,
 * reasks, queue_p50, ttft_p50, cached, prose_tps, code_s, render_x, spark_s)
 * and the JSONL line gains `calls_by_stage`. No runlog, no speed columns: every
 * one is absent, never 0 (rule 1).
 *
 * DELIVERY AND THE SPLIT PER-TIER TARGETS (GV-52, R1-16; MT-01, MT-02,
 * MT-11). A report entry written since GV-33 carries a `delivery` block (the
 * DeliveryTimeline). The bench reads it into `1stAudio s` (first servable
 * item), `allReady s` (every item ready, ONLY when `entry.publishable` is true:
 * a candidate whose gate failed was never ready), `minLead s` (lead over the
 * playhead at 1x), and the detail columns `lead1.5x s` and `render RTF`. Their
 * targets are chosen by the row's tier (`entry.duration`, the `tier` column)
 * from TIER_TARGETS, which replaces the single ttlA1 <= 0.5 min and elapsed
 * <= 6 min targets. No delivery block, no cells: every one is absent.
 *
 * COLUMN GROUPS. Every column is `core` or `detail`. The printed table and the
 * committed KPI doc show the core columns; `--wide` prints every column; the
 * JSONL always carries every number column. A later measurement lands as a
 * `detail` column without re-cutting the committed table.
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
import { isEntryScript } from "../ci/entry.mjs";
import { DEFAULT_STORE as DEFAULT_LISTEN_CARDS, readCards } from "../listening/card.mjs";
import { DEFAULT_KEY_DIR as DEFAULT_LISTEN_KEYS, KEY_MISSING, listenByCandidate } from "../listening/unseal.mjs";
import { STRATA } from "./golden/select.mjs";
import { manifestSha } from "./golden/validate.mjs";
import { SPARK_UNIT, readRunLog, repeatRequests, summarizeRunLog } from "./runlog.mjs";
import { SCORECARD_COLUMNS, judgedPathFor, loadSegmentSources, readJudged, scoreCandidate, scorecardValues } from "./score.mjs";

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
 *   from: "listening"  — the founder's listening cards (GV-08), unsealed to this
 *                        candidate by tools/listening/unseal.mjs
 *   from: "runlog"     — the attempt's runlog/1 file beside the report (GV-17),
 *                        summarised by tools/generation-bench/runlog.mjs
 *
 * `target` is `null` where §1.2 names none. Where it names one, `targetState`
 * is SETTLED or PROPOSED and `targetNote` cites the row or the code that fixes
 * it. Nothing in this file compares a value to a target.
 */
export const COLUMNS = [
  { key: "run", header: "run", from: "derived", width: 7, kind: "text", group: "core" },
  { key: "outcome", header: "outcome", from: "report", width: 9, kind: "text", group: "core" },
  /* `outcome` is NOT the same question as "did this run produce a Foray".
     Run 5's row reads `outcome: "generated"` with `detail: "INVALID … D5 FAIL
     …"`: the pipeline generated a candidate and `check-forays` refused it.
     `generateForays.ts` counts its own publishable runs by the `detail`
     prefix (`report.filter(r => r.detail.startsWith("OK "))`), so this column
     asks the driver's own question rather than inventing a second one. */
  { key: "valid", header: "valid", from: "derived", width: 5, kind: "text", group: "core" },
  /* TM-10: `entry.ms` is NOT wall time. generateForays.ts writes it as the SUM
     of the stage durations, and the acts narrate concurrently, so run 9's four
     overlapping narrate stages make 107.7 min of "ms" out of 44.6 min on the
     clock. The key stays `wall_min` so the committed baseline stays comparable;
     the header says what the number is. `elapsed_min` is the clock. */
  {
    key: "wall_min",
    group: "core",
    header: "stageSum m",
    from: "derived",
    width: 10,
    kind: "number",
    digits: 1,
    targetNote: "sum of stage durations; concurrent acts counted twice (TM-10)"
  },
  {
    key: "elapsed_min",
    group: "core",
    header: "elapsed m",
    from: "derived",
    width: 9,
    kind: "number",
    digits: 1,
    /* GV-52 (R1-16): the old <= 6 min p50 target is superseded by the per-tier
       whole-Foray-ready target on `full_s`; this column is the clock, no target. */
    targetNote:
      "first stage start to last stage end (`elapsedMs` when the report carries it); its <= 6 min target is superseded by R1-16 (allReady s, per tier)"
  },
  {
    key: "ttl_a1_min",
    group: "core",
    header: "ttlA1 m",
    from: "derived",
    width: 7,
    kind: "number",
    digits: 1,
    /* GV-52 (R1-16): kept as its own, act-level row; the 0.5 min target moved
       to `first_s` (first audio), split by tier. */
    targetNote: "§1.2 prompt -> act 1 playable (act-level); its 0.5 min target is superseded by R1-16 (1stAudio s, per tier)"
  },
  /* GV-52 (R1-16; MT-01, MT-02, MT-11): the delivery columns, read off the
     report's `delivery` block (GV-33's DeliveryTimeline, decision 14), with
     targets chosen by the row's tier (TIER_TARGETS). Core, so the committed
     table carries them; runs 4-9 predate the block and print the dash. */
  {
    key: "tier",
    group: "core",
    header: "tier",
    from: "report",
    width: 6,
    kind: "text",
    targetNote: "the duration tier the prompt ran at (`entry.duration`, GV-01); picks the row's per-tier targets"
  },
  {
    key: "first_s",
    group: "core",
    header: "1stAudio s",
    from: "derived",
    width: 10,
    kind: "number",
    digits: 1,
    perTier: true,
    targetNote:
      "MT-01: seconds from the attempt's start to the first servable item (`delivery.firstServableMs`); phone voice first, so the first servable item is first audio"
  },
  {
    key: "full_s",
    group: "core",
    header: "allReady s",
    from: "derived",
    width: 10,
    kind: "number",
    digits: 1,
    perTier: true,
    targetNote:
      "MT-02: seconds until every item was ready (`delivery.allItemsReadyMs`), only when `entry.publishable` is true; otherwise — (not ready: gate failed)"
  },
  {
    key: "lead_s",
    group: "core",
    header: "minLead s",
    from: "report",
    width: 9,
    kind: "number",
    digits: 1,
    perTier: true,
    targetNote: "MT-11: the smallest lead of generation over the playhead at 1x (`delivery.minLeadSec`); negative = a stall"
  },
  { key: "calls", header: "calls", from: "report", width: 5, kind: "number", digits: 0, group: "core" },
  {
    key: "tape_share",
    group: "core",
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
    group: "core",
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
  { key: "clips", header: "clips", from: "candidate", width: 5, kind: "number", digits: 0, group: "core" },
  {
    key: "clip_mean_s",
    group: "core",
    header: "clip mean",
    from: "candidate",
    width: 9,
    kind: "number",
    digits: 1,
    targetNote: "Q-01 cuts clips to a thought, 60-1,800 s; no §1.2 target"
  },
  { key: "clip_max_s", header: "clip max", from: "candidate", width: 8, kind: "number", digits: 1, group: "core" },
  {
    key: "pages_per_seam",
    group: "core",
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
    group: "core",
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
    group: "core",
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
    group: "core",
    header: "1stBt",
    from: "report",
    width: 5,
    kind: "number",
    digits: 2,
    targetNote: "Q-03's per-act reading: narration BEATS the verifier confirmed on round 1. Not comparable to 1stPg"
  },
  {
    key: "first_pass",
    group: "core",
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
    group: "core",
    header: "unver",
    from: "report",
    width: 5,
    kind: "number",
    digits: 0,
    target: 0,
    targetState: SETTLED,
    targetNote: "F-51: any page kept `verified: false` refuses publish (evaluateVeracityGate)"
  },
  { key: "synth_verified", header: "synth", from: "report", width: 5, kind: "number", digits: 0, group: "core" },
  { key: "seed_lost", header: "seedLost", from: "report", width: 8, kind: "number", digits: 0, group: "core" },
  {
    key: "intro_restates",
    group: "core",
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
    group: "core",
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
    group: "core",
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
    group: "core",
    header: "cost $",
    from: "report",
    width: 6,
    kind: "number",
    digits: 2,
    target: 10,
    targetState: PROPOSED,
    targetNote: "§1.2 cost per Foray inside EPISODE_BUDGET_USD $10 (proposed, D0); no report carries `usage` yet"
  },
  /* GV-08 (MQ-20, QK-30): what the founder heard. Detail columns, so the
     committed KPI table does not change shape. Joined by candidate id (the
     report entry's `file` without `.json`) through
     tools/listening/unseal.mjs listenByCandidate; absent when the pack keys
     are not on this machine, and absent for a candidate nobody has listened
     to, which is the point: "nobody has listened since" is a visible dash
     beside a dated column, not a silence. */
  {
    key: "listen",
    group: "detail",
    header: "listen",
    from: "listening",
    width: 6,
    kind: "number",
    digits: 2,
    targetNote: "MQ-20: mean overall (1-5) of the founder's listening cards for this candidate (listen-card/1); — without the pack keys or a card"
  },
  {
    key: "last_listen",
    group: "detail",
    header: "lastListen",
    from: "listening",
    width: 10,
    kind: "text",
    targetNote: "MQ-20: date (UTC) of the latest listening card for this candidate; — = nobody has listened"
  },
  /* GV-17 (MT-04..MT-10, MT-12): the per-call speed scorecard, read off the
     attempt's runlog (`entry.runLog`). Detail columns, so the committed KPI
     table does not change shape; every one is absent without a runlog. */
  {
    key: "out_tok",
    group: "detail",
    header: "outTok",
    from: "runlog",
    width: 6,
    kind: "number",
    digits: 0,
    targetNote: "MT-05: output tokens over every model call of the attempt (per stage in runlog.mjs's outputTokensByStage)"
  },
  {
    key: "series",
    group: "detail",
    header: "series",
    from: "runlog",
    width: 6,
    kind: "number",
    digits: 0,
    targetNote: "MT-06: calls in series, the longest chain of calls each starting after the previous one ended"
  },
  {
    key: "reasks",
    group: "detail",
    header: "reasks",
    from: "runlog",
    width: 6,
    kind: "number",
    digits: 0,
    targetNote: "MT-07: repeat requests: JSON re-asks + spine re-asks (structural, seed-floor) + writer rounds after the first + continuations"
  },
  {
    key: "queue_p50",
    group: "detail",
    header: "queueP50",
    from: "runlog",
    width: 8,
    kind: "number",
    digits: 2,
    targetNote: "MT-04: median seconds a call waited in the server's queue, over the calls that report it"
  },
  {
    key: "ttft_p50",
    group: "detail",
    header: "ttftP50",
    from: "runlog",
    width: 7,
    kind: "number",
    digits: 2,
    targetNote: "MT-04: median seconds to the first token, over the calls that report it"
  },
  {
    key: "cached",
    group: "detail",
    header: "cached",
    from: "runlog",
    width: 6,
    kind: "number",
    digits: 3,
    targetNote: "MT-04: cached prompt tokens / prompt tokens, over the calls that report both"
  },
  {
    key: "prose_tps",
    group: "detail",
    header: "proseTps",
    from: "runlog",
    width: 8,
    kind: "number",
    digits: 1,
    targetNote:
      "MT-12: the writer's output tok/s over decode time (call ms - ttft); suffixed `e2e` when no writer call reports a ttft and the rate is end to end"
  },
  {
    key: "code_s",
    group: "detail",
    header: "code s",
    from: "runlog",
    width: 6,
    kind: "number",
    digits: 1,
    targetNote: "MT-08: seconds of code time inside the stages (CodeSpanAggregate events, exclusive selfMs summed so nested spans count once)"
  },
  {
    key: "render_x",
    group: "detail",
    header: "renderX",
    from: "runlog",
    width: 7,
    kind: "number",
    digits: 2,
    targetNote: "MT-09: seconds of narration audio rendered per second of rendering (RenderSpans)"
  },
  {
    key: "spark_s",
    group: "detail",
    header: "spark s",
    from: "runlog",
    width: 7,
    kind: "number",
    digits: 1,
    targetNote: "MT-10: Spark seconds charged (reconciled sparkSeconds MeterEvents; a reservation is not a charge)"
  },
  /* GV-52: the delivery block's detail columns. */
  {
    key: "lead15_s",
    group: "detail",
    header: "lead1.5x s",
    from: "report",
    width: 10,
    kind: "number",
    digits: 1,
    targetNote: "MT-11 at 1.5x playback: the smallest lead over the playhead (`delivery.minLeadSecAt1_5x`)"
  },
  {
    key: "render_rtf",
    group: "detail",
    header: "render RTF",
    from: "report",
    width: 10,
    kind: "number",
    digits: 2,
    targetNote:
      "R1-14 render speed: the report's own realtime factor (`delivery.render.realtimeFactor`, GV-74); renderX is the runlog's reading of the same MT-09"
  },
  /* GV-55 (R2-21, from W7-02): which implementation and machine served each
     stage, compacted (`stackOf`). A text detail column: absent on reports
     written before the driver recorded `stageAssignments` (runs 4-9). */
  {
    key: "stack",
    group: "detail",
    header: "stack",
    from: "report",
    width: 5,
    kind: "text",
    targetNote: "R2-21 attribution: the most common impl@machine, then each stage that differs (`stageAssignments`, GV-55)"
  },
  /* GV-91 (W7-07): how the best-of-2 spine chose (`entry.spineSelection`),
     as chosen/reason/+addedMs. A text detail column: absent on every row
     whose spine was not built by a best-of-2 builder (rule 1). */
  {
    key: "bo2",
    group: "detail",
    header: "bo2",
    from: "report",
    width: 3,
    kind: "text",
    targetNote: "R2-17 best-of-2 spine (GV-91): the chosen sample, the reason and the ms added after the primary (`spineSelection`); E4 keeps the lever only at p50 addedMs <= 3000"
  },
  /* GV-83 (MQ-07; QK-21, GP-22): show variety, off `meta.veracity.showVariety`
     (computeShowVariety). Detail columns (GV-04 grouping), so the committed
     KPI table does not change shape; absent on reports written before GV-83
     (runs 4-9), never 0 (rule 1). No target: measure-only. */
  {
    key: "shows",
    group: "detail",
    header: "shows",
    from: "report",
    width: 5,
    kind: "number",
    digits: 0,
    targetNote: "MQ-07: distinct shows the Foray's tape comes from (`showVariety.distinctShows`)"
  },
  {
    key: "top_show_pct",
    group: "detail",
    header: "top show %",
    from: "report",
    width: 10,
    kind: "number",
    digits: 0,
    targetNote: "MQ-07: the largest show's share of the tape seconds, in percent (`showVariety.largestShowTapeShare` x 100); — with no tape"
  }
];

/**
 * GV-52 (R1-16): the split per-tier targets, in seconds, for the delivery
 * columns. Replaces the single ttlA1 <= 0.5 min and elapsed <= 6 min targets.
 *
 * SETTLED rests on the orchestrator's adopted reading of the 30 s KPI (OQ-03),
 * recorded as decision 15 of docs/roadmap/generation-v2.md (#1286): short
 * first audio <= 30 s and the whole Foray ready <= 90 s short / <= 240 s
 * medium. Medium first audio <= 40 s and lead >= 30 s stay PROPOSED until a
 * founder ruling. A later ruling flips a state here in one line. Long has no
 * target. Nothing compares a value to these (rule 2).
 */
export const TIER_TARGETS = {
  short: {
    first_s: { target: 30, targetState: SETTLED },
    full_s: { target: 90, targetState: SETTLED },
    lead_s: { target: 30, targetState: PROPOSED }
  },
  medium: {
    first_s: { target: 40, targetState: PROPOSED },
    full_s: { target: 240, targetState: SETTLED },
    lead_s: { target: 30, targetState: PROPOSED }
  }
};

/** Where TIER_TARGETS' states come from, for the legend. */
export const TIER_TARGET_NOTE =
  "orchestrator's adopted reading of the 30 s KPI (OQ-03; docs/roadmap/generation-v2.md decision 15; #1286); ? = proposed until a founder ruling";

/** The tiers a row can carry (`entry.duration`, GV-01). */
export const TIERS = ["short", "medium", "long"];

/** Column groups. A `core` column is in the committed KPI table
 * (markdownHeader / markdownRow) and the default printed table; a `detail`
 * column is carried in every JSONL line and printed only under `--wide`, so a
 * later card can add a measurement without re-cutting the committed table. */
export const CORE = "core";
export const DETAIL = "detail";

/** The columns a table prints: core only, or every column when `wide`. */
export function tableColumns(options = {}) {
  if (!options.wide) return COLUMNS.filter((col) => col.group === CORE);
  /* GV-24: the MQ scorecard columns, only when the rows were scored. */
  return options.scorecard ? [...COLUMNS, ...SCORECARD_COLUMNS] : COLUMNS;
}

const BO2_REASONS = ["judged", "only-valid", "secondary-late", "judge-failed", "none-valid"];

/**
 * GV-91 (W7-07): a row's `spineSelection` (the best-of-2 spine's record) as
 * one cell, `chosen/reason/+addedMs`, e.g. `secondary/judged/+1200ms`. Null
 * when the row carries none or the record is malformed (rule 1: absent,
 * never a guessed choice).
 */
export function bestOfCell(selection) {
  if (!selection || typeof selection !== "object") return null;
  const { chosen, reason, addedMs } = selection;
  if (chosen !== "primary" && chosen !== "secondary") return null;
  if (!BO2_REASONS.includes(reason)) return null;
  if (typeof addedMs !== "number" || !Number.isFinite(addedMs) || addedMs < 0) return null;
  return `${chosen}/${reason}/+${Math.round(addedMs)}ms`;
}

/**
 * GV-55: a row's `stageAssignments` ({stage: {impl, model, machine?}}) as one
 * compact cell: the most common `impl[@machine]` first (the first stage's on a
 * tie), then `stage=impl[@machine]` for every stage that differs, in the
 * report's own stage order. E.g. `local@spark research=none deepen=local@second
 * judge=jev`. Null when the row carries no assignments (rule 1: absent, never
 * a guessed stack).
 */
export function stackOf(stageAssignments) {
  if (!stageAssignments || typeof stageAssignments !== "object") return null;
  const tag = (a) => a.impl + (typeof a.machine === "string" && a.machine ? `@${a.machine}` : "");
  const entries = Object.entries(stageAssignments).filter(([, a]) => a && typeof a === "object" && typeof a.impl === "string");
  if (entries.length === 0) return null;
  const counts = new Map();
  for (const [, a] of entries) counts.set(tag(a), (counts.get(tag(a)) || 0) + 1);
  let top = null;
  for (const [t, n] of counts) if (top === null || n > counts.get(top)) top = t;
  const rest = entries.filter(([, a]) => tag(a) !== top).map(([stage, a]) => `${stage}=${tag(a)}`);
  return [top, ...rest].join(" ");
}

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

/** GV-52: milliseconds to seconds, or null when there were none. */
export function seconds(ms) {
  const v = num(ms);
  return v === null ? null : v / 1000;
}

/** GV-52: the row's tier (`entry.duration`, GV-01), or null when the report
 * names none (every report before GV-01) or names one this bench does not know. */
export function tierOf(entry) {
  return typeof entry?.duration === "string" && TIERS.includes(entry.duration) ? entry.duration : null;
}

/**
 * TM-10: the clock time a run's stages covered — the latest stage end minus
 * the earliest stage start — from the `stageTimings` every report since run 9
 * carries (`{ name, startedAt, ms }`).
 *
 * Summing the `ms` (which is what `entry.ms` is) counts the concurrent acts'
 * narrate stages once each; the span counts the clock once. A timing marked
 * `resumed: true` was banked by an EARLIER attempt and its `startedAt` is that
 * attempt's clock, so it is left out — keeping it would stretch the span
 * across the gap between the two attempts. Null (absent, rule 1) when there is
 * no usable timing at all; a timing with no parseable start or no `ms` is
 * skipped rather than read as zero.
 */
export function spanMsOf(stageTimings) {
  if (!Array.isArray(stageTimings)) return null;
  let first = null;
  let last = null;
  for (const t of stageTimings) {
    if (!t || t.resumed === true) continue;
    const start = typeof t.startedAt === "string" ? Date.parse(t.startedAt) : Number.NaN;
    const ms = num(t.ms);
    if (!Number.isFinite(start) || ms === null) continue;
    if (first === null || start < first) first = start;
    if (last === null || start + ms > last) last = start + ms;
  }
  return first === null ? null : last - first;
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
 * The duration of every `type: "segment"` item, in item order: the minted row
 * first, then the pool row, else null (unresolved). clipStats aggregates these;
 * the scorecard (score.mjs, GV-24, MQ-08) reads them per clip, so the bench and
 * the scorecard measure the same clips.
 */
export function clipDurations(candidate, pool = new Map()) {
  const minted = new Map();
  for (const row of candidate.segments || []) {
    const start = num(row.startSec);
    const end = num(row.endSec);
    if (start !== null && end !== null) minted.set(row.id, end - start);
  }
  const items = (candidate.items || []).filter((item) => item && item.type === "segment");
  return items.map((item) => {
    if (minted.has(item.segment_id)) return minted.get(item.segment_id);
    const row = pool.get(item.segment_id);
    const start = row ? num(row.start_sec) : null;
    const end = row ? num(row.end_sec) : null;
    return start !== null && end !== null ? end - start : null;
  });
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
  const all = clipDurations(candidate, pool);
  const durations = all.filter((d) => d !== null);
  const tapeSec = durations.reduce((sum, d) => sum + d, 0);
  const runtimeSec = num(candidate.runtimeSec);
  return {
    count: all.length,
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
/* What the founder heard (GV-08, MQ-20)                               */
/* ------------------------------------------------------------------ */

/** The id a listening key names a candidate by: the basename generateForays.ts
 * writes as the entry's `file`, without `.json`. Read off the report, so the
 * join works whether or not the candidate itself is on this machine. */
export function candidateIdFor(entry) {
  if (!entry || typeof entry.file !== "string") return null;
  const base = entry.file.replace(/\\/g, "/").split("/").pop();
  const id = base ? base.replace(/\.json$/i, "") : "";
  return id === "" ? null : id;
}

/**
 * The per-candidate listening summary, or null when it cannot be had here.
 *
 * Null (every listening cell absent) when the key directory is not on this
 * machine, or when a card's pack has no key here: the keys are written where
 * the packs were built and never committed, so most checkouts can read the
 * cards and unseal none of them. A malformed store or key THROWS — that is a
 * broken file, not a missing machine, and a bench that skipped it would hide a
 * listen that happened.
 */
export function loadListening(options = {}) {
  const keyDir = options.keyDir || DEFAULT_LISTEN_KEYS;
  if (!fs.existsSync(keyDir)) return null;
  const cards = readCards(options.cards || DEFAULT_LISTEN_CARDS);
  try {
    return listenByCandidate(cards, { keyDir });
  } catch (err) {
    if (err && err.code === KEY_MISSING) return null;
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* The attempt's runlog (GV-17)                                        */
/* ------------------------------------------------------------------ */

/**
 * Where this entry's runlog is, if it is here. `entry.runLog` is written
 * RELATIVE to the report's directory (`runlogs/<key>.<attempt>.runlog.jsonl`,
 * generateForays.ts), so it is resolved against the directory that holds the
 * report, never the working directory. Null when the entry names none (a
 * --dry-run, every report before GV-01) or the file was not copied with the
 * report: the speed columns are then absent, which is what they are.
 */
export function runLogPathFor(entry, reportPath) {
  if (!entry || typeof entry.runLog !== "string" || entry.runLog.trim() === "") return null;
  const file = path.resolve(path.dirname(path.resolve(reportPath)), entry.runLog);
  return fs.existsSync(file) ? file : null;
}

/** The runlog summary for an entry, or null when there is no runlog here. A
 * runlog that IS here but is not `runlog/1` throws (readRunLog): a broken file
 * is not a missing one. */
export function runLogSummaryFor(entry, reportPath) {
  const file = runLogPathFor(entry, reportPath);
  return file === null ? null : summarizeRunLog(readRunLog(file).events);
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
  const { report = {}, runId = "run", clips = null, listening = null, runlog = null, scorecard = null, reportRun = null } = context;
  const v = entry.veracity || {};
  const delivery = entry.delivery && typeof entry.delivery === "object" ? entry.delivery : null;
  const candidateId = candidateIdFor(entry);
  const heard = listening && candidateId !== null ? listening.get(candidateId) || null : null;
  const values = {
    run: runId,
    outcome: typeof entry.outcome === "string" ? entry.outcome : null,
    valid: typeof entry.detail === "string" ? (entry.detail.startsWith("OK ") ? "yes" : "no") : null,
    wall_min: minutes(entry.ms),
    /* A report that records its own elapsed time (`elapsedMs`, the per-run
       RunLog's) is the authority; older reports get the span of their stage
       timings; reports with neither (runs 4-8) are absent. */
    elapsed_min: minutes(num(entry.elapsedMs) ?? spanMsOf(v.stageTimings)),
    ttl_a1_min: minutes(entry.ttlA1Ms),
    /* GV-52: the tier and the delivery block (GV-33). Seconds where the block
       is in milliseconds; absent without the block, and absent on a resumed
       attempt, which carries no first-item times (rule 1). */
    tier: tierOf(entry),
    first_s: seconds(delivery?.firstServableMs),
    /* MT-02 counts only a Foray that could ship: a candidate whose gate failed
       was never "ready", however late its last item arrived. */
    full_s: entry.publishable === true ? seconds(delivery?.allItemsReadyMs) : null,
    lead_s: num(delivery?.minLeadSec),
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
    cost_usd: costUsdFor(entry, report),
    listen: heard ? num(heard.meanOverall) : null,
    last_listen: heard && typeof heard.lastListenedAt === "string" ? new Date(heard.lastListenedAt).toISOString().slice(0, 10) : null,
    /* GV-17: the runlog's speed scorecard. Seconds where the summary is in
       milliseconds; every cell null without a runlog, and null where the
       runlog carries no record of that kind (rule 1). */
    out_tok: runlog ? num(runlog.outputTokens) : null,
    series: runlog ? num(runlog.seriesDepth) : null,
    reasks: runlog ? num(repeatRequests(runlog.repeatWork)) : null,
    queue_p50: runlog && num(runlog.queueP50Ms) !== null ? runlog.queueP50Ms / 1000 : null,
    ttft_p50: runlog && num(runlog.ttftP50Ms) !== null ? runlog.ttftP50Ms / 1000 : null,
    cached: runlog ? num(runlog.cachedShare) : null,
    prose_tps: runlog ? num(runlog.prose?.tokPerSec) : null,
    code_s: runlog && num(runlog.codeMs) !== null ? runlog.codeMs / 1000 : null,
    render_x: runlog ? num(runlog.renderRealtime) : null,
    spark_s: runlog ? num(runlog.unitSpend?.[SPARK_UNIT]) : null,
    lead15_s: num(delivery?.minLeadSecAt1_5x),
    render_rtf: num(delivery?.render?.realtimeFactor),
    stack: stackOf(entry.stageAssignments),
    bo2: bestOfCell(entry.spineSelection),
    /* GV-83: absent without the block, and the share absent with no tape. */
    shows: num(v.showVariety?.distinctShows),
    top_show_pct: num(v.showVariety?.largestShowTapeShare) === null ? null : v.showVariety.largestShowTapeShare * 100
  };
  const sources = {};
  for (const col of COLUMNS) {
    sources[col.key] = values[col.key] === null || values[col.key] === undefined ? "absent" : col.from;
  }
  /* GV-24: the MQ scalars join `values` for the --wide table only; their
     provenance is the scorecard's own per-cell `source`, so `sources` (the
     bench columns' provenance) is unchanged. */
  if (scorecard) Object.assign(values, scorecardValues(scorecard));
  return {
    values,
    sources,
    ...(scorecard ? { scorecard } : {}),
    /* Context a diff wants that is not a graded column. */
    meta: {
      run: runId,
      generated_at: typeof report.generated_at === "string" ? report.generated_at : null,
      prompt: typeof entry.prompt === "string" ? entry.prompt : null,
      detail: typeof entry.detail === "string" ? entry.detail : null,
      clips_measured: clips ? clips.measured : null,
      candidate_read: Boolean(clips),
      /* GV-17: calls per stage (a meta object, not a column) and what the
         prose rate is a rate of ("ttft": decode; "e2e": end to end). */
      calls_by_stage: runlog ? { ...runlog.callsByStage } : null,
      prose_basis: runlog && num(runlog.prose?.tokPerSec) !== null ? runlog.prose.basis : null,
      /* GV-64: the golden join (`entry.promptId`, GV-01/GV-45) and the run id
         the row's report belongs to (without the `#n` entry suffix), so
         --golden groups a report's rows into one summary. Meta only: no
         JSONL line carries them, so the per-row output is unchanged. */
      prompt_id: typeof entry.promptId === "string" && entry.promptId !== "" ? entry.promptId : null,
      report_run: typeof reportRun === "string" ? reportRun : runId
    }
  };
}

/** GV-24: one entry's MQ scorecard. The judged file is GV-92's
 * `<candidate>.judged.json` beside the candidate; MQ-20 is joined by the same
 * candidate id as the listen column. */
export function scorecardFor(entry, candidate, candidateFile, context = {}) {
  const candidateId = candidateIdFor(entry);
  const judgedFile = judgedPathFor(candidateFile);
  return scoreCandidate({
    candidate,
    entry,
    pool: context.pool || new Map(),
    sources: context.sources || null,
    judged: judgedFile ? readJudged(judgedFile)(candidateId) : null,
    listen: context.listening && candidateId !== null ? context.listening.get(candidateId) || null : null
  });
}

/** Every row a report yields — one per entry, in the report's own order. */
export function rowsForReport(reportPath, options = {}) {
  const report = readJson(reportPath);
  const runId = options.runId || runIdFor(reportPath);
  const entries = Array.isArray(report.entries) ? report.entries : [];
  const pool = options.pool || new Map();
  return entries.map((entry, index) => {
    const candidateFile = candidatePathFor(entry, reportPath, options.candidatesDir);
    const candidate = candidateFile ? readJson(candidateFile) : null;
    const clips = candidate ? clipStats(candidate, pool) : null;
    const id = entries.length > 1 ? `${runId}#${index + 1}` : runId;
    const runlog = runLogSummaryFor(entry, reportPath);
    const listening = options.listening || null;
    const scorecard = options.scorecard
      ? scorecardFor(entry, candidate, candidateFile, { pool, sources: options.segmentSources, listening })
      : null;
    return rowFor(entry, { report, runId: id, reportRun: runId, clips, listening, runlog, scorecard });
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
  /* MT-12: an end-to-end rate is labelled, never printed as a decode rate. */
  if (col.key === "prose_tps" && row.meta.prose_basis === "e2e") return `${value.toFixed(col.digits)} e2e`;
  const partial =
    col.from === "candidate" &&
    col.key !== "clips" &&
    row.meta.clips_measured !== null &&
    row.meta.clips_measured < row.values.clips;
  return value.toFixed(col.digits) + (partial ? "*" : "");
}

/** GV-52: one per-tier target as the legend prints it — plain when settled,
 * `?` when proposed. */
function tierTargetText(t) {
  return t.targetState === PROPOSED ? `${t.target}?` : String(t.target);
}

/**
 * GV-52: the target that applies to this column ON THIS ROW, chosen by the
 * row's tier: `{ target, targetState }`, or null when the column has no target
 * for that tier (long, or a row whose report names no tier). A column with a
 * single target returns it whatever the row. Never compares (rule 2).
 */
export function targetFor(col, row) {
  if (col.perTier) {
    const tier = row?.values?.tier;
    const t = typeof tier === "string" && Object.hasOwn(TIER_TARGETS, tier) ? TIER_TARGETS[tier][col.key] : undefined;
    return t ? { target: t.target, targetState: t.targetState } : null;
  }
  if (col.target === undefined || col.target === null) return null;
  return { target: col.target, targetState: col.targetState };
}

/** GV-52: a per-tier column's targets across the tiers, e.g.
 * `short 30, medium 40?, long none`. */
export function tierTargetsLabel(col) {
  return TIERS.map((tier) => {
    const t = TIER_TARGETS[tier]?.[col.key];
    return `${tier} ${t ? tierTargetText(t) : "none"}`;
  }).join(", ");
}

/** The target cell of the legend: settled targets plain, proposed with `?`;
 * a per-tier column (GV-52) prints `per tier`. */
export function targetLabel(col) {
  if (col.perTier) return "per tier";
  if (col.target === undefined || col.target === null) return "";
  const n = col.digits === 0 ? String(col.target) : col.target.toFixed(col.digits);
  return col.targetState === PROPOSED ? `${n}?` : n;
}

/** The human table: a header, one row per run, then the legend that says what
 * each column is, where it came from, and whether its target is settled. Core
 * columns only, unless `options.wide` (the CLI's `--wide`) asks for every one. */
export function formatTable(rows, options = {}) {
  const columns = tableColumns(options);
  const widths = columns.map((col) =>
    Math.max(col.header.length, col.width, ...rows.map((row) => formatCell(col, row).length))
  );
  const line = (cells) => cells.map((cell, i) => String(cell).padStart(widths[i])).join("  ");
  const out = [line(columns.map((c) => c.header)), line(widths.map((w) => "-".repeat(w)))];
  for (const row of rows) out.push(line(columns.map((col) => formatCell(col, row))));

  out.push("");
  out.push(`${ABSENT} = the report does not carry it (never read as zero).  * = measured over some of the clips, not all.`);
  out.push("targets: a bare number is SETTLED; a number with ? is PROPOSED and waits on founder decision D0.");
  out.push("");
  for (const col of columns) {
    const target = targetLabel(col);
    const note = col.targetNote || "";
    if (!target && !note) continue;
    out.push(`  ${col.header.padEnd(9)} ${(target || "no target").padEnd(10)} ${note}`);
    /* GV-52: a per-tier column names every tier's target, in seconds. */
    if (col.perTier) out.push(`  ${"".padEnd(9)} ${"".padEnd(10)} targets (s): ${tierTargetsLabel(col)}`);
  }
  if (columns.some((col) => col.perTier)) out.push(`  per tier: ${TIER_TARGET_NOTE}`);
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
    prompt: row.meta.prompt,
    /* The one text column a diff wants (GV-08): the date of the last listen. */
    last_listen: row.values.last_listen ?? null,
    /* GV-52: the tier, so a baseline line keeps the row's per-tier targets. */
    tier: row.values.tier ?? null,
    /* GV-17: calls per stage as a meta object (not a column), and the basis of
       prose_tps so a diff never compares a decode rate with an e2e one. */
    calls_by_stage: row.meta.calls_by_stage ?? null,
    prose_basis: row.meta.prose_basis ?? null,
    /* GV-55: the compact stack, only when the row has one, so a line from a
       report without stageAssignments keeps its shape. */
    ...(typeof row.values.stack === "string" ? { stack: row.values.stack } : {}),
    /* GV-91: the best-of-2 cell, only when the row has one. */
    ...(typeof row.values.bo2 === "string" ? { bo2: row.values.bo2 } : {}),
    /* GV-24: the MQ scorecard, only on a --scorecard row, so a plain line is
       byte-identical to the bench's own. */
    ...(row.scorecard ? { scorecard: row.scorecard } : {})
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
  const values = {
    run: obj.run,
    outcome: obj.outcome ?? null,
    valid: obj.valid ?? null,
    last_listen: typeof obj.last_listen === "string" ? obj.last_listen : null,
    tier: typeof obj.tier === "string" && TIERS.includes(obj.tier) ? obj.tier : null,
    stack: typeof obj.stack === "string" && obj.stack ? obj.stack : null,
    bo2: typeof obj.bo2 === "string" && obj.bo2 ? obj.bo2 : null
  };
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
  const scorecard = obj.scorecard && typeof obj.scorecard === "object" ? obj.scorecard : null;
  if (scorecard) Object.assign(values, scorecardValues(scorecard));
  return {
    values,
    sources,
    ...(scorecard ? { scorecard } : {}),
    meta: {
      run: obj.run,
      generated_at: obj.generated_at ?? null,
      prompt: obj.prompt ?? null,
      detail: null,
      clips_measured: obj.clips_measured ?? null,
      candidate_read: Boolean(obj.candidate_read),
      calls_by_stage: obj.calls_by_stage && typeof obj.calls_by_stage === "object" ? { ...obj.calls_by_stage } : null,
      prose_basis: obj.prose_basis === "ttft" || obj.prose_basis === "e2e" ? obj.prose_basis : null
    }
  };
}

/* ------------------------------------------------------------------ */
/* Appending to the KPI doc                                            */
/* ------------------------------------------------------------------ */

export const ROWS_BEGIN = "<!-- bench:rows:begin -->";
export const ROWS_END = "<!-- bench:rows:end -->";

/** One markdown table row, `| run | … |`. Core columns only: the committed
 * KPI table is the core table, and a `detail` column lives in the JSONL. */
export function markdownRow(row) {
  return `| ${tableColumns().map((col) => formatCell(col, row)).join(" | ")} |`;
}

/** The two header lines the spliced rows sit under. The KPI doc commits these
 * verbatim above the begin marker, and the suite asserts the committed copy
 * equals this — so adding a column cannot silently shift every cell one place
 * left in a table nobody re-generates. */
export function markdownHeader() {
  const columns = tableColumns();
  return [`| ${columns.map((c) => c.header).join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`];
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
/* The golden set: aggregation, headline, compare (GV-64, GEN-05)       */
/* ------------------------------------------------------------------ */

/** The `kind` of a golden summary line, so a per-row baseline.jsonl passed to
 * --compare by mistake is refused rather than read as an empty baseline. */
export const GOLDEN_SUMMARY = "golden-summary";

/** The stratum every joined row of a run sits in, whatever its golden stratum. */
export const OVERALL = "overall";

/**
 * The tolerance bands --compare judges a move by (GEN-05). PROPOSED: they were
 * chosen before any local run, so they may be tighter than LLM noise. The live
 * step re-derives them from two back-to-back runs of one build (the noise
 * floor) before anyone uses --fail-on-regression. A move exactly the size of
 * the band is within it.
 *
 *   time    +-15 % of the baseline's value (relative to its magnitude, so a
 *           negative lead has a band too)
 *   volume  the time band, for token counts: +-1 token would be no band at all
 *   rate    +-0.05 absolute (a share in 0..1)
 *   count   +-1 absolute
 *   score   +-0.25 absolute on the founder's 1-5 card (MQ-20). The card names
 *           no band for a score, so this one is the bench's own proposal: half
 *           the swap rule's 0.5 axis-drop allowance (swap-rule.mjs).
 */
export const GOLDEN_BANDS = Object.freeze({
  time: Object.freeze({ relative: 0.15 }),
  volume: Object.freeze({ relative: 0.15 }),
  rate: Object.freeze({ absolute: 0.05 }),
  count: Object.freeze({ absolute: 1 }),
  score: Object.freeze({ absolute: 0.25 })
});

/** Float slack, so a move of exactly the band (0.80 - 0.75, which is
 * 0.050000000000000044 in floats) reads within it. */
const BAND_EPSILON = 1e-9;

const pct = (column, q, kind, better, label) => ({ key: `${column}_p${q}`, column, agg: "percentile", q: q / 100, kind, better, label });
const meanOf = (id, column, label) => ({ key: `${column}_mean`, column, agg: "mean", kind: "rate", better: "higher", label: `${id} ${label}` });

/**
 * Every aggregate a golden summary carries, in print order. `column` is the
 * row value it is computed from; `kind` picks the band; `better` is the
 * direction a move outside the band counts as better. A value a row does not
 * carry is left out of that aggregate (rule 1): a mean over the rows that have
 * the number, and absent (null) when none has it.
 */
export const GOLDEN_METRICS = Object.freeze(
  [
    pct("first_s", 50, "time", "lower", "MT-01 first audio, s"),
    pct("first_s", 90, "time", "lower", "MT-01 first audio, s"),
    pct("full_s", 50, "time", "lower", "MT-02 all ready (publishable rows only), s"),
    pct("full_s", 90, "time", "lower", "MT-02 all ready (publishable rows only), s"),
    pct("elapsed_min", 50, "time", "lower", "elapsed, min"),
    pct("elapsed_min", 90, "time", "lower", "elapsed, min"),
    pct("lead_s", 50, "time", "higher", "MT-11 min lead over the playhead, s"),
    pct("lead_s", 90, "time", "higher", "MT-11 min lead over the playhead, s"),
    meanOf("MQ-01", "mq01", "grounded quote rate, mean"),
    meanOf("MQ-02", "mq02", "supported-sentence rate, mean"),
    meanOf("MQ-03", "mq03", "attribution accuracy, mean"),
    meanOf("MQ-05", "mq05", "clip-on-subject rate, mean"),
    meanOf("MQ-06", "mq06", "clean-cut share, mean"),
    meanOf("MQ-09", "mq09", "tape yield, mean"),
    meanOf("MQ-11", "mq11", "beat coverage, mean"),
    { key: "mq21_share", column: "mq21", agg: "share", kind: "rate", better: "higher", label: "MQ-21 publishable share" },
    { key: "mq20_mean", column: "listen", agg: "mean", kind: "score", better: "higher", label: "MQ-20 founder's listen, mean overall (1-5)" },
    pct("out_tok", 50, "volume", "lower", "MT-05 output tokens, median"),
    pct("series", 50, "count", "lower", "MT-06 calls in series, median")
  ].map((m) => Object.freeze(m))
);

/** The five headline numbers --headline prints, in order, read off `overall`. */
export const HEADLINE = Object.freeze([
  Object.freeze({ id: "MT-01", key: "first_s_p50", label: "first audio p50, s" }),
  Object.freeze({ id: "MT-02", key: "full_s_p50", label: "all ready p50, s" }),
  Object.freeze({ id: "MQ-02", key: "mq02_mean", label: "supported-sentence rate, mean" }),
  Object.freeze({ id: "MQ-05", key: "mq05_mean", label: "clip-on-subject rate, mean" }),
  Object.freeze({ id: "MQ-20", key: "mq20_mean", label: "founder's listen, mean overall (1-5)" })
]);

/**
 * The q-th quantile (0..1) of the finite values, linearly interpolated between
 * the two nearest ranks (rank q * (n - 1)), so p50 is the median runlog.mjs's
 * p50 computes (the mean of the two middle values for an even count). Null
 * when there are none: no rows is not a 0 s first audio.
 */
export function percentile(values, q) {
  const xs = values.map(num).filter((v) => v !== null).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = q * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
}

/** The mean of the finite values, or null when there are none. */
export function meanValue(values) {
  const xs = values.map(num).filter((v) => v !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * A golden manifest (GV-45's `golden-v1.json` shape: an array of
 * `{ id, stratum, listened, ... }`) as a join table: `byId` maps a prompt id to
 * `{ stratum, listened }`, `strata` lists the manifest's strata in select.mjs's
 * order (then any other, sorted). Throws on a manifest that is not an array,
 * an entry without a string id or stratum, or a repeated id: a join over a
 * broken manifest would put rows in the wrong stratum quietly.
 */
export function loadGoldenManifest(file) {
  const bytes = fs.readFileSync(file);
  let entries;
  try {
    entries = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  if (!Array.isArray(entries)) throw new Error(`${file}: a golden manifest is an array of prompt entries`);
  const byId = new Map();
  for (const [i, e] of entries.entries()) {
    if (!e || typeof e.id !== "string" || e.id === "") throw new Error(`${file}: entry ${i + 1} has no id`);
    if (typeof e.stratum !== "string" || e.stratum === "" || e.stratum === OVERALL) throw new Error(`${file}: ${e.id} has no usable stratum`);
    if (byId.has(e.id)) throw new Error(`${file}: duplicate id ${e.id}`);
    byId.set(e.id, { stratum: e.stratum, listened: e.listened === true });
  }
  const seen = new Set([...byId.values()].map((e) => e.stratum));
  const strata = [...STRATA.filter((s) => seen.has(s)), ...[...seen].filter((s) => !STRATA.includes(s)).sort()];
  return { name: path.basename(file), sha256: manifestSha(bytes), byId, strata };
}

/** One aggregate over some rows. */
function aggregate(metric, rows) {
  const values = rows.map((row) => row.values[metric.column]);
  if (metric.agg === "percentile") return percentile(values, metric.q);
  if (metric.agg === "mean") return meanValue(values);
  /* share: of the rows that say yes or no; a row that says nothing is left out. */
  const known = values.filter((v) => v === "yes" || v === "no");
  return known.length ? known.filter((v) => v === "yes").length / known.length : null;
}

/** `{ n, listened, metrics }` for one stratum's rows. */
function stratumSummary(rows, manifest) {
  return {
    n: rows.length,
    listened: rows.filter((row) => manifest.byId.get(row.meta.prompt_id)?.listened === true).length,
    metrics: Object.fromEntries(GOLDEN_METRICS.map((m) => [m.key, aggregate(m, rows)]))
  };
}

/**
 * The golden summaries: one per run id (the report a row came from, in order
 * of first appearance). Rows join the manifest by `meta.prompt_id`; a row whose
 * prompt id is missing or not in the manifest is listed in `unmatched` (its id,
 * or null) and left out of every aggregate, `overall` included, so a stray
 * ad-hoc prompt cannot move the golden numbers. Every manifest stratum is
 * present, with `n: 0` and absent metrics when the run has no row in it.
 */
export function goldenSummaries(rows, manifest) {
  const runs = new Map();
  for (const row of rows) {
    const run = row.meta?.report_run ?? row.values.run;
    if (!runs.has(run)) runs.set(run, []);
    runs.get(run).push(row);
  }
  return [...runs].map(([run, runRows]) => {
    const matched = runRows.filter((row) => manifest.byId.has(row.meta?.prompt_id));
    const strata = { [OVERALL]: stratumSummary(matched, manifest) };
    for (const stratum of manifest.strata) {
      strata[stratum] = stratumSummary(
        matched.filter((row) => manifest.byId.get(row.meta.prompt_id).stratum === stratum),
        manifest
      );
    }
    return {
      kind: GOLDEN_SUMMARY,
      run,
      generated_at: runRows[0].meta?.generated_at ?? null,
      manifest: manifest.name,
      manifest_sha256: manifest.sha256,
      rows: runRows.length,
      matched: matched.length,
      unmatched: runRows.filter((row) => !manifest.byId.has(row.meta?.prompt_id)).map((row) => row.meta?.prompt_id ?? null),
      strata
    };
  });
}

/** One `golden-summary` JSONL line: key order as built, numbers as computed
 * (a renderer that rounded would invent movement for --compare). */
export function goldenSummaryLine(summary) {
  return JSON.stringify(summary);
}

/** A metric's value for a person: absent is ABSENT, never 0. */
function formatGoldenValue(metric, value) {
  if (value === null || value === undefined) return ABSENT;
  const digits = { time: 1, volume: 0, count: 1, rate: 3, score: 2 }[metric.kind];
  return value.toFixed(digits);
}

const metricByKey = (key) => GOLDEN_METRICS.find((m) => m.key === key);

/** The human view of one summary: one line per metric, one column per stratum
 * (overall first), then what each metric is. */
export function formatGoldenTable(summary) {
  const strata = Object.keys(summary.strata);
  const head = ["metric", ...strata];
  const body = [
    ["n", ...strata.map((s) => String(summary.strata[s].n))],
    ["listened", ...strata.map((s) => String(summary.strata[s].listened))],
    ...GOLDEN_METRICS.map((m) => [m.key, ...strata.map((s) => formatGoldenValue(m, summary.strata[s].metrics[m.key]))])
  ];
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  const out = [
    `golden ${summary.run}: ${summary.matched} of ${summary.rows} row(s) joined to ${summary.manifest}` +
      (summary.unmatched.length ? `; not in the manifest: ${summary.unmatched.map((id) => id ?? "(no promptId)").join(", ")}` : ""),
    line(head),
    line(widths.map((w) => "-".repeat(w))),
    ...body.map(line),
    "",
    `${ABSENT} = no row in that stratum carries it (never read as zero).`
  ];
  for (const m of GOLDEN_METRICS) out.push(`  ${m.key.padEnd(16)} ${m.label}`);
  return out.join("\n");
}

/** The five headline numbers, overall, one line each: exactly five lines per
 * run, each prefixed with the run id when more than one run is summarised. */
export function headlineLines(summaries) {
  const lines = [];
  for (const summary of summaries) {
    for (const h of HEADLINE) {
      const value = formatGoldenValue(metricByKey(h.key), summary.strata[OVERALL]?.metrics?.[h.key]);
      lines.push(`${summaries.length > 1 ? `${summary.run} ` : ""}${h.id} ${h.label}: ${value}`);
    }
  }
  return lines;
}

/**
 * better | worse | within-band | absent for one metric. 'absent' when either
 * side lacks the number, never 'better' (a metric that vanished did not
 * improve). Outside the band, the metric's direction decides.
 */
export function bandVerdict(metric, baseline, current) {
  const a = num(baseline);
  const b = num(current);
  if (a === null || b === null) return "absent";
  const band = GOLDEN_BANDS[metric.kind];
  const tolerance = band.relative !== undefined ? band.relative * Math.abs(a) : band.absolute;
  const delta = b - a;
  if (Math.abs(delta) <= tolerance + BAND_EPSILON) return "within-band";
  return (metric.better === "lower" ? delta < 0 : delta > 0) ? "better" : "worse";
}

/** The band as a person reads it: `±15%` or `±0.05`. */
export function bandLabel(metric) {
  const band = GOLDEN_BANDS[metric.kind];
  return band.relative !== undefined ? `±${Math.round(band.relative * 100)}%` : `±${band.absolute}`;
}

/**
 * The baseline a summary is compared against: the LAST golden-summary line of
 * the file (the file is append-only; the latest adopted run wins). Null when
 * the file holds none (it starts empty, until the live step commits the first
 * 50-prompt run). A line that is not a golden summary throws: a per-row
 * baseline.jsonl is not a golden baseline.
 */
export function readGoldenBaseline(file) {
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  let last = null;
  for (const [i, l] of lines.entries()) {
    let obj;
    try {
      obj = JSON.parse(l);
    } catch (err) {
      throw new Error(`${file}:${i + 1}: ${err.message}`);
    }
    if (!obj || obj.kind !== GOLDEN_SUMMARY) throw new Error(`${file}:${i + 1}: not a ${GOLDEN_SUMMARY} line`);
    last = obj;
  }
  return last;
}

/**
 * Every metric of every stratum either side has, compared: `{ stratum, metric,
 * baseline, current, band, verdict }`, overall first, then the strata in the
 * current summary's order, then any only the baseline has. A null baseline
 * (an empty file) makes every row 'absent'.
 */
export function compareGolden(current, baseline) {
  const strata = Object.keys(current.strata);
  for (const s of Object.keys(baseline?.strata || {})) if (!strata.includes(s)) strata.push(s);
  const out = [];
  for (const stratum of strata) {
    for (const m of GOLDEN_METRICS) {
      const a = num(baseline?.strata?.[stratum]?.metrics?.[m.key]);
      const b = num(current.strata[stratum]?.metrics?.[m.key]);
      out.push({ stratum, metric: m.key, baseline: a, current: b, band: bandLabel(m), verdict: bandVerdict(m, a, b) });
    }
  }
  return out;
}

/** The compare as a person reads it, with a note when the two sides ran
 * different manifests or the baseline is empty, and a tally at the end. */
export function formatCompare(current, baseline, results) {
  const out = [
    baseline
      ? `golden compare: ${current.run} against baseline ${baseline.run} (bands PROPOSED until re-derived from the noise floor)`
      : `golden compare: ${current.run}: the baseline holds no ${GOLDEN_SUMMARY} line yet, so every metric is absent`
  ];
  if (baseline && baseline.manifest_sha256 !== current.manifest_sha256) {
    out.push(`  note: the two runs used different golden manifests (${baseline.manifest} vs ${current.manifest}); a move may be the set, not the build`);
  }
  const width = Math.max(...results.map((r) => `${r.stratum}/${r.metric}`.length));
  for (const r of results) {
    const metric = metricByKey(r.metric);
    out.push(
      `  ${`${r.stratum}/${r.metric}`.padEnd(width)}  ${formatGoldenValue(metric, r.baseline).padStart(8)} -> ${formatGoldenValue(metric, r.current).padStart(8)}  ${r.band.padStart(5)}  ${r.verdict}`
    );
  }
  const tally = ["better", "worse", "within-band", "absent"].map((v) => `${v} ${results.filter((r) => r.verdict === v).length}`);
  out.push(`  ${tally.join(", ")}`);
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const args = {
    targets: [],
    format: "both",
    candidatesDir: null,
    segments: null,
    runId: null,
    append: null,
    wide: false,
    cards: null,
    listenKeys: null,
    scorecard: false,
    segmentSources: null,
    golden: null,
    headline: false,
    compare: null,
    failOnRegression: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format") args.format = argv[++i];
    else if (a === "--scorecard") args.scorecard = true;
    else if (a === "--segment-sources") args.segmentSources = argv[++i];
    else if (a === "--candidates") args.candidatesDir = argv[++i];
    else if (a === "--segments") args.segments = argv[++i];
    else if (a === "--run-id") args.runId = argv[++i];
    else if (a === "--append") args.append = argv[++i];
    else if (a === "--wide") args.wide = true;
    else if (a === "--cards") args.cards = argv[++i];
    else if (a === "--listen-keys") args.listenKeys = argv[++i];
    else if (a === "--golden") args.golden = argv[++i];
    else if (a === "--headline") args.headline = true;
    else if (a === "--compare") args.compare = argv[++i];
    else if (a === "--fail-on-regression") args.failOnRegression = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else args.targets.push(a);
  }
  if (!["both", "table", "jsonl"].includes(args.format)) throw new Error(`unknown --format ${args.format}`);
  if (args.targets.length === 0) throw new Error("usage: node tools/generation-bench/run.mjs <report.json|dir> [...]");
  if (args.runId && args.targets.length > 1) throw new Error("--run-id names one run; pass one report");
  /* GV-64: the golden views read a manifest; without one there is no stratum. */
  for (const [flag, on] of [["--headline", args.headline], ["--compare", args.compare !== null], ["--fail-on-regression", args.failOnRegression]]) {
    if (on && !args.golden) throw new Error(`${flag} needs --golden <manifest>`);
  }
  if (args.golden !== null && (typeof args.golden !== "string" || args.golden === "")) throw new Error("--golden needs a manifest path");
  if (args.compare !== null && (typeof args.compare !== "string" || args.compare === "")) throw new Error("--compare needs a golden-baseline.jsonl path");
  if (args.failOnRegression && args.compare === null) throw new Error("--fail-on-regression needs --compare <golden-baseline.jsonl>");
  return args;
}

export function collectRows(args) {
  const pool = loadSegmentPool(args.segments || path.join(REPO_ROOT, "data", "segments.json"));
  const listening = loadListening({
    cards: args.cards ? path.resolve(args.cards) : null,
    keyDir: args.listenKeys ? path.resolve(args.listenKeys) : null
  });
  /* GV-64: the golden aggregates average the scorecard's MQ rates, so a
     --golden run is always scored. */
  const scored = Boolean(args.scorecard || args.golden);
  /* GV-24: MQ-07 resolves a clip's show through the segment-sources registry. */
  const segmentSources = scored
    ? loadSegmentSources(args.segmentSources ? path.resolve(args.segmentSources) : path.join(REPO_ROOT, "data", "segment-sources.json"))
    : null;
  const rows = [];
  for (const target of args.targets) {
    rows.push(
      ...rowsForReport(resolveReportPath(target), {
        runId: args.runId,
        candidatesDir: args.candidatesDir,
        pool,
        listening,
        scorecard: scored,
        segmentSources
      })
    );
  }
  return rows;
}

/**
 * GV-64: the --golden views. Replaces the per-row output: the summary table
 * and/or one golden-summary line per run id (by --format), or, under
 * --headline, only the five headline numbers; then the --compare report.
 * `exitCode` is 0 whatever the compare found (rule 2), unless
 * --fail-on-regression and some metric is 'worse'.
 */
export function goldenMain(args, rows, out) {
  const manifest = loadGoldenManifest(path.resolve(args.golden));
  const summaries = goldenSummaries(rows, manifest);
  if (args.headline) {
    for (const line of headlineLines(summaries)) out(line);
  } else {
    if (args.format === "both" || args.format === "table") out(summaries.map(formatGoldenTable).join("\n\n"));
    if (args.format === "both") out("");
    if (args.format === "both" || args.format === "jsonl") for (const summary of summaries) out(goldenSummaryLine(summary));
  }
  const comparisons = [];
  if (args.compare !== null) {
    const baseline = readGoldenBaseline(path.resolve(args.compare));
    for (const summary of summaries) {
      const results = compareGolden(summary, baseline);
      comparisons.push({ run: summary.run, baseline: baseline ? baseline.run : null, results });
      out("");
      out(formatCompare(summary, baseline, results));
    }
  }
  const regressed = comparisons.some((c) => c.results.some((r) => r.verdict === "worse"));
  return { rows, summaries, comparisons, exitCode: args.failOnRegression && regressed ? 1 : 0 };
}

export function main(argv, out = console.log) {
  const args = parseArgs(argv);
  const rows = collectRows(args);
  if (args.golden) {
    const result = goldenMain(args, rows, out);
    if (args.append) {
      const file = path.resolve(args.append);
      fs.writeFileSync(file, spliceRows(fs.readFileSync(file, "utf8"), rows));
    }
    return result;
  }
  if (args.format === "both" || args.format === "table") out(formatTable(rows, { wide: args.wide, scorecard: args.scorecard }));
  if (args.format === "both") out("");
  if (args.format === "both" || args.format === "jsonl") for (const row of rows) out(jsonlLine(row));
  if (args.append) {
    const file = path.resolve(args.append);
    fs.writeFileSync(file, spliceRows(fs.readFileSync(file, "utf8"), rows));
  }
  return rows;
}

if (isEntryScript(import.meta.url)) {
  try {
    const result = main(process.argv.slice(2));
    /* GV-64: only --golden --compare --fail-on-regression ever exits 1. */
    if (result && !Array.isArray(result) && result.exitCode) process.exit(result.exitCode);
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(2);
  }
}
