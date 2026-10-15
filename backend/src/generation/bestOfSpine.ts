import * as crypto from "crypto";
import { z } from "zod";
import { RoutingConfigError } from "../config/stageRouting";
import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape } from "../types/research";
import { SpineSchema, validateSpine, type DurationTier, type Spine } from "../types/spine";
import { FlagValueError, numberParser, readEnumFlag, readFlag, type FlagSource } from "./generationFlags";
import { PRE_SPINE_SENTINEL } from "./preSpineIntent";
import { checkSpineStructure, foldedCopyIssues } from "./spineStructure";
import type { SpineBuildContext, SpineBuilder, SpineSampleRecord, SpineSelectionRecord } from "./SpineBuilder";

/**
 * GV-91 (W7-07, with W4-16 folded in; covers R2-17, R2-07): THE CONSTRAINED
 * BEST-OF-2 SPINE. The one best-of-2 implementation (roadmap decision 18):
 * a second spine sample runs in parallel on the 'spine-alt' route (the second
 * box in the E4 live step), only samples that pass the code gates compete, a
 * pluggable SpineJudge picks between two valid ones, and a deadline bounds
 * the time the second sample may add to the critical path.
 *
 * DARK. Nothing builds this unless FORAY_SPINE_BEST_OF=2
 * (`createSpineBuilder`), and no production judge is registered by this card:
 * the Jev and Qwen judges are GV-97's (W7-11), so until it lands the factory
 * refuses best-of-2 by naming FORAY_SPINE_JUDGE. Tests use the scripted
 * FakeSpineJudge (backend/test/helpers/fakeSpineJudge.ts).
 *
 * WHAT A FIRST CALL DOES (the card's design, in order):
 *  1. A re-ask (ctx.revision set) goes to the builder whose sample won this
 *     instance's last first call, else the primary. The loser is never called
 *     again: the re-ask carries the winner's own reply.
 *  2. Otherwise both builders start; the secondary's promise is settled into
 *     an outcome at once, so a late or failing secondary is never an
 *     unhandled rejection.
 *  3. The primary is awaited.
 *  4. Primary threw or is invalid: the secondary is awaited with no grace
 *     limit (there is nothing else to return).
 *  5. Otherwise the secondary is raced against `graceMs` (default 3000).
 *  6. Valid = SpineSchema (the folded reply schema on the folded path) +
 *     validateSpine + no checkSpineStructure issue under the options
 *     buildSpineWithReasks uses (seedableEpisodeIds from the research shape,
 *     plus foldedCopyIssues on the folded path).
 *  7. None valid: the primary's own result is returned or its error rethrown,
 *     so buildSpineWithReasks's re-ask and throw paths are unchanged. One
 *     valid: it is returned. Two valid: the judge chooses.
 *  8. The judge sees renderSpineForJudge (no ids) and spineJudgeQuestion (the
 *     listener's own words on the folded path, never the keyword intent or
 *     its 'not yet known' sentinels); the A/B order is a stable hash of the
 *     session id.
 *  9. A judge that throws, times out or answers out of range: the primary.
 */

/** What the judge is shown: one question and the two plans, rendered. */
export interface SpineJudgeInput {
  question: string;
  /** the two plans in the PRESENTED order (`renderSpineForJudge`) */
  candidates: [string, string];
}

export interface SpineJudgeChoice {
  /** the chosen plan's index in the presented order */
  index: 0 | 1;
  probabilities?: number[];
  confidence?: number;
  requestId?: string;
  ms: number;
}

/** A judge between two valid spines. GV-97 adds the Jev and Qwen adapters. */
export interface SpineJudge {
  readonly kind: string;
  choose(input: SpineJudgeInput): Promise<SpineJudgeChoice>;
}

