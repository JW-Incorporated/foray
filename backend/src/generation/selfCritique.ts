import { RoutingConfigError } from "../config/stageRouting";
import { narratorStructureLeaks } from "../copy/narratorStructure";
import { BANNED } from "../copy/rules";
import { splitSpokenSentences } from "../copy/spokenLine";
import { bannedCopyHits, isStatementSentence } from "../types/narration";
import { FlagValueError, readEnumFlag, readFlag, type FlagSource } from "./generationFlags";
import type {
  ActWriteRequest,
  ActWriteResult,
  NarrationBuildContext,
  NarrationWriterBuilder,
  SeamBrief,
  SeamEditRequest,
  WriterObservation,
  WriterStreamEvent,
  WrittenSeam
} from "./NarrationWriterBuilder";

/**
 * GV-94 (W7-08, R2-17 step 3; docs/roadmap/generation-v2.md): a TYPED
 * SELF-CRITIQUE of the writer's first draft, before the real verifier runs.
 *
 * The decorator takes the inner writer's round-1 draft of an act, splits each
 * seam's script into spoken sentences (`spokenLine.splitSpokenSentences`,
 * decision 16 -- no local splitter), and flags a sentence when
 *   - it names the Foray's own structure (`narratorStructureLeaks`), or
 *   - it matches the banned-copy rule (`bannedCopyHits` over `BANNED`, the
 *     same rule `validateNarratedBeat` runs), or
 *   - it is a statement (`isStatementSentence`) and the critic's answer to
 *     "is this sentence backed by its seam's own sources?" has
 *     p < CRITIQUE_FLAG_P.
 * A seam with a flagged sentence goes back ONCE, in one inner `writeAct`
 * call, with its draft as `previousScript` and the flagged sentences quoted
 * in `notes`; every other seam is frozen on its draft. Whatever comes back,
 * a frozen seam keeps its draft script and claims, and an edit call that
 * throws returns the draft. The real verifier then runs on the result, as it
 * always does (writeAct.ts).
 *
 * WHAT IT NEVER TOUCHES. Rounds 2-3 (a request with `retryNote`) already
 * carry the verifier's notes and pass straight through, and so does every
 * act under `off`, and act 0 under `behind-playhead` (`ctx.actIndex`, set by
 * runPipeline at `narrate:<i>`): on act 0 the edit call is a second
 * whole-act writer call on the critical path, so `all` must never be the
 * timed-path default.
 *
 * DARK: FORAY_WRITER_SELF_CRITIQUE=off|behind-playhead|all, default off,
 * when `createNarrationWriterBuilder` does not wrap the writer at all. The
 * critic is the one FORAY_WRITER_CRITIC names in the registry below; this
 * card registers none (the scripted fake lives in the tests), so the lever
 * is unusable until GV-97 (W7-11) registers 'jev', 'qwen' and
 * 'jev-then-qwen'. The `cut` mode is reserved and refused until the
 * narration workstream's cut function exists.
 *
 * NO MODEL CALL HERE. The critic is an interface; nothing in this module
 * imports a provider, anthropicCall.ts or the relay.
 */

/* ------------------------------------------------------------------------ */
/* The critic                                                                */
/* ------------------------------------------------------------------------ */

/** One source text a critic question carries: a selected claim's quote or a
 * clip's transcript window, with the document it comes from. */
export interface DraftCritiqueSource {
  docId: string;
  text: string;
}

/** The critic's question: is `sentence` backed by `sources`, which are ONLY
 * its seam's own selected claim quotes and the windows of the clips the seam
 * follows or introduces, trimmed to CRITIQUE_SOURCE_BUDGET_TOKENS. */
export interface DraftCritiqueQuestion {
  sentence: string;
  sources: DraftCritiqueSource[];
}

export interface DraftCritiqueAnswer {
  /** The probability the sentence is supported, 0..1. */
  p: number;
  /** The provider's request id, when it gave one (Jev's x-typesafe-request-id). */
  requestId?: string;
  ms: number;
}

export interface DraftCritic {
  readonly kind: string;
  supported(q: DraftCritiqueQuestion): Promise<DraftCritiqueAnswer>;
}

/** Below this p a sentence is flagged (PROPOSED; calibrated in E5 against the
 * R2-19 review verdicts and the run-9 labelled pages). */
export const CRITIQUE_FLAG_P = 0.3;

/** The source budget of one critic question, in tokens at chars/4 (LM-23). */
export const CRITIQUE_SOURCE_BUDGET_TOKENS = 2000;
export const CRITIQUE_SOURCE_BUDGET_CHARS = CRITIQUE_SOURCE_BUDGET_TOKENS * 4;

