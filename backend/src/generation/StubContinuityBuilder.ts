import * as crypto from "crypto";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { ContinuityBuilder, ContinuityBuildContext, ContinuitySmoothRequest, ContinuitySmoothResult } from "./ContinuityBuilder";

/**
 * Deterministic fake continuity builder, used whenever ANTHROPIC_API_KEY
 * is absent (env.anthropicDryRun) — same role as every other Stub* class
 * in this codebase (StubDeepenActBuilder, StubNarrationWriterBuilder...):
 * zero API keys, zero network calls, a reproducible fixture that still
 * satisfies `validateSmoothedSeam` (smoothForay.ts) and is OBSERVABLY
 * different from the untouched `nextActIntroduction` it was given, so a
 * test can assert "the seam was actually smoothed" rather than merely
 * "some string came back".
 *
 * A fixture generator, not a content-quality stand-in — real prose
 * judgement is AnthropicContinuityBuilder's job.
 */
export class StubContinuityBuilder implements ContinuityBuilder {
  readonly providerName = "stub";

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {}

  async smoothSeam(request: ContinuitySmoothRequest, ctx: ContinuityBuildContext): Promise<ContinuitySmoothResult> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "continuity_smooth",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });

    /* Deterministic, seeded only by the previous exit's own text (never
       randomness — a stub must be reproducible across runs, matching
       StubNarrationWriterBuilder's discipline).

       Q-08: IT NO LONGER SPEAKS THE ACT'S TITLE. An act title is production
       metadata and reads "Act 2: how the tools get chosen"; this string is
       SPOKEN, as the next act's opening narration item, so echoing the title
       put "Act 2" in the listener's ear. `validateSmoothedSeam` refuses that
       now, which means a stub that kept the old wording would fail every
       dry run. The callback out of the previous exit is what actually
       smooths the seam, and it is still what makes the result observably
       different from the introduction it was handed. */
    const callback = shortCallback(request.previousActExit);
    const smoothed = `Coming out of all that — ${callback} — ${lowerFirst(request.nextActIntroduction.trim())}`.trim();

    return { nextIntroduction: smoothed };
  }
}

function shortCallback(exit: string): string {
  const trimmed = exit.trim();
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  // Keep the callback short — this is a seam phrase, not a restatement
  // of the whole exit.
  return firstSentence.length > 90 ? `${firstSentence.slice(0, 87)}...` : lowerFirst(firstSentence).replace(/[.!?]+$/, "");
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}

/** Exported for tests that want a stable hash without pulling in crypto
 * directly — mirrors StubNarrationWriterBuilder's `hashToInt` pattern,
 * kept here in case a future fixture needs a seeded choice among
 * several callback phrasings. */
export function hashToInt(input: string): number {
  const digest = crypto.createHash("sha1").update(input).digest();
  return digest.readUInt32BE(0);
}
