import { findBudgetError } from "../cost/budgetGuard";
import { findUnitBudgetError } from "../cost/unitBudget";
import type { ClipJudgeId, ClipScoreOutcome } from "../types/tapeSourcing";
import type { Spine } from "../types/spine";
import { tokenizeForSourcing } from "./catalogueLookup";
import type { GateConfig } from "./gateConfig";
import { NullJevClient, createJevPool, meteredJevClient, type MeteredJevClientOptions } from "./jevClient";
import type { JevChoiceQuestion, JevClient, JevResult, JevScoreAnswer, JevScoreQuestion, JevState } from "./jevTypes";
import { CLIP_ON_SUBJECT_LEVEL } from "./veracityMetrics";

import type { ClipUnavailable } from "../types/tapeSourcing";

export type { ClipJudgeId, ClipScoreOutcome, ClipScores, ClipUnavailable } from "../types/tapeSourcing";

/**
 * GV-79 (docs/roadmap/generation-v2.md, W5-03; MQ-05, QK-20, GP-21, R2-03):
 * the clip-on-subject judge.
 *
 * WHY IT EXISTS. QK-04 `tapeRelevance` reads `isOnTopic`, which applies the
 * same taxonomy-lineage rule `familyGateAllows` already enforced on every
 * candidate during sourcing, so it is 1.0 by construction. It cannot see a
 * cyclospora clip in a germ-theory Foray when the show's node is in the
 * lineage. This asks of every clip the Foray actually plays two questions,
 * each a 5-level Score (0..4):
 *
 *   subject  how much is the passage about the listener's subject?
 *   claim    how directly does the passage make the beat's claim?
 *
 * Shadow mode only (FORAY_CLIP_JUDGE, `gateConfig.ts`): the Scores are
 * recorded on the sourcing rows and reported as
 * `meta.veracity.clipOnSubjectRate`; nothing is refused on them here (the
 * publish gate is GV-118's). Sourcing is unchanged.
 *
 * NO ANTHROPIC PATH. A judged score comes from the JevClient interface
 * (Jev, or the Qwen judge behind it, GV-47); with no judge key it comes from
 * `CodeProxyClipJudge`, a word-overlap proxy labelled `judge:'code'` so no
 * reader takes it for a model's verdict.
 */

/** One clip to score. `key` is the caller's (scoreClips.ts uses the row's
 * act:slot:beat position); `windowText` is the clip's own transcript. */
export interface ClipQuestion {
  key: string;
  subjectSentence: string;
  claim: string;
  windowText: string;
}

export interface ClipJudge {
  readonly name: string;
  /** One outcome per question key. Never throws for a judge outage (that is
   * an `{unavailable}` row); a budget stop propagates like every model
   * call's. */
  score(questions: readonly ClipQuestion[]): Promise<Map<string, ClipScoreOutcome>>;
  /**
   * GV-107 (W5-04): which of a beat's candidate passages makes its claim
   * about the listener's subject, 'none' allowed. Same contract as `score`:
   * an outage is `{unavailable}`, a budget stop propagates. Optional so a
   * judge that only scores (a test's spy) still is one; `prejudgeClips`
   * reads a missing `choose` as `{unavailable: 'no-choice'}`.
   */
  choose?(question: ClipChoiceQuestion): Promise<ClipChoiceOutcome>;
}

/** GV-107: one candidate passage of a beat: the caller's key
 * (`beatJudgeCandidates`'s option key) and the passage's own transcript. */
export interface ClipChoiceOption {
  key: string;
  text: string;
}

/** GV-107: one beat's choice: its claim, the listener's subject sentence and
 * the candidate passages (at least one). */
export interface ClipChoiceQuestion {
  subjectSentence: string;
  claim: string;
  options: readonly ClipChoiceOption[];
}

/** GV-107: the choice's answer. `ranked` holds every option, highest
 * probability first (ties keep the option order); `noneP` is the probability
 * of 'no passage makes this claim about this subject'. A choice probability
 * is not comparable with a noul's or with another judge's (GV-47), so it is
 * tagged with the judge that answered. */
export type ClipChoiceOutcome = { ranked: Array<{ key: string; p: number }>; noneP: number; judge: ClipJudgeId } | ClipUnavailable;

/** Levels on both Score cards (0..4). */
export const CLIP_SCORE_LEVELS = 5;
/** The purpose every clip-judge ask is metered and recorded under. */
export const CLIP_JUDGE_PURPOSE = "clip-judge";
export const CLIP_QUESTION_IDS = { subject: "subject", claim: "claim" } as const;

