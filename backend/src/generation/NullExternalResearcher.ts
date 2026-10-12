import type { ExternalResearcher, ExternalResearchResult } from "./ExternalResearcher";

/**
 * The 'none' research route (GV-37, moved here from W2-10/GV-61 by roadmap
 * decision 36): no outside research at all. It is the local-mode research
 * default (stageRouting.ts; OQ-04: clip transcripts only on the timed path,
 * outside facts from precomputed dossiers once they exist), so a
 * FORAY_GENERATION_MODE=local run builds it at pipeline start instead of
 * throwing RoutingConfigError.
 *
 * research() resolves an empty result with no I/O: no network, no budget
 * ledger write, no web text. There is deliberately NO retrievePassages, so
 * gatherEvidence's retrieveFor returns 'unavailable' and never writes the
 * evidence cache. GV-61 adds the shared researcher, the cache rule,
 * topicNodeIds and printEvidenceSkipped.
 */
export class NullExternalResearcher implements ExternalResearcher {
  readonly providerName = "none";

  /** The interface's (topic, ctx) are accepted and ignored: nothing is looked up. */
  async research(): Promise<ExternalResearchResult> {
    return { notes: "", controversies: [] };
  }
}
