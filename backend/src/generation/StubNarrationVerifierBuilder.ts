import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { containsContestedLanguage } from "../types/narration";
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

    const needsSource = request.mode === "Patch" || request.mode === "Carry";
    if (needsSource && request.sources.length === 0) {
      notes.push(`${request.mode} narration asserts "${request.claim}" with zero sources attached.`);
    }

    for (const source of request.sources) {
      // The stub's own textual-overlap check: at least some non-trivial
      // token from the claim should appear in the quote it is meant to
      // back. A real Anthropic verifier does actual reading comprehension
      // here; this stub does the mechanical version so the pipeline's
      // shape (a real, separate check) is exercised even in dry-run.
      const claimTokens = significantTokens(source.claimText);
      const quoteLower = source.quote.toLowerCase();
      const overlap = claimTokens.some((t) => quoteLower.includes(t));
      if (!overlap) {
        notes.push(`Source for "${source.claimText}" shares no significant word with its own quote — cannot confirm it supports the claim.`);
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

function significantTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{5,}/g) ?? []).slice(0, 8);
}
