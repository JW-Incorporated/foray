#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { runForayPipeline, RefusedPartialError, type NarrationActTiming, type RunPipelineOutcome } from "../generation/runPipeline";
import { FileTranscriptCueProvider } from "../generation/transcriptArchiveLookup";
import { FileTranscriptTextIndex, type TranscriptTextIndex } from "../generation/transcriptTextIndex";
import { checkpointFingerprint } from "../generation/checkpoint";
import { getUsageTotals } from "../generation/usageTracking";
import { FileCheckpointStore } from "./checkpointStore";
import type { GenerationRequest } from "../types/generation";
import type { PartialCandidate } from "../generation/partialCandidate";
import type { VeracityMetrics } from "../generation/veracityMetrics";
import type { PublishRecord } from "./publishForay";
import { env } from "../config/env";
import { modelSummary } from "../config/models";
import { BudgetStopError, defaultBudgetGuard } from "../cost/budgetGuard";

/**
 * The batch driver: N prompts in, N candidate Forays out.
 *
 * WHY A BATCH CLI AND NOT JUST THE SINGLE-RUN ONE. `generateForay.ts` (§4.0-4.1)
 * and `publishForay.ts` (§4.9) meet at opposite ends of the pipeline with a
 * founder in between; `runForayPipeline` closed that gap for ONE Foray. Making
 * a lot of them needs three more things that belong in a driver rather than in
 * the pipeline: a queue it can resume, a budget it stops at, and a per-prompt
 * outcome record so a failure is one line in a report instead of the end of the
 * run.
 *
 * IT WRITES CANDIDATES, IT DOES NOT PUBLISH. Every run produces one JSON file
 * per Foray in the output directory, in exactly `publishForay.ts`'s input shape,
 * plus a `report.json`. Publishing stays a separate, per-Foray, founder-reviewed
 * step — `docs/curation/generation-architecture.md` §1.3's phase 1 rule, and the
 * reason `publishForay.ts` applies a `hold` label. A batch driver that also
 * merged its own output would turn a review gate into a rubber stamp.
 *
 * RESUMABLE BY CONSTRUCTION, AT THREE GRAINS.
 *
 *   BETWEEN Forays: a prompt whose candidate file already exists is skipped,
 *   so re-running after a crash, a budget stop, or a rate limit costs nothing
 *   for the work already done. That is also why `runForayPipeline` is
 *   deterministic given a fixed clock: the skip is keyed on the prompt, and a
 *   retry must not mint a second id for the same work.
 *
 *   WITHIN one Foray (F-17/F-18, added after generation run 2026-09-09): every
 *   stage's output is written to `<out>/<candidate-basename>.checkpoint.json`
 *   as soon as it exists, and a re-run resumes at the first stage that never
 *   finished. The between-Forays skip alone was not enough, and the run said
 *   so in numbers: attempt 4 ran 2 h 35 m, finished 22 of 31 beats, failed on
 *   beat 23, wrote no candidate — and so a re-run started again at the clarity
 *   check. The checkpoint is deleted the moment the candidate is written; the
 *   candidate is the resume record from then on.
 *
 *   WITHOUT A PERSON (G-30, `docs/curation/foray-to-spec-roadmap.md` §1.5 steps
 *   9, 10, 24, 25, 26). The two grains above made a resume CHEAP; until G-30 a
 *   resume still needed a person to notice the run had died and type the
 *   command again. The latency brief (§4) counted that as manual step 9, and
 *   the rule it applies is the founder's: every step a person or an
 *   orchestrating session does by hand is a defect. So the driver now
 *   resumes itself from the checkpoint on a transient failure — a transport
 *   timeout (I-27's "Request timed out." on the relay), a 5xx/429, a daily
 *   budget window — up to `--max-resumes` times with backoff; ends a run with a
 *   NAMED reason when the partial candidate is refused (step 10) instead of a
 *   person watching for it; runs a shell hook with a one-line summary at the
 *   end (step 24, I-15's lost completion signal); and suffixes a duplicate id
 *   rather than throwing on it (step 25). All of it is recorded in
 *   `report.json` so nothing the driver did on its own is invisible afterwards.
 *
 * Usage:
 *   npm run generate-forays -- --prompts prompts.json [--out data-local/foray-candidates]
 *                              [--duration short|medium|long] [--limit N]
 *                              [--budget-usd N] [--no-resume] [--dry-run]
 *                              [--max-resumes N] [--continue-on-refused-partial]
 *                              [--notify <command>]
 *
 * `prompts.json` is either a JSON array of strings, or of
 * `{ prompt, duration?, topic? }` objects when a prompt needs its taxonomy node
 * pinned by hand rather than resolved.
 */

interface PromptSpec {
  prompt: string;
  duration?: "short" | "medium" | "long";
  topic?: string;
}

