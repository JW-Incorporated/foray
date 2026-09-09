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

/**
 * WS-A generalises this collaborator from "research a sub-topic's shape"
 * to "retrieve N passages of REAL TEXT for this claim". Same web-search
 * capability, different unit of work: `gatherEvidence.ts` needs
 * documents a narration page's quotes can be looked up IN, because run 1
 * showed that a writer with no text to quote invents one (F-14/F-27/F-32).
 */
export interface PassageRetrievalRequest {
  claim: string;
  maxPassages: number;
  maxChars: number;
}

/** One retrieved passage: verbatim text plus the work it came from. The
 * `title` is what a source's `publication` becomes — attribution is
 * derived from the document the pipeline holds, never written by the
 * page's author (F-30/F-32). */
export interface RetrievedPassage {
  /** Stable id; `gatherEvidence` mints one when the provider does not. */
  docId?: string;
  title: string;
  url?: string;
  retrievedAt?: string;
  text: string;
}

export interface ExternalResearcher {
  readonly providerName: string;
  research(topic: string, ctx: ExternalResearchContext): Promise<ExternalResearchResult>;
  /**
   * OPTIONAL so an implementation that only answers §4.2's shape
   * question stays valid: a researcher with no retrieval simply supplies
   * no print evidence, and `gatherEvidence` writes the page from
   * whatever else it holds rather than failing.
   */
  retrievePassages?(request: PassageRetrievalRequest, ctx: ExternalResearchContext): Promise<RetrievedPassage[]>;
}
