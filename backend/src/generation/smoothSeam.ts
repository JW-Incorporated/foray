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
 * Smooths ONE act boundary and returns the introduction act `index`
 * should carry. Act 0 comes back untouched: there is no previous act to
 * hand off from.
 *
 * SPLIT OUT OF `smoothActs` FOR F-66 (docs/curation/generation-run-
 * 2026-09-09.md). §4.8 used to smooth every boundary in one pass, and
 * `stitchForay` ran that pass before it stitched a single act — which
 * meant the whole stitch stage, and with it WS-D2's partial candidate,
 * could not begin until the LAST act's narration was finished.
 *
 * Nothing about the smoothing needed that. The only inputs to a boundary
 * are act `index - 1`'s exit and act `index`'s introduction, both of them
 * §4.4 output, both known before a single page of narration is written.
 * Exposing one boundary at a time therefore lets §4.8 smooth act N the
 * instant act N is narrated without changing what any call receives: this
 * function reads the previous act's ORIGINAL exit, never a smoothed copy
 * (§6.2), exactly as the whole-array pass below always did, and the calls
 * still happen in boundary order.
 */
export async function smoothActIntroduction(
  acts: DeepenedAct[],
  index: number,
  options: SmoothActsOptions,
  ctx: ContinuityBuildContext
): Promise<string> {
  const nextAct = acts[index];
  if (!nextAct) {
    throw new Error(`smoothActIntroduction: no act at index ${index} — ${acts.length} act(s) were supplied`);
  }
  // Act 0 opens the Foray; §6.2's forward-only rule leaves it alone.
  if (index === 0) return nextAct.introduction;

  const previousAct = acts[index - 1]!; // the ORIGINAL previous act — never the smoothed copy, matching §6.2's own act's exit staying fixed once written

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
    throw new SeamSmoothingError(index, nextAct.title, validation.issues);
  }

  return smoothed.nextIntroduction;
}

/**
 * Smooths every act boundary in `acts`, in order, and returns a NEW
 * array where every act's `introduction` has (possibly) been replaced
 * by the smoothed version — act 0 is never touched (there is no
 * previous act to hand off from), and every other field of every act
 * (including `exit`) is passed through unchanged.
 *
 * NO PRODUCTION CALLER SINCE F-66 — `stitchForay.ts` now drives
 * `smoothActIntroduction` one boundary at a time so act N can be stitched
 * as soon as it is narrated. This whole-array form is kept because it is
 * the statement of the forward-only invariant AS A PROPERTY OF A WHOLE
 * FORAY (act 0 identical by reference, every other act a copy carrying
 * only a new `introduction`), which is what `smoothSeam.test.ts` pins and
 * what a reader of §4.8 is looking for. It delegates to the per-boundary
 * function above rather than repeating it, so the invariant those tests
 * assert cannot drift from what the pipeline actually does.
 */
export async function smoothActs(acts: DeepenedAct[], options: SmoothActsOptions, ctx: ContinuityBuildContext): Promise<DeepenedAct[]> {
  if (acts.length === 0) return [];

  const result: DeepenedAct[] = [acts[0]!];
  for (let i = 1; i < acts.length; i++) {
    const introduction = await smoothActIntroduction(acts, i, options, ctx);
    result.push({ ...acts[i]!, introduction });
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