/** G-30 (a): how many times one prompt resumes itself before the driver
 * gives up and records `resumes-exhausted`. Three covers I-27's shape (one
 * dead answering session, one relay timeout, one retry) without letting a
 * persistently broken transport burn a day of backoff. */
export const DEFAULT_MAX_RESUMES = 3;

export interface CliArgs {
  prompts: string | null;
  out: string;
  duration: "short" | "medium" | "long";
  limit: number | null;
  dryRun: boolean;
  authorId: string;
  /**
   * Per-run spend ceiling in USD (F-04 / I-01). Null means "use the
   * environment's caps", which is the normal case. Given a number, it becomes
   * BOTH the per-Foray and the daily ceiling for this process — the two must
   * move together, because generation calls are not tier-prefixed and so are
   * scored tier 1, whose cutoff is the whole daily budget: raising only the
   * per-Foray cap would just move the stop to the daily one.
   */
  budgetUsd: number | null;
  /** Ignore any checkpoint on disk and rebuild every stage (F-17/F-18). */
  noResume: boolean;
  /** G-30 (a): automatic resumes per prompt on a transient failure; `0` turns
   * the loop off and restores "checkpoint kept — re-run to resume". */
  maxResumes: number;
  /** G-30 (b): keep going past a refused partial candidate instead of ending
   * the run with `refused-partial`. Off by default (D4's interim policy). */
  continueOnRefusedPartial: boolean;
  /** G-30 (c): a shell command run with a one-line summary at every prompt's
   * end and at the batch's end (or crash). `--notify` or `GENERATION_NOTIFY_CMD`. */
  notify: string | null;
}

export function parseArgs(argv: string[], envVars: NodeJS.ProcessEnv = process.env): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const d = get("--duration");
  const limitRaw = get("--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
  const budgetRaw = get("--budget-usd");
  const budget = budgetRaw === undefined ? NaN : Number(budgetRaw);
  const maxResumesRaw = get("--max-resumes");
  const maxResumes = maxResumesRaw === undefined ? NaN : Number.parseInt(maxResumesRaw, 10);
  /* The env fallback exists so a detached run (a service, a cron line, a
     relay session) carries its hook without anyone editing the command line;
     an explicit flag wins over it. */
  const notifyEnv = envVars.GENERATION_NOTIFY_CMD?.trim();
  return {
    prompts: get("--prompts") ?? null,
    out: get("--out") ?? path.join("data-local", "foray-candidates"),
    duration: d === "short" || d === "medium" || d === "long" ? d : "short",
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    dryRun: argv.includes("--dry-run"),
    authorId: get("--author") ?? "founder-1",
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null,
    noResume: argv.includes("--no-resume"),
    maxResumes: Number.isInteger(maxResumes) && maxResumes >= 0 ? maxResumes : DEFAULT_MAX_RESUMES,
    continueOnRefusedPartial: argv.includes("--continue-on-refused-partial"),
    notify: get("--notify") ?? (notifyEnv ? notifyEnv : null)
  };
}

/** Accepts both file shapes; a bare string is the common case. */
export function normalizePrompts(raw: unknown): PromptSpec[] {
  if (!Array.isArray(raw)) {
    throw new Error("prompts file must contain a JSON array of strings or {prompt,...} objects");
  }
  return raw.map((entry, i) => {
    if (typeof entry === "string") return { prompt: entry };
    if (entry && typeof entry === "object" && typeof (entry as PromptSpec).prompt === "string") {
      return entry as PromptSpec;
    }
    throw new Error(`prompts[${i}] is neither a string nor an object with a "prompt" string`);
  });
}

/** Filesystem-safe, stable per prompt — this is the resume key. */
export function candidateFilename(prompt: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node builtin, sync by design
  const { createHash } = require("crypto") as typeof import("crypto");
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  const hash = createHash("sha1").update(prompt).digest("hex").slice(0, 8);
  return `${slug || "prompt"}-${hash}.json`;
}

/** WS-D2's partial-candidate file, next to `candidateFilename`'s own file and
 * keyed the same way (same slug+hash, so a reader can find both without a
 * lookup table). `readPartialCandidate` (`generationStatus.ts`) is the
 * counterpart that reads this back for a status request. */
export function partialCandidateFilename(prompt: string): string {
  return candidateFilename(prompt).replace(/\.json$/, ".partial.json");
}