/** Critic questions in flight at once, per act. */
export const CRITIQUE_CONCURRENCY = 4;

/* ------------------------------------------------------------------------ */
/* Flags                                                                     */
/* ------------------------------------------------------------------------ */

export const SELF_CRITIQUE_ENV = "FORAY_WRITER_SELF_CRITIQUE";
export const WRITER_CRITIC_ENV = "FORAY_WRITER_CRITIC";

export type SelfCritiqueMode = "off" | "behind-playhead" | "all";

const CRITIC_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const CRITIC_NAME_EXPECTED = "a draft critic name (lower-case letters, digits, dashes)";

export interface SelfCritiqueConfig {
  mode: SelfCritiqueMode;
  /** behind-playhead|all only: the registered critic's name */
  critic?: string;
}

/**
 * FORAY_WRITER_SELF_CRITIQUE=off|behind-playhead|all (default off). Under an
 * on mode FORAY_WRITER_CRITIC (required, a critic name) is read too. Call
 * time, fail fast, the variable named and never its value
 * (generationFlags.ts). `cut` is reserved: refused, naming the variable.
 * Off, nothing else is read.
 */
export function readSelfCritique(source: FlagSource = process.env): SelfCritiqueConfig {
  const raw = readEnumFlag(SELF_CRITIQUE_ENV, ["off", "behind-playhead", "all", "cut"] as const, "off", source);
  if (raw === "cut") {
    throw new RoutingConfigError(SELF_CRITIQUE_ENV, `${SELF_CRITIQUE_ENV}=cut is reserved until the narration workstream's cut function exists; use off, behind-playhead or all`);
  }
  if (raw === "off") return { mode: "off" };
  const critic = readFlag<string | undefined>(
    WRITER_CRITIC_ENV,
    { parse: (value) => (CRITIC_NAME_RE.test(value) ? value : undefined), expected: CRITIC_NAME_EXPECTED },
    undefined,
    source
  );
  if (critic === undefined) {
    throw new RoutingConfigError(WRITER_CRITIC_ENV, `${SELF_CRITIQUE_ENV}=${raw} needs ${WRITER_CRITIC_ENV} to name the critic that checks the draft's sentences`);
  }
  return { mode: raw, critic };
}

/** The lever as the report records it (`levers.selfCritique`): undefined when
 * off, else a value fixed by the configuration (never per run), so a swap
 * experiment's `expect.levers` can match it exactly (GV-91's pattern). What a
 * run did is the row's `selfCritique` (`SelfCritiqueTotals`). */
export interface SelfCritiqueLever {
  mode: "behind-playhead" | "all";
  critic: string;
  flagP: number;
  sourceBudgetTokens: number;
}

export function selfCritiqueLever(config: SelfCritiqueConfig): SelfCritiqueLever | undefined {
  if (config.mode === "off") return undefined;
  return { mode: config.mode, critic: config.critic!, flagP: CRITIQUE_FLAG_P, sourceBudgetTokens: CRITIQUE_SOURCE_BUDGET_TOKENS };
}

/**
 * The self-critique's part of the checkpoint variant (decision 20): undefined
 * when off, so every classic fingerprint is byte-identical; else
 * `self-critique=<mode>:<critic>`, so a resumed run never mixes acts narrated
 * with and without the critique. Joined onto `checkpointRunVariant` at BOTH
 * call sites (`joinCheckpointVariant`). It stays out of the fork stamp's
 * flags (`checkpointForkStamp`), so E5's arm B can still fork arm A's banked
 * stages and rebuild from `narrate`; the stamp carries it on its own
 * (`selfCritique`, GV-124), compared like a writer route, so a seed built
 * under another self-critique is refused unless the fork reruns from
 * `narrate` or earlier.
 */
export function selfCritiqueVariant(config: SelfCritiqueConfig): string | undefined {
  return config.mode === "off" ? undefined : `self-critique=${config.mode}:${config.critic}`;
}

/** `checkpointRunVariant`'s value with the self-critique part appended (when
 * there is one). Undefined when both are. */
export function joinCheckpointVariant(variant: string | undefined, config: SelfCritiqueConfig): string | undefined {
  const parts = [variant, selfCritiqueVariant(config)].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join("|") : undefined;
}

/* ------------------------------------------------------------------------ */
/* Critic registry (GV-97 fills it)                                          */
/* ------------------------------------------------------------------------ */

