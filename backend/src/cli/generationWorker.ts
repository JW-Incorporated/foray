#!/usr/bin/env node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { format } from "util";
import {
  generateOneCandidate,
  openRemoteRetrieval,
  runStartIntegrity,
  DEFAULT_MAX_RESUMES,
  modeLines,
  type CandidateResult,
  type CliArgs,
  type PromptSpec,
} from "./generateForays";
import { SupabaseJobSink, type JobSinkFetch } from "./supabaseJobSink";
import { SpoolRenderClient } from "./spoolRenderClient";
import {
  runForayPipeline,
  type RetrievalPreparer,
} from "../generation/runPipeline";
import {
  isJobLane,
  type GenerationJobSink,
  type JobLane,
} from "../generation/jobSink";
import type { NarrationRenderClient } from "../generation/narrationRender";
import {
  FileTranscriptCueProvider,
  loadTranscriptArchive,
  type TranscriptCueProvider,
} from "../generation/transcriptArchiveLookup";
import {
  FileTranscriptTextIndex,
  type TranscriptTextIndex,
} from "../generation/transcriptTextIndex";
import { retrievalConfig } from "../generation/generationFlags";
import { scanNormalizedCorpus } from "../generation/transcriptCorpus";
import { integrityGate } from "../generation/archiveIntegrity";
import { dataLocalRefusal } from "../generation/judgeCalibration";
import { anthropicCallCount } from "../generation/usageTracking";
import {
  ALLOW_ANTHROPIC_LEGACY_ENV,
  ANTHROPIC_API_KEY_ENV,
  RoutingConfigError,
  ZERO_ANTHROPIC_RULE,
  resolveRouting,
} from "../config/stageRouting";
import { defaultBudgetGuard } from "../cost/budgetGuard";
import { modelSummary } from "../config/models";

/**
 * GV-105 (docs/roadmap/generation-v2.md, #1286; from W6-19; R1-15, GP-07,
 * GP-08): the Spark generation worker. It closes the on-demand loop: an
 * author's queued `generation_jobs` row (GV-59,
 * backend/migrations/supabase/0007_generation_jobs.sql) is claimed, generated
 * by the SAME `generateOneCandidate` -> `runForayPipeline` path the batch
 * driver runs (classic, or per-act under FORAY_PER_ACT_PIPELINE), and served
 * ahead of the playhead: every item-level snapshot goes to the row through a
 * SupabaseJobSink (GV-44/GV-59) and every narration line to the render spool
 * (GV-74, phone voice first).
 *
 * THE LOOP, one job at a time (OQ-07: the Spark is shared, Foray first in
 * line; the lane scheduler's semaphores handle concurrency inside a run):
 *   1. rpc `claim_generation_job(worker)`: the row moves to `claimed` and its
 *      prompt is NULLed in the same statement (the prompt now lives only in
 *      this process's memory);
 *   2. generateOneCandidate with the job sink, the spool render client, the
 *      row's lane and `phone-voice-first`;
 *   3. a heartbeat touches the row every 10 s (the trigger stamps
 *      updated_at), so a dead worker shows as a row gone quiet;
 *   4. an exception closes the job `failed` with a short code and the loop
 *      goes on (generateOneCandidate closes the row itself for every outcome
 *      it reaches; the worker closes only what escapes it);
 *   5. an empty queue backs off (2 s doubling to 30 s), never a busy loop.
 *
 * ZERO ANTHROPIC (the founder's rule, roadmap "Constraints"). The worker
 * refuses to START when any stage would be built on an Anthropic builder,
 * when ANTHROPIC_BASE_URL is set (the relay), or when ANTHROPIC_API_KEY is in
 * its environment (`workerStartRefusal`). After every job it re-reads the
 * process's Anthropic request count, and stops the loop if it moved. Stub
 * builders (no FORAY_LLM_BASE_URL) are allowed: that is the end-to-end
 * plumbing run.
 *
 * THE PROMPT IS NEVER LOGGED OR WRITTEN. Log lines name the job id
 * (`promptLabel`), files are keyed `job-<uuid>` (`candidateKey`), the job
 * sink refuses any body with a prompt key, and while a job runs every console
 * line is passed through `redactPrompt` so a stage that echoes the request
 * cannot leak it either. A job that does not complete has its resumable
 * checkpoint and partial deleted when it closes (`discardJobLeftovers`): the
 * classic path banks research with the prompt inside, and a closed job is
 * never resumed. The candidate the run builds stays under
 * data-local/ (`--out`, refused elsewhere) and is never published:
 * an on-demand Foray enters the catalogue only through publish-foray's lane
 * check (GV-81).
 *
 * DARK. A new CLI that nothing starts: `node tools/generation/generation-worker.mjs`
 * on the Spark, with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or
 * SUPABASE_SERVICE_ROLE_KEY_FILE). Everything the loop touches is injected
 * (RPC client, sink factory, pipeline, clock), so the tests run offline.
 */

