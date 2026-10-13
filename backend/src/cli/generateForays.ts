#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { runForayPipeline, RefusedPartialError, type NarrationActTiming, type PipelineTopicDecision, type RunPipelineOutcome } from "../generation/runPipeline";
import type { SpineReask } from "../generation/buildSpine";
import { FileTranscriptCueProvider, loadTranscriptArchive, type TranscriptDigestEntry } from "../generation/transcriptArchiveLookup";
import { corpusCoverage, corpusCoverageLine, corpusFingerprint, type CorpusCoverage, type CorpusFingerprint } from "../generation/transcriptCorpus";
import { FileTranscriptTextIndex, TRANSCRIPT_TEXT_INDEX_VERSION, type TranscriptTextIndex } from "../generation/transcriptTextIndex";
import {
  CHECKPOINT_STAGE_ORDER,
  CheckpointFileSchema,
  checkpointFingerprint,
  checkpointForkStamp,
  checkpointRunVariant,
  forkSeedRefusal,
  isCheckpointStage,
  stagesAtOrAfter,
  type CheckpointForkStamp,
  type CheckpointStage
} from "../generation/checkpoint";
import { resolvePipelineFlags, type PipelineFlags } from "../generation/pipelineFlags";
import { resolveGateConfig, type GateConfig } from "../generation/gateConfig";
import { getUsageTotals } from "../generation/usageTracking";
import { RunLog, runWithRunLog, withCallContext } from "../generation/runLog";
import { DeliveryTimeline, deliveryReportOf, type DeliveryReport } from "../generation/deliveryTimeline";
import { spanMsOf } from "../generation/stageTiming";
import { FileCheckpointStore } from "./checkpointStore";
import { FileJobSink } from "./fileJobSink";
import { EMPTY_JOB_PROGRESS, isJobForayId, progressWithEvent, progressWithPartial, snapshotFrom, type GenerationJobSink, type JobCloseOutcome, type JobIdentity } from "../generation/jobSink";
import { readAuthorIdFlag, type ClarityDecider, type GenerationRequest } from "../types/generation";
import type { PartialCandidate } from "../generation/partialCandidate";
import type { VeracityGateResult, VeracityMetrics } from "../generation/veracityMetrics";
import type { PublishRecord } from "./publishForay";
import { modelSummary } from "../config/models";
import {
  ALLOW_PROSE_ON_SECOND_ENV,
  GENERATION_MODE_ENV,
  GENERATION_STAGES,
  LLM_BASE_URL_ENV,
  RoutingConfigError,
  describeStageAssignments,
  resolveRouting,
  routingSummary,
  stageEnvVar,
  type GenerationMode,
  type RoutingSummary,
  type RoutingTable,
  type StageAssignment,
  type StageId
} from "../config/stageRouting";
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
 *   timeout (I-27's "Request timed out." on the relay), a 5xx/429 — up to
 *   `--max-resumes` times with backoff; ends a run with a
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
 *                              [--notify <command>] [--author-id <id>]
 *                              [--job-dir <dir>]
 *                              [--stage-provider stage=provider[:lane][,...]]
 *                              [--keep-checkpoints]
 *                              [--seed-checkpoints <dir> --rerun-from <stage>]
 *   (author_id defaults to `DEFAULT_AUTHOR_ID` in types/generation.ts, the
 *   same default `generate-foray` uses; `--author` still works for one
 *   release and prints a deprecation line)
 *
 * `prompts.json` is either a JSON array of strings, or of
 * `{ prompt, duration?, topic?, id? }` objects when a prompt needs its taxonomy
 * node pinned by hand rather than resolved (`id` is carried into report.json
 * as `promptId`, so a bench can join rows across runs without the prompt text).
 *
 * Each pipeline attempt's RunLog (GV-01) is written beside the candidates as
 * `runlogs/<checkpointKey>.<attempt>.runlog.jsonl` (not under --dry-run):
 * stage spans and, as later cards add them, call records — names, numbers and
 * ids only, never prompt text or model output.
 *
 * `--job-dir <dir>` (GV-44, off by default) also publishes a job snapshot
 * (`generation/jobSink.ts`) to `<dir>/<forayId>.job.json` on every act-ready and
 * item-ready event, then closes it with the run's outcome: what a phone may
 * play so far, the servable prefix only, never the prompt. Not under --dry-run.
 *
 * `--stage-provider spine=local:second,deepen=local:spark` (GV-55, repeatable)
 * routes stages for this run exactly as FORAY_STAGE_<STAGE>=<provider>[:<lane>]
 * would (config/stageRouting.ts, decision 4): the overrides are applied to the
 * environment before the routing table is resolved, and win over the same
 * variables already set. A malformed entry exits non-zero naming it. The
 * MODE/MODELS/STAGES lines state the routing, report.json records it
 * (`routing`, `generationMode`, and `stageAssignments` per row), and in local
 * mode (or with any stage overridden) the routing joins the checkpoint
 * variant, so a resumed run never mixes stages built under another routing.
 *
 * Checkpoint fork (GV-62, bench prompts only; every spec needs `bench: true`
 * or the CLI refuses before anything runs, because §9.4 says a listener's
 * prompt is discarded and its checkpoint must not outlive the run):
 * `--keep-checkpoints` keeps `<key>.checkpoint.json` beside a finished
 * candidate (stamped with what built it), and arm B's
 * `--seed-checkpoints <arm A out> --rerun-from <stage>` copies arm A's file
 * for the same prompt into its own --out, drops the stages at and after
 * <stage> (CHECKPOINT_STAGE_ORDER in generation/checkpoint.ts), and so
 * rebuilds only from the changed stage. A missing or unusable seed is logged
 * and the prompt runs from scratch; the row records `seededFrom`.
 */

interface PromptSpec {
  prompt: string;
  duration?: "short" | "medium" | "long";
  topic?: string;
  /** GV-01: a stable id for the prompt, reported as `promptId`. */
  id?: string;
  /** GV-62: a bench prompt (a golden-set or swap-arm prompt, not a
   * listener's), the only kind whose checkpoint may be kept or seeded. */
  bench?: boolean;
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
   * BOTH the per-Foray and the run ceiling for this process — the two must
   * move together, because every metered call also counts against the whole
   * run cap: raising only the per-Foray cap would just move the stop to the
   * run one.
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
  /** GV-15: `--fast-path`, the `FORAY_FAST_PATH` umbrella for this run
   * (per-field variables still override it). Absent unless given, so the
   * parsed args of a run without it are unchanged. */
  fastPath?: boolean;
  /** GV-44: `--job-dir <dir>`, where the job snapshot sink writes
   * `<forayId>.job.json`. Absent unless given, so the parsed args of a run
   * without it are unchanged and nothing is published. */
  jobDir?: string;
  /** GV-55: `--stage-provider stage=provider[:lane][,...]`, applied as
   * FORAY_STAGE_<STAGE> overrides before the routing table is resolved.
   * Absent unless given, so the parsed args of a run without it are
   * unchanged. */
  stageProviders?: Partial<Record<StageId, string>>;
  /** GV-62: `--keep-checkpoints`, keep a finished bench prompt's checkpoint
   * (stamped for forking) instead of deleting it. Absent unless given. */
  keepCheckpoints?: boolean;
  /** GV-62: `--seed-checkpoints <dir>`, an earlier arm's --out whose kept
   * checkpoints seed this run. Given only with `rerunFrom`. */
  seedCheckpoints?: string;
  /** GV-62: `--rerun-from <stage>`, the first stage a seeded run rebuilds. */
  rerunFrom?: CheckpointStage;
}

/** A command-line value the driver refuses. `main` prints the message and
 * exits non-zero before anything runs. */
export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgError";
  }
}

