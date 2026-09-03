import type { DeepenedAct } from "../types/spine";
import type { ContinuityBuilder, ContinuityBuildContext } from "./ContinuityBuilder";

/**
 * §4.8 CROSS-ACT continuity orchestrator (docs/curation/generation-
 * architecture.md §4.8 / §5 / §6.2). Runs the ONE continuity agent
 * (`ContinuityBuilder`) at every act boundary of a Foray, forward-only:
 * each call may only replace act N+1's `introduction`; act N's own
 * `exit`/items are never touched again after this call returns, and
 * `smoothActs` below enforces that structurally by returning a NEW
 * array of acts rather than mutating `acts` in place, with every act
 * except the one just smoothed copied through unchanged (`===`-equal
 * to the input object for every act other than the one whose
 * `introduction` changed).
 *
 * §6.1/§6.2's real-world driver: acts are built and PLAYED
 * progressively — by the time act N+1 is being smoothed, act N may
 * already be playing in a listener's ear. "Once the listener has heard
 * an act, that act is immutable." This module's contract makes that
 * true for the data structure too, not only for the player's behaviour.
 */
export interface SmoothActsOptions {
  builder: ContinuityBuilder;
}

/**
 * Smooths every act boundary in `acts`, in order, and returns a NEW
 * array where every act's `introduction` has (possibly) been replaced
 * by the smoothed version — act 0 is never touched (there is no
 * previous act to hand off from), and every other field of every act
 * (including `exit`) is passed through unchanged.
 */
export async function smoothActs(acts: DeepenedAct[], options: SmoothActsOptions, ctx: ContinuityBuildContext): Promise<DeepenedAct[]> {
  if (acts.length === 0) return [];

  const result: DeepenedAct[] = [acts[0]!];
  for (let i = 1; i < acts.length; i++) {
    const previousAct = acts[i - 1]!; // the ORIGINAL previous act — never the smoothed copy, matching §6.2's own act's exit staying fixed once written
    const nextAct = acts[i]!;

    const smoothed = await options.builder.smoothSeam(
      {
        previousActExit: previousAct.exit,
        previousActTitle: previousAct.title,
        nextActIntroduction: nextAct.introduction,
        nextActTitle: nextAct.title
      },
      ctx
    );

    const validation = validateSmoothedSeam(nextAct, smoothed.nextIntroduction);
    if (!validation.valid) {
      throw new SeamSmoothingError(i, nextAct.title, validation.issues);
    }

    result.push({ ...nextAct, introduction: smoothed.nextIntroduction });
  }
  return result;
}

export class SeamSmoothingError extends Error {
  constructor(
    public readonly boundaryIndex: number,
    public readonly nextActTitle: string,
    public readonly issues: string[]
  ) {
    super(`Smoothing the seam into act "${nextActTitle}" (boundary ${boundaryIndex}) produced an invalid introduction: ${issues.join("; ")}`);
    this.name = "SeamSmoothingError";
  }
}

export interface SeamValidationResult {
  valid: boolean;
  issues: string[];
}

/** Structural check on a smoothed introduction — deliberately minimal
 * (the actual prose-quality judgement already happened inside the
 * builder call): non-empty, and not simply an untouched copy of an
 * empty string. A stronger content check (e.g. "does it actually
 * reference the previous act") is a job for a verifier agent, which
 * §4.8/§5 do not ask for here — the continuity agent is not paired
 * with a separate verifier the way §4.7's writer/verifier pair is. */
export function validateSmoothedSeam(nextAct: DeepenedAct, smoothedIntroduction: string): SeamValidationResult {
  const issues: string[] = [];
  if (smoothedIntroduction.trim().length === 0) {
    issues.push("smoothed introduction is empty");
  }
  if (smoothedIntroduction.trim().length < nextAct.introduction.trim().length * 0.5) {
    issues.push(
      `smoothed introduction (${smoothedIntroduction.trim().length} chars) is suspiciously shorter than the original (${nextAct.introduction.trim().length} chars) — looks truncated rather than smoothed`
    );
  }
  return { valid: issues.length === 0, issues };
}
