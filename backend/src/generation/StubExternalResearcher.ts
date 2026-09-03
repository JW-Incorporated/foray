import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { ExternalResearcher, ExternalResearchContext, ExternalResearchResult } from "./ExternalResearcher";

/**
 * Deterministic fake external researcher, used whenever ANTHROPIC_API_KEY
 * is absent (env.anthropicDryRun) — mirrors StubPromptUnderstander /
 * StubEnricher exactly: zero API keys, zero network calls, reproducible
 * fixtures, and an honest note that no real research ran.
 */
export class StubExternalResearcher implements ExternalResearcher {
  readonly providerName = "stub";

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {}

  async research(topic: string, ctx: ExternalResearchContext): Promise<ExternalResearchResult> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "external_research",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });

    return {
      notes: `No external research available in dry-run mode for "${topic}" — configure ANTHROPIC_API_KEY to enable real web research.`,
      controversies: []
    };
  }
}
