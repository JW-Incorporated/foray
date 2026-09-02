import type { NarrationBuildContext, NarrationWriteRequest, NarrationWriteResult } from "./NarrationWriterBuilder";

/**
 * §4.7's verification collaborator — a genuinely separate role from
 * `NarrationWriterBuilder`, never the same class or instance (§5's
 * topology table: "1 per act, never the writer"; this stage's task
 * brief: "Self-review does not count").
 *
 * Reads a WRITTEN page against its OWN declared sources and reports
 * whether every factual claim the page makes is actually backed by one
 * of them. It does not have — and must not need — access to the writer's
 * internal reasoning; it re-derives a verdict from the page and the
 * sources alone, which is what makes it a real check rather than the
 * writer's own confidence restated.
 */
export interface NarrationVerifierBuilder {
  readonly providerName: string;

  verifyPage(request: NarrationVerifyRequest, ctx: NarrationBuildContext): Promise<NarrationVerifyResult>;
}

export interface NarrationVerifyRequest extends NarrationWriteRequest, NarrationWriteResult {}

export interface NarrationVerifyResult {
  verified: boolean;
  /** Required whenever `verified` is false — what the page asserted with
   * no backing source, or what a source's quote does not actually
   * support. Optional when `verified` is true (a clean pass needs no
   * explanation), but a builder may still return one. */
  verifierNotes?: string;
}