export type DraftCriticFactory = (source: NodeJS.ProcessEnv) => DraftCritic;

const critics = new Map<string, DraftCriticFactory>();

/** Registers a draft critic under `name` (FORAY_WRITER_CRITIC's value).
 * Refuses a malformed or duplicate name. */
export function registerDraftCritic(name: string, factory: DraftCriticFactory): void {
  if (!CRITIC_NAME_RE.test(name)) throw new FlagValueError(WRITER_CRITIC_ENV, CRITIC_NAME_EXPECTED);
  if (critics.has(name)) throw new Error(`registerDraftCritic: "${name}" is already registered`);
  critics.set(name, factory);
}

export function isDraftCriticRegistered(name: string): boolean {
  return critics.has(name);
}

/** The critic registered under `name`; RoutingConfigError naming
 * FORAY_WRITER_CRITIC (never its value) when none is. */
export function createDraftCritic(name: string, source: NodeJS.ProcessEnv = process.env): DraftCritic {
  const factory = critics.get(name);
  if (factory === undefined) {
    throw new RoutingConfigError(WRITER_CRITIC_ENV, `${WRITER_CRITIC_ENV} names no registered draft critic (the Jev and Qwen critics are GV-97's)`);
  }
  return factory(source);
}

/** Test seam: replace (or add, or with undefined remove) one critic; returns the undo. */
export function __swapDraftCriticForTests(name: string, factory: DraftCriticFactory | undefined): () => void {
  const before = critics.get(name);
  if (factory === undefined) critics.delete(name);
  else critics.set(name, factory);
  return () => {
    if (before === undefined) critics.delete(name);
    else critics.set(name, before);
  };
}

/* ------------------------------------------------------------------------ */
/* Sources and flags                                                         */
/* ------------------------------------------------------------------------ */

/**
 * The sources a seam's critic questions carry: ONLY the seam's own selected
 * claim quotes (in claim order), then the transcript windows of the clips it
 * follows and introduces (`request.clips[].docId` resolved to
 * `request.documents`), deduplicated, trimmed to `budgetChars` in that order
 * (the last source that does not fit is cut, the rest dropped).
 *
 * GV-124 (#1413 item 9): a claim quote is kept only when it is an exact
 * substring of the document it names in `request.documents`. The critique
 * runs on the draft BEFORE the mechanical quote gate, so without this a quote
 * the writer made up would be handed to the critic as the very source that
 * backs its own sentence.
 */
export function seamCritiqueSources(
  brief: SeamBrief,
  draft: WrittenSeam,
  request: ActWriteRequest,
  budgetChars: number = CRITIQUE_SOURCE_BUDGET_CHARS
): DraftCritiqueSource[] {
  const docText = new Map(request.documents.map((d) => [d.docId, d.text]));
  const candidates: DraftCritiqueSource[] = draft.claims
    .filter((c) => typeof c.quote === "string" && c.quote.length > 0 && (docText.get(c.docId)?.includes(c.quote) ?? false))
    .map((c) => ({ docId: c.docId, text: c.quote }));
  for (const clipId of [brief.follows, brief.introduces]) {
    if (clipId === undefined) continue;
    const docId = request.clips.find((c) => c.clipId === clipId)?.docId;
    if (docId === undefined) continue;
    const doc = request.documents.find((d) => d.docId === docId);
    if (doc) candidates.push({ docId: doc.docId, text: doc.text });
  }
  const out: DraftCritiqueSource[] = [];
  const seen = new Set<string>();
  let left = budgetChars;
  for (const source of candidates) {
    if (left <= 0) break;
    if (source.text.trim().length === 0) continue;
    const key = `${source.docId}\n${source.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = source.text.length > left ? source.text.slice(0, left) : source.text;
    out.push({ docId: source.docId, text });
    left -= text.length;
  }
  return out;
}

/** Why a sentence was flagged. */
export type SentenceFlag = "structure" | "banned-copy" | "unsupported";

/** The note one flagged sentence adds to its seam's edit brief. */
export function flagNote(sentence: string, flag: SentenceFlag): string {
  switch (flag) {
    case "structure":
      return `Names the Foray's own structure: «${sentence}» - say it in the listener's words; keep every other sentence.`;
    case "banned-copy":
      return `Uses banned copy: «${sentence}» - rewrite it; keep every other sentence.`;
    default:
      return `Not backed by the act's sources: «${sentence}» - drop or re-source it; keep every other sentence.`;
  }
}

