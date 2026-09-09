import type { Voice } from "../types/spine";
import type { NarrationMode, PronunciationHint } from "../types/narration";
import type { EvidencePack } from "./gatherEvidence";

/**
 * §4.7's writing collaborator (docs/curation/generation-architecture.md
 * §4.7), behind the same stub/real-provider split as every other
 * generation-stage collaborator (`SpineBuilder`, `DeepenActBuilder`).
 *
 * TWO CALLS, NOT ONE, AND BATCHED PER SLOT — the WS-A shape, and a
 * deliberate replacement of the previous "one `writePage` per page":
 *
 *   1. `selectClaims` reads the evidence pack and returns, per page, the
 *      claims it intends to make and the exact span of a held document
 *      that backs each. Whether that span really is in that document is
 *      then decided IN CODE (`writeNarration.ts`), never by a model, so
 *      the prose call can only ever be given claims that are already
 *      grounded.
 *   2. `writePages` writes the scripts from those claims and nothing
 *      else. It does not return sources: attribution is derived from the
 *      documents the pipeline holds, so a publication cannot be free
 *      text, a slug, or a plausibility label (F-30/F-32). A page says
 *      which of its claims it used, by index, and that is all.
 *
 * BOTH take the whole slot at once. Run 1 spent 4.2 narration calls per
 * beat over 31 beats; a call per slot rather than per page is most of the
 * way to the ≤1.5 target, and slots within an act run in parallel
 * (WS-D1). The M3/M4 ordering guarantees are not affected — they were
 * enforced at sourcing time, over the whole Foray, before any of this
 * runs.
 *
 * NEVER the same class/instance as a `NarrationVerifierBuilder` — §5's
 * topology table and this stage's own task brief both require the
 * verification pass to be "a DIFFERENT agent than the writer".
 * `writeNarration.ts`'s orchestrator enforces this at the call site.
 */
export interface NarrationWriterBuilder {
  readonly providerName: string;

  selectClaims(request: ClaimSelectionRequest, ctx: NarrationBuildContext): Promise<ClaimSelectionResult>;
  writePages(request: ProseWriteRequest, ctx: NarrationBuildContext): Promise<ProseWriteResult>;
}

/** One page's brief, shared by both calls and by the verifier. */
export interface NarrationPageBrief {
  /** Identifies this page within its slot batch, in both directions. */
  pageId: string;
  /** The beat's claim (narration-sourced) or the editorial job this
   * connective item exists to do (tape-adjacent) — always the thing the
   * page has to accomplish, stated as prose, never a bare topic. It is
   * EDITORIAL DIRECTION, never a source: quoting it back is F-46, and
   * `writeNarration.ts` rejects a quote that overlaps it. */
  purpose: string;
  mode: NarrationMode;
  /** Extra grounding a connective item needs and a Patch/Carry does not:
   * e.g. that the page hands the listener into real tape. */
  contextNote?: string;
  /** Every prior rejection of this page, accumulated in order (F-35). */
  retryNote?: string;
  /** The documents this page may quote. Nothing else is quotable. */
  evidence: EvidencePack;
}

/** One claim a page intends to make, and the span that backs it. */
export interface SelectedClaim {
  claimText: string;
  /** Must be an exact (whitespace-normalised) substring of the document
   * named by `docId` — checked mechanically, not by a model. */
  quote: string;
  docId: string;
  /** §4.7 rule 3, narrowly: reputable sources actively disagree about the
   * fact itself. Not the writer's own uncertainty. */
  contested: boolean;
}

export interface ClaimSelectionRequest {
  slotTitle: string;
  voice: Voice;
  pages: NarrationPageBrief[];
}

export interface ClaimSelectionResult {
  pages: Array<{ pageId: string; claims: SelectedClaim[] }>;
}

export interface ProsePageBrief extends NarrationPageBrief {
  /** The validated claims — the only material the script may assert. */
  claims: SelectedClaim[];
}

export interface ProseWriteRequest {
  slotTitle: string;
  voice: Voice;
  pages: ProsePageBrief[];
}

export interface WrittenPage {
  pageId: string;
  script: string;
  /** Indices into the page's `claims`, for the claims the script actually
   * asserts. A page that asserts nothing returns none — and then may not
   * contain a declarative sentence (F-36/F-37/F-44). */
  usedClaims: number[];
  pronunciationHints: PronunciationHint[];
}

export interface ProseWriteResult {
  pages: WrittenPage[];
}

export interface NarrationBuildContext {
  userId: string;
  sessionId?: string;
}