export const WORKER_HEARTBEAT_MS = 10_000;
export const IDLE_BACKOFF = Object.freeze({ minMs: 2_000, maxMs: 30_000 });
/** The default --out: a directory under data-local/ (gitignored). */
export const DEFAULT_WORKER_OUT = path.join("data-local", "generation-worker");
/** Short close codes (JOB_DETAIL_PATTERN). */
export const WORKER_ERROR_DETAIL = "worker-error";
export const BAD_JOB_DETAIL = "bad-job";
export const ALREADY_BUILT_DETAIL = "already-built";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIERS = ["short", "medium", "long"] as const;
type Tier = (typeof TIERS)[number];

/** What claim_generation_job hands over. `prompt` exists only here, in memory. */
export interface ClaimedJob {
  id: string;
  authorId: string;
  tier: string;
  lane: string;
  prompt: string | null;
}

/** The two calls the worker makes on the job table itself. */
export interface WorkerRpc {
  /** One queued job, now `claimed` by `worker` with its prompt NULLed in the
   * row; null when the queue is empty. */
  claim(worker: string): Promise<ClaimedJob | null>;
  /** Touch an open row so its updated_at moves. */
  heartbeat(jobId: string, worker: string): Promise<void>;
}

export interface WorkerClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Call `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
}

export const systemClock: WorkerClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

/**
 * PostgREST calls for the worker, with the service-role key (D8: on the
 * Spark only). `fetch` is injected and required, like SupabaseJobSink's, so
 * no test reaches the network. The key goes only into the two auth headers;
 * errors carry the HTTP status, never a body or the key.
 */
export class SupabaseWorkerRpc implements WorkerRpc {
  private readonly base: string;
  private readonly key: string;
  private readonly fetchImpl: WorkerFetch;

  constructor(opts: {
    baseUrl: string;
    serviceKey: string;
    fetch: WorkerFetch;
  }) {
    if (!/^https?:\/\/[^/?#]+\/?$/.test(opts.baseUrl))
      throw new Error(
        "SupabaseWorkerRpc: baseUrl must be the project origin (https://<ref>.supabase.co)",
      );
    if (!opts.serviceKey)
      throw new Error("SupabaseWorkerRpc: a service key is required");
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.key = opts.serviceKey;
    this.fetchImpl = opts.fetch;
  }

  async claim(worker: string): Promise<ClaimedJob | null> {
    const res = await this.fetchImpl(
      `${this.base}/rest/v1/rpc/claim_generation_job`,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ p_worker: worker }),
      },
    );
    if (!res.ok)
      throw new Error(
        `SupabaseWorkerRpc: claim_generation_job failed (HTTP ${res.status})`,
      );
    const rows = await res.json();
    const row = Array.isArray(rows)
      ? (rows[0] as Record<string, unknown> | undefined)
      : undefined;
    if (!row) return null;
    const { id, author_id: authorId, tier, lane, prompt } = row;
    if (typeof id !== "string" || !UUID.test(id))
      throw new Error("SupabaseWorkerRpc: the claimed row has no readable id");
    if (typeof authorId !== "string")
      throw new Error(
        `SupabaseWorkerRpc: claimed job ${id} has no readable author_id`,
      );
    return {
      id: id.toLowerCase(),
      authorId,
      tier: typeof tier === "string" ? tier : "",
      lane: typeof lane === "string" ? lane : "",
      prompt: typeof prompt === "string" ? prompt : null,
    };
  }

  async heartbeat(jobId: string, worker: string): Promise<void> {
    if (!UUID.test(jobId))
      throw new Error("SupabaseWorkerRpc: heartbeat needs the row's uuid");
    /* Setting worker to its own value is an UPDATE, so the before-update
       trigger stamps updated_at. Only an open row (claimed, running) is
       touched: a cancelled or closed job is left alone. */
    const res = await this.fetchImpl(
      `${this.base}/rest/v1/generation_jobs?id=eq.${jobId.toLowerCase()}&status=in.(claimed,running)`,
      {
        method: "PATCH",
        headers: {
          ...this.headers(),
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ worker }),
      },
    );
    if (!res.ok)
      throw new Error(
        `SupabaseWorkerRpc: heartbeat for job ${jobId} failed (HTTP ${res.status})`,
      );
  }

  private headers(): Record<string, string> {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      Accept: "application/json",
    };
  }
}

/** The slice of `fetch` the worker's RPC client uses. */
export type WorkerFetch = (
  url: string,
  init: {
    method: "POST" | "PATCH";
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Why the worker must not start, or null. The zero-Anthropic rule, checked
 * against the environment the stage factories read:
 *   - ANTHROPIC_BASE_URL set: the relay (the worker must never fall back to it);
 *   - ANTHROPIC_API_KEY set: a Spark worker has no use for one, and a key in
 *     its environment is the only way a builder outside the routing table
 *     could reach Anthropic (env.anthropicDryRun false);
 *   - any stage routed 'anthropic' (which resolveRouting allows only under
 *     FORAY_GENERATION_MODE=anthropic-legacy with the legacy opt-in), or a
 *     routing table that does not resolve;
 *   - FORAY_ALLOW_ANTHROPIC_LEGACY set: the legacy opt-in has no place here.
 * Messages name variables and stages, never values.
 */
export function workerStartRefusal(
  source: NodeJS.ProcessEnv = process.env,
): string | null {
  const set = (name: string): boolean => (source[name] ?? "").trim() !== "";
  const why = (reason: string): string =>
    `generation-worker refuses to start: ${reason} (${ZERO_ANTHROPIC_RULE})`;
  if (set("ANTHROPIC_BASE_URL"))
    return why(
      "ANTHROPIC_BASE_URL is set, which points the Anthropic SDK at a relay; unset it",
    );
  if (set(ANTHROPIC_API_KEY_ENV))
    return why(
      `${ANTHROPIC_API_KEY_ENV} is set; the worker runs only with local or stub builders, so unset it`,
    );
  let routing;
  try {
    routing = resolveRouting(source);
  } catch (err) {
    if (err instanceof RoutingConfigError)
      return why(
        `the stage routing does not resolve (${err.variable}): ${err.message}`,
      );
    throw err;
  }
  const anthropicStages = Object.entries(routing.routes)
    .filter(([, route]) => route?.provider === "anthropic")
    .map(([stage]) => stage);
  if (anthropicStages.length)
    return why(
      `stage(s) ${anthropicStages.join(", ")} would be built on an Anthropic builder`,
    );
  if (set(ALLOW_ANTHROPIC_LEGACY_ENV))
    return why(
      `${ALLOW_ANTHROPIC_LEGACY_ENV} is set; the legacy Anthropic builders are never allowed in the worker`,
    );
  return null;
}

/** `text` with every copy of the prompt (and of its 40-, 60- and 120-character
 * prefixes, the lengths log lines cut it to) replaced by "[prompt]". */
export function redactPrompt(text: string, prompt: string): string {
  /* The whole prompt always; a prefix only when long enough not to match
     ordinary words. */
  const full = prompt.trim();
  const prefixes = [
    prompt.slice(0, 120),
    prompt.slice(0, 60),
    prompt.slice(0, 40),
  ]
    .map((n) => n.trim())
    .filter((n) => n.length >= 12);
  const needles = [...new Set([full, ...prefixes])]
    .filter((n) => n.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const needle of needles) out = out.split(needle).join("[prompt]");
  return out;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error"] as const;

/** Runs `fn` with console.log/info/warn/error redacting `prompt`. The worker
 * runs one job at a time, so one patch at a time. */
export async function withRedactedConsole<T>(
  prompt: string,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = CONSOLE_METHODS.map((m) => [m, console[m]] as const);
  for (const [m, original] of saved) {
    console[m] = (...args: unknown[]) =>
      original.call(console, redactPrompt(format(...args), prompt));
  }
  try {
    return await fn();
  } finally {
    for (const [m, original] of saved) console[m] = original;
  }
}

export interface WorkerSources {
  cueProvider: TranscriptCueProvider;
  textIndex?: TranscriptTextIndex;
  retrieval?: RetrievalPreparer;
}

export interface WorkerOptions {
  /** The worker's name in the row (1-120 characters). */
  worker: string;
  /** Where candidates, checkpoints and runlogs go (under data-local/). */
  out: string;
  /** GV-22's render spool; absent, nothing is rendered and the phone speaks
   * every line. */
  renderSpool?: string;
  maxResumes?: number;
  /** Stop after this many jobs (the CLI's --once is 1). */
  maxJobs?: number;
  /** End the loop at the first empty queue instead of backing off (--once). */
  exitWhenIdle?: boolean;
  /** Checked before every claim; true ends the loop (SIGINT/SIGTERM). */
  stop?: () => boolean;
  idleBackoff?: { minMs: number; maxMs: number };
  heartbeatMs?: number;
  /** The environment the start refusal reads (default process.env, which is
   * what the stage factories read). */
  env?: NodeJS.ProcessEnv;
}

export interface WorkerDeps {
  rpc: WorkerRpc;
  /** One sink per claimed job (a SupabaseJobSink on that row). */
  sinkFor: (jobId: string) => GenerationJobSink;
  sources: WorkerSources;
  clock?: WorkerClock;
  /** The pipeline each job runs (default runForayPipeline). */
  runPipeline?: typeof runForayPipeline;
  /** One render client per job (default a SpoolRenderClient over
   * `renderSpool`); used only with `renderSpool`. */
  renderClientFor?: (spool: string) => NarrationRenderClient;
  /** Test seam: the per-job driver (default generateOneCandidate). */
  generate?: typeof generateOneCandidate;
  /** The process's Anthropic request count (default usageTracking's). */
  anthropicCalls?: () => number;
  log?: (line: string) => void;
}

export type JobEnd = "complete" | "failed" | "error";

export interface WorkerStats {
  claimed: number;
  complete: number;
  failed: number;
  idleWaits: number;
  /** Set when the loop ended on the zero-Anthropic rule (or never started). */
  refused: string | null;
}

/**
 * The loop. Returns when `stop()` says so, after `maxJobs` jobs, or at once
 * with `refused` set when `workerStartRefusal` refuses the environment.
 */
export async function runWorker(
  opts: WorkerOptions,
  deps: WorkerDeps,
): Promise<WorkerStats> {
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? ((line: string) => console.log(line));
  const stats: WorkerStats = {
    claimed: 0,
    complete: 0,
    failed: 0,
    idleWaits: 0,
    refused: null,
  };
  const refusal = workerStartRefusal(opts.env ?? process.env);
  if (refusal !== null) {
    stats.refused = refusal;
    return stats;
  }
  if (!opts.worker || opts.worker.length > 120)
    throw new Error("runWorker: the worker name must be 1-120 characters");
  const backoff = opts.idleBackoff ?? IDLE_BACKOFF;
  const anthropicCalls = deps.anthropicCalls ?? anthropicCallCount;
  const anthropicAtStart = anthropicCalls();
  let idleMs = 0;
  while (
    !(opts.stop?.() ?? false) &&
    (opts.maxJobs === undefined || stats.claimed < opts.maxJobs)
  ) {
    let job: ClaimedJob | null;
    try {
      job = await deps.rpc.claim(opts.worker);
    } catch (err) {
      log(
        `worker: claim failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      job = null;
    }
    if (job === null) {
      if (opts.exitWhenIdle) break;
      idleMs =
        idleMs === 0 ? backoff.minMs : Math.min(backoff.maxMs, idleMs * 2);
      stats.idleWaits += 1;
      await clock.sleep(idleMs);
      continue;
    }
    idleMs = 0;
    stats.claimed += 1;
    const end = await runJob(job, opts, deps, clock, log);
    if (end === "complete") stats.complete += 1;
    else stats.failed += 1;
    const sent = anthropicCalls() - anthropicAtStart;
    if (sent > 0) {
      stats.refused = `generation-worker stopped: ${sent} Anthropic request(s) were sent (${ZERO_ANTHROPIC_RULE})`;
      log(stats.refused);
      break;
    }
  }
  return stats;
}