/** One line per prompt, so a 200-prompt run reads as a table and not a log. */
export function summarize(outcome: RunPipelineOutcome): string {
  switch (outcome.outcome) {
    case "rejected":
      return `REJECTED (${outcome.category}) — ${outcome.explanation}`;
    case "needs-clarification":
      return `AMBIGUOUS — ${outcome.question}`;
    case "unresolved-topic":
      return `NO TOPIC — nearest: ${outcome.candidates.slice(0, 3).map((c) => c.id).join(", ") || "(none)"}`;
    case "no-tape":
      /* F-65: every beat degraded to narration, so §4.9 would refuse the Foray
         and the run stopped before narrating it. The per-slot lines name the
         top reason each slot lost its tape. */
      return `NO TAPE — every beat sourced to narration; ${outcome.sourcing.join(" | ")}`;
    case "generated":
      return outcome.result.validation.ok
        ? `OK ${outcome.input.id} (${outcome.input.items.length} items, ${outcome.input.runtimeSec}s)`
        : `INVALID ${outcome.input.id} — ${outcome.result.validation.checkForaysErrors.slice(0, 2).join("; ")}`;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   G-30 (a): what the driver may resume from on its own, and how long it waits.
   ──────────────────────────────────────────────────────────────────────────── */

/** How a thrown pipeline error is handled by the resume loop. */
export type FailureKind =
  /** Transport or upstream trouble that a later attempt can clear: a timeout,
   * a connection reset, a 5xx, a 429/overloaded reply. Resumed with backoff. */
  | "transient"
  /** The DAILY budget cap (manual step 26): resumed when the local day rolls
   * over, because that is when `BudgetGuard`'s window resets. */
  | "budget-window"
  /** The PER-FORAY cap: not resumable — the same Foray would trip it again;
   * raising the cap is a decision, not a retry. */
  | "budget-stop"
  /** `RefusedPartialError` (manual step 10): the named abort. */
  | "refused-partial"
  /** Everything else: a bug, a bad fixture, a schema mismatch. Not retried —
   * repeating a deterministic failure three times is three times the cost. */
  | "fatal";

export interface FailureClass {
  kind: FailureKind;
  reason: string;
}

/** The message shapes the Anthropic SDK, Node's fetch/undici and the test-drive
 * relay produce for trouble that is not the pipeline's fault. Kept to NAMED
 * conditions — no bare "5\d\d" number match, which would read "beat 523" as a
 * server error. Status codes are checked as numbers on the error object. */
const TRANSIENT_MESSAGE =
  /request timed out|timed? ?out|connection error|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|overloaded|rate[ _-]?limit|too many requests|internal server error|bad gateway|service unavailable|gateway time-?out/i;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Classifies a pipeline failure for the resume loop. Walks `cause`, for the
 * same reason `findBudgetError` does: §4.4 wraps an act's failure in its own
 * `ActDeepeningError`, and a relay timeout inside act 2 must still read as a
 * timeout. */
export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof RefusedPartialError) return { kind: "refused-partial", reason: err.message };
  if (err instanceof BudgetStopError) {
    return { kind: err.scope === "daily" ? "budget-window" : "budget-stop", reason: err.message };
  }
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    const e = current as { message?: unknown; status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown; cause?: unknown };
    const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : null;
    if (status !== null && (status === 408 || status === 429 || status >= 500)) {
      return { kind: "transient", reason: `HTTP ${status}: ${errorMessage(err)}` };
    }
    const text = [e.name, e.code, e.message].filter((s): s is string => typeof s === "string").join(" ");
    if (TRANSIENT_MESSAGE.test(text)) return { kind: "transient", reason: errorMessage(err) };
    current = e.cause;
  }
  return { kind: "fatal", reason: errorMessage(err) };
}

/** 30 s, 60 s, 120 s, … capped at 10 min. The floor is deliberately not
 * seconds: on the relay a timeout means the answering session is gone
 * (I-27), and hammering an empty queue three times in a minute just spends
 * the resume budget without giving anything time to come back. */
export function resumeBackoffMs(resumeIndex: number): number {
  return Math.min(30_000 * 2 ** resumeIndex, 600_000);
}

/** Until the next local midnight plus a minute — `startOfLocalDayIso` is the
 * window `BudgetGuard` sums against, so that is exactly when a daily stop
 * clears (manual step 26). */
export function msUntilNextLocalDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now.getTime() + 60_000;
}

/** One automatic resume, as recorded in `report.json`. */
export interface ResumeRecord {
  /** 1-based: the Nth resume of this prompt. */
  attempt: number;
  kind: "transient" | "budget-window";
  reason: string;
  waitedMs: number;
  /** ISO time the wait began. */
  at: string;
}

/** The named reasons a run ends without a pipeline outcome (G-30 b). A plain
 * bug still lands as `outcome: "error"`, exactly as before. */
export type AbortReason = "refused-partial" | "budget-stop" | "resumes-exhausted";

/* ────────────────────────────────────────────────────────────────────────────
   G-30 (c): the completion hook. A shell command, not a service — the
   transport (a `gh issue comment`, a curl, an `echo >> log`) is the operator's
   to choose, and the driver's only job is to run it once with the facts.
   ──────────────────────────────────────────────────────────────────────────── */

export interface NotifySummary {
  /** `built`, `invalid`, `aborted:<reason>`, `error`, `crashed`, `batch-done`,
   * or a pipeline stop (`rejected`, `no-tape`, …). */
  outcome: string;
  id: string | null;
  minutes: number;
  calls: number;
  detail: string;
}

