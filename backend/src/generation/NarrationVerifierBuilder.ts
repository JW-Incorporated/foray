import type { Voice } from "../types/spine";
import type { Source } from "../types/narration";
import type { NarrationBuildContext, NarrationPageBrief } from "./NarrationWriterBuilder";

/* Re-exported because every implementation of this interface imports its
 * context type from THIS module, and a bare `import type` does not make a
 * name available to importers (the `tsc` error WS-E logged against these
 * two files, F-21). One declaration, two import paths. */
export type { NarrationBuildContext, NarrationPageBrief };

/**
 * §4.7's verification collaborator — a genuinely separate role from
 * `NarrationWriterBuilder`, never the same class or instance (§5's
 * topology table: "1 per act, never the writer"; this stage's task
 * brief: "Self-review does not count").
 *
 * WHAT CHANGED, AND WHY (WS-A). Run 1's verifier was told to read a page
 * "against ONLY its declared sources", which made it a consistency check
 * on the writer's own declarations and nothing more: it could not tell an
 * invented quote from a real one (F-22), and it passed a page citing
 * Chernobyl interviews for a Kansas City claim in five seconds (F-27). It
 * also had no way to notice a page that abandoned the job it existed to
 * do (F-41), and it decided the zero-source case by sampling (F-44).
 *
 * So it is now given the beat's PURPOSE and the EVIDENCE PACK, and asked
 * three questions instead of one:
 *
 *   1. is every claim actually supported by the quote attached to it;
 *   2. does the page accomplish the purpose it was given (F-41);
 *   3. is rule 3 satisfied — is anything genuinely contested handled, with
 *      the sources in hand rather than guessed at (F-43).
 *
 * What it is NOT asked is whether a quote exists: that is decided in code
 * against the held documents before this is ever called, so a model is
 * never the last line of defence for something a substring check settles.
 *
 * Batched per slot, matching the writer.
 */
export interface NarrationVerifierBuilder {
  readonly providerName: string;

  verifySlot(request: NarrationVerifyRequest, ctx: NarrationBuildContext): Promise<NarrationVerifyResult>;
}

export interface VerifyPageBrief extends NarrationPageBrief {
  script: string;
  sources: Source[];
}

export interface NarrationVerifyRequest {
  slotTitle: string;
  voice: Voice;
  pages: VerifyPageBrief[];
}

export interface PageVerdict {
  pageId: string;
  /** Q1: every claim the script makes is backed by its quote. */
  claimsSupported: boolean;
  /** Q2: the script does the job the beat purpose describes (F-41). */
  purposeAccomplished: boolean;
  /** Q3: §4.7 rule 3, judged with the sources in hand (F-43). */
  contestedHandled: boolean;
  /** Required whenever any answer is false — what the page asserted with
   * no backing, what it failed to do, or what it left unflagged. */
  notes?: string;
}

export interface NarrationVerifyResult {
  pages: PageVerdict[];
}
