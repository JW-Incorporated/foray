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
 * ONE CALL WHERE THE DESIGN ALLOWS (G-34). `selectAndWrite` is the two
 * calls above folded into one reply: per page, the claims WITH their
 * quotes AND the script written from them. The mechanical quote gate is
 * unchanged and still runs in code — after the combined reply instead of
 * between two replies — so a quote that is not a span of the named
 * document still never becomes a source. What changes is only the cost
 * of the common case: a slot whose quotes all resolve pays one writer
 * call instead of two. A page whose quotes do NOT all resolve has spent
 * its script (the card accepts that: "a rejected quote now wastes a
 * script"), keeps the claims that did pass, and re-runs prose alone —
 * ONE page, not the slot — through `writePages`, which is why that
 * method stays.
 *
 * Optional, because the orchestrator falls back to `selectClaims` +
 * `writePages` when a builder does not offer it. That is what keeps every
 * scripted test writer and every older provider working, and keeps the
 * two-call path itself exercised.
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
  /** G-34: selection and prose in one reply. See the class comment. */
  selectAndWrite?(request: SelectAndWriteRequest, ctx: NarrationBuildContext): Promise<SelectAndWriteResult>;
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
  /** F-50: true when this script departs from its purpose BECAUSE the
   * documents contradicted or complicated it — the page reports the
   * tension instead of asserting the purpose. Self-reported by the
   * writer, so it is recorded rather than trusted: the verifier answers
   * the same question separately and both answers reach the page
   * (`NarratedBeat.purposeRevised` / `purposeRevisedByVerifier`). */
  purposeRevised?: boolean;
}

export interface ProseWriteResult {
  pages: WrittenPage[];
}

/** The same brief as a selection call: the pages, their purposes and
 * the documents each may quote. The reply carries the scripts too. */
export type SelectAndWriteRequest = ClaimSelectionRequest;

/** One page of a combined reply: what it selected AND what it wrote.
 * `usedClaims` indexes `claims` exactly as `WrittenPage.usedClaims`
 * indexes a `ProsePageBrief`'s — and every claim is still put through
 * the mechanical gate before any index is honoured. */
export interface SelectedAndWrittenPage extends WrittenPage {
  claims: SelectedClaim[];
}

export interface SelectAndWriteResult {
  pages: SelectedAndWrittenPage[];
}

export interface NarrationBuildContext {
  userId: string;
  sessionId?: string;
}