export const CLIP_SUBJECT_QUESTION: Readonly<JevScoreQuestion> = Object.freeze({
  id: CLIP_QUESTION_IDS.subject,
  type: "score",
  instructions: "How much is `passage` about `subject`?",
  criteria: [
    "The passage is not about the subject at all.",
    "The passage mentions the subject only in passing.",
    "The passage is partly about the subject.",
    "The passage is mostly about the subject.",
    "The passage is entirely about the subject."
  ]
});

export const CLIP_CLAIM_QUESTION: Readonly<JevScoreQuestion> = Object.freeze({
  id: CLIP_QUESTION_IDS.claim,
  type: "score",
  instructions: "How directly does `passage` make the point in `claim`?",
  criteria: [
    "The passage does not make the point at all.",
    "The passage touches on the point without making it.",
    "The passage makes part of the point.",
    "The passage makes the point, indirectly or among other things.",
    "The passage makes the point directly."
  ]
});

export const CLIP_QUESTIONS: readonly JevScoreQuestion[] = Object.freeze([CLIP_SUBJECT_QUESTION, CLIP_CLAIM_QUESTION]);

/** GV-107: the purpose every clip-choice ask is metered and recorded under,
 * apart from the Scores' so the live step can read the choice's latency per
 * beat on its own. */
export const CLIP_CHOICE_PURPOSE = "clip-choice";
/** GV-107: the choice question's id, and the criterion that says no passage
 * fits. Passages are criteria `o1`..`oN`, in the caller's option order. */
export const CLIP_CHOICE_QUESTION_ID = "passage";
export const CLIP_CHOICE_NONE = "none";

/** GV-107: the criterion id of the i-th option (0-based): `o1`, `o2`, ... */
export function clipChoiceOptionId(index: number): string {
  return `o${index + 1}`;
}

/** GV-107: the one choice question for `optionCount` passages: criteria
 * `o1`..`oN` ({what:'passage oN'}) plus 'none'. */
export function clipChoiceQuestion(optionCount: number): JevChoiceQuestion {
  const criteria: Record<string, { what: string }> = {};
  for (let i = 0; i < optionCount; i++) criteria[clipChoiceOptionId(i)] = { what: `passage ${clipChoiceOptionId(i)}` };
  criteria[CLIP_CHOICE_NONE] = { what: "no passage makes this claim about this subject" };
  return {
    id: CLIP_CHOICE_QUESTION_ID,
    type: "choice",
    instructions: "Which passage in `passages` makes the point in `claim` about `subject`?",
    criteria
  };
}

/** GV-107: what Jev reads for one beat's choice: the subject sentence, the
 * claim and the passages keyed `o1`..`oN` (never the caller's keys, which name
 * episodes; LM-25). */
export function clipChoiceState(q: ClipChoiceQuestion): JevState {
  return {
    subject: q.subjectSentence,
    claim: q.claim,
    passages: Object.fromEntries(q.options.map((o, i) => [clipChoiceOptionId(i), o.text]))
  };
}

const clampP = (p: number): number => Math.min(1, Math.max(0, p));

/** GV-107: reads the choice's probabilities back onto the caller's keys.
 * Fail-closed: a failure, a missing or wrongly typed answer, or a missing or
 * non-finite probability for any option (or for 'none') is `unavailable`. */
export function clipChoiceFromResult(result: JevResult, options: readonly ClipChoiceOption[]): ClipChoiceOutcome {
  if (!result.ok) return { unavailable: result.error.reason || result.error.category };
  const answer = result.answers.find((a) => a.id === CLIP_CHOICE_QUESTION_ID);
  if (!answer || answer.type !== "choice") return { unavailable: "malformed" };
  const probabilities: Record<string, number> = answer.probabilities ?? {};
  const pOf = (id: string): number | null => {
    const p = probabilities[id];
    return typeof p === "number" && Number.isFinite(p) ? clampP(p) : null;
  };
  const noneP = pOf(CLIP_CHOICE_NONE);
  if (noneP === null) return { unavailable: "malformed" };
  const ranked: Array<{ key: string; p: number }> = [];
  for (let i = 0; i < options.length; i++) {
    const p = pOf(clipChoiceOptionId(i));
    if (p === null) return { unavailable: "malformed" };
    ranked.push({ key: options[i]!.key, p });
  }
  /* Array.prototype.sort is stable: equal probabilities keep the option order. */
  ranked.sort((a, b) => b.p - a.p);
  return { ranked, noneP, judge: result.judge ?? "jev" };
}

/** What Jev reads for one clip: only the subject sentence, the claim and the
 * clip's own transcript (LM-25: keep what leaves the network minimal). */
export function clipState(q: ClipQuestion): JevState {
  return { subject: q.subjectSentence, claim: q.claim, passage: q.windowText };
}