export const DEFAULT_SPINE_BEST_OF_GRACE_MS = 3000;
/** The longest grace FORAY_SPINE_BEST_OF_GRACE_MS accepts. */
export const MAX_SPINE_BEST_OF_GRACE_MS = 60_000;
/** How long the judge may take before the primary is returned. */
export const DEFAULT_SPINE_JUDGE_TIMEOUT_MS = 5000;

export interface BestOfTwoSpineOptions {
  primary: SpineBuilder;
  secondary: SpineBuilder;
  judge: SpineJudge;
  graceMs?: number;
  judgeTimeoutMs?: number;
  /** ms clock; Date.now by default (tests inject a fake one) */
  now?: () => number;
  /** the deadline timer; an unref'd setTimeout by default */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    /* A pending deadline must never hold the process open on its own. */
    (timer as { unref?: () => void }).unref?.();
  });
}

/** GV-67's folded reply schema (buildSpine.ts): a blank subject or angle is a
 * re-askable copy issue there, not a schema error, so the gate here agrees. */
const FoldedSampleSchema = SpineSchema.extend({ subject: z.string(), angle: z.string() });

type SampleOutcome =
  | { kind: "ok"; spine: Spine; valid: boolean; issues: string[]; ms: number }
  | { kind: "threw"; error: unknown; ms: number };

/** The gate issue CODES a sample fails (empty = valid). Codes, never messages:
 * the messages quote claims, and the record carries no spine text. */
export function spineSampleIssues(raw: unknown, researchShape: ResearchShape, folded: boolean): string[] {
  const parsed = (folded ? FoldedSampleSchema : SpineSchema).safeParse(raw);
  if (!parsed.success) return ["schema"];
  const spine = parsed.data as Spine;
  try {
    const validation = validateSpine(spine);
    if (!validation.valid) return validation.issues.map((i) => `validate:${i.code}`);
    const seedableEpisodeIds = researchShape.subtopics.flatMap((s) => s.tapeWindows.map((w) => w.episodeId));
    return [...(folded ? foldedCopyIssues(spine) : []), ...checkSpineStructure(spine, { seedableEpisodeIds })].map((i) => i.code);
  } catch {
    return ["check-threw"];
  }
}

/** True when the session id hashes to the swapped A/B order. Stable per
 * session; no session id keeps the primary first. */
export function judgeOrderSwapped(sessionId: string | undefined): boolean {
  if (sessionId === undefined || sessionId.length === 0) return false;
  return (crypto.createHash("sha256").update(sessionId).digest()[0]! & 1) === 1;
}

/**
 * A plan as the judge reads it: overview, voice, the disappointment it
 * answers (R2-07, when the spine carries it), then each act's title, its
 * slots and their beat claims. No ids: no seeds, no episode ids, no
 * generatedAt.
 */
export function renderSpineForJudge(spine: Spine): string {
  const lines: string[] = [`Overview: ${spine.overview}`];
  const v = spine.voice;
  lines.push(`Voice: ${v.style}; ${v.register}; ${v.sentenceRhythm}; ${v.narratorPresence}`);
  if (spine.disappointment) lines.push(`What would disappoint the listener: ${spine.disappointment}`);
  if (spine.answersDisappointment) lines.push(`How this plan answers it: ${spine.answersDisappointment}`);
  spine.acts.forEach((act, a) => {
    lines.push(`Act ${a + 1}: ${act.title}`);
    for (const slot of act.slots) {
      lines.push(`  Slot: ${slot.title}`);
      for (const beat of slot.beats) lines.push(`    - ${beat.claim}`);
    }
  });
  return lines.join("\n");
}

const known = (s: string | undefined): s is string => typeof s === "string" && s.trim().length > 0 && s.trim() !== PRE_SPINE_SENTINEL;

/**
 * The question the judge answers. The judge runs before any spine exists, so
 * on the folded path (ctx.listenerPrompt, GV-67: call stack only, never
 * banked or recorded) it is built from the listener's own words; only when
 * that is absent does it use the intent's subject, angle and disappointment.
 * The pre-spine keyword intent and its 'not yet known' sentinel never reach it.
 */