export const STAGE_PROVIDER_FLAG = "--stage-provider";

/**
 * GV-55: parses every `--stage-provider` value (comma-separated
 * `stage=provider[:lane]` entries; the flag may repeat). Each entry is checked
 * against the same rules FORAY_STAGE_<STAGE> is (the stage is known, the
 * provider is one that stage accepts, the lane exists) by resolving it alone
 * on a synthetic source, so a typo stops the run here, naming the entry,
 * rather than inside the first stage. Rules that depend on the real
 * environment (FORAY_LLM_BASE_URL, the prose lane) are left to the real
 * resolveRouting, which names the variable.
 */
export function parseStageProviders(values: readonly string[]): Partial<Record<StageId, string>> {
  const out: Partial<Record<StageId, string>> = {};
  for (const value of values) {
    for (const raw of value.split(",")) {
      const entry = raw.trim();
      const refuse = (why: string): never => {
        throw new CliArgError(
          `${STAGE_PROVIDER_FLAG}: "${entry}" ${why}; expected stage=provider[:lane][,...] with stage one of ${GENERATION_STAGES.join(", ")}`
        );
      };
      const eq = entry.indexOf("=");
      if (eq <= 0) refuse("is not stage=provider[:lane]");
      const stage = entry.slice(0, eq) as StageId;
      const spec = entry.slice(eq + 1);
      if (!(GENERATION_STAGES as readonly string[]).includes(stage)) refuse("names no stage");
      if (out[stage] !== undefined) refuse("routes a stage a second time");
      try {
        resolveRouting({
          [GENERATION_MODE_ENV]: "stub",
          [LLM_BASE_URL_ENV]: "http://stage-provider.invalid",
          [ALLOW_PROSE_ON_SECOND_ENV]: "1",
          [stageEnvVar(stage)]: spec
        });
      } catch (err) {
        if (err instanceof RoutingConfigError) refuse(`is not a route stage "${stage}" accepts (${err.message})`);
        throw err;
      }
      out[stage] = spec;
    }
  }
  return out;
}

/** `env` with each `--stage-provider` override set as its FORAY_STAGE_*
 * variable (a copy; `env` is not touched). */
export function withStageProviders(env: NodeJS.ProcessEnv, overrides: Partial<Record<StageId, string>> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [stage, spec] of Object.entries(overrides) as [StageId, string][]) out[stageEnvVar(stage)] = spec;
  return out;
}

/** GV-55: the MODE line, then MODELS when a stage is on the legacy
 * Anthropic builders, then STAGES when any stage is not a stub. With no
 * routing variable set, the MODE and MODELS lines are today's text. */
export function modeLines(
  routing: RoutingTable,
  caps: { runUsd: number; episodeUsd: number },
  models: { opus: string; sonnet: string; haiku: string }
): string[] {
  const routes = Object.values(routing.routes).filter((r): r is NonNullable<typeof r> => r !== undefined);
  /* Stub mode with nothing overridden is today's dry run even when a Jev key
     routes the judge to jev: nothing on the default pipeline calls the judge. */
  const inert =
    (routing.mode === "stub" && routing.overridden.length === 0) || routes.every((r) => r.provider === "stub" || r.provider === "none");
  const metered = `metered by BudgetGuard (run $${caps.runUsd} for this process, per-Foray $${caps.episodeUsd})`;
  if (inert) return [`MODE: dry-run (no ANTHROPIC_API_KEY) — stub builders, $0, output is structurally real but editorially empty.`];
  const lines = [
    routing.mode === "anthropic-legacy" && routing.overridden.length === 0
      ? `MODE: live — Anthropic builders, ${metered}.`
      : `MODE: mixed/live — generation mode ${routing.mode} (from ${routing.modeSource}), routed per stage below, ${metered}.`
  ];
  if (routes.some((r) => r.provider === "anthropic")) lines.push(`MODELS: opus=${models.opus} sonnet=${models.sonnet} haiku=${models.haiku}`);
  const summary = routingSummary(routing);
  const stages = Object.entries(summary.stages).map(([stage, route]) => `${stage}=${route}`);
  const overridden = summary.overridden.length ? `; overridden: ${summary.overridden.join(", ")}` : "";
  const llm = summary.llm.baseUrl !== null ? `; llm ${summary.llm.baseUrl} (key ${summary.llm.keyConfigured ? "configured" : "not set"})` : "";
  lines.push(`STAGES: ${stages.join(", ")}${overridden}${llm}`);
  return lines;
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
  /* GV-55: every occurrence, so the flag may repeat. A flag with no value
     is refused rather than read as "no overrides". */
  const stageProviderValues: string[] = [];
  argv.forEach((arg, i) => {
    if (arg !== STAGE_PROVIDER_FLAG) return;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new CliArgError(`${STAGE_PROVIDER_FLAG} needs a value: stage=provider[:lane][,...]`);
    stageProviderValues.push(value);
  });
  const stageProviders = stageProviderValues.length ? parseStageProviders(stageProviderValues) : undefined;
  const fork = parseForkFlags(argv);
  return {
    prompts: get("--prompts") ?? null,
    out: get("--out") ?? path.join("data-local", "foray-candidates"),
    duration: d === "short" || d === "medium" || d === "long" ? d : "short",
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    dryRun: argv.includes("--dry-run"),
    authorId: readAuthorIdFlag(argv),
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null,
    noResume: argv.includes("--no-resume"),
    maxResumes: Number.isInteger(maxResumes) && maxResumes >= 0 ? maxResumes : DEFAULT_MAX_RESUMES,
    continueOnRefusedPartial: argv.includes("--continue-on-refused-partial"),
    notify: get("--notify") ?? (notifyEnv ? notifyEnv : null),
    ...(argv.includes("--fast-path") ? { fastPath: true } : {}),
    ...(get("--job-dir") ? { jobDir: get("--job-dir")! } : {}),
    ...(stageProviders ? { stageProviders } : {}),
    ...fork
  };
}