/**
 * The listener's subject sentence the clip is judged against: the spine's
 * `subject (angle)`, never the taxonomy label (LM-23). The spine always
 * exists before sourcing, so this is the normal path; a missing spine field
 * falls back to the intent's. On the folded path (FORAY_SPINE_FOLD_COPY or
 * FORAY_FAST_PATH) the intent is a keyword list with 'not yet known'
 * sentinels (GV-67), which is why the spine, not the intent, is the source.
 * The spine's `disappointment` is NOT appended: it says what would fail the
 * listener, not what the Foray is about (see the PR's deviation note).
 */
export function subjectSentenceFor(
  spine: Partial<Pick<Spine, "subject" | "angle">> | null | undefined,
  intent: { subject?: string; angle?: string } | null | undefined
): string {
  const pick = (a: string | undefined, b: string | undefined): string => {
    const first = a?.trim() ?? "";
    return first.length > 0 ? first : (b?.trim() ?? "");
  };
  const subject = pick(spine?.subject, intent?.subject);
  const angle = pick(spine?.angle, intent?.angle);
  if (angle.length === 0 || angle === subject) return subject;
  if (subject.length === 0) return angle;
  return `${subject} (${angle})`;
}

const clampLevel = (n: number): number => Math.min(CLIP_SCORE_LEVELS - 1, Math.max(0, n));

/** Reads one ask's two Scores, or why it has none. Fail-closed: a failure,
 * a missing answer or an answer of the wrong type is `unavailable`. */
export function clipScoresFromResult(result: JevResult): ClipScoreOutcome {
  if (!result.ok) return { unavailable: result.error.reason || result.error.category };
  const find = (id: string): JevScoreAnswer | null => {
    const answer = result.answers.find((a) => a.id === id);
    return answer && answer.type === "score" && Number.isFinite(answer.score) ? answer : null;
  };
  const subject = find(CLIP_QUESTION_IDS.subject);
  const claim = find(CLIP_QUESTION_IDS.claim);
  if (!subject || !claim) return { unavailable: "malformed" };
  const confidence = Math.min(subject.confidence, claim.confidence);
  return {
    subject: clampLevel(subject.score),
    claim: clampLevel(claim.score),
    ...(Number.isFinite(confidence) ? { confidence: Math.min(1, Math.max(0, confidence)) } : {}),
    judge: result.judge ?? "jev"
  };
}

/** Jev (or the Qwen judge behind the JevClient interface): one ask per
 * clip, two Score questions. `client` is already metered and pooled
 * (`createClipJudge`), so a Promise.all over the Foray's clips is safe. */
export class JevClipJudge implements ClipJudge {
  readonly name = "jev";

  constructor(private readonly client: JevClient) {}

  async score(questions: readonly ClipQuestion[]): Promise<Map<string, ClipScoreOutcome>> {
    const outcomes = await Promise.all(
      questions.map(async (q): Promise<[string, ClipScoreOutcome]> => {
        try {
          const result = await this.client.ask(clipState(q), CLIP_QUESTIONS, { purpose: CLIP_JUDGE_PURPOSE });
          return [q.key, clipScoresFromResult(result)];
        } catch (err) {
          /* A budget stop propagates like every model call's: the dollar
             caps and, GV-124 (#1413 item 3), the per-Foray unit caps (a
             `jevCalls` UnitBudgetExceededError), so a spent cap stops the run
             instead of leaving the clips unscored. Anything else a JevClient
             throws breaks its never-throws contract and is that clip being
             unscored, not the run failing. */
          if (findBudgetError(err) !== null || findUnitBudgetError(err) !== null) throw err;
          return [q.key, { unavailable: "threw" }];
        }
      })
    );
    return new Map(outcomes);
  }

  /** GV-107: one ask, one choice question, for the beat's passages. */
  async choose(question: ClipChoiceQuestion): Promise<ClipChoiceOutcome> {
    if (question.options.length === 0) return { unavailable: "no-options" };
    try {
      const result = await this.client.ask(clipChoiceState(question), [clipChoiceQuestion(question.options.length)], { purpose: CLIP_CHOICE_PURPOSE });
      return clipChoiceFromResult(result, question.options);
    } catch (err) {
      /* The same rule as `score`: a budget stop propagates, anything else a
         JevClient throws is this beat being unjudged. */
      if (findBudgetError(err) !== null || findUnitBudgetError(err) !== null) throw err;
      return { unavailable: "threw" };
    }
  }
}

/** The proxy's share cut-points: a share at or above `CODE_PROXY_CUTS[i]`
 * reaches level i + 1. */
export const CODE_PROXY_CUTS = [0.05, 0.15, 0.3, 0.5] as const;

