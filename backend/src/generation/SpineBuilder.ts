import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape } from "../types/research";
import type { DurationTier, Spine } from "../types/spine";

/**
 * §4.3's LLM collaborator, behind the same stub/real-provider split as
 * every other generation-stage collaborator (`PromptUnderstander`,
 * `ExternalResearcher`): cheap, deterministic dry-run by default; a real
 * LLM call only when ANTHROPIC_API_KEY is configured. Every call MUST
 * route through the budget guard (src/cost/budgetGuard.ts).
 *
 * Deliberately a SINGLE call per Foray (§5's topology table: "1, always"
 * for this stage) — there is no per-act or per-beat method on this
 * interface, because splitting spine construction across calls is exactly
 * the "actively destructive" parallelism §5 warns against.
 */
export interface SpineBuilder {
  readonly providerName: string;

  /**
   * Produces the raw spine (acts, slots, beats, voice, exploration marks)
   * from §4.1's intent, §4.2's research shape, and the requested duration
   * tier. Does NOT itself guarantee the result passes `validateSpine` —
   * see `buildSpine.ts`, which calls this and then validates the output;
   * a builder is expected to aim for the tier's budget but the validator
   * is the actual gate.
   */
  buildSpine(
    intent: IntentUnderstanding,
    researchShape: ResearchShape,
    duration: DurationTier,
    ctx: SpineBuildContext
  ): Promise<Spine>;
}

export interface SpineBuildContext {
  userId: string;
  sessionId?: string;
  /**
   * F-86: present when this call is a RE-ASK — the previous reply failed the
   * structural gate (`spineStructure.ts`, F-13) and `buildSpine.ts` is asking
   * once more with the violations named. A builder that honours it re-sends its
   * own prompt, the previous reply, and one "fix only these" turn, so the model
   * keeps everything the gate did not refuse; a builder that ignores it simply
   * produces a fresh spine, which the gate judges the same way. Absent on every
   * first call.
   */
  revision?: SpineRevisionRequest;
  /**
   * GV-67 (W4-03): the listener's own words, set only on the folded path
   * (`flags.foldSpineCopy`). The intent is then a keyword list
   * (`preSpineIntent.ts`), and a builder that honours this field asks the
   * model for subject, angle, priorKnowledge, disappointment,
   * answersDisappointment, title and summary first, and returns the Spine's
   * subject and angle from that reply. Absent on every classic call, which
   * is then unchanged.
   *
   * CALL STACK ONLY: it is never checkpointed, logged or copied onto the
   * Spine (§4.1's "prompts are discarded").
   */
  listenerPrompt?: string;
  /**
   * GV-86 (W4-05): set (true) only when FORAY_SPINE_FOLD_DEEPEN is in force
   * for this run's tier. A builder that honours it asks the spine reply for
   * each act's introduction and exit and each beat's kind (prompts/spine.ts,
   * in the deepen prompt's own rules) and parses them through
   * (`RawSpineFoldDeepenSchema`), so `deepenActs.ts` can take the act as
   * deepened without a deepen call. A builder that ignores it returns a
   * classic spine, and every act then costs its usual deepen call. Absent on
   * every classic call, which is then unchanged. CALL STACK ONLY, like
   * `listenerPrompt`.
   */
  foldDeepen?: boolean;
}

/** F-86: what a re-ask carries — see `SpineBuildContext.revision`. */
export interface SpineRevisionRequest {
  /** The reply the gate refused, already schema-parsed. */
  previous: Spine;
  /** The gate's messages, verbatim — each names the act, the slot and the beat. */
  violations: string[];
  /** 1-based: the first re-ask is 1. */
  attempt: number;
  /**
   * WHICH RE-ASK THIS IS (F-98). Two conditions now re-ask the spine, and they
   * ask for different things: `"structure"` (F-86's, the default and the
   * behaviour of every call written before this field) says a claim is
   * malformed and to fix only what the gate named; `"seed-floor"` says the
   * reply is structurally fine but seeds too few of its beats from the windows
   * the prompt offered, and names the beats and the windows. One instruction
   * text per condition — telling a model to "fix only these violations" about
   * beats that violate nothing is how a re-ask comes back worse than the reply
   * it re-asked.
   *
   * GV-89 (W4-14) adds `"runtime"`: the post-seeded plan's minimum runtime
   * (`tierRuntime.ts`) is over the tier's ceiling, and the re-ask names the
   * overrun and the seed windows that carry it, asking the model to drop or
   * merge beats and keep the seeds it keeps (`buildRuntimeFixInstruction`).
   * Sent only under FORAY_TIER_RUNTIME_CAP (`buildSpine.ts`'s
   * `reaskForRuntime`).
   */
  kind?: "structure" | "seed-floor" | "runtime";
}
