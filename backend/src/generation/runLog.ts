/**
 * GV-01 (docs/roadmap/generation-v2.md, from W1-02): ONE log per pipeline
 * attempt, carried through every await by AsyncLocalStorage, so a stage, a
 * model call or a render can say what it did without anyone threading a
 * parameter through the seven builders.
 *
 * WHAT IT IS. An in-memory, append-only list of typed events plus a merged
 * "call context" ({stage, act, attempt, tier, ...}) that an enclosing caller
 * sets and anything below it reads. Every event type the measurement
 * workstream will emit is declared HERE, now, so the producers (stages,
 * providers, renders, meters) and the reader in tools/generation-bench agree
 * on one shape (`runlog/1`) before either side exists.
 *
 * WHAT IT IS NOT. It never writes a file: the CLI (`cli/generateForays.ts`)
 * serialises it with `toJsonl()` and decides where it goes, which keeps every
 * module under `generation/` free of disk writes (promptNoPersistence.test.ts).
 * It never holds prompt text or model output: names, numbers and ids only.
 *
 * INERT OUTSIDE A RUN. Every helper below is a no-op when no log is active —
 * `withCallContext` just runs its function, `currentRunLog()` is undefined,
 * `currentCallContext()` is empty — so a caller that never opens a log (every
 * test that predates this module, the HTTP routes) behaves exactly as before.
 *
 * Decision 3 of the roadmap: this one context serves timers, budgets and lane
 * priority; there is no separate chat/callContext.ts, and the provider layer
 * imports `withCallContext` from here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { outputBudgetMode, stampOutputBudget } from "../config/outputBudgets";

export const RUNLOG_SCHEMA = "runlog/1" as const;

/* ---------------------------------------------------------------------------
   Event types. All times are milliseconds since the log's t0.
   --------------------------------------------------------------------------- */

export type StageStatus = "ok" | "failed" | "resumed";

/** One pipeline stage (`understand`, `topic`, `narrate:2`, ...). A stage that
 * threw is `failed` with its real duration; a stage whose output came from a
 * checkpoint is `resumed` with ms 0. `act` is the trailing `:<n>` of the name. */
export interface StageSpan {
  kind: "stage";
  name: string;
  act?: number;
  startMs: number;
  endMs: number;
  ms: number;
  status: StageStatus;
}

/** One model request, success or failure (GV-07 appends these at the
 * provider choke point). Fields a provider cannot know are `null`, never 0:
 * an absent measurement must not read as a fast one. */
export interface CallRecord {
  kind: "call";
  seq: number;
  stage: string | null;
  act: number | null;
  seam: string | number | null;
  attempt: number | null;
  role: string | null;
  reask: string | null;
  provider: string;
  machine: string | null;
  model: string;
  label: string;
  startMs: number;
  endMs: number;
  ms: number;
  queueMs: number | null;
  ttftMs: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  decodeTokPerSec: number | null;
  maxTokens: number | null;
  outputBudget: number | null;
  overBudget: boolean | null;
  stopReason: string | null;
  jsonValid: boolean | null;
  error?: { kind: string; status?: number };
}

/** A structured reply's parse outcome; `reask` says whether it cost a re-ask. */
export interface ParseEvent {
  kind: "parse";
  ok: boolean;
  reask: boolean;
}

/** Code time inside a stage, aggregated per (stage, name) rather than one
 * event per call, so a hot loop does not flood the log. */
export interface CodeSpanAggregate {
  kind: "code";
  stage: string | null;
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

/** An act or an item became playable. `partialOk` is the partial candidate's
 * verdict when one was built, else null. */
export interface ReadyEvent {
  kind: "ready";
  granularity: "act" | "item";
  actIndex: number;
  itemIds: string[];
  readyMs: number;
  partialOk: boolean | null;
}

/** One rendered narration item: seconds of audio produced in `ms`. */
export interface RenderSpan {
  kind: "render";
  itemId: string;
  audioSec: number;
  ms: number;
}

/** Spend against a unit cap (Spark seconds, Jev calls, ...). */
export interface MeterEvent {
  kind: "meter";
  unit: string;
  amount: number;
  reserved: boolean;
  stage: string | null;
}

export type RunLogEvent = StageSpan | CallRecord | ParseEvent | CodeSpanAggregate | ReadyEvent | RenderSpan | MeterEvent;
export type RunLogEventKind = RunLogEvent["kind"];
export type RunLogEventOf<K extends RunLogEventKind> = Extract<RunLogEvent, { kind: K }>;

/** The header line `toJsonl()` starts with; a reader refuses a file without it. */
export interface RunLogHeader {
  schema: typeof RUNLOG_SCHEMA;
  t0Iso: string;
}

/* ---------------------------------------------------------------------------
   Call context: what an enclosing caller knows about the work below it.
   --------------------------------------------------------------------------- */

export interface CallContext {
  stage?: string;
  act?: number;
  seam?: string | number;
  attempt?: number;
  role?: string;
  reask?: string;
  /** The request's duration tier (short / medium / long). */
  tier?: string;
  /** How many automatic resumes preceded this pipeline attempt (0 = first). */
  resumeAttempt?: number;
  /** Lane priority for the scheduler (GV-93). */
  priority?: "critical" | "background";
  lane?: string;
}

export interface CallTotals {
  calls: number;
  ms: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/* ---------------------------------------------------------------------------
   The log.
   --------------------------------------------------------------------------- */

export class RunLog {
  readonly t0Ms: number;
  readonly t0Iso: string;
  private readonly clock: () => number;
  private readonly list: RunLogEvent[] = [];