/** One claimed job, start to close. Never throws: what escapes the driver
 * closes the row `failed` with a short code. */
export async function runJob(
  job: ClaimedJob,
  opts: WorkerOptions,
  deps: WorkerDeps,
  clock: WorkerClock = systemClock,
  log: (line: string) => void = (l) => console.log(l),
): Promise<JobEnd> {
  const tag = `job ${job.id}`;
  let sink: GenerationJobSink;
  try {
    sink = deps.sinkFor(job.id);
  } catch (err) {
    log(
      `worker: ${tag}: could not open the job sink: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "error";
  }
  const closeFailed = async (detail: string): Promise<void> => {
    try {
      await sink.close("failed", detail);
    } catch (err) {
      log(
        `worker: ${tag}: could not close the job: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const prompt = job.prompt?.trim() ?? "";
  if (
    !prompt ||
    !(TIERS as readonly string[]).includes(job.tier) ||
    !isJobLane(job.lane)
  ) {
    log(
      `worker: ${tag}: refused (${!prompt ? "no prompt" : !isJobLane(job.lane) ? "unknown lane" : "unknown tier"})`,
    );
    await closeFailed(BAD_JOB_DETAIL);
    return "failed";
  }
  const tier = job.tier as Tier;
  const lane: JobLane = job.lane;
  const spec: PromptSpec = { prompt, duration: tier };
  const args: CliArgs = {
    prompts: null,
    out: opts.out,
    duration: tier,
    limit: null,
    dryRun: false,
    authorId: job.authorId,
    budgetUsd: null,
    noResume: false,
    maxResumes: opts.maxResumes ?? DEFAULT_MAX_RESUMES,
    continueOnRefusedPartial: false,
    notify: null,
    lane,
    ...(opts.renderSpool !== undefined
      ? {
          renderSpool: opts.renderSpool,
          audioPolicy: "phone-voice-first" as const,
        }
      : {}),
  };
  const renderClient =
    opts.renderSpool !== undefined
      ? (
          deps.renderClientFor ??
          ((spool: string) =>
            new SpoolRenderClient(path.resolve(spool), () => clock.now()))
        )(opts.renderSpool)
      : undefined;
  const generate = deps.generate ?? generateOneCandidate;
  log(`worker: ${tag}: claimed (${tier}, ${lane})`);
  const stopHeartbeat = clock.every(
    opts.heartbeatMs ?? WORKER_HEARTBEAT_MS,
    () => {
      deps.rpc
        .heartbeat(job.id, opts.worker)
        .catch((err: unknown) =>
          log(
            `worker: ${tag}: heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    },
  );
  let end: JobEnd = "error";
  try {
    const result: CandidateResult = await withRedactedConsole(prompt, () =>
      generate(spec, args, {
        cueProvider: deps.sources.cueProvider,
        ...(deps.sources.textIndex
          ? { textIndex: deps.sources.textIndex }
          : {}),
        ...(deps.sources.retrieval
          ? { retrieval: deps.sources.retrieval }
          : {}),
        ...(deps.runPipeline ? { runPipeline: deps.runPipeline } : {}),
        sleep: (ms: number) => clock.sleep(ms),
        now: () => clock.now(),
        newJobId: () => job.id,
        jobSink: sink,
        ...(renderClient ? { renderClient } : {}),
        promptLabel: tag,
        candidateKey: `job-${job.id}`,
      }),
    );
    if (result.skipped) {
      /* A file already keyed by this job id: the row must not read "claimed"
         forever. */
      log(
        `worker: ${tag}: a candidate for this job already exists; closing it`,
      );
      await closeFailed(ALREADY_BUILT_DETAIL);
      end = "failed";
      return end;
    }
    const built = result.entry?.file !== undefined;
    log(
      `worker: ${tag}: ${built ? "complete" : `closed (${result.entry?.outcome ?? "no outcome"})`}`,
    );
    end = built ? "complete" : "failed";
    return end;
  } catch (err) {
    log(
      `worker: ${tag}: failed: ${redactPrompt(err instanceof Error ? err.message : String(err), prompt).slice(0, 200)}`,
    );
    await closeFailed(WORKER_ERROR_DETAIL);
    end = "error";
    return end;
  } finally {
    stopHeartbeat();
    /* A closed job is never resumed, and the in-call resume loop has ended:
       whatever generateOneCandidate kept "to resume" for an unfinished job
       must go, because the classic path banks research with the prompt
       inside (subjectTape.query). A complete job's checkpoint and partial
       are already discarded by the driver. */
    if (end !== "complete") discardJobLeftovers(opts.out, `job-${job.id}`, log);
  }
}

/**
 * Best-effort removal of a closed job's resumable leftovers under --out: its
 * `<key>.checkpoint.json` (and the store's `.tmp` beside it) and its
 * `<key>.partial.json`. Never throws; a file the run never wrote is fine.
 * Runlogs stay (stage timings and counts, no prompt).
 */
export function discardJobLeftovers(
  out: string,
  key: string,
  log: (line: string) => void = (l) => console.log(l),
): void {
  const dir = path.resolve(out);
  for (const name of [
    `${key}.checkpoint.json`,
    `${key}.checkpoint.json.tmp`,
    `${key}.partial.json`,
  ]) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own job-<uuid> key under its --out.
      fs.unlinkSync(path.join(dir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        log(
          `worker: could not discard ${name}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
  }
}

/** --flag value, or undefined. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--"))
    throw new Error(`${flag} needs a value`);
  return v;
}

export interface WorkerCliArgs {
  worker: string;
  out: string;
  renderSpool?: string;
  once: boolean;
  maxResumes: number;
  allowShortArchive: boolean;
}

export function parseWorkerArgs(
  argv: readonly string[],
  hostname: string = os.hostname(),
): WorkerCliArgs {
  const out = flagValue(argv, "--out") ?? DEFAULT_WORKER_OUT;
  const outRefusal = dataLocalRefusal("--out", out);
  if (outRefusal !== null) throw new Error(outRefusal);
  const worker = (flagValue(argv, "--worker") ?? `spark-${hostname}`).slice(
    0,
    120,
  );
  const renderSpool = flagValue(argv, "--render-spool");
  const maxResumesRaw = flagValue(argv, "--max-resumes");
  const maxResumes =
    maxResumesRaw === undefined
      ? DEFAULT_MAX_RESUMES
      : Number.parseInt(maxResumesRaw, 10);
  if (!Number.isInteger(maxResumes) || maxResumes < 0)
    throw new Error("--max-resumes must be a whole number >= 0");
  return {
    worker,
    out,
    ...(renderSpool !== undefined ? { renderSpool } : {}),
    once: argv.includes("--once"),
    maxResumes,
    allowShortArchive: argv.includes("--allow-short-archive"),
  };
}

/** SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY_FILE;
 * errors name the variable, never the value. */
export function supabaseWorkerConfig(
  source: NodeJS.ProcessEnv = process.env,
  readFile: (f: string) => string = (f) => fs.readFileSync(f, "utf8"),
): { baseUrl: string; serviceKey: string } {
  const baseUrl = source.SUPABASE_URL?.trim();
  if (!baseUrl) throw new Error("generation-worker: SUPABASE_URL is not set");
  let serviceKey = source.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const keyFile = source.SUPABASE_SERVICE_ROLE_KEY_FILE?.trim();
  if (!serviceKey && keyFile) {
    try {
      serviceKey = readFile(keyFile).trim();
    } catch {
      throw new Error(
        "generation-worker: SUPABASE_SERVICE_ROLE_KEY_FILE could not be read",
      );
    }
  }
  if (!serviceKey)
    throw new Error(
      "generation-worker: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE_KEY_FILE) is not set",
    );
  return { baseUrl, serviceKey };
}

/** The CLI: refuse, open the corpus the batch driver opens, loop. */
export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const refusal = workerStartRefusal(process.env);
  if (refusal !== null) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }
  let args: WorkerCliArgs;
  let supabase: { baseUrl: string; serviceKey: string };
  try {
    args = parseWorkerArgs(argv);
    supabase = supabaseWorkerConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  for (const line of modeLines(
    resolveRouting(),
    defaultBudgetGuard.caps(),
    modelSummary(),
  ))
    console.log(line);
  fs.mkdirSync(path.resolve(args.out), { recursive: true });

  /* The batch driver's sources (generateForays main): the retrieval server
     when FORAY_RETRIEVAL_URL is set, else this machine's transcript files. */
  const retrievalFlags = retrievalConfig();
  const archive = loadTranscriptArchive();
  const remote = retrievalFlags
    ? await openRemoteRetrieval(retrievalFlags, archive)
    : null;
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const localShows = remote
    ? []
    : scanNormalizedCorpus(
        path.join(repoRoot, "data-local", "transcripts", "normalized"),
      );
  const gate = integrityGate(
    runStartIntegrity(remote, localShows, repoRoot),
    args.allowShortArchive,
  );
  for (const line of gate.lines)
    (gate.refuse ? console.error : console.log)(line);
  if (gate.refuse) {
    process.exitCode = 2;
    return;
  }
  let sources: WorkerSources;
  if (remote) {
    sources = {
      cueProvider: remote.cueProvider,
      textIndex: remote.textIndex,
      retrieval: remote.retrieval,
    };
  } else {
    const fileProvider = new FileTranscriptCueProvider();
    sources = {
      cueProvider: fileProvider,
      textIndex: new FileTranscriptTextIndex({ bodies: fileProvider }),
    };
  }

  const fetchImpl = globalThis.fetch as unknown as WorkerFetch & JobSinkFetch;
  let stopping = false;
  const stop = (): void => {
    stopping = true;
    console.log("worker: stopping after the current job");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(
    `worker: ${args.worker} polling ${supabase.baseUrl} (one job at a time${args.once ? ", --once" : ""}); candidates under ${args.out}`,
  );
  const stats = await runWorker(
    {
      worker: args.worker,
      out: args.out,
      ...(args.renderSpool !== undefined
        ? { renderSpool: args.renderSpool }
        : {}),
      maxResumes: args.maxResumes,
      ...(args.once ? { maxJobs: 1, exitWhenIdle: true } : {}),
      stop: () => stopping,
    },
    {
      rpc: new SupabaseWorkerRpc({ ...supabase, fetch: fetchImpl }),
      sinkFor: (jobId) =>
        new SupabaseJobSink({ ...supabase, jobId, fetch: fetchImpl }),
      sources,
    },
  );
  console.log(
    `worker: ${stats.claimed} job(s) claimed, ${stats.complete} complete, ${stats.failed} failed`,
  );
  if (stats.refused !== null) {
    console.error(stats.refused);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