/** A share (0..1) as a level (0..4) at the proxy's cut-points. */
export function codeProxyLevel(share: number): number {
  let level = 0;
  for (const cut of CODE_PROXY_CUTS) if (share >= cut) level += 1;
  return level;
}

/**
 * The keyless proxy: for each clip, the idf-weighted share of the subject
 * sentence's (and, separately, the claim's) `tokenizeForSourcing` terms that
 * occur in the clip's window, mapped to 0..4 (`codeProxyLevel`). The idf is
 * over the windows of one `score` call (the Foray's clips): a term every clip
 * carries weighs least, a term no clip carries weighs most. Always labelled
 * `judge:'code'`. It reads words, not meaning, so it is a floor for a run
 * with no judge key, not a substitute for one.
 */
export class CodeProxyClipJudge implements ClipJudge {
  readonly name = "code";

  async score(questions: readonly ClipQuestion[]): Promise<Map<string, ClipScoreOutcome>> {
    const windows = questions.map((q) => new Set(tokenizeForSourcing(q.windowText)));
    const df = new Map<string, number>();
    for (const terms of windows) for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
    const n = windows.length;
    const idf = (t: string): number => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;
    const share = (text: string, window: Set<string>): number | null => {
      const terms = [...new Set(tokenizeForSourcing(text))];
      if (terms.length === 0) return null;
      let total = 0;
      let found = 0;
      for (const t of terms) {
        const w = idf(t);
        total += w;
        if (window.has(t)) found += w;
      }
      return total > 0 ? found / total : null;
    };
    const out = new Map<string, ClipScoreOutcome>();
    questions.forEach((q, i) => {
      const subject = share(q.subjectSentence, windows[i]!);
      const claim = share(q.claim, windows[i]!);
      if (subject === null || claim === null) {
        out.set(q.key, { unavailable: "no-terms" });
        return;
      }
      out.set(q.key, { subject: codeProxyLevel(subject), claim: codeProxyLevel(claim), judge: "code" });
    });
    return out;
  }

  /** GV-107: no keyless choice. The lexical walk already orders a beat's
   * windows by these same words, so a word-overlap "choice" would only
   * restate it with probabilities nobody measured; every beat is
   * `unavailable`, which GV-119's judged walk reads as "walk as today". */
  async choose(): Promise<ClipChoiceOutcome> {
    return { unavailable: "no-judge" };
  }
}

/** Scores nothing: every clip is `unavailable: 'off'`. */
export class NullClipJudge implements ClipJudge {
  readonly name = "none";

  async score(questions: readonly ClipQuestion[]): Promise<Map<string, ClipScoreOutcome>> {
    return new Map(questions.map((q): [string, ClipScoreOutcome] => [q.key, { unavailable: "off" }]));
  }

  async choose(): Promise<ClipChoiceOutcome> {
    return { unavailable: "off" };
  }
}

export interface CreateClipJudgeOptions {
  /** When given, every ask is metered through BudgetGuard (meteredJevClient,
   * GV-20) under this user and session, so the per-Foray cap applies. */
  meter?: MeteredJevClientOptions;
  /** Asks in flight at once (default: the Jev pool size). */
  maxInFlight?: number;
}

/**
 * The run's clip judge: none when FORAY_CLIP_JUDGE is `off`; Jev (metered
 * and pooled) when the judge route has a client that can answer; else the
 * code proxy. `jev` is the judge route's client (`createJevClient`), which is
 * a NullJevClient with no key or on the fail-closed 'none' route.
 */
export function createClipJudge(gates: Pick<GateConfig, "clipJudge">, jev: JevClient | null | undefined, opts: CreateClipJudgeOptions = {}): ClipJudge {
  if (gates.clipJudge === "off") return new NullClipJudge();
  if (!jev || jev instanceof NullJevClient) return new CodeProxyClipJudge();
  const metered = opts.meter ? meteredJevClient(jev, opts.meter) : jev;
  return new JevClipJudge(createJevPool(metered, opts.maxInFlight !== undefined ? { maxInFlight: opts.maxInFlight } : {}));
}

/** The level both Scores must reach for `judge`'s answer to count as on
 * subject: the per-judge gate key for Jev and Qwen (GV-47's `clipLevel`),
 * the proxy's constant for `code`. */
export function clipLevelFor(gates: Pick<GateConfig, "clipLevel.jev" | "clipLevel.qwen">, judge: ClipJudgeId): number {
  if (judge === "jev") return gates["clipLevel.jev"];
  if (judge === "qwen") return gates["clipLevel.qwen"];
  return CLIP_ON_SUBJECT_LEVEL;
}