/**
 * GV-62: `--keep-checkpoints`, `--seed-checkpoints <dir>` and
 * `--rerun-from <stage>`, each absent unless given. Refused (CliArgError):
 * a flag with no value, an unknown stage, --rerun-from without
 * --seed-checkpoints or the other way round, --seed-checkpoints with
 * --no-resume (which would delete the seeded file) or --dry-run (which runs
 * without a store), and a seed directory that is the --out directory.
 */
function parseForkFlags(argv: string[]): Pick<CliArgs, "keepCheckpoints" | "seedCheckpoints" | "rerunFrom"> {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === "") throw new CliArgError(`${flag} needs a value`);
    return value;
  };
  const seed = valueOf("--seed-checkpoints");
  const rerunFrom = valueOf("--rerun-from");
  if (rerunFrom !== undefined && !isCheckpointStage(rerunFrom)) {
    throw new CliArgError(`--rerun-from: "${rerunFrom}" is not a checkpoint stage; expected one of ${CHECKPOINT_STAGE_ORDER.join(", ")}`);
  }
  if (rerunFrom !== undefined && seed === undefined) throw new CliArgError("--rerun-from needs --seed-checkpoints <dir>");
  if (seed !== undefined && rerunFrom === undefined) throw new CliArgError("--seed-checkpoints needs --rerun-from <stage>");
  if (seed !== undefined && argv.includes("--no-resume")) throw new CliArgError("--seed-checkpoints cannot be used with --no-resume");
  if (seed !== undefined && argv.includes("--dry-run")) throw new CliArgError("--seed-checkpoints cannot be used with --dry-run (a dry run keeps no checkpoint)");
  if (seed !== undefined) {
    const outIndex = argv.indexOf("--out");
    const out = outIndex >= 0 && argv[outIndex + 1] !== undefined ? argv[outIndex + 1]! : path.join("data-local", "foray-candidates");
    if (path.resolve(seed) === path.resolve(out)) throw new CliArgError("--seed-checkpoints must name another arm's directory, not this run's --out");
  }
  return {
    ...(argv.includes("--keep-checkpoints") ? { keepCheckpoints: true } : {}),
    ...(seed !== undefined && rerunFrom !== undefined ? { seedCheckpoints: seed, rerunFrom } : {})
  };
}

/**
 * GV-62: the checkpoint-fork flags are for bench prompts only. Returns why
 * the run is refused when `--keep-checkpoints` or `--seed-checkpoints` is
 * given and any prompt about to run lacks `bench: true` (§9.4: a listener's
 * prompt is discarded, so its checkpoint must never outlive the run), else
 * null. `main` checks it before anything is resolved or spent.
 */
export function benchFlagRefusal(args: Pick<CliArgs, "keepCheckpoints" | "seedCheckpoints">, specs: readonly PromptSpec[]): string | null {
  const flag = args.keepCheckpoints ? "--keep-checkpoints" : args.seedCheckpoints !== undefined ? "--seed-checkpoints" : null;
  if (flag === null) return null;
  const notBench = specs.findIndex((spec) => spec.bench !== true);
  if (notBench < 0) return null;
  return `${flag} is for bench prompts only: prompt ${notBench + 1} of ${specs.length} has no "bench": true`;
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

/** GV-39: WHICH PROMPT FILE A BATCH RAN, as `report.json` records it. Two
 * golden-set reports compare only when their prompt sets agree, and a file
 * edited in place keeps its name, so the name alone cannot say so. */
export interface PromptSetIdentity {
  /** The file's basename, for a human; the hash is what compares. */
  file: string;
  /** sha256 of the file's bytes exactly as read — the bytes the run parsed. */
  sha256: string;
  /** Prompts in the file (before `--limit`). */
  count: number;
}

/** Reads a prompts file ONCE, so the identity is of the very bytes the batch
 * parsed and not of a later read of a file that changed in between. */
export function readPromptSet(promptsPath: string): { specs: PromptSpec[]; identity: PromptSetIdentity } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node builtin, sync by design
  const { createHash } = require("crypto") as typeof import("crypto");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's own --prompts path.
  const bytes = fs.readFileSync(path.resolve(promptsPath));
  const specs = normalizePrompts(JSON.parse(bytes.toString("utf8")));
  return {
    specs,
    identity: { file: path.basename(promptsPath), sha256: createHash("sha256").update(bytes).digest("hex"), count: specs.length }
  };
}

/** `report.corpus`: #703's coverage plus GV-39's fingerprint, or null when
 * there is no corpus directory at all (CI, a fresh checkout), which is not the
 * same as "nothing was missing". */
export type CorpusReport = CorpusCoverage & { fingerprint: CorpusFingerprint };

export function corpusReport(coverage: CorpusCoverage, fingerprint: CorpusFingerprint): CorpusReport | null {
  return coverage.showsOnDisk > 0 ? { ...coverage, fingerprint } : null;
}

/** The whole `report.json` document of a non-dry batch, in its written key
 * order. Pure, so the fields a reader compares on are testable without a run. */
