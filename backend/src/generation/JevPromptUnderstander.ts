import { defaultBudgetGuard, findBudgetError, type BudgetGuard } from "../cost/budgetGuard";
import { findUnitBudgetError } from "../cost/unitBudget";
import type { ClarityResult, IntentUnderstanding } from "../types/generation";
import { meteredJevClient } from "./jevClient";
import type { JevClient, JevNoulQuestion, JevResult, JevState } from "./jevTypes";
import type { PromptUnderstandContext, PromptUnderstander } from "./PromptUnderstander";

/**
 * GV-49 (docs/roadmap/generation-v2.md, from W4-02; covers R1-02): §4.1's
 * clarity check as ONE Jev request carrying two yes/no (noul) questions,
 * about 0.2 s, in place of the text model's clarity call.
 *
 *   - Both answers below threshold: the prompt is not ambiguous, and no text
 *     model is called ({ambiguous:false, readings:[], question:null}).
 *   - Either answer at or above threshold: the fallback understander answers
 *     (it writes the question and the readings, or overrules Jev to "not
 *     ambiguous"). Jev never authors listener copy.
 *   - Jev unavailable (no key, network, timeout, HTTP error, a malformed
 *     reply): the fallback answers. Nothing Jev does throws out of
 *     assessClarity; only a budget stop propagates, like every model call's.
 *
 * extractIntent always delegates to the fallback. Every result carries
 * `decidedBy` ('jev' | 'fallback'), which understandPrompt copies onto its
 * result as `clarityDecidedBy`, so the decision reaches the outcome and
 * report.json without module-global state.
 *
 * DARK. Built only by createPromptUnderstander when
 * FORAY_STAGE_UNDERSTAND_CLARITY=jev (or jev:<lane>, which puts GV-47's Qwen
 * judge behind Jev for the two questions). The fallback is the understander
 * the routing table picks for the rest of ST-01; this module adds no
 * Anthropic call site.
 *
 * PRIVACY (OQ-05, RQ-04, LM-25). The listener's prompt and a one-line product
 * description are sent to TypeSafe's hosted Jev API. OQ-05's adopted default
 * accepts this; nothing else (no history, no user id) goes in the state.
 */

/** The two questions' ids: the FakeJevClient key and the answers' ids. */
export const CLARITY_QUESTION_IDS = { twoSubjects: "two-subjects", oneEpisode: "one-episode" } as const;

/** p(yes) at or above which a question counts as "yes" and the fallback is
 * asked. PROPOSED: the live step calibrates them against founder-labelled
 * prompts (agreement 0.9 or better) and records them as settled. */
export const CLARITY_THRESHOLDS: Readonly<ClarityThresholds> = Object.freeze({ twoSubjects: 0.5, oneEpisode: 0.5 });

export interface ClarityThresholds {
  twoSubjects: number;
  oneEpisode: number;
}

/** What Foray is, in one line, so Jev reads the request in context. */
export const CLARITY_PRODUCT_LINE =
  "Foray turns a listener's short request into one narrated audio documentary about a single subject, built from clips of real podcast episodes.";

/** The two noul questions, in the order they are sent. */
export const CLARITY_QUESTIONS: readonly JevNoulQuestion[] = Object.freeze([
  {
    id: CLARITY_QUESTION_IDS.twoSubjects,
    type: "noul",
    instructions: "Does the request name two or more different subjects that would each need their own documentary?",
    criteria: {
      true: "The request names two or more different subjects, and each would need its own documentary.",
      false: "The request is about one subject, or its parts belong in one documentary."
    }
  },
  {
    id: CLARITY_QUESTION_IDS.oneEpisode,
    type: "noul",
    instructions: "Is the request asking for one specific podcast episode or show rather than a subject?",
    criteria: {
      true: "The request asks for one specific podcast episode or show.",
      false: "The request asks about a subject, not one specific episode or show."
    }
  }
]) as readonly JevNoulQuestion[];

/** The purpose label on the Jev call's CallRecord and cost event. */
export const CLARITY_JEV_PURPOSE = "clarity";

/** The state Jev is asked about: the request and the product line, nothing else. */
export function clarityState(prompt: string): JevState {
  return { request: prompt, product: CLARITY_PRODUCT_LINE };
}

/** Jev's verdict from one result: 'clear' (both below threshold), 'yes'
 * (either at or above), or 'unavailable' (a failure, or a reply missing one
 * of the two noul answers). */
export function clarityVerdict(result: JevResult, thresholds: ClarityThresholds): "clear" | "yes" | "unavailable" {
  if (!result.ok) return "unavailable";
  const noul = (id: string): number | null => {
    const answer = result.answers.find((a) => a.id === id);
    return answer !== undefined && answer.type === "noul" && Number.isFinite(answer.noul) ? answer.noul : null;
  };
  const twoSubjects = noul(CLARITY_QUESTION_IDS.twoSubjects);
  const oneEpisode = noul(CLARITY_QUESTION_IDS.oneEpisode);
  if (twoSubjects === null || oneEpisode === null) return "unavailable";
  return twoSubjects >= thresholds.twoSubjects || oneEpisode >= thresholds.oneEpisode ? "yes" : "clear";
}

export class JevPromptUnderstander implements PromptUnderstander {
  readonly providerName = "jev";

  constructor(
    private readonly jev: JevClient,
    private readonly fallback: PromptUnderstander,
    private readonly thresholds: ClarityThresholds = CLARITY_THRESHOLDS,
    /** Every Jev ask is metered here (meteredJevClient) with the call's user
     * and session, so the per-Foray cap applies. */
    private readonly budgetGuard: BudgetGuard = defaultBudgetGuard
  ) {}

  async assessClarity(prompt: string, ctx: PromptUnderstandContext): Promise<ClarityResult> {
    const metered = meteredJevClient(this.jev, {
      guard: this.budgetGuard,
      userId: ctx.userId,
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {})
    });
    let result: JevResult;
    try {
      result = await metered.ask(clarityState(prompt), CLARITY_QUESTIONS, { purpose: CLARITY_JEV_PURPOSE });
    } catch (err) {
      /* A budget stop propagates like every model call's: the dollar caps
         and, GV-124 (#1413 item 3), the per-Foray unit caps (a `jevCalls`
         UnitBudgetExceededError), so a spent cap stops the run instead of
         quietly degrading the stage. Anything else a JevClient throws breaks
         its never-throws contract; it is treated as Jev being unavailable,
         so the run still gets a clarity verdict. */
      if (findBudgetError(err) !== null || findUnitBudgetError(err) !== null) throw err;
      result = { ok: false, error: { category: "network", reason: "threw" }, latencyMs: 0 };
    }
    if (clarityVerdict(result, this.thresholds) === "clear") {
      return { ambiguous: false, readings: [], question: null, decidedBy: "jev" };
    }
    const answered = await this.fallback.assessClarity(prompt, ctx);
    return { ...answered, decidedBy: "fallback" };
  }

  extractIntent(prompt: string, ctx: PromptUnderstandContext): Promise<IntentUnderstanding> {
    return this.fallback.extractIntent(prompt, ctx);
  }
}