  /** `now` is an epoch-milliseconds clock, injected so a test can pin time. */
  constructor(opts: { now?: () => number } = {}) {
    this.clock = opts.now ?? (() => Date.now());
    this.t0Ms = this.clock();
    this.t0Iso = new Date(this.t0Ms).toISOString();
  }

  /** Milliseconds since t0 on this log's clock. */
  nowMs(): number {
    return this.clock() - this.t0Ms;
  }

  append(event: RunLogEvent): void {
    this.list.push(event);
  }

  /** Every event, or only those of one kind, in append order (a copy). */
  events(): RunLogEvent[];
  events<K extends RunLogEventKind>(kind: K): RunLogEventOf<K>[];
  events(kind?: RunLogEventKind): RunLogEvent[] {
    return kind === undefined ? [...this.list] : this.list.filter((e) => e.kind === kind);
  }

  stages(): StageSpan[] {
    return this.events("stage");
  }

  calls(): CallRecord[] {
    return this.events("call");
  }

  /** Sums over every CallRecord; a token count a provider did not report
   * (null) adds nothing. */
  callTotals(): CallTotals {
    const totals: CallTotals = { calls: 0, ms: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0 };
    for (const c of this.calls()) {
      totals.calls += 1;
      totals.ms += c.ms;
      totals.promptTokens += c.promptTokens ?? 0;
      totals.cachedTokens += c.cachedTokens ?? 0;
      totals.outputTokens += c.outputTokens ?? 0;
    }
    return totals;
  }

  /** True elapsed time of the stages that RAN (ok or failed): last end minus
   * first start, so overlapping stages are not double-counted. Resumed spans
   * are excluded — they did not run in this attempt. Null when nothing ran. */
  spanMs(): number | null {
    const ran = this.stages().filter((s) => s.status !== "resumed");
    if (ran.length === 0) return null;
    return Math.max(...ran.map((s) => s.endMs)) - Math.min(...ran.map((s) => s.startMs));
  }