export function batchReportDocument(s: {
  generatedAt: string;
  maxResumes: number;
  continueOnRefusedPartial: boolean;
  resumes: number;
  aborts: number;
  notify: string | null;
  notification: NotificationResult | null;
  corpus: CorpusReport | null;
  prompts: PromptSetIdentity;
  /** GV-55: the generation mode and the routing summary (no key, no URL
   * credentials) the batch ran under. */
  generationMode: GenerationMode;
  routing: RoutingSummary;
  entries: PriorReportEntry[];
}): Record<string, unknown> {
  return {
    generated_at: s.generatedAt,
    dry_run: false,
    /* G-30 (e): the policy the run had and what the driver did on its
       own under it, so a reader can tell "three resumes" from "three
       attempts by hand". */
    max_resumes: s.maxResumes,
    continue_on_refused_partial: s.continueOnRefusedPartial,
    resumes: s.resumes,
    aborts: s.aborts,
    notify: s.notify,
    notification: s.notification,
    /* #703 ask 2: the corpus this batch was sourced from, named shows
       and all; GV-39 adds its fingerprint, so a transcript or index
       change cannot pass for a pipeline change. */
    corpus: s.corpus,
    /* GV-39: the prompt set this batch ran. */
    prompts: s.prompts,
    /* GV-55 (R2-21): which provider, lane and model served each stage, so a
       bench row is attributable. */
    generationMode: s.generationMode,
    routing: s.routing,
    entries: s.entries
  };
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
    case "no-supply":
      /* F-91: the topic resolved, but no candidate topic's family admits enough
         of the archive to source from, so the run stopped BEFORE the spine —
         no Opus or Sonnet call was made. `reason` names every candidate and
         its count. */
      return `${outcome.reason} (stopped before ${outcome.stoppedBefore})`;
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
  /** Either budget cap: not resumable. The per-Foray cap would trip again on
   * the same Foray, and the RUN cap is this process's whole budget — there is
   * no window that resets it (CH2-04). Raising a cap is a decision, not a
   * retry; a run-cap stop also ends the batch (`runBudgetSpent`). */
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
    return { kind: "budget-stop", reason: err.message };
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

/** One automatic resume, as recorded in `report.json`. */
export interface ResumeRecord {
  /** 1-based: the Nth resume of this prompt. */
  attempt: number;
  kind: "transient";
  reason: string;
  waitedMs: number;
  /** ISO time the wait began. */
  at: string;
}

/** The named reasons a run ends without a pipeline outcome (G-30 b). A plain
 * bug still lands as `outcome: "error"`, exactly as before. */
export type AbortReason = "refused-partial" | "budget-stop" | "resumes-exhausted";

/** What one prompt produced. `runBudgetSpent` is set only when the prompt
 * stopped on the RUN cap (`RUN_BUDGET_USD`), which is the whole process's
 * budget — so the batch stops there instead of starting prompts that cannot
 * spend anything (CH2-04). */
export interface CandidateResult {
  skipped: boolean;
  entry?: ReportEntry;
  file?: string;
  runBudgetSpent?: true;
}

/** The batch: one prompt after another, ending early on a run-cap stop. One
 * prompt's other failures never end it (they are recorded and the next prompt
 * is attempted). Returns what the report needs, and how many prompts were
 * never attempted because the run cap was spent. */
export async function generateQueue(
  queue: PromptSpec[],
  generateOne: (spec: PromptSpec) => Promise<CandidateResult>
): Promise<{ report: ReportEntry[]; generated: number; skipped: number; notAttempted: number }> {
  const report: ReportEntry[] = [];
  let generated = 0;
  let skipped = 0;
  for (const [i, spec] of queue.entries()) {
    const result = await generateOne(spec);
    if (result.skipped) {
      skipped++;
      continue;
    }
    if (result.entry) {
      report.push(result.entry);
      if (result.file) generated++;
    }
    if (result.runBudgetSpent) {
      const notAttempted = queue.length - i - 1;
      console.log(
        `STOP   RUN_BUDGET_USD spent: the run cap is everything this process may spend, so ${notAttempted} prompt(s) were not attempted. ` +
          `Raise it with --budget-usd (or RUN_BUDGET_USD) and re-run; candidates already built are skipped.`
      );
      return { report, generated, skipped, notAttempted };
    }
  }
  return { report, generated, skipped, notAttempted: 0 };
}

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

/**
 * The batch's closing line. `validCount` is the rows that passed §4.9
 * validation (the `OK ` detail); GV-26 adds how many of this run's rows also
 * passed every publish gate (`publishable`, MQ-21) — the count that could be
 * published without `--force`.
 */
export function batchSummaryText(s: {
  report: ReportEntry[];
  generated: number;
  skipped: number;
  aborts: number;
  validCount: number;
  resumesTotal: number;
}): string {
  const gatePassing = s.report.filter((r) => r.publishable === true).length;
  return (
    `${s.generated} candidate(s) written, ${s.skipped} skipped, ${s.aborts} aborted, ` +
    `${s.report.length - s.validCount} did not produce a publishable Foray` +
    `; ${gatePassing} passed every gate (publishable without --force)` +
    (s.resumesTotal ? `; ${s.resumesTotal} automatic resume(s)` : "")
  );
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
  /** F-86: every structural re-ask §4.3 took (attempt number and the gate's
   * violations it was asked to fix). Absent when the first spine passed —
   * the common case — and on a resume from a banked spine. */
  spineReasks?: SpineReask[];
  /** F-91: how the topic was chosen — the resolver's pick, every candidate's
   * supply, and whether supply moved the choice (`reason`). On every outcome
   * that got as far as a decision (`no-supply`, `no-tape`, `generated`), so
   * the ledger can cite the numbers a stop was made on. */
  topicDecision?: PipelineTopicDecision;
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
  /** F-87 (a G-32 note): where a `refused-partial` abort landed — the
   * 0-based act whose partial `check-forays` refused, and how many acts the
   * Foray has. Under G-32 every act's narration had already STARTED when act
   * `act`'s partial was judged (the ordered stitch loop validates act 0 only
   * after all narrations are in flight), so `totalActs - act - 1` acts of
   * narration were paid for past the refusal. Run 7 attempt 3: `{act: 0,
   * totalActs: 4}` after 81 calls. Only on an `aborted` row whose reason is
   * `refused-partial`. */
  refusedAtAct?: { act: number; totalActs: number };
  /** G-30 (c): model calls across every attempt of this prompt. */
  calls?: number;
  /** G-30 (c): what the notification hook returned, when one was configured. */
  notification?: NotificationResult;
  /** GV-01: TRUE elapsed time of the final attempt's stages (last end minus
   * first start, `spanMsOf`), where `ms` sums them and so double-counts the
   * concurrent narrate stages. On an aborted or error row (whose `ms` stays
   * 0) it comes from that attempt's RunLog stage spans, failed stage
   * included. Null when no stage ran. */
  elapsedMs?: number | null;
  /** GV-01: the driver's own wall clock for this prompt, across every
   * attempt and every backoff wait. */
  driverMs?: number;
  /** GV-01: the duration tier the prompt ran at. */
  duration?: "short" | "medium" | "long";
  /** GV-01: the prompt spec's `id`, when it has one. */
  promptId?: string;
  /** GV-01: the final attempt's RunLog, relative to the report's directory
   * (`runlogs/<checkpointKey>.<attempt>.runlog.jsonl`). Absent under --dry-run. */
  runLog?: string;
  /** GV-15: the pipeline flags this prompt ran under (env merged with
   * `--fast-path`), the same object the checkpoint variant was built from. */
  flags?: PipelineFlags;
  /** GV-15: the resolved gate config (empty until the gate cards add keys). */
  gates?: GateConfig;
  /** GV-26 (decision 33): the publish gate's verdict, evaluated by the
   * pipeline when the run finished (`evaluateVeracityGate(veracity)`). Only on
   * a `generated` row. Not to be confused with `gates`, the gate CONFIG. */
  gate?: VeracityGateResult;
  /** GV-26 (MQ-21): the candidate passed §4.9 validation AND every publish
   * gate, so it could be published without `--force`. Only on a `generated`
   * row. */
  publishable?: boolean;
  /** GV-33 (decision 14; MT-01, MT-11): the final attempt's delivery timeline
   * — when the first item, the first servable item and the last item were
   * ready (ms since the attempt started), the smallest lead over the playhead
   * at 1x and 1.5x, how many items were under 30 s of lead, where an
   * unservable act paused playback, and how many items `runtimeSecFor` could
   * not time. A resumed attempt (a banked `stitch:<i>` fired no events)
   * carries `resumed: true` and no lead or first-item times, the `ttlA1Ms`
   * rule. Only on a `generated` row; absent stays absent, never zero. */
  delivery?: DeliveryReport;
  /** GV-49: who decided the clarity check, `jev` (Jev's two yes/no answers,
   * no text model call) or `fallback` (the text understander). Only when the
   * understand-clarity stage is routed to Jev
   * (FORAY_STAGE_UNDERSTAND_CLARITY=jev); absent on every other route. */
  clarityDecidedBy?: ClarityDecider;
  /** GV-55 (from W7-02): per routed stage, the implementation, model and
   * machine that served it (`describeStageAssignments`), from the routing the
   * run was resolved under. On every row. */
  stageAssignments?: Partial<Record<StageId, StageAssignment>>;
  /** GV-62: under `--seed-checkpoints`, the seed this prompt was forked from
   * (the seed directory as given, the stage it reran from, and the banked
   * keys it kept), or null when no usable seed existed and the prompt ran
   * from scratch. Absent without the flag. */
  seededFrom?: SeededFrom | null;
};

/** GV-62: a report row's `seededFrom`. */
export type SeededFrom = { dir: string; rerunFrom: CheckpointStage; stagesKept: string[] };

/**
 * A `report.json` row as read back from disk: any earlier run's shape, plus
 * the `publish_refused` field publish-foray writes onto it.
 */
export type PriorReportEntry = Partial<ReportEntry> & { publish_refused?: unknown } & Record<string, unknown>;

/**
 * The rows an earlier run left in `report.json`, or none. An unreadable file
 * is set aside as `report.json.unreadable-<ms>` rather than silently lost.
 */
export function readPriorReportEntries(reportPath: string): PriorReportEntry[] {
  if (!fs.existsSync(reportPath)) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { entries?: unknown };
    return Array.isArray(doc.entries) ? (doc.entries.filter((e) => e && typeof e === "object") as PriorReportEntry[]) : [];
  } catch {
    fs.renameSync(reportPath, `${reportPath}.unreadable-${Date.now()}`);
    return [];
  }
}

