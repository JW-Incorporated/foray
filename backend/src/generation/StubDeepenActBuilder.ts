import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { Act, Beat, DeepenedAct, Slot, Spine } from "../types/spine";
import { capArgumentBeats } from "./deepenActs";
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

    /* The stub obeys the same structural rule the stage does (F-49), through
       the same function rather than a second copy of it: a dry run that could
       hand back a slot of six arguments would let a regression in the cap pass
       every keyless test, which is the exact shape of the run-2 failure. */
    return capArgumentBeats({
      title: targetAct.title,
      thesis: targetAct.thesis,
      startState: targetAct.startState,
      endState: targetAct.endState,
      slots,
      introduction: introductionFor(targetAct, targetActIndex, fullSpine),
      exit: exitFor(targetAct, nextAct, fullSpine)
    });
  }
}

/** Makes a beat's claim slightly more concrete without changing its
 * meaning, and preserves claim-shapedness (the source beat is already
 * claim-shaped by construction — see spine.ts's isClaimShaped — and this
 * only appends detail, never rewrites the verb). */
function sharpenBeat(beat: Beat, subject: string): Beat {
  /* WS-L (F-63): A SEEDED BEAT IS LEFT ALONE.
     Its claim is made of the words a person actually spoke in the window §4.2
     quoted, and §4.5's relevance floor asks whether the tape says the claim —
     so appending a generated sentence about the subject to it is exactly the
     dilution the floor exists to catch, and it would make the dry-run path
     unable to source the beats this stub was extended to produce. A real deepen
     call sharpens wording; it does not paste a fixed sentence onto every beat.
     The seed itself travels with the beat either way: §4.4 does not re-decide
     which stretch of tape a beat was written from, and a stub that dropped the
     field would let a regression in the real builder's pass-through go
     unnoticed in every keyless test. */
  if (beat.seed) {
    /* `account` by construction: the claim came off a recording, so a recording
       can carry it — the one case where the kind is not a judgement. */
    return { claim: beat.claim, exploration: beat.exploration, kind: beat.kind ?? "account", seed: beat.seed };
  }
  return {
    claim: `${beat.claim} This detail sharpens the picture of ${subject} for the listener.`,
    exploration: beat.exploration,
    kind: beat.kind ?? kindOf(beat.claim)
  };
}

/** Generalisation markers a real deepen call judges by meaning. The stub is a
 * fixture generator, not a judge — but it must emit BOTH kinds, or the dry-run
 * path would never exercise §4.5's argument branch (a beat tagged `argument`
 * skips tape lookup entirely) and a regression there would be invisible without
 * a key. `account` is the default here for the same reason it is the default in
 * the real prompt (F-49): a marker word is weak evidence that no recording
 * could carry the claim. */
function kindOf(claim: string): "account" | "argument" {
  return /\b(every|always|never|almost|tends?|generally|typically|in general|means that|is why)\b/i.test(claim) ? "argument" : "account";
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
