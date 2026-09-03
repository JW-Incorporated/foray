import type { Act, DeepenedAct, Spine } from "../types/spine";

/**
 * §4.4's LLM collaborator (docs/curation/generation-architecture.md §4.4),
 * behind the same stub/real-provider split as every other generation-stage
 * collaborator. Every call MUST route through the budget guard
 * (src/cost/budgetGuard.ts).
 *
 * Unlike `SpineBuilder` (called exactly once), §5's topology table calls
 * for "1 per act (3-7)" — this is the first stage with real parallelism.
 * A single `deepenAct()` call is scoped to ONE act, but ALWAYS receives
 * the full spine so the act agent never has to re-derive what a sibling
 * act already established (§4.4: "The full-spine context is what stops
 * act 3 from re-explaining what act 1 established.").
 */
export interface DeepenActBuilder {
  readonly providerName: string;

  /**
   * Refines `targetAct`'s slots/beats and writes its introduction and
   * exit. `fullSpine` is the complete, frozen spine (all acts) — the
   * builder may read any other act for context but must only refine
   * `targetAct`; a builder that mutates or fabricates content for a
   * sibling act is a caller-side bug this module does not itself detect
   * (that is what `validateDeepenedAct` + the "full spine passed" test
   * exist to catch, from the caller side).
   */
  deepenAct(fullSpine: Spine, targetAct: Act, targetActIndex: number, ctx: DeepenActContext): Promise<DeepenedAct>;
}

export interface DeepenActContext {
  userId: string;
  sessionId?: string;
}
