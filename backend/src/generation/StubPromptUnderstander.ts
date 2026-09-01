import * as crypto from "crypto";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { ClarityResult, IntentUnderstanding } from "../types/generation";
import type { PromptUnderstander, PromptUnderstandContext } from "./PromptUnderstander";

/**
 * Deterministic fake clarity/intent understander, used whenever
 * ANTHROPIC_API_KEY is absent (env.anthropicDryRun), exactly mirroring
 * StubEnricher's role (backend/src/enrich/StubEnricher.ts): zero API keys,
 * zero network calls, reproducible fixtures.
 *
 * CLARITY HEURISTIC: a short prompt (few content words) with no qualifying
 * detail reads as ambiguous — this is a deliberately crude stand-in for the
 * real judgement call an LLM makes, calibrated only enough to keep the two
 * required test fixtures ("Roman siege weapons" = clear, a bare one-word
 * prompt like "Mercury" = ambiguous) on the right side of the line. The real
 * provider (AnthropicPromptUnderstander) does the actual judgement.
 */
export class StubPromptUnderstander implements PromptUnderstander {
  readonly providerName = "stub";

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {}

  async assessClarity(prompt: string, ctx: PromptUnderstandContext): Promise<ClarityResult> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "prompt_clarity",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });

    const words = prompt.trim().split(/\s+/).filter(Boolean);
    // A single bare word or two (no qualifying phrase) is the stub's proxy
    // for "genuinely ambiguous" — e.g. "Mercury" alone could mean the planet,
    // the element, the Roman god, or the record label.
    const ambiguous = words.length <= 2;

    if (!ambiguous) {
      return { ambiguous: false, readings: [], question: null };
    }

    const subject = prompt.trim();
    const readings = [
      `${subject} the historical/mythological figure or place`,
      `${subject} the scientific or technical subject`,
      `${subject} as a modern brand, product, or reference`
    ];
    return {
      ambiguous: true,
      readings,
      question: `Did you mean ${readings[0]}, ${readings[1]}, or something else?`
    };
  }

  async extractIntent(prompt: string, ctx: PromptUnderstandContext): Promise<IntentUnderstanding> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "prompt_intent",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });

    const subject = prompt.trim();
    const seed = hashToInt(subject);
    const angles = [
      "the surprising origin story",
      "how it actually works, mechanism first",
      "the controversy nobody agrees on",
      "how it changed once it left the lab/workshop"
    ];
    return {
      subject,
      angle: pick(angles, seed),
      priorKnowledge: `A listener who asked for "${subject}" likely knows the name but not the specifics — treat this as a first real explanation, not a refresher.`,
      disappointment: `This Foray disappoints if it stays surface-level on "${subject}" without landing at least one non-obvious, well-sourced claim the listener didn't already know.`
    };
  }
}

function hashToInt(input: string): number {
  const digest = crypto.createHash("sha1").update(input).digest();
  return digest.readUInt32BE(0);
}

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length]!;
}
