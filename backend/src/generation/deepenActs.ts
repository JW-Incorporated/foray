import type { Act, DeepenedAct, Spine } from "../types/spine";
import { DeepenedActSchema, validateDeepenedAct } from "../types/spine";
import type { DeepenActBuilder, DeepenActContext } from "./DeepenActBuilder";

/**
 * §4.4 end to end (docs/curation/generation-architecture.md §4.4 / §5):
 * takes the frozen §4.3 spine and produces one deepened act per input act,
 * by invoking `builder.deepenAct()` ONCE PER ACT, IN PARALLEL
 * (`Promise.all`) — §5's topology table: "1 per act (3-7)... the natural
 * parallel boundary."
 *
 * Every call receives the FULL spine (not just its own act's slice) —
 * this is load-bearing, not a convenience: §4.4 states "the full-spine
 * context is what stops act 3 from re-explaining what act 1 established."
 *
 * FAILURE-ISOLATION POLICY (this stage's own call, per the task brief):
 * a single act's deepening is retried ONCE on failure (a transient LLM/API
 * hiccup is the overwhelmingly likely cause and a free retry is cheap
 * relative to redoing every other act). If the retry also fails, the
 * WHOLE Foray build fails — a deepened act is not optional content, it is
 * one act of the finished spine, and §6.1 already establishes that acts
 * are played in order; a Foray missing act 3 is not a valid Foray, it is
 * a corrupt one. A failure in one act's deepening never corrupts or
 * silently drops another act's independently-produced result — every
 * other act's `deepenAct()` call proceeds and completes (or fails) on its
 * own, per §4.4's "genuinely independent" framing; this function simply
 * declines to return a partial result set once any act's retry budget is
 * exhausted.
 */
export class ActDeepeningError extends Error {
  constructor(
    public readonly actIndex: number,
    public readonly actTitle: string,
    public readonly cause: unknown
  ) {
    super(`Deepening act ${actIndex + 1} ("${actTitle}") failed after 1 retry: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "ActDeepeningError";
  }
}

export class InvalidDeepenedActError extends Error {
  constructor(
    public readonly actIndex: number,
    public readonly actTitle: string,
    public readonly issues: string[]
  ) {
    super(`Deepened act ${actIndex + 1} ("${actTitle}") failed validation: ${issues.join("; ")}`);
    this.name = "InvalidDeepenedActError";
  }
}

async function deepenOneActWithRetry(
  spine: Spine,
  act: Act,
  index: number,
  builder: DeepenActBuilder,
  ctx: DeepenActContext
): Promise<DeepenedAct> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await builder.deepenAct(spine, act, index, ctx);
      const deepened = DeepenedActSchema.parse(raw);

      const validation = validateDeepenedAct(act, deepened);
      if (!validation.valid) {
        throw new InvalidDeepenedActError(
          index,
          act.title,
          validation.issues.map((i) => i.message)
        );
      }

      return deepened;
    } catch (err) {
      lastError = err;
    }
  }
  throw new ActDeepeningError(index, act.title, lastError);
}

/**
 * Deepens every act of `spine` in parallel. Structured so a future
 * pipeline orchestrator (§4.0-§4.9 wired end-to-end) can call this as one
 * step — building that orchestrator is explicitly NOT this stage's job.
 */
/**
 * Per-act checkpoint seam (generation run 2026-09-09, findings F-17/F-18).
 *
 * Deliberately a pair of callbacks rather than a store object: this stage owns
 * the retry and failure-isolation policy above and must keep owning it, so all
 * it exposes is "do you already have act N?" and "here is act N". Where those
 * answers are kept — an in-memory map in a test, a JSON file beside the
 * candidate in the batch driver — is not this module's business.
 *
 * Both are optional, and a caller that passes neither gets exactly the
 * behaviour this function had before they existed.
 */
export interface DeepenActsOptions {
  /** Returns an already-deepened act for `index`, or undefined to build it. */
  resume?: (index: number) => DeepenedAct | undefined;
  /** Called with each act as soon as it is built and validated — never for a
   * resumed one, which is already stored. */
  onActDeepened?: (index: number, act: DeepenedAct) => void | Promise<void>;
}

export async function deepenActs(
  spine: Spine,
  builder: DeepenActBuilder,
  ctx: DeepenActContext,
  options: DeepenActsOptions = {}
): Promise<DeepenedAct[]> {
  const calls = spine.acts.map(async (act, index) => {
    const resumed = options.resume?.(index);
    if (resumed) return resumed;
    const deepened = await deepenOneActWithRetry(spine, act, index, builder, ctx);
    /* Persisted BEFORE `Promise.all` settles, so an act that succeeded is
       banked even when a sibling act's retry budget runs out and fails the
       whole stage. That is the F-17 case: the run dies, and the next attempt
       does not re-pay for the acts that worked. */
    await options.onActDeepened?.(index, deepened);
    return deepened;
  });
  return Promise.all(calls);
}