/** The code half of the check: a structure leak or banned copy, else null. */
export function codeFlagOf(sentence: string): SentenceFlag | null {
  if (narratorStructureLeaks(sentence).length > 0) return "structure";
  if (bannedCopyHits(sentence, BANNED).length > 0) return "banned-copy";
  return null;
}

/** Runs `tasks` with at most `limit` in flight; results in input order. */
async function boundedAll<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/* ------------------------------------------------------------------------ */
/* The decorator                                                             */
/* ------------------------------------------------------------------------ */

export interface SelfCritiquingNarrationWriterOptions {
  inner: NarrationWriterBuilder;
  critic: DraftCritic;
  mode: SelfCritiqueMode;
  /** Epoch-ms clock for `ms` (default Date.now). */
  now?: () => number;
  /** Critic questions in flight at once (default CRITIQUE_CONCURRENCY). */
  concurrency?: number;
}

/**
 * The decorator. Implements `writeAct` (critiqued) and forwards `editSeams`
 * (timed-policy rounds 2-3, which carry the verifier's notes) untouched.
 *
 * GV-124 (#1413 item 7): it offers `writeActStream` when the inner writer
 * does. An act it does not critique (a retry round, every act under `off`,
 * act 0 under `behind-playhead`) is the inner writer's own stream, untouched,
 * so GV-73's streamed act 0 and its early seam release survive. An act it
 * does critique cannot be streamed (a whole-draft critique cannot follow seams
 * released before the draft is whole): it is written and critiqued exactly as
 * `writeAct` does, and its seams are handed on together after the critique,
 * then one `end`.
 */
export class SelfCritiquingNarrationWriter implements NarrationWriterBuilder {
  readonly providerName: string;
  readonly editSeams?: (request: SeamEditRequest, ctx: NarrationBuildContext) => Promise<ActWriteResult>;
  readonly writeActStream?: (request: ActWriteRequest, ctx: NarrationBuildContext) => AsyncIterable<WriterStreamEvent>;
  private readonly inner: NarrationWriterBuilder;
  private readonly critic: DraftCritic;
  private readonly mode: SelfCritiqueMode;
  private readonly now: () => number;
  private readonly concurrency: number;

  constructor(options: SelfCritiquingNarrationWriterOptions) {
    this.inner = options.inner;
    this.critic = options.critic;
    this.mode = options.mode;
    this.now = options.now ?? (() => Date.now());
    this.concurrency = Math.max(1, options.concurrency ?? CRITIQUE_CONCURRENCY);
    this.providerName = options.inner.providerName;
    const inner = options.inner;
    if (inner.editSeams) this.editSeams = (request, ctx) => inner.editSeams!(request, ctx);
    if (inner.writeActStream) this.writeActStream = (request, ctx) => this.streamAct(request, ctx);
  }

  /** Whether this act's round-1 draft is critiqued (see the module comment). */
  private critiques(request: ActWriteRequest, ctx: NarrationBuildContext): boolean {
    if (this.mode === "off" || request.retryNote !== undefined) return false;
    if (this.mode === "behind-playhead" && (ctx.actIndex ?? 0) === 0) return false;
    return true;
  }

  /** GV-124: the streamed act (see the class comment). */
  private async *streamAct(request: ActWriteRequest, ctx: NarrationBuildContext): AsyncGenerator<WriterStreamEvent, void, undefined> {
    if (!this.critiques(request, ctx)) {
      yield* this.inner.writeActStream!(request, ctx);
      return;
    }
    const startedAt = this.now();
    const { seams } = await this.writeAct(request, ctx);
    const atMs = Math.max(0, this.now() - startedAt);
    for (const seam of seams) yield { type: "seam", seam, atMs };
    const arrived = new Set(seams.map((s) => s.seamId));
    yield { type: "end", stopReason: "end", unfinishedSeamIds: request.seams.filter((s) => !arrived.has(s.seamId)).map((s) => s.seamId) };
  }