  /** A header line `{schema, t0Iso}`, then one event per line, newline-terminated. */
  toJsonl(): string {
    const header: RunLogHeader = { schema: RUNLOG_SCHEMA, t0Iso: this.t0Iso };
    return [header, ...this.list].map((line) => JSON.stringify(line)).join("\n") + "\n";
  }
}

/* ---------------------------------------------------------------------------
   AsyncLocalStorage helpers.
   --------------------------------------------------------------------------- */

interface Scope {
  log: RunLog;
  ctx: CallContext;
}

const storage = new AsyncLocalStorage<Scope>();

/** Runs `fn` with `log` as the current run's log and an empty call context.
 * Concurrent scopes (two attempts in one process, a Promise.all fan-out in
 * each) never see each other's log or context. */
export function runWithRunLog<T>(log: RunLog, fn: () => T): T {
  return storage.run({ log, ctx: {} }, fn);
}

export function currentRunLog(): RunLog | undefined {
  return storage.getStore()?.log;
}

/** Runs `fn` with `partial` merged over the enclosing context. Keys whose
 * value is undefined are ignored rather than clearing the parent's. A no-op
 * wrapper when no log is active. */
export function withCallContext<T>(partial: CallContext, fn: () => T): T {
  const scope = storage.getStore();
  if (!scope) return fn();
  const ctx: CallContext = { ...scope.ctx };
  for (const [key, value] of Object.entries(partial) as Array<[keyof CallContext, CallContext[keyof CallContext]]>) {
    if (value !== undefined) (ctx as Record<string, unknown>)[key] = value;
  }
  return storage.run({ log: scope.log, ctx }, fn);
}

/** The merged context chain at this point (a copy); empty outside a run. */
export function currentCallContext(): CallContext {
  return { ...(storage.getStore()?.ctx ?? {}) };
}

/* ---------------------------------------------------------------------------
   GV-07: one CallRecord per model request, appended at the provider choke
   point.
   --------------------------------------------------------------------------- */

/**
 * The modules allowed to append a CallRecord (paths relative to
 * src/generation, forward slashes). A model call is recorded where it is
 * made, never by a builder or a stage: anthropicCall.ts today, plus the
 * OpenAI-compatible chat provider (GV-13) and the flat Jev client (GV-20),
 * pre-listed so those cards need no edit here. backend/test/anthropicCall.test.ts
 * fails when any other generation module calls `recordModelCall`.
 */
export const PROVIDER_CALL_SITES: readonly string[] = ["anthropicCall.ts", "chat/openAICompatProvider.ts", "jevClient.ts"];

/**
 * What a provider knows about one request. Times are on the log's own clock
 * (`currentRunLog().nowMs()`), so a test that injects `now` into the RunLog
 * pins them. Every measurement the provider did not take is left out (or
 * null) and is recorded as null, never 0. The context keys (stage, act,
 * seam, attempt, role, reask) come from `currentCallContext()`; a provider
 * may set one explicitly (the Jev client's role 'judge'), which wins.
 */
export interface ModelCallInput {
  provider: string;
  machine?: string | null;
  model: string;
  label: string;
  startMs: number;
  endMs: number;
  queueMs?: number | null;
  ttftMs?: number | null;
  promptTokens?: number | null;
  cachedTokens?: number | null;
  outputTokens?: number | null;
  decodeTokPerSec?: number | null;
  maxTokens?: number | null;
  outputBudget?: number | null;
  overBudget?: boolean | null;
  stopReason?: string | null;
  jsonValid?: boolean | null;
  error?: { kind: string; status?: number };
  stage?: string;
  act?: number;
  seam?: string | number;
  attempt?: number;
  role?: string;
  reask?: string;
}

/**
 * Appends one CallRecord to the active run's log, merged with the enclosing
 * call context, and returns it. A no-op returning undefined outside
 * `runWithRunLog`. `seq` is the record's 0-based position among this log's
 * calls.
 */
export function recordModelCall(input: ModelCallInput): CallRecord | undefined {
  const log = currentRunLog();
  if (!log) return undefined;
  const ctx = currentCallContext();
  const pick = <T>(explicit: T | undefined, fromCtx: T | undefined): T | null => explicit ?? fromCtx ?? null;
  const record: CallRecord = {
    kind: "call",
    seq: log.calls().length,
    stage: pick(input.stage, ctx.stage),
    act: pick(input.act, ctx.act),
    seam: pick(input.seam, ctx.seam),
    attempt: pick(input.attempt, ctx.attempt),
    role: pick(input.role, ctx.role),
    reask: pick(input.reask, ctx.reask),
    provider: input.provider,
    machine: input.machine ?? null,
    model: input.model,
    label: input.label,
    startMs: input.startMs,
    endMs: input.endMs,
    ms: input.endMs - input.startMs,
    queueMs: input.queueMs ?? null,
    ttftMs: input.ttftMs ?? null,
    promptTokens: input.promptTokens ?? null,
    cachedTokens: input.cachedTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    decodeTokPerSec: input.decodeTokPerSec ?? null,
    maxTokens: input.maxTokens ?? null,
    ...budgetStamp(input, ctx),
    stopReason: input.stopReason ?? null,
    jsonValid: input.jsonValid ?? null,
    ...(input.error ? { error: { ...input.error } } : {})
  };
  log.append(record);
  return record;
}

/**
 * GV-14: a record's `outputBudget` and `overBudget`. A value the provider
 * passed wins. Otherwise, under FORAY_OUTPUT_BUDGETS=report (the default) or
 * enforce, they are stamped from config/outputBudgets.ts: the budget of the
 * call's stage (label, role, context stage) on the context's tier, and
 * whether the output tokens exceeded it. `off` stamps nothing. The flag is
 * read here, at call time, and only inside a run.
 */
function budgetStamp(input: ModelCallInput, ctx: CallContext): { outputBudget: number | null; overBudget: boolean | null } {
  const given = { outputBudget: input.outputBudget ?? null, overBudget: input.overBudget ?? null };
  if (outputBudgetMode() === "off") return given;
  const stamp = stampOutputBudget(
    {
      label: input.label,
      role: input.role ?? ctx.role ?? null,
      stage: input.stage ?? ctx.stage ?? null,
      maxTokens: input.maxTokens ?? null,
      outputTokens: input.outputTokens ?? null
    },
    ctx.tier
  );
  const outputBudget = given.outputBudget ?? stamp.outputBudget;
  const outputTokens = input.outputTokens ?? null;
  const overBudget =
    given.overBudget ?? (outputBudget !== null && outputTokens !== null ? outputTokens > outputBudget : null);
  return { outputBudget, overBudget };
}

/** Appends a structured reply's parse outcome (GV-07: parseWithRetry). A
 * no-op outside `runWithRunLog`. */
export function recordParse(ok: boolean, reask: boolean): void {
  currentRunLog()?.append({ kind: "parse", ok, reask });
}