export interface NotificationResult {
  command: string;
  /** The exact line the hook was given. */
  summary: string;
  /** The hook's exit code; `null` when it could not be started or timed out. */
  exitCode: number | null;
  error?: string;
}

/** The one line a hook receives: on stdin, and as `FORAY_NOTIFY_SUMMARY`. */
export function summaryLine(s: NotifySummary): string {
  return `foray-generation ${s.outcome} id=${s.id ?? "-"} minutes=${s.minutes.toFixed(1)} calls=${s.calls} — ${s.detail}`;
}

/**
 * Runs `command` through the shell with the summary on stdin and in the
 * environment (`FORAY_NOTIFY_SUMMARY`, `_OUTCOME`, `_ID`, `_MINUTES`, `_CALLS`,
 * `_DETAIL`). NEVER throws and never rejects: a hook that fails must not take
 * the run's report down with it — its failure is the report's to carry.
 */
export function runNotifyHook(
  command: string,
  summary: NotifySummary,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<NotificationResult> {
  const line = summaryLine(summary);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: NotificationResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      /* The operator's own --notify / GENERATION_NOTIFY_CMD command — a shell
         hook by design, the same trust `publishForay.ts` puts in `gh`. */
      const child = spawn(command, {
        shell: true,
        env: {
          ...(opts.env ?? process.env),
          FORAY_NOTIFY_SUMMARY: line,
          FORAY_NOTIFY_OUTCOME: summary.outcome,
          FORAY_NOTIFY_ID: summary.id ?? "",
          FORAY_NOTIFY_MINUTES: summary.minutes.toFixed(1),
          FORAY_NOTIFY_CALLS: String(summary.calls),
          FORAY_NOTIFY_DETAIL: summary.detail
        },
        stdio: ["pipe", "inherit", "inherit"]
      });
      const timer = setTimeout(() => {
        child.kill();
        done({ command, summary: line, exitCode: null, error: `notify hook timed out after ${timeoutMs} ms` });
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        done({ command, summary: line, exitCode: null, error: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ command, summary: line, exitCode: code });
      });
      /* A hook that never reads stdin closes it early; the resulting EPIPE
         must not surface as an unhandled error on the driver. */
      child.stdin.on("error", () => undefined);
      child.stdin.end(`${line}\n`);
    } catch (err) {
      done({ command, summary: line, exitCode: null, error: errorMessage(err) });
    }
  });
}

/** One row of `report.json`. `veracity` is WS-B's per-candidate metric block
 * and `ttlA1Ms` is WS-D2's time-to-first-listen; both are optional because
 * neither exists for a rejected, ambiguous or errored prompt. */
export type ReportEntry = {
  prompt: string;
  outcome: string;
  detail: string;
  ms: number;
  file?: string;
  ttlA1Ms?: number | null;
  /** G-32: the act-concurrency cap the run narrated under
   * (`NARRATION_ACT_CONCURRENCY`, default 4) and one `narrate:<i>` timing per
   * act, so overlap is visible in the report. Only on a `generated` outcome. */
  narrationConcurrency?: number;
  narrationActs?: NarrationActTiming[];
  veracity?: VeracityMetrics;
  /** Written by `publishForay.ts --report` once the candidate has a PR — the
   * PR, the `origin/main` sha it was cut from, and the deploy id it shipped in
   * (`null` until known; the id is minted by the deploy after the merge). */
  publish?: PublishRecord;
  /** G-30 (a): every automatic resume this prompt took, in order. Absent when
   * the first attempt was the only one. */
  resumes?: ResumeRecord[];
  /** G-30 (b): why the run ended without an outcome, when `outcome` is
   * `"aborted"`. */
  abort?: { reason: AbortReason; detail: string };
  /** G-30 (b): act indices whose partial candidate was refused while the run
   * was told to continue (`--continue-on-refused-partial`). The report says
   * so even when the finished Foray then passed. */
  refusedPartials?: number[];
  /** G-30 (c): model calls across every attempt of this prompt. */
  calls?: number;
  /** G-30 (c): what the notification hook returned, when one was configured. */
  notification?: NotificationResult;
};

/**
 * One prompt's worth of `main()`'s loop body, extracted so a test can drive
 * it directly — same reason `parseArgs`/`normalizePrompts`/`candidateFilename`
 * are already exported. `deps.runPipeline` defaults to the real
 * `runForayPipeline`; `deps.onPartialWrite` is a TEST-ONLY hook (no
 * production caller passes it) fired synchronously right after each partial
 * write lands on disk, so a test can assert on the file's on-disk content at
 * the exact moment WS-D2's "rewrites it on each act" happens, rather than
 * only at the very end once (on success) the partial file has already been
 * cleaned up. `deps.sleep`/`deps.now` are the resume loop's clocks, injected
 * so a test can prove a day-long budget wait without taking a day; `deps.notify`
 * replaces the shell hook for the same reason.
 */
