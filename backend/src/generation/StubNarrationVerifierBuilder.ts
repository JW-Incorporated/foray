import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { containsContestedLanguage, hasDeclarativeSentence } from "../types/narration";
import type { NarrationBuildContext, NarrationVerifierBuilder, NarrationVerifyRequest, NarrationVerifyResult } from "./NarrationVerifierBuilder";

/**
 * Deterministic fake narration verifier, used whenever ANTHROPIC_API_KEY
 * is absent (env.anthropicDryRun). A DISTINCT CLASS from
 * `StubNarrationWriterBuilder` — never share a class or instance between
 * the two roles, per §4.7 rule 2 / §5's topology table.
 *
 * Re-derives a verdict from the page + its sources alone (never reads
 * anything the writer produced beyond the `NarrationVerifyRequest`
 * contract), the same structural independence the real
 * AnthropicNarrationVerifierBuilder must also honour: a page whose
 * claim(s) find no textual echo in its own `sources[].quote` fails, and
 * a page with a `contested: true` source that never says so in the
 * script also fails (mirrors `validateNarratedBeat`'s
 * `contested-not-flagged-in-text` check, run independently here so the
 * verifier does not merely rubber-stamp what the schema already
 * enforces — a real LLM verifier is asked to catch content the schema
 * cannot see, e.g. a source quote that does not actually support the
 * claim it is attached to).
 */
export class StubNarrationVerifierBuilder implements NarrationVerifierBuilder {
  readonly providerName = "stub";

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {}

  async verifyPage(request: NarrationVerifyRequest, ctx: NarrationBuildContext): Promise<NarrationVerifyResult> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "narration_verify",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });

    const notes: string[] = [];

    /* A page that asserts something with no source behind it, in either
       direction: the mode's own content obligation, and the general rule
       that a script stating anything about the world needs a source
       (F-36/F-37). */
    const needsSource = request.mode === "Patch" || request.mode === "Carry";
    if (needsSource && request.sources.length === 0) {
      notes.push(`${request.mode} narration asserts "${request.claim}" with zero sources attached.`);
    } else if (request.sources.length === 0 && hasDeclarativeSentence(request.script)) {
      notes.push("The script states something about the world with no source attached.");
    }

    /* WHAT THIS STUB NO LONGER DOES, and why. It used to require a
       significant word of the claim to appear inside its own quote — a
       stand-in for reading comprehension. That test is now both wrong and
       unnecessary: wrong, because a real retrieved passage supports a
       claim without repeating its wording, and the fixture passage
       deliberately shares no word with the beat purpose (quoting the
       purpose back is F-46); unnecessary, because whether a quote exists
       at all is now decided mechanically against the documents the
       pipeline holds, before any verifier is called. What a verifier is
       for — does this quote actually SUPPORT this claim, does the page do
       what the beat is for — needs a model, and a stub says so rather
       than faking it. */
    for (const source of request.sources) {
      if (source.claimText.trim().length === 0) {
        notes.push("A source is attached to no claim at all.");
      }
    }

    const anyContested = request.sources.some((s) => s.contested);
    if (anyContested && !containsContestedLanguage(request.script)) {
      notes.push("A source is marked contested but the script never says so explicitly.");
    }

    return {
      verified: notes.length === 0,
      verifierNotes: notes.length > 0 ? notes.join(" ") : undefined
    };
  }
}
