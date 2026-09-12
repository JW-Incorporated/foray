import type { Voice } from "../types/spine";
import type { EvidenceDoc } from "./gatherEvidence";
import type { BeatBrief, ClipBrief, GroundPageBrief, IntroKind, NarrationBuildContext, NarrationPageBrief } from "./NarrationWriterBuilder";

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
 * So it is given the beat's PURPOSE and the EVIDENCE PACK, and asked the
 * questions a model is actually needed for rather than the one it could
 * only answer from the writer's own declarations: is every claim supported
 * by the quote attached to it; does the prose accomplish the purpose
 * (F-41) — which, since F-50, means "does it address the purpose's SUBJECT
 * with the evidence available", INCLUDING by contradicting or qualifying
 * the purpose; and is rule 3 satisfied, with the sources in hand rather
 * than guessed at (F-43).
 *
 * What it is NOT asked is whether a quote exists: that is decided in code
 * against the held documents before this is ever called, so a model is
 * never the last line of defence for something a substring check settles.
 *
 * Batched per ACT, matching the writer.
 *
 * WHAT USED TO BE HERE (F-100). `verifySlot` asked those questions of one
 * slot's pages, and F-88's `verifySynthesis` asked a fourth of a page whose
 * retrieval had returned nothing. Q-03/F-97 folded both into `verifyAct`:
 * the act's beats are judged against the act's prose, and a bridge is
 * judged against any source in the act — a clip's window, a document's
 * span, or a verified page of the same Foray (F-88's ground,
 * `synthesisVerify.ts`). Both methods, their prompts and their
 * request/reply types are deleted; nothing could reach them, because both
 * classes `createNarrationVerifierBuilder()` returns implement
 * `verifyAct`.
 */
export interface NarrationVerifierBuilder {
  readonly providerName: string;

  /**
   * Q-03: VERIFIED PER BEAT, against the act's prose and clips. Given the
   * act's seams (each script with the claims it selected), its clips (the
   * transcript windows), the ground of earlier acts and the beat
   * checklist, the verifier answers, per BEAT, whether the prose carries
   * its claim — anywhere in the act — and, per SEAM, the two questions
   * `verifySlot` asks of a page: is every statement supported, is a
   * genuinely contested point handled. A missed or unsupported beat comes
   * back as a NOTE naming the beat and its claim ("the prose does not
   * carry beat b3: …; add it where it belongs"), and the retry edits the
   * act's prose, not a page.
   *
   * F-97 — SUPPORT IS ACT-SCOPED. Run 9's verifier judged each seam
   * "against the source attached to it", and per-act prose naturally
   * bridges: the seam after a clip restates what the clip established
   * (supported by THAT window, which the writer attached to a different
   * seam) and sets up the next. So the request now carries ONE source set
   * for the act (`sources`: every gated claim of every seam, every clip's
   * window, every ground page), each seam says which of it it selected as
   * a hint, and the verifier answers which of it each seam and each beat
   * actually RESTS ON (`restsOn`). Those answers, not the writer's
   * declaration, become the page's `sources`. Seams marked `frozen` were
   * confirmed in an earlier round and are context only.
   *
   * What counts as verified is unchanged from the per-page path: a quote is
   * proven a span of a held document in code before this is called (F-51's
   * evidence rules), and a tape source is judged against the window it
   * names (F-82). An Intro's naming is not judged here at all — it is
   * checked structurally in `actSeams.ts`.
   *
   * REQUIRED since F-100, as `writeAct` is on the writer: with the
   * per-page path deleted this is the only verification §4.7 has.
   */
  verifyAct(request: ActVerifyRequest, ctx: NarrationBuildContext): Promise<ActVerifyResult>;
}

/* ------------------------------------------------------------------ *
 * Q-03: the per-act contract.
 * ------------------------------------------------------------------ */

/** F-97: one entry of the act's source set — the ONE list every seam and
 * beat of the act may rest on. Ids are stable for the round: `k<n>` a
 * claim some seam selected (a print span, or a tape echo of a clip),
 * `c<n>` a clip's whole transcript window, `p<n>` a page of this Foray
 * verified in an earlier act (F-88's ground). */
export interface ActSourceBrief {
  id: string;
  kind: "claim" | "clip" | "page";
  /** The claim's text; for a clip, what the clip is; for a page, its claim. */
  claimText: string;
  /** The verbatim span (print) or the echoed phrase (tape), when there is one. */
  quote?: string;
  publication: string;
  contested: boolean;
  /** For a claim: the seam that selected it. */
  selectedBy?: string;
  /** The document the entry rests in: the claim's docId, the clip's window
   * docId, or the ground page's page document id. */
  docId: string;
}

/** One seam as the verifier reads it: the script, which act sources it
 * selected (a hint — the verifier answers what it rests on), which beats
 * sit in it, and which clip it introduces. */
export interface VerifySeamBrief {
  seamId: string;
  script: string;
  /** Ids into `ActVerifyRequest.sources` of the claims this seam selected. */
  selected: string[];
  /** The beat ids positioned in this seam. The verifier may find a beat
   * carried in another seam; this is where the writer was asked to put it. */
  carries: string[];
  follows?: string;
  introduces?: string;
  intro?: IntroKind;
  /** F-97: confirmed in an earlier round — printed for context, not
   * judged again, and not answered for. */
  frozen?: boolean;
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
  /** The checklist THIS ROUND: the beats not yet confirmed, plus the beats
   * a seam edited this round was carrying (F-97 — the retry re-checks only
   * what changed). */
  beats: BeatBrief[];
  /** Every seam that has a script: the ones to judge and the frozen ones. */
  seams: VerifySeamBrief[];
  clips: VerifyClipBrief[];
  /** F-97: the act's source set, in id order. */
  sources: ActSourceBrief[];
  /** F-88's ground on the act path: the earlier acts' verified pages. */
  ground?: GroundPageBrief[];
  /** Every document the seams' claims quote. */
  documents: EvidenceDoc[];
}

export interface BeatVerdict {
  beatId: string;
  /** True when the act's prose (any seam) or a clip carries the beat's
   * claim, supported by an act source. */
  carried: boolean;
  /** F-97: the seam (`s<n>`) or clip (`c<n>`) that carries it. Required
   * when `carried` — an edit to that seam re-opens the beat. */
  carriedBy?: string;
  /** F-97: the act sources the beat's point rests on. */
  restsOn?: string[];
  /** Required when `carried` is false: the note the writer acts on. */
  notes?: string;
}

export interface SeamVerdict {
  seamId: string;
  /** Q1 of `verifySlot`, act-scoped: every statement the script makes
   * about the world follows from SOME act source. */
  claimsSupported: boolean;
  /** F-97: the act sources the seam's statements rest on. Required
   * whenever `claimsSupported` and the script states anything; a seam
   * that asserts nothing (a question, a hand-off) rests on nothing. */
  restsOn: string[];
  /** Q3 of `verifySlot`, for this seam's script. */
  contestedHandled: boolean;
  /** Required whenever an answer is false — and for an unsupported
   * statement it QUOTES the sentence. */
  notes?: string;
}

export interface ActVerifyResult {
  beats: BeatVerdict[];
  seams: SeamVerdict[];
}
