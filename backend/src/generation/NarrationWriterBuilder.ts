import type { Voice } from "../types/spine";
import type { NarrationMode, PronunciationHint } from "../types/narration";
import type { EvidenceDoc, EvidencePack } from "./gatherEvidence";

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
  /**
   * Q-03: THE WHOLE ACT IN ONE CALL. The writer is handed an act's verified
   * material — its clips (opening text, guest/show), its documents, its
   * beats with their claims — laid out in play order as SEAMS (the stretch
   * of narration between two clips, before the first, after the last) and
   * writes continuous prose for the act in one voice: the Intro before each
   * clip (Q-02), the bridges between clips, and the argument the act
   * carries. The beats are the checklist the prose must carry, not the
   * template it fills; a seam's script may carry a beat's claim wherever it
   * belongs. The reply is one script per seam with the claims it asserts
   * and the spans that back them — the same mechanical quote gate as the
   * per-page calls runs on it afterwards.
   *
   * Optional: a writer without it (a scripted test writer, an older
   * provider) takes the per-slot, per-page path above, which is kept as
   * the fallback and as F-88's drafting path. The real and stub builders
   * both offer it, so production and `--dry-run` write per act.
   */
  writeAct?(request: ActWriteRequest, ctx: NarrationBuildContext): Promise<ActWriteResult>;
}

/* ------------------------------------------------------------------ *
 * Q-02/Q-03: the per-act contract.
 * ------------------------------------------------------------------ */

/** How much introducing a clip needs (Q-02, "don't go overkill"):
 *   - `full`  — a different episode from the previous clip, and the host
 *               does not introduce the guest in the clip's own opening:
 *               the prose before it must name who is speaking and on
 *               which show, and say what to listen for;
 *   - `light` — the same episode as the previous clip: one clause at
 *               most, or nothing;
 *   - `none`  — the host's own introduction is in the clip's opening
 *               (the sourcing agent extends windows back to the host's
 *               question): nothing is required, and nothing is repeated. */
export type IntroKind = "full" | "light" | "none";

/** One clip of the act as the writer and verifier see it. */
export interface ClipBrief {
  /** `c<n>` in act play order. */
  clipId: string;
  segmentId: string;
  itemId: string;
  /** The show and episode from the segment's source row or the pack's
   * tape context — what an Intro must name (structural check). */
  show: string;
  title: string;
  /** The transcript window's docId when the pipeline holds it
   * (`tapeDocIdFor`), so a seam may cite the clip. */
  docId?: string;
  /** The clip's OPENING — roughly its first minute of speech, from the
   * start anchor on — the only part of the clip an Intro is written from.
   * Empty when no window is held. */
  opening: string;
  durationSec: number;
  intro: IntroKind;
  /** F-99: every beat this clip carries — the beat whose clip it is and
   * any beat §4.5 merged into it (F-96 `mergedInto`: one clip, two claims).
   * Printed on the CLIP line ("carries beats b2, b3") so the writer knows
   * what the tape already says and the verifier judges those beats
   * against the one window. Optional so a request recorded before F-99
   * (the run-9 replay) still reads. */
  carries?: ClipBeatBrief[];
}

/** F-99: one beat a clip carries, as the prompts print it. */
export interface ClipBeatBrief {
  beatId: string;
  claim: string;
}

/** One beat the act's prose must carry, in play order. */
export interface BeatBrief {
  /** `b<n>` over the act's flattened beats. */
  beatId: string;
  claim: string;
  /** A narration beat's sourcing mode (Patch/Carry) — the band it brings
   * to its seam. */
  mode: NarrationMode;
  /** WS-C: an `argument` beat is a claim about what things mean; an
   * `account` is something that happened. */
  kind: "account" | "argument";
  /**
   * F-99: THE SEED IS GONE (`SourcedBeat.seedLost`, F-96). §4.3 wrote this
   * beat from a stretch of tape and §4.5 could not place that tape, so the
   * claim names a guest and a moment the Foray never plays — unverifiable
   * by construction (six of run 9's eight unverified pages). The writer is
   * told to carry it only as far as the act's sources go and never to
   * attribute specifics to the person the claim names; the verifier is
   * told not to demand the seed's specifics, and a beat the act's sources
   * cannot reach at all is closed as `uncarried: "seed-lost"` after its
   * first judgement instead of costing three rounds.
   */
  seedLost?: true;
}