/**
 * backend-rest-7: this run's rows merged over an earlier run's. A row matches
 * an earlier one by prompt, or by candidate file basename. An earlier row this
 * run did not touch (a candidate skipped as already built) is kept as it was,
 * with the `publish` / `publish_refused` records publish-foray wrote onto it;
 * a new row is appended.
 *
 * A matched earlier row is replaced in place WITHOUT its publish records.
 * Every row in `current` is a candidate this run built afresh (a skipped one
 * produces no row), so the file on disk is a different build from the one
 * that was published or refused. Carrying the record over reported the new
 * build as already refused or already published (round-3 review, L6: refuse,
 * delete the candidate, re-run).
 */
export function mergeReportEntries(prior: readonly PriorReportEntry[], current: readonly ReportEntry[]): PriorReportEntry[] {
  const base = (f: unknown) => (typeof f === "string" ? path.basename(f) : null);
  const merged: PriorReportEntry[] = prior.map((e) => ({ ...e }));
  for (const entry of current) {
    const i = merged.findIndex(
      (old) => (typeof old.prompt === "string" && old.prompt === entry.prompt) || (base(old.file) !== null && base(old.file) === base(entry.file))
    );
    if (i < 0) {
      merged.push({ ...entry });
      continue;
    }
    merged[i] = { ...entry };
  }
  return merged;
}

/** GV-62: rewrites a finished bench prompt's checkpoint with the fork stamp
 * (same temp-and-rename write as FileCheckpointStore). A stamp that cannot be
 * written leaves the file as it was: a seed without one still forks into an
 * arm with the same fingerprint. Never throws. */
function keepCheckpoint(store: FileCheckpointStore, key: string, stamp: CheckpointForkStamp): void {
  try {
    const kept = store.load(key);
    if (!kept) return;
    const file = store.filePathFor(key);
    const tmp = `${file}.tmp`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the driver's own checkpoint path under --out.
    fs.writeFileSync(tmp, `${JSON.stringify({ ...kept, fork: stamp }, null, 2)}\n`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same.
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`  keep: could not stamp ${store.filePathFor(key)}: ${errorMessage(err)}`);
  }
}

/**
 * GV-62: arm B's fork for one prompt. Reads `<seedDir>/<key>.checkpoint.json`;
 * when `forkSeedRefusal` accepts it, writes it into this run's store under
 * this run's fingerprint (without the seed's stamp), then drops every banked
 * stage at or after `rerunFrom` through `FileCheckpointStore.drop`, so the
 * pipeline resumes the upstream stages and rebuilds the rest. A missing,
 * unreadable or refused seed is logged, any checkpoint already in this run's
 * --out for the key is discarded (the prompt runs from scratch), and the
 * result is null.
 */
