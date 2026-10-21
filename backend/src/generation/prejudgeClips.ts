import { z } from "zod";
import { findBudgetError } from "../cost/budgetGuard";
import { findUnitBudgetError } from "../cost/unitBudget";
import { CLIP_JUDGE_IDS, ClipScoreOutcomeSchema, ClipUnavailableSchema, type ClipScoreOutcome } from "../types/tapeSourcing";
import type { ClipChoiceOutcome, ClipJudge, ClipQuestion } from "./clipJudge";
import { beatVerdictKey, type BeatCandidateSet } from "./sourceBeats";

/**
 * GV-107 (docs/roadmap/generation-v2.md, W5-04; R1-20, R2-03): ASYNC
 * PRE-JUDGING OF EVERY BEAT'S CANDIDATE WINDOWS, BEFORE SOURCING.
 *
 * For each beat `beatJudgeCandidates` (sourceBeats.ts) enumerated, ONE choice
 * is asked: which of these passages makes this claim about this subject,
 * 'none' allowed (`ClipJudge.choose`). Then the K passages the choice ranks
 * highest are asked the two clip Scores (`ClipJudge.score`: subject, claim;
 * GV-79's cards). The result is a `ClipVerdictBook` keyed `act/slot/beat`,
 * banked by runPipeline's `clip-judge` stage (FORAY_CLIP_JUDGE=enforce only)
 * and read by GV-119's judged walk; until that card lands it changes no
 * sourcing.
 *
 * NEVER THROWS FOR A JUDGE OUTAGE. An unavailable or malformed choice, a
 * judge that cannot choose (the keyless code proxy, the null judge, a
 * score-only judge) and a judge that throws are all `{unavailable}` rows,
 * which GV-119 reads as "walk exactly as today". A budget stop (the dollar
 * caps or the per-Foray unit caps) propagates, like every model call's.
 *
 * Choice probabilities and Scores are different instruments, and a choice
 * probability is not comparable across judges (Hermes facts.yaml:110,
 * GV-47): nothing here thresholds one against the other.
 *
 * NO ANTHROPIC PATH: the judge is whatever `createClipJudge` built (Jev,
 * metered through BudgetGuard and pooled, or the Qwen judge behind the same
 * interface), or a test's fake.
 */

/** Beats judged at once (each beat's choice, then its Scores). */
export const PREJUDGE_CONCURRENCY = 8;

const ChoiceRankSchema = z.object({ key: z.string().min(1), p: z.number().min(0).max(1) }).strict();

/** One beat's judged verdict. `ranked` is every option the choice saw,
 * highest probability first; `windowScores` holds the Scores of the top-K
 * keys (an unscored window is its `{unavailable}` outcome). */
export const ClipVerdictJudgedSchema = z
  .object({
    ranked: z.array(ChoiceRankSchema),
    noneP: z.number().min(0).max(1),
    judge: z.enum(CLIP_JUDGE_IDS),
    windowScores: z.record(z.string(), ClipScoreOutcomeSchema)
  })
  .strict();
export type ClipVerdictJudged = z.infer<typeof ClipVerdictJudgedSchema>;

export const ClipVerdictSchema = z.union([ClipVerdictJudgedSchema, ClipUnavailableSchema]);
export type ClipVerdict = z.infer<typeof ClipVerdictSchema>;

/** The book the `clip-judge` stage banks: one verdict per beat key
 * (`beatVerdictKey`, `act/slot/beat`), in playing order. */
export const ClipVerdictBookSchema = z.record(z.string(), ClipVerdictSchema);
export type ClipVerdictBook = z.infer<typeof ClipVerdictBookSchema>;

export interface PrejudgeClipsOptions {
  /** The listener's subject sentence (`subjectSentenceFor`). */
  subjectSentence: string;
  /** How many of the choice's leaders are scored (`gates.clipJudgeTopK`). */
  topK: number;
  /** Beats in flight at once (default `PREJUDGE_CONCURRENCY`). */
  concurrency?: number;
}

const isBudgetStop = (err: unknown): boolean => findBudgetError(err) !== null || findUnitBudgetError(err) !== null;

/** Runs `fn` over `items` with at most `limit` in flight, results in item
 * order. After a failure no new item starts, and the first failure rejects. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

async function judgeOneBeat(set: BeatCandidateSet, judge: ClipJudge, opts: PrejudgeClipsOptions): Promise<ClipVerdict> {
  if (set.options.length === 0) return { unavailable: "no-options" };
  if (!judge.choose) return { unavailable: "no-choice" };
  let choice: ClipChoiceOutcome;
  try {
    choice = await judge.choose({
      subjectSentence: opts.subjectSentence,
      claim: set.claim,
      options: set.options.map((o) => ({ key: o.key, text: o.text }))
    });
  } catch (err) {
    if (isBudgetStop(err)) throw err;
    return { unavailable: "threw" };
  }
  if ("unavailable" in choice) return { unavailable: choice.unavailable };

  const textOf = new Map(set.options.map((o) => [o.key, o.text]));
  const leaders = choice.ranked.slice(0, Math.max(0, opts.topK)).filter((r) => textOf.has(r.key));
  const questions: ClipQuestion[] = leaders.map((r) => ({ key: r.key, subjectSentence: opts.subjectSentence, claim: set.claim, windowText: textOf.get(r.key)! }));
  let scores = new Map<string, ClipScoreOutcome>();
  if (questions.length > 0) {
    try {
      scores = await judge.score(questions);
    } catch (err) {
      if (isBudgetStop(err)) throw err;
      scores = new Map(questions.map((q) => [q.key, { unavailable: "threw" }]));
    }
  }
  const windowScores: Record<string, ClipScoreOutcome> = {};
  for (const q of questions) windowScores[q.key] = scores.get(q.key) ?? { unavailable: "no-answer" };
  return { ranked: choice.ranked, noneP: choice.noneP, judge: choice.judge, windowScores };
}

/**
 * Judges every set: one `choose` per beat with options, then one `score`
 * call holding at most `topK` windows. At most `concurrency` beats in flight,
 * so at most that many judge calls. The book's keys follow `sets`' order.
 */
export async function prejudgeClips(sets: readonly BeatCandidateSet[], judge: ClipJudge, opts: PrejudgeClipsOptions): Promise<ClipVerdictBook> {
  const verdicts = await mapLimit(sets, opts.concurrency ?? PREJUDGE_CONCURRENCY, (set) => judgeOneBeat(set, judge, opts));
  const book: ClipVerdictBook = {};
  sets.forEach((set, i) => {
    book[beatVerdictKey(set)] = verdicts[i]!;
  });
  return book;
}

/** One line for the run log: how many beats were judged, how often 'none'
 * beat every passage, and how many verdicts are unavailable (and why). */
export function summarizeClipVerdicts(book: ClipVerdictBook): string {
  let judged = 0;
  let noneWins = 0;
  const unavailable = new Map<string, number>();
  for (const verdict of Object.values(book)) {
    if ("unavailable" in verdict) {
      unavailable.set(verdict.unavailable, (unavailable.get(verdict.unavailable) ?? 0) + 1);
      continue;
    }
    judged += 1;
    if (verdict.ranked.every((r) => verdict.noneP > r.p)) noneWins += 1;
  }
  const reasons = [...unavailable].map(([reason, n]) => `${reason} ${n}`).join(", ");
  const unavailableCount = [...unavailable.values()].reduce((a, b) => a + b, 0);
  return `clip-judge: ${judged} beat(s) judged, 'none' highest on ${noneWins}; ${unavailableCount} unavailable${reasons ? ` (${reasons})` : ""}`;
}