/** One seam of the act: the narration between two clips (or before the
 * first, or after the last). Its script carries the beats listed and, when
 * it introduces a clip, the Intro for it.
 *
 * F-97: THERE IS NO MODE ON THE BRIEF. Run 9 sent the writer "SEAM s0 —
 * mode Patch" and then refused s0 in code because a Patch "must select at
 * least one claim" — a rule about a page role the writer never chose. The
 * mode is now assigned AFTER writing, from what the seam turned out to do
 * (`actSeams.ts`'s `assignSeamMode`); the writer is given only the band. */
export interface SeamBrief {
  /** `s<n>` in play order. */
  seamId: string;
  /** The narration beats positioned in this seam — the ones whose page
   * this seam's script becomes. May be empty for an intro-only seam. */
  beats: BeatBrief[];
  /** The clip that plays just before this seam, when one does. */
  follows?: string;
  /** The clip this seam introduces (plays just after it), when one does. */
  introduces?: string;
  /** The introduction the clip in `introduces` needs. Absent with it. */
  intro?: IntroKind;
  /** The character band the script must land in (`seamBand`). */
  band: [number, number];
  /** The seam's script from the previous round, when this is a retry —
   * the writer EDITS the act's prose rather than starting over (Q-03:
   * "a missed beat sends back a note, not a page"). */
  previousScript?: string;
  /** F-97: true when this seam cleared every rule and the verifier
   * confirmed it in an earlier round. The writer returns `previousScript`
   * VERBATIM for a frozen seam — the orchestrator keeps the frozen text
   * whatever comes back — so a retry for one seam can never cost another
   * seam its text (run 9 dropped a clean Intro this way). */
  frozen?: boolean;
  /** F-97: what is wrong with THIS seam, when this is a retry and the seam
   * is not frozen — the mechanical refusal or the verifier's note, with
   * the sentence it objects to quoted where there is one. */
  notes?: string;
}

export interface ActWriteRequest {
  actTitle: string;
  voice: Voice;
  seams: SeamBrief[];
  clips: ClipBrief[];
  /** F-97: the verified pages of earlier acts this act's prose may rest
   * on (their documents are in `documents` too, kind `page`). */
  ground?: GroundPageBrief[];
  /** Every document the act may quote — print passages and the clips'
   * transcript windows, deduplicated act-wide. Nothing else is quotable. */
  documents: EvidenceDoc[];
  /** Every prior rejection of the act, in order (F-35), with the per-beat
   * and per-seam notes the verifier gave. */
  retryNote?: string;
}

/** F-88's ground, on the act path (F-97): a page of this Foray verified in
 * an act that has already landed. Listed to the verifier as an act source
 * (`p<n>`) a thesis seam may rest on, and handed to the writer as a
 * document of kind `page` it may quote whole sentences of. */
export interface GroundPageBrief {
  /** Foray-wide page id (`synthesisVerify.ts`'s `forayPageId`). */
  pageId: string;
  claim: string;
  script: string;
  /** The `claimText` of every source the page carries. */
  established: string[];
}

/** One seam's script with the claims it selected. `claims` are gated
 * mechanically exactly as a `SelectedAndWrittenPage`'s; `usedClaims` is
 * kept for the reply shape but is no longer the seam's source list — since
 * F-97 the act's whole claim pool is one source set, and the VERIFIER
 * answers which of it each seam rests on (`SeamVerdict.restsOn`). An empty
 * script is allowed only on a seam with no beats whose intro is not `full`
 * — it means "no page here, silence bridges". */
export interface WrittenSeam {
  seamId: string;
  script: string;
  claims: SelectedClaim[];
  usedClaims: number[];
  pronunciationHints: PronunciationHint[];
}

export interface ActWriteResult {
  seams: WrittenSeam[];
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