export function seedCheckpoint(opts: {
  seedDir: string;
  rerunFrom: CheckpointStage;
  key: string;
  store: FileCheckpointStore;
  fingerprint: string;
  stamp: CheckpointForkStamp;
  label: string;
}): SeededFrom | null {
  const seedFile = path.join(path.resolve(opts.seedDir), `${opts.key}.checkpoint.json`);
  const unseeded = (why: string): null => {
    console.log(`  seed   ${opts.label} — no usable seed (${why}); running from scratch`);
    opts.store.discard(opts.key);
    return null;
  };
  let raw: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's own --seed-checkpoints dir and the driver's key.
    if (!fs.existsSync(seedFile)) return unseeded(`${seedFile} does not exist`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same.
    raw = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  } catch (err) {
    return unseeded(`${seedFile} is unreadable: ${errorMessage(err)}`);
  }
  const parsed = CheckpointFileSchema.safeParse(raw);
  if (!parsed.success) return unseeded(`${seedFile} is not a checkpoint file`);
  const refusal = forkSeedRefusal(parsed.data, { fingerprint: opts.fingerprint, stamp: opts.stamp }, opts.rerunFrom);
  if (refusal !== null) return unseeded(`${seedFile}: ${refusal}`);
  const { fork: _fork, ...seed } = parsed.data as typeof parsed.data & { fork?: unknown };
  void _fork;
  const target = opts.store.filePathFor(opts.key);
  try {
    const tmp = `${target}.tmp`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the driver's own checkpoint path under --out.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same.
    fs.writeFileSync(tmp, `${JSON.stringify({ ...seed, key: opts.key, fingerprint: opts.fingerprint, updatedAt: new Date().toISOString() }, null, 2)}\n`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same.
    fs.renameSync(tmp, target);
  } catch (err) {
    return unseeded(`could not copy it to ${target}: ${errorMessage(err)}`);
  }
  const keys = Object.keys(seed.stages);
  const dropped = stagesAtOrAfter(keys, opts.rerunFrom);
  opts.store.drop(opts.key, dropped);
  const stagesKept = keys.filter((key) => !dropped.includes(key));
  console.log(
    `  seed   ${opts.label} — from ${opts.seedDir}: kept ${stagesKept.length} stage(s) (${stagesKept.join(", ") || "none"}), rerunning from ${opts.rerunFrom}`
  );
  return { dir: opts.seedDir, rerunFrom: opts.rerunFrom, stagesKept };
}

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
 * so a test can prove a backoff without waiting it out; `deps.notify`
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
    /** GV-44: the job id the snapshot sink is opened with (default a random
     * UUID per prompt, never derived from the prompt). */
    newJobId?: () => string;
  }
): Promise<CandidateResult> {
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
  /* GV-15 (decision 20): the run's flags, resolved ONCE here and handed to
     the pipeline whole (`options.flags`), so the store's fingerprint and the
     pipeline session's are built from the same variant. FileCheckpointStore
     keeps banked stages only when the file's fingerprint equals ITS OWN, so a
     variant on the session alone would stop a flag-on run resuming itself
     and would merge classic and flag-on stages into one file. */
  const flags = resolvePipelineFlags(args.fastPath ? { fastPath: true } : {});
  const gates = resolveGateConfig();
  /* GV-55: the routing table, resolved once here with the --stage-provider
     overrides applied (main() also sets them on process.env, which the stage
     factories read), handed to the pipeline whole like the flags, so the
     store's and the session's variant agree. */
  const routing = resolveRouting(withStageProviders(process.env, args.stageProviders));
  const stageAssignments = describeStageAssignments({ routing });
  const fingerprint = checkpointFingerprint({
    prompt: spec.prompt,
    duration: request.duration,
    topic: spec.topic,
    variant: checkpointRunVariant(flags, routing)
  });
  const checkpointStore = new FileCheckpointStore(path.resolve(args.out), fingerprint);
  /* GV-62: what a kept checkpoint is stamped with, and what a seed is
     checked against. */
  const forkStamp = checkpointForkStamp({ prompt: spec.prompt, duration: request.duration, topic: spec.topic, flags, routing });
  if (args.noResume) checkpointStore.discard(checkpointKey);
  /* GV-62: arm B's fork, before the resume check below reads the file. */
  const seededFrom =
    args.seedCheckpoints !== undefined && args.rerunFrom !== undefined
      ? seedCheckpoint({
          seedDir: args.seedCheckpoints,
          rerunFrom: args.rerunFrom,
          key: checkpointKey,
          store: checkpointStore,
          fingerprint,
          stamp: forkStamp,
          label: spec.prompt.slice(0, 60)
        })
      : undefined;
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
  /* GV-44 (W6-03): the job row. One sink per prompt, kept across resume
     attempts so the row's seq keeps climbing and a banked act already served
     stays served. Nothing is opened without --job-dir, and nothing under
     --dry-run. A job-row failure never costs the Foray: it is a warning. */
  const jobSink: GenerationJobSink | null = args.jobDir && !args.dryRun ? new FileJobSink(path.resolve(args.jobDir)) : null;
  const job: JobIdentity = { jobId: (deps.newJobId ?? randomUUID)(), authorId: args.authorId, lane: "catalogue" };
  let jobProgress = EMPTY_JOB_PROGRESS;
  let jobSeq = 0;
  const publishJob = async (): Promise<void> => {
    if (!jobSink) return;
    const snapshot = snapshotFrom(job, jobProgress, jobSeq, now().toISOString());
    if (!snapshot) return;
    try {
      await jobSink.publish(snapshot);
      jobSeq = snapshot.seq;
    } catch (err) {
      console.warn(`  job: could not publish snapshot ${snapshot.seq}: ${errorMessage(err)}`);
    }
  };
  const closeJob = async (outcome: JobCloseOutcome, detail: string | undefined, forayId: string | null): Promise<void> => {
    if (!jobSink) return;
    try {
      /* The row to close when this process published nothing (a resumed
         attempt whose acts were all banked fires no hook): the run's Foray id,
         else the one the checkpoint banked. Only a valid job id names a row. */
      const banked = (checkpointStore.load(checkpointKey)?.stages.identity as { forayId?: unknown } | undefined)?.forayId;
      const target = [forayId, banked].find(isJobForayId);
      await jobSink.close(outcome, detail, target ? { forayId: target, authorId: job.authorId } : undefined);
    } catch (err) {
      console.warn(`  job: could not close the job: ${errorMessage(err)}`);
    }
  };
  const onActReady = async (candidate: PartialCandidate): Promise<void> => {
    lastPartialId = candidate.id;
    if (!candidate.validation.ok) refusedPartials.push(candidate.acts.filter((a) => a.status === "ready").length - 1);
    if (args.dryRun) return;
    fs.writeFileSync(partialFile, `${JSON.stringify(candidate, null, 2)}\n`);
    deps.onPartialWrite?.(candidate, partialFile);
    if (jobSink) {
      jobProgress = progressWithPartial(jobProgress, candidate);
      await publishJob();
    }
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
  /* GV-01: one RunLog per attempt, written by THIS module (the pipeline's
     generation/ modules never write files) unless --dry-run. The report row
     names the final attempt's file. */
  let runLogRel: string | undefined;
  const writeRunLog = (log: RunLog, attempt: number): void => {
    if (args.dryRun) return;
    const rel = `runlogs/${checkpointKey}.${attempt}.runlog.jsonl`;
    try {
      fs.mkdirSync(path.join(path.resolve(args.out), "runlogs"), { recursive: true });
      fs.writeFileSync(path.join(path.resolve(args.out), rel), log.toJsonl());
      runLogRel = rel;
    } catch (err) {
      /* A measurement file must never cost the Foray. */
      console.warn(`  runlog: could not write ${rel}: ${errorMessage(err)}`);
      runLogRel = undefined;
    }
  };
  const finishEntry = async (entry: ReportEntry, notifyOutcome: string, id: string | null): Promise<ReportEntry> => {
    /* GV-44: every return goes through here, so the job row closes once,
       with the same outcome code the notify hook gets ("built",
       "aborted:<reason>", "error", "invalid", "rejected" ...). */
    if (notifyOutcome === "built") await closeJob("complete", undefined, id);
    else if (notifyOutcome.startsWith("aborted:")) await closeJob("aborted", notifyOutcome.slice("aborted:".length), id);
    else await closeJob("failed", notifyOutcome, id);
    const withCalls: ReportEntry = {
      ...entry,
      calls,
      driverMs: Date.now() - startedMs,
      duration: request.duration,
      ...(spec.id !== undefined ? { promptId: spec.id } : {}),
      ...(runLogRel !== undefined ? { runLog: runLogRel } : {}),
      flags,
      gates,
      stageAssignments,
      ...(seededFrom !== undefined ? { seededFrom } : {})
    };
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
  let timeline: DeliveryTimeline;
  for (;;) {
    /* GV-01: a fresh log per attempt; attempt numbers are 1-based, and the
       context's `resumeAttempt` counts the resumes before this attempt. */
    const runLog = new RunLog();
    /* GV-33: one delivery timeline per attempt, like the RunLog — a resumed
       attempt's banked acts fire nothing, so its timeline is its own. */
    timeline = new DeliveryTimeline();
    const attemptTimeline = timeline;
    const attempt = resumes.length + 1;
    const runAttempt: typeof runPipeline = (req, opts, pipelineDeps) =>
      runWithRunLog(runLog, () => withCallContext({ resumeAttempt: resumes.length }, () => runPipeline(req, opts, pipelineDeps)));
    try {
      /* The machine this driver runs on holds the transcript bodies (data-local/,
         gitignored), so §4.5 tier 2 gets the real cue provider. On a checkout
         without them the provider returns null for every episode and the run
         behaves exactly as before — pool segments only. */
      outcome = await runAttempt(
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
          refusedPartial: args.continueOnRefusedPartial ? "continue" : "abort",
          flags,
          gates,
          routing
        },
        {
          cueProvider: deps.cueProvider,
          textIndex: deps.textIndex,
          checkpoint: args.dryRun ? undefined : checkpointStore,
          onActReady,
          onItemReady: async (ev) => {
            attemptTimeline.record(ev);
            if (jobSink) {
              jobProgress = progressWithEvent(jobProgress, ev);
              await publishJob();
            }
          }
        }
      );
      writeRunLog(runLog, attempt);
      calls += getUsageTotals().calls;
      break;
    } catch (err) {
      writeRunLog(runLog, attempt);
      calls += getUsageTotals().calls;
      const failure = classifyFailure(err);
      const detail = failure.reason;
      const checkpointNote = args.dryRun ? "" : ` (checkpoint kept at ${checkpointStore.filePathFor(checkpointKey)})`;
      /* F-87: the act the refusal landed on, for the report (`refusedAtAct`). */
      const refusedAtAct = err instanceof RefusedPartialError ? { act: err.actIndex, totalActs: err.totalActs } : null;

      if (failure.kind === "transient") {
        if (resumes.length < args.maxResumes) {
          const waitMs = resumeBackoffMs(resumes.length);
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
          elapsedMs: runLog.spanMs(),
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
          elapsedMs: runLog.spanMs(),
          abort: { reason: failure.kind, detail },
          ...(resumes.length ? { resumes } : {}),
          ...(refusedPartials.length ? { refusedPartials } : {}),
          ...(refusedAtAct ? { refusedAtAct } : {})
        };
        /* CH2-04: the RUN cap is this process's whole budget, so every later
           prompt would stop at its first metered call. Say so to the batch. */
        const runBudgetSpent = err instanceof BudgetStopError && err.scope === "run";
        return {
          skipped: false,
          entry: await finishEntry(entry, `aborted:${failure.kind}`, lastPartialId),
          ...(runBudgetSpent ? { runBudgetSpent: true } : {})
        };
      }

      console.log(`  ERROR  ${spec.prompt.slice(0, 60)} — ${detail.slice(0, 120)}${checkpointNote}`);
      const entry: ReportEntry = {
        prompt: spec.prompt,
        outcome: "error",
        detail,
        ms: 0,
        elapsedMs: runLog.spanMs(),
        ...(resumes.length ? { resumes } : {})
      };
      return { skipped: false, entry: await finishEntry(entry, "error", lastPartialId) };
    }
  }

  const ms = outcome.timings.reduce((sum, t) => sum + t.ms, 0);
  const line = summarize(outcome);
  const ttlA1Ms = outcome.outcome === "generated" ? outcome.ttlA1Ms : null;
  /* F-86: the spine re-asks, on the run line and in the report. A re-ask is an
     extra Opus call that the first reply's defect paid for, so the line names
     the defect — that is what a person reads to decide whether the prompt
     needs changing. */
  const spineReasks = "spineReasks" in outcome ? outcome.spineReasks : [];
  /* GV-26: the gate verdict the pipeline reached, and MQ-21's run success —
     validated AND through every gate, i.e. publishable without --force. */
  const gate = outcome.outcome === "generated" ? outcome.gate : undefined;
  const gateFail = gate && !gate.ok ? ` GATE FAIL: ${gate.failures[0] ?? "(no reason given)"}` : "";
  console.log(
    `  ${outcome.outcome === "generated" ? "built " : "stop  "} ${spec.prompt.slice(0, 60)} — ${line}` +
      (ttlA1Ms != null ? ` (ttlA1=${ttlA1Ms}ms)` : "") +
      (spineReasks.length ? ` [spine re-asked ${spineReasks.length}x: ${spineReasks.flatMap((r) => r.violations).join("; ")}]` : "") +
      (refusedPartials.length ? ` [partial refused at act ${refusedPartials.map((i) => i + 1).join(", ")}; continued]` : "") +
      gateFail
  );

  /* WS-B: `meta.veracity` rides along on `outcome.input` for every
     "generated" outcome (`runPipeline.ts` attaches it before finalize
     runs, win or lose) — carried into `report.json` here so a candidate
     that FAILED check-forays/check-narration still shows why the
     veracity numbers looked the way they did, not just candidates that
     made it to disk. */
  const veracity = outcome.outcome === "generated" ? outcome.input.meta?.veracity : undefined;
  /* GV-33: the final attempt's delivery timeline. Resumed when any act's
     stitch came off the checkpoint: that act fired no events. */
  const stitchResumed = outcome.timings.some((t) => /^stitch:\d+$/.test(t.name) && t.resumed === true);
  const delivery = outcome.outcome === "generated" ? deliveryReportOf(timeline, stitchResumed) : undefined;
  const entry: ReportEntry = {
    prompt: spec.prompt,
    outcome: outcome.outcome,
    detail: line,
    ms,
    elapsedMs: spanMsOf(outcome.timings),
    ttlA1Ms,
    ...(outcome.outcome === "generated"
      ? { narrationConcurrency: outcome.narration.concurrency, narrationActs: outcome.narration.acts }
      : {}),
    ...(spineReasks.length ? { spineReasks } : {}),
    ...("topicDecision" in outcome ? { topicDecision: outcome.topicDecision } : {}),
    veracity,
    ...(outcome.outcome === "generated" && gate ? { gate, publishable: outcome.result.validation.ok && gate.ok } : {}),
    ...(delivery ? { delivery } : {}),
    ...(outcome.outcome !== "rejected" && outcome.clarityDecidedBy !== undefined ? { clarityDecidedBy: outcome.clarityDecidedBy } : {}),
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
         the same content in the output directory.
         GV-62: under --keep-checkpoints a BENCH prompt's checkpoint stays,
         stamped so a later arm can fork it (main refused the flag unless
         every prompt is a bench prompt; the spec is checked again here). */
      if (args.keepCheckpoints && spec.bench === true) keepCheckpoint(checkpointStore, checkpointKey, forkStamp);
      else checkpointStore.discard(checkpointKey);
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

/** The CLI. Exported (GV-55) so a test can prove a refused argument exits
 * non-zero before anything runs; the script entry below passes process.argv. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    /* GV-55: a malformed --stage-provider stops the run before anything is
       read or spent, naming the entry. */
    if (!(err instanceof CliArgError)) throw err;
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  if (!args.prompts) {
    console.error(
      "Usage: npm run generate-forays -- --prompts prompts.json [--out DIR] " +
        "[--duration short|medium|long] [--limit N] [--budget-usd N] [--no-resume] [--dry-run] " +
        "[--max-resumes N] [--continue-on-refused-partial] [--notify <command>] [--author-id <id>] [--fast-path] [--job-dir <dir>] " +
        "[--stage-provider stage=provider[:lane][,...]] [--keep-checkpoints] [--seed-checkpoints <dir> --rerun-from <stage>]"
    );
    process.exitCode = 1;
    return;
  }
  /* GV-55: the overrides go into the environment the stage factories read,
     before anything resolves a route. */
  Object.assign(process.env, withStageProviders({}, args.stageProviders));
  const batchStartedMs = Date.now();

  try {
    /* F-04. Run 1 could only be started by setting DAILY_BUDGET_USD=1000 (now
       RUN_BUDGET_USD) in the environment, and the run log had to record that as
       an intervention (I-01) because there was no way to say "this run may
       spend N" on the command line. Both caps move together: every metered
       call also counts against the whole run cap, so raising only the
       per-Foray ceiling would just move the stop. */
    if (args.budgetUsd !== null) {
      defaultBudgetGuard.setCaps({ runUsd: args.budgetUsd, episodeUsd: args.budgetUsd });
    }

    const { specs, identity: promptSet } = readPromptSet(args.prompts);
    const queue = args.limit ? specs.slice(0, args.limit) : specs;
    /* GV-62: the fork flags are refused for a listener's prompt before any
       route is resolved or any model called. */
    const benchRefusal = benchFlagRefusal(args, queue);
    if (benchRefusal !== null) {
      console.error(benchRefusal);
      process.exitCode = 1;
      return;
    }

    /* State the mode before doing anything expensive. A run that silently used
       stubs and produced 200 placeholder Forays would look exactly like a
       successful run until someone listened to one. */
    const caps = defaultBudgetGuard.caps();
    /* Which models a run ACTUALLY used, printed rather than assumed: F-03 was
       found by reading source, which is not where a run's behaviour should have
       to be looked up. GV-55: from the routing table (a misconfigured route
       throws here, naming its variable, before any prompt runs). */
    const routing = resolveRouting();
    for (const line of modeLines(routing, caps, modelSummary())) console.log(line);
    /* G-30: the hands-free policy, stated up front for the same reason the
       mode is — a run that quietly aborted on its first refused partial
       should not be a surprise in the log. */
    console.log(
      `POLICY: max-resumes=${args.maxResumes}, refused partial → ${args.continueOnRefusedPartial ? "continue" : "abort"}, ` +
        `notify=${args.notify ? JSON.stringify(args.notify) : "(none)"}`
    );
    console.log(`${queue.length} prompt(s); writing candidates to ${args.out}`);

    fs.mkdirSync(path.resolve(args.out), { recursive: true });

    const cueProvider = new FileTranscriptCueProvider();
    /* WS-H (F-06): the same machine holds the transcript BODIES, so tier 2 also
       gets the text index built over them — read through the cue provider above,
       cached under data-local/transcripts/index/. A checkout without data-local/
       builds nothing, returns no candidates, and leaves tier 2 on the title path. */
    const textIndex = new FileTranscriptTextIndex({ bodies: cueProvider });

    /* #703: WHAT THIS RUN CAN SEE OF ITS OWN CORPUS, BEFORE IT GENERATES
       ANYTHING. The 2026-09-14 run drew its research map from 14 of the 22
       shows on this disk, said nothing about the other eight, and produced a
       germ-theory Foray sourced from geology tape. It looked healthy. The line
       below is printed whether the news is good or bad — a run that can see the
       whole corpus says so — and the same numbers go into report.json, so a
       reader who never watched the console can still tell which corpus a batch
       was sourced from. */
    const archive = loadTranscriptArchive();
    /* One stat per row, shared by the coverage count and the fingerprint. */
    const bodyOnDisk = new Map<TranscriptDigestEntry, boolean>();
    const hasBody = (entry: TranscriptDigestEntry): boolean => {
      let known = bodyOnDisk.get(entry);
      if (known === undefined) {
        known = cueProvider.bodyStat(entry) !== null;
        bodyOnDisk.set(entry, known);
      }
      return known;
    };
    const coverage = corpusCoverage({
      archive,
      hasBody: (entry) => hasBody(entry as TranscriptDigestEntry),
      /* The same directory `FileTranscriptCueProvider` defaults to, resolved
         the same way: two levels up from `backend/src/cli`. */
      normalizedRoot: path.resolve(__dirname, "..", "..", "..", "data-local", "transcripts", "normalized")
    });
    if (coverage.showsOnDisk > 0) console.log(corpusCoverageLine(coverage));
    /* GV-39: the golden-set corpus snapshot — which rows, with which content
       digests, this run could read, through which index format. */
    const corpus = corpusReport(
      coverage,
      corpusFingerprint({
        archive,
        hasBody: (entry) => hasBody(entry as TranscriptDigestEntry),
        indexVersion: TRANSCRIPT_TEXT_INDEX_VERSION
      })
    );

    const { report, generated, skipped } = await generateQueue(queue, (spec) =>
      generateOneCandidate(spec, args, { cueProvider, textIndex })
    );

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
    /* backend-rest-7: the batch is re-run in the same --out directory by
       design (the skip above is the outer resume), so report.json is MERGED,
       not rewritten from this run alone. Rows for candidates skipped as
       already built, and the publish / publish_refused records publish-foray
       wrote onto them, survive the re-run; a rebuilt candidate's row starts
       clean. Read once, before this run writes. */
    const priorEntries = args.dryRun ? [] : readPriorReportEntries(reportPath);
    const writeReport = (notification: NotificationResult | null): void => {
      if (args.dryRun) return;
      const entries = mergeReportEntries(priorEntries, report);
      fs.writeFileSync(
        reportPath,
        `${JSON.stringify(
          batchReportDocument({
            generatedAt: new Date().toISOString(),
            maxResumes: args.maxResumes,
            continueOnRefusedPartial: args.continueOnRefusedPartial,
            resumes: resumesTotal,
            aborts,
            notify: args.notify,
            notification,
            corpus,
            prompts: promptSet,
            generationMode: routing.mode,
            routing: routingSummary(routing),
            entries
          }),
          null,
          2
        )}\n`
      );
    };
    /* Written BEFORE the hook runs, so a hook that reads report.json sees the
       finished batch; rewritten after, so the report carries the hook's result. */
    writeReport(null);

    const summaryText = batchSummaryText({ report, generated, skipped, aborts, validCount: publishable, resumesTotal });
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