export function spineJudgeQuestion(intent: IntentUnderstanding, ctx: Pick<SpineBuildContext, "listenerPrompt">): string {
  const ask = "Which of the two plans below would make the better listen for this request? Prefer the plan whose acts answer it directly and do not repeat themselves.";
  if (ctx.listenerPrompt !== undefined) return `The listener asked: "${ctx.listenerPrompt.trim()}"\n${ask}`;
  const parts: string[] = [];
  if (known(intent.subject)) parts.push(`Subject: ${intent.subject}`);
  if (known(intent.angle)) parts.push(`Angle: ${intent.angle}`);
  if (known(intent.disappointment)) parts.push(`What would disappoint the listener: ${intent.disappointment}`);
  return [...parts, ask].join("\n");
}

const LATE = Symbol("late");
const TIMEOUT = Symbol("timeout");

export class BestOfTwoSpineBuilder implements SpineBuilder {
  readonly providerName = "best-of-2";
  readonly primary: SpineBuilder;
  readonly secondary: SpineBuilder;
  readonly judge: SpineJudge;
  readonly graceMs: number;
  readonly judgeTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** the builder whose sample won this instance's last first call */
  private lastWinner: SpineBuilder | undefined;

  constructor(options: BestOfTwoSpineOptions) {
    this.primary = options.primary;
    this.secondary = options.secondary;
    this.judge = options.judge;
    this.graceMs = options.graceMs ?? DEFAULT_SPINE_BEST_OF_GRACE_MS;
    this.judgeTimeoutMs = options.judgeTimeoutMs ?? DEFAULT_SPINE_JUDGE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async buildSpine(intent: IntentUnderstanding, researchShape: ResearchShape, duration: DurationTier, ctx: SpineBuildContext): Promise<Spine> {
    const { observe, ...inner } = ctx;
    if (inner.revision !== undefined) {
      return (this.lastWinner ?? this.primary).buildSpine(intent, researchShape, duration, inner);
    }

    const folded = inner.listenerPrompt !== undefined;
    const startedAt = this.now();
    const sample = (builder: SpineBuilder): Promise<SampleOutcome> =>
      (async () => builder.buildSpine(intent, researchShape, duration, inner))().then(
        (spine): SampleOutcome => {
          const issues = spineSampleIssues(spine, researchShape, folded);
          return { kind: "ok", spine, valid: issues.length === 0, issues, ms: this.now() - startedAt };
        },
        (error: unknown): SampleOutcome => ({ kind: "threw", error, ms: this.now() - startedAt })
      );

    const primaryRun = sample(this.primary);
    let secondaryDone: SampleOutcome | undefined;
    /* Settled into an outcome, never rejected: a late secondary that fails
       after the wrapper returned is caught here. */
    const secondaryRun = sample(this.secondary).then((o) => (secondaryDone = o));

    const primary = await primaryRun;
    const primarySettledAt = this.now();
    const primaryValid = primary.kind === "ok" && primary.valid;
    let secondary: SampleOutcome | undefined = secondaryDone;
    if (secondary === undefined) {
      if (!primaryValid) {
        secondary = await secondaryRun;
      } else {
        const raced = await Promise.race([secondaryRun, this.sleep(this.graceMs).then((): typeof LATE => LATE)]);
        secondary = raced === LATE ? secondaryDone : raced;
      }
    }
    const secondaryValid = secondary?.kind === "ok" && secondary.valid;

    const sampleRecord = (role: "primary" | "secondary", builder: SpineBuilder, o: SampleOutcome | undefined): SpineSampleRecord => ({
      role,
      impl: builder.providerName,
      valid: o?.kind === "ok" && o.valid,
      issues: o === undefined ? [] : o.kind === "threw" ? ["threw"] : o.issues,
      ms: o === undefined ? null : o.ms,
      late: o === undefined
    });
    const finish = (
      chosen: "primary" | "secondary",
      reason: SpineSelectionRecord["reason"],
      judge: SpineSelectionRecord["judge"] = null
    ): void => {
      this.lastWinner = chosen === "primary" ? this.primary : this.secondary;
      observe?.({
        samples: [sampleRecord("primary", this.primary, primary), sampleRecord("secondary", this.secondary, secondary)],
        judge,
        chosen,
        reason,
        addedMs: Math.max(0, this.now() - primarySettledAt)
      });
    };

    if (secondary === undefined) {
      finish("primary", "secondary-late");
      return (primary as Extract<SampleOutcome, { kind: "ok" }>).spine;
    }
    if (primaryValid && !secondaryValid) {
      finish("primary", "only-valid");
      return (primary as Extract<SampleOutcome, { kind: "ok" }>).spine;
    }
    if (!primaryValid && secondaryValid) {
      finish("secondary", "only-valid");
      return (secondary as Extract<SampleOutcome, { kind: "ok" }>).spine;
    }
    if (!primaryValid) {
      /* Neither passed: the primary's own result, so buildSpineWithReasks
         re-asks (or throws) exactly as it would without the wrapper. */
      finish("primary", "none-valid");
      if (primary.kind === "threw") throw primary.error;
      return primary.spine;
    }

    /* Both valid: the judge. */
    const a = (primary as Extract<SampleOutcome, { kind: "ok" }>).spine;
    const b = (secondary as Extract<SampleOutcome, { kind: "ok" }>).spine;
    const swapped = judgeOrderSwapped(inner.sessionId);
    const rendered: [string, string] = [renderSpineForJudge(a), renderSpineForJudge(b)];
    const input: SpineJudgeInput = {
      question: spineJudgeQuestion(intent, inner),
      candidates: swapped ? [rendered[1], rendered[0]] : rendered
    };
    const judgeStartedAt = this.now();
    const asked = (async () => this.judge.choose(input))().then(
      (choice) => ({ ok: true as const, choice }),
      () => ({ ok: false as const })
    );
    const answer = await Promise.race([asked, this.sleep(this.judgeTimeoutMs).then((): typeof TIMEOUT => TIMEOUT)]);
    const judgeMs = this.now() - judgeStartedAt;
    if (answer === TIMEOUT || !answer.ok || (answer.choice.index !== 0 && answer.choice.index !== 1)) {
      finish("primary", "judge-failed", {
        kind: this.judge.kind,
        outcome: answer === TIMEOUT ? "timeout" : "threw",
        ms: judgeMs,
        swapped
      });
      return a;
    }
    const { choice } = answer;
    const original = swapped ? 1 - choice.index : choice.index;
    finish(original === 0 ? "primary" : "secondary", "judged", {
      kind: this.judge.kind,
      outcome: "chose",
      ms: judgeMs,
      swapped,
      index: choice.index,
      ...(choice.probabilities !== undefined ? { probabilities: choice.probabilities } : {}),
      ...(choice.confidence !== undefined ? { confidence: choice.confidence } : {}),
      ...(choice.requestId !== undefined ? { requestId: choice.requestId } : {})
    });
    return original === 0 ? a : b;
  }
}

/* ------------------------------------------------------------------------ */
/* Flags                                                                     */
/* ------------------------------------------------------------------------ */

export const SPINE_BEST_OF_ENV = "FORAY_SPINE_BEST_OF";
export const SPINE_JUDGE_ENV = "FORAY_SPINE_JUDGE";
export const SPINE_BEST_OF_GRACE_MS_ENV = "FORAY_SPINE_BEST_OF_GRACE_MS";

const JUDGE_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

export interface SpineBestOfConfig {
  bestOf: 1 | 2;
  /** best-of-2 only: the registered judge's name */
  judge?: string;
  /** best-of-2 only */
  graceMs?: number;
}

/**
 * FORAY_SPINE_BEST_OF=1|2 (default 1). Under 2, FORAY_SPINE_JUDGE (required,
 * a judge name) and FORAY_SPINE_BEST_OF_GRACE_MS (an integer 0..60000,
 * default 3000) are read too. Call time, fail fast, the variable named and
 * never its value (generationFlags.ts). Under 1 nothing else is read.
 */
export function readSpineBestOf(source: FlagSource = process.env): SpineBestOfConfig {
  const bestOf = readEnumFlag(SPINE_BEST_OF_ENV, ["1", "2"] as const, "1", source);
  if (bestOf === "1") return { bestOf: 1 };
  const judge = readFlag<string | undefined>(
    SPINE_JUDGE_ENV,
    { parse: (raw) => (JUDGE_NAME_RE.test(raw) ? raw : undefined), expected: "a spine judge name (lower-case letters, digits, dashes)" },
    undefined,
    source
  );
  if (judge === undefined) {
    throw new RoutingConfigError(SPINE_JUDGE_ENV, `${SPINE_BEST_OF_ENV}=2 needs ${SPINE_JUDGE_ENV} to name the judge that picks between the two spines`);
  }
  const graceMs = readFlag(
    SPINE_BEST_OF_GRACE_MS_ENV,
    numberParser(z.number().int().min(0).max(MAX_SPINE_BEST_OF_GRACE_MS), `an integer from 0 to ${MAX_SPINE_BEST_OF_GRACE_MS}`),
    DEFAULT_SPINE_BEST_OF_GRACE_MS,
    source
  );
  return { bestOf: 2, judge, graceMs };
}

/** The lever as the report records it (`levers.spineBestOf`): undefined when
 * off, else a value fixed by the configuration (never per run), so a swap
 * experiment's `expect.levers` can match it exactly. The per-run choice is
 * `spineSelection`. */
export function spineBestOfLever(source: FlagSource = process.env): { mode: "best-of-2"; judge: string; graceMs: number } | undefined {
  const config = readSpineBestOf(source);
  if (config.bestOf === 1) return undefined;
  return { mode: "best-of-2", judge: config.judge!, graceMs: config.graceMs! };
}

/* ------------------------------------------------------------------------ */
/* Judge registry (GV-97 fills it)                                           */
/* ------------------------------------------------------------------------ */

export type SpineJudgeFactory = (source: NodeJS.ProcessEnv) => SpineJudge;

const judges = new Map<string, SpineJudgeFactory>();

/** Registers a spine judge under `name` (FORAY_SPINE_JUDGE's value). Refuses
 * a malformed or duplicate name. */
export function registerSpineJudge(name: string, factory: SpineJudgeFactory): void {
  if (!JUDGE_NAME_RE.test(name)) throw new FlagValueError(SPINE_JUDGE_ENV, "a spine judge name (lower-case letters, digits, dashes)");
  if (judges.has(name)) throw new Error(`registerSpineJudge: "${name}" is already registered`);
  judges.set(name, factory);
}

export function isSpineJudgeRegistered(name: string): boolean {
  return judges.has(name);
}

/** The judge registered under `name`; RoutingConfigError naming
 * FORAY_SPINE_JUDGE (never its value) when none is. */
export function createSpineJudge(name: string, source: NodeJS.ProcessEnv = process.env): SpineJudge {
  const factory = judges.get(name);
  if (factory === undefined) {
    throw new RoutingConfigError(SPINE_JUDGE_ENV, `${SPINE_JUDGE_ENV} names no registered spine judge (the Jev and Qwen judges are GV-97's)`);
  }
  return factory(source);
}

/** Test seam: replace (or add, or with undefined remove) one judge; returns the undo. */
export function __swapSpineJudgeForTests(name: string, factory: SpineJudgeFactory | undefined): () => void {
  const before = judges.get(name);
  if (factory === undefined) judges.delete(name);
  else judges.set(name, factory);
  return () => {
    if (before === undefined) judges.delete(name);
    else judges.set(name, before);
  };
}
