import type { Voice } from "../types/spine";
import type { NarrationMode, Source } from "../types/narration";
import type { EvidenceDoc } from "./gatherEvidence";
import type { BeatBrief, ClipBrief, IntroKind, NarrationBuildContext, NarrationPageBrief } from "./NarrationWriterBuilder";

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
 *   2. does the page accomplish the purpose it was given (F-41) — which,
 *      since F-50, means "does it address the purpose's SUBJECT with the
 *      evidence available", INCLUDING by contradicting or qualifying the
 *      purpose. Only a page that ignores the subject fails. It also says
 *      whether the page did depart from its purpose that way, which is
 *      `purposeRevised` below;
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

  /**
   * F-88: the SYNTHESIS question, asked only after the retrieval path has
   * failed a Hinge or Frame (never instead of it, and never for a Patch or
   * Carry — `synthesisVerify.ts` decides eligibility, this only answers).
   * Given the Foray's verified pages, is each page below a fair
   * generalisation of them and only them? The answer is the ids of the
   * pages it rests on, or a refusal naming the case or claim no verified
   * page covers. Optional so a scripted or older verifier still compiles;
   * a verifier without it leaves every such page unverified.
   */
  verifySynthesis?(request: SynthesisVerifyRequest, ctx: NarrationBuildContext): Promise<SynthesisVerifyResult>;

  /**
   * Q-03: VERIFIED PER BEAT, against the act's prose and clips. Given the
   * act's seams (each script with its sources and the documents it quotes),
   * its clips (the transcript windows) and the beat checklist, the verifier
   * answers, per BEAT, whether the prose carries its claim — anywhere in
   * the act, supported by the sources or the clips — and, per SEAM, the
   * same two questions `verifySlot` asks of a page: is every statement
   * supported by the source attached to it, is a genuinely contested point
   * handled. A missed or unsupported beat comes back as a NOTE naming the
   * beat and its claim ("the prose does not carry beat b3: …; add it where
   * it belongs"), and the retry edits the act's prose, not a page.
   *
   * What counts as verified is unchanged from the per-page path: a quote is
   * proven a span of a held document in code before this is called (F-51's
   * evidence rules), and a tape source is judged against the window it
   * names (F-82). An Intro is not judged here at all — it is checked
   * structurally in `actSeams.ts`.
   *
   * Optional, as `writeAct` is on the writer: both must be present for the
   * per-act path to run.
   */
  verifyAct?(request: ActVerifyRequest, ctx: NarrationBuildContext): Promise<ActVerifyResult>;
}

/* ------------------------------------------------------------------ *
 * Q-03: the per-act contract.
 * ------------------------------------------------------------------ */

/** One seam as the verifier reads it: the script, what it cites, which
 * beats sit in it, and which clip it introduces. */
export interface VerifySeamBrief {
  seamId: string;
  mode: NarrationMode;
  script: string;
  sources: Source[];
  /** The beat ids positioned in this seam. The verifier may find a beat
   * carried in another seam; this is where the writer was asked to put it. */
  carries: string[];
  follows?: string;
  introduces?: string;
  intro?: IntroKind;
}

/** One clip with its whole transcript window, so a statement about the
 * tape is judged against everything said in it (F-82). */
export interface VerifyClipBrief extends ClipBrief {
  /** The held window's text; empty when the pipeline holds no cue body. */
  windowText: string;
}

export interface ActVerifyRequest {
  actTitle: string;
  voice: Voice;
  /** The checklist: every narration beat of the act, in play order. */
  beats: BeatBrief[];
  seams: VerifySeamBrief[];
  clips: VerifyClipBrief[];
  /** Every document the seams' sources quote. */
  documents: EvidenceDoc[];
}

export interface BeatVerdict {
  beatId: string;
  /** True when the act's prose (any seam) or a clip carries the beat's
   * claim, supported by the sources or the window it rests on. */
  carried: boolean;
  /** Required when `carried` is false: the note the writer acts on. */
  notes?: string;
}

export interface SeamVerdict {
  seamId: string;
  /** Q1 of `verifySlot`, for this seam's script. */
  claimsSupported: boolean;
  /** Q3 of `verifySlot`, for this seam's script. */
  contestedHandled: boolean;
  notes?: string;
}

export interface ActVerifyResult {
  beats: BeatVerdict[];
  seams: SeamVerdict[];
}

/** F-88: one verified page as the synthesis question sees it — what the
 * page is for, what it says, and what its sources established. */
export interface VerifiedPageSummary {
  /** Foray-wide id (`synthesisVerify.ts`'s `forayPageId`). */
  pageId: string;
  claim: string;
  mode: NarrationMode;
  script: string;
  /** The `claimText` of every source the page carries — the facts it
   * established, tape-cited or print-verified. */
  established: string[];
}

export interface SynthesisVerifyRequest {
  voice: Voice;
  /** The candidate synthesis pages, each written from the verified pages
   * as its documents and already through every mechanical rule. */
  pages: VerifyPageBrief[];
  /** Every page the candidates may rest on. Nothing else counts. */
  verifiedPages: VerifiedPageSummary[];
}

export interface SynthesisVerdict {
  pageId: string;
  /** True only when the script generalises the pages in `restsOn` and
   * introduces no case, entity or claim they do not establish. */
  synthesis: boolean;
  /** The verified page ids the generalisation rests on. Empty on a
   * refusal. */
  restsOn: string[];
  /** Required on a refusal: which case or claim no verified page covers. */
  notes?: string;
}

export interface SynthesisVerifyResult {
  pages: SynthesisVerdict[];
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
  /** Q2: the script engages the SUBJECT its purpose names, with the
   * evidence it was given (F-41, as F-50 redefined it). A page that
   * contradicts or qualifies its purpose from the documents accomplishes
   * it; only a page that drops the subject does not. */
  purposeAccomplished: boolean;
  /** Q2b, F-50: the verifier's own judgement that this page departed from
   * its purpose because the evidence did. Optional — a verifier that does
   * not answer it says nothing, rather than saying "no". */
  purposeRevised?: boolean;
  /** Q3: §4.7 rule 3, judged with the sources in hand (F-43). */
  contestedHandled: boolean;
  /** Required whenever any answer is false — what the page asserted with
   * no backing, what it failed to do, or what it left unflagged. */
  notes?: string;
}

export interface NarrationVerifyResult {
  pages: PageVerdict[];
}
