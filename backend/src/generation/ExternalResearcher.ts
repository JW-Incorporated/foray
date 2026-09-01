/**
 * §4.2's second research source, invoked only for a genuine catalogue gap
 * (a candidate sub-topic whose local `TapeAvailability.signal` is "none").
 * Same stub/real-provider split as `PromptUnderstander` (Enricher's pattern
 * again): cheap, deterministic dry-run by default, a real web-search call
 * only when ANTHROPIC_API_KEY is configured. Every call MUST route through
 * the budget guard (src/cost/budgetGuard.ts), exactly like every other
 * generation-stage collaborator.
 */
export interface ExternalResearchResult {
  /** Free-text summary of what external research found for this topic. */
  notes: string;
  /** Contested/controversial points external research surfaced, if any. */
  controversies: string[];
}

export interface ExternalResearchContext {
  userId: string;
  sessionId?: string;
}

export interface ExternalResearcher {
  readonly providerName: string;
  research(topic: string, ctx: ExternalResearchContext): Promise<ExternalResearchResult>;
}
