import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { Act, Beat, DeepenedAct, Slot, Spine } from "../types/spine";
import type { DeepenActBuilder, DeepenActContext } from "./DeepenActBuilder";

/**
 * Deterministic fake act-deepener, used whenever ANTHROPIC_API_KEY is
 * absent (env.anthropicDryRun) — same role as StubSpineBuilder /
 * StubPromptUnderstander / StubExternalResearcher: zero API keys, zero
 * network calls, reproducible fixtures that still satisfy
 * `validateDeepenedAct` (same slot count as the input act, every refined
 * beat claim-shaped, non-empty introduction/exit).
 *
 * A fixture generator, not a content-quality stand-in — real refinement
 * judgement is AnthropicDeepenActBuilder's job.
 */
export class StubDeepenActBuilder implements DeepenActBuilder {
  readonly providerName = "stub";

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {}

  async deepenAct(fullSpine: Spine, targetAct: Act, targetActIndex: number, ctx: DeepenActContext): Promise<DeepenedAct> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "deepen_act",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });

    const nextAct = fullSpine.acts[targetActIndex + 1];

    const slots: Slot[] = targetAct.slots.map((slot) => ({
      title: slot.title,
      beats: slot.beats.map((beat) => sharpenBeat(beat, fullSpine.subject))
    }));

    return {
      title: targetAct.title,
      thesis: targetAct.thesis,
      startState: targetAct.startState,
      endState: targetAct.endState,
      slots,
      introduction: introductionFor(targetAct, targetActIndex, fullSpine),
      exit: exitFor(targetAct, nextAct, fullSpine)
    };
  }
}

/** Makes a beat's claim slightly more concrete without changing its
 * meaning, and preserves claim-shapedness (the source beat is already
 * claim-shaped by construction — see spine.ts's isClaimShaped — and this
 * only appends detail, never rewrites the verb). */
function sharpenBeat(beat: Beat, subject: string): Beat {
  return {
    claim: `${beat.claim} This detail sharpens the picture of ${subject} for the listener.`,
    exploration: beat.exploration
  };
}

function introductionFor(act: Act, index: number, spine: Spine): string {
  if (index === 0) {
    return `We start with ${act.thesis.toLowerCase()} Before anything else, here is where ${spine.subject} begins.`;
  }
  return `Coming out of the last act, here is where ${act.thesis.toLowerCase()}`;
}

function exitFor(act: Act, nextAct: Act | undefined, spine: Spine): string {
  if (!nextAct) {
    return `That is where ${act.endState.toLowerCase()} closing out this Foray on ${spine.subject}.`;
  }
  return `That leaves us with ${act.endState.toLowerCase()} which is exactly where the next act picks up.`;
}
