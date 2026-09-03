import type { Voice } from "../types/spine";
import type { NarrationMode, PronunciationHint, Source } from "../types/narration";

/**
 * §4.7's writing collaborator (docs/curation/generation-architecture.md
 * §4.7), behind the same stub/real-provider split as every other
 * generation-stage collaborator (`SpineBuilder`, `DeepenActBuilder`).
 * Writes ONE PAGE at a time — a single narration beat, in a single mode,
 * inside that mode's budget — never a whole act or Foray in one call, so
 * the same interface serves every mode from an 8-word Hinge to a
 * 312-word Carry without a shape mismatch.
 *
 * NEVER the same class/instance as a `NarrationVerifierBuilder` — §5's
 * topology table and this stage's own task brief both require the
 * verification pass to be "a DIFFERENT agent than the writer... a
 * genuinely separate call/builder instance". `writeNarration.ts`'s
 * orchestrator is what enforces this at the call-site level (see its
 * doc comment); this interface only defines the writer's own contract.
 */
export interface NarrationWriterBuilder {
  readonly providerName: string;

  writePage(request: NarrationWriteRequest, ctx: NarrationBuildContext): Promise<NarrationWriteResult>;
}

export interface NarrationWriteRequest {
  /** The beat's claim (narration-sourced) or the editorial job this
   * connective item exists to do (tape-adjacent) — always the thing the
   * page has to accomplish, stated as prose, never a bare topic. */
  claim: string;
  mode: NarrationMode;
  /** The spine's single voice (§4.3: decided once, inherited by every
   * downstream writer — never re-invented per beat). */
  voice: Voice;
  /** Extra grounding a connective item needs and a Patch/Carry does not:
   * e.g. the adjacent tape's subject, for a Frame or Hinge. Optional
   * because a Patch/Carry beat is self-contained. */
  contextNote?: string;
}

export interface NarrationWriteResult {
  script: string;
  sources: Source[];
  pronunciationHints: PronunciationHint[];
}

export interface NarrationBuildContext {
  userId: string;
  sessionId?: string;
}