  async writeAct(request: ActWriteRequest, ctx: NarrationBuildContext): Promise<ActWriteResult> {
    const draft = await this.inner.writeAct(request, ctx);
    if (!this.critiques(request, ctx)) return draft;

    const startedAt = this.now();
    const briefs = new Map(request.seams.map((s) => [s.seamId, s]));
    type Question = { seamId: string; sentence: string; sources: DraftCritiqueSource[] };
    const flagsBySeam = new Map<string, Array<{ sentence: string; flag: SentenceFlag }>>();
    const questions: Question[] = [];
    let sentences = 0;
    for (const seam of draft.seams) {
      const brief = briefs.get(seam.seamId);
      if (!brief || brief.frozen) continue;
      const parts = splitSpokenSentences(seam.script);
      if (parts.length === 0) continue;
      const sources = seamCritiqueSources(brief, seam, request);
      for (const sentence of parts) {
        sentences++;
        const flag = codeFlagOf(sentence);
        if (flag !== null) {
          addFlag(flagsBySeam, seam.seamId, sentence, flag);
          continue;
        }
        if (isStatementSentence(sentence)) questions.push({ seamId: seam.seamId, sentence, sources });
      }
    }

    let critiqueErrors = 0;
    const answers = await boundedAll(
      questions.map((q) => async () => {
        try {
          return await this.critic.supported({ sentence: q.sentence, sources: q.sources });
        } catch {
          critiqueErrors++;
          return undefined;
        }
      }),
      this.concurrency
    );
    const pValues: number[] = [];
    questions.forEach((q, i) => {
      const answer = answers[i];
      if (answer === undefined) return;
      pValues.push(answer.p);
      if (answer.p < CRITIQUE_FLAG_P) addFlag(flagsBySeam, q.seamId, q.sentence, "unsupported");
    });

    let flagged = 0;
    for (const list of flagsBySeam.values()) flagged += list.length;
    const observation = (editCalls: number, editErrors: number): WriterObservation => ({
      kind: "self-critique",
      acts: 1,
      sentences,
      flagged,
      editedSeams: flagsBySeam.size,
      editCalls,
      editErrors,
      critiqueCalls: questions.length,
      critiqueErrors,
      ms: Math.max(0, this.now() - startedAt),
      pValues
    });
    if (flagsBySeam.size === 0) {
      ctx.observe?.(observation(0, 0));
      return draft;
    }

    const draftById = new Map(draft.seams.map((s) => [s.seamId, s]));
    const editRequest: ActWriteRequest = {
      ...request,
      seams: request.seams.map((brief): SeamBrief => {
        const previousScript = draftById.get(brief.seamId)?.script ?? "";
        const flags = flagsBySeam.get(brief.seamId);
        if (flags === undefined) return { ...brief, frozen: true, previousScript };
        return { ...brief, previousScript, notes: flags.map((f) => flagNote(f.sentence, f.flag)).join(" ") };
      })
    };
    let edited: ActWriteResult;
    try {
      edited = await this.inner.writeAct(editRequest, ctx);
    } catch {
      ctx.observe?.(observation(1, 1));
      return draft;
    }
    const editedById = new Map(edited.seams.map((s) => [s.seamId, s]));
    const merged = draft.seams.map((seam) => (flagsBySeam.has(seam.seamId) ? (editedById.get(seam.seamId) ?? seam) : seam));
    ctx.observe?.(observation(1, 0));
    return { seams: merged };
  }
}

function addFlag(map: Map<string, Array<{ sentence: string; flag: SentenceFlag }>>, seamId: string, sentence: string, flag: SentenceFlag): void {
  const list = map.get(seamId) ?? [];
  list.push({ sentence, flag });
  map.set(seamId, list);
}

/* ------------------------------------------------------------------------ */
/* Totals                                                                    */
/* ------------------------------------------------------------------------ */

/** The run's self-critique, summed over every act the decorator critiqued
 * (`WriterObservation` without its kind). On the generated outcome and the
 * report row as `selfCritique`; absent when no act was critiqued. */
export type SelfCritiqueTotals = Omit<WriterObservation, "kind">;

export function addSelfCritique(total: SelfCritiqueTotals | undefined, e: WriterObservation): SelfCritiqueTotals {
  const base: SelfCritiqueTotals = total ?? {
    acts: 0,
    sentences: 0,
    flagged: 0,
    editedSeams: 0,
    editCalls: 0,
    editErrors: 0,
    critiqueCalls: 0,
    critiqueErrors: 0,
    ms: 0,
    pValues: []
  };
  return {
    acts: base.acts + e.acts,
    sentences: base.sentences + e.sentences,
    flagged: base.flagged + e.flagged,
    editedSeams: base.editedSeams + e.editedSeams,
    editCalls: base.editCalls + e.editCalls,
    editErrors: base.editErrors + e.editErrors,
    critiqueCalls: base.critiqueCalls + e.critiqueCalls,
    critiqueErrors: base.critiqueErrors + e.critiqueErrors,
    ms: base.ms + e.ms,
    pValues: [...base.pValues, ...e.pValues]
  };
}