export async function generateOneCandidate(
  spec: PromptSpec,
  args: CliArgs,
  deps: {
    cueProvider: FileTranscriptCueProvider;
    /* WS-H (F-06): tier 2’s transcript-TEXT candidate search. Optional for the
       same reason `runPipeline` is — a caller that supplies none (every test that
       predates it) leaves tier 2 on the title path, unchanged. */
    textIndex?: TranscriptTextIndex;
    runPipeline?: typeof runForayPipeline;
    onPartialWrite?: (candidate: PartialCandidate, partialFile: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
    notify?: (summary: NotifySummary) => Promise<NotificationResult>;
  }
): Promise<{ skipped: boolean; entry?: ReportEntry; file?: string }> {
  const runPipeline = deps.runPipeline ?? runForayPipeline;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const notify = deps.notify ?? (args.notify ? (summary: NotifySummary) => runNotifyHook(args.notify!, summary) : undefined);
  const basename = candidateFilename(spec.prompt);
  const file = path.join(path.resolve(args.out), basename);
  if (fs.existsSync(file)) {
    console.log(`  skip   ${spec.prompt.slice(0, 60)} (already built)`);
    return { skipped: true, file };
  }

  const request: GenerationRequest = {
    prompt: spec.prompt,
    duration: spec.duration ?? args.duration,
    author_id: args.authorId,
    visibility: "catalogue"
  };

  /* F-17/F-18. The skip above is the OUTER resume — a prompt whose candidate
     exists costs nothing — and it is unchanged. This is the inner one: a
     prompt whose candidate does NOT exist because the run died at beat 23 of
     31 still has 22 beats on disk, and this is what hands them back. The
     checkpoint key is the candidate's basename minus `.json`, so the two
     files sit side by side and a human can see which prompt a half-finished
     run belongs to. */
  const checkpointKey = basename.replace(/\.json$/, "");
  const checkpointStore = new FileCheckpointStore(
    path.resolve(args.out),
    checkpointFingerprint({ prompt: spec.prompt, duration: request.duration, topic: spec.topic })
  );
  if (args.noResume) checkpointStore.discard(checkpointKey);
  const resumable = !args.noResume && checkpointStore.load(checkpointKey) !== null;
  if (resumable) {
    const stages = Object.keys(checkpointStore.load(checkpointKey)!.stages);
    console.log(`  resume ${spec.prompt.slice(0, 60)} — ${stages.length} stage(s) already done: ${stages.join(", ")}`);
  }

  /* WS-D2 (docs/curation/generation-fix-plan-2026-09-09.md, "D2 (streaming
     publish)"): "generateForays writes the partial file and rewrites it on
     each act." The partial file lives next to the eventual candidate file and
     the checkpoint, under the SAME resumable-batch directory this CLI already
     writes to — no new location, no `data/`/`data-local/` write this CLI
     didn't already make. `--dry-run` writes nothing here either, matching the
     final-candidate and checkpoint paths' own `--dry-run` behaviour below —
     but the callback is still supplied (G-30), so the partial GATE runs and a
     refused act aborts a dry run exactly as it aborts a real one.

     NOTHING IS WRITTEN FOR AN ACT WHOSE STITCH IS ALREADY CHECKPOINTED:
     `runPipeline.ts` fires `onActReady` from inside a `stitch:<i>` stage (one
     per act since F-66), which a resume skips. A run that resumes act 1's
     stitch therefore has `ttlA1Ms` `null` too, for the same reason — see that
     module's own comment. */
  const partialFile = path.join(path.resolve(args.out), partialCandidateFilename(spec.prompt));
  const refusedPartials: number[] = [];
  let lastPartialId: string | null = null;
  const onActReady = (candidate: PartialCandidate): void => {
    lastPartialId = candidate.id;
    if (!candidate.validation.ok) refusedPartials.push(candidate.acts.filter((a) => a.status === "ready").length - 1);
    if (args.dryRun) return;
    fs.writeFileSync(partialFile, `${JSON.stringify(candidate, null, 2)}\n`);
    deps.onPartialWrite?.(candidate, partialFile);
  };
  /* The partial is discarded wherever the CHECKPOINT is, and kept wherever the
     checkpoint is kept — the two answer the same question ("is there more to
     do for this prompt?") and must not disagree. Best-effort: the absence of a
     file this run never wrote is not an error. */
  const discardPartial = (): void => {
    try {
      fs.unlinkSync(partialFile);
    } catch {
      /* nothing to clean up — fine */
    }
  };

  /* G-30 (c): the facts the hook gets. Wall time is the driver's own clock
     across every attempt AND every wait, because that is what "how long did
     this take" means to whoever reads the notification; `ms` on the entry
     stays the pipeline's own stage sum, as before. */
  const startedMs = Date.now();
  let calls = 0;
  const finishEntry = async (entry: ReportEntry, notifyOutcome: string, id: string | null): Promise<ReportEntry> => {
    const withCalls: ReportEntry = { ...entry, calls };
    if (!notify) return withCalls;
    const notification = await notify({
      outcome: notifyOutcome,
      id,
      minutes: (Date.now() - startedMs) / 60_000,
      calls,
      detail: entry.detail
    });
    return { ...withCalls, notification };
  };

  /* G-30 (a): the resume loop. Each attempt re-opens the same checkpoint, so
     a resumed attempt pays only for the stages that had not finished — the
     driver is doing, in-process and with backoff, exactly what "re-run to
     resume" asked a person to do. */
  const resumes: ResumeRecord[] = [];
  let outcome: RunPipelineOutcome;
  for (;;) {
    try {
      /* The machine this driver runs on holds the transcript bodies (data-local/,
         gitignored), so §4.5 tier 2 gets the real cue provider. On a checkout
         without them the provider returns null for every episode and the run
         behaves exactly as before — pool segments only. */
      outcome = await runPipeline(
        request,
        /* `sessionId` is what turns EPISODE_BUDGET_USD on: `BudgetGuard.checkAndRecord`
           only compares a Foray's own spend against the per-Foray cap when the call
           carries one (`budgetGuard.ts`), and this driver passed none — so the cap
           requirements §8.10 specifies was inert in the batch path, the only path
           that generates anything. The checkpoint key (the candidate's basename) is
           the right value: one key per Foray, stable across a resume, and already
           the name a human reads when a run stops. */
        {
          userId: args.authorId,
          topic: spec.topic,
          checkpointKey,
          sessionId: checkpointKey,
          refusedPartial: args.continueOnRefusedPartial ? "continue" : "abort"
        },
        { cueProvider: deps.cueProvider, textIndex: deps.textIndex, checkpoint: args.dryRun ? undefined : checkpointStore, onActReady }
      );
      calls += getUsageTotals().calls;
      break;
    } catch (err) {
      calls += getUsageTotals().calls;
      const failure = classifyFailure(err);
      const detail = failure.reason;
      const checkpointNote = args.dryRun ? "" : ` (checkpoint kept at ${checkpointStore.filePathFor(checkpointKey)})`;

      if (failure.kind === "transient" || failure.kind === "budget-window") {
        if (resumes.length < args.maxResumes) {
          const waitMs = failure.kind === "budget-window" ? msUntilNextLocalDay(now()) : resumeBackoffMs(resumes.length);
          resumes.push({ attempt: resumes.length + 1, kind: failure.kind, reason: detail.slice(0, 300), waitedMs: waitMs, at: now().toISOString() });
          console.log(
            `  retry  ${spec.prompt.slice(0, 60)} — resume ${resumes.length}/${args.maxResumes} in ${Math.round(waitMs / 1000)}s ` +
              `after ${failure.kind}: ${detail.slice(0, 120)}`
          );
          await sleep(waitMs);
          continue;
        }
        /* One prompt's failure must not end the batch — a rate limit on
           prompt 7 should still leave prompts 1-6 on disk and prompt 8
           attempted. The error is recorded, not swallowed. */
        console.log(`  ABORT  ${spec.prompt.slice(0, 60)} — resumes exhausted (${args.maxResumes}) after ${failure.kind}: ${detail.slice(0, 120)}${checkpointNote}`);
        const entry: ReportEntry = {
          prompt: spec.prompt,
          outcome: "aborted",
          detail: `ABORTED (resumes-exhausted) — ${detail}`,
          ms: 0,
          abort: { reason: "resumes-exhausted", detail },
          resumes
        };
        return { skipped: false, entry: await finishEntry(entry, "aborted:resumes-exhausted", lastPartialId) };
      }

      if (failure.kind === "refused-partial" || failure.kind === "budget-stop") {
        /* Not truncated for a budget stop: its message is the whole point (F-04)
           and cutting it removes the spend and the resume instruction, which is
           exactly the half a person needs. The refused partial's message names
           the act and the checker's errors for the same reason. */
        console.log(`  ABORT  ${spec.prompt.slice(0, 60)} — ${failure.kind}: ${detail}${checkpointNote}`);
        const entry: ReportEntry = {
          prompt: spec.prompt,
          outcome: "aborted",
          detail: `ABORTED (${failure.kind}) — ${detail}`,
          ms: 0,
          abort: { reason: failure.kind, detail },
          ...(resumes.length ? { resumes } : {}),
          ...(refusedPartials.length ? { refusedPartials } : {})
        };
        return { skipped: false, entry: await finishEntry(entry, `aborted:${failure.kind}`, lastPartialId) };
      }

      console.log(`  ERROR  ${spec.prompt.slice(0, 60)} — ${detail.slice(0, 120)}${checkpointNote}`);
      const entry: ReportEntry = { prompt: spec.prompt, outcome: "error", detail, ms: 0, ...(resumes.length ? { resumes } : {}) };
      return { skipped: false, entry: await finishEntry(entry, "error", lastPartialId) };
    }
  }

  const ms = outcome.timings.reduce((sum, t) => sum + t.ms, 0);
  const line = summarize(outcome);
  const ttlA1Ms = outcome.outcome === "generated" ? outcome.ttlA1Ms : null;
  console.log(
    `  ${outcome.outcome === "generated" ? "built " : "stop  "} ${spec.prompt.slice(0, 60)} — ${line}` +
      (ttlA1Ms != null ? ` (ttlA1=${ttlA1Ms}ms)` : "") +
      (refusedPartials.length ? ` [partial refused at act ${refusedPartials.map((i) => i + 1).join(", ")}; continued]` : "")
  );

  /* WS-B: `meta.veracity` rides along on `outcome.input` for every
     "generated" outcome (`runPipeline.ts` attaches it before finalize
     runs, win or lose) — carried into `report.json` here so a candidate
     that FAILED check-forays/check-narration still shows why the
     veracity numbers looked the way they did, not just candidates that
     made it to disk. */
  const veracity = outcome.outcome === "generated" ? outcome.input.meta?.veracity : undefined;
  const entry: ReportEntry = {
    prompt: spec.prompt,
    outcome: outcome.outcome,
    detail: line,
    ms,
    ttlA1Ms,
    ...(outcome.outcome === "generated"
      ? { narrationConcurrency: outcome.narration.concurrency, narrationActs: outcome.narration.acts }
      : {}),
    veracity,
    ...(resumes.length ? { resumes } : {}),
    ...(refusedPartials.length ? { refusedPartials } : {})
  };
  const id = outcome.outcome === "generated" ? outcome.input.id : lastPartialId;
  if (outcome.outcome === "generated" && outcome.result.validation.ok) {
    if (!args.dryRun) {
      fs.writeFileSync(file, `${JSON.stringify(outcome.input, null, 2)}\n`);
      /* The candidate now IS the resume record — the outer skip above will
         see it. A checkpoint left beside a finished candidate is only a trap
         for the next reader, and so is the partial candidate: its job (letting
         the requesting listener start early) is done the moment the whole
         Foray exists, and leaving it would just be a second, staler copy of
         the same content in the output directory. */
      checkpointStore.discard(checkpointKey);
      discardPartial();
    }
    const finished = await finishEntry({ ...entry, file: args.dryRun ? undefined : file }, "built", id);
    return { skipped: false, entry: finished, file };
  }
  /* A rejected or clarification-needing prompt is TERMINAL: re-running it
     unchanged produces the same answer, and a changed prompt has a
     different fingerprint and so a different checkpoint. Leaving the file
     behind would litter the output directory with checkpoints no run will
     ever resume. A validation failure is NOT terminal — the stages are
     sound and the checkers refused the assembly — so that one keeps its
     checkpoint (and its partial) and the re-run pays only for what it must. */
  if (!args.dryRun && outcome.outcome !== "generated") {
    checkpointStore.discard(checkpointKey);
    discardPartial();
  }
  return { skipped: false, entry: await finishEntry(entry, outcome.outcome === "generated" ? "invalid" : outcome.outcome, id) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompts) {
    console.error(
      "Usage: npm run generate-forays -- --prompts prompts.json [--out DIR] " +
        "[--duration short|medium|long] [--limit N] [--budget-usd N] [--no-resume] [--dry-run] " +
        "[--max-resumes N] [--continue-on-refused-partial] [--notify <command>]"
    );
    process.exitCode = 1;
    return;
  }
  const batchStartedMs = Date.now();

  try {
    /* F-04. Run 1 could only be started by setting DAILY_BUDGET_USD=1000 in the
       environment, and the run log had to record that as an intervention (I-01)
       because there was no way to say "this run may spend N" on the command
       line. Both caps move together: generation calls are not tier-prefixed, so
       BudgetGuard scores them tier 1, whose cutoff is the whole daily budget —
       raising only the per-Foray ceiling would just move the stop. */
    if (args.budgetUsd !== null) {
      defaultBudgetGuard.setCaps({ dailyUsd: args.budgetUsd, episodeUsd: args.budgetUsd });
    }

    const specs = normalizePrompts(JSON.parse(fs.readFileSync(path.resolve(args.prompts), "utf8")));
    const queue = args.limit ? specs.slice(0, args.limit) : specs;

    /* State the mode before doing anything expensive. A run that silently used
       stubs and produced 200 placeholder Forays would look exactly like a
       successful run until someone listened to one. */
    const caps = defaultBudgetGuard.caps();
    console.log(
      env.anthropicDryRun
        ? `MODE: dry-run (no ANTHROPIC_API_KEY) — stub builders, $0, output is structurally real but editorially empty.`
        : `MODE: live — Anthropic builders, metered by BudgetGuard (daily $${caps.dailyUsd}, per-Foray $${caps.episodeUsd}).`
    );
    /* Which models a run ACTUALLY used, printed rather than assumed: F-03 was
       found by reading source, which is not where a run's behaviour should have
       to be looked up. */
    if (!env.anthropicDryRun) {
      const models = modelSummary();
      console.log(`MODELS: opus=${models.opus} sonnet=${models.sonnet} haiku=${models.haiku}`);
    }
    /* G-30: the hands-free policy, stated up front for the same reason the
       mode is — a run that quietly aborted on its first refused partial, or
       quietly slept until midnight, should not be a surprise in the log. */
    console.log(
      `POLICY: max-resumes=${args.maxResumes}, refused partial → ${args.continueOnRefusedPartial ? "continue" : "abort"}, ` +
        `notify=${args.notify ? JSON.stringify(args.notify) : "(none)"}`
    );
    console.log(`${queue.length} prompt(s); writing candidates to ${args.out}`);

    fs.mkdirSync(path.resolve(args.out), { recursive: true });

    const report: ReportEntry[] = [];
    let generated = 0;
    let skipped = 0;
    const cueProvider = new FileTranscriptCueProvider();
    /* WS-H (F-06): the same machine holds the transcript BODIES, so tier 2 also
       gets the text index built over them — read through the cue provider above,
       cached under data-local/transcripts/index/. A checkout without data-local/
       builds nothing, returns no candidates, and leaves tier 2 on the title path. */
    const textIndex = new FileTranscriptTextIndex({ bodies: cueProvider });

    for (const spec of queue) {
      const result = await generateOneCandidate(spec, args, { cueProvider, textIndex });
      if (result.skipped) {
        skipped++;
        continue;
      }
      if (result.entry) {
        report.push(result.entry);
        if (result.file) generated++;
      }
    }

    /* Count what actually happened, not what the outcome tag says. A run that
       reached §4.9 and FAILED validation still carries `outcome: "generated"` —
       the pipeline generated something and the checkers refused it. The first
       end-to-end run printed "0 did not produce a Foray" while producing zero
       publishable candidates, which is the wrong number to put in front of
       someone deciding whether the batch worked. */
    const publishable = report.filter((r) => r.detail.startsWith("OK ")).length;
    const aborts = report.filter((r) => r.outcome === "aborted").length;
    const resumesTotal = report.reduce((sum, r) => sum + (r.resumes?.length ?? 0), 0);
    const callsTotal = report.reduce((sum, r) => sum + (r.calls ?? 0), 0);

    const reportPath = path.join(path.resolve(args.out), "report.json");
    const writeReport = (notification: NotificationResult | null): void => {
      if (args.dryRun) return;
      fs.writeFileSync(
        reportPath,
        `${JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            dry_run: false,
            /* G-30 (e): the policy the run had and what the driver did on its
               own under it, so a reader can tell "three resumes" from "three
               attempts by hand". */
            max_resumes: args.maxResumes,
            continue_on_refused_partial: args.continueOnRefusedPartial,
            resumes: resumesTotal,
            aborts,
            notify: args.notify,
            notification,
            entries: report
          },
          null,
          2
        )}\n`
      );
    };
    /* Written BEFORE the hook runs, so a hook that reads report.json sees the
       finished batch; rewritten after, so the report carries the hook's result. */
    writeReport(null);

    const summaryText =
      `${generated} candidate(s) written, ${skipped} skipped, ${aborts} aborted, ` +
      `${report.length - publishable} did not produce a publishable Foray` +
      (resumesTotal ? `; ${resumesTotal} automatic resume(s)` : "");
    console.log(`\n${summaryText}.`);

    let notification: NotificationResult | null = null;
    if (args.notify) {
      notification = await runNotifyHook(args.notify, {
        outcome: "batch-done",
        id: null,
        minutes: (Date.now() - batchStartedMs) / 60_000,
        calls: callsTotal,
        detail: summaryText
      });
      if (notification.exitCode !== 0) {
        console.log(`NOTIFY: hook ${notification.error ? `failed (${notification.error})` : `exited ${notification.exitCode}`}`);
      }
      writeReport(notification);
    }

    if (!args.dryRun) {
      console.log(`Report: ${reportPath}`);
      console.log(`Publish one with: npm run publish-foray -- --input <candidate>.json`);
    }
  } catch (err) {
    /* G-30 (c): a crash is the one outcome I-15 lost entirely — the shell
       died and nothing said so. The hook fires for it too, then the process
       exits non-zero as before. */
    console.error(err);
    process.exitCode = 1;
    if (args.notify) {
      await runNotifyHook(args.notify, {
        outcome: "crashed",
        id: null,
        minutes: (Date.now() - batchStartedMs) / 60_000,
        calls: 0,
        detail: errorMessage(err).slice(0, 300)
      });
    }
  }
}

/* Only run when invoked as a script; importing this module for its exported
   helpers (which the tests do) must not start a batch. */
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
