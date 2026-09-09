import * as crypto from "crypto";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type {
  ExternalResearcher,
  ExternalResearchContext,
  ExternalResearchResult,
  PassageRetrievalRequest,
  RetrievedPassage
} from "./ExternalResearcher";

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

  /**
   * A dry-run's stand-in for a retrieved document (WS-A). It is a
   * FIXTURE, and it says so in its own text — but it is a fixture with
   * the one property that matters structurally: it is real text the
   * pipeline holds, so the stub writer's quote can be looked up in it and
   * every mechanical rule in `writeNarration.ts` runs for real in
   * `npm run generate-forays -- --dry-run`.
   *
   * Deliberately contains NO word of the claim: a stub whose passage
   * echoed the beat purpose would pass the substring check while
   * violating the purpose-overlap rule (F-46), which is exactly the
   * confusion this fixture exists to keep out of dry-runs.
   */
  async retrievePassages(request: PassageRetrievalRequest, ctx: ExternalResearchContext): Promise<RetrievedPassage[]> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "evidence_retrieval",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });

    if (request.maxPassages < 1) return [];
    const hash = crypto.createHash("sha1").update(request.claim.toLowerCase().trim()).digest("hex").slice(0, 16);
    const text =
      "This passage stands in for a document the pipeline would have retrieved. " +
      "It exists so that a quoted span can be looked up in text the pipeline actually holds. " +
      "No key is configured, so no search ran and nothing written here describes the world.";
    return [
      {
        docId: `print:${hash}-stub`,
        title: "Dry-run evidence fixture (no ANTHROPIC_API_KEY configured)",
        text: text.slice(0, request.maxChars)
      }
    ];
  }
}
